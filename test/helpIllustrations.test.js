// ============================================================================
// Test cho kế hoạch gửi ảnh minh hoạ kèm /help.
//
// Yêu cầu người dùng: gõ /help phải thấy cả danh sách lệnh LẪN ảnh, không chỉ
// /help <lệnh>. Nhưng không được biến một lần gõ /help thành 30 tin nhắn.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");

const { planHelpIllustrations } = require("../main");
const { HELP_COMMANDS } = require("../helpContent");

test("ảnh không gắn lệnh hoặc thiếu mediaId bị bỏ qua", () => {
    const plan = planHelpIllustrations([
        { mediaId: "a1", command: null },
        { mediaId: "a2", command: "" },
        { command: "nhanlich" },
        { mediaId: "a3", command: "nhanlich" }
    ]);

    assert.equal(plan.groups.length, 1);
    assert.equal(plan.groups[0].command, "nhanlich");
    assert.deepEqual(plan.groups[0].images.map((item) => item.mediaId), ["a3"]);
});

test("không có ảnh nào thì không gửi gì", () => {
    assert.deepEqual(planHelpIllustrations([]).groups, []);
    assert.deepEqual(planHelpIllustrations(null).groups, []);
    assert.equal(planHelpIllustrations([]).hasHeader, false);
});

test("nhóm theo lệnh và xếp theo đúng thứ tự lệnh trong helpContent", () => {
    // Lấy hai lệnh có thật, cố tình đưa vào theo thứ tự ngược.
    const first = HELP_COMMANDS[0].command;
    const second = HELP_COMMANDS[1].command;

    const plan = planHelpIllustrations([
        { mediaId: "b1", command: second },
        { mediaId: "a1", command: first }
    ]);

    assert.deepEqual(plan.groups.map((group) => group.command), [first, second]);
});

test("trong cùng một lệnh, ảnh xếp cũ → mới", () => {
    const plan = planHelpIllustrations([
        { mediaId: "new", command: "nhanlich", storedAt: "2026-05-02T00:00:00.000Z" },
        { mediaId: "old", command: "nhanlich", storedAt: "2026-05-01T00:00:00.000Z" }
    ]);

    assert.deepEqual(plan.groups[0].images.map((item) => item.mediaId), ["old", "new"]);
});

test("chỉ một lệnh có ảnh thì không cần tiêu đề chung", () => {
    const plan = planHelpIllustrations([{ mediaId: "a1", command: "nhanlich" }]);
    assert.equal(plan.hasHeader, false);
});

test("từ hai lệnh trở lên thì có tiêu đề chung", () => {
    const plan = planHelpIllustrations([
        { mediaId: "a1", command: "nhanlich" },
        { mediaId: "b1", command: "luumssv" }
    ]);
    assert.equal(plan.hasHeader, true);
});

test("trần số ảnh: không gửi quá maxImages", () => {
    const images = Array.from({ length: 12 }, (_, index) => ({
        mediaId: `m${index}`,
        command: "nhanlich"
    }));

    const plan = planHelpIllustrations(images, { maxImages: 3 });
    const total = plan.groups.reduce((sum, group) => sum + group.images.length, 0);

    assert.equal(total, 3);
    assert.equal(plan.skippedImages, 9);
});

test("trần số lệnh: không gửi quá maxCommands", () => {
    const images = HELP_COMMANDS.slice(0, 6).map((entry, index) => ({
        mediaId: `m${index}`,
        command: entry.command
    }));

    const plan = planHelpIllustrations(images, { maxCommands: 2 });
    assert.equal(plan.groups.length, 2);
    assert.equal(plan.skippedCommands, 4);
});

test("trần ảnh áp dụng xuyên các lệnh, không phải mỗi lệnh", () => {
    const images = [
        { mediaId: "a1", command: "nhanlich" },
        { mediaId: "a2", command: "nhanlich" },
        { mediaId: "b1", command: "luumssv" }
    ];

    const plan = planHelpIllustrations(images, { maxImages: 2 });
    const total = plan.groups.reduce((sum, group) => sum + group.images.length, 0);

    assert.equal(total, 2);
    assert.equal(plan.skippedImages, 1);
});

test("lệnh không có trong helpContent bị bỏ qua (người dùng không gõ được)", () => {
    const plan = planHelpIllustrations([
        { mediaId: "z1", command: "lenhla" },
        { mediaId: "a1", command: HELP_COMMANDS[0].command }
    ]);

    assert.equal(plan.groups.length, 1, "chỉ lệnh có thật mới được gửi");
    assert.equal(plan.groups[0].command, HELP_COMMANDS[0].command);
});

test("ảnh trùng mediaId trong cùng lệnh vẫn giữ nguyên (không tự lọc)", () => {
    // Việc chống trùng thuộc về tầng lưu trữ; ở đây chỉ kiểm tra không làm mất.
    const plan = planHelpIllustrations([
        { mediaId: "same", command: "nhanlich" },
        { mediaId: "same", command: "nhanlich" }
    ]);
    assert.equal(plan.groups[0].images.length, 2);
});
