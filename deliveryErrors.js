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
    UNKNOWN: "unknown"
});

// Mã lỗi vĩnh viễn. 410 và 422 là hai mã đã gặp thật trong log sản xuất.
const PERMANENT_CODES = new Set([403, 410, 422]);
// Mã lỗi tạm thời.
const TRANSIENT_CODES = new Set([408, 500, 502, 503, 504]);

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

    if (code === 429) {
        return {
            kind: DELIVERY_ERROR_KIND.RATE_LIMIT,
            code,
            retryable: true,
            retryAsPlainText: false,
            reason: "Bị giới hạn tốc độ (429)"
        };
    }
    if (PERMANENT_CODES.has(code)) {
        return {
            kind: DELIVERY_ERROR_KIND.PERMANENT,
            code,
            retryable: false,
            retryAsPlainText: false,
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
            retryable: true,
            retryAsPlainText: false,
            reason: `lỗi tạm thời (${code})`
        };
    }
    if (looksLikeFormatError(error)) {
        return {
            kind: DELIVERY_ERROR_KIND.FORMAT,
            code,
            retryable: false,
            retryAsPlainText: true,
            reason: "định dạng bị từ chối"
        };
    }
    // Không nhận ra: coi là tạm thời nhưng KHÔNG thử plain text, để không nhân đôi
    // số request cho mọi lỗi chưa phân loại được.
    return {
        kind: DELIVERY_ERROR_KIND.UNKNOWN,
        code,
        retryable: false,
        retryAsPlainText: false,
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
    classifyDeliveryError,
    computeRetryDelayMs,
    looksLikeFormatError,
    readErrorCode,
    readRetryAfterSeconds
};
