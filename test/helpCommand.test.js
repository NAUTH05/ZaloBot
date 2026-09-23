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
const PUBLIC_COMMANDS = ["/start", "/luumssv", "/lich", "/lichtuan", "/lichthi", "/lichgv", "/phongtrong", "/ai", "/nhanlich", "/gionhanlich", "/suagionhanlich", "/xoagionhanlich", "/tatnhanlich", "/batnhaclich", "/tatnhaclich", "/trangthainhaclich", "/time", "/myid", "/help"];
// Phòng 411 đã được tách sang bot riêng: không lệnh nào ở đây được quay lại ZaloBot.
const EXTRACTED_411_COMMANDS = ["/lichtruc", "/danhsachlichtruc", "/dangkylich", "/huydangkylich", "/themlichtruc", "/sualichtruc", "/xoalichtruc", "/xacnhanlichtruc", "/help411", "/test6hlichtruc"];

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
    for (const extracted of EXTRACTED_411_COMMANDS) {
        assert.ok(!help.includes(extracted), `không được để ${extracted} trong /help`);
    }
    assert.ok(!help.includes("/helpadmin"), "không được để /helpadmin trong /help");
    assert.ok(!help.includes("/blockbot"), "không được để lệnh quản trị trong /help");
    assert.ok(!help.includes("411"), "không được nhắc tới phòng 411 trong /help");
});

test("gợi ý khi gõ sai lệnh không lộ lệnh phòng 411 đã tách", () => {
    for (const typo of ["lichtru", "themlichtru", "xoalichtru", "dangkylich", "huydangkylich", "danhsachlichtru", "help41", "test6hlichtru"]) {
        const suggestion = main.suggestCommandCorrection(typo);
        assert.ok(
            !/lichtruc|dangkylich|huydangkylich|help411|test6hlichtruc|xacnhanlichtruc/.test(suggestion),
            `${typo} gợi ý lệnh đã tách sang bot khác: ${suggestion}`
        );
    }
});

test("/helpadmin có ví dụ quản trị và không còn lệnh lịch trực", () => {
    const admin = main.formatAdminHelp();

    assert.match(admin, /Ví dụ:/);
    for (const command of ["/blockbot", "/accessmode", "/accesslist", "/quanlychat", "/chitietchat", "/chatfeature", "/thongbao", "/update", "/test6h", "/helpadmin"]) {
        assert.ok(admin.includes(command), `thiếu lệnh quản trị ${command}`);
    }
    for (const extracted of EXTRACTED_411_COMMANDS) {
        assert.ok(!admin.includes(extracted), `${extracted} đã được tách sang bot khác`);
    }
    assert.ok(!admin.includes("411"), "không được nhắc tới phòng 411 trong /helpadmin");
});

test("/help và /helpadmin dùng cùng một định dạng khối gọn", () => {
    const outputs = {
        "/help": main.formatGeneralHelp(),
        "/helpadmin": main.formatAdminHelp()
    };

    for (const [name, text] of Object.entries(outputs)) {
        assert.ok(!text.includes("Ví dụ:\n`"), `${name} còn dùng định dạng ví dụ cũ`);
        assert.ok(!text.includes("Lưu ý:\n"), `${name} còn dùng định dạng lưu ý cũ`);
    }

    for (const entry of HELP_COMMANDS) {
        const output = entry.group === "admin" ? outputs["/helpadmin"] : outputs["/help"];
        const block = output.split("\n\n").find((item) => item.startsWith(`**${entry.usage}**`));
        assert.ok(block, `thiếu khối cho ${entry.usage}`);
        assert.equal(block.split("\n")[0], `**${entry.usage}**`, `khối ${entry.usage} không bắt đầu bằng cú pháp`);
        assert.ok(block.includes(`(Ví dụ: ${entry.examples.join(", ")})`), `sai dòng ví dụ cho ${entry.usage}`);
        if (entry.note) assert.ok(block.includes(`(Lưu ý: ${entry.note})`), `sai dòng lưu ý cho ${entry.usage}`);
    }

    // /helpadmin: cùng định dạng, và /update tách khỏi /thongbao.
    const adminText = outputs["/helpadmin"];
    assert.ok(adminText.includes("**/update [Nội dung cập nhật]**"));
    assert.ok(adminText.includes("(Ví dụ: /update Đã bổ sung tuỳ chọn giờ nhận lịch)"));
    assert.ok(adminText.includes("**/thongbao [Nội dung thông báo]**"));
    assert.ok(adminText.includes("(Ví dụ: /thongbao Hệ thống sẽ bảo trì lúc 22:00)"));
    assert.ok(!/thongbao[^\n]*cập nhật/i.test(adminText), "/thongbao không được mô tả như thông báo cập nhật");
});

test("/update chỉ xuất hiện trong trợ giúp quản trị", () => {
    assert.ok(!main.formatGeneralHelp().includes("/update"), "/update không được nằm trong /help công khai");
    assert.ok(!main.formatGeneralHelp().includes("/thongbao"), "/thongbao không được nằm trong /help công khai");
    assert.ok(main.formatAdminHelp().includes("/update"));
});

test("các lệnh phòng 411 đã tách không còn được xử lý", async () => {
    for (const command of EXTRACTED_411_COMMANDS.map((item) => item.slice(1))) {
        const messages = await run(command, { owner: true });
        assert.equal(messages.length, 1, `/${command} phải trả về đúng một tin`);
        assert.match(messages[0], /LỆNH KHÔNG HỢP LỆ/, `/${command} không được còn được xử lý`);
        assert.ok(!messages[0].includes("LỊCH TRỰC"), `/${command} không được trả về nội dung lịch trực`);
    }
});

test("/help và /helpadmin gửi được qua cơ chế chia tin hiện tại", async () => {
    const publicMessages = await run("help");
    assert.ok(publicMessages.length >= 2, "nội dung /help dài nên phải được chia thành nhiều tin");
    for (const text of publicMessages) {
        assert.ok(text.length > 0 && text.length <= 750, `tin vượt giới hạn chia tin: ${text.length}`);
    }
    const joined = publicMessages.join("\n");
    assert.ok(joined.includes("/luumssv"));
    assert.ok(joined.includes("/nhanlich"));

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

test("parse cú pháp /nhanlich: bắt buộc chọn homnay hoặc homsau", () => {
    // Có MSSV đã lưu, chỉ nhập giờ và ngày đích.
    assert.deepEqual(main.parseNhanLichArgument("06:30 homnay", "123456789"), {
        studentId: "123456789",
        notificationTime: "06:30",
        targetDayOffset: 0
    });
    // MSSV truyền trực tiếp, thứ tự thống nhất: MSSV -> giờ -> ngày đích.
    assert.deepEqual(main.parseNhanLichArgument("123000135 06:30 homsau", null), {
        studentId: "123000135",
        notificationTime: "06:30",
        targetDayOffset: 1
    });
    // Chấp nhận hoa thường và dạng có dấu / có khoảng trắng.
    for (const token of ["homnay", "HOMNAY", "hôm nay", "Hom Nay"]) {
        assert.equal(main.parseNhanLichArgument(`06:30 ${token}`, "123456789").targetDayOffset, 0, token);
    }
    for (const token of ["homsau", "HOMSAU", "hôm sau"]) {
        assert.equal(main.parseNhanLichArgument(`06:30 ${token}`, "123456789").targetDayOffset, 1, token);
    }
    // Giới hạn giờ.
    assert.equal(main.parseNhanLichArgument("00:00 homnay", "123456789").notificationTime, "00:00");
    assert.equal(main.parseNhanLichArgument("23:59 homsau", "123456789").notificationTime, "23:59");
    assert.equal(main.parseNhanLichArgument("24:00 homnay", "123456789").error, "time");
    assert.equal(main.parseNhanLichArgument("06:60 homnay", "123456789").error, "time");
});

test("thiếu ngày đích thì báo lỗi chứ không đoán", () => {
    assert.equal(main.parseNhanLichArgument("06:30", "123456789").error, "day");
    assert.equal(main.parseNhanLichArgument("123000135 06:30", null).error, "day");
    assert.equal(main.parseNhanLichArgument("mai", "123456789").error, "day");
    assert.equal(main.parseNhanLichArgument("", "123456789").error, "empty");
    // Chưa có MSSV và không truyền MSSV.
    assert.equal(main.parseNhanLichArgument("06:30 homnay", null).error, "student");
    // Quá nhiều tham số.
    assert.equal(main.parseNhanLichArgument("123000135 06:30 homnay homnay", null).error, "syntax");
});

test("parse cú pháp /suagionhanlich: đổi được cả giờ lẫn ngày đích", () => {
    assert.deepEqual(main.parseSuaGioNhanLichArgument("#1 06:30 homnay"), {
        id: 1, notificationTime: "06:30", targetDayOffset: 0
    });
    assert.deepEqual(main.parseSuaGioNhanLichArgument("2 21:00 homsau"), {
        id: 2, notificationTime: "21:00", targetDayOffset: 1
    });
    // Chỉ đổi ngày đích.
    assert.deepEqual(main.parseSuaGioNhanLichArgument("#2 homsau"), {
        id: 2, notificationTime: null, targetDayOffset: 1
    });
    assert.equal(main.parseSuaGioNhanLichArgument("#1 06:30").error, "day");
    assert.equal(main.parseSuaGioNhanLichArgument("#1").error, "syntax");
    assert.equal(main.parseSuaGioNhanLichArgument("#1 99:99 homnay").error, "time");
});

test("parseCommand bóc tách lệnh chính xác với mọi định dạng mention Zalo trong nhóm", () => {
    assert.deepEqual(main.parseCommand("/help"), { command: "help", argument: "" });
    assert.deepEqual(main.parseCommand("/helpadmin"), { command: "helpadmin", argument: "" });
    assert.deepEqual(main.parseCommand("/help @Bot MrYukitoBoBo"), { command: "help", argument: "" });
    assert.deepEqual(main.parseCommand("/help@Bot MrYukitoBoBo"), { command: "help", argument: "" });
    assert.deepEqual(main.parseCommand("@Bot MrYukitoBoBo /help"), { command: "help", argument: "" });
    assert.deepEqual(main.parseCommand("@Bot MrYukitoBoBo /luumssv 123456789"), { command: "luumssv", argument: "123456789" });
    assert.deepEqual(main.parseCommand("/lich@botname 123456789"), { command: "lich", argument: "123456789" });
    assert.deepEqual(main.parseCommand("/themlichtruc\n19/08 Nhân – Sang\n20/08 Thuận – Cường"), {
        command: "themlichtruc",
        argument: "19/08 Nhân – Sang\n20/08 Thuận – Cường"
    });
});

test("parseCommand quy tên cũ về tên chính tắc nên không chạy hai lần", () => {
    const pairs = [
        ["/dangky 06:30 homnay", "nhanlich"],
        ["/danhsachdangky", "gionhanlich"],
        ["/suadangky #1 06:30 homnay", "suagionhanlich"],
        ["/xoadangky #1", "xoagionhanlich"],
        ["/huythongbao", "tatnhanlich"],
        ["/find 123456789", "luumssv"],
        ["/thongtinch 123", "chitietchat"],
    ];
    for (const [input, canonical] of pairs) {
        const parsed = main.parseCommand(input);
        assert.equal(parsed.command, canonical, `${input} phải quy về ${canonical}`);
        // Mỗi tên chỉ sinh ra một lệnh duy nhất.
        assert.equal(typeof parsed.command, "string");
    }
    assert.deepEqual(main.parseCommand("/dangky 06:30 homnay"), main.parseCommand("/nhanlich 06:30 homnay"));
});

test("gợi ý gõ sai hướng về tên chính tắc", () => {
    assert.equal(main.suggestCommandCorrection("nhanlich0800"), "/nhanlich 08:00 homnay|homsau");
    assert.equal(main.suggestCommandCorrection("luumssv123456789"), "/luumssv 123456789");
    assert.equal(main.suggestCommandCorrection("batnhaclic"), "/batnhaclich");
    // Tên cũ không còn được gợi ý ra nữa.
    assert.ok(!main.suggestCommandCorrection("dangky0800").includes("/dangky"));
});
