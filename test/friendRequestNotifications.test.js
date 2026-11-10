// ============================================================================
// Test cho phần dựng thông báo lời mời kết bạn và chọn người nhận.
//
// Đây là chỗ dễ sai nhất khi có HAI kênh: Chat ID của bot chính thức không dùng
// được cho tài khoản Zalo cá nhân, và không được gửi cho chính tài khoản đang gửi.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || "fr-notify-admin";
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "fr-notify-password";

const main = require("../main");
const { BASE_PATH } = require("../adminServer");

const SAMPLE = {
    requestId: "zca::zca:1001::555",
    accountId: "zca:1001",
    userId: "555",
    displayName: "Nguyễn Văn A",
    message: "Xin chào, mình muốn kết bạn",
    status: "pending",
    detectedAt: "2026-11-10T07:30:00.000Z",
    requestedAt: "2026-11-10T07:30:00.000Z"
};

const ACCOUNT = { botId: "zca:1001", displayName: "ZCA Main", ownUid: "1001" };

function withBaseUrl(value, run) {
    const previous = process.env.ADMIN_BASE_URL;
    if (value === undefined) delete process.env.ADMIN_BASE_URL;
    else process.env.ADMIN_BASE_URL = value;
    try {
        return run();
    } finally {
        if (previous === undefined) delete process.env.ADMIN_BASE_URL;
        else process.env.ADMIN_BASE_URL = previous;
    }
}

// ---------------------------------------------------------------------------
// Liên kết quản lý
// ---------------------------------------------------------------------------

test("liên kết quản lý dựng từ origin công khai và base path thật", () => {
    const url = withBaseUrl("https://bot.example.org", () => main.buildFriendRequestManageUrl());

    const expectedBase = BASE_PATH === "/" ? "" : BASE_PATH;
    assert.equal(url, `https://bot.example.org${expectedBase}/#friendrequests`);
    // Không được nhúng token/phiên vào liên kết.
    assert.doesNotMatch(url, /token|cookie|imei|session/i);
});

test("không biết origin thì KHÔNG dựng liên kết rác", () => {
    const url = withBaseUrl(undefined, () => main.buildFriendRequestManageUrl());
    assert.equal(url, null);
});

test("origin có dấu / thừa vẫn ghép đúng", () => {
    const url = withBaseUrl("https://bot.example.org///", () => main.buildFriendRequestManageUrl());
    assert.doesNotMatch(url, /\/\/#/);
    assert.match(url, /#friendrequests$/);
});

// ---------------------------------------------------------------------------
// Nội dung thông báo
// ---------------------------------------------------------------------------

test("thông báo lời mời mới có đủ tên, User ID, tài khoản, thời gian, trạng thái", () => {
    const text = withBaseUrl("https://bot.example.org", () =>
        main.friendRequestNotificationText(SAMPLE, ACCOUNT, { kind: "new_request" }));

    assert.match(text, /YÊU CẦU KẾT BẠN MỚI/);
    assert.match(text, /Nguyễn Văn A/);
    assert.match(text, /555/);
    assert.match(text, /ZCA Main/);
    assert.match(text, /Chờ xác nhận/);
    assert.match(text, /Xin chào, mình muốn kết bạn/);
    assert.match(text, /#friendrequests/);
});

test("thông báo khi đã tự động chấp nhận KHÔNG được nói là đang chờ", () => {
    const accepted = { ...SAMPLE, status: "accepted", processedMethod: "auto", processedAt: "2026-11-10T07:31:00.000Z" };
    const text = withBaseUrl("https://bot.example.org", () =>
        main.friendRequestNotificationText(accepted, ACCOUNT, { kind: "accepted" }));

    assert.match(text, /ĐÃ CHẤP NHẬN/);
    assert.match(text, /tự động/);
    assert.doesNotMatch(text, /Chờ xác nhận/, "không được trình bày lời mời đã xử lý như đang chờ");
});

test("thông báo lỗi nêu nguyên văn lý do", () => {
    const failed = { ...SAMPLE, status: "failed", lastError: "Zalo từ chối: quá nhiều thao tác" };
    const text = withBaseUrl("https://bot.example.org", () =>
        main.friendRequestNotificationText(failed, ACCOUNT, { kind: "failed" }));

    assert.match(text, /GẶP LỖI/);
    assert.match(text, /quá nhiều thao tác/);
});

test("không biết origin thì vẫn có hướng dẫn thay vì liên kết chết", () => {
    const text = withBaseUrl(undefined, () =>
        main.friendRequestNotificationText(SAMPLE, ACCOUNT, { kind: "new_request" }));

    assert.match(text, /Admin UI/);
    assert.doesNotMatch(text, /https?:\/\//, "không được gửi liên kết khi chưa biết tên miền");
});

test("tin thử nói rõ là tin thử, không tạo lời mời", () => {
    const text = withBaseUrl("https://bot.example.org", () =>
        main.friendRequestNotificationText(null, null, { test: true }));

    assert.match(text, /THỬ THÔNG BÁO/);
    assert.match(text, /không có lời mời kết bạn nào/);
});

// ---------------------------------------------------------------------------
// Người nhận
// ---------------------------------------------------------------------------

test("kênh bot chính thức không bao giờ trả về danh tính ZCA", () => {
    const recipients = main.resolveOfficialRecipients({});

    for (const item of recipients) {
        assert.doesNotMatch(String(item.botId), /^zca:/, "bot chính thức không thay thế được tài khoản cá nhân");
        assert.ok(item.chatId);
    }
});

test("lọc kênh bot chính thức theo botId được chọn", () => {
    const recipients = main.resolveOfficialRecipients({ botId: "bot1" });

    for (const item of recipients) {
        assert.equal(item.botId, "bot1");
    }
});

test("kênh ZCA từ chối gửi cho chính tài khoản đang gửi", () => {
    const result = main.resolveZcaRecipient({ ownUid: "1001" }, { chatId: "1001" });

    assert.equal(result.valid, false);
    assert.match(result.reason, /chính tài khoản/);
});

test("kênh ZCA nhận hội thoại chỉ định tay", () => {
    const result = main.resolveZcaRecipient({ ownUid: "1001" }, { chatId: "777" });

    assert.equal(result.valid, true);
    assert.equal(result.chatId, "777");
    assert.equal(result.source, "manual");
});

test("kênh ZCA dùng lại OWNER_USER_ID thay vì bắt nhập mới", () => {
    const previous = process.env.OWNER_USER_ID;
    process.env.OWNER_USER_ID = "888";
    try {
        const result = main.resolveZcaRecipient({ ownUid: "1001" }, {});
        assert.equal(result.valid, true);
        assert.equal(result.chatId, "888");
        assert.equal(result.source, "owner_user_id");
    } finally {
        if (previous === undefined) delete process.env.OWNER_USER_ID;
        else process.env.OWNER_USER_ID = previous;
    }
});

test("kênh ZCA bỏ qua OWNER_USER_ID trùng với chính tài khoản", () => {
    const previous = process.env.OWNER_USER_ID;
    process.env.OWNER_USER_ID = "1001";
    try {
        const result = main.resolveZcaRecipient({ ownUid: "1001" }, {});
        // Không có ứng viên nào khác ⇒ phải báo chưa có người nhận, không gửi cho chính mình.
        assert.notEqual(result.chatId, "1001");
        if (!result.valid) assert.match(String(result.reason), /User ID/);
    } finally {
        if (previous === undefined) delete process.env.OWNER_USER_ID;
        else process.env.OWNER_USER_ID = previous;
    }
});

test("tình trạng người nhận mô tả được cả hai kênh, không lộ bí mật phiên", () => {
    const described = main.describeFriendRequestRecipients();
    const serialized = JSON.stringify(described);

    assert.ok(described.official);
    assert.ok(described.zca);
    assert.equal(typeof described.official.valid, "boolean");
    assert.equal(typeof described.zca.valid, "boolean");
    assert.doesNotMatch(serialized, /cookie|imei|userAgent|zpsid/i);
});
