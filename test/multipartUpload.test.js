// ============================================================================
// Test cho bộ phân tích multipart của adminServer.
//
// Lỗi thật đã xảy ra: body của mỗi part bị cắt thêm 2 byte ở cuối (sau khi đã
// cắt \r\n một lần lúc tách part). Hệ quả:
//   - field "help" thành "he"  ⇒ ảnh gắn vào lệnh không tồn tại, bot gửi "/he"
//   - tệp/ảnh mất 2 byte cuối  ⇒ ảnh hỏng nhẹ
// Không bài test nào chạm tới vì trước đây hàm này không được xuất ra.
// ============================================================================

process.env.ADMIN_BASE_PATH = "/";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseMultipart } = require("../adminServer");

const BOUNDARY = "----zalobotboundary123";

function buildBody(parts) {
    const chunks = [];
    for (const part of parts) {
        chunks.push(Buffer.from(`--${BOUNDARY}\r\n`));
        chunks.push(Buffer.from(part.headers));
        chunks.push(Buffer.from("\r\n\r\n"));
        chunks.push(Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body, "utf8"));
        chunks.push(Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
    return Buffer.concat(chunks);
}

function filePart(name, filename, mime, body) {
    return {
        headers: `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${mime}`,
        body
    };
}

function fieldPart(name, value) {
    return {
        headers: `Content-Disposition: form-data; name="${name}"`,
        body: value
    };
}

test("field text giữ NGUYÊN VẸN giá trị, không bị cắt ký tự cuối", () => {
    const body = buildBody([fieldPart("command", "help")]);
    const parsed = parseMultipart(body, BOUNDARY);

    assert.equal(parsed.fields.command, "help", `nhận "${parsed.fields.command}" thay vì "help"`);
});

test("giá trị một ký tự vẫn đọc được", () => {
    const parsed = parseMultipart(buildBody([fieldPart("x", "a")]), BOUNDARY);
    assert.equal(parsed.fields.x, "a");
});

test("giá trị có dấu tiếng Việt không bị mất byte", () => {
    const parsed = parseMultipart(buildBody([fieldPart("note", "nhanh lịch")]), BOUNDARY);
    assert.equal(parsed.fields.note, "nhanh lịch");
});

test("tệp giữ nguyên từng byte, kể cả 2 byte cuối", () => {
    // JPEG kết thúc bằng FF D9 — chính là 2 byte từng bị cắt mất.
    const bytes = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0xFF, 0xD9]);
    const parsed = parseMultipart(buildBody([filePart("file", "a.jpg", "image/jpeg", bytes)]), BOUNDARY);

    assert.ok(parsed.file);
    assert.equal(parsed.file.originalName, "a.jpg");
    assert.equal(parsed.file.declaredMime, "image/jpeg");
    assert.deepEqual([...parsed.file.buffer], [...bytes]);
});

test("đọc được cả field và tệp trong cùng request, đúng thứ tự bất kỳ", () => {
    // Thứ tự thực tế từ FormData: file trước, field sau.
    const bytes = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
    const body = buildBody([
        filePart("file", "anh.png", "image/png", bytes),
        fieldPart("mediaType", "help-image"),
        fieldPart("command", "nhanlich")
    ]);
    const parsed = parseMultipart(body, BOUNDARY);

    assert.equal(parsed.fields.mediaType, "help-image");
    assert.equal(parsed.fields.command, "nhanlich");
    assert.deepEqual([...parsed.file.buffer], [...bytes]);
});

test("field sau tệp không bị dính byte của tệp", () => {
    const bytes = Buffer.from([0x01, 0x02, 0x03]);
    const body = buildBody([
        filePart("file", "a.bin", "application/octet-stream", bytes),
        fieldPart("command", "help")
    ]);
    const parsed = parseMultipart(body, BOUNDARY);

    assert.equal(parsed.fields.command, "help");
});

test("tên tệp có dấu tiếng Việt đọc đúng", () => {
    const parsed = parseMultipart(
        buildBody([filePart("file", "ảnh hướng dẫn.jpg", "image/jpeg", Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]))]),
        BOUNDARY
    );
    assert.equal(parsed.file.originalName, "ảnh hướng dẫn.jpg");
});

test("body rỗng hoặc không có part thì trả về rỗng, không ném", () => {
    const parsed = parseMultipart(Buffer.from(""), BOUNDARY);
    assert.deepEqual(parsed.fields, {});
    assert.equal(parsed.file, null);
});
