const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    addDutySchedule,
    deleteDutySchedule,
    formatDutyList,
    formatDutyNotification,
    getDutyScheduleForDate,
    getDutySchedules,
    parseDutyInput,
    updateDutySchedule
} = require("../dutyScheduleStore");

function temporaryFile(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-duty-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return path.join(directory, "dutyScheduleData.json");
}

test("phân tích cú pháp lịch trực bóc tách chuẩn các dạng dd/mm và tên người trực", () => {
    assert.deepEqual(parseDutyInput("[25/08] [Nguyễn Văn A - Trần Thị B]"), {
        day: 25,
        month: 8,
        year: undefined,
        dateStr: "25/08",
        assigned: "Nguyễn Văn A - Trần Thị B"
    });

    assert.deepEqual(parseDutyInput("[25/08] Nguyễn Văn A - Trần Thị B"), {
        day: 25,
        month: 8,
        year: undefined,
        dateStr: "25/08",
        assigned: "Nguyễn Văn A - Trần Thị B"
    });

    assert.deepEqual(parseDutyInput("25/08 [Nguyễn Văn A - Trần Thị B]"), {
        day: 25,
        month: 8,
        year: undefined,
        dateStr: "25/08",
        assigned: "Nguyễn Văn A - Trần Thị B"
    });

    assert.deepEqual(parseDutyInput("25/08 Nguyễn Văn A - Trần Thị B"), {
        day: 25,
        month: 8,
        year: undefined,
        dateStr: "25/08",
        assigned: "Nguyễn Văn A - Trần Thị B"
    });

    assert.deepEqual(parseDutyInput("05/09/2026 Lê Văn C - Phạm Văn D"), {
        day: 5,
        month: 9,
        year: 2026,
        dateStr: "05/09",
        assigned: "Lê Văn C - Phạm Văn D"
    });

    // Trường hợp không hợp lệ
    assert.equal(parseDutyInput("chuoi khong phai ngay"), null);
    assert.equal(parseDutyInput("32/08 Nguyễn Văn A"), null);
    assert.equal(parseDutyInput("25/13 Nguyễn Văn A"), null);
});

test("thêm, sửa, xóa và truy vấn lịch trực theo ID và ngày dd/mm", (t) => {
    const filePath = temporaryFile(t);

    // 1. Thêm lịch trực
    const item1 = addDutySchedule("[25/08] [Nguyễn Văn A - Trần Thị B]", filePath);
    assert.equal(item1.id, 1);
    assert.equal(item1.dateStr, "25/08");
    assert.equal(item1.assigned, "Nguyễn Văn A - Trần Thị B");

    const item2 = addDutySchedule("[26/08] [Lê Văn C - Phạm Văn D]", filePath);
    assert.equal(item2.id, 2);
    assert.equal(item2.dateStr, "26/08");

    assert.equal(getDutySchedules(filePath).length, 2);

    // 2. Truy vấn lịch trực cho ngày cụ thể
    const date1 = new Date("2026-08-25T10:00:00+07:00");
    const todayDuties = getDutyScheduleForDate(date1, filePath);
    assert.equal(todayDuties.length, 1);
    assert.equal(todayDuties[0].assigned, "Nguyễn Văn A - Trần Thị B");

    // 3. Sửa lịch trực theo ID
    const updated1 = updateDutySchedule(1, "[25/08] [Nguyễn Văn A - Võ Văn E]", filePath);
    assert.equal(updated1.assigned, "Nguyễn Văn A - Võ Văn E");

    // 4. Sửa lịch trực theo ngày
    const updated2 = updateDutySchedule("26/08", "[26/08] [Lê Văn C - Trần Văn F]", filePath);
    assert.equal(updated2.assigned, "Lê Văn C - Trần Văn F");

    // 5. Xóa lịch trực theo ID
    const deleted1 = deleteDutySchedule(1, filePath);
    assert.equal(deleted1.id, 1);
    assert.equal(getDutySchedules(filePath).length, 1);

    // 6. Xóa lịch trực theo ngày
    const deleted2 = deleteDutySchedule("26/08", filePath);
    assert.equal(deleted2.id, 2);
    assert.equal(getDutySchedules(filePath).length, 0);
});

test("định dạng tin nhắn thông báo 06:00 và danh sách lịch trực rich text đầy đủ", () => {
    const items = [
        { id: 1, dateStr: "18/08", day: 18, month: 8, assigned: "Nguyễn Văn A - Trần Thị B" }
    ];

    const notifMsg = formatDutyNotification(items, new Date("2026-08-18T06:00:00+07:00"));
    assert.match(notifMsg, /LỊCH TRỰC/);
    assert.match(notifMsg, /HÔM NAY 18\/08/);
    assert.match(notifMsg, /Nguyễn Văn A - Trần Thị B/);

    const listMsg = formatDutyList(items);
    assert.match(listMsg, /DANH SÁCH PHÂN CÔNG/);
    assert.match(listMsg, /#1/);
    assert.match(listMsg, /Nguyễn Văn A - Trần Thị B/);
});
