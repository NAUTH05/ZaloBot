const path = require("path");
const { readJsonStore, writeJsonStore } = require("./firestorePersistence");

const FILE_PATH = path.join(__dirname, "adminLogs.json");

function readLogs(filePath = FILE_PATH) {
    const data = readJsonStore(filePath, FILE_PATH, { events: [] });
    return Array.isArray(data?.events) ? data.events : [];
}

function recordSystemLog(level, message, metadata = {}, filePath = FILE_PATH) {
    const events = readLogs(filePath).slice(-499);
    events.push({ level: String(level || "INFO").toUpperCase(), message: String(message || ""), at: new Date().toISOString(), ...metadata });
    writeJsonStore(filePath, FILE_PATH, { events });
}

function getSystemLogs(limit = 100, filePath = FILE_PATH) {
    return readLogs(filePath).slice(-Math.max(1, Number(limit) || 100)).reverse();
}

module.exports = { FILE_PATH, getSystemLogs, recordSystemLog };
