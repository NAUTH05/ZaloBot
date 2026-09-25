// ============================================================================
// Yêu cầu hỗ trợ / góp ý từ người dùng, và trả lời của quản trị viên.
//
// Nguyên tắc quan trọng nhất: một yêu cầu thuộc về MỘT cuộc trò chuyện của MỘT bot.
// Danh tính hội thoại là (botId, chatId) — KHÔNG BAO GIỜ chỉ chatId. Chat ID chỉ
// có nghĩa trong phạm vi một bot, nên hai bot có thể có cùng chatId, và trả lời
// nhầm bot là gửi tin cho người khác.
//
// Khóa lưu trữ dùng scopeKey(botId, ...) giống mọi store khác, nên bot1 giữ khóa
// trần (tương thích dữ liệu cũ) còn botN/ZCA có tiền tố riêng.
// ============================================================================
const path = require("path");
const crypto = require("crypto");
const { readJsonStore, writeJsonStore } = require("./firestorePersistence");
const { getCurrentBotId } = require("./botContext");
const { scopeKey, normalizeBotId } = require("./bots");

const FILE_PATH = path.join(__dirname, "feedbackTickets.json");
const SCHEMA_VERSION = 1;

// Giới hạn độ dài để một tin nhắn khổng lồ không làm phình store. Cắt bớt thay vì
// từ chối, để người dùng vẫn gửi được nội dung dài.
const MAX_MESSAGE_LENGTH = 2000;
const MAX_REPLY_LENGTH = 2000;
// Số yêu cầu tối đa giữ lại cho một hội thoại. Yêu cầu cũ nhất bị bỏ khi vượt.
const MAX_TICKETS_PER_CHAT = 50;

const STATUSES = new Set(["open", "resolved"]);

function emptyStore() {
    return { schemaVersion: SCHEMA_VERSION, tickets: {}, sourceIndex: {} };
}

function readStore(filePath = FILE_PATH) {
    try {
        const data = readJsonStore(filePath, FILE_PATH, emptyStore());
        return {
            schemaVersion: SCHEMA_VERSION,
            tickets: data && typeof data.tickets === "object" && data.tickets ? data.tickets : {},
            sourceIndex: data && typeof data.sourceIndex === "object" && data.sourceIndex ? data.sourceIndex : {}
        };
    } catch (error) {
        console.error("Không đọc được feedbackTickets.json:", error.message);
        return emptyStore();
    }
}

function writeStore(data, filePath = FILE_PATH) {
    writeJsonStore(filePath, FILE_PATH, data);
}

function nowIso() {
    return new Date().toISOString();
}

// Mã yêu cầu ngắn, dễ đọc lại cho người dùng. 8 ký tự hex ⇒ ~4 tỷ khả năng.
function generateTicketId() {
    return `FB-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function clampMessage(value, maxLength = MAX_MESSAGE_LENGTH) {
    const text = String(value == null ? "" : value).trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 1)}…`;
}

function normalizeTicketId(value) {
    const text = String(value == null ? "" : value).trim().toUpperCase();
    // Chấp nhận cả "fb-ab12cd34" lẫn "FB-AB12CD34".
    const match = text.match(/^(?:FB-?)?([0-9A-F]{8})$/);
    return match ? `FB-${match[1]}` : null;
}

// Khóa của một yêu cầu trong ngăn của bot hiện tại.
function ticketKey(botId, ticketId) {
    return scopeKey(botId, `ticket::${ticketId}`);
}

// Chỉ mục chống trùng theo mã tin nhắn nguồn. Zalo có thể gửi lại cùng một update,
// nên nếu không chặn thì một yêu cầu sẽ thành hai.
function sourceKey(botId, sourceMessageId) {
    return scopeKey(botId, `source::${sourceMessageId}`);
}

/* -------------------------------------------------------------------------- */
/* Ghi                                                                        */
/* -------------------------------------------------------------------------- */

// Tạo yêu cầu mới trong ngăn của bot đang chạy.
//
// `sourceMessageId` (nếu có) dùng để chống trùng: cùng một tin nhắn gửi lại sẽ trả
// về yêu cầu đã tạo thay vì tạo thêm.
function createTicket(input = {}, filePath = FILE_PATH) {
    const botId = normalizeBotId(input.botId) || getCurrentBotId();
    const chatId = String(input.chatId || "").trim();
    const message = clampMessage(input.message);

    if (!chatId) throw new Error("Yêu cầu hỗ trợ phải có chatId");
    if (!message) throw new Error("Yêu cầu hỗ trợ phải có nội dung");

    const data = readStore(filePath);

    // Đã xử lý tin nhắn nguồn này rồi ⇒ trả lại yêu cầu cũ, không tạo bản sao.
    const sourceMessageId = input.sourceMessageId ? String(input.sourceMessageId) : null;
    if (sourceMessageId) {
        const existingKey = data.sourceIndex[sourceKey(botId, sourceMessageId)];
        if (existingKey && data.tickets[existingKey]) {
            return { ticket: data.tickets[existingKey], duplicate: true };
        }
    }

    // Bảo đảm mã không trùng trong ngăn này.
    let ticketId = generateTicketId();
    let guard = 0;
    while (data.tickets[ticketKey(botId, ticketId)] && guard < 10) {
        ticketId = generateTicketId();
        guard += 1;
    }

    const timestamp = nowIso();
    const ticket = {
        ticketId,
        botId,
        chatId,
        chatType: ["private", "group"].includes(input.chatType) ? input.chatType : "unknown",
        userId: String(input.userId || "").trim() || null,
        displayName: String(input.displayName || "").trim(),
        message,
        status: "open",
        unread: true,
        createdAt: timestamp,
        updatedAt: timestamp,
        resolvedAt: null,
        replies: []
    };

    const key = ticketKey(botId, ticketId);
    data.tickets[key] = ticket;
    if (sourceMessageId) data.sourceIndex[sourceKey(botId, sourceMessageId)] = key;

    // Giới hạn số yêu cầu mỗi hội thoại: bỏ cái cũ nhất khi vượt trần.
    pruneChatTickets(data, botId, chatId);

    writeStore(data, filePath);
    return { ticket, duplicate: false };
}

function pruneChatTickets(data, botId, chatId) {
    const prefix = scopeKey(botId, "ticket::");
    const mine = Object.entries(data.tickets)
        .filter(([key, ticket]) => key.startsWith(prefix) && ticket.chatId === chatId)
        .sort((a, b) => String(a[1].createdAt).localeCompare(String(b[1].createdAt)));

    while (mine.length > MAX_TICKETS_PER_CHAT) {
        const [key, ticket] = mine.shift();
        delete data.tickets[key];
        for (const [indexKey, value] of Object.entries(data.sourceIndex)) {
            if (value === key) delete data.sourceIndex[indexKey];
        }
        void ticket;
    }
}

// Thêm một tin nhắn tiếp theo của người dùng vào yêu cầu đã có.
function appendUserMessage(botId, ticketId, message, filePath = FILE_PATH) {
    const data = readStore(filePath);
    const normalizedBot = normalizeBotId(botId) || getCurrentBotId();
    const key = ticketKey(normalizedBot, ticketId);
    const ticket = data.tickets[key];
    if (!ticket) return null;

    const text = clampMessage(message);
    if (!text) return null;

    ticket.replies.push({
        replyId: `R-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
        author: "user",
        message: text,
        at: nowIso(),
        deliveryStatus: null,
        error: null
    });
    ticket.updatedAt = nowIso();
    // Người dùng vừa viết tiếp ⇒ quản trị viên cần đọc lại.
    ticket.unread = true;
    ticket.status = "open";

    writeStore(data, filePath);
    return ticket;
}

// Thêm trả lời của quản trị viên. Trạng thái gửi được cập nhật riêng sau khi gửi.
function addAdminReply(botId, ticketId, input = {}, filePath = FILE_PATH) {
    const data = readStore(filePath);
    const normalizedBot = normalizeBotId(botId) || getCurrentBotId();
    const key = ticketKey(normalizedBot, ticketId);
    const ticket = data.tickets[key];
    if (!ticket) return null;

    const text = clampMessage(input.message, MAX_REPLY_LENGTH);
    if (!text) throw new Error("Trả lời phải có nội dung");

    const reply = {
        replyId: `R-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
        author: "admin",
        adminName: String(input.adminName || "").trim() || null,
        message: text,
        at: nowIso(),
        // Mặc định là CHƯA gửi được. Chỉ đổi thành "sent" sau khi Zalo xác nhận,
        // để không bao giờ hiển thị "Đã gửi" cho một tin gửi lỗi.
        deliveryStatus: "pending",
        error: null
    };
    ticket.replies.push(reply);
    ticket.updatedAt = nowIso();
    ticket.unread = false;

    writeStore(data, filePath);
    return { ticket, reply };
}

// Cập nhật kết quả gửi của một trả lời.
function setReplyDelivery(botId, ticketId, replyId, delivery = {}, filePath = FILE_PATH) {
    const data = readStore(filePath);
    const normalizedBot = normalizeBotId(botId) || getCurrentBotId();
    const ticket = data.tickets[ticketKey(normalizedBot, ticketId)];
    if (!ticket) return null;

    const reply = ticket.replies.find((item) => item.replyId === replyId);
    if (!reply) return null;

    reply.deliveryStatus = delivery.status === "sent" ? "sent" : "failed";
    reply.error = delivery.status === "sent" ? null : String(delivery.error || "Gửi thất bại");
    reply.deliveredAt = delivery.status === "sent" ? nowIso() : null;
    ticket.updatedAt = nowIso();

    writeStore(data, filePath);
    return { ticket, reply };
}

function setTicketStatus(botId, ticketId, status, filePath = FILE_PATH) {
    const data = readStore(filePath);
    const normalizedBot = normalizeBotId(botId) || getCurrentBotId();
    const ticket = data.tickets[ticketKey(normalizedBot, ticketId)];
    if (!ticket) return null;
    if (!STATUSES.has(status)) throw new Error(`Trạng thái yêu cầu không hợp lệ: ${status}`);

    ticket.status = status;
    ticket.resolvedAt = status === "resolved" ? nowIso() : null;
    ticket.updatedAt = nowIso();
    if (status === "open") ticket.unread = true;

    writeStore(data, filePath);
    return ticket;
}

function markTicketRead(botId, ticketId, filePath = FILE_PATH) {
    const data = readStore(filePath);
    const normalizedBot = normalizeBotId(botId) || getCurrentBotId();
    const ticket = data.tickets[ticketKey(normalizedBot, ticketId)];
    if (!ticket || ticket.unread === false) return ticket || null;

    ticket.unread = false;
    writeStore(data, filePath);
    return ticket;
}

/* -------------------------------------------------------------------------- */
/* Đọc                                                                        */
/* -------------------------------------------------------------------------- */

// Tìm yêu cầu trong ngăn của MỘT bot. Dùng cho lệnh tiếp theo của người dùng.
function findTicket(botId, ticketId, filePath = FILE_PATH) {
    const normalizedBot = normalizeBotId(botId) || getCurrentBotId();
    const normalized = normalizeTicketId(ticketId);
    if (!normalized) return null;
    return readStore(filePath).tickets[ticketKey(normalizedBot, normalized)] || null;
}

// Liệt kê yêu cầu của MỌI bot cho dashboard.
//
// Khóa lưu trữ đã gồm botId nên chỉ cần đọc một lần; mỗi bản ghi tự mang botId của
// nó. Sắp xếp mới nhất trước.
function listTickets(options = {}, filePath = FILE_PATH) {
    const data = readStore(filePath);
    let tickets = Object.values(data.tickets);

    if (options.botId) {
        const wanted = normalizeBotId(options.botId);
        tickets = tickets.filter((ticket) => normalizeBotId(ticket.botId) === wanted);
    }
    if (options.status && options.status !== "all") {
        tickets = tickets.filter((ticket) => ticket.status === options.status);
    }
    if (options.unreadOnly) {
        tickets = tickets.filter((ticket) => ticket.unread === true);
    }
    if (options.search) {
        const needle = String(options.search).trim().toLowerCase();
        if (needle) {
            tickets = tickets.filter((ticket) => [
                ticket.ticketId, ticket.chatId, ticket.userId, ticket.displayName, ticket.message
            ].some((field) => String(field || "").toLowerCase().includes(needle)));
        }
    }

    tickets.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return tickets;
}

function getCounts(filePath = FILE_PATH) {
    const tickets = Object.values(readStore(filePath).tickets);
    return {
        total: tickets.length,
        unread: tickets.filter((ticket) => ticket.unread === true).length,
        open: tickets.filter((ticket) => ticket.status === "open").length,
        resolved: tickets.filter((ticket) => ticket.status === "resolved").length
    };
}

module.exports = {
    FILE_PATH,
    MAX_MESSAGE_LENGTH,
    MAX_REPLY_LENGTH,
    STATUSES,
    addAdminReply,
    appendUserMessage,
    clampMessage,
    createTicket,
    findTicket,
    getCounts,
    listTickets,
    markTicketRead,
    normalizeTicketId,
    setReplyDelivery,
    setTicketStatus,
    ticketKey
};
