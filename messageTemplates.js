const { escapeMarkdown } = require("./richText");
const { formatAdminHelp, formatPublicHelp } = require("./helpContent");

const GENERIC_ERROR_MESSAGE = "Đã xảy ra lỗi khi xử lý yêu cầu. Bạn thử lại sau ít phút nhé.";

function formatSuccessMessage(title, body = "") {
    return [`# {green}✓ ${escapeMarkdown(title)}{/green}`, body].filter(Boolean).join("\n\n");
}

function formatWarningMessage(title, body = "") {
    return [`# {orange}⚠ ${escapeMarkdown(title)}{/orange}`, body].filter(Boolean).join("\n\n");
}

function userMessageForError(error) {
    const message = String(error?.userMessage || "").trim();
    return message || GENERIC_ERROR_MESSAGE;
}

function formatErrorMessage(error) {
    return `# {orange}✕ KHÔNG THỂ THỰC HIỆN{/orange}\n\n${escapeMarkdown(userMessageForError(error))}`;
}

function formatMissingStudentIdMessage(command = "") {
    const suffix = command ? ` trước khi dùng **/${escapeMarkdown(command)}**` : " trước khi sử dụng tính năng này";
    return formatWarningMessage(
        "CHƯA CÓ MSSV",
        `Chưa có MSSV cho tài khoản này.\n\n> Dùng **/find [MSSV]** để lưu MSSV${suffix}.`
    );
}

function formatWelcomeMessage(displayName = "bạn") {
    return `# {green}[LỊCH HỌC LHU] XIN CHÀO{/green}

Xin chào **${escapeMarkdown(displayName || "bạn")}**!

> Dùng **/find [MSSV]** để lưu mã sinh viên.
> Dùng **/lich** để xem lịch hôm nay hoặc **/dangky [hh:mm]** để chọn giờ nhận lịch.

{orange}Dùng **/help** để xem danh sách lệnh.{/orange}`;
}

// Nội dung trợ giúp được quản lý tập trung trong helpContent.js để /help và
// /helpadmin luôn khớp với parser thật.
function formatGeneralHelp() {
    return formatPublicHelp();
}

function formatStudentSavedMessage(scheduleData, subscription) {
    const notificationsEnabled = subscription?.notificationsEnabled === true;
    return formatSuccessMessage(
        "ĐÃ LƯU MSSV",
        `**Sinh viên:** ${escapeMarkdown(scheduleData.studentName || "Sinh viên")}\n` +
        `> **MSSV:** ${escapeMarkdown(scheduleData.studentId)}\n` +
        `> **Nhận lịch tự động:** ${notificationsEnabled ? "Đang bật" : "Đang tắt"}\n\n` +
        "> Dùng **/lich** để xem lịch hoặc **/dangky [hh:mm]** để chọn giờ nhận lịch."
    );
}

function formatDailyNotificationEnabled(scheduleData, notificationTimes) {
    const times = (notificationTimes || []).map((item) => `#${item.id} ${item.time}`).join(", ");
    return formatSuccessMessage(
        "ĐÃ BẬT THÔNG BÁO LỊCH",
        `> **Sinh viên:** ${escapeMarkdown(scheduleData.studentName || "Sinh viên")}\n` +
        `> **MSSV:** ${escapeMarkdown(scheduleData.studentId)}\n` +
        `> **Giờ nhận lịch:** ${escapeMarkdown(times || "06:00")}`
    );
}

function formatClassStartEnabled(subscription) {
    return formatSuccessMessage(
        "ĐÃ BẬT NHẮC GIỜ HỌC",
        `> **Sinh viên:** ${escapeMarkdown(subscription.studentName || "Sinh viên")}\n` +
        `> **MSSV:** ${escapeMarkdown(subscription.studentId)}\n\n` +
        "Bạn sẽ nhận thông báo kèm thông tin buổi học khi mỗi tiết học bắt đầu."
    );
}

function formatClassStartStatus(subscription) {
    const enabled = subscription.classStartNotificationsEnabled === true;
    return `# {${enabled ? "green" : "orange"}}[NHẮC GIỜ HỌC]{/${enabled ? "green" : "orange"}}

**Trạng thái:** ${enabled ? "Đang bật" : "Đang tắt"}

**Sinh viên:** ${escapeMarkdown(subscription.studentName || "Sinh viên")}
**MSSV:** ${escapeMarkdown(subscription.studentId)}

> ${enabled
        ? "Bạn sẽ nhận thông báo khi mỗi tiết học bắt đầu."
        : "Dùng **/batnhaclich** để bật tính năng này."}`;
}

module.exports = {
    GENERIC_ERROR_MESSAGE,
    formatAdminHelp,
    formatClassStartEnabled,
    formatClassStartStatus,
    formatDailyNotificationEnabled,
    formatErrorMessage,
    formatGeneralHelp,
    formatMissingStudentIdMessage,
    formatStudentSavedMessage,
    formatSuccessMessage,
    formatWarningMessage,
    formatWelcomeMessage,
    userMessageForError
};
