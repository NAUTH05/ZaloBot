const path = require("path");
const { readJsonStore, writeJsonStore } = require("./firestorePersistence");

const FILE_PATH = path.join(__dirname, "adminLogs.json");

// Số sự kiện giữ lại. Trước đây 500 — đủ cho vài ngày lỗi, nhưng quá ngắn để đối
// chiếu một sự cố đã xảy ra từ hôm trước ("06:30 hôm qua có gửi không?").
//
// 1000 mục vẫn nằm dưới giới hạn 1 MB của một document Firestore với nội dung
// ngắn, nên không phải tách store. Nội dung mỗi mục bị cắt ở MAX_MESSAGE_CHARS để
// một thông báo lỗi dài không chiếm hết chỗ của 900 mục còn lại.
const MAX_EVENTS = 1000;
const MAX_MESSAGE_CHARS = 500;

function readLogs(filePath = FILE_PATH) {
    const data = readJsonStore(filePath, FILE_PATH, { events: [] });
    return Array.isArray(data?.events) ? data.events : [];
}

function recordSystemLog(level, message, metadata = {}, filePath = FILE_PATH) {
    const events = readLogs(filePath).slice(-(MAX_EVENTS - 1));
    events.push({
        level: String(level || "INFO").toUpperCase(),
        message: String(message || "").slice(0, MAX_MESSAGE_CHARS),
        at: new Date().toISOString(),
        ...metadata
    });
    writeJsonStore(filePath, FILE_PATH, { events });
}

function getSystemLogs(limit = 100, filePath = FILE_PATH) {
    return readLogs(filePath).slice(-Math.max(1, Number(limit) || 100)).reverse();
}

module.exports = { FILE_PATH, MAX_EVENTS, getSystemLogs, recordSystemLog };
