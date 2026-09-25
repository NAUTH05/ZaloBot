// ============================================================================
// Bài kiểm tra bộ gửi thông báo MỘT LẦN từ file liên hệ khôi phục.
//
// Mục tiêu: chứng minh nó chỉ ĐỌC file nguồn, khử trùng theo (botId, chatId),
// ghi checkpoint để chạy tiếp không gửi lại, và hoãn phần ZCA khi không có phiên.
// ============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    campaignContentHash,
    classifyRecipients,
    normalizeCampaignMessage,
    normalizeOfficialConfigs,
    planSend,
    printReport,
    readCheckpoint,
    recipientKey,
    verifyCheckpointContent,
    writeCheckpoint
} = require("../scripts/sendRecoveredAnnouncement");

/* ------------------------------ phân loại -------------------------------- */

test("khử trùng theo (botId, chatId): cùng chatId ở hai bot là hai người nhận", () => {
    const { recipients } = classifyRecipients({
        "a": { chatId: "100", botId: "bot1" },
        "b": { chatId: "100", botId: "bot2" }
    });
    assert.equal(recipients.length, 2);
    assert.deepEqual(new Set(recipients.map((item) => item.key)), new Set(["bot1::100", "bot2::100"]));
});

test("bản ghi trùng (botId, chatId) trong nguồn bị gộp", () => {
    const { recipients, duplicates } = classifyRecipients({
        "a": { chatId: "100", botId: "bot1" },
        "b": { chatId: "100", botId: "bot1" }
    });
    assert.equal(recipients.length, 1);
    assert.equal(duplicates, 1);
});

test("bản ghi không khai báo botId bị loại — KHÔNG đoán bot1", () => {
    const { recipients, excluded } = classifyRecipients({ "a": { chatId: "100" } });
    assert.equal(recipients.length, 0);
    assert.equal(excluded.length, 1);
    assert.match(excluded[0].reason, /botId/);
});

test("khóa lưu trữ lệch với botId khai báo thì bị loại", () => {
    const { recipients, excluded } = classifyRecipients({
        "bot2::5001": { chatId: "5001", botId: "bot3" }
    });
    assert.equal(recipients.length, 0);
    assert.equal(excluded.length, 1);
    assert.match(excluded[0].reason, /lệch/);
});

test("đếm người nhận theo từng bot", () => {
    const { perBot } = classifyRecipients([
        { chatId: "1", botId: "bot1" },
        { chatId: "2", botId: "bot1" },
        { chatId: "3", botId: "bot2" },
        { chatId: "4", botId: "zca:u1" }
    ]);
    assert.deepEqual(perBot, { bot1: 2, bot2: 1, "zca:u1": 1 });
});

/* ------------------------------- checkpoint ------------------------------ */

test("chạy tiếp KHÔNG gửi lại người đã gửi thành công", () => {
    const recipients = [
        { botId: "bot1", chatId: "1", key: recipientKey("bot1", "1") },
        { botId: "bot1", chatId: "2", key: recipientKey("bot1", "2") }
    ];
    const checkpoint = { sent: { [recipientKey("bot1", "1")]: { at: "x" } } };
    const { toSend, alreadySent } = planSend(recipients, checkpoint);
    assert.equal(alreadySent, 1);
    assert.equal(toSend.length, 1);
    assert.equal(toSend[0].chatId, "2");
});

test("checkpoint trống thì gửi tất cả", () => {
    const recipients = [{ botId: "bot2", chatId: "9", key: recipientKey("bot2", "9") }];
    const { toSend, alreadySent } = planSend(recipients, { sent: {} });
    assert.equal(alreadySent, 0);
    assert.equal(toSend.length, 1);
});

/* ------------------------------- dry-run --------------------------------- */

test("dry-run KHÔNG ghi checkpoint và KHÔNG gọi gửi", async (t) => {
    const { main, CHECKPOINT_DIR } = require("../scripts/sendRecoveredAnnouncement");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-announce-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const sourceFile = path.join(dir, "src.json");
    fs.writeFileSync(sourceFile, JSON.stringify({ a: { chatId: "1", botId: "bot1" } }), "utf8");
    const messageFile = path.join(dir, "msg.txt");
    fs.writeFileSync(messageFile, "Xin lỗi các bạn.", "utf8");

    const result = await main(
        ["--campaign", "dry-test", "--message-file", messageFile, "--source", sourceFile],
        {}
    );
    assert.equal(result.dryRun, true);
    assert.equal(result.planned, 1);
    // Không có file checkpoint nào được tạo cho chiến dịch này.
    const checkpointFile = path.join(CHECKPOINT_DIR, "dry-test.json");
    assert.equal(fs.existsSync(checkpointFile), false);
});

test("--send mà không có registry nhà cung cấp thì TỪ CHỐI (không tự mở phiên)", async (t) => {
    const { main } = require("../scripts/sendRecoveredAnnouncement");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-announce-send-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const sourceFile = path.join(dir, "src.json");
    fs.writeFileSync(sourceFile, JSON.stringify({ a: { chatId: "1", botId: "bot1" } }), "utf8");
    const messageFile = path.join(dir, "msg.txt");
    fs.writeFileSync(messageFile, "Xin lỗi các bạn.", "utf8");

    await assert.rejects(
        () => main(["--campaign", "no-registry", "--message-file", messageFile, "--source", sourceFile, "--send"], {}),
        /registry nhà cung cấp/
    );
});

/* ------------------------- lỗi vĩnh viễn & resume ------------------------ */

// Lỗi 410/422 không bao giờ tự khỏi. Chạy tiếp KHÔNG được thử lại chúng, và
// tuyệt đối không được chuyển sang bot khác để thử.
test("resume BỎ QUA người đã thất bại vĩnh viễn (410/422)", () => {
    const recipients = [
        { botId: "bot1", chatId: "1", key: recipientKey("bot1", "1") },
        { botId: "bot1", chatId: "2", key: recipientKey("bot1", "2") },
        { botId: "bot1", chatId: "3", key: recipientKey("bot1", "3") }
    ];
    const checkpoint = {
        sent: { [recipientKey("bot1", "1")]: { at: "x" } },
        failed: {
            [recipientKey("bot1", "2")]: { reason: "chat không tồn tại (410)", permanent: true },
            [recipientKey("bot1", "3")]: { reason: "timeout", permanent: false }
        }
    };
    const { toSend, alreadySent, skippedPermanent } = planSend(recipients, checkpoint);
    assert.equal(alreadySent, 1, "người đã gửi thành công bị bỏ qua");
    assert.equal(skippedPermanent, 1, "người thất bại vĩnh viễn bị bỏ qua");
    assert.equal(toSend.length, 1, "chỉ còn người thất bại TẠM THỜI được thử lại");
    assert.equal(toSend[0].chatId, "3");
});

test("lỗi tạm thời KHÔNG có cờ permanent vẫn được thử lại ở lần resume", () => {
    const recipients = [{ botId: "bot2", chatId: "9", key: recipientKey("bot2", "9") }];
    const checkpoint = { sent: {}, failed: { [recipientKey("bot2", "9")]: { reason: "429" } } };
    const { toSend, skippedPermanent } = planSend(recipients, checkpoint);
    assert.equal(toSend.length, 1);
    assert.equal(skippedPermanent, 0);
});

/* --------------------------- vân tay nội dung ---------------------------- */

test("vân tay nội dung đổi khi nội dung tin đổi", () => {
    const recipients = [{ botId: "bot1", chatId: "1", key: recipientKey("bot1", "1") }];
    const a = campaignContentHash(recipients, "Nội dung A");
    const b = campaignContentHash(recipients, "Nội dung B");
    assert.notEqual(a, b);
});

test("vân tay nội dung không đổi theo thứ tự bản ghi trong nguồn", () => {
    const a = campaignContentHash(
        [{ botId: "bot1", chatId: "1", key: "bot1::1" }, { botId: "bot2", chatId: "2", key: "bot2::2" }],
        "Cùng nội dung"
    );
    const b = campaignContentHash(
        [{ botId: "bot2", chatId: "2", key: "bot2::2" }, { botId: "bot1", chatId: "1", key: "bot1::1" }],
        "Cùng nội dung"
    );
    assert.equal(a, b);
});

test("vân tay nội dung đổi khi nguồn có thêm người nhận", () => {
    const a = campaignContentHash([{ botId: "bot1", chatId: "1", key: "bot1::1" }], "Tin");
    const b = campaignContentHash(
        [{ botId: "bot1", chatId: "1", key: "bot1::1" }, { botId: "bot1", chatId: "2", key: "bot1::2" }],
        "Tin"
    );
    assert.notEqual(a, b);
});

test("checkpoint khớp vân tay thì cho chạy", () => {
    const hash = "abc123";
    assert.deepEqual(verifyCheckpointContent({ campaignId: "c", contentHash: hash }, hash), { ok: true, reason: null });
});

test("checkpoint CHƯA có vân tay (bản cũ) thì cho chạy để tương thích", () => {
    const result = verifyCheckpointContent({ campaignId: "c", contentHash: null }, "any");
    assert.equal(result.ok, true);
});

test("đổi nội dung mà giữ mã chiến dịch thì TỪ CHỐI", () => {
    const result = verifyCheckpointContent({ campaignId: "reset-2026-09", contentHash: "aaa" }, "bbb");
    assert.equal(result.ok, false);
    assert.match(result.reason, /KHÁC/);
    assert.match(result.reason, /reset-2026-09/);
});

test("gửi với nội dung khác nhưng cùng mã chiến dịch thì main TỪ CHỐI", async (t) => {
    const { main, CHECKPOINT_DIR } = require("../scripts/sendRecoveredAnnouncement");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-announce-hash-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const sourceFile = path.join(dir, "src.json");
    fs.writeFileSync(sourceFile, JSON.stringify({ a: { chatId: "1", botId: "bot1" } }), "utf8");
    const messageFile = path.join(dir, "msg.txt");
    fs.writeFileSync(messageFile, "Bản gốc.", "utf8");

    const campaign = `hash-test-${process.pid}`;
    const t1 = path.join(CHECKPOINT_DIR, `${campaign}.json`);
    t.after(() => fs.rmSync(t1, { force: true }));

    // Ghi checkpoint tay: mô phỏng một lượt chạy trước với nội dung khác.
    const before = campaignContentHash([{ key: "bot1::1" }], "Nội dung hoàn toàn khác");
    writeCheckpoint(campaign, { contentHash: before, sent: { "bot1::1": { at: "x" } }, failed: {}, deferred: {} });

    await assert.rejects(
        () => main(["--campaign", campaign, "--message-file", messageFile, "--source", sourceFile], {}),
        /KHÁC/
    );
});

test("chuẩn hoá nội dung bỏ khoảng trắng hai đầu nên không đổi vân tay", () => {
    assert.equal(normalizeCampaignMessage("  Tin  \n"), "Tin");
    const a = campaignContentHash([{ key: "bot1::1" }], normalizeCampaignMessage("  Tin  "));
    const b = campaignContentHash([{ key: "bot1::1" }], normalizeCampaignMessage("Tin"));
    assert.equal(a, b);
});

/* ------------------------- bốn danh tính nhà cung cấp ------------------- */

// Registry giả: 3 bot chính thức + 1 ZCA. Ghi lại mọi lần gửi để chứng minh mỗi
// đích đi ra bằng ĐÚNG nhà cung cấp của nó, không bao giờ rơi về bot1.
function makeFakeRegistry(overrides = {}) {
    const log = [];
    const providers = new Map();
    for (const botId of ["bot1", "bot2", "bot3", "zca:u1"]) {
        providers.set(botId, {
            botId,
            sendMessage: async (chatId, text) => {
                log.push({ botId, chatId, text });
                const custom = overrides[botId];
                if (typeof custom === "function") return custom(chatId, text);
                return { message_id: "ok" };
            },
            health: () => ({ authenticated: true, ready: true })
        });
    }
    return { registry: { get: (botId) => providers.get(botId) || null, list: () => [...providers.values()] }, log };
}

test("gửi đúng nhà cung cấp cho cả 4 danh tính, không rơi về bot1", async (t) => {
    const { main } = require("../scripts/sendRecoveredAnnouncement");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-announce-4bot-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const sourceFile = path.join(dir, "src.json");
    fs.writeFileSync(sourceFile, JSON.stringify({
        a: { chatId: "11", botId: "bot1" },
        b: { chatId: "22", botId: "bot2" },
        c: { chatId: "33", botId: "bot3" },
        d: { chatId: "44", botId: "zca:u1" }
    }), "utf8");
    const messageFile = path.join(dir, "msg.txt");
    fs.writeFileSync(messageFile, "Thông báo.", "utf8");

    const { registry, log } = makeFakeRegistry();
    const campaign = `four-${process.pid}`;
    t.after(() => fs.rmSync(path.join(CHECKPOINT_DIR_FOR_TEST(), `${campaign}.json`), { force: true }));

    const result = await main(
        ["--campaign", campaign, "--message-file", messageFile, "--source", sourceFile, "--send"],
        { runtimeRegistry: registry }
    );
    assert.equal(result.sent, 4);
    const byBot = {};
    for (const item of log) byBot[item.botId] = (byBot[item.botId] || 0) + 1;
    assert.deepEqual(byBot, { bot1: 1, bot2: 1, bot3: 1, "zca:u1": 1 });
    // Không đích nào của bot2/3/ZCA bị gửi bằng bot1.
    const viaBot1 = log.filter((item) => item.botId === "bot1").map((item) => item.chatId);
    assert.deepEqual(viaBot1, ["11"]);
});

test("ZCA không có trong tiến trình thì HOÃN chứ không thất bại", async (t) => {
    const { main } = require("../scripts/sendRecoveredAnnouncement");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-announce-zca-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const sourceFile = path.join(dir, "src.json");
    fs.writeFileSync(sourceFile, JSON.stringify({ d: { chatId: "44", botId: "zca:u1" } }), "utf8");
    const messageFile = path.join(dir, "msg.txt");
    fs.writeFileSync(messageFile, "Thông báo.", "utf8");

    // Registry rỗng: không có ZCA trong tiến trình.
    const { registry } = makeFakeRegistry();
    const emptyRegistry = { get: () => null, list: () => [] };
    void registry;
    const campaign = `zca-defer-${process.pid}`;
    t.after(() => fs.rmSync(path.join(CHECKPOINT_DIR_FOR_TEST(), `${campaign}.json`), { force: true }));

    const result = await main(
        ["--campaign", campaign, "--message-file", messageFile, "--source", sourceFile, "--send"],
        { runtimeRegistry: emptyRegistry }
    );
    assert.equal(result.sent, 0);
    assert.equal(result.deferred, 1, "ZCA không chạy ⇒ hoãn, KHÔNG phải thất bại");
    assert.equal(result.failed, 0);
    const checkpoint = readCheckpoint(campaign);
    assert.match(checkpoint.deferred[recipientKey("zca:u1", "44")].reason, /zca/);
});

test("bot chính thức đã đăng ký nhưng đang tắt ⇒ hoãn (bot_not_configured)", async (t) => {
    const { main } = require("../scripts/sendRecoveredAnnouncement");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-announce-off-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const sourceFile = path.join(dir, "src.json");
    fs.writeFileSync(sourceFile, JSON.stringify({ c: { chatId: "33", botId: "bot3" } }), "utf8");
    const messageFile = path.join(dir, "msg.txt");
    fs.writeFileSync(messageFile, "Thông báo.", "utf8");

    // Registry chỉ có bot1 — bot3 coi như đang tắt.
    const onlyBot1 = { get: (botId) => (botId === "bot1" ? makeFakeRegistry().registry.get("bot1") : null) };
    const campaign = `bot3-off-${process.pid}`;
    t.after(() => fs.rmSync(path.join(CHECKPOINT_DIR_FOR_TEST(), `${campaign}.json`), { force: true }));

    const result = await main(
        ["--campaign", campaign, "--message-file", messageFile, "--source", sourceFile, "--send"],
        { runtimeRegistry: onlyBot1 }
    );
    assert.equal(result.sent, 0);
    assert.equal(result.deferred, 1);
    assert.equal(result.failed, 0, "bot tắt là HOÃN, không phải thất bại — để còn thử lại");
});

/* --------------------------- cấu hình nhà cung cấp ----------------------- */

test("normalizeOfficialConfigs chấp nhận cả mảng trần lẫn { bots }", () => {
    const arr = [{ botId: "bot1" }];
    assert.deepEqual(normalizeOfficialConfigs(arr), arr);
    assert.deepEqual(normalizeOfficialConfigs({ bots: arr, errors: [] }), arr);
    assert.deepEqual(normalizeOfficialConfigs(null), []);
    assert.deepEqual(normalizeOfficialConfigs({ errors: [] }), []);
});

/* ------------------------------- báo cáo --------------------------------- */

test("báo cáo đếm đúng người thất bại vĩnh viễn và hoãn", () => {
    const campaign = `report-${process.pid}`;
    writeCheckpoint(campaign, {
        contentHash: "deadbeefcafe1234",
        sent: { "bot1::1": { at: "x" }, "bot2::2": { at: "x" } },
        failed: {
            "bot1::3": { reason: "410", permanent: true },
            "bot1::4": { reason: "timeout", permanent: false }
        },
        deferred: { "zca:u1::5": { reason: "zca_not_running_in_process" } }
    });
    const report = printReport(campaign);
    assert.equal(report.sent, 2);
    assert.equal(report.failed, 2);
    assert.equal(report.permanent, 1);
    assert.equal(report.deferred, 1);
    assert.deepEqual(report.perBot, { bot1: 1, bot2: 1 });
    fs.rmSync(path.join(CHECKPOINT_DIR_FOR_TEST(), `${campaign}.json`), { force: true });
});

// Đường dẫn thư mục checkpoint, lấy từ chính module để không lặp hằng số.
function CHECKPOINT_DIR_FOR_TEST() {
    return require("../scripts/sendRecoveredAnnouncement").CHECKPOINT_DIR;
}
