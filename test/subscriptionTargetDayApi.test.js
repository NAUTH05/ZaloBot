const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const path = require("node:path");

process.env.BOT_TOKEN ||= "test-token";

// Cách ly khỏi file runtime thật ở gốc dự án.
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

const { createAdminServer } = require("../adminServer");
const { getSubscription, normalizeNotificationTimes } = require("../subscriptions");

function request(port, method, urlPath, body = null, cookie = "") {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: "127.0.0.1", port, method, path: urlPath, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, (response) => {
            let payload = "";
            response.on("data", (chunk) => { payload += chunk; });
            response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: payload ? JSON.parse(payload) : null }));
        });
        req.on("error", reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function setup(t) {
    const oldUsername = process.env.ADMIN_USERNAME;
    const oldPassword = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_USERNAME = "sub-admin";
    process.env.ADMIN_PASSWORD = "test-password";
    memoryFiles.clear();

    const runtime = createAdminServer({ port: 0 });
    await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    const port = runtime.server.address().port;
    t.after(() => { runtime.server.close(); process.env.ADMIN_USERNAME = oldUsername; process.env.ADMIN_PASSWORD = oldPassword; });

    const login = await request(port, "POST", "/zalobot/api/admin/auth/login", { username: "sub-admin", password: "test-password" });
    const cookie = String(login.headers?.["set-cookie"]?.[0] || "").split(";")[0];
    const context = { chatId: "chat-td", userId: "user-td", userDisplayName: "Người thử" };
    return { port, cookie, context };
}

function times(context) {
    return normalizeNotificationTimes(getSubscription(context));
}

test("API từ chối ngày đích không hợp lệ", async (t) => {
    const { port, cookie, context } = await setup(t);

    for (const value of [2, -1, "homnay", "homsau", true, {}]) {
        const result = await request(port, "PATCH", "/zalobot/api/admin/subscriptions", {
            ...context, action: "add_time", studentId: "123000135", time: "06:30", targetDayOffset: value
        }, cookie);
        assert.equal(result.status, 400, `targetDayOffset=${JSON.stringify(value)} phải bị từ chối`);
        assert.match(result.body.error, /targetDayOffset/);
    }
    assert.equal(times(context).length, 0, "không được ghi mốc nào khi giá trị sai");
});

test("API yêu cầu chọn ngày đích khi thêm mốc", async (t) => {
    const { port, cookie, context } = await setup(t);

    const result = await request(port, "PATCH", "/zalobot/api/admin/subscriptions", {
        ...context, action: "add_time", studentId: "123000135", time: "06:30"
    }, cookie);

    assert.equal(result.status, 400);
    assert.match(result.body.error, /ngày đích/);
    assert.equal(times(context).length, 0);
});

test("API thêm được cùng một giờ cho cả hai ngày đích", async (t) => {
    const { port, cookie, context } = await setup(t);

    const first = await request(port, "PATCH", "/zalobot/api/admin/subscriptions", {
        ...context, action: "add_time", studentId: "123000135", time: "06:30", targetDayOffset: 0
    }, cookie);
    assert.equal(first.status, 200, JSON.stringify(first.body));

    const second = await request(port, "PATCH", "/zalobot/api/admin/subscriptions", {
        ...context, action: "add_time", studentId: "123000135", time: "06:30", targetDayOffset: 1
    }, cookie);
    assert.equal(second.status, 200, JSON.stringify(second.body));

    const stored = times(context);
    assert.equal(stored.length, 2);
    assert.deepEqual(stored.map((item) => item.targetDayOffset), [0, 1]);
    assert.deepEqual(stored.map((item) => item.time), ["06:30", "06:30"]);

    // Thêm lại đúng cặp đã có thì không nhân bản.
    await request(port, "PATCH", "/zalobot/api/admin/subscriptions", {
        ...context, action: "add_time", studentId: "123000135", time: "06:30", targetDayOffset: 1
    }, cookie);
    assert.equal(times(context).length, 2);
});

test("API sửa được ngày đích của một mốc theo ID", async (t) => {
    const { port, cookie, context } = await setup(t);

    await request(port, "PATCH", "/zalobot/api/admin/subscriptions", {
        ...context, action: "add_time", studentId: "123000135", time: "06:30", targetDayOffset: 0
    }, cookie);
    const target = times(context)[0];

    const updated = await request(port, "PATCH", "/zalobot/api/admin/subscriptions", {
        ...context, action: "update_time", timeId: target.id, time: "07:00", targetDayOffset: 1
    }, cookie);
    assert.equal(updated.status, 200, JSON.stringify(updated.body));

    const after = times(context);
    assert.equal(after.length, 1);
    assert.equal(after[0].id, target.id, "ID phải được giữ nguyên");
    assert.equal(after[0].time, "07:00");
    assert.equal(after[0].targetDayOffset, 1);
});

test("API xóa đúng mốc theo ID và giữ mốc cùng giờ khác ngày", async (t) => {
    const { port, cookie, context } = await setup(t);

    await request(port, "PATCH", "/zalobot/api/admin/subscriptions", { ...context, action: "add_time", studentId: "123000135", time: "06:30", targetDayOffset: 0 }, cookie);
    await request(port, "PATCH", "/zalobot/api/admin/subscriptions", { ...context, action: "add_time", studentId: "123000135", time: "06:30", targetDayOffset: 1 }, cookie);
    const [first] = times(context);

    const removed = await request(port, "PATCH", "/zalobot/api/admin/subscriptions", { ...context, action: "remove_time", timeId: first.id }, cookie);
    assert.equal(removed.status, 200);

    const after = times(context);
    assert.equal(after.length, 1);
    assert.equal(after[0].targetDayOffset, 1);
});

test("workspace trả về ngày đích để giao diện hiển thị", async (t) => {
    const { port, cookie, context } = await setup(t);

    await request(port, "PATCH", "/zalobot/api/admin/subscriptions", { ...context, action: "add_time", studentId: "123000135", time: "06:30", targetDayOffset: 0 }, cookie);
    await request(port, "PATCH", "/zalobot/api/admin/subscriptions", { ...context, action: "add_time", studentId: "123000135", time: "06:30", targetDayOffset: 1 }, cookie);

    const notifications = await request(port, "GET", "/zalobot/api/admin/notifications", null, cookie);
    assert.equal(notifications.status, 200);
    const entry = notifications.body.schedule.find((item) => item.chatId === context.chatId);
    assert.ok(entry, "phải có đăng ký trong danh sách thông báo");
    assert.deepEqual(entry.notificationTimes.map((item) => item.targetDayOffset), [0, 1]);
    assert.deepEqual(entry.notificationTimes.map((item) => item.time), ["06:30", "06:30"]);
});

test("bản ghi cũ hiển thị ngày đích suy ra qua API", async (t) => {
    const { port, cookie, context } = await setup(t);

    // Bản ghi cũ: không có targetDayOffset.
    memoryFiles.set(fileKey(path.join(__dirname, "..", "subscriptions.json")), {
        [`${encodeURIComponent(context.chatId)}::${encodeURIComponent(context.userId)}`]: {
            contextVersion: 2,
            chatId: context.chatId,
            userId: context.userId,
            userDisplayName: context.userDisplayName,
            studentId: "123000135",
            studentName: "SV",
            notificationTimes: [{ id: 1, time: "06:00" }, { id: 2, time: "20:00" }],
            notificationsEnabled: true,
            classStartNotificationsEnabled: false,
            updatedAt: new Date().toISOString()
        }
    });

    const notifications = await request(port, "GET", "/zalobot/api/admin/notifications", null, cookie);
    const entry = notifications.body.schedule.find((item) => item.chatId === context.chatId);
    assert.deepEqual(entry.notificationTimes.map((item) => item.targetDayOffset), [0, 1], "20:00 phải là homsau, không phải homnay");
});

/* -------------------------------------------------------------------------- */
/* Bot trong API quản trị                                                     */
/* -------------------------------------------------------------------------- */

const { registerBot, clearBots } = require("../botContext");
const { createSubscriptionKey } = require("../subscriptions");
const { scopeKey } = require("../bots");

test("API /bots trả về danh sách bot và KHÔNG bao giờ lộ token", async (t) => {
    const { port, cookie } = await setup(t);

    clearBots();
    registerBot({ botId: "bot1", token: "secret-token-one", source: "BOT_TOKEN", fingerprint: "aaaa1111", enabled: true, status: "running" });
    registerBot({ botId: "bot2", token: "secret-token-two", source: "BOT_2_TOKEN", fingerprint: "bbbb2222", enabled: true, status: "running" });
    t.after(() => clearBots());

    const result = await request(port, "GET", "/zalobot/api/admin/bots", null, cookie);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.bots.map((bot) => bot.botId).sort(), ["bot1", "bot2"]);

    const serialized = JSON.stringify(result.body);
    assert.ok(!serialized.includes("secret-token-one"), "API làm lộ token bot 1");
    assert.ok(!serialized.includes("secret-token-two"), "API làm lộ token bot 2");
    for (const bot of result.body.bots) {
        assert.equal(bot.token, undefined);
        assert.equal(bot.status, "running");
    }
});

test("API lọc đăng ký theo bot, không trộn hai bot vào nhau", async (t) => {
    const { port, cookie } = await setup(t);

    clearBots();
    registerBot({ botId: "bot1", token: "t1", source: "BOT_TOKEN", fingerprint: "aaaa1111", enabled: true });
    registerBot({ botId: "bot2", token: "t2", source: "BOT_2_TOKEN", fingerprint: "bbbb2222", enabled: true });
    t.after(() => clearBots());

    // Cùng Chat ID / User ID nhưng ở hai bot khác nhau.
    const shared = { chatId: "same-chat", userId: "same-user" };
    memoryFiles.set(fileKey(path.join(__dirname, "..", "subscriptions.json")), {
        [createSubscriptionKey({ botId: "bot1", ...shared })]: {
            contextVersion: 2, botId: "bot1", ...shared, userDisplayName: "B1",
            studentId: "111111111", studentName: "SV 1",
            notificationTimes: [{ id: 1, time: "06:30", targetDayOffset: 0 }],
            notificationsEnabled: true, classStartNotificationsEnabled: false, updatedAt: new Date().toISOString()
        },
        [createSubscriptionKey({ botId: "bot2", ...shared })]: {
            contextVersion: 2, botId: "bot2", ...shared, userDisplayName: "B2",
            studentId: "222222222", studentName: "SV 2",
            notificationTimes: [{ id: 1, time: "06:30", targetDayOffset: 0 }],
            notificationsEnabled: true, classStartNotificationsEnabled: false, updatedAt: new Date().toISOString()
        }
    });

    const all = await request(port, "GET", "/zalobot/api/admin/notifications", null, cookie);
    assert.equal(all.body.schedule.length, 2, "không lọc thì thấy cả hai bot");

    const onlyBot1 = await request(port, "GET", "/zalobot/api/admin/notifications?botId=bot1", null, cookie);
    assert.deepEqual(onlyBot1.body.schedule.map((item) => item.studentId), ["111111111"]);

    const onlyBot2 = await request(port, "GET", "/zalobot/api/admin/notifications?botId=bot2", null, cookie);
    assert.deepEqual(onlyBot2.body.schedule.map((item) => item.studentId), ["222222222"]);
});
