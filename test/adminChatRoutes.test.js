// ============================================================================
// Regression test cho các route có tham số động của Chat Center / Help Images.
//
// Vì sao cần file riêng: đã có lỗi thật trên production — 3 route
//     GET    /api/admin/chat/messages/:botId/:chatId
//     GET    /api/admin/chat/conversations/:botId/:chatId
//     DELETE /api/admin/help-images/:mediaId
// trả 404 "Not found" dù dữ liệu tồn tại, chỉ vì ghép regex thủ công thừa một
// cấp escape (`\\\\/` thay vì `\\/`): trong regex `\\` khớp một dấu `\` THẬT nên
// pattern đòi đường dẫn bắt đầu bằng `\`.
//
// File này chạy với ADMIN_BASE_PATH="/" (đúng cấu hình production đang dùng) để
// khẳng định route khớp. Phân biệt hai loại 404:
//   - route KHÔNG khớp  → { error: "Not found" }
//   - route khớp, không có dữ liệu → { error: "Conversation not found" } ...
// ============================================================================

// Phải đặt TRƯỚC khi require adminServer: API_PREFIX là const cấp module.
process.env.ADMIN_BASE_PATH = "/";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const path = require("node:path");

// Cách ly khỏi file JSON thật ở gốc dự án (xem giải thích ở adminServer.test.js).
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

function request(port, method, urlPath, body = null, cookie = "", extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: "127.0.0.1",
            port,
            method,
            path: urlPath,
            headers: {
                ...(body ? { "Content-Type": "application/json" } : {}),
                ...(cookie ? { Cookie: cookie } : {}),
                ...extraHeaders
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

// Khởi động server + đăng nhập một lần cho cả file.
async function startServer(t, extraOptions = {}) {
    const oldUsername = process.env.ADMIN_USERNAME;
    const oldPassword = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_USERNAME = "route-test-admin";
    process.env.ADMIN_PASSWORD = "route-test-password";

    memoryFiles.clear();
    const runtime = createAdminServer({ port: 0, ...extraOptions });
    await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    const port = runtime.server.address().port;

    t.after(() => {
        runtime.server.close();
        process.env.ADMIN_USERNAME = oldUsername;
        process.env.ADMIN_PASSWORD = oldPassword;
    });

    const login = await request(port, "POST", "/api/admin/auth/login", {
        username: "route-test-admin",
        password: "route-test-password"
    });
    assert.equal(login.status, 200, "login phải thành công để test route có auth");
    const cookie = String(login.headers["set-cookie"][0]).split(";")[0];

    return { port, cookie };
}

test("GET /api/admin/chat/messages/:botId/:chatId khớp route (không 404 'Not found')", async (t) => {
    const { port, cookie } = await startServer(t);

    const response = await request(port, "GET", "/api/admin/chat/messages/bot1/1799a8f733bddae383ac?limit=50", null, cookie);

    assert.equal(response.status, 200, `mong 200, nhận ${response.status}: ${response.raw}`);
    assert.notEqual(response.body?.error, "Not found", "route không được rơi vào nhánh 404 chung");
    assert.ok(Array.isArray(response.body?.messages), "phải trả mảng messages");
});

test("GET chat/messages chấp nhận botId ZCA đã URL-encode", async (t) => {
    const { port, cookie } = await startServer(t);

    const response = await request(port, "GET", "/api/admin/chat/messages/zca%3A777000777/chat-1?limit=50", null, cookie);

    assert.equal(response.status, 200, `mong 200, nhận ${response.status}: ${response.raw}`);
    assert.ok(Array.isArray(response.body?.messages));
});

test("GET chat/messages nhận chatId có ký tự đặc biệt", async (t) => {
    const { port, cookie } = await startServer(t);

    // chatId thật của Zalo có thể chứa ':', '_', '-'. Không được cắt ở '/' đầu tiên.
    const response = await request(port, "GET", "/api/admin/chat/messages/bot2/group%3A123_abc-def?limit=10", null, cookie);

    assert.equal(response.status, 200, `mong 200, nhận ${response.status}: ${response.raw}`);
    assert.ok(Array.isArray(response.body?.messages));
});

test("GET chat/conversations/:botId/:chatId khớp route (404 là 'Conversation not found')", async (t) => {
    const { port, cookie } = await startServer(t);

    const response = await request(port, "GET", "/api/admin/chat/conversations/bot1/chat-1", null, cookie);

    // Không có Firestore trong test ⇒ không có hội thoại ⇒ 404 nghiệp vụ.
    assert.equal(response.status, 404);
    assert.equal(response.body?.error, "Conversation not found",
        `route phải khớp rồi mới trả 404 nghiệp vụ, nhận: ${response.raw}`);
});

test("DELETE /api/admin/help-images/:mediaId khớp route (404 là 'Không tìm thấy ảnh')", async (t) => {
    const { port, cookie } = await startServer(t);

    const response = await request(port, "DELETE", "/api/admin/help-images/0123456789abcdef0123456789abcdef", null, cookie);

    assert.equal(response.status, 404);
    assert.match(String(response.body?.error || ""), /Không tìm thấy ảnh/,
        `route phải khớp rồi mới trả 404 nghiệp vụ, nhận: ${response.raw}`);
});

test("POST /api/admin/chat/send khớp route (503 vì test chưa nối hàm gửi)", async (t) => {
    const { port, cookie } = await startServer(t);

    const response = await request(port, "POST", "/api/admin/chat/send", { botId: "bot1", chatId: "chat-1", text: "hi" }, cookie);

    assert.equal(response.status, 503);
    assert.notEqual(response.body?.error, "Not found", "route phải khớp, không rơi vào 404 chung");
});

test("GET /api/admin/chat/unread khớp route", async (t) => {
    const { port, cookie } = await startServer(t);

    const response = await request(port, "GET", "/api/admin/chat/unread", null, cookie);

    assert.equal(response.status, 200);
    assert.equal(typeof response.body?.count, "number");
});

test("route chat không bị nhầm với nhau", async (t) => {
    const { port, cookie } = await startServer(t);

    // /chat/conversations (danh sách) vẫn phải trả danh sách, không bị route
    // chi tiết nuốt mất.
    const list = await request(port, "GET", "/api/admin/chat/conversations", null, cookie);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body?.conversations));

    // /chat/messages thiếu chatId ⇒ 404 chung là ĐÚNG (route cần 2 tham số).
    const incomplete = await request(port, "GET", "/api/admin/chat/messages/bot1", null, cookie);
    assert.equal(incomplete.status, 404);
    assert.equal(incomplete.body?.error, "Not found");
});

/* ==========================================================================
   Origin công khai cho media

   Bot chính thức gửi ảnh/tệp bằng URL, và máy chủ Zalo phải tự tải URL đó. Nếu
   ta dựng URL từ localhost thì việc gửi luôn thất bại. Origin phải lấy từ chính
   request đang phục vụ dashboard.
   ========================================================================== */

test("chat/send truyền origin thật của request xuống tầng gửi", async (t) => {
    let captured = null;
    const { port, cookie } = await startServer(t, {
        sendChatMessage: async (input) => { captured = input; return { sent: true }; }
    });

    const response = await request(port, "POST", "/api/admin/chat/send",
        { botId: "bot1", chatId: "chat-1", text: "xin chào" }, cookie);

    assert.equal(response.status, 200);
    assert.ok(captured, "tầng gửi phải được gọi");
    assert.equal(captured.publicBaseUrl, `http://127.0.0.1:${port}`);
});

test("chat/send tôn trọng X-Forwarded-Proto khi đi qua proxy https", async (t) => {
    let captured = null;
    const { port, cookie } = await startServer(t, {
        sendChatMessage: async (input) => { captured = input; return { sent: true }; }
    });

    await request(port, "POST", "/api/admin/chat/send",
        { botId: "bot1", chatId: "chat-1", text: "qua proxy" }, cookie,
        { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "zalobot.example.com" });

    assert.equal(captured.publicBaseUrl, "https://zalobot.example.com");
});

test("chat/send gửi tệp cũng nhận origin công khai", async (t) => {
    let captured = null;
    const { port, cookie } = await startServer(t, {
        sendChatFile: async (input) => { captured = input; return { sent: true }; }
    });

    const response = await request(port, "POST", "/api/admin/chat/send",
        { botId: "bot1", chatId: "chat-1", fileMediaId: "0".repeat(32) }, cookie);

    assert.equal(response.status, 200);
    assert.ok(captured, "tầng gửi tệp phải được gọi");
    assert.match(String(captured.publicBaseUrl), /^http:\/\/127\.0\.0\.1:\d+$/);
});

test("Host lạ không được ghép vào URL gửi cho Zalo", async (t) => {
    let captured = null;
    const { port, cookie } = await startServer(t, {
        sendChatMessage: async (input) => { captured = input; return { sent: true }; }
    });

    await request(port, "POST", "/api/admin/chat/send",
        { botId: "bot1", chatId: "chat-1", text: "host độc" }, cookie,
        { Host: "evil.example.com/<script>" });

    // Host không hợp lệ ⇒ không dựng được origin ⇒ chuỗi rỗng, không phải URL rác.
    assert.equal(captured.publicBaseUrl, "");
});

/* ==========================================================================
   Chẩn đoán gửi ảnh hướng dẫn
   ========================================================================== */

test("help-images/diagnostics trả mặc định khi tiến trình chưa nối hàm", async (t) => {
    const { port, cookie } = await startServer(t);

    const response = await request(port, "GET", "/api/admin/help-images/diagnostics", null, cookie);

    assert.equal(response.status, 200);
    assert.equal(response.body.publicOriginKnown, false);
    assert.equal(response.body.lastFailure, null);
});

test("help-images/diagnostics trả đúng dữ liệu tiến trình cung cấp", async (t) => {
    const { port, cookie } = await startServer(t, {
        getHelpMediaDiagnostics: () => ({
            publicOrigin: "https://zalobot.example.com",
            publicOriginKnown: true,
            lastFailure: {
                at: "2026-11-10T00:00:00.000Z",
                command: "help",
                mediaId: "a".repeat(32),
                url: "https://zalobot.example.com/api/media/" + "a".repeat(32),
                error: "400 Bad Request"
            }
        })
    });

    const response = await request(port, "GET", "/api/admin/help-images/diagnostics", null, cookie);

    assert.equal(response.status, 200);
    assert.equal(response.body.publicOrigin, "https://zalobot.example.com");
    assert.equal(response.body.lastFailure.error, "400 Bad Request");
});

test("help-images/diagnostics yêu cầu đăng nhập", async (t) => {
    const { port } = await startServer(t);
    const response = await request(port, "GET", "/api/admin/help-images/diagnostics");
    assert.equal(response.status, 401);
});

test("help-images/probe từ chối mediaId không hợp lệ", async (t) => {
    const { port, cookie } = await startServer(t);

    const response = await request(port, "POST", "/api/admin/help-images/probe", { mediaId: "abc" }, cookie);
    assert.equal(response.status, 400);
    assert.match(String(response.body?.error), /mediaId/);
});

test("help-images/probe trả trạng thái bản ghi/tệp/URL", async (t) => {    const mediaId = "a".repeat(32);
    const { port, cookie } = await startServer(t, {
        buildMediaPublicUrl: (id) => `https://zalobot.example.com/api/media/${id}`,
        probeMediaUrl: async (targetUrl) => ({ ok: true, status: 200, contentType: "image/jpeg" })
    });

    const response = await request(port, "POST", "/api/admin/help-images/probe", { mediaId }, cookie);

    assert.equal(response.status, 200);
    assert.equal(response.body.mediaId, mediaId);
    // Không có Firestore trong test ⇒ không có bản ghi, nhưng hình dạng phải đúng.
    assert.equal(typeof response.body.recordExists, "boolean");
    assert.equal(typeof response.body.fileExists, "boolean");
    assert.equal(response.body.url, `https://zalobot.example.com/api/media/${mediaId}`);
    assert.equal(response.body.probe.ok, true);
});

/* ==========================================================================
   Route media phải nhận CẢ HAI dạng URL

   Zalo Bot Platform từ chối URL ảnh không có phần mở rộng ("File not found"),
   nên đường gửi ảnh sinh URL dạng /api/media/<id>.png. Đường dẫn không đuôi vẫn
   phải chạy để không phá các liên kết đã phát ra trước đó.
   ========================================================================== */

test("route media nhận URL có đuôi tệp", async (t) => {
    const { port } = await startServer(t);
    const mediaId = "a".repeat(32);

    const response = await request(port, "GET", `/api/media/${mediaId}.png`);

    // Không có tệp trong test ⇒ 404 nghiệp vụ. Điều cần chốt là route KHỚP,
    // không rơi vào 404 chung của server.
    assert.equal(response.status, 404);
    assert.equal(response.body?.error, "Media not found");
});

test("route media vẫn nhận URL không đuôi", async (t) => {
    const { port } = await startServer(t);
    const mediaId = "b".repeat(32);

    const response = await request(port, "GET", `/api/media/${mediaId}`);

    assert.equal(response.status, 404);
    assert.equal(response.body?.error, "Media not found");
});

test("route media từ chối id không phải 32 ký tự hex", async (t) => {
    const { port } = await startServer(t);

    const response = await request(port, "GET", "/api/media/abc.png");

    // Không khớp route media ⇒ 404 JSON, KHÔNG được trả "Media not found"
    // (và cũng không được rơi xuống trang HTML của dashboard).
    assert.equal(response.status, 404);
    assert.equal(response.body?.error, "Not found");
});
