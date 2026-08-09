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

`CHAT_ID` cũ không còn được sử dụng. Mỗi cuộc trò chuyện dùng `/find [MSSV]` để lưu MSSV vào `subscriptions.json` và bật thông báo lúc 06:00 hằng ngày.

## Lệnh bot

- `/find [MSSV]`: kiểm tra, lưu MSSV và bật thông báo.
- `/lich [MSSV]`: xem lịch học hôm nay.
- `/lich`: xem lịch của MSSV đã lưu.
- `/huythongbao`: tắt thông báo.
- `/time`: kiểm tra giờ Việt Nam mà bot đang dùng.
- `/help`: xem hướng dẫn.

Chạy kiểm thử bằng `npm test`.
