const { LEGACY_BOT_ID, normalizeBotId } = require("./bots");

function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== "");
}

// `options.botId` là bot đã nhận được tin nhắn. Thiếu nó thì mặc định là bot 1 —
// đường tương thích cho mọi lối gọi cũ và cho bản triển khai một token.
//
// Chat ID và User ID chỉ có nghĩa trong phạm vi một bot: cùng một con số ở bot 2
// là một cuộc trò chuyện khác với ở bot 1, nên botId luôn đi kèm ngữ cảnh.
function getMessageContext(msg, options = {}) {
    const rawChatId = firstDefined(
        msg?.chat?.id,
        msg?.chat_id,
        msg?.group_id,
        msg?.grid,
        msg?.thread_id
    );
    if (rawChatId === undefined) {
        throw new Error("Tin nhắn không có chat.id");
    }

    const rawUserId = firstDefined(
        msg?.from?.id,
        msg?.from?.user_id,
        msg?.sender?.id,
        msg?.sender_id,
        msg?.user_id,
        msg?.uid
    );
    const rawDisplayName = firstDefined(
        msg?.from?.display_name,
        msg?.from?.name,
        msg?.sender?.display_name,
        msg?.sender?.name
    );
    const chatId = String(rawChatId);

    return {
        botId: normalizeBotId(options.botId) || LEGACY_BOT_ID,
        chatId,
        // Zalo Bot API bình thường luôn có from.id. Fallback chỉ dành cho payload hệ thống cũ.
        userId: rawUserId === undefined ? `chat-${chatId}` : String(rawUserId),
        userDisplayName: rawDisplayName == null ? "" : String(rawDisplayName)
    };
}

module.exports = { getMessageContext };
