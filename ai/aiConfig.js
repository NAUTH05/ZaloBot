// Cấu hình trợ lý AI (DeepSeek).
//
// Toàn bộ giá trị đọc từ biến môi trường, KHÔNG có khóa nào nằm trong mã nguồn.
// Thiếu cấu hình ⇒ trợ lý ở trạng thái tắt nhưng mọi lệnh thường của ZaloBot vẫn
// chạy nguyên vẹn. Đây là yêu cầu cứng: hết tiền API hay API sập không được làm
// hỏng đường lệnh truyền thống.

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-chat";

// Giá tham khảo để ƯỚC TÍNH chi phí (USD cho 1 triệu token). DeepSeek đổi giá
// theo thời điểm, nên đây chỉ là mức thận trọng để chặn chi tiêu — cập nhật bằng
// biến môi trường khi nhà cung cấp công bố giá mới.
const DEFAULT_PRICE_INPUT_PER_1M_USD = 0.28;
const DEFAULT_PRICE_OUTPUT_PER_1M_USD = 0.42;

const DEFAULTS = Object.freeze({
    enabled: false,
    model: DEFAULT_MODEL,
    baseUrl: DEFAULT_BASE_URL,
    timeoutMs: 20000,
    maxRetries: 2,
    maxHistoryMessages: 8,
    maxInputChars: 8000,
    // 500 token từng làm phản hồi JSON bị CẮT giữa chừng: mô hình trả lời dài một
    // chút là `finish_reason: "length"`, JSON không đóng được, và người dùng nhận
    // câu "mình chưa hiểu rõ" dù mô hình đã hiểu đúng.
    maxOutputTokens: 800,
    maxRequestsPerUserPerDay: 10,
    monthlyBudgetUsd: 2,
    maxActionsPerRequest: 5,
    confirmationTtlMs: 120000,
    clarificationTtlMs: 300000,
    cooldownMs: 3000,
    // Tối thiểu giữa hai câu "trợ lý đang nghỉ" gửi cho CÙNG một người.
    noticeCooldownMs: 900000,
    // Sau lỗi toàn cục (hết số dư / sai khoá), tạm ngừng gọi API trong khoảng này.
    providerCooldownMs: 600000,
    // Owner không bị hạn mức NGÀY theo người chặn (vẫn chịu trần ngân sách tháng).
    // Người vận hành phải thử được hệ thống của mình; hạn mức theo người sinh ra để
    // chặn lạm dụng của người dùng cuối, không phải để chặn chính mình.
    ownerBypassLimit: true,
    enableGroupAssistant: false,
    priceInputPer1mUsd: DEFAULT_PRICE_INPUT_PER_1M_USD,
    priceOutputPer1mUsd: DEFAULT_PRICE_OUTPUT_PER_1M_USD
});

const TRUTHY = ["1", "true", "yes", "on"];
const FALSY = ["0", "false", "no", "off"];

function readBoolean(env, name, fallback) {
    const raw = env?.[name];
    if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
    const value = String(raw).trim().toLowerCase();
    if (TRUTHY.includes(value)) return true;
    if (FALSY.includes(value)) return false;
    return fallback;
}

function readString(env, name, fallback) {
    const raw = env?.[name];
    if (raw === undefined || raw === null) return fallback;
    const value = String(raw).trim();
    return value === "" ? fallback : value;
}

// Số dương hữu hạn. Giá trị lạ/âm/không phải số ⇒ dùng mặc định, không bao giờ
// biến một biến môi trường gõ sai thành "0 request" hay "ngân sách vô hạn".
function readNumber(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
    const raw = env?.[name];
    if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
    const value = Number(String(raw).trim());
    if (!Number.isFinite(value) || value < min || value > max) return fallback;
    return integer ? Math.trunc(value) : value;
}

// Địa chỉ API: chỉ chấp nhận http/https và bỏ dấu "/" ở cuối để ghép đường dẫn
// không sinh ra "//chat/completions".
function readBaseUrl(env) {
    const raw = readString(env, "DEEPSEEK_BASE_URL", DEFAULT_BASE_URL);
    try {
        const parsed = new URL(raw);
        if (!["http:", "https:"].includes(parsed.protocol)) return DEFAULT_BASE_URL;
        return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
    } catch (_) {
        return DEFAULT_BASE_URL;
    }
}

function loadAiConfig(env = process.env) {
    const apiKey = readString(env, "DEEPSEEK_API_KEY", "");
    const enabled = readBoolean(env, "AI_ASSISTANT_ENABLED", DEFAULTS.enabled);

    return {
        enabled,
        apiKey,
        // `configured` mới là điều kiện thật để gọi API: bật cờ mà thiếu khóa thì
        // trợ lý im lặng chứ không được gọi một endpoint không xác thực.
        configured: enabled && apiKey.length > 0,
        provider: "deepseek",
        model: readString(env, "DEEPSEEK_MODEL", DEFAULTS.model),
        baseUrl: readBaseUrl(env),
        timeoutMs: readNumber(env, "AI_REQUEST_TIMEOUT_MS", DEFAULTS.timeoutMs, { min: 1000, max: 120000, integer: true }),
        maxRetries: readNumber(env, "AI_MAX_RETRIES", DEFAULTS.maxRetries, { min: 0, max: 5, integer: true }),
        maxHistoryMessages: readNumber(env, "AI_MAX_HISTORY_MESSAGES", DEFAULTS.maxHistoryMessages, { min: 0, max: 50, integer: true }),
        maxInputChars: readNumber(env, "AI_MAX_INPUT_CHARS", DEFAULTS.maxInputChars, { min: 200, max: 60000, integer: true }),
        maxOutputTokens: readNumber(env, "AI_MAX_OUTPUT_TOKENS", DEFAULTS.maxOutputTokens, { min: 64, max: 4000, integer: true }),
        maxRequestsPerUserPerDay: readNumber(env, "AI_MAX_REQUESTS_PER_USER_PER_DAY", DEFAULTS.maxRequestsPerUserPerDay, { min: 0, max: 10000, integer: true }),
        maxRequestsPerDay: readNumber(env, "AI_MAX_REQUESTS_PER_DAY", 0, { min: 0, max: 1000000, integer: true }),
        monthlyBudgetUsd: readNumber(env, "AI_MONTHLY_BUDGET_USD", DEFAULTS.monthlyBudgetUsd, { min: 0, max: 100000 }),
        maxActionsPerRequest: readNumber(env, "AI_MAX_ACTIONS_PER_REQUEST", DEFAULTS.maxActionsPerRequest, { min: 1, max: 20, integer: true }),
        confirmationTtlMs: readNumber(env, "AI_CONFIRMATION_TTL_MS", DEFAULTS.confirmationTtlMs, { min: 10000, max: 3600000, integer: true }),
        clarificationTtlMs: readNumber(env, "AI_CLARIFICATION_TTL_MS", DEFAULTS.clarificationTtlMs, { min: 10000, max: 3600000, integer: true }),
        cooldownMs: readNumber(env, "AI_COOLDOWN_MS", DEFAULTS.cooldownMs, { min: 0, max: 600000, integer: true }),
        noticeCooldownMs: readNumber(env, "AI_NOTICE_COOLDOWN_MS", DEFAULTS.noticeCooldownMs, { min: 0, max: 86400000, integer: true }),
        providerCooldownMs: readNumber(env, "AI_PROVIDER_COOLDOWN_MS", DEFAULTS.providerCooldownMs, { min: 0, max: 86400000, integer: true }),
        ownerBypassLimit: readBoolean(env, "AI_OWNER_BYPASS_LIMIT", DEFAULTS.ownerBypassLimit),
        enableGroupAssistant: readBoolean(env, "AI_ENABLE_GROUP_ASSISTANT", DEFAULTS.enableGroupAssistant),
        priceInputPer1mUsd: readNumber(env, "AI_PRICE_INPUT_PER_1M_USD", DEFAULTS.priceInputPer1mUsd, { min: 0, max: 10000 }),
        priceOutputPer1mUsd: readNumber(env, "AI_PRICE_OUTPUT_PER_1M_USD", DEFAULTS.priceOutputPer1mUsd, { min: 0, max: 10000 })
    };
}

// Chi phí ước tính từ số token do API báo về. Dùng đúng token thật, không đoán
// theo độ dài chuỗi — đó là lý do phải đọc `usage` của phản hồi.
function estimateCostUsd(usage, config) {
    const promptTokens = Number(usage?.promptTokens || 0);
    const completionTokens = Number(usage?.completionTokens || 0);
    const inputPrice = Number(config?.priceInputPer1mUsd ?? DEFAULT_PRICE_INPUT_PER_1M_USD);
    const outputPrice = Number(config?.priceOutputPer1mUsd ?? DEFAULT_PRICE_OUTPUT_PER_1M_USD);
    const cost = (promptTokens / 1_000_000) * inputPrice + (completionTokens / 1_000_000) * outputPrice;
    return Math.round(cost * 1e8) / 1e8;
}

module.exports = {
    DEFAULTS,
    DEFAULT_BASE_URL,
    DEFAULT_MODEL,
    DEFAULT_PRICE_INPUT_PER_1M_USD,
    DEFAULT_PRICE_OUTPUT_PER_1M_USD,
    estimateCostUsd,
    loadAiConfig
};
