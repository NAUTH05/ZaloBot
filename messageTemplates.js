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
        `Chưa có MSSV cho tài khoản này.\n\n> Dùng **/luumssv [MSSV]** để lưu MSSV${suffix}.`
    );
}

function formatWelcomeMessage(displayName = "bạn") {
    return `# {green}[LỊCH HỌC LHU] XIN CHÀO{/green}

Xin chào **${escapeMarkdown(displayName || "bạn")}**!

> Dùng **/luumssv [MSSV]** để lưu mã sinh viên.
> Dùng **/lich** để xem lịch hôm nay hoặc **/nhanlich hh:mm homnay|homsau** để chọn giờ nhận lịch.

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
        "> Dùng **/lich** để xem lịch hoặc **/nhanlich hh:mm homnay|homsau** để chọn giờ nhận lịch."
    );
}

function formatTargetDay(targetDayOffset) {
    return Number(targetDayOffset) === 1 ? "homsau" : "homnay";
}

function formatDailyNotificationEnabled(scheduleData, notificationTimes) {
    const times = (notificationTimes || [])
        .map((item) => `#${item.id} ${item.time} (${formatTargetDay(item.targetDayOffset)})`)
        .join(", ");
    return formatSuccessMessage(
        "ĐÃ BẬT THÔNG BÁO LỊCH",
        `> **Sinh viên:** ${escapeMarkdown(scheduleData.studentName || "Sinh viên")}\n` +
        `> **MSSV:** ${escapeMarkdown(scheduleData.studentId)}\n` +
        `> **Giờ nhận lịch:** ${escapeMarkdown(times || "06:00 (homnay)")}\n\n` +
        "**homnay** = gửi lịch hôm nay, **homsau** = gửi lịch hôm sau. Dùng /suagionhanlich để đổi."
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

// ---------------------------------------------------------------------------
// Hỗ trợ / góp ý
//
// Lời lẽ ngắn gọn, nói rõ hai điều người dùng cần biết: mã yêu cầu, và việc quản
// trị viên trả lời NGAY TRONG cuộc trò chuyện này (không cần kết bạn Zalo riêng).
// ---------------------------------------------------------------------------

function formatFeedbackUsage() {
    return `# {orange}GỬI GÓP Ý / HỖ TRỢ{/orange}

> Gõ nội dung bạn muốn gửi ngay sau lệnh.

**Ví dụ:**
**/feedback Lịch học hôm nay không được gửi tới**

Mình sẽ gửi tới quản trị viên và trả lời bạn ngay trong cuộc trò chuyện này.`;
}

function formatFeedbackAck(ticketId) {
    return `# {green}✓ ĐÃ GHI NHẬN{/green}

> **Mã yêu cầu:** ${escapeMarkdown(ticketId)}

Quản trị viên sẽ trả lời bạn **ngay trong cuộc trò chuyện này**. Không cần kết bạn Zalo với ai.

Muốn viết thêm, dùng:
**/feedback ${escapeMarkdown(ticketId)} [nội dung]**`;
}

function formatFeedbackDuplicateAck(ticketId) {
    // Zalo gửi lại cùng một update: yêu cầu đã có, không tạo bản sao.
    return `# {green}✓ YÊU CẦU ĐÃ CÓ{/green}

> **Mã yêu cầu:** ${escapeMarkdown(ticketId)}

Yêu cầu này đã được ghi nhận trước đó. Quản trị viên sẽ trả lời trong cuộc trò chuyện này.`;
}

function formatFeedbackFollowUpAck(ticketId) {
    return `# {green}✓ ĐÃ GỬI THÊM{/green}

> **Mã yêu cầu:** ${escapeMarkdown(ticketId)}

Nội dung đã được thêm vào yêu cầu này. Quản trị viên sẽ đọc cùng lúc.`;
}

module.exports = {
    GENERIC_ERROR_MESSAGE,
    formatFeedbackAck,
    formatFeedbackDuplicateAck,
    formatFeedbackFollowUpAck,
    formatFeedbackUsage,
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
