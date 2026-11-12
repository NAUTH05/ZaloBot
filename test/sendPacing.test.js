// ============================================================================
// Nhịp gửi cho thông báo hàng loạt.
//
// Bốn điều phải đúng, vì sai một điều là quay lại đúng sự cố đã xảy ra:
//   1. TUẦN TỰ theo nhà cung cấp — 100 lần gọi đồng thời không được bắn cùng lúc.
//   2. Tài khoản cá nhân (ZCA) chậm hơn bot chính thức.
//   3. Bị giới hạn tốc độ 3 lần ⇒ nhà cung cấp tạm dừng, phần còn lại trả
//      `deferred` (chưa gửi) chứ không phải `failed` (đích hỏng).
//   4. Tắt được (môi trường kiểm thử) mà không đổi hành vi nghiệp vụ.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");

const { createSendPacer, DEFAULT_OFFICIAL_INTERVAL_MS, DEFAULT_ZCA_INTERVAL_MS, envInterval } = require("../sendPacing");

function fakeClock() {
    const state = { now: 1_000_000, sleeps: [] };
    return {
        state,
        now: () => state.now,
        sleep: async (ms) => { state.sleeps.push(ms); state.now += ms; }
    };
}

function rateLimitOutcome() {
    return {
        failed: true,
        error: Object.assign(new Error("429 quá nhiều yêu cầu"), {
            deliveryClassification: { kind: "rate_limit" }
        })
    };
}

test("gửi TUẦN TỰ theo từng nhà cung cấp, không chạy song song", async () => {
    const clock = fakeClock();
    const pacer = createSendPacer({ env: {}, now: clock.now, sleep: clock.sleep });

    const order = [];
    let active = 0;
    let maxActive = 0;

    await Promise.all([1, 2, 3, 4].map((index) => pacer.run("bot1", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(index);
        active -= 1;
        return { sent: true };
    })));

    assert.deepEqual(order, [1, 2, 3, 4], "phải giữ đúng thứ tự xếp hàng");
    assert.equal(maxActive, 1, "không bao giờ có hai lần gửi cùng lúc trên một nhà cung cấp");
    assert.ok(clock.state.sleeps.length >= 3, "mỗi tin sau tin đầu phải chờ đủ nhịp");
    assert.ok(clock.state.sleeps.every((ms) => ms >= DEFAULT_OFFICIAL_INTERVAL_MS - 1));
});

test("tài khoản Zalo cá nhân có nhịp chậm hơn bot chính thức", () => {
    const pacer = createSendPacer({ env: {} });
    assert.equal(pacer.controllerFor("bot1").settings.intervalMs, DEFAULT_OFFICIAL_INTERVAL_MS);
    assert.equal(pacer.controllerFor("zca:623515849454943215").settings.intervalMs, DEFAULT_ZCA_INTERVAL_MS);
    assert.ok(DEFAULT_ZCA_INTERVAL_MS > DEFAULT_OFFICIAL_INTERVAL_MS);
});

test("nhịp đọc từ biến môi trường và luôn bị kẹp về khoảng an toàn", () => {
    const pacer = createSendPacer({ env: { BROADCAST_INTERVAL_MS: "500", BROADCAST_ZCA_INTERVAL_MS: "4000" } });
    assert.equal(pacer.controllerFor("bot1").settings.intervalMs, 500);
    // ZCA có SÀN CỨNG 5 giây: cấu hình 4 giây bị kẹp lên 5 giây. Nhịp ZCA dùng
    // CHUNG nguồn số với outboundLimiter.js (zcaOutboundConfig.js), nên hai nơi
    // không thể lệch nhau.
    assert.equal(pacer.controllerFor("zca:1").settings.intervalMs, 5000);

    // Giá trị rác ⇒ về mặc định, không thành 0 (bắn không giới hạn).
    assert.equal(envInterval({ BROADCAST_INTERVAL_MS: "abc" }, "BROADCAST_INTERVAL_MS", 1200), 1200);
    assert.equal(envInterval({ BROADCAST_INTERVAL_MS: "0" }, "BROADCAST_INTERVAL_MS", 1200), 1200);
    assert.equal(envInterval({}, "BROADCAST_INTERVAL_MS", 1200), 1200);
});

test("bị giới hạn tốc độ 3 lần ⇒ tạm dừng và trả deferred, không phải failed", async () => {
    const clock = fakeClock();
    const pacer = createSendPacer({ env: {}, now: clock.now, sleep: clock.sleep });

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const outcome = await pacer.run("zca:700700700", async () => rateLimitOutcome());
        assert.equal(outcome.failed, true);
    }

    // Lần thứ tư: nhà cung cấp đang tạm dừng ⇒ KHÔNG gọi task, trả deferred.
    let called = false;
    const paused = await pacer.run("zca:700700700", async () => {
        called = true;
        return { sent: true };
    });
    assert.equal(called, false, "đang tạm dừng thì không được gọi nhà cung cấp");
    assert.equal(paused.deferred, true);
    assert.equal(paused.reason, "paused");
    assert.ok(paused.retryAfterMs > 0);

    // Nhà cung cấp KHÁC không bị ảnh hưởng.
    const other = await pacer.run("bot1", async () => ({ sent: true }));
    assert.equal(other.sent, true);
});

test("gửi thành công làm dịu bớt số lần bị giới hạn đã đếm", async () => {
    const clock = fakeClock();
    const pacer = createSendPacer({ env: {}, now: clock.now, sleep: clock.sleep });

    await pacer.run("bot1", async () => rateLimitOutcome());
    await pacer.run("bot1", async () => rateLimitOutcome());
    await pacer.run("bot1", async () => ({ sent: true }));

    const stats = pacer.stats().official.bot1;
    assert.ok(stats.strikeCount <= 1, "một lần thành công phải xoá bớt căng thẳng");
    assert.equal(stats.paused, false);
});

test("tắt nhịp thì chạy trực tiếp, không chờ", async () => {
    const clock = fakeClock();
    const pacer = createSendPacer({ enabled: false, env: {}, now: clock.now, sleep: clock.sleep });

    const outcome = await pacer.run("bot1", async () => ({ sent: true }));
    assert.equal(outcome.sent, true);
    assert.deepEqual(clock.state.sleeps, []);
});
