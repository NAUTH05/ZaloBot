process.env.TZ = "Asia/Ho_Chi_Minh";

require("dotenv").config();

const https = require("https");
const schedule = require("node-schedule");
const ZaloBot = require("node-zalo-bot");
const {
    fetchStudentSchedule,
    formatDailySchedule,
    normalizeStudentId
} = require("./lhuSchedule");
const {
    getAllSubscriptions,
    getSubscription,
    removeSubscription,
    saveSubscription
} = require("./subscriptions");
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

async function sendMessage(chatId, text) {
    // Chia tin dài theo dòng để tránh vượt giới hạn tin nhắn của Zalo.
    const maxLength = 1800;
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
    for (const chunk of chunks) {
        await Promise.resolve(bot.sendMessage(chatId, chunk));
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
        `Chào ${msg.from?.display_name || "bạn"}!\nDùng /find [MSSV] để lưu MSSV và bật thông báo lịch học lúc 06:00 mỗi ngày.`
    ).catch(() => {});
});

bot.onText(/^\/find(?:\s+(.+))?\s*$/i, asyncCommand(async (msg, match) => {
    const studentId = normalizeStudentId(getCommandArgument(match));
    if (!studentId) {
        await sendMessage(msg.chat.id, "Cú pháp: /find [MSSV]\nVí dụ: /find 123456789");
        return;
    }

    try {
        const data = await fetchStudentSchedule(studentId);
        saveSubscription(msg.chat.id, {
            studentId,
            studentName: data.studentName
        });

        await sendMessage(
            msg.chat.id,
            `✅ Đã tìm thấy ${data.studentName || "sinh viên"} (${studentId}).\n` +
            `Bot đã lưu MSSV cho cuộc trò chuyện này và sẽ gửi lịch học lúc 06:00 mỗi ngày theo giờ Việt Nam.\n` +
            `Dùng /lich hoặc /lich ${studentId} để xem lịch hôm nay.`
        );
    } catch (error) {
        await sendMessage(msg.chat.id, `❌ ${friendlyError(error)}`);
    }
}));

bot.onText(/^\/lich(?:\s+(.+))?\s*$/i, asyncCommand(async (msg, match) => {
    const argument = getCommandArgument(match);
    const saved = getSubscription(msg.chat.id);
    const studentId = argument ? normalizeStudentId(argument) : saved?.studentId;

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

bot.onText(/^\/huythongbao\s*$/i, asyncCommand(async (msg) => {
    if (removeSubscription(msg.chat.id)) {
        await sendMessage(msg.chat.id, "🔕 Đã tắt thông báo lịch học hằng ngày cho cuộc trò chuyện này.");
    } else {
        await sendMessage(msg.chat.id, "Cuộc trò chuyện này chưa đăng ký thông báo lịch học.");
    }
}));

bot.onText(/^\/help\s*$/i, (msg) => {
    const helpMessage = `Các lệnh có sẵn:
/find [MSSV] - Kiểm tra, lưu MSSV và bật thông báo 06:00 hằng ngày
/lich [MSSV] - Xem lịch học hôm nay của MSSV
/lich - Xem lịch của MSSV đã lưu bằng /find
/huythongbao - Tắt thông báo lịch học hằng ngày
/time - Xem giờ máy chủ và giờ Việt Nam
/help - Xem hướng dẫn`;
    sendMessage(msg.chat.id, helpMessage).catch(() => {});
});

bot.onText(/^\/time\s*$/i, (msg) => {
    const vietnam = getVietnamDateInfo();
    const message = `Server ISO: ${new Date().toISOString()}\nGiờ Việt Nam: ${vietnam.formattedDateTime}\nMúi giờ bot: ${TIME_ZONE}`;
    sendMessage(msg.chat.id, message).catch(() => {});
});

// Luôn chạy lúc 06:00 tại TP.HCM, không phụ thuộc múi giờ được cấu hình trên VPS.
schedule.scheduleJob({ rule: "0 6 * * *", tz: TIME_ZONE }, async () => {
    const subscriptions = getAllSubscriptions();
    const scheduleCache = new Map();

    for (const [chatId, subscription] of Object.entries(subscriptions)) {
        try {
            let dataPromise = scheduleCache.get(subscription.studentId);
            if (!dataPromise) {
                dataPromise = fetchStudentSchedule(subscription.studentId);
                scheduleCache.set(subscription.studentId, dataPromise);
            }
            const data = await dataPromise;
            await sendMessage(chatId, formatDailySchedule(data));
        } catch (error) {
            logDiscord(
                "ERROR",
                `Không thể gửi lịch cho chat ${chatId}, MSSV ${subscription.studentId}: ${error.message}`
            );
        }
    }
});

bot.on("message", (msg) => {
    const text = msg.text || "[không có nội dung]";
    const from = msg.from?.display_name || msg.chat?.id || "unknown";
    console.log("Tin nhắn mới:", from, "→", text);
    logDiscord("INFO", `Tin nhắn từ ${from}: ${text}`);
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

console.log(`Bot đã khởi động. Lịch tự động chạy lúc 06:00 (${TIME_ZONE}).`);
logDiscord("INFO", `Bot đã khởi động - timezone ${TIME_ZONE}`);
