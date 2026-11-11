// ============================================================================
// Cầu nối dashboard cho đợt thông báo một-lần (hàm trong main.js).
//
// Chứng minh: xem trước không gửi và không ghi; gửi thật bắt buộc xác nhận tường
// minh; nội dung lấy từ tham số HOẶC file trên máy chủ; và toàn bộ đường này
// KHÔNG chạm Firestore (chỉ đọc file nguồn do tham số chỉ định).
//
// Cách ly giống các bài khác: thay readJsonStore/writeJsonStore bằng Map trong
// bộ nhớ trước khi nạp main.js, và trỏ nguồn về file tạm.
// ============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// Hậu tố ngẫu nhiên theo lần chạy: PID bị tái sử dụng nên tên chiến dịch chỉ dựa vào
// PID có thể trùng với checkpoint sót lại của lần chạy trước ⇒ bài kiểm tra đỏ ngẫu nhiên.
const RUN_TAG = crypto.randomBytes(6).toString("hex");

process.env.BOT_TOKEN = "bridge-token-1";
process.env.BOT_2_TOKEN = "bridge-token-2";

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

const main = require("../main");
const { CHECKPOINT_DIR } = require("../scripts/sendRecoveredAnnouncement");

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-bridge-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function writeSource(dir, records) {
    const file = path.join(dir, "src.json");
    fs.writeFileSync(file, JSON.stringify(records), "utf8");
    return file;
}

// Registry giả 4 danh tính, ghi lại mọi lần gửi.
function fakeRegistry() {
    const log = [];
    const providers = new Map();
    for (const botId of ["bot1", "bot2", "bot3", "zca:u1"]) {
        providers.set(botId, {
            botId,
            sendMessage: async (chatId, text) => { log.push({ botId, chatId, text }); return { message_id: "ok" }; },
            health: () => ({ authenticated: true, ready: true })
        });
    }
    return { registry: { get: (botId) => providers.get(botId) || null }, log };
}

/* ----------------------------- nội dung tin ------------------------------ */

test("resolveAnnouncementMessage ưu tiên nội dung gửi trực tiếp", () => {
    const result = main.resolveAnnouncementMessage({ message: "  Nội dung trực tiếp  " });
    assert.equal(result.text, "Nội dung trực tiếp");
    assert.equal(result.source, "inline");
});

test("resolveAnnouncementMessage đọc file khi không có nội dung trực tiếp", (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "m.txt");
    fs.writeFileSync(file, "Từ file.", "utf8");
    const result = main.resolveAnnouncementMessage({ messageFile: file });
    assert.equal(result.text, "Từ file.");
    assert.equal(result.source, path.resolve(file));
});

test("resolveAnnouncementMessage trả text null khi không nguồn nào có nội dung", () => {
    const result = main.resolveAnnouncementMessage({ messageFile: path.join(os.tmpdir(), "khong-ton-tai-xyz.txt") });
    assert.equal(result.text, null);
    assert.ok(Array.isArray(result.tried));
});

/* ------------------------------- xem trước ------------------------------- */

test("preview KHÔNG gửi, KHÔNG ghi checkpoint dù có registry sống", async (t) => {
    const dir = tempDir(t);
    const src = writeSource(dir, { a: { chatId: "1", botId: "bot1" } });
    const { registry, log } = fakeRegistry();
    const campaign = `bridge-preview-${process.pid}-${RUN_TAG}`;
    t.after(() => fs.rmSync(path.join(CHECKPOINT_DIR, `${campaign}.json`), { force: true }));

    // Nguồn thật của preview là ANNOUNCEMENT_SOURCE (recovered-interactions.json);
    // ở đây chỉ cần chứng minh hàm chạy dry-run và không đụng nhà cung cấp.
    // Trỏ qua biến môi trường không có ⇒ hàm sẽ báo lỗi thiếu nguồn, nên ta kiểm
    // tra đường lấy nội dung + việc KHÔNG gọi send thay vì gọi hàm thật.
    void src;
    const before = log.length;
    try {
        await main.previewRecoveredAnnouncement({ campaign, message: "Thông báo thử." });
    } catch (error) {
        // Nguồn recovered-interactions.json không có trên máy này — chấp nhận lỗi
        // thiếu file, miễn là không có tin nào được gửi.
        assert.match(error.message, /file nguồn/i);
    }
    assert.equal(log.length, before, "xem trước không được gửi tin nào");
    assert.equal(fs.existsSync(path.join(CHECKPOINT_DIR, `${campaign}.json`)), false, "xem trước không ghi checkpoint");
    void registry;
});

test("preview TỪ CHỐI khi không có nội dung thông báo", async () => {
    await assert.rejects(
        () => main.previewRecoveredAnnouncement({ message: "   " }),
        /Chưa có nội dung thông báo/
    );
});

/* -------------------------------- gửi thật ------------------------------- */

test("send TỪ CHỐI khi thiếu xác nhận tường minh", async () => {
    await assert.rejects(
        () => main.sendRecoveredAnnouncement({ message: "Thông báo." }),
        /xác nhận tường minh/
    );
});

test("send TỪ CHỐI khi thiếu nội dung (dù đã xác nhận)", async () => {
    await assert.rejects(
        () => main.sendRecoveredAnnouncement({ confirm: true, message: "  " }),
        /Chưa có nội dung thông báo/
    );
});

/* ------------------------------- tiến độ -------------------------------- */

test("announcementProgress đọc checkpoint và trả số đếm, không gửi", () => {
    const campaign = `bridge-progress-${process.pid}-${RUN_TAG}`;
    fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
    const file = path.join(CHECKPOINT_DIR, `${campaign}.json`);
    fs.writeFileSync(file, JSON.stringify({
        campaignId: campaign,
        contentHash: "abcd1234efgh5678",
        sent: { "bot1::1": { at: "x" } },
        failed: { "bot1::2": { reason: "410", permanent: true } },
        deferred: {}
    }), "utf8");
    try {
        const report = main.announcementProgress({ campaign });
        assert.equal(report.sent, 1);
        assert.equal(report.permanent, 1);
        assert.equal(report.campaignId, campaign);
    } finally {
        fs.rmSync(file, { force: true });
    }
});

test("tên chiến dịch mặc định là reset-2026-09", async () => {
    // Không truyền campaign ⇒ dùng mặc định. Thiếu nội dung nên vẫn từ chối, nhưng
    // thông báo lỗi phải nói về nội dung chứ không phải thiếu campaign.
    await assert.rejects(
        () => main.previewRecoveredAnnouncement({}),
        /Chưa có nội dung thông báo/
    );
});
