const path = require("path");
const { readJsonStore, writeJsonStore } = require("./firestorePersistence");

const FILE_PATH = path.join(__dirname, "interactions.json");

function readRegistry(filePath = FILE_PATH) {
    try {
        const data = readJsonStore(filePath, FILE_PATH, {});
        return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch (error) {
        console.error(`Không đọc được ${path.basename(filePath)}:`, error.message);
        return {};
    }
}

function writeRegistry(registry, filePath = FILE_PATH) {
    writeJsonStore(filePath, FILE_PATH, registry);
}

function detectChatType(msg = {}) {
    const rawType = String(msg.chat?.type || msg.chat_type || msg.type || "").toLowerCase();
    if (msg.group_id != null || /group|nh[oó]m/.test(rawType)) return "group";
    return "private";
}

function recordInteraction(context, msg = {}, date = new Date(), filePath = FILE_PATH) {
    const chatId = String(context.chatId);
    const registry = readRegistry(filePath);
    const existing = registry[chatId] || {};
    const isFirstInteraction = !existing.firstInteractionAt;
    registry[chatId] = {
        chatId,
        chatType: detectChatType(msg),
        chatTitle: String(msg.chat?.title || msg.chat?.name || existing.chatTitle || ""),
        lastUserId: String(context.userId || ""),
        lastUserDisplayName: String(context.userDisplayName || ""),
        firstInteractionAt: existing.firstInteractionAt || date.toISOString(),
        lastInteractionAt: date.toISOString()
    };
    writeRegistry(registry, filePath);
    return { ...registry[chatId], isFirstInteraction };
}

function getInteractionTargets(filePath = FILE_PATH) {
    return Object.values(readRegistry(filePath))
        .filter((target) => target?.chatId != null)
        .map((target) => ({ ...target, chatId: String(target.chatId) }));
}

module.exports = {
    FILE_PATH,
    detectChatType,
    getInteractionTargets,
    readRegistry,
    recordInteraction
};
