function text(value) {
    return value == null ? "" : String(value).trim();
}

// Dữ liệu từ API LHU và hồ sơ Zalo có thể chứa ký tự Markdown.
// Escape trước khi chèn vào template để không làm hỏng rich text của cả tin nhắn.
function escapeMarkdown(value) {
    return text(value).replace(/([\\*_~`#>{}\[\]])/g, "\\$1");
}

module.exports = { escapeMarkdown };
