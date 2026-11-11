// ============================================================================
// Renderer rich text cho ZCA: Markdown của ZaloBot → styles[] gốc của Zalo.
//
// Điều quan trọng nhất cần chứng minh: offset của mọi span trỏ đúng vào VĂN BẢN
// CUỐI (đã bỏ ký hiệu định dạng), không phải văn bản Markdown gốc.
// ============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");

const { TextStyle } = require("zca-js");
const { renderZcaRichText, normalizeBlocks } = require("../providers/zca/zcaRichText");

// Lấy nội dung mà một span thực sự phủ, theo offset trong văn bản cuối.
function covered(rendered, style) {
    return rendered.text.slice(style.start, style.start + style.len);
}

function stylesOf(rendered, styleValue) {
    return rendered.styles.filter((style) => style.st === styleValue);
}

function assertSpan(rendered, styleValue, expectedText) {
    const matches = stylesOf(rendered, styleValue);
    assert.ok(matches.length > 0, `không có span ${styleValue}`);
    const hit = matches.find((style) => covered(rendered, style) === expectedText);
    assert.ok(
        hit,
        `span ${styleValue} không phủ đúng ${JSON.stringify(expectedText)}; ` +
        `các khoảng có: ${JSON.stringify(matches.map((s) => covered(rendered, s)))}`
    );
}

// Mọi span phải nằm gọn trong văn bản cuối — span hỏng làm Zalo từ chối cả tin.
function assertSpansInBounds(rendered) {
    for (const style of rendered.styles) {
        assert.ok(style.start >= 0, `start âm: ${JSON.stringify(style)}`);
        assert.ok(style.len > 0, `len không dương: ${JSON.stringify(style)}`);
        assert.ok(
            style.start + style.len <= rendered.text.length,
            `span vượt quá văn bản cuối: ${JSON.stringify(style)} / dài ${rendered.text.length}`
        );
    }
}

// Không được để lộ ký hiệu định dạng thô ra tin nhắn.
function assertNoRawMarkers(rendered) {
    for (const marker of ["**", "{green}", "{/green}", "{orange}", "{/orange}", "{red}", "{/red}", "{yellow}", "{/yellow}"]) {
        assert.ok(
            !rendered.text.includes(marker),
            `văn bản cuối còn ký hiệu thô ${marker}: ${JSON.stringify(rendered.text.slice(0, 120))}`
        );
    }
    assert.ok(!/^#{1,6}\s/m.test(rendered.text), "còn dấu # của tiêu đề ở đầu dòng");
}

/* -------------------------------------------------------------------------- */
/* Định dạng nội dòng cơ bản                                                  */
/* -------------------------------------------------------------------------- */

test("in đậm: **hello** → Bold", () => {
    const rendered = renderZcaRichText("**hello**");
    assert.equal(rendered.text, "hello");
    assertSpan(rendered, TextStyle.Bold, "hello");
});

test("in nghiêng: _hello_ → Italic", () => {
    const rendered = renderZcaRichText("_hello_");
    assert.equal(rendered.text, "hello");
    assertSpan(rendered, TextStyle.Italic, "hello");
});

test("in nghiêng bằng dấu sao đơn: *hello* → Italic", () => {
    const rendered = renderZcaRichText("*hello*");
    assert.equal(rendered.text, "hello");
    assertSpan(rendered, TextStyle.Italic, "hello");
});

test("gạch chân: __hello__ → Underline", () => {
    const rendered = renderZcaRichText("__hello__");
    assert.equal(rendered.text, "hello");
    assertSpan(rendered, TextStyle.Underline, "hello");
});

test("gạch ngang: ~~hello~~ → StrikeThrough", () => {
    const rendered = renderZcaRichText("~~hello~~");
    assert.equal(rendered.text, "hello");
    assertSpan(rendered, TextStyle.StrikeThrough, "hello");
});

test("mã nội dòng: `hello` → Bold (Zalo không có monospace)", () => {
    const rendered = renderZcaRichText("`hello`");
    assert.equal(rendered.text, "hello");
    assertSpan(rendered, TextStyle.Bold, "hello");
});

test("in đậm + nghiêng: ***hello*** → Bold (Zalo không có kiểu kết hợp)", () => {
    const rendered = renderZcaRichText("***hello***");
    assert.equal(rendered.text, "hello");
    assertSpan(rendered, TextStyle.Bold, "hello");
});

test("ký tự được escape không bị hiểu là định dạng", () => {
    // escapeMarkdown() sinh ra \* cho dữ liệu có dấu sao.
    const rendered = renderZcaRichText("giá \\* đặc biệt");
    assert.equal(rendered.text, "giá * đặc biệt");
    assert.equal(rendered.styles.length, 0, "không được sinh style từ ký tự đã escape");
});

/* -------------------------------------------------------------------------- */
/* Tiêu đề                                                                    */
/* -------------------------------------------------------------------------- */

test("tiêu đề cấp 1: # Hello → Big + Bold, bỏ dấu #", () => {
    const rendered = renderZcaRichText("# Hello");
    assert.equal(rendered.text, "Hello");
    assertSpan(rendered, TextStyle.Big, "Hello");
    assertSpan(rendered, TextStyle.Bold, "Hello");
});

test("tiêu đề cấp 2 và 3 → Bold, bỏ dấu #", () => {
    for (const input of ["## Hello", "### Hello"]) {
        const rendered = renderZcaRichText(input);
        assert.equal(rendered.text, "Hello", `đầu vào ${input}`);
        assertSpan(rendered, TextStyle.Bold, "Hello");
    }
});

test("dấu # giữa dòng không bị coi là tiêu đề", () => {
    const rendered = renderZcaRichText("MSSV #123456");
    assert.equal(rendered.text, "MSSV #123456");
});

/* -------------------------------------------------------------------------- */
/* Cú pháp màu của dự án                                                      */
/* -------------------------------------------------------------------------- */

test("màu xanh lá: {green}Hello{/green} → Green", () => {
    const rendered = renderZcaRichText("{green}Hello{/green}");
    assert.equal(rendered.text, "Hello");
    assertSpan(rendered, TextStyle.Green, "Hello");
});

test("màu cam: {orange}Hello{/orange} → Orange", () => {
    const rendered = renderZcaRichText("{orange}Hello{/orange}");
    assert.equal(rendered.text, "Hello");
    assertSpan(rendered, TextStyle.Orange, "Hello");
});

test("màu đỏ và vàng cũng được hỗ trợ", () => {
    const red = renderZcaRichText("{red}Lỗi{/red}");
    assert.equal(red.text, "Lỗi");
    assertSpan(red, TextStyle.Red, "Lỗi");

    const yellow = renderZcaRichText("{yellow}Chú ý{/yellow}");
    assert.equal(yellow.text, "Chú ý");
    assertSpan(yellow, TextStyle.Yellow, "Chú ý");
});

test("màu không được hỗ trợ thì giữ nguyên chữ, không sinh style sai", () => {
    const rendered = renderZcaRichText("{purple}Hello{/purple}");
    // Không nhận ra màu ⇒ coi như chữ thường, tuyệt đối không bịa style.
    assert.equal(rendered.styles.length, 0);
    assert.ok(rendered.text.includes("Hello"));
});

/* -------------------------------------------------------------------------- */
/* Kết hợp nhiều kiểu — yêu cầu quan trọng nhất                               */
/* -------------------------------------------------------------------------- */

test("tiêu đề + màu: # {green}Hello{/green} → Big + Bold + Green trên cùng khoảng", () => {
    const rendered = renderZcaRichText("# {green}Hello{/green}");
    assert.equal(rendered.text, "Hello");
    assertSpan(rendered, TextStyle.Big, "Hello");
    assertSpan(rendered, TextStyle.Bold, "Hello");
    assertSpan(rendered, TextStyle.Green, "Hello");
});

test("đậm + màu lồng nhau: **{orange}/help{/orange}** → Bold + Orange", () => {
    const rendered = renderZcaRichText("**{orange}/help{/orange}**");
    assert.equal(rendered.text, "/help");
    assertSpan(rendered, TextStyle.Bold, "/help");
    assertSpan(rendered, TextStyle.Orange, "/help");
});

test("màu lồng ngoài đậm cũng cho kết quả tương đương", () => {
    const rendered = renderZcaRichText("{orange}**/help**{/orange}");
    assert.equal(rendered.text, "/help");
    assertSpan(rendered, TextStyle.Bold, "/help");
    assertSpan(rendered, TextStyle.Orange, "/help");
});

test("nhiều kiểu trên cùng một dòng, mỗi kiểu đúng khoảng của nó", () => {
    const rendered = renderZcaRichText("**đậm** thường _nghiêng_ ~~bỏ~~");
    assert.equal(rendered.text, "đậm thường nghiêng bỏ");
    assertSpan(rendered, TextStyle.Bold, "đậm");
    assertSpan(rendered, TextStyle.Italic, "nghiêng");
    assertSpan(rendered, TextStyle.StrikeThrough, "bỏ");
    assertSpansInBounds(rendered);
    // Không được áp Bold lên phần chữ thường ở giữa.
    assert.ok(!stylesOf(rendered, TextStyle.Bold).some((s) => covered(rendered, s) === "thường"));
});

/* -------------------------------------------------------------------------- */
/* Khối                                                                       */
/* -------------------------------------------------------------------------- */

test("trích dẫn: > Hello → │ Hello, không còn dấu >", () => {
    const rendered = renderZcaRichText("> Hello");
    assert.equal(rendered.text, "│ Hello");
    assert.ok(!rendered.text.startsWith(">"));
});

test("danh sách không thứ tự → UnorderedList", () => {
    for (const marker of ["-", "*", "+"]) {
        const rendered = renderZcaRichText(`${marker} Mục`);
        assert.equal(rendered.text, "Mục", `dấu ${marker}`);
        assertSpan(rendered, TextStyle.UnorderedList, "Mục");
    }
});

test("danh sách có thứ tự → OrderedList, bỏ số", () => {
    const rendered = renderZcaRichText("1. Mục đầu");
    assert.equal(rendered.text, "Mục đầu");
    assertSpan(rendered, TextStyle.OrderedList, "Mục đầu");
});

test("liên kết: [OpenAI](https://openai.com) → giữ lại URL", () => {
    const rendered = renderZcaRichText("[OpenAI](https://openai.com)");
    assert.equal(rendered.text, "OpenAI (https://openai.com)");
    assert.ok(rendered.text.includes("https://openai.com"), "không được làm mất URL");
});

test("khối mã: bỏ hàng rào ``` nhưng giữ nội dung", () => {
    const rendered = renderZcaRichText('```js\nconsole.log("hello")\n```');
    assert.equal(rendered.text, 'console.log("hello")');
    assert.ok(!rendered.text.includes("```"));
});

/* -------------------------------------------------------------------------- */
/* Tiếng Việt, emoji và an toàn offset                                        */
/* -------------------------------------------------------------------------- */

test("tiếng Việt có dấu: offset tính đúng theo ký tự", () => {
    const rendered = renderZcaRichText("**LỊCH HỌC HÔM NAY**");
    assert.equal(rendered.text, "LỊCH HỌC HÔM NAY");
    assert.equal(rendered.text.length, 16);
    const bold = stylesOf(rendered, TextStyle.Bold)[0];
    assert.equal(bold.start, 0);
    assert.equal(bold.len, 16, "độ dài phải theo ký tự, không theo byte");
});

test("emoji trước phần được định dạng: offset vẫn đúng", () => {
    const rendered = renderZcaRichText("📅 **Lịch học**");
    assert.equal(rendered.text, "📅 Lịch học");
    // Emoji là surrogate pair (2 đơn vị UTF-16) + 1 dấu cách.
    const bold = stylesOf(rendered, TextStyle.Bold)[0];
    assert.equal(bold.start, 3);
    assert.equal(bold.len, 8);
    assert.equal(covered(rendered, bold), "Lịch học");
    assertSpansInBounds(rendered);
});

test("emoji nằm trong phần được định dạng", () => {
    const rendered = renderZcaRichText("**📅 Lịch**");
    assert.equal(rendered.text, "📅 Lịch");
    const bold = stylesOf(rendered, TextStyle.Bold)[0];
    assert.equal(covered(rendered, bold), "📅 Lịch");
    assertSpansInBounds(rendered);
});

test("tiếng Việt lẫn emoji ở nhiều dòng", () => {
    const rendered = renderZcaRichText("# {green}✓ THÀNH CÔNG{/green}\n\n📅 **Lịch hôm nay**\n\n> Ghi chú 🎉");
    assertNoRawMarkers(rendered);
    assertSpansInBounds(rendered);
    assertSpan(rendered, TextStyle.Green, "✓ THÀNH CÔNG");
    assertSpan(rendered, TextStyle.Bold, "Lịch hôm nay");
});

/* -------------------------------------------------------------------------- */
/* Định dạng thật của dự án                                                   */
/* -------------------------------------------------------------------------- */

test("định dạng lệnh thật: **/lichtuan [MSSV]**", () => {
    const rendered = renderZcaRichText("**/lichtuan [MSSV]**\nXem lịch học trong tuần.\n(Ví dụ: /lichtuan 123000xxx)");
    assert.equal(rendered.text, "/lichtuan [MSSV]\nXem lịch học trong tuần.\n(Ví dụ: /lichtuan 123000xxx)");
    assertSpan(rendered, TextStyle.Bold, "/lichtuan [MSSV]");
    assertSpansInBounds(rendered);
});

test("mẫu thông báo thật: tiêu đề màu + trích dẫn + đậm", () => {
    const template = [
        "# {green}✓ ĐÃ LƯU{/green}",
        "",
        "> Dùng **/nhanlich hh:mm homnay** để chọn giờ nhận lịch.",
        "",
        "{orange}Dùng **/help** để xem danh sách lệnh.{/orange}"
    ].join("\n");

    const rendered = renderZcaRichText(template);
    assertNoRawMarkers(rendered);
    assertSpansInBounds(rendered);
    assertSpan(rendered, TextStyle.Green, "✓ ĐÃ LƯU");
    assertSpan(rendered, TextStyle.Bold, "/nhanlich hh:mm homnay");
    assertSpan(rendered, TextStyle.Bold, "/help");
    assertSpan(rendered, TextStyle.Orange, "Dùng /help để xem danh sách lệnh.");
    assert.ok(rendered.text.includes("│ "), "trích dẫn phải được chuyển thành │");
});

test("nội dung /help thật của dự án render sạch", () => {
    // Dùng đúng đầu ra của lệnh /help thật, không phải mẫu tự chế.
    const { formatGeneralHelp } = require("../main");
    const help = formatGeneralHelp();

    assert.ok(help.length > 500, "đầu ra /help phải là nội dung dài nhiều dòng");

    const rendered = renderZcaRichText(help);

    assert.ok(rendered.text.length > 0, "văn bản cuối không được rỗng");
    assert.ok(rendered.styles.length > 0, "phải sinh được style");
    assertNoRawMarkers(rendered);
    assertSpansInBounds(rendered);

    // Không còn dấu # hay dấu > ở đầu dòng.
    assert.ok(!/^#{1,6}\s/m.test(rendered.text));
    assert.ok(!/^\s*>/m.test(rendered.text));

    // Nội dung thật vẫn phải còn nguyên các phần quan trọng.
    assert.ok(rendered.text.includes("[ZALOBOT] HƯỚNG DẪN"));
    assert.ok(rendered.text.includes("/luumssv"));
    assert.ok(rendered.text.includes("/lichtuan"));
});

test("mọi span của /help đều phủ văn bản không rỗng và nằm trong biên", () => {
    const { formatGeneralHelp } = require("../main");
    const rendered = renderZcaRichText(formatGeneralHelp());

    for (const style of rendered.styles) {
        assert.ok(covered(rendered, style).length > 0, "span phủ đoạn rỗng");
        assertSpansInBounds(rendered);
    }
    // Không được sinh style trùng lặp hoàn toàn.
    const seen = new Set(rendered.styles.map((s) => `${s.start}:${s.len}:${s.st}`));
    assert.equal(seen.size, rendered.styles.length, "có span trùng lặp");
});

/* -------------------------------------------------------------------------- */
/* Biên                                                                       */
/* -------------------------------------------------------------------------- */

test("đầu vào rỗng hoặc không phải chuỗi không làm ném lỗi", () => {
    for (const input of ["", null, undefined, 0]) {
        const rendered = renderZcaRichText(input);
        assert.equal(typeof rendered.text, "string");
        assert.ok(Array.isArray(rendered.styles));
    }
});

test("ký hiệu mở mà không có ký hiệu đóng thì giữ nguyên chữ", () => {
    const rendered = renderZcaRichText("**chưa đóng");
    assert.ok(rendered.text.includes("chưa đóng"));
    assertSpansInBounds(rendered);
});

test("chuẩn hoá gộp nhiều dòng trống liên tiếp", () => {
    assert.equal(normalizeBlocks("a\n\n\n\nb"), "a\n\nb");
});

test("offset luôn trỏ vào văn bản CUỐI, không phải văn bản Markdown gốc", () => {
    // Đây là yêu cầu then chốt: nếu tính theo chuỗi gốc thì span sẽ lệch.
    const input = "**/help**";
    const rendered = renderZcaRichText(input);
    assert.notEqual(rendered.text, input, "văn bản cuối phải khác văn bản gốc");
    const bold = stylesOf(rendered, TextStyle.Bold)[0];
    assert.equal(bold.start, 0);
    assert.equal(bold.len, rendered.text.length);
    assert.equal(covered(rendered, bold), "/help");
});
