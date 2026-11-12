// ============================================================================
// TRẠNG THÁI GIAO TIN VÀ CÁCH PHÂN LOẠI LỖI.
//
// Điều quan trọng nhất ở đây: "gọi API thành công" KHÔNG đồng nghĩa "Zalo đã tạo
// tin". Thiếu msgId phải là `unconfirmed`, không bao giờ được báo là thành công.
//
// Mã 123 ("Không thể nhận tin nhắn từ bạn") cũng phải được hiểu đúng phạm vi: mặc
// định là lỗi của MỘT người nhận, không phải giới hạn toàn tài khoản. Việc kết luận
// "tài khoản bị siết" chỉ xảy ra khi lặp lại trên nhiều người nhận — phần đếm đó
// nằm ở outboundLimiter.js và được kiểm chứng ở zcaOutboundLimiter.test.js.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    DELIVERY_ERROR_KIND,
    DELIVERY_STATE,
    ZALO_RECIPIENT_RESTRICTED_CODE,
    classifyDeliveryError,
    deliveryStateForKind
} = require("../deliveryErrors");
const {
    clearDeliveryTraces,
    getDeliveryTraceStats,
    listDeliveryTraces,
    recordDeliveryTrace
} = require("../deliveryTrace");

test.beforeEach(() => clearDeliveryTraces());

test("thiếu msgId ⇒ unconfirmed, KHÔNG phải thành công và KHÔNG phải đích hỏng", () => {
    const error = Object.assign(new Error("Zalo không tạo tin nhắn"), { deliveryKind: "unconfirmed" });
    const classification = classifyDeliveryError(error);

    assert.equal(classification.kind, DELIVERY_ERROR_KIND.UNCONFIRMED);
    assert.equal(classification.state, DELIVERY_STATE.UNCONFIRMED);
    assert.equal(classification.retryable, false, "không gửi lại ngay — tin gốc có thể vẫn xuất hiện");
    assert.notEqual(classification.kind, DELIVERY_ERROR_KIND.PERMANENT);
});

test("mã 123 là lỗi CẤP NGƯỜI NHẬN, không phải giới hạn toàn tài khoản", () => {
    const error = Object.assign(new Error("Không thể nhận tin nhắn từ bạn"), {
        response: { error_code: ZALO_RECIPIENT_RESTRICTED_CODE }
    });
    const classification = classifyDeliveryError(error);

    assert.equal(classification.kind, DELIVERY_ERROR_KIND.RECIPIENT);
    assert.equal(classification.state, DELIVERY_STATE.RECIPIENT_ERROR);
    assert.equal(classification.scope, "recipient");
    assert.equal(classification.retryable, false, "không gửi lại liên tiếp vào đúng người này");
    // Giữ mã gốc để chẩn đoán.
    assert.equal(classification.code, 123);
    assert.match(classification.reason, /123/);
});

test("429 là chuyện của TÀI KHOẢN và tôn trọng Retry-After", () => {
    const withHeader = Object.assign(new Error("Too many requests"), {
        status: 429,
        response: { headers: { "retry-after": "45" } }
    });
    const classification = classifyDeliveryError(withHeader);
    assert.equal(classification.kind, DELIVERY_ERROR_KIND.RATE_LIMIT);
    assert.equal(classification.state, DELIVERY_STATE.RATE_LIMITED);
    assert.equal(classification.scope, "account");
    assert.equal(classification.retryAfterMs, 45000);

    // Không có Retry-After ⇒ không tự bịa ra một con số.
    const withoutHeader = classifyDeliveryError(Object.assign(new Error("Too many requests"), { status: 429 }));
    assert.equal(withoutHeader.retryAfterMs, null);
});

test("hoãn (nhà cung cấp tạm dừng) có trạng thái riêng, không phải lỗi", () => {
    const error = Object.assign(new Error("Hoãn gửi"), { deliveryKind: "deferred", deferred: true });
    const classification = classifyDeliveryError(error);
    assert.equal(classification.kind, DELIVERY_ERROR_KIND.DEFERRED);
    assert.equal(classification.state, DELIVERY_STATE.DEFERRED);
    assert.equal(classification.retryable, true);
});

test("ánh xạ loại lỗi → trạng thái là một chỗ duy nhất", () => {
    assert.equal(deliveryStateForKind(DELIVERY_ERROR_KIND.PERMANENT), DELIVERY_STATE.FAILED);
    assert.equal(deliveryStateForKind(DELIVERY_ERROR_KIND.RATE_LIMIT), DELIVERY_STATE.RATE_LIMITED);
    assert.equal(deliveryStateForKind(DELIVERY_ERROR_KIND.RECIPIENT), DELIVERY_STATE.RECIPIENT_ERROR);
    assert.equal(deliveryStateForKind(DELIVERY_ERROR_KIND.UNCONFIRMED), DELIVERY_STATE.UNCONFIRMED);
    assert.equal(deliveryStateForKind(DELIVERY_ERROR_KIND.DEFERRED), DELIVERY_STATE.DEFERRED);
});

test("nhật ký gửi tin ghi trạng thái tường minh, không tô xanh tin chưa xác nhận", () => {
    recordDeliveryTrace({
        botId: "zca:111",
        chatId: "chat-1",
        feature: "schedule",
        operation: "daily_schedule",
        result: "sent",
        state: DELIVERY_STATE.UNCONFIRMED,
        confirmed: false,
        chunks: 1,
        intervalMs: 10000,
        queuePriority: 1
    });
    recordDeliveryTrace({
        botId: "zca:111",
        chatId: "chat-2",
        feature: "schedule",
        operation: "daily_schedule",
        result: "sent",
        state: DELIVERY_STATE.SENT_CONFIRMED,
        confirmed: true,
        providerMessageIds: ["msg-9"]
    });

    const traces = listDeliveryTraces({ limit: 10 });
    const unconfirmed = traces.find((entry) => entry.chatId === "chat-1");
    const confirmed = traces.find((entry) => entry.chatId === "chat-2");

    assert.equal(unconfirmed.state, "unconfirmed");
    assert.equal(unconfirmed.confirmed, false, "không được coi là thành công chắc chắn");
    assert.equal(unconfirmed.intervalMs, 10000);
    assert.equal(confirmed.state, "sent_confirmed");
    assert.equal(confirmed.providerMessageId, "msg-9");

    const stats = getDeliveryTraceStats();
    assert.equal(stats.byState.sent_confirmed, 1);
    assert.equal(stats.byState.unconfirmed, 1);
});
