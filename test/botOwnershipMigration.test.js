const test = require("node:test");
const assert = require("node:assert/strict");

const { pendingKeys, withBotId } = require("../scripts/migrateBotOwnership");

/* -------------------------------------------------------------------------- */
/* Di trú quyền sở hữu bot: chỉ thêm trường, không đổi khóa                    */
/* -------------------------------------------------------------------------- */

test("bản ghi cũ thiếu botId được nhận diện, bản ghi đã có thì bỏ qua", () => {
    const subscriptions = {
        "chat-1::user-1": { chatId: "chat-1", userId: "user-1", studentId: "111111111" },
        "chat-2::user-2": { chatId: "chat-2", userId: "user-2", botId: "bot1" },
        "bot2::chat-3::user-3": { chatId: "chat-3", userId: "user-3" }
    };

    assert.deepEqual(pendingKeys("subscriptions", subscriptions), ["chat-1::user-1"]);
});

test("chatDirectory lấy bản ghi từ data.chats", () => {
    const directory = {
        schemaVersion: 3,
        chats: {
            "chat-1": { chatId: "chat-1", status: "active" },
            "chat-2": { chatId: "chat-2", botId: "bot1" },
            "bot2::chat-3": { chatId: "chat-3", botId: "bot2" }
        },
        deletedChatIds: {}
    };

    assert.deepEqual(pendingKeys("chatDirectory", directory), ["chat-1"]);
});

test("gán botId KHÔNG đổi khóa và không mất dữ liệu", () => {
    const before = {
        "chat-1::user-1": {
            chatId: "chat-1",
            userId: "user-1",
            studentId: "123000135",
            notificationTimes: [{ id: 1, time: "06:30", targetDayOffset: 0 }]
        }
    };

    const after = withBotId("subscriptions", before, ["chat-1::user-1"]);

    // Khóa giữ nguyên — đây là điều kiện để không cần di trú khóa.
    assert.deepEqual(Object.keys(after), Object.keys(before));
    assert.equal(after["chat-1::user-1"].botId, "bot1");
    // Các trường cũ còn nguyên.
    assert.equal(after["chat-1::user-1"].studentId, "123000135");
    assert.deepEqual(after["chat-1::user-1"].notificationTimes, before["chat-1::user-1"].notificationTimes);
    // Bản gốc không bị sửa tại chỗ.
    assert.equal(before["chat-1::user-1"].botId, undefined);
});

test("chatDirectory giữ nguyên các khóa khác khi gán botId", () => {
    const before = {
        schemaVersion: 3,
        chats: { "chat-1": { chatId: "chat-1", status: "active" } },
        deletedChatIds: { "chat-9": { deletedAt: "2026-01-01T00:00:00.000Z" } }
    };

    const after = withBotId("chatDirectory", before, ["chat-1"]);

    assert.equal(after.chats["chat-1"].botId, "bot1");
    assert.equal(after.chats["chat-1"].status, "active");
    assert.deepEqual(after.deletedChatIds, before.deletedChatIds);
    assert.equal(after.schemaVersion, 3);
});

test("di trú idempotent: chạy lần hai không còn gì để gán", () => {
    const before = {
        "chat-1::user-1": { chatId: "chat-1", userId: "user-1" },
        "chat-2::user-2": { chatId: "chat-2", userId: "user-2" }
    };

    const firstPass = pendingKeys("subscriptions", before);
    assert.equal(firstPass.length, 2);

    const after = withBotId("subscriptions", before, firstPass);
    assert.equal(pendingKeys("subscriptions", after).length, 0, "chạy lại không được gán thêm");
});

test("payload hỏng không làm script ghi bừa", () => {
    // Giá trị không phải object bị bỏ qua thay vì bị ghi đè.
    assert.deepEqual(pendingKeys("subscriptions", null), []);
    assert.deepEqual(pendingKeys("subscriptions", "không phải object"), []);
    assert.deepEqual(pendingKeys("subscriptions", []), []);
    assert.deepEqual(pendingKeys("chatDirectory", { chats: null }), []);
});
