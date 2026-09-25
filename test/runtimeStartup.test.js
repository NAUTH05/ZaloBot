const test = require("node:test");
const assert = require("node:assert/strict");

process.env.BOT_TOKEN ||= "test-token";
process.env.ADMIN_USERNAME = "startup-admin";
process.env.ADMIN_PASSWORD = "startup-password";
process.env.ADMIN_PORT = "0";
process.env.ADMIN_BASE_PATH = "/";

const order = [];

// Chặn ghi file thật và chặn kết nối Firebase thật, nhưng vẫn dùng
// readJsonStore thật để dữ liệu cục bộ đọc được như bình thường.
const persistence = require("../firestorePersistence");
persistence.writeJsonStore = () => {};
persistence.flushPersistenceWrites = async () => { order.push("flush"); };
persistence.initializeFirestorePersistence = async () => {
    order.push("firestore");
    return { projectId: "zalobot-startup-test", databaseId: "(default)", collectionName: "bot_state", credentialSource: "file", storeIds: ["subscriptions"] };
};

// node-schedule thật sẽ tạo job nền trong tiến trình test.
const schedulePath = require.resolve("node-schedule");
require.cache[schedulePath] = {
    id: schedulePath,
    filename: schedulePath,
    loaded: true,
    exports: { scheduleJob: () => { order.push("schedule"); return { cancel() {} }; } }
};

const ZaloBot = require("node-zalo-bot");
ZaloBot.prototype.sendMessage = function () { return Promise.resolve(); };
ZaloBot.prototype.startPolling = function () { order.push("polling"); return Promise.resolve(); };

const main = require("../main.js");

test("runtime nạp Firestore trước scheduler và Zalo polling", async (t) => {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => { logs.push(args.join(" ")); };

    t.after(async () => {
        console.log = originalLog;
        await main.closeDashboardServer();
    });

    await main.startRuntime();

    assert.ok(order.includes("firestore"), "phải nạp Firestore state");
    assert.ok(order.indexOf("firestore") < order.indexOf("schedule"), "Firestore phải xong trước scheduler");
    assert.ok(order.indexOf("schedule") < order.indexOf("polling"), "scheduler phải chạy trước Zalo polling");
    assert.ok(order.indexOf("firestore") < order.indexOf("polling"), "Firestore phải xong trước Zalo polling");

    for (const prefix of [
        "[Firebase] Project: ",
        "[Firebase] Database: ",
        "[Firebase] Collection: ",
        "[Persistence] State loaded",
        "[Runtime] Timezone: ",
        "[Dashboard] Listening on",
        "[Runtime] Scheduler started",
        // Log polling giờ nêu rõ bot nào, vì mỗi bot có consumer riêng.
        // Mỗi nhà cung cấp khởi động độc lập và tự báo trạng thái của mình.
        "[Runtime] bot1: đã khởi động"
    ]) {
        assert.ok(logs.some((line) => line.startsWith(prefix)), `thiếu log khởi động: ${prefix}`);
    }
});

test("cancelSchedulerJobs hủy đúng các job đã đăng ký", () => {
    assert.ok(main.cancelSchedulerJobs() >= 1, "phải có ít nhất một job để hủy");
    assert.equal(main.cancelSchedulerJobs(), 0, "gọi lần hai không còn job nào");
});

test("dừng polling và đóng dashboard an toàn khi thư viện không hỗ trợ", async () => {
    await assert.doesNotReject(() => main.stopZaloPolling());
    await assert.doesNotReject(() => main.closeDashboardServer());
});
