// Phân loại lệnh cho Command console của dashboard.
//
// Command console chạy lệnh với NGỮ CẢNH CỦA NGƯỜI ĐƯỢC CHỌN (userId/chatId
// của họ) nên phần trả lời thực sự được gửi tới chat của người đó, còn quyền
// hạn vẫn xét theo admin đang đăng nhập. Vì vậy chỉ những lệnh mà việc "chạy
// cho một người" là có nghĩa và an toàn mới được phép chọn nhiều người.
//
// Nguyên tắc phân loại:
//   per-user   lệnh đọc/ghi trạng thái gắn với một người hoặc một chat, và tác
//              động của nó chỉ ảnh hưởng trong phạm vi người đó.
//   broadcast  lệnh gửi tới MỌI chat đang hoạt động. Chạy một lần cho mỗi
//              người được chọn sẽ gửi trùng N lần, nên chỉ chạy đúng một lần.
//   none       lệnh toàn cục, chẩn đoán, hoặc chỉ có nghĩa với chính người gõ
//              lệnh. Chọn nhiều người là vô nghĩa hoặc nguy hiểm -> từ chối.
//
// Lệnh không có trong danh sách -> "none" (fail closed).

const TARGETING = {
    PER_USER: "per-user",
    BROADCAST: "broadcast",
    NONE: "none"
};

// Đọc/ghi trạng thái theo từng người, tác động khu trú trong ngữ cảnh đó.
const PER_USER_COMMANDS = new Set([
    "start",
    "luumssv",
    "lich",
    "lichtuan",
    "lichthi",
    "lichgv",
    "phongtrong",
    "nhanlich",
    "gionhanlich",
    "suagionhanlich",
    "xoagionhanlich",
    "tatnhanlich",
    "batnhaclich",
    "tatnhaclich",
    "trangthainhaclich",
    "ai",
    "help"
]);

// Gửi tới mọi chat đang hoạt động bất kể người được chọn là ai.
const BROADCAST_COMMANDS = new Set([
    "thongbao",
    "update",
    "test6h"
]);

// Lý do cụ thể cho từng lệnh không thể chọn đích, để thông báo lỗi hữu ích.
const NOT_TARGETABLE_REASONS = {
    time: "chỉ trả về giờ hệ thống của chính người gõ lệnh.",
    myid: "chỉ trả về User ID và Chat ID của chính người gõ lệnh.",
    blockbot: "thay đổi danh sách chặn toàn hệ thống, không gắn với một người.",
    unblockbot: "thay đổi danh sách chặn toàn hệ thống, không gắn với một người.",
    blockai: "thay đổi quyền dùng /ai toàn hệ thống.",
    unblockai: "thay đổi quyền dùng /ai toàn hệ thống.",
    allowbot: "thay đổi allowlist toàn hệ thống.",
    unallowbot: "thay đổi allowlist toàn hệ thống.",
    allowai: "thay đổi allowlist của /ai toàn hệ thống.",
    unallowai: "thay đổi allowlist của /ai toàn hệ thống.",
    accessmode: "đổi chế độ truy cập toàn hệ thống.",
    accesslist: "chỉ liệt kê danh sách chặn/allowlist toàn hệ thống.",
    quanlychat: "chỉ liệt kê danh sách chat.",
    chitietchat: "xem chi tiết một chat — hãy dùng Target Chat ID, không phải User ID.",
    tamdungchat: "tạm dừng một CHAT — hãy dùng Target Chat ID.",
    batlaichat: "bật lại một CHAT — hãy dùng Target Chat ID.",
    kiemtrachat: "gửi tin kiểm tra tới một CHAT — hãy dùng Target Chat ID.",
    xoachat: "xóa mềm một CHAT — hãy dùng Target Chat ID.",
    chatfeature: "ghi đè tính năng của một CHAT — hãy dùng Target Chat ID.",
    helpadmin: "chỉ hiển thị trợ giúp quản trị cho chính người gõ lệnh."
};

// Bí danh được quy về tên chính tắc trước khi phân loại, nên lệnh cũ và lệnh
// mới luôn có cùng cách xử lý và không bao giờ bị chạy hai lần.
const { resolveCommandName } = require("./helpContent");

function normalizeCommandName(value) {
    return resolveCommandName(value);
}

// Trả về { mode, reason, broadcastScope } cho một tên lệnh.
function resolveCommandTargeting(rawCommand) {
    const name = normalizeCommandName(rawCommand);
    if (!name) {
        return { command: "", mode: TARGETING.NONE, reason: "Thiếu tên lệnh." };
    }

    if (BROADCAST_COMMANDS.has(name)) {
        return {
            command: name,
            mode: TARGETING.BROADCAST,
            reason: null,
            // Giải thích phạm vi để giao diện hiển thị trước khi xác nhận.
            broadcastScope: "Lệnh này gửi tới mọi chat đang hoạt động, nên hệ thống chỉ chạy đúng một lần dù bạn chọn bao nhiêu người."
        };
    }

    if (PER_USER_COMMANDS.has(name)) {
        return { command: name, mode: TARGETING.PER_USER, reason: null };
    }

    const specific = NOT_TARGETABLE_REASONS[name];
    return {
        command: name,
        mode: TARGETING.NONE,
        reason: specific
            ? `Lệnh /${name} không chạy theo từng người được: ${specific}`
            : `Lệnh /${name} không nằm trong danh sách lệnh chạy theo từng người, nên không thể chọn nhiều người nhận.`
    };
}

function isPerUserCommand(rawCommand) {
    return resolveCommandTargeting(rawCommand).mode === TARGETING.PER_USER;
}

function isBroadcastCommand(rawCommand) {
    return resolveCommandTargeting(rawCommand).mode === TARGETING.BROADCAST;
}

module.exports = {
    BROADCAST_COMMANDS,
    NOT_TARGETABLE_REASONS,
    PER_USER_COMMANDS,
    TARGETING,
    isBroadcastCommand,
    isPerUserCommand,
    normalizeCommandName,
    resolveCommandTargeting
};
