// Nguồn dữ liệu cho dropdown "Target User ID" của Command console.
//
// Khóa của danh sách luôn là User ID thật. Chat ID chỉ được trả kèm trong
// `targetChatId` khi tồn tại một liên kết đáng tin cậy: đúng một ngữ cảnh chat
// riêng tư đang hoạt động. Chat ID của nhóm không bao giờ được dùng làm User ID.
//
// Đầu vào là buildAdminData(), tức đã hợp nhất chat directory
// (chatDirectory.js), sổ tương tác (interactionRegistry.js) và subscriptions,
// nên không cần đọc lại các store đó ở đây.

const CHAT_TYPES = new Set(["private", "group", "unknown"]);
const USER_STATUSES = new Set(["active", "disabled", "removed"]);
const DEFAULT_MAX_BATCH_SIZE = 25;

function normalizeId(value) {
    return String(value ?? "").trim();
}

function isPlaceholderName(name, userId) {
    const value = String(name || "").trim();
    return !value || value === `User ${userId}`;
}

function normalizeContext(chat = {}) {
    const chatId = normalizeId(chat.chatId);
    if (!chatId) return null;
    return {
        chatId,
        chatType: CHAT_TYPES.has(chat.chatType) ? chat.chatType : "unknown",
        chatName: String(chat.chatName || chat.chatTitle || "").trim(),
        chatStatus: String(chat.status || chat.chatStatus || "active"),
        memberStatus: String(chat.memberStatus || "active")
    };
}

function usableContexts(contexts) {
    return contexts.filter((context) => context.chatStatus === "active" && context.memberStatus !== "removed");
}

// Chỉ trả Chat ID khi không thể nhầm lẫn: đúng một ngữ cảnh chat đang hoạt động
// và ngữ cảnh đó là chat riêng tư. Mọi trường hợp khác để người dùng tự nhập.
// Nhận cả ngữ cảnh thô lẫn đã chuẩn hoá để an toàn khi gọi trực tiếp.
function resolveTargetChat(contexts = []) {
    const usable = usableContexts(contexts.map(normalizeContext).filter(Boolean));
    const privateContexts = usable.filter((context) => context.chatType === "private");
    if (usable.length === 1 && privateContexts.length === 1) {
        return { targetChatId: privateContexts[0].chatId, targetChatHint: "private" };
    }
    if (!usable.length) return { targetChatId: "", targetChatHint: "none" };
    // Đúng một ngữ cảnh nhưng chưa xác định là chat riêng tư: không đủ tin cậy.
    if (usable.length === 1) return { targetChatId: "", targetChatHint: "unresolved" };
    return { targetChatId: "", targetChatHint: "multiple" };
}

// Danh sách đã khử trùng theo User ID, sắp xếp theo tên hiển thị (vi).
function buildTargetUserOptions(workspace = {}) {
    const usersById = new Map();
    const contextsById = new Map();

    const registerContexts = (userId, contexts) => {
        const list = contextsById.get(userId) || [];
        for (const context of contexts) {
            if (!list.some((item) => item.chatId === context.chatId)) list.push(context);
        }
        contextsById.set(userId, list);
    };

    // Nguồn chính: workspace users (đã hợp nhất directory, sổ tương tác và subscriptions).
    for (const user of workspace.users || []) {
        if (!user) continue;
        const userId = normalizeId(user.userId);
        if (!userId) continue;
        registerContexts(userId, (user.chats || []).map(normalizeContext).filter(Boolean));
        const displayName = String(user.displayName || "").trim();
        usersById.set(userId, {
            userId,
            displayName: isPlaceholderName(displayName, userId) ? "" : displayName,
            status: USER_STATUSES.has(user.status) ? user.status : "active",
            studentIds: [...new Set((user.studentIds || []).map(normalizeId).filter(Boolean))],
            lastInteractionAt: user.lastInteractionAt || null
        });
    }

    // Lưới an toàn cho bản ghi chat còn userId nhưng chưa có member record.
    for (const chat of workspace.chats || []) {
        if (!chat) continue;
        const userId = normalizeId(chat.userId);
        if (!userId) continue;
        const chatId = normalizeId(chat.chatId);
        // Một nhóm có chatId trùng userId chỉ là trùng số, không phải User ID.
        if (chatId && chatId === userId && chat.chatType === "group") continue;
        const context = normalizeContext({ chatId, chatType: chat.chatType, chatName: chat.displayName, status: chat.status });
        if (context) registerContexts(userId, [context]);
        if (usersById.has(userId)) continue;
        usersById.set(userId, {
            userId,
            displayName: chat.chatType === "private" ? String(chat.displayName || "").trim() : "",
            status: "active",
            studentIds: [...new Set((chat.studentIds || []).map(normalizeId).filter(Boolean))],
            lastInteractionAt: chat.lastInboundInteractionAt || null
        });
    }

    return [...usersById.values()]
        .map((user) => {
            const contexts = contextsById.get(user.userId) || [];
            return {
                ...user,
                // Tên thiếu hoặc chỉ là "User <id>" thì trả về rỗng để giao diện tự hiển thị ID.
                displayName: user.displayName || `User ${user.userId}`,
                chatCount: contexts.length,
                ...resolveTargetChat(contexts)
            };
        })
        .sort((left, right) => left.displayName.localeCompare(right.displayName, "vi") || left.userId.localeCompare(right.userId));
}

function findTargetUser(workspace = {}, rawValue) {
    const userId = normalizeId(rawValue);
    if (!userId) return null;
    return buildTargetUserOptions(workspace).find((user) => user.userId === userId) || null;
}

// Chuẩn hoá danh sách User ID cho Command console nhiều người nhận.
//
// - Chuẩn hoá: cắt khoảng trắng, bỏ giá trị rỗng.
// - Khử trùng: giữ lần xuất hiện đầu tiên, ghi lại các lần lặp để báo cáo.
// - Từ chối: Chat ID của nhóm bị dùng làm User ID (dùng lại resolveTargetUserId).
// - Giới hạn: tối đa `max` người nhận, phần vượt bị đếm riêng chứ không cắt lặng lẽ.
//
// Chat ID chỉ được trả kèm khi liên kết đủ tin cậy, đúng như resolveTargetChat.
function resolveBatchTargets(workspace = {}, rawValues = [], options = {}) {
    const max = Number.isInteger(options.max) && options.max > 0 ? options.max : DEFAULT_MAX_BATCH_SIZE;
    const list = Array.isArray(rawValues) ? rawValues : (rawValues == null || rawValues === "" ? [] : [rawValues]);

    // Dựng chỉ mục một lần để không phải quét lại workspace cho từng ID.
    const known = new Map();
    for (const user of buildTargetUserOptions(workspace)) known.set(user.userId, user);
    const groupChatIds = new Set(
        (workspace.chats || [])
            .filter((chat) => chat?.chatType === "group")
            .map((chat) => normalizeId(chat.chatId))
            .filter(Boolean)
    );
    const knownUserIds = new Set((workspace.users || []).map((user) => normalizeId(user?.userId)).filter(Boolean));

    const seen = new Set();
    const targets = [];
    const duplicates = [];
    const rejected = [];
    let overflow = 0;

    for (const raw of list) {
        const value = normalizeId(raw);
        if (!value) {
            rejected.push({ userId: "", reason: "Bỏ qua một giá trị rỗng." });
            continue;
        }
        if (seen.has(value)) {
            duplicates.push(value);
            continue;
        }
        // Chat ID của nhóm không bao giờ được lặng lẽ dùng làm User ID.
        if (!knownUserIds.has(value) && groupChatIds.has(value)) {
            rejected.push({
                userId: value,
                reason: `${value} là Chat ID của một nhóm, không phải User ID. Hãy dùng Target Chat ID cho nhóm.`
            });
            continue;
        }
        seen.add(value);
        if (targets.length >= max) {
            overflow += 1;
            continue;
        }
        const user = known.get(value);
        targets.push({
            userId: value,
            displayName: user?.displayName || `User ${value}`,
            chatId: user?.targetChatId || "",
            chatHint: user?.targetChatHint || "none",
            known: Boolean(user)
        });
    }

    return { targets, duplicates, rejected, overflow, max };
}

// Chặn việc vô tình dùng Chat ID của nhóm làm User ID. Giá trị không nằm trong
// directory vẫn được chấp nhận để không khoá khả năng nhập tay.
function resolveTargetUserId(workspace = {}, rawValue) {
    const userId = normalizeId(rawValue);
    if (!userId) return { ok: true, userId: "" };
    if ((workspace.users || []).some((user) => normalizeId(user?.userId) === userId)) return { ok: true, userId };
    const groupChat = (workspace.chats || []).find((chat) => normalizeId(chat?.chatId) === userId && chat?.chatType === "group");
    if (groupChat) {
        return {
            ok: false,
            userId,
            error: `${userId} là Chat ID của một nhóm, không phải User ID. Hãy để trống Target User ID và dùng Target Chat ID.`
        };
    }
    return { ok: true, userId };
}

module.exports = {
    DEFAULT_MAX_BATCH_SIZE,
    buildTargetUserOptions,
    findTargetUser,
    resolveBatchTargets,
    resolveTargetUserId,
    resolveTargetChat
};
