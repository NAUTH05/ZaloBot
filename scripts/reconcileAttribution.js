// ============================================================================
// Đối chiếu nguồn gốc bản ghi — CHẠY THỬ mặc định, có sao lưu trước khi ghi.
//
//   node scripts/reconcileAttribution.js              # chỉ báo cáo (mặc định)
//   node scripts/reconcileAttribution.js --apply      # ghi thật (sao lưu trước)
//
// Vấn đề: bản ghi không có trường `botId` và có khóa KHÔNG phạm vi trước đây bị
// dashboard mặc định hiển thị là bot1. Một số trong đó thực chất đến từ kênh tài
// khoản Zalo cá nhân (ZCA), nên hiển thị sai nguồn.
//
// Nguyên tắc:
//   - KHÔNG bao giờ gán bừa. Chỉ gán lại khi có BẰNG CHỨNG, và bằng chứng phải là
//     định danh có phạm vi (khóa lưu trữ), không phải tên hiển thị hay MSSV.
//   - Tên và MSSV KHÔNG BAO GIỜ là căn cứ: hai người khác nhau có thể trùng tên.
//   - Bản ghi không đủ căn cứ được giữ nguyên và báo là "chưa xác minh". Chúng
//     vẫn hiển thị được nhưng bị chặn thao tác gửi.
//   - Chạy lại nhiều lần cho kết quả như nhau (idempotent).
// ============================================================================
const fs = require("fs");
const path = require("path");
const { initializeFirestorePersistence, readJsonStore, writeJsonStore, flushPersistenceWrites } = require("../firestorePersistence");
const { parseScopedKey, normalizeBotId, LEGACY_BOT_ID } = require("../bots");
const { SOURCE_CONFIDENCE, resolveRecordSource } = require("../sourceAttribution");
const { getActiveVerifications, getCounts: getVerificationCounts } = require("../sourceVerifications");

const ROOT = path.join(__dirname, "..");
const APPLY = process.argv.includes("--apply");

// Chỉ những store này chứa bản ghi gắn với hội thoại. Không đụng vào store khác.
const STORES = ["chatDirectory", "interactions", "subscriptions", "classStartNotifications"];

function storePath(storeId) {
    return path.join(ROOT, `${storeId}.json`);
}

function loadStore(storeId) {
    return readJsonStore(storePath(storeId), storePath(storeId), null);
}

// Liệt kê mọi bản ghi trong một store kèm khóa và container.
function entriesOf(storeId, data) {
    const out = [];
    if (!data || typeof data !== "object") return out;
    const containers = [];
    if (data.chats && typeof data.chats === "object") containers.push(["chats", data.chats]);
    const flat = {};
    for (const [key, value] of Object.entries(data)) {
        if (["schemaVersion", "chats", "tickets", "deletedChatIds", "sourceIndex"].includes(key)) continue;
        if (value && typeof value === "object") flat[key] = value;
    }
    if (Object.keys(flat).length) containers.push(["flat", flat]);

    for (const [container, map] of containers) {
        for (const [key, record] of Object.entries(map)) {
            if (!record || typeof record !== "object") continue;
            out.push({
                storeId, container, key, record,
                chatId: record.chatId != null ? String(record.chatId) : null,
                userId: record.userId != null
                    ? String(record.userId)
                    : (record.lastUserId != null ? String(record.lastUserId) : null)
            });
        }
    }
    return out;
}

function main() {
    console.log(`=== Đối chiếu nguồn gốc bản ghi ${APPLY ? "(GHI THẬT)" : "(CHẠY THỬ — không ghi gì)"} ===\n`);

    const all = [];
    const storeData = {};
    for (const storeId of STORES) {
        const data = loadStore(storeId);
        storeData[storeId] = data;
        all.push(...entriesOf(storeId, data));
    }

    // --- Bằng chứng từ phạm vi khóa ---------------------------------------------
    //
    // Với mỗi chatId/userId, ghi lại tập NGUỒN (botId) đã được ghi nhận dưới khóa có
    // phạm vi. Nếu một định danh chỉ xuất hiện dưới đúng một nguồn, thì bản ghi
    // không có phạm vi trỏ tới định danh đó rất có thể thuộc nguồn ấy.
    //
    // Đây là bằng chứng mạnh hơn trường botId, vì trường đó do code cũ ghi ra và có
    // thể đã ghi sai (đúng là nguyên nhân của lỗi này).
    const chatScopes = new Map();
    const userScopes = new Map();

    for (const item of all) {
        const parsed = parseScopedKey(item.key);
        if (!parsed.scoped) continue;
        if (item.chatId) {
            if (!chatScopes.has(item.chatId)) chatScopes.set(item.chatId, new Set());
            chatScopes.get(item.chatId).add(parsed.botId);
        }
        if (item.userId) {
            if (!userScopes.has(item.userId)) userScopes.set(item.userId, new Set());
            userScopes.get(item.userId).add(parsed.botId);
        }
    }

    const scopesOf = (map, id) => map.get(id) || null;

    // --- Phân loại ---------------------------------------------------------------
    // Xác minh do quản trị viên thực hiện: bản ghi đã được người quyết định thì
    // KHÔNG đề xuất gán lại nữa. Nạp TRƯỚC vòng lặp phân loại vì vòng lặp cần tra.
    const activeVerifications = getActiveVerifications();
    const verificationCounts = getVerificationCounts();

    const confirmed = [];      // đã có nguồn xác minh và KHÔNG mâu thuẫn bằng chứng
    const recoverable = [];    // có bằng chứng định danh chỉ thuộc một bot khác
    const ambiguous = [];      // không đủ căn cứ
    const conflicting = [];    // botId mâu thuẫn trực tiếp với khóa có phạm vi

    for (const item of all) {
        const verification = activeVerifications[item.storeId + "::" + item.key] || null;
        const source = resolveRecordSource(item.record, item.key, { verification });
        if (source.confidence === SOURCE_CONFIDENCE.CONFLICT) { conflicting.push(item); continue; }
        // Đã được quản trị viên xác minh ⇒ giữ nguyên, không đề xuất lại.
        if (source.confidence === SOURCE_CONFIDENCE.MANUAL) { confirmed.push(item); continue; }

        // Bằng chứng từ phạm vi của định danh: chatId/userId này CHỈ xuất hiện dưới
        // khóa của một nguồn duy nhất. Đây là bằng chứng mạnh — mạnh hơn cả trường
        // botId, vì trường đó do chính code cũ ghi ra và có thể đã ghi sai.
        const chatOwners = item.chatId ? scopesOf(chatScopes, item.chatId) : null;
        const userOwners = item.userId ? scopesOf(userScopes, item.userId) : null;

        // Chỉ kết luận khi định danh chỉ thuộc ĐÚNG MỘT nguồn và nguồn đó KHÁC với
        // nguồn mà bản ghi đang khai báo.
        const singleOwner = (owners) => (owners && owners.size === 1 ? [...owners][0] : null);
        const ownerFromChat = singleOwner(chatOwners);
        const ownerFromUser = singleOwner(userOwners);

        if (ownerFromChat && ownerFromUser && ownerFromChat !== ownerFromUser) {
            // Hai bằng chứng chỉ về hai nguồn khác nhau ⇒ không kết luận.
            ambiguous.push(item);
            continue;
        }
        const evidenceOwner = ownerFromChat || ownerFromUser;
        const declared = source.botId;

        if (evidenceOwner && evidenceOwner !== declared) {
            recoverable.push({
                ...item,
                resolvedBotId: evidenceOwner,
                previousBotId: declared || null,
                evidence: ownerFromChat
                    ? "chatId chỉ xuất hiện ở nguồn này"
                    : "userId chỉ xuất hiện ở nguồn này"
            });
            continue;
        }

        if (source.confidence === SOURCE_CONFIDENCE.UNVERIFIED_LEGACY) ambiguous.push(item);
        else confirmed.push(item);
    }

    console.log("=== Phân loại ===");
    console.log(`  Đã xác minh, giữ nguyên            : ${confirmed.length}`);
    console.log(`  CÓ bằng chứng (ghi sai nguồn)      : ${recoverable.length}`);
    console.log(`  KHÔNG đủ căn cứ (giữ nguyên)       : ${ambiguous.length}`);
    console.log(`  Mâu thuẫn (không tự động xử lý)    : ${conflicting.length}`);
    console.log(`  Quản trị viên đã xác minh (hoàn tác được): ${verificationCounts.active} (đã hoàn tác: ${verificationCounts.revoked})`);

    const byStore = (list) => {
        const out = {};
        for (const item of list) out[item.storeId] = (out[item.storeId] || 0) + 1;
        return Object.entries(out).map(([k, v]) => `${k}=${v}`).join(", ") || "(không có)";
    };
    console.log(`\n  Theo store — có bằng chứng : ${byStore(recoverable)}`);
    console.log(`  Theo store — không căn cứ  : ${byStore(ambiguous)}`);

    // Bảng chuyển nguồn: người xem cần thấy thay đổi này đi từ đâu tới đâu TRƯỚC
    // khi quyết định ghi.
    if (recoverable.length) {
        const moves = {};
        for (const item of recoverable) {
            const key = `${item.previousBotId || "(thiếu)"} → ${item.resolvedBotId}`;
            moves[key] = (moves[key] || 0) + 1;
        }
        console.log("\n=== Chuyển nguồn dự kiến ===");
        for (const [move, count] of Object.entries(moves).sort((a, b) => b[1] - a[1])) {
            console.log(`  ${move.padEnd(28)} ${count} bản ghi`);
        }
        console.log("\n  Lưu ý: KHÔNG có bản ghi nào bị gán cho ZCA nếu không có bằng chứng");
        console.log("  từ phạm vi khóa. Bản ghi không đủ căn cứ được giữ nguyên.");
    }

    if (recoverable.length) {
        console.log("\n=== Bản ghi sẽ được gán lại (có bằng chứng định danh ZCA) ===");
        for (const item of recoverable.slice(0, 15)) {
            console.log(`  - ${item.storeId}/${item.container} key=${item.key}`);
            console.log(`      chatId=${item.chatId} userId=${item.userId}`);
            console.log(`      nguồn hiện ghi: ${item.previousBotId || "(thiếu)"} → nguồn theo bằng chứng: ${item.resolvedBotId}`);
            console.log(`      bằng chứng: ${item.evidence}`);
        }
        if (recoverable.length > 15) console.log(`  ... và ${recoverable.length - 15} bản ghi nữa`);
    }

    if (ambiguous.length) {
        console.log("\n=== Bản ghi KHÔNG đủ căn cứ (giữ nguyên, hiển thị 'Chưa xác minh') ===");
        console.log("  Những bản ghi này không có botId và khóa cũng không có phạm vi, nên KHÔNG");
        console.log("  thể kết luận thuộc bot nào. Chúng vẫn hiển thị nhưng bị chặn thao tác gửi.");
        for (const item of ambiguous.slice(0, 5)) {
            console.log(`  - ${item.storeId}/${item.container} key=${item.key} chatId=${item.chatId}`);
        }
        if (ambiguous.length > 5) console.log(`  ... và ${ambiguous.length - 5} bản ghi nữa`);
    }

    if (conflicting.length) {
        console.log("\n=== MÂU THUẪN — cần người xem xét, script KHÔNG tự sửa ===");
        for (const item of conflicting.slice(0, 10)) {
            const source = resolveRecordSource(item.record, item.key);
            console.log(`  - ${item.storeId}/${item.key}: botId="${source.declaredBotId}" nhưng khóa thuộc "${source.keyBotId}"`);
        }
    }

    if (!APPLY) {
        console.log("\nChạy thử xong. Không có thay đổi nào được ghi.");
        console.log("Để ghi thật: node scripts/reconcileAttribution.js --apply");
        return;
    }

    if (recoverable.length === 0) {
        console.log("\nKhông có bản ghi nào cần gán lại. Không ghi gì.");
        return;
    }

    // --- Sao lưu trước khi ghi ---------------------------------------------------
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(ROOT, "migration-backups", `attribution-${stamp}`);
    fs.mkdirSync(backupDir, { recursive: true });
    for (const storeId of new Set(recoverable.map((item) => item.storeId))) {
        const data = storeData[storeId];
        if (data == null) continue;
        fs.writeFileSync(path.join(backupDir, `${storeId}.json`), JSON.stringify(data, null, 2), "utf8");
    }
    console.log(`\nĐã sao lưu vào: ${backupDir}`);
    console.log("Khôi phục: copy lại các tệp trong thư mục này vào gốc dự án rồi chạy lại bot.");

    // --- Ghi --------------------------------------------------------------------
    let written = 0;
    for (const item of recoverable) {
        const data = storeData[item.storeId];
        const container = item.container === "chats" ? data.chats : data;
        const record = container[item.key];
        if (!record) continue;
        // Ghi đúng một trường: nguồn gốc. Không đụng dữ liệu khác của bản ghi.
        // Khóa lưu trữ KHÔNG đổi — đổi khóa sẽ tách bản ghi khỏi dữ liệu liên quan.
        record.botId = item.resolvedBotId;
        written += 1;
    }

    for (const storeId of new Set(recoverable.map((item) => item.storeId))) {
        writeJsonStore(storePath(storeId), storePath(storeId), storeData[storeId]);
    }

    return flushPersistenceWrites().then(() => {
        console.log(`\nĐã cập nhật ${written} bản ghi.`);
        console.log("Chạy lại script (không --apply) để xác nhận không còn bản ghi nào cần gán lại.");
    });
}

initializeFirestorePersistence({ storeIds: STORES })
    .then(() => main())
    .then(() => process.exit(0))
    .catch((error) => { console.error("Lỗi đối chiếu:", error.message); process.exit(1); });
