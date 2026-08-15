const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
    allowTarget,
    blockTarget,
    canUseAi,
    canUseBot,
    getAccessSummary,
    setAccessMode,
    unallowTarget,
    unblockTarget
} = require("../accessControl");

const TEST_FILE = path.join(__dirname, "testAccessControl.json");

function cleanup() {
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    if (fs.existsSync(`${TEST_FILE}.tmp`)) fs.unlinkSync(`${TEST_FILE}.tmp`);
}

test("kiểm tra mặc định tất cả đều được truy cập", () => {
    cleanup();
    const context = { userId: "user123", chatId: "chat456" };
    assert.equal(canUseBot(context, TEST_FILE).allowed, true);
    assert.equal(canUseAi(context, TEST_FILE).allowed, true);
    cleanup();
});

test("chặn bot theo ID và kiểm tra canUseBot / canUseAi", () => {
    cleanup();
    const context = { userId: "user123", chatId: "chat456" };
    blockTarget("bot", "user123", "Chặn vi phạm", TEST_FILE);

    const botCheck = canUseBot(context, TEST_FILE);
    const aiCheck = canUseAi(context, TEST_FILE);

    assert.equal(botCheck.allowed, false);
    assert.equal(botCheck.reason, "blocked");
    assert.equal(aiCheck.allowed, false);

    unblockTarget("bot", "user123", TEST_FILE);
    assert.equal(canUseBot(context, TEST_FILE).allowed, true);
    cleanup();
});

test("chặn riêng quyền AI với blockTarget('ai')", () => {
    cleanup();
    const context = { userId: "user123", chatId: "chat456" };
    blockTarget("ai", "user123", "Chặn AI", TEST_FILE);

    assert.equal(canUseBot(context, TEST_FILE).allowed, true);
    assert.equal(canUseAi(context, TEST_FILE).allowed, false);

    unblockTarget("ai", "user123", TEST_FILE);
    assert.equal(canUseAi(context, TEST_FILE).allowed, true);
    cleanup();
});

test("chế độ allowlist chỉ cho phép người trong danh sách", () => {
    cleanup();
    const context1 = { userId: "user1", chatId: "chat1" };
    const context2 = { userId: "user2", chatId: "chat2" };

    allowTarget("bot", "user1", TEST_FILE);
    setAccessMode("bot", "allowlist", TEST_FILE);

    assert.equal(canUseBot(context1, TEST_FILE).allowed, true);
    assert.equal(canUseBot(context2, TEST_FILE).allowed, false);

    setAccessMode("bot", "all", TEST_FILE);
    assert.equal(canUseBot(context2, TEST_FILE).allowed, true);
    cleanup();
});
