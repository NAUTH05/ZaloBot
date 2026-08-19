process.env.TZ = "Asia/Ho_Chi_Minh";

require("dotenv").config();

const https = require("https");
const crypto = require("crypto");
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
    disableNotifications,
    enableNotifications,
    getAllSubscriptions,
    getEnabledSubscriptions,
    getSubscription,
    DEFAULT_NOTIFICATION_TIME,
    normalizeNotificationTime,
    normalizeNotificationTimes,
    removeNotificationTime,
    saveStudent,
    updateNotificationTime
} = require("./subscriptions");
const { getMessageContext } = require("./userContext");
const {
    captureScheduleChange,
    confirmScheduleChange,
    formatScheduleChangeMessage,
    initializeScheduleSnapshot
} = require("./scheduleChanges");
const { TIME_ZONE, getVietnamDateInfo } = require("./timezone");
const { escapeMarkdown } = require("./richText");
const { getInteractionTargets, recordInteraction } = require("./interactionRegistry");
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

function logDiscord(level, message) {
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
        try {
            await Promise.resolve(bot.sendMessage(chatId, payload, messageOptions));
        } catch (error) {
            if (messageOptions.parse_mode) {
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

function friendlyError(error) {
    if (error?.userMessage) return error.userMessage;
    if (error?.message) return error.message;
    return "Không thể thực hiện yêu cầu lúc này. Bạn vui lòng thử lại sau.";
}

function formatErrorMessage(error) {
    return `# {orange}[X] KHÔNG THỂ THỰC HIỆN{/orange}\n\n${escapeMarkdown(friendlyError(error))}`;
}

function formatWarningMessage(title, message) {
    return `# {orange}[!] ${escapeMarkdown(title)}{/orange}\n\n${message}`;
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
    const ownerUserIds = String(process.env.OWNER_USER_ID || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const ownerChatIds = String(process.env.OWNER_CHAT_ID || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

    if (ownerUserIds.length === 0 && ownerChatIds.length === 0) return false;

    const userMatch = ownerUserIds.length > 0 && ownerUserIds.includes(String(context?.userId));
    const chatMatch = ownerChatIds.length > 0 && ownerChatIds.includes(String(context?.chatId));

    return userMatch || chatMatch;
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

function getBroadcastTargets() {
    const targets = new Map();
    for (const target of getInteractionTargets()) {
        targets.set(String(target.chatId), target);
    }
    // Giữ tương thích với dữ liệu có trước khi sổ tương tác được bổ sung.
    for (const [subscriptionKey, subscription] of Object.entries(getAllSubscriptions())) {
        // Schema cũ dùng trực tiếp chatId làm khóa; schema mới có trường chatId rõ ràng.
        const legacyChatId = !subscriptionKey.includes("::") ? subscriptionKey : null;
        const rawChatId = subscription?.chatId ?? legacyChatId;
        if (rawChatId == null) continue;
        const chatId = String(rawChatId);
        if (!targets.has(chatId)) targets.set(chatId, { chatId, chatType: "unknown" });
    }
    return [...targets.values()];
}

async function sendBotAnnouncement(message) {
    const targets = getBroadcastTargets();
    const result = { targets: targets.length, sent: 0, failed: 0 };
    for (const target of targets) {
        try {
            await sendMessage(target.chatId, message);
            result.sent += 1;
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

> Hãy dùng **/sinhnhat [câu hỏi]** để gửi cho tôi bất kỳ câu hỏi nào bạn muốn.
> **Ví dụ:** /sinhnhat Điều bạn tự hào nhất trong năm qua là gì?

{orange}Cổng nhận câu hỏi mở đến hết ngày 27/08 theo giờ Việt Nam.{/orange}`;
}

function formatBirthdayResults(year, questions) {
    const age = Math.max(0, Number(year) - BIRTH_YEAR);
    const sections = questions.map((question) =>
        `## {orange}[#${question.id}] ${escapeMarkdown(question.text)}{/orange}\n${escapeMarkdown(question.answer)}`
    );
    return `# {green}[SINH NHẬT ${year}] CÔNG BỐ HỎI & ĐÁP{/green}

Cảm ơn mọi người đã gửi câu hỏi cho sinh nhật 27/08 của tôi. Năm nay tôi **${age} tuổi**!

${sections.join("\n\n")}`;
}

async function sendBirthdayInvitations(targets = getBroadcastTargets(), date = new Date()) {
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
            await sendMessage(target.chatId, message);
            markInvitationSent(year, target.chatId, date);
            result.sent += 1;
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
    for (const target of getBroadcastTargets()) {
        if (wasResultSent(year, target.chatId, digest)) {
            result.skipped += 1;
            continue;
        }
        try {
            await sendMessage(target.chatId, message);
            markResultSent(year, target.chatId, digest);
            result.sent += 1;
        } catch (error) {
            result.failed += 1;
            logDiscord("ERROR", `Không thể công bố sinh nhật cho chat ${target.chatId}: ${error.message}`);
        }
    }
    return result;
}

async function sendWelcomeMessage(chatId, displayName = "bạn") {
    const name = escapeMarkdown(displayName || "bạn");
    await sendMessage(
        chatId,
        "# {green}[BOT] LỊCH HỌC LHU{/green}\n\n" +
        `Xin chào **${name}**!\n\n` +
        "> **Tra cứu:** Dùng **/find [MSSV]** để lưu mã sinh viên.\n" +
        "> **Thông báo:** Sau đó dùng **/dangky** để bật thông báo lịch học.\n\n" +
        "{orange}Gõ /help để xem toàn bộ lệnh.{/orange}"
    );
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
    thongbao: "/thongbao Bot vừa cập nhật tính năng mới",
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
    if (!times.length) return "> _Chưa có giờ thông báo nào._";
    return times.map((item) => `- **#${item.id}** — \`${item.time}\``).join("\n");
}

function formatGeneralHelp() {
    return `# {green}[BOT] HƯỚNG DẪN ZALOBOT LHU{/green}

## {orange}[BẮT ĐẦU]{/orange}
- **/start** — Xem lời chào và hướng dẫn bắt đầu. _(Ví dụ: /start)_

## {orange}[TRA CỨU] LỊCH HỌC & THI{/orange}
- **/find [MSSV]** — Kiểm tra và lưu MSSV. _(Ví dụ: /find 123456789)_
- **/lich [MSSV]** — Xem lịch học hôm nay. _(Ví dụ: /lich 123456789)_
- **/lichtuan [MSSV]** — Xem lịch học cả tuần. _(Ví dụ: /lichtuan 123456789)_
- **/lichthi [MSSV]** — Xem danh sách lịch thi học kỳ. _(Ví dụ: /lichthi 123456789)_
- **/lichgv [Tên giảng viên]** — Xem lịch giảng dạy. _(Ví dụ: /lichgv Nguyễn Văn A)_
- **/phongtrong [Cơ sở]** — Tìm phòng trống. _(Ví dụ: /phongtrong 1)_

## {orange}[TRỢ LÝ AI] HỎI ĐÁP{/orange}
- **/ai [Câu hỏi]** — Hỏi AI về lịch học. _(Ví dụ: /ai Trong 2 tuần tới tôi rảnh ngày nào?)_

## {orange}[THÔNG BÁO] LỊCH HỌC{/orange}
- **/dangky [MSSV]** — Bật thông báo với giờ mặc định 06:00. _(Ví dụ: /dangky 123456789)_
- **/dangky [hh:mm]** — Bật thông báo lịch học theo giờ tùy chọn. _(Ví dụ: /dangky 05:30)_
- **/dangky [MSSV] [hh:mm]** — Lưu MSSV và giờ thông báo. _(Ví dụ: /dangky 123456789 05:30)_
- **/danhsachdangky** — Xem các giờ đang nhận lịch. _(Ví dụ: /danhsachdangky)_
- **/suadangky #ID [hh:mm]** — Sửa một giờ thông báo. _(Ví dụ: /suadangky #1 20:00)_
- **/xoadangky #ID** — Xóa một giờ thông báo. _(Ví dụ: /xoadangky #1)_
- **/huythongbao** — Tắt thông báo lịch học. _(Ví dụ: /huythongbao)_

## {orange}[KHÁC] TIỆN ÍCH{/orange}
- **/sinhnhat [Câu hỏi]** — Gửi câu hỏi sinh nhật ngày 27/08. _(Ví dụ: /sinhnhat Điều bạn mong chờ nhất ở tuổi mới là gì?)_
- **/time** — Xem giờ hệ thống. _(Ví dụ: /time)_
- **/myid** — Xem User ID và Chat ID. _(Ví dụ: /myid)_
- **/help** — Xem hướng dẫn này. _(Ví dụ: /help)_`;
}

function formatDutyHelp() {
    return `# {green}[PHÒNG 411] HƯỚNG DẪN TRỰC NHẬT{/green}

## {orange}[LỊCH TRỰC NHẬT PHÒNG 411]{/orange}
- **/lichtruc** — Xem phân công trực nhật hôm nay. _(Ví dụ: /lichtruc)_
- **/danhsachlichtruc** — Xem toàn bộ lịch trực nhật phòng 411. _(Ví dụ: /danhsachlichtruc)_
- **/dangkylich** — Nhận thông báo trực nhật lúc 06:00 hàng ngày. _(Ví dụ: /dangkylich)_
- **/huydangkylich** — Hủy thông báo trực nhật. _(Ví dụ: /huydangkylich)_
`;
}

function formatAdminHelp() {
    return `${formatGeneralHelp()}

${formatDutyHelp()}

# {orange}[ADMIN] TOÀN BỘ LỆNH QUẢN TRỊ{/orange}

## {orange}[PHÂN QUYỀN]{/orange}
- **/blockbot [ID/Tên]** — Chặn dùng Bot. _(Ví dụ: /blockbot 123456)_
- **/unblockbot [ID/Tên]** — Bỏ chặn dùng Bot. _(Ví dụ: /unblockbot 123456)_
- **/blockai [ID/Tên]** — Chặn dùng AI. _(Ví dụ: /blockai 123456)_
- **/unblockai [ID/Tên]** — Bỏ chặn dùng AI. _(Ví dụ: /unblockai 123456)_
- **/allowbot [ID/Tên]** — Thêm vào allowlist Bot. _(Ví dụ: /allowbot 123456)_
- **/unallowbot [ID/Tên]** — Xóa khỏi allowlist Bot. _(Ví dụ: /unallowbot 123456)_
- **/allowai [ID/Tên]** — Thêm vào allowlist AI. _(Ví dụ: /allowai 123456)_
- **/unallowai [ID/Tên]** — Xóa khỏi allowlist AI. _(Ví dụ: /unallowai 123456)_
- **/accessmode [bot|ai] [all|allowlist]** — Đổi chế độ truy cập. _(Ví dụ: /accessmode bot allowlist)_
- **/accesslist** — Xem danh sách phân quyền. _(Ví dụ: /accesslist)_

## {orange}[TRỰC NHẬT PHÒNG 411]{/orange}
- **/themlichtruc [dd/mm] [Tên 1 - Tên 2]** — Thêm lịch trực nhật. _(Ví dụ: /themlichtruc 25/08 Nhân - Sang)_
- **/sualichtruc [ID/Ngày] [Nội dung mới]** — Sửa lịch trực nhật. _(Ví dụ: /sualichtruc 25/08 Nhân - Cường)_
- **/xoalichtruc [ID/Ngày]** — Xóa lịch trực nhật. _(Ví dụ: /xoalichtruc 25/08)_

## {orange}[HỎI ĐÁP SINH NHẬT]{/orange}
- **/danhsach [Năm]** — Xem danh sách câu hỏi. _(Ví dụ: /danhsach 2026)_
- **/them [Câu hỏi]** — Thêm câu hỏi. _(Ví dụ: /them Câu hỏi mới)_
- **/sua [ID] [Câu hỏi mới]** — Sửa câu hỏi. _(Ví dụ: /sua 1 Nội dung mới)_
- **/xoa [ID]** — Xóa câu hỏi. _(Ví dụ: /xoa 1)_
- **/traloi [ID] [Câu trả lời]** — Trả lời câu hỏi. _(Ví dụ: /traloi 1 Nội dung trả lời)_
- **/congbo [Năm]** — Công bố các câu đã trả lời. _(Ví dụ: /congbo 2026)_

## {orange}[KIỂM TRA HỆ THỐNG]{/orange}
- **/thongbao [Nội dung]** — Gửi thông báo cập nhật tới các chat đang dùng bot. _(Ví dụ: /thongbao Bot vừa cập nhật tính năng mới)_
- **/test6h** — Thử gửi lịch học 06:00. _(Ví dụ: /test6h)_
- **/test6hlichtruc** — Thử gửi lịch trực nhật phòng 411. _(Ví dụ: /test6hlichtruc)_
- **/helpadmin** — Xem toàn bộ lệnh. _(Ví dụ: /helpadmin)_`;
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
                "# {green}[OK] ĐÃ LƯU MSSV{/green}\n\n" +
                `**Sinh viên:** ${escapeMarkdown(data.studentName || "Sinh viên")}\n` +
                `> **MSSV:** ${escapeMarkdown(studentId)}\n` +
                `> **Tài khoản:** ${escapeMarkdown(context.userDisplayName || "Tài khoản Zalo này")}\n\n` +
                (subscription.notificationsEnabled
                    ? "{green}[BẬT] Thông báo lịch đang hoạt động.{/green}\n\n"
                    : "{orange}[TẮT] Thông báo lịch chưa được bật.{/orange}\n\n") +
                "> Dùng **/lich** để xem lịch hoặc **/dangky [hh:mm]** để chọn giờ nhận lịch."
            );
        } catch (error) {
            await sendMessage(chatId, formatErrorMessage(error));
        }
    } else if (command === "dangky") {
        const saved = getSubscription(context);
        const parsedRegistration = parseDangKyArgument(argument, saved?.studentId);
        const studentId = parsedRegistration.studentId;
        const notificationTime = parsedRegistration.notificationTime;
        const registrationParts = String(argument || "").trim().split(/\s+/).filter(Boolean);
        const hasExplicitTime = argument.includes(":") || registrationParts.length === 2;

        if (!studentId || (hasExplicitTime && !parsedRegistration.notificationTime)) {
            await sendMessage(
                chatId,
                formatWarningMessage(
                    argument ? "SAI CÚ PHÁP" : "CHƯA LƯU MSSV",
                    "> **Cú pháp:** /dangky [hh:mm] hoặc /dangky [MSSV] [hh:mm]\n> **Ví dụ:** /dangky 05:30\n> Giờ hợp lệ từ **00:00** đến **23:59**."
                )
            );
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
                "# {green}[OK] ĐĂNG KÝ THÀNH CÔNG{/green}\n\n" +
                `**Sinh viên:** ${escapeMarkdown(data.studentName || "Sinh viên")}\n` +
                `> **MSSV:** ${escapeMarkdown(studentId)}\n\n` +
                `{green}Đã đăng ký ${notificationTimes.length} giờ: ${notificationTimes.map((item) => `#${item.id} ${item.time}`).join(", ")}.{/green}`
            );
        } catch (error) {
            await sendMessage(chatId, formatErrorMessage(error));
        }
    } else if (command === "danhsachdangky") {
        const saved = getSubscription(context);
        await sendMessage(
            chatId,
            `# {green}[THÔNG BÁO] DANH SÁCH GIỜ NHẬN LỊCH{/green}\n\n${formatNotificationTimes(saved)}`
        );
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
                ? `# {green}[OK] ĐÃ SỬA GIỜ THÔNG BÁO{/green}\n\n${formatNotificationTimes(updated)}`
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
                ? `# {green}[OK] ĐÃ XÓA GIỜ ${removed.removed.time}{/green}\n\n${formatNotificationTimes(removed.subscription)}`
                : formatWarningMessage("KHÔNG TÌM THẤY", `> Không có giờ thông báo **#${parsedId}**.`)
        );
    } else if (command === "lich") {
        const saved = getSubscription(context);
        const studentId = resolveStudentIdForCommand(argument, saved?.studentId);

        if (!studentId) {
            await sendMessage(
                chatId,
                formatWarningMessage(
                    argument ? "MSSV KHÔNG HỢP LỆ" : "CHƯA LƯU MSSV",
                    argument
                        ? "> MSSV phải gồm đúng **9 chữ số**."
                        : "> Hãy dùng **/find [MSSV]** hoặc **/lich [MSSV]**."
                )
            );
            return;
        }

        try {
            const data = await fetchStudentSchedule(studentId);
            await sendMessage(chatId, formatDailySchedule(data));
        } catch (error) {
            await sendMessage(chatId, formatErrorMessage(error));
        }
    } else if (command === "lichtuan") {
        const saved = getSubscription(context);
        const studentId = resolveStudentIdForCommand(argument, saved?.studentId);

        if (!studentId) {
            await sendMessage(
                chatId,
                formatWarningMessage(
                    argument ? "MSSV KHÔNG HỢP LỆ" : "CHƯA LƯU MSSV",
                    argument
                        ? "> MSSV phải gồm đúng **9 chữ số**."
                        : "> Hãy dùng **/find [MSSV]** hoặc **/lichtuan [MSSV]**."
                )
            );
            return;
        }

        try {
            const data = await fetchStudentSchedule(studentId);
            await sendMessage(chatId, formatWeeklySchedule(data));
        } catch (error) {
            await sendMessage(chatId, formatErrorMessage(error));
        }
    } else if (command === "huythongbao") {
        if (disableNotifications(context)) {
            await sendMessage(
                chatId,
                "# {orange}[TẮT] ĐÃ TẮT THÔNG BÁO{/orange}\n\n" +
                "> Đã tắt tự động gửi thông báo lịch học hàng ngày.\n\n" +
                "{green}MSSV đã lưu vẫn có thể dùng với /lich và /lichtuan.{/green}"
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
                `# {green}[OK] ĐÃ GHI NHẬN CÂU HỎI #${question.id}{/green}\n\n` +
                `> ${escapeMarkdown(question.text)}\n\n` +
                "Cảm ơn bạn! Câu trả lời sẽ được gửi khi chủ BOT dùng **/congbo**."
            );
        } catch (error) {
            await sendMessage(chatId, formatWarningMessage("KHÔNG THỂ GHI NHẬN", `> ${escapeMarkdown(error.message)}`));
        }
    } else if (command === "lichthi") {
        const saved = getSubscription(context);
        const studentId = resolveStudentIdForCommand(argument, saved?.studentId);

        if (!studentId) {
            await sendMessage(
                chatId,
                formatWarningMessage(
                    argument ? "MSSV KHÔNG HỢP LỆ" : "CHƯA LƯU MSSV",
                    argument
                        ? "> MSSV phải gồm đúng **9 chữ số**."
                        : "> Hãy dùng **/find [MSSV]** hoặc **/lichthi [MSSV]**."
                )
            );
            return;
        }

        try {
            const data = await fetchExamSchedule(studentId);
            await sendMessage(chatId, formatExamSchedule(data));
        } catch (error) {
            await sendMessage(chatId, formatErrorMessage(error));
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
                        `> Không tìm thấy giảng viên nào có tên **"${escapeMarkdown(argument)}"**.`
                    )
                );
                return;
            }

            const selected = teachers[0];
            const scheduleData = await fetchTeacherSchedule(selected.teacherId);
            scheduleData.teacherName = selected.fullName;
            await sendMessage(chatId, formatTeacherSchedule(scheduleData));
        } catch (error) {
            await sendMessage(chatId, formatErrorMessage(error));
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
            await sendMessage(
                chatId,
                formatWarningMessage(
                    "CHƯA LƯU MSSV",
                    "> Vui lòng dùng **/find [MSSV]** trước để lưu mã sinh viên trước khi hỏi AI lịch học."
                )
            );
            return;
        }

        try {
            const scheduleData = await fetchStudentSchedule(saved.studentId);
            await sendMessage(chatId, "# {green}[AI] TRỢ LÝ LỊCH HỌC{/green}\n\n_Đang phân tích dữ liệu lịch học..._");
            const answerText = await askScheduleAi(argument, scheduleData);
            await sendMessage(chatId, `# {green}[AI] CÂU TRẢ LỜI{/green}\n\n${answerText}`);
        } catch (error) {
            await sendMessage(chatId, formatErrorMessage(error));
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
            await sendMessage(chatId, `# {green}[OK] ĐÃ THÊM CÂU HỎI #${question.id}{/green}\n\n> ${escapeMarkdown(question.text)}`);
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
                ? `# {green}[OK] ĐÃ SỬA CÂU HỎI #${question.id}{/green}\n\n> ${escapeMarkdown(question.text)}`
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
            ? `# {green}[OK] ĐÃ XÓA CÂU HỎI #${question.id}{/green}\n\n> ${escapeMarkdown(question.text)}`
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
                ? `# {green}[OK] ĐÃ TRẢ LỜI CÂU #${question.id}{/green}\n\n**Hỏi:** ${escapeMarkdown(question.text)}\n> **Trả lời:** ${escapeMarkdown(question.answer)}`
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
            `# {green}[OK] ĐÃ CÔNG BỐ HỎI & ĐÁP ${year}{/green}\n\n` +
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
                "> **Cú pháp:** /thongbao [Nội dung cập nhật]\n> **Ví dụ:** /thongbao Bot vừa cập nhật giờ thông báo tùy chọn."
            ));
            return;
        }
        const message = `# {green}[BOT] THÔNG BÁO CẬP NHẬT{/green}\n\n${escapeMarkdown(argument)}`;
        const result = await sendBotAnnouncement(message);
        await sendMessage(
            chatId,
            "# {green}[OK] ĐÃ GỬI THÔNG BÁO{/green}\n\n" +
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
                    "> **Cú pháp:** /themlichtruc [dd/mm] [Name 1 - Name 2]\n> **Ví dụ một dòng:** /themlichtruc 25/08 Nhân - Sang\n> **Nhiều dòng:** gửi mỗi lịch trên một dòng sau lệnh."
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
            await sendMessage(chatId, `# {green}[OK] ĐÃ THÊM ${items.length} LỊCH TRỰC NHẬT PHÒNG 411{/green}\n\n${summary}`);
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
                    ? `# {green}[OK] ĐÃ SỬA LỊCH TRỰC NHẬT PHÒNG 411 #${item.id}{/green}\n\n` +
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
                ? `# {green}[OK] ĐÃ XÓA LỊCH TRỰC NHẬT PHÒNG 411 #${deleted.id}{/green}\n\n` +
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
            "# {green}[OK] ĐÃ ĐĂNG KÝ LỊCH TRỰC NHẬT PHÒNG 411{/green}\n\n" +
            "> Cuộc trò chuyện này sẽ tự động nhận thông báo lịch trực nhật phòng 411 vào lúc **06:00 sáng** hàng ngày.\n\n" +
            "{orange}Dùng /huydangkylich nếu muốn tắt thông báo.{/orange}"
        );
    } else if (command === "huydangkylich" || command === "huylichtruc") {
        if (disableDutyNotifications(context)) {
            await sendMessage(
                chatId,
                "# {orange}[TẮT] ĐÃ HỦY ĐĂNG KÝ LỊCH TRỰC NHẬT PHÒNG 411{/orange}\n\n" +
                "> Đã tắt tự động gửi thông báo lịch trực nhật phòng 411 lúc 06:00 sáng cho cuộc trò chuyện này."
            );
        } else {
            await sendMessage(
                chatId,
                formatWarningMessage(
                    "CHƯA ĐĂNG KÝ LỊCH TRỰC NHẬT PHÒNG 411",
                    "> Cuộc trò chuyện này chưa đăng ký nhận thông báo lịch trực nhật phòng 411. Dùng **/dangkylich** để bật."
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
        const message = `# {green}[GIỜ] THỜI GIAN HỆ THỐNG{/green}

> **Server ISO:** ${escapeMarkdown(new Date().toISOString())}
> **Giờ Việt Nam:** ${escapeMarkdown(vietnam.formattedDateTime)}
> **Múi giờ bot:** ${escapeMarkdown(TIME_ZONE)}

{green}Bot luôn lập lịch theo giờ Thành phố Hồ Chí Minh.{/green}`;
        await sendMessage(chatId, message);
    } else if (command === "test6h") {
        if (!await requireOwner(context)) return;
        await sendMessage(chatId, "⏰ *[TEST]* Bắt đầu kích hoạt thử nghiệm gửi lịch 06:00...");
        await sendDailySchedulesAtSix();
        await sendMessage(chatId, "✅ *[TEST]* Đã hoàn tất thử nghiệm gửi lịch 06:00.");
    } else if (command === "test6hlichtruc") {
        if (!await requireOwner(context)) return;
        await sendMessage(chatId, "⏰ *[TEST]* Bắt đầu kích hoạt thử nghiệm gửi thông báo lịch trực nhật phòng 411 06:00...");
        const result = await sendDailyDutyNotificationAtSix();
        await sendMessage(
            chatId,
            `✅ *[TEST]* Đã hoàn tất thử nghiệm gửi lịch trực nhật phòng 411 06:00.\n` +
            `> **Đã gửi:** ${result.sent}\n` +
            `> **Lỗi:** ${result.failed}`
        );
    } else {
        const suggestion = suggestCommandCorrection(command);
        await sendMessage(
            chatId,
            formatWarningMessage(
                "LỆNH KHÔNG HỢP LỆ",
                `> Không nhận diện được **/${escapeMarkdown(command)}**.\n> Vui lòng sử dụng **${suggestion}** để sửa cú pháp.`
            )
        );
    }
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
    return groupSubscriptionsByStudent(Object.values(getEnabledSubscriptions()), notificationTime);
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
                        try {
                            await sendMessage(subscription.chatId, changeMessage);
                        } catch (error) {
                            logDiscord("ERROR", `Không thể gửi cảnh báo thay đổi cho chat ${subscription.chatId}: ${error.message}`);
                        }
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
async function sendDailySchedulesAtTime(notificationTime = DEFAULT_NOTIFICATION_TIME) {
    const subscriptionsGrouped = groupEnabledSubscriptionsByStudent(notificationTime);
    if (subscriptionsGrouped.size === 0) {
        return { processed: false, matchedStudents: 0, sent: 0, failed: 0 };
    }
    if (runningDailyNotificationTimes.has(notificationTime)) {
        return { processed: false, matchedStudents: subscriptionsGrouped.size, sent: 0, failed: 0 };
    }

    runningDailyNotificationTimes.add(notificationTime);
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
                const data = await fetchStudentSchedule(studentId);

                // 1. Kiểm tra thay đổi lịch trước khi gửi (nếu có)
                try {
                    const result = confirmScheduleChange(data);
                    if (result.confirmed) {
                        const changeMessage = formatScheduleChangeMessage(data, result.changes);
                        // Nếu lần kiểm tra này xác nhận thay đổi, thông báo tới mọi đăng ký
                        // của MSSV, không chỉ nhóm đang nhận lịch ở đúng mốc giờ hiện tại.
                        const allStudentTargets = groupEnabledSubscriptionsByStudent().get(studentId) || targetMap;
                        for (const subscription of allStudentTargets.values()) {
                            try {
                                await sendMessage(subscription.chatId, changeMessage);
                            } catch (error) {
                                logDiscord("ERROR", `Không thể gửi cảnh báo thay đổi cho chat ${subscription.chatId}: ${error.message}`);
                            }
                        }
                    }
                } catch (changeError) {
                    console.error(`Lỗi kiểm tra thay đổi cho MSSV ${studentId}:`, changeError.message);
                }

                // 2. Gửi lịch học hôm nay cho tất cả các chat đăng ký MSSV này
                const dailyMessage = formatDailySchedule(data);
                for (const subscription of targetMap.values()) {
                    try {
                        await sendMessage(subscription.chatId, dailyMessage);
                        dispatchResult.sent += 1;
                        console.log(`[${notificationTime}] Đã gửi lịch thành công cho MSSV ${studentId} tới chat ${subscription.chatId}`);
                    } catch (error) {
                        dispatchResult.failed += 1;
                        logDiscord("ERROR", `Không thể gửi lịch ${notificationTime} cho chat ${subscription.chatId}: ${error.message}`);
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
    return sendDailySchedulesAtTime(notificationTime);
}

async function sendDailyDutyNotificationAtSix(date = new Date()) {
    const todayDuties = getDutyScheduleForDate(date);
    if (!todayDuties || todayDuties.length === 0) {
        console.log("[06:00] Không có lịch trực nhật phòng 411 cho ngày hôm nay.");
        return { sent: 0, skipped: 0, failed: 0 };
    }

    const message = formatDutyNotification(todayDuties, date);
    if (!message) return { sent: 0, skipped: 0, failed: 0 };

    const subscriptions = getDutySubscriptions();
    if (subscriptions.length === 0) {
        console.log("[06:00] Chưa có cuộc trò chuyện nào sử dụng /dangkylich.");
        return { sent: 0, skipped: 0, failed: 0 };
    }

    console.log(`[06:00] Gửi thông báo lịch trực nhật phòng 411 tới ${subscriptions.length} cuộc trò chuyện đã đăng ký...`);
    const result = { sent: 0, skipped: 0, failed: 0 };

    for (const sub of subscriptions) {
        try {
            await sendMessage(sub.chatId, message);
            result.sent += 1;
        } catch (error) {
            result.failed += 1;
            logDiscord("ERROR", `Không thể gửi thông báo lịch trực nhật phòng 411 cho chat ${sub.chatId}: ${error.message}`);
        }
    }
    return result;
}

async function startRuntime() {
    await initializeFirestorePersistence({
        storeIds: [
            "accessControl",
            "birthdayData",
            "dutyScheduleData",
            "interactions",
            "scheduleSnapshots",
            "subscriptions"
        ]
    });
    // Chỉ bật scheduler sau khi state Firestore đã được hydrate vào bộ nhớ.
    schedule.scheduleJob({ rule: "*/15 * * * *", tz: TIME_ZONE }, asyncCommand(async () => {
        await checkAndNotifyScheduleChanges();
        await flushPersistenceWrites();
    }));
    schedule.scheduleJob({ rule: "* * * * *", tz: TIME_ZONE }, asyncCommand(async () => {
        const result = await sendScheduledDailySchedules();
        if (result.processed) await flushPersistenceWrites();
    }));
    schedule.scheduleJob({ rule: "5 0 27 8 *", tz: TIME_ZONE }, asyncCommand(async () => {
        await sendBirthdayInvitations();
        await flushPersistenceWrites();
    }));
    await bot.startPolling();
    console.log(`Bot đã khởi động. Tự động kiểm tra thay đổi lịch mỗi 15 phút và gửi lịch theo giờ đăng ký (${TIME_ZONE}).`);
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

    logDiscord("INFO", `Tin nhắn từ: ${from}\n> User ID: ${context.userId}\n> Chat ID: ${context.chatId}\n> Chat Title: ${interaction.chatTitle || "Private"}\n> Chat Type: ${interaction.chatType}\n> Nội dung: ${text}`);

    // Kiểm tra quyền sử dụng BOT (Owner luôn được phép)
    if (!isOwner(context)) {
        const botCheck = canUseBot(context);
        if (!botCheck.allowed) {
            await sendMessage(
                context.chatId,
                formatWarningMessage(
                    "KHÔNG CÓ QUYỀN TRUY CẬP",
                    "> Tài khoản hoặc nhóm này hiện đã bị chặn sử dụng ZaloBOT."
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
                "> Không thể phân tích lệnh này.\n> Vui lòng dùng **/help** để xem cú pháp và ví dụ."
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
    sendBirthdayInvitations,
    sendBotAnnouncement,
    sendDailyDutyNotificationAtSix,
    sendDailySchedulesAtSix,
    sendDailySchedulesAtTime,
    sendScheduledDailySchedules,
    sendWelcomeMessage,
    suggestCommandCorrection,
    startRuntime
};
