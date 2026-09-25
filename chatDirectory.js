const path = require("path");
const { readJsonStore, writeJsonStore } = require("./firestorePersistence");
const { scopeKey } = require("./bots");
const { getCurrentBotId } = require("./botContext");

// Khóa của một chat trong sổ: có phạm vi theo bot đang xử lý.
// Bot 1 giữ khóa trần (chatId) để dữ liệu hiện có dùng nguyên trạng và Room 411
// vẫn đọc được; bot 2/3 có tiền tố nên không bao giờ ghi đè lên nhau.
function scopedChatKey(chatId) {
    return scopeKey(getCurrentBotId(), chatId);
}

const FILE_PATH = path.join(__dirname, "chatDirectory.json");
const SCHEMA_VERSION = 2;
const STATUSES = new Set(["active", "inactive", "disabled", "removed"]);
// Lịch trực phòng 411 đã được tách sang bot riêng (Room411Bot) nên không còn
// là tính năng thông báo của bot này. Giá trị `notificationOverrides.duty` cũ
// (nếu có) vẫn được giữ nguyên trên bản ghi vì normalizeRecord chỉ chuẩn hoá
// các tính năng nằm trong danh sách này.
const FEATURES = ["schedule", "broadcast"];

function normalizeChatType(value, fallback = "unknown") {
    const raw = String(value == null ? "" : value).trim().toLowerCase();
    if (["group", "group_chat", "room", "nhom", "nhóm"].includes(raw)) return "group";
    if (["private", "user", "direct", "personal", "individual"].includes(raw)) return "private";
    return fallback;
}

function nowIso() {
    return new Date().toISOString();
}

function readDirectory(filePath = FILE_PATH) {
    try {
        const data = readJsonStore(filePath, FILE_PATH, { schemaVersion: SCHEMA_VERSION, chats: {} });
        if (data && typeof data === "object" && !Array.isArray(data)) {
            return {
                schemaVersion: SCHEMA_VERSION,
                chats: data.chats && typeof data.chats === "object" ? data.chats : {},
                deletedChatIds: data.deletedChatIds && typeof data.deletedChatIds === "object" ? data.deletedChatIds : {}
            };
        }
    } catch (error) {
        console.error(`Không đọc được ${path.basename(filePath)}:`, error.message);
    }
    return { schemaVersion: SCHEMA_VERSION, chats: {}, deletedChatIds: {} };
}

function writeDirectory(data, filePath = FILE_PATH) {
    writeJsonStore(filePath, FILE_PATH, data);
}

function normalizeChatId(chatId) {
    const value = String(chatId == null ? "" : chatId).trim();
    return value || null;
}

// Trạng thái tiếp nhận của một chat. Phân biệt RÕ ba tình huống mà trước đây bị
// gộp làm một ("có bản ghi = người dùng"):
//
//   pending     — mới chỉ có sự kiện vào, chưa từng có câu trả lời gửi thành công.
//                 KHÔNG được tính là người nhận hợp lệ.
//   admitted    — đã có ít nhất một câu trả lời gửi thành công qua đúng nhà cung
//                 cấp nhận sự kiện. Chỉ nhóm này mới đủ điều kiện nhận phát tin.
//   unreachable — từng được tiếp nhận nhưng gửi tới đã thất bại dứt khoát
//                 (410/422 không quyền). Vẫn giữ dữ liệu người dùng, nhưng bị
//                 loại khỏi phát tin cho tới khi có một tương tác mới thành công.
//
// Giá trị cũ/không hợp lệ được coi là `admitted` để KHÔNG vô hiệu hoá dữ liệu đã
// có trước khi trường này ra đời (chúng đã từng nhận được tin).
const ADMISSION_STATUSES = new Set(["pending", "admitted", "unreachable"]);

function normalizeAdmissionStatus(value, fallback = "admitted") {
    const raw = String(value == null ? "" : value).trim().toLowerCase();
    return ADMISSION_STATUSES.has(raw) ? raw : fallback;
}

function normalizeRecord(chatId, input = {}, existing = {}) {
    const id = normalizeChatId(chatId);
    if (!id) return null;
    const timestamp = nowIso();
    const overrides = { ...(existing.notificationOverrides || {}), ...(input.notificationOverrides || {}) };
    for (const feature of FEATURES) {
        if (overrides[feature] !== true && overrides[feature] !== false) overrides[feature] = null;
    }
    const status = STATUSES.has(input.status) ? input.status : (STATUSES.has(existing.status) ? existing.status : "active");
    const { restoreDeleted, ...safeInput } = input;
    return {
        ...existing,
        ...safeInput,
        chatId: id,
        botId: getCurrentBotId(),
        chatType: normalizeChatType(input.chatType, normalizeChatType(existing.chatType)),
        displayName: input.displayName || existing.displayName || input.chatTitle || existing.chatTitle || "",
        userId: String(input.userId || existing.userId || "").trim() || null,
        chatTitle: String(input.chatTitle || existing.chatTitle || "").trim(),
        notificationOverrides: overrides,
        status,
        // Bản ghi CŨ (không có trường này) mặc định "admitted": chúng đã từng nhận
        // được tin nên không được coi là chưa tiếp nhận. `input.admissionStatus`
        // luôn được ưu tiên khi có.
        admissionStatus: normalizeAdmissionStatus(input.admissionStatus, normalizeAdmissionStatus(existing.admissionStatus)),
        admittedAt: existing.admittedAt || input.admittedAt || null,
        unreachableReason: input.unreachableReason !== undefined ? input.unreachableReason : (existing.unreachableReason || null),
        consecutiveFailureCount: Number.isInteger(input.consecutiveFailureCount)
            ? input.consecutiveFailureCount
            : (Number.isInteger(existing.consecutiveFailureCount) ? existing.consecutiveFailureCount : 0),
        createdAt: existing.createdAt || input.createdAt || timestamp,
        updatedAt: timestamp
    };
}

function upsertChat(input = {}, filePath = FILE_PATH) {
    const chatId = normalizeChatId(input.chatId);
    if (!chatId) return null;
    const data = readDirectory(filePath);
    const key = scopedChatKey(chatId);
    if (data.deletedChatIds[key] && input.restoreDeleted !== true) return null;
    if (input.restoreDeleted === true) delete data.deletedChatIds[key];
    const record = normalizeRecord(chatId, input, data.chats[key]);
    data.chats[key] = record;
    writeDirectory(data, filePath);
    return record;
}

function getChat(chatId, filePath = FILE_PATH) {
    const id = normalizeChatId(chatId);
    return id ? readDirectory(filePath).chats[scopedChatKey(id)] || null : null;
}

function getAllChats(filePath = FILE_PATH) {
    return Object.values(readDirectory(filePath).chats).sort((a, b) => String(a.displayName || a.chatId).localeCompare(String(b.displayName || b.chatId)));
}

function isChatEligible(chatId, feature = null, filePath = FILE_PATH) {
    const id = normalizeChatId(chatId);
    if (id && readDirectory(filePath).deletedChatIds[scopedChatKey(id)]) return false;
    const record = getChat(chatId, filePath);
    // Chưa có bản ghi thì coi như đủ điều kiện theo đường tương thích cũ — nhưng
    // điều đó chỉ áp dụng cho dữ liệu ĐÃ CÓ. Một chat chưa từng được tiếp nhận sẽ
    // không có bản ghi nào, nên nó cũng không xuất hiện trong danh sách phát tin.
    if (!record) return true;
    if (record.status !== "active") return false;
    // Chỉ chat ĐÃ TIẾP NHẬN mới đủ điều kiện nhận phát tin. `pending` chưa từng có
    // câu trả lời nào gửi được; `unreachable` từng có nhưng nay gửi không tới.
    if (record.admissionStatus && record.admissionStatus !== "admitted") return false;
    if (feature && record.notificationOverrides?.[feature] === false) return false;
    return true;
}

// Đánh dấu chat đã được TIẾP NHẬN: một câu trả lời đã gửi thành công qua đúng
// nhà cung cấp. Đây là hành động duy nhất biến một ứng viên thành người dùng thật.
function markChatAdmitted(chatId, filePath = FILE_PATH) {
    const id = normalizeChatId(chatId);
    if (!id) return null;
    const current = getChat(id, filePath);
    // Chỉ tự bật lại khi chat bị HỆ THỐNG tạm ngưng. Quyết định của quản trị viên
    // ("disabled"/"removed") luôn được giữ nguyên.
    const systemSuspended = current?.status === "inactive" && current?.statusChangedBy === "system";
    return updateChat(id, {
        admissionStatus: "admitted",
        admittedAt: current?.admittedAt || nowIso(),
        // Tiếp nhận lại được nghĩa là đã liên lạc được trở lại.
        unreachableReason: null,
        status: systemSuspended ? "active" : (current?.status || "active"),
        statusReason: systemSuspended ? null : current?.statusReason,
        consecutiveFailureCount: 0
    }, filePath);
}

// Đánh dấu chat KHÔNG LIÊN LẠC ĐƯỢC (410/422 không quyền). KHÔNG xoá dữ liệu
// người dùng (MSSV, đăng ký) — chỉ loại khỏi phát tin và ghi lý do rõ ràng.
function markChatUnreachable(chatId, reason, filePath = FILE_PATH) {
    const id = normalizeChatId(chatId);
    if (!id) return null;
    const at = nowIso();
    return updateChat(id, {
        admissionStatus: "unreachable",
        unreachableReason: reason || "permanent_delivery_error",
        status: "inactive",
        statusReason: reason || "permanent_delivery_error",
        statusChangedAt: at,
        statusChangedBy: "system",
        consecutiveFailureCount: (Number(getChat(id, filePath)?.consecutiveFailureCount) || 0) + 1
    }, filePath);
}

// Khôi phục một chat khỏi trạng thái unreachable do quản trị viên quyết định.
function clearUnreachable(chatId, filePath = FILE_PATH) {
    const id = normalizeChatId(chatId);
    if (!id) return null;
    return updateChat(id, {
        admissionStatus: "admitted",
        unreachableReason: null,
        status: "active",
        statusReason: null,
        statusChangedAt: nowIso(),
        statusChangedBy: "admin",
        consecutiveFailureCount: 0
    }, filePath);
}

function updateChat(chatId, changes = {}, filePath = FILE_PATH) {
    const id = normalizeChatId(chatId);
    if (!id) return null;
    const data = readDirectory(filePath);
    const key = scopedChatKey(id);
    if (data.deletedChatIds[key] && changes.restoreDeleted !== true) return null;
    if (changes.restoreDeleted === true) delete data.deletedChatIds[key];
    const existing = data.chats[key] || normalizeRecord(id, {}, {});
    const record = normalizeRecord(id, changes, existing);
    data.chats[key] = record;
    writeDirectory(data, filePath);
    return record;
}

// Các trường mà việc đối chiếu lúc khởi động thực sự có thể thay đổi. Dùng để
// biết một bản ghi có thật sự đổi hay không, thay vì so sánh cả object.
const RECONCILE_FIELDS = Object.freeze(["chatType", "displayName", "userId", "chatTitle"]);

function reconcileFieldChanged(before, after) {
    for (const field of RECONCILE_FIELDS) {
        if (String(before?.[field] ?? "") !== String(after?.[field] ?? "")) return true;
    }
    return false;
}

// Đối chiếu sổ chat trong MỘT LƯỢT: đọc một lần, gộp trong bộ nhớ, ghi TỐI ĐA một lần.
//
// Vì sao cần: cách cũ gọi upsertChat() cho từng bản ghi, mà mỗi lần như vậy lại đọc
// cả sổ rồi ghi lại cả sổ. Với 500 bản ghi tương tác và đăng ký, khởi động tạo ra
// 500 lần ghi Firestore cho cùng một tài liệu — chậm và tốn bộ nhớ vô ích.
//
// Giữ nguyên mọi thứ đang có: status, notificationOverrides, createdAt, các trường
// khác của bản ghi, và không bao giờ hồi sinh chat đã xoá. `updatedAt` chỉ đổi khi
// dữ liệu hiển thị thực sự thay đổi, nên khởi động lại nhiều lần không làm bẩn sổ.
function reconcileChatDirectory(entries = [], filePath = FILE_PATH) {
    const data = readDirectory(filePath);
    let changed = 0;

    for (const input of entries) {
        const chatId = normalizeChatId(input?.chatId);
        if (!chatId) continue;

        const key = scopedChatKey(chatId);
        // Chat đã bị xoá vĩnh viễn thì không được dựng lại.
        if (data.deletedChatIds[key]) continue;

        const existing = data.chats[key];
        const merged = normalizeRecord(chatId, input, existing || {});
        if (!merged) continue;

        if (!existing) {
            data.chats[key] = merged;
            changed += 1;
            continue;
        }

        // Giữ nguyên updatedAt nếu không có gì đổi.
        merged.updatedAt = existing.updatedAt || merged.updatedAt;
        if (!reconcileFieldChanged(existing, merged)) continue;

        merged.updatedAt = nowIso();
        data.chats[key] = merged;
        changed += 1;
    }

    // Chỉ ghi khi thật sự có thay đổi.
    if (changed > 0) writeDirectory(data, filePath);
    return changed;
}

// Xoá một chat khỏi sổ của bot hiện tại.
//
//   hard = false  → chỉ ĐỔI TRẠNG THÁI sang "removed". Bản ghi vẫn còn, đăng ký
//                   vẫn còn, chỉ ngừng gửi tin. Có thể bật lại.
//   hard = true   → XOÁ VĨNH VIỄN bản ghi trong sổ chat và ghi nhớ vào
//                   deletedChatIds để chat không hiện lại trên dashboard.
//
// Cả hai chế độ KHÔNG xoá đăng ký (subscriptions) và KHÔNG xoá lịch sử tương tác
// (interactions) — dữ liệu đó thuộc về người dùng, không phải của sổ chat. Chúng
// cũng chỉ đụng tới bot hiện tại, không bao giờ sang bot khác.
//
// Trả về { record, hadDirectoryRecord, hard } hoặc null nếu chatId không hợp lệ.
function removeChat(chatId, hard = false, filePath = FILE_PATH) {
    const id = normalizeChatId(chatId);
    if (!id) return null;

    if (!hard) {
        const record = setChatStatus(id, "removed", "admin", "admin_removed", filePath);
        return record ? { record, hadDirectoryRecord: true, hard: false } : null;
    }

    const data = readDirectory(filePath);
    const key = scopedChatKey(id);
    const existing = data.chats[key] || null;
    // Ghi nhớ việc xoá kể cả khi KHÔNG có bản ghi trong sổ chat. Một chat có thể
    // xuất hiện trên dashboard chỉ nhờ dữ liệu tương tác/đăng ký; trước đây
    // trường hợp đó trả null nên API thành 404 dù chat đang hiện trên màn hình.
    delete data.chats[key];
    data.deletedChatIds[key] = { deletedAt: nowIso(), deletedBy: "admin" };
    writeDirectory(data, filePath);
    return { record: existing, hadDirectoryRecord: Boolean(existing), hard: true };
}

// Khóa (đã có phạm vi bot) của những chat đã bị xoá vĩnh viễn. Dùng để dashboard
// không hiển thị lại chat vừa xoá qua dữ liệu tương tác/đăng ký.
function getDeletedChatIds(filePath = FILE_PATH) {
    return Object.keys(readDirectory(filePath).deletedChatIds || {});
}

function isChatDeleted(chatId, filePath = FILE_PATH) {
    const id = normalizeChatId(chatId);
    if (!id) return false;
    return Boolean(readDirectory(filePath).deletedChatIds[scopedChatKey(id)]);
}

function classifyChatError(error) {
    const message = String(error?.message || error || "");
    const status = Number(error?.response?.statusCode || error?.response?.status || error?.statusCode || (message.match(/\b(408|410|403|429|5\d\d)\b/) || [])[1] || 0) || null;
    const invalid = status === 410 && /chat[_ ]id\s+is\s+invalid/i.test(message);
    const forbidden = status === 403 && /(chat|user|group|blocked|forbidden|not found|removed)/i.test(message);
    const transient = status === 408 || status === 429 || (status >= 500 && status <= 599) || /timeout|network|econn|socket/i.test(message);
    return {
        status,
        kind: invalid ? "permanent_invalid" : (forbidden ? "permanent_forbidden" : (transient ? "transient" : "unknown")),
        permanent: invalid || forbidden
    };
}

function recordDeliverySuccess(chatId, filePath = FILE_PATH) {
    const current = getChat(chatId, filePath);
    const history = Array.isArray(current?.deliveryHistory) ? current.deliveryHistory.slice(-49) : [];
    history.push({ result: "success", at: nowIso() });
    // Gửi được ⇒ chat đã liên lạc được trở lại. Đây là ĐƯỜNG KHÔI PHỤC sau khi
    // bị đánh dấu unreachable: một lần gửi thành công tự xoá cờ và bật lại chat —
    // nhưng CHỈ khi chat bị tạm ngưng bởi HỆ THỐNG, không đụng tới quyết định của
    // quản trị viên ("disabled"/"removed").
    const systemSuspended = current?.statusChangedBy === "system";
    return updateChat(chatId, {
        status: systemSuspended ? "active" : (current?.status || "active"),
        statusReason: systemSuspended ? null : current?.statusReason,
        admissionStatus: "admitted",
        unreachableReason: null,
        consecutiveFailureCount: 0,
        lastSuccessfulDeliveryAt: nowIso(),
        lastRecoveredAt: current?.lastError ? nowIso() : current?.lastRecoveredAt,
        deliveryHistory: history
    }, filePath);
}

function recordDeliveryFailure(chatId, error, metadata = {}, filePath = FILE_PATH) {
    const current = getChat(chatId, filePath) || upsertChat({ chatId }, filePath);
    const classification = classifyChatError(error);
    const count = (Number(current?.consecutiveFailureCount) || 0) + 1;
    const shouldSuspend = classification.permanent || (classification.kind === "transient" && count >= (metadata.maxConsecutiveFailures || 3));
    const preserveManualStatus = current?.status === "disabled" || current?.status === "removed";
    const at = nowIso();
    const errorRecord = {
        code: error?.code || null,
        status: classification.status,
        message: String(error?.message || error || "Unknown error"),
        feature: metadata.feature || null,
        operation: metadata.operation || null,
        at
    };
    const history = Array.isArray(current?.deliveryHistory) ? current.deliveryHistory.slice(-49) : [];
    history.push({ result: "failed", ...errorRecord });
    const permanentReason = classification.kind === "permanent_invalid"
        ? "chat_id_invalid"
        : classification.kind === "permanent_forbidden" ? "chat_forbidden" : null;
    return updateChat(chatId, {
        status: shouldSuspend && !preserveManualStatus ? "inactive" : (current?.status || "active"),
        statusReason: shouldSuspend && !preserveManualStatus ? (classification.kind === "permanent_invalid" ? "chat_id_invalid" : classification.kind === "permanent_forbidden" ? "chat_forbidden" : "consecutive_failures") : current?.statusReason,
        // Lỗi VĨNH VIỄN ⇒ chat không liên lạc được. Đánh dấu để loại khỏi phát tin, nhưng
        // KHÔNG xoá MSSV/đăng ký — quản trị viên vẫn khôi phục được.
        admissionStatus: permanentReason ? "unreachable" : (current?.admissionStatus || "admitted"),
        unreachableReason: permanentReason || current?.unreachableReason || null,
        statusChangedAt: shouldSuspend && !preserveManualStatus ? at : current?.statusChangedAt,
        statusChangedBy: shouldSuspend && !preserveManualStatus ? "system" : current?.statusChangedBy,
        consecutiveFailureCount: count,
        lastError: errorRecord,
        deliveryHistory: history
    }, filePath);
}

function setChatStatus(chatId, status, actor = "admin", reason = null, filePath = FILE_PATH) {
    if (!STATUSES.has(status)) throw new Error(`Trạng thái chat không hợp lệ: ${status}`);
    return updateChat(chatId, {
        status,
        statusReason: reason,
        statusChangedAt: nowIso(),
        statusChangedBy: actor,
        consecutiveFailureCount: status === "active" ? 0 : (getChat(chatId, filePath)?.consecutiveFailureCount || 0)
    }, filePath);
}

function setFeatureOverride(chatId, feature, enabled, filePath = FILE_PATH) {
    if (!FEATURES.includes(feature)) throw new Error(`Tính năng không hợp lệ: ${feature}`);
    const current = getChat(chatId, filePath) || upsertChat({ chatId }, filePath);
    return updateChat(chatId, {
        notificationOverrides: { ...(current.notificationOverrides || {}), [feature]: enabled == null ? null : Boolean(enabled) }
    }, filePath);
}

module.exports = {
    ADMISSION_STATUSES,
    FEATURES,
    FILE_PATH,
    SCHEMA_VERSION,
    classifyChatError,
    clearUnreachable,
    getAllChats,
    getChat,
    getDeletedChatIds,
    isChatDeleted,
    markChatAdmitted,
    markChatUnreachable,
    normalizeAdmissionStatus,
    normalizeChatType,
    reconcileChatDirectory,
    removeChat,
    isChatEligible,
    readDirectory,
    recordDeliveryFailure,
    recordDeliverySuccess,
    setChatStatus,
    setFeatureOverride,
    updateChat,
    upsertChat
};
