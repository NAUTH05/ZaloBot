const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    getChat,
    isChatEligible,
    normalizeChatType,
    recordDeliveryFailure,
    recordDeliverySuccess,
    removeChat,
    setChatStatus,
    setFeatureOverride,
    upsertChat
} = require("../chatDirectory");

function temporaryFile(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-chat-directory-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return path.join(directory, "chatDirectory.json");
}

test("410 invalid chat is suspended immediately and excluded", (t) => {
    const filePath = temporaryFile(t);
    upsertChat({ chatId: "old-user", chatType: "private", displayName: "Old User" }, filePath);
    const record = recordDeliveryFailure("old-user", { code: "EZALO", message: "EZALO: 410 The chat_id is invalid" }, { feature: "schedule" }, filePath);
    assert.equal(record.status, "inactive");
    assert.equal(record.statusReason, "chat_id_invalid");
    assert.equal(isChatEligible("old-user", "schedule", filePath), false);
    assert.equal(record.lastError.status, 410);
});

test("transient failures suspend after three consecutive attempts and success resets health", (t) => {
    const filePath = temporaryFile(t);
    upsertChat({ chatId: "flaky-group", chatType: "group" }, filePath);
    recordDeliveryFailure("flaky-group", { code: "EZALO", message: "EZALO: 500 temporary failure" }, {}, filePath);
    recordDeliveryFailure("flaky-group", { code: "EZALO", message: "EZALO: 500 temporary failure" }, {}, filePath);
    assert.equal(getChat("flaky-group", filePath).status, "active");
    recordDeliveryFailure("flaky-group", { code: "EZALO", message: "EZALO: 500 temporary failure" }, {}, filePath);
    assert.equal(getChat("flaky-group", filePath).status, "inactive");
    setChatStatus("flaky-group", "active", "admin", "retry", filePath);
    recordDeliverySuccess("flaky-group", filePath);
    assert.equal(getChat("flaky-group", filePath).consecutiveFailureCount, 0);
    assert.match(getChat("flaky-group", filePath).lastError.message, /500/);
    assert.ok(getChat("flaky-group", filePath).lastRecoveredAt);
});

test("admin status and feature overrides preserve chat history", (t) => {
    const filePath = temporaryFile(t);
    upsertChat({ chatId: "group-1", chatType: "group", displayName: "Class Group", lastInboundInteractionAt: "2026-08-21T00:00:00.000Z" }, filePath);
    setFeatureOverride("group-1", "schedule", false, filePath);
    assert.equal(isChatEligible("group-1", "schedule", filePath), false);
    assert.equal(isChatEligible("group-1", "duty", filePath), true);
    setChatStatus("group-1", "removed", "admin", "cleanup", filePath);
    recordDeliveryFailure("group-1", { code: "EZALO", message: "EZALO: 410 The chat_id is invalid" }, {}, filePath);
    const record = getChat("group-1", filePath);
    assert.equal(record.status, "removed");
    assert.equal(record.displayName, "Class Group");
    assert.equal(record.lastInboundInteractionAt, "2026-08-21T00:00:00.000Z");
});

test("normalizes chat type and keeps hard-delete tombstones until explicit restore", (t) => {
    const filePath = temporaryFile(t);
    assert.equal(normalizeChatType("group_chat"), "group");
    assert.equal(normalizeChatType("user"), "private");
    upsertChat({ chatId: "tombstone", chatType: "group" }, filePath);
    const removed = removeChat("tombstone", true, filePath);
    assert.equal(removed.chatType, "group");
    assert.equal(upsertChat({ chatId: "tombstone", chatType: "private" }, filePath), null);
    const restored = upsertChat({ chatId: "tombstone", chatType: "private", restoreDeleted: true }, filePath);
    assert.equal(restored.chatType, "private");
});
