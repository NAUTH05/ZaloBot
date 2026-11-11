// Sửa dữ liệu còn mang danh tính TẠM của ZCA (`zca:pending`).
//
// Bối cảnh: trước khi quét QR xong, nhà cung cấp ZCA chưa biết UID thật nên được
// đăng ký dưới khóa tạm `zca:pending`. Mọi bản ghi sinh ra trong khoảng đó mang
// khóa tạm. Sau khi đăng nhập, `rekeyBot()` đổi khóa của NHÀ CUNG CẤP, nhưng dữ
// liệu đã ghi thì vẫn nằm dưới khóa cũ.
//
// Hệ quả thấy được: bản ghi đó trỏ tới một danh tính không còn tồn tại, nên
// `resolveBroadcastOwner()` xếp nó vào `owner_bot_offline` và **mọi đợt
// /thongbao, /update đều bỏ qua chat đó** — im lặng, không lỗi, người vận hành chỉ
// thấy "1 bỏ qua" mà không hiểu vì sao.
//
// Nguyên tắc:
//   - Chỉ đụng tới khóa `zca:pending` — danh tính tạm, không bao giờ là thật.
//   - Không ghi đè bản ghi đã có ở khóa mới (dữ liệu mới hơn thì thắng).
//   - Ghi qua đúng lớp lưu trữ hiện có để cache và Firestore không lệch nhau.

const path = require("path");
const { readJsonStore, writeJsonStore } = require("./firestorePersistence");
const { normalizeBotId } = require("./bots");

const CHAT_DIRECTORY_PATH = path.join(__dirname, "chatDirectory.json");
const INTERACTIONS_PATH = path.join(__dirname, "interactions.json");
const SUBSCRIPTIONS_PATH = path.join(__dirname, "subscriptions.json");

const PENDING_ZCA_ID = "zca:pending";

function isPendingZca(botId) {
    return normalizeBotId(botId) === PENDING_ZCA_ID;
}

// Đổi khóa `<oldPrefix><phần còn lại>` thành `<newPrefix><phần còn lại>` trong một
// map phẳng, đồng thời cập nhật trường `botId` của bản ghi.
function migrateKeyedRecords(records, oldPrefix, newPrefix, newBotId) {
    let moved = 0;
    let duplicates = 0;
    for (const key of Object.keys(records || {})) {
        if (!key.startsWith(oldPrefix)) continue;
        const targetKey = `${newPrefix}${key.slice(oldPrefix.length)}`;
        if (records[targetKey]) {
            // Đã có bản ghi ở khóa mới ⇒ đó là dữ liệu mới hơn. Không ghi đè, và
            // cũng không xoá bản cũ: xoá dữ liệu là việc của con người.
            duplicates += 1;
            continue;
        }
        const record = records[key];
        delete records[key];
        records[targetKey] = record && typeof record === "object" && !Array.isArray(record)
            ? { ...record, botId: newBotId }
            : record;
        moved += 1;
    }
    return { moved, duplicates };
}

// `options` chỉ dùng cho kiểm thử: thay đường dẫn và lớp đọc/ghi.
function migratePendingZcaOwnership(oldBotId, newBotId, options = {}) {
    const result = { moved: 0, duplicates: 0, stores: [], skipped: null };
    if (!isPendingZca(oldBotId)) return { ...result, skipped: "not_pending" };
    const normalizedNew = normalizeBotId(newBotId);
    if (!normalizedNew || normalizedNew === PENDING_ZCA_ID) return { ...result, skipped: "invalid_target" };

    const oldPrefix = `${PENDING_ZCA_ID}::`;
    const newPrefix = `${normalizedNew}::`;
    const read = options.readJsonStore || readJsonStore;
    const write = options.writeJsonStore || writeJsonStore;
    const paths = {
        chatDirectory: options.chatDirectoryPath || CHAT_DIRECTORY_PATH,
        interactions: options.interactionsPath || INTERACTIONS_PATH,
        subscriptions: options.subscriptionsPath || SUBSCRIPTIONS_PATH
    };

    // chatDirectory có thêm `deletedChatIds` cũng mang khóa theo phạm vi bot.
    const directory = read(paths.chatDirectory, paths.chatDirectory, { schemaVersion: 2, chats: {}, deletedChatIds: {} });
    if (directory && typeof directory === "object") {
        const chats = migrateKeyedRecords(directory.chats || {}, oldPrefix, newPrefix, normalizedNew);
        const tombstones = migrateKeyedRecords(directory.deletedChatIds || {}, oldPrefix, newPrefix, normalizedNew);
        const moved = chats.moved + tombstones.moved;
        if (moved > 0) {
            write(paths.chatDirectory, paths.chatDirectory, directory);
            result.stores.push("chatDirectory");
        }
        result.moved += moved;
        result.duplicates += chats.duplicates + tombstones.duplicates;
    }

    for (const store of ["interactions", "subscriptions"]) {
        const records = read(paths[store], paths[store], {});
        if (!records || typeof records !== "object") continue;
        const migrated = migrateKeyedRecords(records, oldPrefix, newPrefix, normalizedNew);
        if (migrated.moved > 0) {
            write(paths[store], paths[store], records);
            result.stores.push(store);
        }
        result.moved += migrated.moved;
        result.duplicates += migrated.duplicates;
    }

    return result;
}

module.exports = {
    CHAT_DIRECTORY_PATH,
    INTERACTIONS_PATH,
    PENDING_ZCA_ID,
    SUBSCRIPTIONS_PATH,
    isPendingZca,
    migrateKeyedRecords,
    migratePendingZcaOwnership
};
