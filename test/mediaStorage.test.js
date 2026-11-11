// ============================================================================
// Tests for mediaStorage — lưu trữ ảnh an toàn.
//
// Kiểm tra:
//   - detectMimeFromBuffer nhận diện đúng JPEG/PNG/GIF/WebP
//   - validateUploadedFile chấp nhận ảnh hợp lệ, từ chối file rỗng/không phải ảnh
//   - storeMedia lưu file và trả metadata không chứa filePath
//   - getMediaInfo trả đường dẫn file để serve
//   - deleteMedia xoá file
//   - conversationIdFor tạo ID đúng định dạng
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const {
    detectMimeFromBuffer,
    validateUploadedFile,
    storeMedia,
    getMediaInfo,
    deleteMedia,
    MEDIA_TYPES,
    MAX_FILE_SIZE
} = require("../mediaStorage");

const { conversationIdFor, DIRECTION, STATUS, SOURCE } = require("../messageRecorder");

// Tạo buffer ảnh JPEG nhỏ (1x1 pixel).
function minimalJpeg() {
    // JPEG SOI + minimal header + EOI
    return Buffer.from([
        0xFF, 0xD8, 0xFF, 0xE0,  // SOI + APP0 marker
        0x00, 0x10,              // length
        0x4A, 0x46, 0x49, 0x46, 0x00,  // "JFIF\0"
        0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
        0xFF, 0xD9               // EOI
    ]);
}

function minimalPng() {
    return Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,  // PNG signature
        0x00, 0x00, 0x00, 0x0D,  // IHDR length
        0x49, 0x48, 0x44, 0x52   // "IHDR"
    ]);
}

test("detectMimeFromBuffer nhận diện JPEG", () => {
    assert.strictEqual(detectMimeFromBuffer(minimalJpeg()), "image/jpeg");
});

test("detectMimeFromBuffer nhận diện PNG", () => {
    assert.strictEqual(detectMimeFromBuffer(minimalPng()), "image/png");
});

test("detectMimeFromBuffer trả null cho data không phải ảnh", () => {
    assert.strictEqual(detectMimeFromBuffer(Buffer.from("hello world")), null);
    assert.strictEqual(detectMimeFromBuffer(Buffer.alloc(0)), null);
});

test("validateUploadedFile chấp nhận JPEG hợp lệ", () => {
    const file = { buffer: minimalJpeg() };
    const result = validateUploadedFile(file);
    assert.ok(result.valid);
    assert.strictEqual(result.mimeType, "image/jpeg");
});

test("validateUploadedFile từ chối file rỗng", () => {
    const result = validateUploadedFile({ buffer: Buffer.alloc(0) });
    assert.ok(!result.valid);
    assert.ok(result.error);
});

test("validateUploadedFile từ chối file không phải ảnh", () => {
    const result = validateUploadedFile({ buffer: Buffer.from("not an image") });
    assert.ok(!result.valid);
    assert.ok(result.error);
});

test("validateUploadedFile từ chối khi thiếu file", () => {
    const result = validateUploadedFile(null);
    assert.ok(!result.valid);
});

test("storeMedia lưu file JPEG và trả metadata không chứa filePath", async () => {
    const buffer = minimalJpeg();
    const result = await storeMedia({
        buffer,
        originalName: "test.jpg",
        declaredMime: "image/jpeg",
        mediaType: MEDIA_TYPES.HELP_IMAGE,
        metadata: { command: "nhanlich" }
    });

    assert.ok(result.mediaId);
    assert.strictEqual(result.mediaType, MEDIA_TYPES.HELP_IMAGE);
    assert.strictEqual(result.mimeType, "image/jpeg");
    assert.strictEqual(result.size, buffer.length);
    assert.ok(result.url.startsWith("/api/media/"));
    assert.ok(!result.filePath, "filePath must not be in the returned object");

    // File phải tồn tại trên đĩa.
    // Dọn dẹp sau test.
    await deleteMedia(result.mediaId);
});

test("getMediaInfo trả đường dẫn file cho serving", async () => {
    const buffer = minimalJpeg();
    const stored = await storeMedia({
        buffer,
        originalName: "info-test.jpg",
        mediaType: MEDIA_TYPES.HELP_IMAGE
    });

    const info = await getMediaInfo(stored.mediaId);
    assert.ok(info);
    assert.ok(info.filePath);
    assert.strictEqual(info.mimeType, "image/jpeg");
    assert.ok(fs.existsSync(info.filePath));

    // Dọn dẹp.
    await deleteMedia(stored.mediaId);
});

test("deleteMedia xoá file khỏi đĩa", async () => {
    const buffer = minimalJpeg();
    const stored = await storeMedia({
        buffer,
        originalName: "delete-test.jpg",
        mediaType: MEDIA_TYPES.HELP_IMAGE
    });

    const deleted = await deleteMedia(stored.mediaId);
    assert.ok(deleted);

    // File không còn tồn tại.
    const info = await getMediaInfo(stored.mediaId);
    // getMediaInfo có thể vẫn tìm thấy metadata Firestore (tùy backend),
    // nhưng file trên đĩa phải đã bị xoá.
    if (info) {
        assert.ok(!fs.existsSync(info.filePath), "File should be deleted from disk");
    }
});

test("storeMedia từ chối file quá lớn", async () => {
    // Tạo buffer lớn hơn MAX_FILE_SIZE.
    const largeBuffer = Buffer.alloc(MAX_FILE_SIZE + 1, 0xFF);
    largeBuffer[0] = 0xFF;
    largeBuffer[1] = 0xD8;
    largeBuffer[2] = 0xFF;

    await assert.rejects(
        storeMedia({ buffer: largeBuffer, mediaType: MEDIA_TYPES.HELP_IMAGE }),
        /quá lớn|too large/i
    );
});

test("storeMedia từ chối buffer không phải ảnh", async () => {
    await assert.rejects(
        storeMedia({ buffer: Buffer.from("text"), mediaType: MEDIA_TYPES.HELP_IMAGE }),
        /không phải ảnh|magic bytes/i
    );
});

// ---------------------------------------------------------------------------
// messageRecorder tests
// ---------------------------------------------------------------------------

test("conversationIdFor tạo ID đúng cho bot1 (không prefix)", () => {
    const id = conversationIdFor("bot1", "123456");
    assert.strictEqual(id, "123456");
});

test("conversationIdFor tạo ID đúng cho bot2 (có prefix)", () => {
    const id = conversationIdFor("bot2", "123456");
    assert.strictEqual(id, "bot2::123456");
});

test("conversationIdFor tạo ID đúng cho ZCA", () => {
    const id = conversationIdFor("zca:123456789", "chat123");
    assert.strictEqual(id, "zca:123456789::chat123");
});

test("DIRECTION có đúng các giá trị", () => {
    assert.strictEqual(DIRECTION.INBOUND, "inbound");
    assert.strictEqual(DIRECTION.OUTBOUND, "outbound");
});

test("STATUS có đúng các giá trị", () => {
    assert.strictEqual(STATUS.SENT, "sent");
    assert.strictEqual(STATUS.FAILED, "failed");
    assert.strictEqual(STATUS.PENDING, "pending");
});

test("SOURCE có đúng các giá trị", () => {
    assert.ok(SOURCE.BOT_COMMAND);
    assert.ok(SOURCE.ADMIN_CHAT);
    assert.ok(SOURCE.INBOUND_USER);
});

/* ---------------------------------------------------------------------------
   Ảnh bị cụt phải bị từ chối ngay lúc upload.

   Magic bytes chỉ kiểm tra phần ĐẦU, nên một ảnh mất vài byte cuối vẫn lọt qua
   và chỉ hỏng khi Zalo tải về — đúng sự cố bộ phân tích multipart cắt 2 byte.
   --------------------------------------------------------------------------- */

test("ảnh JPEG đủ byte cuối thì hợp lệ", () => {
    const result = validateUploadedFile({ buffer: minimalJpeg() });
    assert.equal(result.valid, true);
});

test("ảnh JPEG mất 2 byte cuối (FF D9) bị từ chối", () => {
    const truncated = minimalJpeg().slice(0, -2);
    const result = validateUploadedFile({ buffer: truncated });

    assert.equal(result.valid, false);
    assert.match(String(result.error), /cụt|thiếu dữ liệu/i);
});

test("ảnh PNG thiếu chunk IEND bị từ chối", () => {
    const head = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
    const valid = Buffer.concat([head, Buffer.alloc(16, 0), iend]);

    assert.equal(validateUploadedFile({ buffer: valid }).valid, true);

    const truncated = valid.slice(0, -4);
    assert.equal(validateUploadedFile({ buffer: truncated }).valid, false);
});
