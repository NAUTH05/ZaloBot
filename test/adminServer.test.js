const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("node:fs");
const path = require("node:path");
const { createAdminServer } = require("../adminServer");

function preserveRuntimeFiles(t) {
    const names = ["adminAudit.json", "adminSettings.json", "chatDirectory.json", "interactions.json", "subscriptions.json"];
    const snapshots = names.map((name) => {
        const filePath = path.join(__dirname, "..", name);
        return { filePath, existed: fs.existsSync(filePath), content: fs.existsSync(filePath) ? fs.readFileSync(filePath) : null };
    });
    t.after(() => {
        for (const snapshot of snapshots) {
            if (snapshot.existed) fs.writeFileSync(snapshot.filePath, snapshot.content);
            else if (fs.existsSync(snapshot.filePath)) fs.rmSync(snapshot.filePath, { force: true });
        }
    });
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
    assert.ok(workspace.body.duty && Array.isArray(workspace.body.duty.schedules));
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
    const command = await request(port, "POST", "/zalobot/api/admin/commands", { command: "/quanlychat", userId: "dashboard-admin-user", chatId: "dashboard-admin-chat" }, cookie);
    assert.equal(command.status, 200);
    assert.equal(executed.command, "/quanlychat");
    assert.equal(command.body.messages[0].text, "Command result");

    const userDeleted = await request(port, "DELETE", "/zalobot/api/admin/users/dashboard-member?hard=1&chatId=dashboard-test-chat", null, cookie);
    assert.equal(userDeleted.status, 200, JSON.stringify(userDeleted.body));

    const deleted = await request(port, "DELETE", "/zalobot/api/admin/chats/dashboard-test-chat?hard=1", null, cookie);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    await request(port, "DELETE", "/zalobot/api/admin/settings/admins?id=dashboard-admin-user", null, cookie);
});
