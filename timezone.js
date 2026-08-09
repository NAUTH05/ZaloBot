const TIME_ZONE = "Asia/Ho_Chi_Minh";

function getParts(date = new Date(), options = {}) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        ...options
    });
    return Object.fromEntries(
        formatter.formatToParts(date)
            .filter((part) => part.type !== "literal")
            .map((part) => [part.type, part.value])
    );
}

function getVietnamDateInfo(date = new Date()) {
    const parts = getParts(date);
    const weekday = new Intl.DateTimeFormat("vi-VN", {
        timeZone: TIME_ZONE,
        weekday: "long"
    }).format(date);
    const dateKey = `${parts.year}-${parts.month}-${parts.day}`;

    return {
        ...parts,
        weekday,
        dateKey,
        formattedDate: `${parts.day}/${parts.month}/${parts.year}`,
        formattedDateTime: `${parts.hour}:${parts.minute}:${parts.second} ${parts.day}/${parts.month}/${parts.year}`
    };
}

function hasExplicitTimeZone(value) {
    return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

function getApiDateTimeInfo(value) {
    if (value instanceof Date) return getVietnamDateInfo(value);
    if (typeof value !== "string") return null;

    if (hasExplicitTimeZone(value)) {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : getVietnamDateInfo(parsed);
    }

    // API LHU trả thời gian không kèm offset; đây là giờ địa phương Việt Nam.
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!match) return null;

    const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
    return {
        year,
        month,
        day,
        hour,
        minute,
        second,
        dateKey: `${year}-${month}-${day}`,
        formattedDate: `${day}/${month}/${year}`,
        formattedDateTime: `${hour}:${minute}:${second} ${day}/${month}/${year}`
    };
}

function toLhuQueryDate(date = new Date()) {
    const { dateKey } = getVietnamDateInfo(date);
    // 12:00 tại Việt Nam = 05:00 UTC. Dùng giữa ngày để không lệch ngày trên VPS.
    return `${dateKey}T05:00:00.000Z`;
}

module.exports = {
    TIME_ZONE,
    getApiDateTimeInfo,
    getVietnamDateInfo,
    toLhuQueryDate
};
