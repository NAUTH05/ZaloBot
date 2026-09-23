const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { RESERVED_STORE_IDS, listImportableStoreFiles } = require("../firestorePersistence");
const { FEATURES } = require("../chatDirectory");
const { HELP_GROUPS, HELP_COMMANDS } = require("../helpContent");

// Những tệp nguồn phải sạch hoàn toàn khỏi phòng 411.
const SOURCE_FILES = [
    "main.js",
    "helpContent.js",
    "messageTemplates.js",
    "commandRegistry.js",
    "chatDirectory.js",
    "adminServer.js",
    "adminDataService.js",
    "firestorePersistence.js",
    "subscriptions.js",
    "interactionRegistry.js",
    "accessControl.js",
    "admin-ui/app.js",
    "admin-ui/index.html",
    "admin-ui/styles.css",
    "admin-ui/admin-controls.css",
    "ecosystem.config.cjs",
    "package.json"
];

function readSource(file) {
    return fs.readFileSync(path.join(ROOT, file), "utf8");
}

// Bỏ chú thích trước khi quét: chú thích giải thích việc tách bot là hợp lệ,
// nhưng mã thực thi thì không được còn tham chiếu nào.
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

// Ngoại lệ duy nhất được phép: dòng khai báo store cấm nhập lại. Nó tồn tại
// chính là để bảo vệ dữ liệu lịch trực khỏi bị ghi đè.
const ALLOWED_DUTY_LINES = [/^const RESERVED_STORE_IDS = new Set\(\["dutyScheduleData"\]\);$/m];

function stripAllowedDeclarations(source) {
    return ALLOWED_DUTY_LINES.reduce((text, pattern) => text.replace(pattern, ""), source);
}

test("mã nguồn ZaloBot không còn tham chiếu tới phòng 411", () => {
    const violations = [];
    for (const file of SOURCE_FILES) {
        const code = stripAllowedDeclarations(stripComments(readSource(file)));
        for (const pattern of [/411/, /duty/i, /lichtruc/i]) {
            if (pattern.test(code)) violations.push(`${file}: ${pattern}`);
        }
    }
    assert.deepEqual(violations, []);
});

test("store cấm nhập lại vẫn được khai báo tường minh", () => {
    const source = readSource("firestorePersistence.js");
    assert.match(source, /^const RESERVED_STORE_IDS = new Set\(\["dutyScheduleData"\]\);$/m);
    assert.match(source, /RESERVED_STORE_IDS\.has\(item\.storeId\)/);
});

test("dutyScheduleStore và các bài kiểm tra lịch trực đã được chuyển đi", () => {
    for (const file of ["dutyScheduleStore.js", "test/dutyScheduleStore.test.js", "test/dutyCommands.test.js"]) {
        assert.equal(fs.existsSync(path.join(ROOT, file)), false, `${file} phải được chuyển sang bot Room 411`);
    }
});

test("trợ giúp không còn nhóm nội bộ phòng 411", () => {
    assert.deepEqual(Object.keys(HELP_GROUPS).sort(), ["ADMIN", "PUBLIC"]);
    assert.equal(HELP_GROUPS.INTERNAL411, undefined);
    for (const entry of HELP_COMMANDS) {
        assert.ok(["public", "admin"].includes(entry.group), `${entry.command}: nhóm trợ giúp không hợp lệ`);
        assert.ok(!/411|lichtruc|dangkylich/i.test(entry.command), `${entry.command} không được quay lại trợ giúp`);
    }
});

test("chatDirectory không còn cờ tính năng duty", () => {
    assert.deepEqual(FEATURES, ["schedule", "birthday", "broadcast"]);
});

test("main.js không hydrate dutyScheduleData và không còn job 06:00", () => {
    const source = readSource("main.js");
    const storeIds = [...(source.match(/storeIds:\s*\[([\s\S]*?)\]/)?.[1] || "").matchAll(/"([^"]+)"/g)].map((item) => item[1]);

    assert.ok(!storeIds.includes("dutyScheduleData"), "ZaloBot không được hydrate dutyScheduleData");
    assert.ok(!/rule:\s*"0 6 \* \* \*"/.test(source), "ZaloBot không được còn job 06:00 của lịch trực");
    assert.ok(!source.includes("dutyScheduleStore"), "ZaloBot không được import dutyScheduleStore");
});

test("adminServer không còn endpoint lịch trực", () => {
    const source = readSource("adminServer.js");
    for (const endpoint of ["/duty/schedules", "/duty/subscriptions"]) {
        assert.ok(!source.includes(endpoint), `endpoint ${endpoint} phải được xóa`);
    }
    assert.ok(!/duty/i.test(source));
});

test("migrate JSON không bao giờ nhập lại dutyScheduleData", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-import-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    for (const name of ["subscriptions.json", "dutyScheduleData.json", "chatDirectory.json", "scheduleSnapshots.json"]) {
        fs.writeFileSync(path.join(directory, name), JSON.stringify({ probe: name }), "utf8");
    }

    const files = listImportableStoreFiles(directory);
    const storeIds = files.map((item) => item.storeId);

    assert.ok(!storeIds.includes("dutyScheduleData"), "dutyScheduleData phải bị loại khỏi mọi lần nhập JSON");
    assert.deepEqual(storeIds, ["chatDirectory", "scheduleSnapshots", "subscriptions"]);
    assert.ok(RESERVED_STORE_IDS.has("dutyScheduleData"));
});

test("thư mục recent_json có dutyScheduleData nhưng vẫn bị lọc", () => {
    const recentJson = path.join(ROOT, "recent_json");
    if (!fs.existsSync(recentJson)) return;

    const storeIds = listImportableStoreFiles(recentJson).map((item) => item.storeId);
    assert.ok(!storeIds.includes("dutyScheduleData"), "npm run migrate:firestore không được ghi đè dữ liệu lịch trực");
});
