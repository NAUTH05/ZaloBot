const fs = require("fs");
const path = require("path");
const { getVietnamDateInfo } = require("./timezone");
const { escapeMarkdown } = require("./richText");

const FILE_PATH = path.join(__dirname, "dutyScheduleData.json");
const DUTY_SCHEMA_VERSION = 1;

function pad2(num) {
    return String(num).padStart(2, "0");
}

function readDutyData(filePath = FILE_PATH) {
    if (!fs.existsSync(filePath)) {
        return {
            schemaVersion: DUTY_SCHEMA_VERSION,
            schedules: [],
            subscriptions: {}
        };
    }
    try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return {
            schemaVersion: DUTY_SCHEMA_VERSION,
            schedules: Array.isArray(data.schedules) ? data.schedules : [],
            subscriptions: data.subscriptions && typeof data.subscriptions === "object" ? data.subscriptions : {}
        };
    } catch (error) {
        console.error("Không đọc được dutyScheduleData.json:", error.message);
        return {
            schemaVersion: DUTY_SCHEMA_VERSION,
            schedules: [],
            subscriptions: {}
        };
    }
}

function enableDutyNotifications(context, filePath = FILE_PATH) {
    const chatId = String(context?.chatId || "");
    if (!chatId) return null;

    const data = readDutyData(filePath);
    const title = context.chatTitle || context.userDisplayName || `Chat ${chatId}`;
    const entry = {
        chatId,
        chatTitle: title,
        enabled: true,
        registeredAt: new Date().toISOString()
    };

    data.subscriptions[chatId] = entry;
    writeDutyData(data, filePath);
    return entry;
}

function disableDutyNotifications(context, filePath = FILE_PATH) {
    const chatId = String(context?.chatId || "");
    if (!chatId) return false;

    const data = readDutyData(filePath);
    if (!data.subscriptions[chatId]) return false;

    delete data.subscriptions[chatId];
    writeDutyData(data, filePath);
    return true;
}

function getDutySubscriptions(filePath = FILE_PATH) {
    const data = readDutyData(filePath);
    return Object.values(data.subscriptions || {}).filter((sub) => sub && sub.enabled);
}


function writeDutyData(data, filePath = FILE_PATH) {
    const temporaryPath = `${filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(temporaryPath, filePath);
}

/**
 * Phân tích cú pháp chuỗi lịch trực.
 * Hỗ trợ các định dạng:
 * - [25/08] [Nguyễn Văn A - Trần Thị B]
 * - [25/08] Nguyễn Văn A - Trần Thị B
 * - 25/08 [Nguyễn Văn A - Trần Thị B]
 * - 25/08 Nguyễn Văn A - Trần Thị B
 */
function parseDutyInput(rawInput) {
    if (!rawInput || typeof rawInput !== "string") return null;
    const str = rawInput.trim();
    if (!str) return null;

    // Pattern bắt ngày dd/mm hoặc dd/mm/yyyy kèm theo cặp ngoặc vuông hoặc không
    const match = str.match(/^\[?(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\]?\s*\[?([\s\S]+?)\]?\s*$/);
    if (!match) return null;

    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = match[3] ? Number(match[3]) : undefined;

    if (day < 1 || day > 31 || month < 1 || month > 12) return null;

    let assigned = match[4].trim();
    // Xóa dấu ] thừa ở cuối nếu người dùng chỉ đóng ngoặc 1 phần
    if (assigned.endsWith("]")) {
        assigned = assigned.slice(0, -1).trim();
    }
    if (!assigned) return null;

    const dateStr = `${pad2(day)}/${pad2(month)}`;

    return {
        day,
        month,
        year,
        dateStr,
        assigned
    };
}

function parseDutyInputs(rawInput) {
    const lines = Array.isArray(rawInput)
        ? rawInput
        : String(rawInput || "").split(/\r?\n/);
    const nonEmptyLines = lines
        .map((line, index) => ({ lineNumber: index + 1, text: String(line || "").trim() }))
        .filter((line) => line.text);

    if (nonEmptyLines.length === 0) return [];

    return nonEmptyLines.map((line) => {
        const parsed = parseDutyInput(line.text);
        if (!parsed) {
            throw new Error(`Cú pháp lịch trực không hợp lệ ở dòng ${line.lineNumber}: ${line.text}`);
        }
        return parsed;
    });
}

function addDutySchedule(rawInput, filePath = FILE_PATH) {
    const parsed = typeof rawInput === "string" ? parseDutyInput(rawInput) : rawInput;
    if (!parsed || !parsed.dateStr || !parsed.assigned) {
        throw new Error("Cú pháp lịch trực không hợp lệ. Ví dụ: [25/08] [Nguyễn Văn A - Trần Thị B]");
    }

    const data = readDutyData(filePath);
    const nextId = data.schedules.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
    const nowIso = new Date().toISOString();

    const newItem = {
        id: nextId,
        dateStr: parsed.dateStr,
        day: parsed.day,
        month: parsed.month,
        year: parsed.year,
        assigned: parsed.assigned,
        createdAt: nowIso,
        updatedAt: nowIso
    };

    data.schedules.push(newItem);
    writeDutyData(data, filePath);
    return newItem;
}

function addDutySchedules(rawInput, filePath = FILE_PATH) {
    const parsedItems = parseDutyInputs(rawInput);
    if (parsedItems.length === 0) {
        throw new Error("Chưa có dòng lịch trực nào để thêm.");
    }

    const data = readDutyData(filePath);
    let nextId = data.schedules.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
    const nowIso = new Date().toISOString();
    const newItems = parsedItems.map((parsed) => ({
        id: nextId++,
        dateStr: parsed.dateStr,
        day: parsed.day,
        month: parsed.month,
        year: parsed.year,
        assigned: parsed.assigned,
        createdAt: nowIso,
        updatedAt: nowIso
    }));

    data.schedules.push(...newItems);
    writeDutyData(data, filePath);
    return newItems;
}

function findDutyIndex(schedules, target) {
    const raw = String(target || "").trim();
    if (!raw) return -1;

    // 1. Kiểm tra ID dạng #1 hoặc 1
    const idMatch = raw.match(/^#?(\d+)$/);
    if (idMatch) {
        const targetId = Number(idMatch[1]);
        const index = schedules.findIndex((item) => Number(item.id) === targetId);
        if (index !== -1) return index;
    }

    // 2. Kiểm tra theo ngày dạng [dd/mm] hoặc dd/mm
    const dateMatch = raw.match(/^\[?(\d{1,2})\/(\d{1,2})\]?$/);
    if (dateMatch) {
        const targetDateStr = `${pad2(Number(dateMatch[1]))}/${pad2(Number(dateMatch[2]))}`;
        const index = schedules.findIndex((item) => item.dateStr === targetDateStr);
        if (index !== -1) return index;
    }

    return -1;
}

function updateDutySchedule(target, newInput, filePath = FILE_PATH) {
    const data = readDutyData(filePath);
    const index = findDutyIndex(data.schedules, target);
    if (index === -1) return null;

    const existing = data.schedules[index];
    const parsed = typeof newInput === "string" ? parseDutyInput(newInput) : newInput;

    if (parsed) {
        data.schedules[index] = {
            ...existing,
            dateStr: parsed.dateStr,
            day: parsed.day,
            month: parsed.month,
            year: parsed.year || existing.year,
            assigned: parsed.assigned,
            updatedAt: new Date().toISOString()
        };
    } else if (typeof newInput === "string" && newInput.trim()) {
        // Trường hợp chỉ cập nhật tên người trực mà giữ nguyên ngày cũ
        data.schedules[index] = {
            ...existing,
            assigned: newInput.trim().replace(/^\[|\]$/g, ""),
            updatedAt: new Date().toISOString()
        };
    } else {
        throw new Error("Nội dung sửa lịch trực không hợp lệ.");
    }

    writeDutyData(data, filePath);
    return data.schedules[index];
}

function deleteDutySchedule(target, filePath = FILE_PATH) {
    const data = readDutyData(filePath);
    const index = findDutyIndex(data.schedules, target);
    if (index === -1) return null;

    const deleted = data.schedules.splice(index, 1)[0];
    writeDutyData(data, filePath);
    return deleted;
}

function getDutySchedules(filePath = FILE_PATH) {
    const data = readDutyData(filePath);
    return [...data.schedules].sort((a, b) => {
        if (a.month !== b.month) return a.month - b.month;
        if (a.day !== b.day) return a.day - b.day;
        return a.id - b.id;
    });
}

function getDutyScheduleForDate(date = new Date(), filePath = FILE_PATH) {
    const dateInfo = getVietnamDateInfo(date);
    const currentDay = Number(dateInfo.day);
    const currentMonth = Number(dateInfo.month);

    const data = readDutyData(filePath);
    return data.schedules.filter(
        (item) => Number(item.day) === currentDay && Number(item.month) === currentMonth
    );
}

function formatDutyNotification(dutyItems, date = new Date()) {
    const dateInfo = getVietnamDateInfo(date);
    const headerDate = `${pad2(dateInfo.day)}/${pad2(dateInfo.month)}`;

    if (!dutyItems || dutyItems.length === 0) {
        return null; // Không có lịch trực -> Không cần gửi thông báo
    }

    const lines = dutyItems.map((item) => `> **[${escapeMarkdown(item.dateStr)}]** **[${escapeMarkdown(item.assigned)}]**`);

    return [
        `# {green}[LỊCH TRỰC] HÔM NAY ${headerDate}{/green}`,
        "",
        "📋 **Phân công trực ban hôm nay:**",
        lines.join("\n"),
        "",
        "{orange}Chúc các bạn một ngày làm việc và học tập vui vẻ!{/orange}"
    ].join("\n");
}

function formatDutyList(dutyItems) {
    if (!dutyItems || dutyItems.length === 0) {
        return (
            "# {orange}[LỊCH TRỰC] DANH SÁCH TRỐNG{/orange}\n\n" +
            "> Hiện tại chưa có lịch trực nào được phân công.\n\n" +
            "**Thêm lịch trực mới:**\n" +
            "- `/themlichtruc [dd/mm] [Name 1 - Name 2]`"
        );
    }

    const rows = dutyItems.map((item) => {
        return `## [#${item.id}] [${escapeMarkdown(item.dateStr)}]\n> **Phân công:** ${escapeMarkdown(item.assigned)}`;
    });

    return [
        `# {green}[LỊCH TRỰC] DANH SÁCH PHÂN CÔNG (${dutyItems.length}){/green}`,
        "",
        rows.join("\n\n"),
        "",
        "**Thao tác Admin:**",
        "- `/themlichtruc [dd/mm] [Name 1 - Name 2]`",
        "- `/sualichtruc [ID/Ngày] [Nội dung mới]`",
        "- `/xoalichtruc [ID/Ngày]`"
    ].join("\n");
}

module.exports = {
    FILE_PATH,
    addDutySchedule,
    addDutySchedules,
    deleteDutySchedule,
    disableDutyNotifications,
    enableDutyNotifications,
    formatDutyList,
    formatDutyNotification,
    getDutyScheduleForDate,
    getDutySchedules,
    getDutySubscriptions,
    parseDutyInput,
    parseDutyInputs,
    readDutyData,
    updateDutySchedule,
    writeDutyData
};
