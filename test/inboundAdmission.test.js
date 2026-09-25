// ============================================================================
// Cổng tiếp nhận liên hệ — kiểm tra ở tầng handleIncomingMessage thật.
//
// Chứng minh yêu cầu cốt lõi: một chat mà bot KHÔNG THỂ trả lời không được để lại
// bất kỳ dấu vết bền vững nào, và chỉ chat đã xác nhận trả lời mới được tiếp nhận.
//
// Dùng cùng cách cô lập như providerParallelOperation.test.js: thay
// readJsonStore/writeJsonStore bằng Map trong bộ nhớ trước khi nạp main.js.
// ============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.BOT_TOKEN = "admission-token-1";
process.env.BOT_2_TOKEN = "admission-token-2";

const { createOfficialProvider } = require("../providers/officialProvider");
const { clearBots, registerBots, runWithBot } = require("../botContext");
const { registry: admissionRegistry } = require("../contactAdmission");

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

const INTERACTIONS_FILE = fileKey(path.join(ROOT, "interactions.json"));
const CHAT_DIRECTORY_FILE = fileKey(path.join(ROOT, "chatDirectory.json"));
const SUBSCRIPTIONS_FILE = fileKey(path.join(ROOT, "subscriptions.json"));

function resetStores() {
    memoryFiles.clear();
    // Cổng tiếp nhận là singleton cấp module: phải xoá giữa các bài để trạng thái
    // "đã tiếp nhận" của bài trước không rò sang bài sau.
    admissionRegistry.clear();
    main.getAdmissionStats();
}

// Nhà cung cấp chính thức với client giả. `sendMessage` có thể được thay để giả
// lập lỗi 410/422.
function officialWithRecorder(botId, token, sendImpl) {
    const provider = createOfficialProvider({ botId, token });
    provider.sent = [];
    provider.client = {
        on() { return this; },
        startPolling: async () => true,
        stopPolling: async () => true,
        sendMessage: sendImpl || (async (chatId, text) => {
            provider.sent.push({ chatId: String(chatId), text });
            return { ok: true };
        }),
        getMe: async () => ({ name: `Bot ${botId}` })
    };
    return provider;
}

function deliver(provider, message) {
    return runWithBot(provider, () => main.handleIncomingMessage(provider, message));
}

function message(overrides = {}) {
    return {
        text: "xin chào",
        chat: { id: "stranger", type: "private", title: "" },
        from: { id: "user-stranger", display_name: "Người lạ" },
        ...overrides
    };
}

function readStore(key, fallback) {
    return memoryFiles.has(key) ? memoryFiles.get(key) : fallback;
}

/* -------------------------------------------------------------------------- */

test("người lạ bị 422 từ chối thì KHÔNG để lại bản ghi tương tác hay sổ chat", async (t) => {
    resetStores();
    clearBots();
    t.after(() => clearBots());

    // Mọi lần gửi đều bị từ chối dứt khoát.
    const bot1 = officialWithRecorder("bot1", "admission-token-1", async () => {
        throw Object.assign(new Error("422 You are not permitted to send messages to this chat_id"), { statusCode: 422 });
    });
    registerBots([bot1]);

    await deliver(bot1, message({ text: "/help" }));

    // Không có bản ghi tương tác nào cho chat này.
    const interactions = readStore(INTERACTIONS_FILE, {});
    assert.deepEqual(Object.keys(interactions), [], "không được ghi sổ tương tác");
    // Không có bản ghi sổ chat nào.
    const directory = readStore(CHAT_DIRECTORY_FILE, { chats: {} });
    assert.deepEqual(Object.keys(directory.chats || {}), [], "không được ghi sổ chat");
});

test("người lạ bị 410 chat_id không hợp lệ thì KHÔNG để lại dấu vết", async (t) => {
    resetStores();
    clearBots();
    t.after(() => clearBots());

    const bot1 = officialWithRecorder("bot1", "admission-token-1", async () => {
        throw Object.assign(new Error("410 The chat_id is invalid"), { response: { statusCode: 410 } });
    });
    registerBots([bot1]);

    await deliver(bot1, message({ text: "/help" }));

    assert.deepEqual(Object.keys(readStore(INTERACTIONS_FILE, {})), []);
    assert.deepEqual(Object.keys(readStore(CHAT_DIRECTORY_FILE, { chats: {} }).chats || {}), []);
});

test("lệnh đầu tiên bị từ chối KHÔNG để lại MSSV/đăng ký", async (t) => {
    resetStores();
    clearBots();
    t.after(() => clearBots());

    const bot1 = officialWithRecorder("bot1", "admission-token-1", async () => {
        throw Object.assign(new Error("422 no permission"), { statusCode: 422 });
    });
    registerBots([bot1]);

    // /luumssv cần tra cứu MSSV; dùng cú pháp sai để không chạm mạng nhưng vẫn
    // chứng minh không có ghi nào xảy ra trên đường bị từ chối.
    await deliver(bot1, message({ text: "/luumssv 123456789" }));

    const subscriptions = readStore(SUBSCRIPTIONS_FILE, {});
    assert.deepEqual(Object.keys(subscriptions), [], "không được ghi đăng ký/MSSV");
});

test("trả lời thành công thì tiếp nhận ĐÚNG MỘT LẦN và ghi sổ chat", async (t) => {
    resetStores();
    clearBots();
    t.after(() => clearBots());

    const bot1 = officialWithRecorder("bot1", "admission-token-1");
    registerBots([bot1]);

    await deliver(bot1, message({ text: "/myid" }));

    assert.equal(bot1.sent.length > 0, true, "phải gửi được phản hồi");
    const directory = readStore(CHAT_DIRECTORY_FILE, { chats: {} });
    const keys = Object.keys(directory.chats || {});
    assert.equal(keys.length, 1, "phải có đúng một bản ghi sổ chat");
    const record = directory.chats[keys[0]];
    assert.equal(record.admissionStatus, "admitted");

    // Gửi thêm lần nữa vẫn chỉ một bản ghi — không tạo thêm dòng.
    await deliver(bot1, message({ text: "/myid" }));
    const after = readStore(CHAT_DIRECTORY_FILE, { chats: {} });
    assert.equal(Object.keys(after.chats || {}).length, 1);
});

test("lỗi TẠM THỜI không tiếp nhận nhưng cũng không đánh dấu hỏng vĩnh viễn", async (t) => {
    resetStores();
    clearBots();
    t.after(() => clearBots());

    // Lần đầu: lỗi 503. Lần sau: thành công.
    let attempt = 0;
    const bot1 = officialWithRecorder("bot1", "admission-token-1", async (chatId, text) => {
        attempt += 1;
        if (attempt === 1) throw Object.assign(new Error("503 service unavailable"), { statusCode: 503 });
        bot1.sent.push({ chatId: String(chatId), text });
        return { ok: true };
    });
    registerBots([bot1]);

    await deliver(bot1, message({ text: "/myid" }));
    // Sau lần lỗi tạm thời: chưa có bản ghi nào (chưa tiếp nhận).
    assert.deepEqual(Object.keys(readStore(CHAT_DIRECTORY_FILE, { chats: {} }).chats || {}), []);

    // Tương tác sau thành công ⇒ được tiếp nhận.
    await deliver(bot1, message({ text: "/myid" }));
    const directory = readStore(CHAT_DIRECTORY_FILE, { chats: {} });
    const keys = Object.keys(directory.chats || {});
    assert.equal(keys.length, 1);
    assert.equal(directory.chats[keys[0]].admissionStatus, "admitted");
});

test("hai bot dùng cùng chatId vẫn tách biệt khi tiếp nhận", async (t) => {
    resetStores();
    clearBots();
    t.after(() => clearBots());

    // bot2 bị từ chối, bot1 thành công — cùng một chatId.
    const bot1 = officialWithRecorder("bot1", "admission-token-1");
    const bot2 = officialWithRecorder("bot2", "admission-token-2", async () => {
        throw Object.assign(new Error("422 no permission"), { statusCode: 422 });
    });
    registerBots([bot1, bot2]);

    await deliver(bot1, message({ text: "/myid", chat: { id: "shared", type: "private" } }));
    await deliver(bot2, message({ text: "/myid", chat: { id: "shared", type: "private" } }));

    const directory = readStore(CHAT_DIRECTORY_FILE, { chats: {} });
    const chats = directory.chats || {};
    // bot1 tiếp nhận được ⇒ có bản ghi của bot1; bot2 bị từ chối ⇒ không có bản ghi.
    const bot1Records = Object.values(chats).filter((item) => item.botId === "bot1");
    const bot2Records = Object.values(chats).filter((item) => item.botId === "bot2");
    assert.equal(bot1Records.length, 1, "bot1 phải có bản ghi");
    assert.equal(bot2Records.length, 0, "bot2 bị từ chối không được có bản ghi");
    assert.equal(bot1Records[0].admissionStatus, "admitted");
});

test("chat chưa tiếp nhận KHÔNG nằm trong danh sách phát tin", async (t) => {
    resetStores();
    clearBots();
    t.after(() => clearBots());

    const bot1 = officialWithRecorder("bot1", "admission-token-1", async () => {
        throw Object.assign(new Error("410 The chat_id is invalid"), { response: { statusCode: 410 } });
    });
    registerBots([bot1]);

    await deliver(bot1, message({ text: "/help" }));

    const targets = main.getBroadcastTargets();
    assert.equal(targets.length, 0, "không có đích phát tin nào");
});
