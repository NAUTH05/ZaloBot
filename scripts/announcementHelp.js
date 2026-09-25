#!/usr/bin/env node
// ============================================================================
// In ra các lệnh cần thiết để chạy đợt thông báo một-lần.
//
// Vì sao có file này: gửi thật KHÔNG thể chạy từ shell — phải đi qua API quản trị
// bên trong tiến trình PM2 (xem ANNOUNCEMENT.md). Việc dựng đúng lệnh curl, đúng
// cookie, đúng cổng khá dễ sai, nên in sẵn ra để dán.
//
// KHÔNG in mật khẩu. Chỉ in tên biến môi trường cần có.
// ============================================================================
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const { DEFAULT_SOURCE } = require("./sendRecoveredAnnouncement");

const CAMPAIGN = process.env.ANNOUNCEMENT_CAMPAIGN || "reset-2026-09";
const MESSAGE_FILE = process.env.ANNOUNCEMENT_MESSAGE_FILE || "/tmp/announce.txt";
const PORT = process.env.ADMIN_PORT || process.env.PORT || "6003";
const BASE = `http://127.0.0.1:${PORT}/zalobot/api/admin`;
const COOKIE = "/tmp/zalobot-admin-cookie.txt";

const lines = [];
const say = (text = "") => lines.push(text);

say("# Đợt thông báo một lần — các lệnh cần chạy");
say("# Chiến dịch: " + CAMPAIGN);
say("# Nguồn     : " + DEFAULT_SOURCE);
say("# Nội dung  : " + MESSAGE_FILE);
say();
say("# Chuẩn bị: cần ADMIN_USERNAME và ADMIN_PASSWORD trong .env (không in ra ở đây).");
say(`# Kiểm tra .env có đủ hai biến: ${process.env.ADMIN_USERNAME ? "ADMIN_USERNAME ✓" : "ADMIN_USERNAME ✗ THIẾU"} ${process.env.ADMIN_PASSWORD ? "ADMIN_PASSWORD ✓" : "ADMIN_PASSWORD ✗ THIẾU"}`);
say();
say("## Bước 1 — Xem trước trên shell (không gửi, không ghi)");
say(`node scripts/sendRecoveredAnnouncement.js --campaign ${CAMPAIGN} --message-file ${MESSAGE_FILE}`);
say();
say("## Bước 2 — Đăng nhập dashboard lấy cookie");
say(`curl -s -c ${COOKIE} \\`);
say(`  -X POST ${BASE}/auth/login \\`);
say(`  -H 'Content-Type: application/json' \\`);
say(`  -d '{"username":"'"$ADMIN_USERNAME"'","password":"'"$ADMIN_PASSWORD"'"}'`);
say();
say("## Bước 3 — Xem trước qua API (đối chiếu với bước 1)");
say(`curl -s -b ${COOKIE} '${BASE}/announcement/preview?campaign=${CAMPAIGN}'`);
say();
say("## Bước 4 — GỬI THẬT (bắt buộc confirm: true)");
say("# Chạy trong tiến trình PM2 nên có thể kéo dài vài phút với ~196 tin.");
say("# Tiến độ được ghi sau MỖI tin — đứt kết nối không mất gì.");
say(`curl -s -b ${COOKIE} \\`);
say(`  -X POST ${BASE}/announcement/send \\`);
say(`  -H 'Content-Type: application/json' \\`);
say(`  -d '{"campaign":"${CAMPAIGN}","confirm":true}'`);
say();
say("## Bước 5 — Chạy tiếp nếu bị dừng giữa chừng");
say("# Tự bỏ qua người đã gửi và người thất bại VĨNH VIỄN (410/422).");
say("# Người bị 429 / hoãn thì ĐƯỢC thử lại ở đây.");
say(`curl -s -b ${COOKIE} \\`);
say(`  -X POST ${BASE}/announcement/send \\`);
say(`  -H 'Content-Type: application/json' \\`);
say(`  -d '{"campaign":"${CAMPAIGN}","confirm":true,"resume":true}'`);
say();
say("# Thêm intervalMs nếu muốn nhịp khác mặc định (1200ms/đích):");
say(`curl -s -b ${COOKIE} \\`);
say(`  -X POST ${BASE}/announcement/send \\`);
say(`  -H 'Content-Type: application/json' \\`);
say(`  -d '{"campaign":"${CAMPAIGN}","confirm":true,"resume":true,"intervalMs":2000}'`);
say();
say("## Bước 6 — Xem tiến độ");
say(`curl -s -b ${COOKIE} '${BASE}/announcement/status?campaign=${CAMPAIGN}'`);
say("# Hoặc, không cần đăng nhập:");
say(`node scripts/sendRecoveredAnnouncement.js --campaign ${CAMPAIGN} --report`);
say();
say("## Lưu ý");
say("# - Đổi nội dung thông báo thì phải ĐỔI MÃ CHIẾN DỊCH (vân tay nội dung bị lệch).");
say("# - Không có cờ --in-process: gửi thật chỉ đi qua API ở bước 4.");
say("# - ZCA chưa đăng nhập ⇒ các đích ZCA báo 'hoãn', chạy lại bước 5 sau khi đăng nhập.");
say("# - Nhà cung cấp đang TẠM DỪNG vì 429 (xem dòng 'ĐANG TẠM DỪNG' ở bước 6): chờ hết");
say("#   thời gian tạm dừng rồi mới chạy bước 5, nếu không phần đó lại được ghi 'hoãn'.");
say("# - Nhịp gửi mặc định 1200ms/đích, 1 đích mỗi nhà cung cấp; sửa bằng");
say("#   ANNOUNCE_SEND_INTERVAL_MS trong .env hoặc intervalMs trong thân request.");

console.log(lines.join("\n"));
