const fs = require("fs");
const path = require("path");

const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

// Thư mục dự án. Đường dẫn tương đối luôn được tính từ đây để .env hoạt động
// giống nhau dù tiến trình được khởi động từ thư mục nào (PM2, systemd, terminal).
const PROJECT_ROOT = __dirname;

// Một biến cấu hình chính thức cho Firebase.
const SERVICE_ACCOUNT_FILE_VAR = "FIREBASE_SERVICE_ACCOUNT_FILE";
// Alias cũ, chỉ giữ để tương thích ngược với cấu hình đã triển khai.
const LEGACY_SERVICE_ACCOUNT_FILE_VAR = "FIREBASE_SERVICE_ACCOUNT_PATH";
const LEGACY_INLINE_VARS = ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"];

const DEFAULT_DATABASE_ID = "(default)";
const DEFAULT_COLLECTION = "bot_state";
const SERVICE_ACCOUNT_SUFFIX = ".iam.gserviceaccount.com";

function stripWrappingQuotes(value) {
    let text = String(value == null ? "" : value).trim();
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        text = text.slice(1, -1).trim();
    }
    return text;
}

function normalizePrivateKey(value) {
    let key = String(value || "").trim();
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
    return key
        .replace(/\\\\n/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\\r?\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\r/g, "")
        .replace(/\\+$/g, "")
        .trim();
}

function pickConfiguredPath(env = process.env) {
    const primary = stripWrappingQuotes(env[SERVICE_ACCOUNT_FILE_VAR]);
    if (primary) return { configuredPath: primary, sourceVar: SERVICE_ACCOUNT_FILE_VAR };
    const legacy = stripWrappingQuotes(env[LEGACY_SERVICE_ACCOUNT_FILE_VAR]);
    if (legacy) return { configuredPath: legacy, sourceVar: LEGACY_SERVICE_ACCOUNT_FILE_VAR };
    return { configuredPath: "", sourceVar: SERVICE_ACCOUNT_FILE_VAR };
}

// Đường dẫn tuyệt đối được giữ nguyên.
// Đường dẫn tương đối được tính từ thư mục dự án; nếu không có ở đó nhưng có ở
// thư mục làm việc hiện tại thì dùng thư mục làm việc để không phá vỡ cách chạy cũ.
function resolveServiceAccountPath(configuredPath, projectRoot = PROJECT_ROOT) {
    const raw = stripWrappingQuotes(configuredPath);
    if (!raw) return null;
    if (path.isAbsolute(raw)) return path.normalize(raw);
    const fromProjectRoot = path.resolve(projectRoot, raw);
    if (fs.existsSync(fromProjectRoot)) return fromProjectRoot;
    const fromWorkingDirectory = path.resolve(process.cwd(), raw);
    if (fromWorkingDirectory !== fromProjectRoot && fs.existsSync(fromWorkingDirectory)) return fromWorkingDirectory;
    return fromProjectRoot;
}

function validateServiceAccount(data, sourceLabel) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error(`Cấu hình Firebase không hợp lệ (${sourceLabel}): nội dung phải là một JSON object.`);
    }

    const missing = ["project_id", "client_email", "private_key"].filter((field) => !String(data[field] || "").trim());
    if (missing.length) {
        throw new Error(
            `Cấu hình Firebase thiếu trường bắt buộc (${sourceLabel}): ${missing.join(", ")}. ` +
            "Hãy tải lại file JSON service account từ Firebase Console."
        );
    }

    const clientEmail = String(data.client_email).trim();
    if (!clientEmail.endsWith(SERVICE_ACCOUNT_SUFFIX)) {
        throw new Error(
            `Cấu hình Firebase không hợp lệ (${sourceLabel}): client_email không phải email service account của Firebase ` +
            `(phải kết thúc bằng ${SERVICE_ACCOUNT_SUFFIX}).`
        );
    }

    const privateKey = normalizePrivateKey(data.private_key);
    if (!privateKey.includes("-----BEGIN PRIVATE KEY-----") || !privateKey.includes("-----END PRIVATE KEY-----")) {
        throw new Error(
            `Cấu hình Firebase không hợp lệ (${sourceLabel}): private_key không phải khóa PEM hoàn chỉnh. ` +
            `Nên dùng ${SERVICE_ACCOUNT_FILE_VAR} trỏ tới file JSON đã tải từ Firebase Console.`
        );
    }

    return {
        ...data,
        project_id: String(data.project_id).trim(),
        client_email: clientEmail,
        private_key: privateKey
    };
}

function loadServiceAccountFromFile(configuredPath, projectRoot = PROJECT_ROOT) {
    const resolvedPath = resolveServiceAccountPath(configuredPath, projectRoot);
    if (!resolvedPath) {
        throw new Error(`Thiếu ${SERVICE_ACCOUNT_FILE_VAR}. Hãy trỏ tới file JSON service account của Firebase.`);
    }
    if (!fs.existsSync(resolvedPath)) {
        throw new Error(
            `Không tìm thấy file cấu hình Firebase tại: ${resolvedPath}. ` +
            `Kiểm tra lại ${SERVICE_ACCOUNT_FILE_VAR} trong .env (đường dẫn tương đối tính từ thư mục dự án).`
        );
    }

    let raw;
    try {
        raw = fs.readFileSync(resolvedPath, "utf8");
    } catch (error) {
        throw new Error(`Không đọc được file cấu hình Firebase tại ${resolvedPath}: ${error.message}`);
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`File cấu hình Firebase không phải JSON hợp lệ (${resolvedPath}): ${error.message}`);
    }

    // Không bao giờ ghi nội dung file cấu hình ra log; chỉ dùng đường dẫn khi báo lỗi.
    return validateServiceAccount(parsed, path.basename(resolvedPath));
}

function loadInlineServiceAccount(env = process.env) {
    const projectId = stripWrappingQuotes(env.FIREBASE_PROJECT_ID);
    const clientEmail = stripWrappingQuotes(env.FIREBASE_CLIENT_EMAIL);
    const privateKey = normalizePrivateKey(env.FIREBASE_PRIVATE_KEY);
    if (!projectId || !clientEmail || !privateKey) return null;
    return validateServiceAccount({ project_id: projectId, client_email: clientEmail, private_key: privateKey }, "biến môi trường");
}

// Cấu hình ưu tiên: MỘT file JSON service account đã tải từ Firebase Console.
// Các biến rời (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY)
// chỉ còn là phương án dự phòng cho cấu hình cũ.
function loadServiceAccount(env = process.env, options = {}) {
    const projectRoot = options.projectRoot || PROJECT_ROOT;
    const { configuredPath, sourceVar } = pickConfiguredPath(env);

    if (configuredPath) {
        const credentials = loadServiceAccountFromFile(configuredPath, projectRoot);
        return { credentials, source: "file", sourceVar, configuredPath };
    }

    const inline = loadInlineServiceAccount(env);
    if (inline) {
        return { credentials: inline, source: "env-fields", sourceVar: null, configuredPath: "" };
    }

    throw new Error(
        `Thiếu cấu hình Firebase. Hãy tải file JSON service account từ Firebase Console và đặt ` +
        `${SERVICE_ACCOUNT_FILE_VAR}=./zalobot-firebase-adminsdk-fbsvc.json trong .env ` +
        `(hoặc dùng đường dẫn tuyệt đối tới file đó).`
    );
}

function getDatabaseId(env = process.env) {
    const configured = stripWrappingQuotes(env.FIREBASE_DATABASE_ID);
    return configured || DEFAULT_DATABASE_ID;
}

function getCollectionName(env = process.env) {
    const configured = stripWrappingQuotes(env.FIREBASE_STATE_COLLECTION);
    return configured || DEFAULT_COLLECTION;
}

function isDefaultDatabaseId(databaseId) {
    const value = stripWrappingQuotes(databaseId);
    return !value || value.toLowerCase() === "default" || value === DEFAULT_DATABASE_ID;
}

// Firebase Admin giữ một app singleton cho mỗi tiến trình. Không tạo thêm app
// để tránh nhiều phiên bản Firestore ghi trùng dữ liệu.
function getFirebaseApp(credentials) {
    const existing = getApps();
    if (existing.length > 0) return existing[0];
    try {
        return initializeApp({
            credential: cert(credentials),
            projectId: credentials.project_id
        });
    } catch (error) {
        throw new Error(`Không thể khởi tạo Firebase: ${error.message}`);
    }
}

// `(default)` gọi getFirestore(app) để tương thích mọi phiên bản firebase-admin.
// Database ID tùy chỉnh dùng getFirestore(app, databaseId) (hỗ trợ từ firebase-admin v10).
function createFirestore(credentials, databaseId = DEFAULT_DATABASE_ID) {
    const app = getFirebaseApp(credentials);
    try {
        return isDefaultDatabaseId(databaseId) ? getFirestore(app) : getFirestore(app, stripWrappingQuotes(databaseId));
    } catch (error) {
        throw new Error(`Không thể kết nối Firestore (database "${databaseId}"): ${error.message}`);
    }
}

// Thông tin an toàn để ghi log: không chứa khóa, email hay nội dung file JSON.
function describeFirebaseTarget({ credentials, databaseId, collectionName } = {}) {
    return {
        projectId: credentials?.project_id || null,
        databaseId: isDefaultDatabaseId(databaseId) ? DEFAULT_DATABASE_ID : stripWrappingQuotes(databaseId),
        collectionName: collectionName || DEFAULT_COLLECTION
    };
}

module.exports = {
    DEFAULT_COLLECTION,
    DEFAULT_DATABASE_ID,
    LEGACY_INLINE_VARS,
    LEGACY_SERVICE_ACCOUNT_FILE_VAR,
    PROJECT_ROOT,
    SERVICE_ACCOUNT_FILE_VAR,
    createFirestore,
    describeFirebaseTarget,
    getCollectionName,
    getDatabaseId,
    getFirebaseApp,
    isDefaultDatabaseId,
    loadServiceAccount,
    loadServiceAccountFromFile,
    normalizePrivateKey,
    resolveServiceAccountPath,
    validateServiceAccount
};
