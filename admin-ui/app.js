const base = new URL(document.baseURI).pathname.replace(/\/$/, "");
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[char]));
let workspace = null;
let dashboard = null;
let logs = null;
let settings = null;
// Trạng thái tạm dừng trợ lý AI (toàn cục + từng cuộc trò chuyện). Đọc từ
// /api/admin/ai-pause; mọi thay đổi đều đi qua máy chủ, giao diện không tự đoán.
let aiPause = { global: { paused: false, active: false }, chats: [], anyActive: false };
let aiPauseBusy = false;
let commandRegistry = [];
let bots = [];
let targetUsers = [];
let targetUserMatches = [];
let targetUserActiveIndex = -1;
const TARGET_USER_LIMIT = 50;
const pageState = {};
const PAGE_SIZES = [10, 20, 25, 50, 100];
function pageSize() { return Number(settings?.defaultPageSize) || 25; }
function paginate(items, key) {
  const size = pageState[key]?.size || pageSize(); const totalPages = items.length ? Math.ceil(items.length / size) : 0;
  const page = totalPages ? Math.min(Math.max(pageState[key]?.page || 1, 1), totalPages) : 1;
  pageState[key] = { page, size }; return { rows: items.slice((page - 1) * size, page * size), totalPages, page, size, total: items.length };
}
function pager(targetId, key, result, rerender) {
  const target = $(targetId); if (!target) return;
  if (!result.total) { target.innerHTML = ""; return; }
  const pages = Array.from({ length: result.totalPages }, (_, i) => i + 1).filter((p) => p === 1 || p === result.totalPages || Math.abs(p - result.page) <= 2);
  target.innerHTML = `<div class="pagination" role="navigation" aria-label="Pagination"><span>Showing ${((result.page - 1) * result.size) + 1}-${Math.min(result.page * result.size, result.total)} of ${result.total}</span><label>Rows per page: <select data-page-size aria-label="Rows per page">${PAGE_SIZES.map((n) => `<option value="${n}" ${n === result.size ? "selected" : ""}>${n}</option>`).join("")}</select></label><button data-page="1" aria-label="First page" ${result.page === 1 ? "disabled" : ""}>«</button><button data-page="${result.page - 1}" aria-label="Previous page" ${result.page === 1 ? "disabled" : ""}>‹</button>${pages.map((p) => `<button data-page="${p}" class="${p === result.page ? "active" : ""}" aria-current="${p === result.page ? "page" : "false"}">${p}</button>`).join("")}<button data-page="${result.page + 1}" aria-label="Next page" ${result.page === result.totalPages ? "disabled" : ""}>›</button><button data-page="${result.totalPages}" aria-label="Last page" ${result.page === result.totalPages ? "disabled" : ""}>»</button></div>`;
  target.querySelector("[data-page-size]").addEventListener("change", (e) => { pageState[key] = { page: 1, size: Number(e.target.value) }; rerender(); });
  target.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => { pageState[key].page = Number(button.dataset.page); rerender(); }));
}
function ensurePager(id, anchor) { if (!$(id)) { const el = document.createElement("div"); el.id = id.slice(1); anchor?.parentElement?.appendChild(el); } }

async function api(path, options = {}) {
  const response = await fetch(`${base}${path}`, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || "Yêu cầu không thành công"); error.status = response.status; throw error; }
  return data;
}

function showAuthenticated(authenticated) { $("#loginView").classList.toggle("hidden", authenticated); $("#dashboardView").classList.toggle("hidden", !authenticated); }
function setDataState(state, message = "") {
  const banner = $("#appStatus");
  if (!banner) return;
  banner.hidden = !message;
  banner.className = `app-status ${state}`;
  banner.innerHTML = message ? `${escapeHtml(message)}${state === "error" ? ' <button type="button" id="retryData">Retry</button>' : ""}` : "";
  if (state === "error") $("#retryData")?.addEventListener("click", loadData, { once: true });
}
// Bọc mọi thao tác quản trị trên dashboard.
//
// Trước đây một lỗi API (ví dụ 404 khi xoá chat) làm Promise bị từ chối âm thầm:
// người dùng chỉ thấy dòng biến mất hoặc không có phản hồi nào. Hàm này hiện thông
// báo lỗi rõ ràng và KHÔNG vẽ lại bảng, nên dòng vẫn còn nếu thao tác thất bại.
async function runAction(action, failureLabel) {
  try {
    const result = await action();
    return { ok: true, result };
  } catch (error) {
    const detail = error?.message || String(error);
    setDataState("error", `${failureLabel}: ${detail}`);
    console.error(failureLabel, error);
    return { ok: false, error };
  }
}

function formatDate(value) { if (!value) return "-"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("vi-VN"); }

// Giờ Việt Nam, KHÔNG theo múi giờ của trình duyệt.
//
// Trang Logs phải khớp với giờ trong `pm2 logs` và với giờ người dùng nhắn tin.
// Người vận hành mở dashboard từ máy để UTC mà đọc giờ địa phương sẽ lệch 7 tiếng
// và kết luận sai rằng lịch gửi chạy nhầm giờ.
function formatDateTimeVN(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });
}function badge(value, tone = "neutral") { return `<span class="badge badge-${tone}">${escapeHtml(value)}</span>`; }
function statusTone(status) { return status === "active" ? "success" : status === "inactive" ? "danger" : status === "disabled" ? "warning" : "neutral"; }

// ---------------------------------------------------------------------------
// Nguồn gốc của bản ghi.
//
// TRƯỚC ĐÂY: recordBotId() chỉ chấp nhận /^bot\d+$/, nên danh tính "zca:<uid>"
// không khớp và bị đổi thành bot1 — đó là nguyên nhân trực tiếp khiến người dùng
// của tài khoản Zalo cá nhân hiển thị là "bot1". Bản ghi thiếu botId cũng bị gán
// bot1 mà không có dấu hiệu gì.
//
// NAY: dùng đúng quy tắc của server (sourceAttribution.js). Server đã tính sẵn
// sourceConfidence/sourceVerified/canSend cho từng bản ghi, nên giao diện chỉ đọc
// lại — không tự suy đoán, tránh hai bên lệch nhau.
// ---------------------------------------------------------------------------
const UNVERIFIED_BOT_ID = "__unverified__";

// Nhãn dùng chung cho bản ghi thiếu thông tin tài khoản.
//
// Cố ý KHÔNG dùng "chưa xác minh" trơ: dễ bị đọc thành "người dùng chưa xác minh"
// hoặc "bot chưa hoạt động". Vấn đề chỉ nằm ở bản ghi lịch sử thiếu tài khoản.
const UNVERIFIED_SOURCE_LABEL = "Chưa rõ tài khoản";
const UNVERIFIED_SOURCE_HINT = "Tài khoản gửi/nhận của bản ghi lịch sử này chưa được xác nhận. " +
  "Người dùng và các bot vẫn hoạt động bình thường.";

function isBotIdLike(value) {
  // Chấp nhận cả botN lẫn zca:<uid>. Không tự bịa danh tính.
  return /^bot\d+$/.test(value) || /^zca:[a-z0-9_-]+$/.test(value);
}

// botId đã xác minh của bản ghi, hoặc null nếu chưa đủ căn cứ.
// KHÔNG bao giờ mặc định về bot1.
function recordBotId(record) {
  const value = String(record?.botId || "").trim().toLowerCase();
  if (isBotIdLike(value)) return value;
  return null;
}

// Bản ghi có nguồn đã xác minh không. Server là nguồn quyết định; nếu vì lý do gì
// đó thiếu trường, suy ra từ botId đã xác minh.
function recordSourceVerified(record) {
  if (typeof record?.sourceVerified === "boolean") return record.sourceVerified;
  return Boolean(recordBotId(record));
}

function recordCanSend(record) {
  if (typeof record?.canSend === "boolean") return record.canSend;
  return recordSourceVerified(record);
}

// Nhãn nguồn gốc: tên bot thật nếu biết, ngược lại nói rõ là chưa xác minh.
function recordSourceLabel(record) {
  const botId = recordBotId(record);
  if (!botId) return UNVERIFIED_SOURCE_LABEL;
  return botLabel(botId);
}

// Lọc theo bot: bản ghi chưa xác minh có mục lọc riêng, không lẫn vào bot1.
function activeBotFilter() {
  return $("#botFilter")?.value || "all";
}

function filterByBot(list) {
  const botId = activeBotFilter();
  if (botId === "all") return list;
  if (botId === UNVERIFIED_BOT_ID) return list.filter((item) => !recordBotId(item));
  return list.filter((item) => recordBotId(item) === botId);
}

// Nhãn bot: ưu tiên tên thật lấy từ Zalo, rồi tới nhãn BOT_N_NAME, cuối cùng là
// botId. Server trả sẵn `label` nên giao diện không phải tự ghép.
function botLabel(botId) {
  if (!botId) return UNVERIFIED_SOURCE_LABEL;
  const known = bots.find((bot) => bot.botId === botId);
  // Danh tính lạ (ví dụ ZCA chưa kịp nạp vào danh sách bot): hiện thẳng botId,
  // KHÔNG thay bằng bot1.
  if (!known) return botId;
  const label = known.label || known.displayName || botId;
  return known.enabled === false ? `${label} (tắt)` : label;
}

// Ô "Nguồn" cho bảng Users và Chat directory. Luôn hiển thị, kể cả khi đang lọc
// một nguồn — cột phải ổn định để bảng không nhảy cột khi đổi bộ lọc.
//
// Bản ghi thiếu tài khoản hiển thị rõ là "Chưa rõ tài khoản" kèm giải thích, KHÔNG
// hiển thị như một bot cụ thể — đó chính là lỗi trước đây.
function botCell(record) {
  const botId = recordBotId(record);
  if (!botId) {
    // Nói rõ đây là vấn đề TÀI KHOẢN của bản ghi lịch sử, không phải người dùng hay
    // bot đang tắt. Tránh chữ "chưa xác minh" trơ khiến người đọc hiểu nhầm là tài
    // khoản hoặc người dùng không hoạt động.
    const tip = "Tài khoản gửi/nhận của bản ghi lịch sử này chưa được xác nhận. " +
      "Người dùng và các bot vẫn hoạt động bình thường — chỉ thiếu thông tin tài khoản trên bản ghi cũ. " +
      "Dùng nút \"Xác minh nguồn\" để xem bằng chứng và chọn tài khoản.";
    const pending = pendingRecordCount(record);
    const count = pending > 1 ? ` (${pending})` : "";
    return `<td><span class="bot-chip bot-chip-unverified" title="${escapeHtml(tip)}">Chưa rõ tài khoản${escapeHtml(count)}</span>` +
      `<small class="block source-pending">Cần xác minh tài khoản</small></td>`;
  }
  const kind = botId.startsWith("zca:") ? "Tài khoản Zalo cá nhân" : "Bot chính thức";
  return `<td><span class="bot-chip" title="${escapeHtml(`${botId} · ${kind}`)}">${escapeHtml(botLabel(botId))}</span><small class="block">${escapeHtml(kind)}</small></td>`;
}

// Nhãn nguồn chỉ hiện khi xem tất cả — lọc một nguồn rồi thì nó là thừa.
function botBadge(record) {
  if (activeBotFilter() !== "all") return "";
  const botId = recordBotId(record);
  if (!botId) return badge(UNVERIFIED_SOURCE_LABEL, "warning");
  return badge(botLabel(botId), botId.startsWith("zca:") ? "info" : "neutral");
}

// Nút thao tác trên một bản ghi.
//
// Nguồn CHƯA XÁC MINH thì nút quản lý bị vô hiệu, nhưng có nút "Xác minh nguồn" để
// quản trị viên xử lý. KHÔNG mở khoá Quản lý chỉ để dashboard trông gọn — gửi tin
// theo một nguồn đoán mò có thể liên hệ nhầm người hoặc nhầm tài khoản.
function actionButton(attribute, value, botId, record, label, className = "table-action") {
  if (!botId) {
    const reason = record?.sourceReason || "Chưa xác định được tài khoản cho bản ghi lịch sử này.";
    return `<button class="${escapeHtml(className)}" disabled title="${escapeHtml(`Không thể thao tác: ${reason}`)}">${escapeHtml(label)}</button>` +
      verifySourceButton(record);
  }
  return `<button class="${escapeHtml(className)}" ${attribute}="${escapeHtml(value)}" data-record-bot="${escapeHtml(botId)}">${escapeHtml(label)}</button>` +
    revokeSourceButton(record);
}

// Số bản ghi thật còn cần xác minh cho một dòng.
function pendingRecordCount(record) {
  if (Array.isArray(record?.sourceRecords)) return record.sourceRecords.filter((item) => !item.verified).length;
  return record?.sourceRecordKey ? 1 : 0;
}

// Nút mở hộp thoại xác minh nguồn.
//
// Dòng có thể được dựng từ NHIỀU bản ghi (chat, tương tác, đăng ký). Nếu còn bản ghi
// chưa xác minh thì vẫn phải cho xác minh, và nói rõ còn bao nhiêu.
function verifySourceButton(record) {
  const pending = pendingRecordCount(record);
  const store = record?.sourceStoreId || "";
  const key = record?.sourceRecordKey || "";
  if (!store || !key) {
    // Không có bản ghi thật nào để xác minh — không được gửi khóa tổng hợp lên API.
    return `<button class="table-action" disabled title="Không xác định được bản ghi lưu trữ nào cho dòng này.">Xác minh nguồn</button>`;
  }
  const suffix = pending > 1 ? ` (${pending} bản ghi)` : "";
  return `<button class="table-action" data-verify-source="1" data-source-store="${escapeHtml(store)}" data-source-key="${escapeHtml(key)}">Xác minh nguồn${escapeHtml(suffix)}</button>` +
    `<small class="block source-pending">Cần xác minh tài khoản</small>`;
}

// Nút hoàn tác cho bản ghi đã được quản trị viên xác minh (có thể sai).
function revokeSourceButton(record) {
  if (record?.sourceConfidence !== "manual") return "";
  const store = record?.sourceStoreId || "";
  const key = record?.sourceRecordKey || "";
  if (!store || !key) return "";
  return `<button class="table-action" data-revoke-source="1" data-source-store="${escapeHtml(store)}" data-source-key="${escapeHtml(key)}">Hoàn tác xác minh</button>`;
}

function botOptionsHtml(includeAll) {
  const options = bots.map((bot) => `<option value="${escapeHtml(bot.botId)}">${escapeHtml(botLabel(bot.botId))}</option>`).join("");
  return (includeAll ? '<option value="all">Tất cả bot</option>' : '<option value="">-- Chọn bot --</option>') + options;
}

// Đổ danh sách nguồn vào bộ lọc và bộ chọn bot, giữ lựa chọn hiện tại nếu còn.
function populateBotControls() {
  const filter = $("#botFilter");
  if (filter) {
    const previous = filter.value || "all";
    // "Chưa rõ tài khoản" là một mục lọc RIÊNG, không gộp vào bot1: những bản ghi này
    // không chứng minh được là của bot nào.
    filter.innerHTML = botOptionsHtml(true) +
      `<option value="${UNVERIFIED_BOT_ID}">Chưa rõ tài khoản</option>`;
    filter.value = bots.some((bot) => bot.botId === previous) || previous === "all" || previous === UNVERIFIED_BOT_ID ? previous : "all";
  }
  const selector = $("#commandBot");
  if (selector) {
    const previous = selector.value;
    selector.innerHTML = botOptionsHtml(false);
    if (bots.some((bot) => bot.botId === previous)) selector.value = previous;
  }
}

// Trạng thái nhà cung cấp → nhãn hiển thị.
const PROVIDER_STATUS_LABELS = {
  disabled: "Đang tắt",
  starting: "Đang khởi động",
  waiting_for_qr: "Cần quét mã QR",
  authentication_required: "Cần đăng nhập",
  authenticated: "Đã xác thực",
  connected: "Đang hoạt động",
  reconnecting: "Đang kết nối lại",
  disconnected: "Mất kết nối",
  running: "Đang hoạt động",
  error: "Lỗi",
  polling_failed: "Lỗi kết nối"
};

function providerStatusLabel(status) {
  return PROVIDER_STATUS_LABELS[status] || status || "không rõ";
}

function providerStatusTone(status) {
  if (["connected", "running", "authenticated"].includes(status)) return "success";
  if (["waiting_for_qr", "authentication_required", "reconnecting", "starting"].includes(status)) return "warning";
  if (["error", "polling_failed", "disconnected"].includes(status)) return "danger";
  return "neutral";
}

// Thẻ nhà cung cấp.
//
// Bot chính thức và tài khoản Zalo cá nhân là HAI loại danh tính khác nhau, nên
// thẻ phải nói rõ loại và không được trình bày tài khoản cá nhân như một bot có
// token — tài khoản cá nhân không có token nào để hiển thị.
function renderBotGrid() {
  const target = $("#botGrid");
  if (!target) return;
  const stats = workspace.botStats || [];
  if (!bots.length) { target.innerHTML = ""; return; }

  target.innerHTML = bots.map((bot) => {
    const stat = stats.find((item) => item.botId === bot.botId) || {};
    const isZca = bot.providerType === "zca" || bot.isPersonalAccount === true;
    const status = bot.status || (bot.enabled === false ? "disabled" : "unknown");
    const typeBadge = isZca
      ? badge("Tài khoản Zalo cá nhân", "warning")
      : badge("Bot chính thức", "info");

    // Dòng danh tính: bot chính thức dùng vân tay token, tài khoản cá nhân dùng UID
    // và trạng thái phiên. Không bao giờ hiển thị token hay nội dung phiên.
    const identityLine = isZca
      ? `<p class="muted">UID: <code>${escapeHtml(bot.uid || "chưa rõ")}</code> · xác thực: <code>${bot.health?.authenticated ? "phiên đã lưu" : "chưa đăng nhập"}</code></p>`
      : `<p class="muted">Token: <code>${escapeHtml(bot.tokenFingerprint || "-")}</code> · nguồn <code>${escapeHtml(bot.tokenSource || "-")}</code></p>`;

    const counters = `<dl><div><dt>Chat</dt><dd>${stat.chatCount ?? 0}</dd></div><div><dt>User</dt><dd>${stat.userCount ?? 0}</dd></div><div><dt>Đăng ký</dt><dd>${stat.subscriptionCount ?? 0}</dd></div><div><dt>Đang bật</dt><dd>${stat.enabledSubscriptionCount ?? 0}</dd></div><div><dt>Lỗi gửi</dt><dd>${stat.deliveryErrorCount ?? 0}</dd></div></dl>`;

    // Chỉ tài khoản cá nhân mới cần QR, và chỉ khi thực sự đang chờ quét.
    const needsQr = isZca && ["waiting_for_qr", "authentication_required"].includes(status);
    const qrActions = isZca
      ? `<div class="row-actions">${needsQr ? `<button type="button" class="small" data-zca-login="1">Đăng nhập bằng QR</button>` : ""}<button type="button" class="small" data-zca-session-status="1">Kiểm tra phiên</button></div>`
      : "";

    const errorLine = bot.health?.lastError
      ? `<p class="error-cell">${escapeHtml(bot.health.lastError)}</p>`
      : "";

    return `<article class="bot-card${isZca ? " provider-zca" : " provider-official"}" data-provider="${escapeHtml(bot.botId)}"><header><strong>${escapeHtml(bot.label || bot.displayName || bot.botId)}</strong>${badge(providerStatusLabel(status), providerStatusTone(status))}</header><p>${typeBadge}</p>${identityLine}${counters}${errorLine}${qrActions}</article>`;
  }).join("");

  $$('[data-zca-login]').forEach((button) => button.addEventListener("click", () => beginZcaLogin()));
  $$('[data-zca-session-status]').forEach((button) => button.addEventListener("click", () => showZcaSessionStatus()));
}

// Bắt đầu đăng nhập QR rồi hiện mã. Ảnh QR chỉ nằm trong bộ nhớ của tiến trình,
// không bao giờ được ghi ra đĩa và không đi kèm thông tin phiên.
async function beginZcaLogin() {
  const outcome = await runAction(async () => {
    const result = await api("/api/admin/providers/zca/login", { method: "POST" });
    if (result?.error) throw new Error(result.error);
    return result;
  }, "Không bắt đầu được đăng nhập ZCA");
  if (!outcome.ok) return;

  setDataState("loading", "Đang tạo mã QR...");
  // loginQR tạo mã bất đồng bộ nên phải chờ một nhịp rồi hỏi lại vài lần.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    const qr = await api("/api/admin/providers/zca/qr").then((data) => data.qr).catch(() => null);
    if (qr?.image) {
      setDataState("success", "Đã tạo mã QR. Quét bằng ứng dụng Zalo trên điện thoại.");
      showDialog("Đăng nhập Zalo cá nhân", `<p>Mở Zalo trên điện thoại → <strong>Cá nhân</strong> → <strong>Thiết bị đăng nhập</strong> → quét mã dưới đây.</p><div class="qr-box"><img alt="Mã QR đăng nhập Zalo" src="data:image/png;base64,${escapeHtml(qr.image)}" /></div><p class="muted">Mã chỉ tồn tại trong bộ nhớ và hết hạn sau ít phút. Không chia sẻ ảnh này.</p>`);
      return;
    }
  }
  setDataState("error", "Chưa tạo được mã QR. Kiểm tra log của tiến trình rồi thử lại.");
}

// Trạng thái phiên: chỉ hiển thị thông tin mô tả. Nội dung phiên (thông tin xác
// thực) không bao giờ được trả về trình duyệt.
async function showZcaSessionStatus() {
  const zca = bots.find((bot) => bot.providerType === "zca");
  showDialog("Phiên Zalo cá nhân", `<div class="detail-grid"><div class="detail"><span>Danh tính</span><strong>${escapeHtml(zca?.label || "-")}</strong></div><div class="detail"><span>UID</span><code>${escapeHtml(zca?.uid || "chưa rõ")}</code></div><div class="detail"><span>Trạng thái</span><strong>${escapeHtml(providerStatusLabel(zca?.status))}</strong></div><div class="detail"><span>Đã xác thực</span><strong>${zca?.health?.authenticated ? "Có" : "Không"}</strong></div></div><p class="muted">Phiên được lưu trên máy chủ và nội dung của nó không bao giờ được hiển thị. Xoá phiên bằng nút bên dưới nếu cần đăng nhập tài khoản khác.</p><div class="row-actions"><button type="button" class="danger-text" data-zca-clear-session="1">Xoá phiên đã lưu</button></div>`);
  $$('[data-zca-clear-session]').forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("Xoá phiên Zalo cá nhân đã lưu? Lần khởi động sau cần quét mã QR lại.")) return;
    const outcome = await runAction(async () => {
      await api("/api/admin/providers/zca/session", { method: "DELETE" });
      $("#detailDialog").close();
      await loadData();
    }, "Không xoá được phiên ZCA");
    if (outcome.ok) setDataState("success", "Đã xoá phiên ZCA. Cần đăng nhập lại bằng QR.");
  }));
}
function emptyRow(cols, text) { return `<tr><td colspan="${cols}" class="empty-state">${escapeHtml(text)}</td></tr>`; }
// Nhãn ngày đích: 0 = homnay, 1 = homsau. Dùng thống nhất với chat.
function targetDayLabel(targetDayOffset) {
  return Number(targetDayOffset) === 1 ? "homsau" : "homnay";
}

function targetDayText(targetDayOffset) {
  return Number(targetDayOffset) === 1 ? "Lịch hôm sau" : "Lịch hôm nay";
}

function timeChips(times = []) {
  return times.length
    ? `<div class="chip-list">${times.map((item) => `<span class="time-chip"><strong>ID ${escapeHtml(item.id)} · ${escapeHtml(item.time)}</strong><small>${escapeHtml(targetDayLabel(item.targetDayOffset))} · ${escapeHtml(formatDate(item.createdAt))}</small></span>`).join("")}</div>`
    : `<span class="muted">Chưa có giờ nhận lịch</span>`;
}

function switchTab(name) {
  $$(".tab-button").forEach((button) => button.classList.toggle("active", button.dataset.tab === name));
  $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === name));
  localStorage.setItem("zalobot-admin-tab", name);

  // Nạp dữ liệu của tab trong try/catch.
  //
  // Vì sao: switchTab() còn được gọi lúc KHÔI PHỤC tab đã lưu, và lần gọi đó có
  // thể chạy trước khi các khối `let` của phần Chat Center được khởi tạo. Truy cập
  // biến `let` lúc đó ném ReferenceError ("Cannot access before initialization"),
  // và vì đây là lỗi đồng bộ trong lúc nạp script nên TOÀN BỘ dashboard trắng.
  // Bọc lại để một tab lỗi không kéo sập cả trang.
  const run = (loader) => {
    try {
      loader();
    } catch (error) {
      console.error(`switchTab(${name}) không nạp được dữ liệu:`, error.message);
    }
  };

  if (name === "helpimages") run(loadHelpImages);
  if (name === "friendrequests") run(loadFriendRequests);
  if (name === "chatcenter") run(() => { loadChatConversations(); connectChatStream(); });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("zalobot-admin-theme", theme);
  $("#themeToggle").textContent = theme === "dark" ? "☀" : "☾";
}

function renderOverview() {
  const activeSubs = workspace.subscriptions.filter((item) => item.notificationsEnabled && item.eligible).length;
  const invalid = workspace.chats.filter((item) => item.status === "inactive").length;
  $("#metricGrid").innerHTML = [
    ["Users", workspace.users.length, `${workspace.users.filter((item) => item.studentIds.length).length} có MSSV`, "users"],
    ["Groups", workspace.groups.length, `${workspace.groups.reduce((sum, item) => sum + item.memberCount, 0)} member records`, "groups"],
    ["Chats", workspace.chats.length, `${workspace.chats.filter((item) => item.chatType === "unknown").length} unknown type`, "directory"],
    ["Nhận lịch", activeSubs, `${workspace.subscriptions.length} bản ghi`, "notifications"],
    ["Invalid chats", invalid, `${dashboard.notifications.failedDeliveries} failed deliveries`, "health"]
  ].map(([label, value, note, tab]) => `<button class="metric" data-jump="${tab}"><span>${label}</span><strong>${value}</strong><small>${note}</small></button>`).join("");
  $$('[data-jump]').forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.jump)));
  const errors = [...(logs.system || []).slice(0, 5).map((item) => ({ title: `${item.level} · System`, detail: item.message, at: item.at })), ...(dashboard.recentErrors || []).slice(0, 5).map((item) => ({ title: item.displayName || item.chatId, detail: item.lastError?.message, at: item.lastError?.at }))];
  $("#errorList").innerHTML = errors.slice(0, 8).map((item) => `<article class="stack-item"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail || "-")}</p><small>${escapeHtml(formatDate(item.at))}</small></article>`).join("") || `<div class="empty-state">Không có lỗi gần đây.</div>`;
  $("#auditList").innerHTML = (dashboard.audit || []).map((item) => `<article class="stack-item"><strong>${escapeHtml(item.action)}</strong><p>${escapeHtml(item.admin)} · ${escapeHtml(item.result || "")}</p><small>${escapeHtml(formatDate(item.at))}</small></article>`).join("") || `<div class="empty-state">Chưa có hoạt động admin.</div>`;
}

function renderUsers() {
  const query = $("#userSearch").value.trim().toLowerCase();
  const users = filterByBot(workspace.users).filter((user) => JSON.stringify(user).toLowerCase().includes(query));
  $("#userRows").innerHTML = users.map((user) => {
    const times = user.subscriptions.flatMap((item) => item.notificationTimes.map((time) => ({ ...time, chatName: item.chatName })));
    return `<tr><td><strong>${escapeHtml(user.displayName)}</strong><code>${escapeHtml(user.userId)}</code></td>${botCell(user)}<td>${user.chats.map((chat) => `<div class="context-line">${badge(chat.chatType, chat.chatType === "group" ? "info" : "neutral")} ${escapeHtml(chat.chatName)} <code>${escapeHtml(chat.chatId)}</code></div>`).join("")}</td><td>${user.studentIds.length ? user.studentIds.map((id) => badge(id, "info")).join(" ") : `<span class="muted">Chưa có MSSV</span>`}</td><td>${timeChips(times)}</td><td>${badge(user.status, statusTone(user.status))} ${badge(user.notificationsEnabled ? "Nhận lịch: bật" : "Nhận lịch: tắt", user.notificationsEnabled ? "success" : "neutral")}</td><td>${actionButton("data-user", user.userId, recordBotId(user), user, "Quản lý")}</td></tr>`;
  }).join("") || emptyRow(7, "Không tìm thấy người dùng phù hợp.");
  $$('[data-user]').forEach((button) => button.addEventListener("click", () => openUser(button.dataset.user, button.dataset.userBot)));
}

// Bộ chọn chế độ nhận tin của MỘT nhóm.
//
// Vì sao cần: nhóm lớp phải giữ "chỉ khi được gọi" (nếu không bot trả lời mọi tin),
// còn nhóm hỗ trợ cần "nhận mọi tin" để quản trị viên đọc và trả lời tay trong Chat
// Center. Một công tắc toàn cục (GROUP_MENTION_ONLY) không diễn đạt được sự khác
// nhau đó — nó biến MỌI nhóm thành nhóm hỗ trợ.
function groupReplyModeControl(group) {
  const mode = group.replyMode === "ingest" ? "ingest" : "mention";
  const botId = recordBotId(group) || "";
  return `<label class="group-reply-mode">Nhận tin
      <select data-group-chat="${escapeHtml(group.chatId)}" data-group-bot="${escapeHtml(botId)}" data-group-previous="${mode}">
        <option value="mention"${mode === "mention" ? " selected" : ""}>Chỉ khi được gọi</option>
        <option value="ingest"${mode === "ingest" ? " selected" : ""}>Mọi tin (để hỗ trợ)</option>
      </select>
    </label>`;
}

async function setGroupReplyMode(botId, chatId, mode) {
  const outcome = await runAction(
    () => api("/api/admin/group-policy", { method: "POST", body: JSON.stringify({ botId, chatId, mode }) }),
    "Không đổi được chế độ nhận tin của nhóm"
  );
  if (!outcome.ok) return outcome;
  await loadData();
  setDataState(
    "success",
    mode === "ingest"
      ? "Đã bật nhận mọi tin cho nhóm này. Bot KHÔNG tự trả lời tin thường và KHÔNG gửi lời chào — tin chỉ được ghi vào Chat Center để bạn trả lời tay."
      : "Nhóm này chỉ phản hồi khi được gọi (tag) hoặc khi có lệnh /..."
  );
  return outcome;
}

function renderGroups() {
  const query = $("#groupSearch").value.trim().toLowerCase();
  const groups = filterByBot(workspace.groups).filter((group) => JSON.stringify(group).toLowerCase().includes(query));
  $("#groupCards").innerHTML = groups.map((group) => `<article class="group-card"><div class="card-heading"><div><span class="eyebrow">${escapeHtml(group.typeSource)}</span><h2>${escapeHtml(group.displayName)}</h2><code>${escapeHtml(group.chatId)}</code> <span class="bot-chip">${escapeHtml(botLabel(recordBotId(group)))}</span></div>${badge(group.status, statusTone(group.status))}</div><div class="group-stats"><span><strong>${group.memberCount}</strong> thành viên</span><span><strong>${group.studentIds.length}</strong> MSSV</span><span><strong>${group.enabledSubscriptionCount}</strong> đang nhận lịch</span></div><div class="member-preview">${group.members.slice(0, 6).map((member) => `<div><strong>${escapeHtml(member.displayName)}</strong><small>${escapeHtml(member.studentIds.join(", ") || "Chưa có MSSV")}</small></div>`).join("") || `<span class="muted">Chưa có dữ liệu thành viên</span>`}</div>${groupReplyModeControl(group)}${actionButton("data-chat-detail", group.chatId, recordBotId(group), group, "Xem toàn bộ nhóm", "secondary full")}</article>`).join("") || `<div class="empty-state panel">Không có nhóm phù hợp.</div>`;
  $$('#groupCards [data-chat-detail]').forEach((button) => button.addEventListener("click", () => openChat(button.dataset.chatDetail, button.dataset.chatBot)));
  $$('#groupCards [data-group-chat]').forEach((select) => select.addEventListener("change", async (event) => {
    // Giữ nguyên lựa chọn cũ khi lưu thất bại: ô chọn không được hiển thị một
    // trạng thái mà máy chủ chưa chấp nhận.
    const previous = event.target.dataset.groupPrevious || "mention";
    event.target.disabled = true;
    const outcome = await setGroupReplyMode(event.target.dataset.groupBot, event.target.dataset.groupChat, event.target.value);
    event.target.disabled = false;
    if (!outcome.ok) event.target.value = previous;
    else event.target.dataset.groupPrevious = event.target.value;
  }));
}

function renderDirectory() {
  const query = $("#directorySearch").value.trim().toLowerCase();
  const type = $("#directoryType").value;
  const chats = filterByBot(workspace.chats).filter((chat) => (type === "all" || chat.chatType === type) && JSON.stringify(chat).toLowerCase().includes(query));
  $("#directoryRows").innerHTML = chats.map((chat) => `<tr><td><strong>${escapeHtml(chat.displayName)}</strong><code>${escapeHtml(chat.chatId)}</code></td>${botCell(chat)}<td>${badge(chat.chatType, chat.chatType === "group" ? "info" : chat.chatType === "unknown" ? "warning" : "neutral")}<small class="block">${escapeHtml(chat.typeSource)}</small></td><td><code>${escapeHtml(chat.userId || "-")}</code></td><td>${badge(chat.status, statusTone(chat.status))}</td><td>${escapeHtml(chat.memberCount)} thành viên<small class="block">${escapeHtml(chat.studentIds.join(", ") || "Chưa có MSSV")}</small></td><td><small>Tương tác: ${escapeHtml(formatDate(chat.lastInboundInteractionAt))}</small><small class="block">Gửi thành công: ${escapeHtml(formatDate(chat.lastSuccessfulDeliveryAt))}</small></td><td>${actionButton("data-chat-detail", chat.chatId, recordBotId(chat), chat, "Quản lý")}</td></tr>`).join("") || emptyRow(8, "Không có cuộc trò chuyện phù hợp.");
  $$('#directoryRows [data-chat-detail]').forEach((button) => button.addEventListener("click", () => openChat(button.dataset.chatDetail, button.dataset.chatBot)));
}

// Chuỗi tìm kiếm của một đăng ký nhận lịch.
//
// Gồm cả mã MSSV, tên sinh viên, chat ID, tên chat và các mốc giờ: người vận hành
// thường tra bằng đúng thứ người dùng vừa đọc cho họ trên Zalo (tên + MSSV), chứ
// không phải bằng khóa nội bộ của bản ghi.
function subscriptionSearchText(item) {
  const times = (item.notificationTimes || []).map((time) => `${time.time} ${targetDayText(time.targetDayOffset)}`);
  return [item.userDisplayName, item.userId, item.studentId, item.studentName, item.chatName, item.chatId, item.chatType, item.botId, ...times]
    .filter(Boolean).join(" ").toLowerCase();
}

function renderNotifications() {
  // `|| "all"` để một ô lọc chưa có giá trị (lúc mới nạp) không bị hiểu là một bộ
  // lọc khác "Tất cả" và làm danh sách trống không rõ lý do.
  const filter = $("#notificationFilter")?.value || "all";
  const query = ($("#notificationSearch")?.value || "").trim().toLowerCase();
  const scoped = filterByBot(workspace.subscriptions).filter((item) => filter === "all" || (filter === "enabled" && item.notificationsEnabled) || (filter === "disabled" && !item.notificationsEnabled) || (filter === "legacy" && item.schema === "legacy"));
  const list = query ? scoped.filter((item) => subscriptionSearchText(item).includes(query)) : scoped;
  const count = $("#notificationCount");
  if (count) {
    count.textContent = query || filter !== "all"
      ? `Hiện ${list.length} trên ${scoped.length} đăng ký phù hợp bộ lọc.`
      : `${scoped.length} đăng ký nhận lịch.`;
  }
  $("#notificationRows").innerHTML = list.map((item) => `<tr><td><strong>${escapeHtml(item.userDisplayName || item.userId || "Bản ghi cũ")}</strong> ${botBadge(item)}<code>${escapeHtml(item.userId || "-")}</code><div>${badge(item.studentId || "Chưa có MSSV", item.studentId ? "info" : "neutral")} ${escapeHtml(item.studentName)}</div></td><td><strong>${escapeHtml(item.chatName)}</strong><code>${escapeHtml(item.chatId)}</code></td><td>${badge(item.chatType, item.chatType === "group" ? "info" : "neutral")}</td><td>${timeChips(item.notificationTimes)}</td><td>${badge(item.schema, item.schema === "current" ? "success" : "warning")} ${badge(item.notificationsEnabled ? "Đang bật" : "Đang tắt", item.notificationsEnabled ? "success" : "neutral")}</td><td>${actionButton("data-subscription", item.key, recordBotId(item), item, "Quản lý")}</td></tr>`).join("") || emptyRow(6, query ? `Không có đăng ký nào khớp "${query}".` : "Không có đăng ký phù hợp.");
  $$('[data-subscription]').forEach((button) => button.addEventListener("click", () => openSubscription(button.dataset.subscription)));
}

function renderHealth() {
  const status = $("#healthFilter").value; const type = $("#healthType").value;
  const chats = filterByBot(workspace.chats).filter((chat) => (status === "all" || chat.status === status) && (type === "all" || chat.chatType === type));
  $("#healthRows").innerHTML = chats.map((chat) => `<tr><td><strong>${escapeHtml(chat.displayName)}</strong><code>${escapeHtml(chat.chatId)}</code></td>${botCell(chat)}<td>${badge(chat.chatType, chat.chatType === "group" ? "info" : chat.chatType === "unknown" ? "warning" : "neutral")}<small class="block">${escapeHtml(chat.typeSource)}</small></td><td>${badge(chat.status, statusTone(chat.status))}</td><td>${chat.memberCount}</td><td>${escapeHtml(formatDate(chat.lastSuccessfulDeliveryAt))}</td><td class="error-cell">${escapeHtml(chat.lastError?.message || "-")}</td><td>${actionButton("data-chat-detail", chat.chatId, recordBotId(chat), chat, "Chi tiết")}</td></tr>`).join("") || emptyRow(8, "Không có chat phù hợp.");
  $$('#healthRows [data-chat-detail]').forEach((button) => button.addEventListener("click", () => openChat(button.dataset.chatDetail, button.dataset.chatBot)));
}

function renderSettings() {
  $("#adminSettingsList").innerHTML = (settings.admins || []).map((admin) => `<article class="stack-item horizontal"><div><strong>${escapeHtml(admin.displayName || admin.userId || admin.chatId)}</strong><p>User: <code>${escapeHtml(admin.userId || "-")}</code> · Chat: <code>${escapeHtml(admin.chatId || "-")}</code></p></div><button class="danger-text" data-remove-admin="${escapeHtml(admin.userId || admin.chatId)}">Xóa</button></article>`).join("") || `<div class="empty-state">Chưa có danh tính quản trị trong cơ sở dữ liệu.</div>`;
  const access = workspace.access;
  $("#accessSummary").innerHTML = `<div class="access-modes"><div><span>Bot mode</span><strong>${escapeHtml(access.botMode)}</strong></div><div><span>AI mode</span><strong>${escapeHtml(access.aiMode)}</strong></div></div>${[["Bot blocked", access.botBlocked], ["AI blocked", access.aiBlocked], ["Bot allowlist", access.botAllowlist], ["AI allowlist", access.aiAllowlist]].map(([title, items]) => `<section><h3>${title} <span>${items.length}</span></h3>${items.slice(0, 8).map((item) => `<p>${escapeHtml(item.targetName || item.targetId)} <code>${escapeHtml(item.targetId)}</code></p>`).join("") || `<p class="muted">Trống</p>`}</section>`).join("")}`;
  $$('[data-remove-admin]').forEach((button) => button.addEventListener("click", async () => { await api(`/api/admin/settings/admins?id=${encodeURIComponent(button.dataset.removeAdmin)}`, { method: "DELETE" }); await loadData(); }));
  const select = $("#commandAdminIdentity");
  if (select) {
    const current = select.value;
    select.innerHTML = `<option value="">Nhập thủ công</option>${(settings.admins || []).map((admin, index) => `<option value="${index}">${escapeHtml(admin.displayName || admin.userId || admin.chatId)} · ${escapeHtml(admin.userId || "-")}</option>`).join("")}`;
    select.value = current;
  }
  const panel = $("#adminSettingsList")?.closest(".panel");
  if (panel && !$("#defaultPageSize")) {
    const form = document.createElement("form"); form.id = "pageSizeForm"; form.innerHTML = `<label>Default rows per page<select id="defaultPageSize" name="defaultPageSize">${PAGE_SIZES.map((n) => `<option value="${n}" ${n === pageSize() ? "selected" : ""}>${n}</option>`).join("")}</select></label><button class="secondary" type="submit">Save page size</button><p id="pageSizeMessage" class="success"></p>`; panel.appendChild(form);
    form.addEventListener("submit", async (event) => { event.preventDefault(); try { await api("/api/admin/settings", { method: "PATCH", body: JSON.stringify({ defaultPageSize: Number(form.elements.defaultPageSize.value) }) }); settings.defaultPageSize = Number(form.elements.defaultPageSize.value); Object.keys(pageState).forEach((key) => { pageState[key].page = 1; pageState[key].size = settings.defaultPageSize; }); $("#pageSizeMessage").textContent = "Saved."; applyPaginationViews(); } catch (error) { $("#pageSizeMessage").textContent = error.message; } });
  }
  // Hạn mức trợ lý AI. Để trống = theo .env; 0 = không giới hạn. Hai thứ khác
  // nhau nên ô nhập phân biệt rõ bằng placeholder thay vì mặc định 0.
  if (panel && !$("#aiLimitForm")) {
    const ai = settings.ai || {};
    const input = (id, label, hint, value) => `<label>${label}<input id="${id}" name="${id}" type="number" min="0" step="1" value="${value === null || value === undefined ? "" : value}" placeholder="theo .env" /><small class="muted">${hint}</small></label>`;
    const form = document.createElement("form");
    form.id = "aiLimitForm";
    form.innerHTML = `<h3>Trợ lý AI</h3>
      ${input("aiPerUser", "Hạn mức mỗi người mỗi ngày", "0 = không giới hạn · để trống = theo .env", ai.perUserDailyLimit)}
      ${input("aiGlobal", "Hạn mức toàn hệ thống mỗi ngày", "0 = không giới hạn · để trống = theo .env", ai.globalDailyLimit)}
      ${input("aiBudget", "Ngân sách tháng (USD)", "0 = không đặt trần · để trống = theo .env", ai.monthlyBudgetUsd)}
      <label>Trợ lý trong nhóm<select id="aiGroup" name="aiGroup"><option value="">Theo .env</option><option value="true">Bật</option><option value="false">Tắt</option></select></label>
      <button class="secondary" type="submit">Lưu hạn mức AI</button>
      <p id="aiLimitMessage" class="success"></p>`;
    panel.appendChild(form);
    form.elements.aiGroup.value = ai.groupAssistant === true ? "true" : ai.groupAssistant === false ? "false" : "";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const num = (id) => { const raw = String(form.elements[id].value).trim(); return raw === "" ? null : Number(raw); };
      const groupValue = form.elements.aiGroup.value;
      try {
        const updated = await api("/api/admin/settings", {
          method: "PATCH",
          body: JSON.stringify({ ai: { perUserDailyLimit: num("aiPerUser"), globalDailyLimit: num("aiGlobal"), monthlyBudgetUsd: num("aiBudget"), groupAssistant: groupValue === "" ? null : groupValue === "true" } })
        });
        settings.ai = updated.ai;
        $("#aiLimitMessage").textContent = "Đã lưu.";
      } catch (error) { $("#aiLimitMessage").textContent = error.message; }
    });
  }
}

function renderCommands() {
  const panel = $("[data-panel=commands]"); if (!panel) return;
  if (!$("#commandRegistryList")) { const section = document.createElement("section"); section.className = "panel command-registry"; section.innerHTML = `<div class="panel-heading"><h2>Available commands</h2><input id="commandSearch" placeholder="Search commands" /></div><div id="commandRegistryList" class="command-list"></div><div id="commandRegistryPagination"></div>`; panel.appendChild(section); $("#commandSearch").addEventListener("input", renderCommands); }
  const query = $("#commandSearch")?.value.trim().toLowerCase() || ""; const list = commandRegistry.filter((item) => JSON.stringify(item).toLowerCase().includes(query)); const result = paginate(list, "commands");
  $("#commandRegistryList").innerHTML = result.rows.map((item) => `<article class="stack-item"><strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(item.description)}</p><small>${escapeHtml(item.usage)} · ${escapeHtml(item.category)} · ${escapeHtml(item.permission)}</small></article>`).join("") || `<div class="empty-state">No commands found.</div>`;
  pager("#commandRegistryPagination", "commands", result, renderCommands);
}
/* ------------------------------------------------------------------ *
 * Command console: chọn nhiều người nhận
 *
 * Khóa của lựa chọn luôn là User ID thật. Chat ID chỉ được suy ra khi có
 * đúng một ngữ cảnh chat riêng tư đang hoạt động — cùng quy tắc với
 * targetUsers.js ở server. Người không suy ra được Chat ID vẫn chọn được
 * nhưng sẽ bị bỏ qua khi chạy, và điều đó được nói rõ trước khi xác nhận.
 * ------------------------------------------------------------------ */

let selectedTargets = [];
let batchPollTimer = null;

function targetUserStatusSuffix(status) {
  if (status === "disabled") return "đã tắt";
  if (status === "removed") return "đã xoá";
  return "";
}

function normalizeTargetUser(raw) {
  const userId = String(raw?.userId ?? "").trim();
  if (!userId) return null;
  const displayName = String(raw?.displayName || "").trim();
  return {
    // botId phải được giữ lại: thiếu nó thì mọi người nhận bị coi là của bot 1 và
    // hai người cùng User ID ở hai bot bị gộp làm một.
    botId: recordBotId(raw),
    userId,
    displayName: displayName || `User ${userId}`,
    status: ["active", "disabled", "removed"].includes(raw?.status) ? raw.status : "active",
    chatCount: Number(raw?.chatCount) || 0,
    studentIds: Array.isArray(raw?.studentIds) ? raw.studentIds.map((id) => String(id)).filter(Boolean) : [],
    targetChatId: String(raw?.targetChatId || "").trim(),
    targetChatHint: ["private", "multiple", "unresolved", "none"].includes(raw?.targetChatHint) ? raw.targetChatHint : "none"
  };
}

// Khử trùng theo User ID: giữ tên hiển thị thật nhất và nhiều ngữ cảnh chat nhất.
function mergeTargetUsers(list) {
  // Khóa theo (bot, user): gộp theo userId trần sẽ trộn hai bot làm một, và
  // Command console sẽ chọn nhầm người của bot khác.
  const byKey = new Map();
  const keyOf = (user) => `${recordBotId(user)}::${user.userId}`;
  for (const raw of list || []) {
    const user = normalizeTargetUser(raw);
    if (!user) continue;
    const key = keyOf(user);
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, user); continue; }
    const existingIsPlaceholder = existing.displayName === `User ${existing.userId}`;
    byKey.set(key, {
      ...existing,
      displayName: existingIsPlaceholder ? user.displayName : existing.displayName,
      status: existing.status === "active" ? existing.status : user.status,
      chatCount: Math.max(existing.chatCount, user.chatCount),
      studentIds: [...new Set([...existing.studentIds, ...user.studentIds])],
      targetChatId: existing.targetChatId || user.targetChatId,
      targetChatHint: existing.targetChatHint === "none" ? user.targetChatHint : existing.targetChatHint
    });
  }
  return [...byKey.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, "vi") || a.userId.localeCompare(b.userId));
}

// Dự phòng khi endpoint target-users không khả dụng: suy ra từ workspace users.
function targetUsersFromWorkspace(workspace) {
  return mergeTargetUsers((workspace?.users || []).map((user) => {
    const contexts = (user.chats || []).filter((chat) => chat.chatId && chat.status === "active" && chat.memberStatus !== "removed");
    const privateContexts = contexts.filter((chat) => chat.chatType === "private");
    const reliable = contexts.length === 1 && privateContexts.length === 1;
    const hint = reliable ? "private" : (!contexts.length ? "none" : (contexts.length === 1 ? "unresolved" : "multiple"));
    return {
      botId: recordBotId(user),
      userId: user.userId,
      displayName: user.displayName,
      status: user.status,
      chatCount: (user.chats || []).length,
      studentIds: user.studentIds,
      targetChatId: reliable ? String(privateContexts[0].chatId) : "",
      targetChatHint: hint
    };
  }));
}

function isTargetSelected(userId) {
  return selectedTargets.some((item) => item.userId === userId);
}

function targetDeliveryNote(target) {
  if (target.targetChatId) return `Gửi tới chat ${target.targetChatId}`;
  if (target.targetChatHint === "multiple") return "Nhiều ngữ cảnh chat — sẽ bỏ qua";
  if (target.targetChatHint === "unresolved") return "Chưa xác định được chat riêng tư — sẽ bỏ qua";
  return "Chưa có chat đang hoạt động — sẽ bỏ qua";
}

function targetUserOptionHtml(user, index) {
  const meta = [`ID ${user.userId}`, botLabel(recordBotId(user))];
  if (user.studentIds.length) meta.push(user.studentIds.join(", "));
  if (user.chatCount) meta.push(`${user.chatCount} chat`);
  const suffix = targetUserStatusSuffix(user.status);
  if (suffix) meta.push(suffix);
  if (!user.targetChatId) meta.push("không gửi được");
  const selected = isTargetSelected(user.userId);
  return `<li role="option" id="targetUserOption${index}" class="combobox-option${index === targetUserActiveIndex ? " active" : ""}${selected ? " selected" : ""}" aria-selected="${index === targetUserActiveIndex ? "true" : "false"}" data-index="${index}"><span class="combobox-name">${escapeHtml(user.displayName)}</span><span class="combobox-meta">${escapeHtml(meta.join(" · "))}</span>${selected ? `<span class="combobox-check" aria-label="đã chọn">✓</span>` : ""}</li>`;
}

// Ứng viên hiện tại: đã lọc theo từ khóa, bỏ những người đã chọn.
function currentTargetUserMatches() {
  const input = $("#targetUserInput");
  const needle = String(input?.value || "").trim().toLowerCase();
  return targetUsers.filter((user) => {
    if (isTargetSelected(user.userId)) return false;
    if (!needle) return true;
    return user.userId.toLowerCase().includes(needle)
      || user.displayName.toLowerCase().includes(needle)
      || user.studentIds.some((id) => id.toLowerCase().includes(needle));
  });
}

function renderTargetUserList() {
  const input = $("#targetUserInput");
  const list = $("#targetUserList");
  if (!input || !list) return;
  const needle = String(input.value || "").trim().toLowerCase();
  targetUserMatches = currentTargetUserMatches();
  targetUserActiveIndex = targetUserMatches.length ? 0 : -1;

  if (!targetUsers.length) {
    list.innerHTML = `<li class="combobox-empty" role="presentation">Chưa có user nào tương tác với bot. Nhập User ID thủ công rồi nhấn Enter.</li>`;
  } else if (!targetUserMatches.length) {
    list.innerHTML = `<li class="combobox-empty" role="presentation">${needle ? `Không có user khớp “${escapeHtml(needle)}”. Nhấn Enter để thêm User ID thủ công.` : "Đã chọn hết user khớp. Nhập User ID thủ công nếu cần."}</li>`;
  } else {
    const visible = targetUserMatches.slice(0, TARGET_USER_LIMIT);
    const rest = targetUserMatches.length - visible.length;
    list.innerHTML = visible.map(targetUserOptionHtml).join("") + (rest > 0 ? `<li class="combobox-empty" role="presentation">Còn ${rest} kết quả — gõ thêm để lọc.</li>` : "");
  }
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

function openTargetUserList() { renderTargetUserList(); }

function closeTargetUserList() {
  const list = $("#targetUserList");
  const input = $("#targetUserInput");
  if (list) { list.hidden = true; list.innerHTML = ""; }
  targetUserMatches = [];
  targetUserActiveIndex = -1;
  if (input) { input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); }
}

function highlightTargetUser(index) {
  const total = Math.min(targetUserMatches.length, TARGET_USER_LIMIT);
  if (index < 0 || index >= total) return;
  targetUserActiveIndex = index;
  $$("#targetUserList .combobox-option").forEach((option) => {
    const active = Number(option.dataset.index) === index;
    option.classList.toggle("active", active);
    option.setAttribute("aria-selected", active ? "true" : "false");
  });
  const active = $(`#targetUserList .combobox-option[data-index="${index}"]`);
  const input = $("#targetUserInput");
  if (!active || !input) return;
  input.setAttribute("aria-activedescendant", active.id);
  active.scrollIntoView({ block: "nearest" });
}

function moveTargetUserActive(step) {
  const total = Math.min(targetUserMatches.length, TARGET_USER_LIMIT);
  if (!total) return;
  const next = targetUserActiveIndex < 0
    ? (step > 0 ? 0 : total - 1)
    : (targetUserActiveIndex + step + total) % total;
  highlightTargetUser(next);
}

// Thêm một người vào lựa chọn. Chấp nhận cả User ID nhập tay không có trong gợi ý.
function addTargetUser(raw) {
  const user = typeof raw === "string"
    ? { userId: String(raw).trim(), displayName: "", status: "active", chatCount: 0, studentIds: [], targetChatId: "", targetChatHint: "none" }
    : raw;
  const userId = String(user?.userId || "").trim();
  if (!userId) return { ok: false, error: "User ID không hợp lệ." };
  if (isTargetSelected(userId)) return { ok: false, error: `Đã có ${userId} trong danh sách chọn.` };

  const known = targetUsers.find((item) => item.userId === userId);
  const source = known || user;
  selectedTargets.push({
    userId,
    displayName: source.displayName || `User ${userId}`,
    status: source.status || "active",
    targetChatId: source.targetChatId || "",
    targetChatHint: source.targetChatHint || "none",
    known: Boolean(known)
  });
  renderTargetSelection();
  return { ok: true };
}

function removeTargetUser(userId) {
  selectedTargets = selectedTargets.filter((item) => item.userId !== userId);
  renderTargetSelection();
}

function clearTargetSelection() {
  selectedTargets = [];
  renderTargetSelection();
}

function selectAllFilteredTargets() {
  const matches = currentTargetUserMatches();
  let added = 0;
  for (const user of matches) {
    if (isTargetSelected(user.userId)) continue;
    selectedTargets.push({
      userId: user.userId,
      displayName: user.displayName,
      status: user.status,
      targetChatId: user.targetChatId,
      targetChatHint: user.targetChatHint,
      known: true
    });
    added += 1;
  }
  renderTargetSelection();
  return added;
}

function renderTargetSelection() {
  const chips = $("#targetChips");
  const count = $("#targetCount");
  const sendable = selectedTargets.filter((item) => item.targetChatId).length;
  const skipped = selectedTargets.length - sendable;

  if (count) {
    count.textContent = selectedTargets.length === 0
      ? "Chưa chọn người nhận nào"
      : `Đã chọn ${selectedTargets.length} người · ${sendable} gửi được${skipped ? ` · ${skipped} sẽ bỏ qua` : ""}`;
  }

  if (chips) {
    chips.innerHTML = selectedTargets.map((target) => `
      <span class="chip${target.targetChatId ? "" : " chip-warning"}">
        <span class="chip-text"><strong>${escapeHtml(target.displayName)}</strong><code>${escapeHtml(target.userId)}</code></span>
        <span class="chip-note">${escapeHtml(targetDeliveryNote(target))}</span>
        <button type="button" class="chip-remove" data-remove-target="${escapeHtml(target.userId)}" aria-label="Bỏ ${escapeHtml(target.displayName)}">×</button>
      </span>`).join("");
    $$("#targetChips [data-remove-target]").forEach((button) => button.addEventListener("click", () => removeTargetUser(button.dataset.removeTarget)));
  }

  const list = $("#targetUserList");
  if (list && !list.hidden) renderTargetUserList();
}

function applyTargetUserState() {
  const hint = $("#targetUserHint");
  if (hint) {
    hint.textContent = targetUsers.length
      ? `${targetUsers.length} user đã tương tác với bot. Gõ để tìm theo tên, User ID hoặc MSSV; nhấn Enter để thêm User ID nhập tay.`
      : "Chưa có user nào tương tác với bot. Nhập User ID thủ công rồi nhấn Enter.";
  }
  renderTargetSelection();
}

/* ------------------------------------------------------------------ *
 * Xác nhận, tiến độ và kết quả
 * ------------------------------------------------------------------ */

function hideBatchConfirm() {
  const block = $("#batchConfirm");
  if (block) { block.hidden = true; block.innerHTML = ""; }
}

function showBatchConfirm({ command, targets, targeting, botId }) {
  const block = $("#batchConfirm");
  if (!block) return;
  const isBroadcast = targeting?.mode === "broadcast";
  const sendable = targets.filter((item) => item.targetChatId);
  const skipped = targets.length - sendable.length;
  const willSend = isBroadcast || sendable.length > 0;

  block.hidden = false;
  block.innerHTML = `
    <div class="panel-heading"><h2>Xác nhận trước khi chạy</h2></div>
    <div class="detail-grid">
      <div class="detail"><span>Lệnh</span><code>${escapeHtml(command)}</code></div>
      <div class="detail"><span>Bot gửi</span><strong>${escapeHtml(botLabel(botId))}</strong></div>
      <div class="detail"><span>Người nhận</span><strong>${isBroadcast ? `Mọi chat đang hoạt động của ${escapeHtml(botLabel(botId))}` : `${targets.length} người (${new Set(targets.map((item) => item.userId)).size} User ID không trùng)`}</strong></div>
      <div class="detail"><span>Sẽ gửi tin nhắn</span><strong>${willSend ? "Có" : "Không"}</strong></div>
      <div class="detail"><span>Bỏ qua</span><strong>${isBroadcast ? 0 : skipped}</strong></div>
    </div>
    <p class="notice">Tin nhắn sẽ được gửi bằng <strong>${escapeHtml(botLabel(botId))}</strong>. Người nhận thuộc bot khác sẽ bị từ chối.</p>
    ${isBroadcast ? `<p class="notice">${escapeHtml(targeting.broadcastScope || "")} Phạm vi là chat đang hoạt động của <strong>${escapeHtml(botLabel(botId))}</strong>, không phải của mọi bot.</p>` : ""}
    ${!isBroadcast && skipped > 0 ? `<p class="warning-box">${skipped} người chưa xác định được chat riêng tư đang hoạt động nên sẽ bị bỏ qua, không gửi tin.</p>` : ""}
    <div class="row-actions">
      <button type="button" class="primary" id="batchConfirmRun">Chạy lệnh</button>
      <button type="button" class="secondary" id="batchConfirmCancel">Hủy</button>
    </div>`;

  $("#batchConfirmRun").addEventListener("click", () => startBatchRun({ command, targets, targeting, botId }));
  $("#batchConfirmCancel").addEventListener("click", () => {
    hideBatchConfirm();
    $("#commandResult").textContent = "Đã hủy. Không có lệnh nào được chạy.";
  });
}

function batchStatusBadge(status) {
  if (status === "delivered") return `<span class="badge badge-success">Đã gửi</span>`;
  if (status === "failed") return `<span class="badge badge-danger">Lỗi</span>`;
  return `<span class="badge badge-warning">Bỏ qua</span>`;
}

function renderBatchProgress(state) {
  const output = $("#commandResult");
  if (!output) return;
  const { phase, progress, summary, results = [], error, note } = state;
  const total = progress?.total || 0;
  const completed = progress?.completed || 0;
  const percent = total ? Math.round((completed / total) * 100) : 0;

  const rows = results.map((item) => `
    <tr>
      <td><strong>${escapeHtml(item.displayName || item.userId || "Mọi chat")}</strong><code>${escapeHtml(item.userId || "-")}</code></td>
      <td>${escapeHtml(item.chatId || "-")}</td>
      <td>${batchStatusBadge(item.status)}</td>
      <td>${item.messageCount ? `${item.messageCount} tin` : ""}${item.error ? escapeHtml(item.error) : ""}</td>
    </tr>`).join("");

  output.innerHTML = `
    <div class="batch-progress">
      <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${completed}"><span style="width:${percent}%"></span></div>
      <p class="muted">${phase === "running" ? "Đang chạy" : phase === "failed" ? "Dừng vì lỗi" : "Hoàn tất"}: ${completed}/${total} · thành công ${summary?.delivered ?? 0} · lỗi ${summary?.failed ?? 0} · bỏ qua ${summary?.skipped ?? 0}${summary?.duplicates ? ` · ${summary.duplicates} User ID trùng đã gộp` : ""}</p>
      ${note ? `<p class="notice">${escapeHtml(note)}</p>` : ""}
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    </div>
    ${rows ? `<div class="table-wrap"><table><thead><tr><th>Người nhận</th><th>Chat</th><th>Trạng thái</th><th>Ghi chú</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}`;
}

async function startBatchRun({ command, targets, targeting, botId }) {
  const runButton = $("#batchConfirmRun");
  if (runButton) runButton.disabled = true;
  hideBatchConfirm();

  const isBroadcast = targeting?.mode === "broadcast";
  // botId bắt buộc: người nhận chỉ có nghĩa trong phạm vi một bot.
  const payload = { command, botId, targetUserIds: targets.map((item) => item.userId) };
  renderBatchProgress({
    phase: "running",
    progress: { completed: 0, total: isBroadcast ? 1 : targets.length },
    summary: { delivered: 0, failed: 0, skipped: 0 },
    results: []
  });

  try {
    const started = await api("/api/admin/commands/batch", { method: "POST", body: JSON.stringify(payload) });
    if (batchPollTimer) { window.clearInterval(batchPollTimer); batchPollTimer = null; }

    const poll = async () => {
      try {
        const state = await api(`/api/admin/commands/batch/${encodeURIComponent(started.jobId)}`);
        renderBatchProgress({
          phase: state.status === "running" ? "running" : state.status === "failed" ? "failed" : "done",
          progress: state.progress,
          summary: state.summary,
          results: state.results,
          error: state.error,
          note: isBroadcast ? targeting?.broadcastScope : null
        });
        if (state.status !== "running") {
          if (batchPollTimer) { window.clearInterval(batchPollTimer); batchPollTimer = null; }
          await loadData();
        }
      } catch (error) {
        if (batchPollTimer) { window.clearInterval(batchPollTimer); batchPollTimer = null; }
        renderBatchProgress({ phase: "failed", progress: { completed: 0, total: targets.length }, summary: {}, results: [], error: error.message });
      }
    };

    await poll();
    batchPollTimer = window.setInterval(poll, 600);
  } catch (error) {
    renderBatchProgress({
      phase: "failed",
      progress: { completed: 0, total: isBroadcast ? 1 : targets.length },
      summary: {},
      results: [],
      error: error.message
    });
  } finally {
    if (runButton) runButton.disabled = false;
  }
}

function setupCommandConsole() {
  const form = $("#commandForm"); if (!form || form.dataset.ready) return; form.dataset.ready = "1";
  form.innerHTML = `
    <label>Command<input name="command" id="commandInput" list="commandSuggestions" placeholder="/lich" required autocomplete="off" /><datalist id="commandSuggestions"></datalist></label>
    <p class="muted">Executing as: <strong>${escapeHtml("authenticated admin")}</strong> — quyền hạn luôn xét theo admin đang đăng nhập, không theo người nhận.</p>
    <div class="field">
      <label for="targetUserInput">Người nhận (User ID)</label>
      <div class="combobox" data-combobox>
        <input name="targetUserInput" id="targetUserInput" role="combobox" aria-expanded="false" aria-controls="targetUserList" aria-autocomplete="list" aria-describedby="targetUserHint" placeholder="Tìm theo tên, User ID hoặc MSSV" autocomplete="off" />
        <button type="button" class="combobox-toggle" data-combobox-toggle aria-label="Mở danh sách user" tabindex="-1">▾</button>
        <ul class="combobox-list" id="targetUserList" role="listbox" aria-label="User đã tương tác với bot" hidden></ul>
      </div>
      <div class="row-actions selection-actions">
        <button type="button" id="targetSelectAll" class="small">Chọn tất cả kết quả đang lọc</button>
        <button type="button" id="targetClearAll" class="small">Bỏ chọn tất cả</button>
        <span class="muted" id="targetCount">Chưa chọn người nhận nào</span>
      </div>
      <div id="targetChips" class="chip-list" aria-live="polite"></div>
      <p class="field-hint" id="targetUserHint">Chưa tải danh sách user.</p>
    </div>
    <div class="field">
      <label for="commandBot">Bot gửi</label>
      <select name="botId" id="commandBot" aria-describedby="commandBotHint"><option value="">-- Chọn bot --</option></select>
      <p class="field-hint" id="commandBotHint">Bắt buộc chọn bot. Chat ID và User ID chỉ có nghĩa trong phạm vi một bot, nên người nhận của bot 1 không thể nhận tin từ bot 2.</p>
    </div>
    <button class="primary" type="submit" id="commandSubmit">Execute command</button>
    <div id="batchConfirm" class="panel confirm-panel" hidden></div>
    <pre id="commandResult" class="command-output">No result yet.</pre>`;

  const input = $("#commandInput");
  input.addEventListener("input", () => { const query = input.value.toLowerCase(); $("#commandSuggestions").innerHTML = commandRegistry.filter((item) => item.name.toLowerCase().startsWith(query || "/")).map((item) => `<option value="${escapeHtml(item.usage)}">`).join(""); });

  const userInput = $("#targetUserInput");
  const toggle = $("[data-combobox-toggle]");

  userInput.addEventListener("focus", openTargetUserList);
  userInput.addEventListener("click", openTargetUserList);
  userInput.addEventListener("input", openTargetUserList);
  userInput.addEventListener("keydown", (event) => {
    const open = !$("#targetUserList").hidden;
    if (event.key === "ArrowDown") { event.preventDefault(); if (open) moveTargetUserActive(1); else openTargetUserList(); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); if (open) moveTargetUserActive(-1); else openTargetUserList(); return; }
    if (event.key === "Home" && open) { event.preventDefault(); highlightTargetUser(0); return; }
    if (event.key === "End" && open) { event.preventDefault(); highlightTargetUser(Math.min(targetUserMatches.length, TARGET_USER_LIMIT) - 1); return; }
    if (event.key === "Enter") {
      // Enter chọn gợi ý đang tô sáng; nếu không có gợi ý nào thì thêm User ID nhập tay.
      const typed = userInput.value.trim();
      if (open && targetUserActiveIndex >= 0 && targetUserMatches[targetUserActiveIndex]) {
        event.preventDefault();
        addTargetUser(targetUserMatches[targetUserActiveIndex]);
        userInput.value = "";
        openTargetUserList();
        return;
      }
      if (typed) {
        event.preventDefault();
        const result = addTargetUser(typed);
        if (!result.ok) $("#commandResult").textContent = result.error;
        userInput.value = "";
        openTargetUserList();
      }
      return;
    }
    if (event.key === "Backspace" && !userInput.value && selectedTargets.length) {
      removeTargetUser(selectedTargets[selectedTargets.length - 1].userId);
      return;
    }
    if (event.key === "Escape" && open) { event.preventDefault(); closeTargetUserList(); }
  });
  // Đóng khi focus rời khỏi combobox, kể cả khi chọn bằng chuột.
  userInput.addEventListener("blur", () => window.setTimeout(() => { if (!$("[data-combobox]")?.contains(document.activeElement)) closeTargetUserList(); }, 120));

  toggle.addEventListener("click", () => { if ($("#targetUserList").hidden) { userInput.focus(); openTargetUserList(); } else closeTargetUserList(); });
  $("#targetUserList").addEventListener("mousedown", (event) => {
    const option = event.target.closest(".combobox-option");
    if (!option) return;
    event.preventDefault();
    const user = targetUserMatches[Number(option.dataset.index)];
    if (!user) return;
    addTargetUser(user);
    userInput.value = "";
    openTargetUserList();
    userInput.focus();
  });

  $("#targetSelectAll").addEventListener("click", () => {
    const added = selectAllFilteredTargets();
    if (!added) $("#commandResult").textContent = "Không còn user nào để chọn thêm trong kết quả đang lọc.";
  });
  $("#targetClearAll").addEventListener("click", () => { clearTargetSelection(); hideBatchConfirm(); });

  // Gửi form: chỉ hiện xác nhận, chưa chạy gì cả.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const command = $("#commandInput").value.trim();
    if (!command) return;
    if (!command.startsWith("/")) { $("#commandResult").textContent = "Lệnh phải bắt đầu bằng /"; return; }
    if (!selectedTargets.length) { $("#commandResult").textContent = "Chọn ít nhất một người nhận."; return; }

    const name = command.slice(1).match(/^(\w+)/)?.[1]?.toLowerCase() || "";
    const entry = commandRegistry.find((item) => item.name.slice(1) === name || (item.aliases || []).includes(name));
    if (!entry) { $("#commandResult").textContent = `Không nhận diện được lệnh “/${name}”.`; return; }

    // Phân loại đích lấy từ server (commandTargeting.js) để dashboard không giữ
    // bản sao danh sách lệnh của riêng nó. Server vẫn là nơi quyết định cuối cùng.
    const targeting = entry.targeting;
    if (!targeting || targeting.mode === "none") {
      $("#commandResult").textContent = targeting?.reason || `Lệnh /${name} không chạy theo từng người được nên không thể chọn nhiều người nhận.`;
      return;
    }

    // Lệnh có gửi tin BẮT BUỘC phải chọn bot: người nhận thuộc về một bot cụ thể.
    const botId = $("#commandBot")?.value || "";
    if (!botId) {
      $("#commandResult").textContent = "Chọn bot gửi trước khi chạy. Người nhận chỉ tồn tại trong phạm vi một bot.";
      $("#commandBot")?.focus();
      return;
    }

    // Người nhận phải thuộc đúng bot đã chọn — không gửi cho người của bot khác
    // chỉ vì User ID trông giống nhau.
    const foreign = selectedTargets.filter((item) => item.botId && item.botId !== botId);
    if (foreign.length) {
      $("#commandResult").textContent = `${foreign.length} người nhận thuộc bot khác (${foreign[0].botId}). Bỏ chọn họ hoặc đổi bot gửi.`;
      return;
    }

    showBatchConfirm({ command, targets: selectedTargets, targeting, botId });
  });
}

// ---------------------------------------------------------------------------
// Logs & audit
//
// Bốn nguồn, cùng một chỗ:
//   deliveries     — từng lần gửi tin theo lịch (bộ đệm trong bộ nhớ ở máy chủ)
//   system         — log hệ thống (lỗi, cảnh báo, kết quả các lượt gửi)
//   deliveryErrors — lỗi gửi gần nhất theo từng chat
//   audit          — đăng nhập và thao tác quản trị
//
// Tất cả đều có tìm kiếm và lọc, và mọi mốc thời gian đều hiển thị theo giờ Việt
// Nam: log phải đối chiếu được với `pm2 logs` và với giờ người dùng nhắn tin.
// ---------------------------------------------------------------------------

const TRACE_RESULT_LABEL = { sent: "Đã gửi", failed: "Lỗi gửi", skipped: "Bỏ qua", deferred: "Hoãn" };
const TRACE_RESULT_TONE = { sent: "success", failed: "danger", skipped: "warning", deferred: "neutral" };

function traceOperationLabel(item) {
  const feature = item.feature === "schedule" ? "Lịch học" : item.feature === "broadcast" ? "Thông báo" : (item.feature || "?");
  const operation = item.operation === "daily_schedule" ? "gửi lịch hằng ngày"
    : item.operation === "class_start_reminder" ? "nhắc giờ học"
    : item.operation === "schedule_change" ? "cảnh báo đổi lịch"
    : (item.operation || "?");
  return `${feature} · ${operation}`;
}

function logMatches(query, values) {
  if (!query) return true;
  return values.filter((value) => value != null && value !== "").join(" ").toLowerCase().includes(query);
}

function auditDetailText(item) {
  const parts = [item.result, item.botId, item.chatId, item.userId, item.scope, item.error].filter((value) => value != null && value !== "");
  return parts.join(" · ");
}

function renderLogs() {
  const query = ($("#logSearch")?.value || "").trim().toLowerCase();
  const level = $("#logLevel")?.value || "all";
  const result = $("#logResult")?.value || "all";

  // 1. Nhật ký gửi tin theo lịch.
  const traces = filterByBot(logs.deliveries || []).filter((item) => {
    if (result !== "all" && item.result !== result) return false;
    return logMatches(query, [item.botId, item.chatId, item.chatName, item.feature, item.operation, item.result, item.reason, item.error, item.providerMessageId]);
  });
  $("#deliveryTraceList").innerHTML = traces.map((item) => `<article class="stack-item">
      <div class="trace-head">${badge(TRACE_RESULT_LABEL[item.result] || item.result, TRACE_RESULT_TONE[item.result] || "neutral")}<strong>${escapeHtml(item.chatName || item.chatId || "?")}</strong><code>${escapeHtml(item.chatId || "")}</code>${item.botId ? badge(item.botId, "neutral") : ""}</div>
      <div class="trace-meta"><span>${escapeHtml(traceOperationLabel(item))}</span><span>${escapeHtml(formatDateTimeVN(item.at))}</span>${item.chunks ? `<span>${item.chunks} phần</span>` : ""}${item.providerMessageId ? `<span>mã Zalo: <code>${escapeHtml(item.providerMessageId)}</code></span>` : `<span>Zalo không trả mã tin nhắn</span>`}${item.reason ? `<span>lý do: ${escapeHtml(item.reason)}</span>` : ""}</div>
      ${item.error ? `<p class="trace-error">${escapeHtml(item.error)}</p>` : ""}
    </article>`).join("") || `<div class="empty-state">Chưa có lần gửi nào được ghi. Nhật ký này chỉ tồn tại trong bộ nhớ của tiến trình đang chạy.</div>`;

  // 2. Log hệ thống.
  const system = (logs.system || []).filter((item) => {
    if (level !== "all" && String(item.level || "").toLowerCase() !== level) return false;
    return logMatches(query, [item.level, item.message, item.kind, item.operation, item.botId, item.chatId]);
  });
  $("#systemLogList").innerHTML = system.map((item) => `<article class="stack-item"><strong><span class="log-level">${escapeHtml(item.level)}</span> ${escapeHtml(item.kind || item.operation || "hệ thống")}</strong><p>${escapeHtml(item.message)}</p><small>${escapeHtml(formatDateTimeVN(item.at))}</small></article>`).join("") || `<div class="empty-state">Không có log hệ thống phù hợp.</div>`;

  // 3. Lỗi gửi theo từng chat.
  const deliveryErrors = filterByBot(logs.deliveryErrors || []).filter((item) => logMatches(query, [item.displayName, item.chatId, item.lastError?.message]));
  $("#deliveryLogList").innerHTML = deliveryErrors.map((item) => `<article class="stack-item"><strong>${escapeHtml(item.displayName || item.chatId)}</strong><p>${escapeHtml(item.lastError?.message || "-")}</p><small>${escapeHtml(formatDateTimeVN(item.lastError?.at))}</small></article>`).join("") || `<div class="empty-state">Không có lỗi gửi gần đây.</div>`;

  // 4. Admin audit.
  const audit = (logs.audit || []).filter((item) => logMatches(query, [item.action, item.admin, item.ip, auditDetailText(item)]));
  $("#auditLogList").innerHTML = audit.map((item) => `<article class="stack-item"><strong>${escapeHtml(item.action)}</strong><p>${escapeHtml(item.admin || "unknown")}${auditDetailText(item) ? ` · ${escapeHtml(auditDetailText(item))}` : ""}</p><small>${escapeHtml(formatDateTimeVN(item.at))}</small></article>`).join("") || `<div class="empty-state">Chưa có hoạt động quản trị phù hợp.</div>`;

  const failedTraces = (logs.deliveries || []).filter((item) => item.result === "failed").length;
  const errorLogs = (logs.system || []).filter((item) => String(item.level).toUpperCase() === "ERROR").length;
  $("#logStats").innerHTML = [
    ["Lần gửi ghi được", (logs.deliveries || []).length, `${failedTraces} lỗi`],
    ["Log hệ thống", (logs.system || []).length, `${errorLogs} lỗi`],
    ["Audit", (logs.audit || []).length, "thao tác quản trị"],
    ["Bộ đệm gửi", logs.deliveryStats?.total ?? 0, `tối đa ${logs.deliveryStats?.capacity ?? 0}`]
  ].map(([label, value, note]) => `<article class="metric-card"><span>${escapeHtml(label)}</span><strong>${Number(value) || 0}</strong><small>${escapeHtml(note)}</small></article>`).join("");
}

function ensurePaginationViews() {
  [["#directoryRows", "directory"], ["#userRows", "users"], ["#groupCards", "groups"], ["#notificationRows", "notifications"], ["#healthRows", "health"], ["#systemLogList", "systemLogs"], ["#deliveryLogList", "deliveryLogs"], ["#deliveryTraceList", "deliveryTraces"], ["#auditLogList", "auditLogs"]].forEach(([selector, key]) => {
    const anchor = $(selector); if (!anchor) return; const id = `${key}Pagination`; if (!document.getElementById(id)) { const el = document.createElement("div"); el.id = id; anchor.closest(".panel")?.appendChild(el) || anchor.parentElement.appendChild(el); }
  });
}
function paginateRendered(selector, key) {
  const container = $(selector); if (!container) return;
  const items = [...container.children].filter((item) => !item.classList.contains("empty-state"));
  const size = pageState[key]?.size || pageSize(); const totalPages = items.length ? Math.ceil(items.length / size) : 0; const page = totalPages ? Math.min(Math.max(pageState[key]?.page || 1, 1), totalPages) : 1;
  pageState[key] = { page, size }; items.forEach((item, index) => { item.hidden = index < (page - 1) * size || index >= page * size; });
  pager(`#${key}Pagination`, key, { page, size, totalPages, total: items.length }, applyPaginationViews);
}
function applyPaginationViews() { ensurePaginationViews(); paginateRendered("#directoryRows", "directory"); paginateRendered("#userRows", "users"); paginateRendered("#groupCards", "groups"); paginateRendered("#notificationRows", "notifications"); paginateRendered("#healthRows", "health"); paginateRendered("#systemLogList", "systemLogs"); paginateRendered("#deliveryLogList", "deliveryLogs"); paginateRendered("#deliveryTraceList", "deliveryTraces"); paginateRendered("#auditLogList", "auditLogs"); }
// Yêu cầu hỗ trợ: danh sách, bộ đếm và yêu cầu đang mở.
let feedbackTickets = [];
let feedbackCounts = { total: 0, unread: 0, open: 0, resolved: 0 };
let selectedFeedback = null;

/* --------------------------------------------------------------------------
   Tạm dừng trợ lý AI

   Khi quản trị viên đang trả lời trực tiếp, trợ lý phải im lặng — nếu không, mỗi
   tin người dùng gửi sẽ nhận một câu trả lời máy móc xen vào giữa cuộc trò
   chuyện thật.

   Công tắc này chỉ chặn đường gọi mô hình. Lệnh "/...", lô lệnh tất định, lời xác
   nhận đang chờ và mọi thông báo theo lịch vẫn chạy — đó là lý do giao diện phải
   nói rõ phạm vi, để người vận hành không tưởng nhầm là "đã tắt bot".
   -------------------------------------------------------------------------- */

const AI_PAUSE_DURATIONS = [[0, "Đến khi bật lại"], [15, "15 phút"], [30, "30 phút"], [60, "1 giờ"], [120, "2 giờ"], [480, "8 giờ"]];

function aiPauseDurationOptions() {
  return AI_PAUSE_DURATIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
}

function pauseUntilText(entry) {
  if (!entry?.until) return "không đặt hạn";
  return `đến ${formatDateTimeVN(entry.until)}`;
}

function activeChatPause(botId, chatId) {
  const key = `${botId}::${chatId}`;
  return (aiPause.chats || []).find((entry) => entry.key === key && entry.active) || null;
}

async function applyAiPause(patch, successMessage) {
  if (aiPauseBusy) return { ok: false };
  aiPauseBusy = true;
  const outcome = await runAction(
    () => api("/api/admin/ai-pause", { method: "POST", body: JSON.stringify(patch) }),
    "Không đổi được trạng thái trợ lý AI"
  );
  aiPauseBusy = false;
  if (!outcome.ok) return outcome;
  aiPause = outcome.result.pause;
  renderAiPause();
  // Thanh điều khiển trong Chat Center đọc trạng thái cuộc trò chuyện đang mở.
  // Bọc lại: nếu người dùng chưa từng mở Chat Center thì trạng thái đó chưa được
  // khởi tạo và lỗi ở đây không được làm hỏng thao tác vừa thành công.
  try { renderChatAiPause(); } catch (_) { /* chưa mở Chat Center */ }
  setDataState("success", successMessage);
  window.setTimeout(() => setDataState("success", ""), 2200);
  return outcome;
}

// Bật lại tất cả: toàn cục + mọi cuộc trò chuyện đang bị tạm dừng riêng lẻ.
async function resumeAllAiPause() {
  const chats = (aiPause.chats || []).filter((entry) => entry.active);
  if (aiPause.global?.active) await applyAiPause({ scope: "global", paused: false }, "Đã bật lại trợ lý AI.");
  for (const entry of chats) {
    await applyAiPause({ scope: "chat", botId: entry.botId, chatId: entry.chatId, paused: false }, "Đã bật lại trợ lý AI.");
  }
}

function renderAiPauseBanner() {
  const banner = $("#aiPauseBanner");
  if (!banner) return;
  if (!aiPause?.anyActive) {
    banner.hidden = true;
    banner.innerHTML = "";
    return;
  }
  const notes = [];
  if (aiPause.global?.active) {
    notes.push(`toàn bộ cuộc trò chuyện (${pauseUntilText(aiPause.global)}${aiPause.global.reason ? ` · ${aiPause.global.reason}` : ""})`);
  }
  const chatCount = (aiPause.chats || []).filter((entry) => entry.active).length;
  if (chatCount) notes.push(`${chatCount} cuộc trò chuyện riêng lẻ`);
  banner.hidden = false;
  banner.innerHTML = `<strong>Trợ lý AI đang tạm dừng</strong> — ${escapeHtml(notes.join(" · "))}. Lệnh "/" và thông báo theo lịch vẫn chạy bình thường. <button type="button" id="aiPauseBannerResume">Bật lại</button>`;
  $("#aiPauseBannerResume")?.addEventListener("click", resumeAllAiPause);
}

function renderAiPausePanel() {
  const status = $("#aiPauseStatus");
  const body = $("#aiPauseBody");
  if (!body) return;
  const globalActive = aiPause?.global?.active === true;
  if (status) {
    status.innerHTML = globalActive
      ? badge("Đang tạm dừng toàn bộ", "warning")
      : badge("Đang hoạt động", "success");
  }

  const activeChats = (aiPause.chats || []).filter((entry) => entry.active);
  body.innerHTML = `
    <div class="ai-pause-controls">
      <label>Thời gian<select id="aiPauseMinutes">${aiPauseDurationOptions()}</select></label>
      <label>Lý do (tuỳ chọn)<input type="text" id="aiPauseReason" maxlength="200" placeholder="Ví dụ: đang trực hỗ trợ qua Zalo" /></label>
      ${globalActive
        ? `<button type="button" class="primary small" id="aiPauseGlobalResume">Bật lại trợ lý</button>`
        : `<button type="button" class="primary small" id="aiPauseGlobalStart">Tạm dừng toàn bộ</button>`}
    </div>
    <p class="ai-pause-hint">${globalActive
      ? `Đang tạm dừng ${escapeHtml(pauseUntilText(aiPause.global))}${aiPause.global.reason ? ` · ${escapeHtml(aiPause.global.reason)}` : ""}. Hết thời gian trên, trợ lý tự chạy lại — không cần thao tác gì thêm.`
      : "Trợ lý trả lời tin nhắn tự nhiên như bình thường. Tạm dừng chỉ ảnh hưởng phần hội thoại AI."}</p>
    <div class="ai-pause-list stack">
      ${activeChats.length
        ? activeChats.map((entry) => `<article class="stack-item horizontal"><div><strong>${escapeHtml(entry.chatId)}</strong><small>${escapeHtml(entry.botId)} · ${escapeHtml(pauseUntilText(entry))}${entry.reason ? ` · ${escapeHtml(entry.reason)}` : ""}</small></div><button type="button" data-ai-pause-resume-chat="${escapeHtml(entry.key)}">Bật lại</button></article>`).join("")
        : `<div class="empty-state">Không có cuộc trò chuyện nào bị tạm dừng riêng lẻ. Tạm dừng một cuộc trò chuyện trong tab Chat Center.</div>`}
    </div>`;

  $("#aiPauseGlobalStart")?.addEventListener("click", () => applyAiPause({
    scope: "global",
    paused: true,
    minutes: Number($("#aiPauseMinutes")?.value) || 0,
    reason: $("#aiPauseReason")?.value || ""
  }, "Đã tạm dừng trợ lý AI."));
  $("#aiPauseGlobalResume")?.addEventListener("click", () => applyAiPause({ scope: "global", paused: false }, "Đã bật lại trợ lý AI."));
  $$('[data-ai-pause-resume-chat]').forEach((button) => button.addEventListener("click", () => {
    const key = button.dataset.aiPauseResumeChat || "";
    const separator = key.indexOf("::");
    applyAiPause({ scope: "chat", botId: separator > 0 ? key.slice(0, separator) : key, chatId: separator > 0 ? key.slice(separator + 2) : "", paused: false }, "Đã bật lại trợ lý ở cuộc trò chuyện này.");
  }));
}

function renderAiPause() {
  renderAiPauseBanner();
  renderAiPausePanel();
}

function renderAll() { populateBotControls(); renderBotGrid(); renderOverview(); renderDirectory(); renderUsers(); renderGroups(); renderNotifications(); renderHealth(); renderSettings(); renderAiPause(); renderLogs(); setupCommandConsole(); renderCommands(); setupFeedback(); renderFeedback(); setupSourceVerification(); ensurePaginationViews(); applyPaginationViews(); $("#healthPill").textContent = `${dashboard.bot.status} · ${dashboard.bot.health}`; $("#generatedAt").textContent = formatDate(workspace.generatedAt); }

async function loadData() {
  setDataState("loading", "Loading admin data...");
  try {
    // Danh sách user cho Command console: ưu tiên endpoint đã khử trùng,
    // dự phòng bằng dữ liệu workspace đã tải.
    const targetUserRequest = api("/api/admin/target-users").then((data) => (Array.isArray(data.users) ? data.users : null)).catch(() => null);
    const botRequest = api("/api/admin/bots").then((data) => (Array.isArray(data.bots) ? data.bots : [])).catch(() => []);
    // Trạng thái tạm dừng trợ lý AI: hỏng endpoint này KHÔNG được làm hỏng cả
    // dashboard, nên có giá trị dự phòng "đang bật".
    const aiPauseRequest = api("/api/admin/ai-pause").then((data) => data.pause).catch(() => null);
    [workspace, dashboard, logs, settings, commandRegistry] = await Promise.all([api("/api/admin/workspace"), api("/api/admin/dashboard"), api("/api/admin/logs"), api("/api/admin/settings"), api("/api/admin/commands").then((data) => data.commands || [])]);
    bots = await botRequest;
    const remoteAiPause = await aiPauseRequest;
    if (remoteAiPause) aiPause = remoteAiPause;
    const remoteTargetUsers = await targetUserRequest;
    targetUsers = mergeTargetUsers(remoteTargetUsers === null ? targetUsersFromWorkspace(workspace) : remoteTargetUsers);
    renderAll();
    await loadFeedback();
    applyTargetUserState();
    setDataState("success", "Updated just now");
    window.setTimeout(() => setDataState("success", ""), 1800);
  } catch (error) {
    setDataState("error", error.message || "Unable to load admin data");
    throw error;
  }
}

function showDialog(title, body) { $("#dialogTitle").textContent = title; $("#dialogBody").innerHTML = body; if (!$("#detailDialog").open) $("#detailDialog").showModal(); }

function openCreateChat() {
  showDialog("Thêm chat", `<form id="createChatForm"><div class="form-grid"><label>Chat ID<input name="chatId" required /></label><label>User ID<input name="userId" /></label><label>Display name<input name="displayName" /></label><label>Type<select name="chatType"><option value="unknown">Unknown</option><option value="private">Private</option><option value="group">Group</option></select></label><label>Status<select name="status"><option value="active">Active</option><option value="disabled">Disabled</option><option value="inactive">Inactive</option></select></label></div><button class="primary" type="submit">Tạo chat</button></form>`);
  $("#createChatForm").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); await api("/api/admin/chats", { method: "POST", body: JSON.stringify(Object.fromEntries(form.entries())) }); $("#detailDialog").close(); await loadData(); });
}

function openCreateUser() {
  showDialog("Thêm user", `<form id="createUserForm"><div class="form-grid"><label>User ID<input name="userId" required /></label><label>Display name<input name="displayName" /></label><label>Chat ID<input name="chatId" required /></label><label>Chat title<input name="chatTitle" /></label><label>Chat type<select name="chatType"><option value="unknown">Unknown</option><option value="private">Private</option><option value="group">Group</option></select></label></div><button class="primary" type="submit">Thêm user vào chat</button></form>`);
  $("#createUserForm").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); await api("/api/admin/users", { method: "POST", body: JSON.stringify(Object.fromEntries(form.entries())) }); $("#detailDialog").close(); await loadData(); });
}

// Chốt an toàn ở tầng mở chi tiết.
//
// Nút thao tác trên bản ghi chưa xác minh đã bị vô hiệu, nhưng đây là lớp thứ hai:
// nếu vì lý do gì đó vẫn vào được, phải chặn thay vì gửi botId rỗng lên API — gửi
// thiếu botId có thể khiến thao tác rơi vào một bot khác.
function requireVerifiedSource(botId, what = "bản ghi này", record = null) {
  if (botId) return true;

  // Hộp thoại phải MỞ ĐƯỢC ĐƯỜNG RA, không chỉ báo lỗi.
  //
  // Bản trước chỉ nói "chạy npm run migrate:attribution" — người dùng bị kẹt vì
  // không biết rằng ngay trên dòng đó có nút "Xác minh nguồn" để gán tay.
  const store = record?.sourceStoreId || "";
  const key = record?.sourceRecordKey || "";
  const reason = record?.sourceReason
    || "Bản ghi này không có trường botId và khóa lưu trữ cũng không có phạm vi, nên chưa xác định được nó thuộc tài khoản nào.";

  const action = store && key
    ? `<p class="muted">Cách xử lý: xem bằng chứng, chọn tài khoản cho bản ghi này, rồi thao tác lại.</p>` +
      `<div class="row-actions"><button class="primary small" type="button" data-open-verify="1">Xác minh nguồn ngay</button></div>`
    : `<p class="muted">Dòng này không gắn với bản ghi lưu trữ nào nên không xác minh trực tiếp được. ` +
      `Chạy <code>npm run migrate:attribution</code> để xem báo cáo (chạy thử, không ghi), ` +
      `rồi <code>npm run migrate:attribution-apply</code> nếu báo cáo chỉ ra bằng chứng.</p>`;

  showDialog("Chưa xác minh nguồn",
    `<div class="empty-state"><p><strong>Không thể thao tác trên ${escapeHtml(what)}.</strong></p>` +
    `<p class="muted">${escapeHtml(reason)} Thao tác lúc này có thể gửi tin cho nhầm người hoặc nhầm tài khoản.</p>` +
    action +
    `<p class="muted">Nhiều dòng cùng lỗi: dùng nút <strong>Xác minh nguồn</strong> ở cột thao tác của từng dòng.</p></div>`);

  if (store && key) {
    $("#dialogBody").querySelector("[data-open-verify]")?.addEventListener("click", () => {
      openVerifySource(store, key);
    });
  }
  return false;
}

function openUser(userId, botId) {
  // Cùng một User ID ở hai bot là hai danh tính khác nhau, nên phải khớp cả bot.
  const wantedBot = recordBotId({ botId });
  // Tra bản ghi TRƯỚC khi chặn: hộp thoại cần store/key để mở thẳng phần xác minh.
  const user = workspace.users.find((item) => item.userId === userId && recordBotId(item) === wantedBot);
  if (!requireVerifiedSource(wantedBot, "người dùng này", user)) return;
  if (!user) return;
  showDialog(user.displayName, `<div class="detail-grid"><div class="detail"><span>Bot</span><strong>${escapeHtml(botLabel(wantedBot))}</strong></div><div class="detail"><span>User ID</span><code>${escapeHtml(user.userId)}</code></div><div class="detail"><span>MSSV</span><strong>${escapeHtml(user.studentIds.join(", ") || "Chưa có MSSV")}</strong></div><div class="detail"><span>Tương tác đầu tiên</span><strong>${escapeHtml(formatDate(user.firstInteractionAt))}</strong></div><div class="detail"><span>Hoạt động gần nhất</span><strong>${escapeHtml(formatDate(user.lastInteractionAt))}</strong></div></div><h3>Ngữ cảnh chat</h3><div class="stack">${user.chats.map((chat) => `<article class="stack-item"><form class="userContextForm" data-user-chat="${escapeHtml(chat.chatId)}"><div class="form-grid"><label>Tên hiển thị<input name="displayName" value="${escapeHtml(user.displayName)}" /></label><label>Trạng thái thành viên<select name="status"><option value="active" ${chat.memberStatus === "active" ? "selected" : ""}>Đang hoạt động</option><option value="disabled" ${chat.memberStatus === "disabled" ? "selected" : ""}>Đã tắt</option><option value="removed" ${chat.memberStatus === "removed" ? "selected" : ""}>Đã xóa</option></select></label></div><p>${escapeHtml(chat.chatType)} · chat ${escapeHtml(chat.status)} · <code>${escapeHtml(chat.chatId)}</code></p><div class="row-actions"><button type="submit">Lưu người dùng</button><button type="button" data-open-chat="${escapeHtml(chat.chatId)}">Mở chat</button><button type="button" data-user-admin="${escapeHtml(chat.chatId)}">Cấp quyền admin</button><button type="button" class="danger-text" data-user-remove="${escapeHtml(chat.chatId)}">Xóa khỏi chat</button></div></form></article>`).join("")}</div><h3>Đăng ký nhận lịch</h3><div class="stack">${user.subscriptions.map((item) => `<article class="stack-item horizontal"><div><strong>${escapeHtml(item.studentId || "Chưa có MSSV")} · ${escapeHtml(item.chatName)}</strong><p>${escapeHtml(item.notificationsEnabled ? "Đang bật" : "Đang tắt")} · ${escapeHtml(item.notificationTimes.map((time) => `${time.time} ${targetDayLabel(time.targetDayOffset)}`).join(", ") || "Chưa có giờ nhận lịch")}</p></div><button data-open-sub="${escapeHtml(item.key)}">Quản lý</button></article>`).join("") || `<div class="empty-state">Không có đăng ký nhận lịch.</div>`}</div>`);
  $$('.userContextForm').forEach((form) => form.addEventListener("submit", async (event) => { event.preventDefault(); const values = new FormData(event.currentTarget); await runAction(async () => { await api(`/api/admin/users/${encodeURIComponent(userId)}`, { method: "PATCH", body: JSON.stringify({ botId: wantedBot, chatId: event.currentTarget.dataset.userChat, displayName: values.get("displayName"), status: values.get("status") }) }); $("#detailDialog").close(); await loadData(); }, "Không lưu được thông tin người dùng"); }));
  $$('[data-user-admin]').forEach((button) => button.addEventListener("click", async () => { await runAction(async () => { await api("/api/admin/settings/admins", { method: "POST", body: JSON.stringify({ userId, chatId: button.dataset.userAdmin, displayName: user.displayName }) }); await loadData(); }, "Không cấp được quyền admin"); }));
  $$('[data-user-remove]').forEach((button) => button.addEventListener("click", async () => { if (!confirm(`Xóa user ${userId} khỏi chat ${button.dataset.userRemove}? Subscription của user trong chat cũng sẽ bị xóa.`)) return; await runAction(async () => { await api(`/api/admin/users/${encodeURIComponent(userId)}?hard=1&chatId=${encodeURIComponent(button.dataset.userRemove)}&botId=${encodeURIComponent(wantedBot)}`, { method: "DELETE" }); $("#detailDialog").close(); await loadData(); }, "Không xóa được người dùng khỏi chat"); }));
  $$('[data-open-chat]').forEach((button) => button.addEventListener("click", () => openChat(button.dataset.openChat, wantedBot)));
  $$('[data-open-sub]').forEach((button) => button.addEventListener("click", () => openSubscription(button.dataset.openSub)));
}

async function openChat(chatId, botId) {
  const verifiedBotId = recordBotId({ botId });
  const chatRecord = workspace.chats.find((item) => item.chatId === chatId && recordBotId(item) === verifiedBotId);
  if (!requireVerifiedSource(verifiedBotId, "cuộc trò chuyện này", chatRecord)) return;
  const scoped = `botId=${encodeURIComponent(verifiedBotId)}`;
  const data = await api(`/api/admin/chats/${encodeURIComponent(chatId)}?${scoped}`); const chat = data.chat;
  showDialog(chat.displayName || chat.chatId, `<form id="chatMetadataForm"><div class="form-grid"><label>Chat ID<input value="${escapeHtml(chat.chatId)}" disabled /></label><label>User ID<input name="userId" value="${escapeHtml(chat.userId || "")}" /></label><label>Display name<input name="displayName" value="${escapeHtml(chat.displayName || "")}" /></label><label>Type<select name="chatType"><option value="private" ${chat.chatType === "private" ? "selected" : ""}>Private</option><option value="group" ${chat.chatType === "group" ? "selected" : ""}>Group</option><option value="unknown" ${chat.chatType === "unknown" ? "selected" : ""}>Unknown</option></select></label></div><button class="primary" type="submit">Lưu metadata</button></form><div class="action-bar"><button data-chat-status="active">Reactivate</button><button data-chat-status="disabled">Disable</button><button data-chat-status="removed">Soft remove</button><button data-chat-retry="1">Retry</button><button data-make-admin="1">Make admin</button><button class="danger-text" data-chat-hard-delete="1">Xóa vĩnh viễn</button></div><div class="detail-grid"><div class="detail"><span>Bot</span><strong>${escapeHtml(botLabel(recordBotId({ botId })))}</strong></div><div class="detail"><span>Last inbound</span><strong>${escapeHtml(formatDate(chat.lastInboundInteractionAt))}</strong></div><div class="detail"><span>Last success</span><strong>${escapeHtml(formatDate(chat.lastSuccessfulDeliveryAt))}</strong></div><div class="detail"><span>Last error</span><strong>${escapeHtml(chat.lastError?.message || "-")}</strong></div><div class="detail"><span>Error time</span><strong>${escapeHtml(formatDate(chat.lastError?.at))}</strong></div></div><h3>Members & MSSV</h3><div class="stack">${(data.members || []).map((user) => `<article class="stack-item"><strong>${escapeHtml(user.displayName)}</strong><p><code>${escapeHtml(user.userId)}</code> · ${escapeHtml(user.studentIds.join(", ") || "No MSSV")}</p></article>`).join("") || `<div class="empty-state">Không có member record.</div>`}</div><h3>Subscriptions</h3><div class="stack">${(data.subscriptions || []).map((item) => `<article class="stack-item horizontal"><div><strong>${escapeHtml(item.userDisplayName || item.userId || "Legacy")}</strong><p>${escapeHtml(item.studentId || "No MSSV")} · ${escapeHtml(item.notificationTimes.map((time) => `${time.time} ${targetDayLabel(time.targetDayOffset)}`).join(", ") || "No times")}</p></div><button data-open-sub="${escapeHtml(item.key)}">Quản lý</button></article>`).join("") || `<div class="empty-state">Không có subscription.</div>`}</div>`);
  $("#chatMetadataForm").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); await runAction(async () => { await api(`/api/admin/chats/${encodeURIComponent(chatId)}`, { method: "PATCH", body: JSON.stringify({ botId: recordBotId({ botId }), action: "metadata", userId: form.get("userId"), displayName: form.get("displayName"), chatType: form.get("chatType") }) }); $("#detailDialog").close(); await loadData(); }, "Không lưu được metadata chat"); });
  $$('[data-chat-status]').forEach((button) => button.addEventListener("click", async () => { await runAction(async () => { await api(`/api/admin/chats/${encodeURIComponent(chatId)}`, { method: "PATCH", body: JSON.stringify({ botId: recordBotId({ botId }), action: "status", status: button.dataset.chatStatus }) }); $("#detailDialog").close(); await loadData(); }, "Không đổi được trạng thái chat"); }));
  $('[data-chat-retry]').addEventListener("click", async () => { await runAction(async () => { await api(`/api/admin/chats/${encodeURIComponent(chatId)}/retry?botId=${encodeURIComponent(recordBotId({ botId }))}`, { method: "POST" }); $("#detailDialog").close(); await loadData(); }, "Không gửi lại được tin thử"); });
  $('[data-make-admin]').addEventListener("click", async () => { await runAction(async () => { await api("/api/admin/settings/admins", { method: "POST", body: JSON.stringify({ userId: chat.userId || "", chatId: chat.chatId, displayName: chat.displayName }) }); await loadData(); }, "Không cấp được quyền admin"); });
  $('[data-chat-hard-delete]').addEventListener("click", async () => {
    // Nói rõ khác biệt trước khi xoá: "Soft remove" chỉ đổi trạng thái, còn thao
    // tác này xoá bản ghi trong sổ chat. Cả hai đều KHÔNG xoá đăng ký nhận lịch
    // hay lịch sử tương tác.
    if (!confirm(
      `Xoá vĩnh viễn ${chatId} khỏi sổ chat của ${botLabel(recordBotId({ botId }))}?\n\n` +
      "• Bản ghi trong sổ chat sẽ bị xoá và chat không hiện lại trên dashboard.\n" +
      "• Đăng ký nhận lịch và lịch sử tương tác VẪN ĐƯỢC GIỮ.\n" +
      "• Không ảnh hưởng tới bot khác.\n\n" +
      "Nếu chỉ muốn ngừng gửi tin, hãy dùng \"Soft remove\"."
    )) return;

    const outcome = await runAction(async () => {
      const result = await api(`/api/admin/chats/${encodeURIComponent(chatId)}?hard=1&botId=${encodeURIComponent(recordBotId({ botId }))}`, { method: "DELETE" });
      $("#detailDialog").close();
      await loadData();
      return result;
    }, "Không xoá được chat");

    if (outcome.ok) setDataState("success", outcome.result?.message || "Đã xoá chat.");
  });
  $$('[data-open-sub]').forEach((button) => button.addEventListener("click", () => openSubscription(button.dataset.openSub)));
}

function openSubscription(key) {
  const item = workspace.subscriptions.find((entry) => entry.key === key); if (!item) return;
  showDialog(`${item.studentId || "Đăng ký nhận lịch"} · ${item.chatName}`, `<div class="detail-grid"><div class="detail"><span>Người dùng</span><strong>${escapeHtml(item.userDisplayName || item.userId || "Bản ghi cũ")}</strong><code>${escapeHtml(item.userId || "-")}</code></div><div class="detail"><span>Chat</span><strong>${escapeHtml(item.chatName)}</strong><code>${escapeHtml(item.chatId)}</code></div><div class="detail"><span>Loại chat</span><strong>${escapeHtml(item.chatType)}</strong></div><div class="detail"><span>Cập nhật bản ghi</span><strong>${escapeHtml(formatDate(item.updatedAt))}</strong></div></div>${item.schema === "legacy" ? `<div class="warning-box">Bản ghi cũ không có userId rõ ràng; chỉ nên xem hoặc xóa.</div>` : `<form id="subscriptionMetaForm"><div class="form-grid"><label>MSSV<input name="studentId" value="${escapeHtml(item.studentId)}" /></label><label>Tên sinh viên<input name="studentName" value="${escapeHtml(item.studentName)}" /></label><label>Tên người dùng<input name="userDisplayName" value="${escapeHtml(item.userDisplayName)}" /></label></div><button class="primary" type="submit">Lưu thông tin</button></form><h3>Giờ nhận lịch</h3><div class="stack">${item.notificationTimes.map((time) => `<article class="stack-item horizontal"><div><strong>ID ${time.id} · ${escapeHtml(time.time)}</strong><small>${escapeHtml(targetDayText(time.targetDayOffset))} · đăng ký ${escapeHtml(formatDate(time.createdAt))} · cập nhật ${escapeHtml(formatDate(time.updatedAt))}</small></div><div class="row-actions"><button data-time-edit="${time.id}">Sửa</button><button class="danger-text" data-time-remove="${time.id}">Xóa</button></div></article>`).join("") || `<div class="empty-state">Chưa có giờ nhận lịch.</div>`}<button class="secondary" id="addTimeButton">Thêm giờ</button></div><div class="action-bar"><button data-sub-action="${item.notificationsEnabled ? "disable" : "enable"}">${item.notificationsEnabled ? "Tắt nhận lịch" : "Bật nhận lịch"}</button><button data-sub-test-send="1">Gửi thử tới chat này</button><button class="danger-text" data-sub-action="delete">Xóa đăng ký</button></div>`}`);
  if (item.schema === "legacy") return;
  $("#subscriptionMetaForm").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); await updateSubscription(item, { action: "metadata", ...Object.fromEntries(form.entries()) }); });
  $("#addTimeButton").addEventListener("click", () => openTimeDialog({ item }));
  $$('[data-time-edit]').forEach((button) => button.addEventListener("click", () => openTimeDialog({ item, time: item.notificationTimes.find((entry) => Number(entry.id) === Number(button.dataset.timeEdit)) })));
  $$('[data-time-remove]').forEach((button) => button.addEventListener("click", () => updateSubscription(item, { action: "remove_time", timeId: Number(button.dataset.timeRemove) })));
  $$('[data-sub-action]').forEach((button) => button.addEventListener("click", () => updateSubscription(item, { action: button.dataset.subAction, studentId: item.studentId, studentName: item.studentName })));

  // Gửi một tin THỬ tới đúng chat của đăng ký này.
  //
  // Đây là câu trả lời nhanh nhất cho "Chat Center ghi đã gửi mà Zalo không thấy":
  // nếu tin thử tới được thì đường gửi còn sống và vấn đề nằm ở thời điểm/nội dung
  // của lượt gửi cũ; nếu tin thử cũng không tới thì chat này đã mất liên kết với
  // bot (người dùng chặn, đổi tài khoản, hoặc chat ID cũ) — không phải lỗi lịch.
  $('[data-sub-test-send]')?.addEventListener("click", async () => {
    const botId = recordBotId(item);
    if (!requireVerifiedSource(botId, "đăng ký này", item)) return;
    const outcome = await runAction(
      () => api(`/api/admin/chats/${encodeURIComponent(item.chatId)}/retry?botId=${encodeURIComponent(botId)}`, { method: "POST" }),
      "Không gửi thử được tới chat này"
    );
    if (!outcome.ok) return;
    setDataState("success", `Đã gửi tin thử tới chat ${item.chatId}. Nếu Zalo không hiện tin này, chat đã mất liên kết với bot — kiểm tra tài khoản người nhận trước khi kết luận lịch gửi sai.`);
  });
}

// Hộp thoại thêm/sửa một mốc nhận lịch. Bắt buộc chọn ngày đích, đúng như lệnh
// chat: homnay (0) hoặc homsau (1).
function openTimeDialog({ item, time }) {
  const isEdit = Boolean(time);
  showDialog(isEdit ? `Sửa mốc ID ${time.id}` : "Thêm giờ nhận lịch", `
    <form id="timeForm">
      <div class="form-grid">
        <label>Giờ nhận lịch (HH:mm)
          <input name="time" value="${escapeHtml(time?.time || "06:00")}" placeholder="06:30" required />
        </label>
        <label>Ngày đích
          <select name="targetDayOffset">
            <option value="0" ${Number(time?.targetDayOffset) === 0 ? "selected" : ""}>homnay — lịch hôm nay</option>
            <option value="1" ${Number(time?.targetDayOffset) === 1 ? "selected" : ""}>homsau — lịch hôm sau</option>
          </select>
        </label>
      </div>
      <p class="muted">Cùng một giờ có thể đăng ký cho cả hai ngày đích; hai mốc này độc lập với nhau.</p>
      <button class="primary" type="submit">${isEdit ? "Lưu mốc" : "Thêm mốc"}</button>
      <p id="timeFormError" class="error"></p>
    </form>`);
  $("#timeForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    try {
      await updateSubscription(item, isEdit
        ? { action: "update_time", timeId: Number(time.id), time: values.get("time"), targetDayOffset: Number(values.get("targetDayOffset")) }
        : { action: "add_time", time: values.get("time"), targetDayOffset: Number(values.get("targetDayOffset")), studentId: item.studentId, studentName: item.studentName });
    } catch (error) {
      $("#timeFormError").textContent = error.message;
    }
  });
}

async function updateSubscription(item, changes) { await api("/api/admin/subscriptions", { method: "PATCH", body: JSON.stringify({ botId: recordBotId(item), chatId: item.chatId, userId: item.userId, userDisplayName: item.userDisplayName, ...changes }) }); $("#detailDialog").close(); await loadData(); }

$("#loginForm").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api("/api/admin/auth/login", { method: "POST", body: JSON.stringify(Object.fromEntries(form.entries())) }); showAuthenticated(true); await loadData(); } catch (error) { $("#loginError").textContent = error.message; } });
$("#logoutButton").addEventListener("click", async () => { await api("/api/admin/auth/logout", { method: "POST" }); showAuthenticated(false); });
$("#refreshButton").addEventListener("click", loadData);
// Đổi bộ lọc bot: vẽ lại danh sách theo bot đã chọn.
$("#groupPolicySave")?.addEventListener("click", async () => {
  const chatId = ($("#groupPolicyChatId")?.value || "").trim();
  const mode = $("#groupPolicyMode")?.value || "ingest";
  // Phải biết áp dụng cho BOT nào: cùng một chatId ở hai bot là hai nhóm khác nhau.
  const botId = activeBotFilter();
  if (!chatId) return setDataState("error", "Nhập Chat ID của nhóm cần áp dụng.");
  if (botId === "all" || botId === UNVERIFIED_BOT_ID) {
    return setDataState("error", "Chọn một bot cụ thể ở bộ lọc phía trên trước khi áp dụng cho Chat ID nhập tay.");
  }
  await setGroupReplyMode(botId, chatId, mode);
});

$("#botFilter").addEventListener("change", () => { if (workspace) renderAll(); }); $("#themeToggle").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
$("#closeDialog").addEventListener("click", () => $("#detailDialog").close());
const rerender = (fn, key) => { pageState[key] = { ...(pageState[key] || {}), page: 1 }; fn(); applyPaginationViews(); };
$("#userSearch").addEventListener("input", () => rerender(renderUsers, "users")); $("#groupSearch").addEventListener("input", () => rerender(renderGroups, "groups")); $("#notificationFilter").addEventListener("change", () => rerender(renderNotifications, "notifications")); $("#notificationSearch").addEventListener("input", () => rerender(renderNotifications, "notifications")); $("#healthFilter").addEventListener("change", () => rerender(renderHealth, "health")); $("#healthType").addEventListener("change", () => rerender(renderHealth, "health"));

// Logs & audit: tìm kiếm và lọc dùng chung cho cả bốn danh sách, nên mọi thay đổi
// đều đưa tất cả về trang 1 — nếu không, người dùng lọc xong sẽ nhìn thấy trang 3
// của một danh sách chỉ còn 2 dòng.
function rerenderLogs() {
  for (const key of ["systemLogs", "deliveryLogs", "deliveryTraces", "auditLogs"]) pageState[key] = { ...(pageState[key] || {}), page: 1 };
  renderLogs();
  applyPaginationViews();
}
async function reloadLogs() {
  const outcome = await runAction(() => api("/api/admin/logs?limit=500"), "Không tải lại được log");
  if (!outcome.ok) return;
  logs = outcome.result;
  rerenderLogs();
}
$("#logSearch")?.addEventListener("input", rerenderLogs);
$("#logLevel")?.addEventListener("change", rerenderLogs);
$("#logResult")?.addEventListener("change", rerenderLogs);
$("#logRefresh")?.addEventListener("click", reloadLogs);
$("#directorySearch").addEventListener("input", () => rerender(renderDirectory, "directory")); $("#directoryType").addEventListener("change", () => rerender(renderDirectory, "directory")); $("#addChatButton").addEventListener("click", openCreateChat);
$("#addUserButton").addEventListener("click", openCreateUser);
$("#adminForm").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api("/api/admin/settings/admins", { method: "POST", body: JSON.stringify(Object.fromEntries(form.entries())) }); event.currentTarget.reset(); $("#adminFormMessage").textContent = "Đã lưu."; await loadData(); } catch (error) { $("#adminFormMessage").textContent = error.message; } });
// Command console tự gắn trình xử lý submit trong setupCommandConsole() vì nó
// cần đọc danh sách người nhận đã chọn và đi qua bước xác nhận.
$("#commandAdminIdentity")?.addEventListener("change", () => {});
$$('.tab-button').forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));
applyTheme(localStorage.getItem("zalobot-admin-theme") || "dark");
// Việc khôi phục tab đã lưu được làm ở CUỐI tệp (xem dưới): nó gọi switchTab(),
// mà switchTab lại chạm tới các biến khai báo bằng `let` ở phần Chat Center.
// Chạy tại đây thì những biến đó chưa được khởi tạo và cả dashboard trắng.
loadData().then(() => showAuthenticated(true)).catch((error) => { showAuthenticated(false); if (error.status !== 401) $("#loginError").textContent = error.message; });

/* ---------------------------------------------------------------------------
   Feedback / Support

   Danh tính hội thoại là (botId, ticketId). Mọi thao tác đọc/ghi đều gửi kèm
   botId, vì chat ID chỉ có nghĩa trong phạm vi một bot — thiếu botId là có thể
   mở hoặc trả lời nhầm yêu cầu của bot khác.
   --------------------------------------------------------------------------- */

function feedbackQuery() {
  const params = new URLSearchParams();
  const botId = $("#feedbackBotFilter")?.value || "";
  const status = $("#feedbackStatusFilter")?.value || "all";
  const search = $("#feedbackSearch")?.value || "";
  const unread = $("#feedbackUnreadFilter")?.value || "false";
  if (botId) params.set("botId", botId);
  if (status !== "all") params.set("status", status);
  if (search.trim()) params.set("search", search.trim());
  if (unread === "true") params.set("unread", "true");
  return params.toString();
}

async function loadFeedback() {
  try {
    const data = await api(`/api/admin/feedback${feedbackQuery() ? `?${feedbackQuery()}` : ""}`);
    feedbackTickets = Array.isArray(data.tickets) ? data.tickets : [];
    feedbackCounts = data.counts || { total: 0, unread: 0, open: 0, resolved: 0 };
  } catch (error) {
    feedbackTickets = [];
    feedbackCounts = { total: 0, unread: 0, open: 0, resolved: 0 };
    console.warn("Không tải được yêu cầu hỗ trợ:", error.message);
  }
  renderFeedback();
}

function feedbackStatusBadge(ticket) {
  if (ticket.status === "resolved") return badge("Đã xử lý", "success");
  if (ticket.unread) return badge("Chưa đọc", "warning");
  return badge("Đang mở", "info");
}

function feedbackSnippet(value) {
  // Nội dung do người dùng gửi: escape trước khi hiển thị để không chèn được HTML.
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return escapeHtml(text.length > 60 ? `${text.slice(0, 59)}…` : text);
}

function renderFeedback() {
  const countsTarget = $("#feedbackCounts");
  if (countsTarget) {
    countsTarget.innerHTML = [
      { label: "Tổng", value: feedbackCounts.total ?? 0 },
      { label: "Chưa đọc", value: feedbackCounts.unread ?? 0 },
      { label: "Đang mở", value: feedbackCounts.open ?? 0 },
      { label: "Đã xử lý", value: feedbackCounts.resolved ?? 0 }
    ].map((item) => `<article class="metric-card"><span>${escapeHtml(item.label)}</span><strong>${Number(item.value) || 0}</strong></article>`).join("");
  }

  // Bộ lọc bot dùng chung danh sách bot đã tải, giữ nguyên lựa chọn hiện tại.
  const botFilter = $("#feedbackBotFilter");
  if (botFilter) {
    const current = botFilter.value;
    const options = ['<option value="">Mọi bot</option>'].concat(
      bots.map((bot) => `<option value="${escapeHtml(bot.botId)}">${escapeHtml(bot.label || bot.displayName || bot.botId)}</option>`)
    );
    botFilter.innerHTML = options.join("");
    botFilter.value = current;
  }

  const rows = $("#feedbackRows");
  if (rows) {
    if (!feedbackTickets.length) {
      rows.innerHTML = emptyRow(6, "Chưa có yêu cầu hỗ trợ nào.");
    } else {
      rows.innerHTML = feedbackTickets.map((ticket) => {
        const selected = selectedFeedback && selectedFeedback.ticketId === ticket.ticketId && selectedFeedback.botId === ticket.botId;
        const bot = bots.find((item) => item.botId === ticket.botId);
        return `<tr class="${selected ? "row-selected" : ""}"><td><code>${escapeHtml(ticket.ticketId)}</code></td>` +
          `<td>${escapeHtml(bot?.label || ticket.botId)}</td>` +
          `<td>${escapeHtml(ticket.displayName || ticket.userId || "-")}<br><small class="muted">${escapeHtml(ticket.chatId)}</small></td>` +
          `<td>${feedbackSnippet(ticket.message)}</td>` +
          `<td>${feedbackStatusBadge(ticket)}</td>` +
          `<td>${escapeHtml(formatDate(ticket.updatedAt))}</td></tr>`;
      }).join("");
      $$("[data-feedback-open]").forEach((node) => node.remove());
      rows.querySelectorAll("tr").forEach((row, index) => {
        row.addEventListener("click", () => openFeedbackTicket(feedbackTickets[index]));
      });
    }
  }
}

async function openFeedbackTicket(ticket) {
  if (!ticket) return;
  try {
    const data = await api(`/api/admin/feedback/detail?botId=${encodeURIComponent(ticket.botId)}&ticketId=${encodeURIComponent(ticket.ticketId)}`);
    selectedFeedback = data.ticket;
    feedbackCounts = data.counts || feedbackCounts;
    renderFeedbackDetail();
    renderFeedback();
  } catch (error) {
    setDataState("error", error.message || "Không mở được yêu cầu");
  }
}

function renderFeedbackDetail() {
  const thread = $("#feedbackThread");
  const form = $("#feedbackReplyForm");
  const hint = $("#feedbackDetailHint");
  const target = $("#feedbackReplyTarget");
  if (!thread || !form) return;

  if (!selectedFeedback) {
    thread.innerHTML = "";
    form.classList.add("hidden");
    if (hint) hint.textContent = "Chưa chọn yêu cầu nào.";
    return;
  }

  const ticket = selectedFeedback;
  const bot = bots.find((item) => item.botId === ticket.botId);
  if (hint) {
    hint.textContent = `${ticket.ticketId} · ${ticket.chatType === "group" ? "nhóm" : "chat riêng"} · ${ticket.status === "resolved" ? "đã xử lý" : "đang mở"}`;
  }

  const messages = [
    {
      author: "user", at: ticket.createdAt,
      name: ticket.displayName || ticket.userId || "người dùng",
      message: ticket.message, deliveryStatus: null, error: null
    },
    ...(ticket.replies || [])
  ];

  thread.innerHTML = messages.map((item) => {
    const isAdmin = item.author === "admin";
    const status = isAdmin ? replyDeliveryBadge(item) : "";
    return `<article class="thread-message ${isAdmin ? "from-admin" : "from-user"}">` +
      `<header><strong>${escapeHtml(isAdmin ? (item.adminName || "quản trị viên") : item.name)}</strong><span class="muted">${escapeHtml(formatDate(item.at))}</span>${status}</header>` +
      `<p>${escapeHtml(item.message).replace(/\n/g, "<br>")}</p></article>`;
  }).join("");

  // Nói rõ trước khi gửi: trả lời sẽ đi tới bot nào và cuộc trò chuyện nào.
  if (target) {
    target.innerHTML = `<p class="muted">Trả lời sẽ được gửi tới:</p><dl><div><dt>Bot</dt><dd>${escapeHtml(bot?.label || ticket.botId)}</dd></div><div><dt>Cuộc trò chuyện</dt><dd><code>${escapeHtml(ticket.chatId)}</code></dd></div><div><dt>Loại</dt><dd>${ticket.chatType === "group" ? "Nhóm" : "Chat riêng"}</dd></div></dl>`;
  }
  form.classList.remove("hidden");
}

// Trạng thái gửi của một trả lời. Chỉ hiện "Đã gửi" khi Zalo thực sự nhận.
function replyDeliveryBadge(item) {
  if (item.deliveryStatus === "sent") return badge("Đã gửi", "success");
  if (item.deliveryStatus === "failed") {
    return badge("Gửi lỗi", "danger") + `<span class="error-cell">${escapeHtml(item.error || "")}</span>`;
  }
  return badge("Chưa gửi", "neutral");
}

async function sendFeedbackReply(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = String(new FormData(form).get("message") || "").trim();
  const messageTarget = $("#feedbackReplyMessage");
  if (messageTarget) messageTarget.textContent = "";
  if (!selectedFeedback) return;
  if (!message) {
    if (messageTarget) messageTarget.textContent = "Nội dung trả lời không được để trống.";
    return;
  }

  const outcome = await runAction(async () => {
    const result = await api("/api/admin/feedback/reply", {
      method: "POST",
      body: JSON.stringify({ botId: selectedFeedback.botId, ticketId: selectedFeedback.ticketId, message })
    });
    if (result?.error) throw new Error(result.error);
    return result;
  }, "Không gửi được trả lời");

  if (!outcome.ok) {
    if (messageTarget) messageTarget.textContent = outcome.error?.message || "Không gửi được trả lời.";
    return;
  }

  const result = outcome.value;
  if (result?.ticket) selectedFeedback = result.ticket;
  form.reset();
  renderFeedbackDetail();

  if (result?.delivered) {
    setDataState("success", "Đã gửi trả lời.");
  } else {
    // KHÔNG báo thành công khi Zalo từ chối. Nêu rõ lỗi và giữ trả lời để gửi lại.
    setDataState("error", `Chưa gửi được: ${result?.error || "Zalo từ chối tin nhắn"}`);
  }
  window.setTimeout(() => setDataState("success", ""), 2500);
}

async function changeFeedbackStatus(status) {
  if (!selectedFeedback) return;
  const outcome = await runAction(async () => {
    const result = await api("/api/admin/feedback/status", {
      method: "POST",
      body: JSON.stringify({ botId: selectedFeedback.botId, ticketId: selectedFeedback.ticketId, status })
    });
    if (result?.error) throw new Error(result.error);
    return result;
  }, "Không đổi được trạng thái");
  if (!outcome.ok) return;

  if (outcome.value?.ticket) selectedFeedback = outcome.value.ticket;
  if (outcome.value?.counts) feedbackCounts = outcome.value.counts;
  renderFeedbackDetail();
  renderFeedback();
  setDataState("success", status === "resolved" ? "Đã đánh dấu xử lý." : "Đã mở lại yêu cầu.");
  window.setTimeout(() => setDataState("success", ""), 2000);
}

function setupFeedback() {
  $("#feedbackReplyForm")?.addEventListener("submit", sendFeedbackReply);
  $("#feedbackResolveButton")?.addEventListener("click", () => changeFeedbackStatus("resolved"));
  $("#feedbackReopenButton")?.addEventListener("click", () => changeFeedbackStatus("open"));

  let debounce = null;
  const reload = () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => loadFeedback(), 250);
  };
  for (const id of ["#feedbackSearch", "#feedbackBotFilter", "#feedbackStatusFilter", "#feedbackUnreadFilter"]) {
    const node = $(id);
    if (!node) continue;
    node.addEventListener(id === "#feedbackSearch" ? "input" : "change", reload);
  }
}

/* ---------------------------------------------------------------------------
   Xác minh nguồn gốc bản ghi.

   Luồng: xem bằng chứng → chọn nguồn → nêu lý do → xác nhận rõ ràng → lưu.
   Có thể hoàn tác nếu xác minh sai.

   Nguyên tắc: giao diện KHÔNG tự chọn nguồn thay quản trị viên. Nó chỉ gợi ý khi
   mọi bằng chứng thống nhất, và luôn bắt người dùng tự xác nhận.
   --------------------------------------------------------------------------- */

function evidenceRow(item) {
  const tone = item.reliable ? "success" : "warning";
  return `<article class="stack-item"><header><strong>${escapeHtml(item.label)}</strong>${badge(item.reliable ? "Đáng tin" : "Không kết luận", tone)}</header>` +
    `<p><code>${escapeHtml(item.value)}</code></p>` +
    `<p class="muted">${escapeHtml(item.detail)}</p></article>`;
}

// Các bản ghi khác cùng đóng góp vào dòng này, kèm trạng thái xác minh riêng.
//
// Mục đích: nói rõ xác minh MỘT bản ghi không làm cả dòng trở nên đã xác minh.
function siblingSection(siblings) {
  if (!Array.isArray(siblings) || siblings.length === 0) return "";
  const rows = siblings.map((item) => {
    const state = item.verified
      ? badge(`Đã xác định: ${item.botId || "?"}`, "success")
      : badge("Còn cần xác minh", "warning");
    return `<li><code>${escapeHtml(item.storeId)}</code> · <code>${escapeHtml(item.recordKey)}</code> — ${state}</li>`;
  }).join("");
  const pending = siblings.filter((item) => !item.verified).length;
  return `<h3>Bản ghi khác cùng dòng (${siblings.length})</h3>` +
    `<p class="muted">Xác minh bản ghi này KHÔNG tự động xác minh các bản ghi dưới đây.` +
    (pending ? ` Còn ${pending} bản ghi cần xác minh.` : " Tất cả đã xác minh.") + `</p>` +
    `<ul>${rows}</ul>`;
}

async function openVerifySource(storeId, recordKey) {
  if (!storeId || !recordKey) {
    setDataState("error", "Thiếu thông tin bản ghi để xác minh.");
    return;
  }
  const outcome = await runAction(
    () => api(`/api/admin/source/evidence?storeId=${encodeURIComponent(storeId)}&recordKey=${encodeURIComponent(recordKey)}`),
    "Không lấy được bằng chứng"
  );
  if (!outcome.ok) return;

  const data = outcome.value;
  const sources = Array.isArray(data.assignableSources) ? data.assignableSources : [];
  const record = data.record || {};

  const options = sources.map((source) =>
    `<option value="${escapeHtml(source.botId)}" ${data.suggestion === source.botId ? "selected" : ""}>` +
    `${escapeHtml(source.label)} — ${escapeHtml(source.botId)} (${source.providerType === "zca" ? "tài khoản cá nhân" : "bot chính thức"})</option>`
  ).join("");

  const candidates = (data.candidates || []).length
    ? data.candidates.map((c) => `<li><strong>${escapeHtml(c.label)}</strong> — ${c.sources.length} dấu vết: ${escapeHtml(c.sources.map((s) => s.detail).join("; "))}</li>`).join("")
    : "<li>Không có nguồn nào được bằng chứng chỉ ra.</li>";

  showDialog("Xác minh nguồn gốc", `
    <div class="empty-state"><p>${escapeHtml(data.note)}</p></div>
    <h3>Bản ghi</h3>
    <div class="detail-grid">
      <div class="detail"><span>Store</span><strong>${escapeHtml(record.storeId || storeId)}</strong></div>
      <div class="detail"><span>Khóa</span><code>${escapeHtml(record.key || recordKey)}</code></div>
      <div class="detail"><span>Chat ID</span><code>${escapeHtml(record.chatId || "-")}</code></div>
      <div class="detail"><span>User ID</span><code>${escapeHtml(record.userId || "-")}</code></div>
      <div class="detail"><span>botId hiện tại</span><strong>${escapeHtml(record.declaredBotId || "(không có)")}</strong></div>
    </div>
    <h3>Bằng chứng thu thập được</h3>
    <div class="stack">${(data.evidence || []).map(evidenceRow).join("")}</div>
    <h3>Nguồn mà bằng chứng chỉ ra</h3>
    <ul>${candidates}</ul>
    ${siblingSection(data.siblings)}
    <form id="verifySourceForm">
      <label>Gán nguồn cho bản ghi này
        <select name="botId" required>
          <option value="">-- Chọn tài khoản/kênh --</option>
          ${options}
        </select>
      </label>
      <label>Lý do xác minh (bắt buộc)
        <textarea name="reason" rows="3" required placeholder="Ví dụ: chatId này chỉ xuất hiện trong dữ liệu của tài khoản này"></textarea>
      </label>
      <label class="checkbox-line">
        <input type="checkbox" name="confirmed" required />
        Tôi đã xem bằng chứng và xác nhận nguồn này là đúng.
      </label>
      <p class="muted">Thao tác này chỉ gán NGUỒN cho bản ghi. Nó không gộp hai danh tính người dùng làm một.</p>
      <div class="row-actions"><button class="primary small" type="submit">Lưu xác minh</button></div>
      <p id="verifySourceMessage" class="error" role="alert"></p>
    </form>
  `);

  const form = $("#verifySourceForm");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const messageTarget = $("#verifySourceMessage");
    if (messageTarget) messageTarget.textContent = "";

    const result = await runAction(() => api("/api/admin/source/verify", {
      method: "POST",
      body: JSON.stringify({
        storeId,
        recordKey,
        botId: formData.get("botId"),
        reason: formData.get("reason"),
        confirmed: formData.get("confirmed") === "on"
      })
    }), "Không lưu được xác minh");

    if (!result.ok) {
      if (messageTarget) messageTarget.textContent = result.error?.message || "Không lưu được xác minh.";
      return;
    }
    $("#detailDialog").close();
    await loadData();
    setDataState("success", "Đã xác minh nguồn.");
    window.setTimeout(() => setDataState("success", ""), 2000);
  });
}

async function revokeSource(storeId, recordKey) {
  const reason = window.prompt("Lý do hoàn tác xác minh (bắt buộc):", "");
  if (reason == null) return;
  if (!reason.trim()) {
    setDataState("error", "Phải nêu lý do hoàn tác.");
    return;
  }
  const outcome = await runAction(() => api("/api/admin/source/revoke", {
    method: "POST",
    body: JSON.stringify({ storeId, recordKey, reason: reason.trim() })
  }), "Không hoàn tác được xác minh");
  if (!outcome.ok) return;

  await loadData();
  setDataState("success", "Đã hoàn tác xác minh. Bản ghi trở lại trạng thái chưa xác minh.");
  window.setTimeout(() => setDataState("success", ""), 2500);
}

function setupSourceVerification() {
  $$("[data-verify-source]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openVerifySource(button.dataset.sourceStore, button.dataset.sourceKey);
    });
  });
  $$("[data-revoke-source]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      revokeSource(button.dataset.sourceStore, button.dataset.sourceKey);
    });
  });
}

/* ==========================================================================
   HELP IMAGES — quản lý ảnh hướng dẫn /help <command>
   ========================================================================== */
let helpImageCommands = [];
let helpImages = [];

async function loadHelpImageCommands() {
  try {
    const data = await api("/api/admin/help-images/commands");
    helpImageCommands = data.commands || [];
    const select = $("#helpImageCommand");
    const filter = $("#helpImageFilter");
    if (select) {
      const previous = select.value;
      select.innerHTML = '<option value="">-- Chọn lệnh --</option>' +
        helpImageCommands.map((c) => `<option value="${escapeHtml(c.command)}">${escapeHtml(c.command)} — ${escapeHtml(c.description || c.usage || "")}</option>`).join("");
      if (previous) select.value = previous;
    }
    if (filter) {
      const previous = filter.value;
      filter.innerHTML = '<option value="">Tất cả lệnh</option>' +
        helpImageCommands.map((c) => `<option value="${escapeHtml(c.command)}">${escapeHtml(c.command)}</option>`).join("");
      if (previous) filter.value = previous;
    }
    syncHelpUploadState();
  } catch (error) {
    console.error("loadHelpImageCommands:", error.message);
  }
}

// Ảnh không gắn lệnh thì KHÔNG bao giờ được gửi kèm /help. Bắt buộc chọn lệnh
// trước khi tải lên để tránh đúng cái bẫy "upload xong mà bot không gửi gì".
function syncHelpUploadState() {
  const select = $("#helpImageCommand");
  const button = $("#helpImageUploadForm button[type=submit]");
  const hint = $("#helpImageCommandHint");
  const chosen = Boolean(select?.value);
  if (button) button.disabled = !chosen;
  if (hint) {
    hint.textContent = chosen ? "" : "Chọn lệnh trước khi tải lên — ảnh không gắn lệnh sẽ không được gửi.";
    hint.className = chosen ? "" : "field-hint warn";
  }
}

async function loadHelpImages() {
  await loadHelpImageCommands();
  const filterVal = $("#helpImageFilter")?.value || "";
  try {
    const url = filterVal ? `/api/admin/help-images?command=${encodeURIComponent(filterVal)}` : "/api/admin/help-images";
    const data = await api(url);
    helpImages = data.images || [];
    renderHelpImages();
    await loadHelpImageDiagnostics();
  } catch (error) {
    console.error("loadHelpImages:", error.message);
    $("#helpImageGrid").innerHTML = `<div class="empty-state">Lỗi tải ảnh: ${escapeHtml(error.message)}</div>`;
  }
}

// Hiện lý do ảnh không gửi được ngay trên tab, thay vì bắt quản trị viên đọc log.
async function loadHelpImageDiagnostics() {
  const banner = $("#helpImageDiagnostics");
  if (!banner) return;
  try {
    const data = await api("/api/admin/help-images/diagnostics");
    const problems = [];

    if (!data.publicOriginKnown) {
      problems.push(
        "Chưa biết địa chỉ công khai của dashboard. Bot chính thức cần URL công khai để Zalo tải ảnh, " +
        "nên ảnh sẽ không gửi được. Hãy mở dashboard một lần (đủ để hệ thống ghi nhận), " +
        "hoặc đặt ADMIN_BASE_URL trong .env."
      );
    }

    if (data.lastFailure) {
      const failure = data.lastFailure;
      let line = `Lần gửi gần nhất thất bại (${formatDate(failure.at)}) — lệnh /${failure.command}: ${failure.error}`;
      if (failure.url) line += ` · URL: ${failure.url}`;
      if (failure.probe) {
        // Kết quả tự tải URL từ chính máy chủ: tách được lỗi phía mình và phía Zalo.
        line += failure.probe.ok
          ? ` · Máy chủ tự tải được URL (HTTP ${failure.probe.status}, ${failure.probe.contentType || "?"}) ⇒ URL ổn, lỗi nằm ở phía Zalo.`
          : ` · Máy chủ CŨNG không tải được URL (${failure.probe.status || failure.probe.error}) ⇒ kiểm tra tệp/proxy.`;
      }
      problems.push(line);
    }

    if (problems.length === 0) {
      if (data.lastSuccess) {
        banner.hidden = false;
        banner.className = "app-status success";
        banner.innerHTML = `<div>Ảnh hướng dẫn gửi được — ${formatDate(data.lastSuccess.at)}, ${data.lastSuccess.count} ảnh.</div>`;
      } else {
        banner.hidden = true;
        banner.innerHTML = "";
      }
      return;
    }

    banner.hidden = false;
    banner.className = "app-status error";
    banner.innerHTML = problems.map((text) => `<div>${escapeHtml(text)}</div>`).join("");
  } catch (_) {
    banner.hidden = true;
  }
}

function helpCommandOptions(selected) {
  const known = helpImageCommands.some((item) => item.command === selected);
  // Nếu ảnh đang gắn một lệnh KHÔNG tồn tại (dữ liệu cũ), phải hiện đúng giá trị
  // đó. Nếu không, select rơi về "-- Chưa gắn lệnh --" và người quản trị tưởng
  // ảnh chưa gắn, trong khi thực tế nó gắn vào một lệnh rác.
  const unknownOption = selected && !known
    ? `<option value="${escapeHtml(selected)}" selected>/${escapeHtml(selected)} (không tồn tại)</option>`
    : "";

  return unknownOption + '<option value="">-- Chưa gắn lệnh --</option>' +
    helpImageCommands.map((c) =>
      `<option value="${escapeHtml(c.command)}"${c.command === selected ? " selected" : ""}>/${escapeHtml(c.command)}</option>`
    ).join("");
}

function renderHelpImages() {
  const grid = $("#helpImageGrid");
  if (!grid) return;
  if (!helpImages.length) {
    grid.innerHTML = '<div class="empty-state">Chưa có ảnh nào. Upload ảnh hướng dẫn ở bảng bên trái.</div>';
    return;
  }

  grid.innerHTML = helpImages.map((img) => {
    const unassigned = !img.command;
    const unknownCommand = img.command && !helpImageCommands.some((c) => c.command === img.command);
    return `
    <div class="help-image-card${unassigned || unknownCommand ? " unassigned" : ""}">
      <img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.originalName || "")}" loading="lazy" />
      <div class="help-image-meta">
        <select class="help-image-command-select" data-media="${escapeHtml(img.mediaId)}" aria-label="Lệnh cho ảnh này">
          ${helpCommandOptions(img.command || "")}
        </select>
        ${unassigned ? '<small class="help-image-warn">Chưa gắn lệnh — ảnh này sẽ không được gửi kèm.</small>' : ""}
        ${unknownCommand ? `<small class="help-image-warn">Lệnh "/${escapeHtml(img.command)}" không tồn tại — ảnh này sẽ không được gửi. Chọn lại lệnh bên trên.</small>` : ""}
        <small class="muted">${escapeHtml(img.originalName || "")} · ${formatDate(img.storedAt)}</small>
        <div class="help-image-actions">
          <button class="ghost small" data-probe-image="${escapeHtml(img.mediaId)}">Kiểm tra</button>
          <button class="ghost small" data-delete-image="${escapeHtml(img.mediaId)}">Xoá</button>
        </div>
      </div>
    </div>`;
  }).join("");

  // Kiểm tra một ảnh: bản ghi, tệp, và URL công khai. Ba câu trả lời này chỉ ra
  // đúng nguyên nhân, thay vì đoán.
  grid.querySelectorAll("[data-probe-image]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const result = await api("/api/admin/help-images/probe", {
          method: "POST",
          body: JSON.stringify({ mediaId: btn.dataset.probeImage })
        });

        const lines = [];
        lines.push(result.recordExists ? "✓ Có bản ghi media" : "✗ KHÔNG có bản ghi media (ảnh đã bị xoá?)");
        lines.push(result.fileExists ? "✓ Có tệp trên đĩa" : "✗ KHÔNG có tệp trên đĩa — ảnh này hỏng, hãy xoá và tải lên lại");
        if (result.url) lines.push(`URL: ${result.url}`);
        if (result.probe) {
          const cacheNote = result.probe.cacheState ? `, cache: ${result.probe.cacheState}` : "";
          lines.push(result.probe.ok
            ? `• Tải URL: HTTP ${result.probe.status} (${result.probe.contentType || "?"}${cacheNote})`
            : `✗ Tải URL thất bại (${result.probe.status || result.probe.error})`);
        }

        if (!result.fileExists) {
          lines.push("⇒ Tệp không còn trên máy chủ. Nếu vẫn thấy ảnh khi mở link, đó là bản cache — Zalo thì không thấy.");
        } else if (result.probe?.ok) {
          lines.push("⇒ Phía máy chủ ổn. Nếu Zalo vẫn báo lỗi thì lỗi nằm ở Zalo/Cloudflare khi tải ảnh.");
        }
        alert(lines.join("\n"));
      } catch (error) {
        alert(`Lỗi kiểm tra: ${error.message}`);
      } finally {
        btn.disabled = false;
      }
    });
  });

  grid.querySelectorAll("[data-delete-image]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Xoá ảnh này?")) return;
      try {
        await api(`/api/admin/help-images/${btn.dataset.deleteImage}`, { method: "DELETE" });
        await loadHelpImages();
      } catch (error) {
        alert(`Lỗi: ${error.message}`);
      }
    });
  });

  // Gắn lệnh bằng select thật thay vì prompt(): prompt() bị chặn ở nhiều môi
  // trường và không cho thấy danh sách lệnh hợp lệ.
  grid.querySelectorAll("[data-media]").forEach((select) => {
    select.addEventListener("change", async () => {
      const command = select.value;
      if (!command) {
        alert("Hiện chưa hỗ trợ bỏ gắn lệnh. Hãy xoá ảnh và tải lại nếu cần đổi sang ảnh không gắn lệnh.");
        select.value = "";
        return;
      }
      select.disabled = true;
      try {
        await api("/api/admin/help-images/associate", {
          method: "POST",
          body: JSON.stringify({ mediaId: select.dataset.media, command })
        });
        await loadHelpImages();
      } catch (error) {
        alert(`Lỗi: ${error.message}`);
      } finally {
        select.disabled = false;
      }
    });
  });
}

// Upload form handler.
$("#helpImageUploadForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const command = $("#helpImageCommand").value;
  const fileInput = $("#helpImageFile");
  const msg = $("#helpImageUploadMsg");

  if (!command) {
    msg.textContent = "Chọn lệnh trước khi tải lên.";
    msg.className = "error";
    return;
  }
  if (!fileInput.files[0]) {
    msg.textContent = "Chưa chọn file.";
    msg.className = "error";
    return;
  }

  const formData = new FormData();
  formData.append("file", fileInput.files[0]);
  formData.append("command", command);

  msg.textContent = "Đang tải lên...";
  msg.className = "";

  try {
    const response = await fetch(`${base}/api/admin/help-images/upload`, {
      method: "POST",
      credentials: "same-origin",
      body: formData
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Upload thất bại");
    msg.textContent = `Đã tải lên và gắn vào /${command}. Người dùng gõ /help ${command} sẽ nhận ảnh này.`;
    msg.className = "success";
    form.reset();
    await loadHelpImages();
    syncHelpUploadState();
  } catch (error) {
    msg.textContent = `Lỗi: ${error.message}`;
    msg.className = "error";
  }
});

$("#helpImageCommand")?.addEventListener("change", syncHelpUploadState);
$("#helpImageFilter")?.addEventListener("change", loadHelpImages);
$("#helpImageRefresh")?.addEventListener("click", loadHelpImages);
/* ==========================================================================
   CHAT CENTER — giao tiếp hai chiều admin ↔ user, cập nhật realtime
   ========================================================================== */

let chatConversations = [];
let chatActiveConv = null;
let chatMessageCursor = null;
let chatMessages = [];
let chatSeenIds = new Set();
let chatStream = null;
let chatStreamFailures = 0;
let chatPollTimer = null;
let chatLive = false;
let chatUnreadTotal = 0;
let chatPendingAttachment = null;
let chatPreviewVisible = false;
let chatSending = false;
let chatNoticeTimer = null;

// Thanh điều khiển tạm dừng trợ lý AI cho ĐÚNG cuộc trò chuyện đang mở.
//
// Khai báo ở đây (sau các biến trạng thái Chat Center) vì nó đọc `chatActiveConv`:
// gọi trước khi khối `let` chạy sẽ ném ReferenceError và làm trắng dashboard.
function renderChatAiPause() {
  const bar = $("#chatAiPauseBar");
  if (!bar) return;
  if (!chatActiveConv) { bar.innerHTML = ""; return; }

  const { botId, chatId } = chatActiveConv;
  const entry = activeChatPause(botId, chatId);
  const globalActive = aiPause?.global?.active === true;
  const stateBadge = entry
    ? badge(`AI tắt ở chat này · ${pauseUntilText(entry)}`, "warning")
    : globalActive ? badge("AI đang tắt toàn bộ", "warning") : badge("AI đang bật", "success");
  const disabledAttr = globalActive ? ' disabled title="Đang tạm dừng toàn bộ"' : "";

  bar.innerHTML = `${stateBadge}${entry
    ? `<button type="button" class="small" id="chatAiPauseResume">Bật lại AI</button>`
    : `<select id="chatAiPauseMinutes" aria-label="Thời gian tạm dừng AI">${aiPauseDurationOptions()}</select><button type="button" class="small" id="chatAiPauseStart"${disabledAttr}>Tạm dừng AI</button>`}`;

  $("#chatAiPauseStart")?.addEventListener("click", () => applyAiPause({
    scope: "chat",
    botId,
    chatId,
    paused: true,
    minutes: Number($("#chatAiPauseMinutes")?.value) || 0,
    reason: "Quản trị viên đang trả lời trực tiếp"
  }, "Đã tạm dừng trợ lý AI ở cuộc trò chuyện này."));
  $("#chatAiPauseResume")?.addEventListener("click", () => applyAiPause({
    scope: "chat", botId, chatId, paused: false
  }, "Đã bật lại trợ lý AI ở cuộc trò chuyện này."));
}

const CHAT_MAX_TEXT = 4000;
const CHAT_POLL_MS = 5000;
const CHAT_MAX_STREAM_FAILURES = 3;

/* --------------------------------------------------------------------------
   Định dạng tin nhắn — dùng ĐÚNG cú pháp mà bot hiểu.

   Nguồn sự thật: providers/zca/zcaRichText.js. Bot chính thức hiểu Markdown qua
   parse_mode; ZCA được chuyển từ chính cú pháp đó. Bảng dưới đây phải khớp:
     **đậm**   *nghiêng*   __gạch chân__   ~~gạch ngang~~   `mã`
     {green}…{/green}  {orange}  {red}  {yellow}
     # Tiêu đề   > Trích dẫn   - Gạch đầu dòng   1. Danh sách số
   -------------------------------------------------------------------------- */

const CHAT_INLINE_MARKERS = {
  bold: ["**", "**"],
  italic: ["*", "*"],
  underline: ["__", "__"],
  strike: ["~~", "~~"],
  "color-green": ["{green}", "{/green}"],
  "color-orange": ["{orange}", "{/orange}"],
  "color-red": ["{red}", "{/red}"],
  "color-yellow": ["{yellow}", "{/yellow}"]
};

const CHAT_LINE_PREFIXES = {
  heading: () => "# ",
  quote: () => "> ",
  bullet: () => "- ",
  ordered: (index) => `${index + 1}. `
};

const PREVIEW_COLORS = {
  green: "#15a85f",
  orange: "#f27806",
  red: "#db342e",
  yellow: "#f7b503"
};

// Thứ tự quan trọng: dấu dài phải đứng trước dấu ngắn, nếu không `**` sẽ bị
// hiểu thành hai lần `*`.
const PREVIEW_MARKERS = [
  { open: "***", close: "***", render: (inner) => `<strong>${inner}</strong>` },
  { open: "**", close: "**", render: (inner) => `<strong>${inner}</strong>` },
  { open: "__", close: "__", render: (inner) => `<u>${inner}</u>` },
  { open: "~~", close: "~~", render: (inner) => `<s>${inner}</s>` },
  { open: "`", close: "`", render: (inner) => `<strong>${inner}</strong>` },
  { open: "*", close: "*", render: (inner) => `<em>${inner}</em>` },
  { open: "_", close: "_", render: (inner) => `<em>${inner}</em>` }
];

// Render nội dùng một dòng thành HTML, khớp hành vi của renderZcaRichText.
function renderPreviewInline(text) {
  let out = "";
  let buffer = "";
  let index = 0;

  const flush = () => {
    if (buffer) {
      out += escapeHtml(buffer);
      buffer = "";
    }
  };

  while (index < text.length) {
    // Ký tự escape: \* \$ … hiển thị đúng ký tự sau dấu chéo.
    if (text[index] === "\\" && index + 1 < text.length) {
      buffer += text[index + 1];
      index += 2;
      continue;
    }

    // Màu: {green}…{/green}
    if (text[index] === "{") {
      const closeBrace = text.indexOf("}", index + 1);
      if (closeBrace !== -1) {
        const name = text.slice(index + 1, closeBrace).toLowerCase();
        const color = PREVIEW_COLORS[name];
        if (color) {
          const closeTag = `{/${name}}`;
          const closeAt = text.indexOf(closeTag, closeBrace + 1);
          if (closeAt !== -1) {
            flush();
            const inner = renderPreviewInline(text.slice(closeBrace + 1, closeAt));
            out += `<span style="color:${color}">${inner}</span>`;
            index = closeAt + closeTag.length;
            continue;
          }
        }
      }
    }

    let matched = false;
    for (const marker of PREVIEW_MARKERS) {
      if (!text.startsWith(marker.open, index)) continue;
      // `*` đơn không được "ăn" vào `**`, và ngược lại.
      if (marker.open === "*" && text.startsWith("**", index)) continue;
      if (marker.open === "_" && text.startsWith("__", index)) continue;

      const close = text.indexOf(marker.close, index + marker.open.length);
      if (close === -1) continue;
      if (close === index + marker.open.length) continue;
      if (marker.open === "*" && text.startsWith("**", close)) continue;
      if (marker.open === "_" && text.startsWith("__", close)) continue;

      flush();
      const inner = renderPreviewInline(text.slice(index + marker.open.length, close));
      out += marker.render(inner);
      index = close + marker.close.length;
      matched = true;
      break;
    }
    if (matched) continue;

    buffer += text[index];
    index += 1;
  }

  flush();
  return out;
}

// Render toàn bộ nội dung (nhiều dòng) thành HTML để xem trước và hiển thị bong bóng.
function renderChatPreviewHtml(text) {
  const source = String(text == null ? "" : text);
  if (!source.trim()) return "";

  const lines = source.split("\n");
  const out = [];
  let listTag = null;

  const closeList = () => {
    if (listTag) {
      out.push(`</${listTag}>`);
      listTag = null;
    }
  };

  for (const rawLine of lines) {
    let line = rawLine;
    let blockTag = null;

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blockTag = `h${Math.min(heading[1].length + 2, 6)}`;
      line = heading[2];
    } else {
      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        blockTag = "blockquote";
        line = quote[1];
      } else {
        const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
        const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
        if (bullet) {
          if (listTag !== "ul") { closeList(); out.push("<ul>"); listTag = "ul"; }
          line = bullet[2];
        } else if (ordered) {
          if (listTag !== "ol") { closeList(); out.push("<ol>"); listTag = "ol"; }
          line = ordered[3];
        } else {
          closeList();
        }
      }
    }

    const html = renderPreviewInline(line);

    if (blockTag) out.push(`<${blockTag}>${html || "&nbsp;"}</${blockTag}>`);
    else if (listTag) out.push(`<li>${html || "&nbsp;"}</li>`);
    else out.push(`<p>${html || "&nbsp;"}</p>`);
  }

  closeList();
  return out.join("");
}

/* --------------------------------------------------------------------------
   Trạng thái realtime
   -------------------------------------------------------------------------- */

function renderChatStatus() {
  const badge = $("#chatUnreadBadge");
  if (!badge) return;
  const live = chatLive ? "● Trực tiếp" : "○ Đang kết nối lại";
  const unread = chatUnreadTotal > 0 ? ` · ${chatUnreadTotal} tin chưa đọc` : "";
  badge.textContent = `${live}${unread}`;
  badge.className = `chat-live ${chatLive ? "on" : "off"}`;
}

function showChatNotice(message, isError = false) {
  const hint = $("#chatComposerHint");
  if (!hint) return;
  hint.textContent = message;
  hint.className = `chat-hint ${isError ? "over" : "info"}`;
  window.clearTimeout(chatNoticeTimer);
  chatNoticeTimer = window.setTimeout(() => updateComposerState(), 4000);
}

// Mở luồng SSE. EventSource tự gửi cookie phiên nên không cần token riêng.
function connectChatStream() {
  if (chatStream || typeof EventSource === "undefined") return;
  try {
    chatStream = new EventSource(`${base}/api/admin/chat/events`);
  } catch (_) {
    chatStream = null;
    startChatPolling();
    return;
  }

  chatStream.addEventListener("ready", () => {
    chatStreamFailures = 0;
    chatLive = true;
    stopChatPolling();
    renderChatStatus();
  });

  chatStream.addEventListener("chat", (event) => {
    let payload;
    try { payload = JSON.parse(event.data); } catch (_) { return; }
    handleChatEvent(payload);
  });

  chatStream.onerror = () => {
    chatLive = false;
    renderChatStatus();
    chatStreamFailures += 1;
    // Sau vài lần lỗi liên tiếp thì bỏ SSE và chuyển sang hỏi định kỳ. Không thử
    // lại mãi: nếu phiên đã hết hạn thì mọi lần thử đều 401.
    if (chatStreamFailures >= CHAT_MAX_STREAM_FAILURES) {
      try { chatStream.close(); } catch (_) {}
      chatStream = null;
      startChatPolling();
    }
  };
}

function startChatPolling() {
  if (chatPollTimer) return;
  chatPollTimer = window.setInterval(() => {
    if (document.hidden) return;   // tab ẩn thì không tốn request
    refreshChatFromServer();
  }, CHAT_POLL_MS);
}

function stopChatPolling() {
  if (!chatPollTimer) return;
  window.clearInterval(chatPollTimer);
  chatPollTimer = null;
}

async function refreshChatFromServer() {
  await loadChatConversations({ silent: true });
  if (chatActiveConv) await fetchNewChatMessages();
}

/* --------------------------------------------------------------------------
   Xử lý sự kiện
   -------------------------------------------------------------------------- */

function handleChatEvent(event) {
  if (!event || !event.type) return;

  if (event.type === "message") {
    mergeChatConversation(event.conversation);
    renderChatConversations();

    const active = chatActiveConv;
    const isActive = active
      && active.botId === event.botId
      && String(active.chatId) === String(event.chatId);

    if (isActive) {
      appendChatMessage(event.message);
      if (event.direction === "inbound") markActiveChatRead();
    } else if (event.direction === "inbound") {
      chatUnreadTotal += 1;
    }
    renderChatStatus();
    return;
  }

  if (event.type === "status") {
    const target = chatMessages.find((item) => item.messageId === event.messageId);
    if (target) {
      target.status = event.status;
      if (event.error) target.error = event.error;
      renderChatMessages();
    }
    return;
  }

  // Media của tin vào tải xong: thay chỗ "đang tải" bằng ảnh/tệp thật.
  if (event.type === "update") {
    const target = chatMessages.find((item) => item.messageId === event.messageId);
    if (target && event.patch) {
      Object.assign(target, event.patch);
      renderChatMessages();
    }
    return;
  }

  if (event.type === "read") {
    const conv = chatConversations.find((item) => item.conversationId === event.conversationId);
    if (conv) {
      conv.unreadCount = 0;
      renderChatConversations();
    }
  }
}

function mergeChatConversation(incoming) {
  if (!incoming || !incoming.conversationId) return;
  const index = chatConversations.findIndex((item) => item.conversationId === incoming.conversationId);
  if (index === -1) {
    chatConversations.unshift({
      conversationId: incoming.conversationId,
      botId: incoming.botId,
      chatId: incoming.chatId,
      displayName: incoming.displayName || null,
      chatType: incoming.chatType || null,
      unreadCount: incoming.unreadCount || 0,
      lastMessageAt: incoming.lastMessageAt || null,
      lastMessagePreview: incoming.lastMessagePreview || "",
      lastMessageDirection: incoming.lastMessageDirection || null,
      lastMessageStatus: incoming.lastMessageStatus || null
    });
    return;
  }

  const conv = chatConversations[index];
  conv.lastMessageAt = incoming.lastMessageAt || conv.lastMessageAt;
  conv.lastMessagePreview = incoming.lastMessagePreview ?? conv.lastMessagePreview;
  conv.lastMessageDirection = incoming.lastMessageDirection || conv.lastMessageDirection;
  conv.lastMessageStatus = incoming.lastMessageStatus || conv.lastMessageStatus;
  if (incoming.displayName) conv.displayName = incoming.displayName;
  if (typeof incoming.unreadCount === "number") conv.unreadCount = incoming.unreadCount;
  else if (incoming.lastMessageDirection === "outbound") conv.unreadCount = 0;

  // Hội thoại vừa có tin mới nhất thì đưa lên đầu danh sách.
  if (index > 0) {
    chatConversations.splice(index, 1);
    chatConversations.unshift(conv);
  }
}

function appendChatMessage(message) {
  if (!message || !message.messageId) return;
  if (chatSeenIds.has(message.messageId)) return;
  chatSeenIds.add(message.messageId);
  chatMessages.push(message);
  chatMessages.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  renderChatMessages();
}

/* --------------------------------------------------------------------------
   Danh sách hội thoại
   -------------------------------------------------------------------------- */

async function loadChatConversations(options = {}) {
  try {
    const data = await api("/api/admin/chat/conversations");
    chatConversations = Array.isArray(data.conversations) ? data.conversations : [];
    const unread = await api("/api/admin/chat/unread");
    chatUnreadTotal = Number(unread.count) || 0;
    renderChatConversations();
    renderChatStatus();
  } catch (error) {
    if (!options.silent) {
      const list = $("#chatConversationList");
      if (list) list.innerHTML = `<div class="empty-state">Lỗi tải hội thoại: ${escapeHtml(error.message)}</div>`;
    }
  }
}

function chatRelativeTime(value) {
  if (!value) return "";
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  if (diff < 60 * 1000) return "vừa xong";
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} phút`;
  const date = new Date(then);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function renderChatConversations() {
  const list = $("#chatConversationList");
  if (!list) return;

  const search = ($("#chatSearch")?.value || "").toLowerCase();
  const filtered = chatConversations.filter((conv) => {
    if (!search) return true;
    return String(conv.chatId || "").toLowerCase().includes(search)
      || String(conv.displayName || "").toLowerCase().includes(search)
      || String(conv.botId || "").toLowerCase().includes(search);
  });

  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state">Chưa có hội thoại nào.</div>';
    return;
  }

  list.innerHTML = filtered.map((conv) => {
    const active = chatActiveConv?.conversationId === conv.conversationId;
    const direction = conv.lastMessageDirection === "outbound" ? "Bạn: " : "";
    const unread = Number(conv.unreadCount) || 0;
    return `
      <div class="chat-conversation-item${active ? " active" : ""}" data-bot="${escapeHtml(conv.botId)}" data-chat="${escapeHtml(conv.chatId)}">
        <div class="conv-row">
          <span class="conv-name">${escapeHtml(conv.displayName || conv.chatId)}</span>
          <span class="conv-time">${escapeHtml(chatRelativeTime(conv.lastMessageAt))}</span>
        </div>
        <div class="conv-row">
          <span class="conv-preview">${escapeHtml(direction + (conv.lastMessagePreview || "(chưa có tin)"))}</span>
          ${unread > 0 ? `<span class="conv-unread">${unread > 99 ? "99+" : unread}</span>` : ""}
        </div>
        <div class="conv-bot">${escapeHtml(conv.botId)}${conv.chatType ? ` · ${escapeHtml(conv.chatType)}` : ""}</div>
      </div>`;
  }).join("");

  list.querySelectorAll("[data-chat]").forEach((item) => {
    item.addEventListener("click", () => openChatConversation(item.dataset.bot, item.dataset.chat));
  });
}

/* --------------------------------------------------------------------------
   Khung tin nhắn
   -------------------------------------------------------------------------- */

async function openChatConversation(botId, chatId) {
  const conv = chatConversations.find((item) => item.botId === botId && String(item.chatId) === String(chatId));
  chatActiveConv = conv || { botId, chatId, displayName: chatId };
  chatMessageCursor = null;
  chatMessages = [];
  chatSeenIds = new Set();
  clearChatAttachment();

  $("#chatThreadTitle").textContent = conv?.displayName || chatId;
  $("#chatThreadInfo").textContent = `${botId} · ${chatId}`;
  $("#chatSendForm").classList.remove("hidden");
  renderChatAiPause();
  renderChatConversations();
  renderChatMessages();

  await loadChatMessages();
  await markActiveChatRead();
  connectChatStream();
}

async function loadChatMessages() {
  if (!chatActiveConv) return;
  const { botId, chatId } = chatActiveConv;
  try {
    const url = `/api/admin/chat/messages/${encodeURIComponent(botId)}/${encodeURIComponent(chatId)}?limit=50`;
    const data = await api(url);
    chatMessages = Array.isArray(data.messages) ? data.messages : [];
    chatMessageCursor = data.nextCursor || null;
    chatSeenIds = new Set(chatMessages.map((item) => item.messageId));
    renderChatMessages();
    scrollChatToBottom(true);
  } catch (error) {
    $("#chatMessageList").innerHTML = `<div class="empty-state">Lỗi tải tin nhắn: ${escapeHtml(error.message)}</div>`;
  }
}

// Chỉ lấy phần tin MỚI hơn mốc cuối cùng đã có — dùng cho nhịp hỏi định kỳ khi
// SSE không dùng được.
async function fetchNewChatMessages() {
  if (!chatActiveConv || !chatMessages.length) {
    if (chatActiveConv) await loadChatMessages();
    return;
  }
  const { botId, chatId } = chatActiveConv;
  const since = chatMessages[chatMessages.length - 1].createdAt;
  if (!since) return;
  try {
    const url = `/api/admin/chat/messages/${encodeURIComponent(botId)}/${encodeURIComponent(chatId)}?since=${encodeURIComponent(since)}`;
    const data = await api(url);
    for (const message of data.messages || []) appendChatMessage(message);
  } catch (_) {
    // Bỏ qua: nhịp sau sẽ thử lại.
  }
}

async function markActiveChatRead() {
  if (!chatActiveConv) return;
  const { botId, chatId } = chatActiveConv;
  try {
    await api("/api/admin/chat/read", { method: "POST", body: JSON.stringify({ botId, chatId }) });
    const conv = chatConversations.find((item) => item.conversationId === chatActiveConv?.conversationId);
    if (conv) conv.unreadCount = 0;
    chatUnreadTotal = Math.max(0, chatUnreadTotal - 1);
    renderChatConversations();
    renderChatStatus();
  } catch (_) {}
}

function chatDayKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function chatDayLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (chatDayKey(date) === chatDayKey(today)) return "Hôm nay";
  if (chatDayKey(date) === chatDayKey(yesterday)) return "Hôm qua";
  return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;
}

function renderChatAttachment(attachment) {
  if (!attachment) return "";

  // Media của tin vào đang được tải về máy chủ.
  if (attachment.pending) {
    const label = attachment.type === "file" ? "tệp" : "ảnh";
    return `<div class="msg-attachment pending"><span class="attach-spinner">◌</span> Đang tải ${label}…</div>`;
  }

  // Tải thất bại: nói rõ, không im lặng bỏ qua.
  if (attachment.failed) {
    return `<div class="msg-attachment failed">⚠ Không tải được ${escapeHtml(attachment.type === "file" ? "tệp" : "ảnh")}${attachment.name ? `: ${escapeHtml(attachment.name)}` : ""}</div>`;
  }

  const url = attachment.url || (attachment.mediaId ? `/api/media/${attachment.mediaId}` : "");
  if (!url) return "";

  if (attachment.type === "image" || /^image\//.test(String(attachment.mimeType || ""))) {
    return `<a class="msg-attachment image" href="${escapeHtml(url)}" target="_blank" rel="noopener">
      <img src="${escapeHtml(url)}" alt="${escapeHtml(attachment.name || "ảnh")}" loading="lazy" />
    </a>`;
  }

  const name = attachment.name || "tệp đính kèm";
  const size = attachment.size ? ` · ${formatChatFileSize(attachment.size)}` : "";
  return `<a class="msg-attachment file" href="${escapeHtml(url)}?download=1" target="_blank" rel="noopener">
    <span class="file-icon">📄</span>
    <span class="file-meta"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(size.replace(" · ", ""))}</small></span>
  </a>`;
}

function formatChatFileSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function renderChatMessages() {
  const list = $("#chatMessageList");
  if (!list) return;

  if (!chatMessages.length) {
    list.innerHTML = '<div class="empty-state">Chưa có tin nhắn. Gửi tin đầu tiên bên dưới.</div>';
    return;
  }

  let lastDay = null;
  const parts = [];

  for (const message of chatMessages) {
    const stamp = message.createdAt || message.sentAt || message.receivedAt;
    const day = chatDayKey(stamp);
    if (day && day !== lastDay) {
      parts.push(`<div class="chat-day-sep"><span>${escapeHtml(chatDayLabel(stamp))}</span></div>`);
      lastDay = day;
    }

    const outbound = message.direction === "outbound";
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    const body = message.text ? renderChatPreviewHtml(message.text) : "";
    const time = stamp ? new Date(stamp) : null;
    const clock = time && !Number.isNaN(time.getTime())
      ? `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`
      : "";
    const status = outbound
      ? (message.status === "failed" ? '<span class="msg-status failed">✕ Lỗi</span>'
        : message.status === "pending" ? '<span class="msg-status">◷ Đang gửi</span>'
        : '<span class="msg-status ok">✓</span>')
      : "";
    // Hiện nguyên văn lỗi: "✕ Lỗi" không nói được vì sao, và người dùng phải mở
    // log mới biết (ví dụ ảnh hỏng vì thiếu địa chỉ công khai).
    const errorLine = message.status === "failed" && message.error
      ? `<div class="msg-error">${escapeHtml(message.error)}</div>`
      : "";

    parts.push(`<div class="chat-bubble-row ${outbound ? "outbound" : "inbound"}">
      <div class="chat-message ${outbound ? "outbound" : "inbound"}"${message.error ? ` title="${escapeHtml(message.error)}"` : ""}>
        ${attachments.map(renderChatAttachment).join("")}
        ${body ? `<div class="msg-text">${body}</div>` : ""}
        ${errorLine}
        <div class="msg-meta">${escapeHtml(clock)} ${status}</div>
      </div>
    </div>`);
  }

  list.innerHTML = parts.join("");
  scrollChatToBottom();
}

function scrollChatToBottom(force = false) {
  const list = $("#chatMessageList");
  if (!list) return;
  const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
  // Chỉ tự cuộn khi người dùng đang ở gần cuối: nếu họ đang đọc tin cũ thì không
  // được giật khung nhìn.
  if (force || distance < 120) list.scrollTop = list.scrollHeight;
}

/* --------------------------------------------------------------------------
   Composer: định dạng, đính kèm, gửi
   -------------------------------------------------------------------------- */

function chatInput() { return $("#chatInput"); }

function updateComposerState() {
  const input = chatInput();
  if (!input) return;
  const length = input.value.length;
  const hasAttachment = Boolean(chatPendingAttachment);
  const button = $("#chatSendButton");
  if (button) button.disabled = chatSending || (length === 0 && !hasAttachment);

  const hint = $("#chatComposerHint");
  if (hint) {
    if (length > CHAT_MAX_TEXT) {
      hint.textContent = `Vượt ${length - CHAT_MAX_TEXT} ký tự`;
      hint.className = "chat-hint over";
    } else {
      hint.textContent = length ? `${length}/${CHAT_MAX_TEXT}` : "";
      hint.className = "chat-hint";
    }
  }

  if (chatPreviewVisible) renderChatPreviewBox();
}

function wrapChatSelection(open, close) {
  const input = chatInput();
  if (!input) return;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const value = input.value;
  const selected = value.slice(start, end);
  const next = `${value.slice(0, start)}${open}${selected}${close}${value.slice(end)}`;
  input.value = next;

  const caret = selected
    ? start + open.length + selected.length + close.length
    : start + open.length;
  input.setSelectionRange(caret, caret);
  input.focus();
  updateComposerState();
}

function applyChatLinePrefix(prefixFor) {
  const input = chatInput();
  if (!input) return;
  const value = input.value;
  const start = input.selectionStart;
  const end = input.selectionEnd;

  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const lineEndRaw = value.indexOf("\n", end);
  const lineEnd = lineEndRaw === -1 ? value.length : lineEndRaw;

  const lines = value.slice(lineStart, lineEnd).split("\n");
  const firstPrefix = prefixFor(0);
  const allPrefixed = lines.every((line, index) => line.startsWith(prefixFor(index)));

  const next = lines.map((line, index) => {
    const prefix = prefixFor(index);
    if (allPrefixed) return line.slice(prefix.length);
    return line.startsWith(prefix) ? line : `${prefix}${line}`;
  }).join("\n");

  input.value = `${value.slice(0, lineStart)}${next}${value.slice(lineEnd)}`;
  const delta = next.length - (lineEnd - lineStart);
  input.setSelectionRange(start + delta, start + delta);
  input.focus();
  updateComposerState();
}

function applyChatFormat(kind) {
  if (CHAT_INLINE_MARKERS[kind]) {
    const [open, close] = CHAT_INLINE_MARKERS[kind];
    wrapChatSelection(open, close);
    return;
  }
  if (CHAT_LINE_PREFIXES[kind]) {
    applyChatLinePrefix(CHAT_LINE_PREFIXES[kind]);
  }
}

function renderChatPreviewBox() {
  const box = $("#chatPreviewBox");
  const input = chatInput();
  if (!box || !input) return;
  const html = renderChatPreviewHtml(input.value);
  box.innerHTML = html
    ? `<div class="preview-label">Xem trước</div><div class="preview-body">${html}</div>`
    : '<div class="preview-label">Xem trước</div><div class="preview-body muted">Chưa có nội dung.</div>';
}

function clearChatAttachment() {
  if (chatPendingAttachment?.previewUrl) {
    try { URL.revokeObjectURL(chatPendingAttachment.previewUrl); } catch (_) {}
  }
  chatPendingAttachment = null;
  const box = $("#chatAttachPreview");
  if (box) {
    box.hidden = true;
    box.innerHTML = "";
  }
  updateComposerState();
}

function renderChatAttachmentPreview() {
  const box = $("#chatAttachPreview");
  if (!box) return;
  const att = chatPendingAttachment;
  if (!att) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }

  const thumb = att.kind === "image" && att.previewUrl
    ? `<img src="${escapeHtml(att.previewUrl)}" alt="${escapeHtml(att.name)}" />`
    : `<span class="attach-icon">${att.kind === "image" ? "🖼" : "📄"}</span>`;

  box.innerHTML = `
    <div class="attach-card">
      ${thumb}
      <div class="attach-meta">
        <strong>${escapeHtml(att.name)}</strong>
        <small>${escapeHtml(formatChatFileSize(att.size))}${att.kind === "file" ? " · gửi dạng tệp" : ""}</small>
      </div>
      <button type="button" class="attach-remove" id="chatAttachRemove" title="Bỏ đính kèm">×</button>
    </div>`;

  box.hidden = false;
  $("#chatAttachRemove")?.addEventListener("click", clearChatAttachment);
  updateComposerState();
}

async function uploadChatAttachment(file) {
  const isImage = /^image\/(jpeg|png|gif|webp)$/i.test(file.type);
  const formData = new FormData();
  formData.append("file", file);
  formData.append("mediaType", isImage ? "chat-image" : "chat-file");

  showChatNotice("Đang tải tệp lên…");
  const response = await fetch(`${base}/api/admin/media/upload`, {
    method: "POST",
    credentials: "same-origin",
    body: formData
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Tải tệp thất bại");

  return {
    kind: isImage ? "image" : "file",
    media: data.media,
    name: file.name || data.media?.originalName || "tệp",
    size: file.size || data.media?.size || 0,
    previewUrl: isImage ? URL.createObjectURL(file) : null
  };
}

async function submitChatMessage() {
  if (!chatActiveConv || chatSending) return;
  const input = chatInput();
  if (!input) return;

  const text = input.value.trim();
  if (!text && !chatPendingAttachment) return;
  if (text.length > CHAT_MAX_TEXT) {
    showChatNotice(`Tin nhắn vượt ${text.length - CHAT_MAX_TEXT} ký tự`, true);
    return;
  }

  const { botId, chatId } = chatActiveConv;
  const attachment = chatPendingAttachment;

  chatSending = true;
  updateComposerState();

  try {
    const body = { botId, chatId, text };
    if (attachment?.kind === "image") body.mediaId = attachment.media.mediaId;
    if (attachment?.kind === "file") body.fileMediaId = attachment.media.mediaId;

    const result = await api("/api/admin/chat/send", {
      method: "POST",
      body: JSON.stringify(body)
    });

    if (!result.sent) {
      showChatNotice(`Gửi thất bại: ${result.error || "lỗi không rõ"}`, true);
      return;
    }

    input.value = "";
    clearChatAttachment();
    if (result.deliveryMode === "link") {
      showChatNotice("Bot chính thức chưa hỗ trợ đính kèm tệp — đã gửi dạng liên kết tải.");
    }
    await fetchNewChatMessages();
  } catch (error) {
    showChatNotice(`Lỗi: ${error.message}`, true);
  } finally {
    chatSending = false;
    updateComposerState();
    input.focus();
  }
}

/* --------------------------------------------------------------------------
   Gắn sự kiện
   -------------------------------------------------------------------------- */

$("#chatSendForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  submitChatMessage();
});

$("#chatInput")?.addEventListener("keydown", (event) => {
  // Ctrl/Cmd + B/I/U: định dạng nhanh như trình soạn thảo quen thuộc.
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
    const shortcut = { b: "bold", i: "italic", u: "underline" }[event.key.toLowerCase()];
    if (shortcut) {
      event.preventDefault();
      applyChatFormat(shortcut);
      return;
    }
  }

  if (event.key !== "Enter") return;
  // Shift+Enter: xuống dòng — để trình soạn thảo tự xử lý.
  if (event.shiftKey) return;
  // Đang gõ tiếng Việt qua bộ gõ (Telex/VNI): Enter là để CHỐT ÂM TIẾT, không
  // phải gửi tin. Bỏ qua để không gửi tin dở dang.
  if (event.isComposing || event.keyCode === 229) return;

  event.preventDefault();
  submitChatMessage();
});

$("#chatInput")?.addEventListener("input", updateComposerState);

// Giữ vùng chọn của textarea khi bấm nút định dạng: nếu để nút nhận focus,
// một số trình duyệt đặt lại selection và việc bọc ký hiệu sẽ rơi vào cuối dòng.
$("#chatFormatBar")?.addEventListener("mousedown", (event) => {
  if (event.target.closest("[data-format]")) event.preventDefault();
});

$("#chatFormatBar")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-format]");
  if (!button) return;
  event.preventDefault();
  applyChatFormat(button.dataset.format);
});

$("#chatPreviewToggle")?.addEventListener("click", () => {
  chatPreviewVisible = !chatPreviewVisible;
  const box = $("#chatPreviewBox");
  if (box) box.hidden = !chatPreviewVisible;
  const toggle = $("#chatPreviewToggle");
  if (toggle) {
    toggle.classList.toggle("active", chatPreviewVisible);
    toggle.setAttribute("aria-pressed", String(chatPreviewVisible));
  }
  if (chatPreviewVisible) renderChatPreviewBox();
});

$("#chatAttachButton")?.addEventListener("click", () => $("#chatFileInput")?.click());

$("#chatFileInput")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;

  if (chatPendingAttachment) {
    showChatNotice("Chỉ gửi được một tệp mỗi tin — hãy bỏ tệp đang chờ trước.", true);
    return;
  }

  try {
    chatPendingAttachment = await uploadChatAttachment(file);
    renderChatAttachmentPreview();
    showChatNotice("");
  } catch (error) {
    showChatNotice(`Tải tệp thất bại: ${error.message}`, true);
  }
});

$("#chatSearch")?.addEventListener("input", renderChatConversations);
$("#chatRefresh")?.addEventListener("click", () => refreshChatFromServer());

// Đóng luồng khi rời tab hoặc ẩn trang để không giữ kết nối vô ích.
window.addEventListener("beforeunload", () => {
  try { chatStream?.close(); } catch (_) {}
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  // Quay lại tab: hội thoại có thể đã có tin mới trong lúc tab bị treo.
  if (!chatStream) connectChatStream();
  refreshChatFromServer();
});


/* ===========================================================================
   FRIEND REQUESTS (ZCA — tài khoản Zalo cá nhân)
   =========================================================================== */

const FRIEND_REQUEST_MODE_LABELS = { manual: "Thủ công", auto: "Tự động", disabled: "Tắt" };

const FRIEND_REQUEST_STATUS_LABELS = {
  pending: "Chờ xác nhận",
  processing: "Đang xử lý",
  accepted: "Đã chấp nhận",
  rejected: "Đã từ chối",
  already_friends: "Đã là bạn",
  cancelled: "Đã thu hồi",
  failed: "Lỗi",
  requires_verification: "Cần kiểm tra"
};

const FRIEND_REQUEST_STATUS_TONES = {
  pending: "warning",
  processing: "neutral",
  accepted: "success",
  rejected: "neutral",
  already_friends: "success",
  cancelled: "neutral",
  failed: "danger",
  requires_verification: "danger"
};

// Trạng thái còn thao tác được. Khớp OPERABLE_STATUSES phía máy chủ — nhưng máy
// chủ vẫn là nơi quyết định; đây chỉ để ẩn nút không dùng được.
//
// `cancelled` nằm ở đây vì cờ trạng thái của Zalo từng trả sai và làm một lời mời
// thật bị đánh dấu huỷ. Không có đường thử lại thì bản ghi đó kẹt vĩnh viễn.
const FRIEND_REQUEST_OPERABLE = new Set(["pending", "cancelled", "failed", "requires_verification"]);

let friendRequestState = null;
const friendRequestBusy = new Set();
let friendRequestSearch = "";

async function loadFriendRequests() {
  const accountId = $("#friendRequestAccount")?.value || "";
  const query = new URLSearchParams();
  if (accountId) query.set("botId", accountId);
  if (friendRequestSearch) query.set("search", friendRequestSearch);
  try {
    const data = await api(`/api/admin/friend-requests${query.toString() ? `?${query}` : ""}`);
    friendRequestState = data;
    renderFriendRequests();
  } catch (error) {
    friendRequestState = null;
    const target = $("#friendRequestPending");
    if (target) target.innerHTML = `<div class="empty-state">Không tải được lời mời kết bạn: ${escapeHtml(error.message)}</div>`;
  }
}

function friendRequestStatusBadge(status) {
  return badge(FRIEND_REQUEST_STATUS_LABELS[status] || status, FRIEND_REQUEST_STATUS_TONES[status] || "neutral");
}

// Một dòng kết quả thông báo của một kênh. Hiện NGUYÊN VĂN lỗi thay vì chỉ "lỗi":
// quản trị viên cần biết kênh nào hỏng và vì sao.
function friendRequestChannelResult(record, channel, label) {
  const entry = record?.notifications?.[channel];
  if (!entry) return "";
  const when = entry.at ? formatDate(entry.at) : "";
  if (entry.status === "sent") {
    return `<span class="fr-channel ok">✓ ${escapeHtml(label)}${when ? ` · ${escapeHtml(when)}` : ""}</span>`;
  }
  if (entry.status === "failed") {
    return `<span class="fr-channel failed">✕ ${escapeHtml(label)}: ${escapeHtml(entry.error || "gửi thất bại")}</span>`;
  }
  return "";
}

function renderFriendRequestCard(record, options = {}) {
  const pending = options.pending === true;
  const busy = friendRequestBusy.has(record.requestId);
  // Bản ghi đã đóng vẫn có thể còn thao tác được (huỷ oan, lỗi tạm). Nếu không có
  // nút ở đây thì quản trị viên chỉ còn cách sửa tay trong Firestore.
  const operable = FRIEND_REQUEST_OPERABLE.has(record.status);
  const avatar = record.avatar
    ? `<img class="fr-avatar" src="${escapeHtml(record.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : `<span class="fr-avatar fr-avatar-empty">${escapeHtml(String(record.displayName || record.userId || "?").slice(0, 1).toUpperCase())}</span>`;

  // MỌI giá trị dẫn xuất phải khai báo TRƯỚC chuỗi HTML.
  //
  // `const` là vùng tạm thời chết (TDZ): dùng nó trong template literal ở phía trên
  // khai báo sẽ ném "Cannot access 'welcomed' before initialization" ngay lúc vẽ,
  // và vì lỗi ném trong .then() của lần đồng bộ nên giao diện báo "Đồng bộ thất bại".
  // Đây đúng là lỗi đã xảy ra một lần với `chatStream`.
  //
  // Tin chào chỉ gửi được cho người ĐÃ kết bạn. Nút này là đường thoát khi tin chào
  // bị bỏ lỡ lúc chấp nhận (tính năng đang tắt, hoặc nội dung đặt sau).
  const canWelcome = ["accepted", "already_friends"].includes(record.status);
  const welcomeStatus = record.notifications?.["zca:welcome"]?.status || null;

  // Phương thức chỉ có nghĩa khi một thao tác THẬT đã chạy. "Đã thu hồi · tự động"
  // là vô nghĩa: huỷ không phải là một lần xử lý.
  const acted = ["accepted", "rejected", "already_friends"].includes(record.status);

  const acceptReject = `<button class="primary small" type="button" data-fr-action="accept" data-fr-id="${escapeHtml(record.requestId)}" ${busy || !operable ? "disabled" : ""}>${busy ? "Đang xử lý…" : "Chấp nhận"}</button>
         <button class="ghost small" type="button" data-fr-action="reject" data-fr-id="${escapeHtml(record.requestId)}" ${busy || !operable ? "disabled" : ""}>Từ chối</button>`;

  const welcomeButton = canWelcome
    ? `<button class="ghost small" type="button" data-fr-action="welcome" data-fr-id="${escapeHtml(record.requestId)}" ${busy ? "disabled" : ""}>${welcomeStatus === "sent" ? "Gửi lại tin chào" : "Gửi tin chào"}</button>`
    : "";

  const actions = pending
    ? `<div class="row-actions">
         ${acceptReject}
         <button class="ghost small" type="button" data-fr-action="details" data-fr-id="${escapeHtml(record.requestId)}">Chi tiết</button>
       </div>`
    : `<div class="row-actions">
         ${operable ? acceptReject : ""}
         ${welcomeButton}
         <button class="ghost small" type="button" data-fr-action="details" data-fr-id="${escapeHtml(record.requestId)}">Chi tiết</button>
         <button class="ghost small" type="button" data-fr-action="retry" data-fr-id="${escapeHtml(record.requestId)}" ${busy ? "disabled" : ""}>Gửi lại thông báo lỗi</button>
       </div>`;
  const method = acted && record.processedMethod
    ? (record.processedMethod === "auto" ? "tự động" : record.processedMethod === "system" ? "hệ thống" : "thủ công")
    : null;

  return `<article class="fr-card${pending ? "" : " closed"}">
    ${avatar}
    <div class="fr-body">
      <div class="fr-title">
        <strong>${escapeHtml(record.displayName || "(không có tên)")}</strong>
        ${friendRequestStatusBadge(record.status)}
      </div>
      <div class="fr-meta">
        <span>User ID ${escapeHtml(record.userId || "-")}</span>
        <span>${escapeHtml(record.accountId || "-")}</span>
        <span>${escapeHtml(formatDate(record.requestedAt || record.detectedAt))}</span>
      </div>
      ${record.message ? `<p class="fr-message">“${escapeHtml(record.message)}”</p>` : ""}
      ${record.lastError ? `<p class="fr-error">${escapeHtml(record.lastError)}</p>` : ""}
      <div class="fr-channels">
        ${friendRequestChannelResult(record, "official", "Bot chính thức")}
        ${friendRequestChannelResult(record, "zca", "ZCA")}
        ${record.notifications?.welcome ? `<span class="fr-channel ${record.notifications.welcome.status === "sent" ? "ok" : "failed"}">Tin chào: ${escapeHtml(record.notifications.welcome.status)}</span>` : ""}
      </div>
      ${pending ? "" : `<div class="fr-meta"><span>Xử lý lúc ${escapeHtml(formatDate(record.processedAt))}</span>${method ? `<span>${escapeHtml(method)}</span>` : ""}${record.processedBy ? `<span>${escapeHtml(record.processedBy)}</span>` : ""}</div>`}
      ${actions}
    </div>
  </article>`;
}

function renderFriendRequestBanner(state) {
  const banner = $("#friendRequestBanner");
  if (!banner) return;
  const problems = [];

  if (!state.accounts || state.accounts.length === 0) {
    problems.push("Không có tài khoản ZCA nào. Bật ZCA_ENABLED và đăng nhập QR ở tab Tổng quan trước.");
  } else if (!state.accounts.some((account) => account.authenticated)) {
    problems.push("Tài khoản ZCA chưa đăng nhập nên không đọc được lời mời kết bạn.");
  }

  const recipients = state.recipients || {};
  const official = recipients.official || {};
  const zca = recipients.zca || {};
  if (official.enabled && !official.valid) problems.push(`Kênh bot chính thức: ${official.reason || "chưa có người nhận."}`);
  if (zca.enabled && !zca.valid) problems.push(`Kênh ZCA: ${zca.reason || "chưa có người nhận."}`);

  if (state.autoAccept?.suspended) {
    problems.push(`Tự động chấp nhận đang TẠM DỪNG: ${state.autoAccept.suspendedReason || "có lỗi liên tiếp"}. Chuyển sang Thủ công rồi bật lại để tiếp tục.`);
  }

  banner.hidden = problems.length === 0;
  banner.className = "app-status error";
  banner.innerHTML = problems.map((line) => `<div>${escapeHtml(line)}</div>`).join("");
}

function renderFriendRequestSettings(state) {
  const settings = state.settings || {};
  const auto = settings.autoAccept || {};

  $$("#friendRequestMode button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === settings.mode);
  });

  const autoState = state.autoAccept || {};
  $("#friendRequestAutoState").textContent = settings.mode === "auto"
    ? (autoState.allowed
      ? "Đang bật — sẵn sàng chấp nhận lời mời tiếp theo."
      : `Đang bật nhưng tạm chưa chạy: ${autoState.detail || autoState.reason || "chưa đủ điều kiện"}.`)
    : (settings.mode === "disabled"
      ? "Đang tắt: chỉ đồng bộ và xem, không tự chấp nhận."
      : "Đang thủ công: mọi lời mời chờ quản trị viên duyệt.");

  if (document.activeElement !== $("#friendRequestMaxPerHour")) $("#friendRequestMaxPerHour").value = auto.maxPerHour ?? 5;
  if (document.activeElement !== $("#friendRequestMinInterval")) $("#friendRequestMinInterval").value = Math.round((auto.minIntervalMs ?? 60000) / 1000);
  if (document.activeElement !== $("#friendRequestSyncInterval")) $("#friendRequestSyncInterval").value = Math.round((settings.syncIntervalMs ?? 60000) / 1000);
  if (document.activeElement !== $("#friendRequestSuspendAfter")) $("#friendRequestSuspendAfter").value = auto.suspendAfterErrors ?? 3;

  $("#friendRequestWelcomeEnabled").checked = settings.welcome?.enabled === true;
  if (document.activeElement !== $("#friendRequestWelcomeMessage")) {
    $("#friendRequestWelcomeMessage").value = settings.welcome?.message || "";
  }
}

function renderFriendRequestChannels(state) {
  const recipients = state.recipients || {};
  const settings = state.settings?.notifications || {};

  for (const channel of ["official", "zca"]) {
    const config = settings[channel] || {};
    const info = recipients[channel] || {};
    const enabledInput = channel === "official" ? $("#friendRequestOfficialEnabled") : $("#friendRequestZcaEnabled");
    const statusNode = channel === "official" ? $("#friendRequestOfficialStatus") : $("#friendRequestZcaStatus");
    const select = channel === "official" ? $("#friendRequestOfficialTarget") : $("#friendRequestZcaTarget");

    enabledInput.checked = config.enabled === true;

    const candidates = Array.isArray(info.candidates) ? info.candidates : [];
    const current = info.chatId || "";
    const options = [`<option value="">${info.valid ? "Dùng người nhận mặc định" : "-- Chọn hội thoại --"}</option>`];
    let matched = false;
    for (const candidate of candidates) {
      const value = String(candidate.chatId || "");
      if (!value) continue;
      if (value === current) matched = true;
      const label = channel === "official"
        ? `${candidate.chatId} · ${candidate.botId || "?"}`
        : `${candidate.displayName || candidate.chatId}${candidate.source === "owner_user_id" ? " (OWNER_USER_ID)" : ""}`;
      options.push(`<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(label)}</option>`);
    }
    // Giá trị đang dùng mà không nằm trong danh sách: vẫn phải hiện, nếu không
    // quản trị viên sẽ tưởng chưa cấu hình và ghi đè mất.
    if (current && !matched) {
      options.push(`<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (đang dùng)</option>`);
    }
    select.innerHTML = options.join("");

    if (info.valid) {
      const source = info.source === "owner_user_id" ? "OWNER_USER_ID" : info.source === "manual" ? "chọn tay" : "owner";
      statusNode.textContent = `Người nhận: ${info.chatId} · ${source}`;
      statusNode.className = "field-hint";
    } else {
      statusNode.textContent = info.reason || "Chưa có người nhận hợp lệ.";
      statusNode.className = "field-hint fr-warn";
    }
  }
}

function renderFriendRequests() {
  const state = friendRequestState;
  if (!state) return;

  renderFriendRequestBanner(state);
  renderFriendRequestSettings(state);
  renderFriendRequestChannels(state);

  const accountSelect = $("#friendRequestAccount");
  const accounts = Array.isArray(state.accounts) ? state.accounts : [];
  const selectedAccount = accountSelect.value;
  accountSelect.innerHTML = ['<option value="">Tất cả tài khoản ZCA</option>']
    .concat(accounts.map((account) => `<option value="${escapeHtml(account.accountId)}">${escapeHtml(account.label || account.accountId)}${account.authenticated ? "" : " (chưa đăng nhập)"}</option>`))
    .join("");
  accountSelect.value = selectedAccount;

  const pending = Array.isArray(state.pending) ? state.pending : [];
  $("#friendRequestPendingCount").textContent = String(pending.length);
  $("#friendRequestPending").innerHTML = pending.length === 0
    ? '<div class="empty-state">Không có lời mời nào đang chờ.</div>'
    : pending.map((record) => renderFriendRequestCard(record, { pending: true })).join("");

  const history = Array.isArray(state.history) ? state.history : [];
  $("#friendRequestHistory").innerHTML = history.length === 0
    ? '<div class="empty-state">Chưa có lịch sử.</div>'
    : history.map((record) => renderFriendRequestCard(record, { pending: false })).join("");
}

async function saveFriendRequestSettings(patch, failureLabel) {
  const outcome = await runAction(
    () => api("/api/admin/friend-requests/settings", { method: "POST", body: JSON.stringify(patch) }),
    failureLabel
  );
  if (outcome.ok) {
    friendRequestState = outcome.result.state || friendRequestState;
    renderFriendRequests();
    setDataState("success", "Đã lưu cài đặt lời mời kết bạn.");
  }
  return outcome.ok;
}

async function handleFriendRequestAction(action, requestId) {
  if (friendRequestBusy.has(requestId)) return;
  friendRequestBusy.add(requestId);
  renderFriendRequests();

  try {
    if (action === "accept" || action === "reject") {
      const result = await api(`/api/admin/friend-requests/${action}`, {
        method: "POST",
        body: JSON.stringify({ requestId })
      });
      friendRequestState = result.state || friendRequestState;
      if (result.ok) {
        setDataState("success", action === "accept" ? "Đã chấp nhận lời mời kết bạn." : "Đã từ chối lời mời kết bạn.");
      } else {
        // Không báo thành công khi nhà cung cấp chưa xác nhận. Nêu đúng lý do.
        setDataState("error", result.error || `Không xử lý được lời mời (${result.reason || "không rõ"}).`);
      }
    } else if (action === "retry") {
      const record = (friendRequestState?.pending || []).concat(friendRequestState?.history || [])
        .find((item) => item.requestId === requestId);
      const failedChannel = ["official", "zca"].find((channel) => record?.notifications?.[channel]?.status === "failed");
      if (!failedChannel) {
        setDataState("error", "Lời mời này không có kênh thông báo nào lỗi.");
      } else {
        const result = await api("/api/admin/friend-requests/retry-notification", {
          method: "POST",
          body: JSON.stringify({ requestId, channel: failedChannel })
        });
        friendRequestState = result.state || friendRequestState;
        setDataState(result.ok ? "success" : "error", result.ok ? "Đã gửi lại thông báo." : (result.error || "Gửi lại thất bại."));
      }
    } else if (action === "welcome") {
      const result = await api("/api/admin/friend-requests/send-welcome", {
        method: "POST",
        body: JSON.stringify({ requestId })
      });
      friendRequestState = result.state || friendRequestState;
      setDataState(result.ok ? "success" : "error", result.ok ? "Đã gửi tin chào." : (result.error || "Gửi tin chào thất bại."));
    } else if (action === "details") {
      const record = (friendRequestState?.pending || []).concat(friendRequestState?.history || [])
        .find((item) => item.requestId === requestId);
      if (record) {
        const lines = [
          `Tên: ${record.displayName || "(không có tên)"}`,
          `User ID: ${record.userId}`,
          `Tài khoản: ${record.accountId}`,
          `Trạng thái: ${FRIEND_REQUEST_STATUS_LABELS[record.status] || record.status}`,
          `Phát hiện: ${formatDate(record.detectedAt)}`,
          `Yêu cầu lúc: ${formatDate(record.requestedAt)}`,
          record.message ? `Lời nhắn: ${record.message}` : "",
          record.processedAt ? `Xử lý: ${formatDate(record.processedAt)} · ${record.processedMethod || "-"} · ${record.processedBy || "-"}` : "",
          record.lastError ? `Lỗi gần nhất: ${record.lastError}` : "",
          `Số lần thử: ${record.attempts || 0}`,
          `Thế hệ lời mời: ${record.generation || 1}`
        ].filter(Boolean);
        alert(lines.join("\n"));
      }
    }
  } catch (error) {
    setDataState("error", `Thao tác thất bại: ${error.message}`);
  } finally {
    friendRequestBusy.delete(requestId);
    renderFriendRequests();
  }
}

// Gắn sự kiện một lần. Dùng ủy nhiệm trên panel nên không phải gắn lại sau mỗi
// lần vẽ lại danh sách.
function bindFriendRequestControls() {
  const panel = document.querySelector('[data-panel="friendrequests"]');
  if (!panel || panel.dataset.bound === "1") return;
  panel.dataset.bound = "1";

  panel.addEventListener("click", (event) => {
    const actionButton = event.target.closest("[data-fr-action]");
    if (actionButton) {
      handleFriendRequestAction(actionButton.dataset.frAction, actionButton.dataset.frId);
      return;
    }

    const modeButton = event.target.closest("#friendRequestMode button");
    if (modeButton) {
      saveFriendRequestSettings({ mode: modeButton.dataset.mode }, "Không đổi được chế độ xử lý");
      return;
    }

    const testButton = event.target.closest("[data-test-channel]");
    if (testButton) {
      const channel = testButton.dataset.testChannel;
      const target = channel === "official" ? $("#friendRequestOfficialResult") : $("#friendRequestZcaResult");
      target.textContent = "Đang gửi…";
      api("/api/admin/friend-requests/test-notification", {
        method: "POST",
        body: JSON.stringify({ channel })
      })
        .then((result) => {
          target.textContent = result.ok
            ? `✓ Đã gửi thử tới ${result.chatId || "người nhận"}.`
            : `✕ ${result.error || "gửi thử thất bại"}`;
          target.className = `field-hint ${result.ok ? "" : "fr-warn"}`;
        })
        .catch((error) => {
          target.textContent = `✕ ${error.message}`;
          target.className = "field-hint fr-warn";
        });
      return;
    }

    if (event.target.closest("#friendRequestRefresh")) {
      $("#friendRequestRefresh").disabled = true;
      api("/api/admin/friend-requests/sync", { method: "POST", body: JSON.stringify({ botId: $("#friendRequestAccount").value || null }) })
        .then((result) => {
          friendRequestState = result.state || friendRequestState;
          renderFriendRequests();
          const summary = result.accounts
            ? result.accounts.map((item) => `${item.accountId}: +${item.added || 0}`).join(", ")
            : `+${result.added || 0} lời mời mới`;
          setDataState(result.ok === false ? "error" : "success", result.ok === false ? (result.error || "Đồng bộ thất bại") : `Đã đồng bộ (${summary}).`);
        })
        .catch((error) => setDataState("error", `Đồng bộ thất bại: ${error.message}`))
        .finally(() => { $("#friendRequestRefresh").disabled = false; });
      return;
    }

    if (event.target.closest("#friendRequestSaveLimits")) {
      saveFriendRequestSettings({
        autoAccept: {
          maxPerHour: Number($("#friendRequestMaxPerHour").value),
          minIntervalMs: Number($("#friendRequestMinInterval").value) * 1000,
          suspendAfterErrors: Number($("#friendRequestSuspendAfter").value)
        },
        syncIntervalMs: Number($("#friendRequestSyncInterval").value) * 1000
      }, "Không lưu được giới hạn");
      return;
    }

    if (event.target.closest("#friendRequestSaveWelcome")) {
      const enabled = $("#friendRequestWelcomeEnabled").checked;
      const message = $("#friendRequestWelcomeMessage").value.trim();
      saveFriendRequestSettings({ welcome: { enabled, message } }, "Không lưu được tin chào").then((ok) => {
        // Bẫy dễ mắc: gõ nội dung rồi bấm Lưu nhưng quên bật công tắc. Nói thẳng
        // ra thay vì để họ tưởng đã cấu hình xong.
        if (ok && !enabled && message) {
          setDataState("error", "Đã lưu nội dung nhưng tin chào đang TẮT — bật công tắc \"Gửi tin chào sau khi kết bạn xong\" để gửi.");
        }
      });
    }
  });

  // Công tắc kênh: bật/tắt độc lập, mỗi kênh một lần gọi.
  for (const [channel, selector] of [["official", "#friendRequestOfficialEnabled"], ["zca", "#friendRequestZcaEnabled"]]) {
    $(selector)?.addEventListener("change", (event) => {
      const patch = { notifications: {} };
      patch.notifications[channel] = { enabled: event.target.checked };
      saveFriendRequestSettings(patch, "Không đổi được kênh thông báo");
    });
  }

  // Đổi người nhận: ghi đè tường minh, nên giá trị rỗng nghĩa là quay về mặc định.
  for (const [channel, selector] of [["official", "#friendRequestOfficialTarget"], ["zca", "#friendRequestZcaTarget"]]) {
    $(selector)?.addEventListener("change", (event) => {
      const patch = { notifications: {} };
      patch.notifications[channel] = { chatId: event.target.value || null };
      saveFriendRequestSettings(patch, "Không đổi được người nhận");
    });
  }

  $("#friendRequestAccount")?.addEventListener("change", () => loadFriendRequests());

  let searchTimer = null;
  $("#friendRequestSearch")?.addEventListener("input", (event) => {
    const value = event.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { friendRequestSearch = value; loadFriendRequests(); }, 300);
  });
}

bindFriendRequestControls();

/* ---------------------------------------------------------------------------
   Khôi phục tab đã lưu — PHẢI nằm ở cuối tệp.

   switchTab() chạm tới biến `let` của phần Chat Center; nếu chạy trước khi tệp
   nạp xong thì ném "Cannot access 'chatStream' before initialization" và toàn bộ
   dashboard không khởi động được.
   --------------------------------------------------------------------------- */

// Liên kết sâu: thông báo lời mời kết bạn trỏ tới #friendrequests. Hash thắng tab
// đã lưu để bấm vào thông báo là mở đúng chỗ, không phải tự tìm tab.
const hashTab = String(location.hash || "").replace(/^#/, "");
if (hashTab && $$(".tab-button").some((button) => button.dataset.tab === hashTab)) {
  localStorage.setItem("zalobot-admin-tab", hashTab);
}
switchTab(localStorage.getItem("zalobot-admin-tab") || "overview");
