const path = require("path");
const { readJsonStore, writeJsonStore } = require("./firestorePersistence");

const FILE_PATH = path.join(__dirname, "adminSettings.json");
const SCHEMA_VERSION = 2;
const DEFAULT_PAGE_SIZE = 25;
// Command console nhiều người nhận: số người tối đa mỗi lượt và khoảng nghỉ
// giữa hai lần gửi để không dồn dập Zalo.
const DEFAULT_MAX_BATCH_SIZE = 25;
const DEFAULT_BATCH_DELAY_MS = 350;
const MAX_BATCH_SIZE_LIMIT = 100;
const MAX_BATCH_DELAY_MS = 5000;

// Hạn mức trợ lý AI do quản trị viên đặt từ dashboard.
//
// `null` = "theo .env". Nhờ vậy dashboard chỉ cần ghi cái người vận hành THẬT SỰ
// muốn đổi; các giá trị còn lại vẫn đi theo biến môi trường và không bị đóng băng
// vào dữ liệu. 0 = không giới hạn.
const AI_LIMIT_RULES = Object.freeze({
    perUserDailyLimit: { min: 0, max: 10000 },
    globalDailyLimit: { min: 0, max: 1000000 },
    monthlyBudgetUsd: { min: 0, max: 100000 }
});

function emptyAiSettings() {
    return {
        perUserDailyLimit: null,
        globalDailyLimit: null,
        monthlyBudgetUsd: null,
        groupAssistant: null
    };
}

// ---------------------------------------------------------------------------
// Tạm dừng trợ lý AI khi quản trị viên đang trả lời trực tiếp.
//
// Hai phạm vi, cùng một dạng bản ghi:
//   global : tắt trợ lý ở MỌI cuộc trò chuyện (ví dụ đang trực hỗ trợ một buổi).
//   chats  : tắt trợ lý ở MỘT cuộc trò chuyện, khóa `botId::chatId` — cùng một
//            chatId ở hai bot là hai cuộc trò chuyện khác nhau.
//
// `until` = null nghĩa là "cho tới khi bật lại". Hết hạn được xét LÚC ĐỌC, nên
// không cần bộ hẹn giờ nào: quá `until` thì trợ lý tự chạy lại, và mục đã hết hạn
// bị bỏ khỏi `chats` ngay lần ghi kế tiếp.
// ---------------------------------------------------------------------------
const AI_PAUSE_MAX_MINUTES = 24 * 60;

function emptyPauseEntry() {
    return { paused: false, until: null, reason: null, updatedAt: null, updatedBy: null };
}

function emptyAiPause() {
    return { global: emptyPauseEntry(), chats: {} };
}

function normalizePauseUntil(value) {
    if (value == null || value === "") return null;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function isPauseExpired(until, now) {
    if (!until) return false;
    const parsed = Date.parse(until);
    if (!Number.isFinite(parsed)) return false;
    return parsed <= new Date(now).getTime();
}

function normalizePauseEntry(raw, now) {
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const until = normalizePauseUntil(source.until);
    const expired = isPauseExpired(until, now);
    const reason = typeof source.reason === "string" && source.reason.trim()
        ? source.reason.trim().slice(0, 200)
        : null;
    return {
        paused: source.paused === true && !expired,
        until,
        reason,
        updatedAt: normalizePauseUntil(source.updatedAt),
        updatedBy: typeof source.updatedBy === "string" && source.updatedBy.trim()
            ? source.updatedBy.trim().slice(0, 64)
            : null,
        expired
    };
}

function normalizeAiPause(raw, now = new Date()) {
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const global = normalizePauseEntry(source.global, now);
    const chats = {};
    const chatSource = source.chats && typeof source.chats === "object" && !Array.isArray(source.chats)
        ? source.chats
        : {};
    for (const [key, entry] of Object.entries(chatSource)) {
        if (!String(key).includes("::")) continue;
        const normalized = normalizePauseEntry(entry, now);
        // Mục đã hết hạn hoặc đã bật lại bị bỏ hẳn: bản đồ này không được phình
        // theo số cuộc trò chuyện từng tạm dừng.
        if (!normalized.paused) continue;
        delete normalized.expired;
        chats[String(key)] = normalized;
    }
    delete global.expired;
    return { global, chats };
}

function pauseKey(botId, chatId) {
    return `${String(botId || "").trim()}::${String(chatId || "").trim()}`;
}

// Đọc lại từ dữ liệu đã lưu. Giá trị hỏng/rác ⇒ null (theo .env), không đoán.
function normalizeAiSettings(raw) {
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const ai = emptyAiSettings();
    for (const [key, rule] of Object.entries(AI_LIMIT_RULES)) {
        const value = source[key];
        if (value === null || value === undefined || value === "") continue;
        const number = Number(value);
        if (!Number.isFinite(number) || number < rule.min || number > rule.max) continue;
        ai[key] = key === "monthlyBudgetUsd" ? number : Math.trunc(number);
    }
    if (typeof source.groupAssistant === "boolean") ai.groupAssistant = source.groupAssistant;
    return ai;
}

function nowIso() { return new Date().toISOString(); }

function normalizeId(value) {
    const id = String(value == null ? "" : value).trim();
    return id || null;
}

function envIds(name) {
    return String(process.env[name] || "").split(",").map(normalizeId).filter(Boolean);
}

function normalizeAdmin(input = {}, existing = {}) {
    const userId = normalizeId(input.userId ?? existing.userId);
    const chatId = normalizeId(input.chatId ?? existing.chatId);
    if (!userId && !chatId) return null;
    return {
        ...existing,
        ...input,
        userId,
        chatId,
        displayName: String(input.displayName ?? existing.displayName ?? "").trim(),
        enabled: input.enabled !== false,
        createdAt: existing.createdAt || input.createdAt || nowIso(),
        updatedAt: nowIso()
    };
}

function readSettings(filePath = FILE_PATH) {
    const fallback = { schemaVersion: SCHEMA_VERSION, admins: [], defaultPageSize: DEFAULT_PAGE_SIZE, maxBatchSize: DEFAULT_MAX_BATCH_SIZE, batchDelayMs: DEFAULT_BATCH_DELAY_MS, ai: emptyAiSettings(), aiPause: emptyAiPause() };
    const data = readJsonStore(filePath, FILE_PATH, fallback);
    const admins = Array.isArray(data?.admins) ? data.admins.map((item) => normalizeAdmin(item)).filter(Boolean) : [];
    const parsedPageSize = Number(data?.defaultPageSize);
    const defaultPageSize = [10, 20, 25, 50, 100].includes(parsedPageSize) ? parsedPageSize : DEFAULT_PAGE_SIZE;
    const parsedBatchSize = Number(data?.maxBatchSize);
    const maxBatchSize = Number.isInteger(parsedBatchSize) && parsedBatchSize >= 1 && parsedBatchSize <= MAX_BATCH_SIZE_LIMIT
        ? parsedBatchSize
        : DEFAULT_MAX_BATCH_SIZE;
    const parsedDelay = Number(data?.batchDelayMs);
    const batchDelayMs = Number.isInteger(parsedDelay) && parsedDelay >= 0 && parsedDelay <= MAX_BATCH_DELAY_MS
        ? parsedDelay
        : DEFAULT_BATCH_DELAY_MS;
    return {
        schemaVersion: SCHEMA_VERSION,
        admins,
        defaultPageSize,
        maxBatchSize,
        batchDelayMs,
        ai: normalizeAiSettings(data?.ai),
        aiPause: normalizeAiPause(data?.aiPause)
    };
}

function writeSettings(settings, filePath = FILE_PATH) {
    writeJsonStore(filePath, FILE_PATH, {
        schemaVersion: SCHEMA_VERSION,
        admins: settings.admins || [],
        defaultPageSize: settings.defaultPageSize || DEFAULT_PAGE_SIZE,
        maxBatchSize: settings.maxBatchSize || DEFAULT_MAX_BATCH_SIZE,
        batchDelayMs: Number.isInteger(settings.batchDelayMs) ? settings.batchDelayMs : DEFAULT_BATCH_DELAY_MS,
        ai: normalizeAiSettings(settings.ai),
        aiPause: normalizeAiPause(settings.aiPause)
    });
}

function getAdminSettings(filePath = FILE_PATH) {
    return readSettings(filePath);
}

function getConfiguredAdminIds(filePath = FILE_PATH) {
    const settings = readSettings(filePath);
    return {
        userIds: [...new Set([...envIds("OWNER_USER_ID"), ...settings.admins.filter((a) => a.enabled !== false).map((a) => a.userId).filter(Boolean)])],
        chatIds: [...new Set([...envIds("OWNER_CHAT_ID"), ...settings.admins.filter((a) => a.enabled !== false).map((a) => a.chatId).filter(Boolean)])]
    };
}

function isConfiguredAdmin(context, filePath = FILE_PATH) {
    const userId = String(context?.userId || "");
    const chatId = String(context?.chatId || "");
    if (envIds("OWNER_USER_ID").includes(userId) || envIds("OWNER_CHAT_ID").includes(chatId)) return true;
    return readSettings(filePath).admins.some((admin) => {
        if (admin.enabled === false) return false;
        if (admin.userId && admin.chatId) return admin.userId === userId && admin.chatId === chatId;
        if (admin.userId) return admin.userId === userId;
        return admin.chatId === chatId;
    });
}

function upsertAdmin(input = {}, filePath = FILE_PATH) {
    const settings = readSettings(filePath);
    const userId = normalizeId(input.userId);
    const chatId = normalizeId(input.chatId);
    const index = settings.admins.findIndex((item) => {
        if (userId && chatId) return item.userId === userId && item.chatId === chatId;
        if (userId) return item.userId === userId && !item.chatId;
        return item.chatId === chatId && !item.userId;
    });
    const existing = index >= 0 ? settings.admins[index] : {};
    const record = normalizeAdmin(input, existing);
    if (!record) throw new Error("Cần userId hoặc chatId của admin");
    if (index >= 0) settings.admins[index] = record;
    else settings.admins.push(record);
    writeSettings(settings, filePath);
    return record;
}

function removeAdmin(identifier, filePath = FILE_PATH) {
    const id = normalizeId(identifier);
    const settings = readSettings(filePath);
    const index = settings.admins.findIndex((item) => item.userId === id || item.chatId === id);
    if (index < 0) return null;
    const [removed] = settings.admins.splice(index, 1);
    writeSettings(settings, filePath);
    return removed;
}

function setDefaultPageSize(value, filePath = FILE_PATH) {
    const pageSize = Number(value);
    if (![10, 20, 25, 50, 100].includes(pageSize)) throw new Error("defaultPageSize must be one of 10, 20, 25, 50, 100");
    const settings = readSettings(filePath);
    settings.defaultPageSize = pageSize;
    writeSettings(settings, filePath);
    return settings;
}

// Giới hạn số người nhận mỗi lượt của Command console.
function setMaxBatchSize(value, filePath = FILE_PATH) {
    const size = Number(value);
    if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH_SIZE_LIMIT) {
        throw new Error(`maxBatchSize must be an integer between 1 and ${MAX_BATCH_SIZE_LIMIT}`);
    }
    const settings = readSettings(filePath);
    settings.maxBatchSize = size;
    writeSettings(settings, filePath);
    return settings;
}

// Khoảng nghỉ giữa hai lần gửi trong một lượt nhiều người nhận.
function setBatchDelayMs(value, filePath = FILE_PATH) {
    const delay = Number(value);
    if (!Number.isInteger(delay) || delay < 0 || delay > MAX_BATCH_DELAY_MS) {
        throw new Error(`batchDelayMs must be an integer between 0 and ${MAX_BATCH_DELAY_MS}`);
    }
    const settings = readSettings(filePath);
    settings.batchDelayMs = delay;
    writeSettings(settings, filePath);
    return settings;
}

// Cập nhật hạn mức trợ lý AI. Chỉ ghi những trường có trong `patch`; trường còn
// lại giữ nguyên. `null` = xoá thiết lập, quay về giá trị trong .env.
//
// Giá trị sai bị TỪ CHỐI (ném lỗi ⇒ 400) chứ không âm thầm bỏ qua: người vận hành
// vừa bấm Lưu và cần biết nó có hiệu lực hay không.
function setAiSettings(patch = {}, filePath = FILE_PATH) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new Error("ai must be an object");
    }
    const settings = readSettings(filePath);
    const next = { ...settings.ai };

    for (const [key, rule] of Object.entries(AI_LIMIT_RULES)) {
        if (patch[key] === undefined) continue;
        if (patch[key] === null || patch[key] === "") {
            next[key] = null;
            continue;
        }
        const value = Number(patch[key]);
        if (!Number.isFinite(value) || value < rule.min || value > rule.max) {
            throw new Error(`${key} must be between ${rule.min} and ${rule.max}`);
        }
        next[key] = key === "monthlyBudgetUsd" ? value : Math.trunc(value);
    }

    if (patch.groupAssistant !== undefined) {
        if (patch.groupAssistant !== null && typeof patch.groupAssistant !== "boolean") {
            throw new Error("groupAssistant must be true, false, or null");
        }
        next.groupAssistant = patch.groupAssistant;
    }

    settings.ai = next;
    writeSettings(settings, filePath);
    return settings;
}

// Bật/tắt tạm dừng trợ lý AI.
//
// `minutes` = 0 hoặc null nghĩa là "cho tới khi bật lại". Giá trị sai bị TỪ CHỐI
// (ném lỗi ⇒ 400) thay vì âm thầm đổi thành "không giới hạn" — người vận hành
// vừa bấm nút và cần biết nó có hiệu lực đúng như ý.
function setAiPause(patch = {}, filePath = FILE_PATH) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new Error("aiPause must be an object");
    }
    const scope = patch.scope === "chat" ? "chat" : patch.scope === "global" ? "global" : null;
    if (!scope) throw new Error('aiPause.scope phải là "global" hoặc "chat"');

    const paused = patch.paused !== false;
    const minutesRaw = patch.minutes;
    const minutes = minutesRaw === undefined || minutesRaw === null || minutesRaw === ""
        ? 0
        : Number(minutesRaw);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > AI_PAUSE_MAX_MINUTES) {
        throw new Error(`minutes must be between 0 and ${AI_PAUSE_MAX_MINUTES}`);
    }

    const settings = readSettings(filePath);
    const now = new Date();
    const entry = {
        paused,
        until: paused && minutes > 0 ? new Date(now.getTime() + minutes * 60000).toISOString() : null,
        reason: typeof patch.reason === "string" && patch.reason.trim() ? patch.reason.trim().slice(0, 200) : null,
        updatedAt: now.toISOString(),
        updatedBy: typeof patch.actor === "string" && patch.actor.trim() ? patch.actor.trim().slice(0, 64) : null
    };

    if (scope === "global") {
        settings.aiPause = { ...settings.aiPause, global: entry };
    } else {
        const botId = String(patch.botId || "").trim();
        const chatId = String(patch.chatId || "").trim();
        if (!botId) throw new Error("aiPause.botId là bắt buộc khi tạm dừng theo cuộc trò chuyện");
        if (!chatId) throw new Error("aiPause.chatId là bắt buộc khi tạm dừng theo cuộc trò chuyện");
        const chats = { ...settings.aiPause.chats };
        const key = pauseKey(botId, chatId);
        if (paused) chats[key] = entry;
        else delete chats[key];
        settings.aiPause = { ...settings.aiPause, chats };
    }

    writeSettings(settings, filePath);
    return settings;
}

module.exports = {
    AI_LIMIT_RULES,
    AI_PAUSE_MAX_MINUTES,
    DEFAULT_BATCH_DELAY_MS,
    DEFAULT_MAX_BATCH_SIZE,
    DEFAULT_PAGE_SIZE,
    FILE_PATH,
    MAX_BATCH_DELAY_MS,
    MAX_BATCH_SIZE_LIMIT,
    emptyAiPause,
    emptyAiSettings,
    getAdminSettings,
    getConfiguredAdminIds,
    isConfiguredAdmin,
    normalizeAiPause,
    normalizeAiSettings,
    pauseKey,
    removeAdmin,
    setAiPause,
    setAiSettings,
    setBatchDelayMs,
    setDefaultPageSize,
    setMaxBatchSize,
    upsertAdmin
};
