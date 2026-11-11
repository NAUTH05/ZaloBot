// Cổng phản hồi trong NHÓM.
//
// Vấn đề: bot (cả bot chính thức lẫn tài khoản Zalo cá nhân) nhận được MỌI tin
// nhắn của một nhóm mà nó tham gia. Trước đây không có cổng nào, nên chỉ cần nhóm
// chưa được "tiếp nhận" trong bộ nhớ là mỗi tin nhắn vu vơ của bất kỳ thành viên
// nào cũng kích hoạt lời chào — bot "trả lời" cả nhóm dù không ai gọi nó.
//
// Quy tắc nay:
//   - Chat riêng: luôn phản hồi như cũ.
//   - Nhóm: chỉ phản hồi khi bot được NHẮC TỚI (tag), hoặc khi tin là một lệnh
//     "/..." (địa chỉ tường minh tới bot). Tin nhắn thường không tag bị bỏ qua
//     HOÀN TOÀN — không trả lời, không chào, không ghi dữ liệu.
//
// Hai công tắc môi trường (mặc định giữ hành vi an toàn):
//   GROUP_MENTION_ONLY=1                      (mặc định) bật cổng nhóm
//   GROUP_ALLOW_COMMANDS_WITHOUT_MENTION=1    (mặc định) lệnh "/..." vẫn chạy dù không tag
//
// Tắt cổng (GROUP_MENTION_ONLY=0) để quay lại hành vi cũ nếu cần.

const { detectChatType } = require("./interactionRegistry");
// Đọc mention/tên nằm ở module không phụ thuộc, dùng chung với adapter ZCA.
const { collectMentionIds, escapeRegExp, foldText } = require("./mentionUtils");

const CHAT_TYPE_GROUP = "group";

const SKIP_REASON = Object.freeze({
    NOT_GROUP: "not_group",
    MENTIONED: "mentioned",
    COMMAND: "command",
    UNTAGGED: "untagged",
    EMPTY: "empty",
    MENTION_REQUIRED_FOR_COMMAND: "command_without_mention"
});

const DEFAULT_OPTIONS = Object.freeze({
    requireMention: true,
    allowCommandsWithoutMention: true
});

function isGroupChat(msg) {
    return detectChatType(msg || {}) === CHAT_TYPE_GROUP;
}

// Danh tính của bot: ID (nếu nhà cung cấp biết) và các tên có thể xuất hiện sau
// dấu "@" trong nội dung tin nhắn.
function botIdentityOf(runtime = {}) {
    const ids = new Set();
    const names = new Set();

    for (const value of [runtime.ownUid, runtime.uid]) {
        const text = String(value == null ? "" : value).trim();
        if (text) ids.add(text);
    }
    // Khóa "zca:<uid>" cũng mang UID thật.
    const botId = String(runtime.botId || "");
    if (botId.startsWith("zca:")) {
        const uid = botId.slice(4).trim();
        if (uid && uid !== "pending") ids.add(uid);
    }

    for (const value of [runtime.verifiedName, runtime.displayName, runtime.configuredName]) {
        const text = String(value == null ? "" : value).trim();
        // Tên quá ngắn hoặc trùng mã bot ("bot1") không dùng để so khớp nội dung.
        if (text.length >= 2 && !/^bot\d+$/i.test(text) && !text.startsWith("zca:")) names.add(text);
    }

    return { ids: [...ids], names: [...names] };
}

// Bot có được nhắc tới không. Ưu tiên danh sách mention (bằng chứng do nền tảng
// cung cấp); nếu không có, dựa vào tên xuất hiện sau "@" trong nội dung.
function isBotMentioned(msg, runtime = {}, text = null) {
    const { ids, names } = botIdentityOf(runtime);
    const mentionedIds = collectMentionIds(msg);

    for (const id of ids) {
        if (mentionedIds.has(id)) return true;
    }

    const raw = text == null ? String(msg?.text || "") : String(text);
    if (!raw.includes("@")) return false;
    const folded = foldText(raw);
    return names.some((name) => folded.includes(`@${foldText(name)}`));
}

// Bỏ phần tag khỏi nội dung để lệnh phía sau vẫn phân tích được:
// "@Alessandra /help" → "/help".
function stripBotMention(text, runtime = {}) {
    let result = String(text == null ? "" : text);
    const { names } = botIdentityOf(runtime);

    // Tên dài trước để "@Alessandra Bot" không bị cắt thành "@Alessandra".
    for (const name of [...names].sort((a, b) => b.length - a.length)) {
        const pattern = new RegExp(`@\\s*${escapeRegExp(name)}`, "gi");
        result = result.replace(pattern, " ");
    }

    // Tag ở đầu câu nhưng tên không khớp (tên hiển thị khác tên trong tin nhắn).
    result = result.replace(/^\s*@\S+\s*/, " ");
    return result.replace(/\s+/g, " ").trim();
}

function looksLikeCommand(text) {
    return String(text == null ? "" : text).trim().startsWith("/");
}

// Quyết định cuối cùng cho một tin nhắn vào.
//
// Trả về đủ dữ kiện để nơi gọi vừa hành động vừa ghi log:
//   { isGroup, respond, reason, mentioned, isCommand, text }
// `text` là nội dung ĐÃ bỏ tag, dùng để phân tích lệnh.
function resolveGroupReplyDecision({ msg, runtime = {}, text = null, options = {} } = {}) {
    const settings = { ...DEFAULT_OPTIONS, ...(options || {}) };
    const rawText = text == null ? String(msg?.text || "") : String(text);
    const isGroup = isGroupChat(msg);

    if (!isGroup) {
        return {
            isGroup: false,
            respond: true,
            reason: SKIP_REASON.NOT_GROUP,
            mentioned: false,
            isCommand: looksLikeCommand(rawText),
            text: rawText
        };
    }

    const mentioned = isBotMentioned(msg, runtime, rawText);
    const effectiveText = mentioned ? stripBotMention(rawText, runtime) : rawText;
    const isCommand = looksLikeCommand(effectiveText);

    // Cổng nhóm tắt: giữ hành vi cũ, nhưng vẫn trả về nội dung đã bỏ tag.
    if (!settings.requireMention) {
        return { isGroup: true, respond: true, reason: SKIP_REASON.MENTIONED, mentioned, isCommand, text: effectiveText };
    }

    if (mentioned) {
        return { isGroup: true, respond: true, reason: SKIP_REASON.MENTIONED, mentioned, isCommand, text: effectiveText };
    }

    if (isCommand) {
        const allowed = settings.allowCommandsWithoutMention !== false;
        return {
            isGroup: true,
            respond: allowed,
            reason: allowed ? SKIP_REASON.COMMAND : SKIP_REASON.MENTION_REQUIRED_FOR_COMMAND,
            mentioned: false,
            isCommand: true,
            text: effectiveText
        };
    }

    const empty = !String(rawText || "").trim();
    return {
        isGroup: true,
        respond: false,
        reason: empty ? SKIP_REASON.EMPTY : SKIP_REASON.UNTAGGED,
        mentioned: false,
        isCommand: false,
        text: rawText
    };
}

// Đọc công tắc từ môi trường. Giá trị lạ ⇒ dùng mặc định an toàn.
function groupReplyOptionsFromEnv(env = process.env) {
    const read = (name, fallback) => {
        const raw = env?.[name];
        if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
        const value = String(raw).trim().toLowerCase();
        if (["1", "true", "yes", "on", "bat", "bật"].includes(value)) return true;
        if (["0", "false", "no", "off", "tat", "tắt"].includes(value)) return false;
        return fallback;
    };
    return {
        requireMention: read("GROUP_MENTION_ONLY", DEFAULT_OPTIONS.requireMention),
        allowCommandsWithoutMention: read("GROUP_ALLOW_COMMANDS_WITHOUT_MENTION", DEFAULT_OPTIONS.allowCommandsWithoutMention)
    };
}

module.exports = {
    CHAT_TYPE_GROUP,
    DEFAULT_OPTIONS,
    SKIP_REASON,
    botIdentityOf,
    collectMentionIds,
    foldText,
    groupReplyOptionsFromEnv,
    isBotMentioned,
    isGroupChat,
    looksLikeCommand,
    resolveGroupReplyDecision,
    stripBotMention
};
