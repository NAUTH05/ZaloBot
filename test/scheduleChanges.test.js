const test = require("node:test");
const assert = require("node:assert/strict");
const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const {
    SNAPSHOT_SCHEMA_VERSION,
    buildScheduleSnapshot,
    captureChangeState,
    confirmChangeState,
    diffSnapshots,
    formatScheduleChangeMessage
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
        NhomID: 10001,
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
        lesson({ ID: 11, NhomID: 20002, TenMonHoc: "Cơ sở dữ liệu" })
    ]), checkDate);
    const diff = diffSnapshots(original, changed);

    assert.equal(diff.added.length, 1);
    assert.equal(diff.removed.length, 0);
    assert.equal(diff.modified.length, 1);
    assert.equal(diff.modified[0].before.room, "A101");
    assert.equal(diff.modified[0].after.room, "B202");
});

test("01:00 chỉ chụp thay đổi và 06:00 mới xác nhận", () => {
    const original = buildScheduleSnapshot(schedule([lesson()]), checkDate);
    const changed = buildScheduleSnapshot(schedule([lesson({ TenPhong: "B202" })]), checkDate);
    const initialized = captureChangeState(null, original, "2026-08-09T00:00:00Z");

    const atOne = captureChangeState(initialized.state, changed, "2026-08-09T01:00:00+07:00");
    assert.equal(atOne.captured, true);
    assert.ok(atOne.state.pending);

    const atSix = confirmChangeState(atOne.state, changed, "2026-08-09T06:00:00+07:00");
    assert.equal(atSix.confirmed, true);
    assert.equal(atSix.changes.modified.length, 1);
    assert.equal(atSix.state.pending, null);
});

test("xác nhận và báo thay đổi lúc 06:00 khi lịch khác baseline", () => {
    const original = buildScheduleSnapshot(schedule([lesson()]), checkDate);
    const atOneSchedule = buildScheduleSnapshot(schedule([lesson({ TenPhong: "B202" })]), checkDate);
    const atSixSchedule = buildScheduleSnapshot(schedule([lesson({ TenPhong: "C303" })]), checkDate);
    const initialized = captureChangeState(null, original);
    const atOne = captureChangeState(initialized.state, atOneSchedule);
    const atSix = confirmChangeState(atOne.state, atSixSchedule);

    assert.equal(atSix.confirmed, true);
    assert.equal(atSix.changes.modified.length, 1);
    assert.equal(atSix.changes.modified[0].after.room, "C303");
    assert.equal(atSix.state.pending, null);
    assert.equal(atSix.state.baseline.fingerprint, atSixSchedule.fingerprint);
});

test("thay đổi xuất hiện sau 01:00 vẫn được báo đầy đủ lúc 06:00", () => {
    const original = buildScheduleSnapshot(schedule([lesson()]), checkDate);
    const changedAfterOne = buildScheduleSnapshot(schedule([lesson({ TenPhong: "B202" })]), checkDate);
    const initialized = captureChangeState(null, original);
    const atOne = captureChangeState(initialized.state, original);
    const atSix = confirmChangeState(atOne.state, changedAfterOne);

    assert.equal(atOne.captured, false);
    assert.equal(atSix.confirmed, true);
    assert.equal(atSix.changes.modified.length, 1);
    assert.equal(atSix.changes.modified[0].after.room, "B202");
    assert.equal(atSix.state.baseline.fingerprint, changedAfterOne.fingerprint);
});

test("bỏ qua lịch đã qua khi chuyển sang ngày mới", () => {
    const previous = buildScheduleSnapshot(schedule([
        lesson({ ID: 9, ThoiGianBD: "2026-08-09T07:00:00", ThoiGianKT: "2026-08-09T09:00:00" }),
        lesson()
    ]), checkDate);
    const nextDay = new Date("2026-08-09T17:00:00.000Z");
    const current = buildScheduleSnapshot(schedule([lesson()]), nextDay);
    const initialized = captureChangeState(null, previous);
    const result = captureChangeState(initialized.state, current);

    assert.equal(diffSnapshots(previous, current).removed.length, 0);
    assert.equal(result.captured, false);
    assert.equal(result.state.pending, null);
});

test("không báo thay đổi khi API chỉ đánh lại ID thứ tự", () => {
    const original = buildScheduleSnapshot(schedule([
        lesson({ ID: 1 }),
        lesson({
            ID: 2,
            NhomID: 20002,
            TenMonHoc: "Cơ sở dữ liệu",
            ThoiGianBD: "2026-08-11T09:30:00",
            ThoiGianKT: "2026-08-11T11:45:00"
        })
    ]), checkDate);
    const reordered = buildScheduleSnapshot(schedule([
        lesson({ ID: 99 }),
        lesson({
            ID: 100,
            NhomID: 20002,
            TenMonHoc: "Cơ sở dữ liệu",
            ThoiGianBD: "2026-08-11T09:30:00",
            ThoiGianKT: "2026-08-11T11:45:00"
        })
    ]), checkDate);

    const diff = diffSnapshots(original, reordered);
    assert.deepEqual(diff, { added: [], removed: [], modified: [] });
    assert.equal(original.fingerprint, reordered.fingerprint);
});

test("ghép một buổi đổi ngày giờ thành điều chỉnh theo NhomID", () => {
    const original = buildScheduleSnapshot(schedule([lesson()]), checkDate);
    const moved = buildScheduleSnapshot(schedule([lesson({
        ID: 25,
        ThoiGianBD: "2026-08-11T13:00:00",
        ThoiGianKT: "2026-08-11T15:15:00"
    })]), checkDate);

    const diff = diffSnapshots(original, moved);
    assert.equal(diff.added.length, 0);
    assert.equal(diff.removed.length, 0);
    assert.equal(diff.modified.length, 1);
    assert.equal(diff.modified[0].after.dateKey, "2026-08-11");
});

test("format thông báo dùng rich text, ngày dd/mm/yyyy và chỉ hiện trường bị đổi", () => {
    const original = buildScheduleSnapshot(schedule([lesson()]), checkDate);
    const changed = buildScheduleSnapshot(schedule([lesson({
        ThoiGianBD: "2026-08-11T07:00:00",
        ThoiGianKT: "2026-08-11T09:15:00",
        TenPhong: "B202"
    })]), checkDate);
    const message = formatScheduleChangeMessage(
        schedule([]),
        diffSnapshots(original, changed),
        new Date("2026-08-10T03:35:00.000Z")
    );

    assert.match(message, /^# \{orange\}\[LỊCH HỌC\] CÓ THAY ĐỔI\{\/orange\}/);
    assert.match(message, /\{orange\}ĐIỀU CHỈNH · 1\{\/orange\}/);
    assert.match(message, /Thứ Hai, 10\/08\/2026 lúc 10:35/);
    assert.match(message, /Lịch hiện tại:\*\* Thứ Ba, 11\/08\/2026 · 07:00 - 09:15/);
    assert.match(message, /~~Thứ Hai, 10\/08\/2026~~ → \*\*Thứ Ba, 11\/08\/2026\*\*/);
    assert.match(message, /Phòng:/);
    assert.doesNotMatch(message, /2026-08-11/);
    assert.doesNotMatch(message, /Giảng viên:/);
    assert.doesNotMatch(message, EMOJI_PATTERN);
});

test("tự đặt lại baseline khi nâng schema snapshot để không báo giả", () => {
    const current = buildScheduleSnapshot(schedule([lesson()]), checkDate);
    const oldState = {
        baseline: { ...current, schemaVersion: SNAPSHOT_SCHEMA_VERSION - 1 },
        pending: { snapshot: current },
        updatedAt: "2026-08-09T01:00:00+07:00"
    };

    const result = captureChangeState(oldState, current);
    assert.equal(result.captured, false);
    assert.equal(result.state.baseline.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
    assert.equal(result.state.pending, null);
});
