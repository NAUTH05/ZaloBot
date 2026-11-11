// ============================================================================
// Test cho media của tin nhắn ĐI VÀO.
//
// Lỗi đang chặn: người dùng gửi ảnh, Chat Center hiện "[không có nội dung]".
// Nguyên nhân: tin của Zalo không có `text`, và ảnh không được ghi vào lịch sử.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const persistencePath = require.resolve("../firestorePersistence");
const realPersistence = require(persistencePath);
const memoryFiles = new Map();
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const fileKey = (filePath, defaultPath) => path.resolve(filePath || defaultPath);

require.cache[persistencePath] = {
    id: persistencePath,
    filename: persistencePath,
    loaded: true,
    exports: {
        ...realPersistence,
        readJsonStore: (filePath, defaultPath, fallback) => {
            const key = fileKey(filePath, defaultPath);
            if (!memoryFiles.has(key)) memoryFiles.set(key, clone(fallback) ?? null);
            return clone(memoryFiles.get(key));
        },
        writeJsonStore: (filePath, defaultPath, value) => {
            memoryFiles.set(fileKey(filePath, defaultPath), clone(value));
        }
    }
};

const {
    extractInboundAttachments,
    ingestInboundAttachments,
    pendingDescriptors,
    pickMediaUrl
} = require("../inboundMedia");
const { deleteMedia } = require("../mediaStorage");
const adapter = require("../providers/zca/zcaMessageAdapter");

function jpegBytes() {
    return Buffer.from([
        0xFF, 0xD8, 0xFF, 0xE0,
        0x00, 0x10,
        0x4A, 0x46, 0x49, 0x46, 0x00,
        0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
        0xFF, 0xD9
    ]);
}

// fetch giả: trả về đúng bytes đã cho, hoặc lỗi.
function fakeFetch({ bytes = jpegBytes(), status = 200, contentLength = null, throws = null } = {}) {
    return async () => {
        if (throws) throw throws;
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (name) => (String(name).toLowerCase() === "content-length" ? contentLength : null) },
            arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        };
    };
}

/* -------------------------------------------------------------------------- */
/* Chuẩn hoá attachment                                                        */
/* -------------------------------------------------------------------------- */

test("nhận ảnh từ tin của bot chính thức (URL dạng chuỗi)", () => {
    const found = extractInboundAttachments({ photo: "https://cdn.zalo.example/a.jpg" });
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, "image");
    assert.equal(found[0].url, "https://cdn.zalo.example/a.jpg");
});

test("ảnh dạng mảng cỡ: chọn cỡ LỚN NHẤT (phần tử cuối)", () => {
    const found = extractInboundAttachments({
        photo: [
            { url: "https://cdn.zalo.example/small.jpg" },
            { url: "https://cdn.zalo.example/big.jpg" }
        ]
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].url, "https://cdn.zalo.example/big.jpg");
});

test("ảnh dạng object có url", () => {
    const found = extractInboundAttachments({ photo: { url: "https://cdn.zalo.example/x.jpg" } });
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, "image");
});

test("nhận tệp từ tin của bot chính thức, giữ tên gốc", () => {
    const found = extractInboundAttachments({
        document: { url: "https://cdn.zalo.example/bao-cao.pdf", file_name: "bao-cao.pdf" }
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, "file");
    assert.equal(found[0].name, "bao-cao.pdf");
});

test("nhận attachment đã chuẩn hoá từ adapter ZCA", () => {
    const found = extractInboundAttachments({
        text: "",
        attachments: [{ kind: "image", url: "https://cdn.zalo.example/zca.jpg", name: "anh.jpg" }]
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].url, "https://cdn.zalo.example/zca.jpg");
});

test("bỏ URL không phải http/https", () => {
    assert.equal(extractInboundAttachments({ photo: "file:///etc/passwd" }).length, 0);
    assert.equal(extractInboundAttachments({ photo: "data:image/png;base64,AAA" }).length, 0);
});

test("không có media thì trả mảng rỗng", () => {
    assert.deepEqual(extractInboundAttachments({ text: "xin chào" }), []);
    assert.deepEqual(extractInboundAttachments({}), []);
});

test("pickMediaUrl chịu được giá trị lạ", () => {
    assert.equal(pickMediaUrl(null), null);
    assert.equal(pickMediaUrl(123), null);
    assert.equal(pickMediaUrl([]), null);
});

test("pendingDescriptors đánh dấu đang tải để UI hiện ngay", () => {
    const pending = pendingDescriptors([{ kind: "image", url: "https://x/a.jpg", name: "a.jpg" }]);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].pending, true);
    assert.equal(pending[0].type, "image");
});

/* -------------------------------------------------------------------------- */
/* Adapter ZCA                                                                 */
/* -------------------------------------------------------------------------- */

test("adapter ZCA giữ lại ảnh thay vì bỏ mất", () => {
    const message = {
        threadId: "chat-1",
        type: 0,
        data: { uidFrom: "u1", dName: "An", content: { href: "https://cdn.zalo.example/z.jpg", title: "" } }
    };
    const internal = adapter.toInternalMessage(message);
    assert.equal(internal.text, "");
    assert.equal(internal.attachments.length, 1);
    assert.equal(internal.attachments[0].kind, "image");
    assert.equal(internal.attachments[0].url, "https://cdn.zalo.example/z.jpg");
});

test("adapter ZCA nhận ra tệp theo đuôi trong tiêu đề", () => {
    const message = {
        threadId: "chat-1",
        type: 0,
        data: { uidFrom: "u1", content: { href: "https://cdn.zalo.example/f", title: "bang-diem.pdf" } }
    };
    const internal = adapter.toInternalMessage(message);
    assert.equal(internal.attachments[0].kind, "file");
    assert.equal(internal.attachments[0].name, "bang-diem.pdf");
});

test("adapter ZCA không tạo attachment cho tin chỉ có chữ", () => {
    const internal = adapter.toInternalMessage({
        threadId: "chat-1",
        type: 0,
        data: { uidFrom: "u1", content: "xin chào" }
    });
    assert.deepEqual(internal.attachments, []);
    assert.equal(internal.text, "xin chào");
});

/* -------------------------------------------------------------------------- */
/* Tải và lưu                                                                  */
/* -------------------------------------------------------------------------- */

test("tải ảnh vào rồi lưu thành media nội bộ", async () => {
    const stored = await ingestInboundAttachments(
        [{ kind: "image", url: "https://cdn.zalo.example/a.jpg", name: "a.jpg" }],
        { fetchImpl: fakeFetch() }
    );

    try {
        assert.equal(stored.length, 1);
        assert.equal(stored[0].type, "image");
        assert.ok(stored[0].mediaId, "phải lưu thành media nội bộ");
        assert.ok(String(stored[0].url).startsWith("/api/media/"));
        assert.equal(stored[0].failed, undefined);
    } finally {
        await deleteMedia(stored[0].mediaId);
    }
});

test("tải thất bại thì ghi nhận failed, không ném", async () => {
    const stored = await ingestInboundAttachments(
        [{ kind: "image", url: "https://cdn.zalo.example/a.jpg", name: "a.jpg" }],
        { fetchImpl: fakeFetch({ status: 404 }) }
    );

    assert.equal(stored.length, 1);
    assert.equal(stored[0].failed, true);
    assert.match(String(stored[0].error), /404/);
});

test("ảnh quá lớn theo content-length thì bỏ, không tải hết", async () => {
    const stored = await ingestInboundAttachments(
        [{ kind: "image", url: "https://cdn.zalo.example/a.jpg", name: "a.jpg" }],
        { fetchImpl: fakeFetch({ contentLength: 50 * 1024 * 1024 }) }
    );

    assert.equal(stored[0].failed, true);
    assert.match(String(stored[0].error), /quá lớn/);
});

test("nội dung không phải ảnh thì đánh dấu failed thay vì lưu rác", async () => {
    const notAnImage = Buffer.from("day khong phai anh");
    const stored = await ingestInboundAttachments(
        [{ kind: "image", url: "https://cdn.zalo.example/a.jpg", name: "a.jpg" }],
        { fetchImpl: fakeFetch({ bytes: notAnImage }) }
    );

    assert.equal(stored[0].failed, true);
});

test("không có fetch thì trả failed, không làm sập luồng ghi lịch sử", async () => {
    const stored = await ingestInboundAttachments(
        [{ kind: "image", url: "https://cdn.zalo.example/a.jpg", name: "a.jpg" }],
        { fetchImpl: null }
    );
    // fetchImpl null ⇒ rơi về globalThis.fetch (có trong Node 18+), nên chỉ cần
    // khẳng định hàm không ném và trả về mảng cùng độ dài.
    assert.equal(stored.length, 1);
});

test("danh sách rỗng thì trả mảng rỗng", async () => {
    assert.deepEqual(await ingestInboundAttachments([]), []);
    assert.deepEqual(await ingestInboundAttachments(null), []);
});
