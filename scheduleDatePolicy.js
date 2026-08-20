const { getVietnamDateInfo } = require("./timezone");

const DAILY_CLASS_SCHEDULE_POLICY = Object.freeze({
    id: "daily-class",
    windows: Object.freeze([
        Object.freeze({ start: "00:00", end: "20:00", targetDayOffset: 0 }),
        Object.freeze({ start: "20:00", end: "24:00", targetDayOffset: 1 })
    ])
});

function timeToMinutes(value) {
    const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour === 24 && minute === 0) return 24 * 60;
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
}

function addCalendarDays(dateKey, days) {
    const calendarDate = new Date(`${dateKey}T00:00:00.000Z`);
    if (Number.isNaN(calendarDate.getTime())) throw new Error(`Invalid date key: ${dateKey}`);
    calendarDate.setUTCDate(calendarDate.getUTCDate() + Number(days || 0));
    return calendarDate.toISOString().slice(0, 10);
}

function dateFromVietnamDateKey(dateKey) {
    const date = new Date(`${dateKey}T05:00:00.000Z`);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid date key: ${dateKey}`);
    return date;
}

function resolveScheduleTarget(deliveryAt = new Date(), policy = DAILY_CLASS_SCHEDULE_POLICY) {
    const delivery = getVietnamDateInfo(deliveryAt);
    const deliveryMinutes = timeToMinutes(`${delivery.hour}:${delivery.minute}`);
    const window = policy.windows.find((item) => {
        const start = timeToMinutes(item.start);
        const end = timeToMinutes(item.end);
        return start != null && end != null && deliveryMinutes >= start && deliveryMinutes < end;
    });
    if (!window) throw new Error(`No ${policy.id || "schedule"} policy window matches ${delivery.hour}:${delivery.minute}`);
    const targetDateKey = addCalendarDays(delivery.dateKey, window.targetDayOffset);
    return {
        policyId: policy.id,
        deliveryDateKey: delivery.dateKey,
        targetDateKey,
        targetDayOffset: window.targetDayOffset,
        targetDate: dateFromVietnamDateKey(targetDateKey)
    };
}

module.exports = {
    DAILY_CLASS_SCHEDULE_POLICY,
    addCalendarDays,
    dateFromVietnamDateKey,
    resolveScheduleTarget,
    timeToMinutes
};
