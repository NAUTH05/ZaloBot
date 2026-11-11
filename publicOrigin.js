// ============================================================================
// Origin công khai của dashboard.
//
// Vì sao cần khái niệm này: bot chính thức gửi ảnh/tệp bằng cách đưa URL cho
// Zalo Bot Platform, và máy chủ Zalo phải TỰ TẢI URL đó về. Một địa chỉ
// http://localhost:6003 chỉ mở được trên chính VPS nên mọi lần gửi đều hỏng.
//
// Nguồn sự thật, theo thứ tự ưu tiên:
//   1. ADMIN_BASE_URL trong .env (cấu hình tường minh, luôn thắng).
//   2. Origin của request dashboard gần nhất (X-Forwarded-* / Host).
//   3. Origin đã lưu trong data/public-origin.json (sống qua restart).
//
// Vì sao phải lưu xuống đĩa: /help gửi ảnh theo yêu cầu người dùng, không có
// request dashboard đi kèm. Nếu chỉ giữ trong bộ nhớ thì sau mỗi lần restart, ảnh
// hướng dẫn sẽ lặng lẽ không gửi được cho tới khi quản trị viên mở dashboard.
// ============================================================================
const fs = require("fs");
const path = require("path");

const PUBLIC_ORIGIN_FILE = path.join(__dirname, "data", "public-origin.json");

function isLoopbackUrl(url) {
    try {
        const host = new URL(String(url)).hostname.toLowerCase();
        return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    } catch (_) {
        return false;
    }
}

// Một origin hợp lệ: http/https, có host, KHÔNG phải loopback.
function isValidPublicOrigin(value) {
    const text = String(value || "").trim();
    if (!/^https?:\/\/[^\s/]+$/i.test(text)) return false;
    return !isLoopbackUrl(text);
}

function loadPersistedOrigin() {
    try {
        const raw = fs.readFileSync(PUBLIC_ORIGIN_FILE, "utf8");
        const value = String(JSON.parse(raw)?.baseUrl || "").trim();
        return isValidPublicOrigin(value) ? value.replace(/\/+$/, "") : null;
    } catch (_) {
        return null;
    }
}

// Có được ghi ra đĩa hay không.
//
// Trong tiến trình kiểm thử thì KHÔNG: các bài test dùng origin giả
// (bot.example.com), nếu ghi lại thì giá trị đó tồn tại trên đĩa và lần chạy
// thật sau đó sẽ gửi ảnh với một tên miền không tồn tại.
function persistenceEnabled() {
    if (process.env.PUBLIC_ORIGIN_PERSIST === "0") return false;
    if (process.env.PUBLIC_ORIGIN_PERSIST === "1") return true;
    return !process.env.NODE_TEST_CONTEXT;
}

// Tên miền dành riêng cho tài liệu/kiểm thử (RFC 2606, RFC 6761). Không bao giờ
// lưu những origin này: chúng chỉ xuất hiện khi chạy test, và nếu nằm lại trên
// đĩa thì lần chạy thật sẽ gửi ảnh tới một tên miền không tồn tại.
function isReservedOrigin(value) {
    try {
        const host = new URL(String(value)).hostname.toLowerCase();
        return /(^|\.)example\.(com|org|net)$/.test(host)
            || /\.(test|invalid|localhost)$/.test(host);
    } catch (_) {
        return true;
    }
}

function persistOrigin(value) {
    if (!persistenceEnabled()) return;
    // Cờ "1" là do bài test ghi-ra-đĩa đặt: khi đó cho phép cả tên miền ví dụ.
    if (process.env.PUBLIC_ORIGIN_PERSIST !== "1" && isReservedOrigin(value)) return;
    try {
        fs.mkdirSync(path.dirname(PUBLIC_ORIGIN_FILE), { recursive: true });
        const temporaryPath = `${PUBLIC_ORIGIN_FILE}.tmp`;
        fs.writeFileSync(
            temporaryPath,
            JSON.stringify({ baseUrl: value, savedAt: new Date().toISOString() }),
            "utf8"
        );
        fs.renameSync(temporaryPath, PUBLIC_ORIGIN_FILE);
    } catch (error) {
        console.warn(`[Media] không lưu được origin công khai: ${error.message}`);
    }
}

let cachedOrigin = String(process.env.ADMIN_BASE_URL || "").trim().replace(/\/+$/, "")
    || loadPersistedOrigin()
    || null;

// Ghi nhớ origin. Bỏ qua loopback: nó không dùng được cho Zalo và sẽ ghi đè một
// origin tốt đã lưu.
function rememberPublicOrigin(baseUrl) {
    const value = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!isValidPublicOrigin(value)) return false;
    if (cachedOrigin === value) return true;
    cachedOrigin = value;
    persistOrigin(value);
    return true;
}

function getPublicOrigin() {
    const configured = String(process.env.ADMIN_BASE_URL || "").trim().replace(/\/+$/, "");
    if (configured) return configured;
    return cachedOrigin || null;
}

// Suy ra origin từ chính request đang phục vụ dashboard.
function publicOriginFromRequest(request) {
    const configured = String(process.env.ADMIN_BASE_URL || "").trim().replace(/\/+$/, "");
    if (configured) return configured;

    const forwardedProto = String(request.headers?.["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
    const proto = forwardedProto === "https" || forwardedProto === "http"
        ? forwardedProto
        : (request.socket?.encrypted ? "https" : "http");

    const rawHost = String(request.headers?.["x-forwarded-host"] || request.headers?.host || "").split(",")[0].trim();
    // Host do client gửi lên ⇒ lọc trước khi ghép vào URL đem đi gửi cho Zalo.
    if (!/^[A-Za-z0-9.\-:[\]]+$/.test(rawHost)) return "";

    return `${proto}://${rawHost}`;
}

// URL công khai cho một media. baseOverride thắng mọi nguồn khác.
//
// `extension` nên được truyền vào: Zalo Bot Platform từ chối URL ảnh không có
// phần mở rộng (báo "File not found" dù máy chủ trả 200). Đường dẫn không đuôi
// vẫn được phục vụ để không phá các liên kết cũ.
function buildMediaUrl(mediaId, baseOverride = null, extension = null) {
    if (!mediaId) return null;
    const base = String(baseOverride || "").trim().replace(/\/+$/, "")
        || getPublicOrigin()
        || `http://localhost:${process.env.ADMIN_PORT || 3000}`;
    const suffix = extension ? `.${String(extension).replace(/^\./, "")}` : "";
    return `${base}/api/media/${mediaId}${suffix}`;
}

module.exports = {
    PUBLIC_ORIGIN_FILE,
    buildMediaUrl,
    getPublicOrigin,
    isLoopbackUrl,
    isValidPublicOrigin,
    publicOriginFromRequest,
    rememberPublicOrigin
};
