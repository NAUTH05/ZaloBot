const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const path = require("node:path");

// Cách ly khỏi các file runtime thật ở gốc dự án. `node --test` chạy mỗi file
// kiểm tra trong một tiến trình song song; nếu hai file cùng ghi
// chatDirectory.json / interactions.json thì chúng sẽ tranh chấp và làm hỏng
// kết quả của nhau. Thay lớp lưu trữ bằng bộ nhớ để không file thật nào bị đụng.
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

// Mỗi bài kiểm tra bắt đầu từ vùng nhớ trắng, thay cho việc sao lưu/khôi phục
// file thật như trước đây.
function preserveRuntimeFiles() {
    memoryFiles.clear();
}

function request(port, method, path, body = null, cookie = "") {
    return new Promise((resolve, reject) => {
        const request = http.request({ hostname: "127.0.0.1", port, method, path, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, (response) => {
            let payload = "";
            response.on("data", (chunk) => { payload += chunk; });
            response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: payload ? JSON.parse(payload) : null }));
        });
        request.on("error", reject);
        if (body) request.write(JSON.stringify(body));
        request.end();
    });
}

test("admin server protects API and serves the dashboard under /zalobot", async (t) => {
    preserveRuntimeFiles(t);
    const oldUsername = process.env.ADMIN_USERNAME;
    const oldPassword = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_USERNAME = "test-admin";
    process.env.ADMIN_PASSWORD = "test-password";
    const runtime = createAdminServer({ port: 0 });
    await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    const port = runtime.server.address().port;
    t.after(() => { runtime.server.close(); process.env.ADMIN_USERNAME = oldUsername; process.env.ADMIN_PASSWORD = oldPassword; });

    const unauthenticated = await request(port, "GET", "/zalobot/api/admin/dashboard");
    assert.equal(unauthenticated.status, 401);
    const login = await request(port, "POST", "/zalobot/api/admin/auth/login", { username: "test-admin", password: "test-password" });
    assert.equal(login.status, 200);
    const cookie = String(login.headers["set-cookie"][0]).split(";")[0];
    const dashboard = await request(port, "GET", "/zalobot/api/admin/dashboard", null, cookie);
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.body.bot.status, "online");
    const workspace = await request(port, "GET", "/zalobot/api/admin/workspace", null, cookie);
    assert.equal(workspace.status, 200);
    assert.ok(Array.isArray(workspace.body.users));
    assert.ok(Array.isArray(workspace.body.groups));
    assert.ok(Array.isArray(workspace.body.subscriptions));
    assert.equal(workspace.body.duty, undefined, "dữ liệu lịch trực đã được tách sang bot khác");
    const page = await new Promise((resolve, reject) => http.get({ hostname: "127.0.0.1", port, path: "/zalobot/" }, (response) => { let body = ""; response.on("data", (chunk) => { body += chunk; }); response.on("end", () => resolve({ status: response.statusCode, body })); }).on("error", reject));
    assert.equal(page.status, 200);
    assert.match(page.body, /ZaloBot Admin/);
});

test("admin API exposes chat CRUD, settings and command execution", async (t) => {
    preserveRuntimeFiles(t);
    const oldUsername = process.env.ADMIN_USERNAME;
    const oldPassword = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_USERNAME = "crud-admin";
    process.env.ADMIN_PASSWORD = "test-password";
    let executed = null;
    const runtime = createAdminServer({ port: 0, executeCommand: async (payload) => { executed = payload; return { deliveredToChatId: payload.chatId, messages: [{ chatId: payload.chatId, text: "Command result" }] }; } });
    await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    const port = runtime.server.address().port;
    t.after(() => { runtime.server.close(); process.env.ADMIN_USERNAME = oldUsername; process.env.ADMIN_PASSWORD = oldPassword; });
    const login = await request(port, "POST", "/zalobot/api/admin/auth/login", { username: "crud-admin", password: "test-password" });
    const cookie = String(login.headers["set-cookie"][0]).split(";")[0];

    const created = await request(port, "POST", "/zalobot/api/admin/chats", { chatId: "dashboard-test-chat", userId: "dashboard-test-user", chatType: "user", displayName: "Dashboard Test" }, cookie);
    assert.equal(created.status, 201);
    assert.equal(created.body.chat.chatType, "private");
    const updated = await request(port, "PATCH", "/zalobot/api/admin/chats/dashboard-test-chat", { action: "metadata", chatType: "group", displayName: "Updated Group" }, cookie);
    assert.equal(updated.status, 200);
    assert.equal(updated.body.chat.chatType, "group");

    const user = await request(port, "POST", "/zalobot/api/admin/users", { chatId: "dashboard-test-chat", userId: "dashboard-member", displayName: "Dashboard Member", chatType: "group" }, cookie);
    assert.equal(user.status, 201);
    const userUpdated = await request(port, "PATCH", "/zalobot/api/admin/users/dashboard-member", { chatId: "dashboard-test-chat", displayName: "Renamed Member", status: "disabled" }, cookie);
    assert.equal(userUpdated.status, 200);
    assert.equal(userUpdated.body.member.displayName, "Renamed Member");

    const admin = await request(port, "POST", "/zalobot/api/admin/settings/admins", { userId: "dashboard-admin-user", chatId: "dashboard-admin-chat" }, cookie);
    assert.equal(admin.status, 200);
    const settings = await request(port, "GET", "/zalobot/api/admin/settings", null, cookie);
    assert.ok(settings.body.admins.some((item) => item.userId === "dashboard-admin-user"));

    // Hạn mức trợ lý AI: ghi được khối `ai` và trả lại đúng giá trị đã lưu.
    const aiPatch = await request(port, "PATCH", "/zalobot/api/admin/settings", { ai: { perUserDailyLimit: 0, monthlyBudgetUsd: 5 } }, cookie);
    assert.equal(aiPatch.status, 200);
    assert.equal(aiPatch.body.ai.perUserDailyLimit, 0, "0 = không giới hạn, không được biến thành null");
    assert.equal(aiPatch.body.ai.monthlyBudgetUsd, 5);
    const badAi = await request(port, "PATCH", "/zalobot/api/admin/settings", { ai: { perUserDailyLimit: -3 } }, cookie);
    assert.equal(badAi.status, 400, "giá trị sai phải bị từ chối để người vận hành biết");
    const command = await request(port, "POST", "/zalobot/api/admin/commands", { command: "/quanlychat", userId: "dashboard-admin-user", chatId: "dashboard-admin-chat" }, cookie);
    assert.equal(command.status, 400, "lệnh toàn cục không chạy theo từng người nhận nên phải bị từ chối");
    assert.match(command.body.error, /không chạy theo từng người được/);

    // Lệnh chạy theo từng người nhận cần một chat riêng tư đủ tin cậy để gửi.
    await request(port, "POST", "/zalobot/api/admin/chats", { chatId: "command-private-chat", chatType: "private", displayName: "Command Target" }, cookie);
    await request(port, "POST", "/zalobot/api/admin/users", { chatId: "command-private-chat", userId: "command-target-user", displayName: "Command Target", chatTitle: "Command Target", chatType: "private" }, cookie);
    const targeted = await request(port, "POST", "/zalobot/api/admin/commands", { command: "/help", targetUserId: "command-target-user" }, cookie);
    assert.equal(targeted.status, 200, JSON.stringify(targeted.body));
    assert.equal(executed.command, "/help");
    assert.equal(executed.target.userId, "command-target-user");
    assert.equal(executed.target.chatId, "command-private-chat");
    assert.equal(targeted.body.messages[0].text, "Command result");
    assert.equal(targeted.body.summary.delivered, 1);

    const userDeleted = await request(port, "DELETE", "/zalobot/api/admin/users/dashboard-member?hard=1&chatId=dashboard-test-chat", null, cookie);
    assert.equal(userDeleted.status, 200, JSON.stringify(userDeleted.body));

    const deleted = await request(port, "DELETE", "/zalobot/api/admin/chats/dashboard-test-chat?hard=1", null, cookie);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    await request(port, "DELETE", "/zalobot/api/admin/settings/admins?id=dashboard-admin-user", null, cookie);
});

test("command execution derives executor identity from the session", async (t) => {
    preserveRuntimeFiles(t);
    const oldUsername = process.env.ADMIN_USERNAME; const oldPassword = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_USERNAME = "session-admin"; process.env.ADMIN_PASSWORD = "test-password";
    let executed = null;
    const runtime = createAdminServer({ port: 0, executeCommand: async (payload) => { executed = payload; return { ok: true }; } });
    await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve)); const port = runtime.server.address().port;
    t.after(() => { runtime.server.close(); process.env.ADMIN_USERNAME = oldUsername; process.env.ADMIN_PASSWORD = oldPassword; });
    const login = await request(port, "POST", "/zalobot/api/admin/auth/login", { username: "session-admin", password: "test-password" });
    const cookie = String(login.headers["set-cookie"][0]).split(";")[0];

    // Đích phải có chat riêng tư đủ tin cậy thì lệnh mới gửi được.
    await request(port, "POST", "/zalobot/api/admin/chats", { chatId: "session-target-chat", chatType: "private", displayName: "Session Target" }, cookie);
    await request(port, "POST", "/zalobot/api/admin/users", { chatId: "session-target-chat", userId: "target-1", displayName: "Session Target", chatTitle: "Session Target", chatType: "private" }, cookie);

    const result = await request(port, "POST", "/zalobot/api/admin/commands", { command: "/help", userId: "spoofed", targetUserId: "target-1" }, cookie);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.notEqual(executed.userId, "spoofed");
    assert.equal(executed.target.userId, "target-1");
});

test("Command console target mapping uses real User IDs and rejects a group Chat ID", async (t) => {
    preserveRuntimeFiles(t);
    const oldUsername = process.env.ADMIN_USERNAME; const oldPassword = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_USERNAME = "target-admin"; process.env.ADMIN_PASSWORD = "test-password";
    let executed = null;
    const runtime = createAdminServer({ port: 0, executeCommand: async (payload) => { executed = payload; return { ok: true }; } });
    await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve)); const port = runtime.server.address().port;
    t.after(() => { runtime.server.close(); process.env.ADMIN_USERNAME = oldUsername; process.env.ADMIN_PASSWORD = oldPassword; });
    const login = await request(port, "POST", "/zalobot/api/admin/auth/login", { username: "target-admin", password: "test-password" });
    const cookie = String(login.headers["set-cookie"][0]).split(";")[0];

    await request(port, "POST", "/zalobot/api/admin/chats", { chatId: "target-private-chat", chatType: "private", displayName: "Target User One" }, cookie);
    await request(port, "POST", "/zalobot/api/admin/users", { chatId: "target-private-chat", userId: "target-user-1", displayName: "Target User One", chatTitle: "Target User One", chatType: "private" }, cookie);
    await request(port, "POST", "/zalobot/api/admin/chats", { chatId: "target-group-chat", chatType: "group", displayName: "Target Group" }, cookie);

    const list = await request(port, "GET", "/zalobot/api/admin/target-users", null, cookie);
    assert.equal(list.status, 200);
    const entry = list.body.users.find((item) => item.userId === "target-user-1");
    assert.ok(entry, "danh sách phải chứa User ID thật đã tương tác");
    assert.equal(entry.displayName, "Target User One");
    assert.equal(entry.targetChatId, "target-private-chat");
    assert.equal(entry.targetChatHint, "private");
    assert.ok(!list.body.users.some((item) => item.userId === "target-group-chat"), "Chat ID của nhóm không được lọt vào danh sách user");

    const rejected = await request(port, "POST", "/zalobot/api/admin/commands", { command: "/help", targetUserId: "target-group-chat" }, cookie);
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /Chat ID của một nhóm/);

    const accepted = await request(port, "POST", "/zalobot/api/admin/commands", { command: "/help", targetUserId: "target-user-1", targetChatId: "target-private-chat" }, cookie);
    assert.equal(accepted.status, 200);
    assert.equal(executed.target.userId, "target-user-1");
    assert.equal(executed.target.chatId, "target-private-chat");
    assert.equal(executed.target.displayName, "Target User One");
});

// ---------------------------------------------------------------------------
// Thông báo MỘT LẦN qua API quản trị.
//
// Đây là đường DUY NHẤT gửi được phần ZCA: hàm gửi phải chạy bên trong tiến trình
// đang giữ phiên. Vì vậy các endpoint này rất nhạy cảm — phải nằm sau requireAdmin
// và bắt buộc xác nhận tường minh mới gửi thật.
// ---------------------------------------------------------------------------
test("announcement endpoints yêu cầu đăng nhập admin", async (t) => {
    preserveRuntimeFiles(t);
    const oldUsername = process.env.ADMIN_USERNAME;
    const oldPassword = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_USERNAME = "ann-admin";
    process.env.ADMIN_PASSWORD = "test-password";
    const runtime = createAdminServer({ port: 0, previewAnnouncement: async () => ({ ok: true }) });
    await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    const port = runtime.server.address().port;
    t.after(() => { runtime.server.close(); process.env.ADMIN_USERNAME = oldUsername; process.env.ADMIN_PASSWORD = oldPassword; });

    const preview = await request(port, "GET", "/zalobot/api/admin/announcement/preview");
    assert.equal(preview.status, 401, "chưa đăng nhập không được xem trước");
    const send = await request(port, "POST", "/zalobot/api/admin/announcement/send", { confirm: true });
    assert.equal(send.status, 401, "chưa đăng nhập không được gửi");
    const status = await request(port, "GET", "/zalobot/api/admin/announcement/status");
    assert.equal(status.status, 401);
});

test("announcement preview trả số liệu và KHÔNG gọi gửi", async (t) => {
    preserveRuntimeFiles(t);
    const oldUsername = process.env.ADMIN_USERNAME;
    const oldPassword = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_USERNAME = "ann-admin2";
    process.env.ADMIN_PASSWORD = "test-password";
    let sendCalled = false;
    const runtime = createAdminServer({
        port: 0,
        previewAnnouncement: async () => ({ campaignId: "reset-2026-09", recipients: 196, excluded: 46, perBot: { bot1: 104 }, planned: 196, dryRun: true }),
        sendAnnouncement: async () => { sendCalled = true; return { sent: 0 }; }
    });
    await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    const port = runtime.server.address().port;
    t.after(() => { runtime.server.close(); process.env.ADMIN_USERNAME = oldUsername; process.env.ADMIN_PASSWORD = oldPassword; });

    const login = await request(port, "POST", "/zalobot/api/admin/auth/login", { username: "ann-admin2", password: "test-password" });
    const cookie = String(login.headers["set-cookie"][0]).split(";")[0];

    const preview = await request(port, "GET", "/zalobot/api/admin/announcement/preview", null, cookie);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.recipients, 196);
    assert.equal(preview.body.excluded, 46);
    assert.equal(sendCalled, false, "xem trước tuyệt đối không được gửi");
});

test("announcement send TỪ CHỐI khi thiếu confirm: true", async (t) => {
    preserveRuntimeFiles(t);
    const oldUsername = process.env.ADMIN_USERNAME;
    const oldPassword = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_USERNAME = "ann-admin3";
    process.env.ADMIN_PASSWORD = "test-password";
    let sendCalled = false;
    const runtime = createAdminServer({
        port: 0,
        sendAnnouncement: async () => { sendCalled = true; return { sent: 1 }; }
    });
    await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    const port = runtime.server.address().port;
    t.after(() => { runtime.server.close(); process.env.ADMIN_USERNAME = oldUsername; process.env.ADMIN_PASSWORD = oldPassword; });

    const login = await request(port, "POST", "/zalobot/api/admin/auth/login", { username: "ann-admin3", password: "test-password" });
    const cookie = String(login.headers["set-cookie"][0]).split(";")[0];

    const noConfirm = await request(port, "POST", "/zalobot/api/admin/announcement/send", { campaign: "reset-2026-09" }, cookie);
    assert.equal(noConfirm.status, 400);
    assert.match(noConfirm.body.error, /xác nhận/);
    assert.equal(sendCalled, false, "thiếu xác nhận thì không được gọi hàm gửi");

    const withConfirm = await request(port, "POST", "/zalobot/api/admin/announcement/send", { campaign: "reset-2026-09", confirm: true }, cookie);
    assert.equal(withConfirm.status, 200);
    assert.equal(sendCalled, true);
});

test("announcement endpoints trả 503 khi tiến trình chưa nối hàm", async (t) => {
    preserveRuntimeFiles(t);
    const oldUsername = process.env.ADMIN_USERNAME;
    const oldPassword = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_USERNAME = "ann-admin4";
    process.env.ADMIN_PASSWORD = "test-password";
    const runtime = createAdminServer({ port: 0 });
    await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    const port = runtime.server.address().port;
    t.after(() => { runtime.server.close(); process.env.ADMIN_USERNAME = oldUsername; process.env.ADMIN_PASSWORD = oldPassword; });

    const login = await request(port, "POST", "/zalobot/api/admin/auth/login", { username: "ann-admin4", password: "test-password" });
    const cookie = String(login.headers["set-cookie"][0]).split(";")[0];

    // Fail closed: thiếu hàm thì báo chưa sẵn sàng, KHÔNG im lặng thành công.
    const preview = await request(port, "GET", "/zalobot/api/admin/announcement/preview", null, cookie);
    assert.equal(preview.status, 503);
    const send = await request(port, "POST", "/zalobot/api/admin/announcement/send", { confirm: true }, cookie);
    assert.equal(send.status, 503);
});

// ---------------------------------------------------------------------------
// Tạm dừng trợ lý AI qua API.
//
// Đây là công tắc vận hành: nếu nó chỉ đổi trạng thái ở trình duyệt thì quản trị
// viên tưởng đã tắt trợ lý trong khi trợ lý vẫn trả lời người dùng.
// ---------------------------------------------------------------------------
test("AI pause đổi được trạng thái toàn cục và theo từng cuộc trò chuyện", async (t) => {
    preserveRuntimeFiles(t);
    const oldUsername = process.env.ADMIN_USERNAME;
    const oldPassword = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_USERNAME = "pause-admin";
    process.env.ADMIN_PASSWORD = "test-password";
    const runtime = createAdminServer({ port: 0 });
    await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    const port = runtime.server.address().port;
    t.after(() => { runtime.server.close(); process.env.ADMIN_USERNAME = oldUsername; process.env.ADMIN_PASSWORD = oldPassword; });

    const login = await request(port, "POST", "/zalobot/api/admin/auth/login", { username: "pause-admin", password: "test-password" });
    const cookie = String(login.headers["set-cookie"][0]).split(";")[0];

    const initial = await request(port, "GET", "/zalobot/api/admin/ai-pause", null, cookie);
    assert.equal(initial.status, 200);
    assert.equal(initial.body.pause.anyActive, false);

    const paused = await request(port, "POST", "/zalobot/api/admin/ai-pause", { scope: "global", paused: true, minutes: 30, reason: "trực hỗ trợ" }, cookie);
    assert.equal(paused.status, 200);
    assert.equal(paused.body.pause.global.active, true);
    assert.equal(paused.body.pause.global.reason, "trực hỗ trợ");
    assert.equal(paused.body.pause.anyActive, true);

    // Trạng thái phải nằm ở máy chủ: đọc lại bằng một yêu cầu mới vẫn thấy.
    const reread = await request(port, "GET", "/zalobot/api/admin/ai-pause", null, cookie);
    assert.equal(reread.body.pause.global.active, true);

    const chatPause = await request(port, "POST", "/zalobot/api/admin/ai-pause", { scope: "chat", botId: "bot1", chatId: "chat-x", paused: true, minutes: 15 }, cookie);
    assert.equal(chatPause.status, 200);
    assert.equal(chatPause.body.pause.chats.length, 1);
    assert.equal(chatPause.body.pause.chats[0].chatId, "chat-x");

    // Thiếu botId/chatId phải bị từ chối, không được đoán bot.
    const invalid = await request(port, "POST", "/zalobot/api/admin/ai-pause", { scope: "chat", paused: true }, cookie);
    assert.equal(invalid.status, 400);

    const resumed = await request(port, "POST", "/zalobot/api/admin/ai-pause", { scope: "global", paused: false }, cookie);
    assert.equal(resumed.body.pause.global.active, false);
});

test("logs trả về nhật ký gửi tin và giới hạn đọc được", async (t) => {
    preserveRuntimeFiles(t);
    const oldUsername = process.env.ADMIN_USERNAME;
    const oldPassword = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_USERNAME = "logs-admin";
    process.env.ADMIN_PASSWORD = "test-password";
    const runtime = createAdminServer({ port: 0 });
    await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    const port = runtime.server.address().port;
    t.after(() => { runtime.server.close(); process.env.ADMIN_USERNAME = oldUsername; process.env.ADMIN_PASSWORD = oldPassword; });

    const login = await request(port, "POST", "/zalobot/api/admin/auth/login", { username: "logs-admin", password: "test-password" });
    const cookie = String(login.headers["set-cookie"][0]).split(";")[0];

    const response = await request(port, "GET", "/zalobot/api/admin/logs?limit=250", null, cookie);
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.system));
    assert.ok(Array.isArray(response.body.audit));
    assert.ok(Array.isArray(response.body.deliveries), "phải có nhật ký gửi tin để chẩn đoán sự cố gửi");
    assert.equal(response.body.deliveryStats.capacity > 0, true);
    assert.equal(response.body.limits.system, 250);
});
