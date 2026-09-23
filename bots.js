// ============================================================================
// Cấu hình nhiều bot Zalo trên CÙNG một codebase và CÙNG một Firestore database.
//
// Nguyên tắc quan trọng nhất: **bot 1 giữ nguyên không gian khóa cũ** (không
// tiền tố). Nhờ vậy bản triển khai hiện tại chỉ có một token chạy tiếp mà không
// cần di trú dữ liệu, và bot Room 411 vẫn đọc được chatDirectory như trước.
// Bot 2 và bot 3 dùng tiền tố `botN::` để không bao giờ đụng dữ liệu của bot 1.
//
// Mỗi bot Zalo là một danh tính riêng: token riêng, người dùng riêng, chat
// riêng, hạn mức riêng. Chat ID và User ID chỉ có nghĩa trong phạm vi một bot.
// ============================================================================
const crypto = require("crypto");

const LEGACY_BOT_ID = "bot1";
const MAX_BOTS = 3;
const BOT_IDS = Object.freeze(["bot1", "bot2", "bot3"]);
const BOT_ID_PATTERN = /^bot[1-9]\d*$/;

// Biến môi trường cho từng bot. `BOT_TOKEN` là đường tương thích của bot 1.
const TOKEN_ENV_VARS = Object.freeze({
    bot1: ["BOT_1_TOKEN", "BOT_TOKEN"],
    bot2: ["BOT_2_TOKEN"],
    bot3: ["BOT_3_TOKEN"]
});

// Cảnh báo hạn mức gửi tin hằng tháng. KHÔNG hard-code rằng hạn mức là theo bot
// hay theo tài khoản — điều đó chưa xác minh được, nên để cấu hình được và ghi
// rõ trong tài liệu.
const DEFAULT_MONTHLY_MESSAGE_WARNING = 3000;

function normalizeBotId(value) {
    const raw = String(value == null ? "" : value).trim().toLowerCase();
    if (!raw) return null;
    if (!BOT_ID_PATTERN.test(raw)) return null;
    return raw;
}

function botIndex(botId) {
    const normalized = normalizeBotId(botId);
    if (!normalized) return null;
    const index = Number(normalized.slice(3));
    return Number.isInteger(index) && index >= 1 ? index : null;
}

function isLegacyBotId(botId) {
    return normalizeBotId(botId) === LEGACY_BOT_ID;
}

// Vân tay token: dùng để phân biệt các bot trong log mà KHÔNG in token.
function tokenFingerprint(token) {
    const value = String(token || "");
    if (!value) return null;
    return crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function isMaskedToken(value) {
    return /^[0-9a-f]{8}$/.test(String(value || ""));
}

function normalizeMonthlyWarning(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MONTHLY_MESSAGE_WARNING;
    return Math.floor(parsed);
}

// ---------------------------------------------------------------------------
// Đọc cấu hình bot từ biến môi trường.
//
// Trả về { bots, errors, warnings }:
//   bots     — chỉ gồm bot BẬT, theo thứ tự bot1..botN, mỗi mục có botId/token/source
//   errors   — lỗi cấu hình khiến không thể khởi động an toàn
//   warnings — thông tin không chặn khởi động (ví dụ thiếu token bot 2/3)
// ---------------------------------------------------------------------------
function resolveBotConfigs(env = process.env) {
    const bots = [];
    const errors = [];
    const warnings = [];
    const seenTokens = new Map();

    const monthlyWarning = normalizeMonthlyWarning(env?.BOT_MONTHLY_MESSAGE_WARNING);

    for (const botId of BOT_IDS) {
        const candidates = TOKEN_ENV_VARS[botId] || [];
        const provided = candidates
            .map((name) => ({ name, token: String(env?.[name] || "").trim() }))
            .filter((item) => item.token.length > 0);

        if (provided.length === 0) {
            if (botId === LEGACY_BOT_ID) {
                errors.push(
                    "Thiếu token cho bot 1. Đặt BOT_TOKEN (đường tương thích cũ) hoặc BOT_1_TOKEN trong .env."
                );
            } else {
                // Thiếu token bot 2/3 chỉ đơn giản là bot đó tắt.
                warnings.push(`${botId} đang tắt (không có ${candidates.join(" hoặc ")}).`);
            }
            continue;
        }

        // Nhiều biến cùng cấp token cho một bot mà giá trị khác nhau là cấu hình
        // mơ hồ — từ chối thay vì âm thầm chọn một cái.
        const distinct = [...new Set(provided.map((item) => item.token))];
        if (distinct.length > 1) {
            errors.push(
                `${botId} nhận token khác nhau từ ${provided.map((item) => item.name).join(" và ")}. ` +
                "Chỉ đặt một trong hai, hoặc đặt cùng một giá trị."
            );
            continue;
        }

        const token = distinct[0];
        const source = provided[0].name;

        // Cùng một token cho hai bot là lỗi: sẽ tạo hai consumer polling trên cùng
        // một danh tính, gây nhận tin trùng và tranh chấp con trỏ cập nhật.
        const duplicate = seenTokens.get(token);
        if (duplicate) {
            errors.push(
                `${botId} và ${duplicate} đang dùng CÙNG một token (${source}). ` +
                "Mỗi bot Zalo phải có token riêng."
            );
            continue;
        }
        seenTokens.set(token, botId);

        bots.push({
            botId,
            token,
            source,
            fingerprint: tokenFingerprint(token),
            enabled: true,
            monthlyMessageWarning: monthlyWarning
        });
    }

    return { bots, errors, warnings, monthlyMessageWarning: monthlyWarning };
}

// ---------------------------------------------------------------------------
// Không gian khóa theo bot.
//
// bot1  → giữ nguyên khóa cũ (chat::user, chatId) để dữ liệu hiện có được dùng
//         nguyên trạng, không cần di trú, và Room 411 vẫn đọc được.
// botN  → thêm tiền tố `botN::` để cùng một Chat ID / User ID ở hai bot khác
//         nhau không bao giờ ghi đè lên nhau.
// ---------------------------------------------------------------------------
function storageKeyPrefix(botId) {
    const normalized = normalizeBotId(botId) || LEGACY_BOT_ID;
    return isLegacyBotId(normalized) ? "" : `${normalized}::`;
}

function scopeKey(botId, key) {
    return `${storageKeyPrefix(botId)}${key}`;
}

// Tách botId khỏi một khóa đã có tiền tố. Khóa không tiền tố thuộc về bot 1 —
// đây chính là quy tắc giữ tương thích cho dữ liệu cũ.
function parseScopedKey(key) {
    const raw = String(key == null ? "" : key);
    const match = raw.match(/^(bot\d+)::(.*)$/);
    if (!match) return { botId: LEGACY_BOT_ID, key: raw, scoped: false };
    const botId = normalizeBotId(match[1]);
    if (!botId) return { botId: LEGACY_BOT_ID, key: raw, scoped: false };
    return { botId, key: match[2], scoped: true };
}

// Mô tả bot an toàn để đưa vào log, API và dashboard: TUYỆT ĐỐI không có token.
function describeBot(bot) {
    return {
        botId: bot.botId,
        enabled: bot.enabled !== false,
        tokenSource: bot.source || null,
        tokenFingerprint: bot.fingerprint || tokenFingerprint(bot.token),
        monthlyMessageWarning: normalizeMonthlyWarning(bot.monthlyMessageWarning)
    };
}

function describeBots(bots) {
    return bots.map(describeBot);
}

module.exports = {
    BOT_IDS,
    DEFAULT_MONTHLY_MESSAGE_WARNING,
    LEGACY_BOT_ID,
    MAX_BOTS,
    TOKEN_ENV_VARS,
    botIndex,
    describeBot,
    describeBots,
    isLegacyBotId,
    isMaskedToken,
    normalizeBotId,
    parseScopedKey,
    resolveBotConfigs,
    scopeKey,
    storageKeyPrefix,
    tokenFingerprint
};
