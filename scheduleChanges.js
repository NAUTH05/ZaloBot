const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { getApiDateTimeInfo, getVietnamDateInfo } = require("./timezone");

const FILE_PATH = path.join(__dirname, "scheduleSnapshots.json");

function text(value) {
    return value == null ? "" : String(value).trim();
}

function normalizeLesson(lesson) {
    const start = getApiDateTimeInfo(lesson.ThoiGianBD);
    const end = getApiDateTimeInfo(lesson.ThoiGianKT);
    const fallbackKey = [
        start?.dateKey,
        start ? `${start.hour}:${start.minute}` : "",
        text(lesson.TenMonHoc),
        text(lesson.TenNhom)
    ].join("|");

    return {
        key: text(lesson.ID ?? lesson.CalendarID) || fallbackKey,
        dateKey: start?.dateKey || "",
        start: start ? `${start.hour}:${start.minute}` : "",
        end: end ? `${end.hour}:${end.minute}` : "",
        subject: text(lesson.TenMonHoc),
        room: text(lesson.TenPhong),
        campus: text(lesson.TenCoSo),
        teacher: text(lesson.GiaoVien),
        group: text(lesson.TenNhom),
        status: Number(lesson.TinhTrang || 0),
        calendarType: Number(lesson.CalenType || 1),
        lessonType: Number(lesson.Type || 0),
        onlineLink: text(lesson.OnlineLink)
    };
}

function snapshotFingerprint(snapshot) {
    return crypto
        .createHash("sha256")
        .update(JSON.stringify(snapshot.lessons))
        .digest("hex");
}

function buildScheduleSnapshot(scheduleData, date = new Date()) {
    const minimumDate = getVietnamDateInfo(date).dateKey;
    const normalized = (scheduleData.lessons || [])
        .map(normalizeLesson)
        .filter((lesson) => lesson.dateKey && lesson.dateKey >= minimumDate)
        .sort((left, right) =>
            `${left.dateKey}|${left.start}|${left.key}`.localeCompare(`${right.dateKey}|${right.start}|${right.key}`)
        );
    const lessons = Object.fromEntries(normalized.map((lesson) => [lesson.key, lesson]));
    const snapshot = {
        studentId: scheduleData.studentId,
        studentName: scheduleData.studentName || "",
        minimumDate,
        lessons
    };
    snapshot.fingerprint = snapshotFingerprint(snapshot);
    return snapshot;
}

function diffSnapshots(previous, current) {
    const minimumDate = current.minimumDate;
    const previousLessons = Object.fromEntries(
        Object.entries(previous.lessons || {}).filter(([, lesson]) => lesson.dateKey >= minimumDate)
    );
    const currentLessons = current.lessons || {};
    const added = [];
    const removed = [];
    const modified = [];

    for (const [key, lesson] of Object.entries(currentLessons)) {
        if (!previousLessons[key]) {
            added.push(lesson);
        } else if (JSON.stringify(previousLessons[key]) !== JSON.stringify(lesson)) {
            modified.push({ before: previousLessons[key], after: lesson });
        }
    }
    for (const [key, lesson] of Object.entries(previousLessons)) {
        if (!currentLessons[key]) removed.push(lesson);
    }
    return { added, removed, modified };
}

// Chỉ xác nhận thay đổi sau khi thấy cùng một lịch mới ở hai lần kiểm tra liên tiếp.
// Cách này tránh báo giả khi API LHU tạm thời trả thiếu dữ liệu.
function advanceChangeState(state, currentSnapshot, observedAt = new Date().toISOString()) {
    if (!state?.baseline) {
        return {
            state: { baseline: currentSnapshot, pending: null, updatedAt: observedAt },
            confirmed: false,
            changes: null
        };
    }

    if (state.baseline.fingerprint === currentSnapshot.fingerprint) {
        return {
            state: { ...state, pending: null, updatedAt: observedAt },
            confirmed: false,
            changes: null
        };
    }

    const currentChanges = diffSnapshots(state.baseline, currentSnapshot);
    const hasActualChanges = currentChanges.added.length > 0 ||
        currentChanges.removed.length > 0 ||
        currentChanges.modified.length > 0;
    if (!hasActualChanges) {
        return {
            state: { baseline: currentSnapshot, pending: null, updatedAt: observedAt },
            confirmed: false,
            changes: null
        };
    }

    if (state.pending?.snapshot?.fingerprint === currentSnapshot.fingerprint) {
        return {
            state: { baseline: currentSnapshot, pending: null, updatedAt: observedAt },
            confirmed: true,
            changes: currentChanges
        };
    }

    return {
        state: {
            ...state,
            pending: { snapshot: currentSnapshot, firstSeenAt: observedAt },
            updatedAt: observedAt
        },
        confirmed: false,
        changes: null
    };
}

function readStates() {
    if (!fs.existsSync(FILE_PATH)) return {};
    try {
        const data = JSON.parse(fs.readFileSync(FILE_PATH, "utf8"));
        return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch (error) {
        console.error("Không đọc được scheduleSnapshots.json:", error.message);
        return {};
    }
}

function writeStates(states) {
    const temporaryPath = `${FILE_PATH}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(states, null, 2), "utf8");
    fs.renameSync(temporaryPath, FILE_PATH);
}

function initializeScheduleSnapshot(scheduleData, date = new Date(), force = false) {
    const states = readStates();
    const studentId = scheduleData.studentId;
    if (force || !states[studentId]?.baseline) {
        states[studentId] = advanceChangeState(null, buildScheduleSnapshot(scheduleData, date)).state;
        writeStates(states);
    }
}

function evaluateScheduleChange(scheduleData, date = new Date()) {
    const states = readStates();
    const studentId = scheduleData.studentId;
    const result = advanceChangeState(states[studentId], buildScheduleSnapshot(scheduleData, date));
    states[studentId] = result.state;
    writeStates(states);
    return result;
}

function statusLabel(status) {
    if (status === 6) return "Nghỉ lễ";
    if (![0, 4, 5, 10].includes(status)) return "Báo nghỉ";
    return "Đang học";
}

function formatCompactLesson(lesson) {
    const [year, month, day] = lesson.dateKey.split("-");
    const date = day ? `${day}/${month}/${year}` : "Chưa rõ ngày";
    const location = [lesson.room, lesson.campus].filter(Boolean).join(" - ");
    return [
        `${date} ${lesson.start || "?"}-${lesson.end || "?"} | ${lesson.subject || "Chưa rõ môn"}`,
        location ? `Phòng: ${location}` : "",
        lesson.teacher ? `GV: ${lesson.teacher}` : "",
        `Trạng thái: ${statusLabel(lesson.status)}`
    ].filter(Boolean).join("\n");
}

function formatModifiedLesson(change) {
    const before = change.before;
    const after = change.after;
    const details = [];
    if (before.dateKey !== after.dateKey || before.start !== after.start || before.end !== after.end) {
        details.push(`Thời gian: ${before.dateKey} ${before.start}-${before.end} → ${after.dateKey} ${after.start}-${after.end}`);
    }
    if (before.room !== after.room || before.campus !== after.campus) {
        details.push(`Phòng: ${[before.room, before.campus].filter(Boolean).join(" - ") || "?"} → ${[after.room, after.campus].filter(Boolean).join(" - ") || "?"}`);
    }
    if (before.teacher !== after.teacher) details.push(`Giảng viên: ${before.teacher || "?"} → ${after.teacher || "?"}`);
    if (before.group !== after.group) details.push(`Nhóm: ${before.group || "?"} → ${after.group || "?"}`);
    if (before.status !== after.status) details.push(`Trạng thái: ${statusLabel(before.status)} → ${statusLabel(after.status)}`);
    if (before.subject !== after.subject) details.push(`Môn: ${before.subject || "?"} → ${after.subject || "?"}`);
    if (before.calendarType !== after.calendarType) details.push("Loại lịch học/thi đã thay đổi");
    if (before.lessonType !== after.lessonType) {
        details.push(`Hình thức: ${before.lessonType === 0 ? "Lý thuyết" : "Thực hành"} → ${after.lessonType === 0 ? "Lý thuyết" : "Thực hành"}`);
    }
    if (before.onlineLink !== after.onlineLink) details.push("Liên kết học online đã thay đổi");
    return `${after.subject || before.subject || "Buổi học"}\n${details.join("\n")}`;
}

function formatScheduleChangeMessage(scheduleData, changes, date = new Date()) {
    const now = getVietnamDateInfo(date);
    const sections = [
        "⚠️ LỊCH HỌC CÓ THAY ĐỔI",
        `👤 ${scheduleData.studentName || "Sinh viên"} (${scheduleData.studentId})`,
        `🕒 Xác nhận lúc ${now.formattedDateTime}`
    ];

    if (changes.added.length) {
        sections.push(`➕ THÊM MỚI (${changes.added.length})\n${changes.added.map(formatCompactLesson).join("\n\n")}`);
    }
    if (changes.removed.length) {
        sections.push(`➖ ĐÃ XÓA (${changes.removed.length})\n${changes.removed.map(formatCompactLesson).join("\n\n")}`);
    }
    if (changes.modified.length) {
        sections.push(`✏️ ĐIỀU CHỈNH (${changes.modified.length})\n${changes.modified.map(formatModifiedLesson).join("\n\n")}`);
    }
    sections.push("Dùng /lich để kiểm tra lịch hôm nay.");
    return sections.join("\n\n");
}

module.exports = {
    FILE_PATH,
    advanceChangeState,
    buildScheduleSnapshot,
    diffSnapshots,
    evaluateScheduleChange,
    formatScheduleChangeMessage,
    initializeScheduleSnapshot,
    normalizeLesson
};
