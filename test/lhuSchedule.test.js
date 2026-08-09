const test = require("node:test");
const assert = require("node:assert/strict");
const {
    formatDailySchedule,
    lessonsForDate,
    normalizeStudentId
} = require("../lhuSchedule");
const { getApiDateTimeInfo, getVietnamDateInfo, toLhuQueryDate } = require("../timezone");

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
    assert.match(message, /Lập trình Web/);
    assert.match(message, /07:00 - 09:15/);
    assert.match(message, /Nguyễn Văn A/);
});

test("kiểm tra định dạng MSSV", () => {
    assert.equal(normalizeStudentId(" 123456789 "), "123456789");
    assert.equal(normalizeStudentId("123"), null);
    assert.equal(normalizeStudentId("D05403126"), null);
});
