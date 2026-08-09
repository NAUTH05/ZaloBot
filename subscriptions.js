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

function saveSubscription(chatId, { studentId, studentName }) {
    const subscriptions = getAllSubscriptions();
    subscriptions[String(chatId)] = {
        studentId,
        studentName: studentName || "",
        updatedAt: new Date().toISOString()
    };
    writeSubscriptions(subscriptions);
    return subscriptions[String(chatId)];
}

function removeSubscription(chatId) {
    const subscriptions = getAllSubscriptions();
    const key = String(chatId);
    if (!subscriptions[key]) return false;
    delete subscriptions[key];
    writeSubscriptions(subscriptions);
    return true;
}

module.exports = {
    FILE_PATH,
    getAllSubscriptions,
    getSubscription,
    removeSubscription,
    saveSubscription
};
