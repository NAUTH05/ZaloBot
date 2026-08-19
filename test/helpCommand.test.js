const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.BOT_TOKEN ||= "test-token";

test("ba nhóm help tách đúng lệnh thường, trực nhật và admin", async () => {
    const mainPath = path.join(__dirname, "../main.js");
    const code = fs.readFileSync(mainPath, "utf8");
    const { formatAdminHelp, formatDutyHelp, formatGeneralHelp, parseCommand } = require("../main.js");
    const general = formatGeneralHelp();
    const duty = formatDutyHelp();
    const admin = formatAdminHelp();

    assert.match(code, /command === "help411"/);
    assert.match(code, /command === "helpadmin"/);
    assert.match(code, /command === "helpadmin"[\s\S]*?requireOwner\(context\)/);
    assert.match(general, /\/start/);
    assert.match(general, /\/find 123456789/);
    assert.doesNotMatch(general, /blockbot|themlichtruc|helpadmin/);
    assert.match(duty, /\/lichtruc/);
    assert.match(duty, /\/dangkylich/);
    assert.doesNotMatch(duty, /blockbot|themlichtruc|helpadmin/);
    assert.match(admin, /\/blockbot/);
    assert.match(admin, /\/themlichtruc/);
    assert.match(admin, /\/helpadmin/);
    assert.match(general, /_\(Ví dụ:/);
    assert.deepEqual(parseCommand("/help411"), { command: "help411", argument: "" });
    assert.deepEqual(parseCommand("/helpadmin"), { command: "helpadmin", argument: "" });
});

test("parseCommand bóc tách lệnh chính xác với mọi định dạng mention Zalo trong nhóm", () => {
    const { parseCommand } = require("../main.js");

    assert.deepEqual(parseCommand("/help"), { command: "help", argument: "" });
    assert.deepEqual(parseCommand("/help @Bot MrYukitoBoBo"), { command: "help", argument: "" });
    assert.deepEqual(parseCommand("/help@Bot MrYukitoBoBo"), { command: "help", argument: "" });
    assert.deepEqual(parseCommand("@Bot MrYukitoBoBo /help"), { command: "help", argument: "" });
    assert.deepEqual(parseCommand("@Bot MrYukitoBoBo /help "), { command: "help", argument: "" });
    assert.deepEqual(parseCommand("@Bot MrYukitoBoBo /find 123456789"), { command: "find", argument: "123456789" });
    assert.deepEqual(parseCommand("/lich@botname 123456789"), { command: "lich", argument: "123456789" });
    assert.deepEqual(parseCommand("/themlichtruc\n19/08 Nhân – Sang\n20/08 Thuận – Cường"), {
        command: "themlichtruc",
        argument: "19/08 Nhân – Sang\n20/08 Thuận – Cường"
    });
});
