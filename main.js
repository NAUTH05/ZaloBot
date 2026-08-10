process.env.TZ = "Asia/Ho_Chi_Minh";

require("dotenv").config();

const https = require("https");
const schedule = require("node-schedule");
const ZaloBot = require("node-zalo-bot");
const {
    fetchStudentSchedule,
    formatDailySchedule,
    formatWeeklySchedule,
    normalizeStudentId,
    resolveStudentIdForCommand
} = require("./lhuSchedule");
const {
    disableNotifications,
    enableNotifications,
    getEnabledSubscriptions,
    getSubscription,
    saveStudent
} = require("./subscriptions");
const { getMessageContext } = require("./userContext");
const {
    captureScheduleChange,
    confirmScheduleChange,
    formatScheduleChangeMessage,
    initializeScheduleSnapshot
} = require("./scheduleChanges");
const { TIME_ZONE, getVietnamDateInfo } = require("./timezone");

if (!process.env.BOT_TOKEN) {
    throw new Error("Thiếu BOT_TOKEN trong file .env");
}

const bot = new ZaloBot(process.env.BOT_TOKEN, { polling: true });

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
    const { continuationHeader = "", ...messageOptions } = options;
    const maxLength = messageOptions.parse_mode ? 1600 : 1800;
    const chunks = [];
    let current = "";

    for (const line of String(text).split("\n")) {
        const next = current ? `${current}\n${line}` : line;
        if (next.length <= maxLength) {
            current = next;
            continue;
        }

        if (current) chunks.push(current);
        if (line.length <= maxLength) {
            current = line;
        } else {
            for (let index = 0; index < line.length; index += maxLength) {
                chunks.push(line.slice(index, index + maxLength));
            }
            current = "";
        }
    }

    if (current) chunks.push(current);
    for (let index = 0; index < chunks.length; index += 1) {
        const prefix = index > 0 && continuationHeader ? `${continuationHeader}\n\n` : "";
        await Promise.resolve(bot.sendMessage(chatId, `${prefix}${chunks[index]}`, messageOptions));
    }
}

function getCommandArgument(match) {
    return (match?.[1] || "").trim();
}

function friendlyError(error) {
    if (error?.userMessage) return error.userMessage;
    return "Không thể lấy lịch từ LHU lúc này. Bạn vui lòng thử lại sau.";
}

function asyncCommand(handler) {
    return (msg, match) => {
        Promise.resolve(handler(msg, match)).catch((error) => {
            console.error("Lỗi xử lý lệnh:", error);
            logDiscord("ERROR", `command_error: ${error.message}`);
        });
    };
}

bot.onText(/^\/start\s*$/i, (msg) => {
    sendMessage(
        msg.chat.id,
        `Chào ${msg.from?.display_name || "bạn"}!\n` +
        `Dùng /find [MSSV] để lưu MSSV, sau đó dùng /dangky để bật thông báo lịch học.`
    ).catch(() => {});
});

bot.onText(/^\/find(?:\s+(.+))?\s*$/i, asyncCommand(async (msg, match) => {
    const context = getMessageContext(msg);
    const studentId = normalizeStudentId(getCommandArgument(match));
    if (!studentId) {
        await sendMessage(msg.chat.id, "Cú pháp: /find [MSSV]\nVí dụ: /find 123456789");
        return;
    }

    try {
        const data = await fetchStudentSchedule(studentId);
        const subscription = saveStudent(context, {
            studentId,
            studentName: data.studentName
        });

        await sendMessage(
            msg.chat.id,
            `✅ Đã tìm thấy ${data.studentName || "sinh viên"} (${studentId}).\n` +
            (subscription.notificationsEnabled
                ? `MSSV đã được lưu riêng cho ${context.userDisplayName || "tài khoản Zalo này"} và thông báo vẫn đang bật.\n`
                : `Bot đã lưu MSSV riêng cho ${context.userDisplayName || "tài khoản Zalo này"}, nhưng chưa bật thông báo.\n`) +
            `Dùng /lich để xem lịch hoặc /dangky để nhận lịch lúc 06:00 và cảnh báo khi lịch thay đổi.`
        );
    } catch (error) {
        await sendMessage(msg.chat.id, `❌ ${friendlyError(error)}`);
    }
}));

bot.onText(/^\/dangky(?:\s+(.+))?\s*$/i, asyncCommand(async (msg, match) => {
    const context = getMessageContext(msg);
    const argument = getCommandArgument(match);
    const saved = getSubscription(context);
    const studentId = resolveStudentIdForCommand(argument, saved?.studentId);

    if (!studentId) {
        await sendMessage(
            msg.chat.id,
            argument
                ? "MSSV không hợp lệ. MSSV phải gồm đúng 9 chữ số."
                : "Bạn chưa lưu MSSV. Hãy dùng /find [MSSV] hoặc /dangky [MSSV]."
        );
        return;
    }

    try {
        const data = await fetchStudentSchedule(studentId);
        const wasAlreadyWatched = Object.values(getEnabledSubscriptions())
            .some((subscription) => subscription.studentId === studentId);
        enableNotifications(context, {
            studentId,
            studentName: data.studentName
        });
        initializeScheduleSnapshot(data, new Date(), !wasAlreadyWatched);
        await sendMessage(
            msg.chat.id,
            `🔔 Đăng ký thành công cho ${data.studentName || "sinh viên"} (${studentId}).\n` +
            `Bot sẽ kiểm tra lịch lần 1 lúc 01:00, xác nhận lần 2 và gửi thông báo lúc 06:00 mỗi ngày.\n` +
            `Chỉ thay đổi xuất hiện giống nhau ở cả hai lần mới được thông báo.`
        );
    } catch (error) {
        await sendMessage(msg.chat.id, `❌ ${friendlyError(error)}`);
    }
}));

bot.onText(/^\/lich(?:\s+(.+))?\s*$/i, asyncCommand(async (msg, match) => {
    const context = getMessageContext(msg);
    const argument = getCommandArgument(match);
    const saved = getSubscription(context);
    const studentId = resolveStudentIdForCommand(argument, saved?.studentId);

    if (!studentId) {
        await sendMessage(
            msg.chat.id,
            argument
                ? "MSSV không hợp lệ. MSSV phải gồm đúng 9 chữ số."
                : "Bạn chưa lưu MSSV. Hãy dùng /find [MSSV] hoặc /lich [MSSV]."
        );
        return;
    }

    try {
        const data = await fetchStudentSchedule(studentId);
        await sendMessage(msg.chat.id, formatDailySchedule(data));
    } catch (error) {
        await sendMessage(msg.chat.id, `❌ ${friendlyError(error)}`);
    }
}));

bot.onText(/^\/lichtuan(?:\s+(.+))?\s*$/i, asyncCommand(async (msg, match) => {
    const context = getMessageContext(msg);
    const argument = getCommandArgument(match);
    const saved = getSubscription(context);
    const studentId = resolveStudentIdForCommand(argument, saved?.studentId);

    if (!studentId) {
        await sendMessage(
            msg.chat.id,
            argument
                ? "MSSV không hợp lệ. MSSV phải gồm đúng 9 chữ số."
                : "Bạn chưa lưu MSSV. Hãy dùng /find [MSSV] hoặc /lichtuan [MSSV]."
        );
        return;
    }

    try {
        const data = await fetchStudentSchedule(studentId);
        await sendMessage(msg.chat.id, formatWeeklySchedule(data));
    } catch (error) {
        await sendMessage(msg.chat.id, `❌ ${friendlyError(error)}`);
    }
}));

bot.onText(/^\/huythongbao\s*$/i, asyncCommand(async (msg) => {
    const context = getMessageContext(msg);
    if (disableNotifications(context)) {
        await sendMessage(msg.chat.id, "🔕 Đã tắt lịch 06:00 và cảnh báo thay đổi. MSSV đã lưu vẫn có thể dùng với /lich.");
    } else {
        await sendMessage(msg.chat.id, "Cuộc trò chuyện này chưa đăng ký thông báo lịch học.");
    }
}));

bot.onText(/^\/help\s*$/i, (msg) => {
    const helpMessage = `Các lệnh có sẵn:
/find [MSSV] - Kiểm tra và lưu MSSV, không tự bật thông báo
/dangky [MSSV] - Kiểm tra 01:00, xác nhận và nhận lịch lúc 06:00
/dangky - Đăng ký bằng MSSV đã lưu qua /find
/lich [MSSV] - Xem lịch học hôm nay của MSSV
/lich - Xem lịch của MSSV đã lưu bằng /find
/lichtuan [MSSV] - Xem lịch từ Thứ Hai đến Chủ nhật
/lichtuan - Xem lịch tuần của MSSV đã lưu
/huythongbao - Tắt kiểm tra 01:00, lịch 06:00 và cảnh báo
/time - Xem giờ máy chủ và giờ Việt Nam
/help - Xem hướng dẫn`;
    sendMessage(msg.chat.id, helpMessage).catch(() => {});
});

bot.onText(/^\/time\s*$/i, (msg) => {
    const vietnam = getVietnamDateInfo();
    const message = `Server ISO: ${new Date().toISOString()}\nGiờ Việt Nam: ${vietnam.formattedDateTime}\nMúi giờ bot: ${TIME_ZONE}`;
    sendMessage(msg.chat.id, message).catch(() => {});
});

function groupEnabledSubscriptionsByStudent() {
    const grouped = new Map();
    for (const subscription of Object.values(getEnabledSubscriptions())) {
        const targets = grouped.get(subscription.studentId) || new Map();
        // Một MSSV chỉ gửi một lần vào cùng một chat, dù nhiều thành viên cùng đăng ký.
        targets.set(subscription.chatId, subscription);
        grouped.set(subscription.studentId, targets);
    }
    return grouped;
}

let scheduledCheckRunning = false;

// 01:00 giờ Việt Nam: chụp lịch lần 1, không gửi bất kỳ thông báo nào.
async function captureSchedulesAtOne() {
    if (scheduledCheckRunning) return;
    scheduledCheckRunning = true;
    try {
        for (const studentId of groupEnabledSubscriptionsByStudent().keys()) {
            try {
                const data = await fetchStudentSchedule(studentId);
                captureScheduleChange(data);
            } catch (error) {
                logDiscord("ERROR", `Không thể chụp lịch 01:00 cho MSSV ${studentId}: ${error.message}`);
            }
        }
    } finally {
        scheduledCheckRunning = false;
    }
}

// 06:00 giờ Việt Nam: xác nhận thay đổi lần 2, báo thay đổi rồi gửi lịch hôm nay.
async function confirmAndNotifyAtSix() {
    if (scheduledCheckRunning) return;
    scheduledCheckRunning = true;
    try {
        for (const [studentId, targetMap] of groupEnabledSubscriptionsByStudent().entries()) {
            try {
                const data = await fetchStudentSchedule(studentId);
                const result = confirmScheduleChange(data);

                if (result.confirmed) {
                    const changeMessage = formatScheduleChangeMessage(data, result.changes);
                    for (const subscription of targetMap.values()) {
                        try {
                            await sendMessage(subscription.chatId, changeMessage, {
                                parse_mode: "markdown",
                                continuationHeader: "# {red}⚠️ LỊCH HỌC THAY ĐỔI · TIẾP{/red}"
                            });
                        } catch (error) {
                            logDiscord("ERROR", `Không thể gửi cảnh báo thay đổi cho chat ${subscription.chatId}: ${error.message}`);
                        }
                    }
                }

                const dailyMessage = formatDailySchedule(data);
                for (const subscription of targetMap.values()) {
                    try {
                        await sendMessage(subscription.chatId, dailyMessage);
                    } catch (error) {
                        logDiscord("ERROR", `Không thể gửi lịch 06:00 cho chat ${subscription.chatId}: ${error.message}`);
                    }
                }
            } catch (error) {
                logDiscord("ERROR", `Không thể kiểm tra lịch 06:00 cho MSSV ${studentId}: ${error.message}`);
            }
        }
    } finally {
        scheduledCheckRunning = false;
    }
}

schedule.scheduleJob({ rule: "0 1 * * *", tz: TIME_ZONE }, captureSchedulesAtOne);
schedule.scheduleJob({ rule: "0 6 * * *", tz: TIME_ZONE }, confirmAndNotifyAtSix);

bot.on("message", (msg) => {
    const text = msg.text || "[không có nội dung]";
    const context = getMessageContext(msg);
    const from = msg.from?.display_name || context.userId || "unknown";
    console.log("Tin nhắn mới:", from, "→", text);
    logDiscord("INFO", `Tin nhắn từ ${from} (${context.userId}) trong chat ${context.chatId}: ${text}`);
});

bot.on("polling_error", (error) => {
    if (error.code === "EZALO" && error.message?.includes("408")) return;
    console.error("Lỗi polling:", error);
    logDiscord("ERROR", `polling_error: ${error.message}`);
});

bot.on("error", (error) => {
    console.error("Lỗi bot:", error);
    logDiscord("ERROR", `error: ${error.message}`);
});

console.log(`Bot đã khởi động. Kiểm tra lịch lúc 01:00 và 06:00 (${TIME_ZONE}).`);
logDiscord("INFO", `Bot đã khởi động - timezone ${TIME_ZONE}`);
