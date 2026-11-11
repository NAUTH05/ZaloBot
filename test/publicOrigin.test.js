// ============================================================================
// Test cho publicOrigin — origin công khai dùng khi gửi ảnh/tệp cho Zalo.
//
// Vì sao quan trọng: bot chính thức đưa URL cho Zalo Bot Platform và máy chủ Zalo
// phải tự tải. Nếu origin là localhost thì mọi lần gửi ảnh đều hỏng, và /help
// không bao giờ gửi được ảnh hướng dẫn.
// ============================================================================

// Bài test này KIỂM TRA việc ghi ra đĩa, nên phải bật cờ cho phép ghi.
// Các file test khác không bật, nên origin giả không bị lưu lại.
process.env.PUBLIC_ORIGIN_PERSIST = "1";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    PUBLIC_ORIGIN_FILE,
    buildMediaUrl,
    getPublicOrigin,
    isLoopbackUrl,
    isValidPublicOrigin,
    publicOriginFromRequest,
    rememberPublicOrigin
} = require("../publicOrigin");

// Sao lưu tệp origin thật để không để lại rác cho các lần chạy sau.
let backup = null;
test.before(() => {
    try { backup = fs.readFileSync(PUBLIC_ORIGIN_FILE, "utf8"); } catch (_) { backup = null; }
});
test.after(() => {
    try {
        if (backup === null) fs.rmSync(PUBLIC_ORIGIN_FILE, { force: true });
        else fs.writeFileSync(PUBLIC_ORIGIN_FILE, backup, "utf8");
    } catch (_) {}
});

test("isLoopbackUrl nhận diện địa chỉ chỉ mở được trên máy", () => {
    assert.equal(isLoopbackUrl("http://localhost:6003/api/media/x"), true);
    assert.equal(isLoopbackUrl("http://127.0.0.1:6003/x"), true);
    assert.equal(isLoopbackUrl("http://[::1]:6003/x"), true);
    assert.equal(isLoopbackUrl("https://zalobot.example.com/x"), false);
    assert.equal(isLoopbackUrl("không phải url"), false);
});

test("isValidPublicOrigin từ chối loopback và chuỗi rác", () => {
    assert.equal(isValidPublicOrigin("http://localhost:6003"), false);
    assert.equal(isValidPublicOrigin("http://127.0.0.1"), false);
    assert.equal(isValidPublicOrigin("ftp://example.com"), false);
    assert.equal(isValidPublicOrigin("example.com"), false);
    assert.equal(isValidPublicOrigin("https://zalobot.example.com"), true);
});

test("origin từ request: dùng Host khi không có proxy", () => {
    const origin = publicOriginFromRequest({ headers: { host: "zalobot.example.com" }, socket: {} });
    assert.equal(origin, "http://zalobot.example.com");
});

test("origin từ request: tôn trọng X-Forwarded-Proto và X-Forwarded-Host", () => {
    const origin = publicOriginFromRequest({
        headers: {
            "x-forwarded-proto": "https",
            "x-forwarded-host": "zalobot.example.com",
            host: "127.0.0.1:6003"
        },
        socket: {}
    });
    assert.equal(origin, "https://zalobot.example.com");
});

test("origin từ request: Host lạ không được ghép vào URL", () => {
    const origin = publicOriginFromRequest({ headers: { host: "evil.example.com/<script>" }, socket: {} });
    assert.equal(origin, "");
});

test("buildMediaUrl dùng origin truyền vào", () => {
    assert.equal(
        buildMediaUrl("abc", "https://bot.example.com"),
        "https://bot.example.com/api/media/abc"
    );
});

test("buildMediaUrl cắt dấu / thừa ở cuối origin", () => {
    assert.equal(
        buildMediaUrl("abc", "https://bot.example.com/"),
        "https://bot.example.com/api/media/abc"
    );
});

test("buildMediaUrl ghép đuôi tệp khi được yêu cầu", () => {
    // Zalo Bot Platform từ chối URL ảnh không có phần mở rộng ("File not found"),
    // nên đường gửi ảnh luôn truyền đuôi vào.
    assert.equal(
        buildMediaUrl("abc", "https://bot.example.com", "png"),
        "https://bot.example.com/api/media/abc.png"
    );
    assert.equal(
        buildMediaUrl("abc", "https://bot.example.com", ".jpg"),
        "https://bot.example.com/api/media/abc.jpg"
    );
});

test("rememberPublicOrigin lưu xuống đĩa để sống qua restart", () => {
    const saved = rememberPublicOrigin("https://help.example.com");
    assert.equal(saved, true);

    const raw = JSON.parse(fs.readFileSync(PUBLIC_ORIGIN_FILE, "utf8"));
    assert.equal(raw.baseUrl, "https://help.example.com");
    assert.ok(raw.savedAt, "phải có mốc thời gian");
});

test("rememberPublicOrigin BỎ QUA loopback để không ghi đè origin tốt", () => {
    rememberPublicOrigin("https://help.example.com");
    const accepted = rememberPublicOrigin("http://localhost:6003");

    assert.equal(accepted, false);
    const raw = JSON.parse(fs.readFileSync(PUBLIC_ORIGIN_FILE, "utf8"));
    assert.equal(raw.baseUrl, "https://help.example.com", "origin tốt phải được giữ nguyên");
});

test("getPublicOrigin trả origin đã ghi nhớ", () => {
    const oldEnv = process.env.ADMIN_BASE_URL;
    delete process.env.ADMIN_BASE_URL;
    try {
        rememberPublicOrigin("https://saved.example.com");
        assert.equal(getPublicOrigin(), "https://saved.example.com");
    } finally {
        if (oldEnv !== undefined) process.env.ADMIN_BASE_URL = oldEnv;
    }
});
