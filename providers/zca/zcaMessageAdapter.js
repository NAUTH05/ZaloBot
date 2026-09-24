// ============================================================================
// Chuyển tin nhắn zca-js thành định dạng nội bộ mà ZaloBot đã dùng.
//
// Định dạng nội bộ (do getMessageContext và handleIncomingMessage yêu cầu):
//   { text, chat: { id, type, title }, from: { id, display_name } }
//
// Nhờ adapter này, toàn bộ logic lệnh/lịch/nhắc học KHÔNG phải biết ZCA tồn tại.
// ============================================================================
const { ThreadType } = require("zca-js");

// zca-js: ThreadType.User = 0, ThreadType.Group = 1
const THREAD_TYPE_USER = ThreadType?.User ?? 0;
const THREAD_TYPE_GROUP = ThreadType?.Group ?? 1;

function threadTypeOf(message) {
    return message?.type === THREAD_TYPE_GROUP ? THREAD_TYPE_GROUP : THREAD_TYPE_USER;
}

function isGroupMessage(message) {
    return threadTypeOf(message) === THREAD_TYPE_GROUP;
}

// `content` của zca-js có thể là chuỗi, hoặc một object mô tả tệp/attachment.
// Chỉ lấy phần văn bản; không cố diễn giải attachment thành lệnh.
function extractText(message) {
    const content = message?.data?.content;
    if (typeof content === "string") return content;
    if (content && typeof content === "object") {
        for (const field of ["msg", "text", "title", "description"]) {
            const value = content[field];
            if (typeof value === "string" && value.trim()) return value;
        }
        // Có nội dung nhưng không phải văn bản (ảnh, sticker, tệp...). Trả chuỗi
        // rỗng để tầng trên coi như không có lệnh, thay vì bịa ra văn bản.
        return "";
    }
    return "";
}

// Tên hiển thị của người gửi. zca-js đặt tên ở `data.dName`.
function senderDisplayName(message) {
    const value = message?.data?.dName;
    return typeof value === "string" ? value.trim() : "";
}

// Tin nhắn do chính tài khoản ZCA gửi. Phải bỏ qua, nếu không bot trả lời chính
// tin nhắn của mình và tạo vòng lặp vô hạn.
function isSelfMessage(message) {
    return message?.isSelf === true;
}

// Chuyển sang định dạng nội bộ. Trả null nếu không dùng được.
function toInternalMessage(message) {
    if (!message) return null;

    const threadId = String(message.threadId || "").trim();
    if (!threadId) return null;

    const isGroup = isGroupMessage(message);
    const senderId = String(message.data?.uidFrom || "").trim();

    // Trong chat riêng, người gửi CHÍNH LÀ đối tượng của hội thoại khi họ nhắn
    // tới; khi chính tài khoản nhắn đi thì threadId vẫn là người kia. Vì vậy
    // chat.id luôn là threadId, còn from.id là người gửi thật.
    const chatId = threadId;
    const userId = senderId || threadId;

    return {
        text: extractText(message),
        chat: {
            id: chatId,
            type: isGroup ? "group" : "private",
            // zca-js không kèm tên hội thoại trong tin nhắn; để rỗng cho tới khi
            // có nguồn khác (không bịa tên).
            title: ""
        },
        from: {
            id: userId,
            display_name: senderDisplayName(message)
        },
        // Giữ lại để chẩn đoán và cho các tính năng sau này; KHÔNG chứa bí mật.
        meta: {
            provider: "zca",
            threadId,
            threadType: isGroup ? "group" : "user",
            msgId: message.data?.msgId || null,
            cliMsgId: message.data?.cliMsgId || null,
            sentAt: message.data?.ts || null,
            isGroup,
            mentions: Array.isArray(message.data?.mentions) ? message.data.mentions : []
        }
    };
}

// Bot có được nhắc tới trong nhóm không. Dùng để giữ hành vi "chỉ trả lời khi
// được nhắc" nếu logic hiện tại yêu cầu.
function isBotMentioned(message, ownUid) {
    const uid = String(ownUid || "");
    if (!uid) return false;
    const mentions = message?.data?.mentions;
    if (!Array.isArray(mentions)) return false;
    return mentions.some((mention) => String(mention?.uid || "") === uid);
}

module.exports = {
    THREAD_TYPE_GROUP,
    THREAD_TYPE_USER,
    extractText,
    isBotMentioned,
    isGroupMessage,
    isSelfMessage,
    senderDisplayName,
    threadTypeOf,
    toInternalMessage
};
