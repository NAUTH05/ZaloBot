// ============================================================================
// BỘ ĐIỀU PHỐI GỬI TIN THỐNG NHẤT CHO TÀI KHOẢN ZCA.
//
// Những điều phải đúng, vì sai một điều là quay lại đúng sự cố đã xảy ra
// ("bot nói đã gửi nhưng rất nhiều người không nhận được"):
//
//   1. Mọi đường gửi của MỘT tài khoản dùng chung một làn: song song = 1.
//   2. Khoảng cách tối thiểu giữa hai request thật luôn được tôn trọng.
//   3. Việc gấp (trả lời người dùng) không bị việc hàng loạt đang xếp hàng chặn.
//   4. Hai tài khoản ZCA có trạng thái độc lập.
//   5. Bot chính thức giữ nguyên trần song song, không thừa hưởng nhịp ZCA.
//   6. Cầu dao riêng cho từng tài khoản, và KHÔNG bị xoá bởi khởi động lại.
//
// Dùng đồng hồ giả + `sleep` tiêm vào: không bài nào phải chờ vài phút thật.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    BREAKER_STATE,
    createOutboundLimiter,
    createDeferredError,
    resolveZcaOutboundConfig
} = require("../outboundLimiter");
const { createProviderQueues, PRIORITY } = require("../sendQueue");

function fakeClock(start = 1_000_000) {
    const state = { now: start, sleeps: [] };
    return {
        state,
        now: () => state.now,
        sleep: async (ms) => {
            state.sleeps.push(ms);
            state.now += ms;
        }
    };
}

function tempStateFile(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zca-outbound-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, "state.json");
}

function buildLimiter(t, extra = {}) {
    const clock = fakeClock();
    const limiter = createOutboundLimiter({
        env: {},
        now: clock.now,
        sleep: clock.sleep,
        stateFilePath: tempStateFile(t),
        log: () => {},
        ...extra
    });
    return { limiter, clock };
}

function rateLimitError(retryAfterSeconds = null) {
    const error = new Error("429 quá nhiều yêu cầu");
    error.deliveryKind = "rate_limit";
    if (retryAfterSeconds != null) {
        error.response = { headers: { "retry-after": String(retryAfterSeconds) } };
    }
    return error;
}

function unconfirmedError() {
    const error = new Error("Zalo không tạo tin nhắn (phản hồi không có msgId)");
    error.deliveryKind = "unconfirmed";
    return error;
}

function recipientError() {
    const error = new Error("Không thể nhận tin nhắn từ bạn");
    error.code = 123;
    return error;
}

// ---------------------------------------------------------------------------
// 1–2. Tuần tự + khoảng cách
// ---------------------------------------------------------------------------

test("một tài khoản ZCA chỉ gửi MỘT tin tại một thời điểm, cách nhau đúng nhịp", async (t) => {
    const { limiter, clock } = buildLimiter(t);
    const order = [];
    let active = 0;
    let maxActive = 0;

    await Promise.all([1, 2, 3, 4].map((index) => limiter.enqueue(
        "zca:111222333",
        async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            order.push(index);
            await Promise.resolve();
            active -= 1;
            return { sent: true };
        },
        PRIORITY.SCHEDULED,
        { recipientKey: `chat-${index}` }
    )));

    assert.deepEqual(order, [1, 2, 3, 4], "phải giữ đúng thứ tự xếp hàng");
    assert.equal(maxActive, 1, "song song phải là 1 — đây là điều kiện của mọi giới hạn tốc độ");
    assert.equal(clock.state.sleeps.length, 3, "mỗi tin sau tin đầu phải chờ đủ nhịp");
    assert.ok(
        clock.state.sleeps.every((ms) => ms === 10000),
        `nhịp phải là 10s, nhận được: ${JSON.stringify(clock.state.sleeps)}`
    );
});

test("hai tài khoản ZCA có làn và nhịp độc lập", async (t) => {
    const { limiter } = buildLimiter(t);

    // Tài khoản A bị tạm dừng (3 lần 429)...
    for (let attempt = 0; attempt < 3; attempt += 1) {
        await assert.rejects(() => limiter.enqueue("zca:aaa", async () => { throw rateLimitError(); }));
    }
    assert.equal(limiter.getStats().accounts["zca:aaa"].paused, true);

    // ...tài khoản B vẫn gửi bình thường. Một tài khoản bị siết KHÔNG được làm
    // đứng tài khoản khác.
    const result = await limiter.enqueue("zca:bbb", async () => ({ sent: true }));
    assert.equal(result.sent, true);
    assert.equal(limiter.getStats().accounts["zca:bbb"].paused, false);
});

// ---------------------------------------------------------------------------
// 3. Ưu tiên
// ---------------------------------------------------------------------------

test("trả lời người dùng được chọn TRƯỚC thông báo hàng loạt đang xếp hàng", async (t) => {
    const { limiter } = buildLimiter(t);
    const order = [];
    let releaseFirst;
    const gate = new Promise((resolve) => { releaseFirst = resolve; });

    const first = limiter.enqueue("zca:9", async () => {
        order.push("dang-gui");
        await gate;
        return { sent: true };
    }, PRIORITY.BULK);

    const bulk = limiter.enqueue("zca:9", async () => {
        order.push("hang-loat");
        return { sent: true };
    }, PRIORITY.BULK);

    const interactive = limiter.enqueue("zca:9", async () => {
        order.push("tra-loi");
        return { sent: true };
    }, PRIORITY.INTERACTIVE);

    releaseFirst();
    await Promise.all([first, bulk, interactive]);

    assert.deepEqual(order, ["dang-gui", "tra-loi", "hang-loat"],
        "việc ưu tiên cao phải được chọn trước dù đến sau");
});

test("việc hàng loạt vẫn bị hoãn trong giai đoạn phục hồi", async (t) => {
    const { limiter, clock } = buildLimiter(t, { env: { ZCA_BREAKER_PAUSE_MS: "1000" } });

    for (let attempt = 0; attempt < 3; attempt += 1) {
        await assert.rejects(() => limiter.enqueue("zca:7", async () => { throw rateLimitError(); }));
    }
    assert.equal(limiter.getStats().accounts["zca:7"].paused, true);

    // Hết thời gian tạm dừng ⇒ chuyển sang phục hồi, KHÔNG phải bình thường.
    clock.state.now += 1001;
    assert.equal(limiter.getStats().accounts["zca:7"].state, BREAKER_STATE.COOLDOWN_COMPLETED);

    // Việc hàng loạt bị hoãn...
    await assert.rejects(
        () => limiter.enqueue("zca:7", async () => ({ sent: true }), PRIORITY.BULK),
        (error) => error.deferred === true && error.reason === "recovering"
    );
    // ...nhưng việc ưu tiên cao vẫn đi qua.
    const sent = await limiter.enqueue("zca:7", async () => ({ sent: true }), PRIORITY.INTERACTIVE);
    assert.equal(sent.sent, true);
});

test("đủ số lần gửi xác nhận thì thoát giai đoạn phục hồi về bình thường", async (t) => {
    const { limiter, clock } = buildLimiter(t, { env: { ZCA_BREAKER_PAUSE_MS: "1000" } });
    for (let attempt = 0; attempt < 3; attempt += 1) {
        await assert.rejects(() => limiter.enqueue("zca:8", async () => { throw rateLimitError(); }));
    }
    clock.state.now += 1001;

    for (let attempt = 0; attempt < 2; attempt += 1) {
        await limiter.enqueue("zca:8", async () => ({ sent: true }), PRIORITY.INTERACTIVE);
    }
    assert.equal(limiter.getStats().accounts["zca:8"].state, BREAKER_STATE.NORMAL);
});

// ---------------------------------------------------------------------------
// 4–5. Bot chính thức giữ nguyên hành vi
// ---------------------------------------------------------------------------

test("bot chính thức giữ trần song song cũ và KHÔNG thừa hưởng nhịp ZCA", async (t) => {
    const clock = fakeClock();
    const officialQueues = createProviderQueues({ env: {}, officialConcurrency: 3 });
    const limiter = createOutboundLimiter({
        env: {},
        now: clock.now,
        sleep: clock.sleep,
        stateFilePath: tempStateFile(t),
        officialQueues,
        log: () => {}
    });

    let active = 0;
    let maxActive = 0;
    await Promise.all([1, 2, 3, 4, 5].map((index) => limiter.enqueue("bot1", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return { sent: true, index };
    })));

    assert.ok(maxActive > 1, `bot chính thức phải chạy song song như trước, maxActive=${maxActive}`);
    assert.deepEqual(clock.state.sleeps, [], "không được áp nhịp ZCA lên bot chính thức");
});

// ---------------------------------------------------------------------------
// 6. Cầu dao + khởi động lại
// ---------------------------------------------------------------------------

test("tạm dừng vì 429 được LƯU LẠI: khởi động lại không xoá cooldown đang hiệu lực", async (t) => {
    const stateFilePath = tempStateFile(t);
    const clock = fakeClock();
    const options = {
        env: { ZCA_BREAKER_PAUSE_MS: "600000" },
        now: clock.now,
        sleep: clock.sleep,
        stateFilePath,
        log: () => {}
    };

    const first = createOutboundLimiter(options);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        await assert.rejects(() => first.enqueue("zca:555", async () => { throw rateLimitError(); }));
    }
    assert.equal(first.getStats().accounts["zca:555"].paused, true);

    // Tiến trình mới (PM2 restart) đọc lại cùng tệp trạng thái.
    const second = createOutboundLimiter(options);
    assert.equal(second.getStats().accounts["zca:555"].paused, true,
        "cooldown đang hiệu lực KHÔNG được bị xoá bởi khởi động lại");
    await assert.rejects(
        () => second.enqueue("zca:555", async () => ({ sent: true })),
        (error) => error.deferred === true
    );
});

test("429 tôn trọng Retry-After của máy chủ", async (t) => {
    const { limiter } = buildLimiter(t);
    await assert.rejects(
        () => limiter.enqueue("zca:42", async () => { throw rateLimitError(30); }),
        (error) => {
            assert.equal(error.deliveryClassification.kind, "rate_limit");
            assert.equal(error.deliveryClassification.retryAfterMs, 30000);
            return true;
        }
    );
});

test("mã 123 lẻ KHÔNG làm tạm dừng tài khoản, nhưng lặp trên nhiều người nhận thì có", async (t) => {
    const { limiter } = buildLimiter(t);

    // Một người nhận bị 123: chỉ là lỗi của người đó.
    await assert.rejects(
        () => limiter.enqueue("zca:123", async () => { throw recipientError(); }, PRIORITY.BULK, { recipientKey: "chat-1" }),
        (error) => error.deliveryClassification.kind === "recipient"
    );
    assert.equal(limiter.getStats().accounts["zca:123"].paused, false,
        "một lần 123 không chứng minh được tài khoản bị siết");

    // Cùng MỘT người nhận lỗi nhiều lần cũng không phải bằng chứng cấp tài khoản.
    for (let attempt = 0; attempt < 4; attempt += 1) {
        await assert.rejects(
            () => limiter.enqueue("zca:123", async () => { throw recipientError(); }, PRIORITY.BULK, { recipientKey: "chat-1" })
        );
    }
    assert.equal(limiter.getStats().accounts["zca:123"].paused, false,
        "cùng một người nhận lặp lại KHÔNG được coi là tài khoản bị siết");

    // Nhiều NGƯỜI NHẬN khác nhau ⇒ nghi tài khoản bị siết.
    for (const chatId of ["chat-2", "chat-3", "chat-4", "chat-5"]) {
        await assert.rejects(
            () => limiter.enqueue("zca:123", async () => { throw recipientError(); }, PRIORITY.BULK, { recipientKey: chatId })
        );
    }
    const stats = limiter.getStats().accounts["zca:123"];
    assert.equal(stats.paused, true, "123 trên nhiều người nhận phải tạm dừng tài khoản");
    assert.equal(stats.pauseReason, "recipient_restricted");
});

test("thiếu msgId lặp trên nhiều người nhận ⇒ tạm dừng tài khoản", async (t) => {
    const { limiter } = buildLimiter(t);

    await assert.rejects(
        () => limiter.enqueue("zca:000", async () => { throw unconfirmedError(); }, PRIORITY.BULK, { recipientKey: "a" }),
        (error) => error.deliveryClassification.kind === "unconfirmed"
    );
    assert.equal(limiter.getStats().accounts["zca:000"].paused, false,
        "một lần thiếu msgId không tự động là bằng chứng tài khoản bị siết");

    for (const chatId of ["b", "c"]) {
        await assert.rejects(
            () => limiter.enqueue("zca:000", async () => { throw unconfirmedError(); }, PRIORITY.BULK, { recipientKey: chatId })
        );
    }
    assert.equal(limiter.getStats().accounts["zca:000"].paused, true);
    assert.equal(limiter.getStats().accounts["zca:000"].pauseReason, "missing_message_id");
});

test("tài khoản đang tạm dừng thì hoãn phần còn lại, không gửi", async (t) => {
    const { limiter } = buildLimiter(t);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        await assert.rejects(() => limiter.enqueue("zca:99", async () => { throw rateLimitError(); }));
    }

    let called = false;
    await assert.rejects(
        () => limiter.enqueue("zca:99", async () => { called = true; return { sent: true }; }),
        (error) => {
            assert.equal(error.deferred, true);
            assert.equal(error.reason, "rate_limited");
            return true;
        }
    );
    assert.equal(called, false, "đang tạm dừng thì KHÔNG được gọi nhà cung cấp");
    assert.ok(limiter.getStats().accounts["zca:99"].deferred >= 1);
});

test("quản trị viên có thể thoát tạm dừng, và nhịp KHÔNG tăng lên", async (t) => {
    const { limiter } = buildLimiter(t);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        await assert.rejects(() => limiter.enqueue("zca:321", async () => { throw rateLimitError(); }));
    }
    assert.equal(limiter.getStats().accounts["zca:321"].paused, true);

    assert.equal(limiter.resume("zca:321"), true);
    const stats = limiter.getStats().accounts["zca:321"];
    assert.equal(stats.paused, false);
    assert.equal(stats.intervalMs, 10000, "thoát tạm dừng KHÔNG được làm gửi nhanh hơn");
});

// ---------------------------------------------------------------------------
// Cấu hình
// ---------------------------------------------------------------------------

test("cấu hình mặc định thận trọng, và luôn bị kẹp về khoảng an toàn", () => {
    const defaults = resolveZcaOutboundConfig({});
    assert.equal(defaults.intervalMs, 10000);
    assert.equal(defaults.minIntervalMs, 5000);
    assert.equal(defaults.concurrency, 1);

    // Cấu hình cũ vẫn dùng được.
    assert.equal(resolveZcaOutboundConfig({ BROADCAST_ZCA_INTERVAL_MS: "20000" }).intervalMs, 20000);
    // Biến mới thắng biến cũ.
    assert.equal(resolveZcaOutboundConfig({
        ZCA_OUTBOUND_INTERVAL_MS: "12000",
        BROADCAST_ZCA_INTERVAL_MS: "20000"
    }).intervalMs, 12000);
    // Không bao giờ nhanh hơn sàn.
    assert.equal(resolveZcaOutboundConfig({ ZCA_OUTBOUND_INTERVAL_MS: "100" }).intervalMs, 5000);
    // Giá trị rác ⇒ mặc định, không thành 0.
    assert.equal(resolveZcaOutboundConfig({ ZCA_OUTBOUND_INTERVAL_MS: "abc" }).intervalMs, 10000);
    assert.equal(resolveZcaOutboundConfig({ ZCA_OUTBOUND_INTERVAL_MS: "0" }).intervalMs, 10000);
    // Song song > 1 bị từ chối.
    const rejected = resolveZcaOutboundConfig({ ZCA_OUTBOUND_CONCURRENCY: "4" });
    assert.equal(rejected.concurrency, 1);
    assert.equal(rejected.concurrencyRejected, true);
});

test("lỗi hoãn mang đúng nhãn để tầng trên không ghi thành lỗi của người nhận", () => {
    const error = createDeferredError("provider_paused", 5000);
    assert.equal(error.deliveryKind, "deferred");
    assert.equal(error.deferred, true);
    assert.equal(error.retryAfterMs, 5000);
});
