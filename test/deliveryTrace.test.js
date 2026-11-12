// ============================================================================
// Nhật ký gửi tin theo lịch (bộ đệm trong bộ nhớ).
//
// Mục đích của nó là trả lời được câu "Chat Center ghi đã gửi mà Zalo không thấy
// thông báo": mỗi lần gửi phải để lại bot, chat, kết quả và mã tin nhắn Zalo trả
// về. Bài này chốt thứ tự, giới hạn bộ đệm và bộ lọc.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    MAX_ENTRIES,
    clearDeliveryTraces,
    getDeliveryTraceStats,
    listDeliveryTraces,
    recordDeliveryTrace
} = require("../deliveryTrace");

test.beforeEach(() => clearDeliveryTraces());

test("mỗi lần gửi để lại bot, chat, kết quả và mã tin nhắn Zalo", () => {
    recordDeliveryTrace({
        botId: "bot1",
        chatId: "123",
        chatName: "Nguyễn Yến Nhi",
        feature: "schedule",
        operation: "daily_schedule",
        result: "sent",
        chunks: 2,
        providerMessageIds: ["msg-zalo-1"]
    });

    const [entry] = listDeliveryTraces();
    assert.equal(entry.botId, "bot1");
    assert.equal(entry.chatId, "123");
    assert.equal(entry.result, "sent");
    assert.equal(entry.chunks, 2);
    assert.equal(entry.providerMessageId, "msg-zalo-1");
    assert.ok(entry.at, "phải có mốc thời gian để đối chiếu với log PM2");
});

test("lần gửi lỗi giữ nguyên lý do", () => {
    recordDeliveryTrace({
        botId: "bot2",
        chatId: "456",
        feature: "schedule",
        operation: "daily_schedule",
        result: "failed",
        error: "410 The chat_id is invalid",
        errorKind: "permanent"
    });

    const [entry] = listDeliveryTraces();
    assert.equal(entry.result, "failed");
    assert.match(entry.error, /410/);
    assert.equal(entry.errorKind, "permanent");
});

test("danh sách trả về mới nhất trước và tôn trọng limit", () => {
    for (let index = 0; index < 5; index += 1) {
        recordDeliveryTrace({ botId: "bot1", chatId: `c${index}`, result: "sent" });
    }
    const list = listDeliveryTraces({ limit: 2 });
    assert.equal(list.length, 2);
    assert.equal(list[0].chatId, "c4");
    assert.equal(list[1].chatId, "c3");
});

test("bộ đệm không phình quá giới hạn", () => {
    for (let index = 0; index < MAX_ENTRIES + 25; index += 1) {
        recordDeliveryTrace({ botId: "bot1", chatId: `c${index}`, result: "sent" });
    }
    const stats = getDeliveryTraceStats();
    assert.equal(stats.total, MAX_ENTRIES);
    assert.equal(listDeliveryTraces({ limit: MAX_ENTRIES })[0].chatId, `c${MAX_ENTRIES + 24}`);
});

test("lọc theo bot và theo kết quả", () => {
    recordDeliveryTrace({ botId: "bot1", chatId: "a", result: "sent" });
    recordDeliveryTrace({ botId: "bot2", chatId: "b", result: "failed" });
    recordDeliveryTrace({ botId: "bot2", chatId: "c", result: "sent" });

    assert.deepEqual(listDeliveryTraces({ botId: "bot2" }).map((item) => item.chatId), ["c", "b"]);
    assert.deepEqual(listDeliveryTraces({ result: "failed" }).map((item) => item.chatId), ["b"]);
    assert.equal(listDeliveryTraces({ botId: "all", result: "all" }).length, 3);
});

test("thống kê đếm theo kết quả và xoá sạch được", () => {
    recordDeliveryTrace({ botId: "bot1", chatId: "a", result: "sent" });
    recordDeliveryTrace({ botId: "bot1", chatId: "b", result: "failed" });
    recordDeliveryTrace({ botId: "bot1", chatId: "c", result: "failed" });

    const stats = getDeliveryTraceStats();
    assert.equal(stats.total, 3);
    assert.deepEqual(stats.byResult, { sent: 1, failed: 2 });
    assert.equal(stats.capacity, MAX_ENTRIES);

    assert.equal(clearDeliveryTraces(), 3);
    assert.equal(getDeliveryTraceStats().total, 0);
});
