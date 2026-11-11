// Chuyển một cụm từ chỉ ngày thành ngày cụ thể, theo giờ Việt Nam.
//
// Dùng CHUNG cho lệnh chat và cho trợ lý AI, để "lịch ngày mai" gõ tay và "lịch
// ngày mai" nói tự nhiên cho ra đúng một kết quả. Mọi phép tính ngày đều đi qua
// dateKey của Asia/Ho_Chi_Minh — không dùng giờ máy, để kết quả không đổi theo
// múi giờ của máy chủ.
//
// Trả về null khi KHÔNG hiểu. Không bao giờ đoán bừa: một ngày sai còn tệ hơn
// một câu hỏi lại.

const { getVietnamDateInfo } = require("./timezone");
const { addCalendarDays, dateFromVietnamDateKey } = require("./scheduleDatePolicy");
const { foldText } = require("./mentionUtils");

// Chỉ số ngày trong tuần: 0 = Chủ Nhật … 6 = Thứ Bảy (giống Date.getUTCDay).
const WEEKDAY_WORDS = Object.freeze({
    thu2: 1, thuhai: 1,
    thu3: 2, thuba: 2,
    thu4: 3, thutu: 3,
    thu5: 4, thunam: 4,
    thu6: 5, thusau: 5,
    thu7: 6, thubay: 6,
    chunhat: 0, cn: 0
});

const RELATIVE_WORDS = Object.freeze({
    homnay: 0, hnay: 0, today: 0,
    // "hôm sau" giữ đúng nghĩa đang dùng trong sản phẩm: ngày kế tiếp.
    mai: 1, ngaymai: 1, homsau: 1, tomorrow: 1,
    mot: 2, ngaykia: 2, ngaymot: 2
});

const MAX_DAYS_AHEAD = 120;

function pad2(value) {
    return String(value).padStart(2, "0");
}

function isValidDateKey(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    const probe = new Date(`${match[0]}T00:00:00.000Z`);
    if (Number.isNaN(probe.getTime())) return false;
    return probe.getUTCFullYear() === year && probe.getUTCMonth() + 1 === month && probe.getUTCDate() === day;
}

function buildResult(dateKey, todayKey) {
    if (!isValidDateKey(dateKey)) return null;
    // Chặn ngày quá xa: gõ nhầm "2099" không nên thành một lần tra cứu vô nghĩa.
    const target = Date.parse(`${dateKey}T00:00:00.000Z`);
    const today = Date.parse(`${todayKey}T00:00:00.000Z`);
    if (!Number.isFinite(target) || !Number.isFinite(today)) return null;
    const daysAhead = Math.round((target - today) / 86400000);
    if (daysAhead < -366 || daysAhead > MAX_DAYS_AHEAD) return null;

    const date = dateFromVietnamDateKey(dateKey);
    const info = getVietnamDateInfo(date);
    return {
        date,
        dateKey,
        daysAhead,
        weekday: info.weekday,
        formattedDate: info.formattedDate,
        label: `${info.weekday} ${info.formattedDate}`
    };
}

// `input`: "mai", "ngày mai", "thứ 5", "12/11", "2026-11-12", "ngày kia"…
function resolveScheduleDate(input, now = new Date()) {
    const raw = String(input == null ? "" : input).trim();
    if (!raw) return null;

    const todayKey = getVietnamDateInfo(now).dateKey;
    const currentYear = Number(todayKey.slice(0, 4));

    // ISO: 2026-11-12
    const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) return buildResult(`${iso[1]}-${pad2(iso[2])}-${pad2(iso[3])}`, todayKey);

    // Ngày/tháng: 12/11, 12-11, 12.11 — hiểu theo năm hiện tại.
    const dayMonth = raw.match(/^(\d{1,2})\s*[/\-.]\s*(\d{1,2})$/);
    if (dayMonth) {
        const day = Number(dayMonth[1]);
        const month = Number(dayMonth[2]);
        return buildResult(`${currentYear}-${pad2(month)}-${pad2(day)}`, todayKey);
    }

    // Chữ: bỏ dấu, bỏ khoảng trắng và dấu câu ("thứ 5" → "thu5").
    const compact = foldText(raw).replace(/[^a-z0-9]/g, "");
    if (!compact) return null;

    if (RELATIVE_WORDS[compact] !== undefined) {
        return buildResult(addCalendarDays(todayKey, RELATIVE_WORDS[compact]), todayKey);
    }

    if (WEEKDAY_WORDS[compact] !== undefined) {
        const targetDay = WEEKDAY_WORDS[compact];
        const todayDate = new Date(`${todayKey}T00:00:00.000Z`);
        const todayDay = todayDate.getUTCDay();
        // "thứ 5" nghĩa là thứ Năm GẦN NHẤT tính từ hôm nay (hôm nay cũng tính).
        const ahead = (targetDay - todayDay + 7) % 7;
        return buildResult(addCalendarDays(todayKey, ahead), todayKey);
    }

    return null;
}

module.exports = {
    MAX_DAYS_AHEAD,
    RELATIVE_WORDS,
    WEEKDAY_WORDS,
    isValidDateKey,
    resolveScheduleDate
};
