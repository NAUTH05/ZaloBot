const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    CLAIM_TTL_MS,
    claimDelivery,
    createLessonEventKey,
    createClassStartReminderService,
    findDueClassStartLessons,
    formatClassStartNotification,
    markDelivered,
    readState
} = require("../classStartNotifications");

function lesson(overrides = {}) {
    return {
        NhomID: "group-01",
        ThoiGianBD: "2026-09-01T12:50:00",
        ThoiGianKT: "2026-09-01T16:45:00",
        TenMonHoc: "Phát triển ứng dụng",
        TenPhong: "B301_Ecommerce LAB",
        TenCoSo: "Cơ sở I",
        GiaoVien: "Nguyễn Minh Phúc",
        TenNhom: "23CT113",
        Type: 0,
        OnlineLink: "https://meet.example.edu/class",
        TinhTrang: 0,
        CalenType: 1,
        ...overrides
    };
}

function subscription(studentId = "123456789", overrides = {}) {
    return {
        contextVersion: 2,
        chatId: "chat-01",
        userId: "user-01",
        studentId,
        classStartNotificationsEnabled: true,
        ...overrides
    };
}

function tempState(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-class-start-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return path.join(directory, "classStartNotifications.json");
}

function service(options) {
    return createClassStartReminderService({
        flushPersistence: async () => {},
        cacheTtlMs: 5 * 60 * 1000,
        ...options
    });
}

test("due lesson checks the grace window and excludes cancelled classes and exams", () => {
    const atStart = new Date("2026-09-01T05:50:00.000Z");
    assert.equal(findDueClassStartLessons([lesson()], new Date("2026-09-01T05:49:59.000Z")).length, 0);
    assert.equal(findDueClassStartLessons([lesson()], atStart).length, 1);
    assert.equal(findDueClassStartLessons([lesson()], new Date("2026-09-01T05:51:00.000Z")).length, 1);
    assert.equal(findDueClassStartLessons([lesson()], new Date("2026-09-01T06:00:00.000Z")).length, 0);
    assert.equal(findDueClassStartLessons([lesson({ TinhTrang: 1 })], atStart).length, 0);
    assert.equal(findDueClassStartLessons([lesson({ CalenType: 2 })], atStart).length, 0);
});

test("lesson event identity prefers the LHU lesson ID when available", () => {
    const first = createLessonEventKey("123456789", lesson({ ID: "lesson-01", NhomID: "shared-group" }));
    const second = createLessonEventKey("123456789", lesson({ ID: "lesson-02", NhomID: "shared-group" }));

    assert.notEqual(first, second);
    assert.match(first, /lesson-01$/);
    assert.match(second, /lesson-02$/);
});

test("disabled feature performs no fetch and sends no reminder", async (t) => {
    let fetchCount = 0;
    let sendCount = 0;
    const reminderService = service({
        stateFilePath: tempState(t),
        getSubscriptions: () => ({}),
        fetchSchedule: async () => { fetchCount += 1; return { lessons: [lesson()] }; },
        sendReminder: async () => { sendCount += 1; return { sent: true }; }
    });
    const result = await reminderService.run(new Date("2026-09-01T05:50:00.000Z"));
    assert.equal(result.processed, false);
    assert.equal(fetchCount, 0);
    assert.equal(sendCount, 0);
});

test("enabled feature sends once and duplicate evaluation is ignored", async (t) => {
    const stateFilePath = tempState(t);
    const sent = [];
    const subscriptions = { "chat-01::user-01": subscription() };
    const reminderService = service({
        stateFilePath,
        getSubscriptions: () => subscriptions,
        fetchSchedule: async (studentId) => ({ studentId, lessons: [lesson()] }),
        sendReminder: async (target, message) => { sent.push({ target, message }); return { sent: true }; }
    });
    const now = new Date("2026-09-01T05:50:00.000Z");
    const first = await reminderService.run(now);
    const second = await reminderService.run(now);

    assert.equal(first.sent, 1);
    assert.equal(second.sent, 0);
    assert.equal(second.duplicates, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].message, /\[ĐẾN GIỜ HỌC\]/);
    assert.doesNotMatch(sent[0].message, /bạn ơi|Bot sẽ/i);
    assert.match(sent[0].message, /Phát triển ứng dụng/);
    assert.match(sent[0].message, /Thời gian:\*\* 12:50 - 16:45/);
    assert.match(sent[0].message, /B301\\_Ecommerce LAB - Cơ sở I/);
    assert.match(sent[0].message, /Giảng viên:\*\* Nguyễn Minh Phúc/);
    assert.match(sent[0].message, /Nhóm:\*\* 23CT113/);
    assert.match(sent[0].message, /Hình thức:\*\* Lý thuyết/);
    assert.match(sent[0].message, /Trực tuyến:\*\* https:\/\/meet\.example\.edu\/class/);
    assert.equal(Object.keys(readState(stateFilePath).events).length, 1);
});

test("multiple classes at the same time are grouped while students remain independent", async (t) => {
    const sent = [];
    const schedules = {
        "123456789": [lesson(), lesson({ NhomID: "group-02", TenMonHoc: "Cơ sở dữ liệu", TenPhong: "A101" })],
        "987654321": [lesson({ NhomID: "group-03", TenMonHoc: "Lập trình Web", TenPhong: "C202" })]
    };
    const reminderService = service({
        stateFilePath: tempState(t),
        getSubscriptions: () => ({
            "chat-01::user-01": subscription("123456789"),
            "chat-02::user-02": subscription("987654321", { chatId: "chat-02", userId: "user-02" })
        }),
        fetchSchedule: async (studentId) => ({ studentId, lessons: schedules[studentId] }),
        sendReminder: async (target, message) => { sent.push({ studentId: target.studentId, message }); return { sent: true }; }
    });
    const result = await reminderService.run(new Date("2026-09-01T05:50:00.000Z"));
    assert.equal(result.sent, 2);
    assert.equal(result.lessons, 3);
    assert.deepEqual(sent.map((item) => item.studentId).sort(), ["123456789", "987654321"]);
    const groupedMessage = sent.find((item) => item.studentId === "123456789").message;
    assert.match(groupedMessage, /\*\*1\. Phát triển ứng dụng\*\*/);
    assert.match(groupedMessage, /\*\*2\. Cơ sở dữ liệu\*\*/);
    assert.equal((groupedMessage.match(/\[ĐẾN GIỜ HỌC\]/g) || []).length, 1);
});

test("lessons with different start times are not merged", async (t) => {
    const sent = [];
    const reminderService = service({
        stateFilePath: tempState(t),
        gracePeriodMs: 2 * 60 * 1000,
        getSubscriptions: () => ({ "chat-01::user-01": subscription() }),
        fetchSchedule: async (studentId) => ({
            studentId,
            lessons: [
                lesson({ NhomID: "group-01", ThoiGianBD: "2026-09-01T12:50:00" }),
                lesson({ NhomID: "group-02", TenMonHoc: "Cơ sở dữ liệu", ThoiGianBD: "2026-09-01T12:51:00" })
            ]
        }),
        sendReminder: async (target, message) => { sent.push({ target, message }); return { sent: true }; }
    });

    const result = await reminderService.run(new Date("2026-09-01T05:51:00.000Z"));
    assert.equal(result.sent, 2);
    assert.equal(sent.length, 2);
    assert.ok(sent.every((item) => (item.message.match(/\*\*Thời gian:/g) || []).length === 1));
});

test("restart does not resend an already claimed and delivered event", async (t) => {
    const stateFilePath = tempState(t);
    let sendCount = 0;
    const options = {
        stateFilePath,
        getSubscriptions: () => ({ "chat-01::user-01": subscription() }),
        fetchSchedule: async (studentId) => ({ studentId, lessons: [lesson()] }),
        sendReminder: async () => { sendCount += 1; return { sent: true }; }
    };
    const now = new Date("2026-09-01T05:50:00.000Z");
    await service(options).run(now);
    const afterRestart = await service(options).run(now);
    assert.equal(sendCount, 1);
    assert.equal(afterRestart.duplicates, 1);
});

test("API failure does not stop the next scheduler evaluation", async (t) => {
    let fetchCount = 0;
    let sendCount = 0;
    const reminderService = service({
        stateFilePath: tempState(t),
        getSubscriptions: () => ({ "chat-01::user-01": subscription() }),
        fetchSchedule: async (studentId) => {
            fetchCount += 1;
            if (fetchCount === 1) throw new Error("LHU unavailable");
            return { studentId, lessons: [lesson()] };
        },
        sendReminder: async () => { sendCount += 1; return { sent: true }; }
    });
    const now = new Date("2026-09-01T05:50:00.000Z");
    const failed = await reminderService.run(now);
    const recovered = await reminderService.run(now);
    assert.equal(failed.failed, 1);
    assert.equal(recovered.sent, 1);
    assert.equal(sendCount, 1);
});

test("failed delivery is released and can be retried", async (t) => {
    let attempts = 0;
    const stateFilePath = tempState(t);
    const reminderService = service({
        stateFilePath,
        getSubscriptions: () => ({ "chat-01::user-01": subscription() }),
        fetchSchedule: async (studentId) => ({ studentId, lessons: [lesson()] }),
        sendReminder: async () => {
            attempts += 1;
            return attempts === 1 ? { failed: true, error: new Error("temporary") } : { sent: true };
        }
    });
    const now = new Date("2026-09-01T05:50:00.000Z");

    assert.equal((await reminderService.run(now)).failed, 1);
    assert.equal(Object.keys(readState(stateFilePath).events).length, 0);
    assert.equal((await reminderService.run(now)).sent, 1);
    assert.equal(attempts, 2);
});

test("fresh confirmation prevents a stale changed lesson from being sent", async (t) => {
    let fetchCount = 0;
    let sendCount = 0;
    const reminderService = service({
        stateFilePath: tempState(t),
        getSubscriptions: () => ({ "chat-01::user-01": subscription() }),
        fetchSchedule: async (studentId) => {
            fetchCount += 1;
            return {
                studentId,
                lessons: [fetchCount === 1 ? lesson() : lesson({
                    ThoiGianBD: "2026-09-01T13:30:00",
                    ThoiGianKT: "2026-09-01T16:45:00"
                })]
            };
        },
        sendReminder: async () => { sendCount += 1; return { sent: true }; }
    });
    const result = await reminderService.run(new Date("2026-09-01T05:50:00.000Z"));
    assert.equal(fetchCount, 2);
    assert.equal(result.sent, 0);
    assert.equal(sendCount, 0);
});

test("a lesson moved into the current minute is detected despite the configured cache TTL", async (t) => {
    let fetchCount = 0;
    let sendCount = 0;
    const reminderService = service({
        stateFilePath: tempState(t),
        cacheTtlMs: 5 * 60 * 1000,
        getSubscriptions: () => ({ "chat-01::user-01": subscription() }),
        fetchSchedule: async (studentId) => {
            fetchCount += 1;
            const movedToNow = fetchCount >= 2;
            return {
                studentId,
                lessons: [lesson({
                    ThoiGianBD: movedToNow ? "2026-09-01T12:50:00" : "2026-09-01T13:30:00"
                })]
            };
        },
        sendReminder: async () => { sendCount += 1; return { sent: true }; }
    });

    await reminderService.run(new Date("2026-09-01T05:49:30.000Z"));
    const result = await reminderService.run(new Date("2026-09-01T05:50:00.000Z"));

    assert.equal(result.sent, 1);
    assert.equal(sendCount, 1);
    assert.equal(fetchCount, 3);
});

test("duplicate scheduler execution produces one delivery", async (t) => {
    let sendCount = 0;
    const reminderService = service({
        stateFilePath: tempState(t),
        getSubscriptions: () => ({ "chat-01::user-01": subscription() }),
        fetchSchedule: async (studentId) => {
            await new Promise((resolve) => setImmediate(resolve));
            return { studentId, lessons: [lesson()] };
        },
        sendReminder: async () => { sendCount += 1; return { sent: true }; }
    });
    const now = new Date("2026-09-01T05:50:00.000Z");
    const [first, second] = await Promise.all([reminderService.run(now), reminderService.run(now)]);

    assert.equal(sendCount, 1);
    assert.equal(first.sent + second.sent, 1);
    assert.ok([first, second].some((result) => result.processed === false));
});

test("multiple users receive independent deliveries", async (t) => {
    const sent = [];
    const reminderService = service({
        stateFilePath: tempState(t),
        getSubscriptions: () => ({
            "chat-01::user-01": subscription(),
            "chat-02::user-02": subscription("123456789", { chatId: "chat-02", userId: "user-02" })
        }),
        fetchSchedule: async (studentId) => ({ studentId, lessons: [lesson()] }),
        sendReminder: async (target) => { sent.push(`${target.chatId}::${target.userId}`); return { sent: true }; }
    });

    const result = await reminderService.run(new Date("2026-09-01T05:50:00.000Z"));
    assert.equal(result.sent, 2);
    assert.deepEqual(sent.sort(), ["chat-01::user-01", "chat-02::user-02"]);
});

test("notification formatter omits missing optional fields", () => {
    const message = formatClassStartNotification(lesson({
        TenPhong: "",
        TenCoSo: "",
        GiaoVien: "",
        TenNhom: "",
        Type: undefined,
        OnlineLink: ""
    }));

    assert.match(message, /Phát triển ứng dụng/);
    assert.match(message, /Thời gian/);
    assert.doesNotMatch(message, /Phòng:|Cơ sở:|Giảng viên:|Nhóm:|Hình thức:|Trực tuyến:/);
});

// ---------------------------------------------------------------------------
// HOÃN VÌ NHÀ CUNG CẤP — KHÔNG PHẢI LỖI CỦA NGƯỜI NHẬN
// ---------------------------------------------------------------------------

test("a deferred delivery releases its claim and is retried on the next run", async (t) => {
    let attempts = 0;
    const stateFilePath = tempState(t);
    const reminderService = service({
        stateFilePath,
        getSubscriptions: () => ({ "chat-01::user-01": subscription() }),
        fetchSchedule: async (studentId) => ({ studentId, lessons: [lesson()] }),
        sendReminder: async () => {
            attempts += 1;
            // Lần đầu: tài khoản ZCA đang tạm dừng ⇒ chưa gửi.
            return attempts === 1 ? { deferred: true, reason: "rate_limited" } : { sent: true, confirmed: true };
        }
    });
    const now = new Date("2026-09-01T05:50:00.000Z");

    const first = await reminderService.run(now);
    assert.equal(first.sent, 0);
    assert.equal(first.deferred, 1, "hoãn phải được đếm riêng, không gộp vào `failed`");
    assert.equal(first.failed, 0, "giới hạn tốc độ KHÔNG phải lỗi của người nhận");
    // Chỗ giữ phải được nhả: nếu giữ lại, người này mất lời nhắc cả ngày.
    assert.equal(Object.keys(readState(stateFilePath).events).length, 0);

    const second = await reminderService.run(now);
    assert.equal(second.sent, 1);
    assert.equal(attempts, 2);
});

test("a claim left behind by a crashed process is reclaimed after the TTL", (t) => {
    const stateFilePath = tempState(t);
    const target = subscription();
    const claimedAt = new Date("2026-09-01T05:50:00.000Z");
    const fields = { subscriptionKey: "chat-01::user-01", subscription: target, lesson: lesson(), now: claimedAt, filePath: stateFilePath };

    const firstId = claimDelivery(fields);
    assert.ok(firstId, "lần giữ chỗ đầu tiên phải thành công");

    // Vẫn trong hạn giữ chỗ ⇒ lượt khác đang gửi, không gửi trùng.
    assert.equal(claimDelivery({ ...fields, now: new Date(claimedAt.getTime() + 1000) }), null);

    // Quá hạn ⇒ tiến trình giữ chỗ đã chết. Phải nhận lại được, nếu không buổi học
    // đó mất lời nhắc cho tới hết hạn lưu trữ (14 ngày).
    const reclaimed = claimDelivery({
        ...fields,
        now: new Date(claimedAt.getTime() + CLAIM_TTL_MS + 1000)
    });
    assert.equal(reclaimed, firstId);
});

test("markDelivered records whether the provider confirmed the message", (t) => {
    const stateFilePath = tempState(t);
    const target = subscription();
    const eventId = claimDelivery({
        subscriptionKey: "chat-01::user-01",
        subscription: target,
        lesson: lesson(),
        now: new Date("2026-09-01T05:50:00.000Z"),
        filePath: stateFilePath
    });

    markDelivered(eventId, new Date("2026-09-01T05:50:05.000Z"), stateFilePath, { confirmed: false });
    const event = readState(stateFilePath).events[eventId];
    assert.ok(event.deliveredAt, "vẫn ghi nhận đã gửi để KHÔNG gửi trùng");
    assert.equal(event.confirmed, false, "nhưng phải nói rõ là chưa có xác nhận của nhà cung cấp");
});
