// ============================================================================
// Chính sách nhận tin theo từng nhóm.
//
// Bối cảnh: cổng nhóm bỏ qua mọi tin không nhắc tới bot. Đúng cho nhóm lớp, sai
// cho nhóm HỖ TRỢ — quản trị viên không thấy tin nào trong Chat Center nên không
// hỗ trợ được. Nhưng mở cổng toàn cục (GROUP_MENTION_ONLY=0) thì mọi nhóm đều
// thành nhóm hỗ trợ, và mỗi tin lại kéo theo lời chào tự động.
//
// Bài dưới đây canh phần lưu trữ + phạm vi của chính sách đó.
// ============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Firestore giả, cài TRƯỚC khi nạp module (module đọc qua firestorePersistence).
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

const groupPolicy = require("../groupPolicy");

// Mỗi bài một "tệp" riêng để không dính dữ liệu của bài trước.
function freshFile(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gp-${name}-`));
    return path.join(dir, "groupPolicy.json");
}

test("mặc định là 'mention' — không tự mở cổng cho nhóm nào", () => {
    const file = freshFile("default");
    assert.equal(groupPolicy.getChatMode({ botId: "bot1", chatId: "g1" }, file), "mention");
    assert.equal(groupPolicy.allowsUntagged("mention"), false);
});

test("bật 'ingest' cho một nhóm, không ảnh hưởng nhóm khác", () => {
    const file = freshFile("scope");
    groupPolicy.setChatMode({ botId: "bot1", chatId: "g1", mode: "ingest" }, file);

    assert.equal(groupPolicy.getChatMode({ botId: "bot1", chatId: "g1" }, file), "ingest");
    assert.equal(groupPolicy.getChatMode({ botId: "bot1", chatId: "g2" }, file), "mention", "nhóm khác phải giữ mặc định");
    assert.equal(groupPolicy.allowsUntagged("ingest"), true);
});

test("cùng chatId ở hai bot là hai nhóm khác nhau", () => {
    const file = freshFile("bots");
    groupPolicy.setChatMode({ botId: "bot1", chatId: "g1", mode: "ingest" }, file);

    assert.equal(groupPolicy.getChatMode({ botId: "bot1", chatId: "g1" }, file), "ingest");
    // ZCA và bot chính thức có không gian chatId riêng; bật cho bot này không
    // được bật cho bot kia.
    assert.equal(groupPolicy.getChatMode({ botId: "zca:111", chatId: "g1" }, file), "mention");
});

test("xoá ghi đè thì quay về mặc định", () => {
    const file = freshFile("clear");
    groupPolicy.setChatMode({ botId: "bot1", chatId: "g1", mode: "ingest" }, file);
    const result = groupPolicy.setChatMode({ botId: "bot1", chatId: "g1", mode: null }, file);

    assert.equal(result.override, false);
    assert.equal(groupPolicy.getChatMode({ botId: "bot1", chatId: "g1" }, file), "mention");
    assert.deepEqual(groupPolicy.listOverrides(file), []);
});

test("chế độ lạ bị từ chối, không âm thầm ghi đè bằng giá trị sai", () => {
    const file = freshFile("bogus");
    assert.throws(
        () => groupPolicy.setChatMode({ botId: "bot1", chatId: "g1", mode: "all" }, file),
        /mention, ingest/
    );
    assert.equal(groupPolicy.getChatMode({ botId: "bot1", chatId: "g1" }, file), "mention");
});

test("thiếu botId hoặc chatId thì báo lỗi thay vì ghi vào khóa rác", () => {
    const file = freshFile("missing");
    assert.throws(() => groupPolicy.setChatMode({ botId: "", chatId: "g1", mode: "ingest" }, file), /botId và chatId/);
    assert.throws(() => groupPolicy.setChatMode({ botId: "bot1", chatId: "", mode: "ingest" }, file), /botId và chatId/);
});

test("dữ liệu hỏng trong tệp không làm sập: đọc ra mặc định an toàn", () => {
    const file = freshFile("corrupt");
    memoryFiles.set(path.resolve(file), { schemaVersion: 1, defaultMode: "lung-tung", chats: { "bot1::g1": { mode: "la" } } });

    assert.equal(groupPolicy.getChatMode({ botId: "bot1", chatId: "g1" }, file), "mention");
    assert.deepEqual(groupPolicy.listOverrides(file), []);
});

test("chế độ mặc định đổi được và áp cho mọi nhóm chưa ghi đè", () => {
    const file = freshFile("global");
    groupPolicy.setChatMode({ botId: "bot1", chatId: "g1", mode: "mention" }, file);
    groupPolicy.setDefaultMode("ingest", file);

    assert.equal(groupPolicy.getChatMode({ botId: "bot1", chatId: "g1" }, file), "mention", "ghi đè riêng vẫn thắng");
    assert.equal(groupPolicy.getChatMode({ botId: "bot1", chatId: "g9" }, file), "ingest");
});
