// ============================================================================
// Tạm dừng trợ lý AI khi quản trị viên đang trả lời trực tiếp.
//
// Vì sao cần: khi quản trị viên đang trực hỗ trợ một người (hoặc một nhóm), mỗi
// câu người dùng gửi tới sẽ bị trợ lý trả lời trước — hai người cùng nói một lúc
// và người dùng nhận câu trả lời máy móc trong khi đang chờ người thật.
//
// Phạm vi:
//   global — tắt trợ lý ở MỌI cuộc trò chuyện (một buổi trực, một đợt bảo trì).
//   chat   — tắt trợ lý ở MỘT cuộc trò chuyện, khóa `botId::chatId`.
//
// Điều KHÔNG bị ảnh hưởng: lệnh có dấu "/", lô lệnh tất định, lời xác nhận đang
// chờ, và mọi thông báo theo lịch. Tạm dừng chỉ chặn đường gọi mô hình — đúng
// nghĩa "trợ lý im lặng", không phải "bot ngừng làm việc".
//
// Trạng thái nằm trong `adminSettings` (store đã có, một writer duy nhất), nên
// không thêm store mới và không có nguy cơ ghi đè dữ liệu của bot khác.
// ============================================================================

const { getAdminSettings, pauseKey } = require("./adminSettings");

function activeUntil(entry, now) {
    if (!entry || entry.paused !== true) return false;
    if (!entry.until) return true;
    const parsed = Date.parse(entry.until);
    if (!Number.isFinite(parsed)) return true;
    return parsed > new Date(now).getTime();
}

function entrySummary(entry) {
    return {
        paused: entry?.paused === true,
        until: entry?.until || null,
        reason: entry?.reason || null,
        updatedAt: entry?.updatedAt || null,
        updatedBy: entry?.updatedBy || null
    };
}

// Trạng thái hiệu lực cho MỘT cuộc trò chuyện. Ưu tiên phạm vi hẹp (chat) trước
// phạm vi rộng, để lý do hiển thị đúng thứ người vận hành vừa đặt.
function resolveAiPause(state, context = {}, now = new Date()) {
    const source = state && typeof state === "object" ? state : {};
    const botId = String(context.botId || "").trim();
    const chatId = String(context.chatId || "").trim();
    const key = botId && chatId ? pauseKey(botId, chatId) : null;
    const chatEntry = key ? source.chats?.[key] : null;

    if (activeUntil(chatEntry, now)) {
        return { paused: true, scope: "chat", chatKey: key, ...entrySummary(chatEntry) };
    }
    if (activeUntil(source.global, now)) {
        return { paused: true, scope: "global", chatKey: null, ...entrySummary(source.global) };
    }
    return { paused: false, scope: null, chatKey: key, until: null, reason: null, updatedAt: null, updatedBy: null };
}

function readAiPauseState() {
    try {
        return getAdminSettings().aiPause || { global: { paused: false }, chats: {} };
    } catch (_) {
        // Không đọc được thiết lập thì trợ lý chạy như bình thường: đây là công
        // tắc vận hành, không phải cổng an toàn. Chặn nhầm vì lỗi đọc tệp sẽ làm
        // trợ lý im lặng mà không ai biết lý do.
        return { global: { paused: false }, chats: {} };
    }
}

function isAiPaused(context = {}, now = new Date()) {
    return resolveAiPause(readAiPauseState(), context, now);
}

// Dạng đầy đủ cho dashboard: cờ `active` đã tính theo thời điểm hiện tại.
function describeAiPause(state = readAiPauseState(), now = new Date()) {
    const source = state && typeof state === "object" ? state : {};
    const chats = Object.entries(source.chats || {}).map(([key, entry]) => {
        const separator = key.indexOf("::");
        return {
            key,
            botId: separator > 0 ? key.slice(0, separator) : "",
            chatId: separator > 0 ? key.slice(separator + 2) : key,
            ...entrySummary(entry),
            active: activeUntil(entry, now)
        };
    }).sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));

    return {
        global: { ...entrySummary(source.global), active: activeUntil(source.global, now) },
        chats,
        // Cờ tổng để giao diện hiện một dòng nhắc duy nhất ở đầu trang.
        anyActive: activeUntil(source.global, now) || chats.some((entry) => entry.active)
    };
}

module.exports = {
    describeAiPause,
    isAiPaused,
    readAiPauseState,
    resolveAiPause
};
