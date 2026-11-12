const test = require("node:test");
const assert = require("node:assert/strict");

const { MAX_START_OFFSET, MAX_WEEKS, resolveWeekRequest, weekLabel } = require("../scheduleWeek");

/* -------------------------------------------------------------------------- */
/* Quy đổi cụm từ                                                             */
/* -------------------------------------------------------------------------- */

test("không có tham số thì không tự đoán tuần nào", () => {
    assert.equal(resolveWeekRequest(""), null);
    assert.equal(resolveWeekRequest("   "), null);
    assert.equal(resolveWeekRequest(null), null);
});

test("tuần này và tuần sau", () => {
    assert.deepEqual(resolveWeekRequest("tuan nay"), { startOffset: 0, weeks: 1 });
    assert.deepEqual(resolveWeekRequest("tuần này"), { startOffset: 0, weeks: 1 });
    assert.deepEqual(resolveWeekRequest("tuan sau"), { startOffset: 1, weeks: 1 });
    assert.deepEqual(resolveWeekRequest("tuần tới"), { startOffset: 1, weeks: 1 });
    assert.deepEqual(resolveWeekRequest("tuần sau nữa"), { startOffset: 2, weeks: 1 });
});

test("con số đứng một mình là SỐ TUẦN muốn xem, không phải tuần thứ N", () => {
    assert.deepEqual(resolveWeekRequest("1"), { startOffset: 0, weeks: 1 });
    assert.deepEqual(resolveWeekRequest("3"), { startOffset: 0, weeks: 3 });
    assert.deepEqual(resolveWeekRequest("3 tuần"), { startOffset: 0, weeks: 3 });
    assert.deepEqual(resolveWeekRequest("3 tuan toi"), { startOffset: 0, weeks: 3 });
});

test("vượt trần thì cắt về trần, không báo lỗi", () => {
    assert.deepEqual(resolveWeekRequest("9"), { startOffset: 0, weeks: MAX_WEEKS });
});

test("cụm từ lạ thì trả null để người gọi hỏi lại, không đoán bừa", () => {
    for (const input of ["abc", "tuần thứ 2", "tháng sau", "2 tháng", "0"]) {
        assert.equal(resolveWeekRequest(input), null, input);
    }
});

/* -------------------------------------------------------------------------- */
/* Nhãn hiển thị                                                              */
/* -------------------------------------------------------------------------- */

test("nhãn tuần đọc được như người nói", () => {
    assert.equal(weekLabel(0), "TUẦN NÀY");
    assert.equal(weekLabel(1), "TUẦN SAU");
    assert.equal(weekLabel(2), "TUẦN SAU NỮA");
    assert.equal(weekLabel(3), "TUẦN THỨ 4");
    assert.equal(weekLabel(MAX_START_OFFSET), `TUẦN THỨ ${MAX_START_OFFSET + 1}`);
});
