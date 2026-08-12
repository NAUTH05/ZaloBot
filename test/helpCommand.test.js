const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("lệnh /help tạo tin nhắn hướng dẫn thành công và không bị lỗi ReferenceError", async () => {
    const mainPath = path.join(__dirname, "../main.js");
    const code = fs.readFileSync(mainPath, "utf8");

    const helpMatch = code.match(/else if \s*\(command === "help"\)\s*\{([\s\S]*?)\n\s*\} else if/);
    assert.ok(helpMatch, "Tìm thấy khai báo xử lý lệnh help trong handleCommand");

    const handlerBody = helpMatch[1];
    let sentMessage = null;
    const fakeSendMessage = (chatId, messageText) => {
        sentMessage = messageText;
        return Promise.resolve();
    };

    const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
    const fn = new AsyncFunction("chatId", "sendMessage", handlerBody);
    await fn(123456, fakeSendMessage);

    assert.ok(sentMessage, "Tin nhắn /help đã được tạo");
    assert.match(sentMessage, /HƯỚNG DẪN ZALOBOT/);
    assert.match(sentMessage, /Có thể bỏ `\[MSSV\]` với \*\*\/lich\*\*/);
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
});
