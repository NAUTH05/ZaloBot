const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.BOT_TOKEN ||= "test-token";
// Đặt trước khi require main.js: dotenv không ghi đè biến đã có.
process.env.OWNER_USER_ID = "test-owner-user";
process.env.OWNER_CHAT_ID = "test-owner-chat";

// Chặn mọi lời gọi Zalo API để kiểm tra nội dung trợ lý trả về.
const ZaloBot = require("node-zalo-bot");
const sent = [];
ZaloBot.prototype.sendMessage = function (chatId, text) {
    sent.push({ chatId: String(chatId), text: String(text) });
    return Promise.resolve();
};

const main = require("../main.js");
const { HELP_COMMANDS } = require("../helpContent");

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const PUBLIC_COMMANDS = ["/start", "/find", "/lich", "/lichtuan", "/lichthi", "/lichgv", "/phongtrong", "/ai", "/dangky", "/danhsachdangky", "/suadangky", "/xoadangky", "/huythongbao", "/batnhaclich", "/tatnhaclich", "/trangthainhaclich", "/sinhnhat", "/time", "/myid", "/help"];
const ROOM_411_COMMANDS = ["/lichtruc", "/danhsachlichtruc", "/dangkylich", "/huydangkylich", "/themlichtruc", "/sualichtruc", "/xoalichtruc", "/help411"];

function message(userId = "regular-user", chatId = "regular-chat") {
    return { text: "", chat: { id: chatId, type: "private" }, from: { id: userId, display_name: "Người dùng" } };
}

async function run(command, { owner = false } = {}) {
    sent.length = 0;
    const userId = owner ? process.env.OWNER_USER_ID : "regular-user";
    const chatId = owner ? process.env.OWNER_CHAT_ID : "regular-chat";
    await main.handleCommand(message(userId, chatId), { command, argument: "" });
    return sent.map((item) => item.text);
}

test("/help có ví dụ, có lệnh người dùng và không chứa phòng 411", () => {
    const help = main.formatGeneralHelp();

    assert.match(help, /Ví dụ:/);
    for (const command of PUBLIC_COMMANDS) {
        assert.ok(help.includes(command), `thiếu lệnh công khai ${command}`);
    }
    for (const internal of ROOM_411_COMMANDS) {
        assert.ok(!help.includes(internal), `không được để ${internal} trong /help`);
    }
    assert.ok(!help.includes("/helpadmin"), "không được để /helpadmin trong /help");
    assert.ok(!help.includes("/blockbot"), "không được để lệnh quản trị trong /help");
    assert.ok(!help.includes("411"), "không được nhắc tới phòng 411 trong /help");
});

test("gợi ý khi gõ sai lệnh không lộ lệnh nội bộ phòng 411", () => {
    for (const typo of ["lichtru", "themlichtru", "xoalichtru", "dangkylich", "huydangkylich", "danhsachlichtru", "help41"]) {
        const suggestion = main.suggestCommandCorrection(typo);
        assert.ok(
            !/lichtruc|dangkylich|huydangkylich|help411/.test(suggestion),
            `${typo} gợi ý lộ lệnh nội bộ: ${suggestion}`
        );
    }
});

test("/helpadmin có ví dụ quản trị và trỏ tới /help411", () => {
    const admin = main.formatAdminHelp();

    assert.match(admin, /Ví dụ:/);
    for (const command of ["/blockbot", "/accessmode", "/accesslist", "/quanlychat", "/thongtinch", "/chatfeature", "/thongbao", "/update", "/danhsach", "/traloi", "/congbo", "/test6h", "/test6hlichtruc", "/helpadmin", "/help411"]) {
        assert.ok(admin.includes(command), `thiếu lệnh quản trị ${command}`);
    }
    for (const internal of ["/themlichtruc", "/sualichtruc", "/xoalichtruc"]) {
        assert.ok(!admin.includes(internal), `${internal} chỉ nên nằm trong /help411`);
    }
});

test("/help411 có tiêu đề nội bộ và đầy đủ lệnh phòng 411 kèm ví dụ", () => {
    const internal = main.formatInternal411Help();

    assert.match(internal, /INTERNAL - ROOM 411/);
    assert.match(internal, /Ví dụ:/);
    for (const command of ["/lichtruc", "/danhsachlichtruc", "/dangkylich", "/huydangkylich", "/themlichtruc", "/sualichtruc", "/xoalichtruc"]) {
        assert.ok(internal.includes(command), `thiếu lệnh nội bộ ${command}`);
    }
    assert.ok(internal.includes("(Ví dụ: /themlichtruc 24/09 Thuận - Nhân, /themlichtruc 25/09 Thuận - Sang)"));
    assert.ok(internal.includes("(Ví dụ: /sualichtruc #3 Thuận - Sang, /sualichtruc 24/09 Thuận - Sang)"));
    assert.ok(internal.includes("(Ví dụ: /xoalichtruc #3, /xoalichtruc 24/09)"));
});

test("mỗi lệnh trong cả ba trợ giúp là một khối gọn theo cùng một định dạng", () => {
    const outputs = {
        "/help": main.formatGeneralHelp(),
        "/helpadmin": main.formatAdminHelp(),
        "/help411": main.formatInternal411Help()
    };

    for (const [name, text] of Object.entries(outputs)) {
        assert.ok(!text.includes("Ví dụ:\n`"), `${name} còn dùng định dạng ví dụ cũ`);
        assert.ok(!text.includes("Lưu ý:\n"), `${name} còn dùng định dạng lưu ý cũ`);
    }

    // /help: mọi lệnh công khai đều là "**usage**" rồi tới "(Ví dụ: ...)".
    for (const entry of HELP_COMMANDS.filter((item) => item.group === "public")) {
        const block = outputs["/help"].split("\n\n").find((item) => item.startsWith(`**${entry.usage}**`));
        assert.ok(block, `/help thiếu khối cho ${entry.usage}`);
        assert.equal(block.split("\n")[0], `**${entry.usage}**`, `khối ${entry.usage} không bắt đầu bằng cú pháp`);
        assert.ok(block.includes(`(Ví dụ: ${entry.examples.join(", ")})`), `/help sai dòng ví dụ cho ${entry.usage}`);
        if (entry.note) assert.ok(block.includes(`(Lưu ý: ${entry.note})`), `/help sai dòng lưu ý cho ${entry.usage}`);
    }

    // /helpadmin: cùng định dạng, và /update tách khỏi /thongbao.
    const adminText = outputs["/helpadmin"];
    assert.ok(adminText.includes("**/update [Nội dung cập nhật]**"));
    assert.ok(adminText.includes("(Ví dụ: /update Đã bổ sung tuỳ chọn giờ nhận lịch)"));
    assert.ok(adminText.includes("**/thongbao [Nội dung thông báo]**"));
    assert.ok(adminText.includes("(Ví dụ: /thongbao Hệ thống sẽ bảo trì lúc 22:00)"));
    assert.ok(!/thongbao[^\n]*cập nhật/i.test(adminText), "/thongbao không được mô tả như thông báo cập nhật");

    // /help411: khối cuối trỏ tới /helpadmin cũng theo định dạng mới.
    assert.ok(outputs["/help411"].includes("**/helpadmin**\nXem hướng dẫn các lệnh quản trị.\n(Ví dụ: /helpadmin)"));
});

test("/update chỉ xuất hiện trong trợ giúp quản trị", () => {
    assert.ok(!main.formatGeneralHelp().includes("/update"), "/update không được nằm trong /help công khai");
    assert.ok(!main.formatGeneralHelp().includes("/thongbao"), "/thongbao không được nằm trong /help công khai");
    assert.ok(main.formatAdminHelp().includes("/update"));
});

test("người dùng thường không nhận được hướng dẫn nội bộ 411", async () => {
    const messages = await run("help411");
    assert.equal(messages.length, 1);
    assert.match(messages[0], /KHÔNG CÓ QUYỀN/);
    assert.ok(!messages[0].includes("INTERNAL - ROOM 411"));
    assert.ok(!messages[0].includes("/themlichtruc"));
});

test("quản trị viên nhận được hướng dẫn nội bộ 411", async () => {
    const messages = await run("help411", { owner: true });
    assert.ok(messages.join("\n").includes("INTERNAL - ROOM 411"));
});

test("/help và /helpadmin gửi được qua cơ chế chia tin hiện tại", async () => {
    const publicMessages = await run("help");
    assert.ok(publicMessages.length >= 2, "nội dung /help dài nên phải được chia thành nhiều tin");
    for (const text of publicMessages) {
        assert.ok(text.length > 0 && text.length <= 750, `tin vượt giới hạn chia tin: ${text.length}`);
    }
    const joined = publicMessages.join("\n");
    assert.ok(joined.includes("/find"));
    assert.ok(joined.includes("/dangky"));

    const adminMessages = await run("helpadmin", { owner: true });
    assert.ok(adminMessages.length >= 1);
    for (const text of adminMessages) {
        assert.ok(text.length > 0 && text.length <= 750, `tin vượt giới hạn chia tin: ${text.length}`);
    }
});

test("mọi ví dụ trong trợ giúp đều dùng lệnh có thật và không còn placeholder", () => {
    for (const entry of HELP_COMMANDS) {
        assert.ok(entry.examples.length > 0, `${entry.command} thiếu ví dụ`);
        for (const example of entry.examples) {
            assert.ok(!example.includes("<") && !example.includes(">"), `ví dụ còn placeholder: ${example}`);
            const parsed = main.parseCommand(example);
            assert.ok(parsed, `ví dụ không phân tích được: ${example}`);
            assert.equal(parsed.command, entry.command, `ví dụ lệch lệnh: ${example}`);
        }
    }
});

test("mọi lệnh trong trợ giúp đều được main.js xử lý", () => {
    // Lệnh có thể được định tuyến trực tiếp hoặc gom nhóm: ["a", "b"].includes(command)
    const isRouted = (name) =>
        MAIN_SOURCE.includes(`command === "${name}"`) ||
        new RegExp(`\\[[^\\]]*"${name}"[^\\]]*\\]\\.includes\\(command\\)`).test(MAIN_SOURCE);

    for (const entry of HELP_COMMANDS) {
        assert.ok(isRouted(entry.command), `trợ giúp nhắc tới /${entry.command} nhưng main.js không xử lý lệnh này`);
    }
});

test("/help411 dùng đúng kiểm tra quyền hiện có", () => {
    assert.match(MAIN_SOURCE, /command === "help411"[\s\S]{0,200}requireOwner\(context\)/);
});

test("parse giờ đăng ký lịch học tùy chọn", () => {
    assert.deepEqual(main.parseDangKyArgument("05:30", "123456789"), {
        studentId: "123456789",
        notificationTime: "05:30"
    });
    assert.deepEqual(main.parseDangKyArgument("123456789 23:59", null), {
        studentId: "123456789",
        notificationTime: "23:59"
    });
    assert.deepEqual(main.parseDangKyArgument("24:00", "123456789"), {
        studentId: "123456789",
        notificationTime: null
    });
});

test("parseCommand bóc tách lệnh chính xác với mọi định dạng mention Zalo trong nhóm", () => {
    assert.deepEqual(main.parseCommand("/help"), { command: "help", argument: "" });
    assert.deepEqual(main.parseCommand("/help411"), { command: "help411", argument: "" });
    assert.deepEqual(main.parseCommand("/helpadmin"), { command: "helpadmin", argument: "" });
    assert.deepEqual(main.parseCommand("/help @Bot MrYukitoBoBo"), { command: "help", argument: "" });
    assert.deepEqual(main.parseCommand("/help@Bot MrYukitoBoBo"), { command: "help", argument: "" });
    assert.deepEqual(main.parseCommand("@Bot MrYukitoBoBo /help"), { command: "help", argument: "" });
    assert.deepEqual(main.parseCommand("@Bot MrYukitoBoBo /find 123456789"), { command: "find", argument: "123456789" });
    assert.deepEqual(main.parseCommand("/lich@botname 123456789"), { command: "lich", argument: "123456789" });
    assert.deepEqual(main.parseCommand("/themlichtruc\n19/08 Nhân – Sang\n20/08 Thuận – Cường"), {
        command: "themlichtruc",
        argument: "19/08 Nhân – Sang\n20/08 Thuận – Cường"
    });
    assert.equal(main.suggestCommandCorrection("dangky0800"), "/dangky 08:00");
    assert.equal(main.suggestCommandCorrection("find123456789"), "/find 123456789");
    assert.equal(main.suggestCommandCorrection("batnhaclic"), "/batnhaclich");
});
