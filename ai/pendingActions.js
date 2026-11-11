// Trạng thái "chờ xác nhận" cho các thao tác phá huỷ.
//
// Phạm vi: botId + chatId + userId. Chỉ đúng người đã yêu cầu mới xác nhận được —
// trong nhóm, người khác gõ "đồng ý" không được phép thay người kia quyết định.
//
// Lưu trong bộ nhớ, KHÔNG ghi xuống Firestore:
//   - đây là trạng thái sống rất ngắn (mặc định 2 phút),
//   - sau khi tiến trình khởi động lại thì lệnh chờ cũ không còn an toàn để chạy,
//     nên mất đi là hành vi đúng.
//
// Hết hạn / bị huỷ / sai người ⇒ KHÔNG BAO GIỜ chạy hành động đang chờ.

const { foldText } = require("../mentionUtils");

const DEFAULT_TTL_MS = 120000;

// Câu xác nhận / từ chối. So khớp trên chuỗi đã bỏ dấu và bỏ ký tự không phải chữ,
// nên "Đồng ý", "dong y", "OK." đều nhận được.
const CONFIRM_TOKENS = new Set([
    "co", "dongy", "xacnhan", "ok", "oke", "okie", "u", "uh", "ung", "vang", "yes", "y", "chuan", "dungroi"
]);
const CANCEL_TOKENS = new Set([
    "khong", "khongdongy", "huy", "huydi", "thoi", "no", "cancel", "dung", "khoan", "tuchoi"
]);

function normalizeReply(text) {
    return foldText(String(text == null ? "" : text)).replace(/[^a-z]/g, "");
}

// "confirm" | "cancel" | null
function classifyConfirmation(text) {
    const normalized = normalizeReply(text);
    if (!normalized) return null;
    if (CONFIRM_TOKENS.has(normalized)) return "confirm";
    if (CANCEL_TOKENS.has(normalized)) return "cancel";
    return null;
}

function pendingKey(botId, chatId, userId) {
    return `${String(botId || "bot1")}::${String(chatId)}::${String(userId)}`;
}

function createPendingActionStore(options = {}) {
    const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS;
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const entries = new Map();

    function sweep() {
        const current = now();
        for (const [key, entry] of entries) {
            if (entry.expiresAt <= current) entries.delete(key);
        }
    }

    return {
        ttlMs,
        // Ghi đè lệnh chờ cũ của cùng người: chỉ lệnh gần nhất còn hiệu lực.
        put(key, payload) {
            sweep();
            const entry = {
                ...payload,
                key,
                createdAt: now(),
                expiresAt: now() + ttlMs
            };
            entries.set(key, entry);
            return entry;
        },
        peek(key) {
            const entry = entries.get(key);
            if (!entry) return null;
            if (entry.expiresAt <= now()) {
                entries.delete(key);
                return null;
            }
            return entry;
        },
        // Lấy ra và xoá ngay: một lệnh chờ chỉ được thực thi tối đa một lần.
        take(key) {
            const entry = this.peek(key);
            if (entry) entries.delete(key);
            return entry;
        },
        drop(key) {
            return entries.delete(key);
        },
        sweep,
        get size() {
            sweep();
            return entries.size;
        },
        clear() {
            entries.clear();
        }
    };
}

module.exports = {
    CANCEL_TOKENS,
    CONFIRM_TOKENS,
    DEFAULT_TTL_MS,
    classifyConfirmation,
    createPendingActionStore,
    normalizeReply,
    pendingKey
};
