// ============================================================================
// Dấu thời gian Việt Nam cho log của tiến trình (PM2 / terminal).
//
// Vì sao cần: `pm2 logs` in dấu thời gian bằng múi giờ của DAEMON PM2, không phải
// của ứng dụng. Đặt TZ trong ecosystem.config.cjs chỉ đổi giờ bên trong tiến
// trình; trên VPS để UTC thì mọi dòng log vẫn hiện giờ UTC — người vận hành đọc
// một lần gửi lúc 06:30 thành 23:30 của hôm trước và tưởng lịch chạy sai.
//
// Cách sửa không phụ thuộc cấu hình máy: mỗi dòng log do chính tiến trình ghi
// kèm dấu thời gian Asia/Ho_Chi_Minh. Nhờ vậy log đúng giờ kể cả khi daemon PM2
// chạy ở múi giờ khác, và không cần khởi động lại daemon.
//
// Chỉ áp dụng cho tiến trình thật: `installVietnamLogTimestamps()` được gọi
// trong nhánh chạy runtime, không gọi khi nạp module để kiểm thử.
// ============================================================================

const { getVietnamDateInfo } = require("./timezone");

// Dấu thời gian đã có sẵn thì không ghép thêm lần nữa (tránh "[..] [..] nội dung"
// khi một lớp khác cũng đã thêm tiền tố).
const STAMP_PATTERN = /^\[\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}\]/;
const METHODS = ["log", "info", "warn", "error", "debug"];

function formatLogStamp(date = new Date()) {
    const info = getVietnamDateInfo(date);
    return `[${info.formattedDate} ${info.hour}:${info.minute}:${info.second}]`;
}

// Ghép tiền tố vào ĐÚNG đối số đầu tiên khi nó là chuỗi, để các chuỗi định dạng
// kiểu console.log("%s", value) vẫn hoạt động như trước.
function withStamp(stamp, args) {
    const [first, ...rest] = args;
    if (typeof first === "string") {
        if (STAMP_PATTERN.test(first)) return args;
        return [`${stamp} ${first}`, ...rest];
    }
    return [stamp, ...args];
}

function installVietnamLogTimestamps(options = {}) {
    const target = options.console || console;
    if (!target || target.__zalobotVietnamLog === true) return false;
    const now = typeof options.now === "function" ? options.now : () => new Date();

    for (const method of METHODS) {
        const original = target[method];
        if (typeof original !== "function") continue;
        const wrapped = (...args) => original.apply(target, withStamp(formatLogStamp(now()), args));
        wrapped.__zalobotOriginal = original;
        target[method] = wrapped;
    }

    target.__zalobotVietnamLog = true;
    return true;
}

module.exports = {
    STAMP_PATTERN,
    formatLogStamp,
    installVietnamLogTimestamps
};
