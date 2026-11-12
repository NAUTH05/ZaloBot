// ============================================================================
// Dấu thời gian Việt Nam cho log của tiến trình.
//
// `pm2 logs` in giờ theo múi giờ của daemon PM2, nên trên VPS để UTC thì một lượt
// gửi 06:30 hiện thành 23:30 hôm trước. Bài này chốt: tiền tố luôn là giờ Việt
// Nam, không phụ thuộc TZ của máy, và không bị ghép hai lần.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");

const { STAMP_PATTERN, formatLogStamp, installVietnamLogTimestamps } = require("../logTime");

function fakeConsole() {
    const lines = [];
    return {
        lines,
        log: (...args) => lines.push(args),
        warn: (...args) => lines.push(args),
        error: (...args) => lines.push(args)
    };
}

test("dấu thời gian luôn theo giờ Việt Nam, bất kể TZ của máy", () => {
    // 02:30:05 UTC = 09:30:05 tại Asia/Ho_Chi_Minh (UTC+7, không có DST).
    assert.equal(formatLogStamp(new Date("2026-11-12T02:30:05.000Z")), "[12/11/2026 09:30:05]");
    // Nửa đêm UTC đã sang ngày mới ở Việt Nam: đây chính là ca gây nhầm lẫn.
    assert.equal(formatLogStamp(new Date("2026-11-11T23:30:00.000Z")), "[12/11/2026 06:30:00]");
});

test("tiền tố được ghép vào đối số đầu tiên và giữ nguyên định dạng %s", () => {
    const target = fakeConsole();
    const installed = installVietnamLogTimestamps({ console: target, now: () => new Date("2026-11-12T02:30:05.000Z") });
    assert.equal(installed, true);

    target.log("Bắt đầu gửi lịch %s", "06:30");
    assert.deepEqual(target.lines[0], ["[12/11/2026 09:30:05] Bắt đầu gửi lịch %s", "06:30"]);
});

test("đối số đầu không phải chuỗi thì tiền tố là một đối số riêng", () => {
    const target = fakeConsole();
    installVietnamLogTimestamps({ console: target, now: () => new Date("2026-11-12T02:30:05.000Z") });
    target.error({ code: 410 });
    assert.deepEqual(target.lines[0], ["[12/11/2026 09:30:05]", { code: 410 }]);
});

test("không ghép tiền tố hai lần", () => {
    const target = fakeConsole();
    installVietnamLogTimestamps({ console: target, now: () => new Date("2026-11-12T02:30:05.000Z") });
    assert.equal(installVietnamLogTimestamps({ console: target }), false, "lần thứ hai phải là no-op");

    target.log("[12/11/2026 09:30:05] đã có sẵn dấu thời gian");
    assert.deepEqual(target.lines[0], ["[12/11/2026 09:30:05] đã có sẵn dấu thời gian"]);
});

test("mẫu nhận dạng khớp đúng định dạng đã phát ra", () => {
    assert.match(formatLogStamp(new Date()), STAMP_PATTERN);
});
