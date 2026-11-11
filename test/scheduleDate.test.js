const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveScheduleDate } = require("../scheduleDate");

// Thứ Tư 11/11/2026, 09:00 giờ Việt Nam.
const NOW = new Date("2026-11-11T02:00:00.000Z");

function key(input) {
    const resolved = resolveScheduleDate(input, NOW);
    return resolved ? resolved.dateKey : null;
}

test("ngày tương đối: hôm nay, mai, mốt", () => {
    assert.equal(key("homnay"), "2026-11-11");
    assert.equal(key("hôm nay"), "2026-11-11");
    assert.equal(key("mai"), "2026-11-12");
    assert.equal(key("ngày mai"), "2026-11-12");
    assert.equal(key("mot"), "2026-11-13");
    assert.equal(key("ngày kia"), "2026-11-13");
    assert.equal(key("ngày mốt"), "2026-11-13");
});

test("thứ trong tuần: lấy lần gần nhất tính từ hôm nay", () => {
    // Hôm nay là Thứ Tư 11/11.
    assert.equal(key("thứ 5"), "2026-11-12");
    assert.equal(key("thu5"), "2026-11-12");
    assert.equal(key("thứ tư"), "2026-11-11", "đúng hôm nay thì trả về hôm nay");
    assert.equal(key("thứ 2"), "2026-11-16", "thứ Hai kế tiếp, không phải tuần trước");
    assert.equal(key("chủ nhật"), "2026-11-15");
    assert.equal(key("cn"), "2026-11-15");
});

test("ngày/tháng và ISO", () => {
    assert.equal(key("12/11"), "2026-11-12");
    assert.equal(key("12-11"), "2026-11-12");
    assert.equal(key("1/1"), "2026-01-01");
    assert.equal(key("2026-11-12"), "2026-11-12");
    assert.equal(key("2026-12-31"), "2026-12-31");
});

test("kết quả có nhãn đọc được và cờ số ngày", () => {
    const tomorrow = resolveScheduleDate("mai", NOW);
    assert.equal(tomorrow.daysAhead, 1);
    assert.equal(tomorrow.formattedDate, "12/11/2026");
    assert.match(tomorrow.label, /12\/11\/2026/);
    assert.ok(tomorrow.date instanceof Date);

    const today = resolveScheduleDate("homnay", NOW);
    assert.equal(today.daysAhead, 0);
});

test("không hiểu thì trả null, không đoán", () => {
    for (const input of ["", "   ", "abc", "tuần sau", "32/13", "2026-02-30", "9999-01-01", null, undefined]) {
        assert.equal(resolveScheduleDate(input, NOW), null, String(input));
    }
});

test("ngày quá xa bị từ chối", () => {
    // 120 ngày là trần; 200 ngày sau phải bị loại.
    assert.equal(key("2027-06-01"), null);
});
