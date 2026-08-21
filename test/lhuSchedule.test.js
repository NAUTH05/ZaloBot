const test = require("node:test");
const assert = require("node:assert/strict");
const {
    formatDailySchedule,
    formatWeeklySchedule,
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
const { escapeMarkdown } = require("../richText");
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
    assert.match(message, /^# \{green\}\[LỊCH\] HÔM NAY\{\/green\}/);
    assert.match(message, /\{orange\}\[1 BUỔI HỌC\]\{\/orange\}/);
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
    assert.match(message, /^# \{green\}\[LỊCH\] TUẦN NÀY\{\/green\}/);
    assert.match(message, /03\/08\/2026 – 09\/08\/2026/);
    assert.match(message, /\{orange\}2 buổi học\{\/orange\}/);
    assert.match(message, /THỨ HAI/);
    assert.match(message, /CHỦ NHẬT/);
    assert.match(message, /Lập trình Web/);
    assert.match(message, /Cơ sở dữ liệu/);
    assert.doesNotMatch(message, EMOJI_PATTERN);
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
});

test("lịch trống vẫn là một tin rich text", () => {
    const data = { studentId: "123456789", studentName: "Nguyễn Văn A", lessons: [] };
    const daily = formatDailySchedule(data, new Date("2026-08-09T05:00:00Z"));
    const weekly = formatWeeklySchedule(data, new Date("2026-08-09T05:00:00Z"));

    assert.match(daily, /^# \{green\}/);
    assert.match(daily, /\{green\}\[i\] Hôm nay không có lịch học\.\{\/green\}/);
    assert.match(weekly, /^# \{green\}/);
    assert.match(weekly, /\{green\}\[i\] Tuần này không có lịch học\.\{\/green\}/);
    assert.doesNotMatch(daily, EMOJI_PATTERN);
    assert.doesNotMatch(weekly, EMOJI_PATTERN);
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
    assert.match(examMsg, /\[LỊCH THI\] DANH SÁCH MÔN THI/);
    assert.match(examMsg, /Thứ Năm, 20\/08\/2026/);
    assert.match(examMsg, /Cơ sở dữ liệu/);

    const emptyRoomsMsg = findEmptyRooms("Cơ sở I", { lessons: [] }, new Date("2026-08-17T00:00:00Z"));
    assert.match(emptyRoomsMsg, /PHÒNG TRỐNG/);
    assert.match(emptyRoomsMsg, /A101/);
});
