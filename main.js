process.env.TZ = "Asia/Ho_Chi_Minh";

const path = require("path");

// Nạp .env theo thư mục dự án để cấu hình hoạt động giống nhau dù tiến trình
// được khởi động từ thư mục nào (PM2, terminal, systemd).
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

const https = require("https");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const schedule = require("node-schedule");
const ZaloBot = require("node-zalo-bot");
const {
    fetchExamSchedule,
    fetchStudentSchedule,
    fetchTeacherSchedule,
    findEmptyRooms,
    formatDailySchedule,
    formatExamSchedule,
    formatTeacherSchedule,
    formatWeeklySchedule,
    normalizeStudentId,
    resolveStudentIdForCommand,
    searchTeacherByName
} = require("./lhuSchedule");
const {
    DEFAULT_NOTIFICATION_TIME,
    TARGET_DAY_TODAY,
    TARGET_DAY_TOMORROW,
    disableClassStartNotifications,
    disableNotifications,
    enableClassStartNotifications,
    enableNotifications,
    getAllSubscriptions,
    getClassStartNotificationSubscriptions,
    getEnabledSubscriptions,
    getSubscription,
    normalizeNotificationTime,
    normalizeNotificationTimes,
    normalizeTargetDayOffset,
    removeNotificationTime,
    saveStudent,
    updateNotificationTime
} = require("./subscriptions");
const {
    createClassStartReminderService,
    DEFAULT_CACHE_TTL_MS,
    DEFAULT_GRACE_PERIOD_MS
} = require("./classStartNotifications");
const { getMessageContext } = require("./userContext");
const {
    captureScheduleChange,
    confirmScheduleChange,
    formatScheduleChangeMessage,
    initializeScheduleSnapshot
} = require("./scheduleChanges");
const { TIME_ZONE, getVietnamDateInfo } = require("./timezone");
const { addCalendarDays, dateFromVietnamDateKey } = require("./scheduleDatePolicy");
const { escapeMarkdown, escapeMarkdownMultiline, sanitizeExternalRichText } = require("./richText");
const {
    formatAdminHelp,
    formatClassStartEnabled,
    formatClassStartStatus,
    formatDailyNotificationEnabled,
    formatErrorMessage,
    formatGeneralHelp,
    formatMissingStudentIdMessage,
    formatStudentSavedMessage,
    formatSuccessMessage,
    formatWarningMessage,
    formatWelcomeMessage
} = require("./messageTemplates");
const { resolveCommandName } = require("./helpContent");
const { getInteractionTargets, recordInteraction } = require("./interactionRegistry");
const {
    getAllChats,
    getChat,
    isChatEligible,
    recordDeliveryFailure,
    recordDeliverySuccess,
    setChatStatus,
    setFeatureOverride,
    upsertChat
} = require("./chatDirectory");
const {
    allowTarget,
    blockTarget,
    canUseAi,
    canUseBot,
    getAccessSummary,
    setAccessMode,
    unallowTarget,
    unblockTarget
} = require("./accessControl");
const { askScheduleAi } = require("./aiAssistant");
const { flushPersistenceWrites, initializeFirestorePersistence } = require("./firestorePersistence");
const { getCommandRegistry } = require("./commandRegistry");
const { createAdminServer } = require("./adminServer");
const { DEFAULT_SHUTDOWN_TIMEOUT_MS, createShutdownController } = require("./shutdown");
const { recordSystemLog } = require("./operationalLog");
const { getConfiguredAdminIds, isConfiguredAdmin } = require("./adminSettings");
const { LEGACY_BOT_ID, normalizeBotId, resolveBotConfigs, scopeKey } = require("./bots");
const {
    bindBot,
    describeRegisteredBots,
    getBot,
    getCurrentBot,
    listBots,
    listEnabledBots,
    registerBots,
    runWithBot
} = require("./botContext");

const isTestEnv = process.env.NODE_ENV === "test" || require.main !== module;

// Cấu hình nhiều bot trên cùng một codebase và một Firestore database.
// BOT_TOKEN cũ vẫn là đường tương thích của bot 1; thiếu BOT_2_TOKEN/BOT_3_TOKEN
// chỉ đơn giản là bot đó tắt.
const botConfigResult = resolveBotConfigs(process.env);

// Bot 1 là danh tính gốc: nó sở hữu không gian khóa cũ và là đường tương thích
// của bản triển khai hiện tại. Thiếu token bot 1 là lỗi cấu hình, không phải
// trạng thái chạy được — kể cả khi bot 2 hoặc bot 3 có token.
const hasLegacyBot = botConfigResult.bots.some((config) => config.botId === LEGACY_BOT_ID);
if (botConfigResult.bots.length === 0 || !hasLegacyBot) {
    const reasons = botConfigResult.errors.length
        ? botConfigResult.errors
        : ["Không có bot 1 đang bật. Đặt BOT_TOKEN hoặc BOT_1_TOKEN trong .env."];
    throw new Error(`Không thể khởi động bot:\n- ${reasons.join("\n- ")}`);
}
for (const warning of botConfigResult.warnings) console.log(`[Bots] ${warning}`);

// Một runtime cho mỗi bot đang bật: client riêng, con trỏ polling riêng, handler
// riêng. Không bao giờ dùng chung một token cho hai bot.
function createBotRuntime(config) {
    return {
        botId: config.botId,
        token: config.token,
        source: config.source,
        fingerprint: config.fingerprint,
        enabled: true,
        client: new ZaloBot(config.token, { polling: false }),
        monthlyMessageWarning: config.monthlyMessageWarning,
        status: "starting",
        lastError: null,
        lastErrorAt: null,
        pollingStartedAt: null
    };
}

const botRuntimes = botConfigResult.bots.map((config) => createBotRuntime(config));
registerBots(botRuntimes);
const dashboardCommandContext = new AsyncLocalStorage();
const registeredSchedulers = new WeakSet();

// Trạng thái runtime phục vụ dừng an toàn.
let runtimeSchedulerJobs = [];
let adminRuntime = null;
let shutdownController = null;
let shuttingDown = false;

function logDiscord(level, message) {
    if (level === "ERROR" || level === "WARN") {
        try { recordSystemLog(level, message); } catch (_) { /* Logging must not interrupt bot work. */ }
    }
    const webhookUrl = process.env.DISCORD_WEBHOOK;
    if (!webhookUrl) return;

    const colors = { INFO: 3447003, WARN: 16776960, ERROR: 15158332 };
    const now = new Date().toLocaleString("vi-VN", { timeZone: TIME_ZONE });
    const payload = JSON.stringify({
        embeds: [{
            title: `[${level}] ZaloBot`,
            description: `\`\`\`${String(message).slice(0, 3900)}\`\`\``,
            color: colors[level] || colors.INFO,
            footer: { text: now }
        }]
    });

    try {
        const url = new URL(webhookUrl);
        const req = https.request({
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload)
            }
        });
        req.on("error", () => { });
        req.write(payload);
        req.end();
    } catch (_) {
        // Không để lỗi webhook làm dừng bot.
    }
}

// Client Zalo của bot đang xử lý. Không có ngữ cảnh thì rơi về bot 1 — đây là
// đường tương thích cho mọi lối gọi cũ và cho bản triển khai một token.
function currentClient() {
    const runtime = getCurrentBot();
    if (!runtime || !runtime.client) {
        throw new Error("Không xác định được bot nào để gửi tin nhắn");
    }
    return runtime.client;
}

async function sendMessage(chatId, text, options = {}) {
    // Chia tin dài theo dòng để tránh vượt giới hạn tin nhắn của Zalo.
    const {
        continuationHeader = "",
        parse_mode = "markdown",
        ...otherOptions
    } = options;
    const messageOptions = { ...otherOptions, parse_mode };
    const maxLength = 750;
    const chunks = [];
    let current = "";

    const blocks = String(text).split(/(?<=\n\n)/);
    for (const block of blocks) {
        if (current && (current + block).length > maxLength) {
            chunks.push(current.trim());
            current = "";
        }

        if (block.length <= maxLength) {
            current += block;
        } else {
            for (const line of block.split("\n")) {
                const next = current ? `${current}\n${line}` : line;
                if (next.length <= maxLength) {
                    current = next;
                } else {
                    if (current.trim()) chunks.push(current.trim());
                    current = line;
                }
            }
        }
    }
    if (current.trim()) chunks.push(current.trim());
    for (let index = 0; index < chunks.length; index += 1) {
        const prefix = index > 0 && continuationHeader ? `${continuationHeader}\n\n` : "";
        const payload = `${prefix}${chunks[index]}`;
        const commandContext = dashboardCommandContext.getStore();
        if (commandContext && String(commandContext.chatId) === String(chatId)) {
            commandContext.messages.push({ chatId: String(chatId), text: payload });
        }
        try {
            await Promise.resolve(currentClient().sendMessage(chatId, payload, messageOptions));
        } catch (error) {
            const permanentChatError = Number(error?.response?.statusCode || error?.statusCode || 0) === 410 || /410\s+The chat_id is invalid/i.test(String(error?.message || ""));
            if (messageOptions.parse_mode && !permanentChatError) {
                console.warn(`Lỗi gửi markdown Zalo (${error.message}), đang gửi lại dạng plain text...`);
                const plainPayload = payload
                    .replace(/\{(?:green|red|orange|blue)\}(.*?)\{\/(?:green|red|orange|blue)\}/g, "$1")
                    .replace(/^#+\s+/gm, "")
                    .replace(/\\([\\*_~`>])/g, "$1");
                const fallbackOptions = { ...otherOptions };
                delete fallbackOptions.parse_mode;
                await Promise.resolve(currentClient().sendMessage(chatId, plainPayload, fallbackOptions));
            } else {
                throw error;
            }
        }
    }
}

function getCommandArgument(match) {
    return (match?.[1] || "").trim();
}

function asyncCommand(handler) {
    return (msg, match) => {
        Promise.resolve(handler(msg, match)).catch((error) => {
            console.error("Lỗi xử lý lệnh:", error);
            logDiscord("ERROR", `command_error: ${error.message}`);
        });
    };
}

function parseCommand(rawText) {
    if (!rawText || typeof rawText !== "string") return null;

    // Xóa bot mention dạng /cmd@Bot MrYukitoBoBo hoặc /cmd@botname -> /cmd
    let clean = rawText
        .replace(/(\/\w+)@Bot\b(?:[ \t]+[\w\d_]+)*/gi, "$1")
        .replace(/(\/\w+)@[\w\d_]+/gi, "$1")
        .replace(/@Bot\b(?:[ \t]+[\w\d_]+)*/gi, "")
        .replace(/@[\w\d_]+/gi, "")
        .trim();

    if (!clean.startsWith("/")) return null;

    const match = clean.match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
    if (!match) return null;

    // Bí danh được quy về tên chính tắc ngay tại đây, nên toàn bộ phần xử lý
    // phía sau chỉ cần so sánh với một tên duy nhất cho mỗi lệnh.
    const command = resolveCommandName(match[1]);
    const argument = (match[2] || "").trim();

    return { command, argument };
}

function isOwner(context) {
    const configured = getConfiguredAdminIds();
    if (configured.userIds.length === 0 && configured.chatIds.length === 0) return false;
    // Khi chạy từ dashboard, quyền hạn luôn xét theo admin đang đăng nhập —
    // không bao giờ theo userId do trình duyệt gửi lên hay theo người được
    // chọn làm đích. Nhờ vậy Command console có thể chạy lệnh với ngữ cảnh của
    // người nhận mà vẫn giữ nguyên kiểm tra quyền.
    const actor = dashboardCommandContext.getStore()?.actor;
    if (actor) return isConfiguredAdmin({ userId: actor.userId, chatId: actor.chatId });
    return isConfiguredAdmin(context);
}

async function sendUserError(chatId, error, operation = "command") {
    console.error(`Lỗi ${operation}:`, error);
    logDiscord("ERROR", `${operation}_error: ${error?.message || error}`);
    await sendMessage(chatId, formatErrorMessage(error));
}

async function requireOwner(context) {
    if (isOwner(context)) return true;
    await sendMessage(context.chatId, formatWarningMessage("KHÔNG CÓ QUYỀN", "> Bạn không có quyền thực hiện lệnh này."));
    return false;
}

function parseQuestionIdAndText(argument) {
    const match = String(argument || "").match(/^#?(\d+)(?:\s*\|\s*|\s+)([\s\S]+)$/);
    return match ? { id: Number(match[1]), text: match[2].trim() } : null;
}

function resolveQuestionYear(argument, date = new Date()) {
    const value = String(argument || "").trim();
    if (/^\d{4}$/.test(value)) return Number(value);
    return Number(getVietnamDateInfo(date).year);
}

function getBroadcastTargets(feature = "broadcast") {
    const targets = new Map();
    for (const target of getInteractionTargets()) {
        upsertChat({
            chatId: target.chatId,
            chatType: target.chatType,
            displayName: target.chatTitle || target.lastUserDisplayName,
            userId: target.lastUserId,
            chatTitle: target.chatTitle,
            lastInboundInteractionAt: target.lastInteractionAt,
            firstInteractionAt: target.firstInteractionAt
        });
        targets.set(String(target.chatId), target);
    }
    // Giữ tương thích với dữ liệu có trước khi sổ tương tác được bổ sung.
    for (const [subscriptionKey, subscription] of Object.entries(getAllSubscriptions())) {
        // Schema cũ dùng trực tiếp chatId làm khóa; schema mới có trường chatId rõ ràng.
        const legacyChatId = !subscriptionKey.includes("::") ? subscriptionKey : null;
        const rawChatId = subscription?.chatId ?? legacyChatId;
        if (rawChatId == null) continue;
        const chatId = String(rawChatId);
        upsertChat({ chatId, chatType: subscription.chatType || "unknown", displayName: subscription.chatTitle || subscription.userDisplayName || "" });
        if (!targets.has(chatId)) targets.set(chatId, { chatId, chatType: "unknown" });
    }
    return [...targets.values()].filter((target) => isChatEligible(target.chatId, feature));
}

// Gửi thông báo tới mọi chat đủ điều kiện. Dùng chung cho /thongbao (thông báo
// chung) và /update (thông báo cập nhật): cùng cách chọn đích, cùng kiểm tra
// điều kiện nhận, cùng bảng tổng kết gửi/lỗi. Chỉ khác nhãn ghi log.
async function sendBotAnnouncement(message, options = {}) {
    const { operation = "announcement", logLabel = "thông báo chung" } = options;
    const targets = getBroadcastTargets();
    const result = { targets: targets.length, sent: 0, failed: 0 };
    for (const target of targets) {
        try {
            const delivery = await sendNotification(target.chatId, message, { feature: "broadcast", operation });
            if (delivery.sent) result.sent += 1;
            else if (delivery.failed) {
                result.failed += 1;
                logDiscord("ERROR", `Không thể gửi ${logLabel} cho chat ${target.chatId}: ${delivery.error.message}`);
            }
        } catch (error) {
            result.failed += 1;
            logDiscord("ERROR", `Không thể gửi ${logLabel} cho chat ${target.chatId}: ${error.message}`);
        }
    }
    return result;
}

function formatBroadcastSummary(title, result) {
    return `# {green}✓ ${title}{/green}\n\n` +
        `> **Tổng cuộc trò chuyện:** ${result.targets}\n` +
        `> **Gửi thành công:** ${result.sent}\n` +
        `> **Gửi lỗi:** ${result.failed}`;
}


async function sendWelcomeMessage(chatId, displayName = "bạn") {
    await sendMessage(chatId, formatWelcomeMessage(displayName));
}

// Ngày đích do người dùng chọn: homnay = hôm nay, homsau = hôm sau.
// Bỏ dấu và mọi ký tự không phải chữ nên "hôm nay", "hom nay", "HOMNAY" đều
// nhận được, nhưng vẫn chỉ có đúng hai giá trị hợp lệ.
function normalizeTargetDayToken(value) {
    const compact = String(value == null ? "" : value)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .toLowerCase()
        .replace(/[^a-z]/g, "");
    if (compact === "homnay") return TARGET_DAY_TODAY;
    if (compact === "homsau") return TARGET_DAY_TOMORROW;
    return null;
}

// ID bản ghi: số nguyên dương. Dạng chính tắc khi hiển thị là "ID 1"; tiền tố
// '#' cũ vẫn được chấp nhận khi nhập để không phá thói quen cũ. Từ chối 0, số
// âm, số thập phân và chuỗi không phải số.
function parseRecordId(value) {
    const match = String(value == null ? "" : value).trim().match(/^#?(\d+)$/);
    if (!match) return null;
    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id >= 1 ? id : null;
}

// Lấy ngày đích ở cuối danh sách token. Chấp nhận một token ("homnay") hoặc
// hai token khi người dùng gõ đúng chính tả có dấu ("hôm nay").
function takeDayToken(tokens) {
    const single = normalizeTargetDayToken(tokens[tokens.length - 1]);
    if (single != null) return { offset: single, length: 1 };
    if (tokens.length >= 2) {
        const pair = normalizeTargetDayToken(tokens.slice(-2).join(""));
        if (pair != null) return { offset: pair, length: 2 };
    }
    return { offset: null, length: 0 };
}

// Cú pháp thống nhất: /nhanlich [MSSV] hh:mm homnay|homsau
// MSSV đứng trước, giờ ở giữa, ngày đích ở cuối. Thiếu ngày đích thì báo lỗi
// chứ KHÔNG suy đoán, để không âm thầm gửi sai ngày.
function parseNhanLichArgument(argument, savedStudentId) {
    const raw = String(argument || "").trim();
    if (!raw) return { error: "empty" };

    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return { error: "day" };

    // Ngày đích có thể là một token ("homnay") hoặc hai token khi người dùng gõ
    // đúng chính tả có dấu ("hôm nay").
    const dayToken = takeDayToken(parts);
    if (dayToken.offset == null) return { error: "day" };

    const timeIndex = parts.length - dayToken.length - 1;
    if (timeIndex < 0) return { error: "day" };

    const studentTokens = parts.slice(0, timeIndex);
    if (studentTokens.length > 1) return { error: "syntax" };

    const notificationTime = normalizeNotificationTime(parts[timeIndex], null);
    if (!notificationTime) return { error: "time" };

    let studentId = normalizeStudentId(savedStudentId);
    if (studentTokens.length === 1) {
        studentId = normalizeStudentId(studentTokens[0]);
        if (!studentId) return { error: "student" };
    }
    if (!studentId) return { error: "student" };

    return { studentId, notificationTime, targetDayOffset: dayToken.offset };
}

// Cú pháp: /suagionhanlich ID hh:mm homnay|homsau
// hoặc     /suagionhanlich ID homnay|homsau   (chỉ đổi ngày đích)
// "ID" là số nguyên dương; "#1" cũ vẫn nhận được.
function parseSuaGioNhanLichArgument(argument) {
    const match = String(argument || "").trim().match(/^(#?\d+)\s+([\s\S]+)$/);
    if (!match) return { error: "syntax" };

    const id = parseRecordId(match[1]);
    if (id == null) return { error: "id" };

    const rest = match[2].trim().split(/\s+/).filter(Boolean);
    if (rest.length === 0) return { error: "syntax" };

    const dayToken = takeDayToken(rest);
    if (dayToken.offset == null) return { error: "day" };

    const beforeDay = rest.slice(0, rest.length - dayToken.length);
    if (beforeDay.length === 0) return { id, notificationTime: null, targetDayOffset: dayToken.offset };
    if (beforeDay.length > 1) return { error: "syntax" };

    const notificationTime = normalizeNotificationTime(beforeDay[0], null);
    if (!notificationTime) return { error: "time" };
    return { id, notificationTime, targetDayOffset: dayToken.offset };
}

// Dùng cho gợi ý khi người dùng gõ sai lệnh. Khóa là TÊN CHÍNH TẮC; tên cũ
// được quy về đây qua resolveCommandName() nên gợi ý luôn hướng người dùng sang
// tên mới.
const COMMAND_EXAMPLES = {
    start: "/start",
    luumssv: "/luumssv 123456789",
    nhanlich: "/nhanlich 06:30 homnay",
    gionhanlich: "/gionhanlich",
    suagionhanlich: "/suagionhanlich 1 06:30 homnay",
    xoagionhanlich: "/xoagionhanlich 1",
    lich: "/lich 123456789",
    lichtuan: "/lichtuan 123456789",
    lichthi: "/lichthi 123456789",
    lichgv: "/lichgv Nguyễn Văn A",
    phongtrong: "/phongtrong 1",
    ai: "/ai Hôm nay tôi học môn gì?",
    batnhaclich: "/batnhaclich",
    tatnhaclich: "/tatnhaclich",
    trangthainhaclich: "/trangthainhaclich",
    tatnhanlich: "/tatnhanlich",
    myid: "/myid",
    help: "/help",
    helpadmin: "/helpadmin",
    time: "/time",
    thongbao: "/thongbao Hệ thống sẽ bảo trì lúc 22:00",
    update: "/update Đã bổ sung tuỳ chọn ngày nhận lịch",
    blockbot: "/blockbot 123456",
    unblockbot: "/unblockbot 123456",
    blockai: "/blockai 123456",
    unblockai: "/unblockai 123456",
    allowbot: "/allowbot 123456",
    unallowbot: "/unallowbot 123456",
    allowai: "/allowai 123456",
    unallowai: "/unallowai 123456",
    accessmode: "/accessmode bot allowlist",
    accesslist: "/accesslist",
    quanlychat: "/quanlychat inactive 1",
    chitietchat: "/chitietchat 123456",
    tamdungchat: "/tamdungchat 123456",
    batlaichat: "/batlaichat 123456",
    kiemtrachat: "/kiemtrachat 123456",
    xoachat: "/xoachat 123456",
    chatfeature: "/chatfeature 123456 schedule off",
    test6h: "/test6h"
};

function editDistance(left, right) {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = [leftIndex];
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
            current[rightIndex] = Math.min(
                current[rightIndex - 1] + 1,
                previous[rightIndex] + 1,
                previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
            );
        }
        previous.splice(0, previous.length, ...current);
    }
    return previous[right.length];
}

function suggestCommandCorrection(command) {
    const compact = String(command || "").toLowerCase();
    const knownCommands = Object.keys(COMMAND_EXAMPLES).sort((a, b) => b.length - a.length);
    for (const known of knownCommands) {
        if (!compact.startsWith(known) || compact === known) continue;
        const suffix = compact.slice(known.length);
        // Gợi ý kèm sẵn phần ngày đích để người dùng biết phải chọn, nhưng
        // không tự đoán hôm nay hay hôm sau.
        if (known === "nhanlich" && /^([01]\d|2[0-3])([0-5]\d)$/.test(suffix)) {
            return `/nhanlich ${suffix.slice(0, 2)}:${suffix.slice(2)} homnay|homsau`;
        }
        return `/${known} ${suffix}`;
    }
    const nearest = knownCommands
        .map((known) => ({ known, distance: editDistance(compact, known) }))
        .sort((a, b) => a.distance - b.distance || a.known.localeCompare(b.known))[0];
    return nearest && nearest.distance <= 2 && compact.length >= 4
        ? COMMAND_EXAMPLES[nearest.known]
        : "/help";
}

// Nhãn ngày đích dùng thống nhất ở chat, dashboard và thông báo.
function formatTargetDay(targetDayOffset) {
    return Number(targetDayOffset) === TARGET_DAY_TOMORROW ? "homsau" : "homnay";
}

function formatTargetDayLabel(targetDayOffset) {
    return Number(targetDayOffset) === TARGET_DAY_TOMORROW ? "lịch hôm sau" : "lịch hôm nay";
}

function formatNotificationTimes(subscription) {
    const times = normalizeNotificationTimes(subscription);
    if (!times.length) return "> Chưa có giờ nhận lịch.";
    return times
        .map((item) => `- **ID ${item.id}** — \`${item.time}\` · **${formatTargetDay(item.targetDayOffset)}** (${formatTargetDayLabel(item.targetDayOffset)})`)
        .join("\n");
}

function formatChatTime(value) {
    if (!value) return "-";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("vi-VN", { timeZone: TIME_ZONE });
}

function formatChatDirectoryList(argument = "") {
    const [rawFilter = "all", rawPage = "1"] = String(argument || "").trim().split(/\s+/).filter(Boolean);
    const filter = rawFilter.toLowerCase();
    const page = Math.max(1, Number(rawPage) || 1);
    const allowed = new Set(["all", "active", "inactive", "disabled", "removed", "private", "group", "unknown"]);
    if (!allowed.has(filter)) return null;
    const all = getAllChats().filter((chat) => filter === "all" || chat.status === filter || chat.chatType === filter);
    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
    const currentPage = Math.min(page, totalPages);
    const rows = all.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((chat) => {
        const name = chat.displayName || "Không rõ tên";
        const lastError = chat.lastError ? `${chat.lastError.status || chat.lastError.code || "ERR"}: ${chat.lastError.message}` : "-";
        return `- **${escapeMarkdown(name)}** · \`${escapeMarkdown(chat.chatId)}\`\n  ${escapeMarkdown(chat.chatType)} · **${escapeMarkdown(chat.status)}** · Thành công: ${escapeMarkdown(formatChatTime(chat.lastSuccessfulDeliveryAt))}\n  Lỗi cuối: ${escapeMarkdown(lastError.slice(0, 140))}`;
    });
    return `# {orange}[ADMIN] QUẢN LÝ CHAT{/orange}\n\n> **Bộ lọc:** ${escapeMarkdown(filter)} · **Trang:** ${currentPage}/${totalPages} · **Tổng:** ${all.length}\n\n${rows.join("\n\n") || "> _Không có chat phù hợp._"}`;
}

function formatChatDetails(record) {
    if (!record) return null;
    const overrides = Object.entries(record.notificationOverrides || {}).map(([feature, value]) => `${feature}=${value == null ? "auto" : value ? "on" : "off"}`).join(", ");
    const error = record.lastError;
    return `# {orange}[ADMIN] CHI TIẾT CHAT{/orange}\n\n` +
        `> **Chat ID:** \`${escapeMarkdown(record.chatId)}\`\n` +
        `> **Loại:** ${escapeMarkdown(record.chatType || "unknown")}\n` +
        `> **Tên:** ${escapeMarkdown(record.displayName || "Không rõ")}\n` +
        `> **Trạng thái:** **${escapeMarkdown(record.status || "active")}**\n` +
        `> **Lý do:** ${escapeMarkdown(record.statusReason || "-")}\n` +
        `> **Tính năng:** ${escapeMarkdown(overrides || "auto")}\n` +
        `> **Tương tác cuối:** ${escapeMarkdown(formatChatTime(record.lastInboundInteractionAt || record.lastInteractionAt))}\n` +
        `> **Gửi thành công cuối:** ${escapeMarkdown(formatChatTime(record.lastSuccessfulDeliveryAt))}\n` +
        `> **Lỗi liên tiếp:** ${Number(record.consecutiveFailureCount) || 0}\n` +
        `> **Lỗi cuối:** ${escapeMarkdown(error ? `${error.status || error.code || "ERR"} ${error.message}` : "-")}\n` +
        `> **Thời điểm lỗi:** ${escapeMarkdown(formatChatTime(error?.at))}`;
}

function syncChatDirectoryFromLegacyStores() {
    const syncedChatIds = new Set();
    for (const target of getInteractionTargets()) {
        upsertChat({
            chatId: target.chatId,
            chatType: target.chatType,
            displayName: target.chatTitle || target.lastUserDisplayName,
            userId: target.lastUserId,
            chatTitle: target.chatTitle,
            firstInteractionAt: target.firstInteractionAt,
            lastInboundInteractionAt: target.lastInteractionAt
        });
        syncedChatIds.add(String(target.chatId));
    }
    for (const [key, subscription] of Object.entries(getAllSubscriptions())) {
        const legacyChatId = !key.includes("::") ? key : null;
        const chatId = subscription?.chatId ?? legacyChatId;
        if (chatId != null) {
            upsertChat({ chatId, chatType: subscription.chatType || "unknown", displayName: subscription.chatTitle || subscription.userDisplayName || "" });
            syncedChatIds.add(String(chatId));
        }
    }
    return syncedChatIds.size;
}

async function handleCommand(msg, parsedCommand) {
    const context = getMessageContext(msg);
    const chatId = context.chatId;
    const { command, argument } = parsedCommand;

    if (command === "start") {
        await sendWelcomeMessage(chatId, msg.from?.display_name);
    } else if (command === "luumssv") {
        const studentId = normalizeStudentId(argument);
        if (!studentId) {
            await sendMessage(chatId, formatWarningMessage(
                "SAI CÚ PHÁP",
                "> **Cú pháp:** /luumssv [MSSV]\n> **Ví dụ:** /luumssv 123456789"
            ));
            return;
        }

        try {
            const data = await fetchStudentSchedule(studentId);
            const subscription = saveStudent(context, {
                studentId,
                studentName: data.studentName
            });

            await sendMessage(
                chatId,
                formatStudentSavedMessage(data, subscription)
            );
        } catch (error) {
            await sendUserError(chatId, error, "luumssv");
        }
    } else if (command === "nhanlich") {
        const saved = getSubscription(context);
        const parsedRegistration = parseNhanLichArgument(argument, saved?.studentId);

        if (parsedRegistration.error) {
            // Lỗi thiếu ngày đích là lỗi hay gặp nhất nên được giải thích riêng,
            // kèm cả hai ví dụ để người dùng chọn đúng.
            const body = parsedRegistration.error === "day"
                ? "> **Cú pháp:** /nhanlich [MSSV] hh:mm homnay|homsau\n" +
                  "> **Ví dụ:** /nhanlich 06:30 homnay\n" +
                  "> **Ví dụ:** /nhanlich 20:00 homsau\n" +
                  "> **Ví dụ:** /nhanlich 123000xxx 06:30 homnay\n" +
                  "> **homnay** = gửi lịch hôm nay, **homsau** = gửi lịch hôm sau. Bắt buộc phải chọn một trong hai."
                : "> **Cú pháp:** /nhanlich [MSSV] hh:mm homnay|homsau\n" +
                  "> **Ví dụ:** /nhanlich 06:30 homnay\n" +
                  "> **Ví dụ:** /nhanlich 20:00 homsau\n" +
                  "> Giờ hợp lệ từ **00:00** đến **23:59**.";
            await sendMessage(chatId, parsedRegistration.error === "student"
                ? formatMissingStudentIdMessage("nhanlich")
                : formatWarningMessage("SAI CÚ PHÁP", body));
            return;
        }

        const { studentId, notificationTime, targetDayOffset } = parsedRegistration;

        try {
            const data = await fetchStudentSchedule(studentId);
            const wasAlreadyWatched = Object.values(getEnabledSubscriptions())
                .some((subscription) => subscription.studentId === studentId);
            enableNotifications(context, {
                studentId,
                studentName: data.studentName,
                notificationTime,
                targetDayOffset
            });
            const updatedSubscription = getSubscription(context);
            const notificationTimes = normalizeNotificationTimes(updatedSubscription);
            initializeScheduleSnapshot(data, new Date(), !wasAlreadyWatched);
            await sendMessage(
                chatId,
                formatDailyNotificationEnabled(data, notificationTimes)
            );
        } catch (error) {
            await sendUserError(chatId, error, "daily_subscription");
        }
    } else if (command === "gionhanlich") {
        const saved = getSubscription(context);
        const times = normalizeNotificationTimes(saved);
        await sendMessage(chatId, times.length
            ? `# {green}[GIỜ NHẬN LỊCH]{/green}\n\n${formatNotificationTimes(saved)}`
            : formatWarningMessage("CHƯA CÓ GIỜ NHẬN LỊCH", "> Dùng **/nhanlich [MSSV] hh:mm homnay|homsau** để thêm giờ nhận lịch."));
    } else if (command === "suagionhanlich") {
        const saved = getSubscription(context);
        const parsed = parseSuaGioNhanLichArgument(argument);
        if (!saved || parsed.error) {
            const body = parsed.error === "day"
                ? "> **Cú pháp:** /suagionhanlich ID hh:mm homnay|homsau\n" +
                  "> **Ví dụ:** /suagionhanlich 1 06:30 homnay\n" +
                  "> **Ví dụ:** /suagionhanlich 2 21:00 homsau\n" +
                  "> Chỉ muốn đổi ngày đích: /suagionhanlich 2 homsau\n" +
                  "> **homnay** = lịch hôm nay, **homsau** = lịch hôm sau. Bắt buộc phải chọn một trong hai."
                : parsed.error === "id"
                    ? "> **Cú pháp:** /suagionhanlich ID hh:mm homnay|homsau\n" +
                      "> **Ví dụ:** /suagionhanlich 1 06:30 homnay\n" +
                      "> ID là số nguyên dương (1, 2, 3, …). Dùng **/gionhanlich** để xem ID."
                    : "> **Cú pháp:** /suagionhanlich ID hh:mm homnay|homsau\n" +
                      "> **Ví dụ:** /suagionhanlich 1 06:30 homnay\n" +
                      "> **Ví dụ:** /suagionhanlich 2 homsau\n" +
                      "> Dùng **/gionhanlich** để xem ID.";
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", body));
            return;
        }
        const updated = updateNotificationTime(context, parsed.id, parsed.notificationTime, parsed.targetDayOffset);
        await sendMessage(
            chatId,
            updated
                ? formatSuccessMessage("ĐÃ CẬP NHẬT GIỜ NHẬN LỊCH", formatNotificationTimes(updated))
                : formatWarningMessage("KHÔNG THỂ SỬA", `> Không có ID **${parsed.id}**, hoặc đã có mốc khác cùng giờ và cùng ngày đích.`)
        );
    } else if (command === "xoagionhanlich") {
        const parsedId = parseRecordId(argument);
        if (parsedId == null) {
            await sendMessage(chatId, formatWarningMessage(
                "SAI CÚ PHÁP",
                "> **Cú pháp:** /xoagionhanlich ID\n> **Ví dụ:** /xoagionhanlich 1\n> ID là số nguyên dương. Dùng **/gionhanlich** để xem ID."
            ));
            return;
        }
        const removed = removeNotificationTime(context, parsedId);
        await sendMessage(
            chatId,
            removed
                ? formatSuccessMessage(`ĐÃ XÓA GIỜ ${removed.removed.time} (${formatTargetDay(removed.removed.targetDayOffset)})`, formatNotificationTimes(removed.subscription))
                : formatWarningMessage("KHÔNG TÌM THẤY", `> Không có giờ nhận lịch **ID ${parsedId}**.`)
        );
    } else if (command === "lich") {
        const saved = getSubscription(context);
        const studentId = resolveStudentIdForCommand(argument, saved?.studentId);

        if (!studentId) {
            await sendMessage(chatId, argument
                ? formatWarningMessage("MSSV KHÔNG HỢP LỆ", "> MSSV phải gồm đúng **9 chữ số**.")
                : formatMissingStudentIdMessage("lich"));
            return;
        }

        try {
            const data = await fetchStudentSchedule(studentId);
            await sendMessage(chatId, formatDailySchedule(data));
        } catch (error) {
            await sendUserError(chatId, error, "daily_schedule");
        }
    } else if (command === "lichtuan") {
        const saved = getSubscription(context);
        const studentId = resolveStudentIdForCommand(argument, saved?.studentId);

        if (!studentId) {
            await sendMessage(chatId, argument
                ? formatWarningMessage("MSSV KHÔNG HỢP LỆ", "> MSSV phải gồm đúng **9 chữ số**.")
                : formatMissingStudentIdMessage("lichtuan"));
            return;
        }

        try {
            const data = await fetchStudentSchedule(studentId);
            await sendMessage(chatId, formatWeeklySchedule(data));
        } catch (error) {
            await sendUserError(chatId, error, "weekly_schedule");
        }
    } else if (command === "tatnhanlich") {
        if (disableNotifications(context)) {
            await sendMessage(
                chatId,
                formatSuccessMessage(
                    "ĐÃ TẮT THÔNG BÁO LỊCH",
                    "> MSSV đã lưu vẫn dùng được với **/lich** và **/lichtuan**."
                )
            );
        } else {
            await sendMessage(
                chatId,
                formatWarningMessage(
                    "CHƯA ĐĂNG KÝ THÔNG BÁO",
                    "> Dùng **/nhanlich** để bật thông báo lịch học."
                )
            );
        }
    } else if (command === "batnhaclich") {
        const saved = getSubscription(context);
        if (!saved?.studentId) {
            await sendMessage(chatId, formatMissingStudentIdMessage("batnhaclich"));
            return;
        }
        const updated = enableClassStartNotifications(context);
        await sendMessage(chatId, formatClassStartEnabled(updated || saved));
    } else if (command === "tatnhaclich") {
        if (disableClassStartNotifications(context)) {
            await sendMessage(chatId, formatSuccessMessage("ĐÃ TẮT NHẮC GIỜ HỌC"));
        } else {
            await sendMessage(chatId, formatWarningMessage("NHẮC GIỜ HỌC ĐANG TẮT", "> Dùng **/batnhaclich** để bật."));
        }
    } else if (command === "trangthainhaclich") {
        const saved = getSubscription(context);
        if (!saved?.studentId) {
            await sendMessage(chatId, formatMissingStudentIdMessage("trangthainhaclich"));
            return;
        }
        await sendMessage(chatId, formatClassStartStatus(saved));
    } else if (command === "lichthi") {
        const saved = getSubscription(context);
        const studentId = resolveStudentIdForCommand(argument, saved?.studentId);

        if (!studentId) {
            await sendMessage(chatId, argument
                ? formatWarningMessage("MSSV KHÔNG HỢP LỆ", "> MSSV phải gồm đúng **9 chữ số**.")
                : formatMissingStudentIdMessage("lichthi"));
            return;
        }

        try {
            const data = await fetchExamSchedule(studentId);
            await sendMessage(chatId, formatExamSchedule(data));
        } catch (error) {
            await sendUserError(chatId, error, "exam_schedule");
        }
    } else if (command === "lichgv") {
        if (!argument) {
            await sendMessage(
                chatId,
                formatWarningMessage(
                    "SAI CÚ PHÁP",
                    "> **Cú pháp:** /lichgv [Tên giảng viên]\n> **Ví dụ:** /lichgv Nguyễn Minh Phúc"
                )
            );
            return;
        }

        try {
            const teachers = await searchTeacherByName(argument);
            if (teachers.length === 0) {
                await sendMessage(
                    chatId,
                    formatWarningMessage(
                        "KHÔNG TÌM THẤY GIẢNG VIÊN",
                        "> Không tìm thấy giảng viên phù hợp với tên bạn nhập."
                    )
                );
                return;
            }

            const selected = teachers[0];
            const scheduleData = await fetchTeacherSchedule(selected.teacherId);
            scheduleData.teacherName = selected.fullName;
            await sendMessage(chatId, formatTeacherSchedule(scheduleData));
        } catch (error) {
            await sendUserError(chatId, error, "teacher_schedule");
        }
    } else if (command === "phongtrong") {
        const campus = argument || "Cơ sở I";
        const saved = getSubscription(context);
        let scheduleData = null;
        if (saved?.studentId) {
            try {
                scheduleData = await fetchStudentSchedule(saved.studentId);
            } catch (_) { }
        }
        await sendMessage(chatId, findEmptyRooms(campus, scheduleData));
    } else if (command === "ai") {
        const aiCheck = canUseAi(context);
        if (!isOwner(context) && !aiCheck.allowed) {
            await sendMessage(
                chatId,
                formatWarningMessage(
                    "QUYỀN TRUY CẬP AI BỊ HẠN CHẾ",
                    "> Tài khoản hoặc nhóm này hiện không có quyền sử dụng lệnh **/ai**."
                )
            );
            return;
        }

        if (!argument) {
            await sendMessage(
                chatId,
                formatWarningMessage(
                    "SAI CÚ PHÁP LỆNH AI",
                    "> **Cú pháp:** /ai [câu hỏi]\n> **Ví dụ:** /ai Trong 2 tuần tới tớ rảnh những ngày nào?"
                )
            );
            return;
        }

        const saved = getSubscription(context);
        if (!saved?.studentId) {
            await sendMessage(chatId, formatMissingStudentIdMessage("ai"));
            return;
        }

        try {
            const scheduleData = await fetchStudentSchedule(saved.studentId);
            await sendMessage(chatId, "# {green}[TRỢ LÝ LỊCH HỌC]{/green}\n\n_Đang phân tích lịch học..._");
            const answerText = await askScheduleAi(argument, scheduleData);
            await sendMessage(chatId, `# {green}[TRỢ LÝ LỊCH HỌC] CÂU TRẢ LỜI{/green}\n\n${sanitizeExternalRichText(answerText)}`);
        } catch (error) {
            await sendUserError(chatId, error, "ai_schedule");
        }
    } else if (command === "blockbot") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /blockbot [User ID / Group ID / Tên]"));
            return;
        }
        const result = blockTarget("bot", argument);
        await sendMessage(
            chatId,
            result
                ? `# {orange}[BLOCK BOT] ĐÃ CHẶN THÀNH CÔNG{/orange}\n\n> **Đối tượng:** ${escapeMarkdown(result.targetName)} (${escapeMarkdown(result.targetId)})\n> **Loại:** ${escapeMarkdown(result.targetType)}`
                : formatWarningMessage("KHÔNG THỂ CHẶN", "> Không tìm thấy ID/Tên phù hợp.")
        );
    } else if (command === "unblockbot") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /unblockbot [User ID / Group ID / Tên]"));
            return;
        }
        const result = unblockTarget("bot", argument);
        await sendMessage(
            chatId,
            result
                ? `# {green}[UNBLOCK BOT] ĐÃ BỎ CHẶN{/green}\n\n> **Đối tượng:** ${escapeMarkdown(result.targetName)} (${escapeMarkdown(result.targetId)})`
                : formatWarningMessage("KHÔNG TÌM THẤY", "> Đối tượng không nằm trong danh sách bị chặn.")
        );
    } else if (command === "blockai") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /blockai [User ID / Group ID / Tên]"));
            return;
        }
        const result = blockTarget("ai", argument);
        await sendMessage(
            chatId,
            result
                ? `# {orange}[BLOCK AI] ĐÃ CHẶN QUYỀN AI{/orange}\n\n> **Đối tượng:** ${escapeMarkdown(result.targetName)} (${escapeMarkdown(result.targetId)})`
                : formatWarningMessage("KHÔNG THỂ CHẶN", "> Không tìm thấy ID/Tên phù hợp.")
        );
    } else if (command === "unblockai") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /unblockai [User ID / Group ID / Tên]"));
            return;
        }
        const result = unblockTarget("ai", argument);
        await sendMessage(
            chatId,
            result
                ? `# {green}[UNBLOCK AI] ĐÃ MỞ LẠI QUYỀN AI{/green}\n\n> **Đối tượng:** ${escapeMarkdown(result.targetName)} (${escapeMarkdown(result.targetId)})`
                : formatWarningMessage("KHÔNG TÌM THẤY", "> Đối tượng không nằm trong danh sách chặn AI.")
        );
    } else if (command === "allowbot") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /allowbot [User ID / Group ID / Tên]"));
            return;
        }
        const result = allowTarget("bot", argument);
        await sendMessage(chatId, `# {green}[ALLOW BOT] ĐÃ THÊM VÀO ALLOWLIST{/green}\n\n> **Đối tượng:** ${escapeMarkdown(result.targetName)} (${escapeMarkdown(result.targetId)})`);
    } else if (command === "unallowbot") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /unallowbot [User ID / Group ID / Tên]"));
            return;
        }
        const result = unallowTarget("bot", argument);
        await sendMessage(chatId, `# {orange}[UNALLOW BOT] ĐÃ XÓA KHỎI ALLOWLIST{/orange}\n\n> **Đối tượng:** ${escapeMarkdown(result.targetName)} (${escapeMarkdown(result.targetId)})`);
    } else if (command === "allowai") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /allowai [User ID / Group ID / Tên]"));
            return;
        }
        const result = allowTarget("ai", argument);
        await sendMessage(chatId, `# {green}[ALLOW AI] ĐÃ THÊM VÀO AI ALLOWLIST{/green}\n\n> **Đối tượng:** ${escapeMarkdown(result.targetName)} (${escapeMarkdown(result.targetId)})`);
    } else if (command === "unallowai") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /unallowai [User ID / Group ID / Tên]"));
            return;
        }
        const result = unallowTarget("ai", argument);
        await sendMessage(chatId, `# {orange}[UNALLOW AI] ĐÃ XÓA KHỎI AI ALLOWLIST{/orange}\n\n> **Đối tượng:** ${escapeMarkdown(result.targetName)} (${escapeMarkdown(result.targetId)})`);
    } else if (command === "accessmode") {
        if (!await requireOwner(context)) return;
        const [type, mode] = argument.split(/\s+/);
        if (!type || !mode || !["bot", "ai"].includes(type.toLowerCase()) || !["all", "allowlist"].includes(mode.toLowerCase())) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /accessmode [bot|ai] [all|allowlist]"));
            return;
        }
        setAccessMode(type.toLowerCase(), mode.toLowerCase());
        await sendMessage(chatId, `# {green}[ACCESS MODE] ĐÃ CẬP NHẬT{/green}\n\n> **Chế độ ${type.toUpperCase()}:** ${mode.toUpperCase()}`);
    } else if (command === "accesslist") {
        if (!await requireOwner(context)) return;
        const summary = getAccessSummary();
        const formatSection = (title, items) => {
            if (!items.length) return `> _Trống_`;
            return items.map((i) => `- **${escapeMarkdown(i.targetName || i.targetId)}** (ID: \`${escapeMarkdown(i.targetId)}\` · ${escapeMarkdown(i.targetType || "user")})`).join("\n");
        };

        const msgContent = [
            `# {orange}[ADMIN] DANH SÁCH QUẢN TRỊ TRUY CẬP{/orange}`,
            `> **Bot Mode:** \`${summary.botMode}\`  •  **AI Mode:** \`${summary.aiMode}\``,
            `## {orange}[CHẶN BOT] ${summary.botBlocked.length}{/orange}\n${formatSection("Chặn Bot", summary.botBlocked)}`,
            `## {orange}[CHẶN AI] ${summary.aiBlocked.length}{/orange}\n${formatSection("Chặn AI", summary.aiBlocked)}`,
            `## {green}[ALLOWLIST BOT] ${summary.botAllowlist.length}{/green}\n${formatSection("Allowlist Bot", summary.botAllowlist)}`,
            `## {green}[ALLOWLIST AI] ${summary.aiAllowlist.length}{/green}\n${formatSection("Allowlist AI", summary.aiAllowlist)}`
        ].join("\n\n");

        await sendMessage(chatId, msgContent);
    } else if (command === "quanlychat") {
        if (!await requireOwner(context)) return;
        const content = formatChatDirectoryList(argument);
        if (!content) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /quanlychat [all|active|inactive|disabled|removed|private|group] [trang]"));
            return;
        }
        await sendMessage(chatId, content);
    } else if (command === "chitietchat") {
        if (!await requireOwner(context)) return;
        const targetId = String(argument || "").trim();
        const content = formatChatDetails(getChat(targetId));
        await sendMessage(chatId, content || formatWarningMessage("KHÔNG TÌM THẤY", "> Chat ID chưa có trong sổ quản lý."));
    } else if (["tamdungchat", "batlaichat", "xoachat", "kiemtrachat"].includes(command)) {
        if (!await requireOwner(context)) return;
        const parts = String(argument || "").trim().split(/\s+/).filter(Boolean);
        const targetId = parts.shift();
        if (!targetId) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", `> **Cú pháp:** /${command} [Chat ID]`));
            return;
        }
        if (command === "tamdungchat") {
            const reason = parts.join(" ") || "admin_disabled";
            setChatStatus(targetId, "disabled", String(context.userId), reason);
            await sendMessage(chatId, `# {orange}[CHAT] ĐÃ VÔ HIỆU HÓA{/orange}\n\n> \`${escapeMarkdown(targetId)}\`\n> **Lý do:** ${escapeMarkdown(reason)}`);
        } else if (command === "batlaichat") {
            setChatStatus(targetId, "active", String(context.userId), "admin_reactivated");
            await sendMessage(chatId, `# {green}[CHAT] ĐÃ KÍCH HOẠT{/green}\n\n> \`${escapeMarkdown(targetId)}\``);
        } else if (command === "xoachat") {
            setChatStatus(targetId, "removed", String(context.userId), "admin_removed");
            await sendMessage(chatId, `# {orange}[CHAT] ĐÃ XÓA MỀM{/orange}\n\n> \`${escapeMarkdown(targetId)}\`\n> Dữ liệu lịch sử vẫn được giữ lại.`);
        } else {
            const result = await sendNotification(targetId, "# {orange}[ADMIN TEST]{/orange}\n\nĐang kiểm tra khả năng gửi thông báo tới cuộc trò chuyện này.", { feature: "broadcast", operation: "admin_test", bypassEligibility: true });
            if (result.sent) {
                setChatStatus(targetId, "active", String(context.userId), "admin_test_succeeded");
                await sendMessage(chatId, `# {green}[CHAT] KIỂM TRA THÀNH CÔNG{/green}\n\n> \`${escapeMarkdown(targetId)}\``);
            } else if (result.skipped) {
                await sendMessage(chatId, formatWarningMessage("CHAT ĐANG BỊ KHÓA", "> Hãy dùng /batlaichat trước khi thử lại."));
            } else {
                await sendMessage(chatId, formatWarningMessage("CHAT VẪN KHÔNG GỬI ĐƯỢC", `> ${escapeMarkdown(result.error?.message || "Lỗi không xác định")}`));
            }
        }
    } else if (command === "chatfeature") {
        if (!await requireOwner(context)) return;
        const [targetId, feature, mode] = String(argument || "").trim().split(/\s+/);
        if (!targetId || !feature || !["on", "off", "auto"].includes(String(mode || "").toLowerCase())) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /chatfeature [Chat ID] [schedule|broadcast] [on|off|auto]"));
            return;
        }
        try {
            setFeatureOverride(targetId, feature.toLowerCase(), mode.toLowerCase() === "auto" ? null : mode.toLowerCase() === "on");
            await sendMessage(chatId, `# {green}[CHAT FEATURE] ĐÃ CẬP NHẬT{/green}\n\n> **Chat:** \`${escapeMarkdown(targetId)}\`\n> **Tính năng:** ${escapeMarkdown(feature)}\n> **Chế độ:** ${escapeMarkdown(mode)}`);
        } catch (error) {
            await sendMessage(chatId, formatWarningMessage("KHÔNG THỂ CẬP NHẬT", `> ${escapeMarkdown(error.message)}`));
        }
    } else if (command === "thongbao") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage(
                "THIẾU NỘI DUNG",
                "> **Cú pháp:** /thongbao [Nội dung thông báo]\n> **Ví dụ:** /thongbao Hệ thống sẽ bảo trì lúc 22:00.\n> Dùng **/update [Nội dung cập nhật]** nếu đây là thông báo cập nhật sản phẩm hoặc bot."
            ));
            return;
        }
        const message = `# {green}[THÔNG BÁO CHUNG]{/green}\n\n${escapeMarkdownMultiline(argument)}`;
        const result = await sendBotAnnouncement(message, { operation: "announcement", logLabel: "thông báo chung" });
        await sendMessage(chatId, formatBroadcastSummary("ĐÃ GỬI THÔNG BÁO CHUNG", result));
    } else if (command === "update") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage(
                "THIẾU NỘI DUNG",
                "> **Cú pháp:** /update [Nội dung cập nhật]\n> **Ví dụ:** /update Đã bổ sung tuỳ chọn giờ nhận lịch.\n> Dùng **/thongbao [Nội dung thông báo]** cho thông báo chung không phải cập nhật."
            ));
            return;
        }
        const message = `# {green}[THÔNG BÁO CẬP NHẬT]{/green}\n\n${escapeMarkdownMultiline(argument)}`;
        const result = await sendBotAnnouncement(message, { operation: "update", logLabel: "thông báo cập nhật" });
        await sendMessage(chatId, formatBroadcastSummary("ĐÃ GỬI THÔNG BÁO CẬP NHẬT", result));
    } else if (command === "myid") {
        await sendMessage(
            chatId,
            "# {green}[ID] THÔNG TIN TÀI KHOẢN{/green}\n\n" +
            `> **User ID:** ${escapeMarkdown(context.userId)}\n` +
            `> **Chat ID:** ${escapeMarkdown(context.chatId)}`
        );
    } else if (command === "help") {
        await sendMessage(chatId, formatGeneralHelp());
    } else if (command === "helpadmin") {
        if (!await requireOwner(context)) return;
        await sendMessage(chatId, formatAdminHelp());
    } else if (command === "time") {
        const vietnam = getVietnamDateInfo();
        const message = `# {green}[GIỜ VIỆT NAM]{/green}

> **Thời gian:** ${escapeMarkdown(vietnam.formattedDateTime)}
> **Múi giờ:** ${escapeMarkdown(TIME_ZONE)}

Lịch học và thông báo đều dùng múi giờ này.`;
        await sendMessage(chatId, message);
    } else if (command === "test6h") {
        if (!await requireOwner(context)) return;
        await sendMessage(chatId, "# {orange}[ADMIN TEST] GỬI LỊCH 06:00{/orange}\n\nĐang chạy kiểm tra gửi lịch học.");
        await sendDailySchedulesAtSix();
        await sendMessage(chatId, "# {green}✓ ĐÃ HOÀN TẤT KIỂM TRA GỬI LỊCH 06:00{/green}");
    } else {
        const suggestion = suggestCommandCorrection(command);
        await sendMessage(
            chatId,
            formatWarningMessage(
                "LỆNH KHÔNG HỢP LỆ",
                `> Không nhận diện được **/${escapeMarkdown(command)}**.\n> Bạn có thể dùng **${suggestion}** hoặc **/help** để xem danh sách lệnh.`
            )
        );
    }
}

async function sendNotification(chatId, text, options = {}) {
    const configuredThreshold = Number(process.env.CHAT_MAX_CONSECUTIVE_FAILURES || 3);
    const defaultThreshold = Number.isInteger(configuredThreshold) && configuredThreshold > 0 ? configuredThreshold : 3;
    const { feature = "broadcast", operation = feature, maxConsecutiveFailures = defaultThreshold, bypassEligibility = false } = options;
    if (!bypassEligibility && !isChatEligible(chatId, feature)) return { skipped: true, reason: "inactive_or_disabled" };
    try {
        await sendMessage(chatId, text, options.sendOptions || {});
        recordDeliverySuccess(chatId);
        return { sent: true };
    } catch (error) {
        const record = recordDeliveryFailure(chatId, error, { feature, operation, maxConsecutiveFailures });
        return { failed: true, error, suspended: record?.status === "inactive" };
    }
}

function positiveDuration(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const classStartReminderService = createClassStartReminderService({
    fetchSchedule: fetchStudentSchedule,
    getSubscriptions: getClassStartNotificationSubscriptions,
    // Quyền truy cập và việc gửi đều phải chạy trong ngữ cảnh của bot sở hữu
    // đăng ký, nếu không nhắc giờ học của bot 2 sẽ bị gửi bằng bot 1.
    isEligible: (subscription) => isSubscriptionEligible(subscription),
    sendReminder: (subscription, message) => sendToSubscription(subscription, message, {
        feature: "schedule",
        operation: "class_start_reminder"
    }),
    onError: ({ stage, error }) => logDiscord("ERROR", `class_start_${stage}_error: ${error.message}`),
    flushPersistence: flushPersistenceWrites,
    gracePeriodMs: positiveDuration(process.env.CLASS_START_GRACE_MS, DEFAULT_GRACE_PERIOD_MS),
    cacheTtlMs: positiveDuration(process.env.CLASS_START_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS)
});

async function sendClassStartNotifications(date = new Date()) {
    const result = await classStartReminderService.run(date);
    if (result.sent > 0) {
        console.log(`[NHẮC GIỜ] Đã gửi ${result.sent} thông báo bắt đầu buổi học.`);
    }
    if (result.failed > 0) {
        logDiscord("ERROR", `class_start_reminder_failed: ${result.failed} delivery or schedule check(s)`);
    }
    return result;
}

function groupSubscriptionsByStudent(subscriptions, notificationTime = null) {
    const grouped = new Map();
    for (const subscription of subscriptions) {
        const notificationTimes = normalizeNotificationTimes(subscription);
        if (notificationTime && !notificationTimes.some((item) => item.time === notificationTime)) continue;
        const targets = grouped.get(subscription.studentId) || new Map();
        // Một MSSV chỉ gửi một lần vào cùng một chat, dù nhiều thành viên cùng đăng ký.
        targets.set(subscription.chatId, subscription);
        grouped.set(subscription.studentId, targets);
    }
    return grouped;
}

function groupEnabledSubscriptionsByStudent(notificationTime = null) {
    return groupSubscriptionsByStudent(
        Object.values(getEnabledSubscriptions()).filter((subscription) => isChatEligible(subscription.chatId, "schedule")),
        notificationTime
    );
}

// Nhóm theo MSSV -> ngày đích -> chat. Mỗi mốc giờ tự chọn lịch hôm nay hay hôm
// sau, nên hai người nhận cùng một mốc giờ có thể cần hai ngày đích khác nhau;
// không được dùng chung một ngày cho cả lượt gửi.
// Bot sở hữu một đăng ký. Bản ghi cũ không có botId thuộc về bot 1.
function subscriptionBotId(subscription) {
    return normalizeBotId(subscription?.botId) || LEGACY_BOT_ID;
}

// Chạy một thao tác trong ngữ cảnh của bot SỞ HỮU đăng ký: kiểm tra quyền chat,
// hạn mức và client gửi đều phải là của chính bot đó. Không bao giờ chọn token
// ngẫu nhiên, và không bao giờ thử lại bằng một bot khác.
function withSubscriptionBot(subscription, fn) {
    const ownerId = subscriptionBotId(subscription);
    const owner = getBot(ownerId);
    if (!owner) {
        return Promise.reject(new Error(`Không có bot ${ownerId} đang bật để gửi cho chat ${subscription?.chatId}`));
    }
    return Promise.resolve(runWithBot(owner, fn));
}

function sendToSubscription(subscription, text, options) {
    return withSubscriptionBot(subscription, () => sendNotification(subscription.chatId, text, options));
}

// Kiểm tra quyền truy cập chat trong ngữ cảnh của bot sở hữu đăng ký. ĐỒNG BỘ —
// classStartNotifications gọi isEligible trong một vòng lặp đồng bộ, nên trả về
// Promise ở đây sẽ khiến mọi đăng ký đều được coi là hợp lệ.
function isSubscriptionEligible(subscription) {
    const owner = getBot(subscriptionBotId(subscription));
    if (!owner) return false;
    return runWithBot(owner, () => isChatEligible(subscription.chatId, "schedule"));
}

function groupEnabledSubscriptionsByTargetDay(notificationTime = null) {
    const grouped = new Map();
    const subscriptions = Object.values(getEnabledSubscriptions())
        // Quyền truy cập chat phải được kiểm tra trong ngữ cảnh của bot sở hữu
        // đăng ký, nếu không bot 2 sẽ bị đánh giá bằng sổ chat của bot 1.
        .filter((subscription) => isSubscriptionEligible(subscription));

    for (const subscription of subscriptions) {
        const offsets = new Set();
        for (const item of normalizeNotificationTimes(subscription)) {
            if (notificationTime && item.time !== notificationTime) continue;
            offsets.add(item.targetDayOffset);
        }
        if (offsets.size === 0) continue;

        const ownerId = subscriptionBotId(subscription);
        const byOffset = grouped.get(subscription.studentId) || new Map();
        for (const offset of offsets) {
            const targets = byOffset.get(offset) || new Map();
            // Một MSSV chỉ gửi một lần cho mỗi cặp (bot, chat) ở mỗi ngày đích.
            // Khóa phải gồm botId: cùng một Chat ID ở bot 1 và bot 2 là hai cuộc
            // trò chuyện khác nhau, gộp chúng lại sẽ làm mất một người nhận.
            targets.set(`${ownerId}::${subscription.chatId}`, subscription);
            byOffset.set(offset, targets);
        }
        grouped.set(subscription.studentId, byOffset);
    }
    return grouped;
}

let isCheckRunning = false;
const runningDailyNotificationTimes = new Set();

// Tự động kiểm tra và thông báo NGAY LẬP TỨC khi phát hiện lịch có thay đổi (chạy mỗi 15 phút)
async function checkAndNotifyScheduleChanges() {
    if (isCheckRunning) return;
    isCheckRunning = true;
    try {
        for (const [studentId, targetMap] of groupEnabledSubscriptionsByStudent().entries()) {
            try {
                const data = await fetchStudentSchedule(studentId);
                const result = confirmScheduleChange(data);

                if (result.confirmed) {
                    const changeMessage = formatScheduleChangeMessage(data, result.changes);
                    for (const subscription of targetMap.values()) {
                        const delivery = await sendToSubscription(subscription, changeMessage, { feature: "schedule", operation: "schedule_change" });
                        if (delivery.failed) logDiscord("ERROR", `Không thể gửi cảnh báo thay đổi cho chat ${subscription.chatId}: ${delivery.error.message}`);
                    }
                }
            } catch (error) {
                logDiscord("ERROR", `Không thể kiểm tra thay đổi lịch cho MSSV ${studentId}: ${error.message}`);
            }
        }
    } finally {
        isCheckRunning = false;
    }
}

// Gửi lịch học cho các đăng ký có cùng giờ thông báo. Ngày đích được tính
// riêng cho TỪNG người nhận: thời điểm gửi thực tế theo giờ Việt Nam cộng với
// lựa chọn hôm nay / hôm sau của chính mốc giờ đó.
async function sendDailySchedulesAtTime(notificationTime = DEFAULT_NOTIFICATION_TIME, deliveryAt = new Date()) {
    const subscriptionsGrouped = groupEnabledSubscriptionsByTargetDay(notificationTime);
    if (subscriptionsGrouped.size === 0) {
        return { processed: false, matchedStudents: 0, sent: 0, failed: 0 };
    }
    if (runningDailyNotificationTimes.has(notificationTime)) {
        return { processed: false, matchedStudents: subscriptionsGrouped.size, sent: 0, failed: 0 };
    }

    runningDailyNotificationTimes.add(notificationTime);
    const deliveryInfo = getVietnamDateInfo(deliveryAt);
    const dispatchResult = {
        processed: true,
        matchedStudents: subscriptionsGrouped.size,
        sent: 0,
        failed: 0
    };
    console.log(`⏰ Bắt đầu tiến trình gửi lịch học ${notificationTime} hàng ngày...`);
    logDiscord("INFO", `Bắt đầu tiến trình gửi lịch học ${notificationTime} hàng ngày...`);
    try {
        console.log(`[${notificationTime}] Tìm thấy ${subscriptionsGrouped.size} MSSV có đăng ký nhận thông báo.`);

        for (const [studentId, byOffset] of subscriptionsGrouped.entries()) {
            const offsets = [...byOffset.keys()].sort((left, right) => left - right);
            // Cảnh báo thay đổi lịch chỉ kiểm tra MỘT LẦN cho mỗi MSSV trong mỗi
            // lượt, đúng như trước đây, để luồng độc lập này không bị đổi hành vi.
            let changeChecked = false;

            for (const targetDayOffset of offsets) {
                const targetDateKey = addCalendarDays(deliveryInfo.dateKey, targetDayOffset);
                const targetDate = dateFromVietnamDateKey(targetDateKey);
                const targets = byOffset.get(targetDayOffset);

                try {
                    const data = await fetchStudentSchedule(studentId, targetDate);

                    // 1. Kiểm tra thay đổi lịch trước khi gửi (nếu có)
                    if (!changeChecked) {
                        changeChecked = true;
                        try {
                            const result = confirmScheduleChange(data);
                            if (result.confirmed) {
                                const changeMessage = formatScheduleChangeMessage(data, result.changes);
                                // Nếu lần kiểm tra này xác nhận thay đổi, thông báo tới mọi đăng ký
                                // của MSSV, không chỉ nhóm đang nhận lịch ở đúng mốc giờ hiện tại.
                                const allStudentTargets = groupEnabledSubscriptionsByStudent().get(studentId) || targets;
                                for (const subscription of allStudentTargets.values()) {
                                    const delivery = await sendToSubscription(subscription, changeMessage, { feature: "schedule", operation: "schedule_change" });
                                    if (delivery.failed) logDiscord("ERROR", `Không thể gửi cảnh báo thay đổi cho chat ${subscription.chatId}: ${delivery.error.message}`);
                                }
                            }
                        } catch (changeError) {
                            console.error(`Lỗi kiểm tra thay đổi cho MSSV ${studentId}:`, changeError.message);
                        }
                    }

                    // 2. Gửi lịch của đúng ngày đích mà người nhận đã chọn
                    const dailyMessage = formatDailySchedule(data, targetDate, { referenceDate: deliveryAt });
                    for (const subscription of targets.values()) {
                        const delivery = await sendToSubscription(subscription, dailyMessage, { feature: "schedule", operation: "daily_schedule" });
                        if (delivery.sent) {
                            dispatchResult.sent += 1;
                            console.log(`[${notificationTime}] Đã gửi lịch ${targetDateKey} cho MSSV ${studentId} tới chat ${subscription.chatId}`);
                        } else if (delivery.failed) {
                            dispatchResult.failed += 1;
                            logDiscord("ERROR", `Không thể gửi lịch ${notificationTime} cho chat ${subscription.chatId}: ${delivery.error.message}`);
                        }
                    }
                } catch (error) {
                    dispatchResult.failed += targets.size;
                    logDiscord("ERROR", `Không thể gửi lịch ${notificationTime} cho MSSV ${studentId} (${targetDateKey}): ${error.message}`);
                }
            }
        }
        return dispatchResult;
    } finally {
        runningDailyNotificationTimes.delete(notificationTime);
        console.log(`⏰ Hoàn tất tiến trình gửi lịch học ${notificationTime}.`);
    }
}

async function sendDailySchedulesAtSix() {
    return sendDailySchedulesAtTime("06:00");
}

async function sendScheduledDailySchedules(date = new Date()) {
    const dateInfo = getVietnamDateInfo(date);
    const notificationTime = `${dateInfo.hour}:${dateInfo.minute}`;
    return sendDailySchedulesAtTime(notificationTime, date);
}

function registerRuntimeJobs(scheduler = schedule) {
    if (scheduler && typeof scheduler === "object") {
        if (registeredSchedulers.has(scheduler)) return [];
        registeredSchedulers.add(scheduler);
    }
    const jobs = [];
    jobs.push(scheduler.scheduleJob({ rule: "*/15 * * * *", tz: TIME_ZONE }, asyncCommand(async () => {
        await checkAndNotifyScheduleChanges();
        await flushPersistenceWrites();
    })));
    jobs.push(scheduler.scheduleJob({ rule: "* * * * *", tz: TIME_ZONE }, asyncCommand(async () => {
        const dailyResult = await sendScheduledDailySchedules();
        const classStartResult = await sendClassStartNotifications();
        if (dailyResult.processed || classStartResult.processed) await flushPersistenceWrites();
    })));
    return jobs;
}

// Hủy các job đã đăng ký với node-schedule (job.cancel là API chính thức).
function cancelSchedulerJobs() {
    const jobs = runtimeSchedulerJobs;
    runtimeSchedulerJobs = [];
    for (const job of jobs) {
        try {
            if (job && typeof job.cancel === "function") job.cancel();
        } catch (error) {
            console.warn(`[Runtime] Không hủy được job scheduler: ${error.message}`);
        }
    }
    return jobs.length;
}

// node-zalo-bot không có stopPolling công khai; instance Polling nội bộ có stop().
// Chỉ gọi khi thư viện thực sự cung cấp, không tự phát minh API.
// Hủy yêu cầu long-poll đang chờ để không phải đợi hết timeout của Zalo.
function stopOneBotPolling(runtime) {
    const client = runtime?.client;
    if (client && typeof client.stopPolling === "function") return Promise.resolve(client.stopPolling());
    const polling = client && client._polling;
    if (polling && typeof polling.stop === "function") {
        return Promise.resolve(polling.stop({ cancel: true, reason: "Bot is shutting down" }));
    }
    console.warn(`[Runtime] ${runtime?.botId || "?"}: thư viện Zalo không cung cấp API dừng polling; bỏ qua bước này.`);
    return Promise.resolve();
}

// Dừng polling của MỌI bot. Một bot lỗi không được ngăn các bot còn lại dừng sạch.
async function stopZaloPolling() {
    shuttingDown = true;
    const results = await Promise.allSettled(listBots().map((runtime) => stopOneBotPolling(runtime)));
    for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
            console.warn(`[Runtime] ${listBots()[index]?.botId || "?"}: dừng polling thất bại - ${result.reason?.message || result.reason}`);
        }
    }
    return results.length;
}

function closeDashboardServer() {
    const server = adminRuntime && adminRuntime.server;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
    });
}

function registerShutdownHandlers() {
    shutdownController ||= createShutdownController({
        timeoutMs: positiveDuration(process.env.SHUTDOWN_TIMEOUT_MS, DEFAULT_SHUTDOWN_TIMEOUT_MS),
        log: (message) => console.log(message),
        stopScheduler: () => { cancelSchedulerJobs(); },
        stopPolling: () => stopZaloPolling(),
        closeDashboard: () => closeDashboardServer(),
        flushPersistence: () => flushPersistenceWrites()
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, () => { shutdownController.run(signal); });
    }
    return shutdownController;
}

async function startRuntime() {
    let firebaseTarget;
    try {
        // Bước 1: nạp cấu hình Firebase + hydrate state Firestore vào bộ nhớ.
        firebaseTarget = await initializeFirestorePersistence({
            storeIds: [
                "accessControl",
                "adminAudit",
                "adminLogs",
                "adminSettings",
                "chatDirectory",
                "interactions",
                "classStartNotifications",
                "scheduleSnapshots",
                "subscriptions"
            ]
        });
    } catch (error) {
        console.error(`[Firebase] Không thể khởi tạo Firestore: ${error.message}`);
        console.error("[Runtime] Dừng khởi động: scheduler và Zalo polling không được bật.");
        throw error;
    }

    console.log(`[Firebase] Project: ${firebaseTarget.projectId}`);
    console.log(`[Firebase] Database: ${firebaseTarget.databaseId}`);
    console.log(`[Firebase] Collection: ${firebaseTarget.collectionName}`);
    console.log(`[Persistence] State loaded (${firebaseTarget.storeIds.length} store)`);
    console.log(`[Runtime] Timezone: ${TIME_ZONE}`);

    // Bước 2: đồng bộ lại state phái sinh từ dữ liệu cũ trước khi chạy runtime.
    if (syncChatDirectoryFromLegacyStores() > 0) await flushPersistenceWrites();

    // Bước 3: dashboard.
    adminRuntime = createAdminServer({
        executeCommand: async ({ command, userId, chatId, displayName, executor, target }) => {
            const parsed = parseCommand(command);
            if (!parsed) throw new Error("Lệnh phải bắt đầu bằng /");

            // Danh tính admin đang đăng nhập — nguồn duy nhất cho kiểm tra quyền.
            const actor = {
                userId: String(executor?.userId || userId),
                chatId: String(chatId),
                username: executor?.username || null
            };
            if (!isOwner(actor)) throw new Error("Admin context chưa được cấp quyền");

            // Ngữ cảnh dữ liệu: người được chọn làm đích nếu có, nếu không thì
            // chính admin. Lệnh chạy cho người nhận nên trạng thái theo người và
            // phần trả lời đều thuộc về người đó.
            const targetUserId = target?.userId ? String(target.userId) : "";
            const targetChatId = target?.chatId ? String(target.chatId) : "";
            const context = {
                userId: targetUserId || actor.userId,
                chatId: targetChatId || actor.chatId,
                userDisplayName: target?.displayName
                    || String(executor?.displayName || displayName || executor?.username || "Dashboard Admin")
            };

            const capture = { chatId: context.chatId, messages: [], actor };
            await dashboardCommandContext.run(capture, () => handleCommand({ text: command, chat: { id: context.chatId, type: "private" }, from: { id: context.userId, display_name: context.userDisplayName } }, parsed));

            // `deliveredToChatId` là bằng chứng phần trả lời đã được gửi thật tới
            // chat nào — khác với việc chỉ phân tích được câu lệnh.
            return {
                command,
                deliveredToChatId: context.chatId,
                messages: capture.messages,
                messageCount: capture.messages.length,
                executor: executor || { userId: actor.userId, displayName: context.userDisplayName },
                target: target || null,
                targetUserId: context.userId,
                targeted: Boolean(targetUserId || targetChatId)
            };
        },
        retryChat: async (chatId) => sendNotification(
            chatId,
            "# {orange}[ADMIN TEST]{/orange}\n\nĐang kiểm tra khả năng gửi thông báo tới cuộc trò chuyện này.",
            { feature: "broadcast", operation: "admin_dashboard_retry", bypassEligibility: true }
        )
    });
    await new Promise((resolve, reject) => {
        adminRuntime.server.once("error", reject);
        adminRuntime.server.listen(adminRuntime.port, "127.0.0.1", resolve);
    });
    console.log(`[Dashboard] Listening on http://127.0.0.1:${adminRuntime.port}${adminRuntime.basePath}`);

    // Bước 4: chỉ bật scheduler sau khi state Firestore đã được hydrate vào bộ nhớ.
    runtimeSchedulerJobs = registerRuntimeJobs() || [];
    registerShutdownHandlers();
    console.log(`[Runtime] Scheduler started (${TIME_ZONE})`);

    // Bước 5: polling Zalo sau cùng — mỗi bot một consumer riêng, không dùng
    // chung token nên không bao giờ có hai consumer trên cùng một danh tính.
    const started = [];
    for (const runtime of listEnabledBots()) {
        try {
            await runtime.client.startPolling();
            runtime.pollingStartedAt = new Date().toISOString();
            runtime.status = "running";
            started.push(runtime.botId);
            console.log(`[Runtime] ${runtime.botId}: Zalo polling started (${TIME_ZONE})`);
        } catch (error) {
            runtime.status = "polling_failed";
            runtime.lastError = error.message;
            runtime.lastErrorAt = new Date().toISOString();
            console.error(`[Runtime] ${runtime.botId}: không khởi động được polling - ${error.message}`);
            logDiscord("ERROR", `polling_start_failed[${runtime.botId}]: ${error.message}`);
        }
    }
    if (started.length === 0) {
        throw new Error("Không bot nào khởi động được polling Zalo");
    }
    logDiscord("INFO", `Bot đã khởi động - timezone ${TIME_ZONE} - bots: ${started.join(", ")}`);
    await flushPersistenceWrites();
}

async function handleIncomingMessage(runtime, msg) {
    const text = msg.text || "[không có nội dung]";
    // Chat ID / User ID chỉ có nghĩa trong phạm vi một bot, nên botId đi kèm ngữ cảnh.
    const context = getMessageContext(msg, { botId: runtime.botId });
    const from = msg.from?.display_name || context.userId || "unknown";
    console.log("Tin nhắn mới:", from, "→", text);
    const interaction = recordInteraction(context, msg);
    upsertChat({
        restoreDeleted: true,
        chatId: context.chatId,
        chatType: interaction.chatType,
        displayName: interaction.chatTitle || context.userDisplayName,
        userId: interaction.lastUserId,
        chatTitle: interaction.chatTitle,
        firstInteractionAt: interaction.firstInteractionAt,
        lastInboundInteractionAt: interaction.lastInteractionAt
    });

    logDiscord("INFO", `Tin nhắn từ: ${from}\n> User ID: ${context.userId}\n> Chat ID: ${context.chatId}\n> Chat Title: ${interaction.chatTitle || "Private"}\n> Chat Type: ${interaction.chatType}\n> Nội dung: ${text}`);

    // Kiểm tra quyền sử dụng BOT (Owner luôn được phép)
    if (!isOwner(context)) {
        const botCheck = canUseBot(context);
        if (!botCheck.allowed) {
            await sendMessage(
                context.chatId,
                formatWarningMessage(
                    "KHÔNG CÓ QUYỀN TRUY CẬP",
                    "> Tài khoản hoặc nhóm này hiện không có quyền sử dụng trợ lý."
                )
            );
            return;
        }
    }

    const parsed = parseCommand(msg.text);

    const looksLikeCommand = String(msg.text || "").trim().startsWith("/");
    if (interaction.isFirstInteraction && !parsed) {
        if (!looksLikeCommand) {
            try {
                await sendWelcomeMessage(context.chatId, msg.from?.display_name);
            } catch (error) {
                logDiscord("ERROR", `Không thể gửi lời chào mừng tới chat ${context.chatId}: ${error.message}`);
            }
        }
    }

    if (parsed) {
        await handleCommand(msg, parsed);
    } else if (looksLikeCommand) {
        await sendMessage(
            context.chatId,
            formatWarningMessage(
                "LỆNH KHÔNG HỢP LỆ",
                "> Không thể phân tích lệnh này.\n> Dùng **/help** để xem cú pháp và danh sách lệnh."
            )
        );
    }
    await flushPersistenceWrites();
}

// Đăng ký handler riêng cho từng bot. Mọi handler chạy trong ngữ cảnh của chính
// bot đó, nên phản hồi luôn đi ra bằng đúng danh tính đã nhận tin nhắn.
function registerBotHandlers(runtime) {
    const label = runtime.botId;
    runtime.client.on("message", bindBot(runtime, asyncCommand((msg) => handleIncomingMessage(runtime, msg))));

    runtime.client.on("polling_error", (error) => {
        // Lỗi phát sinh do chủ động hủy long-poll lúc dừng bot không phải sự cố.
        if (shuttingDown) return;
        if (error.code === "EZALO" && error.message?.includes("408")) return;
        runtime.lastError = error.message;
        runtime.lastErrorAt = new Date().toISOString();
        console.error(`[${label}] Lỗi polling:`, error);
        logDiscord("ERROR", `polling_error[${label}]: ${error.message}`);
    });

    runtime.client.on("error", (error) => {
        runtime.lastError = error.message;
        runtime.lastErrorAt = new Date().toISOString();
        console.error(`[${label}] Lỗi bot:`, error);
        logDiscord("ERROR", `error[${label}]: ${error.message}`);
    });

    return runtime;
}

for (const runtime of listBots()) registerBotHandlers(runtime);

if (!isTestEnv) {
    startRuntime().catch((error) => {
        console.error("Không thể khởi động persistence/runtime:", error);
        logDiscord("ERROR", `runtime_startup_error: ${error.message}`);
        // Không chạy nền bằng JSON cục bộ trong môi trường thật: dừng với mã lỗi.
        process.exit(1);
    });
}

module.exports = {
    cancelSchedulerJobs,
    closeDashboardServer,
    formatGeneralHelp,
    formatAdminHelp,
    registerShutdownHandlers,
    stopZaloPolling,
    getBroadcastTargets,
    groupSubscriptionsByStudent,
    handleCommand,
    getCommandRegistry,
    isOwner,
    formatTargetDay,
    formatTargetDayLabel,
    normalizeTargetDayToken,
    parseNhanLichArgument,
    parseRecordId,
    parseSuaGioNhanLichArgument,
    parseCommand,
    parseQuestionIdAndText,
    registerRuntimeJobs,
    sendBotAnnouncement,
    sendClassStartNotifications,
    sendDailySchedulesAtSix,
    sendDailySchedulesAtTime,
    sendScheduledDailySchedules,
    sendWelcomeMessage,
    suggestCommandCorrection,
    startRuntime
};
