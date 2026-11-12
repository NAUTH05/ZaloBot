// ============================================================================
// GỬI TRƯỚC (presend) CHO THÔNG BÁO THEO MỐC GIỜ.
//
// VẤN ĐỀ
//
// Mốc 06:30 có 50 người. Vì Zalo siết tốc độ, mỗi tin phải cách nhau vài giây
// (tài khoản cá nhân: 5 giây). Nếu bắt đầu ĐÚNG 06:30 thì người cuối nhận lúc
// 06:34 — trễ 4 phút so với giờ họ đăng ký. Càng tăng delay cho an toàn thì càng
// trễ, tức là hai mục tiêu "không bị siết" và "đúng giờ" chọi nhau.
//
// CÁCH GIẢI
//
// Tách "giờ người dùng đăng ký" khỏi "giờ bắt đầu gửi". Với mốc 06:30, ta bắt đầu
// sớm hơn đúng bằng thời gian đợt gửi cần, sao cho TIN CUỐI CÙNG rơi vào 06:30.
// Nhờ vậy vẫn giữ nguyên delay an toàn mà không ai nhận muộn.
//
// Cửa sổ = số người × (delay + thời gian một lần gửi) + dự phòng, kẹp trong
// [PRESEND_MIN_MINUTES, PRESEND_MAX_MINUTES]. Sàn 5 phút để một lần gửi chậm bất
// thường vẫn còn dư địa; trần 20 phút để tin không đến quá sớm.
//
// HAI CHỐT AN TOÀN
//
//   1. KHÔNG BAO GIỜ gửi trước sang ngày hôm trước. Mốc 00:05 mà gửi trước 20 phút
//      là 23:45 hôm trước, và "lịch hôm nay" sẽ tính ra lịch của NGÀY SAI.
//   2. Vẫn nhận gửi muộn trong `SCHEDULE_LATE_GRACE_MINUTES` sau mốc: tiến trình
//      restart đúng lúc 06:28 thì vẫn gửi được, thay vì mất cả ngày.
//
// Hàm thuần, không đọc đồng hồ hệ thống và không tự gửi — kiểm thử được.
// ============================================================================

const MINUTE_MS = 60 * 1000;

// Việt Nam là UTC+7 và KHÔNG có giờ mùa hè, nên độ lệch là hằng số. Cùng giả định
// đã dùng ở timezone.js (`toLhuQueryDate`: 12:00 VN = 05:00 UTC).
const VN_OFFSET_MS = 7 * 60 * MINUTE_MS;

// Thời gian một lần gửi thực tế (mạng + Zalo xử lý), cộng thêm vào delay. Nhịp
// gửi tính từ lúc gửi XONG, nên khoảng cách thật giữa hai tin là delay + thời gian
// này. Bỏ qua nó thì đợt gửi luôn xong muộn hơn dự tính.
const ESTIMATED_SEND_MS = 1000;

const PRESEND_DEFAULTS = Object.freeze({
    minWindowMs: 5 * MINUTE_MS,
    maxWindowMs: 20 * MINUTE_MS,
    lateGraceMs: 15 * MINUTE_MS,
    bufferMs: 90 * 1000
});

function readMinutes(env, name, fallbackMinutes) {
    const raw = env?.[name];
    if (raw === undefined || raw === null || String(raw).trim() === "") return fallbackMinutes * MINUTE_MS;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return fallbackMinutes * MINUTE_MS;
    return Math.round(value * MINUTE_MS);
}

// Cấu hình đọc từ .env mỗi lượt gọi, để chỉnh xong không phải khởi động lại.
function resolvePresendOptions(env = process.env) {
    const minWindowMs = readMinutes(env, "PRESEND_MIN_MINUTES", 5);
    const maxWindowMs = readMinutes(env, "PRESEND_MAX_MINUTES", 20);
    return {
        // Đảo ngược cấu hình (min > max) không được làm cửa sổ âm.
        minWindowMs: Math.min(minWindowMs, maxWindowMs),
        maxWindowMs: Math.max(minWindowMs, maxWindowMs),
        lateGraceMs: readMinutes(env, "SCHEDULE_LATE_GRACE_MINUTES", 15),
        bufferMs: PRESEND_DEFAULTS.bufferMs
    };
}

// Mốc thời gian thật (UTC) của một giờ trên đồng hồ Việt Nam.
// `vietnamInstant("2026-11-12", "06:30")` ⇒ 2026-11-11T23:30:00Z.
function vietnamInstant(dateKey, time) {
    const dateMatch = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const timeMatch = String(time || "").match(/^(\d{2}):(\d{2})$/);
    if (!dateMatch || !timeMatch) return null;
    const [, year, month, day] = dateMatch.map(Number);
    const [, hour, minute] = timeMatch.map(Number);
    if (hour > 23 || minute > 59) return null;
    return new Date(Date.UTC(year, month - 1, day, hour, minute) - VN_OFFSET_MS);
}

// Cửa sổ cần thiết để gửi hết một đợt mà tin cuối vẫn kịp mốc.
//
// `intervals` là delay của từng người nhận (mỗi nhà cung cấp một nhịp khác nhau).
function computeWindowMs(intervals = [], options = PRESEND_DEFAULTS) {
    const total = intervals.reduce((sum, interval) => {
        const value = Number(interval);
        return sum + (Number.isFinite(value) && value > 0 ? value : 0) + ESTIMATED_SEND_MS;
    }, 0) + (Number(options.bufferMs) || 0);

    const min = Number(options.minWindowMs) || 0;
    const max = Number(options.maxWindowMs) || PRESEND_DEFAULTS.maxWindowMs;
    return Math.min(Math.max(total, min), max);
}

// Kế hoạch cho MỘT mốc giờ trong MỘT ngày.
//
// Trả về `due` để nơi gọi biết có phải chạy lượt gửi ngay bây giờ không.
function planSlot({ slotDateKey, time, intervals = [], now = new Date(), options = PRESEND_DEFAULTS } = {}) {
    const slotAt = vietnamInstant(slotDateKey, time);
    if (!slotAt) return null;

    const windowMs = computeWindowMs(intervals, options);
    const dayStart = vietnamInstant(slotDateKey, "00:00");
    const slotMs = slotAt.getTime();
    const nowMs = now.getTime();

    // Không gửi trước sang ngày hôm trước — xem chốt an toàn (1) ở đầu tệp.
    const startAt = Math.max(slotMs - windowMs, dayStart.getTime());
    const endAt = slotMs + (Number(options.lateGraceMs) || 0);

    return {
        slotAt,
        startAt,
        endAt,
        // Cửa sổ THẬT SỰ dùng được (có thể ngắn hơn `windowMs` khi bị chặn bởi đầu ngày).
        windowMs: slotMs - startAt,
        due: nowMs >= startAt && nowMs <= endAt,
        startsInMs: startAt - nowMs,
        // Số phút gửi trước mốc — dùng cho log để người vận hành đối chiếu.
        minutesBefore: Math.round((slotMs - startAt) / MINUTE_MS)
    };
}

module.exports = {
    ESTIMATED_SEND_MS,
    MINUTE_MS,
    PRESEND_DEFAULTS,
    VN_OFFSET_MS,
    computeWindowMs,
    planSlot,
    resolvePresendOptions,
    vietnamInstant
};
