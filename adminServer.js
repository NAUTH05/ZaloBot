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
const {
    getCounts: getFeedbackCounts,
    listTickets: listFeedbackTickets,
    markTicketRead: markFeedbackRead,
    setTicketStatus: setFeedbackStatus
} = require("./feedback");
const {
    getAdminSettings,
    getConfiguredAdminIds,
    removeAdmin,
    setBatchDelayMs,
    setDefaultPageSize,
    setMaxBatchSize,
    upsertAdmin
} = require("./adminSettings");
const { findCommand, getCommandRegistry } = require("./commandRegistry");
const { TARGETING, normalizeCommandName, resolveCommandTargeting } = require("./commandTargeting");
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
const { buildAdminData } = require("./adminDataService");
const { buildTargetUserOptions, resolveBatchTargets } = require("./targetUsers");
const { getPersistenceStatus, readJsonStore, writeJsonStore } = require("./firestorePersistence");
const { getSystemLogs } = require("./operationalLog");
const { describeRegisteredBots, getBot, listEnabledBots, runWithBot } = require("./botContext");
const { LEGACY_BOT_ID, normalizeBotId } = require("./bots");

// Bản ghi không có botId thuộc về bot 1 — quy tắc giữ tương thích dữ liệu cũ.
function recordBotId(record) {
    return normalizeBotId(record?.botId) || LEGACY_BOT_ID;
}

// ?botId=all (mặc định) hoặc botN. Dashboard lọc theo bot bằng tham số này.
function botFilterFrom(url) {
    const raw = String(url.searchParams.get("botId") || "all").trim().toLowerCase();
    if (!raw || raw === "all") return "all";
    return normalizeBotId(raw) || "all";
}

function matchesBot(record, botId) {
    return botId === "all" || recordBotId(record) === botId;
}

// Bot đích của một thao tác ghi: ?botId= hoặc body.botId, mặc định bot 1.
// Bot đích của một request.
//
// Có nhiều bot đang chạy mà request không nêu botId thì KHÔNG được đoán: cùng một
// Chat ID hay User ID ở hai bot là hai đối tượng khác nhau, đoán bừa sẽ tác động
// nhầm bot. Trường hợp đó trả lỗi rõ ràng.
//
// Bản triển khai một bot vẫn chạy nguyên như cũ mà không cần botId — đây là đường
// tương thích cho mọi request bot1 hiện có.
function requestBotId(url, body) {
    const fromBody = normalizeBotId(body?.botId);
    if (fromBody) return fromBody;
    const fromQuery = botFilterFrom(url);
    if (fromQuery !== "all") return fromQuery;

    const enabled = listEnabledBots();
    if (enabled.length === 1) return enabled[0].botId;
    // Registry chưa được nạp (dashboard chạy độc lập hoặc trong bài kiểm tra):
    // bot 1 là mặc định lịch sử.
    if (enabled.length === 0) return LEGACY_BOT_ID;

    const error = new Error(
        `Thiếu botId. Hệ thống đang chạy ${enabled.length} bot (${enabled.map((bot) => bot.botId).join(", ")}) ` +
        "nên không thể xác định bot nào. Hãy chọn bot cụ thể cho thao tác này."
    );
    error.statusCode = 400;
    throw error;
}

// Bot đích cho thao tác CHỈ ĐỌC. Không ném lỗi để không làm hỏng việc hiển thị;
// khi mơ hồ thì trả về null để nơi gọi tự quyết định.
function readBotIdOrNull(url, body) {
    try {
        return requestBotId(url, body);
    } catch (_) {
        return null;
    }
}

// Chạy một thao tác trong ngữ cảnh của bot đích, để khóa lưu trữ rơi đúng vào
// bot đó. Nếu bot đích đang tắt thì từ chối thay vì âm thầm ghi vào bot 1.
function withRequestBot(url, body, fn) {
    const botId = requestBotId(url, body);
    const owner = getBot(botId);
    if (!owner) {
        // Bot 1 vẫn cho phép khi registry chưa nạp (dashboard chạy độc lập, test).
        if (botId !== LEGACY_BOT_ID) {
            const error = new Error(`Bot ${botId} đang tắt nên không thể thực hiện thao tác này.`);
            error.statusCode = 400;
            throw error;
        }
        return fn();
    }
    return runWithBot(owner, fn);
}

// Quyền truy cập chat phải được kiểm tra trong ngữ cảnh của bot SỞ HỮU đăng ký,
// nếu không đăng ký của bot 2 sẽ bị đánh giá bằng sổ chat của bot 1.
// (Cùng quy tắc với isSubscriptionEligible trong main.js.)
function isSubscriptionEligibleForOwner(subscription) {
    const ownerId = recordBotId(subscription);
    const owner = getBot(ownerId);
    if (!owner) {
        // Bản ghi bot 1 vẫn hợp lệ khi registry chưa được nạp (dashboard chạy độc
        // lập, hoặc trong bài kiểm tra): bot 1 là ngữ cảnh mặc định. Bản ghi của
        // bot đang tắt thì KHÔNG hợp lệ — bot đó không gửi được.
        if (ownerId !== LEGACY_BOT_ID) return false;
        return isChatEligible(subscription.chatId, "schedule");
    }
    return runWithBot(owner, () => isChatEligible(subscription.chatId, "schedule"));
}

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

// Ngày đích của một mốc nhận lịch: 0 = homnay, 1 = homsau. Dùng chung quy tắc
// với lệnh chat nên API không thể nhận giá trị mà chat từ chối.
function parseTargetDayOffset(value) {
    if (value === 0 || value === "0") return 0;
    if (value === 1 || value === "1") return 1;
    return null;
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

/* -------------------------------------------------------------------------- */
/* Command console nhiều người nhận                                           */
/* -------------------------------------------------------------------------- */

// Lượt chạy nhiều người nhận chạy nền và được hỏi tiến độ qua jobId, để giao
// diện hiển thị được completed/total thay vì chờ một yêu cầu HTTP dài.
const BATCH_JOB_TTL_MS = 15 * 60 * 1000;
const MAX_BATCH_JOBS = 20;
const batchJobs = new Map();

function pruneBatchJobs(now = Date.now()) {
    for (const [id, job] of batchJobs) {
        if (now - job.createdAtMs > BATCH_JOB_TTL_MS) batchJobs.delete(id);
    }
    while (batchJobs.size > MAX_BATCH_JOBS) {
        const oldest = [...batchJobs.entries()].sort((left, right) => left[1].createdAtMs - right[1].createdAtMs)[0];
        batchJobs.delete(oldest[0]);
    }
}

// Danh tính admin lấy từ phiên đăng nhập, không bao giờ từ nội dung yêu cầu.
function buildExecutor(request) {
    const configured = getConfiguredAdminIds();
    const configuredAdmin = getAdminSettings().admins
        .find((admin) => admin.displayName && admin.displayName.toLowerCase() === String(request.admin.username).toLowerCase());
    return {
        userId: configuredAdmin?.userId || configured.userIds[0] || `admin:${request.admin.username}`,
        username: request.admin.username,
        role: "owner",
        displayName: configuredAdmin?.displayName || request.admin.username,
        chatId: configuredAdmin?.chatId || configured.chatIds[0] || null
    };
}

function batchExecutorChatId(executor) {
    return executor.chatId || executor.userId;
}

function sleep(ms) {
    return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

// Một kết quả cho một người nhận. `status` phân biệt rõ "chạy được và đã gửi"
// với "lỗi" và "bỏ qua", dựa trên `deliveredToChatId` mà engine trả về.
function targetResult(target, outcome) {
    return {
        userId: target.userId,
        displayName: target.displayName,
        chatId: target.chatId || null,
        status: outcome.status,
        messageCount: outcome.messageCount || 0,
        deliveredToChatId: outcome.deliveredToChatId || null,
        messages: outcome.messages || [],
        error: outcome.error || null
    };
}

function commandNameFromInput(raw) {
    const text = String(raw || "").trim();
    if (!text.startsWith("/")) return "";
    const match = text.match(/^\/(\w+)/);
    return match ? match[1].toLowerCase() : "";
}

function summarizeBatch(results, extra = {}) {
    const summary = {
        total: results.length,
        completed: results.length,
        delivered: results.filter((item) => item.status === "delivered").length,
        failed: results.filter((item) => item.status === "failed").length,
        skipped: results.filter((item) => item.status === "skipped").length,
        ...extra
    };
    return summary;
}

// Kiểm tra toàn bộ yêu cầu TRƯỚC khi chạy bất kỳ người nhận nào, để một lượt
// sai không bao giờ gửi được một nửa rồi mới báo lỗi.
function prepareCommandRequest(body = {}) {
    const command = String(body.command || "").trim();
    if (!command) return { ok: false, status: 400, error: "Thiếu lệnh.", command: "" };
    if (!command.startsWith("/")) return { ok: false, status: 400, error: "Lệnh phải bắt đầu bằng /", command };

    const name = commandNameFromInput(command);
    const entry = name ? findCommand(name) : null;
    if (!entry) {
        return { ok: false, status: 400, command, error: `Không nhận diện được lệnh “${name ? `/${name}` : command}”.` };
    }

    const targeting = resolveCommandTargeting(name);
    if (targeting.mode === TARGETING.NONE) {
        return { ok: false, status: 400, command, name, targeting, error: targeting.reason };
    }

    const settings = getAdminSettings();
    // Bot gửi là bắt buộc với lệnh có gửi tin: người nhận chỉ có nghĩa trong
    // phạm vi một bot. Bot đang tắt bị từ chối thay vì âm thầm dùng bot 1.
    const explicitBotId = normalizeBotId(body.botId);
    if (body.botId && !explicitBotId) {
        return { ok: false, status: 400, command, error: `Bot không hợp lệ: ${String(body.botId)}` };
    }
    // Chạy nhiều bot mà không nêu bot thì không được đoán: cùng một User ID ở hai
    // bot là hai người khác nhau nên đoán bừa sẽ gửi nhầm danh tính.
    const enabledBots = listEnabledBots();
    if (!explicitBotId && enabledBots.length > 1) {
        return {
            ok: false,
            status: 400,
            command,
            name,
            targeting,
            error: `Thiếu bot gửi. Hệ thống đang chạy ${enabledBots.length} bot (${enabledBots.map((bot) => bot.botId).join(", ")}) nên phải chọn bot cụ thể.`
        };
    }
    const botId = explicitBotId || (enabledBots.length === 1 ? enabledBots[0].botId : LEGACY_BOT_ID);
    if (botId !== LEGACY_BOT_ID && !getBot(botId)) {
        return { ok: false, status: 400, command, error: `Bot ${botId} đang tắt.` };
    }
    // Tương thích ngược: client cũ vẫn gửi một chuỗi targetUserId.
    const rawIds = Array.isArray(body.targetUserIds)
        ? body.targetUserIds
        : (body.targetUserId != null && String(body.targetUserId).trim() !== "" ? [body.targetUserId] : []);
    // Người nhận được phân giải trong đúng phạm vi bot đã chọn.
    const batch = resolveBatchTargets(buildAdminData(), rawIds, { max: settings.maxBatchSize, botId });

    if (batch.rejected.length > 0) {
        return {
            ok: false, status: 400, command, name, targeting,
            error: batch.rejected[0].reason,
            errors: batch.rejected.map((item) => item.reason),
            targetUserIds: rawIds
        };
    }
    if (batch.overflow > 0) {
        return {
            ok: false, status: 400, command, name, targeting,
            error: `Mỗi lượt chỉ chạy tối đa ${batch.max} người nhận; đang chọn ${batch.targets.length + batch.overflow}. Hãy bỏ bớt ${batch.overflow} người.`,
            targetUserIds: rawIds
        };
    }
    if (targeting.mode === TARGETING.PER_USER && batch.targets.length === 0) {
        return {
            ok: false, status: 400, command, name, targeting,
            error: "Lệnh này chạy theo từng người nên cần chọn ít nhất một người nhận.",
            targetUserIds: rawIds
        };
    }

    return { ok: true, command, name, targeting, batch, settings, botId };
}

async function executeForTarget({ executeCommand, command, executor, target, botId }) {
    return executeCommand({
        command,
        botId,
        userId: executor.userId,
        chatId: batchExecutorChatId(executor),
        displayName: executor.displayName,
        executor,
        target
    });
}

// Chạy lệnh lần lượt cho từng người nhận. Một người lỗi không dừng những người
// còn lại; mỗi lần gửi cách nhau `delayMs` để không dồn dập Zalo.
async function runCommandBatch({ executeCommand, command, targets, executor, delayMs = 0, onProgress = null, botId }) {
    const results = [];

    for (const target of targets) {
        if (!target.chatId) {
            // Không có liên kết chat đủ tin cậy thì không thể gửi thật, nên bỏ
            // qua thay vì báo thành công.
            results.push(targetResult(target, {
                status: "skipped",
                error: target.chatHint === "multiple"
                    ? "Người này có nhiều ngữ cảnh chat nên không xác định được chat để gửi."
                    : "Không xác định được chat riêng tư đang hoạt động cho người này."
            }));
            if (onProgress) onProgress(results);
            continue;
        }

        try {
            const result = await executeForTarget({ executeCommand, command, executor, target, botId });
            const messages = Array.isArray(result?.messages) ? result.messages : [];
            const messageCount = Number(result?.messageCount ?? messages.length) || 0;
            results.push(targetResult(target, {
                status: messageCount > 0 ? "delivered" : "skipped",
                messageCount,
                deliveredToChatId: result?.deliveredToChatId || null,
                messages,
                error: messageCount > 0 ? null : "Lệnh không tạo ra tin nhắn nào để gửi."
            }));
        } catch (error) {
            results.push(targetResult(target, {
                status: "failed",
                error: String(error?.message || error).slice(0, 300)
            }));
        }

        if (onProgress) onProgress(results);
        await sleep(delayMs);
    }

    return results;
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

function subscriptionsForChat(chatId, botId = LEGACY_BOT_ID) {
    return Object.entries(getAllSubscriptions())
        .filter(([key, subscription]) => String(subscription?.chatId || "") === String(chatId) && botIdOf(subscription, key) === botId)
        .map(([key, subscription]) => ({ key, ...subscription }));
}

// Khớp cả botId: cùng một Chat ID ở hai bot là hai cuộc trò chuyện khác nhau,
// tra theo chatId trần sẽ mở nhầm bản ghi của bot kia.
function detailForChat(chatId, botId = LEGACY_BOT_ID) {
    const workspace = buildAdminData();
    const chat = workspace.chats.find((item) => String(item.chatId) === String(chatId) && recordBotId(item) === botId);
    if (!chat) return null;
    return {
        chat: publicChat(chat),
        deliveryHistory: Array.isArray(chat.deliveryHistory) ? chat.deliveryHistory.slice(-50).reverse() : [],
        subscriptions: workspace.subscriptions.filter((item) => String(item.chatId) === String(chatId) && recordBotId(item) === botId),
        members: workspace.users.filter((user) => recordBotId(user) === botId && user.chats.some((item) => String(item.chatId) === String(chatId)))
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
    // Danh sách bot đang chạy. describeRegisteredBots chỉ trả vân tay token,
    // không bao giờ trả chính token.
    if (url.pathname === `${API_PREFIX}/bots` && request.method === "GET") {
        return json(response, 200, { bots: describeRegisteredBots() });
    }

    // ---------------------------------------------------------------------
    // Đăng nhập QR cho tài khoản Zalo cá nhân.
    //
    // Các endpoint này nằm sau middleware xác thực admin hiện có, nên KHÔNG bao
    // giờ lộ ra công khai. Chúng chỉ trả ảnh QR và trạng thái — tuyệt đối không
    // trả cookie, imei hay userAgent của phiên.
    // ---------------------------------------------------------------------
    if (url.pathname === `${API_PREFIX}/providers/zca/qr` && request.method === "GET") {
        if (typeof options.getZcaQr !== "function") return json(response, 503, { error: "ZCA không khả dụng" });
        const qr = options.getZcaQr();
        // Ảnh QR chỉ nằm trong bộ nhớ; không có thì trả về null thay vì lỗi.
        return json(response, 200, { qr });
    }
    if (url.pathname === `${API_PREFIX}/providers/zca/login` && request.method === "POST") {
        if (typeof options.beginZcaLogin !== "function") return json(response, 503, { error: "ZCA không khả dụng" });
        try {
            const result = await options.beginZcaLogin();
            audit("zca.login_requested", request, { result: result?.ok ? "success" : "failed" });
            return json(response, 200, result || { ok: false });
        } catch (error) {
            audit("zca.login_requested", request, { result: "failed", error: error.message });
            return json(response, 400, { error: error.message });
        }
    }
    if (url.pathname === `${API_PREFIX}/providers/zca/session` && request.method === "DELETE") {
        if (typeof options.clearZcaSession !== "function") return json(response, 503, { error: "ZCA không khả dụng" });
        try {
            const result = await options.clearZcaSession();
            audit("zca.session_cleared", request, { result: "success" });
            return json(response, 200, result || { ok: true });
        } catch (error) {
            return json(response, 400, { error: error.message });
        }
    }
    // ---------------------------------------------------------------------
    // Hỗ trợ / góp ý.
    //
    // Mọi route nằm sau requireAdmin ở trên, nên chỉ quản trị viên đã đăng nhập
    // mới đọc và trả lời được. Danh tính hội thoại LUÔN là (botId, ticketId):
    // thiếu botId thì từ chối, không đoán bot 1.
    // ---------------------------------------------------------------------
    if (url.pathname === `${API_PREFIX}/feedback` && request.method === "GET") {
        const botId = url.searchParams.get("botId");
        return json(response, 200, {
            tickets: listFeedbackTickets({
                botId: botId || null,
                status: url.searchParams.get("status") || "all",
                search: url.searchParams.get("search") || "",
                unreadOnly: url.searchParams.get("unread") === "true"
            }),
            counts: getFeedbackCounts()
        });
    }
    if (url.pathname === `${API_PREFIX}/feedback/detail` && request.method === "GET") {
        const botId = url.searchParams.get("botId");
        const ticketId = url.searchParams.get("ticketId");
        if (!botId) return json(response, 400, { error: "Thiếu botId — chat ID chỉ có nghĩa trong phạm vi một bot" });
        if (!ticketId) return json(response, 400, { error: "Thiếu ticketId" });
        // Đọc chi tiết coi như đã xem.
        const ticket = markFeedbackRead(botId, ticketId);
        if (!ticket) return json(response, 404, { error: "Không tìm thấy yêu cầu trong bot này" });
        return json(response, 200, { ticket, counts: getFeedbackCounts() });
    }
    if (url.pathname === `${API_PREFIX}/feedback/reply` && request.method === "POST") {
        if (typeof options.replyToFeedback !== "function") {
            return json(response, 503, { error: "Chức năng trả lời chưa sẵn sàng" });
        }
        let body;
        try {
            body = await readBody(request);
        } catch (error) {
            return json(response, 400, { error: error.message });
        }
        const botId = String(body?.botId || "").trim();
        const ticketId = String(body?.ticketId || "").trim();
        const message = String(body?.message || "").trim();
        if (!botId) return json(response, 400, { error: "Thiếu botId" });
        if (!ticketId) return json(response, 400, { error: "Thiếu ticketId" });
        if (!message) return json(response, 400, { error: "Nội dung trả lời không được để trống" });

        try {
            const result = await options.replyToFeedback({
                botId,
                ticketId,
                message,
                adminName: request.admin?.displayName || request.admin?.username || "quản trị viên"
            });
            audit("feedback.reply", request, { ticketId, botId, result: result?.delivered ? "sent" : "failed" });
            // Trả 200 kèm trạng thái gửi: giao diện hiển thị đúng thất bại thay vì
            // luôn báo "đã gửi".
            return json(response, 200, result);
        } catch (error) {
            audit("feedback.reply", request, { ticketId, botId, result: "error", error: error.message });
            return json(response, 400, { error: error.message });
        }
    }
    if (url.pathname === `${API_PREFIX}/feedback/status` && request.method === "POST") {
        let body;
        try {
            body = await readBody(request);
        } catch (error) {
            return json(response, 400, { error: error.message });
        }
        const botId = String(body?.botId || "").trim();
        const ticketId = String(body?.ticketId || "").trim();
        const status = String(body?.status || "").trim();
        if (!botId) return json(response, 400, { error: "Thiếu botId" });
        if (!ticketId) return json(response, 400, { error: "Thiếu ticketId" });
        if (!["open", "resolved"].includes(status)) {
            return json(response, 400, { error: "Trạng thái chỉ nhận open hoặc resolved" });
        }
        const ticket = setFeedbackStatus(botId, ticketId, status);
        if (!ticket) return json(response, 404, { error: "Không tìm thấy yêu cầu trong bot này" });
        audit("feedback.status", request, { ticketId, botId, status });
        return json(response, 200, { ticket, counts: getFeedbackCounts() });
    }

    if (url.pathname === `${API_PREFIX}/chats` && request.method === "GET") {
        const filter = String(url.searchParams.get("status") || "all");
        const type = String(url.searchParams.get("type") || "all");
        const botId = botFilterFrom(url);
        const chats = buildAdminData().chats
            .filter((chat) => matchesBot(chat, botId))
            .filter((chat) => (filter === "all" || chat.status === filter) && (type === "all" || chat.chatType === type))
            .map(publicChat);
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
        const botId = botFilterFrom(url);
        return json(response, 200, { users: buildAdminData().users.filter((user) => matchesBot(user, botId)) });
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
        const detail = detailForChat(decodeURIComponent(chatMatch[1]), readBotIdOrNull(url, null) || LEGACY_BOT_ID);
        return detail ? json(response, 200, detail) : json(response, 404, { error: "Chat not found" });
    }
    if (chatMatch && ["PATCH", "POST"].includes(request.method)) {
        let body;
        try { body = await readBody(request); } catch (error) { return json(response, 400, { error: error.message }); }
        const chatId = decodeURIComponent(chatMatch[1]);
        try {
            let result;
            const runForBot = (action) => withRequestBot(url, body, action);
            if (body.action === "status") result = runForBot(() => setChatStatus(chatId, body.status, request.admin.username, body.reason || "admin_action"));
            else if (body.action === "feature") result = runForBot(() => setFeatureOverride(chatId, body.feature, body.enabled == null ? null : body.enabled));
            else if (body.action === "metadata") result = runForBot(() => upsertChat({ chatId, chatType: body.chatType, displayName: body.displayName, chatTitle: body.chatTitle, userId: body.userId }));
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
        const hard = body.hard === true || url.searchParams.get("hard") === "1";
        let result;
        try {
            result = withRequestBot(url, body, () => removeChat(chatId, hard));
        } catch (error) {
            // Bot mơ hồ hoặc đang tắt: trả lỗi rõ ràng thay vì âm thầm tác động
            // lên bot 1.
            return json(response, error.statusCode || 400, { error: error.message });
        }
        if (!result) return json(response, 400, { error: "chatId không hợp lệ" });

        audit("chat.delete", request, {
            chatId,
            botId: requestBotId(url, body),
            hard,
            hadDirectoryRecord: result.hadDirectoryRecord,
            result: "success"
        });

        // 200 kể cả khi chat chỉ tồn tại nhờ dữ liệu tương tác/đăng ký: thao tác
        // đã có hiệu lực (chat không còn hiện trên dashboard) nên không phải 404.
        return json(response, 200, {
            ok: true,
            hard,
            botId: requestBotId(url, body),
            hadDirectoryRecord: result.hadDirectoryRecord,
            chat: result.record ? publicChat(result.record) : null,
            message: hard
                ? (result.hadDirectoryRecord
                    ? "Đã xoá vĩnh viễn bản ghi trong sổ chat. Đăng ký nhận lịch và lịch sử tương tác vẫn được giữ."
                    : "Chat này không có bản ghi trong sổ chat (chỉ có dữ liệu tương tác/đăng ký). Đã đánh dấu xoá để không hiện lại; đăng ký và lịch sử tương tác vẫn được giữ.")
                : "Đã chuyển chat sang trạng thái removed. Bản ghi và đăng ký vẫn còn, có thể bật lại."
        });
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
        const botId = botFilterFrom(url);
        return json(response, 200, {
            schedule: Object.values(getEnabledSubscriptions())
                .filter((item) => matchesBot(item, botId))
                .filter((item) => isSubscriptionEligibleForOwner(item))
        });
    }
    if (url.pathname === `${API_PREFIX}/subscriptions` && request.method === "PATCH") {
        let body;
        try { body = await readBody(request); } catch (error) { return json(response, 400, { error: error.message }); }
        const context = { botId: requestBotId(url, body), chatId: body.chatId, userId: body.userId, userDisplayName: body.userDisplayName || "" };
        // Ngày đích phải được kiểm tra giống hệt lệnh chat: chỉ 0 (homnay) hoặc 1 (homsau).
        const targetDayOffset = parseTargetDayOffset(body.targetDayOffset);
        if (body.targetDayOffset !== undefined && body.targetDayOffset !== null && targetDayOffset == null) {
            return json(response, 400, { error: "targetDayOffset chỉ nhận 0 (homnay) hoặc 1 (homsau)" });
        }
        try {
            let result;
            if (body.action === "enable") result = enableNotifications(context, { studentId: body.studentId, studentName: body.studentName });
            else if (body.action === "disable") result = disableNotifications(context);
            else if (body.action === "add_time") {
                if (targetDayOffset == null) return json(response, 400, { error: "Cần chọn ngày đích: 0 (homnay) hoặc 1 (homsau)" });
                result = enableNotifications(context, { studentId: body.studentId, studentName: body.studentName, notificationTime: body.time, targetDayOffset });
            } else if (body.action === "update_time") result = updateNotificationTime(context, body.timeId, body.time, targetDayOffset);
            else if (body.action === "remove_time") result = removeNotificationTime(context, body.timeId);
            else if (body.action === "metadata") result = updateSubscriptionMetadata(context, body);
            else if (body.action === "delete") result = deleteSubscription(context);
            else return json(response, 400, { error: "Unsupported subscription action" });
            if (result == null || result === false) return json(response, 404, { error: "Subscription or notification time not found" });
            audit(`subscription.${body.action}`, request, { result: "success", chatId: body.chatId, userId: body.userId, targetDayOffset: targetDayOffset ?? null });
            return json(response, 200, { ok: true, result });
        } catch (error) {
            audit(`subscription.${body.action || "update"}`, request, { result: "failed", error: error.message });
            return json(response, 400, { error: error.message });
        }
    }
    if (url.pathname === `${API_PREFIX}/settings` && request.method === "GET") return json(response, 200, getAdminSettings());
    if (url.pathname === `${API_PREFIX}/settings` && request.method === "PATCH") {
        let body;
        try { body = await readBody(request); } catch (error) { return json(response, 400, { error: error.message }); }
        try {
            let updated = getAdminSettings();
            if (body.defaultPageSize !== undefined) updated = setDefaultPageSize(body.defaultPageSize);
            if (body.maxBatchSize !== undefined) updated = setMaxBatchSize(body.maxBatchSize);
            if (body.batchDelayMs !== undefined) updated = setBatchDelayMs(body.batchDelayMs);
            audit("settings.update", request, {
                result: "success",
                defaultPageSize: updated.defaultPageSize,
                maxBatchSize: updated.maxBatchSize,
                batchDelayMs: updated.batchDelayMs
            });
            return json(response, 200, updated);
        } catch (error) {
            return json(response, 400, { error: error.message });
        }
    }
    if (url.pathname === `${API_PREFIX}/commands` && request.method === "GET") return json(response, 200, { commands: getCommandRegistry() });
    if (url.pathname === `${API_PREFIX}/target-users` && request.method === "GET") {
        // Khóa luôn là User ID thật; targetChatId chỉ có khi liên kết đủ tin cậy.
        // Có ?botId= thì chỉ trả người của bot đó — bộ chọn không được trộn hai bot.
        const botId = botFilterFrom(url);
        const users = buildTargetUserOptions(buildAdminData())
            .filter((user) => botId === "all" || recordBotId(user) === botId);
        return json(response, 200, { users, botId });
    }
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

        const prepared = prepareCommandRequest(body);
        if (!prepared.ok) {
            audit("command.execute", request, {
                result: "rejected",
                command: prepared.command,
                error: prepared.error,
                targetUserIds: prepared.targetUserIds || null
            });
            return json(response, prepared.status || 400, {
                error: prepared.error,
                errors: prepared.errors || [],
                targeting: prepared.targeting || null
            });
        }

        const executor = buildExecutor(request);
        const { command, targeting, batch, settings } = prepared;

        // Lệnh broadcast gửi tới mọi chat nên chỉ chạy ĐÚNG MỘT LẦN, dù người
        // dùng chọn bao nhiêu người nhận.
        if (targeting.mode === TARGETING.BROADCAST) {
            let result;
            let failure = null;
            try {
                result = await executeForTarget({ executeCommand: options.executeCommand, command, executor, target: null, botId: prepared.botId });
            } catch (error) {
                failure = error;
            }
            audit("command.execute", request, {
                result: failure ? "failed" : "success",
                command,
                executor: executor.username,
                scope: "broadcast",
                targetUserIds: batch.targets.map((item) => item.userId),
                deliveredToChatId: result?.deliveredToChatId || null,
                error: failure ? failure.message : null
            });
            if (failure) return json(response, 400, { error: failure.message, targeting });
            return json(response, 200, {
                ...result,
                targeting,
                summary: summarizeBatch([], { broadcast: true, selected: batch.targets.length, duplicates: batch.duplicates.length }),
                results: [],
                note: targeting.broadcastScope
            });        }

        const results = await runCommandBatch({
            executeCommand: options.executeCommand,
            command,
            botId: prepared.botId,
            targets: batch.targets,
            executor,
            delayMs: settings.batchDelayMs
        });

        const summary = summarizeBatch(results, { duplicates: batch.duplicates.length, truncated: 0 });
        audit("command.execute", request, {
            result: summary.failed > 0 ? "partial" : "success",
            command,
            executor: executor.username,
            scope: "per-user",
            targetUserIds: batch.targets.map((item) => item.userId),
            duplicates: batch.duplicates,
            outcomes: results.map((item) => ({ userId: item.userId, status: item.status, error: item.error }))
        });

        // Tương thích ngược: client cũ gửi một targetUserId vẫn nhận đúng dạng
        // phản hồi cũ (messages / deliveredToChatId / target).
        const single = results.length === 1 ? results[0] : null;
        return json(response, 200, {
            command,
            targeting,
            summary,
            results,
            deliveredToChatId: single?.deliveredToChatId || null,
            messages: single?.messages || [],
            messageCount: single?.messageCount || 0,
            executor,
            target: single ? { userId: single.userId, chatId: single.chatId, displayName: single.displayName } : null
        });
    }

    // Lượt chạy nhiều người nhận chạy nền để giao diện hỏi được tiến độ.
    if (url.pathname === `${API_PREFIX}/commands/batch` && request.method === "POST") {
        if (typeof options.executeCommand !== "function") return json(response, 503, { error: "Command service unavailable" });
        let body;
        try { body = await readBody(request); } catch (error) { return json(response, 400, { error: error.message }); }

        const prepared = prepareCommandRequest(body);
        if (!prepared.ok) {
            audit("command.batch", request, {
                result: "rejected",
                command: prepared.command,
                error: prepared.error,
                targetUserIds: prepared.targetUserIds || null
            });
            return json(response, prepared.status || 400, {
                error: prepared.error,
                errors: prepared.errors || [],
                targeting: prepared.targeting || null
            });
        }

        const executor = buildExecutor(request);
        const { command, targeting, batch, settings } = prepared;
        const isBroadcast = targeting.mode === TARGETING.BROADCAST;

        pruneBatchJobs();
        const job = {
            id: crypto.randomUUID(),
            command,
            targeting,
            executor,
            total: isBroadcast ? 1 : batch.targets.length,
            results: [],
            status: "running",
            duplicates: batch.duplicates,
            createdAtMs: Date.now(),
            startedAt: new Date().toISOString(),
            finishedAt: null
        };
        batchJobs.set(job.id, job);

        const run = async () => {
            try {
                if (isBroadcast) {
                    let outcome;
                    try {
                        const result = await executeForTarget({ executeCommand: options.executeCommand, command, executor, target: null, botId: prepared.botId });
                        const messages = Array.isArray(result?.messages) ? result.messages : [];
                        outcome = [{ userId: null, displayName: "Mọi chat đang hoạt động", chatId: null, status: "delivered", messageCount: Number(result?.messageCount ?? messages.length) || 0, deliveredToChatId: result?.deliveredToChatId || null, messages, error: null }];
                    } catch (error) {
                        outcome = [{ userId: null, displayName: "Mọi chat đang hoạt động", chatId: null, status: "failed", messageCount: 0, deliveredToChatId: null, messages: [], error: String(error?.message || error).slice(0, 300) }];
                    }
                    job.results = outcome;
                } else {
                    job.results = await runCommandBatch({
                        executeCommand: options.executeCommand,
                        command,
                        targets: batch.targets,
                        executor,
                        delayMs: settings.batchDelayMs,
                        onProgress: (partial) => { job.results = [...partial]; }
                    });
                }
                job.status = "finished";
            } catch (error) {
                job.status = "failed";
                job.error = String(error?.message || error).slice(0, 300);
            } finally {
                job.finishedAt = new Date().toISOString();
                const summary = summarizeBatch(job.results, { broadcast: isBroadcast, duplicates: batch.duplicates.length });
                audit("command.batch", request, {
                    result: summary.failed > 0 ? "partial" : "success",
                    command,
                    executor: executor.username,
                    jobId: job.id,
                    scope: isBroadcast ? "broadcast" : "per-user",
                    targetUserIds: batch.targets.map((item) => item.userId),
                    duplicates: batch.duplicates,
                    outcomes: job.results.map((item) => ({ userId: item.userId, status: item.status, error: item.error }))
                });
            }
        };
        // Không await: trả jobId ngay để giao diện hiển thị tiến độ.
        run().catch(() => {});

        return json(response, 202, {
            jobId: job.id,
            total: job.total,
            targeting,
            note: isBroadcast ? targeting.broadcastScope : null
        });
    }

    const batchJobMatch = new RegExp(`^${API_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/commands/batch/([^/]+)$`).exec(url.pathname);
    if (batchJobMatch && request.method === "GET") {
        const job = batchJobs.get(decodeURIComponent(batchJobMatch[1]));
        if (!job) return json(response, 404, { error: "Không tìm thấy lượt chạy này (có thể đã hết hạn)." });
        return json(response, 200, {
            jobId: job.id,
            status: job.status,
            command: job.command,
            targeting: job.targeting,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            error: job.error || null,
            progress: {
                completed: job.results.length,
                total: job.total
            },
            summary: summarizeBatch(job.results, { broadcast: job.targeting?.mode === TARGETING.BROADCAST, duplicates: job.duplicates.length }),
            results: job.results
        });
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
