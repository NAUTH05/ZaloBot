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
