// ============================================================================
// Lưu phiên đăng nhập ZCA.
//
// Phiên ZCA là thông tin xác thực nhạy cảm: có nó là đăng nhập được vào tài khoản
// Zalo cá nhân. Vì vậy:
//   - ghi NGUYÊN TỬ (ghi file tạm rồi đổi tên) để PM2 restart không làm hỏng phiên;
//   - quyền file hạn chế (0600) trên hệ thống hỗ trợ;
//   - KHÔNG BAO GIỜ ghi cookie/imei/userAgent ra log hay API;
//   - thư mục phiên phải nằm trong .gitignore.
//
// Hình dạng phiên đúng theo zca-js: { imei, cookie, userAgent, language? } —
// chính là những gì `Zalo.login(credentials)` cần và `GotLoginInfo` trả về.
// ============================================================================
const fs = require("fs");
const path = require("path");

const SESSION_FILE_NAME = "session.json";
const LOCK_FILE_NAME = "session.lock";

function resolveSessionDir(configuredPath) {
    const raw = String(configuredPath || "").trim();
    if (!raw) return path.join(__dirname, "..", "..", "data", "zca-session");
    return path.isAbsolute(raw) ? raw : path.join(__dirname, "..", "..", raw);
}

function sessionFilePath(dir) {
    return path.join(dir, SESSION_FILE_NAME);
}

function lockFilePath(dir) {
    return path.join(dir, LOCK_FILE_NAME);
}

// Ghi nguyên tử: file tạm cùng thư mục rồi rename. rename trên cùng ổ đĩa là thao
// tác nguyên tử nên không bao giờ để lại file phiên cụt.
function writeJsonAtomic(filePath, value, mode = 0o600) {
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode });
    try {
        fs.chmodSync(tempPath, mode);
    } catch (_) {
        // Windows không hỗ trợ đầy đủ chmod; bỏ qua chứ không làm hỏng việc ghi.
    }
    fs.renameSync(tempPath, filePath);
}

function readSession(dir) {
    const file = sessionFilePath(dir);
    try {
        if (!fs.existsSync(file)) return null;
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        // Chỉ nhận phiên có đủ ba trường zca-js yêu cầu.
        if (!parsed || typeof parsed !== "object") return null;
        if (!parsed.imei || !parsed.cookie || !parsed.userAgent) return null;
        return {
            imei: parsed.imei,
            cookie: parsed.cookie,
            userAgent: parsed.userAgent,
            language: parsed.language,
            savedAt: parsed.savedAt || null,
            uid: parsed.uid || null
        };
    } catch (error) {
        console.warn(`[ZCA] Không đọc được phiên đã lưu (${error.message}); sẽ cần đăng nhập lại.`);
        return null;
    }
}

function saveSession(dir, credentials, meta = {}) {
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(sessionFilePath(dir), {
        imei: credentials.imei,
        cookie: credentials.cookie,
        userAgent: credentials.userAgent,
        language: credentials.language,
        uid: meta.uid || null,
        savedAt: new Date().toISOString()
    });
    return sessionFilePath(dir);
}

function clearSession(dir) {
    const file = sessionFilePath(dir);
    try {
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
        return true;
    } catch (error) {
        console.warn(`[ZCA] Không xoá được phiên (${error.message}).`);
        return false;
    }
}

// Khóa để hai tiến trình không dùng chung một phiên cùng lúc. zca-js dùng chung
// một kết nối WebSocket cho mỗi phiên; hai tiến trình cùng phiên sẽ đá nhau
// (CloseReason.DuplicateConnection = 3000).
function acquireLock(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const file = lockFilePath(dir);
    const payload = { pid: process.pid, startedAt: new Date().toISOString() };

    try {
        if (fs.existsSync(file)) {
            const existing = JSON.parse(fs.readFileSync(file, "utf8"));
            if (existing?.pid && existing.pid !== process.pid) {
                // Tiến trình cũ còn sống không?
                try {
                    process.kill(existing.pid, 0);
                    return { ok: false, reason: `tiến trình ${existing.pid} đang dùng phiên này` };
                } catch (_) {
                    // Tiến trình cũ đã chết ⇒ khóa cũ, chiếm lại.
                }
            }
        }
        writeJsonAtomic(file, payload, 0o600);
        return { ok: true };
    } catch (error) {
        // Không giành được khóa vì lý do khác cũng không nên chặn khởi động.
        return { ok: false, reason: error.message };
    }
}

function releaseLock(dir) {
    try {
        const file = lockFilePath(dir);
        if (!fs.existsSync(file)) return;
        const existing = JSON.parse(fs.readFileSync(file, "utf8"));
        // Chỉ xoá khóa của chính mình.
        if (existing?.pid === process.pid) fs.rmSync(file, { force: true });
    } catch (_) {
        // Bỏ qua: khóa cũ sẽ được chiếm lại ở lần khởi động sau.
    }
}

// Mô tả phiên KHÔNG chứa bí mật — dùng cho log, API và dashboard.
function describeSession(dir) {
    const session = readSession(dir);
    if (!session) return { present: false };
    return {
        present: true,
        uid: session.uid || null,
        savedAt: session.savedAt || null,
        // Chỉ cho biết có bao nhiêu cookie, không bao giờ trả nội dung cookie.
        cookieCount: Array.isArray(session.cookie) ? session.cookie.length : null
    };
}

module.exports = {
    LOCK_FILE_NAME,
    SESSION_FILE_NAME,
    acquireLock,
    clearSession,
    describeSession,
    lockFilePath,
    readSession,
    releaseLock,
    resolveSessionDir,
    saveSession,
    sessionFilePath
};
