const test = require("node:test");
const assert = require("node:assert/strict");
const {
    formatDailySchedule,
    formatLesson,
    formatScheduleWeeks,
    formatWeeklySchedule,
    isLessonActive,
    lessonsForDate,
    lessonsForWeek,
    normalizeStudentId,
    resolveStudentIdForCommand
} = require("../lhuSchedule");
const {
    getApiDateTimeInfo,
    getVietnamDateInfo,
    getVietnamWeekInfo,
    toLhuQueryDate
} = require("../timezone");
const { escapeMarkdown, escapeMarkdownMultiline, sanitizeExternalRichText } = require("../richText");
const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

test("chuẩn hóa ngày Việt Nam tại ranh giới UTC", () => {
    const date = new Date("2026-08-08T17:00:00.000Z");
    const info = getVietnamDateInfo(date);
    assert.equal(info.dateKey, "2026-08-09");
    assert.equal(info.hour, "00");
    assert.equal(toLhuQueryDate(date), "2026-08-09T05:00:00.000Z");
});

test("coi thời gian không offset của LHU là giờ Việt Nam", () => {
    const info = getApiDateTimeInfo("2026-08-09T07:00:00");
    assert.equal(info.dateKey, "2026-08-09");
    assert.equal(info.hour, "07");
});

test("lọc và sắp xếp lịch đúng ngày", () => {
    const lessons = [
        { ThoiGianBD: "2026-08-09T13:00:00" },
        { ThoiGianBD: "2026-08-10T07:00:00" },
        { ThoiGianBD: "2026-08-09T07:00:00" }
    ];
    const result = lessonsForDate(lessons, new Date("2026-08-09T05:00:00Z"));
    assert.equal(result.length, 2);
    assert.equal(result[0].ThoiGianBD, "2026-08-09T07:00:00");
});

test("xác định tuần Việt Nam từ Thứ Hai đến Chủ nhật", () => {
    const week = getVietnamWeekInfo(new Date("2026-08-09T05:00:00Z"));
    assert.equal(week.startDateKey, "2026-08-03");
    assert.equal(week.endDateKey, "2026-08-09");
    assert.equal(week.days.length, 7);
    assert.equal(week.days[0].weekday, "Thứ Hai");
    assert.equal(week.days[6].weekday, "Chủ nhật");
});

test("lọc lịch đúng tuần và sắp xếp theo ngày giờ", () => {
    const lessons = [
        { ThoiGianBD: "2026-08-09T13:00:00" },
        { ThoiGianBD: "2026-08-10T07:00:00" },
        { ThoiGianBD: "2026-08-03T07:00:00" },
        { ThoiGianBD: "2026-08-02T07:00:00" }
    ];
    const result = lessonsForWeek(lessons, new Date("2026-08-09T05:00:00Z"));
    assert.equal(result.length, 2);
    assert.equal(result[0].ThoiGianBD, "2026-08-03T07:00:00");
    assert.equal(result[1].ThoiGianBD, "2026-08-09T13:00:00");
});

test("định dạng tin nhắn lịch học", () => {
    const data = {
        studentId: "123456789",
        studentName: "Nguyễn Văn A",
        lessons: [{
            ThoiGianBD: "2026-08-09T07:00:00",
            ThoiGianKT: "2026-08-09T09:15:00",
            TenMonHoc: "Lập trình Web",
            TenPhong: "A101",
            TenCoSo: "Cơ sở 1",
            GiaoVien: "Trần Văn B",
            TenNhom: "22CT111",
            Type: 0,
            TinhTrang: 0
        }]
    };
    const message = formatDailySchedule(data, new Date("2026-08-09T05:00:00Z"));
    assert.match(message, /^# \{green\}\[NGÀY\] CHỦ NHẬT · 09\/08\/2026 · \[HÔM NAY\]\{\/green\}/);
    assert.match(message, /\{orange\}1 BUỔI HỌC\{\/orange\}/);
    assert.doesNotMatch(message, EMOJI_PATTERN);
    assert.match(message, /Lập trình Web/);
    assert.match(message, /07:00 - 09:15/);
    assert.match(message, /Nguyễn Văn A/);
});

test("định dạng và nhóm lịch học cả tuần", () => {
    const data = {
        studentId: "123456789",
        studentName: "Nguyễn Văn A",
        lessons: [
            {
                ThoiGianBD: "2026-08-03T07:00:00",
                ThoiGianKT: "2026-08-03T09:15:00",
                TenMonHoc: "Lập trình Web",
                TenPhong: "A101",
                Type: 0,
                TinhTrang: 0
            },
            {
                ThoiGianBD: "2026-08-09T13:00:00",
                ThoiGianKT: "2026-08-09T15:15:00",
                TenMonHoc: "Cơ sở dữ liệu",
                TenPhong: "B202",
                Type: 1,
                TinhTrang: 0
            }
        ]
    };
    const message = formatWeeklySchedule(data, new Date("2026-08-09T05:00:00Z"));
    assert.match(message, /^# \{green\}\[LỊCH HỌC\] TUẦN NÀY\{\/green\}/);
    assert.match(message, /03\/08\/2026 – 09\/08\/2026/);
    assert.match(message, /\{orange\}2 buổi học\{\/orange\}/);
    assert.match(message, /THỨ HAI/);
    assert.match(message, /CHỦ NHẬT/);
    assert.match(message, /Lập trình Web/);
    assert.match(message, /Cơ sở dữ liệu/);
    assert.doesNotMatch(message, EMOJI_PATTERN);
});

test("lịch tuần chỉ đánh dấu đúng ngày hôm nay theo giờ Việt Nam qua ranh giới năm", () => {
    const data = {
        studentId: "123456789",
        studentName: "Nguyễn Văn A",
        lessons: [
            {
                ThoiGianBD: "2026-12-31T07:00:00",
                ThoiGianKT: "2026-12-31T09:00:00",
                TenMonHoc: "Môn cuối năm",
                TinhTrang: 0
            },
            {
                ThoiGianBD: "2027-01-01T07:00:00",
                ThoiGianKT: "2027-01-01T09:00:00",
                TenMonHoc: "Môn đầu năm",
                TinhTrang: 0
            }
        ]
    };
    const referenceDate = new Date("2026-12-31T17:30:00.000Z");
    const message = formatWeeklySchedule(data, referenceDate, { referenceDate });

    assert.match(message, /28\/12\/2026 – 03\/01\/2027/);
    assert.match(message, /01\/01\/2027 · \[HÔM NAY\]/);
    assert.doesNotMatch(message, /31\/12\/2026 · \[HÔM NAY\]/);
    assert.equal((message.match(/\[HÔM NAY\]/g) || []).length, 1);
});

test("xác định lớp đang học đúng các mốc bắt đầu và kết thúc", () => {
    const lesson = {
        ThoiGianBD: "2026-09-01T12:50:00",
        ThoiGianKT: "2026-09-01T16:45:00",
        TenMonHoc: "Phát triển ứng dụng",
        TinhTrang: 0,
        CalenType: 1
    };

    assert.equal(isLessonActive(lesson, new Date("2026-09-01T05:49:59.000Z")), false);
    assert.equal(isLessonActive(lesson, new Date("2026-09-01T05:50:00.000Z")), true);
    assert.equal(isLessonActive(lesson, new Date("2026-09-01T07:00:00.000Z")), true);
    assert.equal(isLessonActive(lesson, new Date("2026-09-01T09:45:00.000Z")), false);
    assert.equal(isLessonActive(lesson, new Date("2026-09-01T10:00:00.000Z")), false);
    assert.equal(isLessonActive({ ...lesson, TinhTrang: 1 }, new Date("2026-09-01T07:00:00.000Z")), false);
    assert.equal(isLessonActive({ ...lesson, CalenType: 2 }, new Date("2026-09-01T07:00:00.000Z")), false);
});

test("lịch sinh viên hiển thị ĐANG HỌC nhưng lịch ngoài giờ thì không", () => {
    const data = {
        studentId: "123456789",
        studentName: "Nguyễn Văn A",
        lessons: [{
            ThoiGianBD: "2026-09-01T12:50:00",
            ThoiGianKT: "2026-09-01T16:45:00",
            TenMonHoc: "Phát triển ứng dụng",
            TinhTrang: 0,
            CalenType: 1
        }]
    };
    const active = formatDailySchedule(data, new Date("2026-09-01T07:00:00.000Z"));
    const ended = formatDailySchedule(data, new Date("2026-09-01T10:00:00.000Z"));
    assert.match(active, /\[ĐANG HỌC\] 12:50 - 16:45/);
    assert.doesNotMatch(ended, /\[ĐANG HỌC\]/);
});

test("các lớp trùng giờ đều được đánh dấu đang học nhất quán", () => {
    const referenceDate = new Date("2026-09-01T07:00:00.000Z");
    const message = formatDailySchedule({
        studentId: "123456789",
        studentName: "Nguyễn Văn A",
        lessons: [
            {
                ThoiGianBD: "2026-09-01T12:50:00",
                ThoiGianKT: "2026-09-01T16:45:00",
                TenMonHoc: "Môn A",
                TinhTrang: 0
            },
            {
                ThoiGianBD: "2026-09-01T13:30:00",
                ThoiGianKT: "2026-09-01T15:00:00",
                TenMonHoc: "Môn B",
                TinhTrang: 0
            }
        ]
    }, referenceDate);
    assert.equal((message.match(/\[ĐANG HỌC\]/g) || []).length, 2);
});

test("escape dữ liệu động để không làm vỡ Markdown của Zalo", () => {
    assert.equal(escapeMarkdown("Nguyễn *A* [K24]"), "Nguyễn \\*A\\* [K24]");

    const message = formatDailySchedule({
        studentId: "123456789",
        studentName: "Nguyễn *A* [K24]",
        lessons: [{
            ThoiGianBD: "2026-08-09T07:00:00",
            ThoiGianKT: "2026-08-09T09:15:00",
            TenMonHoc: "C# [Nâng cao]",
            TenPhong: "A_101",
            Type: 0,
            TinhTrang: 0
        }]
    }, new Date("2026-08-09T05:00:00Z"));

    assert.match(message, /Nguyễn \\\*A\\\* \[K24\]/);
    assert.match(message, /C# \[Nâng cao\]/);
    assert.match(message, /A\\_101/);

    assert.equal(escapeMarkdown("Dòng 1\n> Dòng 2"), "Dòng 1 \\> Dòng 2");
    assert.equal(escapeMarkdownMultiline("Dòng 1\n> Dòng 2"), "Dòng 1\n\\> Dòng 2");
    assert.equal(sanitizeExternalRichText("**Nội dung** {green}x{/green}"), "**Nội dung** (green)x(/green)");
});

test("lịch trống vẫn là một tin rich text", () => {
    const data = { studentId: "123456789", studentName: "Nguyễn Văn A", lessons: [] };
    const daily = formatDailySchedule(data, new Date("2026-08-09T05:00:00Z"));
    const weekly = formatWeeklySchedule(data, new Date("2026-08-09T05:00:00Z"));

    assert.match(daily, /^# \{green\}/);
    assert.match(daily, /\{green\}HÔM NAY KHÔNG CÓ LỊCH HỌC\{\/green\}/);
    assert.match(weekly, /^# \{green\}/);
    assert.match(weekly, /\{green\}TUẦN NÀY KHÔNG CÓ LỊCH HỌC\{\/green\}/);
    assert.doesNotMatch(daily, EMOJI_PATTERN);
    assert.doesNotMatch(weekly, EMOJI_PATTERN);
});

test("lịch gửi buổi tối đánh dấu rõ ngày mai", () => {
    const targetDate = new Date("2026-09-01T22:00:00.000Z");
    const referenceDate = new Date("2026-09-01T13:00:00.000Z");
    const message = formatDailySchedule({
        studentId: "123456789",
        studentName: "Nguyễn Văn A",
        lessons: []
    }, targetDate, { referenceDate });

    assert.match(message, /02\/09\/2026 · \[NGÀY MAI\]/);
    assert.match(message, /NGÀY MAI KHÔNG CÓ LỊCH HỌC/);
});

test("kiểm tra định dạng MSSV", () => {
    assert.equal(normalizeStudentId(" 123456789 "), "123456789");
    assert.equal(normalizeStudentId("123"), null);
    assert.equal(normalizeStudentId("D05403126"), null);
});

test("MSSV truyền trực tiếp cho /lich luôn ưu tiên hơn MSSV đã lưu", () => {
    assert.equal(resolveStudentIdForCommand("123000135", "123000536"), "123000135");
    assert.equal(resolveStudentIdForCommand("", "123000536"), "123000536");
    assert.equal(resolveStudentIdForCommand("khong-hop-le", "123000536"), null);
});

test("định dạng lịch thi và danh sách phòng trống", () => {
    const { formatExamSchedule, findEmptyRooms } = require("../lhuSchedule");
    const examData = {
        studentId: "123456789",
        studentName: "Nguyễn Văn A",
        examLessons: [{
            ThoiGianBD: "2026-08-20T07:30:00",
            ThoiGianKT: "2026-08-20T09:30:00",
            TenMonHoc: "Cơ sở dữ liệu",
            TenPhong: "A101",
            TenCoSo: "Cơ sở I",
            CalenType: 2
        }]
    };

    const examMsg = formatExamSchedule(examData);
    assert.match(examMsg, /\[LỊCH THI\]/);
    assert.match(examMsg, /Thứ Năm, 20\/08\/2026/);
    assert.match(examMsg, /Cơ sở dữ liệu/);

    const emptyRoomsMsg = findEmptyRooms("Cơ sở I", { lessons: [] }, new Date("2026-08-17T00:00:00Z"));
    assert.match(emptyRoomsMsg, /PHÒNG TRỐNG/);
    assert.match(emptyRoomsMsg, /A101/);
});

test("formatter dùng cùng thuật ngữ và trường dữ liệu cho lịch học", () => {
    const message = formatLesson({
        ThoiGianBD: "2026-09-01T12:50:00",
        ThoiGianKT: "2026-09-01T16:45:00",
        TenMonHoc: "Phát triển ứng dụng",
        TenPhong: "B301_Ecommerce LAB",
        TenCoSo: "Cơ sở I",
        GiaoVien: "Nguyễn Minh Phúc",
        TenNhom: "23CT113",
        Type: 0,
        TinhTrang: 0,
        OnlineLink: "https://meet.example.edu/class"
    }, 0, { referenceDate: new Date("2026-09-01T05:50:00.000Z") });

    assert.match(message, /\[ĐANG HỌC\] 12:50 - 16:45 · Phát triển ứng dụng/);
    assert.match(message, /Phòng:\*\* B301\\_Ecommerce LAB - Cơ sở I/);
    assert.match(message, /Giảng viên:\*\* Nguyễn Minh Phúc/);
    assert.match(message, /Nhóm:\*\* 23CT113/);
    assert.match(message, /Hình thức:\*\* Lý thuyết/);
    assert.match(message, /Trực tuyến:\*\* https:\/\/meet\.example\.edu\/class/);
});

test("formatter hiển thị trạng thái hủy và lịch thi, đồng thời bỏ qua trường tùy chọn bị thiếu", () => {
    const cancelled = formatLesson({
        ThoiGianBD: "2026-09-01T07:00:00",
        ThoiGianKT: "2026-09-01T09:00:00",
        TenMonHoc: "Môn đã hủy",
        TinhTrang: 1
    }, 0);
    const exam = formatLesson({
        ThoiGianBD: "2026-09-02T07:00:00",
        ThoiGianKT: "2026-09-02T09:00:00",
        TenMonHoc: "Môn thi",
        TinhTrang: 0,
        CalenType: 2
    }, 0);

    assert.match(cancelled, /Trạng thái:\*\* \{orange\}\[BÁO NGHỈ\]/);
    assert.doesNotMatch(cancelled, /Phòng:|Giảng viên:|Nhóm:|Hình thức:|Trực tuyến:/);
    assert.match(exam, /Trạng thái:\*\* \{orange\}\[LỊCH THI\]/);
    assert.match(exam, /Hình thức:\*\* Thi/);
});

/* -------------------------------------------------------------------------- */
/* Lịch nhiều tuần                                                             */
/* -------------------------------------------------------------------------- */

const MULTI_WEEK_DATA = {
    studentId: "123456789",
    studentName: "Nguyễn Văn A",
    lessons: [
        { ThoiGianBD: "2026-11-12T07:00:00", TenMonHoc: "Toán", TenPhong: "A101", Type: 0, TinhTrang: 0 },
        { ThoiGianBD: "2026-11-19T07:00:00", TenMonHoc: "Lý", TenPhong: "A102", Type: 0, TinhTrang: 0 },
        { ThoiGianBD: "2026-11-26T07:00:00", TenMonHoc: "Hoá", TenPhong: "A103", Type: 0, TinhTrang: 0 }
    ]
};

// 11/11/2026 là Thứ Tư ⇒ tuần này 09/11 – 15/11.
const MULTI_WEEK_REFERENCE = new Date("2026-11-11T05:00:00Z");

test("tuần sau có nhãn riêng và đúng khoảng ngày", () => {
    const message = formatWeeklySchedule(MULTI_WEEK_DATA, MULTI_WEEK_REFERENCE, { weekOffset: 1 });

    assert.match(message, /^# \{green\}\[LỊCH HỌC\] TUẦN SAU\{\/green\}/);
    assert.match(message, /16\/11\/2026 – 22\/11\/2026/);
    assert.match(message, /· Lý\*\*/);
    assert.doesNotMatch(message, /· Toán\*\*/, "không được lẫn buổi của tuần này");
});

test("tuần trống vẫn trả lời rõ là không có lịch, không im lặng", () => {
    const message = formatWeeklySchedule(MULTI_WEEK_DATA, MULTI_WEEK_REFERENCE, { weekOffset: 3 });

    assert.match(message, /TUẦN THỨ 4/);
    assert.match(message, /TUẦN THỨ 4 KHÔNG CÓ LỊCH HỌC/);
});

test("xem 3 tuần trả về 3 tin, mỗi tuần một tin đúng thứ tự", () => {
    const messages = formatScheduleWeeks(MULTI_WEEK_DATA, {
        referenceDate: MULTI_WEEK_REFERENCE,
        startOffset: 0,
        weeks: 3
    });

    assert.equal(messages.length, 3);
    assert.match(messages[0], /TUẦN NÀY/);
    assert.match(messages[0], /09\/11\/2026 – 15\/11\/2026/);
    assert.match(messages[1], /TUẦN SAU/);
    assert.match(messages[2], /TUẦN SAU NỮA/);
    // Mỗi tin chỉ chứa buổi của tuần đó.
    assert.match(messages[0], /Toán/);
    assert.doesNotMatch(messages[0], /· Lý\*\*/, "không được lẫn môn của tuần sau");
    assert.match(messages[2], /Hoá/);
});

test("bắt đầu từ tuần sau thì không lẫn tuần này", () => {
    const messages = formatScheduleWeeks(MULTI_WEEK_DATA, {
        referenceDate: MULTI_WEEK_REFERENCE,
        startOffset: 1,
        weeks: 2
    });

    assert.equal(messages.length, 2);
    assert.match(messages[0], /TUẦN SAU/);
    assert.match(messages[1], /TUẦN SAU NỮA/);
    assert.doesNotMatch(messages.join("\n"), /Toán/);
});

test("tuần trống bị bỏ khỏi chuỗi nhiều tuần nhưng khoảng ngày vẫn rõ", () => {
    const messages = formatScheduleWeeks(MULTI_WEEK_DATA, {
        referenceDate: MULTI_WEEK_REFERENCE,
        startOffset: 0,
        weeks: 2
    });

    assert.equal(messages.length, 2, "tuần 3 trống nên không sinh tin thứ ba");
    assert.match(messages[1], /16\/11\/2026 – 22\/11\/2026/);
});

test("cả khoảng đều trống thì trả một tin tổng hợp, không phải N tin rỗng", () => {
    const messages = formatScheduleWeeks(MULTI_WEEK_DATA, {
        referenceDate: MULTI_WEEK_REFERENCE,
        startOffset: 5,
        weeks: 3
    });

    assert.equal(messages.length, 1);
    assert.match(messages[0], /\[LỊCH HỌC\] 3 TUẦN/);
    assert.match(messages[0], /KHÔNG CÓ LỊCH HỌC/);
    assert.match(messages[0], /14\/12\/2026 – 03\/01\/2027/);
});

test("số tuần vượt trần bị cắt, không sinh vô số tin", () => {
    const messages = formatScheduleWeeks(MULTI_WEEK_DATA, {
        referenceDate: MULTI_WEEK_REFERENCE,
        startOffset: 0,
        weeks: 99
    });

    // 3 tuần có buổi học + 1 tin ghi các tuần còn lại (bị cắt ở trần 6 tuần).
    assert.equal(messages.length, 4);
    assert.match(messages[3], /TUẦN KHÔNG CÓ LỊCH/);
    assert.equal((messages[3].match(/^- /gm) || []).length, 3);
});

test("tuần trống trong chuỗi nhiều tuần được nêu tên, không im lặng bỏ qua", () => {
    // 3 tuần có buổi học, tuần thứ 4 (30/11 – 06/12) trống.
    const messages = formatScheduleWeeks(MULTI_WEEK_DATA, {
        referenceDate: MULTI_WEEK_REFERENCE,
        startOffset: 0,
        weeks: 4
    });

    assert.equal(messages.length, 4);
    assert.match(messages[3], /TUẦN KHÔNG CÓ LỊCH/);
    assert.match(messages[3], /30\/11\/2026 – 06\/12\/2026/);
});
