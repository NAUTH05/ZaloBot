# Độ tin cậy gửi tin (ZCA)

Tài liệu vận hành cho kiến trúc gửi tin đi của ZaloBot, tập trung vào tài khoản
Zalo **cá nhân** (ZCA, qua `zca-js`).

> **Đọc trước:** không con số nhịp nào trong tài liệu này là hạn mức do Zalo công
> bố, và không con số nào **bảo đảm** tài khoản không bị siết. Chúng là điểm khởi
> đầu thận trọng để thử nghiệm có kiểm soát. Mục tiêu là **gửi tin đáng tin cậy**,
> không phải gửi nhanh nhất. Không có cơ chế nào trong dự án này nhằm né giới hạn
> của Zalo.

---

## 1. Sự cố mà kiến trúc này giải quyết

Báo cáo thật: `/thongbao` báo "đã gửi thành công 100+ người" nhưng rất nhiều người
không nhận được gì.

Ba nguyên nhân, cùng lúc:

1. **Ba cơ chế giới hạn chạy song song, không cái nào bao trùm mọi đường gửi.**
   - `sendPacing.js` chỉ áp dụng khi `feature` là `broadcast` hoặc `schedule`.
     Trả lời người dùng, tin chào, phản hồi đánh giá, tin thử của quản trị viên,
     ảnh và tệp **không** đi qua. Tệ hơn: trạng thái nhịp chỉ có **hai ô**
     (`official`/`zca`), nên hai tài khoản ZCA khác nhau dùng chung một nhịp —
     tài khoản này bị tạm dừng thì tài khoản kia cũng đứng.
   - `sendQueue.js` có trần song song ZCA mặc định **4**: bốn request có thể rời
     máy trong cùng một giây, nên "5 giây/tin" không có ý nghĩa.
   - `announcementPacing.js` chỉ dùng trong script thông báo một lần, và script đó
     gọi **thẳng** `provider.sendMessage` — đường duy nhất còn lọt qua mọi giới hạn.
2. **Thành công giả.** `zca-js` trả `{ message: null }` khi Zalo nhận yêu cầu mà
   **không tạo tin**. Phản hồi đó không ném lỗi, nên tầng gửi đếm là thành công.
3. **Đọc sai mã tin nhắn.** Mã tin nhắn của ZCA nằm ở `result.message.msgId`, còn
   tầng gửi chỉ đọc ba khoá phẳng (`message_id`/`messageId`/`msgId`). Hệ quả: tin
   gửi **thành công** qua ZCA luôn bị coi là "chưa xác nhận".

---

## 2. Kiến trúc hiện tại

`outboundLimiter.js` là **cửa vào duy nhất** cho mọi lần gửi đi.

```
sendMessage / sendPhoto / sendFile / script thông báo một lần
                       │
                       ▼
              outboundLimiter.enqueue(botId, task, priority, { recipientKey })
                       │
        ┌──────────────┴───────────────┐
        ▼                              ▼
  botId = zca:<uid>              botId = botN (chính thức)
  làn RIÊNG của tài khoản        hàng đợi cũ (sendQueue.js)
  • song song = 1                 • trần song song giữ nguyên
  • nhịp tối thiểu                • KHÔNG thừa hưởng nhịp ZCA
  • ưu tiên 3 mức
  • cầu dao riêng
```

Mỗi tài khoản ZCA có đúng **một làn**:

- **Song song = 1.** Không bao giờ có hai request cùng lúc cho một tài khoản.
- **Khoảng cách tối thiểu** giữa hai request **thật**, áp dụng cho mọi đường gửi,
  kể cả **từng đoạn** của tin dài.
- **Ưu tiên:** trả lời người dùng (0) > thông báo theo lịch (1) > hàng loạt (2).
- **Cầu dao riêng** cho từng tài khoản.

### Vì sao không `sleep()` trong worker đang giữ việc

Nếu lấy một việc ra khỏi hàng đợi rồi ngủ 10 giây, việc đó đã "chiếm chỗ": một câu
trả lời người dùng đến sau phải chờ đủ 10 giây dù ưu tiên cao hơn. Vòng bơm trong
`outboundLimiter.js` **ngủ trước rồi mới chọn việc**: sau mỗi lần chờ, nó chọn lại
việc ưu tiên cao nhất đang có. Khoảng cách luôn được tôn trọng, và việc gấp không
bị việc lớn chặn.

---

## 3. Trạng thái giao tin

Định nghĩa duy nhất ở `deliveryErrors.js` (`DELIVERY_STATE`).

| Trạng thái | Nghĩa | Hệ quả |
| --- | --- | --- |
| `sent_confirmed` | Zalo trả mã tin nhắn | Có bằng chứng tin đã được tạo. Không gửi lại. |
| `unconfirmed` | Yêu cầu xong nhưng **không** có mã tin nhắn | **Không** phải thành công. **Không** gửi lại ngay (tin gốc có thể vẫn xuất hiện). |
| `rate_limited` | 429 hoặc tương đương | Chuyện của tài khoản, không phải của người nhận. |
| `deferred` | Tài khoản đang tạm dừng/phục hồi | Chưa gửi. Lần chạy sau thử lại. |
| `recipient_error` | Mã 123: người này không nhận được tin từ tài khoản này | Không gửi lại liên tiếp vào đúng người đó. |
| `failed` | Hỏng thật (410/422, định dạng, hoặc hết lượt thử) | Không thử lại. |

### Mã 123 — "Không thể nhận tin nhắn từ bạn"

**Không** phải giới hạn tốc độ toàn tài khoản. Nó nói về **quan hệ giữa tài khoản
gửi và một người nhận cụ thể** (người kia chặn, hoặc Zalo tạm siết đúng cặp này).

- Một người nhận bị 123 ⇒ `recipient_error`. **Không** đánh dấu người đó hỏng vĩnh
  viễn, **không** tăng bộ đếm thất bại của chat.
- 123 lặp lại trên **nhiều người nhận khác nhau** trong cửa sổ ⇒ coi là dấu hiệu
  tài khoản bị siết ⇒ tạm dừng tài khoản đó.
- Mã và thông điệp gốc được giữ nguyên để chẩn đoán.

### Thiếu `msgId`

- Không bao giờ tính là đã gửi. Không tự sinh mã tin nhắn.
- Không gửi lại ngay.
- Ghi lại **hình dạng** phản hồi (`providerResponseShape`: tên khoá và kiểu dữ
  liệu) — không chép nội dung tin nhắn hay định danh người nhận.
- Thiếu `msgId` trên **nhiều người nhận khác nhau** ⇒ nghi tài khoản bị siết.
- Một lần lẻ **không** chứng minh người nhận hỏng vĩnh viễn.

### 429

- Tôn trọng `Retry-After` của máy chủ khi có (`retryAfterMs` trong phân loại lỗi).
- Không có thì giãn cách tăng dần có nhiễu, luôn kẹp trần.
- 429 lặp lại ⇒ tạm dừng tài khoản; phần còn lại của hàng đợi là `deferred`.

---

## 4. Cầu dao cấp tài khoản

Trạng thái: `normal` → `suspected` → `paused` → `cooldown_completed` → `normal`.

Khi chạm ngưỡng:

1. Dừng gửi tin mới từ tài khoản đó.
2. Toàn bộ việc **đang xếp hàng** của tài khoản đó được trả `deferred` — **không**
   phải `failed`.
3. Giữ nguyên danh tính và nội dung dự định của từng mục.
4. Ghi lý do, mốc thời gian, thời gian chờ dự kiến.
5. **Không** ảnh hưởng tài khoản ZCA khác hay bot chính thức.
6. **Không** tự tăng tốc sau khi hồi phục.
7. Yêu cầu phục hồi **có kiểm soát**: hết thời gian tạm dừng thì vào
   `cooldown_completed` — chỉ việc ưu tiên cao (trả lời người dùng, thông báo theo
   lịch) đi qua, việc **hàng loạt vẫn bị hoãn** cho tới khi có
   `ZCA_BREAKER_RECOVERY_SUCCESSES` lần gửi **có xác nhận** liên tiếp.

**Khởi động lại PM2 không xoá cooldown đang hiệu lực.** Trạng thái cầu dao được
lưu ở `data/zca-outbound-state.json` (đã nằm trong `.gitignore`), ghi nguyên tử
(tệp tạm → đổi tên). Tệp hỏng/không đọc được ⇒ bắt đầu lại từ trạng thái an toàn,
không làm hỏng tiến trình gửi tin. Tệp này **không** chứa cookie, mật khẩu hay bất
kỳ thông tin xác thực nào.

---

## 5. Cấu hình

Xem `.env.example` để có chú thích đầy đủ. Tóm tắt:

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `ZCA_OUTBOUND_INTERVAL_MS` | `10000` | Khoảng cách giữa hai lần gửi của cùng tài khoản |
| `ZCA_OUTBOUND_MIN_INTERVAL_MS` | `5000` | Sàn cứng — cấu hình sai cũng không nhanh hơn |
| `ZCA_OUTBOUND_CONCURRENCY` | `1` | **Bắt buộc 1**; giá trị khác bị từ chối |
| `ZCA_BREAKER_MAX_RATE_LIMITS` | `3` | Số lần 429 trong cửa sổ ⇒ tạm dừng |
| `ZCA_BREAKER_MAX_UNCONFIRMED` | `3` | Số **người nhận khác nhau** thiếu msgId ⇒ tạm dừng |
| `ZCA_BREAKER_MAX_RECIPIENT_ERRORS` | `5` | Số **người nhận khác nhau** bị mã 123 ⇒ tạm dừng |
| `ZCA_BREAKER_WINDOW_MS` | `300000` | Cửa sổ đếm |
| `ZCA_BREAKER_PAUSE_MS` | `600000` | Thời gian tạm dừng |
| `ZCA_BREAKER_RECOVERY_SUCCESSES` | `2` | Số lần gửi xác nhận để thoát giai đoạn phục hồi |
| `BROADCAST_ZCA_INTERVAL_MS` | `5000` | **Cũ.** Chỉ dùng khi `ZCA_OUTBOUND_INTERVAL_MS` trống |

**Thứ tự ưu tiên nhịp:** `ZCA_OUTBOUND_INTERVAL_MS` → `BROADCAST_ZCA_INTERVAL_MS`
→ `10000`, sau đó **luôn** kẹp về `[minIntervalMs, maxIntervalMs]`. Giá trị rác
(`abc`, `0`, số âm) ⇒ về mặc định, **không** thành 0.

`ZCA_SEND_CONCURRENCY` **không còn tác dụng với ZCA** (luôn song song 1). Bot chính
thức vẫn dùng `OFFICIAL_SEND_CONCURRENCY`.

---

## 6. Xem số liệu và chẩn đoán

### Qua API (sau `requireAdmin`)

```bash
GET  /zalobot/api/admin/outbound
POST /zalobot/api/admin/outbound   { "accountId": "zca:<uid>", "action": "resume" }
POST /zalobot/api/admin/outbound   { "accountId": "zca:<uid>", "action": "reset" }
```

`GET` trả, cho từng tài khoản: `state`, `paused`, `pausedUntil`, `pauseReason`,
`resumeInMs`, `queueLength`, `intervalMs`, `concurrency`, `confirmed`,
`unconfirmed`, `recipientErrors`, `rateLimited`, `deferred`, `failed`,
`lastConfirmedAt`, `lastRateLimitAt`, `recentSendCount`, `recentUniqueRecipients`.

Thiếu handler ⇒ **503** (fail closed), không trả bảng rỗng gây hiểu nhầm.
`action` phải là `resume` hoặc `reset`, và `accountId` phải là `zca:<uid>`.

### Qua dashboard

Tab **Logs & audit** có mục **"Nhịp gửi theo tài khoản ZCA"**. Nhật ký gửi tin
hiển thị badge theo **trạng thái** (`Đã xác nhận` / `Chưa xác nhận` /
`Bị giới hạn tốc độ` / `Hoãn` / `Người nhận không nhận được`), cộng nhịp và thời
gian request. Một tin **chưa xác nhận không bao giờ** hiện như thành công bình thường.

Nhật ký gửi tin nằm trong bộ nhớ (400 mục gần nhất) — **mất khi khởi động lại**.

### Phân biệt lỗi cấp người nhận và cấp tài khoản

| Dấu hiệu | Cấp |
| --- | --- |
| Một người nhận bị 123, những người khác vẫn nhận | Người nhận |
| 123 trên nhiều người nhận khác nhau trong cửa sổ | Tài khoản (nghi bị siết) |
| Một người nhận thiếu msgId | Chưa rõ — chỉ một lần chưa đủ kết luận |
| Thiếu msgId trên nhiều người nhận khác nhau | Tài khoản (nghi bị siết) |
| 429 | Tài khoản |
| 410 / 422 | Người nhận (vĩnh viễn) |

---

## 7. Thông báo theo lịch: hoãn và chạy tiếp

- Mỗi người nhận giữ trạng thái giao tin **riêng**.
- Giới hạn tốc độ **không** được ghi thành thất bại vĩnh viễn của một người dùng.
- Giao tin `deferred` **nhả chỗ giữ** (`dailyScheduleLedger`, `classStartNotifications`)
  để lần chạy sau trong cửa sổ thử lại.
- Giao tin **có xác nhận** được ghi để **không gửi trùng**.
- Giao tin **chưa xác nhận** cũng được ghi (chặn gửi trùng) nhưng kèm
  `confirmed: false` — người vận hành thấy rõ là **không có bằng chứng**.
- Chỗ giữ có **hạn 3 phút**: tiến trình chết giữa lúc gửi không làm người dùng mất
  thông báo cả ngày.
- Khóa chống trùng gồm `botId`, `chatId`, `studentId`, mốc giờ, ngày đích, ngày —
  nên hai lượt chạy chồng nhau, hoặc một lần restart, không tạo tin trùng.

---

## 8. Kiểm tra an toàn trên nhóm nhỏ

**Không** thử bằng `/thongbao` cho toàn bộ người dùng.

1. Dùng **một** tài khoản ZCA và **một** chat riêng của chính bạn.
2. Gửi tin thử qua dashboard: tab Chat Center, hoặc `adminTestChat`.
3. Xem `GET /api/admin/outbound` sau mỗi lần gửi:
   - `confirmed` tăng ⇒ Zalo có tạo tin.
   - `unconfirmed` tăng ⇒ **dừng lại**. Đừng gửi tiếp. Kiểm tra tài khoản.
4. Chỉ khi vài lần gửi liên tiếp đều `confirmed`, mới mở rộng dần: 5 người, 20
   người, rồi mới tới nhóm lớn.
5. Nếu `state` chuyển `paused`: đọc `pauseReason`, xử lý nguyên nhân, rồi
   `POST action: "resume"`. Nhịp **không** tăng lên sau khi resume.

Với thông báo cho số đông, **dùng bot chính thức**. Zalo siết gửi hàng loạt từ tài
khoản cá nhân mạnh hơn nhiều.

---

## 9. Checklist triển khai

1. **Sao lưu** dữ liệu và cấu hình: `data/`, các `*.json` ở gốc dự án, `.env`.
2. **Kéo mã**: `git pull` trên nhánh `dev`.
3. **Kiểm cú pháp**:
   ```bash
   node --check main.js
   node --check outboundLimiter.js
   node --check deliveryErrors.js
   node --check adminServer.js
   ```
4. **Chạy toàn bộ kiểm thử**:
   ```bash
   npm test && npm run build:admin
   ```
5. **Rà cấu hình mới** trong `.env` (xem mục 5). Giữ nguyên giá trị mặc định cho
   lần triển khai đầu.
6. **Chỉ khởi động lại PM2 khi đã sẵn sàng**:
   ```bash
   pm2 restart zalobot --update-env
   ```
7. **Xác nhận ZCA kết nối lại** (log khởi động, `GET /api/admin/bots`).
8. **Gửi thử có kiểm soát** tới một chat của chính bạn (mục 8).
9. **Xem nhật ký gửi tin và số liệu tài khoản** trên dashboard.

> Không triển khai lên VPS sản xuất, không sửa `.env` sản xuất, không restart PM2
> và không gửi thông báo thật như một phần của việc sửa mã nguồn.

---

## 10. Giới hạn đã biết

- **Không có hạn mức nào được Zalo công bố.** 10 giây/tin là điểm khởi đầu thận
  trọng, không phải bảo đảm.
- `zca-js` có thể đổi cấu trúc phản hồi. `providerResponseShape` giúp phát hiện
  điều đó, nhưng việc phân loại vẫn dựa trên `message.msgId` / `attachment[].msgId`.
- Nhật ký gửi tin và số liệu đếm **mất khi khởi động lại**; chỉ trạng thái cầu dao
  được lưu.
- Giai đoạn phục hồi cần lưu lượng ưu tiên cao (trả lời người dùng, thông báo theo
  lịch) để thoát. Nếu tài khoản chỉ dùng cho hàng loạt, quản trị viên phải
  `resume` thủ công.
- Một tin đã `unconfirmed` **không** được gửi lại tự động. Nếu người dùng báo không
  nhận được, phải gửi lại thủ công có chủ đích.
