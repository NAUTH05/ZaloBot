// ============================================================================
// Test cho API quản lý lời mời kết bạn.
//
// Dùng dịch vụ GIẢ nên kiểm thử được phần HTTP: xác thực, mã trạng thái, tham số
// truyền xuống, và việc client không thể tự khai danh tính người thao tác.
//
// MỘT server cho cả tệp, không phải mỗi bài một server.
//
// Vì sao: dựng rồi đóng server cho từng bài khiến cổng được nhả ra và cấp lại liên
// tục, còn `http.globalAgent` (Node 19+) giữ keep-alive nên socket có thể trỏ tới
// server của bài trước — biểu hiện là 400/500 ngẫu nhiên, mỗi lần một bài khác
// nhau, và chỉ hiện khi chạy cả bộ test. Một server cố định loại bỏ hẳn lớp lỗi đó.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

process.env.ADMIN_USERNAME = "fr-route-admin";
process.env.ADMIN_PASSWORD = "fr-route-password";

// Audit ghi ra tệp riêng trong thư mục tạm.
//
// Mặc định adminServer ghi adminAudit.json NGAY TRONG thư mục dự án. Nhiều tiến
// trình test chạy song song cùng ghi tệp đó sẽ làm nó hỏng (hai JSON nối nhau,
// hoặc EPERM khi rename trên Windows), và khi đó mọi request đều lỗi.
const fs = require("fs");
const os = require("os");
const path = require("path");
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-fr-routes-"));
process.env.ADMIN_AUDIT_FILE = path.join(testDir, "adminAudit.json");

const { createAdminServer, BASE_PATH } = require("../adminServer");

const API = `${BASE_PATH === "/" ? "" : BASE_PATH}/api/admin`;

function request(port, method, path, body = null, cookie = "") {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: "127.0.0.1",
            port,
            method,
            path,
            // Kết nối mới cho mỗi request: không để socket cũ được tái sử dụng.
            agent: false,
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

// ---------------------------------------------------------------------------
// Dịch vụ giả — hành vi đổi được theo từng bài
// ---------------------------------------------------------------------------

const state = { settings: { mode: "manual" }, pending: [], history: [], accounts: [], recipients: {} };

const service = {
    calls: { accept: [], reject: [], settings: [], sync: [], test: [], retry: [], welcome: [] },
    behavior: {},
    getState: () => ({ ...state }),
    async accept(requestId, options) {
        service.calls.accept.push({ requestId, options });
        if (service.behavior.accept) return service.behavior.accept(requestId, options);
        return { ok: true, status: "accepted", state };
    },
    async reject(requestId, options) {
        service.calls.reject.push({ requestId, options });
        if (service.behavior.reject) return service.behavior.reject(requestId, options);
        return { ok: true, status: "rejected", state };
    },
    updateSettings(patch, meta) {
        service.calls.settings.push({ patch, meta });
        return { ...state.settings, ...patch };
    },
    async syncAccount(botId, options) {
        service.calls.sync.push({ botId, options });
        return { ok: true, accountId: botId, added: 1 };
    },
    async refresh() {
        service.calls.sync.push({ botId: null });
        return { ok: true, accounts: [{ accountId: "zca:1", added: 2 }] };
    },
    async testNotification(channel) {
        service.calls.test.push(channel);
        return { ok: channel === "official", channel, chatId: "owner-chat" };
    },
    async retryNotification(requestId, channel, options) {
        service.calls.retry.push({ requestId, channel, options });
        return { ok: true, channel };
    },
    async sendWelcomeFor(requestId, options) {
        service.calls.welcome.push({ requestId, options });
        if (service.behavior.welcome) return service.behavior.welcome(requestId, options);
        return { ok: true, chatId: "555", state };
    }
};

function resetService() {
    for (const key of Object.keys(service.calls)) service.calls[key].length = 0;
    service.behavior = {};
}

// ---------------------------------------------------------------------------
// Server dùng chung
// ---------------------------------------------------------------------------

let server = null;
let port = 0;
let cookie = "";

test.before(async () => {
    const runtime = createAdminServer({ port: 0, friendRequestService: service });
    server = runtime.server;
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;

    const login = await request(port, "POST", `${API}/auth/login`, {
        username: process.env.ADMIN_USERNAME,
        password: process.env.ADMIN_PASSWORD
    });
    assert.equal(login.status, 200, `đăng nhập phải thành công, nhận ${login.status}`);
    cookie = login.cookie.split(";")[0];
    assert.ok(cookie, "phải nhận được cookie phiên");
});

test.after(async () => {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
    server = null;
});

test.beforeEach(() => resetService());

// ---------------------------------------------------------------------------

test("mọi route lời mời kết bạn đều yêu cầu đăng nhập", async () => {
    const routes = [
        ["GET", `${API}/friend-requests`],
        ["POST", `${API}/friend-requests/sync`],
        ["POST", `${API}/friend-requests/accept`],
        ["POST", `${API}/friend-requests/reject`],
        ["POST", `${API}/friend-requests/settings`],
        ["POST", `${API}/friend-requests/test-notification`],
        ["POST", `${API}/friend-requests/retry-notification`],
        ["POST", `${API}/friend-requests/send-welcome`]
    ];

    for (const [method, path] of routes) {
        const response = await request(port, method, path, method === "POST" ? {} : null);
        assert.equal(response.status, 401, `${method} ${path} phải trả 401 khi chưa đăng nhập`);
    }
    assert.equal(service.calls.accept.length, 0, "không thao tác nào được chạy khi chưa đăng nhập");
    assert.equal(service.calls.settings.length, 0);
});

test("đọc trạng thái trả về hàng chờ, lịch sử và cài đặt", async () => {
    const response = await request(port, "GET", `${API}/friend-requests`, null, cookie);

    assert.equal(response.status, 200);
    assert.ok(response.body.pending);
    assert.ok(response.body.history);
    assert.ok(response.body.settings);
});

test("chấp nhận: chuyển đúng requestId và dùng danh tính từ PHIÊN", async () => {
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

test("chấp nhận thiếu requestId bị từ chối với 400", async () => {
    const response = await request(port, "POST", `${API}/friend-requests/accept`, {}, cookie);

    assert.equal(response.status, 400);
    assert.match(response.body.error, /requestId/);
    assert.equal(service.calls.accept.length, 0);
});

test("lời mời đã xử lý trả 409 chứ không phải 200", async () => {
    service.behavior.accept = async () => ({ ok: false, reason: "already_processed", error: "Lời mời đã được xử lý." });

    const response = await request(port, "POST", `${API}/friend-requests/accept`, { requestId: "x" }, cookie);

    assert.equal(response.status, 409);
    assert.equal(response.body.ok, false);
});

test("lời mời không tồn tại trả 404", async () => {
    service.behavior.accept = async () => ({ ok: false, reason: "not_found" });

    const response = await request(port, "POST", `${API}/friend-requests/accept`, { requestId: "khong-co" }, cookie);

    assert.equal(response.status, 404);
});

test("lưu cài đặt: chuyển tiếp bản vá xuống dịch vụ", async () => {
    const response = await request(port, "POST", `${API}/friend-requests/settings`, {
        mode: "auto",
        autoAccept: { maxPerHour: 3 }
    }, cookie);

    assert.equal(response.status, 200);
    assert.equal(service.calls.settings.length, 1);
    assert.equal(service.calls.settings[0].patch.mode, "auto");
    assert.equal(service.calls.settings[0].meta.actor, process.env.ADMIN_USERNAME);
});

test("đồng bộ không có botId thì làm mới mọi tài khoản", async () => {
    const response = await request(port, "POST", `${API}/friend-requests/sync`, {}, cookie);

    assert.equal(response.status, 200);
    assert.equal(service.calls.sync.length, 1);
    assert.equal(service.calls.sync[0].botId, null);
});

test("đồng bộ có botId thì chỉ định đúng tài khoản", async () => {
    await request(port, "POST", `${API}/friend-requests/sync`, { botId: "zca:1001" }, cookie);

    assert.equal(service.calls.sync[0].botId, "zca:1001");
});

test("gửi thử trả 400 khi kênh không gửi được", async () => {
    const response = await request(port, "POST", `${API}/friend-requests/test-notification`, { channel: "zca" }, cookie);

    assert.equal(response.status, 400);
    assert.equal(response.body.ok, false);
    assert.equal(service.calls.test[0], "zca");
});

test("gửi lại thông báo cần requestId", async () => {
    const missing = await request(port, "POST", `${API}/friend-requests/retry-notification`, { channel: "zca" }, cookie);
    assert.equal(missing.status, 400);

    const ok = await request(port, "POST", `${API}/friend-requests/retry-notification`, { requestId: "a", channel: "zca" }, cookie);
    assert.equal(ok.status, 200);
    assert.equal(service.calls.retry.length, 1);
    assert.equal(service.calls.retry[0].channel, "zca");
});

test("gửi tin chào: chuyển requestId và dùng danh tính từ PHIÊN", async () => {
    const response = await request(port, "POST", `${API}/friend-requests/send-welcome`, {
        requestId: "zca::zca:1001::555",
        actor: "ke-gia-mao"
    }, cookie);

    assert.equal(response.status, 200);
    assert.equal(service.calls.welcome.length, 1);
    assert.equal(service.calls.welcome[0].requestId, "zca::zca:1001::555");
    assert.equal(service.calls.welcome[0].options.actor, process.env.ADMIN_USERNAME);
});

test("gửi tin chào thất bại trả 400 kèm lý do", async () => {
    service.behavior.welcome = async () => ({ ok: false, reason: "welcome_disabled", error: "Tin chào đang TẮT trong cài đặt." });

    const response = await request(port, "POST", `${API}/friend-requests/send-welcome`, { requestId: "x" }, cookie);

    assert.equal(response.status, 400);
    assert.match(response.body.error, /TẮT/);
});

test("khi tính năng chưa sẵn sàng, route trả 503 thay vì treo", async () => {
    // Server riêng, KHÔNG truyền friendRequestService.
    const runtime = createAdminServer({ port: 0 });
    const bare = runtime.server;
    await new Promise((resolve) => bare.listen(0, "127.0.0.1", resolve));
    const barePort = bare.address().port;
    try {
        const login = await request(barePort, "POST", `${API}/auth/login`, {
            username: process.env.ADMIN_USERNAME,
            password: process.env.ADMIN_PASSWORD
        });
        assert.equal(login.status, 200);
        const response = await request(barePort, "GET", `${API}/friend-requests`, null, login.cookie.split(";")[0]);
        assert.equal(response.status, 503);
    } finally {
        await new Promise((resolve) => bare.close(resolve));
    }
});
