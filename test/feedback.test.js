// ============================================================================
// Hỗ trợ / góp ý: gửi, lưu, trả lời, gửi tiếp, xử lý lại, và cách ly giữa các bot.
//
// Bài quan trọng nhất là cách ly: hai bot có thể có CÙNG chatId. Trả lời phải tới
// đúng cuộc trò chuyện của đúng bot, không bao giờ chỉ dựa vào chatId.
// ============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------------
// Firestore giả: giữ dữ liệu trong bộ nhớ, đếm số lần ghi.
// ---------------------------------------------------------------------------
function installFakePersistence() {
    const persistencePath = require.resolve(path.join(ROOT, "firestorePersistence"));
    const real = require(persistencePath);
    const memoryFiles = new Map();
    const writes = { count: 0 };
    const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
    const fileKey = (filePath, defaultPath) => path.resolve(filePath || defaultPath);

    require.cache[persistencePath] = {
        id: persistencePath, filename: persistencePath, loaded: true,
        exports: {
            ...real,
            readJsonStore: (filePath, defaultPath, fallback) => {
                const key = fileKey(filePath, defaultPath);
                if (!memoryFiles.has(key)) memoryFiles.set(key, clone(fallback) ?? null);
                return clone(memoryFiles.get(key));
            },
            writeJsonStore: (filePath, defaultPath, value) => {
                writes.count += 1;
                memoryFiles.set(fileKey(filePath, defaultPath), clone(value));
            },
            flushPersistenceWrites: async () => undefined,
            getPersistenceStatus: () => ({ backend: "test" })
        }
    };
    return { memoryFiles, writes, clone, fileKey };
}

// Cài một lần: các module lấy hàm persistence ngay lúc require.
const fake = installFakePersistence();

const feedback = require("../feedback");
const { registerBots, clearBots, runWithBot, getCurrentBotId } = require("../botContext");
const { createOfficialProvider } = require("../providers/officialProvider");
const { createZcaProvider } = require("../providers/zca/zcaProvider");

function tempFile(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-test-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, "feedbackTickets.json");
}

// Nhà cung cấp chính thức với client giả ghi lại mọi lần gửi.
function officialWithRecorder(botId, token, options = {}) {
    const provider = createOfficialProvider({ botId, token });
    provider.sent = [];
    provider.failSend = Boolean(options.failSend);
    provider.client = {
        on() { return this; },
        startPolling: async () => true,
        stopPolling: async () => true,
        getMe: async () => ({ name: `Bot ${botId}` }),
        sendMessage: async (chatId, text) => {
            if (provider.failSend) throw new Error("EZALO: 422 You are not permitted to send messages to this chat_id");
            provider.sent.push({ chatId: String(chatId), text });
            return { ok: true };
        }
    };
    return provider;
}

/* ========================================================================== */
/* Gửi và lưu                                                                 */
/* ========================================================================== */

test("tạo yêu cầu lưu đủ trường cần thiết", (t) => {
    const filePath = tempFile(t);
    const { ticket, duplicate } = feedback.createTicket({
        botId: "bot1", chatId: "chat-1", chatType: "private",
        userId: "user-1", displayName: "Nguyễn Văn A",
        message: "Lịch học hôm nay không được gửi tới"
    }, filePath);

    assert.equal(duplicate, false);
    assert.match(ticket.ticketId, /^FB-[0-9A-F]{8}$/);
    assert.equal(ticket.botId, "bot1");
    assert.equal(ticket.chatId, "chat-1");
    assert.equal(ticket.chatType, "private");
    assert.equal(ticket.userId, "user-1");
    assert.equal(ticket.displayName, "Nguyễn Văn A");
    assert.equal(ticket.status, "open");
    assert.equal(ticket.unread, true);
    assert.ok(ticket.createdAt && ticket.updatedAt, "phải có mốc thời gian");
    assert.deepEqual(ticket.replies, [], "chưa có trả lời nào");
});

test("nội dung rỗng hoặc thiếu chatId bị từ chối rõ ràng", (t) => {
    const filePath = tempFile(t);
    assert.throws(() => feedback.createTicket({ botId: "bot1", chatId: "c", message: "   " }, filePath), /nội dung/);
    assert.throws(() => feedback.createTicket({ botId: "bot1", chatId: "", message: "abc" }, filePath), /chatId/);
});

test("nội dung quá dài bị cắt bớt thay vì làm hỏng store", (t) => {
    const filePath = tempFile(t);
    const { ticket } = feedback.createTicket({
        botId: "bot1", chatId: "chat-1", message: "x".repeat(5000)
    }, filePath);
    assert.ok(ticket.message.length <= feedback.MAX_MESSAGE_LENGTH);
});

test("cùng mã tin nhắn nguồn KHÔNG tạo yêu cầu trùng", (t) => {
    const filePath = tempFile(t);
    const input = {
        botId: "bot1", chatId: "chat-1", userId: "u1",
        message: "Gửi một lần", sourceMessageId: "msg-abc"
    };
    const first = feedback.createTicket(input, filePath);
    const second = feedback.createTicket(input, filePath);

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true, "Zalo gửi lại cùng update thì không tạo thêm");
    assert.equal(second.ticket.ticketId, first.ticket.ticketId);
    assert.equal(feedback.getCounts(filePath).total, 1);
});

test("thiếu mã tin nhắn nguồn thì vẫn lưu, chỉ là không chống trùng", (t) => {
    const filePath = tempFile(t);
    feedback.createTicket({ botId: "bot1", chatId: "chat-1", message: "a" }, filePath);
    feedback.createTicket({ botId: "bot1", chatId: "chat-1", message: "b" }, filePath);
    assert.equal(feedback.getCounts(filePath).total, 2);
});

/* ========================================================================== */
/* Cách ly giữa các bot — yêu cầu quan trọng nhất                             */
/* ========================================================================== */

test("hai bot có CÙNG chatId thì yêu cầu hoàn toàn tách biệt", (t) => {
    const filePath = tempFile(t);

    const bot1 = feedback.createTicket({
        botId: "bot1", chatId: "SAME-CHAT", userId: "SAME-USER", message: "Từ bot1"
    }, filePath).ticket;
    const bot2 = feedback.createTicket({
        botId: "bot2", chatId: "SAME-CHAT", userId: "SAME-USER", message: "Từ bot2"
    }, filePath).ticket;

    assert.notEqual(bot1.ticketId, bot2.ticketId, "phải là hai yêu cầu khác nhau");
    assert.equal(feedback.getCounts(filePath).total, 2);

    // Tra cứu chỉ trong ngăn của bot được hỏi.
    assert.equal(feedback.findTicket("bot1", bot1.ticketId, filePath).message, "Từ bot1");
    assert.equal(feedback.findTicket("bot2", bot2.ticketId, filePath).message, "Từ bot2");
    // Mã của bot này KHÔNG được tìm thấy trong ngăn bot kia.
    assert.equal(feedback.findTicket("bot2", bot1.ticketId, filePath), null);
    assert.equal(feedback.findTicket("bot1", bot2.ticketId, filePath), null);
});

test("trả lời đi tới ĐÚNG bot của yêu cầu, không phải bot khác", async (t) => {
    const filePath = tempFile(t);
    clearBots();
    t.after(() => clearBots());

    const bot1 = officialWithRecorder("bot1", "token-1");
    const bot2 = officialWithRecorder("bot2", "token-2");
    registerBots([bot1, bot2]);

    // Hai bot, CÙNG chatId.
    const ticket = feedback.createTicket({
        botId: "bot2", chatId: "SAME-CHAT", userId: "u1", message: "Tôi cần giúp"
    }, filePath).ticket;

    // Mô phỏng đúng đường đi của replyToFeedback: lấy botId từ CHÍNH yêu cầu.
    const runtime = bot2;
    await runWithBot(runtime, () => Promise.resolve(runtime.sendMessage(ticket.chatId, "Trả lời")));

    assert.equal(bot2.sent.length, 1, "bot2 phải gửi");
    assert.equal(bot2.sent[0].chatId, "SAME-CHAT");
    assert.equal(bot1.sent.length, 0, "bot1 TUYỆT ĐỐI không được gửi thay bot2");
});

test("ngữ cảnh bot khi tra cứu yêu cầu là của bot hiện tại", (t) => {
    const filePath = tempFile(t);
    clearBots();
    t.after(() => clearBots());

    const bot1 = officialWithRecorder("bot1", "token-1");
    const bot2 = officialWithRecorder("bot2", "token-2");
    registerBots([bot1, bot2]);

    const inBot2 = runWithBot(bot2, () => feedback.createTicket({
        chatId: "chat-X", userId: "u1", message: "trong bot2"
    }, filePath).ticket);

    assert.equal(inBot2.botId, "bot2", "botId phải lấy từ ngữ cảnh bot đang chạy");
    assert.equal(runWithBot(bot1, () => feedback.findTicket("bot1", inBot2.ticketId, filePath)), null);
    assert.ok(runWithBot(bot2, () => feedback.findTicket("bot2", inBot2.ticketId, filePath)));
});

/* ========================================================================== */
/* Nhóm                                                                       */
/* ========================================================================== */

test("yêu cầu từ nhóm ghi lại đúng bối cảnh nhóm", (t) => {
    const filePath = tempFile(t);
    const { ticket } = feedback.createTicket({
        botId: "bot1", chatId: "group-999", chatType: "group",
        userId: "member-7", displayName: "Thành viên",
        message: "Nhóm em cần hỗ trợ"
    }, filePath);

    assert.equal(ticket.chatType, "group", "phải ghi rõ đây là nhóm");
    assert.equal(ticket.chatId, "group-999", "đích trả lời là NHÓM, không phải người gửi");
    assert.equal(ticket.userId, "member-7", "người gửi vẫn được lưu riêng");
    // Đích gửi và người gửi là hai thứ khác nhau.
    assert.notEqual(ticket.chatId, ticket.userId);
});

/* ========================================================================== */
/* Trả lời, gửi tiếp, xử lý lại                                               */
/* ========================================================================== */

test("trả lời của quản trị viên bắt đầu ở trạng thái CHƯA gửi", (t) => {
    const filePath = tempFile(t);
    const ticket = feedback.createTicket({ botId: "bot1", chatId: "chat-1", message: "cần giúp" }, filePath).ticket;
    const { reply } = feedback.addAdminReply("bot1", ticket.ticketId, { message: "Đã kiểm tra", adminName: "admin" }, filePath);

    assert.equal(reply.author, "admin");
    assert.equal(reply.deliveryStatus, "pending", "chưa gửi thì không được nói là đã gửi");
    assert.equal(reply.error, null);
});

test("ghi nhận gửi thành công và gửi thất bại chính xác", (t) => {
    const filePath = tempFile(t);
    const ticket = feedback.createTicket({ botId: "bot1", chatId: "chat-1", message: "cần giúp" }, filePath).ticket;

    const ok = feedback.addAdminReply("bot1", ticket.ticketId, { message: "ok" }, filePath);
    feedback.setReplyDelivery("bot1", ticket.ticketId, ok.reply.replyId, { status: "sent" }, filePath);
    const afterOk = feedback.findTicket("bot1", ticket.ticketId, filePath);
    assert.equal(afterOk.replies[0].deliveryStatus, "sent");
    assert.equal(afterOk.replies[0].error, null);
    assert.ok(afterOk.replies[0].deliveredAt);

    const bad = feedback.addAdminReply("bot1", ticket.ticketId, { message: "lỗi" }, filePath);
    feedback.setReplyDelivery("bot1", ticket.ticketId, bad.reply.replyId, { status: "failed", error: "422 không có quyền" }, filePath);
    const afterBad = feedback.findTicket("bot1", ticket.ticketId, filePath);
    const failed = afterBad.replies.find((item) => item.replyId === bad.reply.replyId);
    assert.equal(failed.deliveryStatus, "failed", "gửi lỗi thì phải giữ nguyên là lỗi");
    assert.match(failed.error, /422/);
    assert.equal(failed.deliveredAt, null);
});

test("trả lời lỗi vẫn được giữ lại để gửi lại", (t) => {
    const filePath = tempFile(t);
    const ticket = feedback.createTicket({ botId: "bot1", chatId: "chat-1", message: "cần giúp" }, filePath).ticket;
    const { reply } = feedback.addAdminReply("bot1", ticket.ticketId, { message: "nội dung quan trọng" }, filePath);
    feedback.setReplyDelivery("bot1", ticket.ticketId, reply.replyId, { status: "failed", error: "lỗi mạng" }, filePath);

    const after = feedback.findTicket("bot1", ticket.ticketId, filePath);
    const kept = after.replies.find((item) => item.replyId === reply.replyId);
    assert.ok(kept, "trả lời phải còn trong yêu cầu");
    assert.equal(kept.message, "nội dung quan trọng", "nội dung không được mất để còn gửi lại");
});

test("người dùng gửi tiếp thì nối vào đúng yêu cầu và mở lại", (t) => {
    const filePath = tempFile(t);
    const ticket = feedback.createTicket({ botId: "bot1", chatId: "chat-1", message: "vấn đề A" }, filePath).ticket;

    feedback.setTicketStatus("bot1", ticket.ticketId, "resolved", filePath);
    feedback.markTicketRead("bot1", ticket.ticketId, filePath);

    const updated = feedback.appendUserMessage("bot1", ticket.ticketId, "vẫn còn lỗi", filePath);

    assert.equal(updated.replies.length, 1);
    assert.equal(updated.replies[0].author, "user", "phải ghi rõ là của người dùng");
    assert.equal(updated.status, "open", "người dùng viết tiếp thì yêu cầu mở lại");
    assert.equal(updated.unread, true, "quản trị viên cần đọc lại");
    assert.equal(updated.message, "vấn đề A", "nội dung gốc không bị mất");
});

test("gửi tiếp vào mã của bot khác thì không ghi được", (t) => {
    const filePath = tempFile(t);
    const ticket = feedback.createTicket({ botId: "bot1", chatId: "chat-1", message: "của bot1" }, filePath).ticket;

    // Người dùng bot2 gõ mã của bot1: không tìm thấy trong ngăn bot2.
    assert.equal(feedback.findTicket("bot2", ticket.ticketId, filePath), null);
    // Và nội dung bổ sung cũng không ghi vào yêu cầu của bot1.
    assert.equal(feedback.appendUserMessage("bot2", ticket.ticketId, "chen ngang", filePath), null);
    assert.equal(feedback.findTicket("bot1", ticket.ticketId, filePath).replies.length, 0);
});

test("xử lý và mở lại yêu cầu", (t) => {
    const filePath = tempFile(t);
    const ticket = feedback.createTicket({ botId: "bot1", chatId: "chat-1", message: "x" }, filePath).ticket;

    const resolved = feedback.setTicketStatus("bot1", ticket.ticketId, "resolved", filePath);
    assert.equal(resolved.status, "resolved");
    assert.ok(resolved.resolvedAt, "đã xử lý thì phải có mốc thời gian");

    const reopened = feedback.setTicketStatus("bot1", ticket.ticketId, "open", filePath);
    assert.equal(reopened.status, "open");
    assert.equal(reopened.resolvedAt, null, "mở lại thì xoá mốc đã xử lý");
});

test("trạng thái không hợp lệ bị từ chối", (t) => {
    const filePath = tempFile(t);
    const ticket = feedback.createTicket({ botId: "bot1", chatId: "chat-1", message: "x" }, filePath).ticket;
    assert.throws(() => feedback.setTicketStatus("bot1", ticket.ticketId, "đang_xem", filePath), /không hợp lệ/);
});

/* ========================================================================== */
/* Đọc cho dashboard                                                          */
/* ========================================================================== */

test("đếm và lọc yêu cầu theo bot, trạng thái, chưa đọc và từ khoá", (t) => {
    const filePath = tempFile(t);
    const a = feedback.createTicket({ botId: "bot1", chatId: "c1", userId: "u1", displayName: "An", message: "Lịch tuần sai" }, filePath).ticket;
    feedback.createTicket({ botId: "bot2", chatId: "c2", userId: "u2", displayName: "Bình", message: "Không nhận được thông báo" }, filePath);
    feedback.setTicketStatus("bot1", a.ticketId, "resolved", filePath);

    assert.deepEqual(feedback.getCounts(filePath), { total: 2, unread: 2, open: 1, resolved: 1 });
    assert.equal(feedback.listTickets({ botId: "bot1" }, filePath).length, 1);
    assert.equal(feedback.listTickets({ status: "resolved" }, filePath).length, 1);
    assert.equal(feedback.listTickets({ search: "Lịch" }, filePath).length, 1);
    assert.equal(feedback.listTickets({ search: "không tồn tại" }, filePath).length, 0);
});

test("mã yêu cầu được chuẩn hoá khi người dùng gõ thiếu tiền tố", () => {
    assert.equal(feedback.normalizeTicketId("FB-AB12CD34"), "FB-AB12CD34");
    assert.equal(feedback.normalizeTicketId("ab12cd34"), "FB-AB12CD34");
    assert.equal(feedback.normalizeTicketId("FBAB12CD34"), "FB-AB12CD34");
    assert.equal(feedback.normalizeTicketId("không phải mã"), null);
});

test("đọc chi tiết đánh dấu đã xem", (t) => {
    const filePath = tempFile(t);
    const ticket = feedback.createTicket({ botId: "bot1", chatId: "c1", message: "x" }, filePath).ticket;
    assert.equal(ticket.unread, true);

    feedback.markTicketRead("bot1", ticket.ticketId, filePath);
    assert.equal(feedback.findTicket("bot1", ticket.ticketId, filePath).unread, false);
    assert.equal(feedback.getCounts(filePath).unread, 0);
});

test("trả lời của quản trị viên xoá trạng thái chưa đọc", (t) => {
    const filePath = tempFile(t);
    const ticket = feedback.createTicket({ botId: "bot1", chatId: "c1", message: "x" }, filePath).ticket;
    feedback.addAdminReply("bot1", ticket.ticketId, { message: "đã trả lời" }, filePath);
    assert.equal(feedback.findTicket("bot1", ticket.ticketId, filePath).unread, false);
});

/* ========================================================================== */
/* Lệnh /feedback trong chat                                                  */
/* ========================================================================== */

test("/feedback nằm trong trợ giúp và có ví dụ", () => {
    const { findCommand } = require("../commandRegistry");
    const command = findCommand("feedback");
    assert.ok(command, "phải có trong danh mục lệnh");
    assert.equal(command.usage, "/feedback [nội dung]");
    assert.ok(command.examples.some((item) => item.startsWith("/feedback ")), "phải có ví dụ");
    assert.equal(command.permission, "user");
});

test("/feedback không chạy theo từng người nhận", () => {
    const { resolveCommandTargeting } = require("../commandTargeting");
    assert.equal(resolveCommandTargeting("feedback").mode, "none");
});

test("mẫu tin xác nhận có mã yêu cầu và nói rõ trả lời trong chat này", () => {
    const { formatFeedbackUsage, formatFeedbackAck, formatFeedbackFollowUpAck } = require("../messageTemplates");

    const usage = formatFeedbackUsage();
    assert.match(usage, /\/feedback /, "phải có ví dụ cú pháp");

    const ack = formatFeedbackAck("FB-AB12CD34");
    assert.match(ack, /FB-AB12CD34/, "phải nêu mã yêu cầu");
    assert.match(ack, /cuộc trò chuyện này/i, "phải nói trả lời ngay trong chat này");
    assert.match(ack, /\/feedback FB-AB12CD34/, "phải hướng dẫn cách gửi tiếp");

    assert.match(formatFeedbackFollowUpAck("FB-AB12CD34"), /FB-AB12CD34/);
});

/* ========================================================================== */
/* Đường gửi trả lời thật (deliverFeedbackReply)                              */
/* ========================================================================== */

const main = require("../main");

test("trả lời đi tới đúng bot khi hai bot dùng CÙNG chatId", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const bot1 = officialWithRecorder("bot1", "token-1");
    const bot2 = officialWithRecorder("bot2", "token-2");
    registerBots([bot1, bot2]);

    const ticket = feedback.createTicket({
        botId: "bot2", chatId: "SAME-CHAT", userId: "u1", displayName: "An", message: "Cần hỗ trợ"
    }).ticket;

    const result = await main.deliverFeedbackReply({
        botId: "bot2", ticketId: ticket.ticketId, message: "Đã xử lý giúp em.", adminName: "admin"
    });

    assert.equal(result.delivered, true);
    assert.equal(result.botId, "bot2");
    assert.equal(bot2.sent.length, 1, "bot2 phải gửi");
    assert.equal(bot2.sent[0].chatId, "SAME-CHAT");
    assert.match(bot2.sent[0].text, /Đã xử lý giúp em\./);
    assert.equal(bot1.sent.length, 0, "bot1 KHÔNG được gửi — cùng chatId nhưng khác bot");
});

test("botId truyền vào sai vẫn không gửi nhầm bot", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const bot1 = officialWithRecorder("bot1", "token-1");
    const bot2 = officialWithRecorder("bot2", "token-2");
    registerBots([bot1, bot2]);

    const ticket = feedback.createTicket({ botId: "bot1", chatId: "chat-A", message: "của bot1" }).ticket;

    // Cố tình khai sai bot: hàm phải lấy bot từ CHÍNH yêu cầu.
    const result = await main.deliverFeedbackReply({
        botId: "bot2", ticketId: ticket.ticketId, message: "trả lời", adminName: "admin"
    });

    // Yêu cầu không tồn tại trong ngăn bot2 ⇒ từ chối, không gửi gì cả.
    assert.equal(result.delivered, false);
    assert.match(result.error, /Không tìm thấy/);
    assert.equal(bot1.sent.length, 0);
    assert.equal(bot2.sent.length, 0);
});

test("Zalo từ chối thì ghi nhận thất bại và GIỮ trả lời để gửi lại", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const bot1 = officialWithRecorder("bot1", "token-1", { failSend: true });
    registerBots([bot1]);

    const ticket = feedback.createTicket({ botId: "bot1", chatId: "chat-A", message: "cần giúp" }).ticket;

    const result = await main.deliverFeedbackReply({
        botId: "bot1", ticketId: ticket.ticketId, message: "Nội dung quan trọng", adminName: "admin"
    });

    assert.equal(result.delivered, false, "gửi lỗi thì KHÔNG được báo thành công");
    assert.match(result.error, /422/);

    // Trả lời vẫn còn, ở trạng thái lỗi, để quản trị viên gửi lại.
    const after = feedback.findTicket("bot1", ticket.ticketId);
    const reply = after.replies.find((item) => item.replyId === result.replyId);
    assert.ok(reply, "trả lời phải được giữ lại");
    assert.equal(reply.message, "Nội dung quan trọng");
    assert.equal(reply.deliveryStatus, "failed");
    assert.match(reply.error, /422/);
});

test("gửi lại sau khi lỗi thì ghi nhận thành công", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const bot1 = officialWithRecorder("bot1", "token-1", { failSend: true });
    registerBots([bot1]);

    const ticket = feedback.createTicket({ botId: "bot1", chatId: "chat-A", message: "cần giúp" }).ticket;
    const failed = await main.deliverFeedbackReply({
        botId: "bot1", ticketId: ticket.ticketId, message: "thử lại", adminName: "admin"
    });
    assert.equal(failed.delivered, false);

    // Zalo hoạt động trở lại.
    bot1.failSend = false;
    const retried = await main.deliverFeedbackReply({
        botId: "bot1", ticketId: ticket.ticketId, message: "thử lại", adminName: "admin"
    });
    assert.equal(retried.delivered, true);
    assert.equal(bot1.sent.length, 1);
});

test("trả lời yêu cầu từ NHÓM đi tới nhóm, không phải người gửi", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const bot1 = officialWithRecorder("bot1", "token-1");
    registerBots([bot1]);

    const ticket = feedback.createTicket({
        botId: "bot1", chatId: "group-999", chatType: "group",
        userId: "member-7", displayName: "Thành viên", message: "Nhóm cần hỗ trợ"
    }).ticket;

    await main.deliverFeedbackReply({
        botId: "bot1", ticketId: ticket.ticketId, message: "Đã xử lý cho nhóm.", adminName: "admin"
    });

    assert.equal(bot1.sent.length, 1);
    assert.equal(bot1.sent[0].chatId, "group-999", "phải gửi vào NHÓM");
    assert.notEqual(bot1.sent[0].chatId, "member-7", "không được gửi riêng cho người gửi");
});

test("bot đang tắt thì báo lỗi rõ, không im lặng và không chuyển kênh khác", async (t) => {
    clearBots();
    t.after(() => clearBots());

    // Chỉ đăng ký bot1, yêu cầu lại thuộc bot2 (đang tắt).
    const bot1 = officialWithRecorder("bot1", "token-1");
    registerBots([bot1]);

    const ticket = feedback.createTicket({ botId: "bot2", chatId: "chat-A", message: "x" }).ticket;
    const result = await main.deliverFeedbackReply({
        botId: "bot2", ticketId: ticket.ticketId, message: "trả lời", adminName: "admin"
    });

    assert.equal(result.delivered, false);
    assert.match(result.error, /đang tắt/);
    // Không được lặng lẽ gửi bằng bot1 hay bất kỳ kênh nào khác.
    assert.equal(bot1.sent.length, 0);
});

test("không bao giờ tự chuyển sang tài khoản ZCA khi bot chính thức gửi lỗi", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-zca-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const bot1 = officialWithRecorder("bot1", "token-1", { failSend: true });
    const zca = createZcaProvider({ enabled: true, sessionDir: dir });
    zca.sent = [];
    zca.api = {
        sendMessage: async (payload, threadId) => { zca.sent.push({ payload, threadId }); return {}; },
        getOwnId: () => "900900900"
    };
    zca.authenticated = true;
    zca.status = "connected";
    registerBots([bot1, zca]);

    const ticket = feedback.createTicket({ botId: "bot1", chatId: "chat-A", message: "cần giúp" }).ticket;
    const result = await main.deliverFeedbackReply({
        botId: "bot1", ticketId: ticket.ticketId, message: "trả lời", adminName: "admin"
    });

    assert.equal(result.delivered, false);
    assert.equal(zca.sent.length, 0, "TUYỆT ĐỐI không gửi bằng tài khoản Zalo cá nhân");
});
