const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.BOT_TOKEN ||= "test-token";

const ROOT = path.join(__dirname, "..");

const { COMMAND_ALIASES, HELP_COMMANDS, resolveCommandName } = require("../helpContent");
const { findCommand, getCommandRegistry } = require("../commandRegistry");
const { FEATURES } = require("../chatDirectory");
const { resolveCommandTargeting, TARGETING } = require("../commandTargeting");

// Tệp mã nguồn phải sạch hoàn toàn khỏi tính năng sinh nhật. Riêng
// scripts/cleanupBirthdayData.js cố tình nhắc tới sinh nhật vì nó LÀ công cụ
// dọn dẹp dữ liệu cũ; nó có bài kiểm tra riêng ở dưới.
const SOURCE_FILES = [
    "main.js",
    "helpContent.js",
    "commandRegistry.js",
    "commandTargeting.js",
    "messageTemplates.js",
    "chatDirectory.js",
    "adminServer.js",
    "adminDataService.js",
    "firestorePersistence.js",
    "subscriptions.js",
    "accessControl.js",
    "interactionRegistry.js",
    "admin-ui/app.js",
    "admin-ui/index.html",
    "admin-ui/styles.css",
    "ecosystem.config.cjs",
    "package.json"
];

// Mọi tên lệnh và bí danh của tính năng sinh nhật đã bị gỡ.
const REMOVED_NAMES = [
    "sinhnhat",
    "danhsachcauhoi", "themcauhoi", "suacauhoi", "xoacauhoi", "traloicauhoi", "congbocauhoi",
    "danhsach", "them", "sua", "xoa", "traloi", "congbo"
];

function readSource(file) {
    return fs.readFileSync(path.join(ROOT, file), "utf8");
}

// Bỏ chú thích trước khi quét: chú thích giải thích việc gỡ là hợp lệ.
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

// package.json chỉ được nhắc tới sinh nhật ở script DỌN DẸP dữ liệu cũ — đó là
// quy trình người vận hành chạy tay, không phải tính năng. Mọi dòng khác (kể cả
// dependency hay script chạy thật) đều bị coi là vi phạm.
const ALLOWED_LINES = {
    "package.json": [/^\s*"cleanup:birthday-data":\s*"node scripts\/cleanupBirthdayData\.js",?\s*$/]
};

function stripAllowedLines(file, source) {
    const patterns = ALLOWED_LINES[file] || [];
    if (patterns.length === 0) return source;
    return source
        .split(/\r?\n/)
        .filter((line) => !patterns.some((pattern) => pattern.test(line)))
        .join("\n");
}

test("mã nguồn không còn tham chiếu tới tính năng sinh nhật", () => {
    const violations = [];
    for (const file of SOURCE_FILES) {
        const code = stripAllowedLines(file, stripComments(readSource(file)));
        for (const pattern of [/birthday/i, /sinhnhat/i, /cauhoi/i, /27\/08/]) {
            if (pattern.test(code)) violations.push(`${file}: ${pattern}`);
        }
    }
    assert.deepEqual(violations, []);
});

test("script dọn dẹp birthdayData tồn tại, mặc định chỉ chạy thử và luôn sao lưu trước", () => {
    const source = readSource("scripts/cleanupBirthdayData.js");
    // Mặc định không xoá: chỉ xoá khi có --apply.
    assert.match(source, /const apply = process\.argv\.includes\("--apply"\)/);
    // Luôn sao lưu trước khi xoá, và từ chối xoá nếu sao lưu không xác nhận được.
    assert.match(source, /writeBackup/);
    assert.match(source, /không xác nhận được bản sao lưu/i);
    // Chỉ đụng đúng một document.
    assert.match(source, /const STORE_ID = "birthdayData"/);
    // Không được gọi từ bot.
    assert.ok(!readSource("main.js").includes("cleanupBirthdayData"));
    assert.ok(!readSource("main.js").includes("cleanup:birthday-data"));
});

test("birthdayStore và bài kiểm tra của nó đã bị xoá", () => {
    for (const file of ["birthdayStore.js", "test/birthdayStore.test.js"]) {
        assert.equal(fs.existsSync(path.join(ROOT, file)), false, `${file} phải bị xoá`);
    }
});

test("không còn lệnh hay bí danh sinh nhật nào", () => {
    for (const name of REMOVED_NAMES) {
        assert.equal(findCommand(name), null, `/${name} vẫn còn trong sổ lệnh`);
        assert.equal(
            Object.prototype.hasOwnProperty.call(COMMAND_ALIASES, name),
            false,
            `${name} vẫn còn trong bảng bí danh`
        );
        assert.equal(
            HELP_COMMANDS.some((entry) => entry.command === name),
            false,
            `/${name} vẫn còn trong trợ giúp`
        );
    }
    // Tên đã gỡ không được quy về bất kỳ lệnh nào khác.
    for (const name of REMOVED_NAMES) {
        assert.equal(resolveCommandName(name), name, `${name} không được quy về lệnh khác`);
    }
});

test("trợ giúp không còn mục sinh nhật", () => {
    const { formatAdminHelp, formatPublicHelp } = require("../helpContent");
    for (const [label, text] of [["/help", formatPublicHelp()], ["/helpadmin", formatAdminHelp()]]) {
        assert.ok(!/sinhnhat|cauhoi|sinh nhật/i.test(text), `${label} vẫn nhắc tới sinh nhật`);
    }
    // Danh mục "Sinh nhật" không còn trong sổ lệnh.
    assert.ok(!HELP_COMMANDS.some((entry) => /sinh nhật/i.test(entry.category || "")));
});

test("lệnh sinh nhật không thể chạy qua Command console", () => {
    for (const name of REMOVED_NAMES) {
        assert.equal(
            resolveCommandTargeting(name).mode,
            TARGETING.NONE,
            `/${name} vẫn chọn được đích trong Command console`
        );
    }
    // Lệnh broadcast dùng chung vẫn hoạt động.
    for (const name of ["thongbao", "update", "test6h"]) {
        assert.equal(resolveCommandTargeting(name).mode, TARGETING.BROADCAST, `/${name} phải vẫn là broadcast`);
    }
});

test("cờ tính năng birthday đã bị gỡ", () => {
    assert.deepEqual(FEATURES, ["schedule", "broadcast"]);
    assert.equal(FEATURES.includes("birthday"), false);
});

test("không còn job sinh nhật 27/08", () => {
    const { registerRuntimeJobs } = require("../main");
    const jobs = [];
    registerRuntimeJobs({ scheduleJob: (config) => { jobs.push(config); return { cancel() {} }; } });

    assert.equal(jobs.find((config) => config.rule === "5 0 27 8 *"), undefined, "không được còn job 00:05 ngày 27/08");
    // Các job còn lại vẫn phải đăng ký.
    for (const rule of ["* * * * *", "*/15 * * * *"]) {
        assert.ok(jobs.some((config) => config.rule === rule), `thiếu job ${rule}`);
    }
    // Không job nào được chạy lúc 00:05 ngày 27/08.
    assert.equal(jobs.filter((config) => /27/.test(config.rule)).length, 0);
});

test("main.js không hydrate birthdayData nữa", () => {
    const source = readSource("main.js");
    const storeIds = [...(source.match(/storeIds:\s*\[([\s\S]*?)\]/)?.[1] || "").matchAll(/"([^"]+)"/g)].map((item) => item[1]);
    assert.ok(!storeIds.includes("birthdayData"), "không được hydrate birthdayData");
    assert.ok(storeIds.includes("subscriptions"), "vẫn phải hydrate các store đang dùng");
});

test("không còn lời mời sinh nhật nào được đăng ký hay gọi", () => {
    const source = readSource("main.js");
    for (const pattern of [/sendBirthdayInvitations/, /publishBirthdayResults/, /formatBirthday/, /getBroadcastTargets\("birthday"\)/]) {
        assert.ok(!pattern.test(source), `main.js vẫn còn ${pattern}`);
    }
    // Hàm broadcast chung vẫn còn để /thongbao và /update hoạt động.
    assert.ok(/function getBroadcastTargets/.test(source));
});

test("lệnh sinh nhật cũ trả về lỗi không nhận diện thay vì chạy", async () => {
    const ZaloBot = require("node-zalo-bot");
    const sent = [];
    ZaloBot.prototype.sendMessage = function (chatId, text) {
        sent.push({ chatId: String(chatId), text: String(text) });
        return Promise.resolve();
    };
    const main = require("../main.js");

    for (const name of REMOVED_NAMES) {
        sent.length = 0;
        const parsed = main.parseCommand(`/${name} thử`);
        assert.ok(parsed, `/${name} phải vẫn phân tích được cú pháp`);
        await main.handleCommand(
            { text: `/${name} thử`, chat: { id: "probe-chat", type: "private" }, from: { id: "probe-user", display_name: "Probe" } },
            parsed
        );
        assert.equal(sent.length, 1, `/${name} phải trả về đúng một tin`);
        assert.match(sent[0].text, /LỆNH KHÔNG HỢP LỆ/, `/${name} không được còn được xử lý`);
    }
});
