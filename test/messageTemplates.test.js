const test = require("node:test");
const assert = require("node:assert/strict");
const {
    GENERIC_ERROR_MESSAGE,
    formatClassStartEnabled,
    formatClassStartStatus,
    formatErrorMessage,
    formatMissingStudentIdMessage,
    formatSuccessMessage,
    formatWarningMessage
} = require("../messageTemplates");

test("unexpected errors do not expose internal exception details", () => {
    const message = formatErrorMessage(new TypeError("Cannot read properties of undefined"));
    assert.match(message, /KHÔNG THỂ THỰC HIỆN/);
    assert.match(message, new RegExp(GENERIC_ERROR_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(message, /Cannot read properties|TypeError|undefined/);
});

test("safe API guidance is preserved for users", () => {
    const message = formatErrorMessage({
        message: "Request failed with status code 500",
        userMessage: "Không thể lấy lịch học lúc này. Hệ thống LHU có thể đang tạm thời không phản hồi. Bạn thử lại sau ít phút nhé."
    });
    assert.match(message, /Không thể lấy lịch học lúc này/);
    assert.doesNotMatch(message, /status code 500/);
});

test("missing MSSV and reminder states provide a clear next action", () => {
    const missing = formatMissingStudentIdMessage("lich");
    assert.match(missing, /Chưa có MSSV cho tài khoản này/);
    assert.match(missing, /\/find \[MSSV\]/);

    const enabled = formatClassStartEnabled({
        studentId: "123456789",
        studentName: "Nguyễn Văn A"
    });
    assert.match(enabled, /ĐÃ BẬT NHẮC GIỜ HỌC/);
    assert.match(enabled, /Sinh viên:\*\* Nguyễn Văn A/);
    assert.doesNotMatch(enabled, /Bot sẽ|bạn ơi/i);

    const disabled = formatClassStartStatus({
        studentId: "123456789",
        studentName: "Nguyễn Văn A",
        classStartNotificationsEnabled: false
    });
    assert.match(disabled, /Trạng thái:\*\* Đang tắt/);
    assert.match(disabled, /\/batnhaclich/);
});

test("success and warning messages use one consistent visual system", () => {
    assert.match(formatSuccessMessage("ĐÃ LƯU"), /^# \{green\}✓/);
    assert.match(formatWarningMessage("CẦN KIỂM TRA"), /^# \{orange\}⚠/);
    assert.doesNotMatch(formatSuccessMessage("ĐÃ LƯU"), /\[OK\]/);
});
