const fs = require("fs");
const path = require("path");
const { getInteractionTargets } = require("./interactionRegistry");
const { readJsonStore, writeJsonStore } = require("./firestorePersistence");

const FILE_PATH = path.join(__dirname, "accessControl.json");
const ACCESS_SCHEMA_VERSION = 1;

function readAccessData(filePath = FILE_PATH) {
    const empty = {
            schemaVersion: ACCESS_SCHEMA_VERSION,
            botMode: "all", // "all" | "allowlist"
            aiMode: "all",  // "all" | "allowlist"
            botBlocked: {},  // targetId -> { targetId, targetName, targetType, blockedAt, reason }
            aiBlocked: {},
            botAllowlist: {},
            aiAllowlist: {}
        };
    try {
        const data = readJsonStore(filePath, FILE_PATH, empty);
        return {
            schemaVersion: ACCESS_SCHEMA_VERSION,
            botMode: data.botMode || "all",
            aiMode: data.aiMode || "all",
            botBlocked: data.botBlocked || {},
            aiBlocked: data.aiBlocked || {},
            botAllowlist: data.botAllowlist || {},
            aiAllowlist: data.aiAllowlist || {}
        };
    } catch (error) {
        console.error("Không đọc được accessControl.json:", error.message);
        return {
            schemaVersion: ACCESS_SCHEMA_VERSION,
            botMode: "all",
            aiMode: "all",
            botBlocked: {},
            aiBlocked: {},
            botAllowlist: {},
            aiAllowlist: {}
        };
    }
}

function writeAccessData(data, filePath = FILE_PATH) {
    writeJsonStore(filePath, FILE_PATH, data);
}

function resolveTarget(input) {
    const raw = String(input || "").trim();
    if (!raw) return null;

    const targets = getInteractionTargets();
    // 1. Kiểm tra khớp chính xác ID trước (chatId hoặc userId)
    for (const t of targets) {
        if (String(t.chatId) === raw) {
            const name = t.chatTitle || t.lastUserDisplayName || `Group ${t.chatId}`;
            return { targetId: String(t.chatId), targetName: name, targetType: t.chatType || "group" };
        }
        if (String(t.lastUserId) === raw) {
            const name = t.lastUserDisplayName || `User ${t.lastUserId}`;
            return { targetId: String(t.lastUserId), targetName: name, targetType: "user" };
        }
    }

    // 2. Tìm kiếm theo tên nhóm hoặc tên user
    const lower = raw.toLowerCase();
    for (const t of targets) {
        if (t.chatTitle && t.chatTitle.toLowerCase().includes(lower)) {
            return { targetId: String(t.chatId), targetName: t.chatTitle, targetType: "group" };
        }
        if (t.lastUserDisplayName && t.lastUserDisplayName.toLowerCase().includes(lower)) {
            return { targetId: String(t.lastUserId), targetName: t.lastUserDisplayName, targetType: "user" };
        }
    }

    // 3. Nếu là chuỗi số / ID không có trong sổ tương tác
    return { targetId: raw, targetName: `ID ${raw}`, targetType: "unknown" };
}

function canUseBot(context, filePath = FILE_PATH) {
    const userId = String(context?.userId || "");
    const chatId = String(context?.chatId || "");
    const data = readAccessData(filePath);

    // Chặn nếu userId hoặc chatId nằm trong botBlocked
    if (data.botBlocked[userId] || data.botBlocked[chatId]) {
        const blockedInfo = data.botBlocked[userId] || data.botBlocked[chatId];
        return { allowed: false, reason: "blocked", blockedInfo };
    }

    if (data.botMode === "allowlist") {
        if (!data.botAllowlist[userId] && !data.botAllowlist[chatId]) {
            return { allowed: false, reason: "not_in_allowlist" };
        }
    }

    return { allowed: true };
}

function canUseAi(context, filePath = FILE_PATH) {
    const botCheck = canUseBot(context, filePath);
    if (!botCheck.allowed) return botCheck;

    const userId = String(context?.userId || "");
    const chatId = String(context?.chatId || "");
    const data = readAccessData(filePath);

    if (data.aiBlocked[userId] || data.aiBlocked[chatId]) {
        const blockedInfo = data.aiBlocked[userId] || data.aiBlocked[chatId];
        return { allowed: false, reason: "ai_blocked", blockedInfo };
    }

    if (data.aiMode === "allowlist") {
        if (!data.aiAllowlist[userId] && !data.aiAllowlist[chatId]) {
            return { allowed: false, reason: "not_in_ai_allowlist" };
        }
    }

    return { allowed: true };
}

function blockTarget(type, targetInput, reason = "", filePath = FILE_PATH) {
    const target = resolveTarget(targetInput);
    if (!target) return null;

    const data = readAccessData(filePath);
    const storeKey = type === "ai" ? "aiBlocked" : "botBlocked";
    const entry = {
        targetId: target.targetId,
        targetName: target.targetName,
        targetType: target.targetType,
        blockedAt: new Date().toISOString(),
        reason: reason || "Admin block"
    };

    data[storeKey][target.targetId] = entry;
    writeAccessData(data, filePath);
    return entry;
}

function unblockTarget(type, targetInput, filePath = FILE_PATH) {
    const target = resolveTarget(targetInput);
    if (!target) return null;

    const data = readAccessData(filePath);
    const storeKey = type === "ai" ? "aiBlocked" : "botBlocked";
    const existing = data[storeKey][target.targetId];
    if (!existing) return null;

    delete data[storeKey][target.targetId];
    writeAccessData(data, filePath);
    return existing;
}

function allowTarget(type, targetInput, filePath = FILE_PATH) {
    const target = resolveTarget(targetInput);
    if (!target) return null;

    const data = readAccessData(filePath);
    const storeKey = type === "ai" ? "aiAllowlist" : "botAllowlist";
    const entry = {
        targetId: target.targetId,
        targetName: target.targetName,
        targetType: target.targetType,
        allowedAt: new Date().toISOString()
    };

    data[storeKey][target.targetId] = entry;
    writeAccessData(data, filePath);
    return entry;
}

function unallowTarget(type, targetInput, filePath = FILE_PATH) {
    const target = resolveTarget(targetInput);
    if (!target) return null;

    const data = readAccessData(filePath);
    const storeKey = type === "ai" ? "aiAllowlist" : "botAllowlist";
    const existing = data[storeKey][target.targetId];
    if (!existing) return null;

    delete data[storeKey][target.targetId];
    writeAccessData(data, filePath);
    return existing;
}

function setAccessMode(type, modeInput, filePath = FILE_PATH) {
    const mode = String(modeInput || "").toLowerCase();
    if (!["all", "allowlist"].includes(mode)) return null;

    const data = readAccessData(filePath);
    if (type === "ai") data.aiMode = mode;
    else data.botMode = mode;

    writeAccessData(data, filePath);
    return mode;
}

function getAccessSummary(filePath = FILE_PATH) {
    const data = readAccessData(filePath);
    return {
        botMode: data.botMode,
        aiMode: data.aiMode,
        botBlocked: Object.values(data.botBlocked),
        aiBlocked: Object.values(data.aiBlocked),
        botAllowlist: Object.values(data.botAllowlist),
        aiAllowlist: Object.values(data.aiAllowlist)
    };
}

module.exports = {
    FILE_PATH,
    allowTarget,
    blockTarget,
    canUseAi,
    canUseBot,
    getAccessSummary,
    readAccessData,
    resolveTarget,
    setAccessMode,
    unallowTarget,
    unblockTarget
};
