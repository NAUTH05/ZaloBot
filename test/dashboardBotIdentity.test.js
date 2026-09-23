const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.ADMIN_USERNAME = "botid-admin";
process.env.ADMIN_PASSWORD = "botid-pass";
process.env.ADMIN_BASE_PATH = "/zalobot";
process.env.BOT_TOKEN = "botid-token-1";
process.env.BOT_2_TOKEN = "botid-token-2";
process.env.BOT_2_NAME = "Bot Micano";

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

const { registerBots, clearBots } = require("../botContext");
const { createSubscriptionKey } = require("../subscriptions");
const { buildAdminData } = require("../adminDataService");
const { buildTargetUserOptions, resolveBatchTargets } = require("../targetUsers");
const { extractBotName, resolveBotConfigs, formatBotLabel } = require("../bots");
const { createAdminServer } = require("../adminServer");

const SUBSCRIPTIONS = fileKey(path.join(ROOT, "subscriptions.json"));
const CHAT_DIRECTORY = fileKey(path.join(ROOT, "chatDirectory.json"));
const INTERACTIONS = fileKey(path.join(ROOT, "interactions.json"));

// Cùng một Chat ID và User ID ở CẢ HAI bot — đây là tình huống dễ hỏng nhất.
const SHARED_CHAT = "same-chat";
const SHARED_USER = "same-user";

function registerTwoBots() {
    clearBots();
    registerBots([
        { botId: "bot1", token: "botid-token-1", source: "BOT_TOKEN", fingerprint: "1111aaaa", enabled: true, status: "running", client: {} },
        { botId: "bot2", token: "botid-token-2", source: "BOT_2_TOKEN", fingerprint: "2222bbbb", displayName: "Bot Micano", enabled: true, status: "running", client: {} }
    ]);
}

// "ghost-*" chỉ có trong sổ tương tác và đăng ký, KHÔNG có trong chatDirectory —
// đúng trường hợp trước đây trả 404 khi xoá.
function seedStores() {
    memoryFiles.clear();
    memoryFiles.set(CHAT_DIRECTORY, {
        schemaVersion: 3,
        chats: {
            "chat-real-1": { chatId: "chat-real-1", botId: "bot1", chatType: "private", displayName: "Bot1 real", userId: "user-real-1", status: "active" },
            "bot2::chat-real-2": { chatId: "chat-real-2", botId: "bot2", chatType: "private", displayName: "Bot2 real", userId: "user-real-2", status: "active" }
        },
        deletedChatIds: {}
    });

    const time = [{ id: 1, time: "06:30", targetDayOffset: 0 }];
    memoryFiles.set(SUBSCRIPTIONS, {
        [createSubscriptionKey({ botId: "bot1", chatId: SHARED_CHAT, userId: SHARED_USER })]: {
            contextVersion: 2, botId: "bot1", chatId: SHARED_CHAT, userId: SHARED_USER, userDisplayName: "Chung",
            studentId: "111111111", notificationTimes: time, notificationsEnabled: true, updatedAt: "2026-09-01T00:00:00.000Z"
        },
        [createSubscriptionKey({ botId: "bot2", chatId: SHARED_CHAT, userId: SHARED_USER })]: {
            contextVersion: 2, botId: "bot2", chatId: SHARED_CHAT, userId: SHARED_USER, userDisplayName: "Chung",
            studentId: "222222222", notificationTimes: time, notificationsEnabled: true, updatedAt: "2026-09-01T00:00:00.000Z"
        },
        [createSubscriptionKey({ botId: "bot1", chatId: "ghost-1", userId: "ghost-user-1" })]: {
            contextVersion: 2, botId: "bot1", chatId: "ghost-1", userId: "ghost-user-1", userDisplayName: "Ghost1",
            studentId: "333333333", notificationTimes: time, notificationsEnabled: true, updatedAt: "2026-09-01T00:00:00.000Z"
        },
        [createSubscriptionKey({ botId: "bot2", chatId: "ghost-2", userId: "ghost-user-2" })]: {
            contextVersion: 2, botId: "bot2", chatId: "ghost-2", userId: "ghost-user-2", userDisplayName: "Ghost2",
            studentId: "444444444", notificationTimes: time, notificationsEnabled: true, updatedAt: "2026-09-01T00:00:00.000Z"
        }
    });

    const interaction = (chatId, botId, userId, name) => ({
        chatId, botId, chatType: "private",
        members: { [userId]: { userId, displayName: name, status: "active" } },
        lastUserId: userId, firstInteractionAt: "2026-09-01T00:00:00.000Z", lastInteractionAt: "2026-09-01T00:00:00.000Z"
    });
    memoryFiles.set(INTERACTIONS, {
        [SHARED_CHAT]: interaction(SHARED_CHAT, "bot1", SHARED_USER, "Chung"),
        [`bot2::${SHARED_CHAT}`]: interaction(SHARED_CHAT, "bot2", SHARED_USER, "Chung"),
        "ghost-1": interaction("ghost-1", "bot1", "ghost-user-1", "Ghost1"),
        "bot2::ghost-2": interaction("ghost-2", "bot2", "ghost-user-2", "Ghost2")
    });
}

/* -------------------------------------------------------------------------- */
/* Danh tính tổ hợp (botId, userId) và (botId, chatId)                        */
/* -------------------------------------------------------------------------- */

test("cùng User ID và Chat ID ở hai bot vẫn là hai bản ghi riêng", () => {
    registerTwoBots();
    seedStores();
    const data = buildAdminData();

    const sharedChats = data.chats.filter((chat) => chat.chatId === SHARED_CHAT);
    assert.equal(sharedChats.length, 2, "phải có hai dòng chat cho cùng Chat ID");
    assert.deepEqual(sharedChats.map((chat) => chat.botId).sort(), ["bot1", "bot2"]);

    const sharedUsers = data.users.filter((user) => user.userId === SHARED_USER);
    assert.equal(sharedUsers.length, 2, "phải có hai người dùng cho cùng User ID");
    assert.deepEqual(sharedUsers.map((user) => user.botId).sort(), ["bot1", "bot2"]);

    // Đăng ký không được trộn MSSV của hai bot.
    const sharedSubs = data.subscriptions.filter((item) => item.chatId === SHARED_CHAT);
    assert.deepEqual(sharedSubs.map((item) => item.studentId).sort(), ["111111111", "222222222"]);

    // Mỗi người chỉ thấy đăng ký của CHÍNH bot mình.
    for (const user of sharedUsers) {
        assert.ok(user.subscriptions.every((item) => item.botId === user.botId), `${user.botId} bị lẫn đăng ký của bot khác`);
    }
});

test("mọi bản ghi dashboard đều mang botId", () => {
    registerTwoBots();
    seedStores();
    const data = buildAdminData();

    for (const chat of data.chats) assert.ok(chat.botId, `chat ${chat.chatId} thiếu botId`);
    for (const user of data.users) assert.ok(user.botId, `user ${user.userId} thiếu botId`);
    for (const item of data.subscriptions) assert.ok(item.botId, `subscription ${item.key} thiếu botId`);
    for (const group of data.groups) assert.ok(group.botId, `group ${group.chatId} thiếu botId`);
});

test("thống kê theo bot đếm riêng từng danh tính", () => {
    registerTwoBots();
    seedStores();
    const data = buildAdminData();

    const bot1 = data.botStats.find((item) => item.botId === "bot1");
    const bot2 = data.botStats.find((item) => item.botId === "bot2");
    assert.ok(bot1 && bot2, "phải có thống kê cho cả hai bot");
    // bot1: chat-real-1 + same-chat + ghost-1; bot2: chat-real-2 + same-chat + ghost-2
    assert.equal(bot1.chatCount, 3);
    assert.equal(bot2.chatCount, 3);
    assert.equal(bot1.subscriptionCount, 2);
    assert.equal(bot2.subscriptionCount, 2);
});

test("bản ghi cũ thiếu botId thuộc về bot 1", () => {
    registerTwoBots();
    seedStores();
    // Bản ghi legacy: khóa trần, không có trường botId.
    const subscriptions = memoryFiles.get(SUBSCRIPTIONS);
    subscriptions["legacy-chat::legacy-user"] = {
        contextVersion: 2, chatId: "legacy-chat", userId: "legacy-user", userDisplayName: "Legacy",
        studentId: "999999999", notificationTimes: [{ id: 1, time: "06:30", targetDayOffset: 0 }],
        notificationsEnabled: true, updatedAt: "2026-09-01T00:00:00.000Z"
    };
    memoryFiles.set(SUBSCRIPTIONS, subscriptions);

    const data = buildAdminData();
    const legacy = data.subscriptions.find((item) => item.chatId === "legacy-chat");
    assert.equal(legacy.botId, "bot1");
});

/* -------------------------------------------------------------------------- */
/* Xoá chat: trường hợp trước đây trả 404                                     */
/* -------------------------------------------------------------------------- */

async function withServer(fn) {
    registerTwoBots();
    seedStores();
    const runtime = createAdminServer({ port: 0, executeCommand: async () => ({ messageCount: 0, messages: [] }) });
    await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    const port = runtime.server.address().port;
    const base = `http://127.0.0.1:${port}/zalobot`;

    async function call(method, urlPath, body) {
        const response = await fetch(`${base}${urlPath}`, {
            method,
            headers: { "Content-Type": "application/json", Cookie: cookie },
            body: body ? JSON.stringify(body) : undefined
        });
        return { status: response.status, body: await response.json().catch(() => ({})) };
    }

    const login = await fetch(`${base}/api/admin/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "botid-admin", password: "botid-pass" })
    });
    const cookie = (login.headers.getSetCookie?.() || []).map((value) => value.split(";")[0]).join("; ");

    try {
        await fn({ call, base });
    } finally {
        runtime.server.close();
    }
}

test("xoá chat chỉ có trong sổ tương tác/đăng ký trả 200 kèm giải thích, không còn 404", async () => {
    await withServer(async ({ call }) => {
        // Chat "ghost-1" không có bản ghi trong chatDirectory.
        const result = await call("DELETE", `/api/admin/chats/ghost-1?hard=1&botId=bot1`);
        assert.equal(result.status, 200, `mong 200, nhận ${result.status} ${JSON.stringify(result.body)}`);
        assert.equal(result.body.ok, true);
        assert.equal(result.body.hadDirectoryRecord, false);
        assert.match(result.body.message, /không có bản ghi trong sổ chat/);
    });
});

test("xoá chat bot2 (trước đây 404) trả 200 và không đụng dữ liệu bot1", async () => {
    await withServer(async ({ call }) => {
        const before = buildAdminData();
        const bot1Before = before.subscriptions.filter((item) => item.botId === "bot1").length;

        const result = await call("DELETE", `/api/admin/chats/ghost-2?hard=1&botId=bot2`);
        assert.equal(result.status, 200);

        const after = buildAdminData();
        // Chat bot2 không còn hiện trên dashboard.
        assert.equal(after.chats.some((chat) => chat.botId === "bot2" && chat.chatId === "ghost-2"), false);
        // Đăng ký của bot1 còn nguyên.
        assert.equal(after.subscriptions.filter((item) => item.botId === "bot1").length, bot1Before);
        // Đăng ký của bot2 VẪN ĐƯỢC GIỮ (xoá chat không xoá đăng ký).
        assert.equal(after.subscriptions.some((item) => item.botId === "bot2" && item.chatId === "ghost-2"), true);
    });
});

test("xoá chat có bản ghi trong sổ chat vẫn hoạt động và ghi nhớ tombstone", async () => {
    await withServer(async ({ call }) => {
        const result = await call("DELETE", `/api/admin/chats/chat-real-1?hard=1&botId=bot1`);
        assert.equal(result.status, 200);
        assert.equal(result.body.hadDirectoryRecord, true);
        assert.equal(buildAdminData().chats.some((chat) => chat.botId === "bot1" && chat.chatId === "chat-real-1"), false);
    });
});

test("soft remove giữ bản ghi và đăng ký, chỉ đổi trạng thái", async () => {
    await withServer(async ({ call }) => {
        const result = await call("DELETE", `/api/admin/chats/chat-real-1?botId=bot1`);
        assert.equal(result.status, 200);
        assert.equal(result.body.hard, false);

        const chat = buildAdminData().chats.find((item) => item.botId === "bot1" && item.chatId === "chat-real-1");
        assert.ok(chat, "soft remove không được xoá bản ghi");
        assert.equal(chat.status, "removed");
    });
});

test("thiếu botId khi chạy nhiều bot trả lỗi rõ ràng thay vì đoán bot", async () => {
    await withServer(async ({ call }) => {
        const result = await call("DELETE", `/api/admin/chats/ghost-1?hard=1`);
        assert.equal(result.status, 400);
        assert.match(result.body.error, /Thiếu botId/);
        // Không được âm thầm tác động lên bot 1.
        assert.equal(buildAdminData().chats.some((chat) => chat.botId === "bot1" && chat.chatId === "ghost-1"), true);
    });
});

test("botId không hợp lệ bị từ chối", async () => {
    await withServer(async ({ call }) => {
        const result = await call("DELETE", `/api/admin/chats/ghost-1?hard=1&botId=bot9`);
        assert.equal(result.status, 400);
        assert.match(result.body.error, /bot9/);
    });
});

/* -------------------------------------------------------------------------- */
/* Command console chọn đúng bot                                              */
/* -------------------------------------------------------------------------- */

test("người nhận được phân giải trong đúng phạm vi bot", () => {
    registerTwoBots();
    seedStores();
    const workspace = buildAdminData();

    const options = buildTargetUserOptions(workspace);
    const shared = options.filter((user) => user.userId === SHARED_USER);
    assert.equal(shared.length, 2, "cùng User ID ở hai bot phải là hai lựa chọn riêng");
    assert.deepEqual(shared.map((user) => user.botId).sort(), ["bot1", "bot2"]);

    // Chọn bot2 thì chỉ thấy người của bot2.
    const forBot2 = resolveBatchTargets(workspace, [SHARED_USER], { botId: "bot2" });
    assert.equal(forBot2.targets.length, 1);
    assert.equal(forBot2.targets[0].botId, "bot2");

    const forBot1 = resolveBatchTargets(workspace, [SHARED_USER], { botId: "bot1" });
    assert.equal(forBot1.targets.length, 1);
    assert.equal(forBot1.targets[0].botId, "bot1");

    // Người chỉ thuộc bot1 bị TỪ CHỐI khi gửi bằng bot2, không gửi nhầm.
    const foreign = resolveBatchTargets(workspace, ["ghost-user-1"], { botId: "bot2" });
    assert.equal(foreign.targets.length, 0);
    assert.equal(foreign.rejected.length, 1);
    assert.match(foreign.rejected[0].reason, /không thuộc bot2/);
});

test("cùng User ID ở hai bot không bị khử trùng lẫn nhau", () => {
    registerTwoBots();
    seedStores();
    const workspace = buildAdminData();
    // Không nêu bot: hai người khác bot vẫn phải là hai người nhận riêng.
    const result = resolveBatchTargets(workspace, [SHARED_USER]);
    const distinct = new Set(result.targets.map((item) => `${item.botId}::${item.userId}`));
    assert.equal(distinct.size, result.targets.length, "khử trùng đã trộn hai bot");
});

/* -------------------------------------------------------------------------- */
/* Tên bot                                                                    */
/* -------------------------------------------------------------------------- */

test("BOT_N_NAME dùng làm nhãn khi chưa lấy được tên từ Zalo", () => {
    const result = resolveBotConfigs({ BOT_TOKEN: "t1", BOT_2_TOKEN: "t2", BOT_2_NAME: "Bot Micano" });
    const bot1 = result.bots.find((bot) => bot.botId === "bot1");
    const bot2 = result.bots.find((bot) => bot.botId === "bot2");
    assert.equal(formatBotLabel(bot2), "Bot Micano · bot2");
    // Không cấu hình tên thì dùng chính botId.
    assert.equal(formatBotLabel(bot1), "bot1");
});

test("tên lấy từ Zalo được ưu tiên hơn nhãn cấu hình", () => {
    const result = resolveBotConfigs({ BOT_TOKEN: "t1", BOT_2_TOKEN: "t2", BOT_2_NAME: "Nhãn cấu hình" });
    const bot2 = { ...result.bots.find((bot) => bot.botId === "bot2"), displayName: "Tên từ Zalo" };
    assert.equal(formatBotLabel(bot2), "Tên từ Zalo · bot2");
});

test("extractBotName chấp nhận nhiều dạng phản hồi getMe và trả null khi không rõ", () => {
    assert.equal(extractBotName({ name: "A" }), "A");
    assert.equal(extractBotName({ display_name: "B" }), "B");
    assert.equal(extractBotName({ displayName: "C" }), "C");
    assert.equal(extractBotName({ bot_name: "D" }), "D");
    assert.equal(extractBotName({ result: { name: "E" } }), "E");
    assert.equal(extractBotName({ data: { display_name: "F" } }), "F");
    assert.equal(extractBotName({}), null);
    assert.equal(extractBotName(null), null);
    assert.equal(extractBotName({ name: "   " }), null);
});

test("API /bots trả nhãn hiển thị và KHÔNG bao giờ lộ token", async () => {
    await withServer(async ({ call }) => {
        const result = await call("GET", "/api/admin/bots");
        assert.equal(result.status, 200);
        const serialized = JSON.stringify(result.body);
        assert.ok(!serialized.includes("botid-token-1"), "lộ token bot 1");
        assert.ok(!serialized.includes("botid-token-2"), "lộ token bot 2");

        const bot2 = result.body.bots.find((bot) => bot.botId === "bot2");
        assert.equal(bot2.displayName, "Bot Micano");
        assert.equal(bot2.label, "Bot Micano · bot2");
    });
});
