// ============================================================================
// SỔ CHỐNG TRÙNG LỊCH HỌC.
//
// Cửa sổ gửi trước khiến job chạy 5–20 phút cho CÙNG một mốc. Không có sổ này thì
// mỗi người nhận 5–20 tin trùng. Bốn điều phải đúng:
//   1. claim giữ chỗ; lượt thứ hai không gửi lại.
//   2. gửi xong ⇒ không bao giờ gửi lại trong ngày.
//   3. gửi hỏng ⇒ nhả chỗ để lần sau thử lại (không mất lịch cả ngày).
//   4. claim bị bỏ dở quá 3 phút (tiến trình chết) phải nhận lại được.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Cách ly khỏi tệp thật: cùng lý do như các bài kiểm tra khác — `node --test`
// chạy song song và không file nào được ghi dữ liệu runtime.
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

const {
    CLAIM_TTL_MS,
    claimDelivery,
    createDeliveryEventId,
    createDeliveryKey,
    isDelivered,
    markDelivered,
    readState,
    releaseDelivery,
    resetDeliveries
} = require("../dailyScheduleLedger");

const FIELDS = {
    botId: "bot1",
    chatId: "chat-1",
    studentId: "123000135",
    time: "06:30",
    targetDayOffset: 0,
    slotDateKey: "2026-11-12"
};

const AT = new Date("2026-11-11T23:25:00.000Z");

test.beforeEach(() => memoryFiles.clear());

test("khóa gồm đủ bot, chat, MSSV, mốc giờ, ngày đích và ngày", () => {
    assert.equal(createDeliveryKey(FIELDS), "bot1|chat-1|123000135|06:30|0|2026-11-12");
    // Thiếu bất kỳ phần nào ⇒ không tạo khóa, để nơi gọi không ghi một bản ghi vô nghĩa.
    assert.equal(createDeliveryKey({ ...FIELDS, chatId: "" }), null);
    assert.equal(createDeliveryKey({ ...FIELDS, slotDateKey: "" }), null);
    assert.equal(createDeliveryKey({ ...FIELDS, targetDayOffset: -1 }), null);
});

test("cùng chatId ở hai bot là hai lượt khác nhau", () => {
    const first = createDeliveryEventId(FIELDS);
    const second = createDeliveryEventId({ ...FIELDS, botId: "bot2" });
    assert.notEqual(first, second);
});

test("claim giữ chỗ: lượt thứ hai không gửi lại", () => {
    const claimId = claimDelivery(FIELDS, { now: AT });
    assert.ok(claimId);
    assert.equal(isDelivered(FIELDS), false, "đang gửi chứ chưa xong");

    // Lượt chạy kế tiếp (1 phút sau) không được giữ chỗ lần nữa.
    assert.equal(claimDelivery(FIELDS, { now: new Date(AT.getTime() + 60000) }), null);
});

test("gửi xong thì không bao giờ gửi lại trong ngày", () => {
    const claimId = claimDelivery(FIELDS, { now: AT });
    markDelivered(claimId, AT);

    assert.equal(isDelivered(FIELDS), true);
    assert.equal(claimDelivery(FIELDS, { now: new Date(AT.getTime() + 60000) }), null);
    assert.equal(claimDelivery(FIELDS, { now: new Date(AT.getTime() + 3600000) }), null);
});

test("gửi hỏng thì nhả chỗ để lần chạy sau thử lại", () => {
    const claimId = claimDelivery(FIELDS, { now: AT });
    releaseDelivery(claimId);

    assert.equal(isDelivered(FIELDS), false);
    assert.ok(claimDelivery(FIELDS, { now: new Date(AT.getTime() + 60000) }), "phải thử lại được");
});

test("claim bị bỏ dở quá hạn thì nhận lại được", () => {
    claimDelivery(FIELDS, { now: AT });

    const stillFresh = new Date(AT.getTime() + CLAIM_TTL_MS - 1000);
    assert.equal(claimDelivery(FIELDS, { now: stillFresh }), null, "còn tươi thì lượt khác đang gửi");

    const stale = new Date(AT.getTime() + CLAIM_TTL_MS + 1000);
    assert.ok(claimDelivery(FIELDS, { now: stale }), "tiến trình chết giữa lúc gửi ⇒ phải nhận lại, nếu không mất lịch cả ngày");
});

test("ngày khác hoặc ngày đích khác là lượt khác", () => {
    const claimId = claimDelivery(FIELDS, { now: AT });
    markDelivered(claimId, AT);

    assert.equal(isDelivered({ ...FIELDS, slotDateKey: "2026-11-13" }), false);
    assert.equal(isDelivered({ ...FIELDS, targetDayOffset: 1 }), false);
});

test("bản ghi cũ hơn 7 ngày bị dọn, không phình store", () => {
    const claimId = claimDelivery(FIELDS, { now: AT });
    markDelivered(claimId, AT);
    assert.equal(Object.keys(readState().events).length, 1);

    // Một lượt ghi mới sau 8 ngày ⇒ bản ghi cũ bị prune.
    claimDelivery({ ...FIELDS, slotDateKey: "2026-11-20" }, { now: new Date("2026-11-19T23:25:00.000Z") });
    assert.equal(Object.keys(readState().events).length, 1);
});

test("reset xoá sạch sổ để gửi lại một mốc đã lỡ", () => {
    const claimId = claimDelivery(FIELDS, { now: AT });
    markDelivered(claimId, AT);
    assert.equal(resetDeliveries(), 1);
    assert.equal(isDelivered(FIELDS), false);
});
