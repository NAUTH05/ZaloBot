// Quy đổi cụm từ chỉ TUẦN thành yêu cầu xem lịch: bắt đầu từ tuần thứ mấy và
// xem bao nhiêu tuần.
//
// Tách khỏi `scheduleDate.js` vì hai thứ khác nhau về bản chất: ngày là một điểm,
// tuần là một KHOẢNG, và người dùng hay hỏi "mấy tuần tới" chứ không chỉ một tuần.
//
// Trả về null khi KHÔNG hiểu — không đoán bừa. Caller quyết định mặc định.

const { foldText } = require("./mentionUtils");

// Trần cứng: mỗi tuần là một tin nhắn riêng, 6 tuần đã là 6 tin. Nhiều hơn nữa
// thì người dùng không đọc hết và Zalo dễ chạm giới hạn tần suất.
const MAX_WEEKS = 6;
const MAX_START_OFFSET = 8;

// Cụm từ cố định: mỗi cụm chỉ một tuần.
const WEEK_PHRASES = Object.freeze({
    tuannay: 0, tuanhiennay: 0, tuanhientai: 0, thisweek: 0, tuan0: 0,
    tuansau: 1, tuantoi: 1, nextweek: 1, tuansau1: 1,
    tuansaunua: 2, tuansau2: 2
});

function clampWeeks(value) {
    const weeks = Number(value);
    if (!Number.isInteger(weeks) || weeks < 1) return null;
    return Math.min(weeks, MAX_WEEKS);
}

function buildResult(startOffset, weeks) {
    const offset = Number(startOffset);
    if (!Number.isInteger(offset) || offset < 0 || offset > MAX_START_OFFSET) return null;
    const span = clampWeeks(weeks);
    if (!span) return null;
    return { startOffset: offset, weeks: span };
}

// `input`: "tuan sau", "tuan sau nua", "3", "3 tuan", "2 tuan toi"…
// Không có tham số ⇒ null (caller dùng mặc định "tuần này").
function resolveWeekRequest(input) {
    const raw = String(input == null ? "" : input).trim();
    if (!raw) return null;

    const compact = foldText(raw).replace(/[^a-z0-9]/g, "");
    if (!compact) return null;

    if (WEEK_PHRASES[compact] !== undefined) return buildResult(WEEK_PHRASES[compact], 1);

    // "3" hoặc "3 tuan" / "3 tuan toi" / "3 tuan sau": SỐ TUẦN muốn xem, tính từ
    // tuần này. Con số đứng một mình được hiểu là số tuần, không phải "tuần thứ 3
    // của tháng" — cách hiểu sau không có ý nghĩa với lịch học.
    const span = compact.match(/^([1-9])$/);
    if (span) return buildResult(0, Number(span[1]));

    const spanWords = compact.match(/^([1-9])tuan(?:toi|sau)?$/);
    if (spanWords) return buildResult(0, Number(spanWords[1]));

    return null;
}

// Nhãn hiển thị cho tiêu đề tin nhắn.
function weekLabel(offset) {
    const value = Number(offset) || 0;
    if (value <= 0) return "TUẦN NÀY";
    if (value === 1) return "TUẦN SAU";
    if (value === 2) return "TUẦN SAU NỮA";
    return `TUẦN THỨ ${value + 1}`;
}

module.exports = {
    MAX_START_OFFSET,
    MAX_WEEKS,
    WEEK_PHRASES,
    resolveWeekRequest,
    weekLabel
};
