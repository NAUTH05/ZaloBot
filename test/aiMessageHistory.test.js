const test = require("node:test");
const assert = require("node:assert/strict");

const { buildHistoryEntries, redactIdentifiers, protectIdentifiers, resolvePlaceholders } = require("../ai/promptBuilder");

// Firestore giả tối thiểu: đúng những phương thức messageRecorder dùng tới.
function createFakeDb() {
    const docs = new Map();
    const makeRef = (path) => ({
        async get() {
            return { exists: docs.has(path), data: () => docs.get(path) };
        },
        async set(value, options = {}) {
            docs.set(path, options.merge ? { ...(docs.get(path) || {}), ...value } : { ...value });
        }
    });
    return {
        docs,
        collection(name) {
            return {
                doc(id) {
                    const base = `${name}/${id}`;
                    return {
                        ...makeRef(base),
                        collection(sub) {
                            const prefix = `${base}/${sub}/`;
                            // Truy vấn tối thiểu: đủ cho getMessageHistory (orderBy/limit/get).
                            const query = {
                                orderBy() { return query; },
                                where() { return query; },
                                limit() { return query; },
                                async get() {
                                    const items = [...docs.entries()].filter(([itemPath]) => itemPath.startsWith(prefix));
                                    return {
                                        size: items.length,
                                        forEach: (fn) => items.forEach(([, value]) => fn({ data: () => value }))
                                    };
                                },
                                doc: (messageId) => makeRef(`${prefix}${messageId}`)
                            };
                            return query;
                        }
                    };
                }
            };
        }
    };
}

const fakeDb = createFakeDb();
const persistencePath = require.resolve("../firestorePersistence");
const realPersistence = require(persistencePath);
require.cache[persistencePath] = {
    id: persistencePath,
    filename: persistencePath,
    loaded: true,
    exports: { ...realPersistence, getFirestoreDb: () => fakeDb }
};

const { recordMessage, getMessageHistory, DIRECTION } = require("../messageRecorder");

test("ghi danh tính người gửi cho tin vào", async () => {
    const result = await recordMessage({
        botId: "bot1",
        chatId: "chat-group",
        direction: DIRECTION.INBOUND,
        text: "cho mình xem lịch",
        senderUserId: "user-a",
        providerMsgId: "provider-1"
    });

    assert.equal(result.recorded, true);
    const path = `bot_conversations/chat-group/messages/${result.messageId}`;
    assert.equal(fakeDb.docs.get(path).senderUserId, "user-a");
});

test("tin ra không mang danh tính người gửi", async () => {
    const result = await recordMessage({
        botId: "bot1",
        chatId: "chat-group",
        direction: DIRECTION.OUTBOUND,
        text: "lịch của cậu đây",
        senderUserId: "user-a",
        providerMsgId: "provider-2"
    });

    const path = `bot_conversations/chat-group/messages/${result.messageId}`;
    assert.equal(fakeDb.docs.get(path).senderUserId, null);
});

test("lịch sử trả về kèm senderUserId để lọc theo người", async () => {
    const { messages } = await getMessageHistory("bot1", "chat-group", { limit: 20 });
    const inbound = messages.filter((item) => item.direction === DIRECTION.INBOUND);
    assert.ok(inbound.length >= 1);
    assert.equal(inbound[0].senderUserId, "user-a");
});

test("ngữ cảnh nhóm chỉ lấy tin của chính người gửi và của trợ lý", () => {
    const entries = buildHistoryEntries([
        { direction: "inbound", senderUserId: "user-a", text: "câu của A" },
        { direction: "inbound", senderUserId: "user-b", text: "câu của B" },
        { direction: "inbound", text: "tin cũ không rõ ai" },
        { direction: "outbound", text: "trả lời của trợ lý" }
    ], { isGroup: true, senderUserId: "user-a", maxMessages: 8 });

    const flat = entries.map((entry) => entry.content).join(" | ");
    assert.match(flat, /câu của A/);
    assert.match(flat, /trả lời của trợ lý/);
    assert.ok(!flat.includes("câu của B"), "không được lộ tin của thành viên khác");
    assert.ok(!flat.includes("tin cũ không rõ ai"), "tin thiếu danh tính phải bị loại");
});

test("chat riêng vẫn dùng toàn bộ lịch sử của hội thoại", () => {
    const entries = buildHistoryEntries([
        { direction: "inbound", text: "câu một" },
        { direction: "inbound", text: "câu hai" }
    ], { isGroup: false, maxMessages: 8 });
    assert.equal(entries.length, 2);
});

test("giới hạn số tin và tổng độ dài ngữ cảnh", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
        direction: index % 2 === 0 ? "inbound" : "outbound",
        text: `tin số ${index}`
    }));
    const limited = buildHistoryEntries(many, { maxMessages: 4 });
    assert.equal(limited.length, 4);
    assert.match(limited[limited.length - 1].content, /tin số 19/, "phải giữ phần gần nhất");

    const long = buildHistoryEntries([
        { direction: "inbound", text: "x".repeat(5000) }
    ], { maxChars: 800 });
    assert.ok(long[0].content.length <= 800);
});

test("MSSV trong lịch sử được che bớt, trong câu hiện tại thì dùng placeholder", () => {
    assert.equal(redactIdentifiers("MSSV 123456789 của tôi"), "MSSV [MSSV] của tôi");

    const protectedInput = protectIdentifiers("lưu 123456789 và 987654321 nhé");
    assert.equal(protectedInput.text, "lưu {{mssv:1}} và {{mssv:2}} nhé");
    assert.equal(resolvePlaceholders("{{mssv:1}}", protectedInput.placeholders), "123456789");
    assert.equal(resolvePlaceholders("{{mssv:2}}", protectedInput.placeholders), "987654321");
    // Số không có trong tin nhắn thì giữ nguyên (và sẽ bị kiểm tra lại ở schema).
    assert.equal(resolvePlaceholders("{{mssv:9}}", protectedInput.placeholders), "{{mssv:9}}");
});
