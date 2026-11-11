const test = require("node:test");
const assert = require("node:assert/strict");

const {
    DECISION,
    actionNeedsConfirmation,
    planNeedsConfirmation,
    validateAction,
    validateAssistantResponse
} = require("../ai/actionSchema");

function plan(overrides = {}) {
    return {
        decision: "answer",
        reply: "Chào cậu",
        actions: [],
        missing_fields: [],
        requires_confirmation: false,
        ...overrides
    };
}

test("chấp nhận phản hồi hợp lệ và chuẩn hoá giờ", () => {
    const result = validateAssistantResponse(plan({
        decision: "execute",
        actions: [{ type: "register_notification", time: "6:00", target_day: "today" }]
    }), { maxActions: 5 });

    assert.equal(result.ok, true);
    assert.equal(result.plan.decision, DECISION.EXECUTE);
    assert.deepEqual(result.plan.actions, [{ type: "register_notification", time: "06:00", target_day: "today" }]);
});

test("nhận MSSV dạng placeholder do máy chủ sinh ra", () => {
    const result = validateAction({ type: "save_mssv", student_id: "{{mssv:1}}" });
    assert.equal(result.ok, true);
    assert.equal(result.action.student_id, "{{mssv:1}}");
});

test("từ chối loại hành động không có trong allowlist", () => {
    for (const type of ["delete_all_data", "broadcast", "run_shell", "blockbot", "grant_admin", "read_firestore", ""]) {
        const result = validateAction({ type, id: 1 });
        assert.equal(result.ok, false, type);
        assert.match(result.error, /không được phép/);
    }
    assert.equal(validateAction(null).ok, false);
    assert.equal(validateAction("save_mssv").ok, false);
});

test("từ chối thuộc tính lạ trong hành động", () => {
    const result = validateAction({ type: "save_mssv", student_id: "123456789", isAdmin: true });
    assert.equal(result.ok, false);
    assert.match(result.error, /thuộc tính không được phép/);
});

test("không bao giờ nhận botId/chatId/userId từ mô hình", () => {
    for (const field of ["botId", "chatId", "userId"]) {
        const result = validateAction({ type: "list_notifications", [field]: "ke-gia-mao" });
        assert.equal(result.ok, false, field);
    }
});

test("từ chối decision lạ và JSON hỏng", () => {
    assert.equal(validateAssistantResponse(plan({ decision: "sudo" })).ok, false);
    assert.equal(validateAssistantResponse("{khong-phai-json").ok, false);
    assert.equal(validateAssistantResponse("[]").ok, false);
    assert.equal(validateAssistantResponse(null).ok, false);
});

test("từ chối thuộc tính lạ ở cấp cao nhất", () => {
    const result = validateAssistantResponse(plan({ isAdmin: true }));
    assert.equal(result.ok, false);
    assert.match(result.error, /thuộc tính lạ/);
});

test("giới hạn số hành động trong một phản hồi", () => {
    const actions = Array.from({ length: 6 }, () => ({ type: "list_notifications" }));
    const result = validateAssistantResponse(plan({ decision: "execute", actions }), { maxActions: 5 });
    assert.equal(result.ok, false);
    assert.match(result.error, /quá nhiều hành động/);
});

test("execute rỗng bị hạ xuống answer để không im lặng", () => {
    const result = validateAssistantResponse(plan({ decision: "execute", actions: [] }));
    assert.equal(result.ok, true);
    assert.equal(result.plan.decision, DECISION.ANSWER);
});

test("kiểm tra giá trị từng trường", () => {
    assert.equal(validateAction({ type: "register_notification", time: "24:00", target_day: "today" }).ok, false);
    assert.equal(validateAction({ type: "register_notification", time: "06:00", target_day: "nextweek" }).ok, false);
    assert.equal(validateAction({ type: "register_notification", time: "06:00" }).ok, false);
    assert.equal(validateAction({ type: "delete_notification", id: 0 }).ok, false);
    assert.equal(validateAction({ type: "delete_notification", id: -3 }).ok, false);
    assert.equal(validateAction({ type: "delete_notification", id: 1.5 }).ok, false);
    assert.equal(validateAction({ type: "delete_notification", id: "1" }).ok, true);
    assert.equal(validateAction({ type: "update_notification", id: 2 }).ok, false, "cần time hoặc target_day");
    assert.equal(validateAction({ type: "update_notification", id: 2, target_day: "tomorrow" }).ok, true);
    assert.equal(validateAction({ type: "save_mssv", student_id: "12345" }).ok, false);
    assert.equal(validateAction({ type: "save_mssv", student_id: "123456789" }).ok, true);
});

test("trợ giúp chỉ được trỏ tới lệnh công khai", () => {
    assert.equal(validateAction({ type: "help", command: "nhanlich" }).ok, true);
    assert.equal(validateAction({ type: "help", command: "blockbot" }).ok, false);
    assert.equal(validateAction({ type: "help", command: "khongcolenh" }).ok, false);
});

test("chính sách xác nhận do backend quyết định", () => {
    assert.equal(actionNeedsConfirmation({ type: "delete_notification" }), true);
    assert.equal(actionNeedsConfirmation({ type: "disable_notifications" }), true);
    assert.equal(actionNeedsConfirmation({ type: "disable_class_start_notifications" }), true);
    assert.equal(actionNeedsConfirmation({ type: "register_notification" }), false);
    assert.equal(planNeedsConfirmation([{ type: "list_notifications" }, { type: "delete_notification" }]), true);
    assert.equal(planNeedsConfirmation([]), false);
});

test("requires_confirmation do mô hình khai không thay đổi chính sách", () => {
    const result = validateAssistantResponse(plan({
        decision: "execute",
        requires_confirmation: false,
        actions: [{ type: "delete_notification", id: 1 }]
    }));
    assert.equal(result.ok, true);
    // Mô hình nói "không cần xác nhận" nhưng backend vẫn phải hỏi.
    assert.equal(planNeedsConfirmation(result.plan.actions), true);
});

/* -------------------------------------------------------------------------- */
/* Xoá theo giờ + ngày đích, và cổng quản trị                                  */
/* -------------------------------------------------------------------------- */

test("xoá mốc nhận lịch được chỉ bằng giờ + ngày đích", () => {
    assert.equal(validateAction({ type: "delete_notification", time: "21:00", target_day: "tomorrow" }).ok, true);
    assert.equal(validateAction({ type: "delete_notification", id: 3 }).ok, true);
    const missing = validateAction({ type: "delete_notification", time: "21:00" });
    assert.equal(missing.ok, false, "thiếu ngày đích thì không tra được mốc nào");
    assert.match(missing.error, /id, hoặc time \+ target_day/);
});

test("hành động quản trị bị từ chối khi máy chủ chưa xác nhận owner", () => {
    const response = plan({
        decision: "execute",
        actions: [{ type: "admin_pause_chat", chat_id: "123456" }]
    });
    const blocked = validateAssistantResponse(response);
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /hành động quản trị không được phép/);

    const allowed = validateAssistantResponse(response, { allowAdmin: true });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.plan.actions[0].type, "admin_pause_chat");
});

test("quản trị viên vẫn không có hành động phát tin hàng loạt hay phân quyền", () => {
    for (const type of ["broadcast", "update", "blockbot", "blockai", "allowbot", "accessmode", "xoachat"]) {
        const result = validateAction({ type, chat_id: "1" }, { allowAdmin: true });
        assert.equal(result.ok, false, `không được mở ${type} cho mô hình`);
    }
});

/* -------------------------------------------------------------------------- */
/* Hai hành động mới: lịch theo ngày, nhắc trước giờ học                        */
/* -------------------------------------------------------------------------- */

test("get_schedule_for_date nhận cụm từ chỉ ngày, không tự tính ngày", () => {
    assert.equal(validateAction({ type: "get_schedule_for_date", date: "mai" }).ok, true);
    assert.equal(validateAction({ type: "get_schedule_for_date", date: "thứ 5" }).ok, true);
    assert.equal(validateAction({ type: "get_schedule_for_date", date: "2026-11-12" }).ok, true);
    assert.equal(validateAction({ type: "get_schedule_for_date" }).ok, false);
    assert.equal(validateAction({ type: "get_schedule_for_date", date: "" }).ok, false);
    assert.equal(validateAction({ type: "get_schedule_for_date", date: "x".repeat(40) }).ok, false);
});

test("set_class_start_reminder chỉ nhận 0–180 phút", () => {
    assert.equal(validateAction({ type: "set_class_start_reminder", lead_minutes: 0 }).ok, true);
    assert.equal(validateAction({ type: "set_class_start_reminder", lead_minutes: 60 }).ok, true);
    assert.equal(validateAction({ type: "set_class_start_reminder", lead_minutes: 180 }).ok, true);
    assert.equal(validateAction({ type: "set_class_start_reminder", lead_minutes: -1 }).ok, false);
    assert.equal(validateAction({ type: "set_class_start_reminder", lead_minutes: 181 }).ok, false);
    assert.equal(validateAction({ type: "set_class_start_reminder", lead_minutes: 10.5 }).ok, false);
    assert.equal(validateAction({ type: "set_class_start_reminder", lead_minutes: "abc" }).ok, false);
    assert.equal(validateAction({ type: "set_class_start_reminder" }).ok, false);
});
