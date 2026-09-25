// ============================================================================
// Chạy song song: bot chính thức và tài khoản ZCA trong CÙNG một tiến trình.
//
// Đây là bài kiểm tra quan trọng nhất của việc tích hợp: nó chứng minh rằng
//   - phản hồi đi ra bằng ĐÚNG nhà cung cấp đã nhận tin nhắn;
//   - dữ liệu của hai nhà cung cấp không trộn vào nhau dù trùng User ID/Chat ID;
//   - một nhà cung cấp hỏng không kéo theo nhà cung cấp kia.
// ============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.BOT_TOKEN = "parallel-token-1";
process.env.BOT_2_TOKEN = "parallel-token-2";

const { createOfficialProvider } = require("../providers/officialProvider");
const { createZcaProvider } = require("../providers/zca/zcaProvider");
const { registerBots, clearBots, listBots, bindBot, runWithBot, getCurrentBot, getCurrentBotId } = require("../botContext");

const ROOT = path.join(__dirname, "..");
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

const main = require("../main");

// Sổ chat phải có bản ghi "đang hoạt động" thì mới gửi được: isChatEligible() từ
// chối chat chưa từng tương tác. Đây đúng là trạng thái sau lần nhắn đầu tiên.
function seedChats(zcaBotId) {
    const chatDirectory = fileKey(path.join(ROOT, "chatDirectory.json"));
    memoryFiles.set(chatDirectory, {
        schemaVersion: 3,
        chats: {
            // Cùng Chat ID ở cả hai nhà cung cấp — tình huống dễ hỏng nhất.
            "chat-shared": { chatId: "chat-shared", botId: "bot1", chatType: "private", displayName: "Chat chung (bot1)", userId: "user-shared", status: "active" },
            [`${zcaBotId}::chat-shared`]: { chatId: "chat-shared", botId: zcaBotId, chatType: "private", displayName: "Chat chung (ZCA)", userId: "user-shared", status: "active" },
            [`${zcaBotId}::group-shared`]: { chatId: "group-shared", botId: zcaBotId, chatType: "group", displayName: "Nhóm chung (ZCA)", status: "active" }
        },
        deletedChatIds: {}
    });
}

// Nhà cung cấp chính thức với client giả: ghi lại mọi lần gửi.
function officialWithRecorder(botId, token) {
    const provider = createOfficialProvider({ botId, token });
    provider.sent = [];
    provider.client = {
        on() { return this; },
        startPolling: async () => true,
        stopPolling: async () => true,
        sendMessage: async (chatId, text) => {
            provider.sent.push({ chatId: String(chatId), text });
            return { ok: true };
        },
        getMe: async () => ({ name: `Bot ${botId}` })
    };
    return provider;
}

// Nhà cung cấp ZCA với API giả: ghi lại mọi lần gửi.
function zcaWithRecorder(t, uid = "900900900") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zca-parallel-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const provider = createZcaProvider({ enabled: true, sessionDir: dir, displayName: "Tài khoản A" });
    provider.sent = [];
    provider.rememberThread("chat-shared", "private");
    provider.rememberThread("group-shared", "group");
    // Giả lập đã đăng nhập: gắn api giả và danh tính thật.
    provider.botId = `zca:${uid}`;
    provider.ownUid = uid;
    provider.authenticated = true;
    provider.status = "connected";
    provider.api = {
        sendMessage: async (text, threadId, threadType) => {
            provider.sent.push({ chatId: String(threadId), text, threadType });
            return { message: { msgId: 1 }, attachment: [] };
        },
        getOwnId: () => uid
    };
    return provider;
}

// Gọi handleIncomingMessage ĐÚNG như production: trong ngữ cảnh của nhà cung
// cấp đã nhận tin nhắn. Đây chính là cơ chế khiến phản hồi đi ra đúng transport.
function deliver(provider, message) {
    return runWithBot(provider, () => main.handleIncomingMessage(provider, message));
}

function internalMessage(overrides = {}) {
    return {
        text: "/help",
        chat: { id: "chat-shared", type: "private", title: "" },
        from: { id: "user-shared", display_name: "Người dùng" },
        ...overrides
    };
}

/* -------------------------------------------------------------------------- */

test("tin nhắn ZCA được trả lời qua CHÍNH ZCA, không qua bot chính thức", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const official = officialWithRecorder("bot1", "parallel-token-1");
    const zca = zcaWithRecorder(t);
    seedChats(zca.botId);
    registerBots([official, zca]);

    // Người dùng nhắn tới tài khoản ZCA.
    await deliver(zca, internalMessage({ text: "/myid" }));

    assert.equal(zca.sent.length > 0, true, "ZCA phải gửi phản hồi");
    assert.equal(official.sent.length, 0, "bot chính thức KHÔNG được gửi thay ZCA");
});

test("tin nhắn bot chính thức được trả lời qua CHÍNH bot đó, không qua ZCA", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const official = officialWithRecorder("bot1", "parallel-token-1");
    const zca = zcaWithRecorder(t);
    seedChats(zca.botId);
    registerBots([official, zca]);

    await deliver(official, internalMessage({ text: "/myid" }));

    assert.equal(official.sent.length > 0, true, "bot chính thức phải gửi phản hồi");
    assert.equal(zca.sent.length, 0, "ZCA KHÔNG được gửi thay bot chính thức");
});

test("hai bot chính thức không trả lời chéo nhau", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const bot1 = officialWithRecorder("bot1", "parallel-token-1");
    const bot2 = officialWithRecorder("bot2", "parallel-token-2");
    // Chat phải thuộc bot2 thì mới gửi được từ bot2.
    seedChats("bot2");
    registerBots([bot1, bot2]);

    await deliver(bot2, internalMessage({ text: "/myid" }));

    assert.equal(bot2.sent.length > 0, true, "bot2 phải trả lời");
    assert.equal(bot1.sent.length, 0, "bot1 không được trả lời thay bot2");
});

test("cùng Chat ID và User ID ở hai nhà cung cấp vẫn tách biệt", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const official = officialWithRecorder("bot1", "parallel-token-1");
    const zca = zcaWithRecorder(t);
    seedChats(zca.botId);
    registerBots([official, zca]);

    const message = internalMessage({ text: "/myid" });
    await deliver(official, message);
    await deliver(zca, message);

    // Cả hai đều trả lời, nhưng bằng danh tính của chính mình.
    assert.equal(official.sent.length > 0, true);
    assert.equal(zca.sent.length > 0, true);

    // Ngữ cảnh nhà cung cấp phải đúng trong từng lần chạy.
    const seenByOfficial = runWithBot(official, () => getCurrentBotId());
    const seenByZca = runWithBot(zca, () => getCurrentBotId());
    assert.equal(seenByOfficial, "bot1");
    assert.equal(seenByZca, `zca:${zca.ownUid}`);
    assert.notEqual(seenByOfficial, seenByZca);
});

test("tin nhắn trong nhóm gửi lại đúng loại luồng nhóm", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const zca = zcaWithRecorder(t);
    seedChats(zca.botId);
    registerBots([zca]);

    await deliver(zca, internalMessage({
        text: "/myid",
        chat: { id: "group-shared", type: "group", title: "" }
    }));

    assert.equal(zca.sent.length > 0, true, "phải gửi được vào nhóm");
    // ThreadType.Group = 1. Gửi sai loại luồng sẽ không tới được nhóm.
    assert.equal(zca.sent[0].threadType, 1, "phải gửi bằng ThreadType.Group");
    assert.equal(zca.sent[0].chatId, "group-shared");
});

test("ZCA ngắt kết nối không ảnh hưởng bot chính thức", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const official = officialWithRecorder("bot1", "parallel-token-1");
    const zca = zcaWithRecorder(t);
    seedChats(zca.botId);
    registerBots([official, zca]);

    // Giả lập listener ZCA chết.
    zca.api = null;
    zca.authenticated = false;
    zca.status = "disconnected";

    // Bot chính thức vẫn phải xử lý và trả lời bình thường.
    await deliver(official, internalMessage({ text: "/myid" }));
    assert.equal(official.sent.length > 0, true, "bot chính thức phải vẫn chạy");
    assert.equal(official.getStatus().enabled, true);

    // Và ZCA báo lỗi rõ ràng thay vì im lặng.
    await assert.rejects(() => zca.sendMessage("chat-shared", "xin chào"), /chưa đăng nhập/);
});

test("bot chính thức lỗi không ảnh hưởng ZCA", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const official = officialWithRecorder("bot1", "parallel-token-1");
    const zca = zcaWithRecorder(t);
    seedChats(zca.botId);
    registerBots([official, zca]);

    // Bot chính thức hỏng khi gửi.
    official.sendMessage = async () => { throw new Error("EZALO 422 You are not permitted to send messages to this chat_id"); };

    // Lỗi của nó phải nổi lên ở tầng gọi (để báo cho người vận hành)...
    await assert.rejects(() => runWithBot(official, () => main.sendMessage("chat-shared", "thử")));

    // ...nhưng ZCA vẫn gửi được bình thường.
    await deliver(zca, internalMessage({ text: "/myid" }));
    assert.equal(zca.sent.length > 0, true, "ZCA phải vẫn hoạt động");
});

test("lỗi 422 của Zalo Bot Platform không bị áp cho ZCA", () => {
    const official = createOfficialProvider({ botId: "bot1", token: "t" });
    const zca = createZcaProvider({ enabled: true, sessionDir: os.tmpdir() });

    // Lỗi đặc thù của nền tảng chính thức.
    const officialError = { response: { statusCode: 410 }, message: "410 The chat_id is invalid" };
    assert.equal(official.isPermanentChatError(officialError), true);
    // Nhà cung cấp ZCA không dùng chung cách nhận diện đó.
    assert.equal(typeof zca.isPermanentChatError, "undefined");
});

test("mọi nhà cung cấp đều đăng ký và khởi động độc lập", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const bot1 = officialWithRecorder("bot1", "parallel-token-1");
    const bot2 = officialWithRecorder("bot2", "parallel-token-2");
    const zca = zcaWithRecorder(t);
    registerBots([bot1, bot2, zca]);

    assert.equal(listBots().length, 3);
    assert.deepEqual(listBots().map((item) => item.providerType).sort(), ["official", "official", "zca"]);

    // Khởi động từng nhà cung cấp; lỗi một cái không chặn cái khác.
    const started = [];
    for (const provider of listBots()) {
        try {
            await provider.start();
            started.push(provider.botId);
        } catch (_) {
            // Cô lập: nhà cung cấp hỏng bị bỏ qua, không ném ra ngoài.
        }
    }
    assert.ok(started.includes("bot1"), "bot1 phải khởi động");
    assert.ok(started.includes("bot2"), "bot2 phải khởi động");
});
