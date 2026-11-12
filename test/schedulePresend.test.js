// ============================================================================
// GỬI TRƯỚC CHO MỐC GIỜ.
//
// Mục tiêu: mốc 06:30 có 50 người, mỗi tin cách nhau 5 giây. Nếu bắt đầu đúng
// 06:30 thì người cuối nhận 06:34. Gửi trước để TIN CUỐI vẫn rơi vào 06:30.
//
// Bốn điều phải đúng:
//   1. Cửa sổ = số người × (delay + thời gian gửi) + dự phòng, có sàn và trần.
//   2. Không bao giờ gửi trước sang NGÀY HÔM TRƯỚC (mốc 00:05).
//   3. Vẫn nhận gửi muộn trong ân hạn, để restart đúng lúc không mất cả ngày.
//   4. Đọc được từ .env mà không cần sửa mã.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    ESTIMATED_SEND_MS,
    computeWindowMs,
    planSlot,
    resolvePresendOptions,
    vietnamInstant
} = require("../schedulePresend");

const MIN = 60 * 1000;

test("mốc giờ Việt Nam được quy đổi đúng sang UTC", () => {
    assert.equal(vietnamInstant("2026-11-12", "06:30").toISOString(), "2026-11-11T23:30:00.000Z");
    assert.equal(vietnamInstant("2026-11-12", "00:00").toISOString(), "2026-11-11T17:00:00.000Z");
    assert.equal(vietnamInstant("2026-11-12", "23:59").toISOString(), "2026-11-12T16:59:00.000Z");
    assert.equal(vietnamInstant("bad", "06:30"), null);
    assert.equal(vietnamInstant("2026-11-12", "25:00"), null);
});

test("cửa sổ = số người × (delay + thời gian gửi) + dự phòng", () => {
    const options = resolvePresendOptions({});

    // 50 người, tài khoản cá nhân 5 giây/tin ⇒ 50 × 6 giây = 300 giây + 90 giây.
    assert.equal(computeWindowMs(Array(50).fill(5000), options), 50 * (5000 + ESTIMATED_SEND_MS) + 90 * 1000);
});

test("cửa sổ có sàn 5 phút và trần 20 phút", () => {
    const options = resolvePresendOptions({});

    // Một người: thời gian cần rất ngắn nhưng vẫn có sàn 5 phút để còn dư địa.
    assert.equal(computeWindowMs([1200], options), 5 * MIN);
    // 200 người × 6 giây = 1200 giây > trần ⇒ kẹp về 20 phút.
    assert.equal(computeWindowMs(Array(200).fill(5000), options), 20 * MIN);
});

test("tin cuối rơi đúng mốc: bắt đầu sớm đúng bằng thời gian cần", () => {
    const options = resolvePresendOptions({});
    const intervals = Array(50).fill(5000);
    const windowMs = computeWindowMs(intervals, options);

    const plan = planSlot({
        slotDateKey: "2026-11-12",
        time: "06:30",
        intervals,
        now: new Date("2026-11-11T23:00:00.000Z"),   // 06:00 giờ VN
        options
    });

    assert.equal(plan.slotAt.toISOString(), "2026-11-11T23:30:00.000Z");
    assert.equal(plan.startAt, plan.slotAt.getTime() - windowMs);
    assert.equal(plan.minutesBefore, 7);   // 390 giây ⇒ làm tròn 7 phút
    assert.equal(plan.due, false, "06:00 còn quá sớm so với 06:23");

    const atStart = planSlot({
        slotDateKey: "2026-11-12",
        time: "06:30",
        intervals,
        now: new Date(plan.startAt),
        options
    });
    assert.equal(atStart.due, true);
});

test("không bao giờ gửi trước sang ngày hôm trước", () => {
    const options = resolvePresendOptions({});
    // Mốc 00:05 với cửa sổ 20 phút sẽ là 23:45 HÔM TRƯỚC — điều tuyệt đối tránh.
    const plan = planSlot({
        slotDateKey: "2026-11-12",
        time: "00:05",
        intervals: Array(200).fill(5000),
        now: new Date("2026-11-11T16:00:00.000Z"),   // 23:00 VN ngày 11
        options
    });

    assert.equal(plan.startAt, vietnamInstant("2026-11-12", "00:00").getTime());
    assert.equal(plan.windowMs, 5 * MIN, "cửa sổ bị chặn bởi đầu ngày, chỉ còn 5 phút");
    assert.equal(plan.due, false, "23:00 hôm trước thì chưa được gửi");
});

test("vẫn gửi muộn trong ân hạn để restart không mất cả ngày", () => {
    const options = resolvePresendOptions({});
    const args = { slotDateKey: "2026-11-12", time: "06:30", intervals: [5000], options };

    const late = planSlot({ ...args, now: new Date("2026-11-11T23:40:00.000Z") });   // 06:40 VN
    assert.equal(late.due, true, "06:40 vẫn trong ân hạn 15 phút");

    const tooLate = planSlot({ ...args, now: new Date("2026-11-11T23:46:00.000Z") }); // 06:46 VN
    assert.equal(tooLate.due, false, "quá ân hạn thì thôi, không gửi lịch cũ");
});

test("cấu hình đọc từ .env và không bao giờ tạo cửa sổ âm", () => {
    const custom = resolvePresendOptions({ PRESEND_MIN_MINUTES: "3", PRESEND_MAX_MINUTES: "10", SCHEDULE_LATE_GRACE_MINUTES: "5" });
    assert.equal(custom.minWindowMs, 3 * MIN);
    assert.equal(custom.maxWindowMs, 10 * MIN);
    assert.equal(custom.lateGraceMs, 5 * MIN);

    // Đảo ngược cấu hình: vẫn phải ra khoảng hợp lệ.
    const swapped = resolvePresendOptions({ PRESEND_MIN_MINUTES: "30", PRESEND_MAX_MINUTES: "10" });
    assert.equal(swapped.minWindowMs, 10 * MIN);
    assert.equal(swapped.maxWindowMs, 30 * MIN);

    // Giá trị rác ⇒ về mặc định, không thành 0.
    const junk = resolvePresendOptions({ PRESEND_MIN_MINUTES: "abc", PRESEND_MAX_MINUTES: "-5" });
    assert.equal(junk.minWindowMs, 5 * MIN);
    assert.equal(junk.maxWindowMs, 20 * MIN);
});
