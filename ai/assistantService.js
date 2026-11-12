// Trợ lý AI hội thoại của ZaloBot.
//
// Trách nhiệm duy nhất của tệp này là ĐIỀU PHỐI:
//   kiểm tra quyền → hạn mức/ngân sách → dựng ngữ cảnh → gọi DeepSeek →
//   kiểm tra phản hồi → (xin xác nhận) → chuyển cho actionExecutor.
//
// Nó không tự ghi dữ liệu nghiệp vụ và không tự quyết định quyền hạn. Mọi thứ
// liên quan tới dữ liệu người dùng đều đi qua actionExecutor + các dịch vụ cũ.

const { loadAiConfig, estimateCostUsd } = require("./aiConfig");
const { AiProviderError, ERROR_KIND, createDeepSeekProvider } = require("./deepseekProvider");
const { DECISION, planNeedsConfirmation, validateAssistantResponse } = require("./actionSchema");
const { createActionExecutor, formatPreflightErrors } = require("./actionExecutor");
const { classifyConfirmation, createPendingActionStore, pendingKey } = require("./pendingActions");
const { normalizeTargetDayToken } = require("./commandNormalizer");
const {
    buildHistoryEntries,
    buildMessages,
    buildSystemPrompt,
    protectIdentifiers,
    resolvePlaceholders
} = require("./promptBuilder");
const { createAiStateStore } = require("./aiStateStore");
const { getMessageHistory } = require("../messageRecorder");
const { canUseAi } = require("../accessControl");
const { getAdminSettings } = require("../adminSettings");
const { getSubscription, normalizeNotificationTimes } = require("../subscriptions");
const { normalizeStudentId } = require("../lhuSchedule");
const { sanitizeExternalRichText } = require("../richText");
const { formatWarningMessage } = require("../messageTemplates");

// Lời chào của trợ lý, gắn MỘT LẦN vào cuối câu trả lời đầu tiên.
//
// Trước đây đây là một thông báo kỹ thuật về việc dữ liệu được gửi tới DeepSeek.
// Người dùng cuối không cần câu đó trong khung chat: nó xuất hiện trước cả khi họ
// hỏi gì, và đọc như một bảng điều khoản. Thông tin về việc xử lý dữ liệu vẫn
// được nêu ở /help (mục /ai) và trong docs/AI_ASSISTANT.md — đúng chỗ để tra khi
// cần, không làm phiền mỗi cuộc trò chuyện.
const DISCLOSURE_TEXT = "Từ giờ các bạn sẽ được AI chat box hỗ trợ xử lí nếu có câu hỏi.";

// Prompt riêng cho việc giải thích lỗi cú pháp. Ngắn, và bị chặn bằng câu "chỉ
// dùng cú pháp được cung cấp" — trợ lý không được bịa ra lệnh không tồn tại.
const SYNTAX_HELP_PROMPT = `Bạn là trợ lý lịch học của ZaloBot (Đại học Lạc Hồng).
Người dùng vừa gõ một yêu cầu mà bot chưa xử lý được.
Nhiệm vụ: nói NGẮN GỌN (tối đa 2 câu) họ sai ở đâu và đưa ví dụ đúng.

QUY TẮC:
- CHỈ dùng cú pháp trong mục "CÚ PHÁP ĐÚNG". Không tự nghĩ ra lệnh mới.
- Nếu không có "CÚ PHÁP ĐÚNG", hướng dẫn họ nói lại bằng câu tự nhiên.
- Trả về văn bản thường. Không JSON, không markdown, không nhắc tới AI, mô hình hay hệ thống bên trong.
- Không mở đầu bằng lời xin lỗi dài dòng.`;

const REPLIES = Object.freeze({
    restricted: "Tài khoản hoặc nhóm này hiện không dùng được trợ lý AI. Cậu vẫn dùng được các lệnh thường bằng **/help**.",
    // Hai nguyên nhân khác nhau, không được nói lẫn: hạn mức của CHÚNG TA và số dư
    // của tài khoản DeepSeek. Gộp làm một từng khiến người dùng tưởng bot tự đặt
    // giới hạn trong khi thực tế tài khoản API đã cạn tiền.
    budget: "Trợ lý AI đang tạm nghỉ để giữ chi phí trong mức cho phép. Cậu vẫn dùng các lệnh thường bằng **/help** nhé.",
    providerOutage: "Trợ lý AI đang tạm nghỉ. Cậu vẫn dùng các lệnh thường bằng **/help** nhé.",
    userLimit: "Hôm nay cậu dùng trợ lý AI hơi nhiều rồi. Mai mình tiếp tục nhé — các lệnh thường vẫn dùng được.",
    globalLimit: "Trợ lý AI đang phục vụ quá nhiều yêu cầu. Cậu thử lại sau nhé — các lệnh thường vẫn dùng bình thường.",
    busy: "Trợ lý đang bận một chút. Cậu thử lại sau vài giây nhé.",
    unclear: "Mình chưa hiểu rõ ý cậu. Cậu nói lại cụ thể hơn giúp mình nhé, ví dụ: \"nhận lịch lúc 6 giờ sáng hôm nay\".",
    empty: "Mình chưa có câu trả lời cho việc này. Cậu thử hỏi lại hoặc dùng **/help** nhé.",
    cancelled: "Đã huỷ, mình không thực hiện thay đổi nào cả."
});

function formatReply(text) {
    const clean = sanitizeExternalRichText(text || "").trim();
    return clean ? clean.slice(0, 1800) : REPLIES.empty;
}

function confirmationText(entry) {
    const reasons = (entry.confirmationReasons || []).map((item) => `- ${item}`).join("\n");
    const lines = [
        formatWarningMessage("CẦN XÁC NHẬN", `> Thao tác này sẽ thay đổi cấu hình nhận lịch hiện tại:`),
        reasons,
        "Trả lời **đồng ý** để mình thực hiện, hoặc **huỷ** để bỏ."
    ].filter(Boolean);
    return lines.join("\n\n");
}

// Câu thông báo khi trợ lý không phục vụ được. Phân biệt để người dùng không
// hiểu sai nguyên nhân, nhưng vẫn chỉ là một câu ngắn — không phải chẩn đoán.
function providerErrorMessage(error) {
    switch (error?.kind) {
        case ERROR_KIND.INSUFFICIENT_QUOTA:
        case ERROR_KIND.AUTH:
        case ERROR_KIND.DISABLED:
            return REPLIES.providerOutage;
        case ERROR_KIND.RATE_LIMIT:
        case ERROR_KIND.TIMEOUT:
        case ERROR_KIND.NETWORK:
        case ERROR_KIND.SERVER:
            return REPLIES.busy;
        default:
            return REPLIES.busy;
    }
}

function createAssistant(options = {}) {
    const config = options.config || loadAiConfig();
    const now = typeof options.now === "function" ? options.now : () => new Date();
    const log = options.logger || console;

    const provider = options.provider !== undefined
        ? options.provider
        : (config.configured
            ? createDeepSeekProvider({
                apiKey: config.apiKey,
                baseUrl: config.baseUrl,
                model: config.model,
                timeoutMs: config.timeoutMs,
                maxRetries: config.maxRetries,
                transport: options.transport
            })
            : null);

    const executor = options.executor || createActionExecutor(options.executorDeps);
    const pending = options.pending || createPendingActionStore({ ttlMs: config.confirmationTtlMs, now: () => now().getTime() });
    // Câu hỏi làm rõ đang chờ trả lời (ví dụ "hôm nay hay hôm sau?"). Tách khỏi
    // `pending` của xác nhận để hai cơ chế không bao giờ lẫn nhau.
    const clarifications = options.clarifications
        || createPendingActionStore({ ttlMs: config.clarificationTtlMs, now: () => now().getTime() });
    const stateStore = options.stateStore || createAiStateStore({ now });
    const accessCheck = options.accessCheck || canUseAi;
    // Danh tính quản trị LUÔN do máy chủ xác thực từ sự kiện Zalo thật (main.js
    // truyền `isOwner` vào). Mặc định là "không phải owner".
    const isOwner = options.isOwner || (() => false);
    // Hạn mức có thể được chỉnh từ dashboard (Settings). Đọc mỗi lượt: dashboard
    // vừa lưu là có hiệu lực ngay, không cần khởi động lại.
    const readAiSettings = options.readAiSettings || (() => {
        try {
            return getAdminSettings().ai || {};
        } catch (_) {
            return {};
        }
    });
    // Đọc đăng ký của CHÍNH người đang hỏi (đã scoped theo bot + chat + user bởi
    // subscriptions.js). Cho phép thay bằng hàm giả khi kiểm thử.
    const readSubscription = options.getSubscription || getSubscription;
    const historyProvider = options.historyProvider || (async (botId, chatId, opts) => {
        const result = await getMessageHistory(botId, chatId, { limit: opts.limit });
        return result?.messages || [];
    });

    // Chống spam trong thời gian ngắn: bộ nhớ tạm, không cần bền vững.
    const cooldowns = new Map();
    // Đếm số câu NGOÀI PHẠM VI liên tiếp của mỗi người. Câu ngoài phạm vi vẫn tốn
    // token (phải gọi mô hình mới biết là ngoài phạm vi), nên khi ai đó dùng bot
    // như chatbot đa năng, ta ngừng gọi API cho chính người đó một lúc. Đây là
    // chặn CHI PHÍ, không phải chặn quyền: lệnh thường không đi qua đường này.
    const ignoreStreaks = new Map();
    const MAX_IGNORE_STREAK_ENTRIES = 500;

    // Map này không được phình theo số người dùng. Chỉ dọn khi đã lớn, và chỉ bỏ
    // mục đã hết hiệu lực — mục đang tạm ngừng phải giữ nguyên.
    function pruneIgnoreStreaks(at) {
        if (ignoreStreaks.size <= MAX_IGNORE_STREAK_ENTRIES) return;
        for (const [entryKey, entry] of ignoreStreaks) {
            if (!entry.mutedUntil || entry.mutedUntil <= at) ignoreStreaks.delete(entryKey);
        }
    }
    // Lần cuối đã giải thích một lỗi cú pháp cho mỗi người.
    const syntaxHelpAt = new Map();
    // Lần cuối đã gửi một câu "trợ lý đang nghỉ" cho mỗi người. Không có nó thì
    // mỗi tin nhắn lại nhận đúng một câu thông báo giống nhau — đúng kiểu "câu nào
    // cũng rep thế này" mà người dùng phàn nàn.
    const noticeAt = new Map();
    // Cầu dao cho lỗi toàn cục (tài khoản API hết số dư, sai khoá). Những lỗi này
    // không tự khỏi sau vài giây, nên gọi lại chỉ tốn thời gian của người dùng.
    let providerDownUntil = 0;

    // Giá trị hiệu lực = dashboard (nếu có đặt) → .env → mặc định.
    //
    // `null` ở dashboard nghĩa là "theo .env", KHÔNG phải 0. Còn 0 nghĩa là "không
    // giới hạn" — hai thứ khác nhau và người vận hành cần phân biệt được.
    function resolveLimits(settings, owner) {
        const source = settings || {};
        const pick = (value, fallback) => (value === null || value === undefined ? fallback : value);
        return {
            perUser: owner && config.ownerBypassLimit
                ? 0
                : pick(source.perUserDailyLimit, config.maxRequestsPerUserPerDay),
            global: pick(source.globalDailyLimit, config.maxRequestsPerDay),
            budget: pick(source.monthlyBudgetUsd, config.monthlyBudgetUsd),
            groupAssistant: pick(source.groupAssistant, config.enableGroupAssistant)
        };
    }

    // Gửi thông báo "không phục vụ được" CÓ TIẾT CHẾ: tối đa một lần mỗi
    // `noticeCooldownMs`. Trong khoảng đó trợ lý im lặng — người dùng vẫn dùng
    // được lệnh thường, và không bị lặp lại cùng một câu.
    async function sendNotice(key, text, send) {
        const nowMs = now().getTime();
        const last = noticeAt.get(key) || 0;
        if (nowMs - last < config.noticeCooldownMs) return false;
        noticeAt.set(key, nowMs);
        await send(text);
        return true;
    }

    // Trả về phần đuôi thông báo xử lý dữ liệu nếu đây là lần đầu, ngược lại "".
    // Ghép vào câu trả lời thay vì gửi một tin riêng.
    function takeDisclosureSuffix(key, currentTime) {
        if (stateStore.hasSeenDisclosure(key)) return "";
        stateStore.markDisclosure(key, currentTime);
        return `\n\n${DISCLOSURE_TEXT}`;
    }

    function accountSnapshot(context) {
        const subscription = readSubscription(context);
        const times = normalizeNotificationTimes(subscription);
        return {
            subscription,
            account: {
                hasStudentId: Boolean(normalizeStudentId(subscription?.studentId)),
                notificationsEnabled: subscription?.notificationsEnabled === true,
                notificationCount: times.length,
                classStartEnabled: subscription?.classStartNotificationsEnabled === true,
                // Mốc giờ THẬT của chính người đang hỏi, kèm ID.
                //
                // Thiếu danh sách này, trợ lý buộc phải hỏi "cho mình xin mã số
                // mốc giờ" cho một việc nó hoàn toàn có thể tự tra — đúng phản hồi
                // đã nhận. Chỉ dữ liệu của người gửi hiện tại, không phải của ai khác.
                times: times.map((item) => ({
                    id: item.id,
                    time: item.time,
                    targetDay: item.targetDayOffset === 1 ? "tomorrow" : "today"
                }))
            }
        };
    }

    async function loadHistory(context, { isGroup, currentText }) {
        const limit = Math.min(40, Math.max(6, config.maxHistoryMessages * 4));
        let messages = [];
        try {
            messages = await historyProvider(context.botId, context.chatId, { limit, isGroup, senderUserId: context.userId });
        } catch (error) {
            log.warn?.(`[AI] không đọc được lịch sử hội thoại: ${error.message}`);
            messages = [];
        }
        // Tin hiện tại có thể đã được ghi vào lịch sử trước khi xử lý (ghi không
        // chặn). Bỏ bản trùng cuối cùng để ngữ cảnh không lặp lại câu hỏi.
        const last = messages[messages.length - 1];
        if (last && last.direction !== "outbound" && String(last.text || "").trim() === String(currentText || "").trim()) {
            messages = messages.slice(0, -1);
        }
        return buildHistoryEntries(messages, {
            isGroup,
            senderUserId: context.userId,
            maxMessages: config.maxHistoryMessages
        });
    }

    async function runActions({ context, actions, send }) {
        const prepared = await executor.prepare({ context, actions });
        if (!prepared.ok) {
            await send(formatPreflightErrors(prepared.errors));
            return { handled: true, reason: "preflight_failed" };
        }
        const result = await executor.execute({ context, plan: prepared });
        await send(result.message);
        for (const extra of result.extraMessages || []) await send(extra);
        return { handled: true, reason: result.ok ? "executed" : "partial", executed: result.ok };
    }

    // Xử lý câu trả lời cho một lệnh đang chờ xác nhận.
    //
    // Tách riêng để main.js gọi được TRƯỚC khi phân tích lệnh: nhờ vậy lệnh chờ
    // không thể bị bỏ qua chỉ vì người dùng gõ thêm dấu "/", và lô lệnh tất định
    // cũng dùng đúng một cơ chế xác nhận.
    async function handlePendingConfirmation({ context, text, send }) {
        const key = pendingKey(context.botId, context.chatId, context.userId);
        const entry = pending.peek(key);
        if (!entry) return { handled: false, reason: "no_pending" };

        const verdict = classifyConfirmation(text);
        if (verdict === "confirm") {
            // Quyền có thể đã bị thu hồi giữa lúc hỏi và lúc xác nhận. Kiểm tra
            // lại, và bỏ lệnh chờ thay vì để nó nằm lại.
            const access = accessCheck(context);
            if (!access.allowed) {
                pending.drop(key);
                await send(REPLIES.restricted);
                return { handled: true, reason: access.reason || "ai_blocked" };
            }
            pending.take(key);
            return runActions({ context, actions: entry.actions, send });
        }
        if (verdict === "cancel") {
            pending.drop(key);
            await send(REPLIES.cancelled);
            return { handled: true, reason: "cancelled" };
        }
        // Câu khác hẳn ⇒ lệnh chờ cũ bị bỏ, không bao giờ chạy sau đó.
        pending.drop(key);
        return { handled: false, reason: "superseded" };
    }

    // Ghép các phần của một tin trả lời, bỏ phần rỗng. Nhờ vậy một hành động
    // "nội dung là câu trả lời" (xem danh sách, xem lịch) không sinh ra một tin
    // rỗng, và cũng không kéo theo tiêu đề tổng kết vô nghĩa.
    function compose(parts) {
        return parts
            .filter((part) => typeof part === "string" && part.trim())
            .map((part) => part.trim())
            .join("\n\n");
    }

    // Kiểm tra trước rồi mới ghi; hành động phá huỷ dừng lại để xin xác nhận.
    async function executePlan({ context, actions, send, prefix = "", suffix = "" }) {
        const prepared = await executor.prepare({ context, actions });
        if (!prepared.ok) {
            await send(compose([prefix, formatPreflightErrors(prepared.errors), suffix]));
            return { handled: true, reason: "preflight_failed" };
        }

        if (prepared.requiresConfirmation || planNeedsConfirmation(actions)) {
            pending.put(pendingKey(context.botId, context.chatId, context.userId), {
                actions,
                confirmationReasons: prepared.confirmationReasons || []
            });
            await send(compose([prefix, confirmationText(prepared), suffix]));
            return { handled: true, reason: "awaiting_confirmation" };
        }

        const result = await executor.execute({ context, plan: prepared });
        const body = compose([prefix, result.message, suffix]);
        if (body) await send(body);
        for (const extra of result.extraMessages || []) await send(extra);
        return { handled: true, reason: result.ok ? "executed" : "partial", executed: result.ok };
    }

    // Hoàn tất một câu hỏi làm rõ bằng tin trả lời ngắn của người dùng.
    //
    // Trợ lý vừa hỏi "hôm nay hay hôm sau?" và người dùng trả lời đúng "Hôm sau".
    // Câu trả lời đó không cần đi qua mô hình: ta đã biết giờ, chỉ thiếu ngày đích.
    // Xử lý tại đây vừa nhanh vừa chắc, và tránh việc mô hình trả JSON hỏng rồi
    // người dùng nhận câu "mình chưa hiểu rõ".
    async function resolveClarification({ context, text, send }) {
        const key = pendingKey(context.botId, context.chatId, context.userId);
        const entry = clarifications.peek(key);
        if (!entry) return { handled: false, reason: "no_clarification" };

        const targetDay = normalizeTargetDayToken(text);
        if (!targetDay) {
            // Tin khác hẳn ⇒ câu hỏi cũ hết hiệu lực.
            clarifications.drop(key);
            return { handled: false, reason: "superseded" };
        }

        clarifications.take(key);
        const actions = (entry.actions || []).map((action) => (
            action.type === "register_notification" ? { ...action, target_day: targetDay } : action
        ));
        const disclosure = takeDisclosureSuffix(key, now());
        return executePlan({ context, actions, send, suffix: disclosure });
    }

    async function handleTurn({ context, text, isGroup = false, send }) {
        if (typeof send !== "function") throw new Error("handleTurn cần hàm send");

        const key = pendingKey(context.botId, context.chatId, context.userId);

        // ---------------------------------------------------------- xác nhận
        //
        // Chạy TRƯỚC cả công tắc bật/tắt: một lô lệnh tất định có thể đã tạo lệnh
        // chờ trong khi trợ lý AI đang tắt, và người dùng vẫn phải xác nhận được.
        const pendingOutcome = await handlePendingConfirmation({ context, text, send });
        if (pendingOutcome.handled) return pendingOutcome;

        // Người dùng trả lời đúng câu hỏi trợ lý vừa hỏi ("Hôm sau") ⇒ hoàn tất
        // ngay tại máy chủ, không gọi API lần nữa.
        const clarified = await resolveClarification({ context, text, send });
        if (clarified.handled) return clarified;

        if (!config.enabled) return { handled: false, reason: "disabled" };

        // ------------------------------------------------------------ quyền
        const access = accessCheck(context);
        if (!access.allowed) {
            await send(REPLIES.restricted);
            return { handled: true, reason: access.reason || "ai_blocked" };
        }

        // Danh tính và hạn mức hiệu lực, xác định MỘT lần cho cả lượt.
        const owner = isOwner(context) === true;
        const limits = resolveLimits(readAiSettings(), owner);

        if (isGroup && !limits.groupAssistant) {
            // Im lặng, KHÔNG gửi câu giải thích.
            //
            // Trong nhóm, mọi câu trả lời đều phát cho toàn bộ thành viên. Một tin
            // được tag nhưng không phải lệnh mà nhận câu "trợ lý chưa bật" sẽ biến
            // mỗi lần ai đó gọi tên bot thành một thông báo cho cả nhóm. Quy tắc
            // của dự án là im lặng trong trường hợp này.
            return { handled: false, reason: "group_disabled" };
        }

        if (!provider || !config.configured) {
            // Chưa cấu hình: im lặng, không dựng thông điệp lỗi kỹ thuật cho
            // người dùng cuối và không làm phiền khi chat riêng bình thường.
            return { handled: false, reason: "not_configured" };
        }

        // ---------------------------------------------------------- hạn mức
        const currentTime = now();
        const lastCall = cooldowns.get(key) || 0;
        if (config.cooldownMs > 0 && currentTime.getTime() - lastCall < config.cooldownMs) {
            return { handled: true, reason: "cooldown" };
        }

        // Người này vừa hỏi ngoài phạm vi liên tiếp quá nhiều lần ⇒ im lặng và
        // KHÔNG gọi API. Không tiêu hạn mức, không tiêu token, không trả lời gì.
        const streak = ignoreStreaks.get(key);
        if (streak && streak.mutedUntil > currentTime.getTime()) {
            return { handled: true, reason: "offtopic_muted" };
        }

        // Cầu dao: lỗi toàn cục vừa xảy ra thì không gọi lại ngay. Người dùng nhận
        // tối đa một câu thông báo trong mỗi cửa sổ `noticeCooldownMs`.
        if (currentTime.getTime() < providerDownUntil) {
            await sendNotice(key, REPLIES.providerOutage, send);
            return { handled: true, reason: "provider_down" };
        }

        if (stateStore.isBudgetExhausted({ budgetUsd: limits.budget, date: currentTime })) {
            await sendNotice(key, REPLIES.budget, send);
            return { handled: true, reason: "budget_exhausted" };
        }

        const quota = stateStore.consumeQuota({
            key,
            perUserLimit: limits.perUser,
            globalLimit: limits.global,
            date: currentTime
        });
        if (!quota.allowed) {
            await sendNotice(key, quota.reason === "global_daily_limit" ? REPLIES.globalLimit : REPLIES.userLimit, send);
            return { handled: true, reason: quota.reason };
        }
        cooldowns.set(key, currentTime.getTime());

        // Thông báo xử lý dữ liệu KHÔNG gửi thành tin riêng: nó được gắn một lần
        // vào cuối câu trả lời đầu tiên (xem withDisclosureIfFirst).
        const disclosure = takeDisclosureSuffix(key, currentTime);

        // ----------------------------------------------------------- gọi API
        const { account } = accountSnapshot(context);
        // `owner` đã xác định ở trên từ danh tính thật; dùng cho cả prompt lẫn
        // bước kiểm tra phản hồi. Mô hình không bao giờ tự nhận quyền.
        const protectedInput = protectIdentifiers(String(text || ""));
        const historyEntries = await loadHistory(context, { isGroup, currentText: text });
        const messages = buildMessages({
            systemPrompt: buildSystemPrompt({ date: currentTime, account, isOwner: owner }),
            historyEntries,
            userText: protectedInput.text,
            maxInputChars: config.maxInputChars
        });

        let response;
        try {
            response = await provider.complete({
                messages,
                maxTokens: config.maxOutputTokens,
                jsonMode: true
            });
        } catch (error) {
            const kind = error instanceof AiProviderError ? error.kind : ERROR_KIND.NETWORK;
            if (kind === ERROR_KIND.AUTH || kind === ERROR_KIND.INSUFFICIENT_QUOTA) {
                // Lỗi cấu hình/số dư: không tự khỏi trong vài giây, nên mở cầu dao
                // để những tin sau không phải chờ timeout rồi lại nhận cùng câu đó.
                providerDownUntil = currentTime.getTime() + config.providerCooldownMs;
                log.error?.(`[AI] DeepSeek từ chối (${kind}); kiểm tra DEEPSEEK_API_KEY và số dư tài khoản.`);
            }
            await sendNotice(key, providerErrorMessage(error), send);
            return { handled: true, reason: `provider_${kind}` };
        }
        providerDownUntil = 0;

        const costUsd = estimateCostUsd(response.usage, config);
        stateStore.recordUsage({ usage: response.usage, costUsd, date: currentTime });

        // ------------------------------------------------- kiểm tra phản hồi
        const validated = validateAssistantResponse(response.text, {
            maxActions: config.maxActionsPerRequest,
            truncated: response.finishReason === "length",
            // Hành động quản trị chỉ được chấp nhận khi máy chủ đã xác nhận owner.
            allowAdmin: owner
        });
        if (!validated.ok) {
            log.warn?.(`[AI] phản hồi không hợp lệ: ${validated.error}`);
            await sendNotice(key, REPLIES.unclear, send);
            return { handled: true, reason: "invalid_response" };
        }

        const plan = validated.plan;
        // MSSV do mô hình trả về có thể là placeholder; khôi phục từ máy chủ.
        const actions = plan.actions.map((action) => (
            action.student_id
                ? { ...action, student_id: resolvePlaceholders(action.student_id, protectedInput.placeholders) }
                : action
        ));

        if (plan.decision === DECISION.IGNORE) {
            // Câu ngoài phạm vi: không gửi gì. Đếm để chặn chi phí khi bị dùng
            // như chatbot đa năng — ngưỡng và thời gian tạm ngừng đến từ cấu hình.
            const previous = ignoreStreaks.get(key) || { count: 0, mutedUntil: 0 };
            const count = previous.count + 1;
            if (config.offTopicSilenceAfter > 0 && count >= config.offTopicSilenceAfter) {
                ignoreStreaks.set(key, { count: 0, mutedUntil: currentTime.getTime() + config.offTopicSilenceMs });
                log.info?.(`[AI] tạm ngừng trả lời ${config.offTopicSilenceMs}ms sau ${count} câu ngoài phạm vi liên tiếp`);
                pruneIgnoreStreaks(currentTime.getTime());
            } else {
                ignoreStreaks.set(key, { count, mutedUntil: previous.mutedUntil });
            }
            return { handled: true, reason: "ignored" };
        }

        // Một câu trả lời thật ⇒ người này đang dùng bot đúng mục đích, xoá chuỗi.
        ignoreStreaks.delete(key);

        if (plan.decision === DECISION.ANSWER || plan.decision === DECISION.CLARIFY) {
            // Hành động dở dang của câu hỏi làm rõ (ví dụ đã biết 21:00 nhưng chưa
            // biết hôm nay/hôm sau) được giữ lại để tin trả lời kế tiếp — "Hôm sau"
            // — hoàn tất ngay mà không tốn thêm một lời gọi API.
            if (plan.decision === DECISION.CLARIFY) {
                const partial = actions.filter((action) => action.type === "register_notification" && !action.target_day);
                if (partial.length > 0) clarifications.put(key, { actions: partial });
            }
            await send(`${formatReply(plan.reply)}${disclosure}`);
            return { handled: true, reason: plan.decision };
        }

        // ------------------------------------------------------- thực thi
        return executePlan({
            context,
            actions,
            send,
            prefix: plan.reply ? formatReply(plan.reply) : "",
            suffix: disclosure
        });
    }

    // Giải thích một lỗi cú pháp NGAY SAU cảnh báo của bot.
    //
    // Cảnh báo hiện có ("SAI CÚ PHÁP", "LỆNH KHÔNG HỢP LỆ") nói đúng nhưng khô: nó
    // không nói người dùng đã hiểu sai chỗ nào. Trợ lý thêm đúng phần đó, dựa trên
    // CÚ PHÁP THẬT lấy từ helpContent — không tự nghĩ ra lệnh mới.
    //
    // Đây là lời gọi API THÊM, nên có đủ chốt chặn: quyền, ngân sách, hạn mức,
    // và một khoảng nghỉ riêng để gõ sai liên tiếp không thành nhiều lần gọi.
    async function explainCommandError({ context, text, failedReply, usage, isGroup = false, send }) {
        if (typeof send !== "function") return { handled: false, reason: "no_send" };
        if (!config.enabled || !config.configured || !provider) return { handled: false, reason: "disabled" };

        const access = accessCheck(context);
        if (!access.allowed) return { handled: false, reason: access.reason || "ai_blocked" };

        const owner = isOwner(context) === true;
        const limits = resolveLimits(readAiSettings(), owner);
        // Trong nhóm vẫn im lặng như mọi khi: cảnh báo đã phát cho cả nhóm, thêm
        // một câu giải thích nữa chỉ làm ồn.
        if (isGroup && !limits.groupAssistant) return { handled: false, reason: "group_disabled" };

        const key = pendingKey(context.botId, context.chatId, context.userId);
        const currentTime = now();
        const last = syntaxHelpAt.get(key) || 0;
        if (currentTime.getTime() - last < Math.max(config.cooldownMs, 30000)) {
            return { handled: false, reason: "cooldown" };
        }
        if (stateStore.isBudgetExhausted({ budgetUsd: limits.budget, date: currentTime })) {
            return { handled: false, reason: "budget_exhausted" };
        }
        const quota = stateStore.consumeQuota({
            key,
            perUserLimit: limits.perUser,
            globalLimit: limits.global,
            date: currentTime
        });
        if (!quota.allowed) return { handled: false, reason: quota.reason };
        syntaxHelpAt.set(key, currentTime.getTime());

        const messages = [
            { role: "system", content: SYNTAX_HELP_PROMPT },
            {
                role: "user",
                content: `<du_lieu>Người dùng gõ: ${String(text || "").slice(0, 300)}\n` +
                    `Bot đã trả lời: ${String(failedReply || "").slice(0, 400)}</du_lieu>` +
                    (usage ? `\n\nCÚ PHÁP ĐÚNG: ${usage}` : "\n\nCÚ PHÁP ĐÚNG: (không có — hướng dẫn người dùng nói lại bằng câu tự nhiên)")
            }
        ];

        let response;
        try {
            response = await provider.complete({ messages, maxTokens: 200, jsonMode: false });
        } catch (error) {
            const kind = error instanceof AiProviderError ? error.kind : ERROR_KIND.NETWORK;
            if (kind === ERROR_KIND.AUTH || kind === ERROR_KIND.INSUFFICIENT_QUOTA) {
                providerDownUntil = currentTime.getTime() + config.providerCooldownMs;
            }
            // Không gửi thông báo lỗi: cảnh báo cú pháp đã tới người dùng rồi, thêm
            // một câu "trợ lý đang nghỉ" nữa là thừa.
            return { handled: false, reason: `provider_${kind}` };
        }

        stateStore.recordUsage({
            usage: response.usage,
            costUsd: estimateCostUsd(response.usage, config),
            date: currentTime
        });

        const answer = sanitizeExternalRichText(response.text || "").trim();
        if (!answer) return { handled: false, reason: "empty" };
        await send(answer.slice(0, 400));
        return { handled: true, reason: "syntax_help" };
    }

    function getStatus() {        const summary = stateStore.getSummary(now());
        // Hạn mức hiệu lực, không phải giá trị trong .env: dashboard cần thấy đúng
        // con số đang áp dụng.
        const limits = resolveLimits(readAiSettings(), false);
        return {
            enabled: config.enabled,
            configured: config.configured,
            model: config.model,
            provider: config.provider,
            groupAssistant: limits.groupAssistant,
            budgetUsd: limits.budget,
            budgetExhausted: stateStore.isBudgetExhausted({ budgetUsd: limits.budget, date: now() }),
            perUserDailyLimit: limits.perUser,
            globalDailyLimit: limits.global,
            ownerBypassLimit: config.ownerBypassLimit,
            usage: summary.monthUsage,
            requestsToday: summary.requestsToday,
            pendingConfirmations: pending.size
        };
    }

    return {
        config,
        handleTurn,
        explainCommandError,
        handlePendingConfirmation,
        executePlan,
        getStatus,
        pendingStore: pending,
        stateStore,
        executor
    };
}

module.exports = {
    DISCLOSURE_TEXT,
    REPLIES,
    createAssistant,
    formatReply,
    providerErrorMessage
};
