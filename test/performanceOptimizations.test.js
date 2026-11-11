// ============================================================================
// Kiểm thử các tối ưu hiệu năng: gộp ghi, đối chiếu gộp, phân loại lỗi,
// hàng đợi gửi có trần, khởi động song song.
// ============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { classifyDeliveryError, computeRetryDelayMs, readErrorCode, DELIVERY_ERROR_KIND } = require("../deliveryErrors");
const { createSendQueue, createProviderQueues, PRIORITY } = require("../sendQueue");
const { createRuntimeMetrics } = require("../runtimeMetrics");

const ROOT = path.join(__dirname, "..");

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-test-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ========================================================================== */
/* A. Phân loại lỗi gửi tin (Phase 10)                                        */
/* ========================================================================== */

test("410 chat_id không hợp lệ là lỗi VĨNH VIỄN, không thử lại plain text", () => {
    // Đúng thông báo đã thấy trong log sản xuất (kể cả lỗi chính tả của Zalo).
    const error = { code: "EZALO", message: "EZALO: 410 The chat_id is invaild" };
    const result = classifyDeliveryError(error);

    assert.equal(result.kind, DELIVERY_ERROR_KIND.PERMANENT);
    assert.equal(result.code, 410);
    assert.equal(result.retryable, false);
    assert.equal(result.retryAsPlainText, false, "không được thử lại dạng plain text");
});

test("422 không có quyền gửi là lỗi VĨNH VIỄN, không thử lại plain text", () => {
    const error = { code: "EZALO", message: "EZALO: 422 You are not permitted to send messages to this chat_id" };
    const result = classifyDeliveryError(error);

    assert.equal(result.kind, DELIVERY_ERROR_KIND.PERMANENT);
    assert.equal(result.code, 422);
    assert.equal(result.retryAsPlainText, false);
});

test("429 là lỗi TẠM THỜI, cần chờ chứ không thử lại ngay", () => {
    const result = classifyDeliveryError({ message: "HTTP 429 Too Many Requests" });

    assert.equal(result.kind, DELIVERY_ERROR_KIND.RATE_LIMIT);
    assert.equal(result.code, 429);
    assert.equal(result.retryable, true);
    assert.equal(result.retryAsPlainText, false, "429 không liên quan tới định dạng");
});

test("lỗi định dạng markdown thì ĐƯỢC thử lại plain text", () => {
    const result = classifyDeliveryError({ message: "Bad Request: can't parse entities" });
    assert.equal(result.kind, DELIVERY_ERROR_KIND.FORMAT);
    assert.equal(result.retryAsPlainText, true);
});

test("lỗi có mã rõ ràng không bị đoán thành lỗi định dạng", () => {
    // Có mã 422 kèm chữ "markdown" vẫn phải là lỗi vĩnh viễn: mã quyết định.
    const result = classifyDeliveryError({ message: "422 markdown not allowed" });
    assert.equal(result.kind, DELIVERY_ERROR_KIND.PERMANENT);
    assert.equal(result.retryAsPlainText, false);
});

test("lỗi mạng tạm thời không bị coi là lỗi định dạng", () => {
    const result = classifyDeliveryError({ message: "socket hang up ECONNRESET" });
    assert.equal(result.retryAsPlainText, false);
});

test("đọc được mã lỗi từ nhiều hình dạng phản hồi", () => {
    assert.equal(readErrorCode({ response: { error_code: 410 } }), 410);
    assert.equal(readErrorCode({ response: { statusCode: 429 } }), 429);
    assert.equal(readErrorCode({ statusCode: 503 }), 503);
    assert.equal(readErrorCode({ message: "EZALO: 422 nope" }), 422);
    assert.equal(readErrorCode({ message: "không có mã" }), null);
});

test("429 có giãn cách tăng dần và tôn trọng Retry-After", () => {
    const withHeader = { response: { headers: { "retry-after": "30" } } };
    assert.equal(computeRetryDelayMs(withHeader, 1), 30000, "phải dùng Retry-After khi có");

    // Không có header: tăng dần, có nhiễu, và luôn có trần.
    const first = computeRetryDelayMs({}, 1);
    const third = computeRetryDelayMs({}, 3);
    assert.ok(first >= 750 && first <= 1000, `lần 1 phải ~1s, nhận ${first}`);
    assert.ok(third >= 3000 && third <= 4000, `lần 3 phải ~4s, nhận ${third}`);
    assert.ok(computeRetryDelayMs({}, 20) <= 60000, "phải có trần, không tăng vô hạn");
});

/* ========================================================================== */
/* E. Hàng đợi gửi có trần (Phase 9 & 11)                                     */
/* ========================================================================== */

test("hàng đợi tôn trọng trần song song", async () => {
    const queue = createSendQueue({ concurrency: 3, name: "test" });
    let active = 0;
    let peak = 0;

    const tasks = Array.from({ length: 20 }, () => queue.enqueue(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(10);
        active -= 1;
    }, PRIORITY.BULK));

    await Promise.all(tasks);
    assert.ok(peak <= 3, `song song tối đa phải ≤ 3, đo được ${peak}`);
    assert.equal(queue.getStats().completed, 20);
});

test("hàng đợi ưu tiên việc tương tác trước việc hàng loạt", async () => {
    const queue = createSendQueue({ concurrency: 1, name: "priority" });
    const order = [];

    // Chặn hàng đợi bằng một việc dài, rồi xếp việc hàng loạt TRƯỚC việc tương tác.
    const blocker = queue.enqueue(async () => { await sleep(30); order.push("blocker"); }, PRIORITY.BULK);
    const bulk = queue.enqueue(async () => { order.push("bulk"); }, PRIORITY.BULK);
    const interactive = queue.enqueue(async () => { order.push("interactive"); }, PRIORITY.INTERACTIVE);

    await Promise.all([blocker, bulk, interactive]);
    assert.deepEqual(order, ["blocker", "interactive", "bulk"], "việc tương tác phải chen trước việc hàng loạt");
});

test("mỗi nhà cung cấp có hàng đợi riêng, không chặn nhau", async () => {
    const queues = createProviderQueues({ env: { OFFICIAL_SEND_CONCURRENCY: "2", ZCA_SEND_CONCURRENCY: "1" } });

    assert.notEqual(queues.queueFor("bot1"), queues.queueFor("bot2"), "mỗi bot một hàng đợi");
    assert.notEqual(queues.queueFor("bot1"), queues.queueFor("zca:123"), "ZCA tách khỏi bot chính thức");
    assert.equal(queues.queueFor("bot1").concurrency, 2);
    assert.equal(queues.queueFor("zca:123").concurrency, 1, "ZCA có trần riêng");
});

test("hàng đợi đã dừng nhận việc thì từ chối việc mới", async () => {
    const queue = createSendQueue({ concurrency: 1, name: "stop" });
    await queue.enqueue(async () => undefined, PRIORITY.BULK);
    queue.stopAccepting();
    await assert.rejects(() => queue.enqueue(async () => undefined, PRIORITY.BULK), /đã dừng nhận việc/);
});

test("lỗi của một việc không làm kẹt hàng đợi", async () => {
    const queue = createSendQueue({ concurrency: 2, name: "errors" });
    const results = await Promise.allSettled([
        queue.enqueue(async () => { throw new Error("hỏng"); }, PRIORITY.BULK),
        queue.enqueue(async () => "ok", PRIORITY.BULK),
        queue.enqueue(async () => "ok2", PRIORITY.BULK)
    ]);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
    assert.equal(queue.getStats().failed, 1);
});

/* ========================================================================== */
/* B. Đối chiếu sổ chat gộp (Phase 3)                                         */
/* ========================================================================== */

// Cài ĐÚNG MỘT LẦN. chatDirectory lấy writeJsonStore ngay khi require, nên nếu
// cài lại cho từng bài thì nó vẫn ghi vào bản giả đầu tiên và bài kiểm tra sẽ đọc
// nhầm store. Mỗi bài dùng một đường dẫn tạm riêng nên không lẫn dữ liệu.
function installFakePersistence() {
    const persistencePath = require.resolve(path.join(ROOT, "firestorePersistence"));
    const real = require(persistencePath);
    const memoryFiles = new Map();
    const writes = { count: 0 };
    const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
    const fileKey = (filePath, defaultPath) => path.resolve(filePath || defaultPath);

    require.cache[persistencePath] = {
        id: persistencePath, filename: persistencePath, loaded: true,
        exports: {
            ...real,
            readJsonStore: (filePath, defaultPath, fallback) => {
                const key = fileKey(filePath, defaultPath);
                if (!memoryFiles.has(key)) memoryFiles.set(key, clone(fallback) ?? null);
                return clone(memoryFiles.get(key));
            },
            writeJsonStore: (filePath, defaultPath, value) => {
                writes.count += 1;
                memoryFiles.set(fileKey(filePath, defaultPath), clone(value));
            },
            flushPersistenceWrites: async () => undefined,
            getPersistenceStatus: () => ({ backend: "test" })
        }
    };
    return { memoryFiles, writes, clone, fileKey };
}

const sharedFake = installFakePersistence();

test("đối chiếu nhiều chat chỉ ghi MỘT lần", (t) => {
    const fake = sharedFake;
    const dir = tempDir(t);
    const filePath = path.join(dir, "chatDirectory.json");
    fake.memoryFiles.set(fake.fileKey(filePath, filePath), { schemaVersion: 3, chats: {}, deletedChatIds: {} });

    const { reconcileChatDirectory } = require("../chatDirectory");
    const entries = Array.from({ length: 200 }, (_, index) => ({
        chatId: `chat-${index}`, chatType: "private", displayName: `Chat ${index}`, userId: `user-${index}`
    }));

    fake.writes.count = 0;
    const changed = reconcileChatDirectory(entries, filePath);

    assert.equal(changed, 200, "phải thêm đủ 200 bản ghi");
    assert.equal(fake.writes.count, 1, `200 bản ghi chỉ được ghi 1 lần, thực tế ${fake.writes.count}`);
});

test("đối chiếu lại khi không có gì đổi thì KHÔNG ghi", (t) => {
    const fake = sharedFake;
    const dir = tempDir(t);
    const filePath = path.join(dir, "chatDirectory.json");
    fake.memoryFiles.set(fake.fileKey(filePath, filePath), { schemaVersion: 3, chats: {}, deletedChatIds: {} });

    const { reconcileChatDirectory } = require("../chatDirectory");
    const entries = [{ chatId: "chat-1", chatType: "private", displayName: "Chat 1", userId: "user-1" }];

    reconcileChatDirectory(entries, filePath);
    fake.writes.count = 0;
    const changed = reconcileChatDirectory(entries, filePath);

    assert.equal(changed, 0);
    assert.equal(fake.writes.count, 0, "không đổi gì thì không được ghi");
});

test("đối chiếu giữ nguyên status, overrides, createdAt và không hồi sinh chat đã xoá", (t) => {
    const fake = sharedFake;
    const dir = tempDir(t);
    const filePath = path.join(dir, "chatDirectory.json");
    fake.memoryFiles.set(fake.fileKey(filePath, filePath), {
        schemaVersion: 3,
        chats: {
            "keep-me": {
                chatId: "keep-me", botId: "bot1", chatType: "group", displayName: "Cũ", userId: "u1",
                status: "disabled", notificationOverrides: { broadcast: true },
                createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-06-01T00:00:00.000Z"
            }
        },
        deletedChatIds: { "deleted-one": { deletedAt: "2025-05-01T00:00:00.000Z" } }
    });

    const { reconcileChatDirectory, readDirectory } = require("../chatDirectory");
    reconcileChatDirectory([
        { chatId: "keep-me", chatType: "group", displayName: "Cũ", userId: "u1" },
        { chatId: "deleted-one", chatType: "private", displayName: "Không được dựng lại" }
    ], filePath);

    const data = readDirectory(filePath);
    const kept = data.chats["keep-me"];
    assert.equal(kept.status, "disabled", "status phải được giữ");
    assert.equal(kept.notificationOverrides.broadcast, true, "notificationOverrides phải được giữ");
    assert.equal(kept.createdAt, "2025-01-01T00:00:00.000Z", "createdAt phải được giữ");
    assert.equal(data.chats["deleted-one"], undefined, "không được hồi sinh chat đã xoá");
    assert.ok(data.deletedChatIds["deleted-one"], "tombstone phải còn nguyên");
});

test("đối chiếu chỉ đổi updatedAt khi dữ liệu hiển thị thực sự đổi", (t) => {
    const fake = sharedFake;
    const dir = tempDir(t);
    const filePath = path.join(dir, "chatDirectory.json");
    fake.memoryFiles.set(fake.fileKey(filePath, filePath), {
        schemaVersion: 3,
        chats: {
            "chat-1": {
                chatId: "chat-1", botId: "bot1", chatType: "private", displayName: "Tên cũ", userId: "u1",
                status: "active", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-06-01T00:00:00.000Z"
            }
        },
        deletedChatIds: {}
    });

    const { reconcileChatDirectory, readDirectory } = require("../chatDirectory");

    // Cùng dữ liệu ⇒ updatedAt không đổi.
    reconcileChatDirectory([{ chatId: "chat-1", chatType: "private", displayName: "Tên cũ", userId: "u1" }], filePath);
    assert.equal(readDirectory(filePath).chats["chat-1"].updatedAt, "2025-06-01T00:00:00.000Z");

    // Đổi tên ⇒ updatedAt phải đổi.
    reconcileChatDirectory([{ chatId: "chat-1", chatType: "private", displayName: "Tên mới", userId: "u1" }], filePath);
    const after = readDirectory(filePath).chats["chat-1"];
    assert.equal(after.displayName, "Tên mới");
    assert.notEqual(after.updatedAt, "2025-06-01T00:00:00.000Z", "đổi dữ liệu thì phải cập nhật updatedAt");
});

/* ========================================================================== */
/* C. Khởi động nhà cung cấp song song (Phase 5)                              */
/* ========================================================================== */

test("nhà cung cấp khởi động SONG SONG, không tuần tự", async () => {
    const { registerBots, clearBots, listEnabledBots } = require("../botContext");
    clearBots();

    const delayMs = 60;
    const make = (botId, options = {}) => ({
        botId,
        providerType: botId.startsWith("zca:") ? "zca" : "official",
        start: async () => {
            await sleep(delayMs);
            if (options.fail) throw new Error(`${botId} hỏng`);
        }
    });
    registerBots([
        make("bot1"), make("bot2"), make("bot3"),
        make("zca:pending", { fail: true })
    ]);

    const started = [];
    const failed = [];
    const begin = Date.now();
    await Promise.allSettled(listEnabledBots().map(async (runtime) => {
        try { await runtime.start(); started.push(runtime.botId); }
        catch (error) { failed.push(runtime.botId); }
    }));
    const elapsed = Date.now() - begin;

    // Tuần tự sẽ là 4 × 60ms = 240ms. Song song phải gần 60ms.
    assert.ok(elapsed < delayMs * 2, `phải chạy song song, mất ${elapsed}ms cho 4 nhà cung cấp × ${delayMs}ms`);
    assert.equal(started.length, 3, "ba bot chính thức phải lên được");
    assert.deepEqual(failed, ["zca:pending"], "chỉ ZCA hỏng");

    clearBots();
});

/* ========================================================================== */
/* Đo lường (Phase 1)                                                         */
/* ========================================================================== */

test("đo bộ nhớ có đủ các trường cần thiết", () => {
    const metrics = createRuntimeMetrics({ enabled: false });
    const memory = metrics.readMemory();

    for (const field of ["rss", "heapUsed", "heapTotal", "external", "arrayBuffers"]) {
        assert.equal(typeof memory[field], "number", `thiếu trường ${field}`);
    }
});

test("log bộ nhớ tắt được và không tự khởi động lại tiến trình", () => {
    const metrics = createRuntimeMetrics({ enabled: false });
    assert.equal(metrics.enabled, false);
    assert.equal(metrics.start(), false, "tắt thì không đăng ký interval");
    metrics.stop();
});

test("mốc thời gian khởi động ghi lại thứ tự và tổng thời gian", () => {
    const metrics = createRuntimeMetrics({ enabled: false });
    metrics.mark("A");
    metrics.mark("B");
    const summary = metrics.summary();

    assert.equal(summary.marks.length, 2);
    assert.equal(summary.marks[0].label, "A");
    assert.ok(summary.marks[1].sinceStartMs >= summary.marks[0].sinceStartMs, "mốc sau không thể sớm hơn");
    assert.ok(summary.totalMs >= 0);
    assert.match(summary.text, /Full runtime ready/);
});

/* ========================================================================== */
/* A. Gộp ghi persistence (Phase 2)                                           */
/*                                                                             */
/* Cách cũ: mỗi thay đổi nối thêm một Promise giữ một bản sao ĐẦY ĐỦ của store. */
/* 100 thay đổi ⇒ 100 bản sao chờ ghi. Đó là nguồn phình RSS ngoài heap.       */
/*                                                                             */
/* Quan sát được trực tiếp: số writer đang chạy cho mỗi store. Cách mới giữ    */
/* ĐÚNG MỘT writer cho mỗi store, nên con số này không bao giờ vượt 1 dù có    */
/* bao nhiêu thay đổi dồn dập.                                                 */
/* ========================================================================== */

test("100 thay đổi dồn dập KHÔNG tạo 100 bản sao chờ ghi", async () => {
    const { getPersistenceQueueStats, flushPersistenceWrites } = require("../firestorePersistence");

    // Giả lập 100 lần cập nhật liên tiếp cùng một store qua chatDirectory, rồi đo
    // hàng đợi persistence. Không cần Firestore thật: ta quan sát hàng đợi.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coalesce-"));
    const filePath = path.join(dir, "chatDirectory.json");
    const { upsertChat } = require("../chatDirectory");

    const peakWriters = { value: 0 };
    const peakDirty = { value: 0 };
    for (let index = 0; index < 100; index += 1) {
        upsertChat({ chatId: `chat-${index}`, chatType: "private", displayName: `Chat ${index}` }, filePath);
        const stats = getPersistenceQueueStats();
        peakWriters.value = Math.max(peakWriters.value, stats.activeWriters);
        peakDirty.value = Math.max(peakDirty.value, stats.dirtyStores);
    }

    const finalStats = getPersistenceQueueStats();
    // Một writer cho mỗi store, không phải một writer cho mỗi thay đổi.
    assert.ok(
        peakWriters.value <= 1,
        `mỗi store chỉ được có tối đa 1 writer, đo được ${peakWriters.value}`
    );
    assert.ok(finalStats.activeWriters <= 1, "không được có nhiều writer cho cùng một store");
    // Hàng đợi không giữ lịch sử: chỉ có "bẩn" hay "không", không phải N bản sao.
    assert.ok(finalStats.dirtyStores <= 1, `dirtyStores phải ≤ 1, đo được ${finalStats.dirtyStores}`);

    await flushPersistenceWrites();
    const afterFlush = getPersistenceQueueStats();
    assert.equal(afterFlush.dirtyStores, 0, "flush xong thì không còn store bẩn");
    assert.equal(afterFlush.activeWriters, 0, "flush xong thì không còn writer nào chạy");

    fs.rmSync(dir, { recursive: true, force: true });
});

test("flushPersistenceWrites chờ tới khi ghi xong", async () => {
    const { flushPersistenceWrites, getPersistenceQueueStats } = require("../firestorePersistence");
    await flushPersistenceWrites();
    const stats = getPersistenceQueueStats();
    assert.equal(stats.dirtyStores, 0);
    assert.equal(stats.activeWriters, 0);
});

test("thống kê hàng đợi persistence có đủ trường chẩn đoán", () => {
    const { getPersistenceQueueStats } = require("../firestorePersistence");
    const stats = getPersistenceQueueStats();
    for (const field of ["dirtyStores", "activeWriters", "cachedStores", "dirtyStoreIds"]) {
        assert.ok(field in stats, `thiếu trường ${field}`);
    }
});
