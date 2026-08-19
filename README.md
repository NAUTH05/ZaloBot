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
OWNER_USER_ID=user_id_cua_chu_bot
FIREBASE_PROJECT_ID=zalobot-e98a3
FIREBASE_CLIENT_EMAIL=your-service-account@zalobot-e98a3.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n"
# FIREBASE_SERVICE_ACCOUNT_PATH=C:\\Work\\BOT\\ZaloBot\\firebase-service-account.json
# FIREBASE_DATABASE_ID=(default)
# FIREBASE_STATE_COLLECTION=bot_state
```

Để lấy `OWNER_USER_ID`, nhắn `/myid` cho bot rồi sao chép giá trị **User ID**. Có thể cấu hình nhiều chủ BOT bằng cách phân tách ID bằng dấu phẩy. Sau khi sửa `.env`, cần khởi động lại bot.

`CHAT_ID` cũ không còn được sử dụng. Mỗi cuộc trò chuyện dùng `/find [MSSV]` để lưu MSSV, sau đó dùng `/dangky` để chủ động bật thông báo.

Trong nhóm chat, dữ liệu được tách theo cặp `chat.id + from.id`, vì vậy mỗi thành viên có MSSV riêng. `/lich [MSSV]` và `/lichtuan [MSSV]` luôn dùng MSSV truyền trực tiếp, không thay đổi MSSV đã lưu của người gọi.

Các bản ghi `subscriptions.json` theo schema cũ chỉ có `chat.id` sẽ không được dùng sau khi cập nhật vì không thể xác định chủ sở hữu trong nhóm. Mỗi người cần chạy lại `/find [MSSV]`, sau đó `/dangky` nếu muốn nhận thông báo.

## Lệnh bot

- `/find [MSSV]`: kiểm tra và lưu MSSV, không tự bật thông báo.
- `/dangky [MSSV]`: bật thông báo bằng MSSV truyền trực tiếp; mặc định nhận lịch lúc 06:00.
- `/dangky`: đăng ký bằng MSSV đã lưu qua `/find`, giữ nguyên giờ đã chọn.
- `/dangky hh:mm`: thêm một giờ nhận lịch theo giờ Việt Nam (ví dụ `/dangky 05:30`).
- `/dangky [MSSV] hh:mm`: lưu MSSV và thêm một giờ tùy chọn trong cùng lệnh.
- `/danhsachdangky`: xem danh sách giờ đã đăng ký (ví dụ `/danhsachdangky`).
- `/suadangky #ID hh:mm`: sửa giờ theo ID (ví dụ `/suadangky #1 20:00`).
- `/xoadangky #ID`: xóa giờ theo ID (ví dụ `/xoadangky #1`).
- `/lich [MSSV]`: xem lịch học hôm nay.
- `/lich`: xem lịch của MSSV đã lưu.
- `/lichtuan [MSSV]`: xem lịch từ Thứ Hai đến Chủ nhật của tuần hiện tại.
- `/lichtuan`: xem lịch tuần của MSSV đã lưu.
- `/huythongbao`: tắt thông báo lịch học và cảnh báo thay đổi, vẫn giữ MSSV.
- `/time`: kiểm tra giờ Việt Nam mà bot đang dùng.
- `/myid`: xem User ID và Chat ID của người gửi.
- `/sinhnhat [câu hỏi]`: gửi câu hỏi trong ngày 27/08.
- `/lichtruc`: xem phân công lịch trực nhật phòng 411 hôm nay.
- `/themlichtruc [dd/mm] [Name 1 - Name 2]`: chủ BOT thêm một hoặc nhiều phân công lịch trực nhật phòng 411 (mỗi lịch một dòng).
- `/sualichtruc [ID/Ngày] [Nội dung mới]`: chủ BOT sửa phân công lịch trực nhật phòng 411.
- `/xoalichtruc [ID/Ngày]`: chủ BOT xóa phân công lịch trực nhật phòng 411.
- `/danhsachlichtruc`: chủ BOT xem danh sách lịch trực nhật phòng 411 đã phân công.
- `/danhsach [năm]`: chủ BOT xem danh sách câu hỏi; mặc định là năm hiện tại.
- `/them [câu hỏi]`: chủ BOT thêm câu hỏi thủ công.
- `/sua [ID] [câu hỏi mới]`: chủ BOT sửa nội dung câu hỏi.
- `/xoa [ID]`: chủ BOT xóa câu hỏi không phù hợp.
- `/traloi [ID] [câu trả lời]`: chủ BOT ghi hoặc cập nhật câu trả lời; phần trả lời có thể xuống dòng.
- `/congbo [năm]`: gửi toàn bộ câu đã trả lời tới mọi user/nhóm từng tương tác với bot.
- `/thongbao [nội dung]`: chủ BOT gửi thông báo cập nhật tới mọi user/nhóm từng tương tác với bot.
- `/help`: xem các lệnh thông thường và ví dụ.
- `/help411`: xem các lệnh trực nhật phòng 411.
- `/helpadmin`: chủ BOT xem toàn bộ lệnh, gồm cả lệnh quản trị.


Chạy kiểm thử bằng `npm test`.

## Hỏi đáp sinh nhật 27/08

Bot lưu mọi cuộc trò chuyện từng tương tác và dữ liệu hỏi đáp trong Firestore. Lúc `00:05` ngày 27/08 theo giờ Việt Nam, bot gửi lời mời hỏi đáp đến mỗi user/nhóm một lần. Nếu bot khởi động muộn hoặc một chat mới tương tác trong ngày, bot tự kiểm tra bù.

Quy trình dành cho chủ BOT:

1. Dùng `/danhsach` để lấy ID các câu hỏi.
2. Dùng `/traloi 12 Nội dung trả lời...` để trả lời câu `#12`; chạy lại cùng lệnh để sửa đáp án.
3. Dùng `/sua`, `/xoa` hoặc `/them` nếu cần làm sạch danh sách.
4. Dùng `/congbo` sau khi hoàn tất. Chỉ các câu đã có đáp án được gửi đi.

Bot ghi nhận dấu gửi theo nội dung. Chạy lại `/congbo` mà không thay đổi dữ liệu sẽ không gửi trùng; nếu câu hỏi hoặc đáp án đã thay đổi, bot sẽ gửi bản cập nhật.

Bot kiểm tra thay đổi lịch mỗi 15 phút theo `Asia/Ho_Chi_Minh`. Lịch học hằng ngày được gửi theo từng giờ trong danh sách đăng ký (mặc định `06:00`); scheduler chạy mỗi phút để phục vụ các mốc `hh:mm`.

## Firestore

Bot dùng Firebase Admin SDK để đọc/ghi state trong Firestore collection `bot_state`, với mỗi file JSON cũ tương ứng một document: `subscriptions`, `interactions`, `scheduleSnapshots`, `dutyScheduleData`, `birthdayData`, `accessControl`.

Trên VPS, cấu hình `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` và `FIREBASE_PRIVATE_KEY` trong `.env`. Trong `FIREBASE_PRIVATE_KEY`, các dòng PEM được nối bằng chuỗi `\n`. `FIREBASE_SERVICE_ACCOUNT_PATH` chỉ là phương án dự phòng tùy chọn. Chạy migration một lần:

```text
npm run migrate:firestore
```

Sau khi khởi động, bot hydrate state từ Firestore trước khi bật polling/scheduler và không ghi các file JSON local nữa. Thư mục `recent_json/` chỉ là nguồn migration, không phải nơi runtime ghi dữ liệu.

Mọi phản hồi của bot đều dùng rich text Markdown của Zalo Bot: có tiêu đề, phân cấp nội dung và màu theo trạng thái. Bot dùng bộ icon dạng text thống nhất (`[OK]`, `[!]`, `[X]`, `[+]`, `[-]`, `[*]`) thay cho emoji màu để hiển thị gọn và đồng nhất trên các thiết bị. Ngày trong lịch và thông báo thay đổi dùng định dạng `dd/mm/yyyy`. Bot đối chiếu buổi học bằng `NhomID` thay vì `ID` thứ tự để tránh báo nhầm hàng loạt khi nhà trường chèn hoặc xóa lịch.
