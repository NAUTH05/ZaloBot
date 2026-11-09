// ============================================================================
// Test luồng GÁN ẢNH CHO LỆNH HELP, chạy trên Firestore giả.
//
// Vì sao cần: lỗi người dùng gặp là "gán ảnh cho lệnh rồi mà bot không gửi ảnh".
// Chuỗi phụ thuộc ở đây dài (upload → metadata.command → associate → truy vấn
// theo command → gửi), nên phải chốt bằng test thay vì suy luận.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// --- Firestore giả, đủ dùng cho mediaStorage -------------------------------
const store = new Map();   // "collection/id" -> data

function makeQuery(collectionName, filters = [], max = null) {
    const query = {
        where(field, op, value) {
            return makeQuery(collectionName, [...filters, { field, op, value }], max);
        },
        limit(count) {
            return makeQuery(collectionName, filters, count);
        },
        orderBy() {
            return query;
        },
        async get() {
            const prefix = `${collectionName}/`;
            const all = [...store.entries()]
                .filter(([key]) => key.startsWith(prefix))
                .map(([key, data]) => ({ id: key.slice(prefix.length), data: () => data }));

            const matched = all.filter((doc) => filters.every((filter) => {
                const value = doc.data()[filter.field];
                if (filter.op === "==") return value === filter.value;
                if (filter.op === ">") return String(value) > String(filter.value);
                return true;
            }));

            const limited = typeof max === "number" ? matched.slice(0, max) : matched;
            return {
                size: limited.length,
                docs: limited,
                forEach(callback) { limited.forEach(callback); }
            };
        }
    };
    return query;
}

function makeDoc(collectionName, id) {
    const key = `${collectionName}/${id}`;
    return {
        async get() {
            return {
                exists: store.has(key),
                data: () => store.get(key)
            };
        },
        async set(data, options = {}) {
            const current = options.merge ? (store.get(key) || {}) : {};
            store.set(key, { ...current, ...data });
        },
        async delete() {
            store.delete(key);
        }
    };
}

const fakeDb = {
    collection(name) {
        return {
            doc: (id) => makeDoc(name, id),
            where: (field, op, value) => makeQuery(name, [{ field, op, value }]),
            limit: (count) => makeQuery(name, [], count),
            get: () => makeQuery(name, [], null).get()
        };
    }
};

// Gắn db giả vào firestorePersistence TRƯỚC khi mediaStorage đọc.
const persistencePath = require.resolve("../firestorePersistence");
const realPersistence = require(persistencePath);
require.cache[persistencePath] = {
    id: persistencePath,
    filename: persistencePath,
    loaded: true,
    exports: { ...realPersistence, getFirestoreDb: () => fakeDb }
};

const {
    MEDIA_TYPES,
    associateHelpImage,
    deleteMedia,
    getHelpImagesForCommand,
    listMediaByType,
    storeMedia
} = require("../mediaStorage");

function jpegBytes() {
    return Buffer.from([
        0xFF, 0xD8, 0xFF, 0xE0,
        0x00, 0x10,
        0x4A, 0x46, 0x49, 0x46, 0x00,
        0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
        0xFF, 0xD9
    ]);
}

test.beforeEach(() => store.clear());

test("ảnh upload kèm lệnh được tìm thấy khi /help <lệnh> cần ảnh", async () => {
    const media = await storeMedia({
        buffer: jpegBytes(),
        originalName: "nhanlich.jpg",
        mediaType: MEDIA_TYPES.HELP_IMAGE,
        metadata: { command: "nhanlich" }
    });

    const images = await getHelpImagesForCommand("nhanlich");
    assert.equal(images.length, 1, "phải tìm được ảnh vừa gắn");
    assert.equal(images[0].mediaId, media.mediaId);
    assert.ok(String(images[0].url).startsWith("/api/media/"));
    assert.equal(images[0].filePath, undefined, "không được trả đường dẫn nội bộ");
});

test("ảnh gắn bằng associateHelpImage cũng được tìm thấy", async () => {
    const media = await storeMedia({
        buffer: jpegBytes(),
        originalName: "sau.jpg",
        mediaType: MEDIA_TYPES.HELP_IMAGE
    });

    // Lúc upload chưa chọn lệnh — đúng tình huống trong ảnh chụp màn hình.
    assert.deepEqual(await getHelpImagesForCommand("nhanlich"), []);

    const ok = await associateHelpImage(media.mediaId, "nhanlich");
    assert.equal(ok, true);

    const images = await getHelpImagesForCommand("nhanlich");
    assert.equal(images.length, 1);
    assert.equal(images[0].command, "nhanlich");
});

test("ảnh của lệnh khác không bị lẫn sang", async () => {
    await storeMedia({
        buffer: jpegBytes(),
        originalName: "a.jpg",
        mediaType: MEDIA_TYPES.HELP_IMAGE,
        metadata: { command: "nhanlich" }
    });
    await storeMedia({
        buffer: jpegBytes(),
        originalName: "b.jpg",
        mediaType: MEDIA_TYPES.HELP_IMAGE,
        metadata: { command: "luumssv" }
    });

    assert.equal((await getHelpImagesForCommand("nhanlich")).length, 1);
    assert.equal((await getHelpImagesForCommand("luumssv")).length, 1);
    assert.equal((await getHelpImagesForCommand("help")).length, 0);
});

test("ảnh chat không lọt vào ảnh hướng dẫn", async () => {
    const chatImage = await storeMedia({
        buffer: jpegBytes(),
        originalName: "chat.jpg",
        mediaType: MEDIA_TYPES.CHAT_IMAGE,
        metadata: { command: "nhanlich" }
    });

    const images = await getHelpImagesForCommand("nhanlich");
    assert.equal(images.length, 0, "mediaType chat-image không được coi là ảnh trợ giúp");

    const helpOnly = await listMediaByType(MEDIA_TYPES.HELP_IMAGE);
    assert.equal(helpOnly.some((item) => item.mediaId === chatImage.mediaId), false);
});

test("gắn nhiều ảnh cho cùng một lệnh, sắp theo thời gian", async () => {
    for (const name of ["1.jpg", "2.jpg", "3.jpg"]) {
        await storeMedia({
            buffer: jpegBytes(),
            originalName: name,
            mediaType: MEDIA_TYPES.HELP_IMAGE,
            metadata: { command: "nhanlich" }
        });
    }

    const images = await getHelpImagesForCommand("nhanlich");
    assert.equal(images.length, 3);
    const times = images.map((item) => item.storedAt);
    assert.deepEqual(times, [...times].sort(), "phải theo thứ tự thời gian tăng dần");
});

test("lệnh không có ảnh thì trả mảng rỗng, không lỗi", async () => {
    assert.deepEqual(await getHelpImagesForCommand("khongcolenh"), []);
    assert.deepEqual(await getHelpImagesForCommand(""), []);
    assert.deepEqual(await getHelpImagesForCommand(null), []);
});

test("xoá ảnh thì không còn trong danh sách của lệnh", async () => {
    const media = await storeMedia({
        buffer: jpegBytes(),
        originalName: "xoa.jpg",
        mediaType: MEDIA_TYPES.HELP_IMAGE,
        metadata: { command: "nhanlich" }
    });

    assert.equal((await getHelpImagesForCommand("nhanlich")).length, 1);
    await deleteMedia(media.mediaId);
    assert.equal((await getHelpImagesForCommand("nhanlich")).length, 0);
});
