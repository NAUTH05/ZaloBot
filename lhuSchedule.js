const https = require("https");
const {
    getApiDateTimeInfo,
    getVietnamDateInfo,
    getVietnamWeekInfo,
    toLhuQueryDate
} = require("./timezone");
const { escapeMarkdown } = require("./richText");

const API_URL = "https://tapi.lhu.edu.vn/calen/auth/XemLich_LichSinhVien";
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

class LhuApiError extends Error {
    constructor(message, userMessage = message, statusCode = null) {
        super(message);
        this.name = "LhuApiError";
        this.userMessage = userMessage;
        this.statusCode = statusCode;
    }
}

function normalizeStudentId(value) {
    const studentId = String(value || "").trim();
    return /^\d{9}$/.test(studentId) ? studentId : null;
}

function resolveStudentIdForCommand(argument, savedStudentId) {
    const explicit = String(argument || "").trim();
    return explicit ? normalizeStudentId(explicit) : normalizeStudentId(savedStudentId);
}

function postJson(urlString, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const payload = JSON.stringify(body);
        const request = https.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname + url.search,
            method: "POST",
            timeout: 15000,
            headers: {
                "Authorization": "Bearer ",
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": Buffer.byteLength(payload),
                "Origin": "https://calen.lhu.edu.vn",
                "Referer": "https://calen.lhu.edu.vn/xem-lich-sinh-vien",
                "User-Agent": "ZaloBOT-LHU/1.0"
            }
        }, (response) => {
            let raw = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
                raw += chunk;
                if (raw.length > 10 * 1024 * 1024) {
                    request.destroy(new Error("Phản hồi API LHU quá lớn"));
                }
            });
            response.on("end", () => {
                let parsed;
                try {
                    parsed = raw ? JSON.parse(raw) : {};
                } catch (_) {
                    reject(new LhuApiError("API LHU trả dữ liệu không hợp lệ", undefined, response.statusCode));
                    return;
                }

                if (response.statusCode < 200 || response.statusCode >= 300) {
                    const apiMessage = parsed.Message || parsed.message;
                    reject(new LhuApiError(
                        apiMessage || `API LHU trả mã ${response.statusCode}`,
                        apiMessage || "Không thể truy vấn lịch từ LHU.",
                        response.statusCode
                    ));
                    return;
                }
                resolve(parsed);
            });
        });

        request.on("timeout", () => request.destroy(new Error("API LHU phản hồi quá chậm")));
        request.on("error", (error) => {
            reject(error instanceof LhuApiError
                ? error
                : new LhuApiError(error.message, "Không kết nối được tới hệ thống lịch LHU."));
        });
        request.write(payload);
        request.end();
    });
}

async function fetchStudentSchedule(studentIdInput, date = new Date()) {
    const studentId = normalizeStudentId(studentIdInput);
    if (!studentId) {
        throw new LhuApiError("MSSV không hợp lệ", "MSSV phải gồm đúng 9 chữ số.");
    }

    let studentName = "";
    let semesterStart = null;
    let semesterEnd = null;
    let totalRecords = 0;
    const lessons = [];

    for (let pageIndex = 1; pageIndex <= MAX_PAGES; pageIndex += 1) {
        const response = await postJson(API_URL, {
            StudentID: studentId,
            Ngay: toLhuQueryDate(date),
            PageIndex: pageIndex,
            PageSize: PAGE_SIZE
        });
        const data = response?.data;

        if (!Array.isArray(data) || data.length < 3) {
            throw new LhuApiError(
                "Cấu trúc phản hồi API LHU đã thay đổi",
                "Hệ thống lịch LHU đang trả dữ liệu không đúng định dạng."
            );
        }

        if (pageIndex === 1) {
            studentName = data[0]?.[0]?.HoTen || "";
            const metadata = data[1]?.[0] || {};
            totalRecords = Number(metadata.TotalRecord) || 0;
            semesterStart = metadata.TuanBD || null;
            semesterEnd = metadata.TuanKT || null;
        }

        const pageLessons = Array.isArray(data[2]) ? data[2] : [];
        lessons.push(...pageLessons);
        if (lessons.length >= totalRecords || pageLessons.length < PAGE_SIZE) break;

        if (pageIndex === MAX_PAGES) {
            throw new LhuApiError("Vượt quá số trang cho phép khi tải lịch LHU");
        }
    }

    return { studentId, studentName, semesterStart, semesterEnd, totalRecords, lessons };
}

function lessonsForDate(lessons, date = new Date()) {
    const targetDate = getVietnamDateInfo(date).dateKey;
    return lessons
        .filter((lesson) => getApiDateTimeInfo(lesson.ThoiGianBD)?.dateKey === targetDate)
        .sort((left, right) => {
            const leftTime = getApiDateTimeInfo(left.ThoiGianBD)?.hour + getApiDateTimeInfo(left.ThoiGianBD)?.minute;
            const rightTime = getApiDateTimeInfo(right.ThoiGianBD)?.hour + getApiDateTimeInfo(right.ThoiGianBD)?.minute;
            return String(leftTime).localeCompare(String(rightTime));
        });
}

function lessonsForWeek(lessons, date = new Date()) {
    const week = getVietnamWeekInfo(date);
    return lessons
        .filter((lesson) => {
            const dateKey = getApiDateTimeInfo(lesson.ThoiGianBD)?.dateKey;
            return dateKey && dateKey >= week.startDateKey && dateKey <= week.endDateKey;
        })
        .sort((left, right) => {
            const leftInfo = getApiDateTimeInfo(left.ThoiGianBD);
            const rightInfo = getApiDateTimeInfo(right.ThoiGianBD);
            const leftValue = `${leftInfo?.dateKey || ""}${leftInfo?.hour || ""}${leftInfo?.minute || ""}`;
            const rightValue = `${rightInfo?.dateKey || ""}${rightInfo?.hour || ""}${rightInfo?.minute || ""}`;
            return leftValue.localeCompare(rightValue);
        });
}

function lessonStatus(lesson) {
    const status = Number(lesson.TinhTrang || 0);
    if (status === 6) return "NGHỈ LỄ";
    if (![0, 4, 5, 10].includes(status)) return "BÁO NGHỈ";
    if (Number(lesson.CalenType) === 2) return "LỊCH THI";
    return "";
}

function formatLesson(lesson, index) {
    const start = getApiDateTimeInfo(lesson.ThoiGianBD);
    const end = getApiDateTimeInfo(lesson.ThoiGianKT);
    const time = start && end ? `${start.hour}:${start.minute} - ${end.hour}:${end.minute}` : "Chưa rõ giờ";
    const status = lessonStatus(lesson);
    const type = Number(lesson.Type) === 0 ? "Lý thuyết" : "Thực hành";
    const location = [lesson.TenPhong, lesson.TenCoSo].filter(Boolean).join(" - ");

    const statusColor = status === "BÁO NGHỈ" ? "red" : status === "LỊCH THI" ? "orange" : "green";
    const lines = [
        `**${index + 1}. ${escapeMarkdown(time)} · ${escapeMarkdown(lesson.TenMonHoc || "Chưa rõ môn")}**`
    ];
    if (status) lines.push(`> **Trạng thái:** {${statusColor}}[${escapeMarkdown(status)}]{/${statusColor}}`);
    if (location) lines.push(`> **Phòng:** ${escapeMarkdown(location)}`);
    if (lesson.GiaoVien) lines.push(`> **Giảng viên:** ${escapeMarkdown(lesson.GiaoVien)}`);
    if (lesson.TenNhom) lines.push(`> **Nhóm:** ${escapeMarkdown(lesson.TenNhom)}`);
    if (Number(lesson.CalenType) !== 2) lines.push(`> **Hình thức:** ${escapeMarkdown(type)}`);
    if (lesson.OnlineLink && [0, 4, 5, 10].includes(Number(lesson.TinhTrang || 0))) {
        lines.push(`> **Online:** ${escapeMarkdown(lesson.OnlineLink)}`);
    }
    return lines.join("\n");
}

function formatDailySchedule(scheduleData, date = new Date()) {
    const dateInfo = getVietnamDateInfo(date);
    const lessons = lessonsForDate(scheduleData.lessons || [], date);
    const studentName = escapeMarkdown(scheduleData.studentName || "Sinh viên");
    const studentId = escapeMarkdown(scheduleData.studentId);
    const header = [
        "# {green}[LỊCH] HÔM NAY{/green}",
        `**Sinh viên:** ${studentName}`,
        `> **MSSV:** ${studentId}`,
        `> **Ngày:** ${escapeMarkdown(dateInfo.weekday)}, ${dateInfo.formattedDate}`
    ].join("\n");

    if (lessons.length === 0) {
        return `${header}\n\n{green}[i] Hôm nay không có lịch học.{/green}`;
    }
    return `${header}\n\n## {orange}[${lessons.length} BUỔI HỌC]{/orange}\n${lessons.map(formatLesson).join("\n\n────────────\n\n")}`;
}

function formatWeeklySchedule(scheduleData, date = new Date()) {
    const week = getVietnamWeekInfo(date);
    const lessons = lessonsForWeek(scheduleData.lessons || [], date);
    const studentName = escapeMarkdown(scheduleData.studentName || "Sinh viên");
    const studentId = escapeMarkdown(scheduleData.studentId);
    const header = [
        "# {green}[LỊCH] TUẦN NÀY{/green}",
        `**Sinh viên:** ${studentName}`,
        `> **MSSV:** ${studentId}`,
        `> **Tuần:** ${week.formattedStartDate} – ${week.formattedEndDate}`,
        `{orange}Tổng cộng ${lessons.length} buổi học{/orange}`
    ].join("\n");

    if (lessons.length === 0) {
        return `${header}\n\n{green}[i] Tuần này không có lịch học.{/green}`;
    }

    const sections = week.days.map((day) => {
        const dayLessons = lessons.filter(
            (lesson) => getApiDateTimeInfo(lesson.ThoiGianBD)?.dateKey === day.dateKey
        );
        if (dayLessons.length === 0) return null;
        return `## {orange}[NGÀY] ${escapeMarkdown(day.weekday.toUpperCase())} · ${day.formattedDate}{/orange}\n` +
            dayLessons.map(formatLesson).join("\n\n────────────\n\n");
    }).filter(Boolean);

    return `${header}\n\n${sections.join("\n\n════════════════\n\n")}`;
}

module.exports = {
    API_URL,
    LhuApiError,
    fetchStudentSchedule,
    formatDailySchedule,
    formatLesson,
    formatWeeklySchedule,
    lessonsForDate,
    lessonsForWeek,
    normalizeStudentId,
    resolveStudentIdForCommand
};
