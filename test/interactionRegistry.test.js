const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getInteractionTargets, recordInteraction } = require("../interactionRegistry");

test("mỗi chat được lưu một lần và cập nhật người tương tác gần nhất", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-interactions-"));
    const filePath = path.join(directory, "interactions.json");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    recordInteraction(
        { chatId: "group-1", userId: "user-1", userDisplayName: "An" },
        { chat: { id: "group-1", type: "group", title: "Nhóm lớp" } },
        new Date("2026-08-01T00:00:00.000Z"),
        filePath
    );
    recordInteraction(
        { chatId: "group-1", userId: "user-2", userDisplayName: "Bình" },
        { chat: { id: "group-1", type: "group", title: "Nhóm lớp" } },
        new Date("2026-08-02T00:00:00.000Z"),
        filePath
    );

    const targets = getInteractionTargets(filePath);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].chatType, "group");
    assert.equal(targets[0].lastUserId, "user-2");
    assert.equal(targets[0].firstInteractionAt, "2026-08-01T00:00:00.000Z");
});
