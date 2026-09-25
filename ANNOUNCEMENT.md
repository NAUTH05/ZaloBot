# Thông báo một lần sau khi đặt lại dữ liệu (ANNOUNCEMENT)

Tài liệu này mô tả cách gửi **một lần** thông báo xin lỗi tới danh sách liên hệ
trong `recovered-interactions.json` sau khi dữ liệu bot bị đặt lại — mà **KHÔNG**
khôi phục danh bạ cũ vào Firestore.

## Vì sao phải là "một lần" và không nhập lại vào Firestore

Sau khi reset, Firestore phải **sạch**: không có liên hệ cũ, không có MSSV cũ,
không có đăng ký cũ. Nhập lại file khôi phục sẽ hồi sinh dữ liệu đã hỏng và phá
đúng trạng thái mà cổng tiếp nhận đang cố bảo vệ.

Vì vậy công cụ này đọc `recovered-interactions.json` như **dữ liệu đầu vào thuần
tuý**. Nó không bao giờ ghi vào `interactions`, `chatDirectory`, `subscriptions`
hay bất kỳ store nào. Tiến độ gửi được lưu trong một file checkpoint cục bộ
(`data/announcement-checkpoints/<campaign>.json`, đã được `.gitignore`).

## Chuẩn bị

1. Đặt file danh sách liên hệ ở gốc dự án:
   `C:\Work\BOT\ZaloBot\recovered-interactions.json` (đã `.gitignore`).
2. Tạo file nội dung thông báo, ví dụ `/tmp/announce.txt`:

   ```
   Xin lỗi các bạn, dữ liệu của bot vừa được đặt lại để khắc phục lỗi. Nếu trước đây bạn đã lưu MSSV hoặc đăng ký giờ nhận lịch, vui lòng thiết lập lại bằng /luumssv [MSSV] và /nhanlich hh:mm homnay|homsau. Cảm ơn các bạn đã thông cảm.
   ```

## Các lệnh (chạy trên VPS, trong thư mục dự án)

### 1. Xem trước (dry-run) — KHÔNG gửi, KHÔNG ghi

```bash
node scripts/sendRecoveredAnnouncement.js \
  --campaign reset-2026-09 \
  --message-file /tmp/announce.txt
```

Kết quả in ra: số người nhận theo từng bot, số bản ghi trùng đã gộp, danh sách
bản ghi bị loại kèm lý do, và số còn phải gửi sau khi trừ checkpoint cũ.
**Không in chatId/userId đầy đủ.**

### 2. Gửi thật

```bash
node scripts/sendRecoveredAnnouncement.js \
  --campaign reset-2026-09 \
  --message-file /tmp/announce.txt \
  --send
```

`--send` chỉ gửi cho những người **chưa** có trong checkpoint. Sau **mỗi** tin,
tiến độ được ghi ngay xuống checkpoint (ghi nguyên tử) — dừng đột ngột không mất
tiến độ và không gửi trùng.

### 3. Chạy tiếp sau khi bị dừng

Chạy lại **đúng lệnh của bước 2**. Những người đã gửi thành công sẽ tự bị bỏ qua:

```bash
node scripts/sendRecoveredAnnouncement.js \
  --campaign reset-2026-09 \
  --message-file /tmp/announce.txt \
  --send --resume
```

`--resume` hiện là bí danh của hành vi mặc định (checkpoint luôn được tôn trọng).

### 4. Xem báo cáo tiến độ

```bash
node scripts/sendRecoveredAnnouncement.js --campaign reset-2026-09 --report
```

In ra: đã gửi / thất bại / hoãn, thời điểm cập nhật cuối, và số đã gửi theo bot.

## Tài khoản Zalo cá nhân (ZCA)

`recovered-interactions.json` có thể chứa đích thuộc tài khoản ZCA
(`"botId": "zca:<uid>"`). ZCA giữ **khoá phiên độc quyền**: mở tiến trình thứ hai
sẽ đá nhau và làm hỏng phiên đang dùng.

Vì vậy phần ZCA **chỉ gửi được trong tiến trình chính đang chạy**. Gọi hàm đã
được phơi ra từ `main.js`:

```js
const { runRecoveredAnnouncement } = require("./main");
await runRecoveredAnnouncement([
  "--campaign", "reset-2026-09",
  "--message-file", "/tmp/announce.txt",
  "--send"
]);
```

Nếu chạy script độc lập mà không có registry nhà cung cấp, các đích ZCA được báo
là **hoãn** (`deferred`), **không** phải "đã gửi". Chạy lại từ tiến trình chính
để gửi nốt.

## Bảo đảm an toàn

| Quy tắc | Cách thực hiện |
| --- | --- |
| Không ghi Firestore | Chỉ đọc file nguồn; checkpoint là file cục bộ đã ignore |
| Không đoán chủ sở hữu | Bản ghi thiếu `botId` hoặc lệch khoá bị **loại** |
| Không rơi về bot1 | Định tuyến luôn theo `botId` khai báo |
| Khử trùng theo `(botId, chatId)` | Cùng Chat ID ở hai bot là hai người nhận |
| Lỗi 410/422 không thử lại | Bỏ qua vĩnh viễn, **không** đổi bot |
| Timeout xử lý thận trọng | Không coi là đã gửi → lần `--resume` sau mới thử lại |
| Không rò rỉ danh tính | Log chỉ in số đếm và vân tay rút gọn |

## Sau khi gửi

Người dùng tự thiết lập lại bằng `/luumssv [MSSV]` và `/nhanlich hh:mm homnay|homsau`.
Các lệnh thường (`/thongbao`, `/update`) vẫn hoạt động bình thường cho **người
dùng mới đã được tiếp nhận** (đã có ít nhất một câu trả lời gửi thành công).
