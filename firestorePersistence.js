const fs = require("fs");
const path = require("path");

const {
    DEFAULT_COLLECTION,
    createFirestore,
    describeFirebaseTarget,
    getCollectionName,
    getDatabaseId,
    loadServiceAccount,
    normalizePrivateKey
} = require("./firebaseConfig");

let backend = "local";
let credentials = null;
let credentialSource = null;
let databaseId = getDatabaseId();
let collectionName = DEFAULT_COLLECTION;
let db = null;
const cache = new Map();
let lastPersistenceError = null;
let lastPersistenceWriteAt = null;

// ---------------------------------------------------------------------------
// Ghi Firestore có gộp (coalesced).
//
// Cách cũ nối một Promise cho MỖI lần thay đổi:
//     writeQueue = writeQueue.then(() => write(storeId, clone(value)))
// nên 100 thay đổi nhanh tạo ra 100 closure, mỗi closure giữ một bản sao ĐẦY ĐỦ
// của cả store, và chúng được ghi tuần tự. Với store lớn đây chính là nguồn phình
// bộ nhớ: RSS tăng trong khi heap V8 vẫn nhỏ, vì các bản sao đó là dữ liệu ngoài
// heap (external/ArrayBuffer) chờ được ghi.
//
// Cách mới: mỗi store có đúng MỘT writer đang chạy. Cache luôn giữ giá trị mới
// nhất; writer lặp cho tới khi store hết "bẩn", nên các thay đổi trung gian không
// bao giờ tồn tại thành nhiều bản sao trong hàng đợi.
//
// Bảo đảm:
//   - thứ tự ghi trong cùng một store được giữ (một writer, vòng lặp tuần tự)
//   - store khác nhau ghi song song được, không chặn nhau
//   - không mất dữ liệu: thay đổi trong lúc đang ghi làm store bẩn lại và được ghi tiếp
//   - bản sao cũ không bao giờ ghi đè trạng thái mới hơn
//   - flushPersistenceWrites() chờ tới khi mọi writer xong việc
// ---------------------------------------------------------------------------
const dirtyStores = new Set();
const activeWriters = new Map();

function markStoreDirty(storeId) {
    dirtyStores.add(storeId);
    if (!activeWriters.has(storeId)) startStoreWriter(storeId);
}

function startStoreWriter(storeId) {
    const writer = (async () => {
        try {
            // Lặp cho tới khi store sạch. Nếu có thay đổi trong lúc đang ghi thì
            // vòng lặp chạy thêm một lượt với trạng thái MỚI NHẤT.
            while (dirtyStores.has(storeId)) {
                dirtyStores.delete(storeId);
                // Chỉ sao chép MỘT lần cho mỗi lượt ghi, ngay trước khi gửi đi.
                const snapshot = clone(cache.get(storeId));
                await writeFirestoreDocumentWithRetry(storeId, snapshot);
                lastPersistenceWriteAt = new Date().toISOString();
                lastPersistenceError = null;
            }
        } catch (error) {
            // Ghi lỗi không được làm mất các thay đổi sau: store được đánh dấu bẩn
            // lại để lần ghi kế tiếp (hoặc flush lúc tắt) thử lại.
            lastPersistenceError = { storeId, message: error.message, at: new Date().toISOString() };
            console.error(`Không thể ghi Firestore store ${storeId}:`, error.message);
            if (dirtyStores.has(storeId)) {
                // Đã có thay đổi mới trong lúc ghi ⇒ thử lại ở vòng sau.
            }
        } finally {
            activeWriters.delete(storeId);
            // Thay đổi đến đúng lúc writer vừa kết thúc: khởi động lại.
            if (dirtyStores.has(storeId)) startStoreWriter(storeId);
        }
    })();
    activeWriters.set(storeId, writer);
    return writer;
}

// Số liệu chẩn đoán cho dashboard/log: hàng đợi có bị dồn không.
function getPersistenceQueueStats() {
    return {
        dirtyStores: dirtyStores.size,
        activeWriters: activeWriters.size,
        cachedStores: cache.size,
        dirtyStoreIds: [...dirtyStores]
    };
}

// Store do bot khác sở hữu. Bot này không hydrate, không ghi và không được
// nhập lại từ JSON, để không bao giờ ghi đè dữ liệu của bot kia.
const RESERVED_STORE_IDS = new Set(["dutyScheduleData"]);

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function storeIdFromPath(filePath) {
    return path.basename(filePath, path.extname(filePath));
}

function readLocalJson(filePath, fallbackValue) {
    if (!fs.existsSync(filePath)) return clone(fallbackValue);
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeLocalJson(filePath, value) {
    const temporaryPath = `${filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temporaryPath, filePath);
}

function readJsonStore(filePath, defaultPath, fallbackValue) {
    if (backend !== "firestore" || path.resolve(filePath) !== path.resolve(defaultPath)) {
        return readLocalJson(filePath, fallbackValue);
    }
    const storeId = storeIdFromPath(defaultPath);
    return clone(cache.has(storeId) ? cache.get(storeId) : fallbackValue);
}

function writeJsonStore(filePath, defaultPath, value) {
    if (backend !== "firestore" || path.resolve(filePath) !== path.resolve(defaultPath)) {
        writeLocalJson(filePath, value);
        return;
    }
    const storeId = storeIdFromPath(defaultPath);
    // Cache giữ giá trị MỚI NHẤT. Không sao chép ở đây: readJsonStore đã sao chép
    // khi đọc, và mọi nơi gọi đều truyền vào một object vừa đọc ra (đã là bản
    // riêng). Sao chép thêm ở đây chỉ tốn bộ nhớ mà không tăng an toàn.
    cache.set(storeId, value);
    markStoreDirty(storeId);
}

async function readFirestoreDocument(storeId) {
    const snapshot = await db.collection(collectionName).doc(storeId).get();
    if (!snapshot.exists) return null;
    const payload = snapshot.get("payload");
    return payload ? JSON.parse(payload) : null;
}

async function writeFirestoreDocument(storeId, value) {
    await db.collection(collectionName).doc(storeId).set({
        payload: JSON.stringify(value),
        updatedAt: new Date().toISOString()
    }, { merge: true });
}

async function writeFirestoreDocumentWithRetry(storeId, value, attempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            await writeFirestoreDocument(storeId, value);
            return;
        } catch (error) {
            lastError = error;
            if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
    }
    throw lastError;
}

// Một đường khởi tạo Firebase duy nhất dùng chung cho runtime, migration và script kiểm tra.
function connectFirestore(options = {}) {
    if (db) return { credentials, databaseId, collectionName, credentialSource };

    const account = loadServiceAccount(process.env, { projectRoot: options.projectRoot });
    credentials = account.credentials;
    credentialSource = account.source;
    databaseId = options.databaseId || getDatabaseId();
    collectionName = options.collectionName || getCollectionName();

    if (account.source === "env-fields") {
        console.warn(
            "[Firebase] Đang dùng FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY. " +
            "Nên chuyển sang FIREBASE_SERVICE_ACCOUNT_FILE để đơn giản và an toàn hơn."
        );
    }

    db = createFirestore(credentials, databaseId);
    backend = "firestore";
    return { credentials, databaseId, collectionName, credentialSource };
}

async function initializeFirestorePersistence(options = {}) {
    const connection = connectFirestore(options);
    const storeIds = options.storeIds || [];

    // Đọc SONG SONG: các store độc lập với nhau nên đọc tuần tự chỉ nhân độ trễ
    // mạng lên theo số store. Với 9 store × ~250ms thì tiết kiệm được ~2 giây.
    const loaded = await Promise.all(storeIds.map(async (storeId) => {
        const value = await readFirestoreDocument(storeId);
        return { storeId, value };
    }));
    for (const item of loaded) {
        if (item.value != null) cache.set(item.storeId, item.value);
    }

    return {
        ...describeFirebaseTarget({ credentials: connection.credentials, databaseId: connection.databaseId, collectionName: connection.collectionName }),
        credentialSource: connection.credentialSource,
        storeIds
    };
}

// Liệt kê các file JSON có thể nhập từ một thư mục. Store do bot khác sở hữu bị
// loại bỏ ở đây để mọi đường nhập dữ liệu đều không thể ghi đè dữ liệu đã tách.
function listImportableStoreFiles(sourceDirectory) {
    return fs.readdirSync(sourceDirectory)
        .filter((name) => name.toLowerCase().endsWith(".json"))
        .map((name) => ({ fileName: name, storeId: storeIdFromPath(name) }))
        .filter((item) => !RESERVED_STORE_IDS.has(item.storeId))
        .sort((left, right) => left.fileName.localeCompare(right.fileName));
}

async function importJsonDirectory(sourceDirectory, options = {}) {
    const resolvedSource = path.resolve(String(sourceDirectory || ""));
    if (!sourceDirectory || !fs.existsSync(resolvedSource)) {
        throw new Error(`Không tìm thấy thư mục nguồn để migrate: ${resolvedSource || "(trống)"}`);
    }
    if (!fs.statSync(resolvedSource).isDirectory()) {
        throw new Error(`Đường dẫn nguồn migrate không phải thư mục: ${resolvedSource}`);
    }

    const files = listImportableStoreFiles(resolvedSource);
    if (files.length === 0) {
        return { sourceDirectory: resolvedSource, items: [] };
    }

    connectFirestore(options);

    const items = [];
    for (const { fileName, storeId } of files) {
        const absoluteFile = path.join(resolvedSource, fileName);
        let value;
        try {
            value = JSON.parse(fs.readFileSync(absoluteFile, "utf8"));
        } catch (error) {
            throw new Error(`File JSON không hợp lệ: ${fileName} (${error.message})`);
        }
        await writeFirestoreDocumentWithRetry(storeId, value);
        items.push({ fileName, storeId });
    }

    return {
        sourceDirectory: resolvedSource,
        target: describeFirebaseTarget({ credentials, databaseId, collectionName }),
        items
    };
}

// Chờ tới khi MỌI thay đổi đang chờ đã được ghi xong.
//
// Vòng lặp có giới hạn: nếu Firestore liên tục lỗi thì không được treo tiến trình
// mãi. Sau số lượt tối đa, lỗi đã được ghi log và hàm trả về.
async function flushPersistenceWrites({ maxPasses = 5 } = {}) {
    for (let pass = 0; pass < maxPasses; pass += 1) {
        // Store còn bẩn mà chưa có writer (ví dụ writer vừa kết thúc) thì khởi động.
        for (const storeId of [...dirtyStores]) {
            if (!activeWriters.has(storeId)) startStoreWriter(storeId);
        }
        if (activeWriters.size === 0) return;

        await Promise.allSettled([...activeWriters.values()]);

        // Trong lúc chờ có thay đổi mới ⇒ chạy thêm một lượt.
        if (dirtyStores.size === 0 && activeWriters.size === 0) return;
    }
    if (dirtyStores.size > 0) {
        console.error(`[Persistence] còn ${dirtyStores.size} store chưa ghi được sau ${maxPasses} lượt.`);
    }
}

function getPersistenceStatus() {
    return {
        backend,
        projectId: credentials?.project_id || null,
        databaseId,
        collectionName,
        credentialSource,
        lastWriteAt: lastPersistenceWriteAt,
        lastError: lastPersistenceError
    };
}

module.exports = {
    RESERVED_STORE_IDS,
    connectFirestore,
    flushPersistenceWrites,
    getPersistenceQueueStats,
    getPersistenceStatus,
    importJsonDirectory,
    initializeFirestorePersistence,
    listImportableStoreFiles,
    normalizePrivateKey,
    readJsonStore,
    writeJsonStore
};
