// ============================================================================
// Rà soát (CHỈ ĐỌC): bằng chứng có thực sự ĐỘC LẬP với nhãn bot1 sai không?
//
// Ba câu hỏi:
//   A. Có bản ghi nào dưới khóa "zca:pending::" không? Nếu có, bằng chứng đang coi
//      một danh tính TẠM là tài khoản thật.
//   B. Trong số bản ghi sẽ bị gán lại, có trường hợp nào chatId ĐỒNG THỜI xuất hiện
//      dưới khóa bot1 (không phạm vi) VÀ dưới khóa botN khác không? Nếu có thì có
//      thể là HAI cuộc trò chuyện thật, không phải gán nhầm.
//   C. Bằng chứng có bao giờ dựa vào trường botId không? (Kiểm tra bằng cách chạy
//      lại thu thập bằng chứng chỉ từ tiền tố khóa.)
// ============================================================================
const path = require("path");
const { initializeFirestorePersistence, readJsonStore } = require("../firestorePersistence");
const { parseScopedKey } = require("../bots");
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
    await initializeFirestorePersistence({ storeIds: STORES });
    const all = [];
    for (const storeId of STORES) {
        all.push(...entriesOf(storeId, readJsonStore(path.join(ROOT, storeId + ".json"), path.join(ROOT, storeId + ".json"), null)));
    }

    // --- A. zca:pending ---------------------------------------------------------
    console.log("=== A. Danh tinh TAM 'zca:pending' ===");
    const pending = all.filter((item) => item.key.startsWith("zca:pending::") || item.record.botId === "zca:pending");
    console.log(`  Bản ghi dưới khóa zca:pending: ${pending.length}`);
    if (pending.length) {
        for (const item of pending.slice(0, 5)) console.log(`   - ${item.storeId}/${item.key}`);
    } else {
        console.log("  (không có — nhưng code vẫn phải chặn, vì khóa này khớp mẫu hợp lệ)");
    }

    // --- C. Bằng chứng chỉ từ tiền tố khóa --------------------------------------
    console.log("\n=== C. Bằng chứng có dựa vào trường botId không? ===");
    // Thu thập lại phạm vi CHỈ từ tiền tố khóa, rồi so với việc dùng cả trường botId.
    const keyOnlyScopes = new Map();
    for (const item of all) {
        const p = parseScopedKey(item.key);
        if (!p.scoped) continue;
        if (item.chatId) {
            if (!keyOnlyScopes.has(item.chatId)) keyOnlyScopes.set(item.chatId, new Set());
            keyOnlyScopes.get(item.chatId).add(p.botId);
        }
    }
    const pendingInScopes = [...keyOnlyScopes.entries()].filter(([, s]) => s.has("zca:pending"));
    console.log(`  chatId có 'zca:pending' trong tập nguồn: ${pendingInScopes.length}`);
    console.log("  => Bằng chứng lấy từ TIỀN TỐ KHÓA, không lấy từ trường botId.");

    // --- B. Rủi ro gán quá tay --------------------------------------------------
    console.log("\n=== B. Rủi ro gán quá tay ===");
    // Với mỗi bản ghi không phạm vi, xem chatId của nó có xuất hiện dưới NHIỀU nguồn
    // có phạm vi khác nhau không.
    const multiSource = [];
    for (const item of all) {
        const p = parseScopedKey(item.key);
        if (p.scoped) continue;
        const scopes = item.chatId ? keyOnlyScopes.get(item.chatId) : null;
        if (scopes && scopes.size > 1) multiSource.push({ item, scopes: [...scopes] });
    }
    console.log(`  Bản ghi không phạm vi mà chatId thuộc NHIỀU nguồn: ${multiSource.length}`);
    console.log("  (Những bản ghi này KHÔNG được tự gán — cần người xác minh)");
    for (const { item, scopes } of multiSource.slice(0, 5)) {
        console.log(`   - ${item.storeId}/${item.key} chatId=${item.chatId} nguồn=[${scopes.join(", ")}]`);
    }

    // --- Tổng hợp theo đúng logic của script migration ---------------------------
    console.log("\n=== Tổng hợp theo logic migration hiện tại ===");
    const activeVerifications = getActiveVerifications();
    const counts = { confirmed: 0, recoverable: 0, ambiguous: 0, conflict: 0 };
    const moves = {};
    const skippedMulti = [];

    const chatScopes = keyOnlyScopes;
    const userScopes = new Map();
    for (const item of all) {
        const p = parseScopedKey(item.key);
        if (!p.scoped) continue;
        if (item.userId) {
            if (!userScopes.has(item.userId)) userScopes.set(item.userId, new Set());
            userScopes.get(item.userId).add(p.botId);
        }
    }

    for (const item of all) {
        const verification = activeVerifications[item.storeId + "::" + item.key] || null;
        const source = resolveRecordSource(item.record, item.key, { verification });
        if (source.confidence === SOURCE_CONFIDENCE.CONFLICT) { counts.conflict += 1; continue; }
        if (source.confidence === SOURCE_CONFIDENCE.MANUAL) { counts.confirmed += 1; continue; }

        const single = (map, id) => {
            const s = id ? map.get(id) : null;
            return s && s.size === 1 ? [...s][0] : null;
        };
        const ownerChat = single(chatScopes, item.chatId);
        const ownerUser = single(userScopes, item.userId);

        if (ownerChat && ownerUser && ownerChat !== ownerUser) { counts.ambiguous += 1; continue; }
        const owner = ownerChat || ownerUser;

        if (owner && owner !== source.botId) {
            counts.recoverable += 1;
            const key = `${source.botId || "(thiếu)"} → ${owner}`;
            moves[key] = (moves[key] || 0) + 1;
            continue;
        }
        if (source.confidence === SOURCE_CONFIDENCE.UNVERIFIED_LEGACY) counts.ambiguous += 1;
        else counts.confirmed += 1;
    }

    console.log(`  Đã xác minh, giữ nguyên : ${counts.confirmed}`);
    console.log(`  Có bằng chứng, gán lại  : ${counts.recoverable}`);
    console.log(`  Không đủ căn cứ         : ${counts.ambiguous}`);
    console.log(`  Mâu thuẫn               : ${counts.conflict}`);
    console.log("  Chuyển nguồn:");
    for (const [move, count] of Object.entries(moves).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${move.padEnd(30)} ${count}`);
    }

    // Không bản ghi nào được gán cho zca:pending.
    const toPending = Object.entries(moves).filter(([move]) => move.includes("zca:pending"));
    console.log(`\n  Gán cho zca:pending (PHẢI là 0): ${toPending.length}`);
    process.exit(0);
})().catch((e) => { console.error("Lỗi:", e.message); process.exit(1); });
