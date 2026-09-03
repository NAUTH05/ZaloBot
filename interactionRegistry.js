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
    if (/private|user|direct|personal|individual|c[aá] nh[aâ]n/.test(rawType)) return "private";
    return "unknown";
}

function recordInteraction(context, msg = {}, date = new Date(), filePath = FILE_PATH) {
    const chatId = String(context.chatId);
    const userId = String(context.userId || "");
    const registry = readRegistry(filePath);
    const existing = registry[chatId] || {};
    const isFirstInteraction = !existing.firstInteractionAt;
    const members = existing.members && typeof existing.members === "object" ? { ...existing.members } : {};
    if (existing.lastUserId && !members[String(existing.lastUserId)]) {
        members[String(existing.lastUserId)] = {
            userId: String(existing.lastUserId),
            displayName: String(existing.lastUserDisplayName || ""),
            firstInteractionAt: existing.firstInteractionAt || date.toISOString(),
            lastInteractionAt: existing.lastInteractionAt || date.toISOString()
        };
    }
    if (userId) {
        const member = members[userId] || {};
        members[userId] = {
            userId,
            displayName: String(context.userDisplayName || member.displayName || ""),
            status: member.status || "active",
            firstInteractionAt: member.firstInteractionAt || date.toISOString(),
            lastInteractionAt: date.toISOString()
        };
    }
    registry[chatId] = {
        chatId,
        chatType: detectChatType(msg),
        chatTitle: String(msg.chat?.title || msg.chat?.name || existing.chatTitle || ""),
        lastUserId: userId,
        lastUserDisplayName: String(context.userDisplayName || ""),
        members,
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

function upsertInteractionMember(input = {}, filePath = FILE_PATH) {
    const chatId = String(input.chatId || "").trim();
    const userId = String(input.userId || "").trim();
    if (!chatId || !userId) throw new Error("Cần chatId và userId");
    const registry = readRegistry(filePath);
    const existing = registry[chatId] || {};
    const members = existing.members && typeof existing.members === "object" ? { ...existing.members } : {};
    const member = members[userId] || {};
    const now = new Date().toISOString();
    members[userId] = {
        ...member,
        userId,
        displayName: String(input.displayName ?? member.displayName ?? "").trim(),
        status: ["active", "disabled", "removed"].includes(input.status) ? input.status : (member.status || "active"),
        firstInteractionAt: member.firstInteractionAt || input.firstInteractionAt || now,
        lastInteractionAt: input.lastInteractionAt || member.lastInteractionAt || now,
        updatedAt: now
    };
    if (members[userId].status === "active") delete members[userId].removedAt;
    registry[chatId] = {
        ...existing,
        chatId,
        chatType: ["private", "group", "unknown"].includes(input.chatType) ? input.chatType : (existing.chatType || "unknown"),
        chatTitle: String(input.chatTitle ?? existing.chatTitle ?? "").trim(),
        lastUserId: existing.lastUserId || userId,
        lastUserDisplayName: existing.lastUserDisplayName || members[userId].displayName,
        members,
        firstInteractionAt: existing.firstInteractionAt || now,
        lastInteractionAt: existing.lastInteractionAt || now
    };
    writeRegistry(registry, filePath);
    return members[userId];
}

function removeInteractionMember(chatIdInput, userIdInput, hard = false, filePath = FILE_PATH) {
    const chatId = String(chatIdInput || "").trim();
    const userId = String(userIdInput || "").trim();
    const registry = readRegistry(filePath);
    const existing = registry[chatId];
    if (!existing?.members?.[userId]) return null;
    const members = { ...existing.members };
    const removed = members[userId];
    if (hard) delete members[userId];
    else members[userId] = { ...removed, status: "removed", removedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    registry[chatId] = { ...existing, members };
    writeRegistry(registry, filePath);
    return hard ? removed : members[userId];
}

module.exports = {
    FILE_PATH,
    detectChatType,
    getInteractionTargets,
    readRegistry,
    recordInteraction,
    removeInteractionMember,
    upsertInteractionMember
};
