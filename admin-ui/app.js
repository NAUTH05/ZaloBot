const base = new URL(document.baseURI).pathname.replace(/\/$/, "");
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[char]));
let workspace = null;
let dashboard = null;
let logs = null;
let settings = null;

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
function formatDate(value) { if (!value) return "-"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("vi-VN"); }
function badge(value, tone = "neutral") { return `<span class="badge badge-${tone}">${escapeHtml(value)}</span>`; }
function statusTone(status) { return status === "active" ? "success" : status === "inactive" ? "danger" : status === "disabled" ? "warning" : "neutral"; }
function emptyRow(cols, text) { return `<tr><td colspan="${cols}" class="empty-state">${escapeHtml(text)}</td></tr>`; }
function timeChips(times = []) { return times.length ? `<div class="chip-list">${times.map((item) => `<span class="time-chip"><strong>#${escapeHtml(item.id)} · ${escapeHtml(item.time)}</strong><small>${escapeHtml(formatDate(item.createdAt))}</small></span>`).join("")}</div>` : `<span class="muted">Chưa có giờ nhận lịch</span>`; }

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
    ["Invalid chats", invalid, `${dashboard.notifications.failedDeliveries} failed deliveries`, "health"],
    ["Lịch trực", workspace.duty.schedules.length, `${workspace.duty.subscriptions.filter((item) => item.enabled).length} chat đăng ký`, "duty"]
  ].map(([label, value, note, tab]) => `<button class="metric" data-jump="${tab}"><span>${label}</span><strong>${value}</strong><small>${note}</small></button>`).join("");
  $$('[data-jump]').forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.jump)));
  const errors = [...(logs.system || []).slice(0, 5).map((item) => ({ title: `${item.level} · System`, detail: item.message, at: item.at })), ...(dashboard.recentErrors || []).slice(0, 5).map((item) => ({ title: item.displayName || item.chatId, detail: item.lastError?.message, at: item.lastError?.at }))];
  $("#errorList").innerHTML = errors.slice(0, 8).map((item) => `<article class="stack-item"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail || "-")}</p><small>${escapeHtml(formatDate(item.at))}</small></article>`).join("") || `<div class="empty-state">Không có lỗi gần đây.</div>`;
  $("#auditList").innerHTML = (dashboard.audit || []).map((item) => `<article class="stack-item"><strong>${escapeHtml(item.action)}</strong><p>${escapeHtml(item.admin)} · ${escapeHtml(item.result || "")}</p><small>${escapeHtml(formatDate(item.at))}</small></article>`).join("") || `<div class="empty-state">Chưa có hoạt động admin.</div>`;
}

function renderUsers() {
  const query = $("#userSearch").value.trim().toLowerCase();
  const users = workspace.users.filter((user) => JSON.stringify(user).toLowerCase().includes(query));
  $("#userRows").innerHTML = users.map((user) => {
    const times = user.subscriptions.flatMap((item) => item.notificationTimes.map((time) => ({ ...time, chatName: item.chatName })));
    return `<tr><td><strong>${escapeHtml(user.displayName)}</strong><code>${escapeHtml(user.userId)}</code></td><td>${user.chats.map((chat) => `<div class="context-line">${badge(chat.chatType, chat.chatType === "group" ? "info" : "neutral")} ${escapeHtml(chat.chatName)} <code>${escapeHtml(chat.chatId)}</code></div>`).join("")}</td><td>${user.studentIds.length ? user.studentIds.map((id) => badge(id, "info")).join(" ") : `<span class="muted">Chưa có MSSV</span>`}</td><td>${timeChips(times)}</td><td>${badge(user.status, statusTone(user.status))} ${badge(user.notificationsEnabled ? "Nhận lịch: bật" : "Nhận lịch: tắt", user.notificationsEnabled ? "success" : "neutral")}</td><td><button class="table-action" data-user="${escapeHtml(user.userId)}">Quản lý</button></td></tr>`;
  }).join("") || emptyRow(6, "Không tìm thấy người dùng phù hợp.");
  $$('[data-user]').forEach((button) => button.addEventListener("click", () => openUser(button.dataset.user)));
}

function renderGroups() {
  const query = $("#groupSearch").value.trim().toLowerCase();
  const groups = workspace.groups.filter((group) => JSON.stringify(group).toLowerCase().includes(query));
  $("#groupCards").innerHTML = groups.map((group) => `<article class="group-card"><div class="card-heading"><div><span class="eyebrow">${escapeHtml(group.typeSource)}</span><h2>${escapeHtml(group.displayName)}</h2><code>${escapeHtml(group.chatId)}</code></div>${badge(group.status, statusTone(group.status))}</div><div class="group-stats"><span><strong>${group.memberCount}</strong> thành viên</span><span><strong>${group.studentIds.length}</strong> MSSV</span><span><strong>${group.enabledSubscriptionCount}</strong> đang nhận lịch</span></div><div class="member-preview">${group.members.slice(0, 6).map((member) => `<div><strong>${escapeHtml(member.displayName)}</strong><small>${escapeHtml(member.studentIds.join(", ") || "Chưa có MSSV")}</small></div>`).join("") || `<span class="muted">Chưa có dữ liệu thành viên</span>`}</div><button class="secondary full" data-chat-detail="${escapeHtml(group.chatId)}">Xem toàn bộ nhóm</button></article>`).join("") || `<div class="empty-state panel">Không có nhóm phù hợp.</div>`;
  $$('#groupCards [data-chat-detail]').forEach((button) => button.addEventListener("click", () => openChat(button.dataset.chatDetail)));
}

function renderDirectory() {
  const query = $("#directorySearch").value.trim().toLowerCase();
  const type = $("#directoryType").value;
  const chats = workspace.chats.filter((chat) => (type === "all" || chat.chatType === type) && JSON.stringify(chat).toLowerCase().includes(query));
  $("#directoryRows").innerHTML = chats.map((chat) => `<tr><td><strong>${escapeHtml(chat.displayName)}</strong><code>${escapeHtml(chat.chatId)}</code></td><td>${badge(chat.chatType, chat.chatType === "group" ? "info" : chat.chatType === "unknown" ? "warning" : "neutral")}<small class="block">${escapeHtml(chat.typeSource)}</small></td><td><code>${escapeHtml(chat.userId || "-")}</code></td><td>${badge(chat.status, statusTone(chat.status))}</td><td>${escapeHtml(chat.memberCount)} thành viên<small class="block">${escapeHtml(chat.studentIds.join(", ") || "Chưa có MSSV")}</small></td><td><small>Tương tác: ${escapeHtml(formatDate(chat.lastInboundInteractionAt))}</small><small class="block">Gửi thành công: ${escapeHtml(formatDate(chat.lastSuccessfulDeliveryAt))}</small></td><td><button class="table-action" data-chat-detail="${escapeHtml(chat.chatId)}">Quản lý</button></td></tr>`).join("") || emptyRow(7, "Không có cuộc trò chuyện phù hợp.");
  $$('#directoryRows [data-chat-detail]').forEach((button) => button.addEventListener("click", () => openChat(button.dataset.chatDetail)));
}

function renderNotifications() {
  const filter = $("#notificationFilter").value;
  const list = workspace.subscriptions.filter((item) => filter === "all" || (filter === "enabled" && item.notificationsEnabled) || (filter === "disabled" && !item.notificationsEnabled) || (filter === "legacy" && item.schema === "legacy"));
  $("#notificationRows").innerHTML = list.map((item) => `<tr><td><strong>${escapeHtml(item.userDisplayName || item.userId || "Bản ghi cũ")}</strong><code>${escapeHtml(item.userId || "-")}</code><div>${badge(item.studentId || "Chưa có MSSV", item.studentId ? "info" : "neutral")} ${escapeHtml(item.studentName)}</div></td><td><strong>${escapeHtml(item.chatName)}</strong><code>${escapeHtml(item.chatId)}</code></td><td>${badge(item.chatType, item.chatType === "group" ? "info" : "neutral")}</td><td>${timeChips(item.notificationTimes)}</td><td>${badge(item.schema, item.schema === "current" ? "success" : "warning")} ${badge(item.notificationsEnabled ? "Đang bật" : "Đang tắt", item.notificationsEnabled ? "success" : "neutral")}</td><td><button class="table-action" data-subscription="${escapeHtml(item.key)}">Quản lý</button></td></tr>`).join("") || emptyRow(6, "Không có đăng ký phù hợp.");
  $$('[data-subscription]').forEach((button) => button.addEventListener("click", () => openSubscription(button.dataset.subscription)));
}

function renderDuty() {
  $("#dutyScheduleList").innerHTML = workspace.duty.schedules.map((item) => `<article class="schedule-item"><div class="date-box"><strong>${escapeHtml(item.dateStr)}</strong><small>#${escapeHtml(item.id)}</small></div><div><strong>${escapeHtml(item.assigned)}</strong><small>Cập nhật ${escapeHtml(formatDate(item.updatedAt))}</small></div><div class="row-actions"><button data-duty-edit="${item.id}">Sửa</button><button class="danger-text" data-duty-delete="${item.id}">Xóa</button></div></article>`).join("") || `<div class="empty-state">Chưa có lịch trực.</div>`;
  $("#dutySubscriptionList").innerHTML = workspace.duty.subscriptions.map((item) => `<article class="stack-item horizontal"><div><strong>${escapeHtml(item.chatTitle || item.chatId)}</strong><p><code>${escapeHtml(item.chatId)}</code> · ${escapeHtml(item.chatType)} · ${escapeHtml(item.chatStatus)}</p></div><button class="toggle-button ${item.enabled ? "on" : ""}" data-duty-sub="${escapeHtml(item.chatId)}" data-enabled="${item.enabled ? "false" : "true"}">${item.enabled ? "Tắt" : "Bật"}</button></article>`).join("") || `<div class="empty-state">Chưa có chat đăng ký lịch trực.</div>`;
  $$('[data-duty-edit]').forEach((button) => button.addEventListener("click", () => editDuty(button.dataset.dutyEdit)));
  $$('[data-duty-delete]').forEach((button) => button.addEventListener("click", () => deleteDuty(button.dataset.dutyDelete)));
  $$('[data-duty-sub]').forEach((button) => button.addEventListener("click", async () => { await api("/api/admin/duty/subscriptions", { method: "PATCH", body: JSON.stringify({ chatId: button.dataset.dutySub, enabled: button.dataset.enabled === "true" }) }); await loadData(); }));
}

function renderHealth() {
  const status = $("#healthFilter").value; const type = $("#healthType").value;
  const chats = workspace.chats.filter((chat) => (status === "all" || chat.status === status) && (type === "all" || chat.chatType === type));
  $("#healthRows").innerHTML = chats.map((chat) => `<tr><td><strong>${escapeHtml(chat.displayName)}</strong><code>${escapeHtml(chat.chatId)}</code></td><td>${badge(chat.chatType, chat.chatType === "group" ? "info" : chat.chatType === "unknown" ? "warning" : "neutral")}<small class="block">${escapeHtml(chat.typeSource)}</small></td><td>${badge(chat.status, statusTone(chat.status))}</td><td>${chat.memberCount}</td><td>${escapeHtml(formatDate(chat.lastSuccessfulDeliveryAt))}</td><td class="error-cell">${escapeHtml(chat.lastError?.message || "-")}</td><td><button class="table-action" data-chat-detail="${escapeHtml(chat.chatId)}">Chi tiết</button></td></tr>`).join("") || emptyRow(7, "Không có chat phù hợp.");
  $$('#healthRows [data-chat-detail]').forEach((button) => button.addEventListener("click", () => openChat(button.dataset.chatDetail)));
}

function renderSettings() {
  $("#adminSettingsList").innerHTML = (settings.admins || []).map((admin) => `<article class="stack-item horizontal"><div><strong>${escapeHtml(admin.displayName || admin.userId || admin.chatId)}</strong><p>User: <code>${escapeHtml(admin.userId || "-")}</code> · Chat: <code>${escapeHtml(admin.chatId || "-")}</code></p></div><button class="danger-text" data-remove-admin="${escapeHtml(admin.userId || admin.chatId)}">Xóa</button></article>`).join("") || `<div class="empty-state">Chưa có danh tính quản trị trong cơ sở dữ liệu.</div>`;
  const access = workspace.access;
  $("#accessSummary").innerHTML = `<div class="access-modes"><div><span>Bot mode</span><strong>${escapeHtml(access.botMode)}</strong></div><div><span>AI mode</span><strong>${escapeHtml(access.aiMode)}</strong></div></div>${[["Bot blocked", access.botBlocked], ["AI blocked", access.aiBlocked], ["Bot allowlist", access.botAllowlist], ["AI allowlist", access.aiAllowlist]].map(([title, items]) => `<section><h3>${title} <span>${items.length}</span></h3>${items.slice(0, 8).map((item) => `<p>${escapeHtml(item.targetName || item.targetId)} <code>${escapeHtml(item.targetId)}</code></p>`).join("") || `<p class="muted">Trống</p>`}</section>`).join("")}`;
  $$('[data-remove-admin]').forEach((button) => button.addEventListener("click", async () => { await api(`/api/admin/settings/admins?id=${encodeURIComponent(button.dataset.removeAdmin)}`, { method: "DELETE" }); await loadData(); }));
  const select = $("#commandAdminIdentity");
  const current = select.value;
  select.innerHTML = `<option value="">Nhập thủ công</option>${(settings.admins || []).map((admin, index) => `<option value="${index}">${escapeHtml(admin.displayName || admin.userId || admin.chatId)} · ${escapeHtml(admin.userId || "-")}</option>`).join("")}`;
  select.value = current;
}

function renderLogs() {
  $("#systemLogList").innerHTML = (logs.system || []).map((item) => `<article class="stack-item"><strong>${escapeHtml(item.level)}</strong><p>${escapeHtml(item.message)}</p><small>${escapeHtml(formatDate(item.at))}</small></article>`).join("") || `<div class="empty-state">Không có log hệ thống.</div>`;
  $("#deliveryLogList").innerHTML = (logs.deliveryErrors || []).map((item) => `<article class="stack-item"><strong>${escapeHtml(item.displayName || item.chatId)}</strong><p>${escapeHtml(item.lastError?.message || "-")}</p><small>${escapeHtml(formatDate(item.lastError?.at))}</small></article>`).join("") || `<div class="empty-state">Không có lỗi gửi gần đây.</div>`;
}

function renderAll() { renderOverview(); renderDirectory(); renderUsers(); renderGroups(); renderNotifications(); renderDuty(); renderHealth(); renderSettings(); renderLogs(); $("#healthPill").textContent = `${dashboard.bot.status} · ${dashboard.bot.health}`; $("#generatedAt").textContent = formatDate(workspace.generatedAt); }

async function loadData() {
  setDataState("loading", "Loading admin data...");
  try {
    [workspace, dashboard, logs, settings] = await Promise.all([api("/api/admin/workspace"), api("/api/admin/dashboard"), api("/api/admin/logs"), api("/api/admin/settings")]);
    renderAll();
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

function openUser(userId) {
  const user = workspace.users.find((item) => item.userId === userId); if (!user) return;
  showDialog(user.displayName, `<div class="detail-grid"><div class="detail"><span>User ID</span><code>${escapeHtml(user.userId)}</code></div><div class="detail"><span>MSSV</span><strong>${escapeHtml(user.studentIds.join(", ") || "Chưa có MSSV")}</strong></div><div class="detail"><span>Tương tác đầu tiên</span><strong>${escapeHtml(formatDate(user.firstInteractionAt))}</strong></div><div class="detail"><span>Hoạt động gần nhất</span><strong>${escapeHtml(formatDate(user.lastInteractionAt))}</strong></div></div><h3>Ngữ cảnh chat</h3><div class="stack">${user.chats.map((chat) => `<article class="stack-item"><form class="userContextForm" data-user-chat="${escapeHtml(chat.chatId)}"><div class="form-grid"><label>Tên hiển thị<input name="displayName" value="${escapeHtml(user.displayName)}" /></label><label>Trạng thái thành viên<select name="status"><option value="active" ${chat.memberStatus === "active" ? "selected" : ""}>Đang hoạt động</option><option value="disabled" ${chat.memberStatus === "disabled" ? "selected" : ""}>Đã tắt</option><option value="removed" ${chat.memberStatus === "removed" ? "selected" : ""}>Đã xóa</option></select></label></div><p>${escapeHtml(chat.chatType)} · chat ${escapeHtml(chat.status)} · <code>${escapeHtml(chat.chatId)}</code></p><div class="row-actions"><button type="submit">Lưu người dùng</button><button type="button" data-open-chat="${escapeHtml(chat.chatId)}">Mở chat</button><button type="button" data-user-admin="${escapeHtml(chat.chatId)}">Cấp quyền admin</button><button type="button" class="danger-text" data-user-remove="${escapeHtml(chat.chatId)}">Xóa khỏi chat</button></div></form></article>`).join("")}</div><h3>Đăng ký nhận lịch</h3><div class="stack">${user.subscriptions.map((item) => `<article class="stack-item horizontal"><div><strong>${escapeHtml(item.studentId || "Chưa có MSSV")} · ${escapeHtml(item.chatName)}</strong><p>${escapeHtml(item.notificationsEnabled ? "Đang bật" : "Đang tắt")} · ${escapeHtml(item.notificationTimes.map((time) => time.time).join(", ") || "Chưa có giờ nhận lịch")}</p></div><button data-open-sub="${escapeHtml(item.key)}">Quản lý</button></article>`).join("") || `<div class="empty-state">Không có đăng ký nhận lịch.</div>`}</div>`);
  $$('.userContextForm').forEach((form) => form.addEventListener("submit", async (event) => { event.preventDefault(); const values = new FormData(event.currentTarget); await api(`/api/admin/users/${encodeURIComponent(userId)}`, { method: "PATCH", body: JSON.stringify({ chatId: event.currentTarget.dataset.userChat, displayName: values.get("displayName"), status: values.get("status") }) }); $("#detailDialog").close(); await loadData(); }));
  $$('[data-user-admin]').forEach((button) => button.addEventListener("click", async () => { await api("/api/admin/settings/admins", { method: "POST", body: JSON.stringify({ userId, chatId: button.dataset.userAdmin, displayName: user.displayName }) }); await loadData(); }));
  $$('[data-user-remove]').forEach((button) => button.addEventListener("click", async () => { if (!confirm(`Xóa user ${userId} khỏi chat ${button.dataset.userRemove}? Subscription của user trong chat cũng sẽ bị xóa.`)) return; await api(`/api/admin/users/${encodeURIComponent(userId)}?hard=1&chatId=${encodeURIComponent(button.dataset.userRemove)}`, { method: "DELETE" }); $("#detailDialog").close(); await loadData(); }));
  $$('[data-open-chat]').forEach((button) => button.addEventListener("click", () => openChat(button.dataset.openChat)));
  $$('[data-open-sub]').forEach((button) => button.addEventListener("click", () => openSubscription(button.dataset.openSub)));
}

async function openChat(chatId) {
  const data = await api(`/api/admin/chats/${encodeURIComponent(chatId)}`); const chat = data.chat;
  showDialog(chat.displayName || chat.chatId, `<form id="chatMetadataForm"><div class="form-grid"><label>Chat ID<input value="${escapeHtml(chat.chatId)}" disabled /></label><label>User ID<input name="userId" value="${escapeHtml(chat.userId || "")}" /></label><label>Display name<input name="displayName" value="${escapeHtml(chat.displayName || "")}" /></label><label>Type<select name="chatType"><option value="private" ${chat.chatType === "private" ? "selected" : ""}>Private</option><option value="group" ${chat.chatType === "group" ? "selected" : ""}>Group</option><option value="unknown" ${chat.chatType === "unknown" ? "selected" : ""}>Unknown</option></select></label></div><button class="primary" type="submit">Lưu metadata</button></form><div class="action-bar"><button data-chat-status="active">Reactivate</button><button data-chat-status="disabled">Disable</button><button data-chat-status="removed">Soft remove</button><button data-chat-retry="1">Retry</button><button data-make-admin="1">Make admin</button><button class="danger-text" data-chat-hard-delete="1">Xóa vĩnh viễn</button></div><div class="detail-grid"><div class="detail"><span>Last inbound</span><strong>${escapeHtml(formatDate(chat.lastInboundInteractionAt))}</strong></div><div class="detail"><span>Last success</span><strong>${escapeHtml(formatDate(chat.lastSuccessfulDeliveryAt))}</strong></div><div class="detail"><span>Last error</span><strong>${escapeHtml(chat.lastError?.message || "-")}</strong></div><div class="detail"><span>Error time</span><strong>${escapeHtml(formatDate(chat.lastError?.at))}</strong></div></div><h3>Members & MSSV</h3><div class="stack">${(data.members || []).map((user) => `<article class="stack-item"><strong>${escapeHtml(user.displayName)}</strong><p><code>${escapeHtml(user.userId)}</code> · ${escapeHtml(user.studentIds.join(", ") || "No MSSV")}</p></article>`).join("") || `<div class="empty-state">Không có member record.</div>`}</div><h3>Subscriptions</h3><div class="stack">${(data.subscriptions || []).map((item) => `<article class="stack-item horizontal"><div><strong>${escapeHtml(item.userDisplayName || item.userId || "Legacy")}</strong><p>${escapeHtml(item.studentId || "No MSSV")} · ${escapeHtml(item.notificationTimes.map((time) => time.time).join(", ") || "No times")}</p></div><button data-open-sub="${escapeHtml(item.key)}">Quản lý</button></article>`).join("") || `<div class="empty-state">Không có subscription.</div>`}</div>`);
  $("#chatMetadataForm").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); await api(`/api/admin/chats/${encodeURIComponent(chatId)}`, { method: "PATCH", body: JSON.stringify({ action: "metadata", userId: form.get("userId"), displayName: form.get("displayName"), chatType: form.get("chatType") }) }); $("#detailDialog").close(); await loadData(); });
  $$('[data-chat-status]').forEach((button) => button.addEventListener("click", async () => { await api(`/api/admin/chats/${encodeURIComponent(chatId)}`, { method: "PATCH", body: JSON.stringify({ action: "status", status: button.dataset.chatStatus }) }); $("#detailDialog").close(); await loadData(); }));
  $('[data-chat-retry]').addEventListener("click", async () => { await api(`/api/admin/chats/${encodeURIComponent(chatId)}/retry`, { method: "POST" }); $("#detailDialog").close(); await loadData(); });
  $('[data-make-admin]').addEventListener("click", async () => { await api("/api/admin/settings/admins", { method: "POST", body: JSON.stringify({ userId: chat.userId || "", chatId: chat.chatId, displayName: chat.displayName }) }); await loadData(); });
  $('[data-chat-hard-delete]').addEventListener("click", async () => { if (!confirm(`Xóa vĩnh viễn ${chat.chatId}? Bản ghi sẽ không còn trong directory.`)) return; await api(`/api/admin/chats/${encodeURIComponent(chatId)}?hard=1`, { method: "DELETE" }); $("#detailDialog").close(); await loadData(); });
  $$('[data-open-sub]').forEach((button) => button.addEventListener("click", () => openSubscription(button.dataset.openSub)));
}

function openSubscription(key) {
  const item = workspace.subscriptions.find((entry) => entry.key === key); if (!item) return;
  showDialog(`${item.studentId || "Đăng ký nhận lịch"} · ${item.chatName}`, `<div class="detail-grid"><div class="detail"><span>Người dùng</span><strong>${escapeHtml(item.userDisplayName || item.userId || "Bản ghi cũ")}</strong><code>${escapeHtml(item.userId || "-")}</code></div><div class="detail"><span>Chat</span><strong>${escapeHtml(item.chatName)}</strong><code>${escapeHtml(item.chatId)}</code></div><div class="detail"><span>Loại chat</span><strong>${escapeHtml(item.chatType)}</strong></div><div class="detail"><span>Cập nhật bản ghi</span><strong>${escapeHtml(formatDate(item.updatedAt))}</strong></div></div>${item.schema === "legacy" ? `<div class="warning-box">Bản ghi cũ không có userId rõ ràng; chỉ nên xem hoặc xóa.</div>` : `<form id="subscriptionMetaForm"><div class="form-grid"><label>MSSV<input name="studentId" value="${escapeHtml(item.studentId)}" /></label><label>Tên sinh viên<input name="studentName" value="${escapeHtml(item.studentName)}" /></label><label>Tên người dùng<input name="userDisplayName" value="${escapeHtml(item.userDisplayName)}" /></label></div><button class="primary" type="submit">Lưu thông tin</button></form><h3>Giờ nhận lịch</h3><div class="stack">${item.notificationTimes.map((time) => `<article class="stack-item horizontal"><div><strong>#${time.id} · ${escapeHtml(time.time)}</strong><small>Đăng ký ${escapeHtml(formatDate(time.createdAt))} · cập nhật ${escapeHtml(formatDate(time.updatedAt))}</small></div><div class="row-actions"><button data-time-edit="${time.id}">Sửa</button><button class="danger-text" data-time-remove="${time.id}">Xóa</button></div></article>`).join("") || `<div class="empty-state">Chưa có giờ nhận lịch.</div>`}<button class="secondary" id="addTimeButton">Thêm giờ</button></div><div class="action-bar"><button data-sub-action="${item.notificationsEnabled ? "disable" : "enable"}">${item.notificationsEnabled ? "Tắt nhận lịch" : "Bật nhận lịch"}</button><button class="danger-text" data-sub-action="delete">Xóa đăng ký</button></div>`}`);
  if (item.schema === "legacy") return;
  $("#subscriptionMetaForm").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); await updateSubscription(item, { action: "metadata", ...Object.fromEntries(form.entries()) }); });
  $("#addTimeButton").addEventListener("click", async () => { const time = prompt("Nhập giờ HH:mm"); if (time) await updateSubscription(item, { action: "add_time", time, studentId: item.studentId, studentName: item.studentName }); });
  $$('[data-time-edit]').forEach((button) => button.addEventListener("click", async () => { const time = prompt("Giờ mới HH:mm"); if (time) await updateSubscription(item, { action: "update_time", timeId: Number(button.dataset.timeEdit), time }); }));
  $$('[data-time-remove]').forEach((button) => button.addEventListener("click", () => updateSubscription(item, { action: "remove_time", timeId: Number(button.dataset.timeRemove) })));
  $$('[data-sub-action]').forEach((button) => button.addEventListener("click", () => updateSubscription(item, { action: button.dataset.subAction, studentId: item.studentId, studentName: item.studentName })));
}

async function updateSubscription(item, changes) { await api("/api/admin/subscriptions", { method: "PATCH", body: JSON.stringify({ chatId: item.chatId, userId: item.userId, userDisplayName: item.userDisplayName, ...changes }) }); $("#detailDialog").close(); await loadData(); }
async function editDuty(id) { const item = workspace.duty.schedules.find((entry) => String(entry.id) === String(id)); const input = prompt("Nội dung mới: dd/mm Tên người trực", `${item.dateStr} ${item.assigned}`); if (!input) return; await api("/api/admin/duty/schedules", { method: "PATCH", body: JSON.stringify({ target: id, input }) }); await loadData(); }
async function deleteDuty(id) { if (!confirm(`Xóa lịch trực #${id}?`)) return; await api("/api/admin/duty/schedules", { method: "DELETE", body: JSON.stringify({ target: id }) }); await loadData(); }

$("#loginForm").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api("/api/admin/auth/login", { method: "POST", body: JSON.stringify(Object.fromEntries(form.entries())) }); showAuthenticated(true); await loadData(); } catch (error) { $("#loginError").textContent = error.message; } });
$("#logoutButton").addEventListener("click", async () => { await api("/api/admin/auth/logout", { method: "POST" }); showAuthenticated(false); });
$("#refreshButton").addEventListener("click", loadData); $("#themeToggle").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
$("#closeDialog").addEventListener("click", () => $("#detailDialog").close());
$("#userSearch").addEventListener("input", renderUsers); $("#groupSearch").addEventListener("input", renderGroups); $("#notificationFilter").addEventListener("change", renderNotifications); $("#healthFilter").addEventListener("change", renderHealth); $("#healthType").addEventListener("change", renderHealth);
$("#directorySearch").addEventListener("input", renderDirectory); $("#directoryType").addEventListener("change", renderDirectory); $("#addChatButton").addEventListener("click", openCreateChat);
$("#addUserButton").addEventListener("click", openCreateUser);
$("#addDutyButton").addEventListener("click", async () => { const input = prompt("Nhập một hoặc nhiều dòng: dd/mm Tên người trực"); if (!input) return; await api("/api/admin/duty/schedules", { method: "POST", body: JSON.stringify({ input }) }); await loadData(); });
$("#adminForm").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api("/api/admin/settings/admins", { method: "POST", body: JSON.stringify(Object.fromEntries(form.entries())) }); event.currentTarget.reset(); $("#adminFormMessage").textContent = "Đã lưu."; await loadData(); } catch (error) { $("#adminFormMessage").textContent = error.message; } });
$("#commandForm").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); $("#commandResult").textContent = "Đang thực thi..."; try { const result = await api("/api/admin/commands", { method: "POST", body: JSON.stringify(Object.fromEntries(form.entries())) }); $("#commandResult").textContent = (result.messages || []).map((item) => item.text).join("\n\n") || `Đã gửi phản hồi tới ${result.deliveredToChatId}`; await loadData(); } catch (error) { $("#commandResult").textContent = error.message; } });
$("#commandAdminIdentity").addEventListener("change", (event) => { const admin = (settings?.admins || [])[Number(event.currentTarget.value)]; if (!admin) return; const form = $("#commandForm"); form.elements.userId.value = admin.userId || ""; form.elements.chatId.value = admin.chatId || ""; form.elements.displayName.value = admin.displayName || ""; });
$$('.tab-button').forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));
applyTheme(localStorage.getItem("zalobot-admin-theme") || "dark"); switchTab(localStorage.getItem("zalobot-admin-tab") || "overview");
loadData().then(() => showAuthenticated(true)).catch((error) => { showAuthenticated(false); if (error.status !== 401) $("#loginError").textContent = error.message; });
