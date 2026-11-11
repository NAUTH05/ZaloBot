const test = require("node:test");
const assert = require("node:assert/strict");

const { createActionExecutor } = require("../ai/actionExecutor");
const { normalizeNotificationTimes } = require("../subscriptions");
const { normalizeStudentId } = require("../lhuSchedule");

const CONTEXT = { botId: "bot1", chatId: "chat-1", userId: "user-1", userDisplayName: "An" };

const SCHEDULES = {
    "123456789": { studentId: "123456789", studentName: "Nguyễn Văn A", lessons: [] },
    "987654321": { studentId: "987654321", studentName: "Trần Thị B", lessons: [] }
};

function createHarness(options = {}) {
    const state = {
        record: options.record || null,
        writes: [],
        snapshots: 0,
        removed: [],
        updated: [],
        fetched: []
    };

    const deps = {
        getSubscription: () => state.record,
        saveStudent: (_context, { studentId, studentName }) => {
            state.writes.push({ kind: "save_student", studentId });
            state.record = {
                ...(state.record || {}),
                studentId,
                studentName,
                notificationTimes: state.record?.notificationTimes || [],
                notificationsEnabled: state.record?.notificationsEnabled === true
            };
            return state.record;
        },
        enableNotifications: (_context, { studentId, studentName, notificationTime, targetDayOffset }) => {
            const times = normalizeNotificationTimes(state.record);
            const duplicate = times.some((item) => item.time === notificationTime && item.targetDayOffset === targetDayOffset);
            if (notificationTime && !duplicate) {
                const nextId = times.reduce((max, item) => Math.max(max, item.id), 0) + 1;
                times.push({ id: nextId, time: notificationTime, targetDayOffset });
            }
            state.writes.push({ kind: "enable", studentId, notificationTime, targetDayOffset });
            state.record = {
                ...(state.record || {}),
                studentId,
                studentName,
                notificationTimes: times,
                notificationsEnabled: true
            };
            return state.record;
        },
        disableNotifications: () => {
            if (!state.record?.notificationsEnabled) return false;
            state.record = { ...state.record, notificationsEnabled: false };
            state.writes.push({ kind: "disable" });
            return true;
        },
        enableClassStartNotifications: () => {
            state.record = { ...(state.record || {}), classStartNotificationsEnabled: true };
            return state.record;
        },
        disableClassStartNotifications: () => {
            if (!state.record?.classStartNotificationsEnabled) return false;
            state.record = { ...state.record, classStartNotificationsEnabled: false };
            return true;
        },
        updateNotificationTime: (_context, id, time, offset) => {
            const times = normalizeNotificationTimes(state.record);
            const index = times.findIndex((item) => item.id === id);
            if (index < 0) return null;
            times[index] = { ...times[index], time: time || times[index].time, targetDayOffset: offset };
            state.updated.push({ id, time, offset });
            state.record = { ...state.record, notificationTimes: times };
            return state.record;
        },
        removeNotificationTime: (_context, id) => {
            if (options.failDelete) throw new Error("store hỏng");
            const times = normalizeNotificationTimes(state.record);
            const removed = times.find((item) => item.id === id);
            if (!removed) return null;
            state.removed.push(id);
            state.record = { ...state.record, notificationTimes: times.filter((item) => item.id !== id) };
            return { subscription: state.record, removed };
        },
        normalizeNotificationTimes,
        normalizeStudentId,
        fetchStudentSchedule: async (studentId) => {
            state.fetched.push(studentId);
            const data = SCHEDULES[studentId];
            if (!data) throw new Error("không tra được MSSV");
            return data;
        },
        initializeScheduleSnapshot: () => { state.snapshots += 1; },
        formatDailySchedule: () => "LỊCH HÔM NAY",
        formatWeeklySchedule: () => "LỊCH TUẦN",
        formatExamSchedule: () => "LỊCH THI",
        getEnabledSubscriptions: () => ({}),
        gatedWrite: (_context, _label, run) => run(),
        now: () => new Date("2026-11-11T05:00:00.000Z")
    };

    // Cho phép bài kiểm tra bơm thêm phụ thuộc (quản trị, isOwner…).
    Object.assign(deps, options.deps || {});

    return { state, deps, executor: createActionExecutor(deps) };
}
function withTimes(record, times) {
    return { ...record, notificationTimes: times.map((item, index) => ({ id: index + 1, ...item })) };
}

test("lưu MSSV: chỉ lưu sau khi tra được trên hệ thống trường", async () => {
    const { state, executor } = createHarness();
    const result = await executor.run({ context: CONTEXT, actions: [{ type: "save_mssv", student_id: "123456789" }] });

    assert.equal(result.ok, true);
    assert.deepEqual(state.fetched, ["123456789"]);
    assert.deepEqual(state.writes, [{ kind: "save_student", studentId: "123456789" }]);
    assert.match(result.message, /123456789/);
});

test("MSSV không tra được thì không ghi gì", async () => {
    const { state, executor } = createHarness();
    const result = await executor.run({ context: CONTEXT, actions: [{ type: "save_mssv", student_id: "111111111" }] });

    assert.equal(result.ok, false);
    assert.equal(result.executed, false);
    assert.equal(result.errors[0].error, "student_not_verified");
    assert.deepEqual(state.writes, []);
});

test("lô lệnh: đăng ký sau khi lưu MSSV dùng MSSV MỚI trong cùng tin", async () => {
    const { state, executor } = createHarness();
    const result = await executor.run({
        context: CONTEXT,
        actions: [
            { type: "save_mssv", student_id: "123456789" },
            { type: "register_notification", time: "06:00", target_day: "today" },
            { type: "register_notification", time: "20:00", target_day: "tomorrow" }
        ]
    });

    assert.equal(result.ok, true);
    assert.equal(state.record.studentId, "123456789");
    assert.deepEqual(
        state.record.notificationTimes.map((item) => `${item.time}#${item.targetDayOffset}`),
        ["06:00#0", "20:00#1"]
    );
    // Chỉ tra MSSV một lần cho cả lô.
    assert.deepEqual(state.fetched, ["123456789"]);
});

test("đăng ký trùng giờ và ngày đích bị bỏ qua, không tạo mốc thứ hai", async () => {
    const record = withTimes({ studentId: "123456789", studentName: "A", notificationsEnabled: true }, [
        { time: "06:00", targetDayOffset: 0 }
    ]);
    const { state, executor } = createHarness({ record });
    const result = await executor.run({
        context: CONTEXT,
        actions: [{ type: "register_notification", time: "06:00", target_day: "today" }]
    });

    assert.equal(result.ok, true);
    assert.equal(result.results[0].status, "skipped");
    assert.equal(state.record.notificationTimes.length, 1);
    assert.deepEqual(state.writes, []);
});

test("cùng giờ nhưng khác ngày đích là hai mốc riêng", async () => {
    const record = withTimes({ studentId: "123456789", studentName: "A", notificationsEnabled: true }, [
        { time: "06:00", targetDayOffset: 0 }
    ]);
    const { state, executor } = createHarness({ record });
    await executor.run({
        context: CONTEXT,
        actions: [{ type: "register_notification", time: "06:00", target_day: "tomorrow" }]
    });

    assert.equal(state.record.notificationTimes.length, 2);
});

test("thiếu MSSV thì báo lỗi chứ không tự bịa", async () => {
    const { state, executor } = createHarness();
    const result = await executor.run({
        context: CONTEXT,
        actions: [{ type: "register_notification", time: "06:00", target_day: "today" }]
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].error, "missing_student_id");
    assert.deepEqual(state.writes, []);
});

test("xoá mốc không tồn tại bị chặn trước khi ghi", async () => {
    const record = withTimes({ studentId: "123456789", studentName: "A" }, [{ time: "06:00", targetDayOffset: 0 }]);
    const { state, executor } = createHarness({ record });
    const result = await executor.run({ context: CONTEXT, actions: [{ type: "delete_notification", id: 9 }] });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].error, "unknown_id");
    assert.deepEqual(state.removed, []);
});

test("một hành động sai làm cả lô dừng trước khi ghi", async () => {
    const record = withTimes({ studentId: "123456789", studentName: "A" }, [{ time: "06:00", targetDayOffset: 0 }]);
    const { state, executor } = createHarness({ record });
    const result = await executor.run({
        context: CONTEXT,
        actions: [
            { type: "register_notification", time: "07:00", target_day: "today" },
            { type: "delete_notification", id: 42 }
        ]
    });

    assert.equal(result.ok, false);
    assert.equal(result.executed, false);
    assert.deepEqual(state.writes, [], "không được ghi trước khi kiểm tra xong");
});

test("xoá và tắt nhận lịch cần xác nhận, đăng ký thì không", async () => {
    const record = withTimes({ studentId: "123456789", studentName: "A", notificationsEnabled: true }, [
        { time: "06:00", targetDayOffset: 0 }
    ]);
    const { executor } = createHarness({ record });

    const removePlan = await executor.prepare({ context: CONTEXT, actions: [{ type: "delete_notification", id: 1 }] });
    assert.equal(removePlan.requiresConfirmation, true);

    const disablePlan = await executor.prepare({ context: CONTEXT, actions: [{ type: "disable_notifications" }] });
    assert.equal(disablePlan.requiresConfirmation, true);

    const addPlan = await executor.prepare({
        context: CONTEXT,
        actions: [{ type: "register_notification", time: "07:00", target_day: "today" }]
    });
    assert.equal(addPlan.requiresConfirmation, false);
});

test("thay MSSV đang lưu bằng MSSV khác cần xác nhận", async () => {
    const { executor } = createHarness({ record: { studentId: "123456789", studentName: "A" } });
    const plan = await executor.prepare({ context: CONTEXT, actions: [{ type: "save_mssv", student_id: "987654321" }] });
    assert.equal(plan.ok, true);
    assert.equal(plan.requiresConfirmation, true);
    assert.match(plan.confirmationReasons.join(" "), /thay MSSV/);
});

test("lỗi giữa lô: báo đúng phần đã xong và phần hỏng", async () => {
    const record = withTimes({ studentId: "123456789", studentName: "A", notificationsEnabled: true }, [
        { time: "06:00", targetDayOffset: 0 }
    ]);
    const { state, executor } = createHarness({ record, failDelete: true });
    const result = await executor.run({
        context: CONTEXT,
        actions: [
            { type: "register_notification", time: "09:00", target_day: "today" },
            { type: "delete_notification", id: 1 }
        ]
    });

    assert.equal(result.executed, true);
    assert.equal(result.ok, false, "không được báo thành công toàn bộ");
    assert.equal(result.results[0].status, "ok");
    assert.equal(result.results[1].status, "failed");
    assert.match(result.message, /chưa thực hiện được/);
    assert.ok(state.writes.some((item) => item.kind === "enable"));
});

test("xem giờ nhận lịch và xem lịch tuần trả nội dung riêng", async () => {
    const record = withTimes({ studentId: "123456789", studentName: "A" }, [{ time: "06:00", targetDayOffset: 0 }]);
    const { executor } = createHarness({ record });

    const list = await executor.run({ context: CONTEXT, actions: [{ type: "list_notifications" }] });
    assert.match(list.results[0].text, /06:00/);

    const week = await executor.run({ context: CONTEXT, actions: [{ type: "get_week_schedule" }] });
    assert.deepEqual(week.extraMessages, ["LỊCH TUẦN"]);
});

test("tắt nhận lịch khi vốn đang tắt được báo là bỏ qua, không phải lỗi", async () => {
    const { executor } = createHarness({ record: { studentId: "123456789", notificationsEnabled: false } });
    const result = await executor.run({ context: CONTEXT, actions: [{ type: "disable_notifications" }] });
    assert.equal(result.ok, true);
    assert.equal(result.results[0].status, "skipped");
});

/* -------------------------------------------------------------------------- */
/* Xoá mốc bằng giờ + ngày đích (không cần ID)                                 */
/* -------------------------------------------------------------------------- */

test("xoá mốc bằng giờ + ngày đích, tự tra ra ID", async () => {
    const record = withTimes({ studentId: "123456789", studentName: "A", notificationsEnabled: true }, [
        { time: "06:00", targetDayOffset: 0 },
        { time: "21:00", targetDayOffset: 1 }
    ]);
    const { state, executor } = createHarness({ record });

    const result = await executor.run({
        context: CONTEXT,
        actions: [{ type: "delete_notification", time: "21:00", target_day: "tomorrow" }]
    });

    assert.equal(result.ok, true);
    assert.deepEqual(state.removed, [2], "phải xoá đúng mốc ID 2, không phải mốc 06:00");
    assert.deepEqual(state.record.notificationTimes.map((item) => item.time), ["06:00"]);
});

test("cùng giờ nhưng khác ngày đích thì không xoá nhầm", async () => {
    const record = withTimes({ studentId: "123456789", studentName: "A", notificationsEnabled: true }, [
        { time: "21:00", targetDayOffset: 0 },
        { time: "21:00", targetDayOffset: 1 }
    ]);
    const { state, executor } = createHarness({ record });

    await executor.run({
        context: CONTEXT,
        actions: [{ type: "delete_notification", time: "21:00", target_day: "tomorrow" }]
    });

    assert.deepEqual(state.removed, [2]);
    assert.equal(state.record.notificationTimes.length, 1);
    assert.equal(state.record.notificationTimes[0].targetDayOffset, 0, "mốc hôm nay phải còn nguyên");
});

test("không có mốc nào khớp thì báo lỗi, không xoá gì", async () => {
    const record = withTimes({ studentId: "123456789", studentName: "A" }, [{ time: "06:00", targetDayOffset: 0 }]);
    const { state, executor } = createHarness({ record });

    const result = await executor.run({
        context: CONTEXT,
        actions: [{ type: "delete_notification", time: "21:00", target_day: "tomorrow" }]
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].error, "not_found");
    assert.deepEqual(state.removed, []);
});

/* -------------------------------------------------------------------------- */
/* Hành động quản trị                                                          */
/* -------------------------------------------------------------------------- */

function adminHarness(overrides = {}) {
    const calls = [];
    const handler = (name) => async ({ step }) => {
        calls.push({ name, step });
        return `KẾT QUẢ ${name}`;
    };
    const harness = createHarness({
        deps: {
            isOwner: overrides.isOwner || (() => true),
            adminBotStatus: handler("bot_status"),
            adminListChats: handler("list_chats"),
            adminChatDetails: handler("chat_details"),
            adminAccessList: handler("access_list"),
            adminPauseChat: handler("pause_chat"),
            adminResumeChat: handler("resume_chat"),
            adminTestChat: handler("test_chat"),
            ...(overrides.deps || {})
        }
    });
    return { ...harness, calls };
}

test("người KHÔNG phải owner không chạy được hành động quản trị", async () => {
    const { calls, executor } = adminHarness({ isOwner: () => false });
    const result = await executor.run({
        context: CONTEXT,
        actions: [{ type: "admin_pause_chat", chat_id: "123456" }]
    });

    assert.equal(result.ok, false);
    assert.equal(result.executed, false);
    assert.equal(result.errors[0].error, "not_owner");
    assert.deepEqual(calls, [], "không handler nào được gọi");
});

test("lô trộn công khai + quản trị của người thường bị từ chối toàn bộ", async () => {
    const { calls, executor } = adminHarness({ isOwner: () => false });
    const result = await executor.run({
        context: CONTEXT,
        actions: [
            { type: "list_notifications" },
            { type: "admin_resume_chat", chat_id: "123456" }
        ]
    });

    assert.equal(result.ok, false);
    assert.deepEqual(calls, [], "không được chạy nửa vời");
});

test("owner đọc chẩn đoán: kết quả trả về dưới dạng tin nhắn riêng", async () => {
    const { calls, executor } = adminHarness();
    const result = await executor.run({ context: CONTEXT, actions: [{ type: "admin_bot_status" }] });

    assert.equal(result.ok, true);
    assert.deepEqual(result.extraMessages, ["KẾT QUẢ bot_status"]);
    assert.equal(calls.length, 1);
});

test("tạm dừng chat cần xác nhận, bật lại thì không", async () => {
    const { executor } = adminHarness();

    const pause = await executor.prepare({ context: CONTEXT, actions: [{ type: "admin_pause_chat", chat_id: "123456" }] });
    assert.equal(pause.requiresConfirmation, true);
    assert.match(pause.confirmationReasons.join(" "), /tạm dừng/);

    const resume = await executor.prepare({ context: CONTEXT, actions: [{ type: "admin_resume_chat", chat_id: "123456" }] });
    assert.equal(resume.requiresConfirmation, false);

    const test = await executor.prepare({ context: CONTEXT, actions: [{ type: "admin_test_chat", chat_id: "123456" }] });
    assert.equal(test.requiresConfirmation, true, "gửi tin thật tới người thật phải hỏi trước");
});

test("thiếu handler quản trị thì fail closed", async () => {
    const { executor } = createHarness({ deps: { isOwner: () => true } });
    const result = await executor.run({ context: CONTEXT, actions: [{ type: "admin_bot_status" }] });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].error, "admin_unavailable");
});

test("chat_id không hợp lệ bị chặn từ lược đồ, không tới handler", async () => {
    const { validateAction } = require("../ai/actionSchema");
    for (const bad of ["abc", "", "12 34", "zca:123"]) {
        assert.equal(validateAction({ type: "admin_pause_chat", chat_id: bad }).ok, false, bad);
    }
    assert.equal(validateAction({ type: "admin_pause_chat", chat_id: "123456789" }).ok, true);
});

test("xem giờ nhận lịch: nội dung phải được GỬI ĐI, không chỉ nằm trong kết quả", async () => {
    const record = withTimes({ studentId: "123456789", studentName: "A", notificationsEnabled: true }, [
        { time: "06:00", targetDayOffset: 0 },
        { time: "20:00", targetDayOffset: 1 }
    ]);
    const { executor } = createHarness({ record });

    const result = await executor.run({ context: CONTEXT, actions: [{ type: "list_notifications" }] });

    assert.equal(result.extraMessages.length, 1, "danh sách phải nằm trong tin sẽ gửi");
    assert.match(result.extraMessages[0], /06:00/);
    assert.match(result.extraMessages[0], /20:00/);
    assert.equal(result.message, "", "hành động chỉ đọc không được sinh tiêu đề tổng kết rỗng nghĩa");
});

test("xem lịch cũng là nội dung trả lời, không phải một dòng tổng kết", async () => {
    const { executor } = createHarness({ record: { studentId: "123456789", studentName: "A" } });
    const result = await executor.run({ context: CONTEXT, actions: [{ type: "get_week_schedule" }] });
    assert.deepEqual(result.extraMessages, ["LỊCH TUẦN"]);
    assert.equal(result.message, "");
});

/* -------------------------------------------------------------------------- */
/* Lịch theo ngày + nhắc trước giờ học                                         */
/* -------------------------------------------------------------------------- */

test("xem lịch theo ngày: máy chủ quy đổi cụm từ và tra đúng ngày đó", async () => {
    const calls = [];
    const { executor } = createHarness({
        record: { studentId: "123456789", studentName: "A" },
        deps: {
            fetchStudentSchedule: async (studentId, date) => {
                calls.push({ studentId, dateKey: date ? date.toISOString().slice(0, 10) : null });
                return { studentId, studentName: "A", lessons: [] };
            },
            formatDailySchedule: (_data, date) => `LỊCH ${date.toISOString().slice(0, 10)}`
        }
    });

    const result = await executor.run({
        context: CONTEXT,
        actions: [{ type: "get_schedule_for_date", date: "mai" }]
    });

    assert.equal(result.ok, true);
    // NOW của harness là 2026-11-11 ⇒ "mai" = 2026-11-12.
    assert.deepEqual(calls, [{ studentId: "123456789", dateKey: "2026-11-12" }]);
    assert.deepEqual(result.extraMessages, ["LỊCH 2026-11-12"]);
    assert.equal(result.message, "", "đây là câu trả lời, không phải một dòng tổng kết");
});

test("ngày không hiểu được thì hỏi lại, không tra bừa", async () => {
    const { state, executor } = createHarness({
        record: { studentId: "123456789", studentName: "A" }
    });
    const result = await executor.run({
        context: CONTEXT,
        actions: [{ type: "get_schedule_for_date", date: "tuần sau" }]
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].error, "invalid_date");
    assert.deepEqual(state.fetched, [], "không được gọi API khi chưa hiểu ngày");
});

test("nhắc trước giờ học: lưu số phút và bật tính năng", async () => {
    const saved = [];
    const { executor } = createHarness({
        record: { studentId: "123456789", studentName: "A" },
        deps: {
            setClassStartLead: (_context, minutes) => {
                saved.push(minutes);
                return { studentId: "123456789", classStartLeadMinutes: minutes, classStartNotificationsEnabled: true };
            }
        }
    });

    const result = await executor.run({
        context: CONTEXT,
        actions: [{ type: "set_class_start_reminder", lead_minutes: 60 }]
    });

    assert.equal(result.ok, true);
    assert.deepEqual(saved, [60]);
    assert.match(result.message, /60 phút/);
});

test("nhắc trước giờ học cần có MSSV trước", async () => {
    const { executor } = createHarness();
    const result = await executor.run({
        context: CONTEXT,
        actions: [{ type: "set_class_start_reminder", lead_minutes: 10 }]
    });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].error, "missing_student_id");
});
