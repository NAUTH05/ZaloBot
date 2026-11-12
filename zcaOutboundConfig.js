// ============================================================================
// CẤU HÌNH NHỊP GỬI CHO TÀI KHOẢN ZALO CÁ NHÂN (ZCA).
//
// Một chỗ DUY NHẤT giữ các con số này, vì có hai nơi cần biết nhịp ZCA:
//   • outboundLimiter.js — áp nhịp thật cho từng request.
//   • sendPacing.js      — tính cửa sổ "gửi trước" cho thông báo theo lịch (một
//                          đợt 50 người trên tài khoản cá nhân cần nhiều thời gian
//                          hơn hẳn 50 người trên bot chính thức).
// Nếu hai nơi giữ hai con số khác nhau thì cửa sổ gửi trước sẽ tính sai.
//
// THỨ TỰ ƯU TIÊN (cao → thấp)
//   1. ZCA_OUTBOUND_INTERVAL_MS        (mới)
//   2. BROADCAST_ZCA_INTERVAL_MS       (cũ — cấu hình sẵn vẫn dùng được)
//   3. 10000ms                          (mặc định thận trọng)
// Sau đó LUÔN kẹp về [minIntervalMs, maxIntervalMs]: cấu hình sai không bao giờ
// biến nhịp thành "bắn không giới hạn".
//
// LƯU Ý VỀ Ý NGHĨA CỦA CON SỐ
// 10 giây/tin KHÔNG phải hạn mức do Zalo công bố, và KHÔNG bảo đảm tài khoản không
// bị siết. Đây là điểm khởi đầu thận trọng để thử nghiệm có kiểm soát; chỉnh theo
// quan sát thực tế, không theo kỳ vọng.
// ============================================================================

const ZCA_OUTBOUND_DEFAULTS = Object.freeze({
    intervalMs: 10000,
    minIntervalMs: 5000,
    maxIntervalMs: 600000,
    concurrency: 1,
    rateLimitStrikes: 3,
    unconfirmedStrikes: 3,
    recipientStrikes: 5,
    strikeWindowMs: 300000,
    pauseMs: 600000,
    recoverySuccesses: 2,
    historySize: 200
});

// Đọc số nguyên dương. Giá trị rác ⇒ mặc định, KHÔNG thành 0.
function readPositiveInt(raw, fallback) {
    if (raw === undefined || raw === null || raw === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.round(parsed);
}

function resolveZcaOutboundConfig(env = process.env) {
    const source = env || {};
    const minIntervalMs = Math.min(
        readPositiveInt(source.ZCA_OUTBOUND_MIN_INTERVAL_MS, ZCA_OUTBOUND_DEFAULTS.minIntervalMs),
        ZCA_OUTBOUND_DEFAULTS.maxIntervalMs
    );
    const requestedInterval = readPositiveInt(
        source.ZCA_OUTBOUND_INTERVAL_MS,
        readPositiveInt(source.BROADCAST_ZCA_INTERVAL_MS, ZCA_OUTBOUND_DEFAULTS.intervalMs)
    );
    const intervalMs = Math.min(Math.max(requestedInterval, minIntervalMs), ZCA_OUTBOUND_DEFAULTS.maxIntervalMs);

    // Song song LUÔN = 1 cho tài khoản ZCA. Giá trị > 1 bị TỪ CHỐI (kẹp về 1) chứ
    // không được chấp nhận: nhiều request đồng thời là nguyên nhân trực tiếp của
    // việc Zalo nuốt tin. `concurrencyRejected` để tầng gọi ghi cảnh báo.
    const requestedConcurrency = readPositiveInt(source.ZCA_OUTBOUND_CONCURRENCY, ZCA_OUTBOUND_DEFAULTS.concurrency);

    return {
        intervalMs,
        minIntervalMs,
        maxIntervalMs: ZCA_OUTBOUND_DEFAULTS.maxIntervalMs,
        concurrency: ZCA_OUTBOUND_DEFAULTS.concurrency,
        concurrencyRejected: requestedConcurrency !== ZCA_OUTBOUND_DEFAULTS.concurrency,
        rateLimitStrikes: readPositiveInt(source.ZCA_BREAKER_MAX_RATE_LIMITS, ZCA_OUTBOUND_DEFAULTS.rateLimitStrikes),
        unconfirmedStrikes: readPositiveInt(source.ZCA_BREAKER_MAX_UNCONFIRMED, ZCA_OUTBOUND_DEFAULTS.unconfirmedStrikes),
        recipientStrikes: readPositiveInt(source.ZCA_BREAKER_MAX_RECIPIENT_ERRORS, ZCA_OUTBOUND_DEFAULTS.recipientStrikes),
        strikeWindowMs: readPositiveInt(source.ZCA_BREAKER_WINDOW_MS, ZCA_OUTBOUND_DEFAULTS.strikeWindowMs),
        pauseMs: readPositiveInt(source.ZCA_BREAKER_PAUSE_MS, ZCA_OUTBOUND_DEFAULTS.pauseMs),
        recoverySuccesses: readPositiveInt(source.ZCA_BREAKER_RECOVERY_SUCCESSES, ZCA_OUTBOUND_DEFAULTS.recoverySuccesses),
        historySize: ZCA_OUTBOUND_DEFAULTS.historySize
    };
}

module.exports = {
    ZCA_OUTBOUND_DEFAULTS,
    readPositiveInt,
    resolveZcaOutboundConfig
};
