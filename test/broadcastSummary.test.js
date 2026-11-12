// ============================================================================
// Bảng tổng kết đợt phát tin.
//
// Con số "đã gửi thành công" phải nói đúng sự thật, vì nó quyết định việc người
// vận hành có tin là xong việc hay không. Ba trạng thái phải phân biệt được:
//   - gửi được và Zalo có trả mã tin nhắn (bằng chứng mạnh nhất);
//   - Zalo nhận yêu cầu nhưng KHÔNG trả mã ("chưa xác nhận");
//   - bị hoãn vì giới hạn tốc độ (chưa gửi, chạy lại sau được).
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.BOT_TOKEN ||= "summary-test-token";

const { formatBroadcastSummary } = require("../main.js");

function build(overrides = {}) {
    return {
        targets: 100,
        sent: 100,
        unconfirmed: 0,
        failed: 0,
        deferred: 0,
        skipped: { unverifiedSource: 0, ownerBotOffline: 0, pendingIdentity: 0 },
        warning: null,
        ...overrides
    };
}

test("tổng kết sạch: không thêm dòng nhiễu", () => {
    const text = formatBroadcastSummary("ĐÃ GỬI THÔNG BÁO", build());
    assert.match(text, /Tổng cuộc trò chuyện:\*\* 100/);
    assert.match(text, /Gửi thành công:\*\* 100/);
    assert.match(text, /Gửi lỗi:\*\* 0/);
    assert.ok(!/chưa có mã tin nhắn/.test(text));
    assert.ok(!/Hoãn/.test(text));
});

test("Zalo không trả mã tin nhắn thì phải nói rõ là CHƯA XÁC NHẬN", () => {
    const text = formatBroadcastSummary("ĐÃ GỬI THÔNG BÁO", build({ unconfirmed: 37 }));
    assert.match(text, /Gửi thành công:\*\* 100 \(trong đó 37 chưa có mã tin nhắn xác nhận\)/);
});

test("bị giới hạn tốc độ thì hiện số HOÃN và hướng dẫn chạy lại", () => {
    const text = formatBroadcastSummary("ĐÃ GỬI THÔNG BÁO", build({ sent: 60, deferred: 40 }));
    assert.match(text, /Hoãn do bị giới hạn tốc độ:\*\* 40/);
    assert.match(text, /chạy lại lệnh sau vài phút/i);
});

test("cảnh báo tài khoản cá nhân được giữ nguyên trong tổng kết", () => {
    const warning = "> **Lưu ý:** 95/100 cuộc trò chuyện thuộc tài khoản Zalo **cá nhân**.";
    const text = formatBroadcastSummary("ĐÃ GỬI THÔNG BÁO", build({ warning }));
    assert.ok(text.includes(warning));
});

test("vẫn giữ dòng bỏ qua của các bản ghi chưa xác minh", () => {
    const text = formatBroadcastSummary("ĐÃ GỬI THÔNG BÁO", build({
        sent: 90,
        skipped: { unverifiedSource: 8, ownerBotOffline: 2, pendingIdentity: 1 }
    }));
    assert.match(text, /Bỏ qua:\*\* 11/);
    assert.match(text, /8 chưa rõ tài khoản/);
    assert.match(text, /2 bot sở hữu đang tắt/);
    assert.match(text, /1 bản ghi trùng của danh tính tạm/);
});
