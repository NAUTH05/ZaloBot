const path = require("path");
const { readJsonStore, writeJsonStore } = require("./firestorePersistence");
const { LEGACY_TARGET_DAY_CUTOFF, deriveLegacyTargetDayOffset } = require("./scheduleDatePolicy");
const { LEGACY_BOT_ID, normalizeBotId, scopeKey } = require("./bots");

const FILE_PATH = path.join(__dirname, "subscriptions.json");
const CONTEXT_VERSION = 2;
const DEFAULT_NOTIFICATION_TIME = "06:00";
// Mỗi mốc giờ nhận lịch tự chọn lịch của NGÀY NÀO: 0 = hôm nay, 1 = hôm sau.
const TARGET_DAY_TODAY = 0;
const TARGET_DAY_TOMORROW = 1;
const TARGET_DAY_OFFSETS = Object.freeze([TARGET_DAY_TODAY, TARGET_DAY_TOMORROW]);

function normalizeNotificationTime(value, fallback = DEFAULT_NOTIFICATION_TIME) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) return fallback;
    const match = raw.match(/^(?:([01]\d|2[0-3]):([0-5]\d))$/);
    if (!match) return null;
    return `${match[1]}:${match[2]}`;
}

// Chấp nhận 0/1 dạng số hoặc chuỗi. Giá trị thiếu/không hợp lệ được suy ra từ
// chính sách cũ theo giờ, để bản ghi cũ giữ nguyên hành vi (trước 20:00 là hôm
// nay, từ 20:00 là hôm sau). Nhờ vậy một bản ghi thiếu trường không bao giờ làm
// mọi mốc 20:00 đổ về lịch hôm nay.
function normalizeTargetDayOffset(value, time) {
    if (value === 0 || value === "0") return TARGET_DAY_TODAY;
    if (value === 1 || value === "1") return TARGET_DAY_TOMORROW;
    if (value === TARGET_DAY_TODAY || value === TARGET_DAY_TOMORROW) return value;
    return deriveLegacyTargetDayOffset(time);
}

// Khóa nhận dạng một mốc: cùng giờ nhưng khác ngày đích là HAI mốc riêng biệt.
function notificationTimeKey(time, targetDayOffset) {
    return `${time}#${normalizeTargetDayOffset(targetDayOffset, time)}`;
}

function normalizeNotificationTimes(subscription) {
    const rawTimes = Array.isArray(subscription?.notificationTimes)
        ? subscription.notificationTimes
        : (subscription?.notificationTime ? [subscription.notificationTime] : []);
    const seen = new Set();
    const usedIds = new Set();
    const times = [];
    for (const raw of rawTimes) {
        const id = Number(raw?.id);
        const time = normalizeNotificationTime(raw?.time ?? raw);
        if (!time) continue;
        const targetDayOffset = normalizeTargetDayOffset(raw?.targetDayOffset, time);
        const key = notificationTimeKey(time, targetDayOffset);
        // Khử trùng theo (giờ + ngày đích), không phải chỉ theo giờ.
        if (seen.has(key)) continue;
        seen.add(key);
        const normalizedId = Number.isInteger(id) && id > 0 && !usedIds.has(id)
            ? id
            : nextNotificationTimeId(times);
        usedIds.add(normalizedId);
        times.push({
            id: normalizedId,
            time,
            targetDayOffset,
            createdAt: raw?.createdAt || new Date().toISOString(),
            updatedAt: raw?.updatedAt || raw?.createdAt || new Date().toISOString()
        });
    }
    return times.sort((left, right) => left.id - right.id);
}

// Bản ghi cũ chưa có targetDayOffset: trả về giá trị sẽ được suy ra, để script
// di trú và giao diện hiển thị đúng mà không cần ghi đè.
function needsTargetDayMigration(subscription) {
    const rawTimes = Array.isArray(subscription?.notificationTimes) ? subscription.notificationTimes : [];
    return rawTimes.some((raw) => {
        const time = normalizeNotificationTime(raw?.time ?? raw);
        if (!time) return false;
        return !TARGET_DAY_OFFSETS.includes(raw?.targetDayOffset) && raw?.targetDayOffset !== "0" && raw?.targetDayOffset !== "1";
    });
}

function nextNotificationTimeId(times) {
    return times.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
}

function getAllSubscriptions() {
    try {
        const data = readJsonStore(FILE_PATH, FILE_PATH, {});
        return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch (error) {
        console.error("Không đọc được subscriptions.json:", error.message);
        return {};
    }
}

function writeSubscriptions(subscriptions) {
    writeJsonStore(FILE_PATH, FILE_PATH, subscriptions);
}

function normalizeContext(context) {
    if (!context || context.chatId == null || context.userId == null) {
        throw new Error("Thiếu chatId hoặc userId khi xử lý đăng ký");
    }
    return {
        botId: normalizeBotId(context.botId) || LEGACY_BOT_ID,
        chatId: String(context.chatId),
        userId: String(context.userId),
        userDisplayName: String(context.userDisplayName || "")
    };
}

// Khóa đăng ký có phạm vi theo bot: cùng một Chat ID / User ID ở bot 2 là một
// đăng ký KHÁC với ở bot 1, nên chúng không bao giờ ghi đè lên nhau.
// Bot 1 không có tiền tố — dữ liệu hiện có được dùng nguyên trạng, không cần di trú.
function createSubscriptionKey(contextInput) {
    const context = normalizeContext(contextInput);
    return scopeKey(context.botId, `${encodeURIComponent(context.chatId)}::${encodeURIComponent(context.userId)}`);
}

function isCurrentSubscription(subscription) {
    return subscription?.contextVersion === CONTEXT_VERSION &&
        subscription.chatId != null && subscription.userId != null;
}

function getSubscription(context, filePath = FILE_PATH) {
    const data = readJsonStore(filePath, FILE_PATH, {});
    return data?.[createSubscriptionKey(context)] || null;
}

function removeLegacyChatRecord(subscriptions, context) {
    // Schema cũ dùng duy nhất chatId nên có thể làm lộ lịch giữa nhiều thành viên trong nhóm.
    delete subscriptions[String(context.chatId)];
}

// /luumssv chỉ lưu MSSV cho đúng user trong đúng chat. /nhanlich mới bật thông báo.
function saveStudent(contextInput, { studentId, studentName }, filePath = FILE_PATH) {
    const context = normalizeContext(contextInput);
    const subscriptions = readJsonStore(filePath, FILE_PATH, {});
    const key = createSubscriptionKey(context);
    const existing = subscriptions[key];
    removeLegacyChatRecord(subscriptions, context);
    subscriptions[key] = {
        contextVersion: CONTEXT_VERSION,
        ...context,
        studentId,
        studentName: studentName || "",
        notificationTimes: normalizeNotificationTimes(existing),
        notificationsEnabled: existing?.studentId === studentId && existing.notificationsEnabled === true,
        classStartNotificationsEnabled: existing?.studentId === studentId && existing.classStartNotificationsEnabled === true,
        updatedAt: new Date().toISOString()
    };
    writeJsonStore(filePath, FILE_PATH, subscriptions);
    return subscriptions[key];
}

function enableNotifications(contextInput, { studentId, studentName, notificationTime, targetDayOffset } = {}, filePath = FILE_PATH) {
    const context = normalizeContext(contextInput);
    const subscriptions = readJsonStore(filePath, FILE_PATH, {});
    const key = createSubscriptionKey(context);
    removeLegacyChatRecord(subscriptions, context);
    const existing = subscriptions[key] || {};
    const notificationTimes = normalizeNotificationTimes(existing);
    const normalizedTime = normalizeNotificationTime(notificationTime, null);
    if (normalizedTime) {
        const offset = normalizeTargetDayOffset(targetDayOffset, normalizedTime);
        // Cùng giờ nhưng khác ngày đích là hai mốc riêng, nên chỉ bỏ qua khi
        // trùng cả giờ lẫn ngày đích.
        const duplicate = notificationTimes.some((item) => item.time === normalizedTime && item.targetDayOffset === offset);
        if (!duplicate) {
            const now = new Date().toISOString();
            notificationTimes.push({ id: nextNotificationTimeId(notificationTimes), time: normalizedTime, targetDayOffset: offset, createdAt: now, updatedAt: now });
        }
    }
    if (notificationTimes.length === 0) {
        const now = new Date().toISOString();
        notificationTimes.push({
            id: 1,
            time: DEFAULT_NOTIFICATION_TIME,
            targetDayOffset: deriveLegacyTargetDayOffset(DEFAULT_NOTIFICATION_TIME),
            createdAt: now,
            updatedAt: now
        });
    }
    subscriptions[key] = {
        ...existing,
        contextVersion: CONTEXT_VERSION,
        ...context,
        studentId,
        studentName: studentName || "",
        notificationTimes,
        notificationsEnabled: true,
        classStartNotificationsEnabled: existing.studentId === studentId && existing.classStartNotificationsEnabled === true,
        updatedAt: new Date().toISOString()
    };
    writeJsonStore(filePath, FILE_PATH, subscriptions);
    return subscriptions[key];
}

function disableNotifications(context, filePath = FILE_PATH) {
    const subscriptions = readJsonStore(filePath, FILE_PATH, {});
    const key = createSubscriptionKey(context);
    if (!subscriptions[key]?.notificationsEnabled) return false;
    subscriptions[key].notificationsEnabled = false;
    subscriptions[key].updatedAt = new Date().toISOString();
    writeJsonStore(filePath, FILE_PATH, subscriptions);
    return true;
}

function enableClassStartNotifications(contextInput, filePath = FILE_PATH) {
    const subscriptions = readJsonStore(filePath, FILE_PATH, {});
    const key = createSubscriptionKey(contextInput);
    const subscription = subscriptions[key];
    if (!isCurrentSubscription(subscription) || !subscription.studentId) return null;
    subscription.classStartNotificationsEnabled = true;
    subscription.updatedAt = new Date().toISOString();
    writeJsonStore(filePath, FILE_PATH, subscriptions);
    return subscription;
}

function disableClassStartNotifications(contextInput, filePath = FILE_PATH) {
    const subscriptions = readJsonStore(filePath, FILE_PATH, {});
    const key = createSubscriptionKey(contextInput);
    const subscription = subscriptions[key];
    if (!subscription?.classStartNotificationsEnabled) return false;
    subscription.classStartNotificationsEnabled = false;
    subscription.updatedAt = new Date().toISOString();
    writeJsonStore(filePath, FILE_PATH, subscriptions);
    return true;
}

// Sửa một mốc theo ID: đổi được cả giờ lẫn ngày đích. Bỏ trống ngày đích thì
// giữ nguyên giá trị đang có, không suy đoán lại theo chính sách cũ.
function updateNotificationTime(contextInput, timeId, notificationTime, targetDayOffset, filePath = FILE_PATH) {
    const subscriptions = readJsonStore(filePath, FILE_PATH, {});
    const key = createSubscriptionKey(contextInput);
    const subscription = subscriptions[key];
    if (!subscription) return null;
    const times = normalizeNotificationTimes(subscription);
    const index = times.findIndex((item) => Number(item.id) === Number(timeId));
    if (index < 0) return null;

    const normalizedTime = normalizeNotificationTime(notificationTime, null) || times[index].time;
    const offset = targetDayOffset == null || targetDayOffset === ""
        ? times[index].targetDayOffset
        : normalizeTargetDayOffset(targetDayOffset, normalizedTime);

    // Không cho hai mốc trùng cả giờ lẫn ngày đích.
    const conflict = times.some((item, itemIndex) => itemIndex !== index && item.time === normalizedTime && item.targetDayOffset === offset);
    if (conflict) return null;

    times[index] = { ...times[index], time: normalizedTime, targetDayOffset: offset, updatedAt: new Date().toISOString() };
    subscription.notificationTimes = times;
    subscription.updatedAt = new Date().toISOString();
    writeJsonStore(filePath, FILE_PATH, subscriptions);
    return subscription;
}

function removeNotificationTime(contextInput, timeId, filePath = FILE_PATH) {
    const subscriptions = readJsonStore(filePath, FILE_PATH, {});
    const key = createSubscriptionKey(contextInput);
    const subscription = subscriptions[key];
    if (!subscription) return null;
    const times = normalizeNotificationTimes(subscription);
    const removed = times.find((item) => Number(item.id) === Number(timeId));
    if (!removed) return null;
    subscription.notificationTimes = times.filter((item) => Number(item.id) !== Number(timeId));
    if (subscription.notificationTimes.length === 0) subscription.notificationsEnabled = false;
    subscription.updatedAt = new Date().toISOString();
    writeJsonStore(filePath, FILE_PATH, subscriptions);
    return { subscription, removed };
}

function updateSubscriptionMetadata(contextInput, changes = {}, filePath = FILE_PATH) {
    const context = normalizeContext(contextInput);
    const subscriptions = readJsonStore(filePath, FILE_PATH, {});
    const key = createSubscriptionKey(context);
    const subscription = subscriptions[key];
    if (!subscription) return null;
    if (changes.studentId != null) {
        const studentId = String(changes.studentId).trim();
        if (studentId !== subscription.studentId) subscription.classStartNotificationsEnabled = false;
        subscription.studentId = studentId;
    }
    if (changes.studentName != null) subscription.studentName = String(changes.studentName).trim();
    if (changes.userDisplayName != null) subscription.userDisplayName = String(changes.userDisplayName).trim();
    subscription.updatedAt = new Date().toISOString();
    writeJsonStore(filePath, FILE_PATH, subscriptions);
    return subscription;
}

function deleteSubscription(contextInput, filePath = FILE_PATH) {
    const subscriptions = readJsonStore(filePath, FILE_PATH, {});
    const key = createSubscriptionKey(contextInput);
    if (!subscriptions[key]) return null;
    const removed = subscriptions[key];
    delete subscriptions[key];
    writeJsonStore(filePath, FILE_PATH, subscriptions);
    return removed;
}

// Di trú idempotent cho bản ghi cũ chưa có targetDayOffset: ghi lại giá trị suy
// ra từ chính sách trước 20:00 / từ 20:00. Không đụng tới id, MSSV, quyền sở
// hữu chat/user, trạng thái bật-tắt hay lịch sử gửi tin. Chạy lại lần hai không
// ghi gì thêm.
function migrateNotificationTargetDays(filePath = FILE_PATH) {
    const subscriptions = readJsonStore(filePath, FILE_PATH, {});
    let changedSubscriptions = 0;
    let migratedTimes = 0;

    for (const [key, subscription] of Object.entries(subscriptions)) {
        const rawTimes = Array.isArray(subscription?.notificationTimes) ? subscription.notificationTimes : [];
        const missing = rawTimes.filter((raw) => raw?.targetDayOffset !== TARGET_DAY_TODAY && raw?.targetDayOffset !== TARGET_DAY_TOMORROW).length;
        if (missing === 0) continue;
        subscriptions[key] = { ...subscription, notificationTimes: normalizeNotificationTimes(subscription) };
        changedSubscriptions += 1;
        migratedTimes += missing;
    }

    if (changedSubscriptions > 0) writeJsonStore(filePath, FILE_PATH, subscriptions);
    return { changedSubscriptions, migratedTimes };
}

function getEnabledSubscriptions() {
    return Object.fromEntries(
        Object.entries(getAllSubscriptions())
            .filter(([, subscription]) => isCurrentSubscription(subscription) && subscription.notificationsEnabled === true)
            .map(([key, subscription]) => [key, {
                ...subscription,
                notificationTimes: normalizeNotificationTimes(subscription)
            }])
    );
}

function getClassStartNotificationSubscriptions() {
    return Object.fromEntries(
        Object.entries(getAllSubscriptions())
            .filter(([, subscription]) => isCurrentSubscription(subscription) &&
                subscription.classStartNotificationsEnabled === true && subscription.studentId)
    );
}

module.exports = {
    CONTEXT_VERSION,
    DEFAULT_NOTIFICATION_TIME,
    FILE_PATH,
    TARGET_DAY_OFFSETS,
    TARGET_DAY_TODAY,
    TARGET_DAY_TOMORROW,
    createSubscriptionKey,
    deleteSubscription,
    disableClassStartNotifications,
    disableNotifications,
    enableClassStartNotifications,
    enableNotifications,
    getAllSubscriptions,
    getClassStartNotificationSubscriptions,
    getEnabledSubscriptions,
    getSubscription,
    isCurrentSubscription,
    migrateNotificationTargetDays,
    needsTargetDayMigration,
    nextNotificationTimeId,
    normalizeNotificationTime,
    normalizeNotificationTimes,
    normalizeTargetDayOffset,
    notificationTimeKey,
    removeNotificationTime,
    saveStudent,
    updateNotificationTime,
    updateSubscriptionMetadata
};
