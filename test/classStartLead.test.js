const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    createClassStartReminderService,
    createDeliveryEventId,
    findDueClassStartLessons,
    formatClassStartNotification
} = require("../classStartNotifications");
const {
    normalizeClassStartLead,
    setClassStartLead,
    saveStudent,
    getSubscription,
    CLASS_START_LEAD_MAX
} = require("../subscriptions");

const CONTEXT = { botId: "bot1", chatId: "chat-lead", userId: "user-lead", userDisplayName: "An" };

// Buổi học bắt đầu 12:50 ngày 01/09/2026.
function lesson(overrides = {}) {
    return {
        NhomID: "group-01",
        ThoiGianBD: "2026-09-01T12:50:00",
        ThoiGianKT: "2026-09-01T16:45:00",
        TenMonHoc: "Phát triển ứng dụng",
        TenPhong: "B301",
        TenCoSo: "Cơ sở I",
        GiaoVien: "Nguyễn Minh Phúc",
        TenNhom: "23CT113",
        Type: 0,
        TinhTrang: 0,
        CalenType: 1,
        ...overrides
    };
}

function tempFile(t, name) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-lead-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return path.join(directory, name);
}

/* -------------------------------------------------------------------------- */
/* Lưu thiết lập                                                               */
/* -------------------------------------------------------------------------- */

test("số phút nhắc trước được chuẩn hoá về 0–180", () => {
    assert.equal(normalizeClassStartLead(undefined), 0);
    assert.equal(normalizeClassStartLead(null), 0);
    assert.equal(normalizeClassStartLead(""), 0);
    assert.equal(normalizeClassStartLead(-5), 0);
    assert.equal(normalizeClassStartLead(60), 60);
    assert.equal(normalizeClassStartLead("10"), 10);
    assert.equal(normalizeClassStartLead(999), CLASS_START_LEAD_MAX);
    assert.equal(normalizeClassStartLead("abc"), 0);
});

test("đặt nhắc trước thì bật luôn tính năng nhắc giờ học", (t) => {
    const filePath = tempFile(t, "subscriptions.json");
    saveStudent(CONTEXT, { studentId: "123456789", studentName: "An" }, filePath);

    const updated = setClassStartLead(CONTEXT, 60, filePath);
    assert.equal(updated.classStartLeadMinutes, 60);
    assert.equal(updated.classStartNotificationsEnabled, true, "người dùng vừa nói muốn được nhắc");

    const saved = getSubscription(CONTEXT, filePath);
    assert.equal(saved.classStartLeadMinutes, 60);
});

test("lưu lại MSSV không được xoá thiết lập nhắc trước", (t) => {
    const filePath = tempFile(t, "subscriptions.json");
    saveStudent(CONTEXT, { studentId: "123456789", studentName: "An" }, filePath);
    setClassStartLead(CONTEXT, 30, filePath);

    // Đây là lỗi dễ xảy ra: saveStudent dựng lại object từ đầu.
    saveStudent(CONTEXT, { studentId: "987654321", studentName: "Bình" }, filePath);
    assert.equal(getSubscription(CONTEXT, filePath).classStartLeadMinutes, 30);
});

/* -------------------------------------------------------------------------- */
/* Tính đúng thời điểm nhắc                                                    */
/* -------------------------------------------------------------------------- */

test("nhắc trước 60 phút: 11:50 là đúng lúc, 12:50 thì không", () => {
    const lessons = [lesson()];
    const leadMs = 60 * 60000;
    const grace = 2 * 60000;

    const at1150 = new Date("2026-09-01T04:50:00.000Z");   // 11:50 giờ VN
    assert.equal(findDueClassStartLessons(lessons, at1150, grace, leadMs).length, 1);

    const at1250 = new Date("2026-09-01T05:50:00.000Z");   // 12:50 giờ VN
    assert.equal(findDueClassStartLessons(lessons, at1250, grace, leadMs).length, 0,
        "đã qua mốc nhắc trước thì không nhắc nữa");
});

test("lead 0 giữ nguyên hành vi cũ: nhắc đúng lúc vào học", () => {
    const lessons = [lesson()];
    const grace = 2 * 60000;
    const at1250 = new Date("2026-09-01T05:50:00.000Z");
    const at1150 = new Date("2026-09-01T04:50:00.000Z");

    assert.equal(findDueClassStartLessons(lessons, at1250, grace, 0).length, 1);
    assert.equal(findDueClassStartLessons(lessons, at1150, grace, 0).length, 0);
});

test("mã chống trùng khác nhau giữa các mốc nhắc, giữ nguyên khi lead = 0", () => {
    const item = lesson();
    const base = createDeliveryEventId("key-1", "123456789", item);
    assert.equal(createDeliveryEventId("key-1", "123456789", item, 0), base, "lead 0 không được đổi mã cũ");
    assert.notEqual(createDeliveryEventId("key-1", "123456789", item, 60), base);
    assert.notEqual(
        createDeliveryEventId("key-1", "123456789", item, 60),
        createDeliveryEventId("key-1", "123456789", item, 10)
    );
});

test("nội dung nhắc trước nói rõ còn bao nhiêu phút", () => {
    const withLead = formatClassStartNotification([lesson()], { leadMinutes: 60 });
    assert.match(withLead, /SẮP ĐẾN GIỜ HỌC/);
    assert.match(withLead, /Còn 60 phút/);

    const atStart = formatClassStartNotification([lesson()]);
    assert.match(atStart, /ĐẾN GIỜ HỌC/);
    assert.doesNotMatch(atStart, /Còn \d+ phút/);
});

/* -------------------------------------------------------------------------- */
/* Chạy dịch vụ thật                                                           */
/* -------------------------------------------------------------------------- */

test("chỉ người đặt nhắc trước mới nhận tin ở mốc 11:50", async (t) => {
    const stateFilePath = tempFile(t, "classStartNotifications.json");
    const sent = [];
    const subscriptions = {
        "sub-lead": {
            contextVersion: 2, chatId: "chat-a", userId: "user-a", studentId: "123456789",
            classStartNotificationsEnabled: true, classStartLeadMinutes: 60
        },
        "sub-start": {
            contextVersion: 2, chatId: "chat-b", userId: "user-b", studentId: "123456789",
            classStartNotificationsEnabled: true, classStartLeadMinutes: 0
        }
    };
    const reminder = createClassStartReminderService({
        fetchSchedule: async () => ({ studentId: "123456789", lessons: [lesson()] }),
        getSubscriptions: () => subscriptions,
        sendReminder: async (subscription, text) => { sent.push({ chatId: subscription.chatId, text }); return { sent: true }; },
        stateFilePath,
        gracePeriodMs: 2 * 60000
    });

    const at1150 = new Date("2026-09-01T04:50:00.000Z");
    const result = await reminder.run(at1150);

    assert.equal(result.sent, 1, "chỉ một người nhận");
    assert.equal(sent[0].chatId, "chat-a");
    assert.match(sent[0].text, /Còn 60 phút/);
});

test("tới đúng giờ vào học thì người đặt lead 0 mới nhận", async (t) => {
    const stateFilePath = tempFile(t, "classStartNotifications.json");
    const sent = [];
    const subscriptions = {
        "sub-lead": {
            contextVersion: 2, chatId: "chat-a", userId: "user-a", studentId: "123456789",
            classStartNotificationsEnabled: true, classStartLeadMinutes: 60
        },
        "sub-start": {
            contextVersion: 2, chatId: "chat-b", userId: "user-b", studentId: "123456789",
            classStartNotificationsEnabled: true, classStartLeadMinutes: 0
        }
    };
    const reminder = createClassStartReminderService({
        fetchSchedule: async () => ({ studentId: "123456789", lessons: [lesson()] }),
        getSubscriptions: () => subscriptions,
        sendReminder: async (subscription, text) => { sent.push({ chatId: subscription.chatId, text }); return { sent: true }; },
        stateFilePath,
        gracePeriodMs: 2 * 60000
    });

    const at1250 = new Date("2026-09-01T05:50:00.000Z");
    await reminder.run(at1250);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, "chat-b");
    assert.match(sent[0].text, /ĐẾN GIỜ HỌC/);
});
