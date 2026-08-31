const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const INCLUDED_EXTENSIONS = new Set([".js", ".html", ".md"]);
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "test"]);

function productionTextFiles(directory = ROOT) {
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...productionTextFiles(absolutePath));
        else if (INCLUDED_EXTENSIONS.has(path.extname(entry.name))) files.push(absolutePath);
    }
    return files;
}

test("production copy does not contain obsolete UX wording", () => {
    const obsoletePatterns = [
        /ĐẾN GIỜ HỌC RỒI/i,
        /Bot sẽ/i,
        /bạn ơi/i,
        /CHƯA LƯU MSSV/i,
        /\[(?:OK|i|BẬT|TẮT)\]/,
        /\[(?:\+|-|\*)\]\s+(?:THÊM MỚI|ĐÃ XÓA|ĐIỀU CHỈNH)/,
        /Nhóm\/Lớp/i,
        /\bOnline:/i,
        /thông báo ngắn/i,
        /Chưa rõ môn/i,
        /Chưa đăng ký giờ/i,
        /Notify (?:on|off)/i
    ];

    const violations = [];
    for (const filePath of productionTextFiles()) {
        const content = fs.readFileSync(filePath, "utf8");
        for (const pattern of obsoletePatterns) {
            if (pattern.test(content)) violations.push(`${path.relative(ROOT, filePath)}: ${pattern}`);
        }
    }

    assert.deepEqual(violations, []);
});
