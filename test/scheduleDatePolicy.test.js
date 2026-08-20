const test = require("node:test");
const assert = require("node:assert/strict");
const { DAILY_CLASS_SCHEDULE_POLICY, resolveScheduleTarget } = require("../scheduleDatePolicy");

test("daily class policy uses today before 20:00", () => {
    const result = resolveScheduleTarget(new Date("2026-08-21T12:59:00.000Z"), DAILY_CLASS_SCHEDULE_POLICY);
    assert.equal(result.deliveryDateKey, "2026-08-21");
    assert.equal(result.targetDateKey, "2026-08-21");
});

test("daily class policy uses tomorrow at 20:00", () => {
    const result = resolveScheduleTarget(new Date("2026-08-21T13:00:00.000Z"), DAILY_CLASS_SCHEDULE_POLICY);
    assert.equal(result.deliveryDateKey, "2026-08-21");
    assert.equal(result.targetDateKey, "2026-08-22");
});

test("late Sunday targets Monday", () => {
    const result = resolveScheduleTarget(new Date("2026-08-23T16:59:00.000Z"));
    assert.equal(result.targetDateKey, "2026-08-24");
});

test("after midnight starts a new same-day window", () => {
    const result = resolveScheduleTarget(new Date("2026-08-23T17:01:00.000Z"));
    assert.equal(result.deliveryDateKey, "2026-08-24");
    assert.equal(result.targetDateKey, "2026-08-24");
});
