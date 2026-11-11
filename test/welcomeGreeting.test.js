const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { formatWelcomeMessage } = require("../messageTemplates");

test("sendWelcomeMessage định dạng tin nhắn chào mừng chuẩn", async () => {
    const mainPath = path.join(__dirname, "../main.js");
    const code = fs.readFileSync(mainPath, "utf8");

    assert.ok(code.includes("sendWelcomeMessage"), "Hàm sendWelcomeMessage đã được định nghĩa trong main.js");
    // Lời chào tự động nay nằm sau CỔNG TIẾP NHẬN: chat chưa từng được tiếp nhận
    // (chưa có câu trả lời nào gửi thành công) thì lời chào chính là bằng chứng
    // tiếp nhận đầu tiên. Điều kiện "chưa tiếp nhận" thay cho "isFirstInteraction".
    assert.ok(
        code.includes("!parsed && !looksLikeCommand && !alreadyAdmitted"),
        "Chỉ gửi lời chào tự động khi tin nhắn lần đầu là tin nhắn thường (không phải lệnh) và chat chưa được tiếp nhận"
    );

    const sentMsg = formatWelcomeMessage("Minh Anh");

    assert.ok(sentMsg, "Tin nhắn chào đã được tạo thành công");
    assert.match(sentMsg, /Xin chào \*\*Minh Anh\*\*/);
    assert.match(sentMsg, /LỊCH HỌC LHU/);
    assert.match(sentMsg, /\/luumssv/);
    assert.doesNotMatch(sentMsg, /Bot sẽ|bạn ơi/i);
});
