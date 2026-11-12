// Chuẩn hoá câu lệnh + phân tích nhiều lệnh trong một tin nhắn.
//
// Nguyên tắc: phần này là MÃ TẤT ĐỊNH, không gọi AI và không tốn token. Mọi câu
// người dùng gõ mà máy hiểu chắc chắn được thì xử lý ngay tại đây; chỉ những câu
// thật sự cần hiểu ngôn ngữ tự nhiên mới đi tiếp sang trợ lý AI.
//
// Module này KHÔNG require lớp lưu trữ (firestorePersistence) để bộ kiểm tra nạp
// được mà không cần Firestore giả. Nó chỉ dùng helpContent.js (thuần dữ liệu) và
// mentionUtils.js (thuần chuỗi).

const { COMMAND_ALIASES, findHelpCommand } = require("../helpContent");
const { foldText } = require("../mentionUtils");
const { resolveWeekRequest } = require("../scheduleWeek");

const TARGET_DAY = Object.freeze({
    TODAY: "today",
    TOMORROW: "tomorrow"
});

const TARGET_DAY_OFFSET = Object.freeze({
    [TARGET_DAY.TODAY]: 0,
    [TARGET_DAY.TOMORROW]: 1
});

const OFFSET_TARGET_DAY = Object.freeze({
    0: TARGET_DAY.TODAY,
    1: TARGET_DAY.TOMORROW
});

// Lệnh có thể gộp vào một kế hoạch nhiều hành động. Chỉ những lệnh dưới đây mới
// được tách khỏi câu: /feedback, /thongbao, /blockbot… nhận văn bản tự do nên
// tách theo dấu phẩy sẽ cắt nát nội dung của người dùng.
const COMMAND_TO_ACTION = Object.freeze({
    luumssv: "save_mssv",
    nhanlich: "register_notification",
    gionhanlich: "list_notifications",
    suagionhanlich: "update_notification",
    xoagionhanlich: "delete_notification",
    tatnhanlich: "disable_notifications",
    batnhaclich: "enable_class_start_notifications",
    tatnhaclich: "disable_class_start_notifications",
    lich: "get_today_schedule",
    lichtuan: "get_week_schedule",
    lichthi: "get_exam_schedule",
    help: "help"
});

// Lệnh KHÔNG nhận diện khi thiếu dấu "/".
//
// Đây là các tên TRÙNG với từ tiếng Việt thường ngày (hoặc từ tiếng Anh rất phổ
// biến). "lịch mai thế nào" không phải lệnh /lich; "ai là giảng viên môn này"
// không phải lệnh /ai. Nhận diện chúng sẽ biến câu nói bình thường thành lệnh và
// tạo ra câu trả lời không ai yêu cầu — đúng loại lỗi mà cổng nhóm phải chặn.
// Người dùng vẫn dùng được đầy đủ khi gõ dấu "/".
const NO_SLASH_EXCLUDED = new Set(["ai", "lich", "time", "help", "start", "update"]);

const SEPARATOR_PATTERN = /[,;\n]+/;
const CONJUNCTION_PATTERN = /\s+(?:và|va|rồi|roi|sau\s+đó|sau\s+do)\s+/;

function compactText(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

// "6:00" | "06:00" | "6h" | "6 giờ" | "600" | "6" → "06:00"
//
// Chỉ ĐỊNH DẠNG lại. Việc kiểm tra tính hợp lệ vẫn do normalizeNotificationTime()
// trong subscriptions.js quyết định (00:00–23:59), nên chuẩn hoá ở đây không làm
// yếu bất kỳ kiểm tra nào.
function normalizeTimeToken(value) {
    const raw = foldText(compactText(value));
    if (!raw) return null;

    let hour;
    let minute;
    let match = raw.match(/^(\d{1,2})\s*[:hg]\s*(\d{1,2})$/);
    if (match) {
        hour = Number(match[1]);
        minute = Number(match[2]);
    } else if ((match = raw.match(/^(\d{1,2})\s*(?:h|gio)$/))) {
        hour = Number(match[1]);
        minute = 0;
    } else if ((match = raw.match(/^(\d{3,4})$/))) {
        const digits = match[1].padStart(4, "0");
        hour = Number(digits.slice(0, 2));
        minute = Number(digits.slice(2));
    } else if ((match = raw.match(/^(\d{1,2})$/))) {
        hour = Number(match[1]);
        minute = 0;
    } else {
        return null;
    }

    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// Bỏ dấu "/" đầu câu, ngoặc vuông quanh đối số và các dấu câu thừa ở cuối.
// Người dùng hay dán cú pháp từ /help nên "[123456789]" phải hiểu như "123456789".
function normalizeArgument(value) {
    return compactText(
        String(value == null ? "" : value)
            .replace(/[[\]]/g, " ")
            .replace(/[.,;:!?]+$/g, " ")
    );
}

function normalizeTargetDayToken(value) {
    const compact = foldText(value).replace(/[^a-z]/g, "");
    if (compact === "homnay" || compact === "hnay") return TARGET_DAY.TODAY;
    if (compact === "homsau" || compact === "ngaymai" || compact === "mai") return TARGET_DAY.TOMORROW;
    return null;
}

// Lấy token ngày đích ở CUỐI đối số, chấp nhận "homnay" hoặc "hôm nay".
function takeTargetDay(tokens) {
    if (tokens.length === 0) return { day: null, length: 0 };
    const single = normalizeTargetDayToken(tokens[tokens.length - 1]);
    if (single) return { day: single, length: 1 };
    if (tokens.length >= 2) {
        const pair = normalizeTargetDayToken(tokens.slice(-2).join(""));
        if (pair) return { day: pair, length: 2 };
    }
    return { day: null, length: 0 };
}

function parsePositiveId(value) {
    const match = String(value == null ? "" : value).trim().match(/^#?(\d+)$/);
    if (!match) return null;
    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id >= 1 ? id : null;
}

function looksLikeStudentId(value) {
    return /^\d{9}$/.test(String(value == null ? "" : value).trim());
}

// Tên lệnh: bỏ "/" đầu câu, gộp tối đa hai token đầu khi người dùng gõ có dấu và
// có khoảng trắng ("nhận lịch" → nhanlich). Chỉ nhận tên có thật trong sổ lệnh.
function resolveCommandToken(tokens, { requireSlash = false } = {}) {
    if (tokens.length === 0) return null;

    const candidates = [tokens[0]];
    if (tokens.length >= 2) candidates.push(`${tokens[0]}${tokens[1]}`);

    for (let index = 0; index < candidates.length; index += 1) {
        const rawName = foldText(candidates[index]).replace(/[^a-z0-9]/g, "");
        if (!rawName) continue;
        const canonical = COMMAND_ALIASES[rawName];
        if (!canonical) continue;
        if (requireSlash && NO_SLASH_EXCLUDED.has(canonical)) continue;
        return { command: canonical, consumed: index + 1 };
    }
    return null;
}

function buildSaveMssvAction(argument) {
    const studentId = normalizeArgument(argument).replace(/\s+/g, "");
    if (!studentId) return { error: "missing_student_id" };
    if (!looksLikeStudentId(studentId)) return { error: "invalid_student_id" };
    return { action: { type: "save_mssv", student_id: studentId } };
}

// /nhanlich [MSSV] hh:mm homnay|homsau
function buildRegisterNotificationAction(argument) {
    const tokens = normalizeArgument(argument).split(" ").filter(Boolean);
    if (tokens.length === 0) return { error: "missing_time_and_day" };

    const day = takeTargetDay(tokens);
    if (!day.day) return { error: "missing_target_day" };

    const rest = tokens.slice(0, tokens.length - day.length);
    if (rest.length === 0) return { error: "missing_time" };

    const time = normalizeTimeToken(rest[rest.length - 1]);
    if (!time) return { error: "invalid_time" };

    const studentTokens = rest.slice(0, -1);
    const action = { type: "register_notification", time, target_day: day.day };
    if (studentTokens.length === 1) {
        if (!looksLikeStudentId(studentTokens[0])) return { error: "invalid_student_id" };
        action.student_id = studentTokens[0];
    } else if (studentTokens.length > 1) {
        return { error: "invalid_arguments" };
    }
    return { action };
}

// /suagionhanlich ID [hh:mm] homnay|homsau
function buildUpdateNotificationAction(argument) {
    const tokens = normalizeArgument(argument).split(" ").filter(Boolean);
    if (tokens.length === 0) return { error: "missing_id" };

    const id = parsePositiveId(tokens[0]);
    if (id == null) return { error: "invalid_id" };

    const rest = tokens.slice(1);
    if (rest.length === 0) return { error: "missing_target_day" };

    const day = takeTargetDay(rest);
    const beforeDay = day.length > 0 ? rest.slice(0, rest.length - day.length) : rest;
    const action = { type: "update_notification", id };
    if (day.day) action.target_day = day.day;

    if (beforeDay.length > 1) return { error: "invalid_arguments" };
    if (beforeDay.length === 1) {
        const time = normalizeTimeToken(beforeDay[0]);
        if (!time) return { error: "invalid_time" };
        action.time = time;
    }
    if (!action.target_day && !action.time) return { error: "missing_target_day" };
    return { action };
}

function buildDeleteNotificationAction(argument) {
    const id = parsePositiveId(normalizeArgument(argument));
    if (id == null) return { error: "invalid_id" };
    return { action: { type: "delete_notification", id } };
}

function buildScheduleAction(type, argument) {
    const trimmed = normalizeArgument(argument).replace(/\s+/g, "");
    if (!trimmed) return { action: { type } };
    if (!looksLikeStudentId(trimmed)) return { error: "invalid_student_id" };
    return { action: { type, student_id: trimmed } };
}

// "lichtuan", "lichtuan tuan sau", "lichtuan 3", "lichtuan 123456789 tuan sau nua".
// Phần tuần đi CUỐI câu (giống /lich), nên phải thử cụm dài trước — "tuần sau nữa"
// là ba token, thử ngắn trước sẽ bỏ rơi chữ "nữa".
function buildWeekScheduleAction(argument) {
    const trimmed = normalizeArgument(argument);
    if (!trimmed) return { action: { type: "get_week_schedule" } };

    const tokens = trimmed.split(/\s+/).filter(Boolean);
    for (const size of [3, 2, 1]) {
        if (tokens.length < size) continue;
        const request = resolveWeekRequest(tokens.slice(-size).join(" "));
        if (!request) continue;
        const head = tokens.slice(0, tokens.length - size).join("");
        if (head && !looksLikeStudentId(head)) return { error: "invalid_student_id" };
        return {
            action: {
                type: "get_week_schedule",
                ...(head ? { student_id: head } : {}),
                week_offset: request.startOffset,
                weeks: request.weeks
            }
        };
    }

    const single = tokens.join("");
    if (looksLikeStudentId(single)) return { action: { type: "get_week_schedule", student_id: single } };
    return { error: "invalid_week" };
}

function buildHelpAction(argument) {
    const name = foldText(normalizeArgument(argument)).replace(/^\//, "").trim();
    if (!name) return { action: { type: "help" } };
    const entry = findHelpCommand(name);
    if (!entry) return { error: "unknown_command" };
    return { action: { type: "help", command: entry.command } };
}

const ACTION_BUILDERS = {
    save_mssv: buildSaveMssvAction,
    register_notification: buildRegisterNotificationAction,
    update_notification: buildUpdateNotificationAction,
    delete_notification: buildDeleteNotificationAction,
    disable_notifications: () => ({ action: { type: "disable_notifications" } }),
    enable_class_start_notifications: () => ({ action: { type: "enable_class_start_notifications" } }),
    disable_class_start_notifications: () => ({ action: { type: "disable_class_start_notifications" } }),
    get_today_schedule: (argument) => buildScheduleAction("get_today_schedule", argument),
    get_week_schedule: (argument) => buildWeekScheduleAction(argument),
    get_exam_schedule: (argument) => buildScheduleAction("get_exam_schedule", argument),
    list_notifications: () => ({ action: { type: "list_notifications" } }),
    help: buildHelpAction
};

function buildActionForCommand(command, argument) {
    const actionType = COMMAND_TO_ACTION[command];
    if (!actionType) return { error: "unsupported_command" };
    const builder = ACTION_BUILDERS[actionType];
    if (!builder) return { error: "unsupported_command" };
    const built = builder(argument);
    if (built.error) return { error: built.error, actionType };
    return { action: built.action, actionType };
}

// Một đoạn văn bản có phải là một lệnh đã biết không.
// Trả về { command, argument } hoặc null.
function parseCommandSegment(segment, { requireSlash = false } = {}) {
    const raw = compactText(segment);
    if (!raw) return null;

    const hadSlash = raw.startsWith("/");
    const withoutSlash = hadSlash ? raw.slice(1) : raw;
    const tokens = withoutSlash.split(" ").filter(Boolean);
    const resolved = resolveCommandToken(tokens, { requireSlash: requireSlash && !hadSlash });
    if (!resolved) return null;

    const argument = normalizeArgument(tokens.slice(resolved.consumed).join(" "));
    return { command: resolved.command, argument };
}

// Phân tích MỘT lệnh không có dấu "/". Dùng để đưa về đúng đường xử lý lệnh cũ.
//
// Điều kiện cuối cùng: đối số phải dựng được THÀNH MỘT HÀNH ĐỘNG HỢP LỆ.
//
// Vì sao chặt như vậy: "Nhận lịch lúc 9 giờ tối hôm sau" là một CÂU, không phải
// lệnh. Nếu chỉ so khớp hai chữ đầu ("nhận"+"lịch" → nhanlich) rồi đưa sang engine
// lệnh, người dùng nhận "SAI CÚ PHÁP" cho một câu nói bình thường — đúng lỗi đã
// gặp. Câu không dựng được hành động thì để trợ lý AI xử lý.
//
// Chỉ nhận nhóm lệnh CÔNG KHAI có thể gộp lô (COMMAND_TO_ACTION). Lệnh quản trị
// như /thongbao, /update, /xoachat cố ý không được nhận diện khi thiếu "/": một
// tin nhắn lan man của quản trị viên không được biến thành đợt phát tin cho toàn
// bộ người dùng chỉ vì nó bắt đầu bằng một từ trùng tên lệnh.
function parseSingleCommand(text) {
    const segment = parseCommandSegment(text, { requireSlash: true });
    if (!segment) return null;
    if (!findHelpCommand(segment.command)) return null;
    if (!isBatchableCommand(segment.command)) return null;
    const built = buildActionForCommand(segment.command, segment.argument);
    if (built.error) return null;
    return segment;
}

// "Có vẻ là lệnh nhưng chưa đủ chắc": tên lệnh đúng, đối số chưa dựng được hành
// động. Chỉ dùng làm ĐƯỜNG DỰ PHÒNG khi trợ lý AI không xử lý được (tắt/chưa cấu
// hình), để người dùng nhận hướng dẫn cú pháp thay vì im lặng.
function parseCommandHint(text) {
    const segment = parseCommandSegment(text, { requireSlash: true });
    if (!segment) return null;
    if (!isBatchableCommand(segment.command)) return null;
    return buildActionForCommand(segment.command, segment.argument).error ? segment : null;
}

function splitSegments(text, { conjunction = false } = {}) {
    const source = String(text == null ? "" : text);
    const parts = source.split(SEPARATOR_PATTERN);
    const segments = [];
    for (const part of parts) {
        if (!conjunction) {
            segments.push(part);
            continue;
        }
        for (const piece of part.split(CONJUNCTION_PATTERN)) segments.push(piece);
    }
    return segments.map((item) => compactText(item)).filter(Boolean);
}

function isBatchableCommand(command) {
    return Boolean(COMMAND_TO_ACTION[command]);
}

// Phân tích kế hoạch nhiều lệnh.
//
// Trả về null khi câu không phải là một lô lệnh chắc chắn — nghĩa là khi có bất kỳ
// đoạn nào không nhận diện được là lệnh, ta KHÔNG tách câu. Đây là ràng buộc an
// toàn: không bao giờ chạy văn bản tự do như một lệnh.
//
// Kết quả:
//   { actions: [...], invalid: [{ index, text, error }], segments }
function parseMultiCommandPlan(text, options = {}) {
    const maxActions = Number(options.maxActions) > 0 ? Number(options.maxActions) : 10;

    const attempts = [splitSegments(text), splitSegments(text, { conjunction: true })];
    for (const segments of attempts) {
        if (segments.length < 2) continue;

        const parsed = [];
        let allRecognised = true;
        for (const segment of segments) {
            const command = parseCommandSegment(segment);
            if (!command || !isBatchableCommand(command.command)) {
                allRecognised = false;
                break;
            }
            parsed.push({ segment, ...command });
        }
        if (!allRecognised) continue;

        const actions = [];
        const invalid = [];
        parsed.forEach((item, index) => {
            const built = buildActionForCommand(item.command, item.argument);
            if (built.error) invalid.push({ index, text: item.segment, error: built.error, command: item.command });
            else actions.push({ ...built.action, sourceCommand: item.command, sourceText: item.segment });
        });

        return { actions, invalid, segments: parsed.map((item) => item.segment), truncated: actions.length > maxActions };
    }

    return null;
}

function targetDayToOffset(targetDay) {
    return TARGET_DAY_OFFSET[targetDay] ?? null;
}

function offsetToTargetDay(offset) {
    return OFFSET_TARGET_DAY[Number(offset)] || TARGET_DAY.TODAY;
}

module.exports = {
    ACTION_BUILDERS,
    COMMAND_TO_ACTION,
    NO_SLASH_EXCLUDED,
    TARGET_DAY,
    TARGET_DAY_OFFSET,
    buildActionForCommand,
    compactText,
    isBatchableCommand,
    looksLikeStudentId,
    normalizeArgument,
    normalizeTargetDayToken,
    normalizeTimeToken,
    offsetToTargetDay,
    parseCommandSegment,
    parseCommandHint,
    parseMultiCommandPlan,
    parseSingleCommand,
    takeTargetDay,
    targetDayToOffset
};
