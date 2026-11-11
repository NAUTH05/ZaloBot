// ============================================================================
// Test thứ tự nạp của admin-ui/app.js
//
// Lỗi thật đã xảy ra: dòng khôi phục tab đã lưu nằm GIỮA tệp, gọi switchTab()
// trước khi khối `let chatStream` (nằm cuối tệp) được khởi tạo. Kết quả:
//   ReferenceError: Cannot access 'chatStream' before initialization
// và vì đây là lỗi đồng bộ lúc nạp script nên TOÀN BỘ dashboard trắng.
//
// Không có công cụ nào bắt được lỗi này (node --check chỉ kiểm cú pháp), nên chốt
// bằng kiểm tra thứ tự ngay trong tệp nguồn.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const APP_PATH = path.join(__dirname, "..", "admin-ui", "app.js");
const source = fs.readFileSync(APP_PATH, "utf8");

test("khôi phục tab đã lưu phải nằm SAU khai báo trạng thái Chat Center", () => {
    const bootstrapIndex = source.indexOf('switchTab(localStorage.getItem("zalobot-admin-tab")');
    assert.notEqual(bootstrapIndex, -1, "phải có dòng khôi phục tab đã lưu");

    const chatStateIndex = source.indexOf("let chatStream");
    assert.notEqual(chatStateIndex, -1, "phải có khai báo let chatStream");

    assert.ok(
        bootstrapIndex > chatStateIndex,
        "switchTab() đọc biến `let` của Chat Center — gọi trước khi khai báo sẽ ném " +
        "ReferenceError và làm trắng dashboard"
    );
});

test("khôi phục tab đã lưu nằm ở cuối tệp, không phải giữa chừng", () => {
    const bootstrapIndex = source.indexOf('switchTab(localStorage.getItem("zalobot-admin-tab")');
    const tail = source.slice(bootstrapIndex);
    // Sau lời gọi này chỉ được còn khoảng trắng / chú thích ngắn.
    assert.ok(tail.length < 400, `còn ${tail.length} ký tự sau lời gọi khôi phục tab`);
});

test("switchTab bọc phần nạp dữ liệu trong try/catch", () => {
    const start = source.indexOf("function switchTab(name)");
    assert.notEqual(start, -1);

    const end = source.indexOf("function applyTheme(", start);
    const body = source.slice(start, end);

    assert.match(body, /try\s*\{/, "phải có try/catch để một tab lỗi không kéo sập cả trang");
    assert.match(body, /catch\s*\(/, "phải bắt lỗi thay vì để nó nổi lên lúc nạp script");
});

test("mọi loader trong switchTab đều đi qua hàm bọc an toàn", () => {
    const start = source.indexOf("function switchTab(name)");
    const end = source.indexOf("function applyTheme(", start);
    const body = source.slice(start, end);

    // Gọi trực tiếp (không qua run(...)) sẽ ném lỗi đồng bộ ra ngoài.
    assert.equal(
        /if \(name === "chatcenter"\)\s*\{\s*loadChatConversations\(\)/.test(body),
        false,
        "loadChatConversations/connectChatStream phải được gọi qua run()"
    );
});
