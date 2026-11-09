// ============================================================================
// Test cho sendChatMessageToChat — đường gửi tin của Chat Center.
//
// Vì sao cần: đã có lỗi thật trên production — POST /api/admin/chat/send trả 400
// với "ensureConversation is not defined". Hàm này từng nằm inline trong
// startRuntime() nên không bài kiểm tra nào chạm tới, và `node --check` chỉ kiểm
// cú pháp nên không bắt được tên hàm không tồn tại.
//
// Nay logic được tách ra cấp module và test gọi trực tiếp với provider giả.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Cách ly khỏi file JSON thật ở gốc dự án (xem adminServer.test.js).
const persistencePath = require.resolve("../firestorePersistence");
const realPersistence = require(persistencePath);
const memoryFiles = new Map();
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const fileKey = (filePath, defaultPath) => path.resolve(filePath || defaultPath);

require.cache[persistencePath] = {
    id: persistencePath,
    filename: persistencePath,
    loaded: true,
    exports: {
        ...realPersistence,
        readJsonStore: (filePath, defaultPath, fallback) => {
            const key = fileKey(filePath, defaultPath);
            if (!memoryFiles.has(key)) memoryFiles.set(key, clone(fallback) ?? null);
            return clone(memoryFiles.get(key));
        },
        writeJsonStore: (filePath, defaultPath, value) => {
            memoryFiles.set(fileKey(filePath, defaultPath), clone(value));
        }
    }
};

const { clearBots, registerBot } = require("../botContext");
const { deleteMedia, storeMedia, MEDIA_TYPES } = require("../mediaStorage");
const { sendChatMessageToChat } = require("../main");

// 1x1 JPEG tối thiểu — đủ để storeMedia nhận qua magic bytes.
function minimalJpeg() {
    return Buffer.from([
        0xFF, 0xD8, 0xFF, 0xE0,
        0x00, 0x10,
        0x4A, 0x46, 0x49, 0x46, 0x00,
        0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
        0xFF, 0xD9
    ]);
}

// Provider giả ghi lại mọi lần gọi để khẳng định đúng nội dung và đúng tham số.
function makeFakeBot(botId, overrides = {}) {
    const calls = { messages: [], photos: [] };
    const bot = {
        botId,
        providerType: "official",
        supportsMarkdown: true,
        status: "running",
        async sendMessage(chatId, text, options) {
            calls.messages.push({ chatId, text, options });
            return { message_id: `msg-${calls.messages.length}` };
        },
        async sendPhoto(chatId, payload, options) {
            calls.photos.push({ chatId, payload, options });
            return { message_id: `photo-${calls.photos.length}` };
        },
        ...overrides
    };
    return { bot, calls };
}

test.beforeEach(() => clearBots());
test.afterEach(() => clearBots());

test("gửi TEXT qua đúng bot đích và trả sent=true", async () => {
    const { bot, calls } = makeFakeBot("bot1");
    registerBot(bot);

    const result = await sendChatMessageToChat({ botId: "bot1", chatId: "chat-1", text: "Xin chào" });

    assert.equal(result.sent, true, `mong sent=true, nhận: ${JSON.stringify(result)}`);
    assert.equal(calls.messages.length, 1);
    assert.equal(calls.messages[0].chatId, "chat-1");
    assert.equal(calls.messages[0].text, "Xin chào");
});

test("historySource KHÔNG bị truyền xuống provider", async () => {
    const { bot, calls } = makeFakeBot("bot1");
    registerBot(bot);

    await sendChatMessageToChat({ botId: "bot1", chatId: "chat-1", text: "kiểm tra tham số" });

    // Nếu rò rỉ, provider sẽ nhận một tham số gửi tin không tồn tại.
    assert.ok(calls.messages.length >= 1);
    for (const call of calls.messages) {
        assert.equal(
            Object.prototype.hasOwnProperty.call(call.options || {}, "historySource"),
            false,
            "historySource là nhãn lịch sử nội bộ, không được lọt xuống provider"
        );
    }
});

test("gửi tới chat ở bot khác dùng ĐÚNG provider của bot đó", async () => {
    const first = makeFakeBot("bot1");
    const second = makeFakeBot("bot2");
    registerBot(first.bot);
    registerBot(second.bot);

    await sendChatMessageToChat({ botId: "bot2", chatId: "chat-9", text: "cho bot 2" });

    assert.equal(first.calls.messages.length, 0, "bot1 không được nhận tin của bot2");
    assert.equal(second.calls.messages.length, 1);
    assert.equal(second.calls.messages[0].chatId, "chat-9");
});

test("thiếu botId thì từ chối, không đoán bot 1", async () => {
    const { bot } = makeFakeBot("bot1");
    registerBot(bot);

    await assert.rejects(
        sendChatMessageToChat({ chatId: "chat-1", text: "hi" }),
        /botId là bắt buộc/
    );
});

test("thiếu chatId thì từ chối", async () => {
    const { bot } = makeFakeBot("bot1");
    registerBot(bot);

    await assert.rejects(
        sendChatMessageToChat({ botId: "bot1", text: "hi" }),
        /chatId là bắt buộc/
    );
});

test("bot chưa chạy thì báo rõ, không gửi bằng bot khác", async () => {
    const { bot, calls } = makeFakeBot("bot1");
    registerBot(bot);

    await assert.rejects(
        sendChatMessageToChat({ botId: "bot3", chatId: "chat-1", text: "hi" }),
        /không đang chạy/
    );
    assert.equal(calls.messages.length, 0);
});

test("gửi ẢNH qua bot chính thức dùng URL công khai", async () => {
    const { bot, calls } = makeFakeBot("bot1");
    registerBot(bot);

    const media = await storeMedia({
        buffer: minimalJpeg(),
        originalName: "chat.jpg",
        mediaType: MEDIA_TYPES.CHAT_IMAGE
    });

    try {
        const result = await sendChatMessageToChat({ botId: "bot1", chatId: "chat-1", mediaId: media.mediaId });

        assert.equal(result.sent, true, `mong sent=true, nhận: ${JSON.stringify(result)}`);
        assert.equal(calls.photos.length, 1);
        assert.equal(typeof calls.photos[0].payload, "string", "official provider nhận URL, không nhận Buffer");
        assert.match(calls.photos[0].payload, /\/api\/media\//);
        assert.equal(calls.messages.length, 0, "không gửi kèm tin text khi chỉ có ảnh");
    } finally {
        await deleteMedia(media.mediaId);
    }
});

test("gửi ẢNH qua ZCA dùng Buffer vì Zalo không tải được localhost", async () => {
    const { bot, calls } = makeFakeBot("zca:777000777", {
        providerType: "zca",
        isPersonalAccount: true,
        supportsMarkdown: false
    });
    registerBot(bot);

    const media = await storeMedia({
        buffer: minimalJpeg(),
        originalName: "chat-zca.jpg",
        mediaType: MEDIA_TYPES.CHAT_IMAGE
    });

    try {
        const result = await sendChatMessageToChat({
            botId: "zca:777000777",
            chatId: "chat-1",
            mediaId: media.mediaId
        });

        assert.equal(result.sent, true, `mong sent=true, nhận: ${JSON.stringify(result)}`);
        assert.equal(calls.photos.length, 1);
        assert.ok(Buffer.isBuffer(calls.photos[0].payload), "ZCA phải nhận Buffer, không phải URL localhost");
        assert.equal(calls.photos[0].payload.length, minimalJpeg().length);
    } finally {
        await deleteMedia(media.mediaId);
    }
});

test("media không tồn tại thì báo lỗi rõ ràng", async () => {
    const { bot, calls } = makeFakeBot("bot1");
    registerBot(bot);

    await assert.rejects(
        sendChatMessageToChat({ botId: "bot1", chatId: "chat-1", mediaId: "0".repeat(32) }),
        /Không tìm thấy media/
    );
    assert.equal(calls.photos.length, 0);
});

test("provider gửi lỗi thì trả sent=false kèm error, không ném ra ngoài", async () => {
    const { bot } = makeFakeBot("bot1", {
        async sendMessage() { throw new Error("mạng hỏng"); }
    });
    registerBot(bot);

    const result = await sendChatMessageToChat({ botId: "bot1", chatId: "chat-1", text: "hi" });

    assert.equal(result.sent, false);
    assert.match(String(result.error), /mạng hỏng/);
});

test("không có text và không có media thì không gửi gì", async () => {
    const { bot, calls } = makeFakeBot("bot1");
    registerBot(bot);

    const result = await sendChatMessageToChat({ botId: "bot1", chatId: "chat-1" });

    assert.equal(result.sent, false);
    assert.equal(calls.messages.length, 0);
    assert.equal(calls.photos.length, 0);
});
