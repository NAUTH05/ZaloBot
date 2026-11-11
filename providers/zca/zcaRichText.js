// ============================================================================
// Chuyển nội dung dạng Markdown của ZaloBot thành rich text GỐC của Zalo.
//
// Vì sao cần lớp này:
//   Bot chính thức (Zalo Bot Platform) hiểu Markdown qua `parse_mode`.
//   Tài khoản Zalo cá nhân (zca-js) KHÔNG hiểu Markdown. Nếu cứ gửi nguyên văn
//   thì `**bold**`, `##`, `{orange}...{/orange}` hiện ra y như chữ.
//
// Cách làm: giữ NGUYÊN các template dùng chung, rồi tại đây
//   1. bỏ các ký hiệu định dạng khỏi văn bản cuối,
//   2. chuyển chúng thành các span `styles[]` mà zca-js nhận.
//
// Đây là lớp CHỈ thuộc về transport ZCA. Không có template riêng cho ZCA, và
// logic nghiệp vụ không biết gì về Zalo rich text.
//
// Về OFFSET: `start`/`len` của zca-js là offset chuỗi JavaScript (đơn vị UTF-16),
// đúng bằng `String.length`. Nhờ vậy ký tự tiếng Việt và emoji (surrogate pair)
// đều tính đúng mà không cần quy đổi byte.
// ============================================================================
const { TextStyle } = require("zca-js");

// Màu sắc: dùng đúng các giá trị TextStyle của zca-js 2.2.0, không tự bịa tên.
const COLOR_STYLES = Object.freeze({
    green: TextStyle.Green,
    orange: TextStyle.Orange,
    red: TextStyle.Red,
    yellow: TextStyle.Yellow
});

// Đánh dấu nhấn mạnh, xếp dài/mặc định trước để không khớp nhầm.
// `***x***` chỉ còn Bold vì Zalo không có kiểu bold-italic kết hợp.
const EMPHASIS_MARKERS = Object.freeze([
    { open: "***", close: "***", styles: [TextStyle.Bold] },
    { open: "**", close: "**", styles: [TextStyle.Bold] },
    { open: "__", close: "__", styles: [TextStyle.Underline] },
    { open: "~~", close: "~~", styles: [TextStyle.StrikeThrough] },
    // Zalo không có monospace ⇒ dùng Bold làm phương án dễ đọc.
    { open: "`", close: "`", styles: [TextStyle.Bold] },
    { open: "*", close: "*", styles: [TextStyle.Italic] },
    { open: "_", close: "_", styles: [TextStyle.Italic] }
]);

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
const BULLET_PATTERN = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_PATTERN = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE_PATTERN = /^\s*>\s?(.*)$/;
const FENCE_PATTERN = /^```/;

/* -------------------------------------------------------------------------- */
/* Chuẩn hoá toàn văn bản trước khi phân tích từng dòng                       */
/* -------------------------------------------------------------------------- */

function normalizeBlocks(input) {
    let text = String(input == null ? "" : input);

    // Khối mã: bỏ hàng rào ``` nhưng giữ nguyên nội dung bên trong.
    text = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_whole, body) => String(body).replace(/\s+$/, ""));

    // Liên kết: [OpenAI](https://openai.com) → OpenAI (https://openai.com)
    // Không làm mất URL, để Zalo tự nhận diện thành liên kết bấm được.
    text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_whole, label, url) => {
        const cleanLabel = String(label).trim();
        const cleanUrl = String(url).trim();
        return cleanLabel === cleanUrl ? cleanUrl : `${cleanLabel} (${cleanUrl})`;
    });

    // Gộp nhiều dòng trống liên tiếp để tin nhắn không bị rỗng quá nhiều.
    text = text.replace(/\n{3,}/g, "\n\n");

    return text;
}

/* -------------------------------------------------------------------------- */
/* Phân tích định dạng nội dòng                                               */
/*                                                                             */
/* Dùng đệ quy thay vì chuỗi .replace() rồi giữ index cũ: mỗi lần bỏ ký hiệu    */
/* định dạng, độ dài chuỗi đổi, nên index tính từ chuỗi gốc sẽ lệch. Cách đệ    */
/* quy gom (văn bản, các kiểu áp lên nó) rồi mới cộng dồn offset ở lượt cuối    */
/* cùng nên không bao giờ lệch, và xử lý được lồng nhau theo bất kỳ thứ tự nào. */
/* -------------------------------------------------------------------------- */

function matchColorOpen(text, index) {
    if (text[index] !== "{") return null;
    const closeBrace = text.indexOf("}", index + 1);
    if (closeBrace === -1) return null;
    const name = text.slice(index + 1, closeBrace).toLowerCase();
    if (!COLOR_STYLES[name]) return null;
    return { name, style: COLOR_STYLES[name], end: closeBrace + 1 };
}

function matchEmphasis(text, index) {
    for (const marker of EMPHASIS_MARKERS) {
        if (!text.startsWith(marker.open, index)) continue;

        // `*` đơn không được phép "ăn" vào `**`, và ngược lại.
        if (marker.open === "*" && text.startsWith("**", index)) continue;
        if (marker.open === "_" && text.startsWith("__", index)) continue;

        const close = text.indexOf(marker.close, index + marker.open.length);
        if (close === -1) continue;
        // Nội dung rỗng thì không phải định dạng.
        if (close === index + marker.open.length) continue;
        // `*` đơn không được đóng bằng `**`.
        if (marker.open === "*" && text.startsWith("**", close)) continue;
        if (marker.open === "_" && text.startsWith("__", close)) continue;

        return { ...marker, closeAt: close };
    }
    return null;
}

// Trả về mảng các đoạn { text, styles } theo đúng thứ tự xuất hiện.
function parseInline(text, inherited, out) {
    let buffer = "";
    let index = 0;

    const flush = () => {
        if (buffer) {
            out.push({ text: buffer, styles: inherited });
            buffer = "";
        }
    };

    while (index < text.length) {
        // Ký tự được escape (\*, \_, \~, \`, \>) là chữ thường, không phải ký hiệu.
        if (text[index] === "\\" && index + 1 < text.length) {
            buffer += text[index + 1];
            index += 2;
            continue;
        }

        const color = matchColorOpen(text, index);
        if (color) {
            const closeTag = `{/${color.name}}`;
            const closeAt = text.indexOf(closeTag, color.end);
            if (closeAt !== -1) {
                flush();
                parseInline(text.slice(color.end, closeAt), [...inherited, color.style], out);
                index = closeAt + closeTag.length;
                continue;
            }
        }

        const emphasis = matchEmphasis(text, index);
        if (emphasis) {
            flush();
            parseInline(
                text.slice(index + emphasis.open.length, emphasis.closeAt),
                [...inherited, ...emphasis.styles],
                out
            );
            index = emphasis.closeAt + emphasis.close.length;
            continue;
        }

        buffer += text[index];
        index += 1;
    }

    flush();
    return out;
}

/* -------------------------------------------------------------------------- */
/* Renderer                                                                   */
/* -------------------------------------------------------------------------- */

// Gộp các span liền kề cùng kiểu thành một.
//
// Khi một đoạn được định dạng bao quanh một đoạn được định dạng khác, đoạn ngoài
// bị cắt thành nhiều span tại ranh giới của đoạn trong. Ví dụ
// `{orange}Dùng **/help** để xem{/orange}` sinh ba span cam liền nhau. Zalo hiển
// thị y hệt nhau, nhưng gộp lại cho payload nhỏ hơn và dễ đọc hơn khi chẩn đoán.
//
// Phải gộp theo TỪNG kiểu riêng: nếu sắp xếp chung rồi gộp tuần tự thì span đậm
// nằm giữa hai span cam sẽ chen vào giữa và chặn việc gộp.
function mergeAdjacentStyles(styles) {
    const byStyle = new Map();
    for (const style of styles) {
        const list = byStyle.get(style.st) || [];
        list.push({ ...style });
        byStyle.set(style.st, list);
    }

    const merged = [];
    for (const list of byStyle.values()) {
        list.sort((a, b) => a.start - b.start);
        // Gộp trong phạm vi cùng một kiểu.
        const groupMerged = [];
        for (const style of list) {
            const last = groupMerged[groupMerged.length - 1];
            if (last && last.start + last.len === style.start) {
                last.len += style.len;
                continue;
            }
            groupMerged.push(style);
        }
        merged.push(...groupMerged);
    }

    return merged.sort((a, b) => (a.start - b.start) || (a.st < b.st ? -1 : a.st > b.st ? 1 : 0));
}

// Nhận nội dung Markdown của ZaloBot, trả về payload cho zca-js.
function renderZcaRichText(input) {
    const normalized = normalizeBlocks(input);
    const lines = normalized.split("\n");

    const styles = [];
    const parts = [];
    let cursor = 0;   // Vị trí hiện tại trong VĂN BẢN CUỐI — mọi span dùng mốc này.

    // Thêm span, bỏ qua đoạn rỗng để không sinh style vô nghĩa.
    const pushStyle = (start, len, style) => {
        if (len > 0) styles.push({ start, len, st: style });
    };

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const rawLine = lines[lineIndex];

        let content = rawLine;
        let indentPrefix = "";
        let quotePrefix = "";
        const blockStyles = [];

        // Tiêu đề: bỏ dấu #, áp kiểu theo cấp.
        const heading = content.match(HEADING_PATTERN);
        if (heading) {
            const level = heading[1].length;
            content = heading[2];
            // H1 vừa Big vừa Bold; H2/H3 chỉ Bold để không phá bố cục.
            if (level === 1) blockStyles.push(TextStyle.Big, TextStyle.Bold);
            else blockStyles.push(TextStyle.Bold);
        }

        // Trích dẫn: Zalo không có kiểu quote, dùng ký tự đường kẻ cho dễ đọc.
        const quote = content.match(QUOTE_PATTERN);
        if (quote) {
            content = quote[1];
            quotePrefix = "│ ";
        }

        // Danh sách: giữ nguyên thứ tự, thay dấu đầu dòng bằng ký tự hiển thị được.
        let listStyle = null;
        const bullet = content.match(BULLET_PATTERN);
        const ordered = content.match(ORDERED_PATTERN);
        if (bullet) {
            indentPrefix = bullet[1] || "";
            content = bullet[2];
            listStyle = TextStyle.UnorderedList;
        } else if (ordered) {
            // ordered = [toàn bộ, thụt lề, số, nội dung] ⇒ nội dung nằm ở nhóm 3.
            indentPrefix = ordered[1] || "";
            content = ordered[3];
            listStyle = TextStyle.OrderedList;
        }

        // Dòng nằm trong khối mã đã bỏ hàng rào ở bước chuẩn hoá.
        if (FENCE_PATTERN.test(content)) content = content.replace(FENCE_PATTERN, "");

        // Nội dòng: gom các đoạn kèm kiểu áp lên chúng.
        const segments = parseInline(content, [], []);

        // Ghép dòng và tính offset trên chính văn bản cuối.
        const lineStart = cursor + indentPrefix.length + quotePrefix.length;
        const lineText = `${indentPrefix}${quotePrefix}`;

        if (lineText) {
            parts.push(lineText);
            cursor += lineText.length;
        }

        let contentLength = 0;
        for (const segment of segments) {
            const start = cursor;
            parts.push(segment.text);
            cursor += segment.text.length;
            contentLength += segment.text.length;
            // Nhiều kiểu trên cùng một khoảng là hợp lệ và được Zalo áp chồng.
            for (const style of segment.styles) pushStyle(start, segment.text.length, style);
        }

        // Kiểu của cả khối áp lên phần nội dung, không tính tiền tố.
        for (const style of blockStyles) pushStyle(lineStart, contentLength, style);
        if (listStyle) pushStyle(lineStart, contentLength, listStyle);

        // Thêm xuống dòng giữa các dòng, trừ dòng cuối.
        if (lineIndex < lines.length - 1) {
            parts.push("\n");
            cursor += 1;
        }
    }

    const text = parts.join("");

    // Chốt an toàn: mọi span phải nằm trong văn bản cuối. Span hỏng sẽ bị Zalo từ
    // chối cả tin nhắn nên loại trước khi gửi.
    const safeStyles = styles.filter(
        (style) => style.start >= 0 && style.len > 0 && style.start + style.len <= text.length
    );

    return { text, styles: mergeAdjacentStyles(safeStyles) };
}

module.exports = {
    COLOR_STYLES,
    EMPHASIS_MARKERS,
    mergeAdjacentStyles,
    normalizeBlocks,
    parseInline,
    renderZcaRichText
};
