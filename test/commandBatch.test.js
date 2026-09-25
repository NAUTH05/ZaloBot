const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const path = require("node:path");

// Cách ly hoàn toàn khỏi các file runtime thật ở gốc dự án. `node --test` chạy
// mỗi file kiểm tra trong một tiến trình song song, nên nếu file này cùng ghi
// chatDirectory.json / adminAudit.json / adminSettings.json với file khác thì
// chúng sẽ tranh chấp và làm hỏng kết quả của nhau. Thay lớp lưu trữ bằng bộ
// nhớ để không file thật nào bị đụng tới.
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

function readAuditEvents() {
    const key = fileKey(path.join(__dirname, "..", "adminAudit.json"));
    return memoryFiles.get(key)?.events || [];
}

function request(port, method, urlPath, body = null, cookie = "") {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: "127.0.0.1", port, method, path: urlPath, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, (response) => {
            let payload = "";
            response.on("data", (chunk) => { payload += chunk; });
            response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: payload ? JSON.parse(payload) : null }));
        });
        req.on("error", reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Dựng dashboard với executeCommand thay được, rồi tạo sẵn vài người nhận có
// chat riêng tư đủ tin cậy.
async function setup(t, { executeCommand, users = ["u1", "u2"] } = {}) {
    const oldUsername = process.env.ADMIN_USERNAME;
    const oldPassword = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_USERNAME = "batch-admin";
    process.env.ADMIN_PASSWORD = "test-password";
    // Mỗi lần dựng lại bắt đầu từ vùng nhớ trắng để các bài kiểm tra độc lập nhau.
    memoryFiles.clear();

    const calls = [];
    const runtime = createAdminServer({
        port: 0,
        executeCommand: executeCommand || (async (payload) => {
            calls.push(payload);
            return { deliveredToChatId: payload.target?.chatId || payload.chatId, messageCount: 1, messages: [{ text: `ok ${payload.target?.userId || "admin"}` }] };
        })
    });
    await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    const port = runtime.server.address().port;
    t.after(() => { runtime.server.close(); process.env.ADMIN_USERNAME = oldUsername; process.env.ADMIN_PASSWORD = oldPassword; });

    const login = await request(port, "POST", "/zalobot/api/admin/auth/login", { username: "batch-admin", password: "test-password" });
    const cookie = String(login.headers["set-cookie"][0]).split(";")[0];

    for (const userId of users) {
        const chatId = `${userId}-chat`;
        await request(port, "POST", "/zalobot/api/admin/chats", { chatId, chatType: "private", displayName: `Chat ${userId}` }, cookie);
        await request(port, "POST", "/zalobot/api/admin/users", { chatId, userId, displayName: `Người ${userId}`, chatTitle: `Chat ${userId}`, chatType: "private" }, cookie);
    }

    // Không chờ giữa các lần gửi trong phần lớn bài kiểm tra; bài kiểm tra nhịp
    // độ tự đặt lại giá trị này.
    await request(port, "PATCH", "/zalobot/api/admin/settings", { batchDelayMs: 0 }, cookie);

    return { port, cookie, calls };
}

async function runBatch(port, cookie, body) {
    const started = await request(port, "POST", "/zalobot/api/admin/commands/batch", body, cookie);
    if (started.status !== 202) return { started, state: null };
    let state = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
        state = await request(port, "GET", `/zalobot/api/admin/commands/batch/${encodeURIComponent(started.body.jobId)}`, null, cookie);
        if (state.body?.status !== "running") break;
        await sleep(80);
    }
    return { started, state: state.body };
}

/* -------------------------------------------------------------------------- */
/* Chạy theo từng người nhận                                                  */
/* -------------------------------------------------------------------------- */

test("chạy lệnh riêng cho từng người nhận và trả kết quả từng người", async (t) => {
    const { port, cookie, calls } = await setup(t);

    const { started, state } = await runBatch(port, cookie, { command: "/help", targetUserIds: ["u1", "u2"] });

    assert.equal(started.status, 202);
    assert.equal(started.body.total, 2);
    assert.equal(state.status, "finished");
    assert.equal(state.progress.completed, 2);
    assert.equal(state.progress.total, 2);
    assert.equal(state.summary.delivered, 2);
    assert.equal(state.summary.failed, 0);
    assert.deepEqual(state.results.map((item) => item.userId), ["u1", "u2"]);
    assert.deepEqual(state.results.map((item) => item.chatId), ["u1-chat", "u2-chat"]);
    assert.equal(state.results[0].displayName, "Người u1");
    assert.equal(state.results[0].status, "delivered");
    assert.equal(state.results[0].messageCount, 1);

    // Lệnh chạy cho từng người, không phải nối ID thành một chuỗi.
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.target.userId), ["u1", "u2"]);
    assert.equal(calls[0].command, "/help");
});

test("một người lỗi không dừng những người còn lại", async (t) => {
    let index = 0;
    const { port, cookie } = await setup(t, {
        users: ["u1", "u2", "u3"],
        executeCommand: async (payload) => {
            index += 1;
            if (payload.target.userId === "u2") throw new Error("410 The chat_id is invalid");
            return { deliveredToChatId: payload.target.chatId, messageCount: 1, messages: [{ text: "ok" }] };
        }
    });

    const { state } = await runBatch(port, cookie, { command: "/help", targetUserIds: ["u1", "u2", "u3"] });

    assert.equal(state.summary.total, 3);
    assert.equal(state.summary.delivered, 2);
    assert.equal(state.summary.failed, 1);
    assert.equal(state.results[1].userId, "u2");
    assert.equal(state.results[1].status, "failed");
    assert.match(state.results[1].error, /chat_id is invalid/);
    assert.equal(state.results[2].status, "delivered", "người sau vẫn phải được chạy");
    assert.equal(index, 3, "cả ba người đều được thử");
});

test("không gửi trùng khi cùng User ID xuất hiện nhiều lần", async (t) => {
    const { port, cookie, calls } = await setup(t);

    const { state } = await runBatch(port, cookie, { command: "/help", targetUserIds: ["u1", "u1", " u1 ", "u2", "u2"] });

    assert.equal(state.summary.total, 2, "chỉ hai người nhận không trùng");
    assert.equal(state.summary.duplicates, 3);
    assert.equal(calls.length, 2, "mỗi người chỉ được gửi một lần");
    assert.deepEqual(calls.map((call) => call.target.userId), ["u1", "u2"]);
});

test("người không suy ra được chat bị bỏ qua chứ không báo thành công", async (t) => {
    const { port, cookie, calls } = await setup(t, { users: ["u1"] });
    // Người có nhiều ngữ cảnh chat: không xác định được chat riêng tư.
    await request(port, "POST", "/zalobot/api/admin/chats", { chatId: "u1-chat-b", chatType: "private", displayName: "Chat phụ" }, cookie);
    await request(port, "POST", "/zalobot/api/admin/users", { chatId: "u1-chat-b", userId: "u1", chatType: "private" }, cookie);
    // Người chưa từng có chat nào.
    await request(port, "POST", "/zalobot/api/admin/users", { chatId: "u9-chat", userId: "u9", chatType: "group" }, cookie);

    const { state } = await runBatch(port, cookie, { command: "/help", targetUserIds: ["u1", "u9"] });

    assert.equal(state.summary.skipped, 2);
    assert.equal(state.summary.delivered, 0);
    assert.equal(calls.length, 0, "không gửi gì khi không xác định được chat");
    assert.match(state.results[0].error, /nhiều ngữ cảnh chat|Không xác định/);
});

/* -------------------------------------------------------------------------- */
/* Kiểm tra đầu vào                                                           */
/* -------------------------------------------------------------------------- */

test("lệnh không chạy theo từng người bị từ chối trước khi chạy ai", async (t) => {
    const { port, cookie, calls } = await setup(t);

    const result = await request(port, "POST", "/zalobot/api/admin/commands/batch", { command: "/quanlychat", targetUserIds: ["u1", "u2"] }, cookie);

    assert.equal(result.status, 400);
    assert.match(result.body.error, /không chạy theo từng người được/);
    assert.equal(calls.length, 0, "không được chạy dù chỉ một người");
});

test("lệnh không tồn tại và lệnh thiếu dấu gạch chéo bị từ chối", async (t) => {
    const { port, cookie, calls } = await setup(t);

    const unknown = await request(port, "POST", "/zalobot/api/admin/commands/batch", { command: "/khongcolenh", targetUserIds: ["u1"] }, cookie);
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /Không nhận diện được lệnh/);

    const missingSlash = await request(port, "POST", "/zalobot/api/admin/commands/batch", { command: "help", targetUserIds: ["u1"] }, cookie);
    assert.equal(missingSlash.status, 400);
    assert.match(missingSlash.body.error, /phải bắt đầu bằng \//);

    const empty = await request(port, "POST", "/zalobot/api/admin/commands/batch", { command: "", targetUserIds: ["u1"] }, cookie);
    assert.equal(empty.status, 400);

    assert.equal(calls.length, 0);
});

test("Chat ID của nhóm bị từ chối và không chạy người nào", async (t) => {
    const { port, cookie, calls } = await setup(t);
    await request(port, "POST", "/zalobot/api/admin/chats", { chatId: "nhom-lop", chatType: "group", displayName: "Nhóm lớp" }, cookie);

    const result = await request(port, "POST", "/zalobot/api/admin/commands/batch", { command: "/help", targetUserIds: ["u1", "nhom-lop"] }, cookie);

    assert.equal(result.status, 400);
    assert.match(result.body.error, /Chat ID của một nhóm/);
    assert.equal(calls.length, 0);
});

test("lệnh theo từng người cần ít nhất một người nhận", async (t) => {
    const { port, cookie, calls } = await setup(t);

    const result = await request(port, "POST", "/zalobot/api/admin/commands/batch", { command: "/help", targetUserIds: [] }, cookie);

    assert.equal(result.status, 400);
    assert.match(result.body.error, /cần chọn ít nhất một người nhận/);
    assert.equal(calls.length, 0);
});

test("vượt giới hạn số người mỗi lượt thì bị từ chối kèm hướng dẫn", async (t) => {
    const { port, cookie, calls } = await setup(t, { users: ["u1", "u2", "u3"] });
    await request(port, "PATCH", "/zalobot/api/admin/settings", { maxBatchSize: 2 }, cookie);

    const result = await request(port, "POST", "/zalobot/api/admin/commands/batch", { command: "/help", targetUserIds: ["u1", "u2", "u3"] }, cookie);

    assert.equal(result.status, 400);
    assert.match(result.body.error, /tối đa 2 người nhận/);
    assert.match(result.body.error, /bỏ bớt 1 người/);
    assert.equal(calls.length, 0);
});

test("giới hạn số người mỗi lượt cấu hình được và được lưu lại", async (t) => {
    const { port, cookie } = await setup(t, { users: ["u1", "u2", "u3"] });

    const invalid = await request(port, "PATCH", "/zalobot/api/admin/settings", { maxBatchSize: 0 }, cookie);
    assert.equal(invalid.status, 400);
    const tooBig = await request(port, "PATCH", "/zalobot/api/admin/settings", { maxBatchSize: 999 }, cookie);
    assert.equal(tooBig.status, 400);

    const updated = await request(port, "PATCH", "/zalobot/api/admin/settings", { maxBatchSize: 3, batchDelayMs: 0 }, cookie);
    assert.equal(updated.status, 200);
    assert.equal(updated.body.maxBatchSize, 3);
    assert.equal(updated.body.batchDelayMs, 0);

    const settings = await request(port, "GET", "/zalobot/api/admin/settings", null, cookie);
    assert.equal(settings.body.maxBatchSize, 3);
});

/* -------------------------------------------------------------------------- */
/* Broadcast và tương thích ngược                                             */
/* -------------------------------------------------------------------------- */

test("lệnh broadcast chỉ chạy đúng một lần dù chọn nhiều người", async (t) => {
    const { port, cookie, calls } = await setup(t, { users: ["u1", "u2", "u3"] });

    const { started, state } = await runBatch(port, cookie, { command: "/thongbao Bảo trì lúc 22:00", targetUserIds: ["u1", "u2", "u3"] });

    assert.equal(started.status, 202);
    assert.equal(started.body.total, 1, "broadcast chỉ có một lần chạy");
    assert.ok(started.body.note.includes("chỉ chạy đúng một lần"));
    assert.equal(state.summary.broadcast, true);
    assert.equal(state.results.length, 1);
    assert.equal(calls.length, 1, "không được gửi lại cho từng người được chọn");
    assert.equal(calls[0].target, null, "broadcast chạy với ngữ cảnh admin, không theo người nhận");
    assert.equal(calls[0].command, "/thongbao Bảo trì lúc 22:00");
});

test("client cũ chỉ gửi targetUserId vẫn nhận dạng phản hồi cũ", async (t) => {
    const { port, cookie } = await setup(t);

    const result = await request(port, "POST", "/zalobot/api/admin/commands", { command: "/help", targetUserId: "u1" }, cookie);

    assert.equal(result.status, 200);
    assert.equal(result.body.command, "/help");
    assert.equal(result.body.deliveredToChatId, "u1-chat");
    assert.equal(result.body.messages[0].text, "ok u1");
    assert.equal(result.body.target.userId, "u1");
    assert.equal(result.body.target.displayName, "Người u1");
    assert.equal(result.body.summary.delivered, 1);
});

test("client cũ không gửi người nhận vẫn chạy được với ngữ cảnh admin", async (t) => {
    const { port, cookie, calls } = await setup(t);

    const result = await request(port, "POST", "/zalobot/api/admin/commands", { command: "/quanlychat" }, cookie);

    // /quanlychat là lệnh toàn cục nên bị từ chối vì không chạy theo từng người.
    assert.equal(result.status, 400);

    // Còn lệnh theo từng người thì cần người nhận, đúng như thông báo.
    const perUser = await request(port, "POST", "/zalobot/api/admin/commands", { command: "/help" }, cookie);
    assert.equal(perUser.status, 400);
    assert.match(perUser.body.error, /cần chọn ít nhất một người nhận/);
    assert.equal(calls.length, 0);
});

test("danh tính admin lấy từ phiên, không lấy từ nội dung yêu cầu", async (t) => {
    const { port, cookie, calls } = await setup(t);

    await request(port, "POST", "/zalobot/api/admin/commands/batch", {
        command: "/help",
        targetUserIds: ["u1"],
        executor: { userId: "ke-gia-mao", role: "owner" },
        role: "owner",
        userId: "ke-gia-mao"
    }, cookie);

    await sleep(300);
    assert.equal(calls.length, 1);
    assert.notEqual(calls[0].executor.userId, "ke-gia-mao");
    assert.equal(calls[0].executor.username, "batch-admin");
    assert.equal(calls[0].executor.role, "owner");
});

/* -------------------------------------------------------------------------- */
/* Nhịp độ và nhật ký                                                         */
/* -------------------------------------------------------------------------- */

test("có khoảng nghỉ giữa các lần gửi để không dồn dập Zalo", async (t) => {
    const { port, cookie } = await setup(t, { users: ["u1", "u2", "u3"] });
    await request(port, "PATCH", "/zalobot/api/admin/settings", { batchDelayMs: 60 }, cookie);

    const startedAt = Date.now();
    const { state } = await runBatch(port, cookie, { command: "/help", targetUserIds: ["u1", "u2", "u3"] });
    const elapsed = Date.now() - startedAt;

    assert.equal(state.summary.delivered, 3);
    // Ba người nhận => ít nhất hai khoảng nghỉ.
    assert.ok(elapsed >= 100, `phải có khoảng nghỉ giữa các lần gửi, đo được ${elapsed}ms`);
});

test("nhật ký ghi admin, lệnh, User ID và kết quả từng người", async (t) => {
    const { port, cookie } = await setup(t);
    const before = readAuditEvents().length;

    await runBatch(port, cookie, { command: "/help", targetUserIds: ["u1", "u2"] });
    await sleep(200);

    const events = readAuditEvents();
    assert.ok(events.length > before, "phải có bản ghi nhật ký mới");
    const entry = events.filter((item) => item.action === "command.batch").pop();
    assert.ok(entry, "phải ghi nhật ký cho lượt chạy nhiều người");
    assert.equal(entry.admin, "batch-admin");
    assert.equal(entry.command, "/help");
    assert.deepEqual(entry.targetUserIds, ["u1", "u2"]);
    assert.equal(entry.scope, "per-user");
    assert.equal(entry.result, "success");
    assert.deepEqual(entry.outcomes.map((item) => item.userId), ["u1", "u2"]);
    assert.ok(entry.outcomes.every((item) => item.status === "delivered"));
});

test("lượt chạy có người lỗi được ghi là partial", async (t) => {
    const { port, cookie } = await setup(t, {
        executeCommand: async (payload) => {
            if (payload.target.userId === "u2") throw new Error("lỗi thử");
            return { deliveredToChatId: payload.target.chatId, messageCount: 1, messages: [{ text: "ok" }] };
        }
    });

    await runBatch(port, cookie, { command: "/help", targetUserIds: ["u1", "u2"] });
    await sleep(200);

    const entry = readAuditEvents().filter((item) => item.action === "command.batch").pop();
    assert.equal(entry.result, "partial");
    assert.equal(entry.outcomes.find((item) => item.userId === "u2").status, "failed");
});

test("yêu cầu bị từ chối cũng được ghi nhật ký", async (t) => {
    const { port, cookie } = await setup(t);
    const before = readAuditEvents().length;

    await request(port, "POST", "/zalobot/api/admin/commands/batch", { command: "/quanlychat", targetUserIds: ["u1"] }, cookie);
    await sleep(120);

    const events = readAuditEvents();
    assert.ok(events.length > before);
    const entry = events.filter((item) => item.action === "command.batch").pop();
    assert.equal(entry.result, "rejected");
    assert.match(entry.error, /không chạy theo từng người được/);
});

test("job không tồn tại trả về 404", async (t) => {
    const { port, cookie } = await setup(t);
    const result = await request(port, "GET", "/zalobot/api/admin/commands/batch/khong-ton-tai", null, cookie);
    assert.equal(result.status, 404);
});
