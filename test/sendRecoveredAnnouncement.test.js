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
    classifyRecipients,
    planSend,
    recipientKey
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
