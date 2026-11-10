// ============================================================================
// Nhà cung cấp ZCA — tài khoản Zalo CÁ NHÂN qua zca-js.
//
// Đây là một nhà cung cấp ĐỘC LẬP, chạy song song với các bot chính thức trên
// Zalo Bot Platform. Nó không thay thế, không sửa và không vượt qua giới hạn của
// các bot chính thức.
//
// Nguyên tắc sống còn:
//   - KHÔNG BAO GIỜ gọi process.exit. Listener ZCA ngắt kết nối chỉ là sự cố của
//     MỘT nhà cung cấp; các bot chính thức và dashboard phải tiếp tục chạy.
//   - Không thử lại vô hạn với phiên sai: phiên hỏng ⇒ yêu cầu đăng nhập lại.
//   - Không tạo listener trùng khi kết nối lại.
//
// API dùng đúng theo zca-js 2.2.0 (đã đối chiếu dist/*.d.ts):
//   new Zalo(options) / zalo.login(credentials) / zalo.loginQR(options, callback)
//   api.getOwnId() / api.sendMessage(message, threadId, type) / api.listener.*
//
// Lời mời kết bạn (cũng đã đối chiếu dist/*.d.ts của 2.2.0):
//   api.getFriendRecommendations() → recommItems[].dataInfo.recommType === 2
//   api.getFriendRequestStatus(uid) → { is_friend, is_requested, is_requesting }
//   api.acceptFriendRequest(uid) / api.rejectFriendRequest(uid)
//   listener "friend_event" + FriendEventType.REQUEST / UNDO_REQUEST / REJECT_REQUEST
// KHÔNG có getReceivedFriendRequests() trong bản này — đó là tên của bản cũ.
// ============================================================================
const { Zalo, ThreadType, FriendEventType, FriendRecommendationsType } = require("zca-js");
const { PROVIDER_TYPES, formatBotLabel, zcaId } = require("../../bots");
const adapter = require("./zcaMessageAdapter");
const { renderZcaRichText } = require("./zcaRichText");
const sessionStore = require("./zcaSessionStore");

// Trạng thái vòng đời. Chỉ dùng tập con phù hợp với ZCA.
const ZCA_STATUS = Object.freeze({
    DISABLED: "disabled",
    STARTING: "starting",
    WAITING_FOR_QR: "waiting_for_qr",
    AUTHENTICATED: "authenticated",
    CONNECTED: "connected",
    RECONNECTING: "reconnecting",
    DISCONNECTED: "disconnected",
    AUTHENTICATION_REQUIRED: "authentication_required",
    ERROR: "error"
});

// CloseReason của zca-js: 1000 chủ động, 1006 bất thường, 3000 trùng kết nối,
// 3003 bị đá. 3000/3003 gần như luôn là do mở Zalo Web/PC ở nơi khác.
const CLOSE_REASON_HINTS = {
    1000: "đóng chủ động",
    1006: "ngắt kết nối bất thường (mạng hoặc máy chủ Zalo)",
    3000: "trùng kết nối — có nơi khác đang dùng cùng phiên ZCA (thường là Zalo Web/PC)",
    3003: "bị đá khỏi phiên — có nơi khác đăng nhập cùng tài khoản"
};

function describeCloseReason(code, reason) {
    const hint = CLOSE_REASON_HINTS[Number(code)] || "không rõ nguyên nhân";
    return `${code ?? "?"} (${hint})${reason ? ` — ${reason}` : ""}`;
}

// ---------------------------------------------------------------------------
// Sự kiện kết bạn → dạng nội bộ
//
// Chuyển ngay tại biên giới nhà cung cấp, đúng như cách tin nhắn được chuyển qua
// zcaMessageAdapter: tầng nghiệp vụ không bao giờ phải biết tới FriendEventType.
//
// Chỉ trả về sự kiện LIÊN QUAN TỚI CHÚNG TA. Lời mời do chính tài khoản này gửi
// đi (fromUid === ownUid) không được coi là lời mời đến — nhầm chỗ này sẽ khiến
// hệ thống tự chấp nhận lời mời của chính mình.
// ---------------------------------------------------------------------------
function mapFriendEvent(event, ownUid) {
    if (!event || typeof event !== "object") return null;
    const self = ownUid == null || ownUid === "" ? null : String(ownUid);
    const data = event.data;

    const uidOf = (value) => {
        const text = value == null ? "" : String(value).trim();
        return text || null;
    };

    switch (event.type) {
        case FriendEventType.REQUEST: {
            if (!data || typeof data !== "object") return null;
            const fromUid = uidOf(data.fromUid);
            const toUid = uidOf(data.toUid);
            if (!fromUid) return null;
            if (toUid && fromUid === toUid) return null;              // dữ liệu vô nghĩa
            if (self && toUid && toUid !== self) return null;          // không phải gửi cho ta
            return {
                type: "request",
                userId: fromUid,
                message: typeof data.message === "string" ? data.message : null,
                source: data.src ?? null
            };
        }
        case FriendEventType.UNDO_REQUEST:
        case FriendEventType.REJECT_REQUEST: {
            if (!data || typeof data !== "object") return null;
            const fromUid = uidOf(data.fromUid);
            const toUid = uidOf(data.toUid);
            if (!fromUid) return null;
            if (self && toUid && toUid !== self) return null;
            return {
                type: event.type === FriendEventType.UNDO_REQUEST ? "withdrawn" : "rejected",
                userId: fromUid
            };
        }
        case FriendEventType.ADD:
        case FriendEventType.REMOVE: {
            // data là chính uid dạng chuỗi.
            const userId = uidOf(data);
            if (!userId) return null;
            return { type: event.type === FriendEventType.ADD ? "friend_added" : "friend_removed", userId };
        }
        default:
            // BLOCK/UNBLOCK/PIN/SEEN... không liên quan tới lời mời kết bạn.
            return null;
    }
}

// recommTime của Zalo có thể là giây hoặc mili giây tuỳ phiên bản; nhận cả hai
// thay vì đoán, và trả null khi không đọc được.
function toIsoFromEpoch(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    const ms = parsed > 1e12 ? parsed : parsed * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Một mục trong getFriendRecommendations → dạng nội bộ.
//
// Chỉ recommType === ReceivedFriendRequest mới là LỜI MỜI ĐẾN. Các mục còn lại
// là gợi ý kết bạn — coi chúng là lời mời đang chờ sẽ khiến hệ thống chấp nhận
// những người chưa hề gửi lời mời nào.
function normalizeRecommendation(item) {
    const info = item?.dataInfo || item;
    const userId = info?.userId == null ? "" : String(info.userId).trim();
    if (!userId) return null;
    return {
        userId,
        displayName: info.displayName || info.zaloName || null,
        avatar: info.avatar || null,
        message: info.recommInfo?.message || info.recommInfo?.customText || null,
        requestedAt: toIsoFromEpoch(info.recommTime),
        // Giữ lại để nơi gọi có thể kiểm tra thêm nếu cần.
        recommType: Number(info.recommType)
    };
}

// Phản hồi getFriendRequestStatus → dạng đọc được.
//
// Ý nghĩa các cờ (theo tài liệu zca-js): is_friend = đã là bạn; is_requested =
// NGƯỜI KIA đã gửi lời mời cho ta; is_requesting = TA đã gửi lời mời cho họ.
//
// CẢNH BÁO đã kiểm chứng bằng thực tế: hai cờ này KHÔNG đáng tin. Đã gặp trường
// hợp lời mời vẫn còn trong Zalo (và vẫn nằm trong getFriendRecommendations với
// recommType = ReceivedFriendRequest) mà cả is_requested lẫn is_requesting đều
// bằng 0. Vì vậy:
//   - `hasPendingRequest` chỉ là GỢI Ý, không phải bằng chứng "đã thu hồi".
//   - Chiều của lời mời KHÔNG bao giờ được suy ra từ đây; nó do nguồn phát hiện
//     quyết định (recommType = 2, hoặc friend_event.toUid === ownUid).
function normalizeRequestStatus(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const flag = (value) => Number(value) === 1;
    const isFriend = flag(source.is_friend);
    const incomingRequest = flag(source.is_requested);
    const outgoingRequest = flag(source.is_requesting);
    return {
        isFriend,
        incomingRequest,
        outgoingRequest,
        // Còn một lời mời đang chờ (theo cờ). Sai âm tính là chuyện đã xảy ra.
        hasPendingRequest: !isFriend && (incomingRequest || outgoingRequest),
        seen: Boolean(source.isSeenFriendReq),
        raw: source
    };
}

function createZcaProvider(options = {}) {
    const {
        enabled = false,
        sessionDir = sessionStore.resolveSessionDir(options.sessionPath),
        autoReconnect = true,
        language = "vi",
        onMessage = null,
        // Sự kiện kết bạn (đã chuyển sang dạng nội bộ). Lỗi trong handler KHÔNG
        // được làm chết listener — cùng nguyên tắc với onMessage.
        onFriendEvent = null,
        // Gọi sau mỗi lần kết nối lại thành công. Dùng để đồng bộ lời mời kết bạn
        // ngay khi phiên sống lại, thay vì chờ nhịp đồng bộ định kỳ.
        onConnected = null,
        maxReconnectAttempts = 10
    } = options;

    const provider = {
        // Khóa tạm cho tới khi đăng nhập xong mới biết UID thật. Vẫn là một danh
        // tính ZCA hợp lệ nên không bao giờ bị nhầm thành bot chính thức.
        botId: options.botId || "zca:pending",
        providerType: PROVIDER_TYPES.ZCA,
        enabled: Boolean(enabled),
        // Không có markdown của Zalo Bot Platform; tầng chung sẽ chuyển plain text.
        supportsMarkdown: false,
        status: enabled ? ZCA_STATUS.STARTING : ZCA_STATUS.DISABLED,
        // Tài khoản ZCA là danh tính cá nhân, không phải bot có token.
        isPersonalAccount: true,
        tokenSource: null,
        fingerprint: null,
        configuredName: options.displayName || null,
        verifiedName: null,
        displayName: options.displayName || "ZCA",

        // Trạng thái vận hành.
        uid: null,
        authenticated: false,
        listenerConnected: false,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastActivityAt: null,
        lastError: null,
        lastErrorAt: null,
        reconnectAttempts: 0,
        sessionPresent: false,
        // Lần cuối nhận được sự kiện kết bạn. Chỉ để chẩn đoán trên dashboard.
        lastFriendEventAt: null,

        // QR chỉ giữ trong bộ nhớ, không ghi ra đĩa.
        qr: null,

        // Nội bộ.
        zalo: null,
        api: null,
        ownUid: null,
        starting: false,
        stopping: false,
        lockHeld: false
    };

    function log(level, message) {
        const label = provider.botId || "zca";
        const line = `[ZCA][${label}] ${message}`;
        if (level === "error") console.error(line);
        else if (level === "warn") console.warn(line);
        else console.log(line);
    }

    function setStatus(status) {
        if (provider.status !== status) {
            provider.status = status;
            log("info", `trạng thái → ${status}`);
        }
    }

    function recordError(error) {
        provider.lastError = error?.message || String(error);
        provider.lastErrorAt = new Date().toISOString();
    }

    // ------------------------------------------------------------------
    // Gắn API đã đăng nhập và bắt đầu lắng nghe.
    // ------------------------------------------------------------------
    function bindApi(api) {
        provider.api = api;

        let ownId = null;
        try {
            ownId = api.getOwnId();
        } catch (error) {
            recordError(error);
            log("warn", `không lấy được UID (${error.message})`);
        }

        provider.ownUid = ownId == null ? null : String(ownId);
        // Danh tính ổn định: khóa lưu trữ phụ thuộc vào nó nên phải suy ra từ UID
        // thật, không dùng id ngẫu nhiên.
        const resolvedId = zcaId(provider.ownUid);
        if (resolvedId && resolvedId !== provider.botId) {
            const previousId = provider.botId;
            provider.botId = resolvedId;
            // Báo cho tầng đăng ký đổi khóa: trước khi đăng nhập nhà cung cấp nằm
            // dưới khóa tạm, sau khi biết UID mới có danh tính thật.
            try {
                options.onIdentityChanged?.(provider, resolvedId, previousId);
            } catch (error) {
                log("warn", `không đổi được khóa đăng ký: ${error.message}`);
            }
        }
        if (provider.ownUid && !provider.verifiedName) {
            provider.displayName = options.displayName || `ZCA ${provider.ownUid}`;
        }

        provider.authenticated = true;
        setStatus(ZCA_STATUS.AUTHENTICATED);

        const listener = api.listener;

        listener.on("connected", () => {
            provider.listenerConnected = true;
            provider.lastConnectedAt = new Date().toISOString();
            provider.reconnectAttempts = 0;
            setStatus(ZCA_STATUS.CONNECTED);
            // Đồng bộ lời mời kết bạn sau khi kết nối lại: những lời mời đến trong
            // lúc mất kết nối không có sự kiện nào để bắt, nên phải đọc lại.
            if (typeof onConnected === "function") {
                try {
                    Promise.resolve(onConnected(provider)).catch((error) => {
                        log("warn", `đồng bộ sau khi kết nối thất bại: ${error.message}`);
                    });
                } catch (error) {
                    log("warn", `đồng bộ sau khi kết nối thất bại: ${error.message}`);
                }
            }
        });

        const onDisconnect = (code, reason) => {
            provider.listenerConnected = false;
            provider.lastDisconnectedAt = new Date().toISOString();
            const detail = describeCloseReason(code, reason);
            log("warn", `listener ngắt kết nối: ${detail}`);

            // Đóng chủ động trong lúc dừng là bình thường, không phải sự cố.
            if (provider.stopping) {
                setStatus(ZCA_STATUS.DISCONNECTED);
                return;
            }

            // 3000/3003 nghĩa là phiên đang bị dùng ở nơi khác. Thử lại ngay sẽ
            // đá nhau tiếp, nên chỉ thử lại theo nhịp có giới hạn.
            if (Number(code) === 3000 || Number(code) === 3003) {
                log("warn", "một phiên Zalo khác đang hoạt động — không thử lại dồn dập");
            }
            setStatus(autoReconnect ? ZCA_STATUS.RECONNECTING : ZCA_STATUS.DISCONNECTED);
            scheduleReconnect();
        };

        listener.on("disconnected", onDisconnect);
        listener.on("closed", onDisconnect);

        listener.on("error", (error) => {
            recordError(error);
            log("error", `lỗi listener: ${error?.message || error}`);
        });

        listener.on("message", async (message) => {
            try {
                if (adapter.isSelfMessage(message)) return;   // chống vòng lặp tự trả lời
                provider.lastActivityAt = new Date().toISOString();

                // Chuyển sang định dạng nội bộ NGAY tại đây: tầng nghiệp vụ không
                // bao giờ phải biết tới hình dạng tin nhắn của zca-js.
                const internal = adapter.toInternalMessage(message);
                if (!internal) return;

                // Ghi nhớ loại luồng để gửi trả lời đúng loại (cá nhân hay nhóm).
                provider.rememberThread(internal.chat.id, internal.chat.type);

                if (typeof onMessage !== "function") return;
                await onMessage(provider, internal);
            } catch (error) {
                // Lỗi khi xử lý MỘT tin nhắn không được làm chết listener.
                recordError(error);
                log("error", `lỗi xử lý tin nhắn: ${error.message}`);
            }
        });

        // Sự kiện kết bạn. Chỉ đăng ký khi listener hỗ trợ — bản zca-js cũ không
        // có sự kiện này, và khi đó vòng đồng bộ định kỳ là đường duy nhất.
        if (typeof listener.on === "function") {
            listener.on("friend_event", (event) => {
                try {
                    const mapped = mapFriendEvent(event, provider.ownUid);
                    if (!mapped) return;
                    provider.lastFriendEventAt = new Date().toISOString();
                    if (typeof onFriendEvent !== "function") return;
                    Promise.resolve(onFriendEvent(provider, mapped)).catch((error) => {
                        recordError(error);
                        log("error", `lỗi xử lý sự kiện kết bạn: ${error.message}`);
                    });
                } catch (error) {
                    recordError(error);
                    log("error", `lỗi đọc sự kiện kết bạn: ${error.message}`);
                }
            });
        }

        // retryOnClose là cơ chế thử lại CÓ SẴN của zca-js; dùng nó thay vì tự
        // phát minh vòng lặp kết nối.
        listener.start({ retryOnClose: Boolean(autoReconnect) });
    }

    // ------------------------------------------------------------------
    // Kết nối lại có giới hạn, giãn dần. Không bao giờ thử lại vô hạn.
    // ------------------------------------------------------------------
    let reconnectTimer = null;

    function scheduleReconnect() {
        if (provider.stopping || !autoReconnect) return;
        if (reconnectTimer) return;   // đã hẹn rồi, không xếp chồng

        if (provider.reconnectAttempts >= maxReconnectAttempts) {
            log("warn", `đã thử ${provider.reconnectAttempts} lần, dừng thử lại. Cần khởi động lại hoặc đăng nhập lại.`);
            setStatus(ZCA_STATUS.DISCONNECTED);
            return;
        }

        provider.reconnectAttempts += 1;
        // Giãn dần: 5s, 10s, 20s... tối đa 2 phút.
        const delay = Math.min(5000 * 2 ** (provider.reconnectAttempts - 1), 120000);
        log("info", `thử kết nối lại lần ${provider.reconnectAttempts} sau ${Math.round(delay / 1000)}s`);

        reconnectTimer = setTimeout(async () => {
            reconnectTimer = null;
            if (provider.stopping) return;
            try {
                await reconnect();
            } catch (error) {
                recordError(error);
                log("error", `kết nối lại thất bại: ${error.message}`);
                scheduleReconnect();
            }
        }, delay);
        // Không giữ tiến trình sống chỉ vì hẹn giờ kết nối lại.
        reconnectTimer.unref?.();
    }

    async function reconnect() {
        const session = sessionStore.readSession(sessionDir);
        if (!session) {
            log("warn", "không còn phiên để kết nối lại — cần đăng nhập QR");
            setStatus(ZCA_STATUS.AUTHENTICATION_REQUIRED);
            return;
        }
        // Dọn listener cũ trước khi tạo kết nối mới, tránh hai listener cùng lúc.
        try {
            provider.api?.listener?.stop?.();
        } catch (_) {
            // Listener đã chết rồi thì bỏ qua.
        }
        provider.api = null;
        provider.listenerConnected = false;

        const zalo = provider.zalo || new Zalo({ selfListen: false, checkUpdate: false, logging: false });
        provider.zalo = zalo;
        const api = await zalo.login(session);
        bindApi(api);
    }

    // ------------------------------------------------------------------
    // Đăng nhập bằng QR. Đây là đường dùng khi chưa có phiên, hoặc khi phiên hỏng.
    // ------------------------------------------------------------------
    let qrLoginInFlight = null;

    async function beginQrLogin() {
        if (qrLoginInFlight) return qrLoginInFlight;   // không mở hai phiên QR cùng lúc

        provider.qr = null;
        setStatus(ZCA_STATUS.WAITING_FOR_QR);
        log("warn", "CẦN QUÉT MÃ QR: mở dashboard hoặc xem ảnh QR để đăng nhập tài khoản Zalo cá nhân.");

        const zalo = provider.zalo || new Zalo({ selfListen: false, checkUpdate: false, logging: false });
        provider.zalo = zalo;

        qrLoginInFlight = (async () => {
            try {
                const api = await zalo.loginQR({ language }, (event) => {
                    // Chỉ ghi loại sự kiện, KHÔNG ghi nội dung mã/phiên.
                    const type = event?.type;
                    if (type === 0) {
                        // QRCodeGenerated — giữ ảnh trong bộ nhớ cho dashboard.
                        provider.qr = {
                            image: event.data?.image || null,
                            code: event.data?.code || null,
                            generatedAt: new Date().toISOString()
                        };
                        log("info", "đã tạo mã QR, đang chờ quét");
                    } else if (type === 1) {
                        provider.qr = null;
                        log("warn", "mã QR hết hạn, cần tạo lại");
                    } else if (type === 2) {
                        log("info", `đã quét mã, tài khoản: ${event.data?.display_name || "(không rõ)"}`);
                    } else if (type === 3) {
                        provider.qr = null;
                        log("warn", "người dùng từ chối đăng nhập trên điện thoại");
                    } else if (type === 4) {
                        // GotLoginInfo — lưu phiên để các lần khởi động sau dùng lại.
                        try {
                            sessionStore.saveSession(sessionDir, {
                                imei: event.data?.imei,
                                cookie: event.data?.cookie,
                                userAgent: event.data?.userAgent,
                                language
                            });
                            provider.sessionPresent = true;
                            log("info", "đã lưu phiên đăng nhập (nội dung phiên không được ghi log)");
                        } catch (error) {
                            recordError(error);
                            log("error", `không lưu được phiên: ${error.message}`);
                        }
                    }
                });

                provider.qr = null;
                bindApi(api);
                return true;
            } catch (error) {
                recordError(error);
                provider.qr = null;
                log("error", `đăng nhập QR thất bại: ${error.message}`);
                setStatus(ZCA_STATUS.AUTHENTICATION_REQUIRED);
                return false;
            } finally {
                qrLoginInFlight = null;
            }
        })();

        return qrLoginInFlight;
    }

    // ------------------------------------------------------------------
    // Vòng đời công khai.
    // ------------------------------------------------------------------
    async function start() {
        if (!provider.enabled) {
            setStatus(ZCA_STATUS.DISABLED);
            return { started: false, reason: "disabled" };
        }
        if (provider.starting || provider.api) return { started: true, already: true };
        provider.starting = true;

        try {
            const lock = sessionStore.acquireLock(sessionDir);
            if (!lock.ok) {
                // Không giành được khóa: KHÔNG chặn các nhà cung cấp khác, chỉ báo
                // trạng thái và dừng riêng ZCA.
                log("warn", `không giành được khóa phiên (${lock.reason}) — bỏ qua ZCA lần này`);
                setStatus(ZCA_STATUS.ERROR);
                recordError(new Error(lock.reason));
                return { started: false, reason: lock.reason };
            }
            provider.lockHeld = true;

            const session = sessionStore.readSession(sessionDir);
            provider.sessionPresent = Boolean(session);

            if (session) {
                log("info", "tìm thấy phiên đã lưu, đang khôi phục...");
                try {
                    const zalo = new Zalo({ selfListen: false, checkUpdate: false, logging: false });
                    provider.zalo = zalo;
                    const api = await zalo.login(session);
                    bindApi(api);
                    log("info", "khôi phục phiên thành công");
                    return { started: true, restored: true };
                } catch (error) {
                    // Phiên hỏng/hết hạn ⇒ xoá và yêu cầu đăng nhập lại. KHÔNG thử
                    // lại vô hạn với thông tin xác thực đã sai.
                    recordError(error);
                    log("warn", `phiên đã lưu không dùng được (${error.message}); cần đăng nhập lại bằng QR`);
                    sessionStore.clearSession(sessionDir);
                    provider.sessionPresent = false;
                    setStatus(ZCA_STATUS.AUTHENTICATION_REQUIRED);
                    return { started: false, reason: "session_invalid" };
                }
            }

            log("info", "chưa có phiên đăng nhập");
            setStatus(ZCA_STATUS.AUTHENTICATION_REQUIRED);
            return { started: false, reason: "no_session" };
        } catch (error) {
            // Bất kỳ lỗi nào ở đây cũng chỉ ảnh hưởng ZCA.
            recordError(error);
            setStatus(ZCA_STATUS.ERROR);
            log("error", `khởi động thất bại: ${error.message}`);
            return { started: false, reason: error.message };
        } finally {
            provider.starting = false;
        }
    }

    async function stop() {
        provider.stopping = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        try {
            provider.api?.listener?.stop?.();
        } catch (error) {
            log("warn", `dừng listener: ${error.message}`);
        }
        provider.api = null;
        provider.listenerConnected = false;
        provider.authenticated = false;
        provider.qr = null;
        if (provider.lockHeld) {
            sessionStore.releaseLock(sessionDir);
            provider.lockHeld = false;
        }
        setStatus(ZCA_STATUS.DISCONNECTED);
        return true;
    }

    // Gửi tin qua tài khoản Zalo cá nhân.
    //
    // zca-js KHÔNG hiểu Markdown. Nội dung gốc của ZaloBot (dùng chung với bot
    // chính thức) được chuyển tại đây thành rich text GỐC của Zalo: bỏ ký hiệu
    // định dạng khỏi văn bản và sinh `styles[]` trỏ đúng vào văn bản cuối.
    async function sendMessage(chatId, text) {
        if (!provider.api) {
            throw new Error("ZCA chưa đăng nhập nên không gửi được tin nhắn");
        }
        const threadId = String(chatId);
        // Phải biết đây là nhóm hay cá nhân để gửi đúng loại luồng. Mặc định là
        // cá nhân vì phần lớn hội thoại là chat riêng.
        const threadType = provider.threadTypes?.get(threadId) === "group" ? ThreadType.Group : ThreadType.User;

        const rendered = renderZcaRichText(String(text));
        const styledPayload = rendered.styles.length > 0
            ? { msg: rendered.text, styles: rendered.styles }
            : { msg: rendered.text };

        try {
            const result = await provider.api.sendMessage(styledPayload, threadId, threadType);
            provider.lastActivityAt = new Date().toISOString();
            return result;
        } catch (error) {
            // Zalo có thể từ chối payload có styles (ví dụ phiên bản ứng dụng
            // không hỗ trợ). Thử lại ĐÚNG MỘT LẦN bằng chính văn bản đã bỏ ký hiệu
            // định dạng — không bao giờ gửi lại nguyên Markdown, và không lặp vô hạn.
            if (rendered.styles.length === 0) throw error;
            log("warn", `gửi kèm định dạng thất bại (${error.message}), thử lại không kèm định dạng`);
            const result = await provider.api.sendMessage({ msg: rendered.text }, threadId, threadType);
            provider.lastActivityAt = new Date().toISOString();
            return result;
        }
    }

    // Gửi ảnh qua tài khoản Zalo cá nhân.
    //
    // zca-js hỗ gửi ảnh qua sendMessage với attachments. Có hai cách:
    //   1. URL công khai: AttachmentSource = string (URL)
    //   2. Buffer: AttachmentSource = { data: Buffer, filename, metadata }
    //
    // Dùng URL khi có URL công khai; dùng Buffer khi ảnh lưu local (chat images).
    provider.sendPhoto = async function sendPhoto(chatId, photoUrlOrBuffer, options = {}) {
        if (!provider.api) {
            throw new Error("ZCA chua dang nhap nen khong gui duoc anh");
        }
        const threadId = String(chatId);
        const threadType = provider.threadTypes?.get(threadId) === "group" ? ThreadType.Group : ThreadType.User;

        let attachment;
        if (Buffer.isBuffer(photoUrlOrBuffer)) {
            // Gửi từ Buffer (ảnh lưu local).
            attachment = {
                data: photoUrlOrBuffer,
                filename: options.filename || `image_${Date.now()}.jpg`,
                metadata: {
                    totalSize: photoUrlOrBuffer.length,
                    width: options.width,
                    height: options.height
                }
            };
        } else {
            // Gửi từ URL công khai.
            attachment = String(photoUrlOrBuffer);
        }

        const payload = {
            msg: options.caption || "",
            attachments: [attachment]
        };

        try {
            const result = await provider.api.sendMessage(payload, threadId, threadType);
            provider.lastActivityAt = new Date().toISOString();
            return result;
        } catch (error) {
            // Thử lại không kèm caption (một số phiên bản Zalo từ chối caption+attachment).
            if (!options.caption) throw error;
            log("warn", `gui anh kem caption that bai (${error.message}), thu lai khong caption`);
            const fallback = { attachments: [attachment] };
            const result = await provider.api.sendMessage(fallback, threadId, threadType);
            provider.lastActivityAt = new Date().toISOString();
            return result;
        }
    };

    // Cho phép nơi khác (kiểm thử, chẩn đoán) xem trước payload mà không gửi.
    provider.renderMessage = (text) => renderZcaRichText(String(text));

    // ------------------------------------------------------------------
    // Lời mời kết bạn — chỉ có nghĩa với tài khoản Zalo CÁ NHÂN.
    //
    // Đây là đường DUY NHẤT gọi API kết bạn của zca-js. Tầng nghiệp vụ
    // (friendRequestService.js) không giữ tham chiếu tới api, nhờ vậy không có
    // đường thứ hai vô tình gọi thẳng vào phiên Zalo.
    // ------------------------------------------------------------------
    provider.supportsFriendRequests = true;

    function assertApi(operation) {
        if (!provider.api) {
            const error = new Error(`ZCA chưa đăng nhập nên không ${operation} được`);
            error.code = "zca_not_authenticated";
            throw error;
        }
        return provider.api;
    }

    function apiMethod(name) {
        const api = assertApi("gọi API kết bạn");
        if (typeof api[name] !== "function") {
            const error = new Error(`Bản zca-js đang cài không có api.${name}() nên không hỗ trợ thao tác này`);
            error.code = "zca_api_unsupported";
            throw error;
        }
        return api[name].bind(api);
    }

    provider.friendApi = {
        // Danh sách lời mời ĐẾN đang chờ, theo getFriendRecommendations().
        //
        // Chỉ lọc recommType === ReceivedFriendRequest. Gợi ý kết bạn không phải
        // lời mời và không bao giờ được đưa vào đây.
        async listReceivedRequests() {
            const response = await apiMethod("getFriendRecommendations")();
            const items = Array.isArray(response?.recommItems) ? response.recommItems : [];
            return items
                .filter((item) => Number(item?.dataInfo?.recommType) === FriendRecommendationsType.ReceivedFriendRequest)
                .map(normalizeRecommendation)
                .filter((item) => item && item.userId !== provider.ownUid);
        },

        // Trạng thái quan hệ hiện tại. Đây là bước XÁC MINH bắt buộc trước khi
        // chấp nhận: một lời mời có thể đã bị người kia huỷ trong lúc ta chờ.
        async getStatus(userId) {
            const target = String(userId == null ? "" : userId).trim();
            if (!target) throw new Error("Thiếu userId để kiểm tra trạng thái kết bạn");
            return normalizeRequestStatus(await apiMethod("getFriendRequestStatus")(target));
        },

        // Chấp nhận. zca-js trả chuỗi rỗng khi thành công và NÉM LỖI khi thất bại,
        // nên "không ném" mới là bằng chứng thành công.
        async accept(userId) {
            const target = String(userId == null ? "" : userId).trim();
            if (!target) throw new Error("Thiếu userId để chấp nhận lời mời");
            await apiMethod("acceptFriendRequest")(target);
            provider.lastActivityAt = new Date().toISOString();
            return { ok: true, userId: target };
        },

        async reject(userId) {
            const target = String(userId == null ? "" : userId).trim();
            if (!target) throw new Error("Thiếu userId để từ chối lời mời");
            await apiMethod("rejectFriendRequest")(target);
            provider.lastActivityAt = new Date().toISOString();
            return { ok: true, userId: target };
        }
    };

    // Trạng thái sẵn sàng cho thao tác kết bạn — dashboard dùng để hiện cảnh báo
    // thay vì để người dùng bấm nút rồi mới báo lỗi.
    provider.friendRequestHealth = () => ({
        supported: true,
        authenticated: Boolean(provider.api) && provider.authenticated === true,
        listenerConnected: provider.listenerConnected === true,
        uid: provider.ownUid,
        lastFriendEventAt: provider.lastFriendEventAt || null
    });

    // Gửi tệp đính kèm qua tài khoản Zalo cá nhân.
    //
    // zca-js nhận tệp qua `attachments` của sendMessage, với nội dung là Buffer.
    // Đây là đường DUY NHẤT gửi được tệp cho ZCA: URL công khai của dashboard là
    // http://localhost:<port>, máy chủ Zalo không tải được.
    provider.sendFile = async function sendFile(chatId, buffer, options = {}) {
        if (!provider.api) {
            throw new Error("ZCA chua dang nhap nen khong gui duoc tep");
        }
        if (!Buffer.isBuffer(buffer)) {
            throw new Error("ZCA chi gui duoc tep tu Buffer");
        }
        const threadId = String(chatId);
        const threadType = provider.threadTypes?.get(threadId) === "group" ? ThreadType.Group : ThreadType.User;
        const filename = String(options.filename || `tepdinhkem_${Date.now()}.bin`);

        const payload = {
            msg: options.caption || "",
            attachments: [{
                data: buffer,
                filename,
                metadata: { totalSize: buffer.length }
            }]
        };

        try {
            const result = await provider.api.sendMessage(payload, threadId, threadType);
            provider.lastActivityAt = new Date().toISOString();
            return result;
        } catch (error) {
            // Một số phiên bản Zalo từ chối caption kèm tệp: thử lại không caption.
            if (!options.caption) throw error;
            log("warn", `gui tep kem caption that bai (${error.message}), thu lai khong caption`);
            const fallback = {
                attachments: [{ data: buffer, filename, metadata: { totalSize: buffer.length } }]
            };
            const result = await provider.api.sendMessage(fallback, threadId, threadType);
            provider.lastActivityAt = new Date().toISOString();
            return result;
        }
    };

    // Ghi nhớ loại luồng của từng chat để lần gửi sau dùng đúng.
    provider.threadTypes = new Map();
    provider.rememberThread = (chatId, chatType) => {
        if (chatId) provider.threadTypes.set(String(chatId), chatType === "group" ? "group" : "private");
    };

    provider.sendMessage = sendMessage;
    provider.start = start;
    provider.stop = stop;
    provider.beginQrLogin = beginQrLogin;
    // Tên tài khoản, hỏi Zalo khi đã đăng nhập.
    //
    // TRƯỚC ĐÂY hàm này luôn trả null, nên resolveBotNames() luôn ghi
    // "[zca:pending]: không lấy được tên; dùng nhãn cấu hình." — kể cả khi tài khoản
    // hoàn toàn bình thường. Đó là vấn đề TÊN HIỂN THỊ, không phải lỗi kết nối.
    //
    // Chưa đăng nhập thì trả null một cách có chủ ý (chưa có gì để hỏi), và
    // isReadyForName() bên dưới giúp nơi gọi phân biệt "chưa sẵn sàng" với "hỏng".
    provider.fetchIdentityName = async () => {
        if (!provider.authenticated || !provider.api) return null;
        if (typeof provider.api.fetchAccountInfo !== "function") return null;
        const info = await provider.api.fetchAccountInfo();
        const profile = info && info.profile ? info.profile : null;
        if (!profile) return null;
        return profile.displayName || profile.zaloName || null;
    };

    // Tên chỉ lấy được sau khi đăng nhập xong. Nơi gọi dùng cờ này để KHÔNG báo lỗi
    // khi nhà cung cấp còn đang chờ đăng nhập, và để thử lại sau khi đã sẵn sàng.
    provider.isReadyForName = () => provider.authenticated === true && Boolean(provider.api);

    // Xoá phiên đã lưu. Dùng khi phiên hỏng hoặc khi muốn đăng nhập tài khoản khác.
    provider.clearSession = () => {
        const cleared = sessionStore.clearSession(sessionDir);
        provider.sessionPresent = false;
        provider.authenticated = false;
        provider.listenerConnected = false;
        provider.qr = null;
        setStatus(ZCA_STATUS.AUTHENTICATION_REQUIRED);
        return cleared;
    };

    provider.getIdentity = () => ({
        providerType: PROVIDER_TYPES.ZCA,
        botId: provider.botId || "zca:unknown",
        displayName: provider.displayName,
        label: formatBotLabel(provider),
        isPersonalAccount: true,
        uid: provider.ownUid,
        // Không có token: đây là tài khoản cá nhân, không phải bot có token.
        tokenSource: null,
        tokenFingerprint: null
    });

    provider.getStatus = () => ({
        botId: provider.botId || "zca:unknown",
        providerType: PROVIDER_TYPES.ZCA,
        status: provider.status,
        enabled: provider.enabled,
        isPersonalAccount: true,
        uid: provider.ownUid,
        authenticated: provider.authenticated,
        listenerConnected: provider.listenerConnected,
        sessionPresent: provider.sessionPresent,
        qrPending: Boolean(provider.qr),
        reconnectAttempts: provider.reconnectAttempts,
        lastConnectedAt: provider.lastConnectedAt,
        lastDisconnectedAt: provider.lastDisconnectedAt,
        lastActivityAt: provider.lastActivityAt,
        lastError: provider.lastError,
        lastErrorAt: provider.lastErrorAt
    });

    provider.health = () => ({
        status: provider.status,
        authenticated: provider.authenticated,
        listenerConnected: provider.listenerConnected,
        lastError: provider.lastError,
        lastErrorAt: provider.lastErrorAt
    });

    // QR cho dashboard. KHÔNG trả cookie/imei.
    provider.getQr = () => (provider.qr ? { ...provider.qr } : null);
    provider.describeSession = () => sessionStore.describeSession(sessionDir);

    return provider;
}

module.exports = {
    CLOSE_REASON_HINTS,
    ZCA_STATUS,
    createZcaProvider,
    describeCloseReason,
    mapFriendEvent,
    normalizeRecommendation,
    normalizeRequestStatus,
    toIsoFromEpoch
};
