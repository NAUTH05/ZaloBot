// ============================================================================
// Bus sự kiện cho Chat Center.
//
// Vì sao dùng bus trong tiến trình thay vì nghe Firestore:
//   - Chỉ có MỘT tiến trình bot (pm2: instances 1, exec_mode fork), nên mọi thay
//     đổi tin nhắn đều đi qua chính tiến trình này.
//   - Nghe Firestore (onSnapshot) sẽ tốn thêm một kết nối streaming và một lượt
//     đọc cho mỗi client; bus nội bộ thì gần như miễn phí.
//   - Nếu sau này chạy nhiều tiến trình, chỉ cần thay phần publish bằng một
//     nguồn khác; phía SSE và UI không phải đổi.
//
// Quy ước: mọi payload phải là dữ liệu THUẦN (JSON-able), vì nó được gửi thẳng
// xuống trình duyệt qua SSE.
// ============================================================================
const { EventEmitter } = require("events");

const CHANNEL = "chat";

// Kiểu sự kiện. Đặt tên ngắn để payload SSE gọn.
const CHAT_EVENT = Object.freeze({
    MESSAGE: "message",        // có tin mới (inbound hoặc outbound)
    STATUS: "status",          // trạng thái gửi của một tin đã đổi
    READ: "read",              // một hội thoại được đánh dấu đã đọc
    CONVERSATION: "conversation" // metadata hội thoại đổi (tên, loại)
});

const emitter = new EventEmitter();
// Mỗi tab dashboard mở một kết nối SSE. 50 là mức dư cho vài quản trị viên.
emitter.setMaxListeners(50);

let published = 0;
let lastPublishedAt = null;

// Phát một sự kiện. Không bao giờ ném: lỗi ở một listener (ví dụ client đã đóng)
// không được làm hỏng việc ghi lịch sử tin nhắn.
function publishChatEvent(event) {
    if (!event || !event.type) return false;
    published += 1;
    lastPublishedAt = new Date().toISOString();
    try {
        emitter.emit(CHANNEL, event);
        return true;
    } catch (error) {
        console.error("[ChatEvents] lỗi phát sự kiện:", error.message);
        return false;
    }
}

// Đăng ký nhận sự kiện. Trả về hàm huỷ đăng ký.
function onChatEvent(listener) {
    if (typeof listener !== "function") return () => {};
    emitter.on(CHANNEL, listener);
    return () => emitter.off(CHANNEL, listener);
}

function getChatEventStats() {
    return {
        listeners: emitter.listenerCount(CHANNEL),
        published,
        lastPublishedAt
    };
}

module.exports = {
    CHANNEL,
    CHAT_EVENT,
    getChatEventStats,
    onChatEvent,
    publishChatEvent
};
