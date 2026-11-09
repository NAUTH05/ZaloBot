// ============================================================================
// Test cho gửi TỆP ĐÍNH KÈM trong Chat Center.
//
// Trọng tâm:
//   - mediaStorage chỉ nhận định dạng trong danh sách trắng (chặn .exe/.html…).
//   - ZCA nhận Buffer; bot chính thức nhận URL.
//   - Bot chính thức KHÔNG gửi được tệp thì phải chuyển sang gửi liên kết và
//     báo rõ deliveryMode="link" — không được giả vờ đã gửi tệp.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

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
const {
    deleteMedia,
    getMediaInfo,
    storeChatFile,
    storeMedia,
    validateChatFile,
    MEDIA_TYPES
} = require("../mediaStorage");
const { sendChatFileToChat } = require("../main");

function pdfBytes() {
    return Buffer.from("%PDF-1.4\n% test\n", "utf8");
}

test.beforeEach(() => clearBots());
test.afterEach(() => clearBots());

test("validateChatFile từ chối định dạng không nằm trong danh sách trắng", () => {
    for (const name of ["virus.exe", "page.html", "script.js", "image.svg", "setup.msi"]) {
        const result = validateChatFile({ buffer: Buffer.from("x"), originalName: name });
        assert.equal(result.valid, false, `${name} phải bị từ chối`);
    }
});

test("validateChatFile chấp nhận tài liệu thường gặp", () => {
    for (const name of ["bao-cao.pdf", "danh-sach.xlsx", "ghi-chu.docx", "data.zip"]) {
        const result = validateChatFile({ buffer: Buffer.from("x"), originalName: name });
        assert.equal(result.valid, true, `${name} phải được chấp nhận`);
    }
});

test("validateChatFile từ chối tệp không có phần mở rộng", () => {
    const result = validateChatFile({ buffer: Buffer.from("x"), originalName: "khongco" });
    assert.equal(result.valid, false);
});

test("storeChatFile lưu tệp và getMediaInfo đọc lại được", async () => {
    const stored = await storeChatFile({
        buffer: pdfBytes(),
        originalName: "bao-cao.pdf",
        declaredMime: "application/pdf"
    });

    try {
        assert.equal(stored.mediaType, MEDIA_TYPES.CHAT_FILE);
        assert.equal(stored.mimeType, "application/pdf");
        assert.ok(stored.url.startsWith("/api/media/"));
        assert.ok(!stored.filePath, "không được trả đường dẫn nội bộ");

        const info = await getMediaInfo(stored.mediaId);
        assert.ok(info, "phải tìm lại được tệp");
        assert.equal(info.mediaType, MEDIA_TYPES.CHAT_FILE);
        assert.equal(info.mimeType, "application/pdf");
    } finally {
        await deleteMedia(stored.mediaId);
    }
});

test("storeChatFile từ chối tệp quá lớn", async () => {
    const big = Buffer.alloc(21 * 1024 * 1024, 0x41);
    await assert.rejects(
        storeChatFile({ buffer: big, originalName: "to.pdf" }),
        /quá lớn/i
    );
});

test("ZCA nhận Buffer khi gửi tệp", async () => {
    const received = [];
    registerBot({
        botId: "zca:777000777",
        providerType: "zca",
        isPersonalAccount: true,
        supportsMarkdown: false,
        async sendMessage() { throw new Error("không dùng đường text"); },
        async sendFile(chatId, payload) { received.push({ chatId, payload }); return { message: { msgId: 1 } }; }
    });

    const stored = await storeChatFile({ buffer: pdfBytes(), originalName: "zca.pdf" });
    try {
        const result = await sendChatFileToChat({
            botId: "zca:777000777",
            chatId: "chat-1",
            fileMediaId: stored.mediaId
        });

        assert.equal(result.sent, true, JSON.stringify(result));
        assert.equal(result.deliveryMode, "file");
        assert.equal(received.length, 1);
        assert.ok(Buffer.isBuffer(received[0].payload), "ZCA phải nhận Buffer, không phải URL localhost");
    } finally {
        await deleteMedia(stored.mediaId);
    }
});

// Bài này phải đứng TRƯỚC các bài truyền publicBaseUrl: origin công khai được
// ghi nhớ trong module.
test("bot chính thức thiếu địa chỉ công khai thì KHÔNG gửi liên kết chết", async () => {
    const texts = [];
    registerBot({
        botId: "bot1",
        providerType: "official",
        supportsMarkdown: true,
        async sendMessage(chatId, text) { texts.push(text); return { message_id: "m1" }; },
        async sendFile() { return { message_id: "f1" }; }
    });

    // Ép origin về localhost để không phụ thuộc thứ tự chạy giữa các file test.
    const oldBase = process.env.ADMIN_BASE_URL;
    process.env.ADMIN_BASE_URL = "http://localhost:9999";

    const stored = await storeChatFile({ buffer: pdfBytes(), originalName: "no-base.pdf" });
    try {
        const result = await sendChatFileToChat({ botId: "bot1", chatId: "chat-1", fileMediaId: stored.mediaId });

        assert.equal(result.sent, false, "không được coi là gửi thành công");
        assert.match(String(result.error), /địa chỉ công khai|ADMIN_BASE_URL/i);
        assert.equal(texts.length, 0, "không được gửi liên kết localhost cho người dùng");
    } finally {
        await deleteMedia(stored.mediaId);
        if (oldBase === undefined) delete process.env.ADMIN_BASE_URL;
        else process.env.ADMIN_BASE_URL = oldBase;
    }
});

test("bot chính thức gửi được tệp thì dùng URL công khai", async () => {
    const received = [];
    registerBot({
        botId: "bot1",
        providerType: "official",
        supportsMarkdown: true,
        async sendMessage() { throw new Error("không dùng đường text"); },
        async sendFile(chatId, payload) { received.push({ chatId, payload }); return { message_id: "f1" }; }
    });

    const stored = await storeChatFile({ buffer: pdfBytes(), originalName: "official.pdf" });
    try {
        const result = await sendChatFileToChat({
            botId: "bot1",
            chatId: "chat-1",
            fileMediaId: stored.mediaId,
            publicBaseUrl: "https://bot.example.com"
        });

        assert.equal(result.sent, true);
        assert.equal(result.deliveryMode, "file");
        assert.equal(typeof received[0].payload, "string");
        assert.match(received[0].payload, /^https:\/\/bot\.example\.com\/api\/media\//);
    } finally {
        await deleteMedia(stored.mediaId);
    }
});

test("bot chính thức không gửi được tệp thì chuyển sang gửi liên kết", async () => {
    const texts = [];
    registerBot({
        botId: "bot1",
        providerType: "official",
        supportsMarkdown: true,
        async sendMessage(chatId, text) { texts.push({ chatId, text }); return { message_id: "m1" }; },
        async sendFile() { throw new Error("404 Not Found: method sendFile"); }
    });

    const stored = await storeChatFile({ buffer: pdfBytes(), originalName: "fallback.pdf" });
    try {
        const result = await sendChatFileToChat({
            botId: "bot1",
            chatId: "chat-1",
            fileMediaId: stored.mediaId,
            publicBaseUrl: "https://bot.example.com"
        });

        assert.equal(result.sent, true, "vẫn phải gửi được, chỉ là dạng liên kết");
        assert.equal(result.deliveryMode, "link", "phải báo rõ không phải bong bóng tệp");
        assert.equal(texts.length, 1);
        assert.match(texts[0].text, /fallback\.pdf/);
        assert.match(texts[0].text, /\/api\/media\//);
    } finally {
        await deleteMedia(stored.mediaId);
    }
});

test("không gửi tệp khi media là ảnh", async () => {
    registerBot({
        botId: "bot1",
        providerType: "official",
        supportsMarkdown: true,
        async sendMessage() { return { message_id: "m1" }; },
        async sendFile() { return { message_id: "f1" }; }
    });

    const image = await storeMedia({
        buffer: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0xFF, 0xD9]),
        originalName: "anh.jpg",
        mediaType: MEDIA_TYPES.CHAT_IMAGE
    });

    try {
        await assert.rejects(
            sendChatFileToChat({ botId: "bot1", chatId: "chat-1", fileMediaId: image.mediaId }),
            /không phải tệp đính kèm/
        );
    } finally {
        await deleteMedia(image.mediaId);
    }
});

test("thiếu fileMediaId thì từ chối", async () => {
    registerBot({
        botId: "bot1",
        providerType: "official",
        supportsMarkdown: true,
        async sendMessage() { return {}; },
        async sendFile() { return {}; }
    });

    await assert.rejects(
        sendChatFileToChat({ botId: "bot1", chatId: "chat-1" }),
        /fileMediaId là bắt buộc/
    );
});
