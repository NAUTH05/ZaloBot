const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const {
    getAllChats,
    getChat,
    isChatEligible,
    removeChat,
    setChatStatus,
    setFeatureOverride,
    upsertChat
} = require("./chatDirectory");
const { getInteractionTargets, removeInteractionMember, upsertInteractionMember } = require("./interactionRegistry");
const { getAdminSettings, getConfiguredAdminIds, removeAdmin, setDefaultPageSize, upsertAdmin } = require("./adminSettings");
const { getCommandRegistry } = require("./commandRegistry");
const {
    deleteSubscription,
    disableNotifications,
    enableNotifications,
    getAllSubscriptions,
    getEnabledSubscriptions,
    removeNotificationTime,
    updateNotificationTime,
    updateSubscriptionMetadata
} = require("./subscriptions");
const {
    addDutySchedules,
    deleteDutySchedule,
    disableDutyNotifications,
    enableDutyNotifications,
    getDutySubscriptions,
    readDutyData,
    updateDutySchedule
} = require("./dutyScheduleStore");
const { buildAdminData } = require("./adminDataService");
const { getPersistenceStatus, readJsonStore, writeJsonStore } = require("./firestorePersistence");
const { getSystemLogs } = require("./operationalLog");

const configuredBasePath = String(process.env.ADMIN_BASE_PATH || "/zalobot").trim();
const BASE_PATH = configuredBasePath === "/" ? "/" : `/${configuredBasePath.replace(/^\/+|\/+$/g, "")}`;
const API_PREFIX = BASE_PATH === "/" ? "/api/admin" : `${BASE_PATH}/api/admin`;
const UI_PREFIX = BASE_PATH === "/" ? "/" : `${BASE_PATH}/`;
const STATIC_DIR = path.join(__dirname, "admin-ui");
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const sessions = new Map();
const failedLogins = new Map();
const requestCounts = new Map();

function timingSafeEqual(left, right) {
    const a = Buffer.from(String(left || ""));
    const b = Buffer.from(String(right || ""));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function configuredPassword() {
    return String(process.env.ADMIN_PASSWORD || "");
}

function validPassword(candidate) {
    const encoded = String(process.env.ADMIN_PASSWORD_HASH || "");
    if (encoded) {
        const [scheme, saltHex, hashHex] = encoded.split("$");
        if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
        try {
            const actual = crypto.scryptSync(String(candidate || ""), Buffer.from(saltHex, "hex"), Buffer.from(hashHex, "hex").length);
            return actual.length === Buffer.from(hashHex, "hex").length && crypto.timingSafeEqual(actual, Buffer.from(hashHex, "hex"));
        } catch (_) { return false; }
    }
    return timingSafeEqual(candidate, configuredPassword());
}

function adminEnabled() {
    return Boolean(process.env.ADMIN_USERNAME && (process.env.ADMIN_PASSWORD_HASH || process.env.ADMIN_PASSWORD));
}

function parseCookies(request) {
    const result = {};
    for (const part of String(request.headers.cookie || "").split(";")) {
        const [key, ...rest] = part.trim().split("=");
        if (!key || !rest.length) continue;
        try { result[key] = decodeURIComponent(rest.join("=")); } catch (_) { /* Ignore malformed cookies. */ }
    }
    return result;
}

function sessionCookie(request, token, maxAge) {
    const secure = process.env.ADMIN_COOKIE_SECURE === "true" || request.headers["x-forwarded-proto"] === "https" || process.env.NODE_ENV === "production";
    return `zalobot_admin=${token}; Path=${UI_PREFIX}; HttpOnly; SameSite=Strict;${secure ? " Secure;" : ""} Max-Age=${maxAge}`;
}

function json(res, status, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...securityHeaders(), ...extraHeaders });
    res.end(body);
}

function securityHeaders() {
    return {
        "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
    };
}

function sendFile(res, filePath, contentType) {
    try {
        const body = fs.readFileSync(filePath);
        res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache", ...securityHeaders() });
        res.end(body);
    } catch (_) {
        json(res, 404, { error: "Not found" });
    }
}

function sameOrigin(request) {
    const origin = request.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === request.headers.host; } catch (_) { return false; }
}

function withinRateLimit(request) {
    const ip = String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown");
    const minute = Math.floor(Date.now() / 60000);
    const key = `${ip}:${minute}`;
    const count = (requestCounts.get(key) || 0) + 1;
    requestCounts.set(key, count);
    if (requestCounts.size > 2000) {
        for (const oldKey of requestCounts.keys()) if (!oldKey.endsWith(`:${minute}`)) requestCounts.delete(oldKey);
    }
    return count <= 240;
}

function audit(action, request, details = {}) {
    const filePath = path.join(__dirname, "adminAudit.json");
    const fallback = { events: [] };
    const data = readJsonStore(filePath, filePath, fallback);
    const events = Array.isArray(data?.events) ? data.events.slice(-499) : [];
    events.push({
        action,
        admin: String(request.admin?.username || "unknown"),
        ip: String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || ""),
        at: new Date().toISOString(),
        ...details
    });
    writeJsonStore(filePath, filePath, { events });
}

function sessionFor(request) {
    const token = parseCookies(request).zalobot_admin;
    if (!token) return null;
    const session = sessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
        sessions.delete(token);
        return null;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    request.admin = session;
    return session;
}

function requireAdmin(request, response) {
    if (!adminEnabled()) {
        json(response, 503, { error: "Admin authentication is not configured" });
        return false;
    }
    if (!sessionFor(request)) {
        json(response, 401, { error: "Authentication required" });
        return false;
    }
    return true;
}

function readBody(request) {
    return new Promise((resolve, reject) => {
        let body = "";
        request.on("data", (chunk) => {
            body += chunk;
            if (Buffer.byteLength(body) > MAX_BODY_BYTES) reject(new Error("Request body too large"));
        });
        request.on("end", () => {
            if (!body) return resolve({});
            try { resolve(JSON.parse(body)); } catch (_) { reject(new Error("Invalid JSON")); }
        });
        request.on("error", reject);
    });
}

function publicChat(chat) {
    const { deliveryHistory, ...safeChat } = chat || {};
    return safeChat;
}

function enrichedChats() {
    const interactions = getInteractionTargets();
    const byChat = new Map(interactions.map((item) => [String(item.chatId), item]));
    return getAllChats().map((chat) => {
        const interaction = byChat.get(String(chat.chatId));
        if (!interaction) return chat;
        const changes = {
            chatType: chat.chatType === "unknown" ? interaction.chatType : chat.chatType,
            displayName: chat.displayName || interaction.chatTitle || interaction.lastUserDisplayName,
            chatTitle: chat.chatTitle || interaction.chatTitle,
            userId: chat.userId || interaction.lastUserId,
            firstInteractionAt: chat.firstInteractionAt || interaction.firstInteractionAt,
            lastInboundInteractionAt: chat.lastInboundInteractionAt || interaction.lastInteractionAt
        };
        const changed = Object.entries(changes).some(([key, value]) => value != null && value !== "" && chat[key] !== value);
        return changed ? upsertChat({ chatId: chat.chatId, ...changes }) : chat;
    });
}

function dashboardSummary() {
    const workspace = buildAdminData();
    const chats = workspace.chats;
    const subscriptions = Object.values(getEnabledSubscriptions());
    const duty = getDutySubscriptions();
    return {
        bot: { status: "online", health: "healthy", checkedAt: new Date().toISOString() },
        persistence: getPersistenceStatus(),
        chats: {
            total: chats.length,
            users: workspace.users.length,
            groups: workspace.groups.length,
            unknown: chats.filter((chat) => chat.chatType === "unknown").length,
            active: chats.filter((chat) => chat.status === "active").length,
            inactive: chats.filter((chat) => chat.status === "inactive").length,
            disabled: chats.filter((chat) => chat.status === "disabled").length,
            removed: chats.filter((chat) => chat.status === "removed").length
        },
        notifications: {
            activeSubscriptions: subscriptions.length,
            dutySubscriptions: duty.length,
            failedDeliveries: chats.reduce((sum, chat) => sum + (Array.isArray(chat.deliveryHistory) ? chat.deliveryHistory.filter((item) => item.result === "failed").length : 0), 0)
        },
        invalidChats: chats.filter((chat) => chat.status === "inactive"),
        recentErrors: chats.filter((chat) => chat.lastError).sort((a, b) => String(b.lastError.at).localeCompare(String(a.lastError.at))).slice(0, 10).map(publicChat),
        audit: recentAudit(10)
    };
}

function recentAudit(limit = 50) {
    const filePath = path.join(__dirname, "adminAudit.json");
    const data = readJsonStore(filePath, filePath, { events: [] });
    return Array.isArray(data?.events) ? data.events.slice(-limit).reverse() : [];
}

function subscriptionsForChat(chatId) {
    return Object.entries(getAllSubscriptions()).filter(([, subscription]) => String(subscription?.chatId || "") === String(chatId)).map(([key, subscription]) => ({ key, ...subscription }));
}

function detailForChat(chatId) {
    const workspace = buildAdminData();
    const chat = workspace.chats.find((item) => String(item.chatId) === String(chatId)) || getChat(chatId);
    if (!chat) return null;
    return {
        chat: publicChat(chat),
        deliveryHistory: Array.isArray(chat.deliveryHistory) ? chat.deliveryHistory.slice(-50).reverse() : [],
        subscriptions: workspace.subscriptions.filter((item) => String(item.chatId) === String(chatId)),
        members: workspace.users.filter((user) => user.chats.some((item) => String(item.chatId) === String(chatId))),
        duty: workspace.duty.subscriptions.filter((item) => String(item.chatId) === String(chatId))
    };
}

async function handleApi(request, response, url, options = {}) {
    if (!withinRateLimit(request)) return json(response, 429, { error: "Too many requests" });
    if (!["GET", "HEAD"].includes(request.method) && !sameOrigin(request)) return json(response, 403, { error: "Origin not allowed" });
    if (url.pathname === `${API_PREFIX}/auth/login` && request.method === "POST") {
        if (!adminEnabled()) return json(response, 503, { error: "Set ADMIN_USERNAME and ADMIN_PASSWORD" });
        const ip = String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown");
        const state = failedLogins.get(ip) || { count: 0, blockedUntil: 0 };
        if (state.blockedUntil > Date.now()) return json(response, 429, { error: "Too many login attempts" });
        let body;
        try { body = await readBody(request); } catch (error) { return json(response, 400, { error: error.message }); }
        const valid = timingSafeEqual(body.username, process.env.ADMIN_USERNAME) && validPassword(body.password);
        if (!valid) {
            state.count += 1;
            if (state.count >= 5) { state.count = 0; state.blockedUntil = Date.now() + 15 * 60 * 1000; }
            failedLogins.set(ip, state);
            audit("auth.login_failed", request, { result: "denied" });
            return json(response, 401, { error: "Invalid credentials" });
        }
        failedLogins.delete(ip);
        const token = crypto.randomBytes(32).toString("hex");
        const session = { username: process.env.ADMIN_USERNAME, role: "admin", expiresAt: Date.now() + SESSION_TTL_MS };
        sessions.set(token, session);
        request.admin = session;
        audit("auth.login", request, { result: "success" });
        return json(response, 200, { ok: true }, { "Set-Cookie": sessionCookie(request, token, SESSION_TTL_MS / 1000) });
    }
    if (url.pathname === `${API_PREFIX}/auth/logout` && request.method === "POST") {
        sessionFor(request);
        const token = parseCookies(request).zalobot_admin;
        if (token) sessions.delete(token);
        audit("auth.logout", request, { result: "success" });
        return json(response, 200, { ok: true }, { "Set-Cookie": sessionCookie(request, "", 0) });
    }
    if (!requireAdmin(request, response)) return;
    if (url.pathname === `${API_PREFIX}/workspace` && request.method === "GET") return json(response, 200, buildAdminData());
    if (url.pathname === `${API_PREFIX}/dashboard` && request.method === "GET") return json(response, 200, dashboardSummary());
    if (url.pathname === `${API_PREFIX}/chats` && request.method === "GET") {
        const filter = String(url.searchParams.get("status") || "all");
        const type = String(url.searchParams.get("type") || "all");
        const chats = buildAdminData().chats.filter((chat) => (filter === "all" || chat.status === filter) && (type === "all" || chat.chatType === type)).map(publicChat);
        return json(response, 200, { chats });
    }
    if (url.pathname === `${API_PREFIX}/chats` && request.method === "POST") {
        let body;
        try { body = await readBody(request); } catch (error) { return json(response, 400, { error: error.message }); }
        try {
            const result = upsertChat({ restoreDeleted: true, chatId: body.chatId, chatType: body.chatType, displayName: body.displayName, chatTitle: body.chatTitle, userId: body.userId, status: body.status || "active" });
            if (!result) return json(response, 400, { error: "chatId is required" });
            audit("chat.create", request, { chatId: result.chatId, result: "success" });
            return json(response, 201, { chat: publicChat(result) });
        } catch (error) { return json(response, 400, { error: error.message }); }
    }
    if (url.pathname === `${API_PREFIX}/users` && request.method === "GET") {
        return json(response, 200, { users: buildAdminData().users });
    }
    if (url.pathname === `${API_PREFIX}/users` && request.method === "POST") {
        let body;
        try { body = await readBody(request); } catch (error) { return json(response, 400, { error: error.message }); }
        try {
            const chat = upsertChat({ restoreDeleted: true, chatId: body.chatId, chatType: body.chatType || "unknown", displayName: body.chatTitle || body.chatId, status: "active" });
            if (!chat) return json(response, 400, { error: "chatId is required" });
            const member = upsertInteractionMember({ chatId: chat.chatId, userId: body.userId, displayName: body.displayName, chatType: body.chatType, chatTitle: body.chatTitle });
            audit("user.create", request, { result: "success", chatId: chat.chatId, userId: member.userId });
            return json(response, 201, { member });
        } catch (error) { return json(response, 400, { error: error.message }); }
    }
    if (url.pathname === `${API_PREFIX}/groups` && request.method === "GET") {
        return json(response, 200, { groups: buildAdminData().groups.map(publicChat) });
    }
    const userMatch = url.pathname.match(new RegExp(`^${API_PREFIX.replaceAll("/", "\\/")}/users/([^/]+)$`));
    if (userMatch && ["PATCH", "DELETE"].includes(request.method)) {
        let body = {};
        try { body = await readBody(request); } catch (error) { return json(response, 400, { error: error.message }); }
        const userId = decodeURIComponent(userMatch[1]);
        try {
            body.chatId = body.chatId || url.searchParams.get("chatId");
            if (!body.chatId) return json(response, 400, { error: "chatId is required" });
            let result;
            if (request.method === "PATCH") {
                result = upsertInteractionMember({ chatId: body.chatId, userId, displayName: body.displayName, status: body.status, chatType: body.chatType, chatTitle: body.chatTitle });
                if (["disabled", "removed"].includes(body.status)) {
                    for (const subscription of subscriptionsForChat(body.chatId).filter((item) => String(item.userId) === userId)) disableNotifications({ chatId: body.chatId, userId });
                }
            } else {
                const hard = body.hard === true || url.searchParams.get("hard") === "1";
                result = removeInteractionMember(body.chatId, userId, hard);
                if (hard) for (const subscription of subscriptionsForChat(body.chatId).filter((item) => String(item.userId) === userId)) deleteSubscription({ chatId: body.chatId, userId });
            }
            if (!result) return json(response, 404, { error: "User membership not found" });
            audit(`user.${request.method.toLowerCase()}`, request, { result: "success", chatId: body.chatId, userId, hard: body.hard === true });
            return json(response, 200, { ok: true, member: result });
        } catch (error) { return json(response, 400, { error: error.message }); }
    }
    const chatMatch = url.pathname.match(new RegExp(`^${API_PREFIX.replaceAll("/", "\\/")}/chats/([^/]+)$`));
    if (chatMatch && request.method === "GET") {
        const detail = detailForChat(decodeURIComponent(chatMatch[1]));
        return detail ? json(response, 200, detail) : json(response, 404, { error: "Chat not found" });
    }
    if (chatMatch && ["PATCH", "POST"].includes(request.method)) {
        let body;
        try { body = await readBody(request); } catch (error) { return json(response, 400, { error: error.message }); }
        const chatId = decodeURIComponent(chatMatch[1]);
        try {
            let result;
            if (body.action === "status") result = setChatStatus(chatId, body.status, request.admin.username, body.reason || "admin_action");
            else if (body.action === "feature") result = setFeatureOverride(chatId, body.feature, body.enabled == null ? null : body.enabled);
            else if (body.action === "metadata") result = upsertChat({ chatId, chatType: body.chatType, displayName: body.displayName, chatTitle: body.chatTitle, userId: body.userId });
            else return json(response, 400, { error: "Unsupported action" });
            if (!result) return json(response, 404, { error: "Chat not found or permanently deleted" });
            audit(`chat.${body.action}`, request, { chatId, result: "success", metadata: body });
            return json(response, 200, { chat: publicChat(result) });
        } catch (error) {
            audit(`chat.${body.action || "update"}`, request, { chatId, result: "failed", error: error.message });
            return json(response, 400, { error: error.message });
        }
    }
    if (chatMatch && request.method === "DELETE") {
        let body = {};
        try { body = await readBody(request); } catch (_) {}
        const chatId = decodeURIComponent(chatMatch[1]);
        const result = removeChat(chatId, body.hard === true || url.searchParams.get("hard") === "1");
        if (!result) return json(response, 404, { error: "Chat not found" });
        audit("chat.delete", request, { chatId, hard: body.hard === true || url.searchParams.get("hard") === "1", result: "success" });
        return json(response, 200, { ok: true, chat: publicChat(result) });
    }
    const retryMatch = url.pathname.match(new RegExp(`^${API_PREFIX.replaceAll("/", "\\/")}/chats/([^/]+)/retry$`));
    if (retryMatch && request.method === "POST") {
        if (typeof options.retryChat !== "function") return json(response, 503, { error: "Retry service unavailable" });
        const chatId = decodeURIComponent(retryMatch[1]);
        const result = await options.retryChat(chatId);
        audit("chat.retry", request, { chatId, result: result.sent ? "success" : "failed", error: result.error?.message || null });
        if (result.sent) return json(response, 200, { ok: true, chat: publicChat(getChat(chatId)) });
        return json(response, 400, { error: result.error?.message || result.reason || "Retry failed" });
    }
    if (url.pathname === `${API_PREFIX}/notifications` && request.method === "GET") {
        return json(response, 200, {
            schedule: Object.values(getEnabledSubscriptions()).filter((item) => isChatEligible(item.chatId, "schedule")),
            duty: getDutySubscriptions().filter((item) => isChatEligible(item.chatId, "duty")),
            dutySchedules: readDutyData().schedules || []
        });
    }
    if (url.pathname === `${API_PREFIX}/subscriptions` && request.method === "PATCH") {
        let body;
        try { body = await readBody(request); } catch (error) { return json(response, 400, { error: error.message }); }
        const context = { chatId: body.chatId, userId: body.userId, userDisplayName: body.userDisplayName || "" };
        try {
            let result;
            if (body.action === "enable") result = enableNotifications(context, { studentId: body.studentId, studentName: body.studentName });
            else if (body.action === "disable") result = disableNotifications(context);
            else if (body.action === "add_time") result = enableNotifications(context, { studentId: body.studentId, studentName: body.studentName, notificationTime: body.time });
            else if (body.action === "update_time") result = updateNotificationTime(context, body.timeId, body.time);
            else if (body.action === "remove_time") result = removeNotificationTime(context, body.timeId);
            else if (body.action === "metadata") result = updateSubscriptionMetadata(context, body);
            else if (body.action === "delete") result = deleteSubscription(context);
            else return json(response, 400, { error: "Unsupported subscription action" });
            if (result == null || result === false) return json(response, 404, { error: "Subscription or notification time not found" });
            audit(`subscription.${body.action}`, request, { result: "success", chatId: body.chatId, userId: body.userId });
            return json(response, 200, { ok: true, result });
        } catch (error) {
            audit(`subscription.${body.action || "update"}`, request, { result: "failed", error: error.message });
            return json(response, 400, { error: error.message });
        }
    }
    if (url.pathname === `${API_PREFIX}/duty/schedules` && ["POST", "PATCH", "DELETE"].includes(request.method)) {
        let body;
        try { body = await readBody(request); } catch (error) { return json(response, 400, { error: error.message }); }
        try {
            let result;
            if (request.method === "POST") result = addDutySchedules(body.input);
            else if (request.method === "PATCH") result = updateDutySchedule(body.target, body.input);
            else result = deleteDutySchedule(body.target);
            if (!result) return json(response, 404, { error: "Duty schedule not found" });
            audit(`duty_schedule.${request.method.toLowerCase()}`, request, { result: "success", target: body.target || null });
            return json(response, 200, { ok: true, result });
        } catch (error) { return json(response, 400, { error: error.message }); }
    }
    if (url.pathname === `${API_PREFIX}/duty/subscriptions` && request.method === "PATCH") {
        let body;
        try { body = await readBody(request); } catch (error) { return json(response, 400, { error: error.message }); }
        const context = { chatId: body.chatId, chatTitle: body.chatTitle, userDisplayName: body.chatTitle };
        const result = body.enabled === true ? enableDutyNotifications(context) : disableDutyNotifications(context);
        if (!result) return json(response, 404, { error: "Duty subscription not found" });
        audit("duty_subscription.update", request, { result: "success", chatId: body.chatId, enabled: body.enabled === true });
        return json(response, 200, { ok: true, result });
    }
    if (url.pathname === `${API_PREFIX}/settings` && request.method === "GET") return json(response, 200, getAdminSettings());
    if (url.pathname === `${API_PREFIX}/settings` && request.method === "PATCH") {
        let body;
        try { body = await readBody(request); } catch (error) { return json(response, 400, { error: error.message }); }
        try { const updated = setDefaultPageSize(body.defaultPageSize); audit("settings.page_size", request, { result: "success", defaultPageSize: updated.defaultPageSize }); return json(response, 200, updated); }
        catch (error) { return json(response, 400, { error: error.message }); }
    }
    if (url.pathname === `${API_PREFIX}/commands` && request.method === "GET") return json(response, 200, { commands: getCommandRegistry() });
    if (url.pathname === `${API_PREFIX}/settings/admins` && ["POST", "PATCH"].includes(request.method)) {
        let body;
        try { body = await readBody(request); } catch (error) { return json(response, 400, { error: error.message }); }
        try { const admin = upsertAdmin(body); audit("settings.admin_upsert", request, { result: "success", userId: admin.userId, chatId: admin.chatId }); return json(response, 200, { admin }); }
        catch (error) { return json(response, 400, { error: error.message }); }
    }
    if (url.pathname === `${API_PREFIX}/settings/admins` && request.method === "DELETE") {
        const id = String(url.searchParams.get("id") || "");
        const admin = removeAdmin(id);
        if (!admin) return json(response, 404, { error: "Admin setting not found" });
        audit("settings.admin_remove", request, { result: "success", id });
        return json(response, 200, { ok: true, admin });
    }
    if (url.pathname === `${API_PREFIX}/commands` && request.method === "POST") {
        if (typeof options.executeCommand !== "function") return json(response, 503, { error: "Command service unavailable" });
        let body;
        try { body = await readBody(request); } catch (error) { return json(response, 400, { error: error.message }); }
        try {
            const configured = getConfiguredAdminIds();
            const configuredAdmin = getAdminSettings().admins.find((admin) => admin.displayName && admin.displayName.toLowerCase() === String(request.admin.username).toLowerCase());
            const executor = {
                userId: configuredAdmin?.userId || configured.userIds[0] || `admin:${request.admin.username}`,
                username: request.admin.username,
                role: "owner",
                displayName: configuredAdmin?.displayName || request.admin.username
            };
            const target = body.targetUserId || body.targetChatId ? { userId: body.targetUserId || null, chatId: body.targetChatId || null } : null;
            const result = await options.executeCommand({ command: body.command, userId: executor.userId, chatId: body.chatId || configuredAdmin?.chatId || configured.chatIds[0] || executor.userId, displayName: executor.displayName, executor, target });
            audit("command.execute", request, { result: "success", command: body.command, executor: executor.username, userId: executor.userId, target });
            return json(response, 200, result);
        } catch (error) {
            audit("command.execute", request, { result: "failed", command: body.command, error: error.message });
            return json(response, 400, { error: error.message });
        }
    }
    if (url.pathname === `${API_PREFIX}/audit` && request.method === "GET") return json(response, 200, { events: recentAudit(100) });
    if (url.pathname === `${API_PREFIX}/logs` && request.method === "GET") {
        return json(response, 200, { system: getSystemLogs(100), deliveryErrors: dashboardSummary().recentErrors, audit: recentAudit(100) });
    }
    return json(response, 404, { error: "Not found" });
}

function createAdminServer(options = {}) {
    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
        if (url.pathname.startsWith(`${API_PREFIX}/`)) {
            try { await handleApi(request, response, url, options); } catch (error) { json(response, 500, { error: "Internal server error" }); }
            return;
        }
        if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { error: "Method not allowed" });
        if (BASE_PATH !== "/" && url.pathname === BASE_PATH) {
            response.writeHead(308, { Location: `${BASE_PATH}/`, ...securityHeaders() });
            response.end();
            return;
        }
        if (BASE_PATH !== "/" && !url.pathname.startsWith(`${BASE_PATH}/`)) return json(response, 404, { error: "Not found" });
        const relative = url.pathname === UI_PREFIX ? "index.html" : url.pathname.slice(UI_PREFIX.length);
        if (relative.includes("..")) return json(response, 400, { error: "Invalid path" });
        const filePath = path.join(STATIC_DIR, relative || "index.html");
        const ext = path.extname(filePath).toLowerCase();
        const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json" };
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return sendFile(response, filePath, types[ext] || "application/octet-stream");
        return sendFile(response, path.join(STATIC_DIR, "index.html"), types[".html"]);
    });
    const port = Number(options.port || process.env.ADMIN_PORT || process.env.PORT || 6003);
    return { server, port, basePath: BASE_PATH };
}

module.exports = { BASE_PATH, createAdminServer, dashboardSummary, detailForChat, recentAudit };
