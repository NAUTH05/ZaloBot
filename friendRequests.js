// ============================================================================
// Lời mời kết bạn Zalo — lưu trữ + quy tắc trạng thái.
//
// Tách khỏi service (friendRequestService.js) để phần quy tắc thuần này kiểm thử
// được mà không cần zca-js, không cần mạng, không cần Firestore thật.
//
// Nguyên tắc:
//   - Khóa bản ghi là (provider, accountId, userId). Một tài khoản Zalo chỉ có
//     THỂ có một lời mời đang chờ từ một người, nên khóa này là đúng và chống
//     trùng một cách tự nhiên khi cả listener lẫn vòng đồng bộ cùng phát hiện.
//   - "generation" tăng khi một lời mời ĐÃ XỬ LÝ được phát hiện lại là đang chờ
//     (người kia hủy rồi gửi lại). Nhờ vậy không lẫn lời mời mới với bản ghi cũ,
//     và thông báo cho lời mời mới vẫn được gửi.
//   - Trạng thái kết thúc (accepted/rejected/...) không bao giờ bị ghi đè bởi một
//     lần đồng bộ đến muộn trong khoảng REOPEN_GUARD_MS — Zalo có độ trễ, và một
//     lần đọc cũ không được phép "hồi sinh" lời mời vừa được chấp nhận.
// ============================================================================
const path = require("path");
const { readJsonStore, writeJsonStore } = require("./firestorePersistence");

const FILE_PATH = path.join(__dirname, "friendRequests.json");
const SETTINGS_FILE_PATH = path.join(__dirname, "friendRequestSettings.json");
const SCHEMA_VERSION = 1;

const PROVIDER = "zca";

const REQUEST_STATUS = Object.freeze({
    PENDING: "pending",
    PROCESSING: "processing",
    ACCEPTED: "accepted",
    REJECTED: "rejected",
    ALREADY_FRIENDS: "already_friends",
    CANCELLED: "cancelled",
    FAILED: "failed",
    REQUIRES_VERIFICATION: "requires_verification"
});

// Chỉ hai trạng thái này được phép thao tác tiếp. Còn lại là "đã đóng".
const OPEN_STATUSES = new Set([REQUEST_STATUS.PENDING, REQUEST_STATUS.PROCESSING]);

// Trạng thái đã đóng nhưng quản trị viên vẫn được thử lại: lỗi của Zalo hoặc một
// lần xử lý bị gián đoạn không phải là quyết định cuối cùng.
const RETRYABLE_STATUSES = new Set([REQUEST_STATUS.FAILED, REQUEST_STATUS.REQUIRES_VERIFICATION]);

// Chế độ xử lý lời mời.
const HANDLING_MODE = Object.freeze({
    MANUAL: "manual",
    AUTO: "auto",
    DISABLED: "disabled"
});

// Cách bản ghi được xử lý — dùng cho lịch sử và cho hạn mức tự động.
const PROCESSED_METHOD = Object.freeze({
    MANUAL: "manual",
    AUTO: "auto",
    SYSTEM: "system"
});

// Kênh thông báo. Hai kênh độc lập, ghi kết quả riêng.
const NOTIFICATION_CHANNEL = Object.freeze({
    OFFICIAL: "official",
    ZCA: "zca"
});

const NOTIFICATION_STATUS = Object.freeze({
    SENT: "sent",
    FAILED: "failed",
    SKIPPED: "skipped"
});

// Loại thông báo. Khóa ghi nhận của mỗi loại là riêng, nên một lời mời có thể
// vừa "đã báo có lời mời" vừa "đã báo kết quả chấp nhận" mà không ghi đè nhau.
const NOTIFICATION_KIND = Object.freeze({
    NEW_REQUEST: "new_request",
    ACCEPTED: "accepted",
    FAILED: "failed"
});

// Zalo có độ trễ giữa lúc API chấp nhận và lúc trạng thái quan hệ cập nhật. Một
// lần đồng bộ đến trong khoảng này không được mở lại bản ghi vừa xử lý.
const REOPEN_GUARD_MS = 10 * 60 * 1000;

const LIMITS = Object.freeze({
    syncIntervalMs: { min: 30000, max: 600000, fallback: 60000 },
    maxPerHour: { min: 1, max: 30, fallback: 5 },
    minIntervalMs: { min: 5000, max: 600000, fallback: 60000 },
    suspendAfterErrors: { min: 1, max: 10, fallback: 3 },
    welcomeMessageMaxLength: 1000,
    historyLimit: 500
});

const DEFAULT_SETTINGS = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    mode: HANDLING_MODE.MANUAL,
    syncIntervalMs: LIMITS.syncIntervalMs.fallback,
    autoAccept: {
        maxPerHour: LIMITS.maxPerHour.fallback,
        minIntervalMs: LIMITS.minIntervalMs.fallback,
        notifyOnSuccess: true,
        notifyOnFailure: true,
        suspendAfterErrors: LIMITS.suspendAfterErrors.fallback
    },
    notifications: {
        // Kênh bot chính thức BẬT mặc định: hệ thống đã có sẵn OWNER_CHAT_ID và
        // bot 1, nên đây là đường hoạt động được ngay mà không cần cấu hình gì.
        official: { enabled: true, botId: null, chatId: null },
        // Kênh ZCA TẮT mặc định: cần một hội thoại ZCA hợp lệ và không được giả
        // định Chat ID của bot chính thức dùng được cho tài khoản cá nhân.
        zca: { enabled: false, chatId: null }
    },
    welcome: { enabled: false, message: "" }
});

function nowIso() { return new Date().toISOString(); }

function normalizeId(value) {
    const id = String(value == null ? "" : value).trim();
    return id || null;
}

function cleanText(value, maxLength = 500) {
    const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    return text ? text.slice(0, maxLength) : null;
}

function clampInt(value, { min, max, fallback }) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const rounded = Math.round(parsed);
    if (rounded < min) return min;
    if (rounded > max) return max;
    return rounded;
}

// ---------------------------------------------------------------------------
// Khóa bản ghi
// ---------------------------------------------------------------------------

// Khóa ổn định qua các lần khởi động: cùng một tài khoản ZCA nhận cùng một lời
// mời từ cùng một người ⇒ cùng requestId. Nhờ vậy restart không tạo bản ghi mới
// và không gửi lại thông báo.
function buildRequestId(accountId, userId) {
    const account = normalizeId(accountId);
    const user = normalizeId(userId);
    if (!account || !user) return null;
    return `${PROVIDER}::${account}::${user}`;
}

function isOpen(record) {
    return Boolean(record && OPEN_STATUSES.has(record.status));
}

function isClosed(record) {
    return Boolean(record && !OPEN_STATUSES.has(record.status));
}

// ---------------------------------------------------------------------------
// Đọc/ghi store
// ---------------------------------------------------------------------------

function emptyStore() {
    return { schemaVersion: SCHEMA_VERSION, requests: {} };
}

function readStore(filePath = FILE_PATH) {
    // Luôn truyền cùng một đường dẫn cho cả hai tham số: đó là điều kiện để tầng
    // lưu trữ dùng cache Firestore thay vì đọc/ghi tệp cục bộ.
    const data = readJsonStore(filePath, filePath, emptyStore());
    if (!data || typeof data !== "object") return emptyStore();
    const requests = data.requests && typeof data.requests === "object" ? data.requests : {};
    return { schemaVersion: SCHEMA_VERSION, requests };
}

function writeStore(store, filePath = FILE_PATH) {
    writeJsonStore(filePath, filePath, {
        schemaVersion: SCHEMA_VERSION,
        requests: store.requests || {}
    });
}

function listRecords(store) {
    return Object.values(store.requests || {}).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Phát hiện lời mời
// ---------------------------------------------------------------------------

// Ghi nhận một lời mời đang chờ. Đây là ĐIỂM DUY NHẤT tạo bản ghi, nên cả
// listener lẫn vòng đồng bộ đều đi qua đây và không thể tạo bản trùng.
//
// Trả về { record, isNew, reopened }:
//   isNew    — bản ghi mới, hoặc lời mời mới của người từng được xử lý trước đó
//   reopened — bản ghi cũ đã đóng được mở lại thành lời mời mới (generation +1)
function upsertDetected(input = {}, filePath = FILE_PATH) {
    const accountId = normalizeId(input.accountId);
    const userId = normalizeId(input.userId);
    if (!accountId || !userId) {
        throw new Error("Cần accountId và userId để ghi nhận lời mời kết bạn");
    }

    const requestId = buildRequestId(accountId, userId);
    const store = readStore(filePath);
    const existing = store.requests[requestId] || null;
    const now = nowIso();

    // Hồ sơ chỉ cập nhật khi có dữ liệu mới; không xoá tên/ảnh đã biết chỉ vì
    // lần đồng bộ này thiếu trường đó.
    const profile = {
        displayName: cleanText(input.displayName, 120) || existing?.displayName || null,
        avatar: cleanText(input.avatar, 500) || existing?.avatar || null,
        message: cleanText(input.message, 500) || existing?.message || null
    };
    const requestedAt = normalizeId(input.requestedAt) || existing?.requestedAt || null;

    if (!existing) {
        const record = {
            requestId,
            provider: PROVIDER,
            accountId,
            userId,
            ...profile,
            status: REQUEST_STATUS.PENDING,
            generation: 1,
            detectedAt: now,
            requestedAt,
            processedAt: null,
            processedBy: null,
            processedMethod: null,
            lastError: null,
            attempts: 0,
            notifications: {},
            source: normalizeId(input.source) || "sync",
            history: [{ at: now, status: REQUEST_STATUS.PENDING, method: null, by: null, note: "phát hiện lời mời" }]
        };
        store.requests[requestId] = record;
        writeStore(store, filePath);
        return { record, isNew: true, reopened: false };
    }

    // Đang chờ ⇒ chỉ làm giàu hồ sơ. Không đổi trạng thái, không tạo thông báo.
    if (isOpen(existing)) {
        const record = { ...existing, ...profile, requestedAt };
        store.requests[requestId] = record;
        writeStore(store, filePath);
        return { record, isNew: false, reopened: false };
    }

    // Đã đóng ⇒ chỉ mở lại khi thật sự là lời mời mới.
    //
    // Vừa xử lý xong mà đồng bộ vẫn thấy "đang chờ" thì đó là độ trễ của Zalo,
    // không phải lời mời mới. Mở lại sẽ khiến hệ thống chấp nhận hai lần.
    const processedAtMs = existing.processedAt ? Date.parse(existing.processedAt) : NaN;
    if (Number.isFinite(processedAtMs) && Date.now() - processedAtMs < REOPEN_GUARD_MS) {
        const record = { ...existing, ...profile };
        store.requests[requestId] = record;
        writeStore(store, filePath);
        return { record, isNew: false, reopened: false };
    }

    const record = {
        ...existing,
        ...profile,
        status: REQUEST_STATUS.PENDING,
        generation: (Number(existing.generation) || 1) + 1,
        detectedAt: now,
        requestedAt,
        processedAt: null,
        processedBy: null,
        processedMethod: null,
        lastError: null,
        attempts: 0,
        // Thông báo của lời mời MỚI phải đi lại từ đầu; thông báo của lời mời cũ
        // không được dùng để chặn lời mời mới.
        notifications: {},
        previousStatus: existing.status,
        history: [
            ...(Array.isArray(existing.history) ? existing.history : []),
            { at: now, status: REQUEST_STATUS.PENDING, method: null, by: null, note: `lời mời mới (thay cho ${existing.status})` }
        ].slice(-40)
    };
    store.requests[requestId] = record;
    writeStore(store, filePath);
    return { record, isNew: true, reopened: true };
}

// ---------------------------------------------------------------------------
// Chuyển trạng thái
// ---------------------------------------------------------------------------

// Đổi trạng thái một bản ghi và ghi lại lịch sử.
//
// `expectedOpen` = true nghĩa là chỉ được chuyển khi bản ghi còn đang chờ. Dùng
// cho mọi thao tác chấp nhận/từ chối để hai request đồng thời không cùng thắng.
function applyTransition(requestId, status, meta = {}, filePath = FILE_PATH) {
    const store = readStore(filePath);
    const existing = store.requests[requestId];
    if (!existing) return { ok: false, reason: "not_found" };
    // Chỉ chuyển khi trạng thái hiện tại còn nằm trong tập cho phép. Đây là chốt
    // chống hai thao tác đồng thời cùng "thắng" trên một lời mời.
    if (Array.isArray(meta.expectedStatuses)) {
        if (!meta.expectedStatuses.includes(existing.status)) {
            return { ok: false, reason: "already_processed", record: existing };
        }
    } else if (meta.expectedOpen && !isOpen(existing)) {
        return { ok: false, reason: "already_processed", record: existing };
    }

    const now = nowIso();
    const record = {
        ...existing,
        status,
        processedAt: OPEN_STATUSES.has(status) ? null : (meta.processedAt || now),
        processedBy: meta.processedBy ?? existing.processedBy ?? null,
        processedMethod: meta.method ?? existing.processedMethod ?? null,
        lastError: meta.error ? cleanText(meta.error, 400) : (OPEN_STATUSES.has(status) ? null : existing.lastError),
        attempts: Number(existing.attempts || 0) + (meta.incrementAttempts ? 1 : 0),
        history: [
            ...(Array.isArray(existing.history) ? existing.history : []),
            { at: now, status, method: meta.method || null, by: meta.processedBy || null, note: cleanText(meta.note, 200) }
        ].slice(-40)
    };
    store.requests[requestId] = record;
    writeStore(store, filePath);
    return { ok: true, record };
}

// Ghi kết quả gửi thông báo của MỘT kênh. Không đụng tới kênh còn lại: một kênh
// lỗi không được xoá dấu kênh kia đã gửi thành công.
//
// `kind` tách khóa ghi nhận: thông báo "có lời mời mới" và thông báo "đã chấp
// nhận" là hai lần gửi khác nhau trên cùng một kênh, nên không được ghi đè nhau.
function setNotificationResult(requestId, channel, result = {}, filePath = FILE_PATH) {
    const store = readStore(filePath);
    const existing = store.requests[requestId];
    if (!existing) return { ok: false, reason: "not_found" };
    const name = String(channel || "").trim();
    if (!Object.values(NOTIFICATION_CHANNEL).includes(name)) {
        return { ok: false, reason: "invalid_channel" };
    }
    const kind = String(result.kind || "").trim();
    const key = kind && kind !== NOTIFICATION_KIND.NEW_REQUEST ? `${name}:${kind}` : name;

    const notifications = { ...(existing.notifications || {}) };
    const previous = notifications[key] || {};
    notifications[key] = {
        kind: kind || NOTIFICATION_KIND.NEW_REQUEST,
        status: result.status || NOTIFICATION_STATUS.FAILED,
        chatId: normalizeId(result.chatId) || previous.chatId || null,
        botId: normalizeId(result.botId) || previous.botId || null,
        at: nowIso(),
        error: result.error ? cleanText(result.error, 400) : null,
        attempts: Number(previous.attempts || 0) + 1
    };
    store.requests[requestId] = { ...existing, notifications };
    writeStore(store, filePath);
    return { ok: true, record: store.requests[requestId] };
}

// Kênh đã gửi thành công cho lời mời hiện tại chưa. Dùng để chống gửi trùng khi
// listener và vòng đồng bộ cùng phát hiện một lời mời.
function hasNotified(record, channel, kind = NOTIFICATION_KIND.NEW_REQUEST) {
    const key = kind === NOTIFICATION_KIND.NEW_REQUEST ? channel : `${channel}:${kind}`;
    return record?.notifications?.[key]?.status === NOTIFICATION_STATUS.SENT;
}

// Bản ghi đang ở trạng thái "đang xử lý" quá lâu nghĩa là tiến trình đã chết giữa
// chừng. Phải mở khóa, nếu không lời mời đó kẹt vĩnh viễn và không bao giờ xử lý
// lại được. Trả về số bản ghi đã khôi phục.
function recoverStuckProcessing({ staleAfterMs = 2 * 60 * 1000, filePath = FILE_PATH } = {}) {
    const store = readStore(filePath);
    const now = Date.now();
    let recovered = 0;
    for (const [requestId, record] of Object.entries(store.requests || {})) {
        if (record?.status !== REQUEST_STATUS.PROCESSING) continue;
        const startedAt = Date.parse(record.processedAt || record.detectedAt || "");
        if (Number.isFinite(startedAt) && now - startedAt < staleAfterMs) continue;
        store.requests[requestId] = {
            ...record,
            status: REQUEST_STATUS.REQUIRES_VERIFICATION,
            processedAt: new Date().toISOString(),
            lastError: "Gián đoạn khi đang xử lý — cần quản trị viên kiểm tra lại",
            history: [
                ...(Array.isArray(record.history) ? record.history : []),
                {
                    at: new Date().toISOString(),
                    status: REQUEST_STATUS.REQUIRES_VERIFICATION,
                    method: PROCESSED_METHOD.SYSTEM,
                    by: null,
                    note: "khôi phục sau khi tiến trình dừng giữa chừng"
                }
            ].slice(-40)
        };
        recovered += 1;
    }
    if (recovered > 0) writeStore(store, filePath);
    return recovered;
}

// ---------------------------------------------------------------------------
// Truy vấn
// ---------------------------------------------------------------------------

function getRecord(requestId, filePath = FILE_PATH) {
    const store = readStore(filePath);
    return store.requests[requestId] || null;
}

// Danh sách bản ghi, mới nhất trước. Lọc theo tài khoản, trạng thái và từ khóa.
function listRecordsFiltered(options = {}, filePath = FILE_PATH) {
    const store = readStore(filePath);
    const accountId = normalizeId(options.accountId);
    const statuses = Array.isArray(options.statuses)
        ? options.statuses.filter(Boolean)
        : (normalizeId(options.status) ? [normalizeId(options.status)] : []);
    const search = String(options.search || "").trim().toLowerCase();
    const limit = clampInt(options.limit, { min: 1, max: LIMITS.historyLimit, fallback: LIMITS.historyLimit });

    const matched = listRecords(store)
        .filter((record) => (accountId ? record.accountId === accountId : true))
        .filter((record) => (statuses.length > 0 ? statuses.includes(record.status) : true))
        .filter((record) => {
            if (!search) return true;
            return [record.displayName, record.userId, record.message, record.accountId]
                .map((value) => String(value || "").toLowerCase())
                .some((value) => value.includes(search));
        })
        .sort((a, b) => String(b.detectedAt || "").localeCompare(String(a.detectedAt || "")));

    return matched.slice(0, limit);
}

function listPending(options = {}, filePath = FILE_PATH) {
    return listRecordsFiltered({ ...options, statuses: [REQUEST_STATUS.PENDING, REQUEST_STATUS.PROCESSING] }, filePath);
}

function listHistory(options = {}, filePath = FILE_PATH) {
    return listRecordsFiltered(options, filePath).filter((record) => !isOpen(record));
}

// Số lần chấp nhận TỰ ĐỘNG trong khoảng thời gian gần đây. Đếm từ dữ liệu đã
// lưu nên hạn mức vẫn đúng sau khi khởi động lại.
function countAutoAcceptsSince(sinceIso, filePath = FILE_PATH) {
    const since = Date.parse(sinceIso);
    if (!Number.isFinite(since)) return 0;
    return listRecords(readStore(filePath)).filter((record) => {
        if (record.status !== REQUEST_STATUS.ACCEPTED) return false;
        if (record.processedMethod !== PROCESSED_METHOD.AUTO) return false;
        const at = Date.parse(record.processedAt || "");
        return Number.isFinite(at) && at >= since;
    }).length;
}

function lastAutoAcceptAt(filePath = FILE_PATH) {
    let latest = null;
    for (const record of listRecords(readStore(filePath))) {
        if (record.status !== REQUEST_STATUS.ACCEPTED) continue;
        if (record.processedMethod !== PROCESSED_METHOD.AUTO) continue;
        const at = record.processedAt;
        if (!at) continue;
        if (!latest || String(at) > String(latest)) latest = at;
    }
    return latest;
}

// ---------------------------------------------------------------------------
// Cấu hình
// ---------------------------------------------------------------------------

function normalizeNotificationChannel(input = {}, fallback = {}) {
    return {
        enabled: input.enabled === undefined ? fallback.enabled === true : input.enabled === true,
        botId: normalizeId(input.botId) ?? fallback.botId ?? null,
        chatId: normalizeId(input.chatId) ?? fallback.chatId ?? null
    };
}

function normalizeSettings(raw = {}) {
    const source = raw && typeof raw === "object" ? raw : {};
    const mode = Object.values(HANDLING_MODE).includes(source.mode) ? source.mode : DEFAULT_SETTINGS.mode;
    const autoSource = source.autoAccept && typeof source.autoAccept === "object" ? source.autoAccept : {};
    const notifSource = source.notifications && typeof source.notifications === "object" ? source.notifications : {};
    const welcomeSource = source.welcome && typeof source.welcome === "object" ? source.welcome : {};

    return {
        schemaVersion: SCHEMA_VERSION,
        mode,
        // Giới hạn được ép ở ĐÂY, phía máy chủ. Giao diện chỉ là gợi ý; không bao
        // giờ tin giá trị client gửi lên.
        syncIntervalMs: clampInt(source.syncIntervalMs, LIMITS.syncIntervalMs),
        autoAccept: {
            maxPerHour: clampInt(autoSource.maxPerHour, LIMITS.maxPerHour),
            minIntervalMs: clampInt(autoSource.minIntervalMs, LIMITS.minIntervalMs),
            notifyOnSuccess: autoSource.notifyOnSuccess === undefined ? true : autoSource.notifyOnSuccess === true,
            notifyOnFailure: autoSource.notifyOnFailure === undefined ? true : autoSource.notifyOnFailure === true,
            suspendAfterErrors: clampInt(autoSource.suspendAfterErrors, LIMITS.suspendAfterErrors)
        },
        notifications: {
            official: normalizeNotificationChannel(notifSource.official, DEFAULT_SETTINGS.notifications.official),
            zca: normalizeNotificationChannel(notifSource.zca, DEFAULT_SETTINGS.notifications.zca)
        },
        welcome: {
            enabled: welcomeSource.enabled === true,
            message: String(welcomeSource.message == null ? "" : welcomeSource.message)
                .slice(0, LIMITS.welcomeMessageMaxLength)
        }
    };
}

function getSettings(filePath = SETTINGS_FILE_PATH) {
    const data = readJsonStore(filePath, filePath, { ...DEFAULT_SETTINGS });
    return normalizeSettings(data);
}

function writeSettings(settings, filePath = SETTINGS_FILE_PATH) {
    const normalized = normalizeSettings(settings);
    writeJsonStore(filePath, filePath, normalized);
    return normalized;
}

// Gộp một phần thay đổi vào cấu hình hiện có. Chỉ những khóa được gửi lên mới
// thay đổi — nhờ vậy UI có thể lưu từng mục mà không ghi đè mục khác.
function updateSettings(patch = {}, filePath = SETTINGS_FILE_PATH) {
    const current = getSettings(filePath);
    const next = {
        ...current,
        ...(patch.mode === undefined ? {} : { mode: patch.mode }),
        ...(patch.syncIntervalMs === undefined ? {} : { syncIntervalMs: patch.syncIntervalMs }),
        autoAccept: { ...current.autoAccept, ...(patch.autoAccept || {}) },
        notifications: {
            official: { ...current.notifications.official, ...(patch.notifications?.official || {}) },
            zca: { ...current.notifications.zca, ...(patch.notifications?.zca || {}) }
        },
        welcome: { ...current.welcome, ...(patch.welcome || {}) }
    };
    return writeSettings(next, filePath);
}

// Chế độ xử lý có thực sự cho phép tự động chấp nhận hay không. Chỉ một nguồn
// sự thật là `mode`; UI có công tắc riêng nhưng công tắc đó ánh xạ về mode.
function autoAcceptEnabled(settings) {
    return settings?.mode === HANDLING_MODE.AUTO;
}

module.exports = {
    DEFAULT_SETTINGS,
    FILE_PATH,
    HANDLING_MODE,
    LIMITS,
    NOTIFICATION_CHANNEL,
    NOTIFICATION_KIND,
    NOTIFICATION_STATUS,
    OPEN_STATUSES,
    PROCESSED_METHOD,
    PROVIDER,
    REQUEST_STATUS,
    RETRYABLE_STATUSES,
    REOPEN_GUARD_MS,
    SCHEMA_VERSION,
    SETTINGS_FILE_PATH,
    applyTransition,
    autoAcceptEnabled,
    buildRequestId,
    countAutoAcceptsSince,
    emptyStore,
    getRecord,
    getSettings,
    hasNotified,
    isClosed,
    isOpen,
    lastAutoAcceptAt,
    listHistory,
    listPending,
    listRecords,
    listRecordsFiltered,
    normalizeSettings,
    readStore,
    recoverStuckProcessing,
    setNotificationResult,
    updateSettings,
    upsertDetected,
    writeSettings
};
