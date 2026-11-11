const path = require("path");
const { readJsonStore, writeJsonStore } = require("./firestorePersistence");

const FILE_PATH = path.join(__dirname, "adminSettings.json");
const SCHEMA_VERSION = 2;
const DEFAULT_PAGE_SIZE = 25;
// Command console nhiều người nhận: số người tối đa mỗi lượt và khoảng nghỉ
// giữa hai lần gửi để không dồn dập Zalo.
const DEFAULT_MAX_BATCH_SIZE = 25;
const DEFAULT_BATCH_DELAY_MS = 350;
const MAX_BATCH_SIZE_LIMIT = 100;
const MAX_BATCH_DELAY_MS = 5000;

function nowIso() { return new Date().toISOString(); }

function normalizeId(value) {
    const id = String(value == null ? "" : value).trim();
    return id || null;
}

function envIds(name) {
    return String(process.env[name] || "").split(",").map(normalizeId).filter(Boolean);
}

function normalizeAdmin(input = {}, existing = {}) {
    const userId = normalizeId(input.userId ?? existing.userId);
    const chatId = normalizeId(input.chatId ?? existing.chatId);
    if (!userId && !chatId) return null;
    return {
        ...existing,
        ...input,
        userId,
        chatId,
        displayName: String(input.displayName ?? existing.displayName ?? "").trim(),
        enabled: input.enabled !== false,
        createdAt: existing.createdAt || input.createdAt || nowIso(),
        updatedAt: nowIso()
    };
}

function readSettings(filePath = FILE_PATH) {
    const fallback = { schemaVersion: SCHEMA_VERSION, admins: [], defaultPageSize: DEFAULT_PAGE_SIZE, maxBatchSize: DEFAULT_MAX_BATCH_SIZE, batchDelayMs: DEFAULT_BATCH_DELAY_MS };
    const data = readJsonStore(filePath, FILE_PATH, fallback);
    const admins = Array.isArray(data?.admins) ? data.admins.map((item) => normalizeAdmin(item)).filter(Boolean) : [];
    const parsedPageSize = Number(data?.defaultPageSize);
    const defaultPageSize = [10, 20, 25, 50, 100].includes(parsedPageSize) ? parsedPageSize : DEFAULT_PAGE_SIZE;
    const parsedBatchSize = Number(data?.maxBatchSize);
    const maxBatchSize = Number.isInteger(parsedBatchSize) && parsedBatchSize >= 1 && parsedBatchSize <= MAX_BATCH_SIZE_LIMIT
        ? parsedBatchSize
        : DEFAULT_MAX_BATCH_SIZE;
    const parsedDelay = Number(data?.batchDelayMs);
    const batchDelayMs = Number.isInteger(parsedDelay) && parsedDelay >= 0 && parsedDelay <= MAX_BATCH_DELAY_MS
        ? parsedDelay
        : DEFAULT_BATCH_DELAY_MS;
    return { schemaVersion: SCHEMA_VERSION, admins, defaultPageSize, maxBatchSize, batchDelayMs };
}

function writeSettings(settings, filePath = FILE_PATH) {
    writeJsonStore(filePath, FILE_PATH, {
        schemaVersion: SCHEMA_VERSION,
        admins: settings.admins || [],
        defaultPageSize: settings.defaultPageSize || DEFAULT_PAGE_SIZE,
        maxBatchSize: settings.maxBatchSize || DEFAULT_MAX_BATCH_SIZE,
        batchDelayMs: Number.isInteger(settings.batchDelayMs) ? settings.batchDelayMs : DEFAULT_BATCH_DELAY_MS
    });
}

function getAdminSettings(filePath = FILE_PATH) {
    return readSettings(filePath);
}

function getConfiguredAdminIds(filePath = FILE_PATH) {
    const settings = readSettings(filePath);
    return {
        userIds: [...new Set([...envIds("OWNER_USER_ID"), ...settings.admins.filter((a) => a.enabled !== false).map((a) => a.userId).filter(Boolean)])],
        chatIds: [...new Set([...envIds("OWNER_CHAT_ID"), ...settings.admins.filter((a) => a.enabled !== false).map((a) => a.chatId).filter(Boolean)])]
    };
}

function isConfiguredAdmin(context, filePath = FILE_PATH) {
    const userId = String(context?.userId || "");
    const chatId = String(context?.chatId || "");
    if (envIds("OWNER_USER_ID").includes(userId) || envIds("OWNER_CHAT_ID").includes(chatId)) return true;
    return readSettings(filePath).admins.some((admin) => {
        if (admin.enabled === false) return false;
        if (admin.userId && admin.chatId) return admin.userId === userId && admin.chatId === chatId;
        if (admin.userId) return admin.userId === userId;
        return admin.chatId === chatId;
    });
}

function upsertAdmin(input = {}, filePath = FILE_PATH) {
    const settings = readSettings(filePath);
    const userId = normalizeId(input.userId);
    const chatId = normalizeId(input.chatId);
    const index = settings.admins.findIndex((item) => {
        if (userId && chatId) return item.userId === userId && item.chatId === chatId;
        if (userId) return item.userId === userId && !item.chatId;
        return item.chatId === chatId && !item.userId;
    });
    const existing = index >= 0 ? settings.admins[index] : {};
    const record = normalizeAdmin(input, existing);
    if (!record) throw new Error("Cần userId hoặc chatId của admin");
    if (index >= 0) settings.admins[index] = record;
    else settings.admins.push(record);
    writeSettings(settings, filePath);
    return record;
}

function removeAdmin(identifier, filePath = FILE_PATH) {
    const id = normalizeId(identifier);
    const settings = readSettings(filePath);
    const index = settings.admins.findIndex((item) => item.userId === id || item.chatId === id);
    if (index < 0) return null;
    const [removed] = settings.admins.splice(index, 1);
    writeSettings(settings, filePath);
    return removed;
}

function setDefaultPageSize(value, filePath = FILE_PATH) {
    const pageSize = Number(value);
    if (![10, 20, 25, 50, 100].includes(pageSize)) throw new Error("defaultPageSize must be one of 10, 20, 25, 50, 100");
    const settings = readSettings(filePath);
    settings.defaultPageSize = pageSize;
    writeSettings(settings, filePath);
    return settings;
}

// Giới hạn số người nhận mỗi lượt của Command console.
function setMaxBatchSize(value, filePath = FILE_PATH) {
    const size = Number(value);
    if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH_SIZE_LIMIT) {
        throw new Error(`maxBatchSize must be an integer between 1 and ${MAX_BATCH_SIZE_LIMIT}`);
    }
    const settings = readSettings(filePath);
    settings.maxBatchSize = size;
    writeSettings(settings, filePath);
    return settings;
}

// Khoảng nghỉ giữa hai lần gửi trong một lượt nhiều người nhận.
function setBatchDelayMs(value, filePath = FILE_PATH) {
    const delay = Number(value);
    if (!Number.isInteger(delay) || delay < 0 || delay > MAX_BATCH_DELAY_MS) {
        throw new Error(`batchDelayMs must be an integer between 0 and ${MAX_BATCH_DELAY_MS}`);
    }
    const settings = readSettings(filePath);
    settings.batchDelayMs = delay;
    writeSettings(settings, filePath);
    return settings;
}

module.exports = {
    DEFAULT_BATCH_DELAY_MS,
    DEFAULT_MAX_BATCH_SIZE,
    DEFAULT_PAGE_SIZE,
    FILE_PATH,
    MAX_BATCH_DELAY_MS,
    MAX_BATCH_SIZE_LIMIT,
    getAdminSettings,
    getConfiguredAdminIds,
    isConfiguredAdmin,
    removeAdmin,
    setBatchDelayMs,
    setDefaultPageSize,
    setMaxBatchSize,
    upsertAdmin
};
