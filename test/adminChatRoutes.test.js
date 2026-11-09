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

// Khởi động server + đăng nhập một lần cho cả file.
async function startServer(t) {
    const oldUsername = process.env.ADMIN_USERNAME;
    const oldPassword = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_USERNAME = "route-test-admin";
    process.env.ADMIN_PASSWORD = "route-test-password";

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
