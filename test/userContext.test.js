const test = require("node:test");
const assert = require("node:assert/strict");
const {
    createSubscriptionKey,
    isCurrentSubscription,
    normalizeNotificationTime,
    normalizeNotificationTimes
} = require("../subscriptions");
const { getMessageContext } = require("../userContext");

test("hai user trong cùng chat có khóa đăng ký khác nhau", () => {
    const first = getMessageContext({
        chat: { id: "group-01" },
        from: { id: "user-01", display_name: "An" }
    });
    const second = getMessageContext({
        chat: { id: "group-01" },
        from: { id: "user-02", display_name: "Bình" }
    });

    assert.notEqual(createSubscriptionKey(first), createSubscriptionKey(second));
    assert.equal(first.chatId, second.chatId);
    assert.notEqual(first.userId, second.userId);
});

test("chuẩn hóa giờ thông báo theo định dạng 24 giờ", () => {
    assert.equal(normalizeNotificationTime("00:00"), "00:00");
    assert.equal(normalizeNotificationTime("23:59"), "23:59");
    assert.equal(normalizeNotificationTime("6:00"), null);
    assert.equal(normalizeNotificationTime("24:00"), null);
});

test("tương thích bản ghi một giờ và chuẩn hóa danh sách giờ", () => {
    assert.deepEqual(normalizeNotificationTimes({ notificationTime: "06:00" }).map((item) => item.time), ["06:00"]);
    assert.deepEqual(normalizeNotificationTimes({
        notificationTimes: [{ id: 1, time: "06:00" }, { id: 2, time: "20:00" }, { id: 3, time: "06:00" }]
    }).map((item) => item.time), ["06:00", "20:00"]);
});

test("cùng user ở hai chat khác nhau có dữ liệu độc lập", () => {
    const privateChat = { chatId: "private-01", userId: "user-01" };
    const groupChat = { chatId: "group-01", userId: "user-01" };
    assert.notEqual(createSubscriptionKey(privateChat), createSubscriptionKey(groupChat));
});

test("hỗ trợ các tên trường sender dự phòng", () => {
    const context = getMessageContext({ chat_id: 123, sender_id: 456 });
    // Không truyền botId ⇒ mặc định bot 1, đường tương thích cho dữ liệu cũ.
    assert.deepEqual(context, { botId: "bot1", chatId: "123", userId: "456", userDisplayName: "" });
});

test("ngữ cảnh mang theo botId đã nhận tin nhắn", () => {
    const message = { chat: { id: "chat-01" }, from: { id: "user-01", display_name: "An" } };

    assert.equal(getMessageContext(message, { botId: "bot2" }).botId, "bot2");
    assert.equal(getMessageContext(message, { botId: "bot3" }).botId, "bot3");
    // Giá trị lạ rơi về bot 1 thay vì tạo ra một danh tính không tồn tại.
    assert.equal(getMessageContext(message, { botId: "khong-ton-tai" }).botId, "bot1");
    assert.equal(getMessageContext(message, { botId: "" }).botId, "bot1");
});

test("cùng Chat ID và User ID ở hai bot cho ra hai khóa đăng ký khác nhau", () => {
    const message = { chat: { id: "chat-01" }, from: { id: "user-01" } };
    const bot1 = getMessageContext(message, { botId: "bot1" });
    const bot2 = getMessageContext(message, { botId: "bot2" });

    const key1 = createSubscriptionKey(bot1);
    const key2 = createSubscriptionKey(bot2);

    assert.notEqual(key1, key2, "cùng một ID ở hai bot không được dùng chung khóa");
    // Bot 1 giữ khóa trần để dữ liệu hiện có không phải di trú.
    assert.ok(!key1.includes("bot1"), `khóa bot 1 phải không có tiền tố: ${key1}`);
    assert.ok(key2.startsWith("bot2::"), `khóa bot 2 phải có tiền tố: ${key2}`);
});

test("bản ghi schema cũ không được dùng để gửi thông báo", () => {
    assert.equal(isCurrentSubscription({ studentId: "123000135", notificationsEnabled: true }), false);
    assert.equal(isCurrentSubscription({
        contextVersion: 2,
        chatId: "group-01",
        userId: "user-01",
        notificationsEnabled: true
    }), true);
});
