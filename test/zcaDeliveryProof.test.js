// ============================================================================
// BẰNG CHỨNG TIN NHẮN ĐÃ ĐƯỢC TẠO — tài khoản Zalo cá nhân (ZCA).
//
// Sự cố thật: /thongbao báo "đã gửi thành công 100+ người" nhưng rất nhiều người
// không nhận được gì. Nguyên nhân nằm ở đây: zca-js trả `{ message: null }` khi
// Zalo nhận yêu cầu mà KHÔNG tạo tin (tài khoản bị giới hạn gửi), và phản hồi đó
// KHÔNG ném lỗi. Tầng gửi vì thế đếm là thành công.
//
// Không có msgId nghĩa là không có tin nhắn. Bài này chốt điều đó.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createZcaProvider } = require("../providers/zca/zcaProvider");
const { classifyDeliveryError } = require("../deliveryErrors");

function buildProvider(t, sendMessageImpl) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zca-proof-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const provider = createZcaProvider({ enabled: true, sessionDir: dir });
    provider.ownUid = "700700700";
    provider.rememberThread("chat-1", "private");
    provider.rememberThread("group-1", "group");
    provider.api = {
        sendMessage: sendMessageImpl,
        getOwnId: () => "700700700"
    };
    return provider;
}

test("Zalo không tạo tin (message null) ⇒ NÉM LỖI, không báo thành công", async (t) => {
    const provider = buildProvider(t, async () => ({ message: null, attachment: [] }));

    await assert.rejects(
        () => provider.sendMessage("chat-1", "Thông báo chung"),
        /không tạo tin nhắn/
    );
});

test("lỗi đó mang nhãn `unconfirmed` — KHÔNG phải đích hỏng, cũng không phải 429", async (t) => {
    const provider = buildProvider(t, async () => ({ message: null, attachment: [] }));

    let captured = null;
    try {
        await provider.sendMessage("chat-1", "Thông báo chung");
    } catch (error) {
        captured = error;
    }

    assert.ok(captured, "phải ném lỗi");
    // `unconfirmed`: Zalo nhận yêu cầu nhưng không có bằng chứng đã tạo tin. KHÔNG
    // được gộp với `rate_limit` — hai chuyện khác nhau và hệ quả khác nhau.
    assert.equal(captured.deliveryKind, "unconfirmed");
    const classification = classifyDeliveryError(captured);
    assert.equal(classification.kind, "unconfirmed");
    assert.equal(classification.state, "unconfirmed");
    // Không phải đích hỏng: không được đánh dấu unreachable.
    assert.equal(classification.kind === "permanent", false);
    // Không thử lại ngay: tin gốc có thể vẫn xuất hiện phía người nhận.
    assert.equal(classification.retryable, false);
});

test("phản hồi thiếu msgId ghi lại HÌNH DẠNG để chẩn đoán, không chép nội dung", async (t) => {
    const provider = buildProvider(t, async () => ({ message: null, attachment: [], extra: "nội dung riêng tư" }));

    let captured = null;
    try {
        await provider.sendMessage("chat-1", "Nội dung tin nhắn của người dùng");
    } catch (error) {
        captured = error;
    }

    assert.ok(captured?.providerResponseShape, "phải có hình dạng phản hồi để chẩn đoán");
    assert.equal(captured.providerResponseShape.message, "null");
    assert.equal(captured.providerResponseShape.attachmentCount, 0);
    // Không được chép nội dung tin nhắn vào đối tượng lỗi.
    assert.equal(JSON.stringify(captured.providerResponseShape).includes("riêng tư"), false);
});

test("có msgId ⇒ trả về bình thường", async (t) => {
    const provider = buildProvider(t, async () => ({ message: { msgId: 12345 }, attachment: [] }));
    const result = await provider.sendMessage("chat-1", "Xin chào");
    assert.equal(result.message.msgId, 12345);
});

test("chỉ tệp đính kèm có msgId cũng là bằng chứng đã tạo tin", async (t) => {
    const provider = buildProvider(t, async () => ({ message: null, attachment: [{ msgId: 999 }] }));
    const result = await provider.sendMessage("group-1", "Ảnh minh hoạ");
    assert.equal(result.attachment[0].msgId, 999);
});

test("không thử lại khi lỗi đã được phân loại (tránh nhân đôi tin nhắn)", async (t) => {
    let calls = 0;
    const provider = buildProvider(t, async () => {
        calls += 1;
        return { message: null, attachment: [] };
    });

    await assert.rejects(() => provider.sendMessage("chat-1", "**Đậm** và {green}xanh{/green}"));
    assert.equal(calls, 1, "gửi lại chỉ làm tình trạng giới hạn nặng thêm");
});
