const base = new URL(document.baseURI).pathname.replace(/\/$/, "");
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[char]));
let dashboard = null;
let notifications = null;
let logs = null;

async function api(path, options = {}) {
  const response = await fetch(`${base}${path}`, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || "Request failed"); error.status = response.status; throw error; }
  return data;
}

function showAuthenticated(authenticated) { $("#loginView").classList.toggle("hidden", authenticated); $("#dashboardView").classList.toggle("hidden", !authenticated); $("#logoutButton").classList.toggle("hidden", !authenticated); }
function formatDate(value) { if (!value) return "-"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); }
function statusClass(status) { return `status status-${escapeHtml(status || "unknown")}`; }

function render() {
  const chats = dashboard.chats;
  $("#metricGrid").innerHTML = [
    ["Registered chats", chats.total, `${chats.users} users · ${chats.groups} groups`],
    ["Active chats", chats.active, "Eligible for delivery"],
    ["Invalid / unreachable", chats.inactive, "Requires review"],
    ["Schedule subscriptions", dashboard.notifications.activeSubscriptions, "Currently enabled"],
    ["Failed deliveries", dashboard.notifications.failedDeliveries, "Recorded in chat history"]
  ].map(([label,value,note]) => `<article class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></article>`).join("");
  const status = $("#statusFilter").value; const type = $("#typeFilter").value;
  api(`/api/admin/chats?status=${encodeURIComponent(status)}&type=${encodeURIComponent(type)}`).then(({ chats: filtered }) => {
    $("#chatRows").innerHTML = filtered.map((chat) => `<tr><td><div class="chat-name">${escapeHtml(chat.displayName || "Unnamed chat")}</div><div class="chat-id">${escapeHtml(chat.chatId)}</div></td><td>${escapeHtml(chat.chatType || "unknown")}</td><td><span class="${statusClass(chat.status)}">${escapeHtml(chat.status)}</span></td><td>${escapeHtml(formatDate(chat.lastSuccessfulDeliveryAt))}</td><td>${escapeHtml(chat.lastError ? `${chat.lastError.status || chat.lastError.code || "ERR"} ${chat.lastError.message}` : "-")}</td><td><button class="mini-button" data-chat="${escapeHtml(chat.chatId)}">Details</button></td></tr>`).join("") || `<tr><td colspan="6" class="muted">No chats match this filter.</td></tr>`;
    document.querySelectorAll("[data-chat]").forEach((button) => button.addEventListener("click", () => openDetails(button.dataset.chat)));
  });
  const systemErrors = (logs?.system || []).slice(0, 8).map((event) => `<div class="stack-item"><div class="stack-title">${escapeHtml(event.level)} · System</div><div class="stack-meta">${escapeHtml(event.message)}</div><div class="stack-meta">${escapeHtml(formatDate(event.at))}</div></div>`);
  const deliveryErrors = (dashboard.recentErrors || []).slice(0, 8).map((chat) => `<div class="stack-item"><div class="stack-title">${escapeHtml(chat.displayName || chat.chatId)}</div><div class="stack-meta">${escapeHtml(chat.lastError?.message || "Unknown error")}</div><div class="stack-meta">${escapeHtml(formatDate(chat.lastError?.at))}</div></div>`);
  $("#errorList").innerHTML = [...systemErrors, ...deliveryErrors].slice(0, 10).join("") || `<p class="muted">No recent errors.</p>`;
  $("#auditList").innerHTML = (dashboard.audit || []).map((event) => `<div class="stack-item"><div class="stack-title">${escapeHtml(event.action)}</div><div class="stack-meta">${escapeHtml(event.admin)} · ${escapeHtml(formatDate(event.at))}</div></div>`).join("") || `<p class="muted">No admin activity yet.</p>`;
  const scheduleRows = (notifications?.schedule || []).slice(0, 12).map((item) => `<div class="stack-item"><div class="stack-title">${escapeHtml(item.userDisplayName || item.studentName || item.chatId)}</div><div class="stack-meta">Study schedule · ${escapeHtml((item.notificationTimes || []).map((entry) => entry.time).join(", ") || "06:00")} · ${escapeHtml(item.chatId)}</div></div>`);
  const dutyRows = (notifications?.duty || []).slice(0, 8).map((item) => `<div class="stack-item"><div class="stack-title">${escapeHtml(item.chatTitle || item.chatId)}</div><div class="stack-meta">Room 411 duty · 06:00 daily</div></div>`);
  $("#notificationList").innerHTML = [...scheduleRows, ...dutyRows].join("") || `<p class="muted">No active notification subscriptions.</p>`;
  $("#healthPill").textContent = `${dashboard.bot.status} · ${dashboard.bot.health}`;
}

async function loadDashboard() { [dashboard, notifications, logs] = await Promise.all([api("/api/admin/dashboard"), api("/api/admin/notifications"), api("/api/admin/logs")]); render(); }
async function openDetails(chatId) {
  const data = await api(`/api/admin/chats/${encodeURIComponent(chatId)}`); const chat = data.chat;
  $("#dialogTitle").textContent = chat.displayName || chat.chatId;
  const error = chat.lastError ? `${chat.lastError.status || chat.lastError.code || "ERR"} ${chat.lastError.message}` : "-";
  const overrides = chat.notificationOverrides || {};
  const history = (data.deliveryHistory || []).slice(0, 12).map((item) => `<div class="stack-item"><div class="stack-title">${escapeHtml(item.result)} · ${escapeHtml(item.feature || item.operation || "delivery")}</div><div class="stack-meta">${escapeHtml(item.message || "Delivered successfully")}</div><div class="stack-meta">${escapeHtml(formatDate(item.at))}</div></div>`).join("") || `<p class="muted">No delivery history recorded yet.</p>`;
  $("#dialogBody").innerHTML = `<div class="detail-grid"><div class="detail"><label>Chat ID</label><p>${escapeHtml(chat.chatId)}</p></div><div class="detail"><label>Type</label><p>${escapeHtml(chat.chatType)}</p></div><div class="detail"><label>Status</label><p class="${statusClass(chat.status)}">${escapeHtml(chat.status)}</p></div><div class="detail"><label>Last inbound interaction</label><p>${escapeHtml(formatDate(chat.lastInboundInteractionAt))}</p></div><div class="detail"><label>Last successful delivery</label><p>${escapeHtml(formatDate(chat.lastSuccessfulDeliveryAt))}</p></div><div class="detail"><label>Latest error</label><p>${escapeHtml(error)}</p></div></div><div class="panel-heading" style="margin-top:18px"><strong>Admin actions</strong></div><div class="filters"><button class="mini-button" data-action="active">Reactivate</button><button class="mini-button" data-action="disabled">Disable</button><button class="mini-button" data-action="removed">Soft remove</button><button class="mini-button" data-retry="1">Retry delivery</button></div><div class="panel-heading" style="margin-top:18px"><strong>Notification features</strong></div><div class="stack">${["schedule","duty","birthday","broadcast"].map((feature) => `<div class="stack-item"><div class="stack-title">${feature}</div><div class="stack-meta">Override: ${overrides[feature] == null ? "automatic" : overrides[feature] ? "enabled" : "disabled"}</div><div class="filters" style="margin-top:7px"><button class="mini-button" data-feature="${feature}" data-enabled="true">Enable</button><button class="mini-button" data-feature="${feature}" data-enabled="false">Disable</button><button class="mini-button" data-feature="${feature}" data-enabled="auto">Automatic</button></div></div>`).join("")}</div><div class="panel-heading" style="margin-top:18px"><strong>Delivery history</strong></div><div class="stack">${history}</div>`;
  if (!$("#detailDialog").open) $("#detailDialog").showModal();
  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", async () => { await api(`/api/admin/chats/${encodeURIComponent(chatId)}`, { method: "PATCH", body: JSON.stringify({ action: "status", status: button.dataset.action, reason: `dashboard_${button.dataset.action}` }) }); $("#detailDialog").close(); await loadDashboard(); }));
  document.querySelectorAll("[data-retry]").forEach((button) => button.addEventListener("click", async () => { button.disabled = true; try { await api(`/api/admin/chats/${encodeURIComponent(chatId)}/retry`, { method: "POST" }); $("#detailDialog").close(); await loadDashboard(); } catch (error) { button.disabled = false; alert(error.message); } }));
  document.querySelectorAll("[data-feature]").forEach((button) => button.addEventListener("click", async () => { const enabled = button.dataset.enabled === "auto" ? null : button.dataset.enabled === "true"; await api(`/api/admin/chats/${encodeURIComponent(chatId)}`, { method: "PATCH", body: JSON.stringify({ action: "feature", feature: button.dataset.feature, enabled }) }); await openDetails(chatId); }));
}

$("#loginForm").addEventListener("submit", async (event) => { event.preventDefault(); $("#loginError").textContent = ""; const form = new FormData(event.currentTarget); try { await api("/api/admin/auth/login", { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) }); showAuthenticated(true); await loadDashboard(); } catch (error) { $("#loginError").textContent = error.message; } });
$("#logoutButton").addEventListener("click", async () => { await api("/api/admin/auth/logout", { method: "POST" }); showAuthenticated(false); });
$("#refreshButton").addEventListener("click", loadDashboard); $("#statusFilter").addEventListener("change", render); $("#typeFilter").addEventListener("change", render); $("#closeDialog").addEventListener("click", () => $("#detailDialog").close());
loadDashboard().then(() => showAuthenticated(true)).catch((error) => { if (error.status === 401) showAuthenticated(false); else { showAuthenticated(false); $("#loginError").textContent = error.message; } });
