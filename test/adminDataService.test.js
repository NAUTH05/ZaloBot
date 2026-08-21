const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeType, typeFromIdentifiers } = require("../adminDataService");

test("chuẩn hóa các tên chat type phổ biến", () => {
    assert.equal(normalizeType("user"), "private");
    assert.equal(normalizeType("group_chat"), "group");
    assert.equal(normalizeType(""), "unknown");
});

test("không suy luận group chỉ vì chatId khác userId", () => {
    assert.deepEqual(typeFromIdentifiers("chat-1", ["user-1"]), {
        chatType: "unknown",
        typeSource: "identifier_mismatch"
    });
    assert.equal(typeFromIdentifiers("same-id", ["same-id"]).chatType, "private");
    assert.equal(typeFromIdentifiers("group-1", ["user-1", "user-2"]).chatType, "group");
});
