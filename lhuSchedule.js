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
const ACTIVE_LESSON_STATUSES = new Set([0, 4, 5, 10]);

function text(value) {
    return value == null ? "" : String(value).trim();
}

class LhuApiError extends Error {
    constructor(message, userMessage = null, statusCode = null) {
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
                        "Không thể lấy lịch học lúc này. Hệ thống LHU có thể đang tạm thời không phản hồi. Bạn thử lại sau ít phút nhé.",
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
                : new LhuApiError(
                    error.message,
                    "Không thể kết nối với hệ thống lịch LHU lúc này. Bạn thử lại sau ít phút nhé."
                ));
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

function normalizeLesson(lesson = {}) {
    const start = getApiDateTimeInfo(lesson.ThoiGianBD);
    const end = getApiDateTimeInfo(lesson.ThoiGianKT);
    const statusCode = Number(lesson.TinhTrang || 0);
    const calendarType = Number(lesson.CalenType || 1);
    const groupId = text(lesson.NhomID);
    const id = text(lesson.ID);
    const subject = text(lesson.TenMonHoc);
    const group = text(lesson.TenNhom);
    const isExam = calendarType === 2;
    const isHoliday = statusCode === 6;
    const isCancelled = !ACTIVE_LESSON_STATUSES.has(statusCode);
    const statusLabel = isHoliday
        ? "NGHỈ LỄ"
        : isCancelled
            ? "BÁO NGHỈ"
            : isExam
                ? "LỊCH THI"
                : "";
    const lessonTypeCode = lesson.Type == null ? null : Number(lesson.Type);
    const type = isExam
        ? "Thi"
        : lessonTypeCode === 0
            ? "Lý thuyết"
            : lessonTypeCode === 1
                ? "Thực hành"
                : "";

    return {
        raw: lesson,
        id,
        groupId,
        identity: groupId || [subject, group].filter(Boolean).join("|") || id,
        subject,
        start,
        end,
        dateKey: start?.dateKey || "",
        startTime: start ? `${start.hour}:${start.minute}` : "",
        endTime: end ? `${end.hour}:${end.minute}` : "",
        room: text(lesson.TenPhong),
        campus: text(lesson.TenCoSo),
        teacher: text(lesson.GiaoVien),
        group,
        type,
        lessonTypeCode,
        statusCode,
        statusLabel,
        calendarType,
        isExam,
        isHoliday,
        isCancelled,
        isNormal: !isExam && !isCancelled,
        onlineLink: text(lesson.OnlineLink)
    };
}

function lessonStatus(lesson) {
    return normalizeLesson(lesson).statusLabel;
}

function vietnamDateTimeKey(info) {
    return info ? `${info.dateKey}T${info.hour}:${info.minute}:${info.second || "00"}` : "";
}

function isLessonActive(lesson, referenceDate = new Date()) {
    const normalized = normalizeLesson(lesson);
    if (!normalized.isNormal) return false;
    const start = normalized.start;
    const end = normalized.end;
    const current = getVietnamDateInfo(referenceDate);
    const currentKey = vietnamDateTimeKey(current);
    const startKey = vietnamDateTimeKey(start);
    const endKey = vietnamDateTimeKey(end);
    return Boolean(startKey && endKey && startKey <= currentKey && currentKey < endKey);
}

function formatLessonDetails(lesson, options = {}) {
    const normalized = lesson?.raw ? lesson : normalizeLesson(lesson);
    const lines = [];
    if (options.includeTime) {
        const time = normalized.startTime && normalized.endTime
            ? `${normalized.startTime} - ${normalized.endTime}`
            : normalized.startTime;
        if (time) lines.push(`> **Thời gian:** ${escapeMarkdown(time)}`);
    }
    if (options.showStatus !== false && normalized.statusLabel) {
        lines.push(`> **Trạng thái:** {orange}[${escapeMarkdown(normalized.statusLabel)}]{/orange}`);
    }
    if (normalized.room) {
        const location = [normalized.room, normalized.campus].filter(Boolean).join(" - ");
        lines.push(`> **Phòng:** ${escapeMarkdown(location)}`);
    } else if (normalized.campus) {
        lines.push(`> **Cơ sở:** ${escapeMarkdown(normalized.campus)}`);
    }
    if (options.showTeacher !== false && normalized.teacher) {
        lines.push(`> **Giảng viên:** ${escapeMarkdown(normalized.teacher)}`);
    }
    if (options.showGroup !== false && normalized.group) {
        lines.push(`> **Nhóm:** ${escapeMarkdown(normalized.group)}`);
    }
    if (options.showType !== false && normalized.type) {
        lines.push(`> **Hình thức:** ${escapeMarkdown(normalized.type)}`);
    }
    if (options.showOnlineLink !== false && normalized.onlineLink) {
        lines.push(`> **Trực tuyến:** ${escapeMarkdown(normalized.onlineLink)}`);
    }
    return lines;
}

function formatLesson(lesson, index, options = {}) {
    const normalized = lesson?.raw ? lesson : normalizeLesson(lesson);
    const numericIndex = Number.isInteger(index) ? index : 0;
    const subject = normalized.subject || (normalized.isExam ? "Môn thi" : "Buổi học");
    if (options.layout === "notification") {
        const prefix = options.numbered ? `${numericIndex + 1}. ` : "";
        return [
            `**${prefix}${escapeMarkdown(subject)}**`,
            ...formatLessonDetails(normalized, { ...options, includeTime: true, showStatus: false })
        ].join("\n");
    }

    const time = normalized.startTime && normalized.endTime
        ? `${normalized.startTime} - ${normalized.endTime}`
        : normalized.startTime || "Thời gian chưa cập nhật";
    const activeMarker = isLessonActive(normalized.raw, options.referenceDate || new Date()) ? "[ĐANG HỌC] " : "";
    const lines = [
        `**${numericIndex + 1}. ${activeMarker}${escapeMarkdown(time)} · ${escapeMarkdown(subject)}**`,
        ...formatLessonDetails(normalized, options)
    ];
    return lines.join("\n");
}

function formatDailySchedule(scheduleData, date = new Date(), options = {}) {
    const dateInfo = getVietnamDateInfo(date);
    const referenceDateInfo = getVietnamDateInfo(options.referenceDate || date);
    const referenceDate = options.referenceDate || date;
    const isToday = dateInfo.dateKey === referenceDateInfo.dateKey;
    const targetSerial = Date.parse(`${dateInfo.dateKey}T00:00:00.000Z`);
    const referenceSerial = Date.parse(`${referenceDateInfo.dateKey}T00:00:00.000Z`);
    const isTomorrow = targetSerial - referenceSerial === 24 * 60 * 60 * 1000;
    const dayMarker = isToday ? " · [HÔM NAY]" : isTomorrow ? " · [NGÀY MAI]" : "";
    const lessons = lessonsForDate(scheduleData.lessons || [], date);
    const studentName = escapeMarkdown(scheduleData.studentName || "Sinh viên");
    const studentId = escapeMarkdown(scheduleData.studentId);
    const header = [
        `# {green}[NGÀY] ${escapeMarkdown(dateInfo.weekday.toUpperCase())} · ${dateInfo.formattedDate}${dayMarker}{/green}`,
        `**Lịch học của ${studentName}**`,
        `> **MSSV:** ${studentId}`
    ].join("\n");

    if (lessons.length === 0) {
        return `${header}\n\n## {green}${isToday ? "HÔM NAY" : isTomorrow ? "NGÀY MAI" : "NGÀY NÀY"} KHÔNG CÓ LỊCH HỌC{/green}`;
    }
    return `${header}\n\n## {orange}${lessons.length} BUỔI HỌC{/orange}\n${lessons.map((lesson, index) => formatLesson(lesson, index, { referenceDate })).join("\n\n────────────\n\n")}`;
}

function formatWeeklySchedule(scheduleData, date = new Date(), options = {}) {
    const week = getVietnamWeekInfo(date);
    const referenceDate = options.referenceDate || date;
    const todayDateKey = getVietnamDateInfo(referenceDate).dateKey;
    const lessons = lessonsForWeek(scheduleData.lessons || [], date);
    const studentName = escapeMarkdown(scheduleData.studentName || "Sinh viên");
    const studentId = escapeMarkdown(scheduleData.studentId);
    const header = [
        "# {green}[LỊCH HỌC] TUẦN NÀY{/green}",
        `**Sinh viên:** ${studentName}`,
        `> **MSSV:** ${studentId}`,
        `> **Tuần:** ${week.formattedStartDate} – ${week.formattedEndDate}`,
        `> **Tổng cộng:** {orange}${lessons.length} buổi học{/orange}`
    ].join("\n");

    if (lessons.length === 0) {
        return `${header}\n\n## {green}TUẦN NÀY KHÔNG CÓ LỊCH HỌC{/green}`;
    }

    const sections = week.days.map((day) => {
        const dayLessons = lessons.filter(
            (lesson) => getApiDateTimeInfo(lesson.ThoiGianBD)?.dateKey === day.dateKey
        );
        if (dayLessons.length === 0) return null;
        const todayMarker = day.dateKey === todayDateKey ? " · [HÔM NAY]" : "";
        return `# {orange}[NGÀY] ${escapeMarkdown(day.weekday.toUpperCase())} · ${day.formattedDate}${todayMarker}{/orange}\n` +
            dayLessons.map((lesson, index) => formatLesson(lesson, index, { referenceDate })).join("\n\n────────────\n\n");
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
        "# {orange}[LỊCH THI]{/orange}",
        `**Sinh viên:** ${studentName}`,
        `> **MSSV:** ${studentId}`,
        `> **Tổng cộng:** ${exams.length} ca thi`
    ].join("\n");

    if (exams.length === 0) {
        return `${header}\n\n## {green}CHƯA CÓ LỊCH THI TRONG HỌC KỲ NÀY{/green}`;
    }

    const items = exams.map((lesson, index) => {
        const normalized = normalizeLesson(lesson);
        const dateStr = normalized.start
            ? `${normalized.start.weekday ? `${normalized.start.weekday}, ` : ""}${normalized.start.formattedDate}`
            : "Ngày chưa cập nhật";
        const timeStr = normalized.startTime && normalized.endTime
            ? `${normalized.startTime} - ${normalized.endTime}`
            : normalized.startTime || "Chưa cập nhật";
        const location = [normalized.room, normalized.campus].filter(Boolean).join(" - ");

        return [
            `**${index + 1}. ${escapeMarkdown(normalized.subject || "Môn thi")}**`,
            `> **Ngày thi:** ${escapeMarkdown(dateStr)}`,
            `> **Thời gian:** ${escapeMarkdown(timeStr)}`,
            location ? `> **Phòng:** ${escapeMarkdown(location)}` : "",
            normalized.group ? `> **Nhóm:** ${escapeMarkdown(normalized.group)}` : "",
            `> **Hình thức:** Thi`
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
        return `${header}\n\n## {green}TUẦN NÀY KHÔNG CÓ LỊCH DẠY{/green}`;
    }

    const sections = week.days.map((day) => {
        const dayLessons = lessons.filter(
            (lesson) => getApiDateTimeInfo(lesson.ThoiGianBD)?.dateKey === day.dateKey
        );
        if (dayLessons.length === 0) return null;

        const formatted = dayLessons.map((lesson, idx) => {
            const normalized = normalizeLesson(lesson);
            const time = normalized.startTime && normalized.endTime
                ? `${normalized.startTime} - ${normalized.endTime}`
                : normalized.startTime || "Thời gian chưa cập nhật";
            const location = [normalized.room, normalized.campus].filter(Boolean).join(" - ");

            return [
                `**${idx + 1}. ${escapeMarkdown(time)} · ${escapeMarkdown(normalized.subject || "Buổi dạy")}**`,
                normalized.group ? `> **Nhóm:** ${escapeMarkdown(normalized.group)}` : "",
                location ? `> **Phòng:** ${escapeMarkdown(location)}` : ""
            ].filter(Boolean).join("\n");
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

## {orange}PHÒNG TRỐNG GỢI Ý{/orange}
${freeRooms.length > 0 ? freeRooms.map((r) => `- **Phòng ${escapeMarkdown(r)}**`).join("\n") : "Chưa tìm thấy phòng trống phù hợp."}`;
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
    formatLessonDetails,
    formatTeacherSchedule,
    formatWeeklySchedule,
    isLessonActive,
    lessonStatus,
    lessonsForDate,
    lessonsForWeek,
    normalizeLesson,
    normalizeStudentId,
    resolveStudentIdForCommand,
    searchTeacherByName
};
