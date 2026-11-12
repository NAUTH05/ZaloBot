// ============================================================================
// Phân loại lỗi gửi tin.
//
// Vì sao cần: log sản xuất có ba loại lỗi rất khác nhau nhưng trước đây bị đối xử
// gần như nhau — mọi lỗi không phải 410 đều được thử lại dạng plain text.
//
//   - 410 chat_id không hợp lệ      ⇒ VĨNH VIỄN. Thử lại vô ích, chỉ tạo tải.
//   - 422 không có quyền gửi        ⇒ VĨNH VIỄN. Thử lại cũng vô ích.
//   - 429 quá nhiều yêu cầu         ⇒ TẠM THỜI. Phải chờ giãn ra rồi mới thử lại.
//   - lỗi định dạng markdown        ⇒ chỉ khi ĐÚNG là lỗi parse mới gửi lại plain.
//   - lỗi mạng/timeout              ⇒ tạm thời, thử lại có giới hạn.
//
// Phân loại sai gây hai hệ quả đều xấu: thử lại lỗi vĩnh viễn làm tăng tải và log
// rác; coi lỗi tạm thời là vĩnh viễn làm mất tin nhắn.
// ============================================================================

const DELIVERY_ERROR_KIND = Object.freeze({
    PERMANENT: "permanent",     // đích không dùng được nữa, thử lại vô nghĩa
    RATE_LIMIT: "rate_limit",   // bị giới hạn tốc độ, cần chờ
    FORMAT: "format",           // payload/định dạng bị từ chối, thử plain text được
    TRANSIENT: "transient",     // lỗi tạm thời (mạng, 5xx), thử lại có giới hạn
    // Người nhận không thể nhận tin từ TÀI KHOẢN NÀY (mã 123 của Zalo). Khác
    // `permanent`: một lần không chứng minh được đích hỏng vĩnh viễn — có thể do
    // chính sách của người nhận, và có thể hết sau khi tài khoản hết bị siết.
    RECIPIENT: "recipient",
    // Nhà cung cấp nhận yêu cầu nhưng KHÔNG trả mã tin nhắn ⇒ chưa có bằng chứng
    // tin đã được tạo. Tuyệt đối không tính là đã gửi, cũng không gửi lại ngay
    // (tin gốc có thể vẫn xuất hiện).
    UNCONFIRMED: "unconfirmed",
    // Chưa gửi vì nhà cung cấp đang tạm dừng / mất kết nối. Chạy lại sau được.
    DEFERRED: "deferred",
    UNKNOWN: "unknown"
});

// Trạng thái giao tin — dùng cho bảng tổng kết và nhật ký gửi tin. Đây là thứ
// người vận hành đọc để trả lời câu "vì sao người này không nhận được".
//
//   sent_confirmed — Zalo trả mã tin nhắn: có bằng chứng tin đã được tạo.
//   unconfirmed    — yêu cầu xong nhưng KHÔNG có mã tin nhắn. Không phải thành công.
//   rate_limited   — bị giới hạn tốc độ (429 hoặc tương đương).
//   deferred       — hoãn vì nhà cung cấp đang tạm dừng; chạy lại sau.
//   recipient_error— riêng người nhận này không nhận được (mã 123).
//   failed         — hỏng thật, không thử lại (hoặc đã hết lượt thử).
const DELIVERY_STATE = Object.freeze({
    SENT_CONFIRMED: "sent_confirmed",
    UNCONFIRMED: "unconfirmed",
    RATE_LIMITED: "rate_limited",
    DEFERRED: "deferred",
    RECIPIENT_ERROR: "recipient_error",
    FAILED: "failed"
});

// Ánh xạ loại lỗi → trạng thái giao tin. Một chỗ duy nhất, để nhật ký, bảng tổng
// kết và dashboard không bao giờ nói khác nhau về cùng một lần gửi.
const KIND_TO_STATE = Object.freeze({
    [DELIVERY_ERROR_KIND.PERMANENT]: DELIVERY_STATE.FAILED,
    [DELIVERY_ERROR_KIND.RATE_LIMIT]: DELIVERY_STATE.RATE_LIMITED,
    [DELIVERY_ERROR_KIND.FORMAT]: DELIVERY_STATE.FAILED,
    [DELIVERY_ERROR_KIND.TRANSIENT]: DELIVERY_STATE.FAILED,
    [DELIVERY_ERROR_KIND.RECIPIENT]: DELIVERY_STATE.RECIPIENT_ERROR,
    [DELIVERY_ERROR_KIND.UNCONFIRMED]: DELIVERY_STATE.UNCONFIRMED,
    [DELIVERY_ERROR_KIND.DEFERRED]: DELIVERY_STATE.DEFERRED,
    [DELIVERY_ERROR_KIND.UNKNOWN]: DELIVERY_STATE.FAILED
});

function deliveryStateForKind(kind) {
    return KIND_TO_STATE[kind] || DELIVERY_STATE.FAILED;
}

// Mã lỗi vĩnh viễn. 410 và 422 là hai mã đã gặp thật trong log sản xuất.
const PERMANENT_CODES = new Set([403, 410, 422]);
// Mã lỗi tạm thời.
const TRANSIENT_CODES = new Set([408, 500, 502, 503, 504]);

// Mã 123 của Zalo: "Không thể nhận tin nhắn từ bạn."
//
// KHÔNG phải giới hạn tốc độ toàn tài khoản. Nó nói về QUAN HỆ giữa tài khoản gửi
// và một người nhận cụ thể (người kia chặn, giới hạn quyền nhận tin từ người lạ,
// hoặc Zalo tạm siết đúng cặp này). Vì vậy mặc định là lỗi CẤP NGƯỜI NHẬN; chỉ khi
// nó lặp lại trên NHIỀU người nhận khác nhau trong một cửa sổ thời gian thì mới
// được coi là dấu hiệu tài khoản bị siết — việc đếm đó nằm ở outboundLimiter.js.
const ZALO_RECIPIENT_RESTRICTED_CODE = 123;

function readErrorCode(error) {
    const candidates = [
        error?.response?.error_code,
        error?.response?.statusCode,
        error?.response?.status,
        error?.statusCode,
        error?.status,
        error?.code
    ];
    for (const candidate of candidates) {
        const value = Number(candidate);
        if (Number.isInteger(value) && value > 0) return value;
    }
    // node-zalo-bot nhét mã vào chuỗi thông báo: "EZALO: 410 The chat_id is invaild".
    const match = String(error?.message || "").match(/\b(4\d{2}|5\d{2})\b/);
    return match ? Number(match[1]) : null;
}

// Thử lại dạng plain text chỉ có ý nghĩa với lỗi ĐỊNH DẠNG. Các lỗi khác không
// liên quan tới markdown nên gửi lại plain text chỉ tốn thêm một request.
const FORMAT_HINTS = [
    /parse[_ ]?mode/i,
    /can(?:not|'t)\s+parse/i,
    /invalid\s+(?:markdown|format|entity)/i,
    /unsupported\s+format/i,
    /markdown/i,
    /entity\s+begins?\s+at/i
];

function looksLikeFormatError(error) {
    const text = `${error?.message || ""} ${error?.response?.description || ""}`;
    if (/\b4\d{2}\b/.test(text)) {
        // Có mã lỗi rõ ràng thì mã quyết định, không đoán theo chữ.
        return false;
    }
    return FORMAT_HINTS.some((pattern) => pattern.test(text));
}

function classifyDeliveryError(error) {
    const code = readErrorCode(error);

    // Nhãn do CHÍNH nhà cung cấp gắn, đáng tin hơn mọi suy đoán theo mã HTTP.
    //
    // Trường hợp thật: zca-js trả về `message: null` khi Zalo nhận yêu cầu nhưng
    // không tạo tin. Không có mã lỗi nào để đọc, nên nếu đoán theo chữ sẽ ra
    // "unknown" và tầng gửi không biết phải làm gì.
    const declared = String(error?.deliveryKind || "");
    if (declared && Object.values(DELIVERY_ERROR_KIND).includes(declared)) {
        const retryAfter = readRetryAfterSeconds(error);
        return {
            kind: declared,
            code,
            state: deliveryStateForKind(declared),
            retryable: declared === DELIVERY_ERROR_KIND.TRANSIENT || declared === DELIVERY_ERROR_KIND.DEFERRED,
            retryAsPlainText: false,
            scope: declared === DELIVERY_ERROR_KIND.RECIPIENT ? "recipient" : "account",
            // Nhà cung cấp có thể tự gắn nhãn VÀ vẫn trả `Retry-After`; giá trị của
            // máy chủ luôn thắng mọi khoảng chờ ta tự đoán.
            retryAfterMs: retryAfter != null ? retryAfter * 1000 : null,
            reason: error?.message || declared
        };
    }

    if (code === 429) {
        return {
            kind: DELIVERY_ERROR_KIND.RATE_LIMIT,
            code,
            state: DELIVERY_STATE.RATE_LIMITED,
            retryable: true,
            retryAsPlainText: false,
            // Giới hạn tốc độ là chuyện của TÀI KHOẢN, không phải của đích.
            scope: "account",
            // Tôn trọng `Retry-After` của máy chủ khi có; nơi gọi dùng đúng giá trị
            // này thay vì tự đoán một khoảng chờ.
            retryAfterMs: readRetryAfterSeconds(error) != null ? readRetryAfterSeconds(error) * 1000 : null,
            reason: "Bị giới hạn tốc độ (429)"
        };
    }
    if (code === ZALO_RECIPIENT_RESTRICTED_CODE) {
        // Giữ NGUYÊN mã và thông điệp gốc để chẩn đoán; chỉ thêm cách hiểu.
        return {
            kind: DELIVERY_ERROR_KIND.RECIPIENT,
            code,
            state: DELIVERY_STATE.RECIPIENT_ERROR,
            // Không thử lại NGAY: gửi lại liên tiếp vào đúng người này chỉ làm tình
            // trạng nặng thêm. Lần chạy sau (hoặc khi người dùng chủ động nhắn) sẽ thử.
            retryable: false,
            retryAsPlainText: false,
            scope: "recipient",
            reason: `người nhận không thể nhận tin từ tài khoản này (${code})`
        };
    }
    if (PERMANENT_CODES.has(code)) {
        return {
            kind: DELIVERY_ERROR_KIND.PERMANENT,
            code,
            state: DELIVERY_STATE.FAILED,
            retryable: false,
            retryAsPlainText: false,
            scope: "recipient",
            reason: code === 410
                ? "chat_id không hợp lệ (410)"
                : code === 422
                    ? "không có quyền gửi tới chat này (422)"
                    : `đích không dùng được (${code})`
        };
    }
    if (TRANSIENT_CODES.has(code)) {
        return {
            kind: DELIVERY_ERROR_KIND.TRANSIENT,
            code,
            state: DELIVERY_STATE.FAILED,
            retryable: true,
            retryAsPlainText: false,
            scope: "account",
            reason: `lỗi tạm thời (${code})`
        };
    }
    if (looksLikeFormatError(error)) {
        return {
            kind: DELIVERY_ERROR_KIND.FORMAT,
            code,
            state: DELIVERY_STATE.FAILED,
            retryable: false,
            retryAsPlainText: true,
            scope: "recipient",
            reason: "định dạng bị từ chối"
        };
    }
    // Không nhận ra: coi là tạm thời nhưng KHÔNG thử plain text, để không nhân đôi
    // số request cho mọi lỗi chưa phân loại được.
    return {
        kind: DELIVERY_ERROR_KIND.UNKNOWN,
        code,
        state: DELIVERY_STATE.FAILED,
        retryable: false,
        retryAsPlainText: false,
        scope: "recipient",
        reason: error?.message || "lỗi không xác định"
    };
}

// Thời gian chờ trước khi thử lại một lỗi 429.
//
// Ưu tiên `Retry-After` nếu máy chủ có trả (giây). Nếu không, dùng giãn cách tăng
// dần có nhiễu ngẫu nhiên để nhiều đích cùng bị 429 không thử lại đồng loạt.
function computeRetryDelayMs(error, attempt, options = {}) {
    const baseMs = Number(options.baseMs) > 0 ? Number(options.baseMs) : 1000;
    const maxMs = Number(options.maxMs) > 0 ? Number(options.maxMs) : 60000;
    const jitter = options.jitter === false ? 0 : Math.random() * 0.25 + 0.75;   // 0.75–1.0

    const retryAfter = readRetryAfterSeconds(error);
    if (retryAfter != null) return Math.min(retryAfter * 1000, maxMs);

    const exponential = baseMs * 2 ** Math.max(0, attempt - 1);
    return Math.min(Math.round(exponential * jitter), maxMs);
}

function readRetryAfterSeconds(error) {
    const raw = error?.response?.headers?.["retry-after"] ?? error?.headers?.["retry-after"];
    if (raw == null) return null;
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

module.exports = {
    DELIVERY_ERROR_KIND,
    DELIVERY_STATE,
    ZALO_RECIPIENT_RESTRICTED_CODE,
    classifyDeliveryError,
    computeRetryDelayMs,
    deliveryStateForKind,
    looksLikeFormatError,
    readErrorCode,
    readRetryAfterSeconds
};
