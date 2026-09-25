// ============================================================================
// Thu thập BẰNG CHỨNG về nguồn gốc của một bản ghi, để quản trị viên xem trước khi
// xác minh.
//
// Mục tiêu không phải là tự quyết định, mà là trình bày trung thực mọi dấu vết đang
// có — kể cả những dấu vết KHÔNG kết luận được. Người xác minh cần thấy cả bằng
// chứng ủng hộ lẫn bằng chứng chống lại một lựa chọn.
//
// TUYỆT ĐỐI không đưa token, cookie, imei hay bất kỳ bí mật phiên nào vào đây: báo
// cáo này hiển thị trên dashboard.
// ============================================================================
const { parseScopedKey, normalizeBotId } = require("./bots");

// Nhãn an toàn cho một nguồn. Không bao giờ chứa token.
function describeSource(botId) {
    const value = String(botId || "");
    if (!value) return "Chưa rõ";
    if (value.startsWith("zca:")) {
        const uid = value.slice(4);
        return value === "zca:pending" ? "Tài khoản Zalo cá nhân (chưa đăng nhập)" : `Tài khoản Zalo cá nhân ${uid}`;
    }
    return `Bot ${value}`;
}

// Thu thập bằng chứng cho MỘT bản ghi.
//
// `context` do nơi gọi cung cấp vì chỉ nơi đó mới có toàn cảnh các store:
//   allRecords: [{ storeId, key, record, chatId, userId }]
function buildEvidence(target, context = {}) {
    const all = Array.isArray(context.allRecords) ? context.allRecords : [];
    const targetChatId = target.chatId != null ? String(target.chatId) : null;
    const targetUserId = target.userId != null ? String(target.userId) : null;

    const parsed = parseScopedKey(target.key);
    const declaredBotId = normalizeBotId(target.record?.botId);

    const evidence = [];
    const candidates = new Map();   // botId -> { botId, sources: [] }

    const addCandidate = (botId, source, detail) => {
        if (!botId) return;
        if (!candidates.has(botId)) candidates.set(botId, { botId, label: describeSource(botId), sources: [] });
        candidates.get(botId).sources.push({ source, detail });
    };

    // 1. Trường botId trên chính bản ghi.
    evidence.push({
        kind: "record_field",
        label: "Trường botId trên bản ghi",
        value: declaredBotId || "(không có)",
        reliable: Boolean(declaredBotId),
        detail: declaredBotId
            ? "Do hệ thống ghi ra. Có thể sai nếu bản ghi được ghi trong ngữ cảnh bot khác."
            : "Bản ghi không khai báo nguồn."
    });
    addCandidate(declaredBotId, "record_field", "Trường botId trên bản ghi");

    // 2. Phạm vi của khóa lưu trữ.
    evidence.push({
        kind: "storage_key",
        label: "Khóa lưu trữ",
        value: target.key,
        reliable: parsed.scoped,
        detail: parsed.scoped
            ? `Khóa có phạm vi "${parsed.botId}" — đây là bằng chứng mạnh.`
            : "Khóa không có phạm vi, nên không nói được bản ghi thuộc bot nào."
    });
    if (parsed.scoped) addCandidate(parsed.botId, "storage_key", "Tiền tố khóa lưu trữ");

    // 3. Bản ghi khác có phạm vi, cùng chatId hoặc userId.
    //
    // Đây là bằng chứng gián tiếp: nếu chatId này chỉ từng xuất hiện dưới khóa của
    // một nguồn, thì bản ghi trỏ tới nó rất có thể thuộc nguồn đó. Nếu xuất hiện ở
    // nhiều nguồn thì KHÔNG kết luận được — và phải nói rõ điều đó.
    const chatScopes = new Map();
    const userScopes = new Map();
    for (const item of all) {
        if (item === target) continue;
        const itemParsed = parseScopedKey(item.key);
        if (!itemParsed.scoped) continue;
        if (item.chatId != null) {
            const id = String(item.chatId);
            if (!chatScopes.has(id)) chatScopes.set(id, new Set());
            chatScopes.get(id).add(itemParsed.botId);
        }
        if (item.userId != null) {
            const id = String(item.userId);
            if (!userScopes.has(id)) userScopes.set(id, new Set());
            userScopes.get(id).add(itemParsed.botId);
        }
    }

    const describeScope = (scopes) => (scopes ? [...scopes].map(describeSource).join(", ") : "(không có)");

    const chatScopesForTarget = targetChatId ? chatScopes.get(targetChatId) : null;
    evidence.push({
        kind: "chat_id_scope",
        label: "Phạm vi của Chat ID trong toàn hệ thống",
        value: targetChatId || "(không có)",
        reliable: Boolean(chatScopesForTarget && chatScopesForTarget.size === 1),
        detail: !targetChatId
            ? "Bản ghi không có Chat ID."
            : !chatScopesForTarget
                ? "Chat ID này không xuất hiện ở bản ghi nào có phạm vi — không có bằng chứng."
                : chatScopesForTarget.size === 1
                    ? `Chat ID này CHỈ xuất hiện ở: ${describeScope(chatScopesForTarget)}.`
                    : `Chat ID này xuất hiện ở NHIỀU nguồn: ${describeScope(chatScopesForTarget)} — không kết luận được.`
    });
    if (chatScopesForTarget && chatScopesForTarget.size === 1) {
        for (const botId of chatScopesForTarget) addCandidate(botId, "chat_id_scope", "Chat ID chỉ xuất hiện ở nguồn này");
    }

    const userScopesForTarget = targetUserId ? userScopes.get(targetUserId) : null;
    evidence.push({
        kind: "user_id_scope",
        label: "Phạm vi của User ID trong toàn hệ thống",
        value: targetUserId || "(không có)",
        reliable: Boolean(userScopesForTarget && userScopesForTarget.size === 1),
        detail: !targetUserId
            ? "Bản ghi không có User ID."
            : !userScopesForTarget
                ? "User ID này không xuất hiện ở bản ghi nào có phạm vi — không có bằng chứng."
                : userScopesForTarget.size === 1
                    ? `User ID này CHỈ xuất hiện ở: ${describeScope(userScopesForTarget)}.`
                    : `User ID này xuất hiện ở NHIỀU nguồn: ${describeScope(userScopesForTarget)} — không kết luận được.`
    });
    if (userScopesForTarget && userScopesForTarget.size === 1) {
        for (const botId of userScopesForTarget) addCandidate(botId, "user_id_scope", "User ID chỉ xuất hiện ở nguồn này");
    }

    // 4. Nói rõ điều KHÔNG dùng làm bằng chứng, để không ai tưởng nhầm.
    evidence.push({
        kind: "excluded",
        label: "Không dùng làm bằng chứng",
        value: "Tên hiển thị, MSSV, tên nhóm",
        reliable: false,
        detail: "Hai người khác nhau có thể trùng tên hoặc trùng MSSV, nên những trường này không xác định được nguồn."
    });

    const ranked = [...candidates.values()].sort((a, b) => b.sources.length - a.sources.length);
    const consistent = ranked.length === 1;

    return {
        record: {
            storeId: target.storeId,
            key: target.key,
            chatId: targetChatId,
            userId: targetUserId,
            declaredBotId: declaredBotId || null,
            displayName: target.record?.displayName || target.record?.userDisplayName || null
        },
        evidence,
        candidates: ranked,
        // Gợi ý chỉ là gợi ý: giao diện vẫn bắt quản trị viên tự chọn và tự xác nhận.
        suggestion: consistent ? ranked[0].botId : null,
        consistent,
        note: consistent
            ? "Mọi bằng chứng đều chỉ về cùng một nguồn."
            : ranked.length === 0
                ? "Không có bằng chứng nào chỉ ra nguồn."
                : "Các bằng chứng KHÔNG thống nhất — cần quản trị viên quyết định."
    };
}

module.exports = { buildEvidence, describeSource };
