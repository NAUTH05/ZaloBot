// ============================================================================
// Nhịp gửi (pacing) RIÊNG cho từng nhà cung cấp.
//
// VÌ SAO CẦN
//
// Một đợt thông báo 196 người đã kết thúc trong ~2 giây với 165 lỗi: 136 lỗi 429
// (quá nhiều yêu cầu), 28 lỗi 422 vĩnh viễn, và một lỗi phiên ZCA. Đó không phải
// lỗi của từng người nhận — đó là hệ quả của việc bắn hết danh sách trong vài giây.
// Khi Zalo trả 429, cách xử lý duy nhất đúng là CHẬM LẠI rồi mới tiếp; thử tiếp
// ngay lập tức chỉ tạo thêm 429 và có thể khiến tài khoản bị đánh dấu spam.
//
// Ba quy tắc của mô-đun này:
//
//   1. MỖI NHÀ CUNG CẤP MỘT NHỊP. bot1 bị giới hạn tốc độ KHÔNG được làm chậm
//      bot2/bot3/ZCA, và ngược lại. Trạng thái tạm dừng, số lần 429, mốc chờ đều
//      tách theo botId.
//
//   2. 429 THÌ CHỜ, KHÔNG THÌ BẮN TIẾP. Ưu tiên `Retry-After` của máy chủ; không
//      có thì giãn cách tăng dần (bounded exponential) kèm nhiễu ngẫu nhiên để
//      nhiều đích cùng bị 429 không thử lại đồng loạt.
//
//   3. 429 LẶP LẠI THÌ DỪNG NHÀ CUNG CẤP ĐÓ. Sau `maxRateLimitStrikes` lần trong
//      một cửa sổ, nhà cung cấp bị TẠM DỪNG (paused) — mọi đích còn lại của nó
//      được ghi là `deferred`, không phải `failed`, và lần chạy tiếp sẽ thử lại.
//      Đây chính là chốt chặn "429 lặp lại không được tạo vòng lặp nhanh".
//
// Không chờ bằng `setTimeout` trần trong vòng lặp: mọi thời gian chờ đều đi qua
// `sleep` của mô-đun (đổi được trong kiểm thử) nên bài kiểm tra chạy tức thì mà
// vẫn chứng minh được đúng thứ tự và đúng độ dài khoảng chờ.
// ============================================================================

const { DELIVERY_ERROR_KIND, classifyDeliveryError, computeRetryDelayMs } = require("./deliveryErrors");

// ---------------------------------------------------------------------------
// Cấu hình mặc định — THẬN TRỌNG có chủ ý.
//
// Đợt gửi này chỉ chạy MỘT LẦN cho ~200 người, sau đó chạy tiếp vài lần. Không có
// lý do gì để đánh đổi rủi ro bị khoá tài khoản lấy vài phút tiết kiệm. Mặc định
// 1200ms/đích ≈ 4 phút cho 196 người — chậm, nhưng không sinh thêm 429.
// ---------------------------------------------------------------------------
const PACING_DEFAULTS = Object.freeze({
    intervalMs: 1200,              // khoảng cách tối thiểu giữa hai tin CÙNG nhà cung cấp
    minIntervalMs: 100,            // sàn cứng: cấu hình sai cũng không thể bắn nhanh hơn
    maxIntervalMs: 600000,         // trần cứng cho mọi khoảng chờ
    concurrency: 1,                // một đích tại một thời điểm cho mỗi nhà cung cấp
    backoffBaseMs: 2000,           // 429 không có Retry-After: 2s, 4s, 8s, …
    backoffMaxMs: 120000,          // không chờ quá 2 phút cho một lần 429
    maxRateLimitStrikes: 3,        // 3 lần 429 trong một cửa sổ ⇒ tạm dừng nhà cung cấp
    strikeWindowMs: 300000,        // cửa sổ đếm 429 (5 phút)
    pauseMs: 600000                // tạm dừng 10 phút khi vượt ngưỡng
});

// ---------------------------------------------------------------------------
// Hàm thuần (kiểm thử được, không phụ thuộc thời gian thực)
// ---------------------------------------------------------------------------

function clampInterval(value, defaults = PACING_DEFAULTS) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return defaults.intervalMs;
    return Math.min(Math.max(Math.round(numeric), defaults.minIntervalMs), defaults.maxIntervalMs);
}

// Chuẩn hoá cấu hình nhịp từ tham số/chuỗi môi trường. Chấp nhận cả số và chuỗi
// (biến môi trường luôn là chuỗi) và LUÔN kẹp về khoảng an toàn.
function resolvePacingOptions(input = {}, env = process.env) {
    const read = (explicit, envName, fallback) => {
        if (explicit !== undefined && explicit !== null && explicit !== "") return explicit;
        if (env && env[envName] !== undefined && env[envName] !== "") return env[envName];
        return fallback;
    };
    const intervalRaw = read(input.intervalMs, "ANNOUNCE_SEND_INTERVAL_MS", PACING_DEFAULTS.intervalMs);
    const parsedInterval = Number(intervalRaw);
    return {
        intervalMs: clampInterval(
            Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : PACING_DEFAULTS.intervalMs
        ),
        backoffBaseMs: PACING_DEFAULTS.backoffBaseMs,
        backoffMaxMs: PACING_DEFAULTS.backoffMaxMs,
        maxRateLimitStrikes: PACING_DEFAULTS.maxRateLimitStrikes,
        strikeWindowMs: PACING_DEFAULTS.strikeWindowMs,
        pauseMs: PACING_DEFAULTS.pauseMs
    };
}

// Tính khoảng chờ trước một lần thử lại sau 429.
//
// Bọc `computeRetryDelayMs` của deliveryErrors để mọi nơi trong dự án dùng ĐÚNG
// một công thức: tôn trọng `Retry-After` (giây) khi máy chủ có trả, nếu không thì
// giãn cách tăng dần kèm nhiễu, luôn kẹp trần. Việc tôn trọng Retry-After là bắt
// buộc: đoán thấp hơn máy chủ yêu cầu sẽ tạo thêm 429.
function computeRateLimitDelayMs(error, strike, options = PACING_DEFAULTS) {
    const cap = Number(options.backoffMaxMs) > 0 ? Number(options.backoffMaxMs) : PACING_DEFAULTS.backoffMaxMs;
    return computeRetryDelayMs(error, strike, {
        baseMs: Number(options.backoffBaseMs) || PACING_DEFAULTS.backoffBaseMs,
        maxMs: cap
    });
}

// Ghi nhận một lần 429 vào lịch sử của nhà cung cấp.
//
// Trả về trạng thái MỚI (không sửa tham số vào) để hàm thuần và dễ kiểm thử.
// `strikes` chỉ giữ các mốc còn nằm trong cửa sổ — nếu không, một nhà cung cấp
// chạy vài giờ sẽ tích luỹ đủ 429 rải rác để bị khoá oan.
function registerRateLimit(paced, nowMs, options = PACING_DEFAULTS) {
    const windowMs = Number(options.strikeWindowMs) || PACING_DEFAULTS.strikeWindowMs;
    const limit = Number(options.maxRateLimitStrikes) || PACING_DEFAULTS.maxRateLimitStrikes;
    const pauseMs = Number(options.pauseMs) || PACING_DEFAULTS.pauseMs;

    const strikes = [...(paced?.strikes || []), nowMs].filter((at) => nowMs - at <= windowMs);
    const exceeded = strikes.length >= limit;
    return {
        strikes,
        strikeCount: strikes.length,
        pausedUntil: exceeded ? nowMs + pauseMs : paced?.pausedUntil || 0,
        pauseReason: exceeded ? "rate_limited" : paced?.pauseReason || null
    };
}

// Trạng thái "còn chờ" của một nhà cung cấp tại thời điểm `nowMs`.
//
// `intervalOverrideMs` cho phép nơi gọi truyền nhịp ĐANG có hiệu lực (vì bộ điều
// khiển giữ một cấu hình chung cho mọi nhà cung cấp). Bỏ qua tham số này thì hàm
// vẫn chạy đúng với nhịp riêng ghi trên từng bản ghi.
function pacingGate(paced, nowMs, intervalOverrideMs) {
    const remaining = (Number(paced?.pausedUntil) || 0) - nowMs;
    if (remaining > 0) {
        return { allowed: false, reason: "paused", waitMs: remaining };
    }
    const sinceLastSend = nowMs - (Number(paced?.lastSendAt) || 0);
    const interval = Number(intervalOverrideMs) > 0
        ? Number(intervalOverrideMs)
        : Number(paced?.intervalMs) || PACING_DEFAULTS.intervalMs;
    if (paced?.lastSendAt && sinceLastSend < interval) {
        return { allowed: false, reason: "interval", waitMs: interval - sinceLastSend };
    }
    return { allowed: true, reason: null, waitMs: 0 };
}

/* -------------------------------------------------------------------------- */
/* Ghi đè đồng hồ & sleep — để kiểm thử chạy tức thì                           */
/* -------------------------------------------------------------------------- */

// Đổi được nguồn thời gian và hàm ngủ. Bài kiểm tra thay `sleep` bằng hàm ghi lại
// khoảng chờ rồi trả về ngay, nên chứng minh được cả thứ tự lẫn độ dài mà không
// phải chờ thật.
function createPacingController(options = {}) {
    const defaults = PACING_DEFAULTS;
    // Chỉ những khoá đã biết mới được ghi đè, và `intervalMs` LUÔN đi qua `clampInterval`
    // như một chốt an toàn cuối. Nếu không lọc, một khoá lạ trong cấu hình sẽ lọt vào
    // `settings`; nếu không kẹp, cấu hình `intervalMs: 0` sẽ biến nhịp thành bắn không
    // giới hạn — đúng thứ đã gây ra 136 lỗi 429.
    const settings = { ...defaults };
    for (const key of Object.keys(defaults)) {
        if (options.settings && options.settings[key] !== undefined) settings[key] = options.settings[key];
    }
    settings.intervalMs = clampInterval(settings.intervalMs, defaults);
    settings.minIntervalMs = defaults.minIntervalMs;
    settings.maxIntervalMs = defaults.maxIntervalMs;

    const nowFn = typeof options.now === "function" ? options.now : () => Date.now();
    const sleepFn = typeof options.sleep === "function"
        ? options.sleep
        : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const logFn = typeof options.log === "function" ? options.log : () => {};

    // Trạng thái theo từng nhà cung cấp, khôi phục được từ checkpoint.
    const state = new Map();

    function entryFor(botId) {
        const key = String(botId || "unknown");
        if (!state.has(key)) {
            state.set(key, {
                strikes: [],
                strikeCount: 0,
                pausedUntil: 0,
                pauseReason: null,
                lastSendAt: 0,
                sent: 0,
                // Nhịp ghi kèm từng nhà cung cấp: nếu sau này cho phép mỗi nhà cung
                // cấp một nhịp khác nhau thì trạng thái đã lưu vẫn tự mô tả đủ.
                intervalMs: settings.intervalMs
            });
        }
        return state.get(key);
    }

    // Khôi phục trạng thái đã lưu xuống checkpoint (chạy tiếp sau khi tiến trình
    // chết hoặc sau khi bị tạm dừng vì 429).
    function restore(saved) {
        if (!saved || typeof saved !== "object") return;
        for (const [botId, value] of Object.entries(saved)) {
            if (!value || typeof value !== "object") continue;
            state.set(String(botId), {
                strikes: Array.isArray(value.strikes)
                    ? value.strikes.filter((at) => Number.isFinite(Number(at))).map(Number)
                    : [],
                strikeCount: Number(value.strikeCount) || 0,
                pausedUntil: Number(value.pausedUntil) || 0,
                pauseReason: value.pauseReason || null,
                // KHÔNG khôi phục `lastSendAt`: sau khi tiến trình khởi động lại thì
                // khoảng cách cũ đã trôi qua, giữ lại chỉ tạo một lần chờ vô nghĩa.
                lastSendAt: 0,
                sent: Number(value.sent) || 0,
                intervalMs: settings.intervalMs
            });
        }
    }

    // Ảnh chụp để ghi vào checkpoint. Chỉ những nhà cung cấp có chuyện đáng kể
    // (đang chờ hoặc từng bị 429) mới được lưu, để file không phình ra.
    function snapshot() {
        const result = {};
        for (const [botId, value] of state) {
            if (value.strikes.length === 0 && !value.pausedUntil) continue;
            result[botId] = {
                strikes: value.strikes,
                strikeCount: value.strikeCount,
                pausedUntil: value.pausedUntil,
                pauseReason: value.pauseReason,
                sent: value.sent
            };
        }
        return result;
    }

    // Số liệu trạng thái hiện tại của mọi nhà cung cấp (cho báo cáo/API).
    function stats(nowMs = nowFn()) {
        const result = {};
        for (const [botId, value] of state) {
            const gate = pacingGate(value, nowMs, settings.intervalMs);
            result[botId] = {
                intervalMs: settings.intervalMs,
                lastSendAt: value.lastSendAt || null,
                strikeCount: value.strikeCount,
                paused: gate.reason === "paused",
                pausedUntil: value.pausedUntil || null,
                pauseReason: value.pauseReason,
                resumeInMs: gate.reason === "paused" ? gate.waitMs : 0,
                sent: value.sent
            };
        }
        return result;
    }

    // Chờ cho tới khi nhà cung cấp được phép gửi. Trả về `null` nếu được phép,
    // hoặc `{ reason, waitMs }` khi nhà cung cấp đang bị TẠM DỪNG (không chờ, để
    // nơi gọi ghi `deferred` và đi tiếp).
    //
    // Chỉ chờ giãn cách thường (interval), không chờ hết thời gian tạm dừng: chờ
    // 10 phút trong một request HTTP là vô nghĩa — người vận hành sẽ thấy treo.
    async function waitTurn(botId) {
        const entry = entryFor(botId);
        while (true) {
            const nowMs = nowFn();
            const gate = pacingGate(entry, nowMs, settings.intervalMs);
            if (gate.allowed) return null;
            if (gate.reason === "paused") return { reason: "paused", waitMs: gate.waitMs };
            await sleepFn(gate.waitMs);
        }
    }

    // Đánh dấu vừa gửi xong một tin (dù thành công hay thất bại): mốc dùng để áp
    // khoảng cách cho tin kế tiếp của CÙNG nhà cung cấp.
    function markSent(botId, atMs = nowFn()) {
        const entry = entryFor(botId);
        entry.lastSendAt = atMs;
    }

    // Ghi nhận một lần 429: đếm vào cửa sổ, tính khoảng chờ, và tạm dừng nhà cung
    // cấp nếu vượt ngưỡng. KHÔNG tự ngủ — nơi gọi quyết định (vì có thể là lần 429
    // thứ ba làm dừng hẳn nhà cung cấp).
    //
    // `retryDelayMs` là khoảng chờ ĐỀ XUẤT trước lần thử kế tiếp; luôn ít nhất
    // bằng `intervalMs` để không bao giờ ngắn hơn nhịp thường.
    function onRateLimit(botId, error, atMs = nowFn()) {
        const entry = entryFor(botId);
        const next = registerRateLimit(entry, atMs, settings);
        entry.strikes = next.strikes;
        entry.strikeCount = next.strikeCount;
        // Mốc gửi cuối cùng cũng phải nhích lên, nếu không lần thử kế tiếp sẽ khởi
        // hành ngay lập tức và tạo vòng lặp 429 nhanh.
        entry.lastSendAt = atMs;

        const retryDelayMs = computeRateLimitDelayMs(error, next.strikeCount, settings);
        if (next.pausedUntil > entry.pausedUntil) {
            entry.pausedUntil = next.pausedUntil;
            entry.pauseReason = next.pauseReason;
            logFn("warn",
                `[Pacing] ${botId}: ${next.strikeCount} lần 429 trong cửa sổ ⇒ tạm dừng ${Math.round(settings.pauseMs / 1000)}s.`);
            return {
                paused: true,
                strikeCount: next.strikeCount,
                retryDelayMs,
                pausedUntil: entry.pausedUntil,
                pauseMs: settings.pauseMs,
                reason: next.pauseReason
            };
        }
        // Chưa vượt ngưỡng: chờ đúng bằng khoảng đề xuất rồi mới đi tiếp. Đây là
        // chỗ biến "429" thành "chậm lại" thay vì "bắn tiếp thật nhanh".
        const waitMs = Math.max(retryDelayMs, settings.intervalMs);
        logFn("warn", `[Pacing] ${botId}: 429 lần ${next.strikeCount}, chờ ${waitMs}ms trước khi tiếp.`);
        entry.lastSendAt = atMs + waitMs;
        return { paused: false, strikeCount: next.strikeCount, retryDelayMs: waitMs, pausedUntil: 0, reason: null };
    }

    // Gửi thành công ⇒ xoá bớt căng thẳng cho nhà cung cấp. Không xoá sạch ngay:
    // một lần 429 hiếm hoi không nên ám ảnh cả chiến dịch, nhưng cũng không nên
    // được "ân xá" chỉ vì có một tin đi qua. Giảm dần theo từng lần thành công.
    function onSuccess(botId, atMs = nowFn()) {
        const entry = entryFor(botId);
        entry.sent += 1;
        entry.lastSendAt = atMs;
        if (entry.strikes.length > 0) {
            entry.strikes = entry.strikes.slice(0, entry.strikes.length - 1);
            entry.strikeCount = entry.strikes.length;
        }
        if (entry.strikes.length === 0) {
            entry.pausedUntil = 0;
            entry.pauseReason = null;
        }
    }

    // Tạm dừng nhà cung cấp theo yêu cầu (lỗi phiên ZCA, lỗi hạ tầng).
    function pause(botId, reason, ms = settings.pauseMs, atMs = nowFn()) {
        const entry = entryFor(botId);
        entry.pausedUntil = Math.max(entry.pausedUntil, atMs + ms);
        entry.pauseReason = reason;
        return { pausedUntil: entry.pausedUntil, reason };
    }

    // Xoá hoàn toàn trạng thái của một nhà cung cấp (người vận hành xử lý xong sự
    // cố và muốn thử lại ngay, không phải chờ hết thời gian tạm dừng).
    function reset(botId) {
        if (botId === undefined) {
            state.clear();
            return;
        }
        state.delete(String(botId));
    }

    return {
        entryFor,
        markSent,
        onRateLimit,
        onSuccess,
        pause,
        reset,
        restore,
        settings,
        snapshot,
        stats,
        waitTurn
    };
}

module.exports = {
    PACING_DEFAULTS,
    clampInterval,
    computeRateLimitDelayMs,
    createPacingController,
    pacingGate,
    registerRateLimit,
    resolvePacingOptions
};
