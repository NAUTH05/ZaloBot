// Sổ theo dõi chi phí và hạn mức của trợ lý AI.
//
// Một store duy nhất (`aiAssistantState`) đi qua đúng lớp lưu trữ hiện có
// (readJsonStore/writeJsonStore + writer gộp của firestorePersistence), nên không
// tạo thêm cơ chế ghi nào và không đụng tới dữ liệu của bot khác.
//
// Nội dung:
//   months      : { "2026-11": { costUsd, requests, promptTokens, completionTokens } }
//   days        : { "2026-11-11": { total, users: { "<bot>::<chat>::<user>": n } } }
//   disclosures : { "<bot>::<chat>::<user>": "ISO" }   đã thông báo xử lý dữ liệu
//
// Vì sao phải bền vững: hạn mức và ngân sách chỉ có ý nghĩa nếu khởi động lại
// tiến trình không xoá sạch bộ đếm. Vì sao không ghi Firestore trực tiếp: mỗi
// store chỉ có MỘT writer; đi qua lớp hiện có là cách duy nhất giữ được điều đó.

const path = require("path");
const { readJsonStore, writeJsonStore } = require("../firestorePersistence");

const FILE_PATH = path.join(__dirname, "..", "aiAssistantState.json");
const SCHEMA_VERSION = 1;
const KEEP_MONTHS = 3;
const KEEP_DAYS = 10;
const MAX_DISCLOSURES = 5000;
const DISCLOSURE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

function emptyState() {
    return { schemaVersion: SCHEMA_VERSION, months: {}, days: {}, disclosures: {} };
}

function monthKey(date) {
    const info = new Date(date);
    return `${info.getUTCFullYear()}-${String(info.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Khóa ngày theo giờ Việt Nam để "hạn mức trong ngày" khớp với ngày người dùng thấy.
function dayKey(date) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Ho_Chi_Minh",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    });
    const parts = Object.fromEntries(
        formatter.formatToParts(new Date(date))
            .filter((part) => part.type !== "literal")
            .map((part) => [part.type, part.value])
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function round(value, digits = 8) {
    const factor = 10 ** digits;
    return Math.round(Number(value || 0) * factor) / factor;
}

function createAiStateStore(options = {}) {
    const filePath = options.filePath || FILE_PATH;
    const defaultPath = options.defaultPath || FILE_PATH;
    const now = typeof options.now === "function" ? options.now : () => new Date();

    function read() {
        const raw = readJsonStore(filePath, defaultPath, emptyState());
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyState();
        return {
            schemaVersion: SCHEMA_VERSION,
            months: raw.months && typeof raw.months === "object" ? raw.months : {},
            days: raw.days && typeof raw.days === "object" ? raw.days : {},
            disclosures: raw.disclosures && typeof raw.disclosures === "object" ? raw.disclosures : {}
        };
    }

    function write(state) {
        writeJsonStore(filePath, defaultPath, state);
    }

    function prune(state, current = now()) {
        const months = Object.keys(state.months).sort();
        while (months.length > KEEP_MONTHS) delete state.months[months.shift()];

        const days = Object.keys(state.days).sort();
        while (days.length > KEEP_DAYS) delete state.days[days.shift()];

        const cutoff = new Date(current).getTime() - DISCLOSURE_TTL_MS;
        const disclosures = Object.entries(state.disclosures);
        if (disclosures.length > MAX_DISCLOSURES) {
            const kept = disclosures
                .filter(([, at]) => {
                    const time = Date.parse(at);
                    return Number.isFinite(time) ? time >= cutoff : false;
                })
                .slice(-MAX_DISCLOSURES);
            state.disclosures = Object.fromEntries(kept);
        }
        return state;
    }

    function getMonthUsage(date = now()) {
        const entry = read().months[monthKey(date)] || {};
        return {
            costUsd: round(entry.costUsd || 0),
            requests: Number(entry.requests || 0),
            promptTokens: Number(entry.promptTokens || 0),
            completionTokens: Number(entry.completionTokens || 0)
        };
    }

    // Ngân sách: chặn CỨNG khi chi phí ước tính đã chạm trần. Không có "nới tay"
    // nào ở đây — hết tiền thì trợ lý ngưng, lệnh thường vẫn chạy.
    function isBudgetExhausted({ budgetUsd, date = now() } = {}) {
        const limit = Number(budgetUsd);
        if (!Number.isFinite(limit) || limit <= 0) return false;
        return getMonthUsage(date).costUsd >= limit;
    }

    function getDailyCount(key, date = now()) {
        const day = read().days[dayKey(date)];
        if (!day) return 0;
        return Number(day.users?.[key] || 0);
    }

    // Kiểm tra + tăng bộ đếm trong cùng một lượt đọc/ghi để hai tin nhắn đến sát
    // nhau không cùng vượt qua hạn mức.
    function consumeQuota({ key, perUserLimit = 0, globalLimit = 0, date = now() } = {}) {
        const state = read();
        const id = dayKey(date);
        const day = state.days[id] || { total: 0, users: {} };
        const used = Number(day.users?.[key] || 0);
        const total = Number(day.total || 0);

        if (perUserLimit > 0 && used >= perUserLimit) {
            return { allowed: false, reason: "user_daily_limit", used, limit: perUserLimit };
        }
        if (globalLimit > 0 && total >= globalLimit) {
            return { allowed: false, reason: "global_daily_limit", used: total, limit: globalLimit };
        }

        day.users = { ...(day.users || {}), [key]: used + 1 };
        day.total = total + 1;
        state.days[id] = day;
        write(prune(state, now()));
        return { allowed: true, used: used + 1, limit: perUserLimit || null };
    }

    function recordUsage({ usage, costUsd, date = now() } = {}) {
        const state = read();
        const id = monthKey(date);
        const entry = state.months[id] || { costUsd: 0, requests: 0, promptTokens: 0, completionTokens: 0 };
        entry.requests = Number(entry.requests || 0) + 1;
        entry.promptTokens = Number(entry.promptTokens || 0) + Number(usage?.promptTokens || 0);
        entry.completionTokens = Number(entry.completionTokens || 0) + Number(usage?.completionTokens || 0);
        entry.costUsd = round(Number(entry.costUsd || 0) + Number(costUsd || 0));
        state.months[id] = entry;
        write(prune(state, now()));
        return { ...entry };
    }

    function hasSeenDisclosure(key) {
        return Boolean(read().disclosures[key]);
    }

    function markDisclosure(key, date = now()) {
        const state = read();
        state.disclosures[key] = new Date(date).toISOString();
        write(prune(state, now()));
    }

    function getSummary(date = now()) {
        const state = read();
        const month = getMonthUsage(date);
        const day = state.days[dayKey(date)] || { total: 0, users: {} };
        return {
            month: monthKey(date),
            day: dayKey(date),
            monthUsage: month,
            requestsToday: Number(day.total || 0),
            trackedUsersToday: Object.keys(day.users || {}).length
        };
    }

    return {
        FILE_PATH,
        consumeQuota,
        dayKey,
        getDailyCount,
        getMonthUsage,
        getSummary,
        hasSeenDisclosure,
        isBudgetExhausted,
        markDisclosure,
        monthKey,
        read,
        recordUsage
    };
}

module.exports = {
    FILE_PATH,
    SCHEMA_VERSION,
    createAiStateStore,
    dayKey,
    emptyState,
    monthKey
};
