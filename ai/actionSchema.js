// Lược đồ phản hồi của trợ lý AI và danh sách hành động được phép.
//
// Đây là ranh giới an ninh quan trọng nhất của toàn bộ tính năng: mô hình chỉ được
// TRẢ VỀ dữ liệu, không bao giờ được gọi hàm. Mọi thứ mô hình trả về đều phải đi
// qua hàm kiểm tra ở đây trước khi backend làm bất cứ việc gì.
//
// Nguyên tắc:
//   - Danh sách hành động là allowlist đóng. Loại lạ ⇒ từ chối.
//   - Thuộc tính lạ ⇒ từ chối (không "bỏ qua cho nhanh"), để một trường như
//     `isAdmin: true` không thể lọt qua rồi bị dùng ở nơi khác.
//   - `botId` / `chatId` / `userId` KHÔNG BAO GIỜ được nhận từ mô hình. Chúng
//     luôn lấy từ sự kiện Zalo thật.
//   - Không có hành động nào chạm tới quản trị, quyền hạn, Firestore thô, shell,
//     tệp tin hay HTTP tuỳ ý.

const { findHelpCommand } = require("../helpContent");
const { normalizeTimeToken } = require("./commandNormalizer");

const DECISION = Object.freeze({
    ANSWER: "answer",
    CLARIFY: "clarify",
    EXECUTE: "execute",
    IGNORE: "ignore"
});

const DECISIONS = new Set(Object.values(DECISION));

// Hành động công khai, ánh xạ 1-1 vào nghiệp vụ đã có trong ZaloBot.
const PUBLIC_ACTION_TYPES = Object.freeze([
    "save_mssv",
    "register_notification",
    "list_notifications",
    "update_notification",
    "delete_notification",
    "enable_notifications",
    "disable_notifications",
    "enable_class_start_notifications",
    "set_class_start_reminder",
    "disable_class_start_notifications",
    "get_today_schedule",
    "get_week_schedule",
    "get_exam_schedule",
    "get_schedule_for_date",
    "help"
]);

// Hành động quản trị. CHỈ dành cho danh tính owner do MÁY CHỦ xác thực.
//
// Ranh giới cố ý hẹp: đọc chẩn đoán, và thay đổi phạm vi MỘT cuộc trò chuyện.
// Không có hành động nào chạm tới toàn bộ người dùng.
//
// Vì sao không mở broadcast / phân quyền / chặn / xoá chat cho mô hình:
//   - Một câu "đồng ý" nhầm, hoặc một prompt injection lọt qua, là ảnh hưởng tới
//     TOÀN BỘ người dùng và không hoàn tác được (đã gửi là đã gửi).
//   - Những thao tác đó phải do người vận hành gõ lệnh tường minh, nơi ý định
//     được thể hiện bằng chính cú pháp chứ không qua một lớp suy luận.
const ADMIN_ACTION_TYPES = Object.freeze([
    "admin_bot_status",
    "admin_list_chats",
    "admin_chat_details",
    "admin_access_list",
    "admin_pause_chat",
    "admin_resume_chat",
    "admin_test_chat"
]);

const ACTION_TYPES = Object.freeze([...PUBLIC_ACTION_TYPES, ...ADMIN_ACTION_TYPES]);

const ALLOWED_ACTIONS = new Set(ACTION_TYPES);
const ADMIN_ACTIONS = new Set(ADMIN_ACTION_TYPES);
const PUBLIC_ACTIONS = new Set(PUBLIC_ACTION_TYPES);

// Hành động phá huỷ / gây gián đoạn: bắt buộc xác nhận, kể cả khi mô hình khai
// `requires_confirmation: false`. Chính sách này do backend quyết định.
const DESTRUCTIVE_ACTIONS = new Set([
    "delete_notification",
    "disable_notifications",
    "disable_class_start_notifications",
    // Tạm dừng một chat làm người đó ngừng nhận lịch; gửi tin kiểm tra là gửi
    // một tin thật tới người thật. Cả hai đều phải hỏi trước.
    "admin_pause_chat",
    "admin_test_chat"
]);

const PLACEHOLDER_PATTERN = /^\{\{mssv:(\d{1,3})\}\}$/;
const STUDENT_ID_PATTERN = /^\d{9}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const TARGET_DAYS = new Set(["today", "tomorrow"]);
const CHAT_ID_PATTERN = /^\d{1,32}$/;
const CHAT_FILTERS = new Set(["all", "active", "inactive", "disabled", "removed", "private", "group", "unknown"]);

const TOP_LEVEL_KEYS = new Set(["decision", "reply", "actions", "missing_fields", "requires_confirmation"]);

const REPLY_MAX_CHARS = 1200;
const MAX_MISSING_FIELDS = 8;

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unexpectedKeys(value, allowed) {
    return Object.keys(value).filter((key) => !allowed.has(key));
}

function validateStudentId(value) {
    if (typeof value !== "string") return { ok: false, error: "student_id phải là chuỗi" };
    const trimmed = value.trim();
    if (PLACEHOLDER_PATTERN.test(trimmed) || STUDENT_ID_PATTERN.test(trimmed)) {
        return { ok: true, value: trimmed };
    }
    return { ok: false, error: "student_id phải gồm đúng 9 chữ số" };
}

function validateTime(value) {
    if (typeof value !== "string") return { ok: false, error: "time phải là chuỗi" };
    const normalized = normalizeTimeToken(value);
    if (!normalized || !TIME_PATTERN.test(normalized)) {
        return { ok: false, error: "time không hợp lệ (hh:mm, 00:00–23:59)" };
    }
    return { ok: true, value: normalized };
}

function validateTargetDay(value) {
    if (typeof value !== "string" || !TARGET_DAYS.has(value)) {
        return { ok: false, error: "target_day phải là \"today\" hoặc \"tomorrow\"" };
    }
    return { ok: true, value };
}

function validateRecordId(value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1) {
        return { ok: false, error: "id phải là số nguyên dương" };
    }
    return { ok: true, value: id };
}

function validateHelpCommand(value) {
    if (typeof value !== "string") return { ok: false, error: "command phải là chuỗi" };
    const entry = findHelpCommand(value);
    if (!entry) return { ok: false, error: "command không nằm trong sổ lệnh" };
    // Chỉ trợ giúp công khai: không hé lộ lệnh quản trị qua trợ lý.
    if (entry.group !== "public") return { ok: false, error: "command không được phép" };
    return { ok: true, value: entry.command };
}

// Chat ID của Zalo là chuỗi số. Không nhận chuỗi tự do: đây là đích mà một hành
// động quản trị có thể tác động tới, nên nó phải kiểm tra được bằng hình dạng.
function validateChatId(value) {
    if (typeof value !== "string" && typeof value !== "number") {
        return { ok: false, error: "chat_id phải là chuỗi số" };
    }
    const text = String(value).trim();
    if (!CHAT_ID_PATTERN.test(text)) return { ok: false, error: "chat_id phải là chuỗi số" };
    return { ok: true, value: text };
}

function validateChatFilter(value) {
    if (typeof value !== "string") return { ok: false, error: "filter phải là chuỗi" };
    const text = value.trim().toLowerCase();
    if (!CHAT_FILTERS.has(text)) return { ok: false, error: "filter không hợp lệ" };
    return { ok: true, value: text };
}

function validateShortReason(value) {
    if (typeof value !== "string") return { ok: false, error: "reason phải là chuỗi" };
    const text = value.trim();
    if (text.length > 120) return { ok: false, error: "reason quá dài" };
    return { ok: true, value: text };
}

// Cụm từ chỉ ngày. Chỉ kiểm tra HÌNH DẠNG ở đây; việc quy đổi sang ngày thật do
// máy chủ làm (scheduleDate.resolveScheduleDate) vì nó cần "hôm nay là ngày nào"
// theo giờ Việt Nam — thứ mô hình không đáng tin để tự tính.
function validateDatePhrase(value) {
    if (typeof value !== "string") return { ok: false, error: "date phải là chuỗi" };
    const text = value.trim();
    if (!text) return { ok: false, error: "date không được rỗng" };
    if (text.length > 30) return { ok: false, error: "date quá dài" };
    if (/[\u0000-\u001f]/.test(text)) return { ok: false, error: "date chứa ký tự không hợp lệ" };
    return { ok: true, value: text };
}

// Số phút nhắc trước: 0–180. 0 nghĩa là nhắc đúng lúc vào học.
function validateLeadMinutes(value) {
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < 0 || minutes > 180) {
        return { ok: false, error: "lead_minutes phải là số nguyên 0–180" };
    }
    return { ok: true, value: minutes };
}

// Bảng luật cho từng hành động: thuộc tính bắt buộc, thuộc tính tuỳ chọn và hàm
// kiểm tra giá trị. Không có luật ⇒ không có quyền chạy.
const ACTION_RULES = Object.freeze({
    save_mssv: { required: ["student_id"], optional: [], fields: { student_id: validateStudentId } },
    register_notification: {
        required: ["time", "target_day"],
        optional: ["student_id"],
        fields: { time: validateTime, target_day: validateTargetDay, student_id: validateStudentId }
    },
    list_notifications: { required: [], optional: [], fields: {} },
    update_notification: {
        required: ["id"],
        optional: ["time", "target_day"],
        fields: { id: validateRecordId, time: validateTime, target_day: validateTargetDay }
    },
    // Xoá được chỉ bằng giờ + ngày đích, không bắt người dùng nhớ ID. Máy chủ tự
    // tra ra mốc tương ứng trong đăng ký CỦA CHÍNH người gửi.
    delete_notification: {
        required: [],
        optional: ["id", "time", "target_day"],
        fields: { id: validateRecordId, time: validateTime, target_day: validateTargetDay }
    },
    enable_notifications: { required: [], optional: [], fields: {} },
    disable_notifications: { required: [], optional: [], fields: {} },
    enable_class_start_notifications: { required: [], optional: [], fields: {} },
    // Nhắc TRƯỚC giờ học N phút. Bật luôn tính năng này: người dùng vừa nói rõ
    // họ muốn được nhắc, không cần thêm một bước bật riêng.
    set_class_start_reminder: { required: ["lead_minutes"], optional: [], fields: { lead_minutes: validateLeadMinutes } },
    disable_class_start_notifications: { required: [], optional: [], fields: {} },
    get_today_schedule: { required: [], optional: ["student_id"], fields: { student_id: validateStudentId } },
    get_week_schedule: { required: [], optional: ["student_id"], fields: { student_id: validateStudentId } },
    get_exam_schedule: { required: [], optional: ["student_id"], fields: { student_id: validateStudentId } },
    // Ngày do mô hình trả về chỉ là CỤM TỪ ("mai", "thứ 5", "12/11"). Máy chủ tự
    // quy đổi và từ chối nếu không hiểu — mô hình không bao giờ tự tính ra ngày.
    get_schedule_for_date: {
        required: ["date"],
        optional: ["student_id"],
        fields: { date: validateDatePhrase, student_id: validateStudentId }
    },
    help: { required: [], optional: ["command"], fields: { command: validateHelpCommand } },

    // ------------------------------------------------------------- quản trị
    admin_bot_status: { required: [], optional: [], fields: {} },
    admin_list_chats: {
        required: [],
        optional: ["filter", "page"],
        fields: { filter: validateChatFilter, page: validateRecordId }
    },
    admin_chat_details: { required: ["chat_id"], optional: [], fields: { chat_id: validateChatId } },
    admin_access_list: { required: [], optional: [], fields: {} },
    admin_pause_chat: {
        required: ["chat_id"],
        optional: ["reason"],
        fields: { chat_id: validateChatId, reason: validateShortReason }
    },
    admin_resume_chat: { required: ["chat_id"], optional: [], fields: { chat_id: validateChatId } },
    admin_test_chat: { required: ["chat_id"], optional: [], fields: { chat_id: validateChatId } }
});

// Kiểm tra MỘT hành động. Trả về { ok: true, action } hoặc { ok: false, error }.
//
// `options.allowPartial` cho phép `register_notification` thiếu `target_day`.
// Chỉ dùng khi quyết định là `clarify`: lúc đó mô hình đã hiểu giờ nhưng cần hỏi
// ngày đích. Hành động dở dang KHÔNG BAO GIỜ được thực thi — nó chỉ được giữ lại
// để tin trả lời kế tiếp hoàn tất (xem resolveClarification trong assistantService).
function validateAction(raw, options = {}) {
    if (!isPlainObject(raw)) return { ok: false, error: "hành động phải là object" };

    const type = raw.type;
    if (typeof type !== "string" || !ALLOWED_ACTIONS.has(type)) {
        return { ok: false, error: `loại hành động không được phép: ${String(type).slice(0, 40)}` };
    }

    const rule = ACTION_RULES[type];
    const allowPartial = options.allowPartial === true && type === "register_notification";
    const required = allowPartial
        ? rule.required.filter((field) => field !== "target_day")
        : rule.required;

    const allowedKeys = new Set(["type", ...rule.required, ...rule.optional]);
    const extra = unexpectedKeys(raw, allowedKeys);
    if (extra.length > 0) {
        return { ok: false, error: `thuộc tính không được phép trong ${type}: ${extra.join(", ")}` };
    }

    const action = { type };
    for (const field of required) {
        if (raw[field] === undefined || raw[field] === null || raw[field] === "") {
            return { ok: false, error: `${type} thiếu ${field}` };
        }
    }
    for (const field of [...rule.required, ...rule.optional]) {
        if (raw[field] === undefined || raw[field] === null) continue;
        if (raw[field] === "" && rule.optional.includes(field)) continue;
        const result = rule.fields[field](raw[field]);
        if (!result.ok) return { ok: false, error: `${type}.${field}: ${result.error}` };
        action[field] = result.value;
    }

    if (type === "update_notification" && action.time === undefined && action.target_day === undefined) {
        return { ok: false, error: "update_notification cần time hoặc target_day" };
    }

    if (type === "delete_notification") {
        const hasId = action.id !== undefined;
        const hasPair = action.time !== undefined && action.target_day !== undefined;
        if (!hasId && !hasPair) {
            return { ok: false, error: "delete_notification cần id, hoặc time + target_day" };
        }
    }

    return { ok: true, action };
}

// Mô hình hay bọc JSON trong ```json … ``` dù đã bật JSON mode, và đôi khi thêm
// một câu dẫn trước. Bóc phần JSON ra trước khi parse — việc KIỂM TRA nội dung
// vẫn giữ nguyên nghiêm ngặt, đây chỉ là bước đọc dữ liệu.
function parseJsonPayload(text) {
    const raw = String(text == null ? "" : text).trim();
    if (!raw) throw new Error("rỗng");

    const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const candidate = fenced ? fenced[1].trim() : raw;
    try {
        return JSON.parse(candidate);
    } catch (firstError) {
        const start = candidate.indexOf("{");
        const end = candidate.lastIndexOf("}");
        if (start >= 0 && end > start) {
            return JSON.parse(candidate.slice(start, end + 1));
        }
        throw firstError;
    }
}

// Kiểm tra TOÀN BỘ phản hồi của mô hình.
//
// `options.maxActions` chặn một phản hồi sinh ra hàng chục thao tác; `options.placeholders`
// cho phép mô hình trả lại đúng placeholder MSSV mà ta đã gửi đi.
function validateAssistantResponse(raw, options = {}) {
    const maxActions = Number(options.maxActions) > 0 ? Number(options.maxActions) : 5;

    let payload = raw;
    if (typeof payload === "string") {
        try {
            payload = parseJsonPayload(payload);
        } catch (_) {
            // Phản hồi bị cắt vì chạm trần token là nguyên nhân khác hẳn với "mô
            // hình trả lời sai định dạng" — ghi rõ để người vận hành biết phải
            // tăng AI_MAX_OUTPUT_TOKENS thay vì đi sửa prompt.
            return {
                ok: false,
                error: options.truncated
                    ? "phản hồi bị cắt vì quá dài (chạm trần AI_MAX_OUTPUT_TOKENS)"
                    : "phản hồi không phải JSON hợp lệ"
            };
        }
    }
    if (!isPlainObject(payload)) return { ok: false, error: "phản hồi phải là object JSON" };

    const extra = unexpectedKeys(payload, TOP_LEVEL_KEYS);
    if (extra.length > 0) return { ok: false, error: `thuộc tính lạ: ${extra.join(", ")}` };

    const decision = payload.decision;
    if (typeof decision !== "string" || !DECISIONS.has(decision)) {
        return { ok: false, error: `decision không hợp lệ: ${String(decision).slice(0, 40)}` };
    }

    let reply = payload.reply;
    if (reply === undefined || reply === null) reply = "";
    if (typeof reply !== "string") return { ok: false, error: "reply phải là chuỗi" };
    reply = reply.trim();
    if (reply.length > REPLY_MAX_CHARS) reply = reply.slice(0, REPLY_MAX_CHARS);

    let missingFields = payload.missing_fields;
    if (missingFields === undefined || missingFields === null) missingFields = [];
    if (!Array.isArray(missingFields)) return { ok: false, error: "missing_fields phải là mảng" };
    missingFields = missingFields
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, MAX_MISSING_FIELDS);

    let rawActions = payload.actions;
    if (rawActions === undefined || rawActions === null) rawActions = [];
    if (!Array.isArray(rawActions)) return { ok: false, error: "actions phải là mảng" };
    if (rawActions.length > maxActions) {
        return { ok: false, error: `quá nhiều hành động (tối đa ${maxActions})` };
    }

    const actions = [];
    // Chỉ khi quyết định là "clarify" mới cho phép hành động dở dang (thiếu ngày
    // đích). Mọi quyết định khác vẫn đòi đủ tham số.
    const allowPartial = decision === DECISION.CLARIFY;
    const allowAdmin = options.allowAdmin === true;
    for (let index = 0; index < rawActions.length; index += 1) {
        const result = validateAction(rawActions[index], { allowPartial });
        if (!result.ok) return { ok: false, error: `actions[${index}]: ${result.error}` };
        // Hành động quản trị chỉ tồn tại với danh tính owner. Mô hình không bao
        // giờ quyết định điều này — `allowAdmin` do máy chủ truyền vào sau khi đã
        // kiểm tra danh tính từ sự kiện Zalo thật.
        if (ADMIN_ACTIONS.has(result.action.type) && !allowAdmin) {
            return { ok: false, error: `actions[${index}]: hành động quản trị không được phép` };
        }
        actions.push(result.action);
    }

    // `execute` mà không có hành động nào là phản hồi vô nghĩa: hạ xuống `answer`
    // để người dùng vẫn nhận được lời giải thích thay vì im lặng.
    const effectiveDecision = decision === DECISION.EXECUTE && actions.length === 0 ? DECISION.ANSWER : decision;

    return {
        ok: true,
        plan: {
            decision: effectiveDecision,
            reply,
            actions,
            missingFields,
            // Mô hình chỉ ĐỀ XUẤT; quyết định cuối cùng thuộc về backend.
            modelRequiresConfirmation: payload.requires_confirmation === true
        }
    };
}

// Chính sách xác nhận do backend áp đặt, không phụ thuộc mô hình.
function actionNeedsConfirmation(action) {
    return DESTRUCTIVE_ACTIONS.has(action?.type);
}

function planNeedsConfirmation(actions) {
    return (actions || []).some(actionNeedsConfirmation);
}

module.exports = {
    ACTION_RULES,
    ACTION_TYPES,
    ADMIN_ACTIONS,
    ADMIN_ACTION_TYPES,
    ALLOWED_ACTIONS,
    DECISION,
    DECISIONS,
    DESTRUCTIVE_ACTIONS,
    PLACEHOLDER_PATTERN,
    PUBLIC_ACTIONS,
    PUBLIC_ACTION_TYPES,
    REPLY_MAX_CHARS,
    actionNeedsConfirmation,
    parseJsonPayload,
    planNeedsConfirmation,
    validateAction,
    validateAssistantResponse
};
