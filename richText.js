function text(value) {
    return value == null ? "" : String(value).trim();
}

// Dữ liệu từ API LHU và hồ sơ Zalo có thể chứa ký tự Markdown.
// Escape trước khi chèn vào template để không làm hỏng rich text của cả tin nhắn.
function escapeMarkdown(value) {
    const sanitized = text(value)
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s{2,}/g, " ")
        .replace(/\{/g, "(")
        .replace(/\}/g, ")");
    return sanitized.replace(/([\\*_~`>])/g, "\\$1");
}

function escapeMarkdownMultiline(value) {
    return text(value)
        .replace(/\{/g, "(")
        .replace(/\}/g, ")")
        .split(/\r?\n/)
        .map((line) => line.replace(/([\\*_~`>])/g, "\\$1"))
        .join("\n");
}

function sanitizeExternalRichText(value) {
    return text(value).replace(/\{/g, "(").replace(/\}/g, ")");
}

module.exports = { escapeMarkdown, escapeMarkdownMultiline, sanitizeExternalRichText };
