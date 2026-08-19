const test = require("node:test");
const assert = require("node:assert/strict");
process.env.BOT_TOKEN ||= "test-token";
const { groupSubscriptionsByStudent } = require("../main");

function subscription(overrides = {}) {
    return {
        studentId: "123000135",
        chatId: "chat-01",
        notificationTimes: [{ id: 1, time: "06:00" }],
        ...overrides
    };
}

test("scheduler chỉ chọn các đăng ký khớp đúng giờ hiện tại", () => {
    const grouped = groupSubscriptionsByStudent([
        subscription(),
        subscription({ studentId: "123000246", chatId: "chat-02", notificationTimes: [{ id: 1, time: "20:00" }] })
    ], "06:00");

    assert.deepEqual([...grouped.keys()], ["123000135"]);
    assert.deepEqual([...grouped.get("123000135").keys()], ["chat-01"]);
    assert.equal(groupSubscriptionsByStudent([subscription()], "06:01").size, 0);
});

test("scheduler không gửi trùng một MSSV tới cùng một chat trong cùng mốc giờ", () => {
    const grouped = groupSubscriptionsByStudent([
        subscription({ userId: "user-01" }),
        subscription({ userId: "user-02" }),
        subscription({ chatId: "chat-02", userId: "user-03" })
    ], "06:00");

    assert.equal(grouped.size, 1);
    assert.deepEqual([...grouped.get("123000135").keys()], ["chat-01", "chat-02"]);
});
