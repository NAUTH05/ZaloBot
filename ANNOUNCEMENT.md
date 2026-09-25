# Thông báo một lần sau khi đặt lại dữ liệu (ANNOUNCEMENT)

Tài liệu này mô tả cách gửi **một lần** thông báo xin lỗi tới danh sách liên hệ
trong `recovered-interactions.json` sau khi dữ liệu bot bị đặt lại — mà **KHÔNG**
khôi phục danh bạ cũ vào Firestore.

## Nhịp gửi: vì sao đợt đầu tiên hỏng và nay đã khác

Đợt gửi đầu tiên (`reset-2026-09`) kết thúc trong **~2 giây** với 196 người:
**31 thành công, 165 thất bại** — trong đó **136 lỗi 429** (quá nhiều yêu cầu),
**28 lỗi 422** vĩnh viễn, và một lỗi phiên ZCA
(`Không thể nhận tin nhắn từ bạn.`).

136 lỗi 429 KHÔNG phải 136 người hỏng: đó là hệ quả của việc bắn hết danh sách
trong vài giây. Từ nay `announcementPacing.js` áp nhịp **riêng cho từng nhà cung cấp**:

| Cơ chế | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `intervalMs` | **1200 ms** | Cách nhau tối thiểu giữa hai tin CÙNG một nhà cung cấp |
| Song song | **1 đích/nhà cung cấp** | Một tài khoản chỉ gửi một tin tại một thời điểm |
| 429 có `Retry-After` | theo máy chủ | Chờ đúng số giây Zalo yêu cầu |
| 429 không có `Retry-After` | 2000 ms × 2ⁿ, có nhiễu | Giãn cách tăng dần, kẹp trần **120 s** |
| Ngưỡng dừng | **3 lần 429 / 5 phút** | Vượt ngưỡng ⇒ **tạm dừng nhà cung cấp 10 phút** |

Ba hệ quả quan trọng:

1. **Một nhà cung cấp bị khoá tốc độ không làm chậm nhà cung cấp khác.** bot1 gặp
   429 thì bot2/bot3/ZCA vẫn chạy hết phần của mình trong cùng đợt.
2. **429 không bao giờ tạo vòng lặp nhanh.** Mỗi lần 429 đều phải chờ ít nhất bằng
   `intervalMs` trước khi thử đích kế tiếp, và 429 lặp lại thì **dừng hẳn nhà cung
   cấp đó** thay vì bắn nốt số còn lại.
3. **Phần bị dừng được ghi `deferred`, không phải `failed`.** Nghĩa là lần chạy tiếp
   sẽ thử lại — không có ai bị bỏ quên.

### Đặt nhịp khác đi (không bắt buộc)

Chỉ cần khi muốn nhanh hơn hoặc chậm hơn mặc định:

- **Cách 1 — biến môi trường (áp cho mọi đợt):** thêm vào `.env` rồi khởi động lại PM2:

  ```bash
  ANNOUNCE_SEND_INTERVAL_MS=2000
  ```

- **Cách 2 — theo từng lần gửi:** thêm `"intervalMs": 2000` vào thân request `send`
  (xem bước 2), hoặc cờ `--interval-ms 2000` khi chạy shell.

Nhịp **luôn bị kẹp về khoảng an toàn** (sàn 100 ms, trần 600 s), nên một giá trị sai
không thể biến thành "bắn không giới hạn".

## Vì sao phải là "một lần" và không nhập lại vào Firestore

Sau khi reset, Firestore phải **sạch**: không có liên hệ cũ, không có MSSV cũ,
không có đăng ký cũ. Nhập lại file khôi phục sẽ hồi sinh dữ liệu đã hỏng và phá
đúng trạng thái mà cổng tiếp nhận đang cố bảo vệ.

Vì vậy công cụ này đọc `recovered-interactions.json` như **dữ liệu đầu vào thuần
tuý**. Nó không bao giờ ghi vào `interactions`, `chatDirectory`, `subscriptions`
hay bất kỳ store nào. Tiến độ gửi được lưu trong một file checkpoint cục bộ
(`data/announcement-checkpoints/<campaign>.json`, đã được `.gitignore`).

Mã nguồn không hề `require` lớp lưu trữ — đây là bảo đảm ở mức cấu trúc, không
chỉ là quy ước. Một bài kiểm tra tự động cũng canh điều này.

## Điểm mấu chốt: GỬI THẬT phải chạy TRONG tiến trình PM2

Đây là điều dễ hiểu nhầm nhất, nên đọc kỹ trước khi làm.

- Lệnh shell **chỉ dùng để xem trước và xem báo cáo**. Hai việc này không cần nhà
  cung cấp nên chạy ở đâu cũng được.
- **Gửi thật phải chạy bên trong tiến trình đang chạy** (`main.js` trong PM2), vì
  chỉ tiến trình đó mới giữ nhà cung cấp — và phiên ZCA. Một tiến trình shell
  riêng **không bao giờ** chạm được tới registry của PM2.
- Đường kích hoạt đúng là **API quản trị** (bên dưới). Không có cờ `--in-process`
  nào — nếu thấy tài liệu cũ nhắc tới nó, đó là thông tin sai.

Vì sao không cho shell tự mở phiên Zalo: tài khoản ZCA giữ **khoá phiên độc quyền**.
Mở tiến trình thứ hai sẽ đá nhau và làm hỏng phiên đang đăng nhập — tức là làm
hỏng luôn khả năng gửi của bot chính.

## Triển khai bản sửa nhịp gửi lên VPS

Chạy **đúng theo thứ tự** dưới đây. Bước 1–4 không gửi tin nào.

```bash
cd /duong/dan/toi/ZaloBot

# 1. Lấy mã mới (nhánh dev) rồi cài phụ thuộc nếu package.json đổi.
git fetch origin dev
git checkout dev
git pull --ff-only origin dev

# 2. Kiểm tra cú pháp + toàn bộ bài kiểm tra. KHÔNG có tin nào được gửi ở bước này.
node --check main.js
node --check adminServer.js
node --check announcementPacing.js
node --check scripts/sendRecoveredAnnouncement.js
npm test

# 3. (Tuỳ chọn) chỉ đặt nhịp nếu muốn khác mặc định 1200 ms. Bỏ qua thì dùng mặc định.
grep -q '^ANNOUNCE_SEND_INTERVAL_MS=' .env || echo 'ANNOUNCE_SEND_INTERVAL_MS=1200' >> .env

# 4. Nạp lại tiến trình. BẮT BUỘC: phiên ZCA chỉ sống trong tiến trình này, nên phải
#    restart để mã mới có hiệu lực — nhưng KHÔNG được mở tiến trình thứ hai.
pm2 restart ecosystem.config.cjs --update-env
pm2 logs zalobot --lines 40

# 5. Xem trước: đối chiếu số người nhận và số CÒN PHẢI GỬI sau checkpoint cũ.
node scripts/sendRecoveredAnnouncement.js \
  --campaign reset-2026-09 \
  --message-file /tmp/announce.txt
```

> **Chờ dashboard sẵn sàng.** Sau `pm2 restart`, đợi tới khi log báo khởi động xong
> (~3 s bình thường). Gửi ngay khi ZCA chưa đăng nhập lại sẽ khiến các đích ZCA bị
> ghi "hoãn" — không mất gì, chỉ cần chạy lại bước resume sau.

## Chuẩn bị

1. Đặt file danh sách liên hệ ở gốc dự án:
   `recovered-interactions.json` (đã `.gitignore`).
2. Tạo file nội dung thông báo trên máy chủ, ví dụ `/tmp/announce.txt`:

   ```
   Xin lỗi các bạn, dữ liệu của bot vừa được đặt lại để khắc phục lỗi. Nếu trước đây bạn đã lưu MSSV hoặc đăng ký giờ nhận lịch, vui lòng thiết lập lại bằng /luumssv [MSSV] và /nhanlich hh:mm homnay|homsau. Cảm ơn các bạn đã thông cảm.
   ```

   Có thể đổi đường dẫn bằng biến `ANNOUNCEMENT_MESSAGE_FILE` (mặc định
   `/tmp/announce.txt`). Hoặc gửi thẳng nội dung trong thân request API.
3. Chắc chắn có `ADMIN_USERNAME` và `ADMIN_PASSWORD` trong `.env` để đăng nhập
   dashboard.

## Bước 1 — Xem trước (dry-run), chạy trên shell

```bash
cd /duong/dan/toi/ZaloBot

node scripts/sendRecoveredAnnouncement.js \
  --campaign reset-2026-09 \
  --message-file /tmp/announce.txt
```

In ra: số người nhận theo từng bot, số bản ghi trùng đã gộp, danh sách bản ghi bị
loại kèm lý do, vân tay nội dung, và số còn phải gửi sau khi trừ checkpoint cũ.
**Không in chatId/userId đầy đủ.**

Kết quả mong đợi với dữ liệu hiện có: **196 người nhận hợp lệ**
(bot1=104, bot2=59, bot3=26, ZCA=7) và **46 bản ghi bị loại** vì thiếu `botId`.

Sau đợt chạy đầu, **checkpoint đã có 31 người gửi thành công và 28 người lỗi vĩnh
viễn** (422) — nên số "còn phải gửi" sẽ nhỏ hơn 196. Đó là điều đúng: 31 người kia
**không bao giờ** bị gửi lại.

## Bước 2 — Gửi thật, qua API quản trị

Lấy cookie phiên admin (đăng nhập một lần):

```bash
curl -s -c /tmp/zalobot-cookie.txt \
  -X POST http://127.0.0.1:6003/zalobot/api/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"'"$ADMIN_USERNAME"'","password":"'"$ADMIN_PASSWORD"'"}'
```

Xem trước qua API (không gửi, không ghi) — nên chạy để đối chiếu với bước 1:

```bash
curl -s -b /tmp/zalobot-cookie.txt \
  'http://127.0.0.1:6003/zalobot/api/admin/announcement/preview?campaign=reset-2026-09'
```

Gửi thật. **Bắt buộc `"confirm": true`** — thiếu là bị từ chối 400:

```bash
curl -s -b /tmp/zalobot-cookie.txt \
  -X POST http://127.0.0.1:6003/zalobot/api/admin/announcement/send \
  -H 'Content-Type: application/json' \
  -d '{"campaign":"reset-2026-09","confirm":true}'
```

Muốn gửi nội dung khác với file trên máy chủ thì thêm `"message": "..."`.
Muốn chỉ định file khác thì thêm `"messageFile": "/duong/dan/khac.txt"`.

> **Chú ý về độ trễ.** Đợt gửi 196 tin chạy tuần tự qua hàng đợi của từng nhà cung
> cấp, nên request có thể kéo dài vài phút. Tiến độ được ghi xuống checkpoint sau
> **mỗi** tin, nên nếu kết nối bị đứt hay bạn dừng giữa chừng thì **không mất gì** —
> chỉ cần chạy lại với `"resume": true` (bước 3).

## Bước 3 — Chạy tiếp sau khi bị dừng

```bash
curl -s -b /tmp/zalobot-cookie.txt \
  -X POST http://127.0.0.1:6003/zalobot/api/admin/announcement/send \
  -H 'Content-Type: application/json' \
  -d '{"campaign":"reset-2026-09","confirm":true,"resume":true}'
```

Muốn đổi nhịp cho riêng lần chạy này thì thêm `"intervalMs": 2000`:

```bash
curl -s -b /tmp/zalobot-cookie.txt \
  -X POST http://127.0.0.1:6003/zalobot/api/admin/announcement/send \
  -H 'Content-Type: application/json' \
  -d '{"campaign":"reset-2026-09","confirm":true,"resume":true,"intervalMs":2000}'
```

Chạy tiếp sẽ **bỏ qua**:
- người đã gửi thành công (**31 người của đợt đầu — không bao giờ gửi lại**);
- người đã **thất bại vĩnh viễn** (410 chat không tồn tại, 422 không có quyền —
  **28 người của đợt đầu**) vì các lỗi này không bao giờ tự khỏi, thử lại chỉ tốn
  thời gian và có thể khiến tài khoản bị đánh dấu spam.

Chạy tiếp sẽ **thử lại**:
- người bị **429** ở đợt trước (136 lỗi);
- người bị **hoãn** vì nhà cung cấp đang tạm dừng hoặc phiên ZCA chưa sẵn sàng;
- người bị timeout / 5xx.

> **Quan trọng — nhà cung cấp đang tạm dừng.** Nếu lần chạy trước kết thúc với dòng
> `Nhà cung cấp đang tạm dừng vì 429: bot1, …`, thì chạy resume **ngay lập tức** sẽ
> chỉ ghi tiếp phần của nhà cung cấp đó là "hoãn" (không gửi). Đây là hành vi đúng:
> chờ hết thời gian tạm dừng (mặc định 10 phút — xem `resumeInMs` trong bước 4) rồi
> chạy lại bước này. Các nhà cung cấp KHÁC không bị ảnh hưởng và đã gửi xong trong
> lần chạy trước.

## Bước 4 — Xem tiến độ

Qua API (khuyến nghị khi bot đang chạy):

```bash
curl -s -b /tmp/zalobot-cookie.txt \
  'http://127.0.0.1:6003/zalobot/api/admin/announcement/status?campaign=reset-2026-09'
```

Hoặc trên shell — không cần nhà cung cấp:

```bash
node scripts/sendRecoveredAnnouncement.js --campaign reset-2026-09 --report
```

Cả hai đều in/trả: đã gửi · thất bại (kèm số vĩnh viễn) · hoãn (kèm số do 429) ·
vân tay nội dung · thời điểm cập nhật cuối · số đã gửi theo từng bot · **danh sách
nhà cung cấp đang tạm dừng vì 429**.

### Đọc báo cáo của đợt đầu

```
đã gửi: 31 · thất bại: 28 (vĩnh viễn: 28) · hoãn: 136 (429: 136)
```

- `31` — đã nhận tin. Sẽ không bao giờ bị gửi lại.
- `28` thất bại vĩnh viễn — 422 không có quyền. Sẽ không bao giờ được thử lại.
- `136` hoãn do 429 — **sẽ được thử lại** ở bước 3 (đây là chìa khoá: chúng nằm ở
  `deferred` chứ không phải `failed`).
- Lỗi `Không thể nhận tin nhắn từ bạn.` của ZCA: tuỳ cách phân loại mà nằm ở
  `failed` (tạm thời, không `permanent`) hoặc `deferred` — cả hai đều được thử lại
  ở bước 3; chỉ 410/422 mới bị bỏ qua vĩnh viễn.

## Vân tay nội dung: đổi nội dung thì phải đổi mã chiến dịch

Checkpoint lưu một **vân tay** gồm nội dung tin + danh sách người nhận. Nếu bạn
đổi nội dung thông báo mà **vẫn dùng lại `reset-2026-09`**, hệ thống sẽ **TỪ CHỐI
chạy** thay vì âm thầm bỏ qua những người đã nhận bản cũ.

Lý do: checkpoint khiến người đã nhận bản cũ bị coi là "xong", nên họ sẽ **không
bao giờ** nhận được bản mới — mà không có cảnh báo nào.

Cách xử lý: dùng **mã chiến dịch mới**, ví dụ `reset-2026-09-v2`. Chỉ xoá file
checkpoint khi bạn thực sự muốn gửi lại từ đầu.

## Tài khoản Zalo cá nhân (ZCA)

`recovered-interactions.json` có thể chứa đích thuộc tài khoản ZCA
(`"botId": "zca:<uid>"`). Nhờ gửi qua API quản trị, phần ZCA dùng chung phiên đang
đăng nhập của tiến trình chính — **không** mở phiên thứ hai, **không** định tuyến
ZCA qua bot khác.

Nếu phiên ZCA chưa đăng nhập khi gửi, các đích đó được báo là **hoãn**
(`deferred`), **không** phải "đã gửi". Đăng nhập ZCA rồi chạy lại bước 3 để gửi nốt.

## Bảo đảm an toàn

| Quy tắc | Cách thực hiện |
| --- | --- |
| Không ghi Firestore | Mã nguồn không hề `require` lớp lưu trữ; checkpoint là file cục bộ đã ignore |
| Gửi trong đúng tiến trình | Chỉ qua API quản trị, chạy bên trong `main.js` của PM2 |
| Không mở phiên ZCA thứ hai | Không có đường nào tự đăng nhập; thiếu phiên ⇒ báo hoãn |
| Không đoán chủ sở hữu | Bản ghi thiếu `botId` hoặc lệch khoá bị **loại** |
| Không rơi về bot1 | Định tuyến luôn theo `botId` khai báo |
| Nhịp riêng từng nhà cung cấp | `announcementPacing.js`; 1 đích/nhà cung cấp, cách nhau `intervalMs` |
| 429 không tạo vòng lặp nhanh | Luôn chờ ≥ `intervalMs` sau 429; vượt ngưỡng ⇒ **tạm dừng nhà cung cấp** |
| 429 được thử lại | Ghi `deferred`, không ghi `failed` — không ai bị bỏ quên |
| Khử trùng theo `(botId, chatId)` | Cùng Chat ID ở hai bot là hai người nhận |
| Lỗi 410/422 không thử lại | Bỏ qua **vĩnh viễn** ở mọi lần chạy tiếp, không đổi bot |
| Timeout xử lý thận trọng | Không coi là đã gửi → lần resume sau mới thử lại |
| Đổi nội dung không tái dùng mã | Vân tay lệch ⇒ từ chối chạy |
| Chỉ admin gửi được | Ba endpoint nằm sau `requireAdmin`; gửi cần `confirm: true` |
| Không rò rỉ danh tính | Log chỉ in số đếm và vân tay rút gọn |

## Sau khi gửi

Người dùng tự thiết lập lại bằng `/luumssv [MSSV]` và `/nhanlich hh:mm homnay|homsau`.
Các lệnh thường (`/thongbao`, `/update`) vẫn hoạt động bình thường cho **người
dùng mới đã được tiếp nhận** (đã có ít nhất một câu trả lời gửi thành công).
