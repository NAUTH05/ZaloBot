const fs = require("fs");
const path = require("path");

const FILE_PATH = path.join(__dirname, "subscriptions.json");
const CONTEXT_VERSION = 2;

function getAllSubscriptions() {
    if (!fs.existsSync(FILE_PATH)) return {};
    try {
        const data = JSON.parse(fs.readFileSync(FILE_PATH, "utf8"));
        return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch (error) {
        console.error("Không đọc được subscriptions.json:", error.message);
        return {};
    }
}

function writeSubscriptions(subscriptions) {
    const temporaryPath = `${FILE_PATH}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(subscriptions, null, 2), "utf8");
    fs.renameSync(temporaryPath, FILE_PATH);
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
        notificationsEnabled: existing?.studentId === studentId && existing.notificationsEnabled === true,
        updatedAt: new Date().toISOString()
    };
    writeSubscriptions(subscriptions);
    return subscriptions[key];
}

function enableNotifications(contextInput, { studentId, studentName }) {
    const context = normalizeContext(contextInput);
    const subscriptions = getAllSubscriptions();
    const key = createSubscriptionKey(context);
    removeLegacyChatRecord(subscriptions, context);
    subscriptions[key] = {
        ...(subscriptions[key] || {}),
        contextVersion: CONTEXT_VERSION,
        ...context,
        studentId,
        studentName: studentName || "",
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

function getEnabledSubscriptions() {
    return Object.fromEntries(
        Object.entries(getAllSubscriptions())
            .filter(([, subscription]) =>
                isCurrentSubscription(subscription) && subscription.notificationsEnabled === true
            )
    );
}

module.exports = {
    CONTEXT_VERSION,
    FILE_PATH,
    createSubscriptionKey,
    disableNotifications,
    enableNotifications,
    getAllSubscriptions,
    getEnabledSubscriptions,
    getSubscription,
    isCurrentSubscription,
    saveStudent
};
