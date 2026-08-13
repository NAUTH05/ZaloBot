const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { escapeMarkdown } = require("../richText");

test("sendWelcomeMessage định dạng tin nhắn chào mừng chuẩn", async () => {
    const mainPath = path.join(__dirname, "../main.js");
    const code = fs.readFileSync(mainPath, "utf8");

    assert.ok(code.includes("sendWelcomeMessage"), "Hàm sendWelcomeMessage đã được định nghĩa trong main.js");
    assert.ok(code.includes("interaction.isFirstInteraction"), "Logic tự động chào mừng lần đầu đã được thêm vào bot.on('message')");

    const match = code.match(/async function sendWelcomeMessage\([\s\S]*?\n\}/);
    assert.ok(match, "Tìm thấy khai báo hàm sendWelcomeMessage");

    const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
    const fn = new AsyncFunction("chatId", "displayName", "escapeMarkdown", "sendMessage", `
        ${match[0]}
        return sendWelcomeMessage(chatId, displayName);
    `);

    let sentMsg = null;
    await fn("chat-123", "Minh Anh", escapeMarkdown, (id, msg) => {
        sentMsg = msg;
        return Promise.resolve();
    });

    assert.ok(sentMsg, "Tin nhắn chào đã được tạo thành công");
    assert.match(sentMsg, /Xin chào \*\*Minh Anh\*\*/);
    assert.match(sentMsg, /LỊCH HỌC LHU/);
    assert.match(sentMsg, /\/find/);

    assert.ok(
        code.includes("if (interaction.isFirstInteraction && !parsed)"),
        "Chỉ gửi lời chào tự động khi tin nhắn lần đầu là tin nhắn thường (không phải lệnh)"
    );
});
