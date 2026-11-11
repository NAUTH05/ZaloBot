// ============================================================================
// API đổi chế độ nhận tin của một nhóm.
//
// Endpoint này điều khiển việc bot có xử lý tin nhắn KHÔNG nhắc tới nó hay không,
// nên phải canh: chỉ quản trị viên đã đăng nhập, tham số sai bị từ chối, và phạm
// vi là (bot, chat) chứ không phải chatId trần.
//
// MỘT server cho cả tệp (xem ghi chú trong friendRequestRoutes.test.js).
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.ADMIN_USERNAME = "group-route-admin";
process.env.ADMIN_PASSWORD = "group-route-password";

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-group-route-"));
// Không ghi audit vào thư mục dự án: nhiều tiến trình test ghi song song sẽ làm
// hỏng tệp, và khi đó mọi request đều lỗi.
process.env.ADMIN_AUDIT_FILE = path.join(testDir, "adminAudit.json");

// Firestore trong bộ nhớ, cài TRƯỚC khi nạp adminServer (groupPolicy đọc qua đây).
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
        },
        flushPersistenceWrites: async () => undefined,
        getPersistenceStatus: () => ({ backend: "test" })
    }
};

const { createAdminServer, BASE_PATH } = require("../adminServer");
const groupPolicy = require("../groupPolicy");

const API = `${BASE_PATH === "/" ? "" : BASE_PATH}/api/admin`;

let server = null;
let port = 0;
let cookie = "";

function request(method, path, body = null, withCookie = "") {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: "127.0.0.1",
            port,
            method,
            path,
            agent: false,
            headers: {
                ...(body ? { "Content-Type": "application/json" } : {}),
                ...(withCookie ? { Cookie: withCookie } : {})
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

test.before(async () => {
    const runtime = createAdminServer({ port: 0 });
    server = runtime.server;
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;

    const login = await request("POST", `${API}/auth/login`, {
        username: process.env.ADMIN_USERNAME,
        password: process.env.ADMIN_PASSWORD
    });
    assert.equal(login.status, 200, "đăng nhập phải thành công để các bài sau chạy được");
    cookie = login.cookie.split(";")[0];
});

test.after(() => {
    server?.close();
});

test("chưa đăng nhập: bị chặn", async () => {
    const response = await request("POST", `${API}/group-policy`, { botId: "bot1", chatId: "g1", mode: "ingest" });
    assert.equal(response.status, 401);
    // Không được ghi gì khi chưa xác thực.
    assert.equal(groupPolicy.getChatMode({ botId: "bot1", chatId: "g1" }), "mention");
});

test("đặt chế độ cho một nhóm", async () => {
    const response = await request("POST", `${API}/group-policy`, { botId: "bot1", chatId: "g1", mode: "ingest" }, cookie);

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.mode, "ingest");
    assert.equal(groupPolicy.getChatMode({ botId: "bot1", chatId: "g1" }), "ingest");
});

test("chế độ lạ bị từ chối, không ghi", async () => {
    const response = await request("POST", `${API}/group-policy`, { botId: "bot1", chatId: "g1", mode: "traloimoitin" }, cookie);

    assert.equal(response.status, 400);
    assert.match(response.body.error, /mention, ingest/);
    assert.equal(groupPolicy.getChatMode({ botId: "bot1", chatId: "g1" }), "ingest", "giữ nguyên giá trị cũ");
});

test("thiếu chatId bị từ chối", async () => {
    const response = await request("POST", `${API}/group-policy`, { botId: "bot1", mode: "ingest" }, cookie);

    assert.equal(response.status, 400);
    assert.match(response.body.error, /botId và chatId/);
});

test("xoá ghi đè đưa nhóm về mặc định", async () => {
    const response = await request("POST", `${API}/group-policy`, { botId: "bot1", chatId: "g1", mode: null }, cookie);

    assert.equal(response.status, 200);
    assert.equal(response.body.override, false);
    assert.equal(groupPolicy.getChatMode({ botId: "bot1", chatId: "g1" }), "mention");
});

test("phạm vi theo (bot, chat): chatId trần không bị ảnh hưởng", async () => {
    await request("POST", `${API}/group-policy`, { botId: "bot1", chatId: "g1", mode: "ingest" }, cookie);

    assert.equal(groupPolicy.getChatMode({ botId: "bot2", chatId: "g1" }), "mention");
    assert.equal(groupPolicy.getChatMode({ botId: "zca:999", chatId: "g1" }), "mention");
});
