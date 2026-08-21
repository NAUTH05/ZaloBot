const path = require("path");
const { readJsonStore, writeJsonStore } = require("./firestorePersistence");

const FILE_PATH = path.join(__dirname, "chatDirectory.json");
const SCHEMA_VERSION = 2;
const STATUSES = new Set(["active", "inactive", "disabled", "removed"]);
const FEATURES = ["schedule", "duty", "birthday", "broadcast"];

function normalizeChatType(value, fallback = "unknown") {
    const raw = String(value == null ? "" : value).trim().toLowerCase();
    if (["group", "group_chat", "room", "nhom", "nhóm"].includes(raw)) return "group";
    if (["private", "user", "direct", "personal", "individual"].includes(raw)) return "private";
    return fallback;
}

function nowIso() {
    return new Date().toISOString();
}

function readDirectory(filePath = FILE_PATH) {
    try {
        const data = readJsonStore(filePath, FILE_PATH, { schemaVersion: SCHEMA_VERSION, chats: {} });
        if (data && typeof data === "object" && !Array.isArray(data)) {
            return {
                schemaVersion: SCHEMA_VERSION,
                chats: data.chats && typeof data.chats === "object" ? data.chats : {},
                deletedChatIds: data.deletedChatIds && typeof data.deletedChatIds === "object" ? data.deletedChatIds : {}
            };
        }
    } catch (error) {
        console.error(`Không đọc được ${path.basename(filePath)}:`, error.message);
    }
    return { schemaVersion: SCHEMA_VERSION, chats: {}, deletedChatIds: {} };
}

function writeDirectory(data, filePath = FILE_PATH) {
    writeJsonStore(filePath, FILE_PATH, data);
}

function normalizeChatId(chatId) {
    const value = String(chatId == null ? "" : chatId).trim();
    return value || null;
}

function normalizeRecord(chatId, input = {}, existing = {}) {
    const id = normalizeChatId(chatId);
    if (!id) return null;
    const timestamp = nowIso();
    const overrides = { ...(existing.notificationOverrides || {}), ...(input.notificationOverrides || {}) };
    for (const feature of FEATURES) {
        if (overrides[feature] !== true && overrides[feature] !== false) overrides[feature] = null;
    }
    const status = STATUSES.has(input.status) ? input.status : (STATUSES.has(existing.status) ? existing.status : "active");
    const { restoreDeleted, ...safeInput } = input;
    return {
        ...existing,
        ...safeInput,
        chatId: id,
        chatType: normalizeChatType(input.chatType, normalizeChatType(existing.chatType)),
        displayName: input.displayName || existing.displayName || input.chatTitle || existing.chatTitle || "",
        userId: String(input.userId || existing.userId || "").trim() || null,
        chatTitle: String(input.chatTitle || existing.chatTitle || "").trim(),
        notificationOverrides: overrides,
        status,
        consecutiveFailureCount: Number.isInteger(input.consecutiveFailureCount)
            ? input.consecutiveFailureCount
            : (Number.isInteger(existing.consecutiveFailureCount) ? existing.consecutiveFailureCount : 0),
        createdAt: existing.createdAt || input.createdAt || timestamp,
        updatedAt: timestamp
    };
}

function upsertChat(input = {}, filePath = FILE_PATH) {
    const chatId = normalizeChatId(input.chatId);
    if (!chatId) return null;
    const data = readDirectory(filePath);
    if (data.deletedChatIds[chatId] && input.restoreDeleted !== true) return null;
    if (input.restoreDeleted === true) delete data.deletedChatIds[chatId];
    const record = normalizeRecord(chatId, input, data.chats[chatId]);
    data.chats[chatId] = record;
    writeDirectory(data, filePath);
    return record;
}

function getChat(chatId, filePath = FILE_PATH) {
    const id = normalizeChatId(chatId);
    return id ? readDirectory(filePath).chats[id] || null : null;
}

function getAllChats(filePath = FILE_PATH) {
    return Object.values(readDirectory(filePath).chats).sort((a, b) => String(a.displayName || a.chatId).localeCompare(String(b.displayName || b.chatId)));
}

function isChatEligible(chatId, feature = null, filePath = FILE_PATH) {
    const id = normalizeChatId(chatId);
    if (id && readDirectory(filePath).deletedChatIds[id]) return false;
    const record = getChat(chatId, filePath);
    if (!record) return true;
    if (record.status !== "active") return false;
    if (feature && record.notificationOverrides?.[feature] === false) return false;
    return true;
}

function updateChat(chatId, changes = {}, filePath = FILE_PATH) {
    const id = normalizeChatId(chatId);
    if (!id) return null;
    const data = readDirectory(filePath);
    if (data.deletedChatIds[id] && changes.restoreDeleted !== true) return null;
    if (changes.restoreDeleted === true) delete data.deletedChatIds[id];
    const existing = data.chats[id] || normalizeRecord(id, {}, {});
    const record = normalizeRecord(id, changes, existing);
    data.chats[id] = record;
    writeDirectory(data, filePath);
    return record;
}

function removeChat(chatId, hard = false, filePath = FILE_PATH) {
    const id = normalizeChatId(chatId);
    if (!id) return null;
    if (!hard) return setChatStatus(id, "removed", "admin", "admin_removed", filePath);
    const data = readDirectory(filePath);
    const existing = data.chats[id] || null;
    if (!existing) return null;
    delete data.chats[id];
    data.deletedChatIds[id] = { deletedAt: nowIso(), deletedBy: "admin" };
    writeDirectory(data, filePath);
    return existing;
}

function classifyChatError(error) {
    const message = String(error?.message || error || "");
    const status = Number(error?.response?.statusCode || error?.response?.status || error?.statusCode || (message.match(/\b(408|410|403|429|5\d\d)\b/) || [])[1] || 0) || null;
    const invalid = status === 410 && /chat[_ ]id\s+is\s+invalid/i.test(message);
    const forbidden = status === 403 && /(chat|user|group|blocked|forbidden|not found|removed)/i.test(message);
    const transient = status === 408 || status === 429 || (status >= 500 && status <= 599) || /timeout|network|econn|socket/i.test(message);
    return {
        status,
        kind: invalid ? "permanent_invalid" : (forbidden ? "permanent_forbidden" : (transient ? "transient" : "unknown")),
        permanent: invalid || forbidden
    };
}

function recordDeliverySuccess(chatId, filePath = FILE_PATH) {
    const current = getChat(chatId, filePath);
    const history = Array.isArray(current?.deliveryHistory) ? current.deliveryHistory.slice(-49) : [];
    history.push({ result: "success", at: nowIso() });
    return updateChat(chatId, {
        status: current?.status || "active",
        consecutiveFailureCount: 0,
        lastSuccessfulDeliveryAt: nowIso(),
        lastRecoveredAt: current?.lastError ? nowIso() : current?.lastRecoveredAt,
        deliveryHistory: history
    }, filePath);
}

function recordDeliveryFailure(chatId, error, metadata = {}, filePath = FILE_PATH) {
    const current = getChat(chatId, filePath) || upsertChat({ chatId }, filePath);
    const classification = classifyChatError(error);
    const count = (Number(current?.consecutiveFailureCount) || 0) + 1;
    const shouldSuspend = classification.permanent || (classification.kind === "transient" && count >= (metadata.maxConsecutiveFailures || 3));
    const preserveManualStatus = current?.status === "disabled" || current?.status === "removed";
    const at = nowIso();
    const errorRecord = {
        code: error?.code || null,
        status: classification.status,
        message: String(error?.message || error || "Unknown error"),
        feature: metadata.feature || null,
        operation: metadata.operation || null,
        at
    };
    const history = Array.isArray(current?.deliveryHistory) ? current.deliveryHistory.slice(-49) : [];
    history.push({ result: "failed", ...errorRecord });
    return updateChat(chatId, {
        status: shouldSuspend && !preserveManualStatus ? "inactive" : (current?.status || "active"),
        statusReason: shouldSuspend && !preserveManualStatus ? (classification.kind === "permanent_invalid" ? "chat_id_invalid" : classification.kind === "permanent_forbidden" ? "chat_forbidden" : "consecutive_failures") : current?.statusReason,
        statusChangedAt: shouldSuspend && !preserveManualStatus ? at : current?.statusChangedAt,
        statusChangedBy: shouldSuspend && !preserveManualStatus ? "system" : current?.statusChangedBy,
        consecutiveFailureCount: count,
        lastError: errorRecord,
        deliveryHistory: history
    }, filePath);
}

function setChatStatus(chatId, status, actor = "admin", reason = null, filePath = FILE_PATH) {
    if (!STATUSES.has(status)) throw new Error(`Trạng thái chat không hợp lệ: ${status}`);
    return updateChat(chatId, {
        status,
        statusReason: reason,
        statusChangedAt: nowIso(),
        statusChangedBy: actor,
        consecutiveFailureCount: status === "active" ? 0 : (getChat(chatId, filePath)?.consecutiveFailureCount || 0)
    }, filePath);
}

function setFeatureOverride(chatId, feature, enabled, filePath = FILE_PATH) {
    if (!FEATURES.includes(feature)) throw new Error(`Tính năng không hợp lệ: ${feature}`);
    const current = getChat(chatId, filePath) || upsertChat({ chatId }, filePath);
    return updateChat(chatId, {
        notificationOverrides: { ...(current.notificationOverrides || {}), [feature]: enabled == null ? null : Boolean(enabled) }
    }, filePath);
}

module.exports = {
    FEATURES,
    FILE_PATH,
    SCHEMA_VERSION,
    classifyChatError,
    getAllChats,
    getChat,
    normalizeChatType,
    removeChat,
    isChatEligible,
    readDirectory,
    recordDeliveryFailure,
    recordDeliverySuccess,
    setChatStatus,
    setFeatureOverride,
    updateChat,
    upsertChat
};
