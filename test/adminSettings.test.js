const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getAdminSettings, isConfiguredAdmin, removeAdmin, setDefaultPageSize, upsertAdmin } = require("../adminSettings");

function temporaryFile(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-admin-settings-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return path.join(directory, "adminSettings.json");
}

test("admin settings support user/chat identity pairs and removal", (t) => {
    const filePath = temporaryFile(t);
    const record = upsertAdmin({ userId: "u-1", chatId: "c-1", displayName: "Owner" }, filePath);
    assert.equal(isConfiguredAdmin({ userId: "u-1", chatId: "c-1" }, filePath), true);
    assert.equal(isConfiguredAdmin({ userId: "u-1", chatId: "other" }, filePath), false);
    assert.equal(getAdminSettings(filePath).admins[0].displayName, "Owner");
    assert.equal(removeAdmin(record.userId, filePath).chatId, "c-1");
    assert.equal(getAdminSettings(filePath).admins.length, 0);
});

test("admin settings persist a validated default page size", (t) => {
    const filePath = temporaryFile(t);
    assert.equal(getAdminSettings(filePath).defaultPageSize, 25);
    assert.equal(setDefaultPageSize(50, filePath).defaultPageSize, 50);
    assert.throws(() => setDefaultPageSize(17, filePath));
});

/* -------------------------------------------------------------------------- */
/* Hạn mức trợ lý AI                                                           */
/* -------------------------------------------------------------------------- */

const { setAiSettings } = require("../adminSettings");

test("hạn mức AI mặc định là null, nghĩa là theo .env", (t) => {
    const filePath = temporaryFile(t);
    assert.deepEqual(getAdminSettings(filePath).ai, {
        perUserDailyLimit: null,
        globalDailyLimit: null,
        monthlyBudgetUsd: null,
        groupAssistant: null
    });
});

test("đặt hạn mức AI và giữ nguyên các trường không gửi lên", (t) => {
    const filePath = temporaryFile(t);
    setAiSettings({ perUserDailyLimit: 25 }, filePath);
    const settings = setAiSettings({ monthlyBudgetUsd: 3.5 }, filePath);
    assert.equal(settings.ai.perUserDailyLimit, 25, "không được xoá trường đã đặt trước đó");
    assert.equal(settings.ai.monthlyBudgetUsd, 3.5);
});

test("0 là không giới hạn, khác hẳn null (theo .env)", (t) => {
    const filePath = temporaryFile(t);
    setAiSettings({ perUserDailyLimit: 0 }, filePath);
    assert.equal(getAdminSettings(filePath).ai.perUserDailyLimit, 0);
    setAiSettings({ perUserDailyLimit: null }, filePath);
    assert.equal(getAdminSettings(filePath).ai.perUserDailyLimit, null);
});

test("giá trị sai bị từ chối thay vì âm thầm bỏ qua", (t) => {
    const filePath = temporaryFile(t);
    assert.throws(() => setAiSettings({ perUserDailyLimit: -1 }, filePath), /perUserDailyLimit/);
    assert.throws(() => setAiSettings({ perUserDailyLimit: 99999 }, filePath), /perUserDailyLimit/);
    assert.throws(() => setAiSettings({ monthlyBudgetUsd: -5 }, filePath), /monthlyBudgetUsd/);
    assert.throws(() => setAiSettings({ groupAssistant: "yes" }, filePath), /groupAssistant/);
    assert.throws(() => setAiSettings(null, filePath), /ai must be an object/);
});

test("bật/tắt trợ lý trong nhóm", (t) => {
    const filePath = temporaryFile(t);
    assert.equal(setAiSettings({ groupAssistant: true }, filePath).ai.groupAssistant, true);
    assert.equal(setAiSettings({ groupAssistant: false }, filePath).ai.groupAssistant, false);
    assert.equal(setAiSettings({ groupAssistant: null }, filePath).ai.groupAssistant, null);
});

test("hạn mức AI sống sót qua các lần ghi khác (page size, admin)", (t) => {
    const filePath = temporaryFile(t);
    setAiSettings({ perUserDailyLimit: 40 }, filePath);
    setDefaultPageSize(50, filePath);
    upsertAdmin({ userId: "u-9" }, filePath);
    assert.equal(getAdminSettings(filePath).ai.perUserDailyLimit, 40, "ghi cấu hình khác không được xoá hạn mức AI");
});
