const test = require("node:test");
const assert = require("node:assert/strict");
const { formatScheduleContextForAi } = require("../aiAssistant");

test("tạo ngữ cảnh lịch học cho AI và phát hiện ngày rảnh / ngày báo nghỉ", () => {
    const mockScheduleData = {
        studentId: "123456789",
        studentName: "Nguyễn Văn A",
        lessons: [
            {
                ThoiGianBD: "2026-08-17T07:30:00",
                ThoiGianKT: "2026-08-17T11:25:00",
                TenMonHoc: "Lập trình Web",
                TenPhong: "A101",
                TenCoSo: "Cơ sở I",
                TinhTrang: 0
            },
            {
                ThoiGianBD: "2026-08-18T07:30:00",
                ThoiGianKT: "2026-08-18T11:25:00",
                TenMonHoc: "Trí tuệ nhân tạo",
                TenPhong: "C402",
                TenCoSo: "Cơ sở I",
                TinhTrang: 1 // Báo nghỉ
            }
        ]
    };

    const date = new Date("2026-08-17T00:00:00.000Z");
    const result = formatScheduleContextForAi(mockScheduleData, date, 2);

    assert.equal(result.studentId, "123456789");
    assert.equal(result.studentName, "Nguyễn Văn A");
    assert.match(result.summaryText, /Nguyễn Văn A/);
    assert.match(result.summaryText, /Lập trình Web/);
    assert.match(result.summaryText, /BÁO NGHỈ/);
});
