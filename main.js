process.env.TZ = "Asia/Ho_Chi_Minh";

const path = require("path");

// Nạp .env theo thư mục dự án để cấu hình hoạt động giống nhau dù tiến trình
// được khởi động từ thư mục nào (PM2, terminal, systemd).
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

const https = require("https");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const schedule = require("node-schedule");
const ZaloBot = require("node-zalo-bot");
const {
    fetchExamSchedule,
    fetchStudentSchedule,
    fetchTeacherSchedule,
    findEmptyRooms,
    formatDailySchedule,
    formatExamSchedule,
    formatTeacherSchedule,
    formatWeeklySchedule,
    normalizeStudentId,
    resolveStudentIdForCommand,
    searchTeacherByName
} = require("./lhuSchedule");
const {
    DEFAULT_NOTIFICATION_TIME,
    TARGET_DAY_TODAY,
    TARGET_DAY_TOMORROW,
    disableClassStartNotifications,
    disableNotifications,
    enableClassStartNotifications,
    enableNotifications,
    getAllSubscriptions,
    getClassStartNotificationSubscriptions,
    getEnabledSubscriptions,
    getSubscription,
    normalizeNotificationTime,
    normalizeNotificationTimes,
    normalizeTargetDayOffset,
    removeNotificationTime,
    saveStudent,
    updateNotificationTime
} = require("./subscriptions");
const {
    createClassStartReminderService,
    DEFAULT_CACHE_TTL_MS,
    DEFAULT_GRACE_PERIOD_MS
} = require("./classStartNotifications");
const { getMessageContext } = require("./userContext");
const {
    captureScheduleChange,
    confirmScheduleChange,
    formatScheduleChangeMessage,
    initializeScheduleSnapshot
} = require("./scheduleChanges");
const { TIME_ZONE, getVietnamDateInfo } = require("./timezone");
const { addCalendarDays, dateFromVietnamDateKey } = require("./scheduleDatePolicy");
const { escapeMarkdown, escapeMarkdownMultiline, sanitizeExternalRichText } = require("./richText");
const {
    formatAdminHelp,
    formatClassStartEnabled,
    formatClassStartStatus,
    formatDailyNotificationEnabled,
    formatErrorMessage,
    formatFeedbackAck,
    formatFeedbackDuplicateAck,
    formatFeedbackFollowUpAck,
    formatFeedbackUsage,
    formatGeneralHelp,
    formatMissingStudentIdMessage,
    formatStudentSavedMessage,
    formatSuccessMessage,
    formatWarningMessage,
    formatWelcomeMessage
} = require("./messageTemplates");
const { resolveCommandName } = require("./helpContent");
const { detectChatType, getInteractionTargets, recordInteraction } = require("./interactionRegistry");
const {
    ADMISSION_STATE,
    admissionKey,
    classifyAdmissionFailure,
    registry: admissionRegistry
} = require("./contactAdmission");
const {
    getAllChats,
    getChat,
    isChatEligible,
    markChatAdmitted,
    markChatUnreachable,
    recordDeliveryFailure,
    recordDeliverySuccess,
    setChatStatus,
    setFeatureOverride,
    reconcileChatDirectory,
    upsertChat
} = require("./chatDirectory");
const {
    allowTarget,
    blockTarget,
    canUseAi,
    canUseBot,
    getAccessSummary,
    setAccessMode,
    unallowTarget,
    unblockTarget
} = require("./accessControl");
const { askScheduleAi } = require("./aiAssistant");
const { flushPersistenceWrites, initializeFirestorePersistence } = require("./firestorePersistence");
const { getCommandRegistry } = require("./commandRegistry");
const { createAdminServer } = require("./adminServer");
const { DEFAULT_SHUTDOWN_TIMEOUT_MS, createShutdownController } = require("./shutdown");
const { recordSystemLog } = require("./operationalLog");
const { getAdminSettings, getConfiguredAdminIds, isConfiguredAdmin } = require("./adminSettings");
const { LEGACY_BOT_ID, extractBotName, isZcaId, normalizeBotId, parseScopedKey, resolveBotConfigs, resolveBotDisplayName, scopeKey } = require("./bots");
const { createOfficialProvider } = require("./providers/officialProvider");
const { createZcaProvider } = require("./providers/zca/zcaProvider");
const { createRuntimeMetrics } = require("./runtimeMetrics");
const {
    addAdminReply,
    appendUserMessage,
    createTicket,
    findTicket,
    normalizeTicketId,
    setReplyDelivery
} = require("./feedback");
const { DELIVERY_ERROR_KIND, classifyDeliveryError } = require("./deliveryErrors");
const { PRIORITY, createProviderQueues } = require("./sendQueue");
const { getPersistenceQueueStats } = require("./firestorePersistence");
const {
    bindBot,
    describeRegisteredBots,
    getBot,
    getCurrentBot,
    getCurrentBotId,
    listBots,
    listEnabledBots,
    registerBots,
    rekeyBot,
    runWithBot
} = require("./botContext");

const isTestEnv = process.env.NODE_ENV === "test" || require.main !== module;

// Cấu hình nhiều bot trên cùng một codebase và một Firestore database.
// BOT_TOKEN cũ vẫn là đường tương thích của bot 1; thiếu BOT_2_TOKEN/BOT_3_TOKEN
// chỉ đơn giản là bot đó tắt.
// Đọc cờ bật/tắt từ .env. Chấp nhận các cách viết thường gặp để tránh việc
// ZCA_ENABLED=false lại bị hiểu là bật.
function isTruthyEnv(value) {
    const raw = String(value == null ? "" : value).trim().toLowerCase();
    return ["1", "true", "yes", "on"].includes(raw);
}

const botConfigResult = resolveBotConfigs(process.env);

// Bot 1 là danh tính gốc: nó sở hữu không gian khóa cũ và là đường tương thích
// của bản triển khai hiện tại. Thiếu token bot 1 là lỗi cấu hình, không phải
// trạng thái chạy được — kể cả khi bot 2 hoặc bot 3 có token.
const hasLegacyBot = botConfigResult.bots.some((config) => config.botId === LEGACY_BOT_ID);
if (botConfigResult.bots.length === 0 || !hasLegacyBot) {
    const reasons = botConfigResult.errors.length
        ? botConfigResult.errors
        : ["Không có bot 1 đang bật. Đặt BOT_TOKEN hoặc BOT_1_TOKEN trong .env."];
    throw new Error(`Không thể khởi động bot:\n- ${reasons.join("\n- ")}`);
}
for (const warning of botConfigResult.warnings) console.log(`[Bots] ${warning}`);

// Một nhà cung cấp cho mỗi bot chính thức đang bật: client riêng, con trỏ polling
// riêng, handler riêng. Không bao giờ dùng chung một token cho hai bot.
//
// Hành vi không đổi so với trước — vẫn là node-zalo-bot — nhưng nay được đặt sau
// giao diện nhà cung cấp chung để ZCA chạy song song mà không phải sửa logic.
const officialProviders = botConfigResult.bots.map((config) => createOfficialProvider(config));

// Nhà cung cấp ZCA — tài khoản Zalo CÁ NHÂN qua zca-js. Tắt mặc định.
//
// Đây là nhà cung cấp độc lập, KHÔNG thay thế và không nới giới hạn của các bot
// chính thức. Lỗi của nó không bao giờ được làm dừng phần còn lại của hệ thống.
const zcaProvider = createZcaProvider({
    enabled: isTruthyEnv(process.env.ZCA_ENABLED),
    sessionPath: process.env.ZCA_SESSION_PATH,
    autoReconnect: process.env.ZCA_AUTO_RECONNECT === undefined ? true : isTruthyEnv(process.env.ZCA_AUTO_RECONNECT),
    displayName: process.env.ZCA_DISPLAY_NAME || null,
    language: process.env.ZCA_LANGUAGE || "vi",
    // Tin nhắn ZCA phải chạy trong ngữ cảnh của CHÍNH nhà cung cấp ZCA.
    //
    // handleIncomingMessage() gửi phản hồi qua currentProvider(), mà nó lấy nhà
    // cung cấp từ ngữ cảnh. Listener của zca-js gọi lại từ ngoài mọi ngữ cảnh, nên
    // thiếu bước này thì ngữ cảnh rơi về mặc định là bot 1 và phản hồi cho người
    // dùng ZCA bị gửi nhầm bằng bot chính thức.
    //
    // Dùng runWithBot (chạy ngay) chứ KHÔNG phải bindBot (trả về hàm bọc dùng cho
    // event handler) — bindBot ở đây sẽ khiến handler không bao giờ được gọi.
    onMessage: (provider, message) => runWithBot(provider, () => handleIncomingMessage(provider, message)),
    // UID chỉ biết được sau khi đăng nhập, nên danh tính đăng ký được đổi khóa
    // ngay tại đây. Mọi bản ghi về sau dùng khóa "zca:<uid>" thật.
    onIdentityChanged: (provider, newBotId, previousBotId) => {
        const moved = rekeyBot(previousBotId, newBotId);
        console.log(`[ZCA] danh tính: ${previousBotId} → ${newBotId}${moved ? "" : " (giữ nguyên khóa cũ)"}`);
        // Danh tính vừa đổi nghĩa là tài khoản đã đăng nhập xong. Tra tên ngay bây
        // giờ — lúc khởi động chưa hỏi được nên tên thật chưa có.
        refreshBotName(newBotId).catch((error) => {
            console.warn(`[ZCA] không tra lại được tên: ${error.message}`);
        });
    }
});

registerBots([...officialProviders, zcaProvider]);

// Đặt registry nhà cung cấp lên globalThis để công cụ một-lần
// (scripts/sendRecoveredAnnouncement.js) gửi được TRONG CÙNG tiến trình này.
//
// Bắt buộc phải cùng tiến trình: tài khoản ZCA giữ khoá phiên độc quyền, mở tiến
// trình thứ hai sẽ đá nhau và làm hỏng phiên. Chỉ đặt khi đang chạy như tiến trình
// chính (không đặt trong bài kiểm tra) để không rò rỉ trạng thái giữa các bài.
if (process.env.NODE_ENV !== "test") {
    globalThis.__ZALOBOT_RUNTIMES__ = {
        get: (botId) => getBot(botId),
        list: () => listBots(),
        isZcaId
    };
}

// Đo lường runtime: mốc thời gian khởi động + log bộ nhớ định kỳ.
const metrics = createRuntimeMetrics();

// Hàng đợi gửi RIÊNG cho từng nhà cung cấp.
//
// Một hàng đợi chung sẽ khiến bot1 phải chờ bot2, và một đợt thông báo lớn có thể
// chặn luôn câu trả lời cho người dùng đang nhắn tới. Mỗi nhà cung cấp có trần
// song song riêng, và việc tương tác được ưu tiên hơn việc hàng loạt.
const providerQueues = createProviderQueues();

// Đánh dấu một chat là không gửi được tới (410/422) để các đợt thông báo sau không
// tiếp tục bắn vào đó.
//
// KHÔNG xoá dữ liệu người dùng: chỉ tăng bộ đếm thất bại để chatDirectory tự
// chuyển trạng thái theo ngưỡng sẵn có, và quản trị viên vẫn khôi phục được.
function recordUndeliverableChat(chatId, classification) {
    try {
        // KHÔNG tạo bản ghi sổ chat cho một chat CHƯA từng được tiếp nhận.
        //
        // Vì sao: một người lạ bị 410/422 ngay từ đầu không phải "người dùng không
        // liên lạc được" — họ chưa bao giờ là người dùng. Ghi vào sổ chat ở đây sẽ
        // để lại đúng dấu vết mà cổng tiếp nhận đang cố ngăn.
        const existing = getChat(chatId);
        if (!existing) {
            console.warn(`[Delivery] ${chatId}: ${classification.reason} — chat chưa được tiếp nhận, không ghi sổ.`);
            return;
        }
        recordDeliveryFailure(chatId, new Error(classification.reason), {
            feature: "broadcast",
            operation: "permanent_delivery_error"
        });
        console.warn(`[Delivery] ${chatId}: ${classification.reason} — sẽ không gửi tiếp cho tới khi được bật lại.`);
    } catch (error) {
        // Ghi nhận thất bại không được làm hỏng luồng gửi tin.
        console.warn(`[Delivery] không ghi nhận được lỗi cho ${chatId}: ${error.message}`);
    }
}

/* -------------------------------------------------------------------------- */
/* Cổng tiếp nhận liên hệ                                                     */
/* -------------------------------------------------------------------------- */

// Hàng đợi ghi HOÃN cho những chat CHƯA được tiếp nhận.
//
// Vì sao cần: một lệnh đầu tiên của người lạ có thể kích hoạt ghi MSSV hoặc đăng
// ký nhận lịch. Nếu ta ghi ngay rồi câu trả lời bị 422/410, dữ liệu người dùng bị
// bỏ lại một phần cho một chat mà bot không thể liên lạc. Thay vào đó, khi chat
// chưa được tiếp nhận, ta giữ các thao tác ghi trong bộ nhớ và chỉ THỰC THI khi
// câu trả lời đã gửi thành công.
//
// Hàng đợi này KHÔNG phải nguồn sự thật: nó chỉ chứa các thao tác sẽ chạy lại.
// Mất khi khởi động lại là đúng — chat chưa tiếp nhận thì không có gì phải khôi phục.
const MAX_DEFERRED_WRITES = 100;
const deferredWrites = new Map(); // admissionKey → Array<{ label, run }>

function deferWrite(botId, chatId, label, run) {
    const key = admissionKey(botId, chatId);
    const queue = deferredWrites.get(key) || [];
    // Nhiều lệnh lặp lại trong cửa sổ chờ thì cái sau ghi đè cái trước theo nhãn:
    // ví dụ /luumssv chạy hai lần chỉ cần ghi bản mới nhất.
    const filtered = queue.filter((entry) => entry.label !== label);
    filtered.push({ label, run });
    deferredWrites.set(key, filtered.slice(-MAX_DEFERRED_WRITES));
}

// Chạy toàn bộ thao tác đã hoãn cho một chat. Gọi SAU KHI đã xác nhận câu trả lời
// gửi thành công qua đúng nhà cung cấp.
async function flushDeferredWrites(botId, chatId) {
    const key = admissionKey(botId, chatId);
    const queue = deferredWrites.get(key);
    if (!queue || queue.length === 0) return 0;
    deferredWrites.delete(key);
    let executed = 0;
    for (const entry of queue) {
        try {
            await entry.run();
            executed += 1;
        } catch (error) {
            // Một thao tác hoãn lỗi không được kéo theo các thao tác khác.
            console.error(`Lỗi chạy thao tác hoãn (${entry.label}):`, error.message);
            logDiscord("ERROR", `deferred_write_failed: ${entry.label}: ${error.message}`);
        }
    }
    return executed;
}

function discardDeferredWrites(botId, chatId) {
    deferredWrites.delete(admissionKey(botId, chatId));
}

// Chỉ để chẩn đoán. Không trả dữ liệu nhận dạng.
function getAdmissionStats() {
    return {
        ...admissionRegistry.stats(),
        deferredKeys: deferredWrites.size
    };
}

// Thực thi một thao tác ghi có thể bị cổng tiếp nhận chặn.
//
// Nếu chat ĐÃ được tiếp nhận: chạy ngay, trả về giá trị thật.
// Nếu CHƯA: trả về giá trị dự phòng và xếp thao tác vào hàng đợi hoãn. Thao tác
// này sẽ chạy khi câu trả lời kế tiếp gửi thành công (hoặc bị bỏ nếu bị từ chối).
//
// `options.fallback` là giá trị trả về khi thao tác bị hoãn. `options.defer: false`
// dùng cho những thao tác KHÔNG được hoãn (ví dụ ghi log quản trị phải chạy ngay).
function gatedWrite(context, label, run, options = {}) {
    const botId = context.botId || getCurrentBotId();
    if (admissionRegistry.isAdmitted(botId, context.chatId)) {
        return run();
    }
    // Chưa tiếp nhận: hoãn lại. Không ghi gì vào store.
    deferWrite(botId, context.chatId, label, run);
    console.log(`[Admission] hoãn "${label}" cho ${botId}/${context.chatId} tới khi có câu trả lời gửi được.`);
    return options.fallback !== undefined ? options.fallback : null;
}

// Khi RSS vượt ngưỡng cảnh báo, in thêm ngữ cảnh để biết cái gì đang giữ bộ nhớ.
// Đây là chẩn đoán, KHÔNG tự khởi động lại tiến trình — PM2 vẫn là cơ chế an toàn.
metrics.setDiagnosticsProvider(() => ({
    providers: listBots().map((bot) => `${bot.botId}:${bot.status || "?"}`).join(", "),
    persistenceQueue: getPersistenceQueueStats(),
    outboundQueues: providerQueues.getStats(),
    schedulerJobs: Array.isArray(runtimeSchedulerJobs) ? runtimeSchedulerJobs.length : 0,
    interactions: getInteractionTargets().length,
    subscriptions: Object.keys(getAllSubscriptions()).length,
    chats: getAllChats().length,
    admission: getAdmissionStats()
}));

// Hỏi Zalo tên thật của từng bot bằng chính token của bot đó (getMe).
//
// Chạy nền và có thời hạn: KHÔNG bao giờ chặn hay làm hỏng khởi động. Không lấy
// được tên thì giữ nhãn BOT_N_NAME, không có nữa thì dùng botId. Token không bao
// giờ được ghi log — chỉ ghi botId và lý do lỗi.
const BOT_NAME_TIMEOUT_MS = positiveDuration(process.env.BOT_NAME_TIMEOUT_MS, 5000);

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} quá thời gian ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function resolveBotNames() {
    await Promise.all(listBots().map(async (runtime) => {
        try {
            // Nhà cung cấp chưa sẵn sàng (ví dụ ZCA đang chờ quét QR) thì bỏ qua
            // TRONG IM LẶNG. Đây không phải lỗi — chỉ là chưa tới lúc. Báo cảnh báo
            // ở đây chính là tiếng ồn "[zca:pending]: không lấy được tên".
            if (typeof runtime.isReadyForName === "function" && !runtime.isReadyForName()) return;
            // Mỗi nhà cung cấp tự biết cách lấy tên của mình: bot chính thức hỏi
            // Zalo Bot Platform bằng token; tài khoản cá nhân hỏi hồ sơ tài khoản.
            if (typeof runtime.fetchIdentityName !== "function") return;
            const response = await withTimeout(
                Promise.resolve(runtime.fetchIdentityName()),
                BOT_NAME_TIMEOUT_MS,
                `${runtime.botId} fetchIdentityName`
            );
            const name = extractBotName(response);
            if (!name) {
                console.warn(`[${runtime.botId}]: không lấy được tên; dùng nhãn cấu hình.`);
                return;
            }
            runtime.verifiedName = name;
            runtime.displayName = resolveBotDisplayName({
                botId: runtime.botId,
                verifiedName: name,
                configuredName: runtime.configuredName
            });
            console.log(`[${runtime.botId}]: tên từ Zalo = ${name}`);
        } catch (error) {
            // Lỗi tra tên chỉ là thông tin: nhà cung cấp vẫn chạy với nhãn cấu hình.
            console.warn(`[${runtime.botId}]: không lấy được tên (${error.message}); dùng nhãn cấu hình.`);
        }
    }));
}

// Tra lại tên sau khi một nhà cung cấp vừa sẵn sàng.
//
// ZCA chỉ biết danh tính sau khi đăng nhập, mà resolveBotNames() lúc khởi động đã
// chạy xong từ trước. Không gọi lại thì tên thật không bao giờ được lấy và dashboard
// mãi hiển thị nhãn dự phòng.
async function refreshBotName(botId) {
    const runtime = getBot(botId);
    if (!runtime) return null;
    try {
        if (typeof runtime.isReadyForName === "function" && !runtime.isReadyForName()) return null;
        if (typeof runtime.fetchIdentityName !== "function") return null;
        const name = extractBotName(await withTimeout(
            Promise.resolve(runtime.fetchIdentityName()),
            BOT_NAME_TIMEOUT_MS,
            `${runtime.botId} fetchIdentityName`
        ));
        if (!name) return null;
        runtime.verifiedName = name;
        runtime.displayName = resolveBotDisplayName({
            botId: runtime.botId,
            verifiedName: name,
            configuredName: runtime.configuredName
        });
        console.log(`[${runtime.botId}]: tên từ Zalo = ${name}`);
        return name;
    } catch (error) {
        // Không lấy được tên thì vẫn giữ nhãn cấu hình — không ảnh hưởng vận hành.
        console.warn(`[${runtime.botId}]: không lấy được tên (${error.message}); dùng nhãn cấu hình.`);
        return null;
    }
}
const dashboardCommandContext = new AsyncLocalStorage();

// Ngữ cảnh CỔNG TIẾP NHẬN cho một sự kiện tin nhắn vào.
//
// Vì sao cần một ngữ cảnh riêng thay vì chỉ bọc các lần gửi trong
// handleIncomingMessage: các lệnh (/luumssv, /nhanlich, /help …) gọi sendMessage
// từ BÊN TRONG handleCommand, mà handleCommand cũng được gọi từ dashboard và các
// bài kiểm tra. Đặt ngữ cảnh ở đây cho phép sendMessage biết "lần gửi này thuộc
// một sự kiện vào của chat X, bot Y" và tự cập nhật cổng tiếp nhận — không phải
// sửa hàng trăm lối gọi sendMessage.
//
// Trường: { botId, chatId, onAdmitted, onDefiniteRejection, onUncertain }
const inboundAdmissionContext = new AsyncLocalStorage();

const registeredSchedulers = new WeakSet();

// Trạng thái runtime phục vụ dừng an toàn.
let runtimeSchedulerJobs = [];
let adminRuntime = null;
let shutdownController = null;
let shuttingDown = false;

function logDiscord(level, message) {
    if (level === "ERROR" || level === "WARN") {
        try { recordSystemLog(level, message); } catch (_) { /* Logging must not interrupt bot work. */ }
    }
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
        req.on("error", () => { });
        req.write(payload);
        req.end();
    } catch (_) {
        // Không để lỗi webhook làm dừng bot.
    }
}

// Client Zalo của bot đang xử lý. Không có ngữ cảnh thì rơi về bot 1 — đây là
// đường tương thích cho mọi lối gọi cũ và cho bản triển khai một token.
// Nhà cung cấp đang xử lý. Mọi lần gửi đi qua đây, nên phản hồi luôn đi ra bằng
// ĐÚNG nhà cung cấp đã nhận tin nhắn — không bao giờ trả lời người dùng ZCA bằng
// một bot chính thức hay ngược lại.
function currentProvider() {
    const runtime = getCurrentBot();
    if (!runtime) {
        throw new Error("Không xác định được nhà cung cấp nào để gửi tin nhắn");
    }
    if (typeof runtime.sendMessage === "function") return runtime;
    // Tương thích: runtime cũ chỉ có trường client của node-zalo-bot.
    if (runtime.client) {
        return { ...runtime, sendMessage: (chatId, text, options) => runtime.client.sendMessage(chatId, text, options), supportsMarkdown: true };
    }
    throw new Error("Nhà cung cấp hiện tại không gửi được tin nhắn");
}

// Chuyển nội dung có markdown của Zalo Bot Platform sang plain text.
//
// Dùng cho hai việc: gửi lại khi markdown bị từ chối, và cho những nhà cung cấp
// không hiểu markdown (tài khoản Zalo cá nhân qua ZCA).
function toPlainText(text) {
    return String(text)
        .replace(/\{(?:green|red|orange|blue)\}(.*?)\{\/(?:green|red|orange|blue)\}/g, "$1")
        .replace(/^#+\s+/gm, "")
        .replace(/\\([\\*_~`>])/g, "$1");
}

async function sendMessage(chatId, text, options = {}) {
    // Chia tin dài theo dòng để tránh vượt giới hạn tin nhắn của Zalo.
    const {
        continuationHeader = "",
        parse_mode = "markdown",
        // Việc trả lời người dùng mặc định được ưu tiên hơn thông báo hàng loạt,
        // để một đợt /thongbao lớn không làm người đang nhắn phải chờ.
        priority = PRIORITY.INTERACTIVE,
        ...otherOptions
    } = options;
    const messageOptions = { ...otherOptions, parse_mode };
    const maxLength = 750;
    const chunks = [];
    let current = "";

    const blocks = String(text).split(/(?<=\n\n)/);
    for (const block of blocks) {
        if (current && (current + block).length > maxLength) {
            chunks.push(current.trim());
            current = "";
        }

        if (block.length <= maxLength) {
            current += block;
        } else {
            for (const line of block.split("\n")) {
                const next = current ? `${current}\n${line}` : line;
                if (next.length <= maxLength) {
                    current = next;
                } else {
                    if (current.trim()) chunks.push(current.trim());
                    current = line;
                }
            }
        }
    }
    if (current.trim()) chunks.push(current.trim());
    const provider = currentProvider();
    const supportsMarkdown = provider.supportsMarkdown !== false;
    const sendOptions = supportsMarkdown ? messageOptions : { ...otherOptions };
    // Kết quả gửi tường minh cho tầng cổng tiếp nhận: biết CHÍNH XÁC đã gửi được
    // qua nhà cung cấp nào. Không suy đoán từ ngữ cảnh bên ngoài.
    const deliveryResult = {
        delivered: chunks.length === 0 ? true : false,
        chunks: chunks.length,
        sentChunks: 0,
        providerBotId: normalizeBotId(provider.botId) || LEGACY_BOT_ID
    };
    for (let index = 0; index < chunks.length; index += 1) {
        const prefix = index > 0 && continuationHeader ? `${continuationHeader}\n\n` : "";
        const rawPayload = `${prefix}${chunks[index]}`;
        // Nhà cung cấp LUÔN nhận nội dung GỐC, chưa cắt định dạng.
        //
        // Bot chính thức gửi thẳng kèm parse_mode. ZCA cần nội dung gốc để tự
        // chuyển `**bold**` và `{orange}...{/orange}` thành styles[] gốc của Zalo.
        // Cắt markdown ở đây sẽ làm mất chính dữ liệu định dạng mà ZCA cần.
        const payload = rawPayload;
        const commandContext = dashboardCommandContext.getStore();
        if (commandContext && String(commandContext.chatId) === String(chatId)) {
            commandContext.messages.push({ chatId: String(chatId), text: payload });
        }
        try {
            await providerQueues.enqueueFor(
                provider.botId,
                () => Promise.resolve(provider.sendMessage(chatId, payload, sendOptions)),
                priority
            );
            deliveryResult.sentChunks += 1;
        } catch (error) {
            // Phân loại lỗi trước khi quyết định có thử lại dạng plain text hay không.
            //
            // Trước đây MỌI lỗi không phải 410 đều được thử lại plain text, kể cả
            // 422 (không có quyền) và 429 (quá tải). Hai loại đó không liên quan
            // gì tới định dạng, nên gửi lại chỉ nhân đôi số request vô ích và làm
            // tình trạng quá tải nặng thêm.
            const classification = classifyDeliveryError(error);
            const canRetryAsPlainText = classification.retryAsPlainText && Boolean(sendOptions.parse_mode);

            if (canRetryAsPlainText) {
                console.warn(`Lỗi định dạng markdown (${error.message}), gửi lại dạng plain text một lần...`);
                const fallbackOptions = { ...otherOptions };
                delete fallbackOptions.parse_mode;
                await providerQueues.enqueueFor(
                    provider.botId,
                    () => Promise.resolve(provider.sendMessage(chatId, toPlainText(payload), fallbackOptions)),
                    priority
                );
                deliveryResult.sentChunks += 1;
                continue;
            }

            if (classification.kind === DELIVERY_ERROR_KIND.PERMANENT) {
                // Đích không dùng được nữa: ghi nhận để không bắn tiếp vào đó, nhưng
                // KHÔNG xoá dữ liệu người dùng — chỉ đánh dấu để quản trị viên xử lý.
                recordUndeliverableChat(chatId, classification);
                error.deliveryRecorded = true;
            }
            // Gắn phân loại lỗi lên đối tượng lỗi để tầng gọi không phải tự đoán lại
            // (cổng tiếp nhận cần biết đây có phải từ chối dứt khoát hay không).
            error.deliveryClassification = classification;
            error.deliveryResult = deliveryResult;
            // Cổng tiếp nhận: báo cho ngữ cảnh sự kiện vào biết lần gửi này thất bại.
            notifyAdmissionFailure(chatId, error);
            throw error;
        }
    }
    deliveryResult.delivered = deliveryResult.sentChunks === chunks.length;
    // Cổng tiếp nhận: báo cho ngữ cảnh sự kiện vào biết đã trả lời được chat này.
    if (deliveryResult.delivered) notifyAdmissionSuccess(chatId);
    return deliveryResult;
}

// Thông báo cho ngữ cảnh cổng tiếp nhận (nếu có) rằng một lần gửi tới chatId vừa
// thành công. Chỉ áp dụng khi lần gửi thuộc ĐÚNG sự kiện vào của chat đó.
function notifyAdmissionSuccess(chatId) {
    const ctx = inboundAdmissionContext.getStore();
    if (!ctx || String(ctx.chatId) !== String(chatId)) return;
    if (typeof ctx.onAdmitted === "function") ctx.onAdmitted();
}

function notifyAdmissionFailure(chatId, error) {
    const ctx = inboundAdmissionContext.getStore();
    if (!ctx || String(ctx.chatId) !== String(chatId)) return;
    const failure = classifyAdmissionFailure(error);
    if (failure.definite) {
        if (typeof ctx.onDefiniteRejection === "function") ctx.onDefiniteRejection(failure);
    } else if (typeof ctx.onUncertain === "function") {
        ctx.onUncertain(error);
    }
}

function getCommandArgument(match) {
    return (match?.[1] || "").trim();
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
        .replace(/(\/\w+)@Bot\b(?:[ \t]+[\w\d_]+)*/gi, "$1")
        .replace(/(\/\w+)@[\w\d_]+/gi, "$1")
        .replace(/@Bot\b(?:[ \t]+[\w\d_]+)*/gi, "")
        .replace(/@[\w\d_]+/gi, "")
        .trim();

    if (!clean.startsWith("/")) return null;

    const match = clean.match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
    if (!match) return null;

    // Bí danh được quy về tên chính tắc ngay tại đây, nên toàn bộ phần xử lý
    // phía sau chỉ cần so sánh với một tên duy nhất cho mỗi lệnh.
    const command = resolveCommandName(match[1]);
    const argument = (match[2] || "").trim();

    return { command, argument };
}

function isOwner(context) {
    const configured = getConfiguredAdminIds();
    if (configured.userIds.length === 0 && configured.chatIds.length === 0) return false;
    // Khi chạy từ dashboard, quyền hạn luôn xét theo admin đang đăng nhập —
    // không bao giờ theo userId do trình duyệt gửi lên hay theo người được
    // chọn làm đích. Nhờ vậy Command console có thể chạy lệnh với ngữ cảnh của
    // người nhận mà vẫn giữ nguyên kiểm tra quyền.
    const actor = dashboardCommandContext.getStore()?.actor;
    if (actor) return isConfiguredAdmin({ userId: actor.userId, chatId: actor.chatId });
    return isConfiguredAdmin(context);
}

async function sendUserError(chatId, error, operation = "command") {
    console.error(`Lỗi ${operation}:`, error);
    logDiscord("ERROR", `${operation}_error: ${error?.message || error}`);
    await sendMessage(chatId, formatErrorMessage(error));
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

// Nguồn gốc của một đích phát tin: (botId, chatId) — KHÔNG BAO GIỜ chỉ chatId.
//
// Vì sao: hai bot có thể cùng gặp một Chat ID (Zalo cấp Chat ID theo từng tài
// khoản), đó là HAI cuộc trò chuyện khác nhau với hai người khác nhau. Gộp theo
// chatId trần sẽ làm mất một người nhận, và tệ hơn: gửi tin bằng tài khoản không
// sở hữu cuộc trò chuyện đó.
function broadcastKey(botId, chatId) {
    return `${normalizeBotId(botId) || LEGACY_BOT_ID}::${String(chatId)}`;
}

// Bot sở hữu một bản ghi tương tác.
//
// `botId` là nguồn duy nhất đáng tin: bản ghi do chính bot ghi ra. Bản ghi không
// khai báo botId là dữ liệu cũ chưa xác minh nguồn — trả null, KHÔNG mặc định bot 1.
// Không suy từ tiền tố khóa vì getInteractionTargets() đã bỏ mất khóa.
function interactionOwnerId(target) {
    return normalizeBotId(target?.botId);
}

// Đích hợp lệ để phát tin: phải biết chắc tài khoản sở hữu VÀ bot đó đang bật.
//
// Bot đang tắt không phải "chưa xác minh": không có tài khoản nào gửi được, nên
// đích bị loại khỏi đợt phát thay vì để lỗi giữa chừng hoặc rơi về bot khác.
function resolveBroadcastOwner(target) {
    const ownerId = interactionOwnerId(target);
    if (!ownerId) return { ownerId: null, runtime: null, reason: "unverified_source" };
    const runtime = getBot(ownerId);
    if (!runtime) return { ownerId, runtime: null, reason: "owner_bot_offline" };
    return { ownerId, runtime, reason: null };
}

function getBroadcastTargets(feature = "broadcast") {
    // Khóa gộp là (botId, chatId). Cùng Chat ID ở hai tài khoản là hai đích riêng.
    const targets = new Map();
    const skipped = { unverifiedSource: 0, ownerBotOffline: 0 };
    const addTarget = (key, target) => {
        if (!targets.has(key)) targets.set(key, target);
    };

    // Ghi sổ chat bằng MỘT lượt đối chiếu gộp thay vì một lần cho mỗi đích.
    //
    // Cách cũ gọi upsertChat() trong vòng lặp, nên mỗi lần /thongbao lại tạo ra N
    // lần đọc + N lần ghi cả tài liệu sổ chat. Với hàng trăm đích thì đây vừa là
    // điểm nghẽn tốc độ vừa là nguồn phình bộ nhớ ngay trước khi bắn tin.
    const entriesByBot = new Map();
    const addEntry = (botId, entry) => {
        const normalized = normalizeBotId(botId) || LEGACY_BOT_ID;
        const list = entriesByBot.get(normalized) || [];
        list.push(entry);
        entriesByBot.set(normalized, list);
    };

    for (const target of getInteractionTargets()) {
        // Bản ghi chưa rõ tài khoản KHÔNG BAO GIỜ được phát tin: không có căn cứ nào
        // để chọn tài khoản gửi, và đoán sai nghĩa là nhắn cho người khác.
        const owner = resolveBroadcastOwner(target);
        if (!owner.ownerId) {
            skipped.unverifiedSource += 1;
            continue;
        }
        addEntry(owner.ownerId, {
            chatId: target.chatId,
            chatType: target.chatType,
            displayName: target.chatTitle || target.lastUserDisplayName,
            userId: target.lastUserId,
            chatTitle: target.chatTitle,
            lastInboundInteractionAt: target.lastInteractionAt,
            firstInteractionAt: target.firstInteractionAt
        });
        addTarget(broadcastKey(owner.ownerId, target.chatId), {
            ...target,
            chatId: String(target.chatId),
            botId: owner.ownerId
        });
    }

    // Giữ tương thích với dữ liệu có trước khi sổ tương tác được bổ sung.
    for (const [subscriptionKey, subscription] of Object.entries(getAllSubscriptions())) {
        // Schema cũ dùng trực tiếp chatId làm khóa; schema mới có trường chatId rõ ràng.
        const legacyChatId = !subscriptionKey.includes("::") ? subscriptionKey : null;
        const rawChatId = subscription?.chatId ?? legacyChatId;
        if (rawChatId == null) continue;
        const chatId = String(rawChatId);
        // Trường botId tường minh trước; nếu thiếu thì khóa ĐÃ CÓ PHẠM VI mới là bằng
        // chứng. Khóa trần là bản ghi cũ chưa xác minh nguồn — bỏ qua thay vì gán bot 1,
        // vì đoán sai tài khoản nghĩa là nhắn cho người khác.
        const declared = normalizeBotId(subscription?.botId);
        const parsedKey = parseScopedKey(subscriptionKey);
        const botId = declared || (parsedKey.scoped ? parsedKey.botId : null);
        if (!botId) {
            skipped.unverifiedSource += 1;
            continue;
        }
        addEntry(botId, {
            chatId,
            chatType: subscription.chatType || "unknown",
            displayName: subscription.chatTitle || subscription.userDisplayName || ""
        });
        const key = broadcastKey(botId, chatId);
        if (!targets.has(key)) {
            addTarget(key, { chatId, botId, chatType: "unknown" });
        }
    }

    for (const [botId, entries] of entriesByBot) {
        const runtime = getBot(botId);
        const run = () => reconcileChatDirectory(entries);
        if (runtime) runWithBot(runtime, run); else run();
    }

    const resolved = [];
    const skippedAdmission = { pending: 0, unreachable: 0 };
    for (const target of targets.values()) {
        // Quyền truy cập chat được kiểm tra trong ngữ cảnh của bot SỞ HỮU đích, nếu
        // không bot 2 sẽ bị đánh giá bằng sổ chat của bot 1.
        const owner = resolveBroadcastOwner(target);
        if (!owner.runtime) {
            if (owner.reason === "owner_bot_offline") skipped.ownerBotOffline += 1;
            else skipped.unverifiedSource += 1;
            continue;
        }
        // Chốt bổ sung: chỉ chat ĐÃ TIẾP NHẬN mới được tính là người nhận. Bản ghi
        // trong store vốn đã chỉ được tạo sau khi tiếp nhận, nhưng dữ liệu cũ hoặc
        // bản ghi sót lại vẫn có thể mang admissionStatus khác — kiểm tra tường minh.
        const admission = runWithBot(owner.runtime, () => getChat(target.chatId)?.admissionStatus || "admitted");
        if (admission !== "admitted") {
            if (admission === "unreachable") skippedAdmission.unreachable += 1;
            else skippedAdmission.pending += 1;
            continue;
        }
        const eligible = runWithBot(owner.runtime, () => isChatEligible(target.chatId, feature));
        if (eligible) resolved.push({ ...target, botId: owner.ownerId });
    }

    skipped.notAdmitted = skippedAdmission.pending + skippedAdmission.unreachable;
    skipped.pendingAdmission = skippedAdmission.pending;
    skipped.unreachable = skippedAdmission.unreachable;

    // `skipped` chỉ để chẩn đoán và ghi log — không phải danh sách người nhận.
    return Object.assign(resolved, { skipped });
}

// Gửi thông báo tới mọi chat đủ điều kiện. Dùng chung cho /thongbao (thông báo
// chung) và /update (thông báo cập nhật): cùng cách chọn đích, cùng kiểm tra
// điều kiện nhận, cùng bảng tổng kết gửi/lỗi. Chỉ khác nhãn ghi log.
async function sendBotAnnouncement(message, options = {}) {
    const { operation = "announcement", logLabel = "thông báo chung" } = options;
    const targets = getBroadcastTargets();
    const skipped = targets.skipped || { unverifiedSource: 0, ownerBotOffline: 0 };
    const result = { targets: targets.length, sent: 0, failed: 0, skipped };
    if (skipped.unverifiedSource > 0 || skipped.ownerBotOffline > 0) {
        console.warn(
            `[Phát tin] Bỏ qua ${skipped.unverifiedSource} đích chưa rõ tài khoản và ` +
            `${skipped.ownerBotOffline} đích có bot sở hữu đang tắt.`
        );
    }
    // Gửi hàng loạt có kiểm soát.
    //
    // Trước đây vòng lặp này await TUẦN TỰ từng đích: 500 đích × ~200ms = 100 giây.
    // Nay mỗi đích được xếp vào hàng đợi của nhà cung cấp sở hữu nó với mức ưu tiên
    // BULK, nên chạy song song có trần và không chen ngang việc trả lời người dùng.
    //
    // Mỗi lần gửi PHẢI chạy trong ngữ cảnh của bot sở hữu đích: nếu không, tin của
    // bot 2 sẽ đi ra bằng token bot 1 — nhắn cho người khác bằng tài khoản khác.
    const deliveries = targets.map((target) => {
        const owner = resolveBroadcastOwner(target);
        if (!owner.runtime) {
            return Promise.resolve({
                target,
                error: new Error(`Không có bot ${owner.ownerId || "(chưa rõ)"} đang bật để gửi cho chat ${target.chatId}`)
            });
        }
        return runWithBot(owner.runtime, () => sendNotification(target.chatId, message, {
            feature: "broadcast",
            operation,
            priority: PRIORITY.BULK
        }))
            .then((delivery) => ({ target, delivery }))
            .catch((error) => ({ target, error }));
    });

    const outcomes = await Promise.allSettled(deliveries);
    for (const outcome of outcomes) {
        if (outcome.status !== "fulfilled") {
            result.failed += 1;
            continue;
        }
        const { target, delivery, error } = outcome.value;
        if (error) {
            result.failed += 1;
            logDiscord("ERROR", `Không thể gửi ${logLabel} cho chat ${target.chatId}: ${error.message}`);
            continue;
        }
        if (delivery?.sent) {
            result.sent += 1;
        } else if (delivery?.failed) {
            result.failed += 1;
            logDiscord("ERROR", `Không thể gửi ${logLabel} cho chat ${target.chatId}: ${delivery.error?.message || "không rõ"}`);
        }
    }
    return result;
}

function formatBroadcastSummary(title, result) {
    const skipped = result.skipped || { unverifiedSource: 0, ownerBotOffline: 0 };
    const skipTotal = skipped.unverifiedSource + skipped.ownerBotOffline;
    return `# {green}✓ ${title}{/green}\n\n` +
        `> **Tổng cuộc trò chuyện:** ${result.targets}\n` +
        `> **Gửi thành công:** ${result.sent}\n` +
        `> **Gửi lỗi:** ${result.failed}` +
        (skipTotal > 0
            ? `\n> **Bỏ qua:** ${skipTotal} (${skipped.unverifiedSource} chưa rõ tài khoản, ${skipped.ownerBotOffline} bot sở hữu đang tắt)`
            : "");
}

// Chạy đợt thông báo MỘT LẦN từ danh sách liên hệ khôi phục, TRONG CÙNG tiến trình
// này. Đây là đường được hỗ trợ để gửi kèm tài khoản ZCA: registry nhà cung cấp —
// và do đó là phiên ZCA đang đăng nhập — chỉ tồn tại trong tiến trình đang chạy.
//
// Trả về cùng cấu trúc mà scripts/sendRecoveredAnnouncement.js xuất ra. Không bao
// giờ ghi vào Firestore: chỉ đọc file nguồn và gửi tin.
async function runRecoveredAnnouncement(argv = [], options = {}) {
    const { main } = require("./scripts/sendRecoveredAnnouncement");
    return main(argv, {
        ...options,
        // Truyền registry sống của tiến trình này để script lấy được nhà cung cấp.
        runtimeRegistry: options.runtimeRegistry || globalThis.__ZALOBOT_RUNTIMES__ || null
    });
}


async function sendWelcomeMessage(chatId, displayName = "bạn") {
    await sendMessage(chatId, formatWelcomeMessage(displayName));
}

// Ngày đích do người dùng chọn: homnay = hôm nay, homsau = hôm sau.
// Bỏ dấu và mọi ký tự không phải chữ nên "hôm nay", "hom nay", "HOMNAY" đều
// nhận được, nhưng vẫn chỉ có đúng hai giá trị hợp lệ.
function normalizeTargetDayToken(value) {
    const compact = String(value == null ? "" : value)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .toLowerCase()
        .replace(/[^a-z]/g, "");
    if (compact === "homnay") return TARGET_DAY_TODAY;
    if (compact === "homsau") return TARGET_DAY_TOMORROW;
    return null;
}

// ID bản ghi: số nguyên dương. Dạng chính tắc khi hiển thị là "ID 1"; tiền tố
// '#' cũ vẫn được chấp nhận khi nhập để không phá thói quen cũ. Từ chối 0, số
// âm, số thập phân và chuỗi không phải số.
function parseRecordId(value) {
    const match = String(value == null ? "" : value).trim().match(/^#?(\d+)$/);
    if (!match) return null;
    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id >= 1 ? id : null;
}

// Lấy ngày đích ở cuối danh sách token. Chấp nhận một token ("homnay") hoặc
// hai token khi người dùng gõ đúng chính tả có dấu ("hôm nay").
function takeDayToken(tokens) {
    const single = normalizeTargetDayToken(tokens[tokens.length - 1]);
    if (single != null) return { offset: single, length: 1 };
    if (tokens.length >= 2) {
        const pair = normalizeTargetDayToken(tokens.slice(-2).join(""));
        if (pair != null) return { offset: pair, length: 2 };
    }
    return { offset: null, length: 0 };
}

// Cú pháp thống nhất: /nhanlich [MSSV] hh:mm homnay|homsau
// MSSV đứng trước, giờ ở giữa, ngày đích ở cuối. Thiếu ngày đích thì báo lỗi
// chứ KHÔNG suy đoán, để không âm thầm gửi sai ngày.
function parseNhanLichArgument(argument, savedStudentId) {
    const raw = String(argument || "").trim();
    if (!raw) return { error: "empty" };

    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return { error: "day" };

    // Ngày đích có thể là một token ("homnay") hoặc hai token khi người dùng gõ
    // đúng chính tả có dấu ("hôm nay").
    const dayToken = takeDayToken(parts);
    if (dayToken.offset == null) return { error: "day" };

    const timeIndex = parts.length - dayToken.length - 1;
    if (timeIndex < 0) return { error: "day" };

    const studentTokens = parts.slice(0, timeIndex);
    if (studentTokens.length > 1) return { error: "syntax" };

    const notificationTime = normalizeNotificationTime(parts[timeIndex], null);
    if (!notificationTime) return { error: "time" };

    let studentId = normalizeStudentId(savedStudentId);
    if (studentTokens.length === 1) {
        studentId = normalizeStudentId(studentTokens[0]);
        if (!studentId) return { error: "student" };
    }
    if (!studentId) return { error: "student" };

    return { studentId, notificationTime, targetDayOffset: dayToken.offset };
}

// Cú pháp: /suagionhanlich ID hh:mm homnay|homsau
// hoặc     /suagionhanlich ID homnay|homsau   (chỉ đổi ngày đích)
// "ID" là số nguyên dương; "#1" cũ vẫn nhận được.
function parseSuaGioNhanLichArgument(argument) {
    const match = String(argument || "").trim().match(/^(#?\d+)\s+([\s\S]+)$/);
    if (!match) return { error: "syntax" };

    const id = parseRecordId(match[1]);
    if (id == null) return { error: "id" };

    const rest = match[2].trim().split(/\s+/).filter(Boolean);
    if (rest.length === 0) return { error: "syntax" };

    const dayToken = takeDayToken(rest);
    if (dayToken.offset == null) return { error: "day" };

    const beforeDay = rest.slice(0, rest.length - dayToken.length);
    if (beforeDay.length === 0) return { id, notificationTime: null, targetDayOffset: dayToken.offset };
    if (beforeDay.length > 1) return { error: "syntax" };

    const notificationTime = normalizeNotificationTime(beforeDay[0], null);
    if (!notificationTime) return { error: "time" };
    return { id, notificationTime, targetDayOffset: dayToken.offset };
}

// Dùng cho gợi ý khi người dùng gõ sai lệnh. Khóa là TÊN CHÍNH TẮC; tên cũ
// được quy về đây qua resolveCommandName() nên gợi ý luôn hướng người dùng sang
// tên mới.
const COMMAND_EXAMPLES = {
    start: "/start",
    luumssv: "/luumssv 123456789",
    nhanlich: "/nhanlich 06:30 homnay",
    gionhanlich: "/gionhanlich",
    suagionhanlich: "/suagionhanlich 1 06:30 homnay",
    xoagionhanlich: "/xoagionhanlich 1",
    lich: "/lich 123456789",
    lichtuan: "/lichtuan 123456789",
    lichthi: "/lichthi 123456789",
    lichgv: "/lichgv Nguyễn Văn A",
    phongtrong: "/phongtrong 1",
    ai: "/ai Hôm nay tôi học môn gì?",
    batnhaclich: "/batnhaclich",
    tatnhaclich: "/tatnhaclich",
    trangthainhaclich: "/trangthainhaclich",
    tatnhanlich: "/tatnhanlich",
    myid: "/myid",
    help: "/help",
    helpadmin: "/helpadmin",
    time: "/time",
    thongbao: "/thongbao Hệ thống sẽ bảo trì lúc 22:00",
    update: "/update Đã bổ sung tuỳ chọn ngày nhận lịch",
    blockbot: "/blockbot 123456",
    unblockbot: "/unblockbot 123456",
    blockai: "/blockai 123456",
    unblockai: "/unblockai 123456",
    allowbot: "/allowbot 123456",
    unallowbot: "/unallowbot 123456",
    allowai: "/allowai 123456",
    unallowai: "/unallowai 123456",
    accessmode: "/accessmode bot allowlist",
    accesslist: "/accesslist",
    quanlychat: "/quanlychat inactive 1",
    chitietchat: "/chitietchat 123456",
    tamdungchat: "/tamdungchat 123456",
    batlaichat: "/batlaichat 123456",
    kiemtrachat: "/kiemtrachat 123456",
    xoachat: "/xoachat 123456",
    chatfeature: "/chatfeature 123456 schedule off",
    test6h: "/test6h"
};

function editDistance(left, right) {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = [leftIndex];
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
            current[rightIndex] = Math.min(
                current[rightIndex - 1] + 1,
                previous[rightIndex] + 1,
                previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
            );
        }
        previous.splice(0, previous.length, ...current);
    }
    return previous[right.length];
}

function suggestCommandCorrection(command) {
    const compact = String(command || "").toLowerCase();
    const knownCommands = Object.keys(COMMAND_EXAMPLES).sort((a, b) => b.length - a.length);
    for (const known of knownCommands) {
        if (!compact.startsWith(known) || compact === known) continue;
        const suffix = compact.slice(known.length);
        // Gợi ý kèm sẵn phần ngày đích để người dùng biết phải chọn, nhưng
        // không tự đoán hôm nay hay hôm sau.
        if (known === "nhanlich" && /^([01]\d|2[0-3])([0-5]\d)$/.test(suffix)) {
            return `/nhanlich ${suffix.slice(0, 2)}:${suffix.slice(2)} homnay|homsau`;
        }
        return `/${known} ${suffix}`;
    }
    const nearest = knownCommands
        .map((known) => ({ known, distance: editDistance(compact, known) }))
        .sort((a, b) => a.distance - b.distance || a.known.localeCompare(b.known))[0];
    return nearest && nearest.distance <= 2 && compact.length >= 4
        ? COMMAND_EXAMPLES[nearest.known]
        : "/help";
}

// Nhãn ngày đích dùng thống nhất ở chat, dashboard và thông báo.
function formatTargetDay(targetDayOffset) {
    return Number(targetDayOffset) === TARGET_DAY_TOMORROW ? "homsau" : "homnay";
}

function formatTargetDayLabel(targetDayOffset) {
    return Number(targetDayOffset) === TARGET_DAY_TOMORROW ? "lịch hôm sau" : "lịch hôm nay";
}

function formatNotificationTimes(subscription) {
    const times = normalizeNotificationTimes(subscription);
    if (!times.length) return "> Chưa có giờ nhận lịch.";
    return times
        .map((item) => `- **ID ${item.id}** — \`${item.time}\` · **${formatTargetDay(item.targetDayOffset)}** (${formatTargetDayLabel(item.targetDayOffset)})`)
        .join("\n");
}

function formatChatTime(value) {
    if (!value) return "-";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("vi-VN", { timeZone: TIME_ZONE });
}

function formatChatDirectoryList(argument = "") {
    const [rawFilter = "all", rawPage = "1"] = String(argument || "").trim().split(/\s+/).filter(Boolean);
    const filter = rawFilter.toLowerCase();
    const page = Math.max(1, Number(rawPage) || 1);
    const allowed = new Set(["all", "active", "inactive", "disabled", "removed", "private", "group", "unknown"]);
    if (!allowed.has(filter)) return null;
    const all = getAllChats().filter((chat) => filter === "all" || chat.status === filter || chat.chatType === filter);
    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
    const currentPage = Math.min(page, totalPages);
    const rows = all.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((chat) => {
        const name = chat.displayName || "Không rõ tên";
        const lastError = chat.lastError ? `${chat.lastError.status || chat.lastError.code || "ERR"}: ${chat.lastError.message}` : "-";
        return `- **${escapeMarkdown(name)}** · \`${escapeMarkdown(chat.chatId)}\`\n  ${escapeMarkdown(chat.chatType)} · **${escapeMarkdown(chat.status)}** · Thành công: ${escapeMarkdown(formatChatTime(chat.lastSuccessfulDeliveryAt))}\n  Lỗi cuối: ${escapeMarkdown(lastError.slice(0, 140))}`;
    });
    return `# {orange}[ADMIN] QUẢN LÝ CHAT{/orange}\n\n> **Bộ lọc:** ${escapeMarkdown(filter)} · **Trang:** ${currentPage}/${totalPages} · **Tổng:** ${all.length}\n\n${rows.join("\n\n") || "> _Không có chat phù hợp._"}`;
}

function formatChatDetails(record) {
    if (!record) return null;
    const overrides = Object.entries(record.notificationOverrides || {}).map(([feature, value]) => `${feature}=${value == null ? "auto" : value ? "on" : "off"}`).join(", ");
    const error = record.lastError;
    return `# {orange}[ADMIN] CHI TIẾT CHAT{/orange}\n\n` +
        `> **Chat ID:** \`${escapeMarkdown(record.chatId)}\`\n` +
        `> **Loại:** ${escapeMarkdown(record.chatType || "unknown")}\n` +
        `> **Tên:** ${escapeMarkdown(record.displayName || "Không rõ")}\n` +
        `> **Trạng thái:** **${escapeMarkdown(record.status || "active")}**\n` +
        `> **Lý do:** ${escapeMarkdown(record.statusReason || "-")}\n` +
        `> **Tính năng:** ${escapeMarkdown(overrides || "auto")}\n` +
        `> **Tương tác cuối:** ${escapeMarkdown(formatChatTime(record.lastInboundInteractionAt || record.lastInteractionAt))}\n` +
        `> **Gửi thành công cuối:** ${escapeMarkdown(formatChatTime(record.lastSuccessfulDeliveryAt))}\n` +
        `> **Lỗi liên tiếp:** ${Number(record.consecutiveFailureCount) || 0}\n` +
        `> **Lỗi cuối:** ${escapeMarkdown(error ? `${error.status || error.code || "ERR"} ${error.message}` : "-")}\n` +
        `> **Thời điểm lỗi:** ${escapeMarkdown(formatChatTime(error?.at))}`;
}

// Đối chiếu sổ chat từ dữ liệu cũ (sổ tương tác + đăng ký) khi khởi động.
//
// Hai điều quan trọng:
//
// 1. GHI TỐI ĐA MỘT LẦN cho mỗi bot. Cách cũ gọi upsertChat() cho từng bản ghi, mà
//    mỗi lần lại đọc rồi ghi cả sổ ⇒ hàng trăm lần ghi Firestore cho cùng một tài
//    liệu ngay lúc khởi động. Nay gộp trong bộ nhớ rồi ghi một lần.
//
// 2. ĐÚNG NGĂN CỦA TỪNG BOT. Sổ tương tác và đăng ký chứa bản ghi của MỌI bot,
//    nhưng khóa lưu trữ lại phụ thuộc bot đang chạy. Gọi trong ngữ cảnh mặc định
//    (bot 1) sẽ kéo bản ghi của bot 2/bot 3 vào ngăn của bot 1. Vì vậy phải gom
//    theo bot rồi chạy mỗi nhóm trong ngữ cảnh của chính bot đó.
function syncChatDirectoryFromLegacyStores() {
    const entriesByBot = new Map();
    const addEntry = (botId, entry) => {
        const normalized = normalizeBotId(botId) || LEGACY_BOT_ID;
        const list = entriesByBot.get(normalized) || [];
        list.push(entry);
        entriesByBot.set(normalized, list);
    };

    for (const target of getInteractionTargets()) {
        addEntry(target.botId, {
            chatId: target.chatId,
            chatType: target.chatType,
            displayName: target.chatTitle || target.lastUserDisplayName,
            userId: target.lastUserId,
            chatTitle: target.chatTitle,
            firstInteractionAt: target.firstInteractionAt,
            lastInboundInteractionAt: target.lastInteractionAt
        });
    }

    for (const [key, subscription] of Object.entries(getAllSubscriptions())) {
        const legacyChatId = !key.includes("::") ? key : null;
        const chatId = subscription?.chatId ?? legacyChatId;
        if (chatId == null) continue;
        addEntry(subscription?.botId || parseScopedKey(key).botId, {
            chatId,
            chatType: subscription.chatType || "unknown",
            displayName: subscription.chatTitle || subscription.userDisplayName || ""
        });
    }

    let changed = 0;
    for (const [botId, entries] of entriesByBot) {
        const runtime = getBot(botId);
        const run = () => reconcileChatDirectory(entries);
        // Bot chưa đăng ký (hiếm) thì chạy ở ngữ cảnh hiện tại thay vì bỏ sót.
        changed += runtime ? runWithBot(runtime, run) : run();
    }
    return changed;
}

async function handleCommand(msg, parsedCommand) {
    // Lấy botId từ NGỮ CẢNH đang chạy, không để mặc định về bot 1.
    //
    // getMessageContext() mặc định botId là bot 1 khi không được truyền vào. Trước
    // đây điều đó vô hại vì context.botId không được dùng ở đây; nhưng /feedback
    // lưu yêu cầu theo botId, nên thiếu bước này thì yêu cầu của bot2/bot3 bị ghi
    // vào ngăn của bot1 — và trả lời sau đó sẽ gửi tới cuộc trò chuyện của bot1.
    const context = getMessageContext(msg, { botId: getCurrentBotId() });
    const chatId = context.chatId;
    const { command, argument } = parsedCommand;

    if (command === "start") {
        await sendWelcomeMessage(chatId, msg.from?.display_name);
    } else if (command === "luumssv") {
        const studentId = normalizeStudentId(argument);
        if (!studentId) {
            await sendMessage(chatId, formatWarningMessage(
                "SAI CÚ PHÁP",
                "> **Cú pháp:** /luumssv [MSSV]\n> **Ví dụ:** /luumssv 123456789"
            ));
            return;
        }

        try {
            const data = await fetchStudentSchedule(studentId);
            // Ghi MSSV qua cổng tiếp nhận: chat chưa được xác nhận thì chỉ hoãn lại,
            // KHÔNG ghi một bản ghi người dùng cho chat mà bot có thể không trả lời được.
            const subscription = gatedWrite(
                context,
                "save_student",
                () => saveStudent(context, { studentId, studentName: data.studentName }),
                { fallback: { studentId, studentName: data.studentName, notificationTimes: [] } }
            );

            await sendMessage(
                chatId,
                formatStudentSavedMessage(data, subscription)
            );
        } catch (error) {
            await sendUserError(chatId, error, "luumssv");
        }
    } else if (command === "nhanlich") {
        const saved = getSubscription(context);
        const parsedRegistration = parseNhanLichArgument(argument, saved?.studentId);

        if (parsedRegistration.error) {
            // Lỗi thiếu ngày đích là lỗi hay gặp nhất nên được giải thích riêng,
            // kèm cả hai ví dụ để người dùng chọn đúng.
            const body = parsedRegistration.error === "day"
                ? "> **Cú pháp:** /nhanlich [MSSV] hh:mm homnay|homsau\n" +
                  "> **Ví dụ:** /nhanlich 06:30 homnay\n" +
                  "> **Ví dụ:** /nhanlich 20:00 homsau\n" +
                  "> **Ví dụ:** /nhanlich 123000xxx 06:30 homnay\n" +
                  "> **homnay** = gửi lịch hôm nay, **homsau** = gửi lịch hôm sau. Bắt buộc phải chọn một trong hai."
                : "> **Cú pháp:** /nhanlich [MSSV] hh:mm homnay|homsau\n" +
                  "> **Ví dụ:** /nhanlich 06:30 homnay\n" +
                  "> **Ví dụ:** /nhanlich 20:00 homsau\n" +
                  "> Giờ hợp lệ từ **00:00** đến **23:59**.";
            await sendMessage(chatId, parsedRegistration.error === "student"
                ? formatMissingStudentIdMessage("nhanlich")
                : formatWarningMessage("SAI CÚ PHÁP", body));
            return;
        }

        const { studentId, notificationTime, targetDayOffset } = parsedRegistration;

        try {
            const data = await fetchStudentSchedule(studentId);
            const wasAlreadyWatched = Object.values(getEnabledSubscriptions())
                .some((subscription) => subscription.studentId === studentId);
            // Ghi đăng ký qua cổng tiếp nhận: hoãn nếu chat chưa được xác nhận.
            const updatedSubscription = gatedWrite(
                context,
                "enable_notifications",
                () => {
                    enableNotifications(context, {
                        studentId,
                        studentName: data.studentName,
                        notificationTime,
                        targetDayOffset
                    });
                    // Ảnh chụp lịch chỉ có nghĩa khi đăng ký thật sự được ghi.
                    initializeScheduleSnapshot(data, new Date(), !wasAlreadyWatched);
                    return getSubscription(context);
                },
                {
                    // Dự phòng: đủ để dựng thông điệp xác nhận khi thao tác bị hoãn.
                    fallback: {
                        studentId,
                        studentName: data.studentName,
                        notificationTimes: [{ time: notificationTime, targetDayOffset }]
                    }
                }
            );
            const notificationTimes = normalizeNotificationTimes(updatedSubscription);
            await sendMessage(
                chatId,
                formatDailyNotificationEnabled(data, notificationTimes)
            );
        } catch (error) {
            await sendUserError(chatId, error, "daily_subscription");
        }
    } else if (command === "gionhanlich") {
        const saved = getSubscription(context);
        const times = normalizeNotificationTimes(saved);
        await sendMessage(chatId, times.length
            ? `# {green}[GIỜ NHẬN LỊCH]{/green}\n\n${formatNotificationTimes(saved)}`
            : formatWarningMessage("CHƯA CÓ GIỜ NHẬN LỊCH", "> Dùng **/nhanlich [MSSV] hh:mm homnay|homsau** để thêm giờ nhận lịch."));
    } else if (command === "suagionhanlich") {
        const saved = getSubscription(context);
        const parsed = parseSuaGioNhanLichArgument(argument);
        if (!saved || parsed.error) {
            const body = parsed.error === "day"
                ? "> **Cú pháp:** /suagionhanlich ID hh:mm homnay|homsau\n" +
                  "> **Ví dụ:** /suagionhanlich 1 06:30 homnay\n" +
                  "> **Ví dụ:** /suagionhanlich 2 21:00 homsau\n" +
                  "> Chỉ muốn đổi ngày đích: /suagionhanlich 2 homsau\n" +
                  "> **homnay** = lịch hôm nay, **homsau** = lịch hôm sau. Bắt buộc phải chọn một trong hai."
                : parsed.error === "id"
                    ? "> **Cú pháp:** /suagionhanlich ID hh:mm homnay|homsau\n" +
                      "> **Ví dụ:** /suagionhanlich 1 06:30 homnay\n" +
                      "> ID là số nguyên dương (1, 2, 3, …). Dùng **/gionhanlich** để xem ID."
                    : "> **Cú pháp:** /suagionhanlich ID hh:mm homnay|homsau\n" +
                      "> **Ví dụ:** /suagionhanlich 1 06:30 homnay\n" +
                      "> **Ví dụ:** /suagionhanlich 2 homsau\n" +
                      "> Dùng **/gionhanlich** để xem ID.";
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", body));
            return;
        }
        const updated = updateNotificationTime(context, parsed.id, parsed.notificationTime, parsed.targetDayOffset);
        await sendMessage(
            chatId,
            updated
                ? formatSuccessMessage("ĐÃ CẬP NHẬT GIỜ NHẬN LỊCH", formatNotificationTimes(updated))
                : formatWarningMessage("KHÔNG THỂ SỬA", `> Không có ID **${parsed.id}**, hoặc đã có mốc khác cùng giờ và cùng ngày đích.`)
        );
    } else if (command === "xoagionhanlich") {
        const parsedId = parseRecordId(argument);
        if (parsedId == null) {
            await sendMessage(chatId, formatWarningMessage(
                "SAI CÚ PHÁP",
                "> **Cú pháp:** /xoagionhanlich ID\n> **Ví dụ:** /xoagionhanlich 1\n> ID là số nguyên dương. Dùng **/gionhanlich** để xem ID."
            ));
            return;
        }
        const removed = removeNotificationTime(context, parsedId);
        await sendMessage(
            chatId,
            removed
                ? formatSuccessMessage(`ĐÃ XÓA GIỜ ${removed.removed.time} (${formatTargetDay(removed.removed.targetDayOffset)})`, formatNotificationTimes(removed.subscription))
                : formatWarningMessage("KHÔNG TÌM THẤY", `> Không có giờ nhận lịch **ID ${parsedId}**.`)
        );
    } else if (command === "lich") {
        const saved = getSubscription(context);
        const studentId = resolveStudentIdForCommand(argument, saved?.studentId);

        if (!studentId) {
            await sendMessage(chatId, argument
                ? formatWarningMessage("MSSV KHÔNG HỢP LỆ", "> MSSV phải gồm đúng **9 chữ số**.")
                : formatMissingStudentIdMessage("lich"));
            return;
        }

        try {
            const data = await fetchStudentSchedule(studentId);
            await sendMessage(chatId, formatDailySchedule(data));
        } catch (error) {
            await sendUserError(chatId, error, "daily_schedule");
        }
    } else if (command === "lichtuan") {
        const saved = getSubscription(context);
        const studentId = resolveStudentIdForCommand(argument, saved?.studentId);

        if (!studentId) {
            await sendMessage(chatId, argument
                ? formatWarningMessage("MSSV KHÔNG HỢP LỆ", "> MSSV phải gồm đúng **9 chữ số**.")
                : formatMissingStudentIdMessage("lichtuan"));
            return;
        }

        try {
            const data = await fetchStudentSchedule(studentId);
            await sendMessage(chatId, formatWeeklySchedule(data));
        } catch (error) {
            await sendUserError(chatId, error, "weekly_schedule");
        }
    } else if (command === "tatnhanlich") {
        if (disableNotifications(context)) {
            await sendMessage(
                chatId,
                formatSuccessMessage(
                    "ĐÃ TẮT THÔNG BÁO LỊCH",
                    "> MSSV đã lưu vẫn dùng được với **/lich** và **/lichtuan**."
                )
            );
        } else {
            await sendMessage(
                chatId,
                formatWarningMessage(
                    "CHƯA ĐĂNG KÝ THÔNG BÁO",
                    "> Dùng **/nhanlich** để bật thông báo lịch học."
                )
            );
        }
    } else if (command === "batnhaclich") {
        const saved = getSubscription(context);
        if (!saved?.studentId) {
            await sendMessage(chatId, formatMissingStudentIdMessage("batnhaclich"));
            return;
        }
        const updated = enableClassStartNotifications(context);
        await sendMessage(chatId, formatClassStartEnabled(updated || saved));
    } else if (command === "tatnhaclich") {
        if (disableClassStartNotifications(context)) {
            await sendMessage(chatId, formatSuccessMessage("ĐÃ TẮT NHẮC GIỜ HỌC"));
        } else {
            await sendMessage(chatId, formatWarningMessage("NHẮC GIỜ HỌC ĐANG TẮT", "> Dùng **/batnhaclich** để bật."));
        }
    } else if (command === "trangthainhaclich") {
        const saved = getSubscription(context);
        if (!saved?.studentId) {
            await sendMessage(chatId, formatMissingStudentIdMessage("trangthainhaclich"));
            return;
        }
        await sendMessage(chatId, formatClassStartStatus(saved));
    } else if (command === "lichthi") {
        const saved = getSubscription(context);
        const studentId = resolveStudentIdForCommand(argument, saved?.studentId);

        if (!studentId) {
            await sendMessage(chatId, argument
                ? formatWarningMessage("MSSV KHÔNG HỢP LỆ", "> MSSV phải gồm đúng **9 chữ số**.")
                : formatMissingStudentIdMessage("lichthi"));
            return;
        }

        try {
            const data = await fetchExamSchedule(studentId);
            await sendMessage(chatId, formatExamSchedule(data));
        } catch (error) {
            await sendUserError(chatId, error, "exam_schedule");
        }
    } else if (command === "lichgv") {
        if (!argument) {
            await sendMessage(
                chatId,
                formatWarningMessage(
                    "SAI CÚ PHÁP",
                    "> **Cú pháp:** /lichgv [Tên giảng viên]\n> **Ví dụ:** /lichgv Nguyễn Minh Phúc"
                )
            );
            return;
        }

        try {
            const teachers = await searchTeacherByName(argument);
            if (teachers.length === 0) {
                await sendMessage(
                    chatId,
                    formatWarningMessage(
                        "KHÔNG TÌM THẤY GIẢNG VIÊN",
                        "> Không tìm thấy giảng viên phù hợp với tên bạn nhập."
                    )
                );
                return;
            }

            const selected = teachers[0];
            const scheduleData = await fetchTeacherSchedule(selected.teacherId);
            scheduleData.teacherName = selected.fullName;
            await sendMessage(chatId, formatTeacherSchedule(scheduleData));
        } catch (error) {
            await sendUserError(chatId, error, "teacher_schedule");
        }
    } else if (command === "phongtrong") {
        const campus = argument || "Cơ sở I";
        const saved = getSubscription(context);
        let scheduleData = null;
        if (saved?.studentId) {
            try {
                scheduleData = await fetchStudentSchedule(saved.studentId);
            } catch (_) { }
        }
        await sendMessage(chatId, findEmptyRooms(campus, scheduleData));
    } else if (command === "ai") {
        const aiCheck = canUseAi(context);
        if (!isOwner(context) && !aiCheck.allowed) {
            await sendMessage(
                chatId,
                formatWarningMessage(
                    "QUYỀN TRUY CẬP AI BỊ HẠN CHẾ",
                    "> Tài khoản hoặc nhóm này hiện không có quyền sử dụng lệnh **/ai**."
                )
            );
            return;
        }

        if (!argument) {
            await sendMessage(
                chatId,
                formatWarningMessage(
                    "SAI CÚ PHÁP LỆNH AI",
                    "> **Cú pháp:** /ai [câu hỏi]\n> **Ví dụ:** /ai Trong 2 tuần tới tớ rảnh những ngày nào?"
                )
            );
            return;
        }

        const saved = getSubscription(context);
        if (!saved?.studentId) {
            await sendMessage(chatId, formatMissingStudentIdMessage("ai"));
            return;
        }

        try {
            const scheduleData = await fetchStudentSchedule(saved.studentId);
            await sendMessage(chatId, "# {green}[TRỢ LÝ LỊCH HỌC]{/green}\n\n_Đang phân tích lịch học..._");
            const answerText = await askScheduleAi(argument, scheduleData);
            await sendMessage(chatId, `# {green}[TRỢ LÝ LỊCH HỌC] CÂU TRẢ LỜI{/green}\n\n${sanitizeExternalRichText(answerText)}`);
        } catch (error) {
            await sendUserError(chatId, error, "ai_schedule");
        }
    } else if (command === "blockbot") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /blockbot [User ID / Group ID / Tên]"));
            return;
        }
        const result = blockTarget("bot", argument);
        await sendMessage(
            chatId,
            result
                ? `# {orange}[BLOCK BOT] ĐÃ CHẶN THÀNH CÔNG{/orange}\n\n> **Đối tượng:** ${escapeMarkdown(result.targetName)} (${escapeMarkdown(result.targetId)})\n> **Loại:** ${escapeMarkdown(result.targetType)}`
                : formatWarningMessage("KHÔNG THỂ CHẶN", "> Không tìm thấy ID/Tên phù hợp.")
        );
    } else if (command === "unblockbot") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /unblockbot [User ID / Group ID / Tên]"));
            return;
        }
        const result = unblockTarget("bot", argument);
        await sendMessage(
            chatId,
            result
                ? `# {green}[UNBLOCK BOT] ĐÃ BỎ CHẶN{/green}\n\n> **Đối tượng:** ${escapeMarkdown(result.targetName)} (${escapeMarkdown(result.targetId)})`
                : formatWarningMessage("KHÔNG TÌM THẤY", "> Đối tượng không nằm trong danh sách bị chặn.")
        );
    } else if (command === "blockai") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /blockai [User ID / Group ID / Tên]"));
            return;
        }
        const result = blockTarget("ai", argument);
        await sendMessage(
            chatId,
            result
                ? `# {orange}[BLOCK AI] ĐÃ CHẶN QUYỀN AI{/orange}\n\n> **Đối tượng:** ${escapeMarkdown(result.targetName)} (${escapeMarkdown(result.targetId)})`
                : formatWarningMessage("KHÔNG THỂ CHẶN", "> Không tìm thấy ID/Tên phù hợp.")
        );
    } else if (command === "unblockai") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /unblockai [User ID / Group ID / Tên]"));
            return;
        }
        const result = unblockTarget("ai", argument);
        await sendMessage(
            chatId,
            result
                ? `# {green}[UNBLOCK AI] ĐÃ MỞ LẠI QUYỀN AI{/green}\n\n> **Đối tượng:** ${escapeMarkdown(result.targetName)} (${escapeMarkdown(result.targetId)})`
                : formatWarningMessage("KHÔNG TÌM THẤY", "> Đối tượng không nằm trong danh sách chặn AI.")
        );
    } else if (command === "allowbot") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /allowbot [User ID / Group ID / Tên]"));
            return;
        }
        const result = allowTarget("bot", argument);
        await sendMessage(chatId, `# {green}[ALLOW BOT] ĐÃ THÊM VÀO ALLOWLIST{/green}\n\n> **Đối tượng:** ${escapeMarkdown(result.targetName)} (${escapeMarkdown(result.targetId)})`);
    } else if (command === "unallowbot") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /unallowbot [User ID / Group ID / Tên]"));
            return;
        }
        const result = unallowTarget("bot", argument);
        await sendMessage(chatId, `# {orange}[UNALLOW BOT] ĐÃ XÓA KHỎI ALLOWLIST{/orange}\n\n> **Đối tượng:** ${escapeMarkdown(result.targetName)} (${escapeMarkdown(result.targetId)})`);
    } else if (command === "allowai") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /allowai [User ID / Group ID / Tên]"));
            return;
        }
        const result = allowTarget("ai", argument);
        await sendMessage(chatId, `# {green}[ALLOW AI] ĐÃ THÊM VÀO AI ALLOWLIST{/green}\n\n> **Đối tượng:** ${escapeMarkdown(result.targetName)} (${escapeMarkdown(result.targetId)})`);
    } else if (command === "unallowai") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /unallowai [User ID / Group ID / Tên]"));
            return;
        }
        const result = unallowTarget("ai", argument);
        await sendMessage(chatId, `# {orange}[UNALLOW AI] ĐÃ XÓA KHỎI AI ALLOWLIST{/orange}\n\n> **Đối tượng:** ${escapeMarkdown(result.targetName)} (${escapeMarkdown(result.targetId)})`);
    } else if (command === "accessmode") {
        if (!await requireOwner(context)) return;
        const [type, mode] = argument.split(/\s+/);
        if (!type || !mode || !["bot", "ai"].includes(type.toLowerCase()) || !["all", "allowlist"].includes(mode.toLowerCase())) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /accessmode [bot|ai] [all|allowlist]"));
            return;
        }
        setAccessMode(type.toLowerCase(), mode.toLowerCase());
        await sendMessage(chatId, `# {green}[ACCESS MODE] ĐÃ CẬP NHẬT{/green}\n\n> **Chế độ ${type.toUpperCase()}:** ${mode.toUpperCase()}`);
    } else if (command === "accesslist") {
        if (!await requireOwner(context)) return;
        const summary = getAccessSummary();
        const formatSection = (title, items) => {
            if (!items.length) return `> _Trống_`;
            return items.map((i) => `- **${escapeMarkdown(i.targetName || i.targetId)}** (ID: \`${escapeMarkdown(i.targetId)}\` · ${escapeMarkdown(i.targetType || "user")})`).join("\n");
        };

        const msgContent = [
            `# {orange}[ADMIN] DANH SÁCH QUẢN TRỊ TRUY CẬP{/orange}`,
            `> **Bot Mode:** \`${summary.botMode}\`  •  **AI Mode:** \`${summary.aiMode}\``,
            `## {orange}[CHẶN BOT] ${summary.botBlocked.length}{/orange}\n${formatSection("Chặn Bot", summary.botBlocked)}`,
            `## {orange}[CHẶN AI] ${summary.aiBlocked.length}{/orange}\n${formatSection("Chặn AI", summary.aiBlocked)}`,
            `## {green}[ALLOWLIST BOT] ${summary.botAllowlist.length}{/green}\n${formatSection("Allowlist Bot", summary.botAllowlist)}`,
            `## {green}[ALLOWLIST AI] ${summary.aiAllowlist.length}{/green}\n${formatSection("Allowlist AI", summary.aiAllowlist)}`
        ].join("\n\n");

        await sendMessage(chatId, msgContent);
    } else if (command === "quanlychat") {
        if (!await requireOwner(context)) return;
        const content = formatChatDirectoryList(argument);
        if (!content) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /quanlychat [all|active|inactive|disabled|removed|private|group] [trang]"));
            return;
        }
        await sendMessage(chatId, content);
    } else if (command === "chitietchat") {
        if (!await requireOwner(context)) return;
        const targetId = String(argument || "").trim();
        const content = formatChatDetails(getChat(targetId));
        await sendMessage(chatId, content || formatWarningMessage("KHÔNG TÌM THẤY", "> Chat ID chưa có trong sổ quản lý."));
    } else if (["tamdungchat", "batlaichat", "xoachat", "kiemtrachat"].includes(command)) {
        if (!await requireOwner(context)) return;
        const parts = String(argument || "").trim().split(/\s+/).filter(Boolean);
        const targetId = parts.shift();
        if (!targetId) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", `> **Cú pháp:** /${command} [Chat ID]`));
            return;
        }
        if (command === "tamdungchat") {
            const reason = parts.join(" ") || "admin_disabled";
            setChatStatus(targetId, "disabled", String(context.userId), reason);
            await sendMessage(chatId, `# {orange}[CHAT] ĐÃ VÔ HIỆU HÓA{/orange}\n\n> \`${escapeMarkdown(targetId)}\`\n> **Lý do:** ${escapeMarkdown(reason)}`);
        } else if (command === "batlaichat") {
            setChatStatus(targetId, "active", String(context.userId), "admin_reactivated");
            await sendMessage(chatId, `# {green}[CHAT] ĐÃ KÍCH HOẠT{/green}\n\n> \`${escapeMarkdown(targetId)}\``);
        } else if (command === "xoachat") {
            setChatStatus(targetId, "removed", String(context.userId), "admin_removed");
            await sendMessage(chatId, `# {orange}[CHAT] ĐÃ XÓA MỀM{/orange}\n\n> \`${escapeMarkdown(targetId)}\`\n> Dữ liệu lịch sử vẫn được giữ lại.`);
        } else {
            const result = await sendNotification(targetId, "# {orange}[ADMIN TEST]{/orange}\n\nĐang kiểm tra khả năng gửi thông báo tới cuộc trò chuyện này.", { feature: "broadcast", operation: "admin_test", bypassEligibility: true });
            if (result.sent) {
                setChatStatus(targetId, "active", String(context.userId), "admin_test_succeeded");
                await sendMessage(chatId, `# {green}[CHAT] KIỂM TRA THÀNH CÔNG{/green}\n\n> \`${escapeMarkdown(targetId)}\``);
            } else if (result.skipped) {
                await sendMessage(chatId, formatWarningMessage("CHAT ĐANG BỊ KHÓA", "> Hãy dùng /batlaichat trước khi thử lại."));
            } else {
                await sendMessage(chatId, formatWarningMessage("CHAT VẪN KHÔNG GỬI ĐƯỢC", `> ${escapeMarkdown(result.error?.message || "Lỗi không xác định")}`));
            }
        }
    } else if (command === "chatfeature") {
        if (!await requireOwner(context)) return;
        const [targetId, feature, mode] = String(argument || "").trim().split(/\s+/);
        if (!targetId || !feature || !["on", "off", "auto"].includes(String(mode || "").toLowerCase())) {
            await sendMessage(chatId, formatWarningMessage("SAI CÚ PHÁP", "> **Cú pháp:** /chatfeature [Chat ID] [schedule|broadcast] [on|off|auto]"));
            return;
        }
        try {
            setFeatureOverride(targetId, feature.toLowerCase(), mode.toLowerCase() === "auto" ? null : mode.toLowerCase() === "on");
            await sendMessage(chatId, `# {green}[CHAT FEATURE] ĐÃ CẬP NHẬT{/green}\n\n> **Chat:** \`${escapeMarkdown(targetId)}\`\n> **Tính năng:** ${escapeMarkdown(feature)}\n> **Chế độ:** ${escapeMarkdown(mode)}`);
        } catch (error) {
            await sendMessage(chatId, formatWarningMessage("KHÔNG THỂ CẬP NHẬT", `> ${escapeMarkdown(error.message)}`));
        }
    } else if (command === "thongbao") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage(
                "THIẾU NỘI DUNG",
                "> **Cú pháp:** /thongbao [Nội dung thông báo]\n> **Ví dụ:** /thongbao Hệ thống sẽ bảo trì lúc 22:00.\n> Dùng **/update [Nội dung cập nhật]** nếu đây là thông báo cập nhật sản phẩm hoặc bot."
            ));
            return;
        }
        const message = `# {green}[THÔNG BÁO CHUNG]{/green}\n\n${escapeMarkdownMultiline(argument)}`;
        const result = await sendBotAnnouncement(message, { operation: "announcement", logLabel: "thông báo chung" });
        await sendMessage(chatId, formatBroadcastSummary("ĐÃ GỬI THÔNG BÁO CHUNG", result));
    } else if (command === "update") {
        if (!await requireOwner(context)) return;
        if (!argument) {
            await sendMessage(chatId, formatWarningMessage(
                "THIẾU NỘI DUNG",
                "> **Cú pháp:** /update [Nội dung cập nhật]\n> **Ví dụ:** /update Đã bổ sung tuỳ chọn giờ nhận lịch.\n> Dùng **/thongbao [Nội dung thông báo]** cho thông báo chung không phải cập nhật."
            ));
            return;
        }
        const message = `# {green}[THÔNG BÁO CẬP NHẬT]{/green}\n\n${escapeMarkdownMultiline(argument)}`;
        const result = await sendBotAnnouncement(message, { operation: "update", logLabel: "thông báo cập nhật" });
        await sendMessage(chatId, formatBroadcastSummary("ĐÃ GỬI THÔNG BÁO CẬP NHẬT", result));
    } else if (command === "myid") {
        await sendMessage(
            chatId,
            "# {green}[ID] THÔNG TIN TÀI KHOẢN{/green}\n\n" +
            `> **User ID:** ${escapeMarkdown(context.userId)}\n` +
            `> **Chat ID:** ${escapeMarkdown(context.chatId)}`
        );
    } else if (command === "feedback") {
        await handleFeedbackCommand(context, argument, msg);
    } else if (command === "help") {
        await sendMessage(chatId, formatGeneralHelp());
    } else if (command === "helpadmin") {
        if (!await requireOwner(context)) return;
        await sendMessage(chatId, formatAdminHelp());
    } else if (command === "time") {
        const vietnam = getVietnamDateInfo();
        const message = `# {green}[GIỜ VIỆT NAM]{/green}

> **Thời gian:** ${escapeMarkdown(vietnam.formattedDateTime)}
> **Múi giờ:** ${escapeMarkdown(TIME_ZONE)}

Lịch học và thông báo đều dùng múi giờ này.`;
        await sendMessage(chatId, message);
    } else if (command === "test6h") {
        if (!await requireOwner(context)) return;
        await sendMessage(chatId, "# {orange}[ADMIN TEST] GỬI LỊCH 06:00{/orange}\n\nĐang chạy kiểm tra gửi lịch học.");
        await sendDailySchedulesAtSix();
        await sendMessage(chatId, "# {green}✓ ĐÃ HOÀN TẤT KIỂM TRA GỬI LỊCH 06:00{/green}");
    } else {
        const suggestion = suggestCommandCorrection(command);
        await sendMessage(
            chatId,
            formatWarningMessage(
                "LỆNH KHÔNG HỢP LỆ",
                `> Không nhận diện được **/${escapeMarkdown(command)}**.\n> Bạn có thể dùng **${suggestion}** hoặc **/help** để xem danh sách lệnh.`
            )
        );
    }
}

async function sendNotification(chatId, text, options = {}) {
    const configuredThreshold = Number(process.env.CHAT_MAX_CONSECUTIVE_FAILURES || 3);
    const defaultThreshold = Number.isInteger(configuredThreshold) && configuredThreshold > 0 ? configuredThreshold : 3;
    const { feature = "broadcast", operation = feature, maxConsecutiveFailures = defaultThreshold, bypassEligibility = false, priority } = options;
    // Kiểm tra quyền và GHI NHẬN KẾT QUẢ GỬI đều phải chạy trong ngữ cảnh của bot
    // sở hữu chat: sổ chat có phạm vi theo bot, nên ghi nhận bằng ngữ cảnh bot 1 sẽ
    // đánh dấu nhầm lên bản ghi của bot 1 khi chat thuộc bot 2.
    if (!bypassEligibility && !isChatEligible(chatId, feature)) return { skipped: true, reason: "inactive_or_disabled" };
    try {
        await sendMessage(chatId, text, { ...(options.sendOptions || {}), ...(priority === undefined ? {} : { priority }) });
        recordDeliverySuccess(chatId);
        return { sent: true };
    } catch (error) {
        // Lỗi vĩnh viễn (410/422) đã được ghi nhận ngay tại sendMessage, nơi biết
        // rõ phân loại. Ghi thêm ở đây sẽ đếm hai lần cùng một lần gửi.
        if (error?.deliveryRecorded === true) {
            return { failed: true, error, suspended: false };
        }
        const record = recordDeliveryFailure(chatId, error, { feature, operation, maxConsecutiveFailures });
        return { failed: true, error, suspended: record?.status === "inactive" };
    }
}

function positiveDuration(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const classStartReminderService = createClassStartReminderService({
    fetchSchedule: fetchStudentSchedule,
    getSubscriptions: getClassStartNotificationSubscriptions,
    // Quyền truy cập và việc gửi đều phải chạy trong ngữ cảnh của bot sở hữu
    // đăng ký, nếu không nhắc giờ học của bot 2 sẽ bị gửi bằng bot 1.
    isEligible: (subscription) => isSubscriptionEligible(subscription),
    sendReminder: (subscription, message) => sendToSubscription(subscription, message, {
        feature: "schedule",
        operation: "class_start_reminder"
    }),
    onError: ({ stage, error }) => logDiscord("ERROR", `class_start_${stage}_error: ${error.message}`),
    flushPersistence: flushPersistenceWrites,
    gracePeriodMs: positiveDuration(process.env.CLASS_START_GRACE_MS, DEFAULT_GRACE_PERIOD_MS),
    cacheTtlMs: positiveDuration(process.env.CLASS_START_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS)
});

async function sendClassStartNotifications(date = new Date()) {
    const result = await classStartReminderService.run(date);
    if (result.sent > 0) {
        console.log(`[NHẮC GIỜ] Đã gửi ${result.sent} thông báo bắt đầu buổi học.`);
    }
    if (result.failed > 0) {
        logDiscord("ERROR", `class_start_reminder_failed: ${result.failed} delivery or schedule check(s)`);
    }
    return result;
}

function groupSubscriptionsByStudent(subscriptions, notificationTime = null) {
    const grouped = new Map();
    for (const subscription of subscriptions) {
        const notificationTimes = normalizeNotificationTimes(subscription);
        if (notificationTime && !notificationTimes.some((item) => item.time === notificationTime)) continue;
        const targets = grouped.get(subscription.studentId) || new Map();
        // Một MSSV chỉ gửi một lần vào cùng một chat, dù nhiều thành viên cùng đăng ký.
        targets.set(subscription.chatId, subscription);
        grouped.set(subscription.studentId, targets);
    }
    return grouped;
}

function groupEnabledSubscriptionsByStudent(notificationTime = null) {
    return groupSubscriptionsByStudent(
        Object.values(getEnabledSubscriptions()).filter((subscription) => isChatEligible(subscription.chatId, "schedule")),
        notificationTime
    );
}

// Nhóm theo MSSV -> ngày đích -> chat. Mỗi mốc giờ tự chọn lịch hôm nay hay hôm
// sau, nên hai người nhận cùng một mốc giờ có thể cần hai ngày đích khác nhau;
// không được dùng chung một ngày cho cả lượt gửi.
// Bot sở hữu một đăng ký. Bản ghi cũ không có botId thuộc về bot 1.
function subscriptionBotId(subscription) {
    return normalizeBotId(subscription?.botId) || LEGACY_BOT_ID;
}

// Chạy một thao tác trong ngữ cảnh của bot SỞ HỮU đăng ký: kiểm tra quyền chat,
// hạn mức và client gửi đều phải là của chính bot đó. Không bao giờ chọn token
// ngẫu nhiên, và không bao giờ thử lại bằng một bot khác.
function withSubscriptionBot(subscription, fn) {
    const ownerId = subscriptionBotId(subscription);
    const owner = getBot(ownerId);
    if (!owner) {
        return Promise.reject(new Error(`Không có bot ${ownerId} đang bật để gửi cho chat ${subscription?.chatId}`));
    }
    return Promise.resolve(runWithBot(owner, fn));
}

function sendToSubscription(subscription, text, options) {
    return withSubscriptionBot(subscription, () => sendNotification(subscription.chatId, text, options));
}

// Kiểm tra quyền truy cập chat trong ngữ cảnh của bot sở hữu đăng ký. ĐỒNG BỘ —
// classStartNotifications gọi isEligible trong một vòng lặp đồng bộ, nên trả về
// Promise ở đây sẽ khiến mọi đăng ký đều được coi là hợp lệ.
function isSubscriptionEligible(subscription) {
    const owner = getBot(subscriptionBotId(subscription));
    if (!owner) return false;
    return runWithBot(owner, () => isChatEligible(subscription.chatId, "schedule"));
}

function groupEnabledSubscriptionsByTargetDay(notificationTime = null) {
    const grouped = new Map();
    const subscriptions = Object.values(getEnabledSubscriptions())
        // Quyền truy cập chat phải được kiểm tra trong ngữ cảnh của bot sở hữu
        // đăng ký, nếu không bot 2 sẽ bị đánh giá bằng sổ chat của bot 1.
        .filter((subscription) => isSubscriptionEligible(subscription));

    for (const subscription of subscriptions) {
        const offsets = new Set();
        for (const item of normalizeNotificationTimes(subscription)) {
            if (notificationTime && item.time !== notificationTime) continue;
            offsets.add(item.targetDayOffset);
        }
        if (offsets.size === 0) continue;

        const ownerId = subscriptionBotId(subscription);
        const byOffset = grouped.get(subscription.studentId) || new Map();
        for (const offset of offsets) {
            const targets = byOffset.get(offset) || new Map();
            // Một MSSV chỉ gửi một lần cho mỗi cặp (bot, chat) ở mỗi ngày đích.
            // Khóa phải gồm botId: cùng một Chat ID ở bot 1 và bot 2 là hai cuộc
            // trò chuyện khác nhau, gộp chúng lại sẽ làm mất một người nhận.
            targets.set(`${ownerId}::${subscription.chatId}`, subscription);
            byOffset.set(offset, targets);
        }
        grouped.set(subscription.studentId, byOffset);
    }
    return grouped;
}

let isCheckRunning = false;
const runningDailyNotificationTimes = new Set();

// Tự động kiểm tra và thông báo NGAY LẬP TỨC khi phát hiện lịch có thay đổi (chạy mỗi 15 phút)
async function checkAndNotifyScheduleChanges() {
    if (isCheckRunning) return;
    isCheckRunning = true;
    try {
        for (const [studentId, targetMap] of groupEnabledSubscriptionsByStudent().entries()) {
            try {
                const data = await fetchStudentSchedule(studentId);
                const result = confirmScheduleChange(data);

                if (result.confirmed) {
                    const changeMessage = formatScheduleChangeMessage(data, result.changes);
                    for (const subscription of targetMap.values()) {
                        const delivery = await sendToSubscription(subscription, changeMessage, { feature: "schedule", operation: "schedule_change" });
                        if (delivery.failed) logDiscord("ERROR", `Không thể gửi cảnh báo thay đổi cho chat ${subscription.chatId}: ${delivery.error.message}`);
                    }
                }
            } catch (error) {
                logDiscord("ERROR", `Không thể kiểm tra thay đổi lịch cho MSSV ${studentId}: ${error.message}`);
            }
        }
    } finally {
        isCheckRunning = false;
    }
}

// Gửi lịch học cho các đăng ký có cùng giờ thông báo. Ngày đích được tính
// riêng cho TỪNG người nhận: thời điểm gửi thực tế theo giờ Việt Nam cộng với
// lựa chọn hôm nay / hôm sau của chính mốc giờ đó.
async function sendDailySchedulesAtTime(notificationTime = DEFAULT_NOTIFICATION_TIME, deliveryAt = new Date()) {
    const subscriptionsGrouped = groupEnabledSubscriptionsByTargetDay(notificationTime);
    if (subscriptionsGrouped.size === 0) {
        return { processed: false, matchedStudents: 0, sent: 0, failed: 0 };
    }
    if (runningDailyNotificationTimes.has(notificationTime)) {
        return { processed: false, matchedStudents: subscriptionsGrouped.size, sent: 0, failed: 0 };
    }

    runningDailyNotificationTimes.add(notificationTime);
    const deliveryInfo = getVietnamDateInfo(deliveryAt);
    const dispatchResult = {
        processed: true,
        matchedStudents: subscriptionsGrouped.size,
        sent: 0,
        failed: 0
    };
    console.log(`⏰ Bắt đầu tiến trình gửi lịch học ${notificationTime} hàng ngày...`);
    logDiscord("INFO", `Bắt đầu tiến trình gửi lịch học ${notificationTime} hàng ngày...`);
    try {
        console.log(`[${notificationTime}] Tìm thấy ${subscriptionsGrouped.size} MSSV có đăng ký nhận thông báo.`);

        for (const [studentId, byOffset] of subscriptionsGrouped.entries()) {
            const offsets = [...byOffset.keys()].sort((left, right) => left - right);
            // Cảnh báo thay đổi lịch chỉ kiểm tra MỘT LẦN cho mỗi MSSV trong mỗi
            // lượt, đúng như trước đây, để luồng độc lập này không bị đổi hành vi.
            let changeChecked = false;

            for (const targetDayOffset of offsets) {
                const targetDateKey = addCalendarDays(deliveryInfo.dateKey, targetDayOffset);
                const targetDate = dateFromVietnamDateKey(targetDateKey);
                const targets = byOffset.get(targetDayOffset);

                try {
                    const data = await fetchStudentSchedule(studentId, targetDate);

                    // 1. Kiểm tra thay đổi lịch trước khi gửi (nếu có)
                    if (!changeChecked) {
                        changeChecked = true;
                        try {
                            const result = confirmScheduleChange(data);
                            if (result.confirmed) {
                                const changeMessage = formatScheduleChangeMessage(data, result.changes);
                                // Nếu lần kiểm tra này xác nhận thay đổi, thông báo tới mọi đăng ký
                                // của MSSV, không chỉ nhóm đang nhận lịch ở đúng mốc giờ hiện tại.
                                const allStudentTargets = groupEnabledSubscriptionsByStudent().get(studentId) || targets;
                                for (const subscription of allStudentTargets.values()) {
                                    const delivery = await sendToSubscription(subscription, changeMessage, { feature: "schedule", operation: "schedule_change" });
                                    if (delivery.failed) logDiscord("ERROR", `Không thể gửi cảnh báo thay đổi cho chat ${subscription.chatId}: ${delivery.error.message}`);
                                }
                            }
                        } catch (changeError) {
                            console.error(`Lỗi kiểm tra thay đổi cho MSSV ${studentId}:`, changeError.message);
                        }
                    }

                    // 2. Gửi lịch của đúng ngày đích mà người nhận đã chọn
                    const dailyMessage = formatDailySchedule(data, targetDate, { referenceDate: deliveryAt });
                    for (const subscription of targets.values()) {
                        const delivery = await sendToSubscription(subscription, dailyMessage, { feature: "schedule", operation: "daily_schedule" });
                        if (delivery.sent) {
                            dispatchResult.sent += 1;
                            console.log(`[${notificationTime}] Đã gửi lịch ${targetDateKey} cho MSSV ${studentId} tới chat ${subscription.chatId}`);
                        } else if (delivery.failed) {
                            dispatchResult.failed += 1;
                            logDiscord("ERROR", `Không thể gửi lịch ${notificationTime} cho chat ${subscription.chatId}: ${delivery.error.message}`);
                        }
                    }
                } catch (error) {
                    dispatchResult.failed += targets.size;
                    logDiscord("ERROR", `Không thể gửi lịch ${notificationTime} cho MSSV ${studentId} (${targetDateKey}): ${error.message}`);
                }
            }
        }
        return dispatchResult;
    } finally {
        runningDailyNotificationTimes.delete(notificationTime);
        console.log(`⏰ Hoàn tất tiến trình gửi lịch học ${notificationTime}.`);
    }
}

async function sendDailySchedulesAtSix() {
    return sendDailySchedulesAtTime("06:00");
}

async function sendScheduledDailySchedules(date = new Date()) {
    const dateInfo = getVietnamDateInfo(date);
    const notificationTime = `${dateInfo.hour}:${dateInfo.minute}`;
    return sendDailySchedulesAtTime(notificationTime, date);
}

function registerRuntimeJobs(scheduler = schedule) {
    if (scheduler && typeof scheduler === "object") {
        if (registeredSchedulers.has(scheduler)) return [];
        registeredSchedulers.add(scheduler);
    }
    const jobs = [];
    jobs.push(scheduler.scheduleJob({ rule: "*/15 * * * *", tz: TIME_ZONE }, asyncCommand(async () => {
        await checkAndNotifyScheduleChanges();
        await flushPersistenceWrites();
    })));
    jobs.push(scheduler.scheduleJob({ rule: "* * * * *", tz: TIME_ZONE }, asyncCommand(async () => {
        const dailyResult = await sendScheduledDailySchedules();
        const classStartResult = await sendClassStartNotifications();
        if (dailyResult.processed || classStartResult.processed) await flushPersistenceWrites();
    })));
    return jobs;
}

// Hủy các job đã đăng ký với node-schedule (job.cancel là API chính thức).
function cancelSchedulerJobs() {
    const jobs = runtimeSchedulerJobs;
    runtimeSchedulerJobs = [];
    for (const job of jobs) {
        try {
            if (job && typeof job.cancel === "function") job.cancel();
        } catch (error) {
            console.warn(`[Runtime] Không hủy được job scheduler: ${error.message}`);
        }
    }
    return jobs.length;
}

// node-zalo-bot không có stopPolling công khai; instance Polling nội bộ có stop().
// Chỉ gọi khi thư viện thực sự cung cấp, không tự phát minh API.
// Hủy yêu cầu long-poll đang chờ để không phải đợi hết timeout của Zalo.
// Dừng MỘT nhà cung cấp. Mỗi nhà cung cấp tự biết cách dừng; nếu nó không cung
// cấp stop() thì thử cách cũ của node-zalo-bot.
function stopOneBotPolling(runtime) {
    // Nhà cung cấp tự biết cách dừng. Với bot chính thức, officialProvider.stop()
    // gọi polling.stop() KHÔNG tham số — truyền { cancel, reason } làm nó ném
    // "... is not a function" (đã kiểm chứng trên node-zalo-bot 0.1.6).
    if (runtime && typeof runtime.stop === "function") return Promise.resolve(runtime.stop());
    const polling = runtime?.client?._polling;
    if (polling && typeof polling.stop === "function") return Promise.resolve(polling.stop());
    return Promise.resolve();
}

// Dừng polling của MỌI bot. Một bot lỗi không được ngăn các bot còn lại dừng sạch.
async function stopZaloPolling() {
    shuttingDown = true;
    const results = await Promise.allSettled(listBots().map((runtime) => stopOneBotPolling(runtime)));
    for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
            console.warn(`[Runtime] ${listBots()[index]?.botId || "?"}: dừng polling thất bại - ${result.reason?.message || result.reason}`);
        }
    }
    return results.length;
}

function closeDashboardServer() {
    const server = adminRuntime && adminRuntime.server;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
    });
}

function registerShutdownHandlers() {
    shutdownController ||= createShutdownController({
        timeoutMs: positiveDuration(process.env.SHUTDOWN_TIMEOUT_MS, DEFAULT_SHUTDOWN_TIMEOUT_MS),
        log: (message) => console.log(message),
        stopScheduler: () => { cancelSchedulerJobs(); },
        // Dừng nhận việc gửi mới rồi chờ các tin đang gửi dở kết thúc.
        stopOutboundQueues: () => providerQueues.stopAll(),
        stopPolling: () => stopZaloPolling(),
        closeDashboard: () => closeDashboardServer(),
        flushPersistence: () => flushPersistenceWrites(),
        stopMetrics: () => { metrics.stop(); }
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, () => { shutdownController.run(signal); });
    }
    return shutdownController;
}

async function startRuntime() {
    let firebaseTarget;
    metrics.start();
    try {
        // Bước 1: nạp cấu hình Firebase + hydrate state Firestore vào bộ nhớ.
        firebaseTarget = await initializeFirestorePersistence({
            storeIds: [
                "accessControl",
                "adminAudit",
                "adminLogs",
                "adminSettings",
                "chatDirectory",
                "interactions",
                "classStartNotifications",
                "scheduleSnapshots",
                "subscriptions"
            ]
        });
    } catch (error) {
        console.error(`[Firebase] Không thể khởi tạo Firestore: ${error.message}`);
        console.error("[Runtime] Dừng khởi động: scheduler và Zalo polling không được bật.");
        throw error;
    }

    console.log(`[Firebase] Project: ${firebaseTarget.projectId}`);
    console.log(`[Firebase] Database: ${firebaseTarget.databaseId}`);
    console.log(`[Firebase] Collection: ${firebaseTarget.collectionName}`);
    console.log(`[Persistence] State loaded (${firebaseTarget.storeIds.length} store)`);
    console.log(`[Runtime] Timezone: ${TIME_ZONE}`);
    metrics.mark("Firebase hydrate");
    metrics.logMemory("sau hydrate");

    // Bước 2: đồng bộ lại state phái sinh từ dữ liệu cũ trước khi chạy runtime.
    const reconciledChats = syncChatDirectoryFromLegacyStores();
    metrics.mark(`Chat reconciliation (${reconciledChats} thay đổi)`);
    if (reconciledChats > 0) await flushPersistenceWrites();
    metrics.mark("Persistence flush");

    // Bước 3: dashboard.
    adminRuntime = createAdminServer({
        executeCommand: async ({ command, userId, chatId, displayName, executor, target, botId }) => {
            const parsed = parseCommand(command);
            if (!parsed) throw new Error("Lệnh phải bắt đầu bằng /");

            // Danh tính admin đang đăng nhập — nguồn duy nhất cho kiểm tra quyền.
            const actor = {
                userId: String(executor?.userId || userId),
                chatId: String(chatId),
                username: executor?.username || null
            };
            if (!isOwner(actor)) throw new Error("Admin context chưa được cấp quyền");

            // Bot gửi: người nhận thuộc bot nào thì lệnh chạy trong ngữ cảnh bot đó.
            // Chat ID / User ID chỉ có nghĩa trong phạm vi một bot, nên bot phải
            // được chọn tường minh thay vì mặc định về bot 1.
            const requestedBotId = normalizeBotId(target?.botId) || normalizeBotId(botId) || LEGACY_BOT_ID;
            const ownerBot = getBot(requestedBotId);
            if (!ownerBot) throw new Error(`Bot ${requestedBotId} đang tắt nên không thể gửi`);

            // Ngữ cảnh dữ liệu: người được chọn làm đích nếu có, nếu không thì
            // chính admin. Lệnh chạy cho người nhận nên trạng thái theo người và
            // phần trả lời đều thuộc về người đó.
            const targetUserId = target?.userId ? String(target.userId) : "";
            const targetChatId = target?.chatId ? String(target.chatId) : "";
            const context = {
                botId: requestedBotId,
                userId: targetUserId || actor.userId,
                chatId: targetChatId || actor.chatId,
                userDisplayName: target?.displayName
                    || String(executor?.displayName || displayName || executor?.username || "Dashboard Admin")
            };

            const capture = { chatId: context.chatId, messages: [], actor, botId: requestedBotId };
            await runWithBot(ownerBot, () => dashboardCommandContext.run(capture, () => handleCommand({ text: command, chat: { id: context.chatId, type: "private" }, from: { id: context.userId, display_name: context.userDisplayName } }, parsed)));

            // `deliveredToChatId` là bằng chứng phần trả lời đã được gửi thật tới
            // chat nào — khác với việc chỉ phân tích được câu lệnh.
            return {
                command,
                deliveredToChatId: context.chatId,
                messages: capture.messages,
                messageCount: capture.messages.length,
                executor: executor || { userId: actor.userId, displayName: context.userDisplayName },
                target: target || null,
                targetUserId: context.userId,
                targeted: Boolean(targetUserId || targetChatId)
            };
        },
        retryChat: async (chatId) => sendNotification(
            chatId,
            "# {orange}[ADMIN TEST]{/orange}\n\nĐang kiểm tra khả năng gửi thông báo tới cuộc trò chuyện này.",
            { feature: "broadcast", operation: "admin_dashboard_retry", bypassEligibility: true }
        ),

        // Đăng nhập QR cho tài khoản Zalo cá nhân, chỉ qua API đã xác thực admin.
        getZcaQr: () => (zcaProvider.enabled ? zcaProvider.getQr() : null),

        // Bắt đầu đăng nhập QR rồi trả về NGAY. loginQR() chỉ kết thúc khi người
        // dùng quét xong, nên chờ nó sẽ treo request của dashboard.
        beginZcaLogin: async () => {
            if (!zcaProvider.enabled) {
                return { ok: false, error: "ZCA đang tắt. Đặt ZCA_ENABLED=true rồi khởi động lại." };
            }
            if (zcaProvider.getStatus().authenticated) {
                return { ok: true, already: true, status: zcaProvider.getStatus() };
            }
            // Không await: chạy nền, dashboard hỏi /qr để lấy ảnh.
            zcaProvider.beginQrLogin().catch((error) => {
                console.error(`[ZCA] đăng nhập QR thất bại: ${error.message}`);
            });
            return { ok: true, started: true };
        },

        clearZcaSession: async () => {
            if (!zcaProvider.enabled) return { ok: false, error: "ZCA đang tắt." };
            await zcaProvider.stop();
            const cleared = zcaProvider.clearSession();
            return { ok: cleared, cleared };
        },

        // Đã tách thành hàm riêng để kiểm thử trực tiếp đường gửi.
        replyToFeedback: (input) => deliverFeedbackReply(input)
    });
    await new Promise((resolve, reject) => {
        adminRuntime.server.once("error", reject);
        adminRuntime.server.listen(adminRuntime.port, "127.0.0.1", resolve);
    });
    console.log(`[Dashboard] Listening on http://127.0.0.1:${adminRuntime.port}${adminRuntime.basePath}`);
    metrics.mark("Dashboard");
    metrics.logMemory("sau dashboard");

    // Bước 4: chỉ bật scheduler sau khi state Firestore đã được hydrate vào bộ nhớ.
    runtimeSchedulerJobs = registerRuntimeJobs() || [];
    registerShutdownHandlers();
    console.log(`[Runtime] Scheduler started (${TIME_ZONE})`);
    metrics.mark("Scheduler");

    // Bước 4b: tra tên hiển thị của từng bot — KHÔNG chặn khởi động.
    //
    // Tên bot chỉ để hiển thị trên dashboard. Trước đây bước này được await ngay
    // trước khi khởi động nhà cung cấp, nên mỗi lần tra tên chậm (mạng, Zalo) đều
    // cộng thẳng vào thời gian khởi động. Nay chạy nền; xong lúc nào cập nhật lúc đó.
    const nameResolution = resolveBotNames()
        .then(() => metrics.mark("Bot name resolution"))
        .catch((error) => console.warn(`[Runtime] tra tên bot thất bại (không ảnh hưởng khởi động): ${error.message}`));

    // Bước 5: khởi động MỌI nhà cung cấp SONG SONG.
    //
    // Các nhà cung cấp độc lập với nhau: bot1 không cần bot2 khởi động xong, và ZCA
    // không cần bot chính thức. Chạy tuần tự khiến tổng thời gian bằng TỔNG độ trễ
    // của từng nhà cung cấp (3 bot × ~10s = ~30s) thay vì bằng độ trễ LỚN NHẤT.
    //
    // Ranh giới lỗi nằm ở đây: một nhà cung cấp hỏng không được ngăn những nhà
    // cung cấp khác chạy. Mỗi lời hứa tự xử lý lỗi của mình nên không lời hứa nào
    // bị từ chối và không nhà cung cấp nào bị khởi động hai lần.
    const started = [];
    const failed = [];
    const providerStartups = listEnabledBots().map(async (runtime) => {
        const providerStart = Date.now();
        try {
            await runtime.start();
            const elapsed = Date.now() - providerStart;
            started.push(runtime.botId);
            metrics.mark(`${runtime.botId} start`);
            console.log(`[Runtime] ${runtime.botId}: đã khởi động (${runtime.providerType || "official"}) sau ${elapsed}ms`);
        } catch (error) {
            failed.push({ botId: runtime.botId, message: error.message });
            runtime.status = "polling_failed";
            runtime.lastError = error.message;
            runtime.lastErrorAt = new Date().toISOString();
            console.error(`[Runtime] ${runtime.botId}: không khởi động được - ${error.message}`);
            logDiscord("ERROR", `provider_start_failed[${runtime.botId}]: ${error.message}`);
        }
    });
    await Promise.allSettled(providerStartups);

    // Chỉ coi là lỗi chí mạng khi KHÔNG nhà cung cấp CHÍNH THỨC nào lên được:
    // đó mới là hệ thống hỏng. ZCA hỏng một mình là trạng thái bình thường và
    // được báo cáo trên dashboard.
    const startedOfficial = started.filter((botId) => !botId.startsWith("zca:"));
    if (startedOfficial.length === 0) {
        throw new Error(`Không bot chính thức nào khởi động được: ${failed.map((item) => `${item.botId} (${item.message})`).join("; ")}`);
    }

    logDiscord("INFO", `Đã khởi động - timezone ${TIME_ZONE} - providers: ${started.join(", ")}`);
    await flushPersistenceWrites();
    metrics.mark("Persistence flush");

    // Đợi tra tên bot hoàn tất trước khi in tổng kết, nhưng chỉ để báo cáo: nó
    // không chặn bất cứ thứ gì ở trên.
    await nameResolution;
    console.log(metrics.summary().text);
    metrics.logMemory("sẵn sàng");
}

async function handleIncomingMessage(runtime, msg) {
    // Sau khi bắt đầu tắt máy thì không xử lý tin mới: tránh bắt đầu một đợt gửi
    // hoặc một lệnh quản trị trong lúc tiến trình đang dừng.
    if (shuttingDown) return;
    const text = msg.text || "[không có nội dung]";
    // Chat ID / User ID chỉ có nghĩa trong phạm vi một bot, nên botId đi kèm ngữ cảnh.
    const context = getMessageContext(msg, { botId: runtime.botId });
    const from = msg.from?.display_name || context.userId || "unknown";
    const botId = context.botId || getCurrentBotId();
    console.log("Tin nhắn mới:", from, "→", text);

    // CỔNG TIẾP NHẬN.
    //
    // Sự kiện vào chỉ là ỨNG VIÊN. Trước đây recordInteraction() + upsertChat()
    // chạy ngay tại đây — trước khi kiểm tra quyền và trước khi bất kỳ câu trả lời
    // nào gửi được — nên một chat mà bot không thể trả lời vẫn để lại dấu vết và
    // vẫn được coi là người nhận hợp lệ cho các đợt /thongbao sau.
    //
    // Nay: ta chỉ ghi nhận ứng viên trong bộ nhớ (TTL ngắn, khóa theo bot+chat).
    // Không ghi gì bền vững ở đây.
    const admission = admissionRegistry.markIncoming(botId, context.chatId);
    const alreadyAdmitted = admission.alreadyAdmitted;

    // Ghi sổ tương tác + sổ chat. CHỈ chạy khi chat đã được tiếp nhận (trực tiếp
    // hoặc qua lần gửi thành công vừa xảy ra trong sự kiện này).
    const persistChatFacts = () => {
        const interaction = recordInteraction(context, msg);
        upsertChat({
            restoreDeleted: true,
            chatId: context.chatId,
            chatType: interaction.chatType,
            displayName: interaction.chatTitle || context.userDisplayName,
            userId: interaction.lastUserId,
            chatTitle: interaction.chatTitle,
            firstInteractionAt: interaction.firstInteractionAt,
            lastInboundInteractionAt: interaction.lastInteractionAt
        });
        return interaction;
    };

    // Thông tin hiển thị chỉ để ghi log — không cần ghi store cho việc này.
    const logInteraction = {
        chatType: detectChatType(msg),
        chatTitle: String(msg.chat?.title || msg.chat?.name || ""),
        lastUserId: context.userId
    };
    let interaction = alreadyAdmitted ? persistChatFacts() : logInteraction;

    logDiscord("INFO", `Tin nhắn từ: ${from}\n> User ID: ${context.userId}\n> Chat ID: ${context.chatId}\n> Chat Title: ${interaction.chatTitle || "Private"}\n> Chat Type: ${interaction.chatType}\n> Nội dung: ${text}`);

    // Xử lý MỘT lần tiếp nhận thành công. Chạy đúng một lần cho dù có nhiều lần
    // gửi thành công trong cùng sự kiện (ví dụ lời chào + phản hồi lệnh).
    let admittedThisEvent = alreadyAdmitted;
    const onAdmitted = () => {
        if (admittedThisEvent) return;
        admittedThisEvent = true;
        // Xác nhận gửi thành công ⇒ bằng chứng thật sự bot liên lạc được.
        admissionRegistry.admit(botId, context.chatId);
        try {
            persistChatFacts();
            markChatAdmitted(context.chatId);
        } catch (error) {
            console.error(`[Admission] ghi sổ chat thất bại: ${error.message}`);
        }
        // Chạy nốt các thao tác ghi đã hoãn (MSSV, đăng ký…).
        flushDeferredWrites(botId, context.chatId).catch((error) => {
            console.error(`[Admission] chạy thao tác hoãn thất bại: ${error.message}`);
        });
    };

    const onDefiniteRejection = (failure) => {
        // Từ chối dứt khoát: KHÔNG ghi dữ liệu người dùng, bỏ thao tác hoãn.
        admissionRegistry.reject(botId, context.chatId, failure.reason);
        discardDeferredWrites(botId, context.chatId);
        // Nếu chat đã từng được tiếp nhận (người dùng cũ bị chặn bot), đánh dấu
        // unreachable để loại khỏi phát tin — nhưng GIỮ NGUYÊN MSSV/đăng ký.
        if (alreadyAdmitted) {
            try {
                markChatUnreachable(context.chatId, failure.reason);
            } catch (error) {
                console.error(`[Admission] không đánh dấu được unreachable: ${error.message}`);
            }
        }
        console.warn(`[Admission] ${botId}/${context.chatId}: từ chối (${failure.reason}) — không ghi dữ liệu.`);
    };

    const onUncertain = (error) => {
        // Kết quả KHÔNG CHẮC CHẮN (timeout/429/5xx/422 mơ hồ): không tiếp nhận lần
        // này, nhưng KHÔNG đánh dấu hỏng vĩnh viễn — giữ thao tác hoãn cho lần sau.
        const kind = error?.deliveryClassification?.kind || "unknown";
        console.warn(`[Admission] ${botId}/${context.chatId}: chưa xác nhận được (${kind}) — sẽ thử lại sau.`);
    };

    // Chạy toàn bộ phần xử lý trong ngữ cảnh cổng tiếp nhận. Mọi sendMessage() cho
    // ĐÚNG chat này — dù gọi từ handleCommand hay từ nhánh chào mừng — đều tự cập
    // nhật cổng tiếp nhận. Đây là thứ khiến lệnh đầu tiên của người lạ cũng được
    // kiểm soát mà không phải sửa từng lối gọi.
    await inboundAdmissionContext.run(
        { botId, chatId: context.chatId, onAdmitted, onDefiniteRejection, onUncertain },
        async () => {
            // Kiểm tra quyền sử dụng BOT (Owner luôn được phép)
            if (!isOwner(context)) {
                const botCheck = canUseBot(context);
                if (!botCheck.allowed) {
                    // Gửi lời từ chối. Nếu gửi được (hiếm) thì chat vẫn được tiếp
                    // nhận; nếu bị chặn thì không ghi gì. Không ném lỗi ra ngoài —
                    // handler tin nhắn không được làm chết vòng lặp polling.
                    try {
                        await sendMessage(
                            context.chatId,
                            formatWarningMessage(
                                "KHÔNG CÓ QUYỀN TRUY CẬP",
                                "> Tài khoản hoặc nhóm này hiện không có quyền sử dụng trợ lý."
                            )
                        );
                    } catch (error) {
                        logDiscord("ERROR", `access_denied_reply_failed: ${error.message}`);
                    }
                    await flushPersistenceWrites();
                    return;
                }
            }

            const parsed = parseCommand(msg.text);
            const looksLikeCommand = String(msg.text || "").trim().startsWith("/");

            // Chào mừng khi chat chưa được tiếp nhận VÀ tin không phải lệnh.
            //
            // Đây là "bằng chứng" rẻ nhất: lời chào cũng là một câu trả lời thật,
            // nên khi nó gửi được thì chat được tiếp nhận luôn — không cần tin "probe".
            if (!parsed && !looksLikeCommand && !alreadyAdmitted) {
                try {
                    await sendWelcomeMessage(context.chatId, msg.from?.display_name);
                } catch (error) {
                    logDiscord("ERROR", `welcome_message_failed: ${error.message}`);
                }
            }

            if (parsed) {
                // Lệnh có thể ném lỗi gửi (410/422/tạm thời). handler tin nhắn không
                // được để lỗi làm chết vòng lặp polling — nuốt tại đây, cổng tiếp
                // nhận đã ghi nhận kết quả qua notifyAdmissionFailure().
                try {
                    await handleCommand(msg, parsed);
                } catch (error) {
                    logDiscord("ERROR", `command_failed: ${error.message}`);
                }
            } else if (looksLikeCommand) {
                try {
                    await sendMessage(
                        context.chatId,
                        formatWarningMessage(
                            "LỆNH KHÔNG HỢP LỆ",
                            "> Không thể phân tích lệnh này.\n> Dùng **/help** để xem cú pháp và danh sách lệnh."
                        )
                    );
                } catch (error) {
                    logDiscord("ERROR", `invalid_command_reply_failed: ${error.message}`);
                }
            }
        }
    );
    await flushPersistenceWrites();
}

// Đăng ký handler cho MỘT nhà cung cấp chính thức. Mọi handler chạy trong ngữ
// cảnh của chính nhà cung cấp đó, nên phản hồi luôn đi ra bằng đúng danh tính đã
// nhận tin nhắn.
//
// Nhà cung cấp không phải chính thức (ZCA) tự gắn listener của nó bên trong
// provider và gọi lại qua `onMessage`, nên không đi qua đường này.
function registerBotHandlers(runtime) {
    if (!runtime?.client || typeof runtime.client.on !== "function") return runtime;
    const label = runtime.botId;
    runtime.client.on("message", bindBot(runtime, asyncCommand((msg) => handleIncomingMessage(runtime, msg))));

    runtime.client.on("polling_error", (error) => {
        // Lỗi phát sinh do chủ động hủy long-poll lúc dừng bot không phải sự cố.
        if (shuttingDown) return;
        if (error.code === "EZALO" && error.message?.includes("408")) return;
        runtime.lastError = error.message;
        runtime.lastErrorAt = new Date().toISOString();
        console.error(`[${label}] Lỗi polling:`, error);
        logDiscord("ERROR", `polling_error[${label}]: ${error.message}`);
    });

    runtime.client.on("error", (error) => {
        runtime.lastError = error.message;
        runtime.lastErrorAt = new Date().toISOString();
        console.error(`[${label}] Lỗi bot:`, error);
        logDiscord("ERROR", `error[${label}]: ${error.message}`);
    });

    return runtime;
}

for (const runtime of listBots()) registerBotHandlers(runtime);

/* -------------------------------------------------------------------------- */
/* Hỗ trợ / góp ý                                                             */
/* -------------------------------------------------------------------------- */

// Mã tin nhắn nguồn, dùng để chống trùng khi Zalo gửi lại cùng một update.
//
// Mỗi nhà cung cấp đặt mã ở chỗ khác nhau: ZCA để trong `meta.msgId`, Zalo Bot
// Platform để trong trường của update. Trả null nếu không có — khi đó yêu cầu vẫn
// được lưu, chỉ là không chống trùng được.
// Danh tính quản trị viên để gửi thông báo về yêu cầu mới.
//
// adminSettings không lưu botId (dữ liệu cũ), nên mặc định là bot 1 — bot sở hữu
// không gian khóa cũ và là nơi quản trị viên đăng ký từ trước tới nay.
function getAdminIdentities() {
    const settings = getAdminSettings();
    const identities = [];
    for (const admin of settings.admins || []) {
        if (admin.enabled === false) continue;
        const chatId = String(admin.chatId || "").trim();
        if (!chatId) continue;
        identities.push({ botId: normalizeBotId(admin.botId) || LEGACY_BOT_ID, chatId });
    }
    for (const chatId of getConfiguredAdminIds().chatIds) {
        const normalized = String(chatId || "").trim();
        if (normalized) identities.push({ botId: LEGACY_BOT_ID, chatId: normalized });
    }
    // Bỏ trùng theo (botId, chatId).
    const seen = new Set();
    return identities.filter((item) => {
        const key = `${item.botId}::${item.chatId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function resolveSourceMessageId(msg) {
    const candidates = [
        msg?.meta?.msgId,
        msg?.message_id,
        msg?.messageId,
        msg?.update_id,
        msg?.updateId,
        msg?.data?.msgId
    ];
    for (const candidate of candidates) {
        const value = String(candidate == null ? "" : candidate).trim();
        if (value) return value;
    }
    return null;
}

// /feedback [mã yêu cầu] [nội dung]
//
// Có mã yêu cầu ⇒ gửi tiếp vào yêu cầu đó. Không có ⇒ mở yêu cầu mới.
//
// Yêu cầu luôn được lưu trong ngăn của BOT HIỆN TẠI, và việc tra cứu cũng chỉ
// trong ngăn đó, nên không thể vô tình ghi vào yêu cầu của bot khác.
async function handleFeedbackCommand(context, argument, msg) {
    const chatId = context.chatId;
    const rawArgument = String(argument || "").trim();

    // Chưa có nội dung: hướng dẫn cách dùng thay vì lưu một yêu cầu rỗng.
    if (!rawArgument) {
        await sendMessage(chatId, formatFeedbackUsage());
        return;
    }

    const followUpMatch = rawArgument.match(/^(FB-?[0-9A-Fa-f]{8})\s+([\s\S]+)$/);
    const sourceMessageId = resolveSourceMessageId(msg);
    const botId = context.botId || getCurrentBotId();

    if (followUpMatch) {
        const ticketId = normalizeTicketId(followUpMatch[1]);
        const existing = ticketId ? findTicket(botId, ticketId) : null;

        if (existing) {
            const updated = appendUserMessage(botId, ticketId, followUpMatch[2]);
            if (!updated) {
                await sendMessage(chatId, formatErrorMessage(new Error("Không ghi được nội dung bổ sung.")));
                return;
            }
            await sendMessage(chatId, formatFeedbackFollowUpAck(ticketId));
            logDiscord("INFO", `Yêu cầu ${ticketId}: người dùng gửi tiếp (bot ${botId})`);
            return;
        }

        if (ticketId) {
            // Có mã nhưng không thuộc bot này ⇒ nói rõ, đừng im lặng mở yêu cầu mới
            // với nội dung bắt đầu bằng mã.
            await sendMessage(chatId, formatWarningMessage(
                "KHÔNG TÌM THẤY YÊU CẦU",
                `> Không có yêu cầu **${escapeMarkdown(ticketId)}** trong cuộc trò chuyện với bot này.\n\n` +
                "> Kiểm tra lại mã, hoặc gửi **/feedback [nội dung]** để mở yêu cầu mới."
            ));
            return;
        }
    }

    let created;
    try {
        created = createTicket({
            botId,
            chatId,
            chatType: detectChatType(msg),
            userId: context.userId,
            displayName: context.userDisplayName,
            message: rawArgument,
            sourceMessageId
        });
    } catch (error) {
        // KHÔNG bao giờ báo đã gửi khi lưu thất bại.
        console.error(`[Feedback] không lưu được yêu cầu: ${error.message}`);
        await sendMessage(chatId, formatErrorMessage(new Error("Chưa lưu được yêu cầu. Bạn thử lại sau ít phút nhé.")));
        return;
    }

    const ticket = created.ticket;
    // Không log nội dung góp ý: chỉ log mã yêu cầu và định danh hội thoại.
    console.log(`[Feedback] ${ticket.ticketId} từ bot ${botId} chat ${chatId}${created.duplicate ? " (trùng, đã có)" : ""}`);
    logDiscord("INFO", `Yêu cầu hỗ trợ mới: ${ticket.ticketId} (bot ${botId})`);

    await sendMessage(chatId, created.duplicate
        ? formatFeedbackDuplicateAck(ticket.ticketId)
        : formatFeedbackAck(ticket.ticketId));

    // Báo cho quản trị viên. Lỗi ở bước này không được làm hỏng việc đã lưu.
    await notifyAdminsOfFeedback(ticket).catch((error) => {
        console.warn(`[Feedback] không báo được cho quản trị viên: ${error.message}`);
    });
}

// Báo quản trị viên về yêu cầu mới, trong đúng ngữ cảnh bot của họ.
//
// Cố ý KHÔNG gửi kèm nội dung góp ý: chỉ một dòng để quản trị viên mở dashboard.
async function notifyAdminsOfFeedback(ticket) {
    const recipients = getAdminIdentities();
    if (recipients.length === 0) return;

    const text = "# {orange}[HỖ TRỢ] YÊU CẦU MỚI{/orange}\n\n" +
        `> **Mã:** ${escapeMarkdown(ticket.ticketId)}\n` +
        `> **Bot:** ${escapeMarkdown(ticket.botId)}\n` +
        `> **Chat:** ${escapeMarkdown(ticket.chatId)}\n\n` +
        "Mở **Feedback / Support** trên dashboard để đọc và trả lời.";

    for (const admin of recipients) {
        try {
            const runtime = getBot(admin.botId) || getBot(LEGACY_BOT_ID);
            if (!runtime) continue;
            await runWithBot(runtime, () => sendMessage(admin.chatId, text));
        } catch (error) {
            console.warn(`[Feedback] không gửi được thông báo cho ${admin.chatId}: ${error.message}`);
        }
    }
}

// Gửi trả lời của quản trị viên tới đúng cuộc trò chuyện của đúng bot.
//
// Đây là điểm dễ sai nhất của cả tính năng: chatId chỉ có nghĩa trong phạm vi một
// bot, nên gửi bằng bot khác là gửi cho người khác. Vì vậy botId lấy từ CHÍNH yêu
// cầu (không phải từ tham số người gọi), và lệnh gửi chạy trong ngữ cảnh bot đó.
//
// KHÔNG bao giờ tự chuyển sang tài khoản Zalo cá nhân khi bot chính thức gửi lỗi:
// đó là gửi bằng danh tính khác, không phải phương án dự phòng.
async function deliverFeedbackReply({ botId, ticketId, message, adminName }) {
    const ticket = findTicket(botId, ticketId);
    if (!ticket) {
        return { delivered: false, error: "Không tìm thấy yêu cầu trong bot này" };
    }

    // Lấy bot từ CHÍNH yêu cầu, không tin botId do người gọi truyền vào.
    const runtime = getBot(ticket.botId);
    if (!runtime) {
        return { delivered: false, error: `Bot ${ticket.botId} đang tắt nên không gửi được` };
    }

    const saved = addAdminReply(ticket.botId, ticketId, { message, adminName });
    if (!saved) return { delivered: false, error: "Không lưu được trả lời" };

    const text = "# {green}[TRẢ LỜI HỖ TRỢ]{/green}\n\n" +
        `${message}\n\n` +
        `> **Mã yêu cầu:** ${escapeMarkdown(ticketId)}`;

    try {
        await runWithBot(runtime, () => sendMessage(ticket.chatId, text));
        setReplyDelivery(ticket.botId, ticketId, saved.reply.replyId, { status: "sent" });
        console.log(`[Feedback] ${ticketId}: đã trả lời qua ${ticket.botId}`);
        return {
            delivered: true,
            botId: ticket.botId,
            chatId: ticket.chatId,
            replyId: saved.reply.replyId,
            ticket: findTicket(ticket.botId, ticketId)
        };
    } catch (error) {
        // Ghi nhận thất bại THẬT và giữ trả lời lại để gửi lại. Giao diện phải
        // hiển thị lỗi này, không được báo "đã gửi".
        const reason = error?.message || String(error);
        setReplyDelivery(ticket.botId, ticketId, saved.reply.replyId, { status: "failed", error: reason });
        console.warn(`[Feedback] ${ticketId}: gửi qua ${ticket.botId} thất bại - ${reason}`);
        return {
            delivered: false,
            botId: ticket.botId,
            chatId: ticket.chatId,
            replyId: saved.reply.replyId,
            error: reason,
            ticket: findTicket(ticket.botId, ticketId)
        };
    }
}

if (!isTestEnv) {
    startRuntime().catch((error) => {
        console.error("Không thể khởi động persistence/runtime:", error);
        logDiscord("ERROR", `runtime_startup_error: ${error.message}`);
        // Không chạy nền bằng JSON cục bộ trong môi trường thật: dừng với mã lỗi.
        process.exit(1);
    });
}

module.exports = {
    cancelSchedulerJobs,
    closeDashboardServer,
    // Dùng cho bài kiểm tra đường gửi trả lời hỗ trợ: chứng minh trả lời đi tới
    // đúng bot của yêu cầu, không bao giờ chỉ dựa vào chatId.
    deliverFeedbackReply,
    formatGeneralHelp,
    formatAdminHelp,
    // Dùng cho bài kiểm tra cách ly nhà cung cấp: chứng minh phản hồi đi ra bằng
    // ĐÚNG nhà cung cấp đã nhận tin nhắn.
    handleIncomingMessage,
    sendMessage,
    registerShutdownHandlers,
    stopZaloPolling,
    getBroadcastTargets,
    groupSubscriptionsByStudent,
    handleCommand,
    getCommandRegistry,
    isOwner,
    formatTargetDay,
    formatTargetDayLabel,
    normalizeTargetDayToken,
    parseNhanLichArgument,
    parseRecordId,
    parseSuaGioNhanLichArgument,
    parseCommand,
    parseQuestionIdAndText,
    registerRuntimeJobs,
    sendBotAnnouncement,
    runRecoveredAnnouncement,
    getAdmissionStats,
    sendClassStartNotifications,
    sendDailySchedulesAtSix,
    sendDailySchedulesAtTime,
    sendScheduledDailySchedules,
    sendWelcomeMessage,
    suggestCommandCorrection,
    startRuntime
};
