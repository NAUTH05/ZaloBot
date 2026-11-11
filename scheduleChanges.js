const crypto = require("crypto");
const path = require("path");
const { getVietnamDateInfo, getVietnamWeekdayForDateKey } = require("./timezone");
const { escapeMarkdown } = require("./richText");
const { normalizeLesson: normalizeScheduleLesson } = require("./lhuSchedule");
const { readJsonStore, writeJsonStore } = require("./firestorePersistence");

const FILE_PATH = path.join(__dirname, "scheduleSnapshots.json");
const SNAPSHOT_SCHEMA_VERSION = 3;

function text(value) {
    return value == null ? "" : String(value).trim();
}

function normalizeLesson(lesson) {
    const normalized = normalizeScheduleLesson(lesson);

    return {
        // ID từ API chỉ là số thứ tự của kết quả và thay đổi khi lịch được sắp xếp lại.
        // NhomID + ngày/giờ mới là khóa ổn định cho từng buổi học.
        key: [normalized.identity, normalized.dateKey, normalized.startTime, normalized.endTime].join("|"),
        identity: normalized.identity,
        groupId: normalized.groupId,
        dateKey: normalized.dateKey,
        start: normalized.startTime,
        end: normalized.endTime,
        subject: normalized.subject,
        room: normalized.room,
        campus: normalized.campus,
        teacher: normalized.teacher,
        group: normalized.group,
        status: normalized.statusCode,
        calendarType: normalized.calendarType,
        lessonType: normalized.lessonTypeCode,
        onlineLink: normalized.onlineLink
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
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
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

    const unmatchedPrevious = new Map(Object.entries(previousLessons));
    const unmatchedCurrent = new Map(Object.entries(currentLessons));

    // Ghép chính xác trước để các buổi không đổi không bị ảnh hưởng khi API đánh lại ID thứ tự.
    for (const [key, currentLesson] of currentLessons ? Object.entries(currentLessons) : []) {
        const previousLesson = previousLessons[key];
        if (!previousLesson) continue;
        unmatchedPrevious.delete(key);
        unmatchedCurrent.delete(key);
        if (JSON.stringify(previousLesson) !== JSON.stringify(currentLesson)) {
            modified.push({ before: previousLesson, after: currentLesson });
        }
    }

    // Với buổi đổi ngày/giờ, ghép theo NhomID và khoảng thời gian gần nhất.
    const toTimestamp = (lesson) => Date.parse(`${lesson.dateKey}T${lesson.start || "00:00"}:00Z`);
    const maxMoveDistance = 14 * 24 * 60 * 60 * 1000;
    for (const [previousKey, previousLesson] of [...unmatchedPrevious.entries()]) {
        let bestMatch = null;
        let bestDistance = Infinity;
        for (const [currentKey, currentLesson] of unmatchedCurrent.entries()) {
            if (!previousLesson.identity || previousLesson.identity !== currentLesson.identity) continue;
            const distance = Math.abs(toTimestamp(previousLesson) - toTimestamp(currentLesson));
            if (distance < bestDistance) {
                bestDistance = distance;
                bestMatch = [currentKey, currentLesson];
            }
        }
        if (!bestMatch || bestDistance > maxMoveDistance) continue;
        modified.push({ before: previousLesson, after: bestMatch[1] });
        unmatchedPrevious.delete(previousKey);
        unmatchedCurrent.delete(bestMatch[0]);
    }

    removed.push(...unmatchedPrevious.values());
    added.push(...unmatchedCurrent.values());

    const sortLessons = (left, right) =>
        `${left.dateKey}|${left.start}|${left.subject}`.localeCompare(`${right.dateKey}|${right.start}|${right.subject}`);
    added.sort(sortLessons);
    removed.sort(sortLessons);
    modified.sort((left, right) => sortLessons(left.after, right.after));
    return { added, removed, modified };
}

function hasActualChanges(changes) {
    return changes.added.length > 0 || changes.removed.length > 0 || changes.modified.length > 0;
}

function createBaselineState(snapshot, observedAt) {
    return { baseline: snapshot, pending: null, updatedAt: observedAt };
}

// Lần 1 lúc 01:00 chỉ lưu ứng viên thay đổi, tuyệt đối không gửi thông báo.
function captureChangeState(state, currentSnapshot, observedAt = new Date().toISOString()) {
    if (!state?.baseline || state.baseline.schemaVersion !== currentSnapshot.schemaVersion) {
        return {
            state: createBaselineState(currentSnapshot, observedAt),
            captured: false
        };
    }

    if (state.baseline.fingerprint === currentSnapshot.fingerprint) {
        return {
            state: { ...state, pending: null, updatedAt: observedAt },
            captured: false
        };
    }

    const currentChanges = diffSnapshots(state.baseline, currentSnapshot);
    if (!hasActualChanges(currentChanges)) {
        return {
            state: createBaselineState(currentSnapshot, observedAt),
            captured: false
        };
    }

    return {
        state: {
            ...state,
            pending: {
                snapshot: currentSnapshot,
                capturedDate: currentSnapshot.minimumDate,
                capturedAt: observedAt
            },
            updatedAt: observedAt
        },
        captured: true
    };
}

// Lần 2 lúc 06:00 xác nhận thay đổi dựa trên so sánh bản snapshot 06:00 với baseline.
function confirmChangeState(state, currentSnapshot, observedAt = new Date().toISOString()) {
    if (!state?.baseline || state.baseline.schemaVersion !== currentSnapshot.schemaVersion) {
        return {
            state: createBaselineState(currentSnapshot, observedAt),
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
    if (!hasActualChanges(currentChanges)) {
        return {
            state: createBaselineState(currentSnapshot, observedAt),
            confirmed: false,
            changes: null
        };
    }

    return {
        state: createBaselineState(currentSnapshot, observedAt),
        confirmed: true,
        changes: currentChanges
    };
}

function readStates() {
    try {
        const data = readJsonStore(FILE_PATH, FILE_PATH, {});
        return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch (error) {
        console.error("Không đọc được scheduleSnapshots.json:", error.message);
        return {};
    }
}

function writeStates(states) {
    writeJsonStore(FILE_PATH, FILE_PATH, states);
}

function initializeScheduleSnapshot(scheduleData, date = new Date(), force = false) {
    const states = readStates();
    const studentId = scheduleData.studentId;
    if (force || !states[studentId]?.baseline) {
        states[studentId] = createBaselineState(buildScheduleSnapshot(scheduleData, date), new Date().toISOString());
        writeStates(states);
    }
}

function captureScheduleChange(scheduleData, date = new Date()) {
    const states = readStates();
    const studentId = scheduleData.studentId;
    const result = captureChangeState(states[studentId], buildScheduleSnapshot(scheduleData, date));
    states[studentId] = result.state;
    writeStates(states);
    return result;
}

function confirmScheduleChange(scheduleData, date = new Date()) {
    const states = readStates();
    const studentId = scheduleData.studentId;
    const result = confirmChangeState(states[studentId], buildScheduleSnapshot(scheduleData, date));
    states[studentId] = result.state;
    writeStates(states);
    return result;
}

function statusLabel(status, calendarType = 1) {
    if (status === 6) return "Nghỉ lễ";
    if (![0, 4, 5, 10].includes(status)) return "Báo nghỉ";
    if (calendarType === 2) return "Lịch thi";
    return "Theo lịch";
}

function formatDateKey(dateKey) {
    const [year, month, day] = text(dateKey).split("-");
    return day ? `${day}/${month}/${year}` : "Ngày chưa cập nhật";
}

function formatDateKeyWithWeekday(dateKey) {
    const formattedDate = formatDateKey(dateKey);
    const weekday = getVietnamWeekdayForDateKey(dateKey);
    return weekday ? `${weekday}, ${formattedDate}` : formattedDate;
}

function formatLocation(lesson) {
    return [lesson.room, lesson.campus].filter(Boolean).join(" - ");
}

function formatTimeRange(start, end) {
    if (start && end) return `${start} - ${end}`;
    return start || end || "Chưa cập nhật";
}

function formatCompactLesson(lesson, index) {
    return [
        `**${index + 1}. ${escapeMarkdown(lesson.subject || "Buổi học")}**`,
        `> **Ngày:** ${formatDateKeyWithWeekday(lesson.dateKey)}`,
        `> **Thời gian:** ${escapeMarkdown(formatTimeRange(lesson.start, lesson.end))}`,
        formatLocation(lesson) ? `> **Phòng:** ${escapeMarkdown(formatLocation(lesson))}` : "",
        lesson.teacher ? `> **Giảng viên:** ${escapeMarkdown(lesson.teacher)}` : "",
        lesson.group ? `> **Nhóm:** ${escapeMarkdown(lesson.group)}` : "",
        lesson.lessonType != null && lesson.calendarType !== 2
            ? `> **Hình thức:** ${lesson.lessonType === 0 ? "Lý thuyết" : "Thực hành"}`
            : "",
        lesson.onlineLink ? `> **Trực tuyến:** ${escapeMarkdown(lesson.onlineLink)}` : "",
        `> **Trạng thái:** ${escapeMarkdown(statusLabel(lesson.status, lesson.calendarType))}`
    ].filter(Boolean).join("\n");
}

function changedLine(label, before, after) {
    return `> **${label}:** ~~${escapeMarkdown(before || "Không có thông tin")}~~ → **${escapeMarkdown(after || "Không có thông tin")}**`;
}

function formatModifiedLesson(change, index) {
    const before = change.before;
    const after = change.after;
    const title = before.subject === after.subject
        ? after.subject
        : "Thay đổi môn học";
    const currentSchedule = [
        formatDateKeyWithWeekday(after.dateKey),
        formatTimeRange(after.start, after.end)
    ].filter(Boolean).join(" · ");
    const details = [
        `**${index + 1}. ${escapeMarkdown(title || "Buổi học")}**`,
        `> **Lịch hiện tại:** ${escapeMarkdown(currentSchedule)}`
    ];

    if (before.dateKey !== after.dateKey) {
        details.push(changedLine("Ngày", formatDateKeyWithWeekday(before.dateKey), formatDateKeyWithWeekday(after.dateKey)));
    }
    if (before.start !== after.start || before.end !== after.end) {
        details.push(changedLine(
            "Giờ",
            formatTimeRange(before.start, before.end),
            formatTimeRange(after.start, after.end)
        ));
    }
    if (before.room !== after.room || before.campus !== after.campus) {
        details.push(changedLine("Phòng", formatLocation(before), formatLocation(after)));
    }
    if (before.teacher !== after.teacher) details.push(changedLine("Giảng viên", before.teacher, after.teacher));
    if (before.group !== after.group) details.push(changedLine("Nhóm", before.group, after.group));
    if (before.status !== after.status && statusLabel(before.status, before.calendarType) !== statusLabel(after.status, after.calendarType)) {
        details.push(changedLine(
            "Trạng thái",
            statusLabel(before.status, before.calendarType),
            statusLabel(after.status, after.calendarType)
        ));
    }
    if (before.subject !== after.subject) details.push(changedLine("Môn", before.subject, after.subject));
    if (before.calendarType !== after.calendarType) {
        details.push(changedLine(
            "Loại lịch",
            before.calendarType === 2 ? "Lịch thi" : "Lịch học",
            after.calendarType === 2 ? "Lịch thi" : "Lịch học"
        ));
    }
    if (before.lessonType !== after.lessonType) {
        details.push(changedLine(
            "Hình thức",
            before.lessonType === 0 ? "Lý thuyết" : "Thực hành",
            after.lessonType === 0 ? "Lý thuyết" : "Thực hành"
        ));
    }
    if (before.onlineLink !== after.onlineLink) {
        details.push(changedLine("Trực tuyến", before.onlineLink, after.onlineLink));
    }
    return details.join("\n");
}

function formatScheduleChangeMessage(scheduleData, changes, date = new Date()) {
    const now = getVietnamDateInfo(date);
    const totalChanges = changes.added.length + changes.removed.length + changes.modified.length;
    const sections = [
        "# {orange}[LỊCH HỌC] CÓ THAY ĐỔI{/orange}",
        `**Sinh viên:** ${escapeMarkdown(scheduleData.studentName || "Sinh viên")}  •  **MSSV:** ${escapeMarkdown(scheduleData.studentId)}`,
        `**Xác nhận:** ${now.weekday}, ${now.formattedDate} lúc ${now.hour}:${now.minute}`,
        `{orange}${totalChanges} thay đổi đã được xác nhận{/orange}`
    ];

    if (changes.added.length) {
        sections.push(
            `## {green}THÊM MỚI · ${changes.added.length}{/green}\n` +
            changes.added.map(formatCompactLesson).join("\n\n────────────\n\n")
        );
    }
    if (changes.removed.length) {
        sections.push(
            `## {orange}ĐÃ XÓA · ${changes.removed.length}{/orange}\n` +
            changes.removed.map(formatCompactLesson).join("\n\n────────────\n\n")
        );
    }
    if (changes.modified.length) {
        sections.push(
            `## {orange}ĐIỀU CHỈNH · ${changes.modified.length}{/orange}\n` +
            changes.modified.map(formatModifiedLesson).join("\n\n────────────\n\n")
        );
    }
    sections.push("> Dùng **/lich** để xem hôm nay hoặc **/lichtuan** để xem cả tuần.");
    return sections.join("\n\n");
}

module.exports = {
    FILE_PATH,
    SNAPSHOT_SCHEMA_VERSION,
    buildScheduleSnapshot,
    captureChangeState,
    captureScheduleChange,
    confirmChangeState,
    confirmScheduleChange,
    diffSnapshots,
    formatScheduleChangeMessage,
    initializeScheduleSnapshot,
    normalizeLesson
};
