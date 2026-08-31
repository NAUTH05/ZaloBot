process.env.TZ = "Asia/Ho_Chi_Minh";

require("dotenv").config();

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
    disableClassStartNotifications,
    disableNotifications,
    enableClassStartNotifications,
    enableNotifications,
    getAllSubscriptions,
    getClassStartNotificationSubscriptions,
    getEnabledSubscriptions,
    getSubscription,
    DEFAULT_NOTIFICATION_TIME,
    normalizeNotificationTime,
    normalizeNotificationTimes,
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
const { resolveScheduleTarget } = require("./scheduleDatePolicy");
const { escapeMarkdown, escapeMarkdownMultiline, sanitizeExternalRichText } = require("./richText");
const {
    formatAdminHelp,
    formatClassStartEnabled,
    formatClassStartStatus,
    formatDailyNotificationEnabled,
    formatDutyHelp,
    formatErrorMessage,
    formatGeneralHelp,
    formatMissingStudentIdMessage,
    formatStudentSavedMessage,
    formatSuccessMessage,
    formatWarningMessage,
    formatWelcomeMessage
} = require("./messageTemplates");
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
const { createAdminServer } = require("./adminServer");
const { recordSystemLog } = require("./operationalLog");
const { getConfiguredAdminIds, isConfiguredAdmin } = require("./adminSettings");
const {
    addQuestion,
    answerQuestion,
    deleteQuestion,
    getLatestQuestionYear,
    getQuestions,
    isBirthdayDate,
    markInvitationSent,
    markResultSent,
    updateQuestion,
    wasInvitationSent,
    wasResultSent
} = require("./birthdayStore");
const {
    addDutySchedule,
    addDutySchedules,
    deleteDutySchedule,
    disableDutyNotifications,
    enableDutyNotifications,
    formatDutyList,
    formatDutyNotification,
    getDutyScheduleForDate,
    getDutySchedules,
    getDutySubscriptions,
    updateDutySchedule
} = require("./dutyScheduleStore");

const isTestEnv = process.env.NODE_ENV === "test" || require.main !== module;
const BIRTH_YEAR = 2005;

if (!process.env.BOT_TOKEN) {
    throw new Error("Thiếu BOT_TOKEN trong file .env");
}

const bot = new ZaloBot(process.env.BOT_TOKEN, { polling: false });
const dashboardCommandContext = new AsyncLocalStorage();

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
        req.on("error", () => {});
        req.write(payload);
        req.end();
    } catch (_) {
        // Không để lỗi webhook làm dừng bot.
    }
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
            await Promise.resolve(bot.sendMessage(chatId, payload, messageOptions));
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
                await Promise.resolve(bot.sendMessage(chatId, plainPayload, fallbackOptions));
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

    const command = match[1].toLowerCase();
    const argument = (match[2] || "").trim();

    return { command, argument };
}

function isOwner(context) {
    const configured = getConfiguredAdminIds();
    if (configured.userIds.length === 0 && configured.chatIds.length === 0) return false;
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

function parseDutyIdOrDateAndText(argument) {
    const match = String(argument || "").trim().match(/^(\[?\d{1,2}\/\d{1,2}\]?|#?\d+)(?:\s*\|\s*|\s+)([\s\S]+)$/);
    return match ? { target: match[1], text: match[2].trim() } : null;
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

async function sendBotAnnouncement(message) {
    const targets = getBroadcastTargets();
    const result = { targets: targets.length, sent: 0, failed: 0 };
    for (const target of targets) {
        try {
            const delivery = await sendNotification(target.chatId, message, { feature: "broadcast", operation: "announcement" });
            if (delivery.sent) result.sent += 1;
            else if (delivery.failed) {
                result.failed += 1;
                logDiscord("ERROR", `Không thể gửi thông báo cập nhật cho chat ${target.chatId}: ${delivery.error.message}`);
            }
        } catch (error) {
            result.failed += 1;
            logDiscord("ERROR", `Không thể gửi thông báo cập nhật cho chat ${target.chatId}: ${error.message}`);
        }
    }
    return result;
}

function formatBirthdayInvitation(year) {
    const age = Math.max(0, Number(year) - BIRTH_YEAR);
    return `# {green}[SINH NHẬT ${year}] HỎI TÔI BẤT KỲ ĐIỀU GÌ{/green}

Hôm nay, **27/08**, là sinh nhật của tôi. Năm nay tôi **${age} tuổi**!

> Dùng **/sinhnhat [câu hỏi]** để gửi câu hỏi bạn muốn.
> **Ví dụ:** /sinhnhat Điều bạn tự hào nhất trong năm qua là gì?

{orange}Cổng nhận câu hỏi mở đến hết ngày 27/08 theo giờ Việt Nam.{/orange}`;
}

function formatBirthdayResults(year, questions) {
    const age = Math.max(0, Number(year) - BIRTH_YEAR);
    const sections = questions.map((question) =>
        `## {orange}[#${question.id}] ${escapeMarkdown(question.text)}{/orange}\n${escapeMarkdownMultiline(question.answer)}`
    );
    return `# {green}[SINH NHẬT ${year}] CÔNG BỐ HỎI & ĐÁP{/green}

Cảm ơn mọi người đã gửi câu hỏi cho sinh nhật 27/08 của tôi. Năm nay tôi **${age} tuổi**!

${sections.join("\n\n")}`;
}

async function sendBirthdayInvitations(targets = getBroadcastTargets("birthday"), date = new Date()) {
    const dateInfo = getVietnamDateInfo(date);
    if (!isBirthdayDate(dateInfo)) return { sent: 0, skipped: targets.length, failed: 0 };

    const year = Number(dateInfo.year);
    const message = formatBirthdayInvitation(year);
    const result = { sent: 0, skipped: 0, failed: 0 };
    for (const target of targets) {
        if (wasInvitationSent(year, target.chatId)) {
            result.skipped += 1;
            continue;
        }
        try {
            const delivery = await sendNotification(target.chatId, message, { feature: "birthday", operation: "invitation" });
            if (delivery.sent) {
                markInvitationSent(year, target.chatId, date);
                result.sent += 1;
            } else if (delivery.failed) {
                result.failed += 1;
                logDiscord("ERROR", `Không thể gửi lời mời sinh nhật cho chat ${target.chatId}: ${delivery.error.message}`);
            }
        } catch (error) {
            result.failed += 1;
            logDiscord("ERROR", `Không thể gửi lời mời sinh nhật cho chat ${target.chatId}: ${error.message}`);
        }
    }
    return result;
}

async function publishBirthdayResults(year) {
    const answeredQuestions = getQuestions(year).filter((question) => question.answer);
    if (!answeredQuestions.length) return { noAnswers: true, sent: 0, skipped: 0, failed: 0 };

    const message = formatBirthdayResults(year, answeredQuestions);
    const digest = crypto.createHash("sha256").update(message).digest("hex");
    const result = { noAnswers: false, sent: 0, skipped: 0, failed: 0 };
    for (const target of getBroadcastTargets("birthday")) {
        if (wasResultSent(year, target.chatId, digest)) {
            result.skipped += 1;
            continue;
        }
        try {
            const delivery = await sendNotification(target.chatId, message, { feature: "birthday", operation: "results" });
            if (delivery.sent) {
                markResultSent(year, target.chatId, digest);
                result.sent += 1;
            } else if (delivery.failed) {
                result.failed += 1;
                logDiscord("ERROR", `Không thể công bố sinh nhật cho chat ${target.chatId}: ${delivery.error.message}`);
            }
        } catch (error) {
            result.failed += 1;
            logDiscord("ERROR", `Không thể công bố sinh nhật cho chat ${target.chatId}: ${error.message}`);
        }
    }
    return result;
}

async function sendWelcomeMessage(chatId, displayName = "bạn") {
    await sendMessage(chatId, formatWelcomeMessage(displayName));
}

function parseDangKyArgument(argument, savedStudentId) {
    const raw = String(argument || "").trim();
    const saved = normalizeStudentId(savedStudentId);
    if (!raw) return { studentId: saved, notificationTime: null };

    const parts = raw.split(/\s+/);
    if (parts.length === 1 && raw.includes(":")) {
        return { studentId: saved, notificationTime: normalizeNotificationTime(raw) };
    }

    if (parts.length === 1) {
        return { studentId: normalizeStudentId(raw), notificationTime: null };
    }

    if (parts.length === 2) {
        return {
            studentId: normalizeStudentId(parts[0]),
            notificationTime: normalizeNotificationTime(parts[1])
        };
    }

    return { studentId: null, notificationTime: null };
}

function parseNotificationTimeEditArgument(argument) {
    const match = String(argument || "").trim().match(/^#?(\d+)\s+(.+)$/);
    if (!match) return null;
    return { id: Number(match[1]), notificationTime: normalizeNotificationTime(match[2]) };
}

const COMMAND_EXAMPLES = {
    start: "/start",
    find: "/find 123456789",
    dangky: "/dangky 08:00",
    danhsachdangky: "/danhsachdangky",
    suadangky: "/suadangky #1 20:00",
    xoadangky: "/xoadangky #1",
    lich: "/lich 123456789",
    lichtuan: "/lichtuan 123456789",
    lichthi: "/lichthi 123456789",
    lichgv: "/lichgv Nguyễn Văn A",
    phongtrong: "/phongtrong 1",
    ai: "/ai Hôm nay tôi học môn gì?",
    batnhaclich: "/batnhaclich",
    tatnhaclich: "/tatnhaclich",
    trangthainhaclich: "/trangthainhaclich",
    huythongbao: "/huythongbao",
    sinhnhat: "/sinhnhat Bạn muốn hỏi tôi điều gì?",
    myid: "/myid",
    lichtruc: "/lichtruc",
    themlichtruc: "/themlichtruc 25/08 Nhân - Sang",
    sualichtruc: "/sualichtruc 25/08 Nhân - Cường",
    xoalichtruc: "/xoalichtruc 25/08",
    danhsachlichtruc: "/danhsachlichtruc",
    dangkylich: "/dangkylich",
    huydangkylich: "/huydangkylich",
    help: "/help",
    help411: "/help411",
    helpadmin: "/helpadmin",
    time: "/time",
    thongbao: "/thongbao Đã cập nhật tính năng mới",
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
    thongtinch: "/thongtinch 123456",
    vohieuchat: "/vohieuchat 123456",
    kichhoatchat: "/kichhoatchat 123456",
    thuchatchat: "/thuchatchat 123456",
    xoachat: "/xoachat 123456",
    chatfeature: "/chatfeature 123456 schedule off",
    danhsach: "/danhsach 2026",
    them: "/them Câu hỏi mới",
    sua: "/sua 1 Nội dung mới",
    xoa: "/xoa 1",
    traloi: "/traloi 1 Nội dung trả lời",
    congbo: "/congbo 2026",
    test6h: "/test6h",
    test6hlichtruc: "/test6hlichtruc"
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
        if (known === "dangky" && /^([01]\d|2[0-3])([0-5]\d)$/.test(suffix)) {
            return `/dangky ${suffix.slice(0, 2)}:${suffix.slice(2)}`;
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

function formatNotificationTimes(subscription) {
    const times = normalizeNotificationTimes(subscription);
    if (!times.length) return "> Chưa có giờ nhận lịch.";
    return times.map((item) => `- **#${item.id}** — \`${item.time}\``).join("\n");
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
    for (const subscription of getDutySubscriptions()) {
        upsertChat({ chatId: subscription.chatId, chatType: subscription.chatType || "unknown", displayName: subscription.chatTitle || "" });
        syncedChatIds.add(String(subscription.chatId));
    }
    return syncedChatIds.size;
}

async function handleCommand(msg, parsedCommand) {
    const context = getMessageContext(msg);
    const chatId = context.chatId;
    const { command, argument } = parsedCommand;

    if (command === "start") {
        await sendWelcomeMessage(chatId, msg.from?.display_name);
    } else if (command === "find") {
        const studentId = normalizeStudentId(argument);
        if (!studentId) {
            await sendMessage(chatId, formatWarningMessage(
                "SAI CÚ PHÁP",
                "> **Cú pháp:** /find [MSSV]\n> **Ví dụ:** /find 123456789"
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
            await sendUserError(chatId, error, "find");
        }
    } else if (command === "dangky") {
        const saved = getSubscription(context);
        const parsedRegistration = parseDangKyArgument(argument, saved?.studentId);
        const studentId = parsedRegistration.studentId;
        const notificationTime = parsedRegistration.notificationTime;
        const registrationParts = String(argument || "").trim().split(/\s+/).filter(Boolean);
        const hasExplicitTime = argument.includes(":") || registrationParts.length === 2;

        if (!studentId || (hasExplicitTime && !parsedRegistration.notificationTime)) {
            await sendMessage(chatId, argument
                ? formatWarningMessage(
                    "SAI CÚ PHÁP",
                    "> **Cú pháp:** /dangky [hh:mm] hoặc /dangky [MSSV] [hh:mm]\n> **Ví dụ:** /dangky 05:30\n> Giờ hợp lệ từ **00:00** đến **23:59**."
                )
                : formatMissingStudentIdMessage("dangky"));
            return;
        }

        try {
            const data = await fetchStudentSchedule(studentId);
            const wasAlreadyWatched = Object.values(getEnabledSubscriptions())
                .some((subscription) => subscription.studentId === studentId);
            enableNotifications(context, {
                studentId,
                studentName: data.studentName,
                notificationTime
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
    } else if (command === "danhsachdangky") {
        const saved = getSubscription(context);
        const times = normalizeNotificationTimes(saved);
        await sendMessage(chatId, times.length
            ? `# {green}[GIỜ NHẬN LỊCH]{/green}\n\n${formatNotificationTimes(saved)}`
            : formatWarningMessage("CHƯA CÓ GIỜ NHẬN LỊCH", "> Dùng **/dangky [hh:mm]** để thêm giờ nhận lịch."));
    } else if (command === "suadangky") {
        const saved = getSubscription(context);
        const parsed = parseNotificationTimeEditArgument(argument);
        if (!saved || !parsed || !parsed.notificationTime) {
            await sendMessage(chatId, formatWarningMessage(
                "SAI CÚ PHÁP",
                "> **Cú pháp:** /suadangky #ID hh:mm\n> **Ví dụ:** /suadangky #1 20:00"
            ));
            return;
        }
        const updated = updateNotificationTime(context, parsed.id, parsed.notificationTime);
        await sendMessage(
            chatId,
            updated
                ? formatSuccessMessage("ĐÃ CẬP NHẬT GIỜ NHẬN LỊCH", formatNotificationTimes(updated))
                : formatWarningMessage("KHÔNG THỂ SỬA", "> ID không tồn tại hoặc giờ này đã được đăng ký.")
        );
    } else if (command === "xoadangky") {
        const parsedId = String(argument || "").trim().match(/^#?(\d+)$/)?.[1];
        if (!parsedId) {
            await sendMessage(chatId, formatWarningMessage(
                "SAI CÚ PHÁP",
                "> **Cú pháp:** /xoadangky #ID\n> **Ví dụ:** /xoadangky #1"
            ));
            return;
        }
        const removed = removeNotificationTime(context, Number(parsedId));
        await sendMessage(
            chatId,
            removed
                ? formatSuccessMessage(`ĐÃ XÓA GIỜ ${removed.removed.time}`, formatNotificationTimes(removed.subscription))
                : formatWarningMessage("KHÔNG TÌM THẤY", `> Không có giờ nhận lịch **#${parsedId}**.`)
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
    } else if (command === "huythongbao") {
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
                    "> Dùng **/dangky** để bật thông báo lịch học."
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
    } else if (command === "sinhnhat") {
        const dateInfo = getVietnamDateInfo();
        if (!isBirthdayDate(dateInfo)) {
            await sendMessage(chatId, formatWarningMessage(
                "CHƯA ĐẾN NGÀY SINH NHẬT",
                "> Lệnh **/sinhnhat [câu hỏi]** chỉ nhận câu hỏi trong ngày **27/08** theo giờ Việt Nam."
            ));
            return;
        }
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage(
                "THIẾU CÂU HỎI",
                "> **Cú pháp:** /sinhnhat [câu hỏi]\n> **Ví dụ:** /sinhnhat Điều bạn mong chờ nhất ở tuổi mới là gì?"
            ));
            return;
        }
        try {
            const question = addQuestion({
                year: Number(dateInfo.year),
                text: argument,
                author: {
                    userId: context.userId,
                    displayName: context.userDisplayName,
                    chatId: context.chatId
                }
            });
            await sendMessage(chatId,
                `# {green}✓ ĐÃ GHI NHẬN CÂU HỎI #${question.id}{/green}\n\n` +
                `> ${escapeMarkdown(question.text)}\n\n` +
                "Cảm ơn bạn. Câu trả lời sẽ được công bố sau."
            );
        } catch (error) {
            await sendUserError(chatId, error, "birthday_question");
        }
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
            } catch (_) {}
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
    } else if (command === "thongtinch") {
        if (!await requireOwner(context)) return;
        const targetId = String(argument || "").trim();
        const content = formatChatDetails(getChat(targetId));
        await sendMessage(chatId, content || formatWarningMessage("KHÔNG TÌM THẤY", "> Chat ID chưa có trong sổ quản lý."));
    } else if (["vohieuchat", "kichhoatchat", "xoachat", "thuchatchat"].includes(command)) {
        if (!await requireOwner(context)) return;
        const parts = String(argument || "").trim().split(/\s+/).filter(Boolean);
        const targetId = parts.shift();
        if (!targetId) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", `> **Cú pháp:** /${command} [Chat ID]`));
            return;
        }
        if (command === "vohieuchat") {
            const reason = parts.join(" ") || "admin_disabled";
            setChatStatus(targetId, "disabled", String(context.userId), reason);
            await sendMessage(chatId, `# {orange}[CHAT] ĐÃ VÔ HIỆU HÓA{/orange}\n\n> \`${escapeMarkdown(targetId)}\`\n> **Lý do:** ${escapeMarkdown(reason)}`);
        } else if (command === "kichhoatchat") {
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
                await sendMessage(chatId, formatWarningMessage("CHAT ĐANG BỊ KHÓA", "> Hãy dùng /kichhoatchat trước khi thử lại."));
            } else {
                await sendMessage(chatId, formatWarningMessage("CHAT VẪN KHÔNG GỬI ĐƯỢC", `> ${escapeMarkdown(result.error?.message || "Lỗi không xác định")}`));
            }
        }
    } else if (command === "chatfeature") {
        if (!await requireOwner(context)) return;
        const [targetId, feature, mode] = String(argument || "").trim().split(/\s+/);
        if (!targetId || !feature || !["on", "off", "auto"].includes(String(mode || "").toLowerCase())) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /chatfeature [Chat ID] [schedule|duty|birthday|broadcast] [on|off|auto]"));
            return;
        }
        try {
            setFeatureOverride(targetId, feature.toLowerCase(), mode.toLowerCase() === "auto" ? null : mode.toLowerCase() === "on");
            await sendMessage(chatId, `# {green}[CHAT FEATURE] ĐÃ CẬP NHẬT{/green}\n\n> **Chat:** \`${escapeMarkdown(targetId)}\`\n> **Tính năng:** ${escapeMarkdown(feature)}\n> **Chế độ:** ${escapeMarkdown(mode)}`);
        } catch (error) {
            await sendMessage(chatId, formatWarningMessage("KHÔNG THỂ CẬP NHẬT", `> ${escapeMarkdown(error.message)}`));
        }
    } else if (command === "danhsach") {
        if (!await requireOwner(context)) return;
        if (argument && !/^\d{4}$/.test(String(argument).trim())) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /danhsach [năm]"));
            return;
        }
        const year = resolveQuestionYear(argument);
        const questions = getQuestions(year);
        if (!questions.length) {
            await sendMessage(chatId, formatWarningMessage(
                `DANH SÁCH ${year} ĐANG TRỐNG`,
                "> Dùng **/them [câu hỏi]** để thêm thủ công."
            ));
            return;
        }
        const rows = questions.map((question) => {
            const asker = escapeMarkdown(question.author?.displayName || question.author?.userId || "Không rõ");
            const status = question.answer ? "{green}[ĐÃ TRẢ LỜI]{/green}" : "{orange}[CHỜ TRẢ LỜI]{/orange}";
            const answer = question.answer ? `\n> **Trả lời:** ${escapeMarkdown(question.answer)}` : "";
            return `## [#${question.id}] ${status}\n**Hỏi:** ${escapeMarkdown(question.text)}\n> **Người gửi:** ${asker}${answer}`;
        });
        await sendMessage(chatId,
            `# {green}[DANH SÁCH ${year}] ${questions.length} CÂU HỎI{/green}\n\n` +
            `${rows.join("\n\n")}\n\n` +
            "**Thao tác nhanh:**\n- /traloi [ID] [câu trả lời]\n- /sua [ID] [câu hỏi mới]\n- /xoa [ID]\n- /them [câu hỏi]"
        );
    } else if (command === "them") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /them [câu hỏi]"));
            return;
        }
        try {
            const dateInfo = getVietnamDateInfo();
            const question = addQuestion({
                year: Number(dateInfo.year),
                text: argument,
                author: { userId: context.userId, displayName: "Chủ BOT", chatId }
            });
            await sendMessage(chatId, `# {green}✓ ĐÃ THÊM CÂU HỎI #${question.id}{/green}\n\n> ${escapeMarkdown(question.text)}`);
        } catch (error) {
            await sendMessage(chatId, formatWarningMessage("KHÔNG THỂ THÊM", `> ${escapeMarkdown(error.message)}`));
        }
    } else if (command === "sua") {
        if (!await requireOwner(context)) return;
        const input = parseQuestionIdAndText(argument);
        if (!input) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /sua [ID] [câu hỏi mới]"));
            return;
        }
        try {
            const question = updateQuestion(input.id, input.text);
            await sendMessage(chatId, question
                ? `# {green}✓ ĐÃ SỬA CÂU HỎI #${question.id}{/green}\n\n> ${escapeMarkdown(question.text)}`
                : formatWarningMessage("KHÔNG TÌM THẤY", `> Không có câu hỏi **#${input.id}**.`));
        } catch (error) {
            await sendMessage(chatId, formatWarningMessage("KHÔNG THỂ SỬA", `> ${escapeMarkdown(error.message)}`));
        }
    } else if (command === "xoa") {
        if (!await requireOwner(context)) return;
        const id = String(argument || "").trim().match(/^#?(\d+)$/)?.[1];
        if (!id) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /xoa [ID]"));
            return;
        }
        const question = deleteQuestion(Number(id));
        await sendMessage(chatId, question
            ? `# {green}✓ ĐÃ XÓA CÂU HỎI #${question.id}{/green}\n\n> ${escapeMarkdown(question.text)}`
            : formatWarningMessage("KHÔNG TÌM THẤY", `> Không có câu hỏi **#${id}**.`));
    } else if (command === "traloi") {
        if (!await requireOwner(context)) return;
        const input = parseQuestionIdAndText(argument);
        if (!input) {
            await sendMessage(chatId, formatWarningMessage(
                "SAI CÚ PHÁP",
                "> **Cú pháp:** /traloi [ID] [câu trả lời]\n> Có thể xuống dòng trong phần câu trả lời. Dùng **/danhsach** để xem ID."
            ));
            return;
        }
        try {
            const question = answerQuestion(input.id, input.text);
            await sendMessage(chatId, question
                ? `# {green}✓ ĐÃ TRẢ LỜI CÂU #${question.id}{/green}\n\n**Hỏi:** ${escapeMarkdown(question.text)}\n> **Trả lời:** ${escapeMarkdown(question.answer)}`
                : formatWarningMessage("KHÔNG TÌM THẤY", `> Không có câu hỏi **#${input.id}**.`));
        } catch (error) {
            await sendMessage(chatId, formatWarningMessage("KHÔNG THỂ TRẢ LỜI", `> ${escapeMarkdown(error.message)}`));
        }
    } else if (command === "congbo") {
        if (!await requireOwner(context)) return;
        const rawYear = String(argument || "").trim();
        if (rawYear && !/^\d{4}$/.test(rawYear)) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /congbo [năm]\n> Có thể bỏ năm để dùng năm hiện tại."));
            return;
        }
        const year = rawYear
            ? Number(rawYear)
            : (getLatestQuestionYear() || Number(getVietnamDateInfo().year));
        const allQuestions = getQuestions(year);
        const unanswered = allQuestions.filter((question) => !question.answer).length;
        const result = await publishBirthdayResults(year);
        if (result.noAnswers) {
            await sendMessage(chatId, formatWarningMessage(
                `CHƯA CÓ CÂU TRẢ LỜI NĂM ${year}`,
                "> Dùng **/traloi [ID] [câu trả lời]** trước khi công bố."
            ));
            return;
        }
        await sendMessage(chatId,
            `# {green}✓ ĐÃ CÔNG BỐ HỎI & ĐÁP ${year}{/green}\n\n` +
            `> **Gửi thành công:** ${result.sent}\n` +
            `> **Đã có cùng bản công bố:** ${result.skipped}\n` +
            `> **Gửi lỗi:** ${result.failed}\n` +
            `> **Câu chưa trả lời (không công bố):** ${unanswered}\n\n` +
            "{orange}Nếu sửa câu hỏi hoặc câu trả lời, chạy /congbo lần nữa sẽ gửi bản cập nhật; bản không đổi sẽ không bị gửi trùng.{/orange}"
        );
    } else if (command === "thongbao") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage(
                "THIẾU NỘI DUNG",
                "> **Cú pháp:** /thongbao [Nội dung cập nhật]\n> **Ví dụ:** /thongbao Đã cập nhật giờ nhận lịch tùy chọn."
            ));
            return;
        }
        const message = `# {green}[THÔNG BÁO CẬP NHẬT]{/green}\n\n${escapeMarkdownMultiline(argument)}`;
        const result = await sendBotAnnouncement(message);
        await sendMessage(
            chatId,
            "# {green}✓ ĐÃ GỬI THÔNG BÁO{/green}\n\n" +
            `> **Tổng cuộc trò chuyện:** ${result.targets}\n` +
            `> **Gửi thành công:** ${result.sent}\n` +
            `> **Gửi lỗi:** ${result.failed}`
        );
    } else if (command === "myid") {
        await sendMessage(
            chatId,
            "# {green}[ID] THÔNG TIN TÀI KHOẢN{/green}\n\n" +
            `> **User ID:** ${escapeMarkdown(context.userId)}\n` +
            `> **Chat ID:** ${escapeMarkdown(context.chatId)}`
        );
    } else if (command === "lichtruc") {
        const todayDuties = getDutyScheduleForDate();
        if (todayDuties && todayDuties.length > 0) {
            await sendMessage(chatId, formatDutyNotification(todayDuties));
        } else {
            await sendMessage(chatId, formatDutyList(getDutySchedules()));
        }
    } else if (command === "themlichtruc" || command === "addlichtruc") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(
                chatId,
                formatWarningMessage(
                    "SAI CÚ PHÁP",
                    "> **Cú pháp:** /themlichtruc [dd/mm] [Tên 1 - Tên 2]\n> **Ví dụ một dòng:** /themlichtruc 25/08 Nhân - Sang\n> **Nhiều dòng:** gửi mỗi lịch trên một dòng sau lệnh."
                )
            );
            return;
        }
        try {
            const items = argument.includes("\n")
                ? addDutySchedules(argument)
                : [addDutySchedule(argument)];
            const summary = items.map((item) =>
                `> **#${item.id}** \`[${escapeMarkdown(item.dateStr)}]\` — \`${escapeMarkdown(item.assigned)}\``
            ).join("\n");
            await sendMessage(chatId, `# {green}✓ ĐÃ THÊM ${items.length} LỊCH TRỰC NHẬT PHÒNG 411{/green}\n\n${summary}`);
        } catch (error) {
            await sendMessage(chatId, formatWarningMessage("KHÔNG THỂ THÊM LỊCH TRỰC NHẬT PHÒNG 411", `> ${escapeMarkdown(error.message)}`));
        }
    } else if (command === "sualichtruc" || command === "editlichtruc") {
        if (!await requireOwner(context)) return;
        const parsed = parseDutyIdOrDateAndText(argument);
        if (!parsed) {
            await sendMessage(
                chatId,
                formatWarningMessage(
                    "SAI CÚ PHÁP",
                    "> **Cú pháp:** /sualichtruc [ID hoặc dd/mm] [Nội dung mới]\n> **Ví dụ:** /sualichtruc #1 [25/08] [Nguyễn Văn A - Võ Văn E]"
                )
            );
            return;
        }
        try {
            const item = updateDutySchedule(parsed.target, parsed.text);
            await sendMessage(
                chatId,
                item
                    ? `# {green}✓ ĐÃ SỬA LỊCH TRỰC NHẬT PHÒNG 411 #${item.id}{/green}\n\n` +
                      `> **Ngày:** \`[${escapeMarkdown(item.dateStr)}]\`\n` +
                      `> **Phân công:** \`[${escapeMarkdown(item.assigned)}]\``
                    : formatWarningMessage("KHÔNG TÌM THẤY", `> Không tìm thấy lịch trực nhật phòng 411 **${escapeMarkdown(parsed.target)}**.`)
            );
        } catch (error) {
            await sendMessage(chatId, formatWarningMessage("KHÔNG THỂ SỬA LỊCH TRỰC NHẬT PHÒNG 411", `> ${escapeMarkdown(error.message)}`));
        }
    } else if (command === "xoalichtruc" || command === "dellichtruc") {
        if (!await requireOwner(context)) return;
        const target = String(argument || "").trim();
        if (!target) {
            await sendMessage(
                chatId,
                formatWarningMessage(
                    "SAI CÚ PHÁP",
                    "> **Cú pháp:** /xoalichtruc [ID hoặc dd/mm]\n> **Ví dụ:** /xoalichtruc #1 hoặc /xoalichtruc 25/08"
                )
            );
            return;
        }
        const deleted = deleteDutySchedule(target);
        await sendMessage(
            chatId,
            deleted
                ? `# {green}✓ ĐÃ XÓA LỊCH TRỰC NHẬT PHÒNG 411 #${deleted.id}{/green}\n\n` +
                  `> **Ngày:** \`[${escapeMarkdown(deleted.dateStr)}]\`\n` +
                  `> **Phân công:** \`[${escapeMarkdown(deleted.assigned)}]\``
                : formatWarningMessage("KHÔNG TÌM THẤY", `> Không tìm thấy lịch trực nhật phòng 411 **${escapeMarkdown(target)}**.`)
        );
    } else if (command === "danhsachlichtruc") {
        const items = getDutySchedules();
        await sendMessage(chatId, formatDutyList(items));
    } else if (command === "dangkylich") {
        enableDutyNotifications(context);
        await sendMessage(
            chatId,
            "# {green}✓ ĐÃ BẬT THÔNG BÁO LỊCH TRỰC{/green}\n\n" +
            "> **Giờ nhận lịch:** 06:00 hằng ngày\n\n" +
            "Dùng **/huydangkylich** để tắt thông báo."
        );
    } else if (command === "huydangkylich" || command === "huylichtruc") {
        if (disableDutyNotifications(context)) {
            await sendMessage(
                chatId,
                "# {green}✓ ĐÃ TẮT THÔNG BÁO LỊCH TRỰC{/green}\n\n" +
                "> Cuộc trò chuyện này sẽ không còn nhận lịch trực nhật lúc 06:00."
            );
        } else {
            await sendMessage(
                chatId,
                formatWarningMessage(
                    "THÔNG BÁO LỊCH TRỰC ĐANG TẮT",
                    "> Dùng **/dangkylich** để nhận lịch trực nhật phòng 411 lúc 06:00 hằng ngày."
                )
            );
        }
    } else if (command === "help") {
        await sendMessage(chatId, formatGeneralHelp());
    } else if (command === "help411") {
        await sendMessage(chatId, formatDutyHelp());
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
    } else if (command === "test6hlichtruc") {
        if (!await requireOwner(context)) return;
        await sendMessage(chatId, "# {orange}[ADMIN TEST] GỬI LỊCH TRỰC 06:00{/orange}\n\nĐang chạy kiểm tra gửi lịch trực nhật phòng 411.");
        const result = await sendDailyDutyNotificationAtSix();
        await sendMessage(
            chatId,
            `# {green}✓ ĐÃ HOÀN TẤT KIỂM TRA GỬI LỊCH TRỰC 06:00{/green}\n\n` +
            `> **Đã gửi:** ${result.sent}\n` +
            `> **Lỗi:** ${result.failed}`
        );
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
    isEligible: (subscription) => isChatEligible(subscription.chatId, "schedule"),
    sendReminder: (subscription, message) => sendNotification(subscription.chatId, message, {
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
                        const delivery = await sendNotification(subscription.chatId, changeMessage, { feature: "schedule", operation: "schedule_change" });
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

// Gửi lịch học cho các đăng ký có cùng giờ thông báo.
async function sendDailySchedulesAtTime(notificationTime = DEFAULT_NOTIFICATION_TIME, deliveryAt = new Date()) {
    const subscriptionsGrouped = groupEnabledSubscriptionsByStudent(notificationTime);
    if (subscriptionsGrouped.size === 0) {
        return { processed: false, matchedStudents: 0, sent: 0, failed: 0 };
    }
    if (runningDailyNotificationTimes.has(notificationTime)) {
        return { processed: false, matchedStudents: subscriptionsGrouped.size, sent: 0, failed: 0 };
    }

    runningDailyNotificationTimes.add(notificationTime);
    const scheduleTarget = resolveScheduleTarget(deliveryAt);
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

        for (const [studentId, targetMap] of subscriptionsGrouped.entries()) {
            try {
                const data = await fetchStudentSchedule(studentId, scheduleTarget.targetDate);

                // 1. Kiểm tra thay đổi lịch trước khi gửi (nếu có)
                try {
                    const result = confirmScheduleChange(data);
                    if (result.confirmed) {
                        const changeMessage = formatScheduleChangeMessage(data, result.changes);
                        // Nếu lần kiểm tra này xác nhận thay đổi, thông báo tới mọi đăng ký
                        // của MSSV, không chỉ nhóm đang nhận lịch ở đúng mốc giờ hiện tại.
                        const allStudentTargets = groupEnabledSubscriptionsByStudent().get(studentId) || targetMap;
                        for (const subscription of allStudentTargets.values()) {
                            const delivery = await sendNotification(subscription.chatId, changeMessage, { feature: "schedule", operation: "schedule_change" });
                            if (delivery.failed) logDiscord("ERROR", `Không thể gửi cảnh báo thay đổi cho chat ${subscription.chatId}: ${delivery.error.message}`);
                        }
                    }
                } catch (changeError) {
                    console.error(`Lỗi kiểm tra thay đổi cho MSSV ${studentId}:`, changeError.message);
                }

                // 2. Gửi lịch học hôm nay cho tất cả các chat đăng ký MSSV này
                const dailyMessage = formatDailySchedule(data, scheduleTarget.targetDate, { referenceDate: deliveryAt });
                for (const subscription of targetMap.values()) {
                    const delivery = await sendNotification(subscription.chatId, dailyMessage, { feature: "schedule", operation: "daily_schedule" });
                    if (delivery.sent) {
                        dispatchResult.sent += 1;
                        console.log(`[${notificationTime}] Đã gửi lịch thành công cho MSSV ${studentId} tới chat ${subscription.chatId}`);
                    } else if (delivery.failed) {
                        dispatchResult.failed += 1;
                        logDiscord("ERROR", `Không thể gửi lịch ${notificationTime} cho chat ${subscription.chatId}: ${delivery.error.message}`);
                    }
                }
            } catch (error) {
                dispatchResult.failed += targetMap.size;
                logDiscord("ERROR", `Không thể gửi lịch ${notificationTime} cho MSSV ${studentId}: ${error.message}`);
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

async function sendDailyDutyNotificationAtSix(date = new Date()) {
    const todayDuties = getDutyScheduleForDate(date);
    if (!todayDuties || todayDuties.length === 0) {
        console.log("[06:00] Không có lịch trực nhật phòng 411 cho ngày hôm nay.");
        return { sent: 0, skipped: 0, failed: 0 };
    }

    const message = formatDutyNotification(todayDuties, date);
    if (!message) return { sent: 0, skipped: 0, failed: 0 };

    const subscriptions = getDutySubscriptions().filter((subscription) => isChatEligible(subscription.chatId, "duty"));
    if (subscriptions.length === 0) {
        console.log("[06:00] Chưa có cuộc trò chuyện nào sử dụng /dangkylich.");
        return { sent: 0, skipped: 0, failed: 0 };
    }

    console.log(`[06:00] Gửi thông báo lịch trực nhật phòng 411 tới ${subscriptions.length} cuộc trò chuyện đã đăng ký...`);
    const result = { sent: 0, skipped: 0, failed: 0 };

    for (const sub of subscriptions) {
        const delivery = await sendNotification(sub.chatId, message, { feature: "duty", operation: "daily_duty" });
        if (delivery.sent) {
            result.sent += 1;
        } else if (delivery.failed) {
            result.failed += 1;
            logDiscord("ERROR", `Không thể gửi thông báo lịch trực nhật phòng 411 cho chat ${sub.chatId}: ${delivery.error.message}`);
        }
    }
    return result;
}

function registerRuntimeJobs(scheduler = schedule) {
    scheduler.scheduleJob({ rule: "*/15 * * * *", tz: TIME_ZONE }, asyncCommand(async () => {
        await checkAndNotifyScheduleChanges();
        await flushPersistenceWrites();
    }));
    scheduler.scheduleJob({ rule: "* * * * *", tz: TIME_ZONE }, asyncCommand(async () => {
        const dailyResult = await sendScheduledDailySchedules();
        const classStartResult = await sendClassStartNotifications();
        if (dailyResult.processed || classStartResult.processed) await flushPersistenceWrites();
    }));
    // Lịch trực phòng 411 có mốc cố định 06:00, độc lập với các giờ nhận lịch học.
    scheduler.scheduleJob({ rule: "0 6 * * *", tz: TIME_ZONE }, asyncCommand(async () => {
        await sendDailyDutyNotificationAtSix();
        await flushPersistenceWrites();
    }));
    scheduler.scheduleJob({ rule: "5 0 27 8 *", tz: TIME_ZONE }, asyncCommand(async () => {
        await sendBirthdayInvitations();
        await flushPersistenceWrites();
    }));
}

async function startRuntime() {
    await initializeFirestorePersistence({
        storeIds: [
            "accessControl",
            "adminAudit",
            "adminLogs",
            "adminSettings",
            "birthdayData",
            "chatDirectory",
            "dutyScheduleData",
            "interactions",
            "classStartNotifications",
            "scheduleSnapshots",
            "subscriptions"
        ]
    });
    if (syncChatDirectoryFromLegacyStores() > 0) await flushPersistenceWrites();
    const adminRuntime = createAdminServer({
        executeCommand: async ({ command, userId, chatId, displayName }) => {
            const parsed = parseCommand(command);
            if (!parsed) throw new Error("Lệnh phải bắt đầu bằng /");
            const context = { userId: String(userId), chatId: String(chatId), userDisplayName: String(displayName || "Dashboard Admin") };
            if (!isOwner(context)) throw new Error("Admin context chưa được cấp quyền");
            const capture = { chatId: context.chatId, messages: [] };
            await dashboardCommandContext.run(capture, () => handleCommand({ text: command, chat: { id: context.chatId, type: "private" }, from: { id: context.userId, display_name: context.userDisplayName } }, parsed));
            return { command, deliveredToChatId: context.chatId, messages: capture.messages };
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
    console.log(`Admin dashboard listening on http://127.0.0.1:${adminRuntime.port}${adminRuntime.basePath}`);
    // Chỉ bật scheduler sau khi state Firestore đã được hydrate vào bộ nhớ.
    registerRuntimeJobs();
    await bot.startPolling();
    console.log(`Bot đã khởi động. Tự động kiểm tra thay đổi lịch, gửi lịch theo giờ đăng ký và nhắc giờ bắt đầu buổi học (${TIME_ZONE}).`);
    logDiscord("INFO", `Bot đã khởi động - timezone ${TIME_ZONE}`);
    await sendBirthdayInvitations();
    await flushPersistenceWrites();
}

bot.on("message", asyncCommand(async (msg) => {
    const text = msg.text || "[không có nội dung]";
    const context = getMessageContext(msg);
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

    // Chat lần đầu tương tác trong ngày 27/08 vẫn nhận lời mời dù lịch 00:05 đã chạy.
    await sendBirthdayInvitations([interaction]);

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
}));

bot.on("polling_error", (error) => {
    if (error.code === "EZALO" && error.message?.includes("408")) return;
    console.error("Lỗi polling:", error);
    logDiscord("ERROR", `polling_error: ${error.message}`);
});

bot.on("error", (error) => {
    console.error("Lỗi bot:", error);
    logDiscord("ERROR", `error: ${error.message}`);
});

if (!isTestEnv) {
    startRuntime().catch((error) => {
        console.error("Không thể khởi động persistence/runtime:", error);
        logDiscord("ERROR", `runtime_startup_error: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    formatBirthdayInvitation,
    formatBirthdayResults,
    formatDutyHelp,
    formatGeneralHelp,
    formatAdminHelp,
    getBroadcastTargets,
    groupSubscriptionsByStudent,
    handleCommand,
    isOwner,
    parseDangKyArgument,
    parseCommand,
    parseQuestionIdAndText,
    publishBirthdayResults,
    registerRuntimeJobs,
    sendBirthdayInvitations,
    sendBotAnnouncement,
    sendClassStartNotifications,
    sendDailyDutyNotificationAtSix,
    sendDailySchedulesAtSix,
    sendDailySchedulesAtTime,
    sendScheduledDailySchedules,
    sendWelcomeMessage,
    suggestCommandCorrection,
    startRuntime
};
