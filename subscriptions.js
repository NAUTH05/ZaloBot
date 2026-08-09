const fs = require("fs");
const path = require("path");

const FILE_PATH = path.join(__dirname, "subscriptions.json");

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

function getSubscription(chatId) {
    return getAllSubscriptions()[String(chatId)] || null;
}

// /find chỉ lưu MSSV. Người dùng phải gọi /dangky để bật thông báo.
function saveStudent(chatId, { studentId, studentName }) {
    const subscriptions = getAllSubscriptions();
    const key = String(chatId);
    const existing = subscriptions[key];
    subscriptions[key] = {
        studentId,
        studentName: studentName || "",
        notificationsEnabled: existing?.studentId === studentId && existing.notificationsEnabled === true,
        updatedAt: new Date().toISOString()
    };
    writeSubscriptions(subscriptions);
    return subscriptions[key];
}

function enableNotifications(chatId, { studentId, studentName }) {
    const subscriptions = getAllSubscriptions();
    const key = String(chatId);
    subscriptions[key] = {
        ...(subscriptions[key] || {}),
        studentId,
        studentName: studentName || "",
        notificationsEnabled: true,
        updatedAt: new Date().toISOString()
    };
    writeSubscriptions(subscriptions);
    return subscriptions[key];
}

function disableNotifications(chatId) {
    const subscriptions = getAllSubscriptions();
    const key = String(chatId);
    if (!subscriptions[key]?.notificationsEnabled) return false;
    subscriptions[key].notificationsEnabled = false;
    subscriptions[key].updatedAt = new Date().toISOString();
    writeSubscriptions(subscriptions);
    return true;
}

function getEnabledSubscriptions() {
    return Object.fromEntries(
        Object.entries(getAllSubscriptions())
            .filter(([, subscription]) => subscription.notificationsEnabled === true)
    );
}

module.exports = {
    FILE_PATH,
    disableNotifications,
    enableNotifications,
    getAllSubscriptions,
    getEnabledSubscriptions,
    getSubscription,
    saveStudent
};
