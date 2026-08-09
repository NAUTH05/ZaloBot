# ZaloBOT lịch học LHU

Bot lấy dữ liệu trực tiếp từ trang lịch sinh viên của Đại học Lạc Hồng và gửi lịch theo múi giờ `Asia/Ho_Chi_Minh`.

## Cài đặt và chạy

```bash
npm install
npm start
```

File `.env` cần có:

```env
BOT_TOKEN=token_zalo_bot
DISCORD_WEBHOOK=webhook_tuy_chon
```

`CHAT_ID` cũ không còn được sử dụng. Mỗi cuộc trò chuyện dùng `/find [MSSV]` để lưu MSSV, sau đó dùng `/dangky` để chủ động bật thông báo.

## Lệnh bot

- `/find [MSSV]`: kiểm tra và lưu MSSV, không tự bật thông báo.
- `/dangky [MSSV]`: đăng ký lịch 06:00 và cảnh báo khi lịch thay đổi.
- `/dangky`: đăng ký bằng MSSV đã lưu qua `/find`.
- `/lich [MSSV]`: xem lịch học hôm nay.
- `/lich`: xem lịch của MSSV đã lưu.
- `/huythongbao`: tắt lịch 06:00 và cảnh báo thay đổi, vẫn giữ MSSV.
- `/time`: kiểm tra giờ Việt Nam mà bot đang dùng.
- `/help`: xem hướng dẫn.

Chạy kiểm thử bằng `npm test`.

Bot kiểm tra thay đổi vào phút `05, 20, 35, 50` mỗi giờ theo `Asia/Ho_Chi_Minh`. Lịch mới phải xuất hiện giống nhau trong hai lần kiểm tra liên tiếp trước khi bot gửi cảnh báo, nhằm tránh báo giả khi API LHU tạm thời trả thiếu dữ liệu. Mốc so sánh được lưu trong `scheduleSnapshots.json` và không được commit lên Git.
