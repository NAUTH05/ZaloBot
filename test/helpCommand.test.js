const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("lệnh /help tạo tin nhắn hướng dẫn thành công và không bị lỗi ReferenceError", async () => {
    const mainPath = path.join(__dirname, "../main.js");
    const code = fs.readFileSync(mainPath, "utf8");

    const helpHandlerMatch = code.match(/bot\.onText\([^,]+\/help[^,]+,\s*(?:asyncCommand\()?async\s*\((?:msg|\w+)\)\s*=>\s*\{([\s\S]*?)\n\}\)?\);/);
    assert.ok(helpHandlerMatch, "Tìm thấy khai báo bot.onText cho /help");

    const handlerBody = helpHandlerMatch[1];
    let sentMessage = null;
    const fakeSendMessage = (chatId, messageText) => {
        sentMessage = messageText;
        return Promise.resolve();
    };

    const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
    const fn = new AsyncFunction("msg", "sendMessage", handlerBody);
    await fn({ chat: { id: 123456 } }, fakeSendMessage);

    assert.ok(sentMessage, "Tin nhắn /help đã được tạo");
    assert.match(sentMessage, /HƯỚNG DẪN ZALOBOT/);
    assert.match(sentMessage, /Có thể bỏ `\[MSSV\]` với \*\*\/lich\*\*/);
});
