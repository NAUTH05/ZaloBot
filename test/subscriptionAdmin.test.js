const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    deleteSubscription,
    disableClassStartNotifications,
    disableNotifications,
    enableClassStartNotifications,
    enableNotifications,
    getSubscription,
    saveStudent,
    updateSubscriptionMetadata
} = require("../subscriptions");

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

test("class-start reminders default off and stay independent from daily notifications", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-class-start-subscription-"));
    const filePath = path.join(directory, "subscriptions.json");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const context = { chatId: "chat-01", userId: "user-01", userDisplayName: "An" };

    const saved = saveStudent(context, { studentId: "123456789", studentName: "An" }, filePath);
    assert.equal(saved.classStartNotificationsEnabled, false);
    assert.ok(enableClassStartNotifications(context, filePath));
    enableNotifications(context, { studentId: "123456789", studentName: "An" }, filePath);
    assert.equal(disableNotifications(context, filePath), true);
    assert.equal(getSubscription(context, filePath).classStartNotificationsEnabled, true);
    assert.equal(disableClassStartNotifications(context, filePath), true);
    assert.equal(getSubscription(context, filePath).notificationsEnabled, false);
});

test("class-start reminders require a saved MSSV and reset when MSSV changes", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-class-start-student-"));
    const filePath = path.join(directory, "subscriptions.json");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const context = { chatId: "chat-01", userId: "user-01", userDisplayName: "An" };

    assert.equal(enableClassStartNotifications(context, filePath), null);
    saveStudent(context, { studentId: "123456789", studentName: "An" }, filePath);
    enableClassStartNotifications(context, filePath);
    saveStudent(context, { studentId: "987654321", studentName: "Bình" }, filePath);
    assert.equal(getSubscription(context, filePath).classStartNotificationsEnabled, false);
});
