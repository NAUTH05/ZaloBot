const test = require("node:test");
const assert = require("node:assert/strict");
const {
    advanceChangeState,
    buildScheduleSnapshot,
    diffSnapshots
} = require("../scheduleChanges");

function schedule(lessons) {
    return {
        studentId: "123456789",
        studentName: "Nguyễn Văn A",
        lessons
    };
}

function lesson(overrides = {}) {
    return {
        ID: 10,
        ThoiGianBD: "2026-08-10T07:00:00",
        ThoiGianKT: "2026-08-10T09:15:00",
        TenMonHoc: "Lập trình Web",
        TenPhong: "A101",
        TenCoSo: "Cơ sở 1",
        GiaoVien: "Trần Văn B",
        TenNhom: "22CT111",
        Type: 0,
        TinhTrang: 0,
        ...overrides
    };
}

const checkDate = new Date("2026-08-09T05:00:00.000Z");

test("phát hiện buổi học được thêm, xóa và chỉnh sửa", () => {
    const original = buildScheduleSnapshot(schedule([lesson()]), checkDate);
    const changed = buildScheduleSnapshot(schedule([
        lesson({ TenPhong: "B202" }),
        lesson({ ID: 11, TenMonHoc: "Cơ sở dữ liệu" })
    ]), checkDate);
    const diff = diffSnapshots(original, changed);

    assert.equal(diff.added.length, 1);
    assert.equal(diff.removed.length, 0);
    assert.equal(diff.modified.length, 1);
    assert.equal(diff.modified[0].before.room, "A101");
    assert.equal(diff.modified[0].after.room, "B202");
});

test("bỏ qua lịch đã qua khi so sánh sang ngày mới", () => {
    const previous = buildScheduleSnapshot(schedule([
        lesson({ ID: 9, ThoiGianBD: "2026-08-09T07:00:00", ThoiGianKT: "2026-08-09T09:00:00" }),
        lesson()
    ]), checkDate);
    const nextDay = new Date("2026-08-09T17:00:00.000Z");
    const current = buildScheduleSnapshot(schedule([lesson()]), nextDay);

    assert.equal(diffSnapshots(previous, current).removed.length, 0);

    const initialized = advanceChangeState(null, previous);
    const nextDayResult = advanceChangeState(initialized.state, current);
    assert.equal(nextDayResult.confirmed, false);
    assert.equal(nextDayResult.state.pending, null);
});

test("chỉ xác nhận thay đổi sau hai lần quan sát liên tiếp", () => {
    const original = buildScheduleSnapshot(schedule([lesson()]), checkDate);
    const changed = buildScheduleSnapshot(schedule([lesson({ TenPhong: "B202" })]), checkDate);

    const initialized = advanceChangeState(null, original, "2026-08-09T05:00:00Z");
    const firstObservation = advanceChangeState(initialized.state, changed, "2026-08-09T05:05:00Z");
    const secondObservation = advanceChangeState(firstObservation.state, changed, "2026-08-09T05:20:00Z");

    assert.equal(initialized.confirmed, false);
    assert.equal(firstObservation.confirmed, false);
    assert.equal(secondObservation.confirmed, true);
    assert.equal(secondObservation.changes.modified.length, 1);
});

test("hủy thay đổi chờ xác nhận nếu API trở về lịch cũ", () => {
    const original = buildScheduleSnapshot(schedule([lesson()]), checkDate);
    const transient = buildScheduleSnapshot(schedule([]), checkDate);
    const initialized = advanceChangeState(null, original);
    const pending = advanceChangeState(initialized.state, transient);
    const recovered = advanceChangeState(pending.state, original);

    assert.ok(pending.state.pending);
    assert.equal(recovered.confirmed, false);
    assert.equal(recovered.state.pending, null);
});
