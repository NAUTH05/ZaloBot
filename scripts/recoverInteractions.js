#!/usr/bin/env node
// ============================================================================
// Khôi phục sổ tương tác sau khi một lần reset Firestore xoá mất danh bạ người
// nhận phát tin (/thongbao, /update).
//
// Script này CHỈ làm một việc: đưa trở lại những bản ghi tương tác có QUYỀN SỞ
// HỮU BOT TƯỜNG MINH VÀ KHÔNG MÂU THUẪN từ một file khôi phục.
//
//   npm run recover:interactions -- --source recovered-interactions.json
//   npm run recover:interactions -- --source recovered-interactions.json --apply
//
// Không làm gì khác. Cụ thể là KHÔNG khôi phục: đăng ký nhận tin
// (subscriptions), MSSV, lịch học, cài đặt thông báo, hay bất kỳ store nào khác.
// Những thứ đó có người sở hữu riêng và có thể đã được ghi lại sau reset — ghi
// đè lên là phá dữ liệu mới.
//
// ---------------------------------------------------------------------------
// QUY TẮC AN TOÀN (đọc trước khi sửa)
// ---------------------------------------------------------------------------
// 1. FAIL-CLOSED. Chỉ bản ghi khai báo `botId` hợp lệ VÀ không mâu thuẫn mới được
//    nhập. Không có căn cứ thì KHÔNG đoán bot 1 — đoán sai nghĩa là nhắn tin cho
//    người khác bằng tài khoản khác. Những bản ghi như vậy bị giữ ngoài đường gửi.
//
// 2. BẢO TOÀN DỮ LIỆU MỚI. Bản ghi đã có trong sổ hiện tại (ghi sau reset) LUÔN
//    được giữ nguyên. Mâu thuẫn được BÁO CÁO trước, không tự động ghi đè.
//
// 3. SAO LƯU TRƯỚC. Sổ tương tác hiện tại được ghi ra migration-backups/ TRƯỚC
//    khi ghi bất cứ thứ gì, và phải xác nhận file tồn tại mới đi tiếp.
//
// 4. CHỈ ĐỌC/GHI QUA FIRESTORE. Không dựng store cục bộ, nên không thể ghi đè
//    dữ liệu từ xa bằng một file rỗng trên đĩa.
//
// 5. KHÔNG RÒ RỈ ID NGƯỜI NHẬN. Mọi thông báo ra ngoài chỉ dùng số đếm và tên
//    bot; không in chatId/userId. Khi cần đối chiếu, in vân tay rút gọn.
// ============================================================================
const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const { createFirestore, describeFirebaseTarget, getCollectionName, getDatabaseId, loadServiceAccount } = require("../firebaseConfig");
const { LEGACY_BOT_ID, normalizeBotId, scopeKey } = require("../bots");

const INTERACTIONS_STORE_ID = "interactions";
const BACKUP_DIR = path.join(__dirname, "..", "migration-backups");
const DEFAULT_SOURCE = path.join(__dirname, "..", "recovered-interactions.json");

// Nhãn cho bản ghi không có botId. Chỉ dùng trong BÁO CÁO, không bao giờ dùng để
// gửi tin. Tên này cố ý không phải botN nên normalizeBotId() sẽ từ chối nó.
const UNVERIFIED_LABEL = "(chưa xác minh)";

/* -------------------------------------------------------------------------- */
/* Hàm thuần — kiểm tra được mà không cần Firestore                            */
/* -------------------------------------------------------------------------- */

// Khóa lưu trữ của một bản ghi tương tác, đúng như interactionRegistry ghi ra.
// bot1 giữ khóa trần, danh tính khác có tiền tố "<botId>::".
function interactionStorageKey(botId, chatId) {
    return scopeKey(botId, String(chatId));
}

// Vân tay rút gọn của một ID, để đối chiếu trong log mà không lộ danh tính.
function fingerprint(value) {
    const raw = String(value == null ? "" : value);
    if (!raw) return "(trống)";
    let hash = 0;
    for (let index = 0; index < raw.length; index += 1) {
        hash = (hash * 31 + raw.charCodeAt(index)) | 0;
    }
    return `#${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

// Đọc payload nguồn thành mảng bản ghi {chatId, botId, record} đã chuẩn hoá.
//
// Nguồn chấp nhận hai hình dạng:
//   - object khóa → bản ghi (đúng hình dạng interactions.json)
//   - mảng bản ghi (một số bản dump trả về mảng)
function normalizeSourceRecords(raw) {
    const rows = [];
    if (Array.isArray(raw)) {
        for (const item of raw) {
            if (item && typeof item === "object" && item.chatId != null) rows.push({ key: null, record: item });
        }
        return rows;
    }
    if (!raw || typeof raw !== "object") return rows;
    for (const [key, value] of Object.entries(raw)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        rows.push({ key, record: value });
    }
    return rows;
}

// Phân loại TOÀN BỘ bản ghi nguồn. Không bao giờ ném lỗi vì dữ liệu xấu: mọi thứ
// không đủ điều kiện đều đi vào `rejected` kèm lý do để người vận hành xem lại.
//
// Trả về {
//   importable: [{ botId, chatId, key, record }],
//   rejected:   [{ chatId, reason, botId }],
//   perBot:     { botId: n }
// }
function classifySourceRecords(raw) {
    const importable = [];
    const rejected = [];
    const seen = new Map();

    for (const { key, record } of normalizeSourceRecords(raw)) {
        const chatId = record.chatId == null ? null : String(record.chatId).trim();
        if (!chatId) {
            rejected.push({ chatId: null, botId: null, reason: "thiếu chatId" });
            continue;
        }

        const botId = normalizeBotId(record.botId);
        if (!botId) {
            // Không có botId tường minh (hoặc không nhận ra). KHÔNG đoán bot 1.
            rejected.push({ chatId, botId: null, reason: "không khai báo botId hợp lệ" });
            continue;
        }

        // Tiền tố khóa (nếu có) phải khớp trường botId. Lệch nhau là bằng chứng
        // mâu thuẫn — từ chối thay vì chọn một trong hai.
        if (key && typeof key === "string" && key.includes("::")) {
            const prefix = key.slice(0, key.indexOf("::"));
            const prefixBot = normalizeBotId(prefix);
            if (prefixBot && prefixBot !== botId) {
                rejected.push({ chatId, botId, reason: `khóa "${prefix}::" lệch với botId "${botId}"` });
                continue;
            }
        }

        const storageKey = interactionStorageKey(botId, chatId);
        // Cùng một (botId, chatId) xuất hiện hai lần trong nguồn: giữ bản đầu, báo
        // bản sau là trùng lặp trong chính file nguồn.
        if (seen.has(storageKey)) {
            rejected.push({ chatId, botId, reason: "trùng lặp trong file nguồn" });
            continue;
        }
        seen.set(storageKey, true);
        importable.push({ botId, chatId, key: storageKey, record });
    }

    const perBot = {};
    for (const item of importable) perBot[item.botId] = (perBot[item.botId] || 0) + 1;

    return { importable, rejected, perBot };
}

// Soạn kế hoạch nhập: bản ghi nào thêm mới, bản ghi nào va vào dữ liệu hiện có.
//
// Bản ghi đã tồn tại trong sổ hiện tại (được ghi SAU reset) KHÔNG bị đụng tới —
// chúng được báo cáo là va chạm. Chỉ bản ghi thật sự vắng mặt mới được thêm.
function planImport(current, importable) {
    const store = current && typeof current === "object" && !Array.isArray(current) ? current : {};
    const toAdd = [];
    const collisions = [];

    for (const item of importable) {
        if (Object.prototype.hasOwnProperty.call(store, item.key)) {
            collisions.push({ botId: item.botId, chatId: item.chatId, key: item.key, existing: store[item.key] });
            continue;
        }
        toAdd.push(item);
    }

    return { toAdd, collisions };
}

// Trộn: giữ nguyên mọi bản ghi hiện có, chỉ thêm những bản ghi vắng mặt.
function mergeImport(current, toAdd) {
    const store = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
    for (const item of toAdd) {
        if (Object.prototype.hasOwnProperty.call(store, item.key)) continue;
        store[item.key] = { ...item.record, chatId: item.chatId, botId: item.botId };
    }
    return store;
}

// Đếm bản ghi theo bot trong một sổ, để báo cáo trạng thái sau khi nhập.
//
// Bản ghi không có botId hợp lệ bị gom vào UNVERIFIED_LABEL — chúng vẫn nằm trong
// sổ nhưng KHÔNG bao giờ trở thành đích phát tin (getBroadcastTargets lọc chúng).
function countByBot(store) {
    const counts = {};
    if (!store || typeof store !== "object" || Array.isArray(store)) return counts;
    for (const record of Object.values(store)) {
        if (!record || typeof record !== "object") continue;
        const botId = normalizeBotId(record.botId);
        const label = botId || UNVERIFIED_LABEL;
        counts[label] = (counts[label] || 0) + 1;
    }
    return counts;
}

function formatCounts(counts) {
    const keys = Object.keys(counts).sort();
    if (keys.length === 0) return "(không có bản ghi nào)";
    return keys.map((key) => `${key}=${counts[key]}`).join(", ");
}

function readSourceFile(sourcePath) {
    const resolved = path.resolve(sourcePath);
    if (!fs.existsSync(resolved)) {
        throw new Error(`Không tìm thấy file khôi phục: ${resolved}`);
    }
    const text = fs.readFileSync(resolved, "utf8");
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new Error(`File khôi phục không phải JSON hợp lệ: ${error.message}`);
    }
    return parsed;
}

function writeBackup(payload) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(BACKUP_DIR, `interactions-recovery-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
    return file;
}

/* -------------------------------------------------------------------------- */
/* Chạy thật                                                                   */
/* -------------------------------------------------------------------------- */

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

function reportRejected(rejected) {
    if (rejected.length === 0) return;
    const byReason = {};
    for (const item of rejected) {
        byReason[item.reason] = (byReason[item.reason] || 0) + 1;
    }
    console.log(`[Recover] Giữ NGOÀI đường gửi: ${rejected.length} bản ghi không đủ điều kiện.`);
    for (const [reason, count] of Object.entries(byReason).sort()) {
        console.log(`[Recover]   - ${reason}: ${count}`);
    }
}

function parseArgs(argv) {
    const apply = argv.includes("--apply");
    const sourceIndex = argv.findIndex((value) => value === "--source" || value === "-s");
    const source = sourceIndex >= 0 && argv[sourceIndex + 1] ? argv[sourceIndex + 1] : DEFAULT_SOURCE;
    return { apply, source };
}

async function main(argv = process.argv.slice(2)) {
    const { apply, source } = parseArgs(argv);

    // 1. Đọc và phân loại nguồn TRƯỚC khi chạm vào database.
    const raw = readSourceFile(source);
    const { importable, rejected, perBot } = classifySourceRecords(raw);
    console.log(`[Recover] Nguồn: ${path.resolve(source)}`);
    console.log(`[Recover] Bản ghi đủ điều kiện nhập: ${importable.length}. Theo bot: ${formatCounts(perBot)}`);
    reportRejected(rejected);

    if (importable.length === 0) {
        console.log("[Recover] Không có bản ghi nào đủ điều kiện. Dừng lại, không ghi gì.");
        return { applied: false, reason: "nothing_importable" };
    }

    const account = loadServiceAccount(process.env);
    const databaseId = getDatabaseId();
    const collectionName = getCollectionName();
    const db = createFirestore(account.credentials, databaseId);
    const target = describeFirebaseTarget({ credentials: account.credentials, databaseId, collectionName });

    console.log(`[Recover] Project: ${target.projectId} · database ${target.databaseId} · collection ${target.collectionName}`);

    // 2. Đọc sổ tương tác hiện tại. Payload hỏng ⇒ dừng, không ghi đè.
    const store = await readStore(db, collectionName, INTERACTIONS_STORE_ID);
    if (store && !store.data) {
        throw new Error(
            `Sổ ${INTERACTIONS_STORE_ID} hiện tại không đọc được payload` +
            `${store.parseError ? ` (${store.parseError})` : ""}. Dừng để tránh ghi đè.`
        );
    }
    const current = store?.data || {};
    console.log(`[Recover] Sổ hiện tại: ${Object.keys(current).length} bản ghi. Theo bot: ${formatCounts(countByBot(current))}`);

    // 3. Soạn kế hoạch nhập. Va chạm được BÁO CÁO, không tự ghi đè.
    const { toAdd, collisions } = planImport(current, importable);

    if (collisions.length > 0) {
        console.log(`[Recover] VA CHẠM: ${collisions.length} bản ghi đã có trong sổ hiện tại và sẽ ĐƯỢC GIỮ NGUYÊN.`);
        for (const item of collisions.slice(0, 20)) {
            console.log(
                `[Recover]   - bot ${item.botId} · chat ${fingerprint(item.chatId)} ` +
                `(đã có botId trong sổ: ${normalizeBotId(item.existing?.botId) || "không"})`
            );
        }
        if (collisions.length > 20) {
            console.log(`[Recover]   ... và ${collisions.length - 20} bản ghi va chạm khác.`);
        }
        console.log("[Recover] Bản ghi mới ghi sau reset luôn được ưu tiên. Không ghi đè.");
    }

    console.log(`[Recover] Kế hoạch: thêm mới ${toAdd.length} bản ghi, giữ nguyên ${collisions.length} bản ghi hiện có.`);

    if (toAdd.length === 0) {
        console.log("[Recover] Không có bản ghi nào cần thêm. Sổ đã đầy đủ.");
        return { applied: false, reason: "nothing_to_add", collisions: collisions.length };
    }

    // 4. Sao lưu sổ hiện tại TRƯỚC khi ghi bất cứ thứ gì.
    const backupFile = writeBackup({
        reason: "interactions-recovery",
        target: { projectId: target.projectId, databaseId: target.databaseId, collectionName: target.collectionName },
        source: path.resolve(source),
        backedUpAt: new Date().toISOString(),
        interactions: store?.document || null
    });
    console.log(`[Recover] Đã sao lưu: ${backupFile}`);

    if (!fs.existsSync(backupFile)) {
        throw new Error("Không xác nhận được bản sao lưu. Dừng lại, không ghi gì.");
    }

    // 5. Chỉ ghi khi được yêu cầu.
    if (!apply) {
        console.log("");
        console.log("[Recover] DRY-RUN: chưa ghi gì. Chạy lại với --apply để nhập.");
        return { applied: false, reason: "dry_run", planned: toAdd.length, collisions: collisions.length, backupFile };
    }

    const merged = mergeImport(current, toAdd);
    await db.collection(collectionName).doc(INTERACTIONS_STORE_ID).set({
        ...(store?.document || {}),
        payload: JSON.stringify(merged),
        updatedAt: new Date().toISOString()
    }, { merge: true });

    console.log(`[Recover] Đã nhập ${toAdd.length} bản ghi.`);
    console.log(`[Recover] Sổ sau nhập: ${Object.keys(merged).length} bản ghi. Theo bot: ${formatCounts(countByBot(merged))}`);
    console.log(
        `[Recover] Lưu ý: ${formatCounts(countByBot(merged))} — nhãn "${UNVERIFIED_LABEL}" KHÔNG được phát tin.`
    );
    console.log("");
    console.log("[Recover] Xong. Bước tiếp theo: gửi thử tới MỘT chat kiểm soát cho mỗi nhà cung cấp trước khi phát toàn bộ.");
    return { applied: true, imported: toAdd.length, collisions: collisions.length, backupFile };
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[Recover] Thất bại: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    BACKUP_DIR,
    INTERACTIONS_STORE_ID,
    UNVERIFIED_LABEL,
    classifySourceRecords,
    countByBot,
    fingerprint,
    interactionStorageKey,
    mergeImport,
    normalizeSourceRecords,
    parseArgs,
    planImport,
    readSourceFile
};
