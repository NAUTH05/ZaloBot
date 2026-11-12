// ============================================================================
// SỔ CHỐNG TRÙNG CHO THÔNG BÁO THEO MỐC GIỜ.
//
// VÌ SAO BẮT BUỘC PHẢI CÓ
//
// Trước đây job chạy mỗi phút và chỉ gửi khi giờ hiện tại TRÙNG KHÍT mốc đăng ký
// (`06:30`). Chính sự trùng khít đó là cơ chế chống trùng — không có sổ nào.
//
// Nay mốc 06:30 được gửi trong một CỬA SỔ nhiều phút (gửi trước để tin cuối kịp
// giờ). Nếu chỉ nới cửa sổ mà không có sổ, job sẽ chạy lúc 06:25, 06:26, … 06:30 và
// MỖI NGƯỜI NHẬN 6 TIN. Vì vậy phải nhớ "đã gửi cho ai, ngày nào, mốc nào".
//
// BA TRẠNG THÁI CỦA MỘT LƯỢT
//
//   claim   → giữ chỗ NGAY TRƯỚC khi gửi. Hai lượt chạy chồng nhau không gửi trùng.
//   markDelivered → gửi xong. Từ đây lượt này không bao giờ gửi lại trong ngày.
//   release → gửi hỏng. Nhả chỗ để lần chạy sau (trong cửa sổ) thử lại.
//
// `claim` có hạn 3 phút: nếu tiến trình chết giữa lúc gửi, chỗ giữ bị coi là đã
// chết và được nhận lại. Không có hạn này thì một lần restart đúng lúc gửi sẽ làm
// người dùng MẤT lịch cả ngày — tệ hơn nhiều so với một tin trùng hiếm hoi.
//
// Khóa gồm cả `botId`: cùng một Chat ID ở hai tài khoản là hai cuộc trò chuyện.
// ============================================================================

const crypto = require("crypto");
const path = require("path");
const { readJsonStore, writeJsonStore } = require("./firestorePersistence");

const FILE_PATH = path.join(__dirname, "dailyScheduleDeliveries.json");
const STATE_SCHEMA_VERSION = 1;
// Giữ 7 ngày: đủ để chống trùng cho hôm nay và vài ngày gần nhất, không phình store.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CLAIM_TTL_MS = 3 * 60 * 1000;

function text(value) {
    return value == null ? "" : String(value).trim();
}

// Khóa đọc được bằng mắt khi cần chẩn đoán; bản ghi trong store dùng hash cho gọn.
function createDeliveryKey(fields = {}) {
    const botId = text(fields.botId);
    const chatId = text(fields.chatId);
    const studentId = text(fields.studentId);
    const time = text(fields.time);
    const slotDateKey = text(fields.slotDateKey);
    const targetDayOffset = Number(fields.targetDayOffset);
    if (!botId || !chatId || !studentId || !time || !slotDateKey) return null;
    if (!Number.isInteger(targetDayOffset) || targetDayOffset < 0) return null;
    return [botId, chatId, studentId, time, targetDayOffset, slotDateKey].join("|");
}

function createDeliveryEventId(fields = {}) {
    const key = createDeliveryKey(fields);
    if (!key) return null;
    return crypto.createHash("sha256").update(key).digest("hex");
}

function emptyState() {
    return { schemaVersion: STATE_SCHEMA_VERSION, events: {} };
}

function readState(filePath = FILE_PATH) {
    try {
        const state = readJsonStore(filePath, FILE_PATH, emptyState());
        if (!state || typeof state !== "object" || Array.isArray(state)) return emptyState();
        return {
            schemaVersion: STATE_SCHEMA_VERSION,
            events: state.events && typeof state.events === "object" && !Array.isArray(state.events)
                ? state.events
                : {}
        };
    } catch (error) {
        // Không đọc được sổ thì vẫn phải chạy được — nhưng ghi log để không im lặng.
        console.error("Không đọc được sổ chống trùng lịch học:", error.message);
        return emptyState();
    }
}

function pruneEvents(state, now = new Date()) {
    const cutoff = now.getTime() - RETENTION_MS;
    for (const [eventId, event] of Object.entries(state.events)) {
        const recordedAt = Date.parse(event?.deliveredAt || event?.claimedAt || "");
        if (!Number.isFinite(recordedAt) || recordedAt < cutoff) delete state.events[eventId];
    }
}

// Đã gửi xong chưa? Chỉ đọc, không giữ chỗ — dùng để lọc TRƯỚC khi gọi API lịch
// của trường (tránh gọi HTTP cho người đã nhận xong).
function isDelivered(fields = {}, { filePath = FILE_PATH } = {}) {
    const eventId = createDeliveryEventId(fields);
    if (!eventId) return false;
    const event = readState(filePath).events[eventId];
    return Boolean(event?.deliveredAt);
}

// Giữ chỗ trước khi gửi. Trả về eventId, hoặc null nếu đã gửi / đang có người gửi.
function claimDelivery(fields = {}, { now = new Date(), filePath = FILE_PATH } = {}) {
    const eventId = createDeliveryEventId(fields);
    if (!eventId) return null;

    const state = readState(filePath);
    pruneEvents(state, now);
    const existing = state.events[eventId];
    if (existing?.deliveredAt) return null;
    // Có chỗ đang giữ nhưng chưa xong: nếu còn "tươi" thì lượt khác đang gửi.
    if (existing?.claimedAt) {
        const claimedAt = Date.parse(existing.claimedAt);
        if (Number.isFinite(claimedAt) && now.getTime() - claimedAt < CLAIM_TTL_MS) return null;
    }

    state.events[eventId] = {
        eventId,
        botId: text(fields.botId),
        chatId: text(fields.chatId),
        studentId: text(fields.studentId),
        time: text(fields.time),
        targetDayOffset: Number(fields.targetDayOffset),
        slotDateKey: text(fields.slotDateKey),
        claimedAt: now.toISOString(),
        deliveredAt: null
    };
    writeJsonStore(filePath, FILE_PATH, state);
    return eventId;
}

// Đánh dấu đã gửi xong. `meta.confirmed` ghi lại việc nhà cung cấp có trả mã tin
// nhắn hay không.
//
// Vì sao vẫn đánh dấu "đã gửi" khi CHƯA xác nhận: gửi lại một tin có thể đã tới
// (yêu cầu xong nhưng phản hồi mơ hồ) sẽ tạo tin TRÙNG cho người dùng. Yêu cầu là
// "không gửi lại ngay", nên sổ ghi nhận đã gửi và `confirmed: false` nói rõ rằng
// ta KHÔNG có bằng chứng — người vận hành đọc được sự khác biệt này.
function markDelivered(eventId, now = new Date(), filePath = FILE_PATH, meta = {}) {
    const state = readState(filePath);
    if (!state.events[eventId]) return false;
    state.events[eventId].deliveredAt = now.toISOString();
    if (meta.confirmed !== undefined) state.events[eventId].confirmed = meta.confirmed === true;
    writeJsonStore(filePath, FILE_PATH, state);
    return true;
}

function releaseDelivery(eventId, filePath = FILE_PATH) {
    const state = readState(filePath);
    if (!state.events[eventId]) return false;
    delete state.events[eventId];
    writeJsonStore(filePath, FILE_PATH, state);
    return true;
}

// Xoá sạch sổ. Dùng cho kiểm thử và khi người vận hành muốn gửi lại một mốc đã
// lỡ (không có lối tắt nào khác vì sổ nằm trong Firestore).
function resetDeliveries(filePath = FILE_PATH) {
    const state = readState(filePath);
    const removed = Object.keys(state.events).length;
    writeJsonStore(filePath, FILE_PATH, emptyState());
    return removed;
}

module.exports = {
    CLAIM_TTL_MS,
    FILE_PATH,
    RETENTION_MS,
    STATE_SCHEMA_VERSION,
    claimDelivery,
    createDeliveryEventId,
    createDeliveryKey,
    isDelivered,
    markDelivered,
    readState,
    releaseDelivery,
    resetDeliveries
};
