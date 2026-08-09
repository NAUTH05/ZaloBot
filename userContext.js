function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== "");
}

function getMessageContext(msg) {
    const rawChatId = firstDefined(msg?.chat?.id, msg?.chat_id);
    if (rawChatId === undefined) {
        throw new Error("Tin nhắn không có chat.id");
    }

    const rawUserId = firstDefined(
        msg?.from?.id,
        msg?.from?.user_id,
        msg?.sender?.id,
        msg?.sender_id,
        msg?.user_id
    );
    const rawDisplayName = firstDefined(
        msg?.from?.display_name,
        msg?.from?.name,
        msg?.sender?.display_name
    );
    const chatId = String(rawChatId);

    return {
        chatId,
        // Zalo Bot API bình thường luôn có from.id. Fallback chỉ dành cho payload hệ thống cũ.
        userId: rawUserId === undefined ? `chat-${chatId}` : String(rawUserId),
        userDisplayName: rawDisplayName == null ? "" : String(rawDisplayName)
    };
}

module.exports = { getMessageContext };
