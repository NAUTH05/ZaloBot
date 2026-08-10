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
const { escapeMarkdown } = require("./richText");

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
    const {
        continuationHeader = "# {green}↪️ NỘI DUNG TIẾP THEO{/green}",
        parse_mode = "markdown",
        ...otherOptions
    } = options;
    const messageOptions = { ...otherOptions, parse_mode };
    const maxLength = 1600;
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

function formatErrorMessage(error) {
    return `# {red}❌ KHÔNG THỂ THỰC HIỆN{/red}\n\n${escapeMarkdown(friendlyError(error))}`;
}

function formatWarningMessage(title, message) {
    return `# {orange}⚠️ ${escapeMarkdown(title)}{/orange}\n\n${message}`;
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
    const displayName = escapeMarkdown(msg.from?.display_name || "bạn");
    sendMessage(
        msg.chat.id,
        "# {green}👋 ZALOBOT LỊCH HỌC LHU{/green}\n\n" +
        `Xin chào **${displayName}**!\n\n` +
        "> 🔎 Dùng **/find [MSSV]** để lưu mã sinh viên.\n" +
        "> 🔔 Sau đó dùng **/dangky** để bật thông báo lịch học.\n\n" +
        "{orange}Gõ /help để xem toàn bộ lệnh.{/orange}"
    ).catch(() => {});
});

bot.onText(/^\/find(?:\s+(.+))?\s*$/i, asyncCommand(async (msg, match) => {
    const context = getMessageContext(msg);
    const studentId = normalizeStudentId(getCommandArgument(match));
    if (!studentId) {
        await sendMessage(msg.chat.id, formatWarningMessage(
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
            msg.chat.id,
            "# {green}✅ ĐÃ LƯU MSSV{/green}\n\n" +
            `👤 **${escapeMarkdown(data.studentName || "Sinh viên")}**\n` +
            `> 🆔 **MSSV:** ${escapeMarkdown(studentId)}\n` +
            `> 📱 **Tài khoản:** ${escapeMarkdown(context.userDisplayName || "Tài khoản Zalo này")}\n\n` +
            (subscription.notificationsEnabled
                ? "{green}🔔 Thông báo lịch đang được bật.{/green}\n\n"
                : "{orange}🔕 Thông báo lịch chưa được bật.{/orange}\n\n") +
            "> Dùng **/lich** để xem lịch hoặc **/dangky** để nhận lịch lúc 06:00."
        );
    } catch (error) {
        await sendMessage(msg.chat.id, formatErrorMessage(error));
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
            formatWarningMessage(
                argument ? "MSSV KHÔNG HỢP LỆ" : "CHƯA LƯU MSSV",
                argument
                    ? "> MSSV phải gồm đúng **9 chữ số**."
                    : "> Hãy dùng **/find [MSSV]** hoặc **/dangky [MSSV]**."
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
            studentName: data.studentName
        });
        initializeScheduleSnapshot(data, new Date(), !wasAlreadyWatched);
        await sendMessage(
            msg.chat.id,
            "# {green}🔔 ĐĂNG KÝ THÀNH CÔNG{/green}\n\n" +
            `👤 **${escapeMarkdown(data.studentName || "Sinh viên")}**\n` +
            `> 🆔 **MSSV:** ${escapeMarkdown(studentId)}\n` +
            "> 🕐 **01:00:** Chụp lịch lần thứ nhất.\n" +
            "> 🕕 **06:00:** Xác nhận thay đổi và gửi lịch hôm nay.\n\n" +
            "{orange}Chỉ thay đổi xuất hiện giống nhau ở cả hai lần mới được thông báo.{/orange}"
        );
    } catch (error) {
        await sendMessage(msg.chat.id, formatErrorMessage(error));
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
        await sendMessage(msg.chat.id, formatDailySchedule(data), {
            continuationHeader: "# {green}📚 LỊCH HÔM NAY · TIẾP{/green}"
        });
    } catch (error) {
        await sendMessage(msg.chat.id, formatErrorMessage(error));
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
        await sendMessage(msg.chat.id, formatWeeklySchedule(data), {
            continuationHeader: "# {green}📚 LỊCH TUẦN · TIẾP{/green}"
        });
    } catch (error) {
        await sendMessage(msg.chat.id, formatErrorMessage(error));
    }
}));

bot.onText(/^\/huythongbao\s*$/i, asyncCommand(async (msg) => {
    const context = getMessageContext(msg);
    if (disableNotifications(context)) {
        await sendMessage(
            msg.chat.id,
            "# {orange}🔕 ĐÃ TẮT THÔNG BÁO{/orange}\n\n" +
            "> Bot sẽ không kiểm tra lịch lúc 01:00 hoặc gửi lịch lúc 06:00.\n\n" +
            "{green}MSSV đã lưu vẫn có thể dùng với /lich và /lichtuan.{/green}"
        );
    } else {
        await sendMessage(
            msg.chat.id,
            formatWarningMessage(
                "CHƯA ĐĂNG KÝ THÔNG BÁO",
                "> Dùng **/dangky** để bật thông báo lịch học."
            )
        );
    }
}));

bot.onText(/^\/help\s*$/i, (msg) => {
    const helpMessage = `# {green}🤖 HƯỚNG DẪN ZALOBOT{/green}

## {orange}🔎 TRA CỨU LỊCH{/orange}
- **/find [MSSV]** — Kiểm tra và lưu MSSV
- **/lich [MSSV]** — Xem lịch hôm nay
- **/lichtuan [MSSV]** — Xem lịch cả tuần

> Có thể bỏ `[MSSV]` với **/lich** và **/lichtuan** sau khi đã dùng **/find**.

## {orange}🔔 THÔNG BÁO{/orange}
- **/dangky [MSSV]** — Bật kiểm tra 01:00 và thông báo 06:00
- **/dangky** — Đăng ký bằng MSSV đã lưu
- **/huythongbao** — Tắt toàn bộ thông báo tự động

## {orange}⚙️ HỆ THỐNG{/orange}
- **/time** — Xem giờ máy chủ và giờ Việt Nam
- **/help** — Xem hướng dẫn này`;
    sendMessage(msg.chat.id, helpMessage).catch(() => {});
});

bot.onText(/^\/time\s*$/i, (msg) => {
    const vietnam = getVietnamDateInfo();
    const message = `# {green}🕐 THỜI GIAN HỆ THỐNG{/green}

> 🖥️ **Server ISO:** ${escapeMarkdown(new Date().toISOString())}
> 🇻🇳 **Giờ Việt Nam:** ${escapeMarkdown(vietnam.formattedDateTime)}
> 🌏 **Múi giờ bot:** ${escapeMarkdown(TIME_ZONE)}

{green}Bot luôn lập lịch theo giờ Thành phố Hồ Chí Minh.{/green}`;
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
                        await sendMessage(subscription.chatId, dailyMessage, {
                            continuationHeader: "# {green}📚 LỊCH HÔM NAY · TIẾP{/green}"
                        });
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
