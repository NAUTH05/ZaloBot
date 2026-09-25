// ============================================================================
// Phân tích SÂU (chỉ đọc): tìm các bản ghi bị gán nhầm nguồn.
//
// Giả thuyết: một người vừa có bản ghi ZCA (khóa có phạm vi) vừa có bản ghi KHÔNG
// có phạm vi (bị mặc định là bot1). Nếu cùng userId/chatId xuất hiện ở cả hai thì
// bản ghi không phạm vi rất có thể đến từ kênh ZCA nhưng đang hiển thị là bot1.
//
// KHÔNG ghi, KHÔNG sửa.
// ============================================================================
const path = require("path");
const { initializeFirestorePersistence, readJsonStore } = require("../firestorePersistence");
const { parseScopedKey, normalizeBotId, storageKeyPrefix } = require("../bots");

const STORES = ["chatDirectory", "interactions", "subscriptions", "scheduleSnapshots", "classStartNotifications"];

function load(storeId) {
    return readJsonStore(
        path.join(__dirname, "..", `${storeId}.json`),
        path.join(__dirname, "..", `${storeId}.json`),
        null
    );
}

function entriesOf(storeId, data) {
    const out = [];
    if (!data || typeof data !== "object") return out;
    const containers = [];
    if (data.chats && typeof data.chats === "object") containers.push(["chats", data.chats]);
    const flat = {};
    for (const [k, v] of Object.entries(data)) {
        if (["schemaVersion", "chats", "tickets", "deletedChatIds", "sourceIndex"].includes(k)) continue;
        if (v && typeof v === "object") flat[k] = v;
    }
    if (Object.keys(flat).length) containers.push(["flat", flat]);
    for (const [container, map] of containers) {
        for (const [key, record] of Object.entries(map)) {
            if (!record || typeof record !== "object") continue;
            const parsed = parseScopedKey(key);
            out.push({
                storeId, container, key, record,
                declaredBotId: normalizeBotId(record.botId),
                keyBotId: parsed.botId,
                scoped: parsed.scoped,
                chatId: record.chatId != null ? String(record.chatId) : null,
                userId: record.userId != null ? String(record.userId) : (record.lastUserId != null ? String(record.lastUserId) : null)
            });
        }
    }
    return out;
}

async function main() {
    console.log("=== Phân tích bản ghi bị gán nhầm (CHỈ ĐỌC) ===\n");
    await initializeFirestorePersistence({ storeIds: STORES });

    const all = [];
    for (const storeId of STORES) all.push(...entriesOf(storeId, load(storeId)));

    // 1. Tập hợp định danh đã biết là ZCA.
    const zcaChatIds = new Set();
    const zcaUserIds = new Set();
    for (const item of all) {
        if (item.scoped && item.keyBotId.startsWith("zca:")) {
            if (item.chatId) zcaChatIds.add(item.chatId);
            if (item.userId) zcaUserIds.add(item.userId);
        }
    }
    console.log(`Định danh ZCA đã biết: ${zcaChatIds.size} chatId, ${zcaUserIds.size} userId\n`);

    // 2. Bản ghi KHÔNG có phạm vi (đang bị mặc định là bot1) nhưng định danh trùng ZCA.
    const suspicious = all.filter((item) =>
        !item.scoped &&
        ((item.chatId && zcaChatIds.has(item.chatId)) || (item.userId && zcaUserIds.has(item.userId)))
    );

    console.log(`Bản ghi KHÔNG phạm vi nhưng trùng định danh ZCA: ${suspicious.length}`);
    const byStore = {};
    for (const item of suspicious) byStore[item.storeId] = (byStore[item.storeId] || 0) + 1;
    for (const [storeId, count] of Object.entries(byStore)) console.log(`   ${storeId.padEnd(24)} ${count}`);

    console.log("\n   Ví dụ (tối đa 8):");
    for (const item of suspicious.slice(0, 8)) {
        console.log(`   - ${item.storeId}/${item.container} key=${item.key} chatId=${item.chatId} userId=${item.userId} botId=${item.declaredBotId || "(thiếu)"}`);
    }

    // 3. Trùng lặp hiển thị: cùng userId xuất hiện ở nhiều nguồn.
    const byUserId = new Map();
    for (const item of all) {
        if (!item.userId) continue;
        const effective = item.declaredBotId || item.keyBotId;
        if (!byUserId.has(item.userId)) byUserId.set(item.userId, new Set());
        byUserId.get(item.userId).add(effective);
    }
    const multiSource = [...byUserId.entries()].filter(([, set]) => set.size > 1);
    console.log(`\nCùng userId xuất hiện ở NHIỀU nguồn: ${multiSource.length}`);
    for (const [userId, set] of multiSource.slice(0, 8)) {
        console.log(`   - ${userId}: ${[...set].join(", ")}`);
    }

    // 4. Tên hiển thị trùng nhau giữa các nguồn (KHÔNG đủ để kết luận cùng người).
    const byName = new Map();
    for (const item of all) {
        const name = String(item.record.displayName || item.record.userDisplayName || "").trim().toLowerCase();
        if (!name) continue;
        const effective = item.declaredBotId || item.keyBotId;
        if (!byName.has(name)) byName.set(name, new Set());
        byName.get(name).add(effective);
    }
    const sameNameDifferentSource = [...byName.entries()].filter(([, set]) => set.size > 1);
    console.log(`\nTên hiển thị trùng nhưng KHÁC nguồn: ${sameNameDifferentSource.length} (chỉ để tham khảo, KHÔNG đủ căn cứ gộp)`);
    for (const [name, set] of sameNameDifferentSource.slice(0, 5)) {
        console.log(`   - "${name}": ${[...set].join(", ")}`);
    }

    // 5. Tổng hợp mức độ tin cậy.
    const confident = all.filter((item) => item.declaredBotId && item.scoped && item.declaredBotId === item.keyBotId).length;
    const fromKeyOnly = all.filter((item) => !item.declaredBotId && item.scoped).length;
    const ambiguous = all.filter((item) => !item.declaredBotId && !item.scoped).length;
    const conflicting = all.filter((item) => item.declaredBotId && item.scoped && item.declaredBotId !== item.keyBotId).length;

    console.log("\n=== Mức độ tin cậy của nguồn ===");
    console.log(`  Xác nhận (botId khớp khóa có phạm vi) : ${confident}`);
    console.log(`  Suy ra từ khóa có phạm vi (thiếu botId): ${fromKeyOnly}`);
    console.log(`  MƠ HỒ (không botId, khóa trần)          : ${ambiguous}`);
    console.log(`  MÂU THUẪN (botId khác khóa)             : ${conflicting}`);
    console.log("\n(Chỉ đọc — không có thay đổi nào được ghi.)");
    process.exit(0);
}

main().catch((error) => { console.error("Lỗi:", error.message); process.exit(1); });
