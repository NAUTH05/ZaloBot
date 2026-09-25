const { getAllChats, getDeletedChatIds } = require("./chatDirectory");
const { getInteractionTargets } = require("./interactionRegistry");
const { getAllSubscriptions, isCurrentSubscription, normalizeNotificationTimes } = require("./subscriptions");
const { getAccessSummary } = require("./accessControl");
const path = require("path");
const { parseScopedKey, normalizeBotId, storageKeyPrefix, LEGACY_BOT_ID } = require("./bots");
const { readJsonStore } = require("./firestorePersistence");
const { SOURCE_CONFIDENCE, isVerifiedConfidence, resolveRecordSource, scopedIdentityKey } = require("./sourceAttribution");
const { getActiveVerifications } = require("./sourceVerifications");

// Dấu hiệu nhóm chưa xác minh trong khóa gộp. Phải trùng với sourceAttribution.
const UNVERIFIED_KEY_MARKER = "__unverified__";

function normalizeType(value) {
    const raw = String(value || "").toLowerCase();
    if (["private", "user", "direct", "individual"].includes(raw)) return "private";
    if (["group", "group_chat", "room"].includes(raw)) return "group";
    return "unknown";
}

function typeFromIdentifiers(chatId, userIds = []) {
    const normalizedUsers = [...new Set(userIds.filter(Boolean).map(String))];
    if (normalizedUsers.length > 1) return { chatType: "group", typeSource: "multiple_members" };
    if (normalizedUsers.length === 1 && normalizedUsers[0] === String(chatId)) {
        return { chatType: "private", typeSource: "matching_user_chat_id" };
    }
    // Zalo may use different identifiers for a private conversation and its user.
    // A mismatching pair is therefore not enough evidence to classify a group.
    if (normalizedUsers.length === 1) return { chatType: "unknown", typeSource: "identifier_mismatch" };
    return { chatType: "unknown", typeSource: "unresolved" };
}

function latestIso(...values) {
    return values.filter(Boolean).sort((a, b) => String(b).localeCompare(String(a)))[0] || null;
}

// Các trường nguồn gốc đưa ra ngoài cho dashboard.
//
// `canSend` là chốt an toàn: nguồn chưa xác minh thì giao diện phải chặn mọi thao
// tác có thể gửi tin, vì gửi sai bot là gửi cho người khác.
function sourceFields(source, storeId = null, recordKey = null) {
    return {
        sourceStoreId: storeId,
        sourceRecordKey: recordKey,
        sourceConfidence: source.confidence,
        sourceLabel: source.label,
        sourceReason: source.reason || null,
        sourceVerified: isVerifiedConfidence(source.confidence),
        canSend: Boolean(source.canSend)
    };
}

// Nguồn gốc của một bản ghi.
//
// Trước đây hàm này lấy parseScopedKey(key).botId, mà hàm đó trả bot1 cho MỌI
// khóa không có phạm vi — và cờ `scoped: false` bị bỏ qua. Nghĩa là bản ghi cũ
// không rõ nguồn bị gán cho bot1 mà không có dấu hiệu nào.
//
// Nay dùng quy tắc dùng chung ở sourceAttribution.js: thiếu bằng chứng thì trả về
// CHƯA XÁC MINH thay vì đoán bot1.
// Bản đồ xác minh do quản trị viên thực hiện, nạp một lần cho mỗi lượt dựng dữ liệu.
let activeVerifications = {};

// sourceOf cần storeId vì xác minh được lưu theo TỪNG STORE: cùng một khóa có thể
// tồn tại ở nhiều store với nguồn khác nhau.
function sourceOf(record, key = "", storeId = null) {
    const verification = storeId ? activeVerifications[`${storeId}::${key}`] || null : null;
    return resolveRecordSource(record, key, { verification });
}

// botId đã xác minh, hoặc null nếu chưa đủ căn cứ. KHÔNG bao giờ tự gán bot1.
function botIdOf(record, key = "") {
    return sourceOf(record, key).botId;
}

// Khóa gộp phải gồm nguồn: cùng một Chat ID ở bot 1 và bot 2 là hai cuộc trò
// chuyện khác nhau, gộp theo chatId trần sẽ trộn dữ liệu của hai bot.
//
// Bản ghi CHƯA XÁC MINH (botId = null) dùng một khóa riêng, không trộn vào bot
// nào và cũng không bị coi là bot1.
function scopedChatId(botId, chatId) {
    return scopedIdentityKey(botId, String(chatId));
}

// Tách lại khóa gộp. Trả botId = null cho nhóm chưa xác minh.
function parseScopedChatId(chatKey) {
    const separator = chatKey.indexOf("::");
    if (separator < 0) return { botId: null, chatId: chatKey };
    const rawBotId = chatKey.slice(0, separator);
    return {
        botId: rawBotId === UNVERIFIED_KEY_MARKER ? null : rawBotId,
        chatId: chatKey.slice(separator + 2)
    };
}

// Chỉ mục KHÓA THẬT theo chatId, cho từng store.
//
// getAllChats() trả về giá trị bản ghi mà BỎ MẤT khóa lưu trữ. Nhưng khóa thật là
// thứ duy nhất API xác minh nguồn chấp nhận — gửi khóa tổng hợp của dashboard
// ("__unverified__::<chatId>") lên API sẽ luôn 404 vì không có bản ghi nào như vậy.
//
// Hàm này đọc thẳng store để lấy khóa thật.
function realKeysByChatId(storeId) {
    const filePath = path.join(__dirname, `${storeId}.json`);
    const index = new Map();
    let data = null;
    try {
        data = readJsonStore(filePath, filePath, null);
    } catch (error) {
        console.warn(`Không đọc được ${storeId} để lấy khóa thật: ${error.message}`);
        return index;
    }
    if (!data || typeof data !== "object") return index;

    const containers = [];
    if (data.chats && typeof data.chats === "object") containers.push(data.chats);
    const flat = {};
    for (const [key, value] of Object.entries(data)) {
        if (["schemaVersion", "chats", "tickets", "deletedChatIds", "sourceIndex"].includes(key)) continue;
        if (value && typeof value === "object") flat[key] = value;
    }
    if (Object.keys(flat).length) containers.push(flat);

    for (const container of containers) {
        for (const [recordKey, record] of Object.entries(container)) {
            if (!record || typeof record !== "object") continue;
            const chatId = record.chatId != null ? String(record.chatId) : null;
            if (!chatId) continue;
            if (!index.has(chatId)) index.set(chatId, []);
            index.get(chatId).push({ storeId, recordKey, record });
        }
    }
    return index;
}

function buildAdminData() {
    activeVerifications = getActiveVerifications();
    // Khóa THẬT của từng store, để giao diện gọi đúng API xác minh.
    const realKeys = {
        chatDirectory: realKeysByChatId("chatDirectory"),
        interactions: realKeysByChatId("interactions"),
        subscriptions: realKeysByChatId("subscriptions")
    };
    const rawChats = getAllChats();
    const interactions = getInteractionTargets();
    const rawSubscriptions = Object.entries(getAllSubscriptions());

    // Nguồn suy ra từ CHAT mà một bản ghi tham chiếu.
    //
    // Bản ghi tương tác không có trường botId và getInteractionTargets() không trả
    // về khóa lưu trữ, nên không thể đọc nguồn từ khóa. Nhưng nó trỏ tới một chatId
    // cụ thể, và nếu chat đó chỉ thuộc ĐÚNG MỘT bot đã xác minh thì nguồn của chat
    // chính là nguồn của bản ghi.
    //
    // Nếu chatId thuộc nhiều bot (cùng Chat ID ở hai bot) thì KHÔNG suy ra — để
    // nguyên là chưa xác minh thay vì đoán.
    const verifiedChatOwners = new Map();
    for (const chat of rawChats) {
        const source = sourceOf(chat, "", "chatDirectory");
        if (!source.botId) continue;
        const chatId = String(chat.chatId);
        if (!verifiedChatOwners.has(chatId)) verifiedChatOwners.set(chatId, new Set());
        verifiedChatOwners.get(chatId).add(source.botId);
    }
    const ownerFromChatId = (chatId) => {
        const owners = verifiedChatOwners.get(String(chatId));
        return owners && owners.size === 1 ? [...owners][0] : null;
    };

    // Nguồn suy ra từ CHAT mà bản ghi tham chiếu, dùng chung cho mọi store có trường
    // chatId (tương tác, đăng ký nhận lịch).
    //
    // Vì sao cần: một đăng ký nhận lịch không có trường botId, nhưng nó trỏ tới một
    // chatId cụ thể. Nếu chat đó đã xác minh được nguồn thì đăng ký thuộc chính nguồn
    // ấy. Thiếu bước này, mỗi đăng ký như vậy sinh ra một DÒNG RIÊNG mang khóa tổng
    // hợp "__unverified__::<chatId>" cho cùng một cuộc trò chuyện đã biết nguồn —
    // vừa trùng lặp vừa không xác minh được.
    //
    // Nếu chatId thuộc nhiều bot thì KHÔNG suy ra — để nguyên chưa xác minh.
    const sourceWithChatInheritance = (item, storeId, recordKey = "") => {
        // recordKey PHẢI là khóa thật: xác minh của quản trị viên được lưu theo
        // (storeId, khóa). Truyền khóa rỗng thì không bao giờ tra được xác minh.
        const declared = sourceOf(item, recordKey, storeId);
        if (declared.botId) return declared;
        const inherited = ownerFromChatId(item.chatId);
        if (!inherited) return declared;
        return {
            botId: inherited,
            confidence: SOURCE_CONFIDENCE.FROM_SCOPED_KEY,
            label: "Đã xác minh (theo chat tham chiếu)",
            canSend: true,
            declaredBotId: null,
            keyBotId: inherited,
            reason: null
        };
    };

    const interactionSource = (item, recordKey = "") => sourceWithChatInheritance(item, "interactions", recordKey);

    // Khóa thật của từng bản ghi tương tác, tra theo chatId.
    //
    // getInteractionTargets() trả về giá trị mà BỎ MẤT khóa, nhưng xác minh của quản
    // trị viên được lưu theo (storeId, khóa). Thiếu khóa thật thì không bao giờ tra
    // được xác minh, và dòng sẽ mãi ở trạng thái chưa rõ tài khoản.
    const interactionRealKey = (item) => {
        const entries = realKeys.interactions.get(String(item.chatId)) || [];
        if (!entries.length) return "";
        // Cùng một chatId có thể có NHIỀU bản ghi tương tác (một ở bot1, một ở bot2).
        // Phải chọn đúng khóa của bản ghi này, nếu không sẽ tra xác minh của bản ghi
        // khác và kết luận sai tài khoản.
        const declared = normalizeBotId(item.botId);
        if (declared) {
            const match = entries.find((entry) => normalizeBotId(entry.record?.botId) === declared);
            if (match) return match.recordKey;
        }
        // Không khai báo botId: dùng khóa KHÔNG có phạm vi (bản ghi của bot1).
        const unscoped = entries.find((entry) => !parseScopedKey(entry.recordKey).scoped);
        return unscoped ? unscoped.recordKey : entries[0].recordKey;
    };

    const interactionByChat = new Map(interactions.map((item) => [
        scopedChatId(interactionSource(item, interactionRealKey(item)).botId, String(item.chatId)),
        item
    ]));
    const subscriptionsByChat = new Map();
    const users = new Map();

    const subscriptions = rawSubscriptions.map(([key, raw]) => {
        const current = isCurrentSubscription(raw);
        const source = sourceWithChatInheritance(raw, "subscriptions");
        const botId = source.botId;
        const item = {
            key,
            botId,
            ...sourceFields(source, "subscriptions", key),
            schema: current ? "current" : "legacy",
            chatId: String(raw?.chatId ?? (!key.includes("::") ? key : "")),
            userId: raw?.userId == null ? null : String(raw.userId),
            userDisplayName: String(raw?.userDisplayName || ""),
            chatType: normalizeType(raw?.chatType),
            chatTitle: String(raw?.chatTitle || ""),
            studentId: String(raw?.studentId || ""),
            studentName: String(raw?.studentName || ""),
            notificationsEnabled: raw?.notificationsEnabled === true,
            classStartNotificationsEnabled: raw?.classStartNotificationsEnabled === true,
            notificationTimes: normalizeNotificationTimes(raw),
            updatedAt: raw?.updatedAt || null
        };
        if (item.chatId) {
            const groupKey = scopedChatId(botId, item.chatId);
            const list = subscriptionsByChat.get(groupKey) || [];
            list.push(item);
            subscriptionsByChat.set(groupKey, list);
        }
        return item;
    });

    // Mỗi cặp (botId, chatId) là một dòng riêng trong dashboard.
    const allChatKeys = new Set([
        ...rawChats.map((chat) => scopedChatId(sourceOf(chat, "", "chatDirectory").botId, String(chat.chatId))),
        ...interactions.map((item) => scopedChatId(interactionSource(item, interactionRealKey(item)).botId, String(item.chatId))),
        ...subscriptions.filter((item) => item.chatId).map((item) => scopedChatId(item.botId, item.chatId))
    ]);

    // Chat đã bị xoá vĩnh viễn không được hiện lại chỉ vì còn dữ liệu tương tác
    // hoặc đăng ký. Khóa trong deletedChatIds dùng đúng quy ước lưu trữ
    // (bot1 không tiền tố, botN có tiền tố) nên phải so bằng storageKeyPrefix.
    const deletedKeys = new Set(getDeletedChatIds());
    for (const chatKey of [...allChatKeys]) {
        const { botId, chatId } = parseScopedChatId(chatKey);
        // Chỉ so tombstone khi đã biết nguồn: khóa tombstone phụ thuộc bot.
        if (botId && deletedKeys.has(`${storageKeyPrefix(botId)}${chatId}`)) allChatKeys.delete(chatKey);
    }

    const chats = [...allChatKeys].map((chatKey) => {
        const { botId, chatId } = parseScopedChatId(chatKey);
        const chatRecord = rawChats.find((item) => sourceOf(item, "", "chatDirectory").botId === botId && String(item.chatId) === chatId);
        const chat = chatRecord || { chatId, botId, status: "active" };
        const chatSource = chatRecord
            ? sourceOf(chatRecord, "", "chatDirectory")
            : { botId, confidence: botId ? SOURCE_CONFIDENCE.FROM_SCOPED_KEY : SOURCE_CONFIDENCE.UNVERIFIED_LEGACY, canSend: Boolean(botId), label: null };
        // Nếu bản ghi chatDirectory không xác định được tài khoản (hoặc không tồn tại),
        // dòng vẫn có thể học từ các bản ghi đóng góp khác — nhưng chỉ khi bằng chứng
        // nhất quán. Xem resolvedSource bên dưới.
        const interaction = interactionByChat.get(chatKey);
        const chatSubscriptions = subscriptionsByChat.get(chatKey) || [];

        // Mọi bản ghi THẬT đóng góp vào dòng này, kèm trạng thái xác minh riêng.
        //
        // Một dòng dashboard có thể được dựng từ nhiều bản ghi ở nhiều store. Giao
        // diện phải xác minh được TỪNG bản ghi, và không được coi cả dòng là đã xác
        // minh chỉ vì một trong số đó đã xác minh.
        const sourceRecords = [];
        const collect = (storeId, entries, resolve) => {
            for (const entry of entries || []) {
                const source = resolve(entry.record, entry.recordKey);
                sourceRecords.push({
                    storeId,
                    recordKey: entry.recordKey,
                    botId: source.botId,
                    confidence: source.confidence,
                    canSend: Boolean(source.canSend),
                    verified: isVerifiedConfidence(source.confidence),
                    reason: source.reason || null
                });
            }
        };
        collect("chatDirectory", (realKeys.chatDirectory.get(String(chatId)) || []).filter((entry) => entry.recordKey === chatKey || !parseScopedKey(entry.recordKey).scoped), (record, recordKey) => sourceOf(record, recordKey, "chatDirectory"));
        collect("interactions", (realKeys.interactions.get(String(chatId)) || []).filter((entry) => scopedChatId(interactionSource(entry.record, entry.recordKey).botId, String(chatId)) === chatKey), (record, recordKey) => interactionSource(record, recordKey));
        collect("subscriptions", (realKeys.subscriptions.get(String(chatId)) || []).filter((entry) => chatSubscriptions.some((sub) => sub.key === entry.recordKey)), (record, recordKey) => sourceWithChatInheritance(record, "subscriptions", recordKey));

        // Bản ghi nào còn cần xác minh. Dòng chỉ được coi là "đã xác minh đầy đủ"
        // khi MỌI bản ghi đóng góp đều đã xác minh.
        const pendingRecords = sourceRecords.filter((item) => !item.verified);

        // Tài khoản của DÒNG.
        //
        // Ưu tiên nguồn của bản ghi chatDirectory. Nếu bản ghi đó không xác định được
        // tài khoản, dòng có thể học từ các bản ghi đóng góp ĐÃ XÁC MINH — nhưng chỉ
        // khi chúng cùng chỉ về MỘT tài khoản. Nhiều tài khoản khác nhau thì không kết
        // luận, vì đó là dấu hiệu dữ liệu không nhất quán.
        const verifiedOwners = [...new Set(
            sourceRecords.filter((item) => item.verified && item.botId).map((item) => item.botId)
        )];
        const resolvedSource = chatSource.botId
            ? chatSource
            : (verifiedOwners.length === 1
                ? {
                    botId: verifiedOwners[0],
                    confidence: SOURCE_CONFIDENCE.MANUAL,
                    label: "Đã xác minh (theo bản ghi đã xác minh cùng dòng)",
                    canSend: true,
                    declaredBotId: null,
                    keyBotId: verifiedOwners[0],
                    reason: null
                }
                : chatSource);

        // Mở khoá Quản lý chỉ khi MỌI bản ghi đóng góp đều đã xác minh.
        //
        // Không đủ nếu chỉ một bản ghi được xác minh: phần còn lại vẫn có thể trỏ tới
        // tài khoản khác, và thao tác gửi sẽ đi sai người.
        const allRecordsVerified = sourceRecords.length > 0 && pendingRecords.length === 0;
        const rowCanSend = Boolean(resolvedSource.botId) && allRecordsVerified;

        // Khóa để giao diện gọi API xác minh.
        //
        // PHẢI là khóa THẬT trong store. Với dòng không có bản ghi chatDirectory thật
        // (dòng tổng hợp), khóa tổng hợp "__unverified__::<chatId>" không tồn tại trong
        // Firestore nên API sẽ trả 404 — đúng lỗi đang sửa. Khi đó trỏ tới bản ghi thật
        // đầu tiên còn cần xác minh.
        const realChatEntry = (realKeys.chatDirectory.get(String(chatId)) || [])
            .find((entry) => !parseScopedKey(entry.recordKey).scoped);
        const primaryTarget = realChatEntry
            ? { storeId: "chatDirectory", recordKey: realChatEntry.recordKey }
            : (pendingRecords[0] || sourceRecords[0] || null);
        const memberIds = new Set([
            ...Object.keys(interaction?.members || {}),
            ...chatSubscriptions.map((item) => item.userId).filter(Boolean),
            ...(chat.userId ? [String(chat.userId)] : []),
            ...(interaction?.lastUserId ? [String(interaction.lastUserId)] : [])
        ]);
        const interactionType = normalizeType(interaction?.chatType);
        const storedType = normalizeType(chat.chatType);
        let chatType = "unknown";
        let typeSource = "unresolved";
        if (interactionType !== "unknown") { chatType = interactionType; typeSource = "zalo_interaction"; }
        else if (storedType !== "unknown") { chatType = storedType; typeSource = "chat_directory"; }
        else if (chatSubscriptions.some((item) => item.chatType !== "unknown")) {
            chatType = chatSubscriptions.find((item) => item.chatType !== "unknown").chatType;
            typeSource = "subscription_metadata";
        } else {
            const inferred = typeFromIdentifiers(chatId, [...memberIds]);
            chatType = inferred.chatType;
            typeSource = inferred.typeSource;
        }

        const displayName = String(chat.displayName || interaction?.chatTitle || chatSubscriptions.find((item) => item.chatTitle)?.chatTitle || interaction?.lastUserDisplayName || `Chat ${chatId}`);
        // Trạng thái tiếp nhận: bản ghi CŨ không có trường này coi như đã tiếp nhận.
        // `pending` = mới chỉ có sự kiện vào; `unreachable` = gửi tới thất bại dứt khoát.
        const admissionStatus = chat.admissionStatus === "pending" || chat.admissionStatus === "unreachable"
            ? chat.admissionStatus
            : "admitted";
        const record = {
            ...chat,
            chatId,
            botId,
            chatType,
            typeSource,
            displayName,
            chatTitle: String(chat.chatTitle || interaction?.chatTitle || ""),
            memberCount: memberIds.size,
            subscriptionCount: chatSubscriptions.length,
            enabledSubscriptionCount: chatSubscriptions.filter((item) => item.notificationsEnabled).length,
            studentIds: [...new Set(chatSubscriptions.map((item) => item.studentId).filter(Boolean))],
            lastInboundInteractionAt: chat.lastInboundInteractionAt || interaction?.lastInteractionAt || null,
            firstInteractionAt: chat.firstInteractionAt || interaction?.firstInteractionAt || null,
            // Trạng thái tiếp nhận để dashboard phân biệt ba nhóm.
            admissionStatus,
            unreachableReason: admissionStatus === "unreachable" ? (chat.unreachableReason || null) : null,
            // CHỈ chat đã tiếp nhận mới được tính là người nhận phát tin. `canSend` phản
            // ánh cả nguồn đã xác minh LẪN việc chat đã trả lời được hay chưa.
            canReceiveBroadcast: rowCanSend && admissionStatus === "admitted",
            ...sourceFields(resolvedSource, primaryTarget ? primaryTarget.storeId : null, primaryTarget ? primaryTarget.recordKey : null),
            // Quyền thao tác do MỌI bản ghi đóng góp quyết định, không chỉ một bản ghi.
            canSend: rowCanSend,
            fullyVerified: allRecordsVerified,
            // Danh sách bản ghi thật cần xác minh, kèm trạng thái từng bản ghi.
            sourceRecords,
            pendingRecordCount: pendingRecords.length,
            // Dòng chỉ "sạch" khi mọi bản ghi đóng góp đều đã xác minh.
            fullyVerified: sourceRecords.length > 0 && pendingRecords.length === 0
        };

        for (const userId of memberIds) {
            const member = interaction?.members?.[userId] || {};
            const userSubscriptions = chatSubscriptions.filter((item) => item.userId === userId);
            // Khóa theo (bot, user): một người dùng cả hai bot có cấu hình riêng cho
            // từng bot, và dashboard phải hiển thị chúng tách biệt.
            // Khóa gộp gồm nguồn: null (chưa xác minh) có nhóm riêng, không trộn vào bot1.
            const userKey = `${botId}::${userId}`;
            const existing = users.get(userKey) || {
                key: userKey,
                botId,
                userId,
                displayName: "",
                chats: [],
                subscriptions: [],
                studentIds: [],
                firstInteractionAt: null,
                lastInteractionAt: null,
                ...sourceFields(chatSource, "chatDirectory", chatKey)
            };
            existing.displayName = existing.displayName || member.displayName || userSubscriptions.find((item) => item.userDisplayName)?.userDisplayName || (chatType === "private" ? displayName : "") || `User ${userId}`;
            existing.chats.push({ chatId, botId, chatType, chatName: displayName, status: record.status, memberStatus: member.status || "active" });
            existing.subscriptions.push(...userSubscriptions);
            existing.studentIds = [...new Set([...existing.studentIds, ...userSubscriptions.map((item) => item.studentId).filter(Boolean)])];
            existing.firstInteractionAt = existing.firstInteractionAt || member.firstInteractionAt || (interaction?.lastUserId === userId ? interaction.firstInteractionAt : null);
            existing.lastInteractionAt = latestIso(existing.lastInteractionAt, member.lastInteractionAt, interaction?.lastUserId === userId ? interaction.lastInteractionAt : null, ...userSubscriptions.map((item) => item.updatedAt));
            users.set(userKey, existing);
        }
        return record;
    }).sort((a, b) => a.displayName.localeCompare(b.displayName));

    // Tra theo cặp (bot, chat): cùng một chatId ở hai bot là hai dòng khác nhau.
    const chatByKey = new Map(chats.map((chat) => [scopedChatId(chat.botId, chat.chatId), chat]));
    const normalizedSubscriptions = subscriptions.map((item) => {
        const chat = chatByKey.get(scopedChatId(item.botId, item.chatId));
        const admitted = !chat || chat.admissionStatus === "admitted";
        return {
            ...item,
            chatName: chat?.displayName || item.chatId,
            chatType: chat?.chatType || "unknown",
            chatStatus: chat?.status || "active",
            admissionStatus: chat?.admissionStatus || "admitted",
            // Đăng ký chỉ thật sự "đủ điều kiện" khi chat đã được tiếp nhận VÀ đang hoạt động.
            eligible: chat?.status === "active" && admitted
        };
    });

    for (const user of users.values()) {
        user.subscriptions = normalizedSubscriptions.filter((item) => item.userId === user.userId && item.botId === user.botId);
        user.notificationsEnabled = user.subscriptions.some((item) => item.notificationsEnabled && item.eligible);
        user.notificationTimeCount = user.subscriptions.reduce((sum, item) => sum + item.notificationTimes.length, 0);
        user.status = user.chats.some((item) => item.memberStatus === "active") ? "active" : (user.chats.some((item) => item.memberStatus === "disabled") ? "disabled" : "removed");
    }

    const groups = chats.filter((chat) => chat.chatType === "group").map((chat) => ({
        ...chat,
        members: [...users.values()]
            .filter((user) => user.botId === chat.botId && user.chats.some((item) => item.chatId === chat.chatId))
            .map((user) => ({
                userId: user.userId,
                botId: user.botId,
                displayName: user.displayName,
                studentIds: user.subscriptions.filter((item) => item.chatId === chat.chatId).map((item) => item.studentId).filter(Boolean),
                notificationTimes: user.subscriptions.filter((item) => item.chatId === chat.chatId).flatMap((item) => item.notificationTimes),
                notificationsEnabled: user.subscriptions.some((item) => item.chatId === chat.chatId && item.notificationsEnabled)
            }))
    }));

    // Thống kê theo từng bot — mỗi bot là một danh tính riêng nên đếm riêng.
    // Thống kê theo bot. Bản ghi CHƯA XÁC MINH (botId = null) không thuộc bot nào
    // nên không được đếm vào đây — nếu không chúng sẽ bị cộng nhầm cho một bot.
    const botIds = [...new Set([
        ...chats.map((chat) => chat.botId),
        ...normalizedSubscriptions.map((item) => item.botId)
    ])].filter(Boolean).sort();
    const botStats = botIds.map((botId) => {
        const botChats = chats.filter((chat) => chat.botId === botId);
        return {
            botId,
            chatCount: botChats.length,
            userCount: [...users.values()].filter((user) => user.botId === botId).length,
            groupCount: groups.filter((group) => group.botId === botId).length,
            subscriptionCount: normalizedSubscriptions.filter((item) => item.botId === botId).length,
            enabledSubscriptionCount: normalizedSubscriptions.filter((item) => item.botId === botId && item.notificationsEnabled && item.eligible).length,
            deliveryErrorCount: botChats.filter((chat) => chat.lastError).length,
            // Đếm theo trạng thái tiếp nhận: chỉ "admitted" mới là người nhận hợp lệ.
            admittedChatCount: botChats.filter((chat) => chat.admissionStatus === "admitted").length,
            pendingAdmissionCount: botChats.filter((chat) => chat.admissionStatus === "pending").length,
            unreachableChatCount: botChats.filter((chat) => chat.admissionStatus === "unreachable").length,
            broadcastRecipientCount: botChats.filter((chat) => chat.canReceiveBroadcast).length
        };
    });

    return {
        generatedAt: new Date().toISOString(),
        chats,
        users: [...users.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
        groups,
        subscriptions: normalizedSubscriptions,
        botStats,
        access: getAccessSummary()
    };
}

module.exports = { buildAdminData, normalizeType, typeFromIdentifiers };
