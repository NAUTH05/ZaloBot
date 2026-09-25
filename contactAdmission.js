// ============================================================================
// Cổng tiếp nhận liên hệ (contact admission).
//
// VẤN ĐỀ ĐANG SỬA
//
// Trước đây handleIncomingMessage() gọi recordInteraction() và upsertChat() NGAY
// khi một sự kiện tin nhắn tới, TRƯỚC khi kiểm tra quyền truy cập và TRƯỚC khi
// bất kỳ câu trả lời nào được gửi thành công. Hệ quả:
//
//   - Một chat mà bot KHÔNG THỂ trả lời (422 không có quyền, 410 chat_id không
//     hợp lệ) vẫn để lại bản ghi tương tác + bản ghi sổ chat, và hiện trên
//     dashboard như một người dùng đang hoạt động.
//   - Các đợt /thongbao sau đó coi những chat đó là người nhận hợp lệ và tiếp
//     tục bắn vào, dù chưa từng có một tin nào gửi được.
//   - Nếu người dùng bị từ chối nhưng lệnh đầu tiên của họ đã kịp ghi MSSV hoặc
//     đăng ký nhận lịch, dữ liệu người dùng bị bỏ lại một phần.
//
// NGUYÊN TẮC MỚI
//
//   1. Một chat đến từ sự kiện vào chỉ là ỨNG VIÊN TẠM. Không ghi gì bền vững
//      chỉ vì có sự kiện vào.
//   2. Chỉ TIẾP NHẬN (admit) sau khi một câu trả lời thật sự gửi thành công,
//      bằng ĐÚNG nhà cung cấp đã nhận sự kiện đó.
//   3. Mọi ghi bền vững do lệnh đầu tiên kích hoạt (MSSV, đăng ký, sổ chat, sổ
//      tương tác) đều bị hoãn cho tới khi chat được tiếp nhận.
//   4. Trạng thái chờ chỉ nằm trong BỘ NHỚ, có TTL ngắn, khóa theo (botId, chatId).
//      Khởi động lại thì mất — không bao giờ coi bộ nhớ là "đã tiếp nhận".
//
// TẠI SAO LẠI CẦN TRẠNG THÁI CHỜ TRONG BỘ NHỚ
//
// Zalo có thể gửi nhiều update cho cùng một chat gần như đồng thời (người dùng
// bấm nhanh, hoặc nền tảng gửi lại). Nếu mỗi tin nhắn đều tự quyết định "tiếp
// nhận" thì ta vừa gửi nhiều lời chào, vừa ghi sổ nhiều lần. Trạng thái chờ gom
// các sự kiện đến gần nhau lại trong MỘT quyết định tiếp nhận.
// ============================================================================
const { normalizeBotId, LEGACY_BOT_ID } = require("./bots");
const { getCurrentBotId } = require("./botContext");

// Trạng thái của một ứng viên.
const ADMISSION_STATE = Object.freeze({
    // Chưa từng thấy, hoặc đã hết TTL chờ. Lần tương tác kế tiếp sẽ thử lại.
    PENDING: "pending",
    // Đã có ít nhất một câu trả lời gửi thành công qua đúng nhà cung cấp.
    ADMITTED: "admitted",
    // Từ chối dứt khoát (422 không quyền / 410 chat không hợp lệ). KHÔNG ghi dữ
    // liệu; một tương tác mới sau này vẫn được thử lại vì đây không phải án phạt.
    REJECTED: "rejected"
});

// Lý do từ chối dứt khoát mà ta biết chắc nghĩa là "không thể gửi tới chat này".
//
// Lưu ý: KHÔNG phải mọi 422 đều giống nhau. Nhà cung cấp có thể trả 422 cho nội
// dung sai định dạng hoặc cho việc không có quyền. Chỉ những thông điệp nói rõ về
// quyền/khả năng gửi mới được coi là từ chối dứt khoát — xem isDefiniteRejection().
const DEFINITE_REJECTION_PATTERNS = [
    /chat[_ ]?id\s+is\s+invalid/i,
    /(not|no)\s+(have\s+)?permission/i,
    /kh[oô]ng\s+c[oó]\s+quy[eề]n/i,
    /user\s+(has\s+)?(not\s+)?(started|blocked|deactivated)/i,
    /blocked\s+by\s+(the\s+)?user/i,
    /bot\s+(was\s+)?(blocked|stopped)/i
];

// TTL của trạng thái chờ trong bộ nhớ. Ngắn thôi: nó chỉ để gom các sự kiện đến
// sát nhau, không phải để nhớ lâu. Hết TTL thì lần tương tác sau tự thử lại.
const DEFAULT_PENDING_TTL_MS = 60 * 1000;

// Mặc định số sự kiện tối đa gom vào một lần tiếp nhận, tránh việc một chat bị
// spam làm phình bộ nhớ chờ.
const DEFAULT_MAX_PENDING_PER_KEYS = 500;

function nowMs() {
    return Date.now();
}

// Khóa chờ phải gồm bot: cùng một Chat ID ở hai bot là HAI cuộc trò chuyện khác
// nhau. Bỏ botId đi thì bot2 bị đánh giá bằng trạng thái của bot1.
function admissionKey(botId, chatId) {
    const bot = normalizeBotId(botId) || getCurrentBotId() || LEGACY_BOT_ID;
    return `${bot}::${String(chatId)}`;
}

// Biết một lỗi gửi có phải là TỪ CHỐI DỨT KHOÁT hay không.
//
// Trả về { definite: boolean, reason: string }.
//
// Chỉ trả về definite=true khi ta CHẮC CHẮN không thể gửi tới chat này:
//   - 410 + "chat_id is invalid"
//   - 422/403 kèm thông điệp nói rõ về quyền hoặc việc người dùng chặn bot
//
// Các trường hợp còn lại (timeout, 429, 5xx, 422 mơ hồ, lỗi mạng) đều KHÔNG phải
// từ chối dứt khoát: ta không tiếp nhận, nhưng cũng không đánh dấu là hỏng vĩnh
// viễn — lần tương tác sau sẽ thử lại.
function classifyAdmissionFailure(error) {
    const message = String(error?.message || error || "");
    const code = Number(
        error?.response?.statusCode
        || error?.response?.status
        || error?.statusCode
        || (message.match(/\b(403|410|422)\b/) || [])[1]
        || 0
    ) || null;

    if (code === 410 && /chat[_ ]?id\s+is\s+invalid/i.test(message)) {
        return { definite: true, reason: "chat_id_invalid", code };
    }

    const permissionLike = DEFINITE_REJECTION_PATTERNS.some((pattern) => pattern.test(message));
    if ((code === 403 || code === 422) && permissionLike) {
        return { definite: true, reason: code === 403 ? "chat_forbidden" : "no_permission", code };
    }

    // 422 không kèm dấu hiệu quyền: có thể là lỗi định dạng nội dung — KHÔNG phải
    // từ chối dứt khoát. Tương tự với mọi mã còn lại.
    return { definite: false, reason: "uncertain", code };
}

// Nguồn duy nhất giữ trạng thái chờ. Toàn bộ nằm trong bộ nhớ.
class AdmissionRegistry {
    constructor(options = {}) {
        this.pendingTtlMs = Number.isFinite(options.pendingTtlMs)
            ? Math.max(1000, Number(options.pendingTtlMs))
            : DEFAULT_PENDING_TTL_MS;
        this.maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
            ? options.maxEntries
            : DEFAULT_MAX_PENDING_PER_KEYS;
        // Map<admissionKey, { botId, chatId, firstSeenAt, lastSeenAt, count, state, reason }>
        this.entries = new Map();
    }

    // Dọn các mục PENDING đã hết TTL. Gọi ở mỗi lần đọc để không cần timer riêng.
    prune(at = nowMs()) {
        for (const [key, entry] of this.entries) {
            if (entry.state === ADMISSION_STATE.PENDING && at - entry.lastSeenAt > this.pendingTtlMs) {
                this.entries.delete(key);
            }
        }
        // Nếu vượt trần, bỏ những mục PENDING cũ nhất trước. Mục ADMITTED/REJECTED
        // cũng bị dọn nếu buộc phải dọn — nhưng chúng không phải nguồn sự thật
        // (sự thật nằm trong store) nên mất đi cũng vô hại.
        if (this.entries.size > this.maxEntries) {
            // Sắp theo lastSeenAt tăng dần rồi bỏ những khóa cũ nhất.
            const ordered = [...this.entries.entries()]
                .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)
                .map((pair) => pair[0]);
            const overflow = this.entries.size - this.maxEntries;
            for (const key of ordered.slice(0, overflow)) this.entries.delete(key);
        }
    }

    get(botId, chatId, at = nowMs()) {
        this.prune(at);
        return this.entries.get(admissionKey(botId, chatId)) || null;
    }

    // Ghi nhận một ứng viên vừa có sự kiện vào.
    //
    // Trả về { entry, isNewPending, alreadyAdmitted, recentlyRejected }.
    //   - alreadyAdmitted: chat đã được tiếp nhận ⇒ xử lý bình thường, ghi được.
    //   - isNewPending: lần đầu thấy trong cửa sổ chờ ⇒ cần một câu trả lời để
    //     xác nhận trước khi ghi bất cứ thứ gì.
    markIncoming(botId, chatId, at = nowMs()) {
        this.prune(at);
        const key = admissionKey(botId, chatId);
        const existing = this.entries.get(key);
        if (existing?.state === ADMISSION_STATE.ADMITTED) {
            existing.lastSeenAt = at;
            existing.count += 1;
            return { entry: existing, isNewPending: false, alreadyAdmitted: true, recentlyRejected: false };
        }
        if (existing?.state === ADMISSION_STATE.REJECTED) {
            // Từ chối trước đó KHÔNG phải án phạt: mỗi tương tác mới được thử lại.
            // Ta chỉ nhớ rằng gần đây đã từng thất bại để không ghi dữ liệu ngay,
            // mà vẫn cho câu trả lời chạy qua cổng tiếp nhận như thường.
            existing.lastSeenAt = at;
            existing.count += 1;
            return { entry: existing, isNewPending: true, alreadyAdmitted: false, recentlyRejected: true };
        }
        if (existing) {
            existing.lastSeenAt = at;
            existing.count += 1;
            return { entry: existing, isNewPending: true, alreadyAdmitted: false, recentlyRejected: false };
        }
        const entry = {
            botId: normalizeBotId(botId) || getCurrentBotId() || LEGACY_BOT_ID,
            chatId: String(chatId),
            firstSeenAt: at,
            lastSeenAt: at,
            count: 1,
            state: ADMISSION_STATE.PENDING,
            reason: null
        };
        this.entries.set(key, entry);
        return { entry, isNewPending: true, alreadyAdmitted: false, recentlyRejected: false };
    }

    // Đánh dấu tiếp nhận: một câu trả lời ĐÃ gửi thành công qua đúng nhà cung cấp.
    admit(botId, chatId, at = nowMs()) {
        const key = admissionKey(botId, chatId);
        const existing = this.entries.get(key) || {
            botId: normalizeBotId(botId) || getCurrentBotId() || LEGACY_BOT_ID,
            chatId: String(chatId),
            firstSeenAt: at,
            count: 0
        };
        existing.state = ADMISSION_STATE.ADMITTED;
        existing.reason = null;
        existing.lastSeenAt = at;
        existing.admittedAt = at;
        this.entries.set(key, existing);
        return existing;
    }

    // Đánh dấu từ chối dứt khoát. Trạng thái này KHÔNG cấm tương tác sau — nó chỉ
    // nói rằng lần này chưa ghi được gì.
    reject(botId, chatId, reason, at = nowMs()) {
        const key = admissionKey(botId, chatId);
        const existing = this.entries.get(key) || {
            botId: normalizeBotId(botId) || getCurrentBotId() || LEGACY_BOT_ID,
            chatId: String(chatId),
            firstSeenAt: at,
            count: 0
        };
        existing.state = ADMISSION_STATE.REJECTED;
        existing.reason = reason || "rejected";
        existing.lastSeenAt = at;
        existing.rejectedAt = at;
        this.entries.set(key, existing);
        return existing;
    }

    isAdmitted(botId, chatId, at = nowMs()) {
        return this.get(botId, chatId, at)?.state === ADMISSION_STATE.ADMITTED;
    }

    clear() {
        this.entries.clear();
    }

    // Chỉ để chẩn đoán và kiểm thử. KHÔNG trả dữ liệu nhận dạng người dùng.
    size() {
        return this.entries.size;
    }

    stats() {
        const counts = { pending: 0, admitted: 0, rejected: 0 };
        for (const entry of this.entries.values()) counts[entry.state] = (counts[entry.state] || 0) + 1;
        return { total: this.entries.size, ...counts };
    }
}

// Registry dùng chung cho tiến trình.
const registry = new AdmissionRegistry();

module.exports = {
    ADMISSION_STATE,
    AdmissionRegistry,
    DEFAULT_PENDING_TTL_MS,
    admissionKey,
    classifyAdmissionFailure,
    registry
};
