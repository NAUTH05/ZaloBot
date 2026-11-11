#!/usr/bin/env node
// ============================================================================
// Dọn tài liệu birthdayData còn lại sau khi gỡ tính năng sinh nhật 27/08.
//
// Bot KHÔNG còn đọc hay ghi tài liệu này, nên nó nằm im và không ảnh hưởng gì.
// Script này chỉ dành cho khi bạn đã xác minh bản triển khai và chắc chắn không
// cần dữ liệu cũ nữa.
//
//   npm run cleanup:birthday-data              # chỉ xem trước + sao lưu cục bộ
//   npm run cleanup:birthday-data -- --apply   # xoá thật, SAU KHI sao lưu thành công
//
// An toàn:
//   - Luôn ghi bản sao lưu JSON có mốc thời gian vào migration-backups/ TRƯỚC.
//   - Nếu sao lưu lỗi thì KHÔNG xoá gì.
//   - Không bao giờ tự chạy; không được bot gọi ở bất kỳ đâu.
//   - Chỉ đụng đúng một document: birthdayData.
// ============================================================================
const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const {
    createFirestore,
    describeFirebaseTarget,
    getCollectionName,
    getDatabaseId,
    loadServiceAccount
} = require("../firebaseConfig");

const STORE_ID = "birthdayData";
const BACKUP_DIR = path.join(__dirname, "..", "migration-backups");
const apply = process.argv.includes("--apply");

function writeBackup(payload) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(BACKUP_DIR, `${STORE_ID}-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
    return file;
}

async function main() {
    const account = loadServiceAccount(process.env);
    const databaseId = getDatabaseId();
    const collectionName = getCollectionName();
    const db = createFirestore(account.credentials, databaseId);
    const target = describeFirebaseTarget({ credentials: account.credentials, databaseId, collectionName });

    console.log(`[Cleanup] Project: ${target.projectId} · database ${target.databaseId} · collection ${target.collectionName}`);
    console.log(`[Cleanup] Document: ${collectionName}/${STORE_ID}`);

    const reference = db.collection(collectionName).doc(STORE_ID);
    const snapshot = await reference.get();

    if (!snapshot.exists) {
        console.log("[Cleanup] Không có document nào. Không cần làm gì.");
        return;
    }

    const document = snapshot.data() || {};
    let parsedPayload = null;
    if (typeof document.payload === "string") {
        try {
            parsedPayload = JSON.parse(document.payload);
        } catch (error) {
            console.error(`[Cleanup] Cảnh báo: payload không đọc được dưới dạng JSON (${error.message}).`);
        }
    }

    const summary = {
        questions: Array.isArray(parsedPayload?.questions) ? parsedPayload.questions.length : null,
        nextQuestionId: parsedPayload?.nextQuestionId ?? null,
        hasDeliveries: Boolean(parsedPayload?.deliveries),
        updatedAt: document.updatedAt || null
    };
    console.log(`[Cleanup] Câu hỏi: ${summary.questions ?? "(không đọc được)"} · nextQuestionId: ${summary.nextQuestionId ?? "-"} · cập nhật: ${summary.updatedAt || "-"}`);

    // Sao lưu nguyên trạng document trước khi làm bất cứ điều gì.
    const backupFile = writeBackup({
        storeId: STORE_ID,
        target: { projectId: target.projectId, databaseId: target.databaseId, collectionName: target.collectionName },
        backedUpAt: new Date().toISOString(),
        document
    });
    console.log(`[Cleanup] Đã sao lưu: ${backupFile}`);

    if (!fs.existsSync(backupFile)) {
        console.error("[Cleanup] Không xác nhận được bản sao lưu. Dừng lại, không xoá gì.");
        process.exitCode = 1;
        return;
    }

    if (!apply) {
        console.log("");
        console.log("[Cleanup] DRY-RUN: chưa xoá gì. Chạy lại với --apply để xoá document này.");
        return;
    }

    await reference.delete();
    console.log(`[Cleanup] Đã xoá ${collectionName}/${STORE_ID}.`);
    console.log(`[Cleanup] Khôi phục nếu cần: đọc lại ${path.basename(backupFile)} và ghi lại document với trường payload.`);
}

main().catch((error) => {
    console.error(`[Cleanup] Thất bại: ${error.message}`);
    process.exitCode = 1;
});
