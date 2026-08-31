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

Danh sách đầy đủ biến môi trường có trong [`.env.example`](.env.example). File `.env` thật không commit lên Git vì chứa token và private key.

Để lấy `OWNER_USER_ID`, nhắn `/myid` cho bot rồi sao chép giá trị **User ID**. Có thể cấu hình nhiều chủ BOT bằng cách phân tách ID bằng dấu phẩy. Sau khi sửa `.env`, cần khởi động lại bot.

`CHAT_ID` cũ không còn được sử dụng. Mỗi cuộc trò chuyện dùng `/find [MSSV]` để lưu MSSV, sau đó dùng `/dangky` để chủ động bật thông báo.

Trong nhóm chat, dữ liệu được tách theo cặp `chat.id + from.id`, vì vậy mỗi thành viên có MSSV riêng. `/lich [MSSV]` và `/lichtuan [MSSV]` luôn dùng MSSV truyền trực tiếp, không thay đổi MSSV đã lưu của người gọi.

Các bản ghi `subscriptions.json` theo schema cũ chỉ có `chat.id` sẽ không được dùng sau khi cập nhật vì không thể xác định chủ sở hữu trong nhóm. Mỗi người cần chạy lại `/find [MSSV]`, sau đó `/dangky` nếu muốn nhận thông báo.

## Lệnh bot

- `/find [MSSV]`: kiểm tra và lưu MSSV cho người dùng trong cuộc trò chuyện hiện tại; không tự bật thông báo.
- `/lich [MSSV]`: xem lịch học hôm nay. Bỏ MSSV để dùng mã đã lưu.
- `/lichtuan [MSSV]`: xem lịch học từ Thứ Hai đến Chủ nhật. Bỏ MSSV để dùng mã đã lưu.
- `/lichthi [MSSV]`: xem lịch thi trong học kỳ.
- `/lichgv [Tên giảng viên]`: xem lịch dạy của giảng viên.
- `/phongtrong [Cơ sở]`: xem gợi ý phòng trống hôm nay.
- `/ai [Câu hỏi]`: hỏi trợ lý AI về lịch học đã lưu.
- `/dangky [hh:mm]`: bật nhận lịch học tự động vào giờ Việt Nam đã chọn; mặc định `06:00`.
- `/dangky [MSSV] [hh:mm]`: lưu MSSV và bật giờ nhận lịch trong cùng lệnh.
- `/danhsachdangky`: xem các giờ nhận lịch hiện có.
- `/suadangky #ID hh:mm`: sửa một giờ nhận lịch.
- `/xoadangky #ID`: xóa một giờ nhận lịch; nếu hết giờ, nhận lịch tự động sẽ tắt.
- `/huythongbao`: tắt nhận lịch học tự động và cảnh báo thay đổi, vẫn giữ MSSV.
- `/batnhaclich`: bật nhắc giờ học kèm đầy đủ môn, thời gian, phòng/cơ sở, giảng viên, nhóm, hình thức và link trực tuyến nếu có.
- `/tatnhaclich`: tắt riêng nhắc giờ học, không ảnh hưởng `/dangky`.
- `/trangthainhaclich`: xem trạng thái nhắc giờ học của người dùng trong cuộc trò chuyện hiện tại.
- `/lichtruc`, `/danhsachlichtruc`: xem lịch trực nhật phòng 411.
- `/dangkylich`, `/huydangkylich`: bật hoặc tắt thông báo lịch trực lúc `06:00`.
- `/sinhnhat [câu hỏi]`: gửi câu hỏi trong ngày 27/08.
- `/time`, `/myid`: xem giờ Việt Nam hoặc ID của tài khoản/chat.
- `/help`, `/help411`: xem hướng dẫn lệnh thường hoặc lịch trực.
- `/helpadmin`: chủ bot xem các lệnh quản trị.

Các lệnh quản trị hiện có vẫn được giữ nguyên: quản lý phân quyền, chat, lịch trực, hỏi đáp sinh nhật, thông báo chung và kiểm tra gửi. Xem `/helpadmin` để có danh sách theo nhóm.


Chạy kiểm thử bằng `npm test`.

## Hỏi đáp sinh nhật 27/08

Bot lưu mọi cuộc trò chuyện từng tương tác và dữ liệu hỏi đáp trong Firestore. Lúc `00:05` ngày 27/08 theo giờ Việt Nam, bot gửi lời mời hỏi đáp đến mỗi user/nhóm một lần. Nếu bot khởi động muộn hoặc một chat mới tương tác trong ngày, bot tự kiểm tra bù.

Quy trình dành cho chủ BOT:

1. Dùng `/danhsach` để lấy ID các câu hỏi.
2. Dùng `/traloi 12 Nội dung trả lời...` để trả lời câu `#12`; chạy lại cùng lệnh để sửa đáp án.
3. Dùng `/sua`, `/xoa` hoặc `/them` nếu cần làm sạch danh sách.
4. Dùng `/congbo` sau khi hoàn tất. Chỉ các câu đã có đáp án được gửi đi.

Dấu gửi được ghi nhận theo nội dung. Chạy lại `/congbo` mà không thay đổi dữ liệu sẽ không gửi trùng; nếu câu hỏi hoặc đáp án thay đổi, bản cập nhật mới sẽ được gửi.

Bot kiểm tra thay đổi lịch mỗi 15 phút theo `Asia/Ho_Chi_Minh`. Lịch học hằng ngày được gửi theo từng giờ trong danh sách đăng ký (mặc định `06:00`); scheduler đối chiếu mốc `hh:mm` mỗi phút nhưng bỏ qua im lặng nếu không có đăng ký khớp giờ, không tạo log hay flush dữ liệu thừa.

Nhắc giờ học là tính năng độc lập và mặc định tắt với mọi subscription hiện có. Người dùng có thể bật nhận lịch hằng ngày, nhắc giờ học, cả hai hoặc không bật tính năng nào. Scheduler trung tâm chạy mỗi phút, nhóm subscription theo MSSV và tải lại lịch ngay trước khi gửi để tránh nhắc một buổi đã hủy hoặc đổi giờ. Các buổi có cùng thời điểm bắt đầu được gộp trong một tin; các thời điểm khác nhau vẫn tách riêng.

Mỗi buổi được ghi vào store `classStartNotifications` bằng khóa ổn định gồm subscription, MSSV, ngày, giờ bắt đầu và định danh buổi học; vì vậy restart bot/VPS hoặc tick lặp không gửi trùng. Mặc định bot chấp nhận độ trễ tối đa 2 phút (`CLASS_START_GRACE_MS=120000`) và không gửi bù các buổi đã bắt đầu quá lâu. `CLASS_START_CACHE_TTL_MS` là giới hạn cache cấu hình, nhưng runtime tự giới hạn bucket hiệu lực tối đa 60 giây và không quá nửa grace window để không bỏ lỡ lịch vừa đổi giờ.

Ngày lịch được xác định bằng policy theo cửa sổ thời gian: thông báo từ `00:00` đến trước `20:00` gửi lịch hôm nay, còn từ `20:00` đến `23:59` gửi lịch ngày mai. Policy nằm riêng trong `scheduleDatePolicy.js` để có thể thêm loại thông báo hoặc khung giờ mới mà không phải thêm điều kiện đặc biệt vào scheduler. Ngày không có lớp và cuối tuần vẫn được gửi với trạng thái không có lịch học.

## Firestore

Bot dùng Firebase Admin SDK để đọc/ghi state trong Firestore collection `bot_state`, với mỗi file JSON cũ tương ứng một document: `subscriptions`, `classStartNotifications`, `interactions`, `scheduleSnapshots`, `dutyScheduleData`, `birthdayData`, `accessControl`, `chatDirectory`, `adminAudit`, `adminLogs`, `adminSettings`.

`chatDirectory` là cổng kiểm soát chung cho mọi tác vụ gửi. Lỗi vĩnh viễn `EZALO 410 The chat_id is invalid` làm chat chuyển ngay sang `inactive`; lỗi tạm thời chỉ chuyển trạng thái sau số lần liên tiếp cấu hình bởi `CHAT_MAX_CONSECUTIVE_FAILURES` (mặc định `3`). Dữ liệu cũ được giữ để admin xem và kích hoạt lại.

## Admin Dashboard

The owner dashboard is served by the bot at `/zalobot` on `127.0.0.1:${ADMIN_PORT}` (default `6003`). Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_PORT`, and `ADMIN_BASE_PATH` in `.env`. It uses an HttpOnly Secure session cookie and exposes only authenticated `/zalobot/api/admin/*` endpoints.

For CloudPanel/Nginx, proxy the subpath without adding it twice:

```nginx
location = /zalobot { return 301 /zalobot/; }
location /zalobot/ {
    proxy_pass http://127.0.0.1:6003/zalobot/;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Keep the existing `location /lythuyet` block unchanged. The dashboard does not use WebSockets; if live push is added later, preserve the existing Upgrade and Connection headers.

Dashboard có phần **Add or update chat** để bổ sung/sửa `chatId`, `userId`, tên và loại `private`/`group`. Bản ghi cũ có type `unknown` được tự bổ sung từ sổ tương tác nếu bot đã từng nhận tin từ chat đó. Xóa thông thường là xóa mềm; xóa vĩnh viễn cần xác nhận riêng.

Phần **Admin identities** lưu `userId`/`chatId` quản trị trong Firestore store `adminSettings` và gộp chúng với `OWNER_USER_ID`/`OWNER_CHAT_ID`. **Command console** gọi trực tiếp `handleCommand` hiện có, nên có thể thực thi các lệnh bot bằng một admin context đã được cấp quyền mà không nhân đôi business logic.

Dashboard được chia thành các tab: tổng quan, chat directory, users & MSSV, groups, đăng ký nhận lịch, lịch trực, chat health, command console, settings và logs/audit. Theme mặc định là dark xanh dương sáng, có nút chuyển light theme. Admin có thể thêm/sửa/xóa member theo từng chat, chỉnh trạng thái, make admin, quản lý subscription và xem thời điểm tạo/cập nhật từng giờ nhận lịch. API `/zalobot/api/admin/workspace` hợp nhất user, chat/group, MSSV, từng giờ đăng ký, lịch trực và access control nhưng vẫn giữ backend bot là nguồn dữ liệu thật.

Trên VPS, cấu hình `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` và `FIREBASE_PRIVATE_KEY` trong `.env`. Trong `FIREBASE_PRIVATE_KEY`, các dòng PEM được nối bằng chuỗi `\n`. `FIREBASE_SERVICE_ACCOUNT_PATH` chỉ là phương án dự phòng tùy chọn. Chạy migration một lần:

```text
npm run migrate:firestore
```

Sau khi khởi động, bot hydrate state từ Firestore trước khi bật polling/scheduler và không ghi các file JSON local nữa. Thư mục `recent_json/` chỉ là nguồn migration, không phải nơi runtime ghi dữ liệu.

Phản hồi dùng rich text Markdown của Zalo Bot với tiêu đề, nhấn mạnh và màu trạng thái nhất quán. Thành công dùng `✓`, cảnh báo dùng `⚠`, lỗi dùng `✕`; tiêu đề lịch và nhắc giờ dùng nhãn chức năng thay vì các tiền tố kỹ thuật. Dữ liệu từ LHU và hồ sơ Zalo được escape trước khi chèn vào rich text. Ngày dùng định dạng `dd/mm/yyyy`. Bot đối chiếu buổi học bằng `NhomID` thay vì `ID` thứ tự để tránh báo nhầm hàng loạt khi nhà trường chèn hoặc xóa lịch.
