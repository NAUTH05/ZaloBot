// ============================================================================
// Nhật ký gửi tin theo lịch (bộ đệm trong bộ nhớ).
//
// Vì sao cần: khi người dùng báo "Chat Center ghi đã gửi nhưng Zalo không thấy
// thông báo", câu trả lời phải nằm ở phía máy chủ: lần gửi đó đi qua bot nào,
// tới chat nào, nhà cung cấp trả về mã tin nhắn gì, hay lỗi gì. Trước đây thông
// tin này chỉ có trong console — người vận hành phải ssh vào VPS đọc `pm2 logs`,
// mà log PM2 lại xoay vòng và lệch múi giờ.
//
// Vì sao KHÔNG ghi xuống Firestore: mỗi store chỉ có MỘT writer, và thêm store
// mới là thêm rủi ro ghi đè dữ liệu. Một đợt gửi 06:30 cho vài trăm người cũng
// sẽ đẩy mọi log khác ra khỏi `adminLogs` (giới hạn 500 mục). Bộ đệm trong bộ
// nhớ đủ cho việc chẩn đoán ngay trong ngày và không tốn một lượt ghi nào.
//
// Đánh đổi được nói rõ trên giao diện: khởi động lại tiến trình thì nhật ký này
// mất. Đó là lý do mỗi mục đều có dấu thời gian Việt Nam để đối chiếu với log PM2.
// ============================================================================

const MAX_ENTRIES = 400;

// Mảng cũ → mới. Chỉ giữ `MAX_ENTRIES` mục gần nhất.
let entries = [];

function text(value, max = 300) {
    return value == null ? null : String(value).slice(0, max);
}

// `result`: "sent" | "failed" | "skipped" | "deferred"
function recordDeliveryTrace(input = {}) {
    const record = {
        at: new Date().toISOString(),
        botId: text(input.botId, 64),
        chatId: text(input.chatId, 128),
        chatName: text(input.chatName, 120),
        feature: text(input.feature, 40),
        operation: text(input.operation, 60),
        result: text(input.result, 20) || "unknown",
        reason: text(input.reason, 80),
        chunks: Number(input.chunks) || 0,
        providerMessageId: text(input.providerMessageIds?.[0] ?? input.providerMessageId, 128),
        error: text(input.error, 400),
        errorKind: text(input.errorKind, 30)
    };
    entries.push(record);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    return record;
}

// Mới nhất trước. Bộ lọc phía máy chủ chỉ để giảm dữ liệu gửi đi; giao diện vẫn
// tự tìm kiếm trên phần nhận được.
function listDeliveryTraces(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 200, 1), MAX_ENTRIES);
    const botId = options.botId && options.botId !== "all" ? String(options.botId) : null;
    const result = options.result && options.result !== "all" ? String(options.result) : null;

    const filtered = entries.filter((entry) => {
        if (botId && entry.botId !== botId) return false;
        if (result && entry.result !== result) return false;
        return true;
    });
    return filtered.slice(-limit).reverse();
}

function clearDeliveryTraces() {
    const removed = entries.length;
    entries = [];
    return removed;
}

function getDeliveryTraceStats() {
    const byResult = {};
    for (const entry of entries) byResult[entry.result] = (byResult[entry.result] || 0) + 1;
    return {
        total: entries.length,
        capacity: MAX_ENTRIES,
        oldestAt: entries.length ? entries[0].at : null,
        newestAt: entries.length ? entries[entries.length - 1].at : null,
        byResult
    };
}

module.exports = {
    MAX_ENTRIES,
    clearDeliveryTraces,
    getDeliveryTraceStats,
    listDeliveryTraces,
    recordDeliveryTrace
};
