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
// ============================================================================
const { Zalo, ThreadType } = require("zca-js");
const { PROVIDER_TYPES, formatBotLabel, zcaId } = require("../../bots");
const adapter = require("./zcaMessageAdapter");
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

function createZcaProvider(options = {}) {
    const {
        enabled = false,
        sessionDir = sessionStore.resolveSessionDir(options.sessionPath),
        autoReconnect = true,
        language = "vi",
        onMessage = null,
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

    async function sendMessage(chatId, text) {
        if (!provider.api) {
            throw new Error("ZCA chưa đăng nhập nên không gửi được tin nhắn");
        }
        const threadId = String(chatId);
        // Phải biết đây là nhóm hay cá nhân để gửi đúng loại luồng. Mặc định là
        // cá nhân vì phần lớn hội thoại là chat riêng.
        const threadType = provider.threadTypes?.get(threadId) === "group" ? ThreadType.Group : ThreadType.User;
        const result = await provider.api.sendMessage(String(text), threadId, threadType);
        provider.lastActivityAt = new Date().toISOString();
        return result;
    }

    // Ghi nhớ loại luồng của từng chat để lần gửi sau dùng đúng.
    provider.threadTypes = new Map();
    provider.rememberThread = (chatId, chatType) => {
        if (chatId) provider.threadTypes.set(String(chatId), chatType === "group" ? "group" : "private");
    };

    provider.sendMessage = sendMessage;
    provider.start = start;
    provider.stop = stop;
    provider.beginQrLogin = beginQrLogin;
    provider.fetchIdentityName = async () => null;   // tên tài khoản đến từ QR/phiên

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

module.exports = { CLOSE_REASON_HINTS, ZCA_STATUS, createZcaProvider, describeCloseReason };
