#!/usr/bin/env node
// ============================================================================
// Di trú ngày đích cho các mốc nhận lịch cũ.
//
// Trước đây ngày đích được suy ra từ giờ gửi (trước 20:00 = lịch hôm nay, từ
// 20:00 = lịch hôm sau). Bây giờ mỗi mốc tự lưu lựa chọn của mình. Script này
// ghi lại giá trị suy ra đó vào bản ghi để dữ liệu ổn định, thay vì chỉ suy ra
// lúc đọc.
//
//   node scripts/migrateNotificationTargetDays.js           # chỉ xem trước
//   node scripts/migrateNotificationTargetDays.js --apply   # ghi thật
//
// An toàn: chỉ thêm trường targetDayOffset. Không đổi id, MSSV, quyền sở hữu
// chat/user, trạng thái bật-tắt hay lịch sử gửi tin. Chạy lại không ghi thêm.
// ============================================================================
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const {
    getAllSubscriptions,
    normalizeNotificationTimes,
    migrateNotificationTargetDays
} = require("../subscriptions");

const apply = process.argv.includes("--apply");

function summarize() {
    const subscriptions = getAllSubscriptions();
    const rows = [];
    for (const [key, subscription] of Object.entries(subscriptions)) {
        const rawTimes = Array.isArray(subscription?.notificationTimes) ? subscription.notificationTimes : [];
        const missing = rawTimes.filter((raw) => raw?.targetDayOffset !== 0 && raw?.targetDayOffset !== 1).length;
        if (missing === 0) continue;
        const times = normalizeNotificationTimes(subscription);
        rows.push({
            key,
            chatId: subscription?.chatId ?? "(không rõ)",
            studentId: subscription?.studentId ?? "(không có MSSV)",
            times: times.map((item) => `#${item.id} ${item.time} -> ${item.targetDayOffset === 1 ? "homsau" : "homnay"}`)
        });
    }
    return { total: Object.keys(subscriptions).length, rows };
}

function main() {
    const before = summarize();
    console.log(`[Migrate] Tổng số đăng ký: ${before.total}`);
    console.log(`[Migrate] Số đăng ký cần di trú: ${before.rows.length}`);

    if (before.rows.length === 0) {
        console.log("[Migrate] Không có gì để làm. Mọi mốc đã có ngày đích.");
        return;
    }

    for (const row of before.rows) {
        console.log(`  - ${row.chatId} · ${row.studentId}: ${row.times.join(", ")}`);
    }

    if (!apply) {
        console.log("");
        console.log("[Migrate] DRY-RUN: chưa ghi gì. Chạy lại với --apply để ghi thật.");
        return;
    }

    const result = migrateNotificationTargetDays();
    console.log("");
    console.log(`[Migrate] Đã ghi: ${result.changedSubscriptions} đăng ký, ${result.migratedTimes} mốc.`);
    console.log("[Migrate] Kiểm tra lại: chạy script không có --apply, số cần di trú phải là 0.");
}

main();
