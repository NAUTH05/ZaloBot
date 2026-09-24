const base = new URL(document.baseURI).pathname.replace(/\/$/, "");
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[char]));
let workspace = null;
let dashboard = null;
let logs = null;
let settings = null;
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

function formatDate(value) { if (!value) return "-"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("vi-VN"); }function badge(value, tone = "neutral") { return `<span class="badge badge-${tone}">${escapeHtml(value)}</span>`; }
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
  if (!botId) return record?.sourceLabel || "Chưa xác minh";
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
  if (!botId) return "Chưa xác minh";
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
// Bản ghi chưa xác minh hiển thị rõ là "Chưa xác minh" kèm lý do, KHÔNG hiển thị
// như một bot cụ thể — đó chính là lỗi trước đây.
function botCell(record) {
  const botId = recordBotId(record);
  if (!botId) {
    const reason = record?.sourceReason || "Không đủ căn cứ xác định nguồn.";
    return `<td><span class="bot-chip bot-chip-unverified" title="${escapeHtml(reason)}">Chưa xác minh</span></td>`;
  }
  const kind = botId.startsWith("zca:") ? "Tài khoản Zalo cá nhân" : "Bot chính thức";
  return `<td><span class="bot-chip" title="${escapeHtml(`${botId} · ${kind}`)}">${escapeHtml(botLabel(botId))}</span><small class="block">${escapeHtml(kind)}</small></td>`;
}

// Nhãn nguồn chỉ hiện khi xem tất cả — lọc một nguồn rồi thì nó là thừa.
function botBadge(record) {
  if (activeBotFilter() !== "all") return "";
  const botId = recordBotId(record);
  if (!botId) return badge("Chưa xác minh", "warning");
  return badge(botLabel(botId), botId.startsWith("zca:") ? "info" : "neutral");
}

// Nút thao tác trên một bản ghi.
//
// Nguồn CHƯA XÁC MINH thì nút bị vô hiệu và nêu rõ lý do: mở chi tiết hay gửi tin
// theo một nguồn đoán mò có thể liên hệ nhầm người hoặc nhầm tài khoản.
function actionButton(attribute, value, botId, record, label, className = "table-action") {
  if (!botId) {
    const reason = record?.sourceReason || "Chưa xác định được nguồn của bản ghi này.";
    return `<button class="${escapeHtml(className)}" disabled title="${escapeHtml(`Không thể thao tác: ${reason}`)}">${escapeHtml(label)}</button>` +
      `<small class="block error-cell">Cần xác minh nguồn</small>`;
  }
  return `<button class="${escapeHtml(className)}" ${attribute}="${escapeHtml(value)}" data-record-bot="${escapeHtml(botId)}">${escapeHtml(label)}</button>`;
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
    // "Chưa xác minh" là một mục lọc RIÊNG, không gộp vào bot1: những bản ghi này
    // không chứng minh được là của bot nào.
    filter.innerHTML = botOptionsHtml(true) +
      `<option value="${UNVERIFIED_BOT_ID}">Chưa xác minh</option>`;
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

function renderGroups() {
  const query = $("#groupSearch").value.trim().toLowerCase();
  const groups = filterByBot(workspace.groups).filter((group) => JSON.stringify(group).toLowerCase().includes(query));
  $("#groupCards").innerHTML = groups.map((group) => `<article class="group-card"><div class="card-heading"><div><span class="eyebrow">${escapeHtml(group.typeSource)}</span><h2>${escapeHtml(group.displayName)}</h2><code>${escapeHtml(group.chatId)}</code> <span class="bot-chip">${escapeHtml(botLabel(recordBotId(group)))}</span></div>${badge(group.status, statusTone(group.status))}</div><div class="group-stats"><span><strong>${group.memberCount}</strong> thành viên</span><span><strong>${group.studentIds.length}</strong> MSSV</span><span><strong>${group.enabledSubscriptionCount}</strong> đang nhận lịch</span></div><div class="member-preview">${group.members.slice(0, 6).map((member) => `<div><strong>${escapeHtml(member.displayName)}</strong><small>${escapeHtml(member.studentIds.join(", ") || "Chưa có MSSV")}</small></div>`).join("") || `<span class="muted">Chưa có dữ liệu thành viên</span>`}</div>${actionButton("data-chat-detail", group.chatId, recordBotId(group), group, "Xem toàn bộ nhóm", "secondary full")}</article>`).join("") || `<div class="empty-state panel">Không có nhóm phù hợp.</div>`;
  $$('#groupCards [data-chat-detail]').forEach((button) => button.addEventListener("click", () => openChat(button.dataset.chatDetail, button.dataset.chatBot)));
}

function renderDirectory() {
  const query = $("#directorySearch").value.trim().toLowerCase();
  const type = $("#directoryType").value;
  const chats = filterByBot(workspace.chats).filter((chat) => (type === "all" || chat.chatType === type) && JSON.stringify(chat).toLowerCase().includes(query));
  $("#directoryRows").innerHTML = chats.map((chat) => `<tr><td><strong>${escapeHtml(chat.displayName)}</strong><code>${escapeHtml(chat.chatId)}</code></td>${botCell(chat)}<td>${badge(chat.chatType, chat.chatType === "group" ? "info" : chat.chatType === "unknown" ? "warning" : "neutral")}<small class="block">${escapeHtml(chat.typeSource)}</small></td><td><code>${escapeHtml(chat.userId || "-")}</code></td><td>${badge(chat.status, statusTone(chat.status))}</td><td>${escapeHtml(chat.memberCount)} thành viên<small class="block">${escapeHtml(chat.studentIds.join(", ") || "Chưa có MSSV")}</small></td><td><small>Tương tác: ${escapeHtml(formatDate(chat.lastInboundInteractionAt))}</small><small class="block">Gửi thành công: ${escapeHtml(formatDate(chat.lastSuccessfulDeliveryAt))}</small></td><td>${actionButton("data-chat-detail", chat.chatId, recordBotId(chat), chat, "Quản lý")}</td></tr>`).join("") || emptyRow(8, "Không có cuộc trò chuyện phù hợp.");
  $$('#directoryRows [data-chat-detail]').forEach((button) => button.addEventListener("click", () => openChat(button.dataset.chatDetail, button.dataset.chatBot)));
}

function renderNotifications() {
  const filter = $("#notificationFilter").value;
  const list = filterByBot(workspace.subscriptions).filter((item) => filter === "all" || (filter === "enabled" && item.notificationsEnabled) || (filter === "disabled" && !item.notificationsEnabled) || (filter === "legacy" && item.schema === "legacy"));
  $("#notificationRows").innerHTML = list.map((item) => `<tr><td><strong>${escapeHtml(item.userDisplayName || item.userId || "Bản ghi cũ")}</strong> ${botBadge(item)}<code>${escapeHtml(item.userId || "-")}</code><div>${badge(item.studentId || "Chưa có MSSV", item.studentId ? "info" : "neutral")} ${escapeHtml(item.studentName)}</div></td><td><strong>${escapeHtml(item.chatName)}</strong><code>${escapeHtml(item.chatId)}</code></td><td>${badge(item.chatType, item.chatType === "group" ? "info" : "neutral")}</td><td>${timeChips(item.notificationTimes)}</td><td>${badge(item.schema, item.schema === "current" ? "success" : "warning")} ${badge(item.notificationsEnabled ? "Đang bật" : "Đang tắt", item.notificationsEnabled ? "success" : "neutral")}</td><td>${actionButton("data-subscription", item.key, recordBotId(item), item, "Quản lý")}</td></tr>`).join("") || emptyRow(6, "Không có đăng ký phù hợp.");
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

function renderLogs() {
  $("#systemLogList").innerHTML = (logs.system || []).map((item) => `<article class="stack-item"><strong>${escapeHtml(item.level)}</strong><p>${escapeHtml(item.message)}</p><small>${escapeHtml(formatDate(item.at))}</small></article>`).join("") || `<div class="empty-state">Không có log hệ thống.</div>`;
  $("#deliveryLogList").innerHTML = filterByBot(logs.deliveryErrors || []).map((item) => `<article class="stack-item"><strong>${escapeHtml(item.displayName || item.chatId)}</strong><p>${escapeHtml(item.lastError?.message || "-")}</p><small>${escapeHtml(formatDate(item.lastError?.at))}</small></article>`).join("") || `<div class="empty-state">Không có lỗi gửi gần đây.</div>`;
}

function ensurePaginationViews() {
  [["#directoryRows", "directory"], ["#userRows", "users"], ["#groupCards", "groups"], ["#notificationRows", "notifications"], ["#healthRows", "health"], ["#systemLogList", "systemLogs"], ["#deliveryLogList", "deliveryLogs"]].forEach(([selector, key]) => {
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
function applyPaginationViews() { ensurePaginationViews(); paginateRendered("#directoryRows", "directory"); paginateRendered("#userRows", "users"); paginateRendered("#groupCards", "groups"); paginateRendered("#notificationRows", "notifications"); paginateRendered("#healthRows", "health"); paginateRendered("#systemLogList", "systemLogs"); paginateRendered("#deliveryLogList", "deliveryLogs"); }
// Yêu cầu hỗ trợ: danh sách, bộ đếm và yêu cầu đang mở.
let feedbackTickets = [];
let feedbackCounts = { total: 0, unread: 0, open: 0, resolved: 0 };
let selectedFeedback = null;

function renderAll() { populateBotControls(); renderBotGrid(); renderOverview(); renderDirectory(); renderUsers(); renderGroups(); renderNotifications(); renderHealth(); renderSettings(); renderLogs(); setupCommandConsole(); renderCommands(); setupFeedback(); renderFeedback(); ensurePaginationViews(); applyPaginationViews(); $("#healthPill").textContent = `${dashboard.bot.status} · ${dashboard.bot.health}`; $("#generatedAt").textContent = formatDate(workspace.generatedAt); }

async function loadData() {
  setDataState("loading", "Loading admin data...");
  try {
    // Danh sách user cho Command console: ưu tiên endpoint đã khử trùng,
    // dự phòng bằng dữ liệu workspace đã tải.
    const targetUserRequest = api("/api/admin/target-users").then((data) => (Array.isArray(data.users) ? data.users : null)).catch(() => null);
    const botRequest = api("/api/admin/bots").then((data) => (Array.isArray(data.bots) ? data.bots : [])).catch(() => []);
    [workspace, dashboard, logs, settings, commandRegistry] = await Promise.all([api("/api/admin/workspace"), api("/api/admin/dashboard"), api("/api/admin/logs"), api("/api/admin/settings"), api("/api/admin/commands").then((data) => data.commands || [])]);
    bots = await botRequest;
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
function requireVerifiedSource(botId, what = "bản ghi này") {
  if (botId) return true;
  showDialog("Chưa xác minh nguồn",
    `<div class="empty-state"><p><strong>Không thể thao tác trên ${escapeHtml(what)}.</strong></p>` +
    `<p class="muted">Bản ghi này không có trường botId và khóa lưu trữ cũng không có phạm vi, nên chưa xác định được nó thuộc bot nào. ` +
    `Thao tác lúc này có thể gửi tin cho nhầm người hoặc nhầm tài khoản.</p>` +
    `<p class="muted">Cách xử lý: chạy <code>npm run migrate:attribution</code> để xem báo cáo, và chỉ gán nguồn khi có bằng chứng.</p></div>`);
  return false;
}

function openUser(userId, botId) {
  // Cùng một User ID ở hai bot là hai danh tính khác nhau, nên phải khớp cả bot.
  const wantedBot = recordBotId({ botId });
  if (!requireVerifiedSource(wantedBot, "người dùng này")) return;
  const user = workspace.users.find((item) => item.userId === userId && recordBotId(item) === wantedBot);
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
  if (!requireVerifiedSource(verifiedBotId, "cuộc trò chuyện này")) return;
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
  showDialog(`${item.studentId || "Đăng ký nhận lịch"} · ${item.chatName}`, `<div class="detail-grid"><div class="detail"><span>Người dùng</span><strong>${escapeHtml(item.userDisplayName || item.userId || "Bản ghi cũ")}</strong><code>${escapeHtml(item.userId || "-")}</code></div><div class="detail"><span>Chat</span><strong>${escapeHtml(item.chatName)}</strong><code>${escapeHtml(item.chatId)}</code></div><div class="detail"><span>Loại chat</span><strong>${escapeHtml(item.chatType)}</strong></div><div class="detail"><span>Cập nhật bản ghi</span><strong>${escapeHtml(formatDate(item.updatedAt))}</strong></div></div>${item.schema === "legacy" ? `<div class="warning-box">Bản ghi cũ không có userId rõ ràng; chỉ nên xem hoặc xóa.</div>` : `<form id="subscriptionMetaForm"><div class="form-grid"><label>MSSV<input name="studentId" value="${escapeHtml(item.studentId)}" /></label><label>Tên sinh viên<input name="studentName" value="${escapeHtml(item.studentName)}" /></label><label>Tên người dùng<input name="userDisplayName" value="${escapeHtml(item.userDisplayName)}" /></label></div><button class="primary" type="submit">Lưu thông tin</button></form><h3>Giờ nhận lịch</h3><div class="stack">${item.notificationTimes.map((time) => `<article class="stack-item horizontal"><div><strong>ID ${time.id} · ${escapeHtml(time.time)}</strong><small>${escapeHtml(targetDayText(time.targetDayOffset))} · đăng ký ${escapeHtml(formatDate(time.createdAt))} · cập nhật ${escapeHtml(formatDate(time.updatedAt))}</small></div><div class="row-actions"><button data-time-edit="${time.id}">Sửa</button><button class="danger-text" data-time-remove="${time.id}">Xóa</button></div></article>`).join("") || `<div class="empty-state">Chưa có giờ nhận lịch.</div>`}<button class="secondary" id="addTimeButton">Thêm giờ</button></div><div class="action-bar"><button data-sub-action="${item.notificationsEnabled ? "disable" : "enable"}">${item.notificationsEnabled ? "Tắt nhận lịch" : "Bật nhận lịch"}</button><button class="danger-text" data-sub-action="delete">Xóa đăng ký</button></div>`}`);
  if (item.schema === "legacy") return;
  $("#subscriptionMetaForm").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); await updateSubscription(item, { action: "metadata", ...Object.fromEntries(form.entries()) }); });
  $("#addTimeButton").addEventListener("click", () => openTimeDialog({ item }));
  $$('[data-time-edit]').forEach((button) => button.addEventListener("click", () => openTimeDialog({ item, time: item.notificationTimes.find((entry) => Number(entry.id) === Number(button.dataset.timeEdit)) })));
  $$('[data-time-remove]').forEach((button) => button.addEventListener("click", () => updateSubscription(item, { action: "remove_time", timeId: Number(button.dataset.timeRemove) })));
  $$('[data-sub-action]').forEach((button) => button.addEventListener("click", () => updateSubscription(item, { action: button.dataset.subAction, studentId: item.studentId, studentName: item.studentName })));
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
$("#botFilter").addEventListener("change", () => { if (workspace) renderAll(); }); $("#themeToggle").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
$("#closeDialog").addEventListener("click", () => $("#detailDialog").close());
const rerender = (fn, key) => { pageState[key] = { ...(pageState[key] || {}), page: 1 }; fn(); applyPaginationViews(); };
$("#userSearch").addEventListener("input", () => rerender(renderUsers, "users")); $("#groupSearch").addEventListener("input", () => rerender(renderGroups, "groups")); $("#notificationFilter").addEventListener("change", () => rerender(renderNotifications, "notifications")); $("#healthFilter").addEventListener("change", () => rerender(renderHealth, "health")); $("#healthType").addEventListener("change", () => rerender(renderHealth, "health"));
$("#directorySearch").addEventListener("input", () => rerender(renderDirectory, "directory")); $("#directoryType").addEventListener("change", () => rerender(renderDirectory, "directory")); $("#addChatButton").addEventListener("click", openCreateChat);
$("#addUserButton").addEventListener("click", openCreateUser);
$("#adminForm").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api("/api/admin/settings/admins", { method: "POST", body: JSON.stringify(Object.fromEntries(form.entries())) }); event.currentTarget.reset(); $("#adminFormMessage").textContent = "Đã lưu."; await loadData(); } catch (error) { $("#adminFormMessage").textContent = error.message; } });
// Command console tự gắn trình xử lý submit trong setupCommandConsole() vì nó
// cần đọc danh sách người nhận đã chọn và đi qua bước xác nhận.
$("#commandAdminIdentity")?.addEventListener("change", () => {});
$$('.tab-button').forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));
applyTheme(localStorage.getItem("zalobot-admin-theme") || "dark"); switchTab(localStorage.getItem("zalobot-admin-tab") || "overview");
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
