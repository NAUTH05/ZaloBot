const crypto = require("crypto");
const path = require("path");
const { getApiDateTimeInfo, getVietnamDateInfo } = require("./timezone");
const { formatLesson, normalizeLesson } = require("./lhuSchedule");
const { readJsonStore, writeJsonStore } = require("./firestorePersistence");

const FILE_PATH = path.join(__dirname, "classStartNotifications.json");
const STATE_SCHEMA_VERSION = 1;
const DEFAULT_GRACE_PERIOD_MS = 2 * 60 * 1000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const EVENT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function text(value) {
    return value == null ? "" : String(value).trim();
}

function isClassStartReminderLesson(lesson) {
    return normalizeLesson(lesson).isNormal;
}

function vietnamSerial(info) {
    if (!info) return null;
    return Date.UTC(
        Number(info.year),
        Number(info.month) - 1,
        Number(info.day),
        Number(info.hour),
        Number(info.minute),
        Number(info.second || 0)
    );
}

function findDueClassStartLessons(lessons, evaluationAt = new Date(), gracePeriodMs = DEFAULT_GRACE_PERIOD_MS) {
    const currentSerial = vietnamSerial(getVietnamDateInfo(evaluationAt));
    return (lessons || []).filter((lesson) => {
        if (!isClassStartReminderLesson(lesson)) return false;
        const startSerial = vietnamSerial(getApiDateTimeInfo(lesson.ThoiGianBD));
        if (startSerial == null) return false;
        const delay = currentSerial - startSerial;
        return delay >= 0 && delay <= gracePeriodMs;
    });
}

function createLessonEventKey(studentId, lesson) {
    const normalized = normalizeLesson(lesson);
    const start = normalized.start;
    if (!start) return null;
    const stableLessonIdentity = normalized.id || normalized.groupId || [
        normalized.subject,
        normalized.room,
        normalized.group,
        normalized.teacher
    ].filter(Boolean).join("|");
    if (!stableLessonIdentity) return null;
    return [text(studentId), start.dateKey, `${start.hour}:${start.minute}`, stableLessonIdentity].join("|");
}

function createDeliveryEventId(subscriptionKey, studentId, lesson) {
    const lessonEventKey = createLessonEventKey(studentId, lesson);
    if (!lessonEventKey) return null;
    return crypto.createHash("sha256").update(`${subscriptionKey}|${lessonEventKey}`).digest("hex");
}

function formatClassStartNotification(lessonsInput) {
    const lessons = (Array.isArray(lessonsInput) ? lessonsInput : [lessonsInput]).filter(Boolean);
    const numbered = lessons.length > 1;
    const lessonBlocks = lessons.map((lesson, index) => formatLesson(lesson, index, {
        layout: "notification",
        numbered
    }));
    return [
        "# {green}[ĐẾN GIỜ HỌC]{/green}",
        lessonBlocks.join("\n\n────────────\n\n"),
        "Chúc bạn học tốt!"
    ].filter(Boolean).join("\n\n");
}

function groupDueLessonsByStart(lessons) {
    const groups = new Map();
    for (const lesson of lessons || []) {
        const normalized = normalizeLesson(lesson);
        if (!normalized.start) continue;
        const key = `${normalized.start.dateKey}T${normalized.startTime}`;
        const group = groups.get(key) || [];
        group.push(lesson);
        groups.set(key, group);
    }
    return [...groups.values()];
}

function emptyState() {
    return { schemaVersion: STATE_SCHEMA_VERSION, events: {} };
}

function readState(filePath = FILE_PATH) {
    try {
        const state = readJsonStore(filePath, FILE_PATH, emptyState());
        if (!state || typeof state !== "object" || Array.isArray(state)) return emptyState();
        return {
            schemaVersion: STATE_SCHEMA_VERSION,
            events: state.events && typeof state.events === "object" && !Array.isArray(state.events)
                ? state.events
                : {}
        };
    } catch (error) {
        console.error("Không đọc được trạng thái nhắc giờ học:", error.message);
        return emptyState();
    }
}

function pruneEvents(state, now = new Date()) {
    const cutoff = now.getTime() - EVENT_RETENTION_MS;
    for (const [eventId, event] of Object.entries(state.events)) {
        const recordedAt = Date.parse(event.deliveredAt || event.claimedAt || "");
        if (!Number.isFinite(recordedAt) || recordedAt < cutoff) delete state.events[eventId];
    }
}

function claimDelivery({ subscriptionKey, subscription, lesson, now = new Date(), filePath = FILE_PATH }) {
    const eventId = createDeliveryEventId(subscriptionKey, subscription.studentId, lesson);
    if (!eventId) return null;
    const state = readState(filePath);
    pruneEvents(state, now);
    if (state.events[eventId]) return null;
    const start = getApiDateTimeInfo(lesson.ThoiGianBD);
    state.events[eventId] = {
        eventId,
        subscriptionKey,
        chatId: String(subscription.chatId),
        userId: String(subscription.userId),
        studentId: String(subscription.studentId),
        lessonEventKey: createLessonEventKey(subscription.studentId, lesson),
        lessonDateKey: start.dateKey,
        lessonStartTime: `${start.hour}:${start.minute}`,
        claimedAt: now.toISOString(),
        deliveredAt: null
    };
    writeJsonStore(filePath, FILE_PATH, state);
    return eventId;
}

function markDelivered(eventId, now = new Date(), filePath = FILE_PATH) {
    const state = readState(filePath);
    if (!state.events[eventId]) return false;
    state.events[eventId].deliveredAt = now.toISOString();
    writeJsonStore(filePath, FILE_PATH, state);
    return true;
}

function releaseDelivery(eventId, filePath = FILE_PATH) {
    const state = readState(filePath);
    if (!state.events[eventId]) return false;
    delete state.events[eventId];
    writeJsonStore(filePath, FILE_PATH, state);
    return true;
}

function groupSubscriptionsByStudent(subscriptions, isEligible) {
    const grouped = new Map();
    for (const [subscriptionKey, subscription] of Object.entries(subscriptions || {})) {
        if (!subscription?.studentId || !isEligible(subscription)) continue;
        const group = grouped.get(subscription.studentId) || [];
        group.push({ subscriptionKey, subscription });
        grouped.set(subscription.studentId, group);
    }
    return grouped;
}

function createClassStartReminderService(options) {
    const {
        fetchSchedule,
        getSubscriptions,
        sendReminder,
        flushPersistence = async () => {},
        onError = () => {},
        isEligible = () => true,
        gracePeriodMs = DEFAULT_GRACE_PERIOD_MS,
        cacheTtlMs = DEFAULT_CACHE_TTL_MS,
        stateFilePath = FILE_PATH
    } = options || {};
    if (typeof fetchSchedule !== "function" || typeof getSubscriptions !== "function" || typeof sendReminder !== "function") {
        throw new Error("Thiếu dependency cho class-start reminder service");
    }

    const cache = new Map();
    const effectiveCacheTtlMs = Math.min(cacheTtlMs, Math.max(1000, Math.floor(gracePeriodMs / 2)), 60 * 1000);
    let running = false;

    async function fetchForBucket(studentId, evaluationAt) {
        const bucket = Math.floor(evaluationAt.getTime() / effectiveCacheTtlMs);
        const cached = cache.get(studentId);
        if (cached?.bucket === bucket) return cached.scheduleData;
        const scheduleData = await fetchSchedule(studentId, evaluationAt);
        cache.set(studentId, { bucket, scheduleData });
        return scheduleData;
    }

    async function run(evaluationAt = new Date()) {
        const grouped = groupSubscriptionsByStudent(getSubscriptions(), isEligible);
        if (grouped.size === 0) return { processed: false, students: 0, sent: 0, lessons: 0, failed: 0, duplicates: 0 };
        if (running) return { processed: false, students: grouped.size, sent: 0, lessons: 0, failed: 0, duplicates: 0 };

        running = true;
        const result = { processed: true, students: grouped.size, sent: 0, lessons: 0, failed: 0, duplicates: 0 };
        try {
            for (const [studentId, targets] of grouped.entries()) {
                try {
                    const cachedSchedule = await fetchForBucket(studentId, evaluationAt);
                    const cachedDueLessons = findDueClassStartLessons(cachedSchedule.lessons, evaluationAt, gracePeriodMs);
                    if (cachedDueLessons.length === 0) continue;

                    // Confirm once more at delivery time so a moved or cancelled lesson is never sent from stale cache.
                    const confirmedSchedule = await fetchSchedule(studentId, evaluationAt);
                    cache.set(studentId, {
                        bucket: Math.floor(evaluationAt.getTime() / effectiveCacheTtlMs),
                        scheduleData: confirmedSchedule
                    });
                    const dueLessonGroups = groupDueLessonsByStart(
                        findDueClassStartLessons(confirmedSchedule.lessons, evaluationAt, gracePeriodMs)
                    );

                    for (const { subscriptionKey, subscription } of targets) {
                        const currentSubscription = getSubscriptions()[subscriptionKey];
                        if (!currentSubscription || currentSubscription.studentId !== subscription.studentId ||
                            !isEligible(currentSubscription)) continue;
                        for (const dueLessons of dueLessonGroups) {
                            const claimed = [];
                            for (const lesson of dueLessons) {
                                const eventId = claimDelivery({
                                    subscriptionKey,
                                    subscription: currentSubscription,
                                    lesson,
                                    now: evaluationAt,
                                    filePath: stateFilePath
                                });
                                if (!eventId) {
                                    result.duplicates += 1;
                                    continue;
                                }
                                claimed.push({ eventId, lesson });
                            }
                            if (claimed.length === 0) continue;

                            await flushPersistence();
                            let delivery;
                            try {
                                const claimedLessons = claimed.map((item) => item.lesson);
                                delivery = await sendReminder(
                                    currentSubscription,
                                    formatClassStartNotification(claimedLessons),
                                    claimedLessons
                                );
                            } catch (error) {
                                delivery = { failed: true, error };
                            }

                            if (delivery == null || delivery === true || delivery.sent === true) {
                                for (const item of claimed) markDelivered(item.eventId, new Date(), stateFilePath);
                                result.sent += 1;
                                result.lessons += claimed.length;
                            } else {
                                onError({ stage: "delivery", error: delivery.error || new Error("Reminder delivery failed") });
                                for (const item of claimed) releaseDelivery(item.eventId, stateFilePath);
                                result.failed += 1;
                            }
                            await flushPersistence();
                        }
                    }
                } catch (error) {
                    onError({ stage: "schedule", error });
                    result.failed += targets.length;
                }
            }
            return result;
        } finally {
            running = false;
        }
    }

    return { run };
}

module.exports = {
    DEFAULT_CACHE_TTL_MS,
    DEFAULT_GRACE_PERIOD_MS,
    FILE_PATH,
    STATE_SCHEMA_VERSION,
    createClassStartReminderService,
    createDeliveryEventId,
    createLessonEventKey,
    findDueClassStartLessons,
    formatClassStartNotification,
    groupDueLessonsByStart,
    isClassStartReminderLesson,
    readState
};
