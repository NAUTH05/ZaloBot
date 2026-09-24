const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Hai bot được cấu hình TRƯỚC khi nạp main.js: registry được dựng lúc nạp module.
process.env.BOT_TOKEN = "token-bot-1";
process.env.BOT_2_TOKEN = "token-bot-2";
delete process.env.BOT_3_TOKEN;

const ROOT = path.join(__dirname, "..");

// Bộ nhớ thay cho file runtime thật.
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

// Ghi lại mọi lần gửi kèm TOKEN của client đã gửi, để khẳng định đúng danh tính.
const ZaloBot = require("node-zalo-bot");
const sent = [];
ZaloBot.prototype.sendMessage = function (chatId, text) {
    sent.push({ token: this.token, chatId: String(chatId), text: String(text) });
    return Promise.resolve();
};

const main = require("../main.js");
const {
    describeRegisteredBots,
    getBot,
    getCurrentBot,
    listBots,
    listEnabledBots,
    runWithBot
} = require("../botContext");
const { LEGACY_BOT_ID, resolveBotConfigs, scopeKey, storageKeyPrefix } = require("../bots");
const { createSubscriptionKey, getSubscription } = require("../subscriptions");

const TOKEN_1 = "token-bot-1";
const TOKEN_2 = "token-bot-2";
const SUBSCRIPTIONS_KEY = fileKey(path.join(ROOT, "subscriptions.json"));
const CHAT_DIRECTORY_KEY = fileKey(path.join(ROOT, "chatDirectory.json"));

function resetStores() {
    memoryFiles.clear();
    sent.length = 0;
}

// Đăng ký một người nhận ở một bot cụ thể, đúng như dữ liệu thật được ghi.
function seedSubscription({ botId, chatId, userId, studentId = "123000135", times = [{ id: 1, time: "06:30", targetDayOffset: 0 }], notificationsEnabled = true }) {
    const data = memoryFiles.get(SUBSCRIPTIONS_KEY) || {};
    data[createSubscriptionKey({ botId, chatId, userId })] = {
        contextVersion: 2,
        botId,
        chatId,
        userId,
        userDisplayName: `Người ${botId}`,
        studentId,
        studentName: "Sinh viên thử",
        notificationTimes: times,
        notificationsEnabled,
        classStartNotificationsEnabled: false,
        updatedAt: new Date().toISOString()
    };
    memoryFiles.set(SUBSCRIPTIONS_KEY, data);
}

function seedChat({ botId, chatId, userId }) {
    const data = memoryFiles.get(CHAT_DIRECTORY_KEY) || { schemaVersion: 3, chats: {}, deletedChatIds: {} };
    data.chats[scopeKey(botId, chatId)] = {
        chatId,
        botId,
        chatType: "private",
        displayName: `Chat ${botId}`,
        userId,
        status: "active",
        notificationOverrides: {},
        deliveryHistory: [],
        consecutiveFailureCount: 0
    };
    memoryFiles.set(CHAT_DIRECTORY_KEY, data);
}

/* -------------------------------------------------------------------------- */
/* 1. Cấu hình                                                                */
/* -------------------------------------------------------------------------- */

test("một token cũ vẫn chạy được và chỉ bật bot 1", () => {
    const result = resolveBotConfigs({ BOT_TOKEN: "only-token" });
    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.bots.map((bot) => bot.botId), ["bot1"]);
    assert.equal(result.bots[0].source, "BOT_TOKEN");
    // Thiếu token bot 2/3 chỉ là cảnh báo, không chặn khởi động.
    assert.equal(result.warnings.length, 2);
});

test("thiếu token bot 2 và bot 3 thì chúng đơn giản là tắt", () => {
    const result = resolveBotConfigs({ BOT_1_TOKEN: "a", BOT_2_TOKEN: "b" });
    assert.deepEqual(result.bots.map((bot) => bot.botId), ["bot1", "bot2"]);
    assert.ok(result.warnings.some((line) => line.includes("bot3")));
    assert.equal(result.errors.length, 0);
});

test("ba bot chạy được cùng lúc", () => {
    const result = resolveBotConfigs({ BOT_1_TOKEN: "a", BOT_2_TOKEN: "b", BOT_3_TOKEN: "c" });
    assert.deepEqual(result.bots.map((bot) => bot.botId), ["bot1", "bot2", "bot3"]);
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.length, 0);
});

test("token trùng nhau bị từ chối", () => {
    const result = resolveBotConfigs({ BOT_TOKEN: "same", BOT_2_TOKEN: "same" });
    assert.equal(result.bots.length, 1, "bot trùng token không được bật");
    assert.ok(result.errors.some((line) => line.includes("CÙNG một token")));
});

test("bot 1 nhận hai token khác nhau bị từ chối thay vì chọn bừa", () => {
    const result = resolveBotConfigs({ BOT_TOKEN: "a", BOT_1_TOKEN: "b" });
    assert.equal(result.bots.length, 0);
    assert.ok(result.errors.some((line) => line.includes("token khác nhau")));
});

test("thiếu token bot 1 là lỗi cấu hình, không chạy được chỉ với bot 2", () => {
    const result = resolveBotConfigs({ BOT_2_TOKEN: "b" });
    // Bot 2 vẫn được nhận diện là có token...
    assert.deepEqual(result.bots.map((bot) => bot.botId), ["bot2"]);
    // ...nhưng bot 1 thiếu token là lỗi chặn khởi động, và main.js từ chối chạy
    // khi không có bot 1 (nó sở hữu không gian khóa cũ).
    assert.ok(result.errors.some((line) => line.includes("Thiếu token cho bot 1")));
    assert.equal(result.bots.some((bot) => bot.botId === "bot1"), false);
});

test("mô tả bot không bao giờ chứa token", () => {
    const described = describeRegisteredBots();
    assert.ok(described.length >= 1);
    const serialized = JSON.stringify(described);
    for (const token of [TOKEN_1, TOKEN_2]) {
        assert.ok(!serialized.includes(token), `mô tả bot bị lộ token ${token}`);
    }
    for (const bot of described) {
        assert.equal(bot.token, undefined, "mô tả không được chứa token");
        if (bot.providerType === "official") {
            assert.equal(typeof bot.tokenFingerprint, "string");
            assert.equal(bot.tokenFingerprint.length, 8);
        } else {
            // Tài khoản cá nhân không có token: không bao giờ được bịa ra một cái.
            assert.equal(bot.tokenFingerprint, null);
            assert.equal(bot.isPersonalAccount, true);
        }
    }
});

/* -------------------------------------------------------------------------- */
/* 2. Không gian khóa                                                         */
/* -------------------------------------------------------------------------- */

test("bot 1 giữ khóa trần, bot 2 có tiền tố", () => {
    assert.equal(storageKeyPrefix("bot1"), "");
    assert.equal(storageKeyPrefix("bot2"), "bot2::");
});

test("cùng Chat ID và User ID ở hai bot cho ra hai bản ghi riêng", () => {
    resetStores();
    const shared = { chatId: "chat-same", userId: "user-same" };

    seedSubscription({ botId: "bot1", ...shared, studentId: "111111111" });
    seedSubscription({ botId: "bot2", ...shared, studentId: "222222222" });

    const bot1 = getSubscription({ botId: "bot1", ...shared });
    const bot2 = getSubscription({ botId: "bot2", ...shared });

    assert.equal(bot1.studentId, "111111111");
    assert.equal(bot2.studentId, "222222222");
    assert.notEqual(bot1.studentId, bot2.studentId, "hai bot không được dùng chung bản ghi");
    // Cả hai cùng tồn tại, không cái nào ghi đè cái nào.
    assert.equal(Object.keys(memoryFiles.get(SUBSCRIPTIONS_KEY)).length, 2);
});

/* -------------------------------------------------------------------------- */
/* 3. Định tuyến tin nhắn đến                                                  */
/* -------------------------------------------------------------------------- */

function incomingMessage(chatId, userId, text) {
    return { text, chat: { id: chatId, type: "private" }, from: { id: userId, display_name: "Người thử" } };
}

test("tin nhắn tới bot 2 được trả lời bằng bot 2", async () => {
    resetStores();
    const client2 = getBot("bot2").client;

    client2.emit("message", incomingMessage("chat-b2", "user-b2", "/help"));
    // Handler là async; chờ một nhịp để nó chạy xong.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(sent.length > 0, "bot 2 phải trả lời");
    for (const message of sent) {
        assert.equal(message.token, TOKEN_2, "phản hồi phải đi ra bằng token của bot 2");
    }
});

test("tin nhắn tới bot 1 được trả lời bằng bot 1", async () => {
    resetStores();
    const client1 = getBot("bot1").client;

    client1.emit("message", incomingMessage("chat-b1", "user-b1", "/help"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(sent.length > 0, "bot 1 phải trả lời");
    for (const message of sent) {
        assert.equal(message.token, TOKEN_1, "phản hồi phải đi ra bằng token của bot 1");
    }
});

test("ngữ cảnh bot được đặt đúng khi xử lý tin nhắn của từng bot", async () => {
    resetStores();
    const seen = [];
    const client1 = getBot("bot1").client;
    const client2 = getBot("bot2").client;

    const { getMessageContext } = require("../userContext");
    const original = ZaloBot.prototype.sendMessage;
    ZaloBot.prototype.sendMessage = function (chatId, text) {
        seen.push({ token: this.token, botId: getCurrentBot()?.botId, text: String(text) });
        return Promise.resolve();
    };

    try {
        client1.emit("message", incomingMessage("ctx-1", "ctx-user-1", "/help"));
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        client2.emit("message", incomingMessage("ctx-2", "ctx-user-2", "/help"));
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
    } finally {
        ZaloBot.prototype.sendMessage = original;
    }

    const forBot1 = seen.filter((item) => item.token === TOKEN_1);
    const forBot2 = seen.filter((item) => item.token === TOKEN_2);
    assert.ok(forBot1.length > 0 && forBot2.length > 0, "cả hai bot phải trả lời");
    assert.ok(forBot1.every((item) => item.botId === "bot1"), "ngữ cảnh bot 1 phải là bot1");
    assert.ok(forBot2.every((item) => item.botId === "bot2"), "ngữ cảnh bot 2 phải là bot2");

    // Ngữ cảnh tin nhắn mang đúng botId.
    assert.equal(getMessageContext(incomingMessage("x", "y", ""), { botId: "bot2" }).botId, "bot2");
});

/* -------------------------------------------------------------------------- */
/* 4. Gửi theo lịch đúng bot sở hữu                                            */
/* -------------------------------------------------------------------------- */

test("thông báo theo lịch đi ra bằng bot sở hữu đăng ký", async () => {
    resetStores();
    const reference = new Date("2026-09-23T06:30:00+07:00");

    seedChat({ botId: "bot1", chatId: "sched-1", userId: "sched-user-1" });
    seedChat({ botId: "bot2", chatId: "sched-2", userId: "sched-user-2" });
    seedSubscription({ botId: "bot1", chatId: "sched-1", userId: "sched-user-1" });
    seedSubscription({ botId: "bot2", chatId: "sched-2", userId: "sched-user-2" });

    const result = await main.sendDailySchedulesAtTime("06:30", reference);

    assert.equal(result.processed, true);
    const byChat = new Map(sent.map((item) => [item.chatId, item.token]));
    assert.equal(byChat.get("sched-1"), TOKEN_1, "đăng ký bot 1 phải gửi bằng bot 1");
    assert.equal(byChat.get("sched-2"), TOKEN_2, "đăng ký bot 2 phải gửi bằng bot 2");
});

test("cùng Chat ID ở hai bot đều nhận được, không bị gộp làm một", async () => {
    resetStores();
    const reference = new Date("2026-09-23T06:30:00+07:00");
    const shared = { chatId: "shared-chat", userId: "shared-user" };

    seedChat({ botId: "bot1", ...shared });
    seedChat({ botId: "bot2", ...shared });
    seedSubscription({ botId: "bot1", ...shared });
    seedSubscription({ botId: "bot2", ...shared });

    const result = await main.sendDailySchedulesAtTime("06:30", reference);

    assert.equal(result.sent, 2, "mỗi bot phải gửi một tin cho cùng một Chat ID");
    const tokens = sent.map((item) => item.token).sort();
    assert.deepEqual(tokens, [TOKEN_1, TOKEN_2].sort());
});

test("đăng ký của bot đã tắt thì không được gửi", async () => {
    resetStores();
    const reference = new Date("2026-09-23T06:30:00+07:00");

    seedChat({ botId: "bot1", chatId: "on-1", userId: "u-1" });
    seedSubscription({ botId: "bot1", chatId: "on-1", userId: "u-1" });
    // Đăng ký trỏ tới bot 3, mà bot 3 không bật trong bài kiểm tra này.
    seedSubscription({ botId: "bot3", chatId: "off-3", userId: "u-3" });

    await main.sendDailySchedulesAtTime("06:30", reference);

    assert.ok(sent.every((item) => item.chatId !== "off-3"), "không được gửi cho bot đang tắt");
    assert.ok(sent.some((item) => item.chatId === "on-1"));
});

/* -------------------------------------------------------------------------- */
/* 5. Registry và vòng đời                                                     */
/* -------------------------------------------------------------------------- */

test("registry có đúng các bot đã bật và mỗi bot một client riêng", () => {
    const bots = listEnabledBots();
    assert.deepEqual(bots.map((bot) => bot.botId), ["bot1", "bot2"]);
    const clients = new Set(bots.map((bot) => bot.client));
    assert.equal(clients.size, bots.length, "mỗi bot phải có client riêng");
    // Không dùng chung token ⇒ không có hai consumer trên cùng một danh tính.
    const tokens = bots.map((bot) => bot.client.token);
    assert.equal(new Set(tokens).size, tokens.length);
});

test("không có ngữ cảnh thì mặc định là bot 1", () => {
    assert.equal(getCurrentBot().botId, LEGACY_BOT_ID);
});

test("runWithBot đổi danh tính cho cả nhánh async bên trong", async () => {
    const observed = await runWithBot("bot2", async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return getCurrentBot().botId;
    });
    assert.equal(observed, "bot2");
    // Sau khi ra khỏi ngữ cảnh thì quay lại mặc định.
    assert.equal(getCurrentBot().botId, LEGACY_BOT_ID);
});

test("dừng polling dừng mọi bot, một bot lỗi không chặn bot khác", async () => {
    const calls = [];
    const original = ZaloBot.prototype.stopPolling;
    ZaloBot.prototype.stopPolling = function () {
        calls.push(this.token);
        if (this.token === TOKEN_1) return Promise.reject(new Error("dừng lỗi"));
        return Promise.resolve();
    };

    try {
        const stopped = await main.stopZaloPolling();
        assert.equal(stopped, listBots().length, "phải thử dừng mọi nhà cung cấp đã đăng ký");
        assert.deepEqual(calls.sort(), [TOKEN_1, TOKEN_2].sort());
    } finally {
        ZaloBot.prototype.stopPolling = original;
    }
});

test("khởi động polling cho mọi bot đang bật", async () => {
    const started = [];
    const original = ZaloBot.prototype.startPolling;
    ZaloBot.prototype.startPolling = function () { started.push(this.token); return Promise.resolve(); };

    try {
        await main.startRuntime();
        assert.deepEqual(started.sort(), [TOKEN_1, TOKEN_2].sort(), "mỗi bot phải có một consumer riêng");
        // Không bot nào được khởi động hai lần trên cùng một token.
        assert.equal(new Set(started).size, started.length);
    } finally {
        ZaloBot.prototype.startPolling = original;
        await main.closeDashboardServer();
    }
});

test("listBots trả về mọi nhà cung cấp đã đăng ký, gồm cả ZCA", () => {
    const ids = listBots().map((bot) => bot.botId).sort();
    assert.ok(ids.includes("bot1") && ids.includes("bot2"), "phải có hai bot chính thức");
    // ZCA đăng ký dưới khóa tạm cho tới khi đăng nhập mới biết UID thật.
    assert.ok(ids.some((id) => id.startsWith("zca:")), "phải có nhà cung cấp ZCA");
});
