const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { deleteSubscription, enableNotifications, getSubscription, updateSubscriptionMetadata } = require("../subscriptions");

test("admin can update metadata and delete a subscription", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-subscription-admin-"));
    const filePath = path.join(directory, "subscriptions.json");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const context = { chatId: "chat-01", userId: "user-01", userDisplayName: "An" };
    enableNotifications(context, { studentId: "123456789", studentName: "An" }, filePath);
    updateSubscriptionMetadata(context, { studentId: "987654321", studentName: "Bình" }, filePath);
    assert.equal(getSubscription(context, filePath).studentId, "987654321");
    assert.equal(deleteSubscription(context, filePath).studentName, "Bình");
    assert.equal(getSubscription(context, filePath), null);
});
