const { getAllChats, getDeletedChatIds } = require("./chatDirectory");
const { getInteractionTargets } = require("./interactionRegistry");
const { getAllSubscriptions, isCurrentSubscription, normalizeNotificationTimes } = require("./subscriptions");
const { getAccessSummary } = require("./accessControl");
const { parseScopedKey, normalizeBotId, storageKeyPrefix, LEGACY_BOT_ID } = require("./bots");

function normalizeType(value) {
    const raw = String(value || "").toLowerCase();
    if (["private", "user", "direct", "individual"].includes(raw)) return "private";
    if (["group", "group_chat", "room"].includes(raw)) return "group";
    return "unknown";
}

function typeFromIdentifiers(chatId, userIds = []) {
    const normalizedUsers = [...new Set(userIds.filter(Boolean).map(String))];
    if (normalizedUsers.length > 1) return { chatType: "group", typeSource: "multiple_members" };
    if (normalizedUsers.length === 1 && normalizedUsers[0] === String(chatId)) {
        return { chatType: "private", typeSource: "matching_user_chat_id" };
    }
    // Zalo may use different identifiers for a private conversation and its user.
    // A mismatching pair is therefore not enough evidence to classify a group.
    if (normalizedUsers.length === 1) return { chatType: "unknown", typeSource: "identifier_mismatch" };
    return { chatType: "unknown", typeSource: "unresolved" };
}

function latestIso(...values) {
    return values.filter(Boolean).sort((a, b) => String(b).localeCompare(String(a)))[0] || null;
}

// Bot của một bản ghi: ưu tiên trường botId, nếu thiếu thì suy ra từ tiền tố
// khóa (`botN::`), còn lại thuộc về bot 1 — đúng quy tắc giữ tương thích dữ liệu cũ.
function botIdOf(record, key = "") {
    const fromRecord = normalizeBotId(record?.botId);
    if (fromRecord) return fromRecord;
    return parseScopedKey(key).botId;
}

// Khóa gộp phải gồm botId: cùng một Chat ID ở bot 1 và bot 2 là hai cuộc trò
// chuyện khác nhau, gộp theo chatId trần sẽ trộn dữ liệu của hai bot.
function scopedChatId(botId, chatId) {
    return `${botId}::${chatId}`;
}

function buildAdminData() {
    const rawChats = getAllChats();
    const interactions = getInteractionTargets();
    const rawSubscriptions = Object.entries(getAllSubscriptions());
    const interactionByChat = new Map(interactions.map((item) => [scopedChatId(botIdOf(item), String(item.chatId)), item]));
    const subscriptionsByChat = new Map();
    const users = new Map();

    const subscriptions = rawSubscriptions.map(([key, raw]) => {
        const current = isCurrentSubscription(raw);
        const botId = botIdOf(raw, key);
        const item = {
            key,
            botId,
            schema: current ? "current" : "legacy",
            chatId: String(raw?.chatId ?? (!key.includes("::") ? key : "")),
            userId: raw?.userId == null ? null : String(raw.userId),
            userDisplayName: String(raw?.userDisplayName || ""),
            chatType: normalizeType(raw?.chatType),
            chatTitle: String(raw?.chatTitle || ""),
            studentId: String(raw?.studentId || ""),
            studentName: String(raw?.studentName || ""),
            notificationsEnabled: raw?.notificationsEnabled === true,
            classStartNotificationsEnabled: raw?.classStartNotificationsEnabled === true,
            notificationTimes: normalizeNotificationTimes(raw),
            updatedAt: raw?.updatedAt || null
        };
        if (item.chatId) {
            const groupKey = scopedChatId(botId, item.chatId);
            const list = subscriptionsByChat.get(groupKey) || [];
            list.push(item);
            subscriptionsByChat.set(groupKey, list);
        }
        return item;
    });

    // Mỗi cặp (botId, chatId) là một dòng riêng trong dashboard.
    const allChatKeys = new Set([
        ...rawChats.map((chat) => scopedChatId(botIdOf(chat), String(chat.chatId))),
        ...interactions.map((item) => scopedChatId(botIdOf(item), String(item.chatId))),
        ...subscriptions.filter((item) => item.chatId).map((item) => scopedChatId(item.botId, item.chatId))
    ]);

    // Chat đã bị xoá vĩnh viễn không được hiện lại chỉ vì còn dữ liệu tương tác
    // hoặc đăng ký. Khóa trong deletedChatIds dùng đúng quy ước lưu trữ
    // (bot1 không tiền tố, botN có tiền tố) nên phải so bằng storageKeyPrefix.
    const deletedKeys = new Set(getDeletedChatIds());
    for (const chatKey of [...allChatKeys]) {
        const separator = chatKey.indexOf("::");
        const botId = chatKey.slice(0, separator);
        const chatId = chatKey.slice(separator + 2);
        if (deletedKeys.has(`${storageKeyPrefix(botId)}${chatId}`)) allChatKeys.delete(chatKey);
    }

    const chats = [...allChatKeys].map((chatKey) => {
        const separator = chatKey.indexOf("::");
        const botId = chatKey.slice(0, separator);
        const chatId = chatKey.slice(separator + 2);
        const chat = rawChats.find((item) => botIdOf(item) === botId && String(item.chatId) === chatId)
            || { chatId, botId, status: "active" };
        const interaction = interactionByChat.get(chatKey);
        const chatSubscriptions = subscriptionsByChat.get(chatKey) || [];
        const memberIds = new Set([
            ...Object.keys(interaction?.members || {}),
            ...chatSubscriptions.map((item) => item.userId).filter(Boolean),
            ...(chat.userId ? [String(chat.userId)] : []),
            ...(interaction?.lastUserId ? [String(interaction.lastUserId)] : [])
        ]);
        const interactionType = normalizeType(interaction?.chatType);
        const storedType = normalizeType(chat.chatType);
        let chatType = "unknown";
        let typeSource = "unresolved";
        if (interactionType !== "unknown") { chatType = interactionType; typeSource = "zalo_interaction"; }
        else if (storedType !== "unknown") { chatType = storedType; typeSource = "chat_directory"; }
        else if (chatSubscriptions.some((item) => item.chatType !== "unknown")) {
            chatType = chatSubscriptions.find((item) => item.chatType !== "unknown").chatType;
            typeSource = "subscription_metadata";
        } else {
            const inferred = typeFromIdentifiers(chatId, [...memberIds]);
            chatType = inferred.chatType;
            typeSource = inferred.typeSource;
        }

        const displayName = String(chat.displayName || interaction?.chatTitle || chatSubscriptions.find((item) => item.chatTitle)?.chatTitle || interaction?.lastUserDisplayName || `Chat ${chatId}`);
        const record = {
            ...chat,
            chatId,
            botId,
            chatType,
            typeSource,
            displayName,
            chatTitle: String(chat.chatTitle || interaction?.chatTitle || ""),
            memberCount: memberIds.size,
            subscriptionCount: chatSubscriptions.length,
            enabledSubscriptionCount: chatSubscriptions.filter((item) => item.notificationsEnabled).length,
            studentIds: [...new Set(chatSubscriptions.map((item) => item.studentId).filter(Boolean))],
            lastInboundInteractionAt: chat.lastInboundInteractionAt || interaction?.lastInteractionAt || null,
            firstInteractionAt: chat.firstInteractionAt || interaction?.firstInteractionAt || null
        };

        for (const userId of memberIds) {
            const member = interaction?.members?.[userId] || {};
            const userSubscriptions = chatSubscriptions.filter((item) => item.userId === userId);
            // Khóa theo (bot, user): một người dùng cả hai bot có cấu hình riêng cho
            // từng bot, và dashboard phải hiển thị chúng tách biệt.
            const userKey = `${botId}::${userId}`;
            const existing = users.get(userKey) || {
                key: userKey,
                botId,
                userId,
                displayName: "",
                chats: [],
                subscriptions: [],
                studentIds: [],
                firstInteractionAt: null,
                lastInteractionAt: null
            };
            existing.displayName = existing.displayName || member.displayName || userSubscriptions.find((item) => item.userDisplayName)?.userDisplayName || (chatType === "private" ? displayName : "") || `User ${userId}`;
            existing.chats.push({ chatId, botId, chatType, chatName: displayName, status: record.status, memberStatus: member.status || "active" });
            existing.subscriptions.push(...userSubscriptions);
            existing.studentIds = [...new Set([...existing.studentIds, ...userSubscriptions.map((item) => item.studentId).filter(Boolean)])];
            existing.firstInteractionAt = existing.firstInteractionAt || member.firstInteractionAt || (interaction?.lastUserId === userId ? interaction.firstInteractionAt : null);
            existing.lastInteractionAt = latestIso(existing.lastInteractionAt, member.lastInteractionAt, interaction?.lastUserId === userId ? interaction.lastInteractionAt : null, ...userSubscriptions.map((item) => item.updatedAt));
            users.set(userKey, existing);
        }
        return record;
    }).sort((a, b) => a.displayName.localeCompare(b.displayName));

    // Tra theo cặp (bot, chat): cùng một chatId ở hai bot là hai dòng khác nhau.
    const chatByKey = new Map(chats.map((chat) => [scopedChatId(chat.botId, chat.chatId), chat]));
    const normalizedSubscriptions = subscriptions.map((item) => {
        const chat = chatByKey.get(scopedChatId(item.botId, item.chatId));
        return {
            ...item,
            chatName: chat?.displayName || item.chatId,
            chatType: chat?.chatType || "unknown",
            chatStatus: chat?.status || "active",
            eligible: chat?.status === "active"
        };
    });

    for (const user of users.values()) {
        user.subscriptions = normalizedSubscriptions.filter((item) => item.userId === user.userId && item.botId === user.botId);
        user.notificationsEnabled = user.subscriptions.some((item) => item.notificationsEnabled && item.eligible);
        user.notificationTimeCount = user.subscriptions.reduce((sum, item) => sum + item.notificationTimes.length, 0);
        user.status = user.chats.some((item) => item.memberStatus === "active") ? "active" : (user.chats.some((item) => item.memberStatus === "disabled") ? "disabled" : "removed");
    }

    const groups = chats.filter((chat) => chat.chatType === "group").map((chat) => ({
        ...chat,
        members: [...users.values()]
            .filter((user) => user.botId === chat.botId && user.chats.some((item) => item.chatId === chat.chatId))
            .map((user) => ({
                userId: user.userId,
                botId: user.botId,
                displayName: user.displayName,
                studentIds: user.subscriptions.filter((item) => item.chatId === chat.chatId).map((item) => item.studentId).filter(Boolean),
                notificationTimes: user.subscriptions.filter((item) => item.chatId === chat.chatId).flatMap((item) => item.notificationTimes),
                notificationsEnabled: user.subscriptions.some((item) => item.chatId === chat.chatId && item.notificationsEnabled)
            }))
    }));

    // Thống kê theo từng bot — mỗi bot là một danh tính riêng nên đếm riêng.
    const botIds = [...new Set([
        ...chats.map((chat) => chat.botId),
        ...normalizedSubscriptions.map((item) => item.botId)
    ])].sort();
    const botStats = botIds.map((botId) => ({
        botId,
        chatCount: chats.filter((chat) => chat.botId === botId).length,
        userCount: [...users.values()].filter((user) => user.botId === botId).length,
        groupCount: groups.filter((group) => group.botId === botId).length,
        subscriptionCount: normalizedSubscriptions.filter((item) => item.botId === botId).length,
        enabledSubscriptionCount: normalizedSubscriptions.filter((item) => item.botId === botId && item.notificationsEnabled && item.eligible).length,
        deliveryErrorCount: chats.filter((chat) => chat.botId === botId && chat.lastError).length
    }));

    return {
        generatedAt: new Date().toISOString(),
        chats,
        users: [...users.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
        groups,
        subscriptions: normalizedSubscriptions,
        botStats,
        access: getAccessSummary()
    };
}

module.exports = { buildAdminData, normalizeType, typeFromIdentifiers };
