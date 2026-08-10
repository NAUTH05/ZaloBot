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

Trong nhóm chat, dữ liệu được tách theo cặp `chat.id + from.id`, vì vậy mỗi thành viên có MSSV riêng. `/lich [MSSV]` và `/lichtuan [MSSV]` luôn dùng MSSV truyền trực tiếp, không thay đổi MSSV đã lưu của người gọi.

Các bản ghi `subscriptions.json` theo schema cũ chỉ có `chat.id` sẽ không được dùng sau khi cập nhật vì không thể xác định chủ sở hữu trong nhóm. Mỗi người cần chạy lại `/find [MSSV]`, sau đó `/dangky` nếu muốn nhận thông báo.

## Lệnh bot

- `/find [MSSV]`: kiểm tra và lưu MSSV, không tự bật thông báo.
- `/dangky [MSSV]`: đăng ký kiểm tra 01:00, xác nhận thay đổi và nhận lịch lúc 06:00.
- `/dangky`: đăng ký bằng MSSV đã lưu qua `/find`.
- `/lich [MSSV]`: xem lịch học hôm nay.
- `/lich`: xem lịch của MSSV đã lưu.
- `/lichtuan [MSSV]`: xem lịch từ Thứ Hai đến Chủ nhật của tuần hiện tại.
- `/lichtuan`: xem lịch tuần của MSSV đã lưu.
- `/huythongbao`: tắt kiểm tra 01:00, lịch 06:00 và cảnh báo thay đổi, vẫn giữ MSSV.
- `/time`: kiểm tra giờ Việt Nam mà bot đang dùng.
- `/help`: xem hướng dẫn.

Chạy kiểm thử bằng `npm test`.

Bot chỉ kiểm tra thay đổi hai lần mỗi ngày theo `Asia/Ho_Chi_Minh`: lúc `01:00` bot chụp lịch lần 1 nhưng không gửi tin; lúc `06:00` bot tải lại lần 2, chỉ cảnh báo nếu kết quả giống bản chụp 01:00 rồi gửi lịch hôm nay. Mốc so sánh được lưu trong `scheduleSnapshots.json` và không được commit lên Git.

Mọi phản hồi của bot đều dùng rich text Markdown của Zalo Bot: có tiêu đề, phân cấp nội dung và màu theo trạng thái. Ngày trong lịch và thông báo thay đổi dùng định dạng `dd/mm/yyyy`. Bot đối chiếu buổi học bằng `NhomID` thay vì `ID` thứ tự để tránh báo nhầm hàng loạt khi nhà trường chèn hoặc xóa lịch.
