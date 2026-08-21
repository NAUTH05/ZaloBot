const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { createAdminServer } = require("../adminServer");

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
    const page = await new Promise((resolve, reject) => http.get({ hostname: "127.0.0.1", port, path: "/zalobot/" }, (response) => { let body = ""; response.on("data", (chunk) => { body += chunk; }); response.on("end", () => resolve({ status: response.statusCode, body })); }).on("error", reject));
    assert.equal(page.status, 200);
    assert.match(page.body, /ZaloBot Admin/);
});
