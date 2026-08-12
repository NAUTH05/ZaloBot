process.env.TZ = "Asia/Ho_Chi_Minh";

require("dotenv").config();

const https = require("https");
const crypto = require("crypto");
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
    getAllSubscriptions,
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
const { getInteractionTargets, recordInteraction } = require("./interactionRegistry");
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

const isTestEnv = process.env.NODE_ENV === "test" || require.main !== module;

if (!process.env.BOT_TOKEN) {
    throw new Error("Thiếu BOT_TOKEN trong file .env");
}

const bot = new ZaloBot(process.env.BOT_TOKEN, { polling: !isTestEnv });

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
        continuationHeader = "# {green}[...] NỘI DUNG TIẾP THEO{/green}",
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
    return `# {red}[X] KHÔNG THỂ THỰC HIỆN{/red}\n\n${escapeMarkdown(friendlyError(error))}`;
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
        .replace(/(\/\w+)@Bot\b(?:\s+[\w\d_]+)*/gi, "$1")
        .replace(/(\/\w+)@[\w\d_]+/gi, "$1")
        .replace(/@Bot\b(?:\s+[\w\d_]+)*/gi, "")
        .replace(/@[\w\d_]+/gi, "")
        .trim();

    if (!clean.startsWith("/")) return null;

    const parts = clean.split(/\s+/);
    const command = parts[0].slice(1).toLowerCase();
    const argument = parts.slice(1).join(" ").trim();

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

    const userMatch = ownerUserIds.length === 0 || ownerUserIds.includes(String(context?.userId));
    const chatMatch = ownerChatIds.length === 0 || ownerChatIds.includes(String(context?.chatId));

    return userMatch && chatMatch;
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

function formatBirthdayInvitation(year) {
    return `# {green}[SINH NHẬT ${year}] HỎI TÔI BẤT KỲ ĐIỀU GÌ{/green}

Hôm nay, **27/08**, là sinh nhật của tôi!

> Hãy dùng **/sinhnhat [câu hỏi]** để gửi cho tôi bất kỳ câu hỏi nào bạn muốn.
> **Ví dụ:** /sinhnhat Điều bạn tự hào nhất trong năm qua là gì?

{orange}Cổng nhận câu hỏi mở đến hết ngày 27/08 theo giờ Việt Nam.{/orange}`;
}

function formatBirthdayResults(year, questions) {
    const sections = questions.map((question) =>
        `## {orange}[#${question.id}] ${escapeMarkdown(question.text)}{/orange}\n${escapeMarkdown(question.answer)}`
    );
    return `# {green}[SINH NHẬT ${year}] CÔNG BỐ HỎI & ĐÁP{/green}

Cảm ơn mọi người đã gửi câu hỏi cho sinh nhật 27/08 của tôi!

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
            await sendMessage(target.chatId, message, {
                continuationHeader: `# {green}[SINH NHẬT ${year}] HỎI & ĐÁP · TIẾP{/green}`
            });
            markResultSent(year, target.chatId, digest);
            result.sent += 1;
        } catch (error) {
            result.failed += 1;
            logDiscord("ERROR", `Không thể công bố sinh nhật cho chat ${target.chatId}: ${error.message}`);
        }
    }
    return result;
}

async function handleCommand(msg, parsedCommand) {
    const context = getMessageContext(msg);
    const chatId = context.chatId;
    const { command, argument } = parsedCommand;

    if (command === "start") {
        const displayName = escapeMarkdown(msg.from?.display_name || "bạn");
        await sendMessage(
            chatId,
            "# {green}[BOT] LỊCH HỌC LHU{/green}\n\n" +
            `Xin chào **${displayName}**!\n\n` +
            "> **Tra cứu:** Dùng **/find [MSSV]** để lưu mã sinh viên.\n" +
            "> **Thông báo:** Sau đó dùng **/dangky** để bật thông báo lịch học.\n\n" +
            "{orange}Gõ /help để xem toàn bộ lệnh.{/orange}"
        );
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
                "> Dùng **/lich** để xem lịch hoặc **/dangky** để nhận lịch lúc 06:00."
            );
        } catch (error) {
            await sendMessage(chatId, formatErrorMessage(error));
        }
    } else if (command === "dangky") {
        const saved = getSubscription(context);
        const studentId = resolveStudentIdForCommand(argument, saved?.studentId);

        if (!studentId) {
            await sendMessage(
                chatId,
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
                chatId,
                "# {green}[OK] ĐĂNG KÝ THÀNH CÔNG{/green}\n\n" +
                `**Sinh viên:** ${escapeMarkdown(data.studentName || "Sinh viên")}\n` +
                `> **MSSV:** ${escapeMarkdown(studentId)}\n\n` +
                "{green}Thông báo lịch học sẽ được tự động gửi vào lúc 06:00 hàng ngày.{/green}"
            );
        } catch (error) {
            await sendMessage(chatId, formatErrorMessage(error));
        }
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
            await sendMessage(chatId, formatDailySchedule(data), {
                continuationHeader: "# {green}[LỊCH] HÔM NAY · TIẾP{/green}"
            });
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
            await sendMessage(chatId, formatWeeklySchedule(data), {
                continuationHeader: "# {green}[LỊCH] TUẦN · TIẾP{/green}"
            });
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
    } else if (command === "myid") {
        await sendMessage(
            chatId,
            "# {green}[ID] THÔNG TIN TÀI KHOẢN{/green}\n\n" +
            `> **User ID:** ${escapeMarkdown(context.userId)}\n` +
            `> **Chat ID:** ${escapeMarkdown(context.chatId)}`
        );
    } else if (command === "help") {
        const ownerSection = isOwner(context)
            ? "\n\n## {orange}[CHỦ BOT] SINH NHẬT{/orange}\n" +
              "- **/danhsach [năm]** — Xem các câu hỏi\n" +
              "- **/them**, **/sua**, **/xoa** — Quản lý câu hỏi\n" +
              "- **/traloi [ID] [nội dung]** — Ghi hoặc sửa câu trả lời\n" +
              "- **/congbo [năm]** — Gửi các câu đã trả lời tới mọi chat"
            : "";

        const helpMessage = `# {green}[BOT] HƯỚNG DẪN ZALOBOT{/green}

## {orange}[TRA CỨU] LỊCH HỌC{/orange}
- **/find [MSSV]** — Kiểm tra và lưu MSSV
- **/lich [MSSV]** — Xem lịch học hôm nay
- **/lichtuan [MSSV]** — Xem lịch học cả tuần

> Có thể bỏ \`[MSSV]\` với **/lich** và **/lichtuan** sau khi đã dùng **/find**.

## {orange}[THÔNG BÁO] TỰ ĐỘNG{/orange}
- **/dangky [MSSV]** — Bật nhận thông báo lịch học 06:00 hàng ngày
- **/dangky** — Đăng ký bằng MSSV đã lưu
- **/huythongbao** — Tắt toàn bộ thông báo tự động

## {orange}[HỆ THỐNG] THÔNG TIN{/orange}
- **/time** — Xem giờ hệ thống
- **/myid** — Xem User ID và Chat ID
- **/sinhnhat [câu hỏi]** — Gửi câu hỏi trong ngày 27/08
- **/help** — Xem hướng dẫn này${ownerSection}`;
        await sendMessage(chatId, helpMessage);
    } else if (command === "time") {
        const vietnam = getVietnamDateInfo();
        const message = `# {green}[GIỜ] THỜI GIAN HỆ THỐNG{/green}

> **Server ISO:** ${escapeMarkdown(new Date().toISOString())}
> **Giờ Việt Nam:** ${escapeMarkdown(vietnam.formattedDateTime)}
> **Múi giờ bot:** ${escapeMarkdown(TIME_ZONE)}

{green}Bot luôn lập lịch theo giờ Thành phố Hồ Chí Minh.{/green}`;
        await sendMessage(chatId, message);
    }
}

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
                                continuationHeader: "# {red}[!] LỊCH HỌC THAY ĐỔI · TIẾP{/red}"
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
                            continuationHeader: "# {green}[LỊCH] HÔM NAY · TIẾP{/green}"
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

if (!isTestEnv) {
    schedule.scheduleJob({ rule: "0 1 * * *", tz: TIME_ZONE }, captureSchedulesAtOne);
    schedule.scheduleJob({ rule: "0 6 * * *", tz: TIME_ZONE }, confirmAndNotifyAtSix);
    // 00:05 ngày 27/08 hằng năm. Kiểm tra lúc khởi động ở dưới sẽ bù nếu bot khởi động muộn.
    schedule.scheduleJob({ rule: "5 0 27 8 *", tz: TIME_ZONE }, asyncCommand(async () => {
        await sendBirthdayInvitations();
    }));
}

bot.on("message", asyncCommand(async (msg) => {
    const text = msg.text || "[không có nội dung]";
    const context = getMessageContext(msg);
    const from = msg.from?.display_name || context.userId || "unknown";
    console.log("Tin nhắn mới:", from, "→", text);
    logDiscord("INFO", `Tin nhắn từ ${from} (${context.userId}) trong chat ${context.chatId}: ${text}`);
    const interaction = recordInteraction(context, msg);

    // Chat lần đầu tương tác trong ngày 27/08 vẫn nhận lời mời dù lịch 00:05 đã chạy.
    await sendBirthdayInvitations([interaction]);

    const parsed = parseCommand(msg.text);
    if (parsed) {
        await handleCommand(msg, parsed);
    }
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
    console.log(`Bot đã khởi động. Kiểm tra lịch lúc 01:00 và 06:00 (${TIME_ZONE}).`);
    logDiscord("INFO", `Bot đã khởi động - timezone ${TIME_ZONE}`);

    // Không chờ tới năm sau nếu tiến trình được khởi động lại trong chính ngày sinh nhật.
    sendBirthdayInvitations().catch((error) => {
        console.error("Lỗi gửi thông báo sinh nhật khi khởi động:", error);
        logDiscord("ERROR", `birthday_startup_error: ${error.message}`);
    });
}

module.exports = {
    formatBirthdayInvitation,
    formatBirthdayResults,
    getBroadcastTargets,
    handleCommand,
    isOwner,
    parseCommand,
    parseQuestionIdAndText,
    publishBirthdayResults,
    sendBirthdayInvitations
};
