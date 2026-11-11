// ============================================================================
// Nguồn gốc bản ghi: không bao giờ mặc định về bot1 khi thiếu bằng chứng.
//
// Bối cảnh lỗi: dashboard hiển thị người dùng của tài khoản Zalo cá nhân là
// "bot1". Có hai nguyên nhân độc lập:
//   1. admin-ui/app.js recordBotId() chỉ chấp nhận /^bot\d+$/ nên "zca:<uid>"
//      không khớp và bị đổi thành bot1.
//   2. adminDataService.js bỏ qua cờ `scoped` của parseScopedKey, nên mọi khóa
//      không có phạm vi đều bị coi là bot1.
//
// Bài kiểm tra dưới đây khoá chặt cả hai.
// ============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const {
    SOURCE_CONFIDENCE,
    isVerifiedConfidence,
    resolveRecordSource,
    scopedIdentityKey
} = require("../sourceAttribution");

/* ========================================================================== */
/* Quy tắc trung tâm                                                          */
/* ========================================================================== */

test("1. bản ghi bot1 cũ KHÔNG có botId và khóa trần là CHƯA XÁC MINH", () => {
    // Đây là trường hợp trước đây bị gán bừa cho bot1.
    const source = resolveRecordSource({ chatId: "c1", userId: "u1" }, "c1");
    assert.equal(source.botId, null, "không được tự nhận là bot1");
    assert.equal(source.confidence, SOURCE_CONFIDENCE.UNVERIFIED_LEGACY);
    assert.equal(source.canSend, false, "chưa xác minh thì không được gửi");
});

test("2. bản ghi ZCA có khóa phạm vi được nhận đúng là ZCA, KHÔNG phải bot1", () => {
    const source = resolveRecordSource({ botId: "zca:623515849545943215" }, "zca:623515849545943215::c1");
    assert.equal(source.botId, "zca:623515849545943215");
    assert.equal(source.confidence, SOURCE_CONFIDENCE.VERIFIED);
    assert.equal(source.canSend, true);
    assert.notEqual(source.botId, "bot1");
});

test("bản ghi ZCA chỉ có khóa phạm vi (thiếu trường botId) vẫn nhận đúng", () => {
    const source = resolveRecordSource({}, "zca:111222333::c1");
    assert.equal(source.botId, "zca:111222333");
    assert.equal(source.confidence, SOURCE_CONFIDENCE.FROM_SCOPED_KEY);
    assert.equal(source.canSend, true);
});

test("3. bản ghi bot2 và bot3 có khóa phạm vi được nhận đúng", () => {
    assert.equal(resolveRecordSource({ botId: "bot2" }, "bot2::c1").botId, "bot2");
    assert.equal(resolveRecordSource({ botId: "bot3" }, "bot3::c1").botId, "bot3");
    // Chỉ có khóa, không có trường botId.
    assert.equal(resolveRecordSource({}, "bot2::c1").botId, "bot2");
    assert.equal(resolveRecordSource({}, "bot3::c1").botId, "bot3");
});

test("botId mâu thuẫn với khóa phạm vi thì KHÔNG tin cái nào", () => {
    const source = resolveRecordSource({ botId: "bot2" }, "bot1::c1");
    assert.equal(source.botId, null);
    assert.equal(source.confidence, SOURCE_CONFIDENCE.CONFLICT);
    assert.equal(source.canSend, false, "mâu thuẫn thì không được gửi");
    assert.match(source.reason, /bot2/);
    assert.match(source.reason, /bot1/);
});

test("4. cùng chatId ở hai kênh khác nhau là hai danh tính khác nhau", () => {
    // Cùng chatId, khác nguồn ⇒ khóa gộp phải khác nhau.
    const a = scopedIdentityKey("bot1", "SAME");
    const b = scopedIdentityKey("bot2", "SAME");
    const c = scopedIdentityKey("zca:999", "SAME");
    assert.notEqual(a, b);
    assert.notEqual(b, c);
    assert.notEqual(a, c);
});

test("bản ghi chưa xác minh có khóa gộp RIÊNG, không trộn vào bot1", () => {
    const unverified = scopedIdentityKey(null, "SAME");
    assert.notEqual(unverified, scopedIdentityKey("bot1", "SAME"));
    assert.notEqual(unverified, scopedIdentityKey("bot2", "SAME"));
});

test("5. hai người khác nhau trùng tên/MSSV vẫn là hai danh tính", () => {
    // Tên và MSSV KHÔNG BAO GIỜ là căn cứ xác định nguồn.
    const personA = resolveRecordSource({ botId: "bot1", displayName: "Nguyễn Văn A" }, "c1");
    const personB = resolveRecordSource({ botId: "bot2", displayName: "Nguyễn Văn A" }, "bot2::c1");
    assert.equal(personA.botId, "bot1");
    assert.equal(personB.botId, "bot2");
    // Nguồn khác nhau nên khóa gộp khác nhau, dù tên giống hệt.
    assert.notEqual(scopedIdentityKey(personA.botId, "u"), scopedIdentityKey(personB.botId, "u"));
});

test("6. một người dùng nhiều bot vẫn giữ các nguồn tách biệt", () => {
    const viaBot1 = resolveRecordSource({ botId: "bot1" }, "u1");
    const viaBot2 = resolveRecordSource({ botId: "bot2" }, "bot2::u1");
    const viaZca = resolveRecordSource({ botId: "zca:555" }, "zca:555::u1");

    const sources = [viaBot1.botId, viaBot2.botId, viaZca.botId];
    assert.deepEqual(sources, ["bot1", "bot2", "zca:555"], "ba kênh là ba nguồn riêng");
    assert.equal(new Set(sources).size, 3);
});

test("7. bản ghi mơ hồ vẫn CHƯA XÁC MINH, không đoán theo cấu hình bot hiện tại", () => {
    // Kể cả khi hệ thống chỉ chạy một bot, thiếu bằng chứng vẫn là thiếu bằng chứng.
    const source = resolveRecordSource({ displayName: "Ai đó", studentId: "123456789" }, "some-key");
    assert.equal(source.confidence, SOURCE_CONFIDENCE.UNVERIFIED_LEGACY);
    assert.equal(source.botId, null);
    assert.equal(source.canSend, false);
    // Có nêu ứng viên cũ để tham khảo, nhưng KHÔNG dùng nó làm nguồn.
    assert.equal(source.legacyCandidateBotId, "bot1");
});

test("chỉ hai mức đã xác minh mới cho phép gửi", () => {
    assert.equal(isVerifiedConfidence(SOURCE_CONFIDENCE.VERIFIED), true);
    assert.equal(isVerifiedConfidence(SOURCE_CONFIDENCE.FROM_SCOPED_KEY), true);
    assert.equal(isVerifiedConfidence(SOURCE_CONFIDENCE.UNVERIFIED_LEGACY), false);
    assert.equal(isVerifiedConfidence(SOURCE_CONFIDENCE.CONFLICT), false);
});

/* ========================================================================== */
/* Dashboard: nguồn gốc hiển thị và định tuyến                                */
/* ========================================================================== */

// Cài persistence giả MỘT LẦN (các module lấy hàm ngay lúc require).
function installFakePersistence() {
    const persistencePath = require.resolve(path.join(ROOT, "firestorePersistence"));
    const real = require(persistencePath);
    const memoryFiles = new Map();
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
                memoryFiles.set(fileKey(filePath, defaultPath), clone(value));
            },
            flushPersistenceWrites: async () => undefined,
            getPersistenceStatus: () => ({ backend: "test" })
        }
    };
    return { memoryFiles, fileKey };
}

const fake = installFakePersistence();
const { buildAdminData } = require("../adminDataService");
const { registerBots, clearBots } = require("../botContext");
const { createOfficialProvider } = require("../providers/officialProvider");

const CHAT_DIR = fake.fileKey(path.join(ROOT, "chatDirectory.json"));
const INTERACTIONS = fake.fileKey(path.join(ROOT, "interactions.json"));
const SUBSCRIPTIONS = fake.fileKey(path.join(ROOT, "subscriptions.json"));

function seedStores(chats, interactions, subscriptions) {
    // Xoá SẠCH mọi store trước mỗi bài: các bài dùng chung một persistence giả nên
    // dữ liệu bài trước sẽ lẫn sang bài sau nếu không reset.
    fake.memoryFiles.clear();
    fake.memoryFiles.set(CHAT_DIR, { schemaVersion: 3, chats: chats || {}, deletedChatIds: {} });
    fake.memoryFiles.set(INTERACTIONS, interactions || {});
    fake.memoryFiles.set(SUBSCRIPTIONS, subscriptions || {});
}

function registerBotsForTest() {
    clearBots();
    registerBots([
        createOfficialProvider({ botId: "bot1", token: "t1" }),
        createOfficialProvider({ botId: "bot2", token: "t2" }),
        createOfficialProvider({ botId: "bot3", token: "t3" })
    ]);
}

test("dashboard: bản ghi ZCA KHÔNG hiển thị là bot1", () => {
    registerBotsForTest();
    seedStores({
        "zca:623515849545943215::chat-zca": {
            chatId: "chat-zca", botId: "zca:623515849545943215", chatType: "private",
            displayName: "Người dùng ZCA", userId: "user-zca", status: "active"
        }
    }, {}, {});

    const data = buildAdminData();
    const chat = data.chats.find((item) => item.chatId === "chat-zca");
    assert.ok(chat, "phải có bản ghi");
    assert.equal(chat.botId, "zca:623515849545943215", "phải giữ đúng danh tính ZCA");
    assert.notEqual(chat.botId, "bot1");
    assert.equal(chat.sourceVerified, true);
    assert.equal(chat.canSend, true);
    clearBots();
});

test("dashboard: bản ghi mơ hồ được đánh dấu và CHẶN gửi", () => {
    registerBotsForTest();
    seedStores({}, {
        "chat-mo-ho": {
            chatId: "chat-mo-ho", chatType: "private", lastUserId: "user-mo-ho",
            members: { "user-mo-ho": { userId: "user-mo-ho", displayName: "Mơ hồ" } }
        }
    }, {});

    const data = buildAdminData();
    const chat = data.chats.find((item) => item.chatId === "chat-mo-ho");
    assert.ok(chat);
    assert.equal(chat.botId, null, "không được tự nhận là bot1");
    assert.equal(chat.sourceVerified, false);
    assert.equal(chat.canSend, false, "phải chặn gửi");
    assert.equal(chat.sourceConfidence, "unverified_legacy");
    clearBots();
});

test("dashboard: hai bot cùng chatId vẫn tách thành hai dòng riêng", () => {
    registerBotsForTest();
    seedStores({
        "SAME-CHAT": { chatId: "SAME-CHAT", botId: "bot1", chatType: "private", displayName: "Của bot1", status: "active" },
        "bot2::SAME-CHAT": { chatId: "SAME-CHAT", botId: "bot2", chatType: "private", displayName: "Của bot2", status: "active" }
    }, {}, {});

    const data = buildAdminData();
    const rows = data.chats.filter((item) => item.chatId === "SAME-CHAT");
    assert.equal(rows.length, 2, "hai bot, hai dòng");
    assert.deepEqual(rows.map((r) => r.botId).sort(), ["bot1", "bot2"]);
    clearBots();
});

test("dashboard: cùng userId ở hai nguồn không bị gộp làm một người", () => {
    registerBotsForTest();
    seedStores({
        "bot1-chat": { chatId: "bot1-chat", botId: "bot1", chatType: "private", userId: "SAME-USER", displayName: "A", status: "active" },
        "bot2::bot2-chat": { chatId: "bot2-chat", botId: "bot2", chatType: "private", userId: "SAME-USER", displayName: "A", status: "active" }
    }, {
        "bot1-chat": { chatId: "bot1-chat", chatType: "private", lastUserId: "SAME-USER", members: { "SAME-USER": { userId: "SAME-USER", displayName: "A" } } },
        "bot2::bot2-chat": { chatId: "bot2-chat", chatType: "private", lastUserId: "SAME-USER", members: { "SAME-USER": { userId: "SAME-USER", displayName: "A" } } }
    }, {});

    const data = buildAdminData();
    const users = data.users.filter((item) => item.userId === "SAME-USER");
    assert.equal(users.length, 2, "cùng User ID nhưng khác nguồn là hai danh tính");
    assert.deepEqual(users.map((u) => u.botId).sort(), ["bot1", "bot2"]);
    clearBots();
});

test("8. botStats không gán bản ghi mơ hồ cho bot1", () => {
    registerBotsForTest();
    seedStores({}, {
        "chat-mo-ho": { chatId: "chat-mo-ho", chatType: "private", lastUserId: "u", members: { u: { userId: "u" } } }
    }, {});

    const data = buildAdminData();
    // Bất biến: KHÔNG botStats nào được đếm bản ghi chưa xác minh.
    const totalCounted = data.botStats.reduce((sum, item) => sum + item.chatCount, 0);
    assert.equal(totalCounted, 0, "bản ghi chưa xác minh không được cộng cho bot nào");
    assert.equal(data.chats.find((item) => item.chatId === "chat-mo-ho").botId, null);
    clearBots();
});

test("dashboard: bản ghi có botId tường minh trên khóa trần vẫn xác minh là bot1", () => {
    registerBotsForTest();
    seedStores({
        "legacy-chat": { chatId: "legacy-chat", botId: "bot1", chatType: "private", displayName: "Cũ thật", status: "active" }
    }, {}, {});

    const data = buildAdminData();
    const chat = data.chats.find((item) => item.chatId === "legacy-chat");
    assert.equal(chat.botId, "bot1", "bản ghi bot1 chính danh phải được giữ nguyên");
    assert.equal(chat.sourceVerified, true);
    assert.equal(chat.canSend, true, "không được chặn nhầm bản ghi bot1 hợp lệ");
    clearBots();
});
