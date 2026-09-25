// ============================================================================
// Kiểm tra CHỈ ĐỌC: đối chiếu nguồn gốc của mọi bản ghi trong Firestore.
//
// KHÔNG ghi, KHÔNG sửa, KHÔNG xoá. Chỉ đọc và thống kê.
//
// Mục đích: biết chính xác có bao nhiêu bản ghi (a) thiếu botId, (b) nằm dưới
// khóa zca:pending, (c) có botId mâu thuẫn với tiền tố khóa, (d) không có khóa
// phạm vi nên bị mặc định là bot1.
// ============================================================================
const path = require("path");
const { initializeFirestorePersistence, readJsonStore } = require("../firestorePersistence");
const { parseScopedKey, normalizeBotId, LEGACY_BOT_ID } = require("../bots");

const STORES = [
    "accessControl", "adminAudit", "adminLogs", "adminSettings", "chatDirectory",
    "interactions", "classStartNotifications", "scheduleSnapshots", "subscriptions",
    "feedbackTickets"
];

function classifyKey(key) {
    const parsed = parseScopedKey(key);
    return { botId: parsed.botId, scoped: parsed.scoped, assumed: !parsed.scoped };
}

async function main() {
    console.log("=== Kiểm tra nguồn gốc bản ghi (CHỈ ĐỌC) ===\n");
    await initializeFirestorePersistence({ storeIds: STORES });

    const report = {};

    for (const storeId of STORES) {
        const data = readJsonStore(
            path.join(__dirname, "..", `${storeId}.json`),
            path.join(__dirname, "..", `${storeId}.json`),
            null
        );
        if (!data || typeof data !== "object") {
            report[storeId] = { present: false };
            continue;
        }

        // Mỗi store có hình dạng khác nhau: chatDirectory có .chats, số khác là map phẳng.
        const containers = [];
        if (data.chats && typeof data.chats === "object") containers.push(["chats", data.chats]);
        if (data.tickets && typeof data.tickets === "object") containers.push(["tickets", data.tickets]);
        const flat = {};
        for (const [key, value] of Object.entries(data)) {
            if (["schemaVersion", "chats", "tickets", "deletedChatIds", "sourceIndex"].includes(key)) continue;
            if (value && typeof value === "object") flat[key] = value;
        }
        if (Object.keys(flat).length) containers.push(["flat", flat]);

        const summary = {
            present: true,
            total: 0,
            noBotIdField: 0,
            unscopedKey: 0,
            zcaPendingKey: 0,
            botIdMatchesKey: 0,
            botIdConflictsKey: 0,
            byBotId: {},
            examples: { noBotIdField: [], zcaPendingKey: [], conflicts: [] }
        };

        for (const [containerName, container] of containers) {
            for (const [key, record] of Object.entries(container)) {
                if (!record || typeof record !== "object") continue;
                summary.total += 1;

                const declared = normalizeBotId(record.botId);
                const fromKey = classifyKey(key);
                const effective = declared || fromKey.botId;

                summary.byBotId[effective] = (summary.byBotId[effective] || 0) + 1;

                if (!declared) {
                    summary.noBotIdField += 1;
                    if (summary.examples.noBotIdField.length < 3) {
                        summary.examples.noBotIdField.push({ store: storeId, container: containerName, key });
                    }
                }
                if (!fromKey.scoped) summary.unscopedKey += 1;
                if (key.startsWith("zca:pending::") || record.botId === "zca:pending") {
                    summary.zcaPendingKey += 1;
                    if (summary.examples.zcaPendingKey.length < 3) {
                        summary.examples.zcaPendingKey.push({ store: storeId, key, botId: record.botId || null });
                    }
                }
                if (declared && fromKey.scoped) {
                    if (declared === fromKey.botId) summary.botIdMatchesKey += 1;
                    else {
                        summary.botIdConflictsKey += 1;
                        if (summary.examples.conflicts.length < 3) {
                            summary.examples.conflicts.push({ store: storeId, key, declared, fromKey: fromKey.botId });
                        }
                    }
                }
            }
        }
        report[storeId] = summary;
    }

    console.log("Store                | tổng | thiếu botId | khóa trần | zca:pending | khớp khóa | MÂU THUẪN");
    console.log("---------------------|------|-------------|-----------|-------------|-----------|----------");
    let totals = { total: 0, noBotId: 0, unscoped: 0, pending: 0, conflicts: 0 };
    for (const [storeId, summary] of Object.entries(report)) {
        if (!summary.present) { console.log(`${storeId.padEnd(20)} | (không có)`); continue; }
        totals.total += summary.total;
        totals.noBotId += summary.noBotIdField;
        totals.unscoped += summary.unscopedKey;
        totals.pending += summary.zcaPendingKey;
        totals.conflicts += summary.botIdConflictsKey;
        console.log(
            `${storeId.padEnd(20)} | ${String(summary.total).padStart(4)} | ` +
            `${String(summary.noBotIdField).padStart(11)} | ${String(summary.unscopedKey).padStart(9)} | ` +
            `${String(summary.zcaPendingKey).padStart(11)} | ${String(summary.botIdMatchesKey).padStart(9)} | ` +
            `${String(summary.botIdConflictsKey).padStart(8)}`
        );
    }
    console.log("---------------------|------|-------------|-----------|-------------|-----------|----------");
    console.log(`TỔNG                 | ${String(totals.total).padStart(4)} | ${String(totals.noBotId).padStart(11)} | ${String(totals.unscoped).padStart(9)} | ${String(totals.pending).padStart(11)} |           | ${String(totals.conflicts).padStart(8)}`);

    console.log("\n=== Phân bố theo botId hiệu dụng ===");
    const merged = {};
    for (const summary of Object.values(report)) {
        if (!summary.present) continue;
        for (const [botId, count] of Object.entries(summary.byBotId)) {
            merged[botId] = (merged[botId] || 0) + count;
        }
    }
    for (const [botId, count] of Object.entries(merged).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${botId.padEnd(24)} ${count}`);
    }

    console.log("\n=== Ví dụ ===");
    for (const [storeId, summary] of Object.entries(report)) {
        if (!summary.present) continue;
        if (summary.examples.zcaPendingKey.length) {
            console.log(`  [zca:pending] ${storeId}:`, JSON.stringify(summary.examples.zcaPendingKey));
        }
        if (summary.examples.conflicts.length) {
            console.log(`  [mâu thuẫn] ${storeId}:`, JSON.stringify(summary.examples.conflicts));
        }
    }
    const noBotIdExample = Object.entries(report).find(([, s]) => s.present && s.examples.noBotIdField.length);
    if (noBotIdExample) {
        console.log(`  [thiếu botId] ${noBotIdExample[0]}:`, JSON.stringify(noBotIdExample[1].examples.noBotIdField));
    }

    console.log("\n(Chỉ đọc — không có thay đổi nào được ghi.)");
    process.exit(0);
}

main().catch((error) => { console.error("Lỗi kiểm tra:", error.message); process.exit(1); });
