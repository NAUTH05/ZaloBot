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
            const chunks = [];
            let totalBytes = 0;
            response.on("data", (chunk) => {
                chunks.push(chunk);
                totalBytes += chunk.length;
                if (totalBytes > 10 * 1024 * 1024) {
                    request.destroy(new Error("Phản hồi API LHU quá lớn"));
                }
            });
            response.on("end", () => {
                let parsed;
                try {
                    const raw = Buffer.concat(chunks).toString("utf8");
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
        `> **Tổng cộng:** {orange}${lessons.length} buổi học{/orange}`
    ].join("\n");

    if (lessons.length === 0) {
        return `${header}\n\n{green}[i] Tuần này không có lịch học.{/green}`;
    }

    const sections = week.days.map((day) => {
        const dayLessons = lessons.filter(
            (lesson) => getApiDateTimeInfo(lesson.ThoiGianBD)?.dateKey === day.dateKey
        );
        if (dayLessons.length === 0) return null;
        return `# {orange}[NGÀY] ${escapeMarkdown(day.weekday.toUpperCase())} · ${day.formattedDate}{/orange}\n` +
            dayLessons.map(formatLesson).join("\n\n────────────\n\n");
    }).filter(Boolean);

    return `${header}\n\n${sections.join("\n\n════════════════\n\n")}`;
}

async function fetchExamSchedule(studentIdInput, date = new Date()) {
    const studentData = await fetchStudentSchedule(studentIdInput, date);
    const examLessons = (studentData.lessons || []).filter((l) => Number(l.CalenType) === 2);
    return { ...studentData, examLessons };
}

async function searchTeacherByName(teacherNameInput) {
    const query = String(teacherNameInput || "").trim();
    if (!query) return [];

    const response = await postJson("https://tapi.lhu.edu.vn/calen/auth/XemLich_GiaoVienSelectByName", { Name: query });
    const rawList = response?.data || [];
    const list = Array.isArray(rawList) ? rawList : (Array.isArray(rawList[0]) ? rawList[0] : []);

    return list.map((item) => ({
        teacherId: String(item.GiaoVienID || item.ID || item.MaGV || "").trim(),
        fullName: [item.Ho, item.Ten].filter(Boolean).join(" ") || item.TenGiaoVien || query,
        faculty: item.TenKhoa || item.Khoa || ""
    })).filter((t) => t.teacherId);
}

async function fetchTeacherSchedule(teacherIdInput, date = new Date()) {
    const teacherId = String(teacherIdInput || "").trim();
    if (!teacherId) {
        throw new LhuApiError("Mã giảng viên không hợp lệ");
    }

    const lessons = [];
    let totalRecords = 0;

    for (let pageIndex = 1; pageIndex <= MAX_PAGES; pageIndex += 1) {
        const response = await postJson("https://tapi.lhu.edu.vn/calen/auth/XemLich_LichGiaoVien", {
            GiaoVienID: teacherId,
            Ngay: toLhuQueryDate(date),
            PageIndex: pageIndex,
            PageSize: PAGE_SIZE
        });

        const data = response?.data;
        if (!Array.isArray(data) || data.length < 2) {
            throw new LhuApiError("Cấu trúc lịch giảng viên không khớp");
        }

        if (pageIndex === 1) {
            totalRecords = Number(data[0]?.[0]?.TotalRecord) || 0;
        }

        const pageLessons = Array.isArray(data[1]) ? data[1] : [];
        lessons.push(...pageLessons);

        if (lessons.length >= totalRecords || pageLessons.length < PAGE_SIZE) break;
    }

    const teacherName = lessons[0]?.GiaoVien || teacherId;
    return { teacherId, teacherName, lessons };
}

function formatExamSchedule(examData) {
    const exams = examData.examLessons || [];
    const studentName = escapeMarkdown(examData.studentName || "Sinh viên");
    const studentId = escapeMarkdown(examData.studentId);

    const header = [
        "# {orange}[LỊCH THI] DANH SÁCH MÔN THI{/orange}",
        `**Sinh viên:** ${studentName}`,
        `> **MSSV:** ${studentId}`,
        `{green}Tổng cộng ${exams.length} ca thi{/green}`
    ].join("\n");

    if (exams.length === 0) {
        return `${header}\n\n{green}[i] Không có lịch thi trong học kỳ này.{/green}`;
    }

    const items = exams.map((lesson, index) => {
        const start = getApiDateTimeInfo(lesson.ThoiGianBD);
        const end = getApiDateTimeInfo(lesson.ThoiGianKT);
        const dateStr = start ? start.formattedDate : "Chưa rõ ngày";
        const timeStr = start && end ? `${start.hour}:${start.minute} - ${end.hour}:${end.minute}` : "Chưa rõ giờ";
        const location = [lesson.TenPhong, lesson.TenCoSo].filter(Boolean).join(" - ") || "Chưa xếp phòng";

        return [
            `**${index + 1}. ${escapeMarkdown(lesson.TenMonHoc || "Môn thi")}**`,
            `> **Ngày thi:** ${escapeMarkdown(dateStr)}`,
            `> **Giờ thi:** ${escapeMarkdown(timeStr)}`,
            `> **Phòng thi:** ${escapeMarkdown(location)}`,
            lesson.TenNhom ? `> **Nhóm/Lớp:** ${escapeMarkdown(lesson.TenNhom)}` : "",
            `> **Hình thức:** {orange}[LỊCH THI]{/orange}`
        ].filter(Boolean).join("\n");
    });

    return `${header}\n\n${items.join("\n\n────────────\n\n")}`;
}

function formatTeacherSchedule(scheduleData, date = new Date()) {
    const week = getVietnamWeekInfo(date);
    const lessons = lessonsForWeek(scheduleData.lessons || [], date);
    const teacherName = escapeMarkdown(scheduleData.teacherName || "Giảng viên");

    const header = [
        "# {green}[GIẢNG VIÊN] LỊCH DẠY TUẦN NÀY{/green}",
        `**Giảng viên:** ${teacherName}`,
        `> **Tuần:** ${week.formattedStartDate} – ${week.formattedEndDate}`,
        `{orange}Tổng cộng ${lessons.length} buổi dạy{/orange}`
    ].join("\n");

    if (lessons.length === 0) {
        return `${header}\n\n{green}[i] Tuần này giảng viên không có lịch dạy.{/green}`;
    }

    const sections = week.days.map((day) => {
        const dayLessons = lessons.filter(
            (lesson) => getApiDateTimeInfo(lesson.ThoiGianBD)?.dateKey === day.dateKey
        );
        if (dayLessons.length === 0) return null;

        const formatted = dayLessons.map((lesson, idx) => {
            const start = getApiDateTimeInfo(lesson.ThoiGianBD);
            const end = getApiDateTimeInfo(lesson.ThoiGianKT);
            const time = start && end ? `${start.hour}:${start.minute} - ${end.hour}:${end.minute}` : "Chưa rõ giờ";
            const location = [lesson.TenPhong, lesson.TenCoSo].filter(Boolean).join(" - ");

            return [
                `**${idx + 1}. ${escapeMarkdown(time)} · ${escapeMarkdown(lesson.TenMonHoc || "Lớp học")}**`,
                `> **Nhóm/Lớp:** ${escapeMarkdown(lesson.TenNhom || "Chưa rõ")}`,
                `> **Phòng:** ${escapeMarkdown(location || "Chưa rõ")}`
            ].join("\n");
        }).join("\n\n────────────\n\n");

        return `# {orange}[NGÀY] ${escapeMarkdown(day.weekday.toUpperCase())} · ${day.formattedDate}{/orange}\n${formatted}`;
    }).filter(Boolean);

    return `${header}\n\n${sections.join("\n\n════════════════\n\n")}`;
}

function findEmptyRooms(campusInput, scheduleData, date = new Date()) {
    const campusName = String(campusInput || "").trim() || "Cơ sở I";
    const dateInfo = getVietnamDateInfo(date);

    // Lọc tất cả các phòng đang có ca học tại cơ sở này trong ngày
    const dayLessons = lessonsForDate(scheduleData?.lessons || [], date)
        .filter((l) => (l.TenCoSo || "").toLowerCase().includes(campusName.toLowerCase()));

    const occupiedRooms = new Set(dayLessons.map((l) => l.TenPhong).filter(Boolean));

    const knownRooms = [
        "A101", "A102", "A201", "A202", "B101", "B102", "B201", "B202",
        "C401_PM08", "C402_PM07", "C501_PM10", "C502_PM09", "D401_Hybrid", "D502", "G308"
    ];

    const freeRooms = knownRooms.filter((r) => !occupiedRooms.has(r));

    return `# {green}[PHÒNG TRỐNG] ${escapeMarkdown(campusName.toUpperCase())}{/green}

> **Ngày:** ${dateInfo.weekday}, ${dateInfo.formattedDate}
> **Các phòng đang sử dụng ca học (${occupiedRooms.size}):** ${[...occupiedRooms].map(escapeMarkdown).join(", ") || "Không có"}

## {orange}DANH SÁCH PHÒNG TRỐNG GỢI Ý CÓ THỂ TỰ HỌC / HỌP NHÓM:{/orange}
${freeRooms.length > 0 ? freeRooms.map((r) => `- **Phòng ${escapeMarkdown(r)}**`).join("\n") : "_Không tìm thấy phòng trống khả dụng_"}`;
}

module.exports = {
    API_URL,
    LhuApiError,
    fetchExamSchedule,
    fetchStudentSchedule,
    fetchTeacherSchedule,
    findEmptyRooms,
    formatDailySchedule,
    formatExamSchedule,
    formatLesson,
    formatTeacherSchedule,
    formatWeeklySchedule,
    lessonsForDate,
    lessonsForWeek,
    normalizeStudentId,
    resolveStudentIdForCommand,
    searchTeacherByName
};
