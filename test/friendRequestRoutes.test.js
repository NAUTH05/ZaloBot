// ============================================================================
// Test cho API quản lý lời mời kết bạn.
//
// Dùng dịch vụ GIẢ nên kiểm thử được phần HTTP: xác thực, mã trạng thái, tham số
// truyền xuống, và việc client không thể tự khai danh tính người thao tác.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

process.env.ADMIN_USERNAME = "fr-route-admin";
process.env.ADMIN_PASSWORD = "fr-route-password";

const { createAdminServer, BASE_PATH } = require("../adminServer");

const API = `${BASE_PATH === "/" ? "" : BASE_PATH}/api/admin`;

function request(port, method, path, body = null, cookie = "") {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: "127.0.0.1",
            port,
            method,
            path,
            headers: {
                ...(body ? { "Content-Type": "application/json" } : {}),
                ...(cookie ? { Cookie: cookie } : {})
            }
        }, (response) => {
            let payload = "";
            response.on("data", (chunk) => { payload += chunk; });
            response.on("end", () => {
                let parsed = null;
                try { parsed = payload ? JSON.parse(payload) : null; } catch (_) { parsed = null; }
                resolve({ status: response.statusCode, body: parsed, cookie: String(response.headers["set-cookie"] || "") });
            });
        });
        req.on("error", reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// Dịch vụ giả: ghi lại mọi lời gọi để kiểm tra route chuyển đúng tham số.
function makeService(overrides = {}) {
    const calls = { accept: [], reject: [], settings: [], sync: [], test: [], retry: [] };
    const state = { settings: { mode: "manual" }, pending: [], history: [], accounts: [], recipients: {} };
    return {
        calls,
        state,
        getState: () => ({ ...state }),
        accept: async (requestId, options) => {
            calls.accept.push({ requestId, options });
            if (overrides.accept) return overrides.accept(requestId, options);
            return { ok: true, status: "accepted", state };
        },
        reject: async (requestId, options) => {
            calls.reject.push({ requestId, options });
            if (overrides.reject) return overrides.reject(requestId, options);
            return { ok: true, status: "rejected", state };
        },
        updateSettings: (patch, meta) => {
            calls.settings.push({ patch, meta });
            return { ...state.settings, ...patch };
        },
        syncAccount: async (botId, options) => {
            calls.sync.push({ botId, options });
            return { ok: true, accountId: botId, added: 1 };
        },
        refresh: async () => {
            calls.sync.push({ botId: null });
            return { ok: true, accounts: [{ accountId: "zca:1", added: 2 }] };
        },
        testNotification: async (channel) => {
            calls.test.push(channel);
            return { ok: channel === "official", channel, chatId: "owner-chat" };
        },
        retryNotification: async (requestId, channel, options) => {
            calls.retry.push({ requestId, channel, options });
            return { ok: true, channel };
        }
    };
}

async function startServer(t, service) {
    const runtime = createAdminServer({ port: 0, friendRequestService: service });
    await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    const port = runtime.server.address().port;
    const login = await request(port, "POST", `${API}/auth/login`, {
        username: process.env.ADMIN_USERNAME,
        password: process.env.ADMIN_PASSWORD
    });
    const cookie = login.cookie.split(";")[0];
    t.after(() => new Promise((resolve) => runtime.server.close(resolve)));
    return { port, cookie };
}

// ---------------------------------------------------------------------------

test("mọi route lời mời kết bạn đều yêu cầu đăng nhập", async (t) => {
    const service = makeService();
    const runtime = createAdminServer({ port: 0, friendRequestService: service });
    await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    const port = runtime.server.address().port;
    t.after(() => new Promise((resolve) => runtime.server.close(resolve)));

    const routes = [
        ["GET", `${API}/friend-requests`],
        ["POST", `${API}/friend-requests/sync`],
        ["POST", `${API}/friend-requests/accept`],
        ["POST", `${API}/friend-requests/reject`],
        ["POST", `${API}/friend-requests/settings`],
        ["POST", `${API}/friend-requests/test-notification`],
        ["POST", `${API}/friend-requests/retry-notification`]
    ];

    for (const [method, path] of routes) {
        const response = await request(port, method, path, method === "POST" ? {} : null);
        assert.equal(response.status, 401, `${method} ${path} phải trả 401 khi chưa đăng nhập`);
    }
    assert.equal(service.calls.accept.length, 0, "không thao tác nào được chạy khi chưa đăng nhập");
    assert.equal(service.calls.settings.length, 0);
});

test("đọc trạng thái trả về hàng chờ, lịch sử và cài đặt", async (t) => {
    const service = makeService();
    const { port, cookie } = await startServer(t, service);

    const response = await request(port, "GET", `${API}/friend-requests`, null, cookie);

    assert.equal(response.status, 200);
    assert.ok(response.body.pending);
    assert.ok(response.body.history);
    assert.ok(response.body.settings);
});

test("chấp nhận: chuyển đúng requestId và dùng danh tính từ PHIÊN", async (t) => {
    const service = makeService();
    const { port, cookie } = await startServer(t, service);

    const response = await request(port, "POST", `${API}/friend-requests/accept`, {
        requestId: "zca::zca:1001::555",
        // Client cố khai mình là người khác — phải bị bỏ qua.
        actor: "ke-gia-mao"
    }, cookie);

    assert.equal(response.status, 200);
    assert.equal(service.calls.accept.length, 1);
    assert.equal(service.calls.accept[0].requestId, "zca::zca:1001::555");
    assert.equal(service.calls.accept[0].options.actor, process.env.ADMIN_USERNAME);
});

test("chấp nhận thiếu requestId bị từ chối với 400", async (t) => {
    const service = makeService();
    const { port, cookie } = await startServer(t, service);

    const response = await request(port, "POST", `${API}/friend-requests/accept`, {}, cookie);

    assert.equal(response.status, 400);
    assert.match(response.body.error, /requestId/);
    assert.equal(service.calls.accept.length, 0);
});

test("lời mời đã xử lý trả 409 chứ không phải 200", async (t) => {
    const service = makeService({
        accept: async () => ({ ok: false, reason: "already_processed", error: "Lời mời đã được xử lý." })
    });
    const { port, cookie } = await startServer(t, service);

    const response = await request(port, "POST", `${API}/friend-requests/accept`, { requestId: "x" }, cookie);

    assert.equal(response.status, 409);
    assert.equal(response.body.ok, false);
});

test("lời mời không tồn tại trả 404", async (t) => {
    const service = makeService({ accept: async () => ({ ok: false, reason: "not_found" }) });
    const { port, cookie } = await startServer(t, service);

    const response = await request(port, "POST", `${API}/friend-requests/accept`, { requestId: "khong-co" }, cookie);

    assert.equal(response.status, 404);
});

test("lưu cài đặt: chuyển tiếp bản vá xuống dịch vụ", async (t) => {
    const service = makeService();
    const { port, cookie } = await startServer(t, service);

    const response = await request(port, "POST", `${API}/friend-requests/settings`, {
        mode: "auto",
        autoAccept: { maxPerHour: 3 }
    }, cookie);

    assert.equal(response.status, 200);
    assert.equal(service.calls.settings.length, 1);
    assert.equal(service.calls.settings[0].patch.mode, "auto");
    assert.equal(service.calls.settings[0].meta.actor, process.env.ADMIN_USERNAME);
});

test("đồng bộ không có botId thì làm mới mọi tài khoản", async (t) => {
    const service = makeService();
    const { port, cookie } = await startServer(t, service);

    const response = await request(port, "POST", `${API}/friend-requests/sync`, {}, cookie);

    assert.equal(response.status, 200);
    assert.equal(service.calls.sync.length, 1);
    assert.equal(service.calls.sync[0].botId, null);
});

test("đồng bộ có botId thì chỉ định đúng tài khoản", async (t) => {
    const service = makeService();
    const { port, cookie } = await startServer(t, service);

    await request(port, "POST", `${API}/friend-requests/sync`, { botId: "zca:1001" }, cookie);

    assert.equal(service.calls.sync[0].botId, "zca:1001");
});

test("gửi thử trả 400 khi kênh không gửi được", async (t) => {
    const service = makeService();
    const { port, cookie } = await startServer(t, service);

    const response = await request(port, "POST", `${API}/friend-requests/test-notification`, { channel: "zca" }, cookie);

    assert.equal(response.status, 400);
    assert.equal(response.body.ok, false);
    assert.equal(service.calls.test[0], "zca");
});

test("gửi lại thông báo cần requestId", async (t) => {
    const service = makeService();
    const { port, cookie } = await startServer(t, service);

    const missing = await request(port, "POST", `${API}/friend-requests/retry-notification`, { channel: "zca" }, cookie);
    assert.equal(missing.status, 400);

    const ok = await request(port, "POST", `${API}/friend-requests/retry-notification`, { requestId: "a", channel: "zca" }, cookie);
    assert.equal(ok.status, 200);
    assert.equal(service.calls.retry.length, 1);
    assert.equal(service.calls.retry[0].channel, "zca");
});

test("khi tính năng chưa sẵn sàng, route trả 503 thay vì treo", async (t) => {
    const runtime = createAdminServer({ port: 0 });
    await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    const port = runtime.server.address().port;
    t.after(() => new Promise((resolve) => runtime.server.close(resolve)));

    const login = await request(port, "POST", `${API}/auth/login`, {
        username: process.env.ADMIN_USERNAME,
        password: process.env.ADMIN_PASSWORD
    });
    const cookie = login.cookie.split(";")[0];

    const response = await request(port, "GET", `${API}/friend-requests`, null, cookie);

    assert.equal(response.status, 503);
});
