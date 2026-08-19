const path = require("path");
const { readJsonStore, writeJsonStore } = require("./firestorePersistence");

const FILE_PATH = path.join(__dirname, "subscriptions.json");
const CONTEXT_VERSION = 2;
const DEFAULT_NOTIFICATION_TIME = "06:00";

function normalizeNotificationTime(value, fallback = DEFAULT_NOTIFICATION_TIME) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) return fallback;
    const match = raw.match(/^(?:([01]\d|2[0-3]):([0-5]\d))$/);
    if (!match) return null;
    return `${match[1]}:${match[2]}`;
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
        if (!time || seen.has(time)) continue;
        seen.add(time);
        const normalizedId = Number.isInteger(id) && id > 0 && !usedIds.has(id)
            ? id
            : nextNotificationTimeId(times);
        usedIds.add(normalizedId);
        times.push({
            id: normalizedId,
            time,
            createdAt: raw?.createdAt || new Date().toISOString(),
            updatedAt: raw?.updatedAt || raw?.createdAt || new Date().toISOString()
        });
    }
    return times.sort((left, right) => left.id - right.id);
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
        chatId: String(context.chatId),
        userId: String(context.userId),
        userDisplayName: String(context.userDisplayName || "")
    };
}

function createSubscriptionKey(contextInput) {
    const context = normalizeContext(contextInput);
    return `${encodeURIComponent(context.chatId)}::${encodeURIComponent(context.userId)}`;
}

function isCurrentSubscription(subscription) {
    return subscription?.contextVersion === CONTEXT_VERSION &&
        subscription.chatId != null && subscription.userId != null;
}

function getSubscription(context) {
    return getAllSubscriptions()[createSubscriptionKey(context)] || null;
}

function removeLegacyChatRecord(subscriptions, context) {
    // Schema cũ dùng duy nhất chatId nên có thể làm lộ lịch giữa nhiều thành viên trong nhóm.
    delete subscriptions[String(context.chatId)];
}

// /find chỉ lưu MSSV cho đúng user trong đúng chat. /dangky mới bật thông báo.
function saveStudent(contextInput, { studentId, studentName }) {
    const context = normalizeContext(contextInput);
    const subscriptions = getAllSubscriptions();
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
        updatedAt: new Date().toISOString()
    };
    writeSubscriptions(subscriptions);
    return subscriptions[key];
}

function enableNotifications(contextInput, { studentId, studentName, notificationTime } = {}) {
    const context = normalizeContext(contextInput);
    const subscriptions = getAllSubscriptions();
    const key = createSubscriptionKey(context);
    removeLegacyChatRecord(subscriptions, context);
    const existing = subscriptions[key] || {};
    const notificationTimes = normalizeNotificationTimes(existing);
    const normalizedTime = normalizeNotificationTime(notificationTime, null);
    if (normalizedTime && !notificationTimes.some((item) => item.time === normalizedTime)) {
        const now = new Date().toISOString();
        notificationTimes.push({ id: nextNotificationTimeId(notificationTimes), time: normalizedTime, createdAt: now, updatedAt: now });
    }
    if (notificationTimes.length === 0) {
        const now = new Date().toISOString();
        notificationTimes.push({ id: 1, time: DEFAULT_NOTIFICATION_TIME, createdAt: now, updatedAt: now });
    }
    subscriptions[key] = {
        ...existing,
        contextVersion: CONTEXT_VERSION,
        ...context,
        studentId,
        studentName: studentName || "",
        notificationTimes,
        notificationsEnabled: true,
        updatedAt: new Date().toISOString()
    };
    writeSubscriptions(subscriptions);
    return subscriptions[key];
}

function disableNotifications(context) {
    const subscriptions = getAllSubscriptions();
    const key = createSubscriptionKey(context);
    if (!subscriptions[key]?.notificationsEnabled) return false;
    subscriptions[key].notificationsEnabled = false;
    subscriptions[key].updatedAt = new Date().toISOString();
    writeSubscriptions(subscriptions);
    return true;
}

function updateNotificationTime(contextInput, timeId, notificationTime) {
    const subscriptions = getAllSubscriptions();
    const key = createSubscriptionKey(contextInput);
    const subscription = subscriptions[key];
    const normalizedTime = normalizeNotificationTime(notificationTime, null);
    if (!subscription || !normalizedTime) return null;
    const times = normalizeNotificationTimes(subscription);
    const index = times.findIndex((item) => Number(item.id) === Number(timeId));
    if (index < 0 || times.some((item, itemIndex) => itemIndex !== index && item.time === normalizedTime)) return null;
    times[index] = { ...times[index], time: normalizedTime, updatedAt: new Date().toISOString() };
    subscription.notificationTimes = times;
    subscription.updatedAt = new Date().toISOString();
    writeSubscriptions(subscriptions);
    return subscription;
}

function removeNotificationTime(contextInput, timeId) {
    const subscriptions = getAllSubscriptions();
    const key = createSubscriptionKey(contextInput);
    const subscription = subscriptions[key];
    if (!subscription) return null;
    const times = normalizeNotificationTimes(subscription);
    const removed = times.find((item) => Number(item.id) === Number(timeId));
    if (!removed) return null;
    subscription.notificationTimes = times.filter((item) => Number(item.id) !== Number(timeId));
    if (subscription.notificationTimes.length === 0) subscription.notificationsEnabled = false;
    subscription.updatedAt = new Date().toISOString();
    writeSubscriptions(subscriptions);
    return { subscription, removed };
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

module.exports = {
    CONTEXT_VERSION,
    DEFAULT_NOTIFICATION_TIME,
    FILE_PATH,
    createSubscriptionKey,
    disableNotifications,
    enableNotifications,
    getAllSubscriptions,
    getEnabledSubscriptions,
    getSubscription,
    isCurrentSubscription,
    normalizeNotificationTime,
    normalizeNotificationTimes,
    removeNotificationTime,
    saveStudent,
    updateNotificationTime
};
