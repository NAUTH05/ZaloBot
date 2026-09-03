const { escapeMarkdown } = require("./richText");

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

function formatGeneralHelp() {
    return `# {green}[BOT] HƯỚNG DẪN{/green}

## {orange}BẮT ĐẦU{/orange}
**/start**
Xem hướng dẫn bắt đầu.

**/find [MSSV]**
Lưu MSSV cho tài khoản hiện tại.

## {orange}LỊCH HỌC{/orange}
**/lich [MSSV]**
Xem lịch học hôm nay.

**/lichtuan [MSSV]**
Xem lịch học trong tuần.

**/lichthi [MSSV]**
Xem lịch thi trong học kỳ.

**/lichgv [Tên giảng viên]**
Xem lịch dạy của giảng viên.

**/phongtrong [Cơ sở]**
Xem gợi ý phòng trống hôm nay.

## {orange}THÔNG BÁO{/orange}
**/dangky [hh:mm]**
Nhận lịch học tự động vào giờ đã chọn.

**/dangky [MSSV] [hh:mm]**
Lưu MSSV và bật nhận lịch trong cùng lệnh.

**/danhsachdangky**
Xem các giờ nhận lịch đã lưu.

**/suadangky #ID [hh:mm]**
Đổi một giờ nhận lịch.

**/xoadangky #ID**
Xóa một giờ nhận lịch.

**/huythongbao**
Tắt nhận lịch học tự động.

**/batnhaclich**
Bật nhắc giờ bắt đầu tiết học.

**/tatnhaclich**
Tắt nhắc giờ bắt đầu tiết học.

**/trangthainhaclich**
Xem trạng thái nhắc giờ học.

## {orange}TIỆN ÍCH{/orange}
**/ai [Câu hỏi]**
Hỏi trợ lý AI về lịch học đã lưu.

**/lichtruc** · **/danhsachlichtruc**
Xem lịch trực nhật phòng 411.

**/dangkylich** · **/huydangkylich**
Bật hoặc tắt thông báo lịch trực nhật.

**/sinhnhat [Câu hỏi]**
Gửi câu hỏi trong ngày 27/08.

**/time** · **/myid** · **/help411** · **/help**
Xem giờ hệ thống, ID tài khoản hoặc các hướng dẫn.`;
}

function formatDutyHelp() {
    return `# {green}[PHÒNG 411] HƯỚNG DẪN{/green}

**/lichtruc**
Xem phân công trực nhật hôm nay.

**/danhsachlichtruc**
Xem toàn bộ danh sách phân công.

**/dangkylich**
Nhận lịch trực nhật lúc 06:00 hằng ngày.

**/huydangkylich**
Tắt thông báo lịch trực nhật.`;
}

function formatAdminHelp() {
    return `${formatGeneralHelp()}

${formatDutyHelp()}

# {orange}[ADMIN] LỆNH QUẢN TRỊ{/orange}

## {orange}PHÂN QUYỀN{/orange}
**/blockbot** · **/unblockbot** · **/blockai** · **/unblockai**
Chặn hoặc mở lại quyền sử dụng.

**/allowbot** · **/unallowbot** · **/allowai** · **/unallowai**
Quản lý allowlist.

**/accessmode** · **/accesslist**
Đổi chế độ và xem danh sách truy cập.

## {orange}CHAT VÀ THÔNG BÁO{/orange}
**/quanlychat** · **/thongtinch**
Kiểm tra trạng thái chat và lỗi gửi.

**/vohieuchat** · **/kichhoatchat** · **/thuchatchat** · **/xoachat**
Quản lý vòng đời chat.

**/chatfeature** · **/thongbao**
Điều khiển tính năng hoặc gửi thông báo chung.

## {orange}LỊCH TRỰC VÀ HỎI ĐÁP{/orange}
**/themlichtruc** · **/sualichtruc** · **/xoalichtruc**
Quản lý phân công trực nhật phòng 411.

**/danhsach** · **/them** · **/sua** · **/xoa** · **/traloi** · **/congbo**
Quản lý hỏi đáp sinh nhật.

## {orange}KIỂM TRA HỆ THỐNG{/orange}
**/test6h** · **/test6hlichtruc** · **/helpadmin**
Chạy kiểm tra gửi và xem hướng dẫn quản trị.`;
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
    formatDutyHelp,
    formatErrorMessage,
    formatGeneralHelp,
    formatMissingStudentIdMessage,
    formatStudentSavedMessage,
    formatSuccessMessage,
    formatWarningMessage,
    formatWelcomeMessage,
    userMessageForError
};
