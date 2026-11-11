// ============================================================================
// Nhịp gửi theo từng nhà cung cấp + chống vòng lặp 429.
//
// BỐI CẢNH: đợt thông báo đầu tiên bắn 196 đích trong ~2 giây và nhận lại 136 lỗi
// 429. Bài kiểm tra ở đây canh đúng những bảo đảm đã sửa được lỗi đó:
//
//   1. Nhịp RIÊNG theo nhà cung cấp — bot1 bị giới hạn tốc độ không làm chậm bot2.
//   2. 429 tôn trọng `Retry-After`; không có thì giãn cách tăng dần kèm nhiễu.
//   3. 429 lặp lại ⇒ TẠM DỪNG nhà cung cấp đó, phần còn lại ghi "hoãn" (không bắn nốt).
//   4. Chạy tiếp chỉ gửi người CHƯA gửi và người lỗi TẠM THỜI; không gửi lại 31 người
//      đã thành công; không thử lại 410/422.
//   5. Không bao giờ có hai lần gửi cho cùng một đích.
//
// KHÔNG bài nào gửi tin thật: mọi nhà cung cấp đều là đối tượng giả, và đồng hồ/`sleep`
// được thay bằng bản giả để kiểm tra chạy tức thì mà vẫn đo được khoảng chờ.
// ============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    PACING_DEFAULTS,
    clampInterval,
    computeRateLimitDelayMs,
    createPacingController,
    pacingGate,
    registerRateLimit,
    resolvePacingOptions
} = require("../announcementPacing");

const {
    CHECKPOINT_DIR,
    main,
    planSend,
    readCheckpoint,
    recipientKey,
    writeCheckpoint
} = require("../scripts/sendRecoveredAnnouncement");

/* -------------------------------------------------------------------------- */
/* Tiện ích dùng chung                                                         */
/* -------------------------------------------------------------------------- */

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-pacing-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

// Tên chiến dịch DUY NHẤT cho mỗi bài kiểm tra.
//
// Vì sao không dùng `process.pid` một mình: PID bị hệ điều hành TÁI SỬ DỤNG. Một
// checkpoint sót lại từ lần chạy trước (do bài kiểm tra trước bị dừng giữa chừng)
// sẽ mang cùng tên; lần chạy sau nạp nó lên, thấy người nhận đã ở mục `sent`, nên
// KHÔNG gửi gì cả và bài kiểm tra đỏ một cách ngẫu nhiên. Đây là nguyên nhân đã
// gây ra lỗi chập chờn thật.
//
// Vì vậy: PID + hậu tố ngẫu nhiên theo lần chạy + bộ đếm tăng dần. Tệp cũ cũng được
// dọn trước khi dùng để không phụ thuộc vào may mắn.
const RUN_TAG = crypto.randomBytes(6).toString("hex");
let campaignCounter = 0;
function uniqueCampaign(name) {
    campaignCounter += 1;
    const campaign = `${name}-${process.pid}-${RUN_TAG}-${campaignCounter}`;
    // Dọn mọi tệp cùng tên còn sót (phòng trường hợp hậu tố trùng).
    fs.rmSync(path.join(CHECKPOINT_DIR, `${campaign}.json`), { force: true });
    return campaign;
}

function writeSource(dir, records) {
    const file = path.join(dir, "src.json");
    fs.writeFileSync(file, JSON.stringify(records), "utf8");
    return file;
}

function writeMessage(dir, text = "Thông báo.") {
    const file = path.join(dir, "msg.txt");
    fs.writeFileSync(file, text, "utf8");
    return file;
}

// Đồng hồ ẢO: `sleep` không thật sự chờ, chỉ ghi lại khoảng chờ rồi nhích đồng hồ,
// nên bài kiểm tra chạy tức thì mà vẫn đo được đúng khoảng cách.
//
// Vì sao phải dùng đồng hồ ảo chứ không phải `Date.now()` thật: cấu hình nhịp có sàn
// an toàn (không cho nhỏ hơn 100ms), nên nếu dùng đồng hồ thật thì mỗi lần chờ 100ms
// sẽ cộng dồn thành hàng chục giây cho cả bộ kiểm thử — và kết quả sẽ phụ thuộc tốc
// độ máy. Với đồng hồ ảo, mọi giá trị nhịp đều đo được chính xác.
function virtualClock(options = {}) {
    const sleeps = [];
    const state = { now: options.start ?? 1_000_000 };
    return {
        sleeps,
        now: () => state.now,
        sleep: async (ms) => {
            sleeps.push(ms);
            // Cho phép chặn "ngủ" để mô phỏng thời gian trôi thật khi cần.
            if (options.onSleep) await options.onSleep(ms, state);
            state.now += Math.max(0, Number(ms) || 0);
        },
        advance: (ms) => { state.now += ms; },
        get nowValue() { return state.now; }
    };
}

// Lỗi 429 giống thật: node-zalo-bot nhét mã vào `response.statusCode` và có thể kèm
// header `retry-after`.
function rateLimitError(retryAfterSeconds) {
    const error = new Error("EZALO: 429 Too Many Requests");
    error.response = { statusCode: 429, headers: {} };
    if (retryAfterSeconds != null) error.response.headers["retry-after"] = String(retryAfterSeconds);
    return error;
}

function permanentError(code = 422) {
    const error = new Error(`EZALO: ${code} ${code === 422 ? "You are not permitted to send messages" : "The chat_id is invalid"}`);
    error.response = { statusCode: code };
    return error;
}

// Nhà cung cấp giả: ghi lại từng lần gửi và trả lỗi theo kịch bản.
//
//   sendMessage(chatId) → script quyết định theo chatId: trả kết quả hoặc ném lỗi.
function fakeProvider(botId, script, log) {
    return {
        botId,
        supportsMarkdown: true,
        sendMessage: async (chatId) => {
            log.push({ botId, chatId, at: log.length });
            return script(chatId);
        },
        health: () => ({ authenticated: true, ready: true })
    };
}

function registryOf(providers) {
    const map = new Map(providers.map((provider) => [provider.botId, provider]));
    return { get: (botId) => map.get(botId) || null, list: () => [...map.values()] };
}

function readSavedCheckpoint(campaign) {
    return JSON.parse(fs.readFileSync(path.join(CHECKPOINT_DIR, `${campaign}.json`), "utf8"));
}

/* -------------------------------------------------------------------------- */
/* 1. Nhịp riêng theo từng nhà cung cấp                                        */
/* -------------------------------------------------------------------------- */

test("mỗi nhà cung cấp có nhịp riêng, cách nhau đúng intervalMs", () => {
    const clock = virtualClock();
    // Dùng nhịp nhỏ nhất mà chính sách cho phép: đây là bài kiểm tra LOGIC nhịp, không
    // phải kiểm tra giá trị mặc định.
    const interval = PACING_DEFAULTS.minIntervalMs;
    const pacing = createPacingController({
        settings: { intervalMs: interval },
        sleep: clock.sleep,
        now: clock.now
    });

    // Lần đầu của mỗi nhà cung cấp không phải chờ.
    assert.equal(pacingGate(pacing.entryFor("bot1"), clock.nowValue).allowed, true);
    assert.equal(pacingGate(pacing.entryFor("bot2"), clock.nowValue).allowed, true);

    pacing.onSuccess("bot1");
    // bot1 vừa gửi ⇒ phải chờ; bot2 chưa gửi gì ⇒ vẫn được gửi ngay.
    assert.equal(pacingGate(pacing.entryFor("bot1"), clock.nowValue).allowed, false);
    assert.equal(pacingGate(pacing.entryFor("bot2"), clock.nowValue).allowed, true);

    const wait = pacingGate(pacing.entryFor("bot1"), clock.nowValue);
    assert.equal(wait.reason, "interval");
    assert.equal(wait.waitMs, interval, "khoảng cách phải đúng bằng intervalMs");
});

test("bot1 bị tạm dừng KHÔNG chặn bot2 (nhịp tách theo botId)", async () => {
    const clock = virtualClock();
    const pacing = createPacingController({
        settings: { intervalMs: 100, pauseMs: 60_000, maxRateLimitStrikes: 2 },
        sleep: clock.sleep,
        now: clock.now
    });

    pacing.onRateLimit("bot1", rateLimitError(1));
    const second = pacing.onRateLimit("bot1", rateLimitError(1));
    assert.equal(second.paused, true, "bot1 phải bị tạm dừng sau 2 lần 429");

    // bot1 bị chặn...
    const bot1Gate = await pacing.waitTurn("bot1");
    assert.equal(bot1Gate.reason, "paused");
    // ...nhưng bot2 hoàn toàn tự do.
    assert.equal(await pacing.waitTurn("bot2"), null, "bot2 không được bị ảnh hưởng");
});

test("waitTurn chờ đúng bằng khoảng cách còn thiếu của nhà cung cấp", async () => {
    const clock = virtualClock();
    const interval = 1_000;
    const pacing = createPacingController({
        settings: { intervalMs: interval },
        sleep: clock.sleep,
        now: clock.now
    });
    pacing.onSuccess("bot1");
    clock.advance(200);              // đã trôi 200ms ⇒ còn phải chờ 800ms
    assert.equal(await pacing.waitTurn("bot1"), null);
    assert.deepEqual(clock.sleeps, [interval - 200]);
});

/* -------------------------------------------------------------------------- */
/* 2. 429: Retry-After và giãn cách tăng dần                                   */
/* -------------------------------------------------------------------------- */

test("429 CÓ Retry-After thì chờ đúng số giây máy chủ yêu cầu", () => {
    const delay = computeRateLimitDelayMs(rateLimitError(12), 1, {
        backoffBaseMs: 1_000,
        backoffMaxMs: 120_000
    });
    assert.equal(delay, 12_000, "Retry-After phải được tôn trọng (giây → ms)");
});

test("429 KHÔNG có Retry-After thì giãn cách tăng dần và bị kẹp trần", () => {
    const options = { backoffBaseMs: 1_000, backoffMaxMs: 8_000 };
    // Nhiễu nằm trong 0.75–1.0 nên giá trị luôn nằm trong khoảng hợp lý.
    const first = computeRateLimitDelayMs(rateLimitError(), 1, options);
    assert.ok(first >= 750 && first <= 1_000, `lần 1 phải quanh 1s, nhận ${first}`);

    const second = computeRateLimitDelayMs(rateLimitError(), 2, options);
    assert.ok(second >= 1_500 && second <= 2_000, `lần 2 phải quanh 2s, nhận ${second}`);

    // Tăng mãi cũng không vượt trần.
    for (let strike = 1; strike <= 12; strike += 1) {
        assert.ok(
            computeRateLimitDelayMs(rateLimitError(), strike, options) <= 8_000,
            `lần ${strike} phải bị kẹp ở trần`
        );
    }
});

test("Retry-After lớn hơn trần vẫn bị kẹp ở trần (không treo vô hạn)", () => {
    const delay = computeRateLimitDelayMs(rateLimitError(9_999), 1, {
        backoffBaseMs: 1_000,
        backoffMaxMs: 60_000
    });
    assert.equal(delay, 60_000);
});

test("computeRateLimitDelayMs của module là chính sách dùng chung của dự án", () => {
    // Không tự cài lại công thức ở nơi khác: giá trị phải khớp deliveryErrors.
    const { computeRetryDelayMs } = require("../deliveryErrors");
    const error = rateLimitError(5);
    assert.equal(
        computeRateLimitDelayMs(error, 3, { backoffBaseMs: 1_000, backoffMaxMs: 60_000 }),
        computeRetryDelayMs(error, 3, { baseMs: 1_000, maxMs: 60_000 })
    );
});

/* -------------------------------------------------------------------------- */
/* 3. Dừng nhà cung cấp sau nhiều lần 429                                      */
/* -------------------------------------------------------------------------- */

test("429 lặp lại trong cửa sổ ⇒ tạm dừng nhà cung cấp", () => {
    const options = { maxRateLimitStrikes: 3, strikeWindowMs: 60_000, pauseMs: 300_000 };
    let paced = { strikes: [], pausedUntil: 0, pauseReason: null };
    let now = 10_000;

    paced = { ...paced, ...registerRateLimit(paced, now, options) };
    assert.equal(paced.pausedUntil, 0, "1 lần 429 chưa đủ để khoá");
    now += 1_000;
    paced = { ...paced, ...registerRateLimit(paced, now, options) };
    assert.equal(paced.pausedUntil, 0, "2 lần 429 chưa đủ để khoá");
    now += 1_000;
    paced = { ...paced, ...registerRateLimit(paced, now, options) };
    assert.equal(paced.strikeCount, 3);
    assert.equal(paced.pausedUntil, now + 300_000, "lần thứ 3 phải khoá nhà cung cấp");
    assert.equal(paced.pauseReason, "rate_limited");
});

test("429 rải rác ngoài cửa sổ KHÔNG tích luỹ thành khoá oan", () => {
    const options = { maxRateLimitStrikes: 3, strikeWindowMs: 10_000, pauseMs: 300_000 };
    let paced = { strikes: [], pausedUntil: 0, pauseReason: null };
    // Ba lần 429 cách nhau 20s — mỗi lần cửa sổ đã trôi hết.
    let now = 0;
    for (let index = 0; index < 3; index += 1) {
        paced = { ...paced, ...registerRateLimit(paced, now, options) };
        now += 20_000;
    }
    assert.equal(paced.pausedUntil, 0, "429 rải rác không được làm khoá nhà cung cấp");
});

test("gửi thành công làm dịu bớt số lần 429 đã đếm", () => {
    const clock = virtualClock();
    const pacing = createPacingController({
        settings: { intervalMs: 1, maxRateLimitStrikes: 3, pauseMs: 60_000, strikeWindowMs: 60_000 },
        sleep: clock.sleep,
        now: clock.now
    });
    pacing.onRateLimit("bot1", rateLimitError(1));
    pacing.onRateLimit("bot1", rateLimitError(1));
    assert.equal(pacing.entryFor("bot1").strikeCount, 2);

    pacing.onSuccess("bot1");
    assert.equal(pacing.entryFor("bot1").strikeCount, 1, "một tin đi qua phải xoá bớt một vết 429");
    // Và lần 429 kế tiếp chưa đủ ngưỡng nên không khoá.
    const strike = pacing.onRateLimit("bot1", rateLimitError(1));
    assert.equal(strike.paused, false);
});

/* -------------------------------------------------------------------------- */
/* 4. Toàn bộ đường gửi: nhịp, hoãn, và không vòng lặp nhanh                    */
/* -------------------------------------------------------------------------- */

test("nguồn có 429 ⇒ nhà cung cấp bị tạm dừng, phần còn lại ghi HOÃN chứ không bắn nốt", async (t) => {
    const dir = tempDir(t);
    const campaign = uniqueCampaign("pacing-stop");
    t.after(() => fs.rmSync(path.join(CHECKPOINT_DIR, `${campaign}.json`), { force: true }));

    // 6 đích của bot1, tất cả đều 429.
    const records = {};
    for (let index = 1; index <= 6; index += 1) records[`r${index}`] = { chatId: `10${index}`, botId: "bot1" };
    const source = writeSource(dir, records);
    const messageFile = writeMessage(dir);

    const log = [];
    const registry = registryOf([fakeProvider("bot1", () => { throw rateLimitError(1); }, log)]);
    const clock = virtualClock();

    const result = await main(
        ["--campaign", campaign, "--message-file", messageFile, "--source", source, "--send",
            "--interval-ms", "1000"],
        {
            runtimeRegistry: registry,
            sleep: clock.sleep,
            now: clock.now,
            // Cấu hình chặt để bài kiểm tra chứng minh được việc DỪNG.
            pacing: { maxRateLimitStrikes: 2, pauseMs: 600_000, strikeWindowMs: 300_000 }
        }
    );

    // Chỉ 2 lần thử: lần 1 và lần 2 (lần 2 chạm ngưỡng ⇒ dừng). KHÔNG được thử cả 6.
    assert.equal(log.length, 2, `chỉ được thử 2 lần rồi dừng, đã thử ${log.length}`);
    assert.equal(result.sent, 0);
    assert.equal(result.rateLimited, 2, "cả hai lần thử đều là 429");
    // Số ĐÍCH ĐÃ THỬ là 2 (cả hai đều 429). Mọi đích còn lại phải được ghi `deferred`.
    assert.ok(result.deferred >= 4, `4 đích chưa thử phải được ghi hoãn, nhận ${result.deferred}`);
    assert.equal(result.failed, 0, "429 KHÔNG phải thất bại — phải thử lại được");
    assert.deepEqual(Object.keys(result.paused), ["bot1"]);

    // Checkpoint phải ghi lại nhà cung cấp đang tạm dừng, để lần chạy tiếp không
    // thử lại ngay.
    const saved = readSavedCheckpoint(campaign);
    assert.ok(saved.paused.bot1, "checkpoint phải giữ trạng thái tạm dừng");
    assert.equal(saved.paused.bot1.reason, "rate_limited");
    // Mọi đích chưa gửi được nằm ở `deferred`, KHÔNG nằm ở `failed`: chúng phải được
    // thử lại ở lần resume. Không ai lọt vào `failed` và không ai vào `sent`.
    const deferredKeys = Object.keys(saved.deferred);
    assert.ok(deferredKeys.length >= 4, "các đích chưa thử phải nằm ở deferred");
    assert.equal(Object.keys(saved.sent).length, 0);
    assert.equal(Object.keys(saved.failed).length, 0);
});

test("429 KHÔNG tạo vòng lặp nhanh: mỗi lần 429 đều chờ ít nhất bằng interval", async (t) => {
    const dir = tempDir(t);
    const campaign = uniqueCampaign("pacing-no-fastloop");
    t.after(() => fs.rmSync(path.join(CHECKPOINT_DIR, `${campaign}.json`), { force: true }));

    const source = writeSource(dir, { a: { chatId: "1", botId: "bot1" }, b: { chatId: "2", botId: "bot1" } });
    const messageFile = writeMessage(dir);

    const log = [];
    // 429 KHÔNG kèm Retry-After và cấu hình cho phép nhiều lần thử.
    const registry = registryOf([fakeProvider("bot1", () => { throw rateLimitError(); }, log)]);
    const clock = virtualClock();

    await main(
        ["--campaign", campaign, "--message-file", messageFile, "--source", source, "--send",
            "--interval-ms", "1000"],
        {
            runtimeRegistry: registry,
            sleep: clock.sleep,
            now: clock.now,
            pacing: { maxRateLimitStrikes: 99, strikeWindowMs: 300_000, backoffBaseMs: 500, backoffMaxMs: 60_000 }
        }
    );

    assert.equal(log.length, 2, "cả hai đích đều được thử khi chưa chạm ngưỡng");
    // Đã phải ngủ ít nhất một lần, và mọi khoảng ngủ đều ≥ interval: không có đường
    // nào bắn liên tiếp sau 429.
    assert.ok(clock.sleeps.length >= 1, "phải có khoảng chờ sau 429");
    for (const ms of clock.sleeps) {
        assert.ok(ms >= 1000, `khoảng chờ ${ms}ms phải ≥ interval 1000ms`);
    }
});

test("429 vẫn cho các nhà cung cấp khác chạy hết trong cùng một đợt", async (t) => {
    const dir = tempDir(t);
    const campaign = uniqueCampaign("pacing-isolation");
    t.after(() => fs.rmSync(path.join(CHECKPOINT_DIR, `${campaign}.json`), { force: true }));

    const source = writeSource(dir, {
        a: { chatId: "11", botId: "bot1" },
        b: { chatId: "12", botId: "bot1" },
        c: { chatId: "21", botId: "bot2" },
        d: { chatId: "22", botId: "bot2" }
    });
    const messageFile = writeMessage(dir);

    const log = [];
    const registry = registryOf([
        fakeProvider("bot1", () => { throw rateLimitError(1); }, log),
        fakeProvider("bot2", () => ({ message_id: "ok" }), log)
    ]);
    const clock = virtualClock();

    const result = await main(
        ["--campaign", campaign, "--message-file", messageFile, "--source", source, "--send"],
        {
            runtimeRegistry: registry,
            sleep: clock.sleep,
            now: clock.now,
            pacing: { maxRateLimitStrikes: 2, pauseMs: 600_000 }
        }
    );

    // bot2 hoàn thành cả hai đích dù bot1 bị khoá tốc độ.
    assert.equal(result.sent, 2);
    const bot2Log = log.filter((item) => item.botId === "bot2");
    assert.equal(bot2Log.length, 2, "bot2 phải gửi đủ, không bị bot1 cản");
    // bot1 chỉ được thử 2 lần rồi dừng.
    assert.equal(log.filter((item) => item.botId === "bot1").length, 2);
});

test("nhà cung cấp ĐANG tạm dừng (từ checkpoint) không được thử lại ngay ở lần chạy tiếp", async (t) => {
    const dir = tempDir(t);
    const campaign = uniqueCampaign("pacing-resume-paused");
    t.after(() => fs.rmSync(path.join(CHECKPOINT_DIR, `${campaign}.json`), { force: true }));

    const source = writeSource(dir, { a: { chatId: "11", botId: "bot1" } });
    const messageFile = writeMessage(dir);

    // Checkpoint cũ: bot1 vừa bị tạm dừng 10 phút tính từ hiện tại.
    const hash = require("../scripts/sendRecoveredAnnouncement");
    writeCheckpoint(campaign, {
        contentHash: null,
        sent: {},
        failed: {},
        deferred: {},
        paused: { bot1: { reason: "rate_limited", resumeInMs: 600_000, at: new Date().toISOString() } },
        pacing: {
            bot1: {
                strikes: [Date.now() - 1_000, Date.now() - 500, Date.now()],
                strikeCount: 3,
                pausedUntil: Date.now() + 600_000,
                pauseReason: "rate_limited",
                sent: 0
            }
        }
    });
    void hash;

    const log = [];
    const registry = registryOf([fakeProvider("bot1", () => ({ message_id: "ok" }), log)]);
    const clock = virtualClock({ start: Date.now() });

    const result = await main(
        ["--campaign", campaign, "--message-file", messageFile, "--source", source, "--send"],
        { runtimeRegistry: registry, sleep: clock.sleep, now: clock.now }
    );

    assert.equal(log.length, 0, "nhà cung cấp đang tạm dừng KHÔNG được gửi lần nào");
    assert.equal(result.deferred, 1);
    assert.equal(result.sent, 0);
});

/* -------------------------------------------------------------------------- */
/* 5. Chạy tiếp: chỉ gửi người chưa gửi + người lỗi tạm thời                    */
/* -------------------------------------------------------------------------- */

test("chạy tiếp không gửi lại 31 người đã thành công và không thử lại 410/422", async (t) => {
    const dir = tempDir(t);
    const campaign = uniqueCampaign("pacing-resume");
    t.after(() => fs.rmSync(path.join(CHECKPOINT_DIR, `${campaign}.json`), { force: true }));

    const records = {};
    const sentKeys = [];
    const permanentKeys = [];
    const retryableKeys = [];
    // 5 đã gửi (đại diện cho 31 thực tế), 2 vĩnh viễn (410/422), 3 lỗi tạm thời/429.
    for (let index = 1; index <= 5; index += 1) { records[`s${index}`] = { chatId: `1${index}`, botId: "bot1" }; sentKeys.push(recipientKey("bot1", `1${index}`)); }
    for (let index = 1; index <= 2; index += 1) { records[`p${index}`] = { chatId: `2${index}`, botId: "bot2" }; permanentKeys.push(recipientKey("bot2", `2${index}`)); }
    for (let index = 1; index <= 3; index += 1) { records[`t${index}`] = { chatId: `3${index}`, botId: "bot3" }; retryableKeys.push(recipientKey("bot3", `3${index}`)); }

    const source = writeSource(dir, records);
    const messageFile = writeMessage(dir);

    const sent = {};
    for (const key of sentKeys) sent[key] = { at: "x" };
    const failed = {};
    for (const key of permanentKeys) failed[key] = { reason: "không có quyền gửi tới chat này (422)", permanent: true };
    for (const key of retryableKeys) failed[key] = { reason: "Bị giới hạn tốc độ (429)", permanent: false };
    writeCheckpoint(campaign, { contentHash: null, sent, failed, deferred: {}, paused: {}, pacing: {} });

    const log = [];
    const registry = registryOf([
        fakeProvider("bot1", () => ({ message_id: "ok" }), log),
        fakeProvider("bot2", () => ({ message_id: "ok" }), log),
        fakeProvider("bot3", () => ({ message_id: "ok" }), log)
    ]);
    const clock = virtualClock();

    const result = await main(
        ["--campaign", campaign, "--message-file", messageFile, "--source", source, "--send"],
        { runtimeRegistry: registry, sleep: clock.sleep, now: clock.now }
    );

    assert.equal(result.alreadySent, 5, "5 người đã gửi phải bị bỏ qua");
    assert.equal(result.skippedPermanent, 2, "2 người lỗi vĩnh viễn phải bị bỏ qua");
    assert.equal(result.sent, 3, "chỉ 3 người lỗi tạm thời được gửi lại");
    assert.equal(log.length, 3);

    // KHÔNG một đích nào bị gửi hai lần, và không đích đã-gửi/410-422 nào được thử.
    const keys = log.map((item) => recipientKey(item.botId, item.chatId));
    assert.equal(new Set(keys).size, keys.length, "không được gửi trùng");
    for (const key of sentKeys) assert.ok(!keys.includes(key), `người đã gửi ${key} không được gửi lại`);
    for (const key of permanentKeys) assert.ok(!keys.includes(key), `lỗi vĩnh viễn ${key} không được thử lại`);

    // Và checkpoint cuối cùng giữ đủ 8 người "xong", chỉ còn 3 người mới gửi.
    const saved = readSavedCheckpoint(campaign);
    assert.equal(Object.keys(saved.sent).length, 8);
    assert.equal(Object.keys(saved.failed).length, 2, "lỗi vĩnh viễn vẫn được giữ (không bị xoá)");
});

test("sau khi nhà cung cấp hết tạm dừng, chạy tiếp gửi nốt phần đã hoãn", async (t) => {
    const dir = tempDir(t);
    const campaign = uniqueCampaign("pacing-resume-after-pause");
    t.after(() => fs.rmSync(path.join(CHECKPOINT_DIR, `${campaign}.json`), { force: true }));

    const source = writeSource(dir, { a: { chatId: "11", botId: "bot1" }, b: { chatId: "12", botId: "bot1" } });
    const messageFile = writeMessage(dir);

    // Lần 1: cả hai đích đều bị 429 hai lần ⇒ bot1 bị tạm dừng.
    const firstLog = [];
    const clock1 = virtualClock();
    const registry1 = registryOf([fakeProvider("bot1", () => { throw rateLimitError(1); }, firstLog)]);
    await main(
        ["--campaign", campaign, "--message-file", messageFile, "--source", source, "--send"],
        { runtimeRegistry: registry1, sleep: clock1.sleep, now: clock1.now, pacing: { maxRateLimitStrikes: 2, pauseMs: 600_000 } }
    );
    assert.equal(firstLog.length, 2);

    // Lần 2: đã qua thời gian tạm dừng (đồng hồ nhích 20 phút), nhà cung cấp hoạt
    // động lại và gửi nốt hai đích đã hoãn.
    const secondLog = [];
    const registry2 = registryOf([fakeProvider("bot1", () => ({ message_id: "ok" }), secondLog)]);
    const savedBefore = readSavedCheckpoint(campaign);
    savedBefore.pacing.bot1.pausedUntil = Date.now() - 1_000;   // hết hạn tạm dừng
    writeCheckpoint(campaign, savedBefore);

    const clock2 = virtualClock({ start: Date.now() });
    const result = await main(
        ["--campaign", campaign, "--message-file", messageFile, "--source", source, "--send"],
        { runtimeRegistry: registry2, sleep: clock2.sleep, now: clock2.now }
    );

    assert.equal(result.sent, 2, "hai đích đã hoãn phải được gửi nốt");
    assert.equal(secondLog.length, 2);
    const savedAfter = readSavedCheckpoint(campaign);
    assert.equal(Object.keys(savedAfter.sent).length, 2);
    // Tất cả đều là 429 tạm thời nên không có thất bại vĩnh viễn nào.
    assert.equal(Object.keys(savedAfter.failed).length, 0);
});

/* -------------------------------------------------------------------------- */
/* 6. Cấu hình: mặc định thận trọng và luôn bị kẹp                             */
/* -------------------------------------------------------------------------- */

test("mặc định thận trọng: ≥ 1s giữa hai tin và chỉ một đích mỗi nhà cung cấp", () => {
    assert.ok(PACING_DEFAULTS.intervalMs >= 1_000, "mặc định phải thận trọng");
    assert.equal(PACING_DEFAULTS.concurrency, 1, "một đích tại một thời điểm cho mỗi nhà cung cấp");
    assert.ok(PACING_DEFAULTS.maxRateLimitStrikes >= 2, "phải có ngưỡng dừng");
    assert.ok(PACING_DEFAULTS.backoffMaxMs >= PACING_DEFAULTS.backoffBaseMs);
});

test("cấu hình nhịp luôn bị kẹp về khoảng an toàn, kể cả giá trị phá hoại", () => {
    // Cấu hình sai (0 hoặc âm) không được phép biến thành "bắn không giới hạn".
    assert.equal(clampInterval(0), PACING_DEFAULTS.minIntervalMs);
    assert.equal(clampInterval(-5_000), PACING_DEFAULTS.minIntervalMs);
    assert.equal(clampInterval(1), PACING_DEFAULTS.minIntervalMs);
    assert.equal(clampInterval(Number.MAX_SAFE_INTEGER), PACING_DEFAULTS.maxIntervalMs);
    assert.equal(resolvePacingOptions({ intervalMs: 1 }, {}).intervalMs, PACING_DEFAULTS.minIntervalMs);
    // Giá trị hợp lệ nhưng chậm hơn mặc định thì được giữ nguyên (chỉ bị kẹp, không bị ép).
    assert.equal(resolvePacingOptions({ intervalMs: "500" }, {}).intervalMs, 500);
    assert.equal(resolvePacingOptions({ intervalMs: "nonsense" }, {}).intervalMs, PACING_DEFAULTS.intervalMs);
    // `0` (và chuỗi rỗng) được coi là "không chỉ định" nên rơi về mặc định thận trọng
    // — vẫn an toàn, không bao giờ thành "bắn không giới hạn".
    assert.ok(resolvePacingOptions({ intervalMs: 0 }, {}).intervalMs >= 1_000);
    assert.ok(resolvePacingOptions({ intervalMs: "" }, {}).intervalMs >= 1_000);
});

test("createPacingController cũng kẹp interval, không chỉ resolvePacingOptions", () => {
    // Chốt an toàn cuối: dù cấu hình đi đường nào, nhịp vẫn không thể nhanh hơn sàn.
    const pacing = createPacingController({ settings: { intervalMs: 0 } });
    assert.equal(pacing.settings.intervalMs, PACING_DEFAULTS.minIntervalMs);
    const negative = createPacingController({ settings: { intervalMs: -10_000 } });
    assert.equal(negative.settings.intervalMs, PACING_DEFAULTS.minIntervalMs);
    // Và khoá lạ không lọt được vào settings.
    const strange = createPacingController({ settings: { intervalMs: 500, somethingElse: true } });
    assert.equal(strange.settings.somethingElse, undefined);
});

test("nhịp đọc từ biến môi trường khi không có tham số", () => {
    assert.equal(
        resolvePacingOptions({}, { ANNOUNCE_SEND_INTERVAL_MS: "2500" }).intervalMs,
        2500
    );
    // Tham số tường minh thắng biến môi trường.
    assert.equal(
        resolvePacingOptions({ intervalMs: 400 }, { ANNOUNCE_SEND_INTERVAL_MS: "2500" }).intervalMs,
        400
    );
});

test("checkpoint giữ trạng thái nhịp qua một vòng ghi/đọc", () => {
    const clock = virtualClock();
    const pacing = createPacingController({
        settings: { intervalMs: 100, maxRateLimitStrikes: 2, pauseMs: 60_000 },
        sleep: clock.sleep,
        now: clock.now
    });
    pacing.onRateLimit("bot1", rateLimitError(1));
    pacing.onRateLimit("bot1", rateLimitError(1));
    const snapshot = pacing.snapshot();
    assert.ok(snapshot.bot1, "nhà cung cấp từng bị 429 phải được lưu");

    const restored = createPacingController({ settings: { intervalMs: 100 }, sleep: clock.sleep, now: clock.now });
    restored.restore(snapshot);
    assert.equal(restored.entryFor("bot1").pausedUntil, snapshot.bot1.pausedUntil);
    assert.equal(restored.entryFor("bot1").pauseReason, "rate_limited");
});

test("trạng thái nhịp hỏng trong checkpoint bị bỏ qua, không làm sập đợt gửi", () => {
    const { sanitizePacingState } = require("../scripts/sendRecoveredAnnouncement");
    assert.deepEqual(sanitizePacingState(null), {});
    assert.deepEqual(sanitizePacingState("rác"), {});
    assert.deepEqual(sanitizePacingState([]), {});
    assert.deepEqual(sanitizePacingState({ bot1: "rác" }), {});
    const cleaned = sanitizePacingState({ bot1: { strikes: ["x", 5, null], pausedUntil: "abc" } });
    assert.deepEqual(cleaned.bot1.strikes, [5]);
    assert.equal(cleaned.bot1.pausedUntil, 0);
});

/* -------------------------------------------------------------------------- */
/* 7. Không gửi trùng trong mọi tình huống                                     */
/* -------------------------------------------------------------------------- */

test("cùng một đích không bao giờ được gửi hai lần trong một đợt", async (t) => {
    const dir = tempDir(t);
    const campaign = uniqueCampaign("pacing-nodup");
    t.after(() => fs.rmSync(path.join(CHECKPOINT_DIR, `${campaign}.json`), { force: true }));

    // Nguồn cố tình chứa bản ghi trùng (cùng botId + chatId).
    const source = writeSource(dir, {
        a: { chatId: "77", botId: "bot1" },
        b: { chatId: "77", botId: "bot1" },
        c: { chatId: "88", botId: "bot1" }
    });
    const messageFile = writeMessage(dir);

    const log = [];
    const registry = registryOf([fakeProvider("bot1", () => ({ message_id: "ok" }), log)]);
    const clock = virtualClock();

    const result = await main(
        ["--campaign", campaign, "--message-file", messageFile, "--source", source, "--send"],
        { runtimeRegistry: registry, sleep: clock.sleep, now: clock.now }
    );

    assert.equal(result.sent, 2, "bản ghi trùng phải bị gộp");
    const chatIds = log.map((item) => item.chatId);
    assert.equal(new Set(chatIds).size, chatIds.length, "không có chatId nào bị gửi hai lần");
});

test("planSend bỏ qua người đã gửi và người lỗi vĩnh viễn, giữ người lỗi tạm thời", () => {
    const recipients = [
        { botId: "bot1", chatId: "1", key: "bot1::1" },
        { botId: "bot1", chatId: "2", key: "bot1::2" },
        { botId: "bot1", chatId: "3", key: "bot1::3" }
    ];
    const plan = planSend(recipients, {
        sent: { "bot1::1": { at: "x" } },
        failed: {
            "bot1::2": { reason: "422", permanent: true },
            "bot1::3": { reason: "429", permanent: false }
        }
    });
    assert.equal(plan.alreadySent, 1);
    assert.equal(plan.skippedPermanent, 1);
    assert.deepEqual(plan.toSend.map((item) => item.chatId), ["3"]);
});

test("gửi lỗi 410 cũng là vĩnh viễn và không được thử lại", async (t) => {
    const dir = tempDir(t);
    const campaign = uniqueCampaign("pacing-410");
    t.after(() => fs.rmSync(path.join(CHECKPOINT_DIR, `${campaign}.json`), { force: true }));

    const source = writeSource(dir, { a: { chatId: "99", botId: "bot1" } });
    const messageFile = writeMessage(dir);

    const log = [];
    const registry = registryOf([fakeProvider("bot1", () => { throw permanentError(410); }, log)]);
    const clock = virtualClock();

    const first = await main(
        ["--campaign", campaign, "--message-file", messageFile, "--source", source, "--send"],
        { runtimeRegistry: registry, sleep: clock.sleep, now: clock.now }
    );
    assert.equal(first.failed, 1);
    assert.equal(log.length, 1);

    // Chạy tiếp: KHÔNG được thử lại đích 410.
    const second = await main(
        ["--campaign", campaign, "--message-file", messageFile, "--source", source, "--send"],
        { runtimeRegistry: registry, sleep: clock.sleep, now: clock.now }
    );
    assert.equal(second.skippedPermanent, 1);
    assert.equal(log.length, 1, "410 không bao giờ được thử lại");
});
