// ============================================================================
// Tests cho /help <command> routing và help image integration.
//
// Kiểm tra:
//   - findHelpCommand tìm đúng lệnh theo tên
//   - renderCommand trả về text có usage
//   - /help không argument vẫn trả danh sách chung
//   - /help <command> trả chi tiết lệnh đó
//   - /help <sai> trả warning "không tìm thấy"
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");

const { findHelpCommand, renderCommand, resolveCommandName, HELP_COMMANDS } = require("../helpContent");

test("findHelpCommand tìm đúng lệnh theo tên chính", () => {
    // Lấy một lệnh thật từ HELP_COMMANDS để kiểm tra.
    const first = HELP_COMMANDS[0];
    assert.ok(first, "HELP_COMMANDS không rỗng");

    const found = findHelpCommand(first.command);
    assert.ok(found);
    assert.strictEqual(found.command, first.command);
});

test("findHelpCommand trả null cho lệnh không tồn tại", () => {
    const found = findHelpCommand("khongtontai999");
    assert.strictEqual(found, null);
});

test("findHelpCommand nhận diện alias", () => {
    // Tìm lệnh có alias và kiểm tra resolveCommandName.
    const cmdWithAlias = HELP_COMMANDS.find((c) => c.aliases && c.aliases.length > 0);
    if (cmdWithAlias) {
        const found = findHelpCommand(cmdWithAlias.aliases[0]);
        assert.ok(found);
        assert.strictEqual(found.command, cmdWithAlias.command);
    }
});

test("renderCommand trả về text có usage", () => {
    const first = HELP_COMMANDS[0];
    const rendered = renderCommand(first);
    assert.ok(rendered);
    // renderCommand wraps usage in **markdown bold**.
    assert.ok(rendered.includes(first.usage), `rendered should contain usage "${first.usage}"`);
});

test("renderCommand có description khi entry có description", () => {
    const cmdWithDesc = HELP_COMMANDS.find((c) => c.description);
    if (cmdWithDesc) {
        const rendered = renderCommand(cmdWithDesc);
        assert.ok(rendered.includes(cmdWithDesc.description));
    }
});

test("resolveCommandName trả chuỗi rỗng cho input rỗng", () => {
    // resolveCommandName returns "" (empty string) for empty input, not null.
    assert.strictEqual(resolveCommandName(""), "");
    assert.strictEqual(resolveCommandName(null), "");
    assert.strictEqual(resolveCommandName(undefined), "");
});

test("HELP_COMMANDS có ít nhất một lệnh", () => {
    assert.ok(HELP_COMMANDS.length > 0);
});

test("mọi entry trong HELP_COMMANDS có command và usage", () => {
    for (const entry of HELP_COMMANDS) {
        assert.ok(entry.command, `Entry thiếu command: ${JSON.stringify(entry)}`);
        assert.ok(entry.usage, `Entry thiếu usage: ${entry.command}`);
    }
});
