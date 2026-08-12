const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("lệnh /help phản hồi động tùy theo quyền owner", async (t) => {
    const mainPath = path.join(__dirname, "../main.js");
    const code = fs.readFileSync(mainPath, "utf8");

    const helpMatch = code.match(/else if \s*\(command === "help"\)\s*\{([\s\S]*?)\n\s*\} else if/);
    assert.ok(helpMatch, "Tìm thấy khai báo xử lý lệnh help trong handleCommand");

    const originalOwner = process.env.OWNER_USER_ID;
    const originalOwnerChat = process.env.OWNER_CHAT_ID;
    process.env.OWNER_USER_ID = "owner123";
    process.env.OWNER_CHAT_ID = "private_owner_chat";

    t.after(() => {
        if (originalOwner === undefined) {
            delete process.env.OWNER_USER_ID;
        } else {
            process.env.OWNER_USER_ID = originalOwner;
        }
        if (originalOwnerChat === undefined) {
            delete process.env.OWNER_CHAT_ID;
        } else {
            process.env.OWNER_CHAT_ID = originalOwnerChat;
        }
    });

    const handlerBody = helpMatch[1];
    const { isOwner } = require("../main.js");

    const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
    const fn = new AsyncFunction("chatId", "sendMessage", "context", "isOwner", handlerBody);

    // Người dùng thường (không phải owner)
    let normalMessage = null;
    await fn("group_chat_1", (chatId, messageText) => { normalMessage = messageText; return Promise.resolve(); }, { userId: "user456", chatId: "group_chat_1" }, isOwner);
    assert.ok(normalMessage, "Tin nhắn /help cho người dùng thường đã được tạo");
    assert.match(normalMessage, /HƯỚNG DẪN ZALOBOT/);
    assert.doesNotMatch(normalMessage, /\[CHỦ BOT\]/);

    // Chủ BOT dùng /help trong nhóm chat thường (chatId khác OWNER_CHAT_ID) -> không hiện [CHỦ BOT]
    let groupOwnerMessage = null;
    await fn("group_chat_1", (chatId, messageText) => { groupOwnerMessage = messageText; return Promise.resolve(); }, { userId: "owner123", chatId: "group_chat_1" }, isOwner);
    assert.ok(groupOwnerMessage, "Tin nhắn /help cho owner trong nhóm đã được tạo");
    assert.match(groupOwnerMessage, /HƯỚNG DẪN ZALOBOT/);
    assert.doesNotMatch(groupOwnerMessage, /\[CHỦ BOT\]/);

    // Chủ BOT dùng /help trong đúng chat riêng của owner (chatId khớp OWNER_CHAT_ID)
    let ownerMessage = null;
    await fn("private_owner_chat", (chatId, messageText) => { ownerMessage = messageText; return Promise.resolve(); }, { userId: "owner123", chatId: "private_owner_chat" }, isOwner);
    assert.ok(ownerMessage, "Tin nhắn /help cho chủ BOT trong chat riêng đã được tạo");
    assert.match(ownerMessage, /HƯỚNG DẪN ZALOBOT/);
    assert.match(ownerMessage, /\[CHỦ BOT\]/);
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
