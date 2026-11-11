// ============================================================================
// Message Recorder — ghi lịch sử tin nhắn hai chiều cho Chat Center.
//
// Thiết kế:
//   - Mỗi hội thoại là một document trong `bot_conversations` collection.
//   - Mỗi tin nhắn là một document trong subcollection `messages`.
//   - Idempotent: dùng messageId (từ provider) làm document ID; ghi trùng = skip.
//   - Phân trang theo cursor (timestamp + messageId), không dùng offset.
//   - Bot-scoped: conversationId = `${botId}::${chatId}`.
//
// Không thay thế interactionRegistry (chỉ ghi last interaction) hay feedback
// (ticket-based). Lớp này ghi ĐẦY ĐỬ lịch sử cho Chat Center.
//
// Collection layout:
//   bot_conversations/{conversationId}
//     - botId, chatId, chatType, displayName, lastMessageAt, lastMessagePreview,
//       lastMessageDirection, unreadCount, createdAt, updatedAt
//   bot_conversations/{conversationId}/messages/{messageId}
//     - direction (inbound|outbound), text, attachments[], status, providerMsgId,
//       botId, chatId, sentAt, deliveredAt, failedAt, error, source,
//       senderUserId (chỉ tin vào; null với tin ra)
// ============================================================================

const { normalizeBotId, storageKeyPrefix } = require("./bots");
const { CHAT_EVENT, publishChatEvent } = require("./chatEvents");

const CONVERSATIONS_COLLECTION = "bot_conversations";
const MESSAGES_SUBCOLLECTION = "messages";

// Direction constants
const DIRECTION = Object.freeze({
    INBOUND: "inbound",
    OUTBOUND: "outbound"
});

// Delivery status constants
const STATUS = Object.freeze({
    PENDING: "pending",
    SENT: "sent",
    DELIVERED: "delivered",
    FAILED: "failed",
    READ: "read"
});

// Message source — ai/đâu gửi tin này.
const SOURCE = Object.freeze({
    BOT_COMMAND: "bot_command",       // tin phản hồi từ lệnh bot (handleCommand)
    ADMIN_CHAT: "admin_chat",         // admin gửi qua Chat Center
    SCHEDULED: "scheduled",           // thông báo định kỳ
    FEEDBACK_REPLY: "feedback_reply", // phản hồi feedback ticket
    ANNOUNCEMENT: "announcement",     // thông báo khôi phục
    INBOUND_USER: "inbound_user",     // tin người dùng gửi tới bot
    INBOUND_GROUP: "inbound_group"    // tin nhóm gửi tới bot
});

// ---------------------------------------------------------------------------
// Tạo conversationId từ botId và chatId.
// Dùng cùng quy ước scopeKey nhưng là string an toàn cho Firestore document ID.
// ---------------------------------------------------------------------------
function conversationIdFor(botId, chatId) {
    const id = normalizeBotId(botId) || "bot1";
    const prefix = storageKeyPrefix(id);
    return `${prefix}${chatId}`;
}

// Lấy db từ firestorePersistence một cách an toàn.
function getDb() {
    try {
        const { getFirestoreDb } = require("./firestorePersistence");
        const db = getFirestoreDb();
        if (!db) {
            console.warn("[MessageRecorder] Firestore chưa khởi tạo — ghi lịch sử tin nhắn bị bỏ qua.");
        }
        return db;
    } catch (error) {
        console.error("[MessageRecorder] không lấy được Firestore:", error.message);
        return null;
    }
}

// Tạo hoặc cập nhật metadata hội thoại.
async function upsertConversation({ botId, chatId, chatType, displayName }) {
    const db = getDb();
    if (!db) return null;

    const convId = conversationIdFor(botId, chatId);
    const convRef = db.collection(CONVERSATIONS_COLLECTION).doc(convId);

    try {
        const doc = await convRef.get();
        const now = new Date().toISOString();

        if (!doc.exists) {
            const data = {
                conversationId: convId,
                botId: normalizeBotId(botId) || "bot1",
                chatId: String(chatId),
                chatType: chatType || null,
                displayName: displayName || null,
                unreadCount: 0,
                createdAt: now,
                updatedAt: now,
                lastMessageAt: null,
                lastMessagePreview: null,
                lastMessageDirection: null,
                lastMessageStatus: null
            };
            await convRef.set(data);
            return data;
        }

        // Đã tồn tại — chỉ cập nhật các trường có giá trị mới.
        const existing = doc.data();
        const updates = { updatedAt: now };
        if (chatType && existing.chatType !== chatType) updates.chatType = chatType;
        if (displayName && existing.displayName !== displayName) updates.displayName = displayName;
        await convRef.set(updates, { merge: true });
        return { ...existing, ...updates };
    } catch (error) {
        console.error(`[MessageRecorder] lỗi upsertConversation ${convId}:`, error.message);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Ghi một tin nhắn vào lịch sử. Idempotent: nếu messageId đã tồn tại thì skip.
//
// Trả về { recorded: true, messageId } hoặc { recorded: false, reason: "duplicate" }
// ---------------------------------------------------------------------------
async function recordMessage({
    botId,
    chatId,
    direction,
    text,
    attachments = [],
    status = STATUS.SENT,
    providerMsgId = null,
    source = SOURCE.BOT_COMMAND,
    chatType = null,
    displayName = null,
    // Danh tính người gửi của tin VÀO. Bắt buộc với tin nhóm: nếu không lưu, trợ
    // lý AI không thể tách ngữ cảnh của từng thành viên và mọi tin trong nhóm sẽ
    // trở thành ngữ cảnh chung — vừa sai quyền riêng tư vừa tốn token.
    senderUserId = null,
    timestamp = null,
    error = null
}) {
    const db = getDb();
    if (!db) return { recorded: false, reason: "no_db" };

    // Đảm bảo conversation tồn tại.
    const convId = conversationIdFor(botId, chatId);
    await upsertConversation({ botId, chatId, chatType, displayName });

    // Sinh messageId nếu không có providerMsgId.
    // Dùng providerMsgId làm document ID để idempotent.
    const crypto = require("crypto");
    const msgId = providerMsgId
        ? `msg_${crypto.createHash("sha256").update(String(providerMsgId)).digest("hex").slice(0, 24)}`
        : `msg_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;

    const msgRef = db.collection(CONVERSATIONS_COLLECTION)
        .doc(convId)
        .collection(MESSAGES_SUBCOLLECTION)
        .doc(msgId);

    try {
        // Kiểm tra trùng (idempotent).
        const existing = await msgRef.get();
        if (existing.exists) {
            // Nếu tin đã ghi nhưng status cập nhật (ví dụ pending → sent), cập nhật.
            if (status !== existing.data().status) {
                const statusUpdate = {};
                if (status === STATUS.SENT && !existing.data().deliveredAt) {
                    statusUpdate.deliveredAt = new Date().toISOString();
                }
                if (status === STATUS.FAILED && !existing.data().failedAt) {
                    statusUpdate.failedAt = new Date().toISOString();
                }
                if (error) statusUpdate.error = String(error).slice(0, 500);
                statusUpdate.status = status;
                await msgRef.set(statusUpdate, { merge: true });
                // Báo cho UI đang mở: trạng thái gửi của tin này vừa đổi.
                publishChatEvent({
                    type: CHAT_EVENT.STATUS,
                    conversationId: convId,
                    botId: normalizeBotId(botId) || "bot1",
                    chatId: String(chatId),
                    messageId: msgId,
                    status,
                    error: error ? String(error).slice(0, 500) : null
                });
            }
            return { recorded: false, reason: "duplicate", messageId: msgId };
        }

        const now = new Date().toISOString();
        const ts = timestamp || now;

        const message = {
            messageId: msgId,
            conversationId: convId,
            botId: normalizeBotId(botId) || "bot1",
            chatId: String(chatId),
            direction,
            text: String(text || "").slice(0, 4096),
            attachments: Array.isArray(attachments) ? attachments.slice(0, 10) : [],
            status,
            // Chỉ tin VÀO mới có người gửi; tin ra do chính bot gửi.
            senderUserId: direction === DIRECTION.INBOUND && senderUserId != null
                ? String(senderUserId).slice(0, 64)
                : null,
            providerMsgId: providerMsgId ? String(providerMsgId).slice(0, 128) : null,
            source,
            sentAt: direction === DIRECTION.OUTBOUND ? ts : null,
            receivedAt: direction === DIRECTION.INBOUND ? ts : null,
            deliveredAt: status === STATUS.SENT || status === STATUS.DELIVERED ? ts : null,
            failedAt: status === STATUS.FAILED ? ts : null,
            error: error ? String(error).slice(0, 500) : null,
            createdAt: now
        };

        await msgRef.set(message);

        // Cập nhật conversation metadata.
        const attachmentCount = Array.isArray(attachments) ? attachments.length : 0;
        const preview = String(text || "").trim()
            ? String(text).slice(0, 120)
            : (attachmentCount > 0 ? "[tệp đính kèm]" : "");
        const convUpdate = {
            lastMessageAt: ts,
            lastMessagePreview: preview,
            lastMessageDirection: direction,
            lastMessageStatus: status,
            updatedAt: now
        };
        // Tin inbound tăng unreadCount; tin outbound (admin gửi) reset unreadCount.
        if (direction === DIRECTION.INBOUND) {
            const convRef = db.collection(CONVERSATIONS_COLLECTION).doc(convId);
            const convDoc = await convRef.get();
            const current = convDoc.exists ? (convDoc.data().unreadCount || 0) : 0;
            convUpdate.unreadCount = current + 1;
        } else if (direction === DIRECTION.OUTBOUND) {
            convUpdate.unreadCount = 0;
        }

        await db.collection(CONVERSATIONS_COLLECTION).doc(convId).set(convUpdate, { merge: true });

        // Đẩy sự kiện xuống dashboard đang mở để không phải F5.
        publishChatEvent({
            type: CHAT_EVENT.MESSAGE,
            conversationId: convId,
            botId: message.botId,
            chatId: message.chatId,
            direction,
            message,
            conversation: {
                conversationId: convId,
                botId: message.botId,
                chatId: message.chatId,
                lastMessageAt: convUpdate.lastMessageAt,
                lastMessagePreview: convUpdate.lastMessagePreview,
                lastMessageDirection: convUpdate.lastMessageDirection,
                lastMessageStatus: convUpdate.lastMessageStatus,
                unreadCount: convUpdate.unreadCount,
                displayName: displayName || null,
                chatType: chatType || null
            }
        });

        return { recorded: true, messageId: msgId };
    } catch (error) {
        console.error(`[MessageRecorder] lỗi recordMessage ${convId}/${msgId}:`, error.message);
        return { recorded: false, reason: "error", error: error.message };
    }
}

// ---------------------------------------------------------------------------
// Lấy danh sách hội thoại cho Chat Center.
// Phân trang theo cursor (lastMessageAt + conversationId).
// ---------------------------------------------------------------------------
async function listConversations(options = {}) {
    const db = getDb();
    if (!db) return { conversations: [], nextCursor: null };

    const limit = Math.min(Number(options.limit) || 30, 100);
    const botIdFilter = options.botId || null;

    try {
        let query = db.collection(CONVERSATIONS_COLLECTION);

        if (botIdFilter) {
            query = query.where("botId", "==", normalizeBotId(botIdFilter));
        }

        // Phân trang cursor: dùng lastMessageAt + conversationId.
        // Firestore không hỗ trợ OR cho cursor nên dùng startAfter.
        if (options.cursor) {
            // cursor = base64({ lastMessageAt, conversationId })
            const decoded = JSON.parse(Buffer.from(options.cursor, "base64").toString("utf8"));
            if (decoded.lastMessageAt && decoded.conversationId) {
                query = query
                    .orderBy("lastMessageAt", "desc")
                    .startAfter(decoded.lastMessageAt, decoded.conversationId);
            }
        } else {
            query = query.orderBy("lastMessageAt", "desc");
        }

        const snapshot = await query.limit(limit).get();
        const conversations = [];
        snapshot.forEach((doc) => {
            conversations.push(doc.data());
        });

        let nextCursor = null;
        if (conversations.length === limit) {
            const last = conversations[conversations.length - 1];
            if (last.lastMessageAt && last.conversationId) {
                nextCursor = Buffer.from(
                    JSON.stringify({ lastMessageAt: last.lastMessageAt, conversationId: last.conversationId })
                ).toString("base64");
            }
        }

        return { conversations, nextCursor };
    } catch (error) {
        console.error("[MessageRecorder] lỗi listConversations:", error.message);
        return { conversations: [], nextCursor: null };
    }
}

// ---------------------------------------------------------------------------
// Lấy lịch sử tin nhắn của một hội thoại. Phân trang cursor.
// ---------------------------------------------------------------------------
async function getMessageHistory(botId, chatId, options = {}) {
    const db = getDb();
    if (!db) return { messages: [], nextCursor: null };

    const convId = conversationIdFor(botId, chatId);
    const limit = Math.min(Number(options.limit) || 50, 200);

    // Chế độ TĂNG DẦN: chỉ lấy tin mới hơn mốc `since`. Dùng cho cập nhật
    // realtime — client đã có lịch sử cũ, chỉ cần phần vừa phát sinh.
    // where + orderBy trên CÙNG một trường nên không cần composite index.
    if (options.since) {
        try {
            const snapshot = await db.collection(CONVERSATIONS_COLLECTION)
                .doc(convId)
                .collection(MESSAGES_SUBCOLLECTION)
                .where("createdAt", ">", String(options.since))
                .orderBy("createdAt", "asc")
                .limit(limit)
                .get();
            const messages = [];
            snapshot.forEach((doc) => messages.push(doc.data()));
            return { messages, nextCursor: null, incremental: true };
        } catch (error) {
            console.error(`[MessageRecorder] lỗi getMessageHistory(since) ${convId}:`, error.message);
            return { messages: [], nextCursor: null, incremental: true };
        }
    }

    try {
        let query = db.collection(CONVERSATIONS_COLLECTION)
            .doc(convId)
            .collection(MESSAGES_SUBCOLLECTION)
            .orderBy("createdAt", "desc");

        if (options.cursor) {
            const decoded = JSON.parse(Buffer.from(options.cursor, "base64").toString("utf8"));
            if (decoded.createdAt && decoded.messageId) {
                query = query.startAfter(decoded.createdAt, decoded.messageId);
            }
        }

        const snapshot = await query.limit(limit).get();
        const messages = [];
        snapshot.forEach((doc) => {
            messages.push(doc.data());
        });

        // Đảo ngược để hiển thị theo thứ tự thời gian tăng dần (cũ → mới).
        messages.reverse();

        let nextCursor = null;
        if (snapshot.size === limit) {
            const first = messages[0];  // tin cũ nhất trong trang này
            if (first && first.createdAt && first.messageId) {
                nextCursor = Buffer.from(
                    JSON.stringify({ createdAt: first.createdAt, messageId: first.messageId })
                ).toString("base64");
            }
        }

        return { messages, nextCursor };
    } catch (error) {
        console.error(`[MessageRecorder] lỗi getMessageHistory ${convId}:`, error.message);
        return { messages: [], nextCursor: null };
    }
}

// ---------------------------------------------------------------------------
// Đánh dấu hội thoại đã đọc (reset unreadCount).
// ---------------------------------------------------------------------------
async function markConversationRead(botId, chatId) {
    const db = getDb();
    if (!db) return false;

    const convId = conversationIdFor(botId, chatId);
    try {
        await db.collection(CONVERSATIONS_COLLECTION).doc(convId).set({
            unreadCount: 0,
            readAt: new Date().toISOString()
        }, { merge: true });
        publishChatEvent({
            type: CHAT_EVENT.READ,
            conversationId: convId,
            botId: normalizeBotId(botId) || "bot1",
            chatId: String(chatId)
        });
        return true;
    } catch (error) {
        console.error(`[MessageRecorder] lỗi markConversationRead ${convId}:`, error.message);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Gắn (hoặc thay) attachment của một tin đã ghi.
//
// Dùng cho tin VÀO có ảnh/tệp: ghi lịch sử ngay khi tin tới (để không chặn xử lý
// lệnh), rồi tải media về sau và cập nhật lại. UI nhận sự kiện UPDATE để thay
// chỗ "đang tải" bằng ảnh thật mà không cần tải lại trang.
// ---------------------------------------------------------------------------
async function updateMessageAttachments(botId, chatId, messageId, attachments, options = {}) {
    const db = getDb();
    if (!db || !messageId) return false;

    const convId = conversationIdFor(botId, chatId);
    const msgRef = db.collection(CONVERSATIONS_COLLECTION)
        .doc(convId)
        .collection(MESSAGES_SUBCOLLECTION)
        .doc(messageId);

    try {
        const patch = { attachments: Array.isArray(attachments) ? attachments.slice(0, 10) : [] };
        if (options.text !== undefined) patch.text = String(options.text).slice(0, 4096);
        await msgRef.set(patch, { merge: true });

        publishChatEvent({
            type: CHAT_EVENT.UPDATE,
            conversationId: convId,
            botId: normalizeBotId(botId) || "bot1",
            chatId: String(chatId),
            messageId,
            patch
        });
        return true;
    } catch (error) {
        console.error(`[MessageRecorder] lỗi updateMessageAttachments ${convId}/${messageId}:`, error.message);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Cập nhật trạng thái delivery cho một tin nhắn.
// ---------------------------------------------------------------------------
async function updateMessageStatus(botId, chatId, messageId, { status, error = null }) {
    const db = getDb();
    if (!db) return false;

    const convId = conversationIdFor(botId, chatId);
    const msgRef = db.collection(CONVERSATIONS_COLLECTION)
        .doc(convId)
        .collection(MESSAGES_SUBCOLLECTION)
        .doc(messageId);

    try {
        const now = new Date().toISOString();
        const update = { status };
        if (status === STATUS.SENT || status === STATUS.DELIVERED) update.deliveredAt = now;
        if (status === STATUS.FAILED) { update.failedAt = now; update.error = String(error || "").slice(0, 500); }
        if (error) update.error = String(error).slice(0, 500);

        await msgRef.set(update, { merge: true });

        // Cập nhật conversation-level status.
        await db.collection(CONVERSATIONS_COLLECTION).doc(convId).set({
            lastMessageStatus: status,
            updatedAt: now
        }, { merge: true });

        publishChatEvent({
            type: CHAT_EVENT.STATUS,
            conversationId: convId,
            botId: normalizeBotId(botId) || "bot1",
            chatId: String(chatId),
            messageId,
            status,
            error: error ? String(error).slice(0, 500) : null
        });

        return true;
    } catch (error) {
        console.error(`[MessageRecorder] lỗi updateMessageStatus:`, error.message);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Đếm số hội thoại chưa đọc (cho badge trên UI).
// ---------------------------------------------------------------------------
async function getUnreadCount(botId) {
    const db = getDb();
    if (!db) return 0;

    try {
        let query = db.collection(CONVERSATIONS_COLLECTION).where("unreadCount", ">", 0);
        if (botId) {
            query = query.where("botId", "==", normalizeBotId(botId));
        }
        const snapshot = await query.get();
        let total = 0;
        snapshot.forEach((doc) => {
            total += doc.data().unreadCount || 0;
        });
        return total;
    } catch (error) {
        console.error("[MessageRecorder] lỗi getUnreadCount:", error.message);
        return 0;
    }
}

// ---------------------------------------------------------------------------
// Tìm hoặc tạo conversation metadata từ dữ liệu chat directory.
// Dùng khi Chat Center cần đảm bảo một hội thoại tồn tại trước khi gửi.
// ---------------------------------------------------------------------------
async function ensureConversation({ botId, chatId, chatType, displayName }) {
    return upsertConversation({ botId, chatId, chatType, displayName });
}

// ---------------------------------------------------------------------------
// Lấy thông tin một conversation cụ thể.
// ---------------------------------------------------------------------------
async function getConversation(botId, chatId) {
    const db = getDb();
    if (!db) return null;

    const convId = conversationIdFor(botId, chatId);
    try {
        const doc = await db.collection(CONVERSATIONS_COLLECTION).doc(convId).get();
        return doc.exists ? doc.data() : null;
    } catch (error) {
        console.error(`[MessageRecorder] lỗi getConversation ${convId}:`, error.message);
        return null;
    }
}

module.exports = {
    CONVERSATIONS_COLLECTION,
    MESSAGES_SUBCOLLECTION,
    DIRECTION,
    STATUS,
    SOURCE,
    conversationIdFor,
    recordMessage,
    upsertConversation,
    ensureConversation,
    getConversation,
    listConversations,
    getMessageHistory,
    markConversationRead,
    updateMessageStatus,
    updateMessageAttachments,
    getUnreadCount
};
