// ============================================================================
// Kiểm chứng migration trên BẢN SAO (CHỈ ĐỌC với Firestore thật).
//
// Nạp dữ liệu thật vào bộ nhớ, áp dụng đúng logic của migration, rồi so sánh
// TRƯỚC/SAU trên:
//   - từng bản ghi bị đổi (và khẳng định KHÔNG có bản ghi nào khác bị đổi)
//   - nhãn nguồn và bộ đếm trên dashboard
//   - bộ lọc theo nguồn
//   - quyền gửi (canSend) — 82 bản ghi thiếu căn cứ PHẢI vẫn bị chặn
//   - định tuyến: mỗi bản ghi đã xác minh phải trỏ tới đúng tài khoản
//
// KHÔNG ghi gì lên Firestore.
// ============================================================================
const path = require("path");
const { initializeFirestorePersistence, readJsonStore } = require("../firestorePersistence");
const { parseScopedKey, normalizeBotId } = require("../bots");
const { SOURCE_CONFIDENCE, resolveRecordSource } = require("../sourceAttribution");
const { getActiveVerifications } = require("../sourceVerifications");

const ROOT = path.join(__dirname, "..");
const STORES = ["chatDirectory", "interactions", "subscriptions", "classStartNotifications"];

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
            out.push({
                storeId, container, key, record,
                chatId: record.chatId != null ? String(record.chatId) : null,
                userId: record.userId != null ? String(record.userId) : (record.lastUserId != null ? String(record.lastUserId) : null)
            });
        }
    }
    return out;
}

(async () => {
    console.log("=== Kiểm chứng migration trên bản sao (CHỈ ĐỌC) ===\n");
    await initializeFirestorePersistence({ storeIds: STORES });

    const stores = {};
    for (const storeId of STORES) {
        stores[storeId] = readJsonStore(path.join(ROOT, storeId + ".json"), path.join(ROOT, storeId + ".json"), null);
    }
    const all = [];
    for (const storeId of STORES) all.push(...entriesOf(storeId, stores[storeId]));

    const activeVerifications = getActiveVerifications();

    // --- Dựng lại đúng logic phân loại của migration ---------------------------
    const chatScopes = new Map();
    const userScopes = new Map();
    const declaredSupport = new Map();
    for (const item of all) {
        const p = parseScopedKey(item.key);
        const declared = normalizeBotId(item.record?.botId);
        if (p.scoped) {
            if (item.chatId) {
                if (!chatScopes.has(item.chatId)) chatScopes.set(item.chatId, new Set());
                chatScopes.get(item.chatId).add(p.botId);
            }
            if (item.userId) {
                if (!userScopes.has(item.userId)) userScopes.set(item.userId, new Set());
                userScopes.get(item.userId).add(p.botId);
            }
        }
        if (declared) {
            if (item.chatId) declaredSupport.set(`${item.chatId}|${declared}`, (declaredSupport.get(`${item.chatId}|${declared}`) || 0) + 1);
            if (item.userId) declaredSupport.set(`${item.userId}|${declared}`, (declaredSupport.get(`${item.userId}|${declared}`) || 0) + 1);
        }
    }
    const single = (map, id) => { const s = id ? map.get(id) : null; return s && s.size === 1 ? [...s][0] : null; };
    const supportFor = (item, botId) => {
        if (!botId) return 0;
        let total = 0;
        if (item.chatId) total += declaredSupport.get(`${item.chatId}|${botId}`) || 0;
        if (item.userId) total += declaredSupport.get(`${item.userId}|${botId}`) || 0;
        if (normalizeBotId(item.record?.botId) === botId) total -= 1;
        return Math.max(0, total);
    };

    const before = [];
    const after = [];
    for (const item of all) {
        const verification = activeVerifications[item.storeId + "::" + item.key] || null;
        const source = resolveRecordSource(item.record, item.key, { verification });
        before.push({ item, botId: source.botId, canSend: source.canSend, confidence: source.confidence });

        let newBotId = source.botId;
        let newConfidence = source.confidence;
        let newCanSend = source.canSend;

        if (source.confidence !== SOURCE_CONFIDENCE.CONFLICT && source.confidence !== SOURCE_CONFIDENCE.MANUAL) {
            const ownerChat = single(chatScopes, item.chatId);
            const ownerUser = single(userScopes, item.userId);
            const owner = (ownerChat && ownerUser && ownerChat !== ownerUser) ? null : (ownerChat || ownerUser);
            if (owner && owner !== source.botId && supportFor(item, source.botId) === 0) {
                newBotId = owner;
                newConfidence = "migrated";
                newCanSend = true;
            }
        }
        after.push({ item, botId: newBotId, canSend: newCanSend, confidence: newConfidence });
    }

    // --- So sánh ---------------------------------------------------------------
    const changed = [];
    for (let index = 0; index < before.length; index += 1) {
        const beforeItem = before.at(index);
        const afterItem = after.at(index);
        if (beforeItem.botId !== afterItem.botId) changed.push({ before: beforeItem, after: afterItem });
    }

    console.log(`Tổng bản ghi đọc được : ${all.length}`);
    console.log(`Bản ghi THAY ĐỔI       : ${changed.length}`);
    console.log("");
    for (const c of changed) {
        console.log(`  ${c.before.item.storeId}/${c.before.item.key}`);
        console.log(`    nguồn: ${c.before.botId || "(chưa xác minh)"} → ${c.after.botId}`);
        console.log(`    gửi được: ${c.before.canSend} → ${c.after.canSend}`);
    }

    // Không bản ghi nào bị ĐỔI QUYỀN GỬI theo hướng nguy hiểm.
    const newlySendable = after.filter((entry, index) => !before.at(index).canSend && entry.canSend);
    console.log(`\nBản ghi được MỞ quyền gửi : ${newlySendable.length} (phải bằng số bản ghi thay đổi)`);
    const newlyBlocked = after.filter((entry, index) => before.at(index).canSend && !entry.canSend);
    console.log(`Bản ghi bị CHẶN thêm      : ${newlyBlocked.length} (phải là 0)`);
    if (newlyBlocked.length) {
        for (const b of newlyBlocked.slice(0, 5)) console.log(`   - ${b.item.storeId}/${b.item.key}`);
    }

    // --- 82 bản ghi thiếu căn cứ phải VẪN chưa xác minh -------------------------
    const stillUnverified = after.filter((a) => !a.botId);
    console.log(`\nBản ghi CHƯA XÁC MINH sau migration: ${stillUnverified.length}`);
    console.log(`  trong đó bị chặn gửi: ${stillUnverified.filter((a) => !a.canSend).length}`);
    console.log(`  PHẢI bằng nhau — nếu lệch nghĩa là có bản ghi vừa chưa xác minh vừa gửi được.`);

    // --- Phân bố nguồn TRƯỚC và SAU --------------------------------------------
    const tally = (list) => {
        const out = {};
        for (const x of list) out[x.botId || "(chưa xác minh)"] = (out[x.botId || "(chưa xác minh)"] || 0) + 1;
        return out;
    };
    const tBefore = tally(before);
    const tAfter = tally(after);
    console.log("\n=== Phân bố nguồn ===");
    console.log("  nguồn                      trước → sau");
    const keys = [...new Set([...Object.keys(tBefore), ...Object.keys(tAfter)])].sort();
    for (const k of keys) {
        const b = tBefore[k] || 0;
        const a = tAfter[k] || 0;
        console.log(`  ${k.padEnd(28)} ${String(b).padStart(4)} → ${String(a).padStart(4)}${b !== a ? "   <-- đổi" : ""}`);
    }

    // --- Không bản ghi nào trỏ tới danh tính TẠM --------------------------------
    const toPending = after.filter((a) => a.botId === "zca:pending");
    console.log(`\nBản ghi trỏ tới 'zca:pending' (PHẢI là 0): ${toPending.length}`);

    // --- Bộ lọc theo nguồn phải khớp số thật -----------------------------------
    console.log("\n=== Bộ lọc theo nguồn (sau migration) ===");
    for (const [source, count] of Object.entries(tAfter).sort((a, b) => b[1] - a[1])) {
        const matching = after.filter((a) => (a.botId || "(chưa xác minh)") === source).length;
        console.log(`  lọc "${source}" → ${matching} bản ghi ${matching === count ? "✓" : "✗ LỆCH"}`);
    }

    console.log("\n(Chỉ đọc — không có thay đổi nào được ghi lên Firestore.)");
    process.exit(0);
})().catch((e) => { console.error("Lỗi:", e.message); process.exit(1); });
