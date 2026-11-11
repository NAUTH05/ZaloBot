// ============================================================================
// Chính sách phản hồi trong NHÓM — theo từng nhóm, lưu bền vững.
//
// Vì sao cần: bot tham gia nhóm sẽ NHẬN được mọi tin nhắn của nhóm, nhưng cổng ở
// groupMentions.js bỏ qua mọi tin không nhắc tới bot. Đúng cho nhóm lớp (tránh bot
// trả lời loạn), nhưng sai cho nhóm hỗ trợ: quản trị viên không thấy tin nào trong
// Chat Center nên không hỗ trợ được, vì tin bị bỏ TRƯỚC khi ghi lịch sử.
//
// Hai chế độ:
//   mention (mặc định) — chỉ xử lý khi được tag hoặc khi có lệnh "/..."
//   ingest             — NHẬN mọi tin: ghi lịch sử để quản trị viên xem và trả lời
//                        tay trong Chat Center. Bot vẫn KHÔNG tự trả lời tin
//                        thường; chỉ lệnh mới được đáp.
//
// "ingest" không phải "trả lời tất cả": không có nhánh nào sinh câu trả lời cho
// văn bản thường, nên chế độ này không thể làm bot nói trong nhóm.
//
// Lời chào tự động KHÔNG BAO GIỜ được gửi vào nhóm (xem main.js) — đó là quy tắc
// cứng, không phải một tuỳ chọn, vì lời chào trong nhóm là phát cho cả nhóm.
// ============================================================================

const path = require("path");
const { readJsonStore, writeJsonStore } = require("./firestorePersistence");

const FILE_PATH = path.join(__dirname, "groupPolicy.json");
const SCHEMA_VERSION = 1;
// Trần số nhóm ghi đè: chặn một payload lạ làm phình store.
const MAX_OVERRIDES = 500;

const MODE = Object.freeze({
    MENTION: "mention",
    INGEST: "ingest"
});

const MODES = new Set(Object.values(MODE));
const DEFAULT_MODE = MODE.MENTION;

function nowIso() {
    return new Date().toISOString();
}

function normalizeMode(value, fallback = null) {
    const text = String(value == null ? "" : value).trim().toLowerCase();
    if (MODES.has(text)) return text;
    // "inherit"/null/rỗng = bỏ ghi đè, dùng mặc định.
    if (["inherit", "default", "mac-dinh", ""].includes(text)) return fallback;
    return fallback;
}

// Khóa phạm vi: cùng một chatId ở hai bot là hai nhóm khác nhau.
function scopeChatKey(botId, chatId) {
    const bot = String(botId == null ? "" : botId).trim();
    const chat = String(chatId == null ? "" : chatId).trim();
    if (!bot || !chat) return null;
    return `${bot}::${chat}`;
}

function readPolicy(filePath = FILE_PATH) {
    const fallback = { schemaVersion: SCHEMA_VERSION, defaultMode: DEFAULT_MODE, chats: {} };
    const data = readJsonStore(filePath, FILE_PATH, fallback);
    const defaultMode = normalizeMode(data?.defaultMode, DEFAULT_MODE);

    const chats = {};
    const source = data && typeof data.chats === "object" && data.chats ? data.chats : {};
    for (const [key, value] of Object.entries(source)) {
        const mode = normalizeMode(value?.mode);
        if (!mode) continue;
        chats[key] = { mode, updatedAt: String(value?.updatedAt || "") || null };
    }
    return { schemaVersion: SCHEMA_VERSION, defaultMode, chats };
}

function writePolicy(policy, filePath = FILE_PATH) {
    writeJsonStore(filePath, FILE_PATH, {
        schemaVersion: SCHEMA_VERSION,
        defaultMode: normalizeMode(policy.defaultMode, DEFAULT_MODE),
        chats: policy.chats || {}
    });
}

// Chế độ hiệu lực cho một nhóm: ghi đè của nhóm, nếu không có thì mặc định.
function getChatMode({ botId, chatId } = {}, filePath = FILE_PATH) {
    const policy = readPolicy(filePath);
    const key = scopeChatKey(botId, chatId);
    const override = key ? policy.chats[key] : null;
    return override?.mode || policy.defaultMode;
}

// Chế độ này có nhận tin không nhắc tới bot hay không.
function allowsUntagged(mode) {
    return normalizeMode(mode) === MODE.INGEST;
}

function setDefaultMode(value, filePath = FILE_PATH) {
    const mode = normalizeMode(value);
    if (!mode) throw new Error(`mode phải là một trong: ${[...MODES].join(", ")}`);
    const policy = readPolicy(filePath);
    policy.defaultMode = mode;
    writePolicy(policy, filePath);
    return policy;
}

// Đặt chế độ cho MỘT nhóm. `mode` null/rỗng ⇒ xoá ghi đè (quay về mặc định).
function setChatMode({ botId, chatId, mode } = {}, filePath = FILE_PATH) {
    const key = scopeChatKey(botId, chatId);
    if (!key) throw new Error("Cần botId và chatId");

    const policy = readPolicy(filePath);
    const wanted = mode == null || String(mode).trim() === "" ? null : normalizeMode(mode);
    if (mode != null && String(mode).trim() !== "" && !wanted) {
        throw new Error(`mode phải là một trong: ${[...MODES].join(", ")}`);
    }

    if (!wanted) {
        delete policy.chats[key];
        writePolicy(policy, filePath);
        return { key, mode: policy.defaultMode, override: false };
    }

    if (!policy.chats[key] && Object.keys(policy.chats).length >= MAX_OVERRIDES) {
        throw new Error(`Chỉ lưu được tối đa ${MAX_OVERRIDES} nhóm ghi đè`);
    }
    policy.chats[key] = { mode: wanted, updatedAt: nowIso() };
    writePolicy(policy, filePath);
    return { key, mode: wanted, override: true };
}

function listOverrides(filePath = FILE_PATH) {
    const policy = readPolicy(filePath);
    return Object.entries(policy.chats).map(([key, value]) => ({ key, ...value }));
}

module.exports = {
    DEFAULT_MODE,
    FILE_PATH,
    MAX_OVERRIDES,
    MODE,
    SCHEMA_VERSION,
    allowsUntagged,
    getChatMode,
    listOverrides,
    normalizeMode,
    readPolicy,
    scopeChatKey,
    setChatMode,
    setDefaultMode
};
