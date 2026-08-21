const { getAllChats, getChat } = require("./chatDirectory");
const { getInteractionTargets } = require("./interactionRegistry");
const { getAllSubscriptions, isCurrentSubscription, normalizeNotificationTimes } = require("./subscriptions");
const { readDutyData } = require("./dutyScheduleStore");
const { getAccessSummary } = require("./accessControl");

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

function buildAdminData() {
    const rawChats = getAllChats();
    const interactions = getInteractionTargets();
    const rawSubscriptions = Object.entries(getAllSubscriptions());
    const dutyData = readDutyData();
    const interactionByChat = new Map(interactions.map((item) => [String(item.chatId), item]));
    const subscriptionsByChat = new Map();
    const users = new Map();

    const subscriptions = rawSubscriptions.map(([key, raw]) => {
        const current = isCurrentSubscription(raw);
        const item = {
            key,
            schema: current ? "current" : "legacy",
            chatId: String(raw?.chatId ?? (!key.includes("::") ? key : "")),
            userId: raw?.userId == null ? null : String(raw.userId),
            userDisplayName: String(raw?.userDisplayName || ""),
            chatType: normalizeType(raw?.chatType),
            chatTitle: String(raw?.chatTitle || ""),
            studentId: String(raw?.studentId || ""),
            studentName: String(raw?.studentName || ""),
            notificationsEnabled: raw?.notificationsEnabled === true,
            notificationTimes: normalizeNotificationTimes(raw),
            updatedAt: raw?.updatedAt || null
        };
        if (item.chatId) {
            const list = subscriptionsByChat.get(item.chatId) || [];
            list.push(item);
            subscriptionsByChat.set(item.chatId, list);
        }
        return item;
    });

    const allChatIds = new Set([
        ...rawChats.map((chat) => String(chat.chatId)),
        ...interactions.map((item) => String(item.chatId)),
        ...subscriptions.map((item) => item.chatId).filter(Boolean),
        ...Object.keys(dutyData.subscriptions || {})
    ]);

    const chats = [...allChatIds].map((chatId) => {
        const chat = rawChats.find((item) => String(item.chatId) === chatId) || getChat(chatId) || { chatId, status: "active" };
        const interaction = interactionByChat.get(chatId);
        const chatSubscriptions = subscriptionsByChat.get(chatId) || [];
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
            chatType,
            typeSource,
            displayName,
            chatTitle: String(chat.chatTitle || interaction?.chatTitle || ""),
            memberCount: memberIds.size,
            subscriptionCount: chatSubscriptions.length,
            enabledSubscriptionCount: chatSubscriptions.filter((item) => item.notificationsEnabled).length,
            studentIds: [...new Set(chatSubscriptions.map((item) => item.studentId).filter(Boolean))],
            lastInboundInteractionAt: chat.lastInboundInteractionAt || interaction?.lastInteractionAt || null,
            firstInteractionAt: chat.firstInteractionAt || interaction?.firstInteractionAt || null,
            dutySubscription: dutyData.subscriptions?.[chatId] || null
        };

        for (const userId of memberIds) {
            const member = interaction?.members?.[userId] || {};
            const userSubscriptions = chatSubscriptions.filter((item) => item.userId === userId);
            const existing = users.get(userId) || {
                userId,
                displayName: "",
                chats: [],
                subscriptions: [],
                studentIds: [],
                firstInteractionAt: null,
                lastInteractionAt: null
            };
            existing.displayName = existing.displayName || member.displayName || userSubscriptions.find((item) => item.userDisplayName)?.userDisplayName || (chatType === "private" ? displayName : "") || `User ${userId}`;
            existing.chats.push({ chatId, chatType, chatName: displayName, status: record.status, memberStatus: member.status || "active" });
            existing.subscriptions.push(...userSubscriptions);
            existing.studentIds = [...new Set([...existing.studentIds, ...userSubscriptions.map((item) => item.studentId).filter(Boolean)])];
            existing.firstInteractionAt = existing.firstInteractionAt || member.firstInteractionAt || (interaction?.lastUserId === userId ? interaction.firstInteractionAt : null);
            existing.lastInteractionAt = latestIso(existing.lastInteractionAt, member.lastInteractionAt, interaction?.lastUserId === userId ? interaction.lastInteractionAt : null, ...userSubscriptions.map((item) => item.updatedAt));
            users.set(userId, existing);
        }
        return record;
    }).sort((a, b) => a.displayName.localeCompare(b.displayName));

    const chatById = new Map(chats.map((chat) => [chat.chatId, chat]));
    const normalizedSubscriptions = subscriptions.map((item) => ({
        ...item,
        chatName: chatById.get(item.chatId)?.displayName || item.chatId,
        chatType: chatById.get(item.chatId)?.chatType || "unknown",
        chatStatus: chatById.get(item.chatId)?.status || "active",
        eligible: chatById.get(item.chatId)?.status === "active"
    }));

    for (const user of users.values()) {
        user.subscriptions = normalizedSubscriptions.filter((item) => item.userId === user.userId);
        user.notificationsEnabled = user.subscriptions.some((item) => item.notificationsEnabled && item.eligible);
        user.notificationTimeCount = user.subscriptions.reduce((sum, item) => sum + item.notificationTimes.length, 0);
        user.status = user.chats.some((item) => item.memberStatus === "active") ? "active" : (user.chats.some((item) => item.memberStatus === "disabled") ? "disabled" : "removed");
    }

    const groups = chats.filter((chat) => chat.chatType === "group").map((chat) => ({
        ...chat,
        members: [...users.values()].filter((user) => user.chats.some((item) => item.chatId === chat.chatId)).map((user) => ({
            userId: user.userId,
            displayName: user.displayName,
            studentIds: user.subscriptions.filter((item) => item.chatId === chat.chatId).map((item) => item.studentId).filter(Boolean),
            notificationTimes: user.subscriptions.filter((item) => item.chatId === chat.chatId).flatMap((item) => item.notificationTimes),
            notificationsEnabled: user.subscriptions.some((item) => item.chatId === chat.chatId && item.notificationsEnabled)
        }))
    }));

    return {
        generatedAt: new Date().toISOString(),
        chats,
        users: [...users.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
        groups,
        subscriptions: normalizedSubscriptions,
        duty: {
            schedules: [...(dutyData.schedules || [])].sort((a, b) => Number(a.month) - Number(b.month) || Number(a.day) - Number(b.day) || Number(a.id) - Number(b.id)),
            subscriptions: Object.values(dutyData.subscriptions || {}).map((item) => ({
                ...item,
                chatType: chatById.get(String(item.chatId))?.chatType || "unknown",
                chatStatus: chatById.get(String(item.chatId))?.status || "active"
            }))
        },
        access: getAccessSummary()
    };
}

module.exports = { buildAdminData, normalizeType, typeFromIdentifiers };
