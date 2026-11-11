#!/usr/bin/env node
// ============================================================================
// Gán tường minh quyền sở hữu bot cho dữ liệu cũ.
//
// THIẾT KẾ KHÔNG CẦN DI TRÚ KHÓA. Bot 1 giữ nguyên không gian khóa cũ
// (chatId::userId, chatId), nên dữ liệu hiện có được dùng nguyên trạng và không
// có bước đổi khóa nào ở đây. Script này chỉ làm một việc duy nhất: thêm trường
// `botId: "bot1"` vào những bản ghi còn thiếu, để quyền sở hữu trở nên tường
// minh thay vì ngầm hiểu.
//
//   npm run migrate:bot-ownership            # chỉ xem trước + sao lưu
//   npm run migrate:bot-ownership -- --apply # ghi thật, SAU KHI sao lưu xong
//
// An toàn:
//   - Chỉ ĐỌC/GHI qua Firestore; không dựng store cục bộ nên không thể ghi đè
//     dữ liệu từ xa bằng một file rỗng.
//   - Sao lưu JSON có mốc thời gian vào migration-backups/ TRƯỚC khi ghi.
//   - Không xoá, không đổi tên, không di chuyển bản ghi nào.
//   - Idempotent: chạy lại lần hai không ghi gì thêm.
// ============================================================================
const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const { createFirestore, describeFirebaseTarget, getCollectionName, getDatabaseId, loadServiceAccount } = require("../firebaseConfig");
const { LEGACY_BOT_ID } = require("../bots");

const STORE_IDS = ["subscriptions", "chatDirectory", "interactions"];
const BACKUP_DIR = path.join(__dirname, "..", "migration-backups");
const apply = process.argv.includes("--apply");

function writeBackup(payload) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(BACKUP_DIR, `bot-ownership-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
    return file;
}

// Đọc payload của một document store. Trả về null nếu không có.
async function readStore(db, collectionName, storeId) {
    const snapshot = await db.collection(collectionName).doc(storeId).get();
    if (!snapshot.exists) return null;
    const document = snapshot.data() || {};
    if (typeof document.payload !== "string") return { document, data: null };
    try {
        return { document, data: JSON.parse(document.payload) };
    } catch (error) {
        return { document, data: null, parseError: error.message };
    }
}

// Bản ghi nào còn thiếu botId? Trả về danh sách khóa cần gán.
function pendingKeys(storeId, data) {
    if (!data || typeof data !== "object") return [];
    const keys = [];
    if (storeId === "chatDirectory") {
        for (const [key, record] of Object.entries(data.chats || {})) {
            // Khóa đã có tiền tố botN:: thì đã tường minh.
            if (/^bot\d+::/.test(key)) continue;
            if (record && typeof record === "object" && record.botId) continue;
            keys.push(key);
        }
        return keys;
    }
    for (const [key, record] of Object.entries(data)) {
        if (/^bot\d+::/.test(key)) continue;
        if (!record || typeof record !== "object" || Array.isArray(record)) continue;
        if (record.botId) continue;
        keys.push(key);
    }
    return keys;
}

function withBotId(storeId, data, keys) {
    const next = JSON.parse(JSON.stringify(data));
    if (storeId === "chatDirectory") {
        for (const key of keys) {
            if (next.chats?.[key]) next.chats[key] = { ...next.chats[key], botId: LEGACY_BOT_ID };
        }
        return next;
    }
    for (const key of keys) next[key] = { ...next[key], botId: LEGACY_BOT_ID };
    return next;
}

async function main() {
    const account = loadServiceAccount(process.env);
    const databaseId = getDatabaseId();
    const collectionName = getCollectionName();
    const db = createFirestore(account.credentials, databaseId);
    const target = describeFirebaseTarget({ credentials: account.credentials, databaseId, collectionName });

    console.log(`[Migrate] Project: ${target.projectId} · database ${target.databaseId} · collection ${target.collectionName}`);
    console.log(`[Migrate] Không đổi khóa: bot 1 giữ nguyên không gian khóa cũ.`);

    const plan = [];
    for (const storeId of STORE_IDS) {
        const store = await readStore(db, collectionName, storeId);
        if (!store) {
            console.log(`[Migrate] ${storeId}: không có document.`);
            continue;
        }
        if (!store.data) {
            console.error(`[Migrate] ${storeId}: payload không đọc được${store.parseError ? ` (${store.parseError})` : ""}. Bỏ qua để tránh ghi đè.`);
            continue;
        }
        const keys = pendingKeys(storeId, store.data);
        console.log(`[Migrate] ${storeId}: ${keys.length} bản ghi cần gán botId (tổng ${Object.keys(store.data.chats || store.data).length}).`);
        if (keys.length > 0) plan.push({ storeId, store, keys });
    }

    if (plan.length === 0) {
        console.log("[Migrate] Không có gì để làm. Mọi bản ghi đã có botId tường minh.");
        return;
    }

    // Sao lưu nguyên trạng mọi store sẽ bị sửa, trước khi sửa bất cứ thứ gì.
    const backupFile = writeBackup({
        reason: "bot-ownership",
        target: { projectId: target.projectId, databaseId: target.databaseId, collectionName: target.collectionName },
        backedUpAt: new Date().toISOString(),
        stores: Object.fromEntries(plan.map((item) => [item.storeId, item.store.document]))
    });
    console.log(`[Migrate] Đã sao lưu: ${backupFile}`);

    if (!fs.existsSync(backupFile)) {
        console.error("[Migrate] Không xác nhận được bản sao lưu. Dừng lại, không ghi gì.");
        process.exitCode = 1;
        return;
    }

    if (!apply) {
        console.log("");
        console.log("[Migrate] DRY-RUN: chưa ghi gì. Chạy lại với --apply để gán botId.");
        return;
    }

    for (const item of plan) {
        const next = withBotId(item.storeId, item.store.data, item.keys);
        await db.collection(collectionName).doc(item.storeId).set({
            ...item.store.document,
            payload: JSON.stringify(next),
            updatedAt: new Date().toISOString()
        }, { merge: true });
        console.log(`[Migrate] ${item.storeId}: đã gán botId cho ${item.keys.length} bản ghi.`);
    }

    console.log("");
    console.log("[Migrate] Xong. Kiểm tra lại: chạy script không có --apply, số cần gán phải là 0.");
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[Migrate] Thất bại: ${error.message}`);
        process.exitCode = 1;
    });
}

// Xuất các hàm thuần để kiểm tra được tính idempotent mà không cần Firestore.
module.exports = { pendingKeys, withBotId, STORE_IDS };
