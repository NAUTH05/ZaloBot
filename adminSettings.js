const path = require("path");
const { readJsonStore, writeJsonStore } = require("./firestorePersistence");

const FILE_PATH = path.join(__dirname, "adminSettings.json");
const SCHEMA_VERSION = 1;

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
    const fallback = { schemaVersion: SCHEMA_VERSION, admins: [] };
    const data = readJsonStore(filePath, FILE_PATH, fallback);
    const admins = Array.isArray(data?.admins) ? data.admins.map((item) => normalizeAdmin(item)).filter(Boolean) : [];
    return { schemaVersion: SCHEMA_VERSION, admins };
}

function writeSettings(settings, filePath = FILE_PATH) {
    writeJsonStore(filePath, FILE_PATH, { schemaVersion: SCHEMA_VERSION, admins: settings.admins || [] });
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

module.exports = { FILE_PATH, getAdminSettings, getConfiguredAdminIds, isConfiguredAdmin, removeAdmin, upsertAdmin };
