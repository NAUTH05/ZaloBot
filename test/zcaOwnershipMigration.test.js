const test = require("node:test");
const assert = require("node:assert/strict");

const { migratePendingZcaOwnership, isPendingZca } = require("../zcaOwnershipMigration");

const OLD = "zca:pending";
const NEW = "zca:2070715314762406715";
const CHAT = "4646553866539614460";

function createMemoryStore(initial = {}) {
    const files = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.parse(JSON.stringify(value))]));
    return {
        files,
        readJsonStore: (filePath) => JSON.parse(JSON.stringify(files.get(filePath) ?? {})),
        writeJsonStore: (filePath, _defaultPath, value) => { files.set(filePath, JSON.parse(JSON.stringify(value))); }
    };
}

function paths() {
    return { chatDirectoryPath: "chat.json", interactionsPath: "inter.json", subscriptionsPath: "subs.json" };
}

test("chỉ khóa tạm zca:pending mới được chuyển", () => {
    assert.equal(isPendingZca("zca:pending"), true);
    assert.equal(isPendingZca("zca:2070715314762406715"), false);
    assert.equal(isPendingZca("bot1"), false);

    const store = createMemoryStore();
    const result = migratePendingZcaOwnership("bot1", NEW, { ...paths(), ...store });
    assert.equal(result.skipped, "not_pending");
    assert.equal(result.moved, 0);
});

test("chuyển cả ba store và cập nhật trường botId", () => {
    const store = createMemoryStore({
        "chat.json": {
            schemaVersion: 2,
            chats: {
                [`${OLD}::${CHAT}`]: { chatId: CHAT, botId: OLD, admissionStatus: "admitted", status: "active" },
                [`${NEW}::other`]: { chatId: "other", botId: NEW }
            },
            deletedChatIds: { [`${OLD}::gone`]: true }
        },
        "inter.json": {
            [`${OLD}::${CHAT}`]: { chatId: CHAT, botId: OLD, lastUserId: "u1" }
        },
        "subs.json": {
            [`${OLD}::${CHAT}::u1`]: { chatId: CHAT, userId: "u1", botId: OLD, studentId: "123456789" }
        }
    });

    const result = migratePendingZcaOwnership(OLD, NEW, { ...paths(), ...store });

    assert.equal(result.moved, 4, "1 chat + 1 tombstone + 1 interaction + 1 subscription");
    assert.deepEqual(result.stores.sort(), ["chatDirectory", "interactions", "subscriptions"]);

    const chat = store.files.get("chat.json");
    assert.equal(chat.chats[`${NEW}::${CHAT}`].botId, NEW, "botId phải đổi theo khóa mới");
    assert.equal(chat.chats[`${NEW}::${CHAT}`].admissionStatus, "admitted", "không được mất trạng thái tiếp nhận");
    assert.equal(chat.chats[`${OLD}::${CHAT}`], undefined, "khóa cũ phải biến mất");
    assert.equal(chat.deletedChatIds[`${NEW}::gone`], true, "tombstone cũng phải đi theo");
    assert.equal(chat.chats[`${NEW}::other`].chatId, "other", "bản ghi khác không bị đụng");

    const inter = store.files.get("inter.json");
    assert.equal(inter[`${NEW}::${CHAT}`].botId, NEW);

    const subs = store.files.get("subs.json");
    assert.equal(subs[`${NEW}::${CHAT}::u1`].botId, NEW);
    assert.equal(subs[`${NEW}::${CHAT}::u1`].studentId, "123456789", "không được mất MSSV");
});

test("không ghi đè bản ghi đã có ở khóa mới", () => {
    const store = createMemoryStore({
        "chat.json": {
            schemaVersion: 2,
            chats: {
                [`${OLD}::${CHAT}`]: { chatId: CHAT, botId: OLD, status: "disabled" },
                [`${NEW}::${CHAT}`]: { chatId: CHAT, botId: NEW, status: "active" }
            },
            deletedChatIds: {}
        },
        "inter.json": {},
        "subs.json": {}
    });

    const result = migratePendingZcaOwnership(OLD, NEW, { ...paths(), ...store });

    assert.equal(result.moved, 0);
    assert.equal(result.duplicates, 1);
    const chat = store.files.get("chat.json");
    assert.equal(chat.chats[`${NEW}::${CHAT}`].status, "active", "dữ liệu mới hơn phải được giữ nguyên");
    assert.equal(chat.chats[`${OLD}::${CHAT}`].status, "disabled", "bản cũ không bị xoá — đó là việc của con người");
});

test("không có gì để chuyển thì không ghi file", () => {
    let writes = 0;
    const store = createMemoryStore({ "chat.json": { schemaVersion: 2, chats: {}, deletedChatIds: {} }, "inter.json": {}, "subs.json": {} });
    const result = migratePendingZcaOwnership(OLD, NEW, {
        ...paths(),
        readJsonStore: store.readJsonStore,
        writeJsonStore: (filePath, defaultPath, value) => { writes += 1; store.writeJsonStore(filePath, defaultPath, value); }
    });

    assert.equal(result.moved, 0);
    assert.equal(writes, 0, "không được ghi khi không có thay đổi");
});
