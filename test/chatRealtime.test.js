// ============================================================================
// Test cho luồng realtime (SSE) của Chat Center.
//
// Điều quan trọng nhất cần chốt:
//   - Endpoint phải nằm SAU requireAdmin (không rò rỉ nội dung hội thoại).
//   - Trả đúng Content-Type text/event-stream và có khung "ready".
//   - Sự kiện publish trong tiến trình phải tới được client đang mở.
//   - Route không được rơi vào 404 chung (lỗi escape regex đã từng gặp).
// ============================================================================

process.env.ADMIN_BASE_PATH = "/";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const path = require("node:path");

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
const { publishChatEvent } = require("../chatEvents");

function request(port, method, urlPath, body = null, cookie = "") {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: "127.0.0.1",
            port,
            method,
            path: urlPath,
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
                resolve({ status: response.statusCode, headers: response.headers, body: parsed, raw: payload });
            });
        });
        req.on("error", reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function startServer(t) {
    const oldUsername = process.env.ADMIN_USERNAME;
    const oldPassword = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_USERNAME = "sse-admin";
    process.env.ADMIN_PASSWORD = "sse-password";

    memoryFiles.clear();
    const runtime = createAdminServer({ port: 0 });
    await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    const port = runtime.server.address().port;

    t.after(() => {
        runtime.server.close();
        process.env.ADMIN_USERNAME = oldUsername;
        process.env.ADMIN_PASSWORD = oldPassword;
    });

    const login = await request(port, "POST", "/api/admin/auth/login", {
        username: "sse-admin",
        password: "sse-password"
    });
    assert.equal(login.status, 200);
    const cookie = String(login.headers["set-cookie"][0]).split(";")[0];
    return { port, cookie };
}

// Mở luồng SSE và trả về bộ thu thập dữ liệu + hàm đóng.
function openEventStream(port, cookie) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: "127.0.0.1",
            port,
            path: "/api/admin/chat/events",
            method: "GET",
            headers: cookie ? { Cookie: cookie } : {}
        }, (response) => {
            const state = { text: "", status: response.statusCode, headers: response.headers };
            response.setEncoding("utf8");
            response.on("data", (chunk) => { state.text += chunk; });
            resolve({
                state,
                close: () => { try { req.destroy(); } catch (_) {} }
            });
        });
        req.on("error", reject);
        req.end();
    });
}

function waitFor(predicate, timeoutMs = 3000) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (predicate()) return resolve(true);
            if (Date.now() - started > timeoutMs) return reject(new Error("Hết thời gian chờ"));
            setTimeout(tick, 20);
        };
        tick();
    });
}

test("SSE yêu cầu đăng nhập admin", async (t) => {
    const { port } = await startServer(t);

    const response = await request(port, "GET", "/api/admin/chat/events");
    assert.equal(response.status, 401, "không có phiên thì phải 401, không được mở luồng");
});

test("SSE trả đúng content-type và khung ready", async (t) => {
    const { port, cookie } = await startServer(t);

    const stream = await openEventStream(port, cookie);
    t.after(stream.close);

    await waitFor(() => stream.state.text.includes("event: ready"));

    assert.equal(stream.state.status, 200);
    assert.match(String(stream.state.headers["content-type"]), /text\/event-stream/);
    assert.match(stream.state.text, /event: ready/);
    // nginx phải được bảo đừng buffer, nếu không realtime sẽ trễ.
    assert.equal(stream.state.headers["x-accel-buffering"], "no");
});

test("sự kiện publish trong tiến trình tới được client đang mở", async (t) => {
    const { port, cookie } = await startServer(t);
    const stream = await openEventStream(port, cookie);
    t.after(stream.close);

    await waitFor(() => stream.state.text.includes("event: ready"));

    publishChatEvent({
        type: "message",
        conversationId: "chat-1",
        botId: "bot1",
        chatId: "chat-1",
        direction: "inbound",
        message: { messageId: "m1", text: "xin chào", createdAt: new Date().toISOString() }
    });

    await waitFor(() => stream.state.text.includes("event: chat"));

    assert.match(stream.state.text, /"messageId":"m1"/);
    assert.match(stream.state.text, /"direction":"inbound"/);
});

test("route SSE không rơi vào 404 chung", async (t) => {
    const { port, cookie } = await startServer(t);

    // /chat/events/stats là route thường, dùng để chắc chắn prefix khớp.
    const stats = await request(port, "GET", "/api/admin/chat/events/stats", null, cookie);
    assert.equal(stats.status, 200);
    assert.notEqual(stats.body?.error, "Not found");
    assert.equal(typeof stats.body?.streams, "number");
});
