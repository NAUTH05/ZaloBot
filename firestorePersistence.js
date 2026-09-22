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
let writeQueue = Promise.resolve();
let lastPersistenceError = null;
let lastPersistenceWriteAt = null;

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
    cache.set(storeId, clone(value));
    writeQueue = writeQueue
        .catch(() => {})
        .then(() => writeFirestoreDocumentWithRetry(storeId, clone(value)))
        .then(() => {
            lastPersistenceError = null;
            lastPersistenceWriteAt = new Date().toISOString();
        })
        .catch((error) => {
            lastPersistenceError = { storeId, message: error.message, at: new Date().toISOString() };
            console.error(`Không thể ghi Firestore store ${storeId}:`, error.message);
        });
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
    for (const storeId of storeIds) {
        const value = await readFirestoreDocument(storeId);
        if (value != null) cache.set(storeId, value);
    }
    return {
        ...describeFirebaseTarget({ credentials: connection.credentials, databaseId: connection.databaseId, collectionName: connection.collectionName }),
        credentialSource: connection.credentialSource,
        storeIds
    };
}

async function importJsonDirectory(sourceDirectory, options = {}) {
    const resolvedSource = path.resolve(String(sourceDirectory || ""));
    if (!sourceDirectory || !fs.existsSync(resolvedSource)) {
        throw new Error(`Không tìm thấy thư mục nguồn để migrate: ${resolvedSource || "(trống)"}`);
    }
    if (!fs.statSync(resolvedSource).isDirectory()) {
        throw new Error(`Đường dẫn nguồn migrate không phải thư mục: ${resolvedSource}`);
    }

    const files = fs.readdirSync(resolvedSource).filter((name) => name.toLowerCase().endsWith(".json")).sort();
    if (files.length === 0) {
        return { sourceDirectory: resolvedSource, items: [] };
    }

    connectFirestore(options);

    const items = [];
    for (const fileName of files) {
        const storeId = storeIdFromPath(fileName);
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

function flushPersistenceWrites() {
    return writeQueue;
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
    connectFirestore,
    flushPersistenceWrites,
    getPersistenceStatus,
    importJsonDirectory,
    initializeFirestorePersistence,
    normalizePrivateKey,
    readJsonStore,
    writeJsonStore
};
