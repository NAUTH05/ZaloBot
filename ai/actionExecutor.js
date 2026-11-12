// Thực thi kế hoạch hành động do trợ lý AI (hoặc bộ phân tích tất định) đề xuất.
//
// Nguyên tắc kiến trúc quan trọng nhất của tính năng:
//   Mô hình KHÔNG gọi hàm. Nó chỉ trả về JSON. Lớp này kiểm tra lại từ đầu bằng
//   đúng các dịch vụ nghiệp vụ đã có (subscriptions, lhuSchedule, scheduleChanges)
//   rồi mới thực thi — nên mọi bất biến cũ vẫn còn hiệu lực.
//
// Hai pha, theo đúng thứ tự:
//   1. prepare()  — kiểm tra TẤT CẢ tham số, quyền, MSSV và trùng lặp TRƯỚC khi
//                   ghi bất cứ thứ gì. Có lỗi ⇒ không ghi gì cả.
//   2. execute()  — chạy tuần tự theo đúng thứ tự người dùng yêu cầu. Lỗi giữa
//                   chừng được báo chính xác, không bao giờ báo "thành công toàn bộ".

const subscriptions = require("../subscriptions");
const { fetchStudentSchedule, normalizeStudentId, formatDailySchedule, formatExamSchedule, formatScheduleWeeks, formatWeeklySchedule } = require("../lhuSchedule");
const { initializeScheduleSnapshot } = require("../scheduleChanges");
const { resolveScheduleDate } = require("../scheduleDate");
const { weekLabel } = require("../scheduleWeek");
const { findHelpCommand, renderCommand } = require("../helpContent");
const { formatPublicHelp } = require("../messageTemplates");
const { TARGET_DAY, offsetToTargetDay, targetDayToOffset } = require("./commandNormalizer");
// Chỉ dùng hằng số (không dùng hàm kiểm tra) để tránh phụ thuộc vòng.
const { ADMIN_ACTIONS } = require("./actionSchema");

const STATUS = Object.freeze({
    OK: "ok",
    SKIPPED: "skipped",
    FAILED: "failed"
});

const ERROR_TEXT = Object.freeze({
    missing_student_id: "chưa có MSSV",
    invalid_student_id: "MSSV phải gồm đúng 9 chữ số",
    student_not_verified: "không tra được MSSV này trên hệ thống trường",
    unknown_id: "không có mốc giờ nhận lịch với ID này",
    not_found: "không có mốc giờ nhận lịch nào khớp",
    conflict: "mốc giờ này đã tồn tại",
    missing_target_day: "thiếu ngày đích",
    missing_notification_times: "chưa có mốc giờ nhận lịch nào để bật",
    lookup_failed: "không tra được dữ liệu lịch học",
    invalid_date: "chưa hiểu ngày cậu muốn xem",
    unsupported: "thao tác không được hỗ trợ",
    not_owner: "chỉ quản trị viên mới dùng được thao tác này",
    admin_unavailable: "thao tác quản trị chưa sẵn sàng"
});

const TYPE_LABEL = Object.freeze({
    save_mssv: "lưu MSSV",
    register_notification: "đăng ký nhận lịch",
    list_notifications: "xem giờ nhận lịch",
    update_notification: "sửa giờ nhận lịch",
    delete_notification: "xoá giờ nhận lịch",
    enable_notifications: "bật nhận lịch",
    disable_notifications: "tắt nhận lịch",
    enable_class_start_notifications: "bật nhắc giờ học",
    set_class_start_reminder: "hẹn nhắc trước giờ học",
    disable_class_start_notifications: "tắt nhắc giờ học",
    get_today_schedule: "xem lịch hôm nay",
    get_week_schedule: "xem lịch trong tuần",
    get_exam_schedule: "xem lịch thi",
    get_schedule_for_date: "xem lịch theo ngày",
    help: "hướng dẫn",
    admin_bot_status: "xem trạng thái hệ thống",
    admin_list_chats: "xem danh sách chat",
    admin_chat_details: "xem chi tiết một chat",
    admin_access_list: "xem phân quyền",
    admin_pause_chat: "tạm dừng một chat",
    admin_resume_chat: "bật lại một chat",
    admin_test_chat: "gửi tin kiểm tra"
});

function describeTime(entry) {
    return `${entry.time} (${entry.targetDayOffset === 1 ? "hôm sau" : "hôm nay"})`;
}

function describeTimes(list) {
    const times = (list || []).slice().sort((left, right) => Number(left.id) - Number(right.id));
    if (times.length === 0) return "> Chưa có giờ nhận lịch nào.";
    return times
        .map((item) => `- **ID ${item.id}** — \`${item.time}\` · ${item.targetDayOffset === 1 ? "hôm sau" : "hôm nay"}`)
        .join("\n");
}

function createActionExecutor(deps = {}) {
    const services = {
        getSubscription: deps.getSubscription || subscriptions.getSubscription,
        saveStudent: deps.saveStudent || subscriptions.saveStudent,
        enableNotifications: deps.enableNotifications || subscriptions.enableNotifications,
        disableNotifications: deps.disableNotifications || subscriptions.disableNotifications,
        enableClassStartNotifications: deps.enableClassStartNotifications || subscriptions.enableClassStartNotifications,
        setClassStartLead: deps.setClassStartLead || subscriptions.setClassStartLead,
        disableClassStartNotifications: deps.disableClassStartNotifications || subscriptions.disableClassStartNotifications,
        updateNotificationTime: deps.updateNotificationTime || subscriptions.updateNotificationTime,
        removeNotificationTime: deps.removeNotificationTime || subscriptions.removeNotificationTime,
        getEnabledSubscriptions: deps.getEnabledSubscriptions || subscriptions.getEnabledSubscriptions,
        normalizeNotificationTimes: deps.normalizeNotificationTimes || subscriptions.normalizeNotificationTimes,
        normalizeStudentId: deps.normalizeStudentId || normalizeStudentId,
        fetchStudentSchedule: deps.fetchStudentSchedule || fetchStudentSchedule,
        initializeScheduleSnapshot: deps.initializeScheduleSnapshot || initializeScheduleSnapshot,
        formatDailySchedule: deps.formatDailySchedule || formatDailySchedule,
        formatWeeklySchedule: deps.formatWeeklySchedule || formatWeeklySchedule,
        formatScheduleWeeks: deps.formatScheduleWeeks || formatScheduleWeeks,
        formatExamSchedule: deps.formatExamSchedule || formatExamSchedule,
        // Cổng tiếp nhận: mặc định chạy ngay (đúng hành vi khi chat đã được tiếp
        // nhận). main.js truyền gatedWrite thật vào để giữ nguyên cơ chế hoãn ghi.
        gatedWrite: deps.gatedWrite || ((_context, _label, run) => run()),
        now: deps.now || (() => new Date()),
        // --------------------------------------------------------- quản trị
        //
        // Mặc định TẤT CẢ đều rỗng và `isOwner` luôn false: nếu main.js không nối
        // vào thì hành động quản trị bị từ chối (fail closed), không bao giờ chạy
        // nhờ một mặc định nguy hiểm.
        admin: {
            isOwner: deps.isOwner || (() => false),
            botStatus: deps.adminBotStatus || null,
            listChats: deps.adminListChats || null,
            chatDetails: deps.adminChatDetails || null,
            accessList: deps.adminAccessList || null,
            pauseChat: deps.adminPauseChat || null,
            resumeChat: deps.adminResumeChat || null,
            testChat: deps.adminTestChat || null
        }
    };

    // ------------------------------------------------------------------ pha 1
    async function prepare({ context, actions }) {
        const list = Array.isArray(actions) ? actions : [];
        if (list.length === 0) return { ok: false, errors: [{ index: -1, type: null, error: "no_actions" }] };

        // Cổng quyền quản trị, kiểm tra MỘT LẦN cho cả lô và TRƯỚC mọi việc khác.
        //
        // Danh tính lấy từ sự kiện Zalo thật (main.js truyền `isOwner` vào), không
        // bao giờ từ nội dung mô hình trả về. Lô trộn hành động công khai và quản
        // trị của người không phải owner bị từ chối toàn bộ — không chạy nửa vời.
        const adminRequested = list.some((action) => ADMIN_ACTIONS.has(action?.type));
        if (adminRequested && !services.admin.isOwner(context)) {
            return { ok: false, errors: [{ index: -1, type: null, error: "not_owner" }], steps: [] };
        }

        const current = services.getSubscription(context);
        const savedStudentId = services.normalizeStudentId(current?.studentId) || null;
        let effectiveStudentId = savedStudentId;

        const scheduleCache = new Map();
        const plannedTimes = services.normalizeNotificationTimes(current).slice();
        const steps = [];
        const errors = [];
        const confirmationReasons = [];

        async function loadSchedule(studentId) {
            if (scheduleCache.has(studentId)) return scheduleCache.get(studentId);
            let data;
            try {
                data = await services.fetchStudentSchedule(studentId);
            } catch (error) {
                // Không tra được nghĩa là CHƯA xác minh được ⇒ không bao giờ lưu.
                // Gộp mọi lỗi mạng/API về cùng một mã để thông điệp cho người dùng
                // nhất quán và không lộ chi tiết hạ tầng.
                throw Object.assign(new Error("student_not_verified"), { code: "student_not_verified", cause: error });
            }
            if (!data || !data.studentId) {
                throw Object.assign(new Error("student_not_verified"), { code: "student_not_verified" });
            }
            scheduleCache.set(studentId, data);
            return data;
        }

        for (let index = 0; index < list.length; index += 1) {
            const action = list[index];
            const base = { index, type: action.type, action };
            try {
                switch (action.type) {
                    case "save_mssv": {
                        const studentId = services.normalizeStudentId(action.student_id);
                        if (!studentId) {
                            errors.push({ ...base, error: "invalid_student_id" });
                            break;
                        }
                        const data = await loadSchedule(studentId);
                        if (savedStudentId && savedStudentId !== studentId) {
                            confirmationReasons.push(`thay MSSV đang lưu (${savedStudentId}) bằng ${studentId}`);
                        }
                        // Đăng ký sau đó trong cùng lô phải dùng MSSV MỚI này.
                        effectiveStudentId = studentId;
                        steps.push({
                            ...base,
                            studentId,
                            studentName: data.studentName || "",
                            scheduleData: data,
                            label: `MSSV ${studentId}`
                        });
                        break;
                    }
                    case "register_notification": {
                        const studentId = services.normalizeStudentId(action.student_id || effectiveStudentId);
                        if (!studentId) {
                            errors.push({ ...base, error: "missing_student_id" });
                            break;
                        }
                        const offset = targetDayToOffset(action.target_day);
                        if (offset == null) {
                            errors.push({ ...base, error: "missing_target_day" });
                            break;
                        }
                        const data = await loadSchedule(studentId);
                        const duplicate = plannedTimes.some(
                            (item) => item.time === action.time && item.targetDayOffset === offset
                        );
                        if (!duplicate) {
                            plannedTimes.push({
                                id: null,
                                time: action.time,
                                targetDayOffset: offset
                            });
                        }
                        steps.push({
                            ...base,
                            studentId,
                            studentName: data.studentName || "",
                            scheduleData: data,
                            time: action.time,
                            targetDayOffset: offset,
                            alreadyExists: duplicate,
                            label: `${action.time} · ${offset === 1 ? "hôm sau" : "hôm nay"}`
                        });
                        break;
                    }
                    case "list_notifications":
                        steps.push({ ...base, label: TYPE_LABEL[action.type] });
                        break;
                    case "update_notification": {
                        const times = services.normalizeNotificationTimes(current);
                        const existing = times.find((item) => Number(item.id) === Number(action.id));
                        if (!existing) {
                            errors.push({ ...base, error: "unknown_id" });
                            break;
                        }
                        const nextTime = action.time || existing.time;
                        const nextOffset = action.target_day ? targetDayToOffset(action.target_day) : existing.targetDayOffset;
                        const conflict = times.some(
                            (item) => Number(item.id) !== Number(action.id) &&
                                item.time === nextTime && item.targetDayOffset === nextOffset
                        );
                        if (conflict) {
                            errors.push({ ...base, error: "conflict" });
                            break;
                        }
                        steps.push({
                            ...base,
                            id: Number(action.id),
                            time: nextTime,
                            targetDayOffset: nextOffset,
                            label: `ID ${action.id} → ${nextTime} · ${nextOffset === 1 ? "hôm sau" : "hôm nay"}`
                        });
                        break;
                    }
                    case "delete_notification": {
                        const times = services.normalizeNotificationTimes(current);
                        // Nhận diện mốc bằng ID, hoặc bằng (giờ + ngày đích).
                        //
                        // Đường thứ hai là thứ người dùng thật sự nói: "bỏ lịch 21
                        // giờ hôm sau". Bắt họ nhớ ID chỉ vì mô hình không biết ID
                        // là lỗi thiết kế, không phải yêu cầu nghiệp vụ. Việc tra
                        // cứu diễn ra trên ĐĂNG KÝ CỦA CHÍNH NGƯỜI GỬI nên không
                        // thể chạm tới mốc của người khác.
                        let existing = null;
                        if (action.id != null) {
                            existing = times.find((item) => Number(item.id) === Number(action.id));
                        } else if (action.time && action.target_day) {
                            const offset = targetDayToOffset(action.target_day);
                            existing = times.find((item) => item.time === action.time && item.targetDayOffset === offset);
                        }
                        if (!existing) {
                            errors.push({ ...base, error: action.id != null ? "unknown_id" : "not_found" });
                            break;
                        }
                        confirmationReasons.push(`xoá mốc ${existing.time} (${existing.targetDayOffset === 1 ? "hôm sau" : "hôm nay"})`);
                        steps.push({ ...base, id: existing.id, removed: existing, label: `ID ${existing.id}` });
                        break;
                    }
                    case "enable_notifications": {
                        const studentId = services.normalizeStudentId(effectiveStudentId);
                        if (!studentId) {
                            errors.push({ ...base, error: "missing_student_id" });
                            break;
                        }
                        const times = services.normalizeNotificationTimes(current);
                        if (times.length === 0) {
                            errors.push({ ...base, error: "missing_notification_times" });
                            break;
                        }
                        steps.push({ ...base, studentId, studentName: current?.studentName || "", label: TYPE_LABEL[action.type] });
                        break;
                    }
                    case "disable_notifications":
                        confirmationReasons.push("tắt nhận lịch tự động");
                        steps.push({ ...base, label: TYPE_LABEL[action.type] });
                        break;
                    case "enable_class_start_notifications": {
                        const studentId = services.normalizeStudentId(effectiveStudentId);
                        if (!studentId) {
                            errors.push({ ...base, error: "missing_student_id" });
                            break;
                        }
                        steps.push({ ...base, studentId, studentName: current?.studentName || "", label: TYPE_LABEL[action.type] });
                        break;
                    }
                    case "set_class_start_reminder": {
                        const studentId = services.normalizeStudentId(effectiveStudentId);
                        if (!studentId) {
                            errors.push({ ...base, error: "missing_student_id" });
                            break;
                        }
                        steps.push({
                            ...base,
                            studentId,
                            studentName: current?.studentName || "",
                            leadMinutes: Number(action.lead_minutes),
                            label: Number(action.lead_minutes) > 0
                                ? `nhắc trước ${Number(action.lead_minutes)} phút`
                                : "nhắc đúng lúc vào học"
                        });
                        break;
                    }
                    case "disable_class_start_notifications":
                        confirmationReasons.push("tắt nhắc giờ bắt đầu tiết học");
                        steps.push({ ...base, label: TYPE_LABEL[action.type] });
                        break;
                    case "get_today_schedule":
                    case "get_exam_schedule": {
                        const studentId = services.normalizeStudentId(action.student_id || effectiveStudentId);
                        if (!studentId) {
                            errors.push({ ...base, error: "missing_student_id" });
                            break;
                        }
                        const data = await loadSchedule(studentId);
                        steps.push({ ...base, studentId, scheduleData: data, label: TYPE_LABEL[action.type] });
                        break;
                    }
                    case "get_week_schedule": {
                        const studentId = services.normalizeStudentId(action.student_id || effectiveStudentId);
                        if (!studentId) {
                            errors.push({ ...base, error: "missing_student_id" });
                            break;
                        }
                        const data = await loadSchedule(studentId);
                        // Tuần và số tuần đều do máy chủ quyết định, mô hình chỉ nói ý.
                        const weekOffset = Number(action.week_offset) || 0;
                        const weeks = Number(action.weeks) || 1;
                        const label = weeks > 1
                            ? `xem lịch ${weeks} tuần`
                            : `xem lịch ${weekLabel(weekOffset).toLowerCase()}`;
                        steps.push({ ...base, studentId, scheduleData: data, weekOffset, weeks, label });
                        break;
                    }
                    case "get_schedule_for_date": {
                        const studentId = services.normalizeStudentId(action.student_id || effectiveStudentId);
                        if (!studentId) {
                            errors.push({ ...base, error: "missing_student_id" });
                            break;
                        }
                        // Máy chủ quy đổi cụm từ thành ngày thật. Không hiểu ⇒ hỏi
                        // lại, không đoán — một ngày sai tệ hơn một câu hỏi.
                        const resolved = resolveScheduleDate(action.date, services.now());
                        if (!resolved) {
                            errors.push({ ...base, error: "invalid_date" });
                            break;
                        }
                        let data;
                        try {
                            // Ngày khác hôm nay nên KHÔNG dùng cache dùng chung: cửa
                            // sổ dữ liệu trả về phụ thuộc ngày được hỏi.
                            data = await services.fetchStudentSchedule(studentId, resolved.date);
                        } catch (error) {
                            errors.push({ ...base, error: "student_not_verified" });
                            break;
                        }
                        if (!data || !data.studentId) {
                            errors.push({ ...base, error: "student_not_verified" });
                            break;
                        }
                        steps.push({
                            ...base,
                            studentId,
                            scheduleData: data,
                            targetDate: resolved.date,
                            label: `lịch ${resolved.label}`
                        });
                        break;
                    }
                    case "help": {
                        const entry = action.command ? findHelpCommand(action.command) : null;
                        steps.push({ ...base, helpCommand: entry ? entry.command : null, label: TYPE_LABEL[action.type] });
                        break;
                    }
                    // ------------------------------------------------- quản trị
                    case "admin_bot_status":
                    case "admin_access_list":
                        if (!services.admin[action.type === "admin_bot_status" ? "botStatus" : "accessList"]) {
                            errors.push({ ...base, error: "admin_unavailable" });
                            break;
                        }
                        steps.push({ ...base, label: TYPE_LABEL[action.type] });
                        break;
                    case "admin_list_chats":
                        if (!services.admin.listChats) {
                            errors.push({ ...base, error: "admin_unavailable" });
                            break;
                        }
                        steps.push({
                            ...base,
                            filter: action.filter || "all",
                            page: action.page || 1,
                            label: TYPE_LABEL[action.type]
                        });
                        break;
                    case "admin_chat_details":
                    case "admin_resume_chat":
                        if (!services.admin[action.type === "admin_chat_details" ? "chatDetails" : "resumeChat"]) {
                            errors.push({ ...base, error: "admin_unavailable" });
                            break;
                        }
                        steps.push({ ...base, chatId: action.chat_id, label: TYPE_LABEL[action.type] });
                        break;
                    case "admin_pause_chat": {
                        if (!services.admin.pauseChat) {
                            errors.push({ ...base, error: "admin_unavailable" });
                            break;
                        }
                        confirmationReasons.push(`tạm dừng gửi thông báo tới chat ${action.chat_id}`);
                        steps.push({
                            ...base,
                            chatId: action.chat_id,
                            reason: action.reason || "admin_paused",
                            label: TYPE_LABEL[action.type]
                        });
                        break;
                    }
                    case "admin_test_chat": {
                        if (!services.admin.testChat) {
                            errors.push({ ...base, error: "admin_unavailable" });
                            break;
                        }
                        confirmationReasons.push(`gửi một tin kiểm tra thật tới chat ${action.chat_id}`);
                        steps.push({ ...base, chatId: action.chat_id, label: TYPE_LABEL[action.type] });
                        break;
                    }
                    default:
                        errors.push({ ...base, error: "unsupported" });
                }
            } catch (error) {
                errors.push({ ...base, error: error?.code === "student_not_verified" ? "student_not_verified" : "lookup_failed" });
            }
        }

        if (errors.length > 0) {
            return { ok: false, errors, steps };
        }

        return {
            ok: true,
            steps,
            errors: [],
            requiresConfirmation: confirmationReasons.length > 0,
            confirmationReasons,
            current
        };
    }

    // ------------------------------------------------------------------ pha 2
    async function execute({ context, plan }) {
        const results = [];
        const extraMessages = [];

        for (const step of plan.steps || []) {
            const action = step.action;
            try {
                switch (action.type) {
                    case "save_mssv": {
                        services.gatedWrite(
                            context,
                            "save_student",
                            () => services.saveStudent(context, { studentId: step.studentId, studentName: step.studentName }),
                            { fallback: { studentId: step.studentId, studentName: step.studentName } }
                        );
                        results.push({ ...baseResult(step), status: STATUS.OK, detail: `MSSV ${step.studentId} — đã lưu` });
                        break;
                    }
                    case "register_notification": {
                        if (step.alreadyExists) {
                            results.push({ ...baseResult(step), status: STATUS.SKIPPED, detail: `${describeTime(step)} — đã có sẵn` });
                            break;
                        }
                        const wasAlreadyWatched = Object.values(services.getEnabledSubscriptions())
                            .some((subscription) => subscription.studentId === step.studentId);
                        services.gatedWrite(
                            context,
                            "enable_notifications",
                            () => {
                                services.enableNotifications(context, {
                                    studentId: step.studentId,
                                    studentName: step.studentName,
                                    notificationTime: step.time,
                                    targetDayOffset: step.targetDayOffset
                                });
                                services.initializeScheduleSnapshot(step.scheduleData, services.now(), !wasAlreadyWatched);
                            },
                            { fallback: null }
                        );
                        results.push({ ...baseResult(step), status: STATUS.OK, detail: `${describeTime(step)} — đã đăng ký` });
                        break;
                    }
                    case "list_notifications": {
                        const subscription = services.getSubscription(context);
                        const text = `# {green}[GIỜ NHẬN LỊCH]{/green}\n\n${describeTimes(services.normalizeNotificationTimes(subscription))}`;
                        // Nội dung là CÂU TRẢ LỜI, không phải một dòng tổng kết.
                        //
                        // Trước đây chuỗi này chỉ nằm ở `results[].text` và không ai
                        // gửi đi, nên người dùng nhận đúng một câu "ĐÃ HOÀN TÁT —
                        // danh sách giờ nhận lịch" mà không có danh sách nào.
                        extraMessages.push(text);
                        results.push({
                            ...baseResult(step),
                            status: STATUS.OK,
                            detail: "danh sách giờ nhận lịch",
                            standalone: true,
                            text
                        });
                        break;
                    }
                    case "update_notification": {
                        const updated = services.updateNotificationTime(context, step.id, step.time, step.targetDayOffset);
                        results.push(updated
                            ? { ...baseResult(step), status: STATUS.OK, detail: `ID ${step.id} → ${step.time} (${step.targetDayOffset === 1 ? "hôm sau" : "hôm nay"})` }
                            : { ...baseResult(step), status: STATUS.FAILED, detail: ERROR_TEXT.conflict });
                        break;
                    }
                    case "delete_notification": {
                        const removed = services.removeNotificationTime(context, step.id);
                        results.push(removed
                            ? { ...baseResult(step), status: STATUS.OK, detail: `đã xoá ${removed.removed.time} (${removed.removed.targetDayOffset === 1 ? "hôm sau" : "hôm nay"})` }
                            : { ...baseResult(step), status: STATUS.FAILED, detail: ERROR_TEXT.unknown_id });
                        break;
                    }
                    case "enable_notifications": {
                        services.enableNotifications(context, { studentId: step.studentId, studentName: step.studentName });
                        results.push({ ...baseResult(step), status: STATUS.OK, detail: "đã bật nhận lịch" });
                        break;
                    }
                    case "disable_notifications": {
                        const changed = services.disableNotifications(context);
                        results.push({
                            ...baseResult(step),
                            status: changed ? STATUS.OK : STATUS.SKIPPED,
                            detail: changed ? "đã tắt nhận lịch" : "vốn đang tắt"
                        });
                        break;
                    }
                    case "enable_class_start_notifications": {
                        const updated = services.enableClassStartNotifications(context);
                        results.push(updated
                            ? { ...baseResult(step), status: STATUS.OK, detail: "đã bật nhắc giờ học" }
                            : { ...baseResult(step), status: STATUS.FAILED, detail: ERROR_TEXT.missing_student_id });
                        break;
                    }
                    case "set_class_start_reminder": {
                        const updated = services.setClassStartLead(context, step.leadMinutes);
                        results.push(updated
                            ? {
                                ...baseResult(step),
                                status: STATUS.OK,
                                detail: step.leadMinutes > 0
                                    ? `nhắc trước ${step.leadMinutes} phút mỗi buổi học`
                                    : "nhắc đúng lúc vào học"
                            }
                            : { ...baseResult(step), status: STATUS.FAILED, detail: ERROR_TEXT.missing_student_id });
                        break;
                    }
                    case "disable_class_start_notifications": {
                        const changed = services.disableClassStartNotifications(context);
                        results.push({
                            ...baseResult(step),
                            status: changed ? STATUS.OK : STATUS.SKIPPED,
                            detail: changed ? "đã tắt nhắc giờ học" : "vốn đang tắt"
                        });
                        break;
                    }
                    case "get_today_schedule": {
                        extraMessages.push(services.formatDailySchedule(step.scheduleData));
                        results.push({ ...baseResult(step), status: STATUS.OK, standalone: true, detail: `lịch hôm nay của ${step.studentId}` });
                        break;
                    }
                    case "get_week_schedule": {
                        const messages = services.formatScheduleWeeks(step.scheduleData, {
                            referenceDate: services.now(),
                            startOffset: step.weekOffset,
                            weeks: step.weeks
                        });
                        for (const message of messages) extraMessages.push(message);
                        results.push({ ...baseResult(step), status: STATUS.OK, standalone: true, detail: step.label });
                        break;
                    }
                    case "get_exam_schedule": {
                        extraMessages.push(services.formatExamSchedule(step.scheduleData));
                        results.push({ ...baseResult(step), status: STATUS.OK, standalone: true, detail: `lịch thi của ${step.studentId}` });
                        break;
                    }
                    case "get_schedule_for_date": {
                        extraMessages.push(services.formatDailySchedule(step.scheduleData, step.targetDate, {
                            referenceDate: services.now()
                        }));
                        results.push({ ...baseResult(step), status: STATUS.OK, standalone: true, detail: step.label });
                        break;
                    }
                    case "help": {
                        const entry = step.helpCommand ? findHelpCommand(step.helpCommand) : null;
                        extraMessages.push(entry ? renderCommand(entry) : formatPublicHelp());
                        results.push({ ...baseResult(step), status: STATUS.OK, standalone: true, detail: "hướng dẫn" });
                        break;
                    }
                    // ------------------------------------------------- quản trị
                    //
                    // Mọi handler trả về CHUỖI để gửi cho người dùng, hoặc ném lỗi.
                    // Quyền đã được kiểm tra ở prepare(); kiểm tra lại ở đây là lớp
                    // thứ hai, để một lối gọi execute() trực tiếp cũng không lách được.
                    case "admin_bot_status":
                    case "admin_access_list":
                    case "admin_list_chats":
                    case "admin_chat_details":
                    case "admin_resume_chat": {
                        if (!services.admin.isOwner(context)) {
                            results.push({ ...baseResult(step), status: STATUS.FAILED, detail: ERROR_TEXT.not_owner });
                            break;
                        }
                        const handler = {
                            admin_bot_status: services.admin.botStatus,
                            admin_access_list: services.admin.accessList,
                            admin_list_chats: services.admin.listChats,
                            admin_chat_details: services.admin.chatDetails,
                            admin_resume_chat: services.admin.resumeChat
                        }[action.type];
                        if (typeof handler !== "function") {
                            results.push({ ...baseResult(step), status: STATUS.FAILED, detail: ERROR_TEXT.admin_unavailable });
                            break;
                        }
                        const text = await handler({ context, step });
                        if (typeof text === "string" && text.trim()) extraMessages.push(text);
                        results.push({ ...baseResult(step), status: STATUS.OK, standalone: true, detail: step.label });
                        break;
                    }
                    case "admin_pause_chat":
                    case "admin_test_chat": {
                        if (!services.admin.isOwner(context)) {
                            results.push({ ...baseResult(step), status: STATUS.FAILED, detail: ERROR_TEXT.not_owner });
                            break;
                        }
                        const handler = action.type === "admin_pause_chat" ? services.admin.pauseChat : services.admin.testChat;
                        if (typeof handler !== "function") {
                            results.push({ ...baseResult(step), status: STATUS.FAILED, detail: ERROR_TEXT.admin_unavailable });
                            break;
                        }
                        const text = await handler({ context, step });
                        if (typeof text === "string" && text.trim()) extraMessages.push(text);
                        results.push({ ...baseResult(step), status: STATUS.OK, standalone: true, detail: step.label });
                        break;
                    }
                    default:
                        results.push({ ...baseResult(step), status: STATUS.FAILED, detail: ERROR_TEXT.unsupported });
                }
            } catch (error) {
                // Không dừng cả lô: các hành động sau vẫn chạy, nhưng kết quả được
                // ghi đúng là thất bại để phần tổng kết không nói dối.
                results.push({
                    ...baseResult(step),
                    status: STATUS.FAILED,
                    detail: error?.userMessage || "không thực hiện được"
                });
            }
        }

        const failed = results.filter((item) => item.status === STATUS.FAILED);
        return {
            ok: failed.length === 0,
            results,
            extraMessages,
            failed,
            message: formatSummary(results)
        };
    }

    function baseResult(step) {
        return {
            index: step.index,
            type: step.type,
            label: step.label || TYPE_LABEL[step.type] || step.type
        };
    }

    async function run({ context, actions }) {
        const plan = await prepare({ context, actions });
        if (!plan.ok) return { ...plan, executed: false };
        const result = await execute({ context, plan });
        return { ...result, executed: true, requiresConfirmation: plan.requiresConfirmation };
    }

    return { prepare, execute, run };
}

// Tổng kết một lô hành động. Nói rõ việc nào xong, việc nào bỏ qua, việc nào hỏng
// — không bao giờ tuyên bố "hoàn tất" khi còn mục thất bại.
//
// Hành động `standalone` (xem danh sách, xem lịch, hướng dẫn, đọc chẩn đoán) tự
// gửi nội dung của chúng thành một tin riêng. Chúng KHÔNG xuất hiện trong tổng
// kết: một câu "ĐÃ HOÀN TÁT — danh sách giờ nhận lịch" nằm trên chính danh sách
// là tiếng ồn, và từng khiến người dùng tưởng bot trả lời rỗng.
function formatSummary(results) {
    const list = (results || []).filter((item) => !item.standalone);
    // Toàn bộ là hành động "nội dung là câu trả lời" ⇒ không có gì để tổng kết.
    if (list.length === 0) return "";

    const ok = list.filter((item) => item.status === STATUS.OK);
    const skipped = list.filter((item) => item.status === STATUS.SKIPPED);
    const failed = list.filter((item) => item.status === STATUS.FAILED);

    const lines = [];
    if (ok.length > 0) {
        lines.push(failed.length === 0 && skipped.length === 0
            ? "# {green}✓ ĐÃ HOÀN TẤT{/green}"
            : "# {green}✓ ĐÃ THỰC HIỆN{/green}");
    } else if (failed.length > 0) {
        lines.push("# {orange}⚠ CHƯA THỰC HIỆN ĐƯỢC{/orange}");
    } else {
        lines.push("# {orange}⚠ KHÔNG CÓ THAY ĐỔI{/orange}");
    }

    const detail = [];
    for (const item of ok) detail.push(`- ${item.detail}`);
    for (const item of skipped) detail.push(`- ${item.detail}`);
    for (const item of failed) detail.push(`- ${item.detail} — **chưa thực hiện được**`);
    if (detail.length > 0) lines.push(detail.join("\n"));

    if (failed.length > 0) {
        lines.push("> Cậu thử lại phần chưa thực hiện được giúp mình nhé.");
    } else if (ok.length > 0) {
        lines.push("> Dùng **/gionhanlich** để xem lại các mốc giờ đã đăng ký.");
    }
    return lines.join("\n\n");
}

function formatPreflightErrors(errors) {
    if (!errors || errors.length === 0) return "Chưa thực hiện được yêu cầu nào.";
    const lines = errors.map((item) => {
        const label = TYPE_LABEL[item.type] || item.type || "yêu cầu";
        const reason = ERROR_TEXT[item.error] || "không hợp lệ";
        return `- ${label}: ${reason}`;
    });
    return ["# {orange}⚠ CHƯA THỰC HIỆN ĐƯỢC{/orange}", lines.join("\n"), "> Chưa có thay đổi nào được ghi."].join("\n\n");
}

module.exports = {
    ERROR_TEXT,
    STATUS,
    TYPE_LABEL,
    createActionExecutor,
    describeTimes,
    formatPreflightErrors,
    formatSummary,
    offsetToTargetDay,
    TARGET_DAY
};
