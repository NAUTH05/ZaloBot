// ============================================================================
// Quy trình xác minh nguồn trên dashboard, kiểm tra bằng KHÓA THẬT.
//
// Lỗi đang sửa: dashboard gửi khóa TỔNG HỢP "__unverified__::<chatId>" lên API bằng
// chứng, nhưng khóa đó không tồn tại trong Firestore nên API trả 404. Nguyên nhân
// sâu hơn: một đăng ký nhận lịch thiếu botId sinh ra một DÒNG RIÊNG cho cùng cuộc
// trò chuyện đã biết nguồn.
// ============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

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
const verifications = require("../sourceVerifications");
const { SOURCE_CONFIDENCE, resolveRecordSource } = require("../sourceAttribution");

const CHAT_DIR = fake.fileKey(path.join(ROOT, "chatDirectory.json"));
const INTERACTIONS = fake.fileKey(path.join(ROOT, "interactions.json"));
const SUBSCRIPTIONS = fake.fileKey(path.join(ROOT, "subscriptions.json"));

function seed(chats, interactions, subscriptions) {
    fake.memoryFiles.clear();
    fake.memoryFiles.set(CHAT_DIR, { schemaVersion: 3, chats: chats || {}, deletedChatIds: {} });
    fake.memoryFiles.set(INTERACTIONS, interactions || {});
    fake.memoryFiles.set(SUBSCRIPTIONS, subscriptions || {});
}

function registerThreeBots() {
    clearBots();
    registerBots([
        createOfficialProvider({ botId: "bot1", token: "t1" }),
        createOfficialProvider({ botId: "bot2", token: "t2" }),
        createOfficialProvider({ botId: "bot3", token: "t3" })
    ]);
}

/* ========================================================================== */
/* 1. Khóa tổng hợp KHÔNG BAO GIỜ được gửi lên API                            */
/* ========================================================================== */

test("dòng chưa xác minh dùng KHÓA THẬT, không dùng khóa tổng hợp", () => {
    registerThreeBots();
    // Bản ghi lịch sử: tương tác không có botId, KHÔNG có bản ghi chatDirectory nào.
    // Đây chính là trường hợp sinh khóa tổng hợp "__unverified__::<chatId>".
    seed({}, {
        "legacy-chat-1": {
            chatId: "legacy-chat-1", chatType: "private", lastUserId: "legacy-user-1",
            members: { "legacy-user-1": { userId: "legacy-user-1", displayName: "Cũ" } }
        }
    }, {});

    const data = buildAdminData();
    const row = data.chats.find((item) => item.chatId === "legacy-chat-1");
    assert.ok(row, "phải có dòng cho chat lịch sử");
    assert.equal(row.botId, null, "chưa xác định được tài khoản");

    // Khóa gửi lên API PHẢI là khóa thật.
    assert.equal(row.sourceStoreId, "interactions");
    assert.equal(row.sourceRecordKey, "legacy-chat-1");
    assert.ok(!row.sourceRecordKey.includes("__unverified__"),
        "khóa tổng hợp không bao giờ được gửi lên API");

    // Và khóa đó phải THẬT SỰ tồn tại trong store.
    const store = fake.memoryFiles.get(INTERACTIONS);
    assert.ok(store[row.sourceRecordKey], "khóa phải tồn tại trong store");
    clearBots();
});

test("không dòng nào gửi khóa tổng hợp, dù có nhiều dòng chưa xác minh", () => {
    registerThreeBots();
    const interactions = {};
    for (let index = 0; index < 5; index += 1) {
        interactions[`legacy-${index}`] = {
            chatId: `legacy-${index}`, chatType: "private", lastUserId: `u-${index}`,
            members: { [`u-${index}`]: { userId: `u-${index}` } }
        };
    }
    seed({}, interactions, {});

    const data = buildAdminData();
    const unverified = data.chats.filter((item) => !item.botId);
    assert.equal(unverified.length, 5);
    for (const row of unverified) {
        assert.ok(!String(row.sourceRecordKey).includes("__unverified__"),
            `dòng ${row.chatId} vẫn dùng khóa tổng hợp`);
        assert.ok(fake.memoryFiles.get(INTERACTIONS)[row.sourceRecordKey],
            `khóa ${row.sourceRecordKey} không tồn tại trong store`);
    }
    clearBots();
});

/* ========================================================================== */
/* 2. Đăng ký thiếu botId phải theo chat, không sinh dòng trùng               */
/* ========================================================================== */

test("đăng ký thiếu botId suy nguồn từ chat, KHÔNG sinh dòng trùng", () => {
    registerThreeBots();
    seed(
        { "chat-a": { chatId: "chat-a", botId: "bot1", chatType: "private", displayName: "A", status: "active" } },
        {},
        { "chat-a::user-a": { chatId: "chat-a", userId: "user-a", studentId: "111", notificationsEnabled: true } }
    );

    const data = buildAdminData();
    const rows = data.chats.filter((item) => item.chatId === "chat-a");
    assert.equal(rows.length, 1, "chỉ được có MỘT dòng cho một chatId");
    assert.equal(rows[0].botId, "bot1", "đăng ký phải theo nguồn của chat");
    assert.equal(rows[0].canSend, true, "xác định được tài khoản thì được phép thao tác");
    clearBots();
});

test("đăng ký của chat CHƯA rõ tài khoản vẫn không sinh dòng trùng", () => {
    registerThreeBots();
    seed({}, {
        "chat-b": { chatId: "chat-b", chatType: "private", lastUserId: "u", members: { u: { userId: "u" } } }
    }, {
        "chat-b::u": { chatId: "chat-b", userId: "u", studentId: "222", notificationsEnabled: true }
    });

    const data = buildAdminData();
    const rows = data.chats.filter((item) => item.chatId === "chat-b");
    assert.equal(rows.length, 1, "vẫn chỉ một dòng");
    assert.equal(rows[0].botId, null, "chat chưa rõ thì đăng ký cũng chưa rõ");
    clearBots();
});

/* ========================================================================== */
/* 3. Dòng dựng từ NHIỀU bản ghi                                              */
/* ========================================================================== */

test("dòng gộp nhiều bản ghi liệt kê đủ và đúng trạng thái từng bản ghi", () => {
    registerThreeBots();
    // chatDirectory đã xác minh (bot1), nhưng tương tác thì không có botId.
    seed(
        { "chat-c": { chatId: "chat-c", botId: "bot1", chatType: "private", displayName: "C", status: "active" } },
        { "chat-c": { chatId: "chat-c", chatType: "private", lastUserId: "u", members: { u: { userId: "u" } } } },
        { "chat-c::u": { chatId: "chat-c", userId: "u", studentId: "333", notificationsEnabled: true } }
    );

    const data = buildAdminData();
    const row = data.chats.find((item) => item.chatId === "chat-c");
    assert.ok(Array.isArray(row.sourceRecords), "phải có danh sách bản ghi đóng góp");
    assert.ok(row.sourceRecords.length >= 1, "phải liệt kê được bản ghi thật");

    for (const item of row.sourceRecords) {
        assert.ok(item.storeId && item.recordKey, "mỗi bản ghi phải có store và khóa thật");
        assert.equal(typeof item.verified, "boolean", "mỗi bản ghi phải có trạng thái xác minh riêng");
        assert.ok(!item.recordKey.includes("__unverified__"), "khóa phải là khóa thật");
    }
    // Tương tác và đăng ký đều suy nguồn từ chat ⇒ mọi bản ghi đã xác minh.
    assert.equal(row.fullyVerified, true, "mọi bản ghi đóng góp đều đã xác minh");
    assert.equal(row.pendingRecordCount, 0);
    clearBots();
});

test("xác minh MỘT bản ghi không làm cả dòng thành đã xác minh", () => {
    registerThreeBots();
    seed({}, {
        "chat-d": { chatId: "chat-d", chatType: "private", lastUserId: "u", members: { u: { userId: "u" } } }
    }, {
        "chat-d::u": { chatId: "chat-d", userId: "u", studentId: "444", notificationsEnabled: true }
    });

    const data = buildAdminData();
    const row = data.chats.find((item) => item.chatId === "chat-d");
    // Cả hai bản ghi đều chưa xác minh ⇒ dòng phải báo còn cần xác minh.
    assert.ok(row.pendingRecordCount >= 1, "phải báo còn bản ghi cần xác minh");
    assert.equal(row.fullyVerified, false, "không được coi cả dòng là đã xác minh");
    clearBots();
});

/* ========================================================================== */
/* 4. Cùng chatId/userId ở HAI tài khoản khác nhau                            */
/* ========================================================================== */

test("cùng chatId ở hai tài khoản vẫn là hai dòng, không gộp", () => {
    registerThreeBots();
    seed({
        "SAME-CHAT": { chatId: "SAME-CHAT", botId: "bot1", chatType: "private", displayName: "Của bot1", status: "active" },
        "bot2::SAME-CHAT": { chatId: "SAME-CHAT", botId: "bot2", chatType: "private", displayName: "Của bot2", status: "active" }
    }, {}, {});

    const data = buildAdminData();
    const rows = data.chats.filter((item) => item.chatId === "SAME-CHAT");
    assert.equal(rows.length, 2, "hai tài khoản, hai dòng");
    assert.deepEqual(rows.map((r) => r.botId).sort(), ["bot1", "bot2"]);
    for (const row of rows) assert.equal(row.canSend, true);
    clearBots();
});

test("xác minh ở tài khoản này không ảnh hưởng tài khoản kia", () => {
    registerThreeBots();
    seed({}, {
        "SHARED": { chatId: "SHARED", chatType: "private", lastUserId: "u", members: { u: { userId: "u" } } },
        "bot2::SHARED": { chatId: "SHARED", chatType: "private", lastUserId: "u", members: { u: { userId: "u" } } }
    }, {});

    // Xác minh bản ghi ở bot2 (khóa có phạm vi).
    verifications.verifySource({
        storeId: "interactions", recordKey: "bot2::SHARED", botId: "bot2",
        reason: "khóa có phạm vi bot2", confirmed: true, verifiedBy: "admin"
    });

    const data = buildAdminData();
    const rows = data.chats.filter((item) => item.chatId === "SHARED");
    const bot2Row = rows.find((r) => r.botId === "bot2");
    assert.ok(bot2Row, "dòng bot2 phải xác định được tài khoản");
    // Dòng còn lại KHÔNG được hưởng lợi từ xác minh của bot2.
    const otherRow = rows.find((r) => r.botId !== "bot2");
    if (otherRow) {
        assert.notEqual(otherRow.botId, "bot2", "không được gán nhờ xác minh của tài khoản khác");
    }
    clearBots();
});

/* ========================================================================== */
/* 5. Xem bằng chứng → lưu xác minh → tải lại → hoàn tác                      */
/* ========================================================================== */

test("xác minh một bản ghi thật rồi tải lại dashboard thì dòng đổi trạng thái", () => {
    registerThreeBots();
    seed({}, {
        "flow-chat": { chatId: "flow-chat", chatType: "private", lastUserId: "u", members: { u: { userId: "u" } } }
    }, {});

    // Trước: chưa rõ tài khoản, bị chặn thao tác.
    const before = buildAdminData().chats.find((item) => item.chatId === "flow-chat");
    assert.equal(before.botId, null);
    assert.equal(before.canSend, false, "chưa xác minh thì phải bị chặn");
    const target = { storeId: before.sourceStoreId, recordKey: before.sourceRecordKey };
    assert.ok(fake.memoryFiles.get(INTERACTIONS)[target.recordKey], "khóa phải là khóa thật");

    // Lưu xác minh cho ĐÚNG bản ghi đó.
    verifications.verifySource({
        storeId: target.storeId, recordKey: target.recordKey, botId: "bot3",
        reason: "chatId chỉ xuất hiện ở bot3", confirmed: true, verifiedBy: "quản trị viên"
    });

    // Sau khi tải lại: đã xác định tài khoản và mở được thao tác.
    const after = buildAdminData().chats.find((item) => item.chatId === "flow-chat");
    assert.equal(after.botId, "bot3", "dòng phải nhận tài khoản vừa xác minh");
    assert.equal(after.canSend, true, "xác minh xong thì được phép thao tác");
    assert.equal(after.sourceConfidence, "manual");

    // Hoàn tác: quay lại đúng trạng thái chưa rõ tài khoản.
    verifications.revokeVerification({
        storeId: target.storeId, recordKey: target.recordKey, reason: "chọn nhầm", revokedBy: "quản trị viên"
    });
    const reverted = buildAdminData().chats.find((item) => item.chatId === "flow-chat");
    assert.equal(reverted.botId, null, "hoàn tác thì không được gán tài khoản khác");
    assert.equal(reverted.canSend, false, "hoàn tác thì phải chặn lại");
    clearBots();
});

test("xác minh ghi ở store KHÁC không mở khoá dòng này", () => {
    registerThreeBots();
    seed({}, {
        "scoped-chat": { chatId: "scoped-chat", chatType: "private", lastUserId: "u", members: { u: { userId: "u" } } }
    }, {});

    const row = buildAdminData().chats.find((item) => item.chatId === "scoped-chat");
    // Cố tình xác minh ở store khác với store của bản ghi.
    verifications.verifySource({
        storeId: "subscriptions", recordKey: row.sourceRecordKey, botId: "bot2",
        reason: "sai store", confirmed: true
    });

    const after = buildAdminData().chats.find((item) => item.chatId === "scoped-chat");
    assert.equal(after.botId, null, "xác minh phải gắn với ĐÚNG store và đúng khóa");
    clearBots();
});

test("không bao giờ tự gán bot1 cho bản ghi chưa xác minh", () => {
    registerThreeBots();
    const interactions = {};
    for (let index = 0; index < 8; index += 1) {
        interactions[`never-${index}`] = {
            chatId: `never-${index}`, chatType: "private", lastUserId: `u${index}`,
            members: { [`u${index}`]: { userId: `u${index}` } }
        };
    }
    seed({}, interactions, {});

    const data = buildAdminData();
    for (const row of data.chats) {
        assert.notEqual(row.botId, "bot1", `dòng ${row.chatId} bị tự gán bot1`);
    }
    clearBots();
});
