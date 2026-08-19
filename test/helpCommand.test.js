const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.BOT_TOKEN ||= "test-token";

test("ba nhóm help tách đúng lệnh thường, trực nhật và admin", async () => {
    const mainPath = path.join(__dirname, "../main.js");
    const code = fs.readFileSync(mainPath, "utf8");
    const { formatAdminHelp, formatDutyHelp, formatGeneralHelp, parseCommand, suggestCommandCorrection } = require("../main.js");
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
    assert.match(admin, /\/thongbao/);
    assert.match(admin, /\/helpadmin/);
    assert.match(general, /_\(Ví dụ:/);
    assert.deepEqual(parseCommand("/help411"), { command: "help411", argument: "" });
    assert.deepEqual(parseCommand("/helpadmin"), { command: "helpadmin", argument: "" });
    assert.equal(suggestCommandCorrection("dangky0800"), "/dangky 08:00");
    assert.equal(suggestCommandCorrection("find123456789"), "/find 123456789");
});

test("parse giờ đăng ký lịch học tùy chọn", () => {
    const { parseDangKyArgument } = require("../main.js");

    assert.deepEqual(parseDangKyArgument("05:30", "123456789"), {
        studentId: "123456789",
        notificationTime: "05:30"
    });
    assert.deepEqual(parseDangKyArgument("123456789 23:59", null), {
        studentId: "123456789",
        notificationTime: "23:59"
    });
    assert.deepEqual(parseDangKyArgument("24:00", "123456789"), {
        studentId: "123456789",
        notificationTime: null
    });
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
