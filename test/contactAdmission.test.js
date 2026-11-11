// ============================================================================
// Bài kiểm tra CỔNG TIẾP NHẬN LIÊN HỆ.
//
// Mục tiêu: một chat mà bot KHÔNG THỂ trả lời không được để lại dấu vết bền vững,
// và chỉ chat ĐÃ được xác nhận trả lời mới đủ điều kiện nhận phát tin.
// ============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    ADMISSION_STATE,
    AdmissionRegistry,
    admissionKey,
    classifyAdmissionFailure
} = require("../contactAdmission");
const {
    getChat,
    isChatEligible,
    markChatAdmitted,
    markChatUnreachable,
    recordDeliveryFailure,
    recordDeliverySuccess,
    upsertChat
} = require("../chatDirectory");

function temporaryFile(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-admission-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return path.join(directory, "chatDirectory.json");
}

/* --------------------------- phân loại lỗi gửi ---------------------------- */

test("410 chat_id không hợp lệ là từ chối dứt khoát", () => {
    const result = classifyAdmissionFailure(new Error("EZALO: 410 The chat_id is invalid"));
    assert.equal(result.definite, true);
    assert.equal(result.reason, "chat_id_invalid");
});

test("422 không có quyền là từ chối dứt khoát", () => {
    const result = classifyAdmissionFailure(Object.assign(new Error("no permission to send"), { statusCode: 422 }));
    assert.equal(result.definite, true);
    assert.equal(result.reason, "no_permission");
});

test("422 MƠ HỒ (không nói về quyền) KHÔNG phải từ chối dứt khoát", () => {
    // 422 có thể là lỗi định dạng nội dung — không được coi là hỏng vĩnh viễn.
    const result = classifyAdmissionFailure(Object.assign(new Error("422 unprocessable payload"), { statusCode: 422 }));
    assert.equal(result.definite, false);
});

test("timeout, 429, 5xx đều KHÔNG phải từ chối dứt khoát", () => {
    assert.equal(classifyAdmissionFailure(new Error("request timeout")).definite, false);
    assert.equal(classifyAdmissionFailure(Object.assign(new Error("rate limited"), { statusCode: 429 })).definite, false);
    assert.equal(classifyAdmissionFailure(Object.assign(new Error("server error"), { statusCode: 503 })).definite, false);
});

/* ------------------------------- registry --------------------------------- */

test("khóa tiếp nhận tách biệt theo bot: cùng chatId ở hai bot là hai ứng viên", () => {
    assert.notEqual(admissionKey("bot1", "999"), admissionKey("bot2", "999"));
    const registry = new AdmissionRegistry();
    registry.admit("bot1", "999");
    assert.equal(registry.isAdmitted("bot1", "999"), true);
    assert.equal(registry.isAdmitted("bot2", "999"), false);
});

test("ứng viên mới bắt đầu ở trạng thái PENDING, chưa được tiếp nhận", () => {
    const registry = new AdmissionRegistry();
    const mark = registry.markIncoming("bot1", "555");
    assert.equal(mark.isNewPending, true);
    assert.equal(mark.alreadyAdmitted, false);
    assert.equal(registry.isAdmitted("bot1", "555"), false);
    assert.equal(registry.get("bot1", "555").state, ADMISSION_STATE.PENDING);
});

test("sau khi admit, sự kiện kế tiếp thấy alreadyAdmitted", () => {
    const registry = new AdmissionRegistry();
    registry.markIncoming("bot1", "555");
    registry.admit("bot1", "555");
    const next = registry.markIncoming("bot1", "555");
    assert.equal(next.alreadyAdmitted, true);
    assert.equal(next.isNewPending, false);
});

test("trạng thái PENDING hết TTL thì bị dọn — không coi bộ nhớ là đã tiếp nhận", () => {
    const registry = new AdmissionRegistry({ pendingTtlMs: 1000 });
    registry.markIncoming("bot1", "777", 0);
    // Đọc ở thời điểm vượt TTL: mục PENDING phải biến mất.
    const later = registry.get("bot1", "777", 5000);
    assert.equal(later, null);
    assert.equal(registry.isAdmitted("bot1", "777", 5000), false);
});

test("từ chối KHÔNG phải án phạt: tương tác sau vẫn được thử lại", () => {
    const registry = new AdmissionRegistry();
    registry.markIncoming("bot1", "888");
    registry.reject("bot1", "888", "no_permission");
    assert.equal(registry.isAdmitted("bot1", "888"), false);
    // Sự kiện mới vẫn tạo cơ hội tiếp nhận lại.
    const again = registry.markIncoming("bot1", "888");
    assert.equal(again.recentlyRejected, true);
    assert.equal(again.isNewPending, true);
    registry.admit("bot1", "888");
    assert.equal(registry.isAdmitted("bot1", "888"), true);
});

test("stats đếm đúng theo trạng thái", () => {
    const registry = new AdmissionRegistry();
    registry.markIncoming("bot1", "a");
    registry.markIncoming("bot1", "b");
    registry.admit("bot1", "b");
    registry.markIncoming("bot1", "c");
    registry.reject("bot1", "c", "x");
    const stats = registry.stats();
    assert.equal(stats.pending, 1);
    assert.equal(stats.admitted, 1);
    assert.equal(stats.rejected, 1);
});

/* --------------------- cổng tiếp nhận trong sổ chat ----------------------- */

test("chat chưa tiếp nhận KHÔNG đủ điều kiện phát tin", (t) => {
    const filePath = temporaryFile(t);
    upsertChat({ chatId: "new-chat", chatType: "private", admissionStatus: "pending" }, filePath);
    assert.equal(isChatEligible("new-chat", "broadcast", filePath), false);
});

test("chat unreachable KHÔNG đủ điều kiện phát tin", (t) => {
    const filePath = temporaryFile(t);
    upsertChat({ chatId: "gone", chatType: "private" }, filePath);
    markChatUnreachable("gone", "chat_id_invalid", filePath);
    const record = getChat("gone", filePath);
    assert.equal(record.admissionStatus, "unreachable");
    assert.equal(record.unreachableReason, "chat_id_invalid");
    assert.equal(isChatEligible("gone", "broadcast", filePath), false);
});

test("chat đã tiếp nhận thì đủ điều kiện phát tin", (t) => {
    const filePath = temporaryFile(t);
    upsertChat({ chatId: "ok", chatType: "private" }, filePath);
    markChatAdmitted("ok", filePath);
    assert.equal(getChat("ok", filePath).admissionStatus, "admitted");
    assert.equal(isChatEligible("ok", "broadcast", filePath), true);
});

test("lỗi gửi VĨNH VIỄN chuyển chat sang unreachable nhưng GIỮ dữ liệu người dùng", (t) => {
    const filePath = temporaryFile(t);
    upsertChat({ chatId: "user-x", chatType: "private", userId: "u1", notificationOverrides: { schedule: true } }, filePath);
    markChatAdmitted("user-x", filePath);
    recordDeliveryFailure("user-x", { code: "EZALO", message: "EZALO: 410 The chat_id is invalid" }, {}, filePath);
    const record = getChat("user-x", filePath);
    assert.equal(record.admissionStatus, "unreachable");
    // Dữ liệu người dùng không bị xoá.
    assert.equal(record.userId, "u1");
    assert.equal(record.notificationOverrides.schedule, true);
});

test("gửi thành công SAU khi unreachable khôi phục lại trạng thái tiếp nhận", (t) => {
    const filePath = temporaryFile(t);
    upsertChat({ chatId: "recover", chatType: "private" }, filePath);
    markChatUnreachable("recover", "chat_forbidden", filePath);
    assert.equal(isChatEligible("recover", "broadcast", filePath), false);
    recordDeliverySuccess("recover", filePath);
    const record = getChat("recover", filePath);
    assert.equal(record.admissionStatus, "admitted");
    assert.equal(record.unreachableReason, null);
    assert.equal(isChatEligible("recover", "broadcast", filePath), true);
});
