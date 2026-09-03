const fs = require("fs");
const path = require("path");
let cert;
let getApps;
let initializeApp;
let getFirestore;

try {
    ({ cert, getApps, initializeApp } = require("firebase-admin/app"));
    ({ getFirestore } = require("firebase-admin/firestore"));
} catch (_) {
    // Compatibility with firebase-admin versions before modular subpath exports.
    const legacyAdmin = require("firebase-admin");
    cert = legacyAdmin.credential.cert;
    getApps = () => legacyAdmin.apps || [];
    initializeApp = legacyAdmin.initializeApp.bind(legacyAdmin);
    getFirestore = legacyAdmin.firestore.bind(legacyAdmin);
}

const DEFAULT_COLLECTION = "bot_state";
const DEFAULT_CREDENTIAL_PATH = "";

let backend = "local";
let credentials = null;
let databaseId = "(default)";
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

function loadCredentials(credentialsPath = process.env.FIREBASE_SERVICE_ACCOUNT_FILE || process.env.FIREBASE_SERVICE_ACCOUNT_PATH || DEFAULT_CREDENTIAL_PATH) {
    const envProjectId = String(process.env.FIREBASE_PROJECT_ID || "").trim();
    const envClientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || "").trim();
    const envPrivateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);
    const externalFileConfigured = Boolean(String(process.env.FIREBASE_SERVICE_ACCOUNT_FILE || "").trim());
    if (!externalFileConfigured && envProjectId && envClientEmail && envPrivateKey) {
        return {
            project_id: envProjectId,
            client_email: envClientEmail,
            private_key: envPrivateKey
        };
    }
    if (!credentialsPath) {
        throw new Error(
            "Thiếu FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL hoặc FIREBASE_PRIVATE_KEY trong môi trường"
        );
    }
    if (!fs.existsSync(credentialsPath)) {
        throw new Error(`Không tìm thấy service account Firebase tại ${credentialsPath}`);
    }
    const data = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
    if (!data.project_id || !data.client_email || !data.private_key) {
        throw new Error("Service account Firebase thiếu project_id, client_email hoặc private_key");
    }
    if (!data.client_email.endsWith(".iam.gserviceaccount.com")) {
        throw new Error("client_email không phải email service account Firebase");
    }
    data.private_key = normalizePrivateKey(data.private_key);
    if (!data.private_key.includes("-----BEGIN PRIVATE KEY-----") || !data.private_key.includes("-----END PRIVATE KEY-----")) {
        throw new Error("private_key không phải khóa PEM hợp lệ của service account Firebase");
    }
    return data;
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

async function initializeFirestorePersistence(options = {}) {
    credentials = loadCredentials(options.credentialsPath);
    databaseId = options.databaseId || process.env.FIREBASE_DATABASE_ID || "(default)";
    collectionName = options.collectionName || process.env.FIREBASE_STATE_COLLECTION || DEFAULT_COLLECTION;
    if (getApps().length === 0) {
        initializeApp({
            credential: cert(credentials),
            projectId: credentials.project_id
        });
    }
    db = getFirestore();
    const storeIds = options.storeIds || [];
    for (const storeId of storeIds) {
        const value = await readFirestoreDocument(storeId);
        if (value != null) cache.set(storeId, value);
    }
    backend = "firestore";
    return { projectId: credentials.project_id, databaseId, collectionName };
}

async function importJsonDirectory(sourceDirectory) {
    credentials ||= loadCredentials();
    databaseId = process.env.FIREBASE_DATABASE_ID || "(default)";
    collectionName = process.env.FIREBASE_STATE_COLLECTION || DEFAULT_COLLECTION;
    if (!db) {
        if (getApps().length === 0) {
            initializeApp({
                credential: cert(credentials),
                projectId: credentials.project_id
            });
        }
        db = getFirestore();
    }
    const files = fs.readdirSync(sourceDirectory).filter((name) => name.toLowerCase().endsWith(".json"));
    const result = [];
    for (const fileName of files) {
        const storeId = storeIdFromPath(fileName);
        const value = JSON.parse(fs.readFileSync(path.join(sourceDirectory, fileName), "utf8"));
        await writeFirestoreDocument(storeId, value);
        result.push({ fileName, storeId });
    }
    return result;
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
        lastWriteAt: lastPersistenceWriteAt,
        lastError: lastPersistenceError
    };
}

module.exports = {
    DEFAULT_CREDENTIAL_PATH,
    flushPersistenceWrites,
    importJsonDirectory,
    initializeFirestorePersistence,
    getPersistenceStatus,
    normalizePrivateKey,
    readJsonStore,
    writeJsonStore
};
