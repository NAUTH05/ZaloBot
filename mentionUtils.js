// Đọc "ai được nhắc tới" trong một tin nhắn.
//
// Tách riêng thành module KHÔNG phụ thuộc gì để adapter tin nhắn ZCA dùng được mà
// không kéo theo interactionRegistry/firestorePersistence. Việc kéo sớm hai module
// đó vào đường nạp của adapter từng làm hỏng thứ tự nạp của bộ kiểm tra (mock
// Firestore bị bỏ qua), nên đây là ràng buộc có lý do — đừng thêm require vào đây.

// zca-js đặt ở `data.mentions` (adapter chuyển sang `meta.mentions`); Zalo Bot
// Platform có thể đặt ở `mentions`, hoặc không kèm gì.
const MENTION_SOURCES = [
    (msg) => msg?.meta?.mentions,
    (msg) => msg?.mentions,
    (msg) => msg?.data?.mentions,
    (msg) => msg?.raw?.mentions,
    (msg) => msg?.mentionIds,
    (msg) => msg?.mentioned_uids
];

// Mọi ID được nhắc tới trong tin nhắn, dạng chuỗi.
function collectMentionIds(msg) {
    const ids = new Set();
    for (const read of MENTION_SOURCES) {
        const list = read(msg);
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            if (entry == null) continue;
            const id = typeof entry === "object"
                ? (entry.uid ?? entry.userId ?? entry.id ?? entry.user_id)
                : entry;
            const text = String(id == null ? "" : id).trim();
            if (text) ids.add(text);
        }
    }
    return ids;
}

// Bỏ dấu tiếng Việt để so khớp tên: "Nguyễn An" và "nguyen an" là một.
function foldText(value) {
    return String(value == null ? "" : value)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .toLowerCase();
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { collectMentionIds, escapeRegExp, foldText };
