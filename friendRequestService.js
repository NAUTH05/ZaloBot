// ============================================================================
// Quản lý lời mời kết bạn Zalo cho tài khoản ZCA (Zalo cá nhân).
//
// Nhiệm vụ:
//   1. Phát hiện lời mời đến — qua sự kiện `friend_event` VÀ qua vòng đồng bộ.
//   2. Lưu bền, chống trùng, chống xử lý hai lần.
//   3. Thông báo cho quản trị viên qua HAI kênh độc lập (bot chính thức, ZCA).
//   4. Chấp nhận/từ chối có xác minh trước và sau khi gọi API.
//   5. Tự động chấp nhận theo hạn mức an toàn (nếu bật).
//
// Nguyên tắc sống còn:
//   - KHÔNG báo thành công trước khi nhà cung cấp xác nhận.
//   - Lỗi thông báo KHÔNG được làm mất lời mời; lỗi một kênh KHÔNG được xoá dấu
//     kênh kia đã gửi.
//   - Chỉ tài khoản ZCA mới xử lý được lời mời kết bạn. Bot chính thức không có
//     khái niệm lời mời kết bạn và không bao giờ được gọi vào đây.
//   - Mọi phụ thuộc bên ngoài được TIÊM vào, nên toàn bộ quy tắc kiểm thử được
//     mà không cần zca-js, không cần Firestore thật, không cần mạng.
// ============================================================================
const fr = require("./friendRequests");

const {
    HANDLING_MODE,
    NOTIFICATION_CHANNEL,
    NOTIFICATION_KIND,
    NOTIFICATION_STATUS,
    PROCESSED_METHOD,
    REQUEST_STATUS,
    RETRYABLE_STATUSES
} = fr;

// Trần số ứng viên xử lý trong một lượt đồng bộ. Danh sách gợi ý của Zalo có thể
// dài; mỗi ứng viên cần một lần gọi kiểm tra trạng thái, nên phải có trần để
// không biến một nhịp đồng bộ thành vài chục request.
const MAX_SYNC_CANDIDATES = 30;

// Trạng thái được phép bắt đầu một thao tác chấp nhận/từ chối.
//
// `cancelled` cũng nằm trong đây: nếu một lời mời bị đánh dấu huỷ OAN (cờ trạng
// thái của Zalo không đáng tin), quản trị viên phải có đường thử lại thay vì bị
// khoá vĩnh viễn ở một trạng thái sai.
const OPERABLE_STATUSES = [
    REQUEST_STATUS.PENDING,
    REQUEST_STATUS.CANCELLED,
    REQUEST_STATUS.FAILED,
    REQUEST_STATUS.REQUIRES_VERIFICATION
];

// Người này còn nằm trong danh sách lời mời ĐẾN của Zalo hay không.
//
// Đây là bằng chứng dương duy nhất đủ để kết luận "lời mời đã biến mất". Trả
// `null` khi không đọc được — và nơi gọi phải coi `null` là "chưa biết", không
// phải "không còn".
async function stillListedAsIncoming(account, userId) {
    if (!account?.friendApi?.listReceivedRequests) return null;
    try {
        const list = await account.friendApi.listReceivedRequests();
        return list.some((item) => String(item.userId) === String(userId));
    } catch (_) {
        return null;
    }
}

// Trạng thái quan hệ có nói "còn lời mời đang chờ" hay không.
//
// Đọc cả `hasPendingRequest` (nhà cung cấp tính sẵn) lẫn hai cờ gốc, để nơi cung
// cấp trạng thái không đầy đủ (ví dụ trong kiểm thử) vẫn cho kết quả đúng thay vì
// âm thầm rơi vào nhánh "đã thu hồi".
function pendingEvidence(status) {
    if (!status) return false;
    if (typeof status.hasPendingRequest === "boolean") return status.hasPendingRequest;
    return !status.isFriend && Boolean(status.incomingRequest || status.outgoingRequest);
}

// Chờ ngắn giữa hai lần đọc lại trạng thái.
//
// KHÔNG `unref()` timer này: đó là một khoảng chờ NGẮN nằm trong một thao tác đang
// chạy, nên nó phải giữ event loop sống. `unref()` khiến Node coi như không còn
// việc gì và kết thúc vòng lặp trong lúc promise còn treo ("Promise resolution is
// still pending but the event loop has already resolved") — thao tác chấp nhận
// biến mất giữa chừng.
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Xác nhận hai bên đã là bạn, đọc lại NHIỀU LẦN.
//
// Vì sao không đọc một lần: `acceptFriendRequest()` trả về ngay khi Zalo nhận lệnh,
// nhưng trạng thái quan hệ cần vài giây mới cập nhật. Đọc đúng một lần rồi kết
// luận "thất bại" đã biến một lần chấp nhận THÀNH CÔNG thành lỗi — đúng sự cố
// "tự động chấp nhận bị lỗi, phải accept bằng tay".
//
// Trả về:
//   { state: "friend" }      — đã là bạn (xác nhận được)
//   { state: "not_friend" }  — đọc được, và Zalo nói chưa phải bạn
//   { state: "unknown" }     — không đọc được lần nào; KHÔNG phải bằng chứng thất bại
async function confirmFriendship(account, userId, options = {}) {
    const delays = Array.isArray(options.delays) ? options.delays : [1200, 2500];
    let lastError = null;
    let readOk = false;

    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
        if (attempt > 0) await sleep(delays[attempt - 1]);
        try {
            const status = await account.friendApi.getStatus(userId);
            readOk = true;
            lastError = null;
            if (status.isFriend) return { state: "friend" };
        } catch (error) {
            lastError = error?.message || String(error);
        }
    }

    return { state: readOk ? "not_friend" : "unknown", error: lastError };
}

function createFriendRequestService(deps = {}) {
    const {
        // Danh sách nhà cung cấp ZCA đang đăng ký.
        listAccounts = () => [],
        // Lấy một nhà cung cấp theo botId. Phải trả null nếu không phải ZCA.
        getAccount = () => null,
        // Gửi thông báo cho quản trị viên qua MỘT kênh.
        // Trả { ok, chatId, botId, error, skipped }.
        notify = async () => ({ ok: false, skipped: true, error: "chưa cấu hình kênh thông báo" }),
        // Gửi tin chào tới người vừa được chấp nhận. Trả { ok, error }.
        sendWelcome = async () => ({ ok: false, skipped: true }),
        // Tình trạng người nhận của từng kênh, để dashboard hiển thị. Không bắt buộc.
        describeRecipients = () => ({}),
        // Ghi audit. Không bắt buộc.
        audit = () => {},
        log = () => {},
        // Đường dẫn tùy chọn cho kiểm thử.
        requestsPath = undefined,
        settingsPath = undefined,
        // Khoảng chờ giữa các lần đọc lại trạng thái kết bạn. Kiểm thử đặt [0, 0]
        // để không phải chờ vài giây cho mỗi ca.
        confirmDelays = [1200, 2500]
    } = deps;

    const paths = {
        requests: requestsPath || fr.FILE_PATH,
        settings: settingsPath || fr.SETTINGS_FILE_PATH
    };

    // Khóa đồng bộ theo tài khoản: listener, nhịp định kỳ và nút Làm mới có thể
    // cùng gọi. Chỉ một lượt chạy cho mỗi tài khoản tại một thời điểm.
    const syncLocks = new Map();

    // Khóa thao tác theo lời mời: chống hai lần bấm Chấp nhận.
    const inFlight = new Set();

    // Trạng thái tạm của bộ tự động chấp nhận. Mất khi restart — đó là chủ ý:
    // restart là một lần "thử lại từ đầu", còn hạn mức theo giờ vẫn đọc từ dữ
    // liệu đã lưu nên không thể vượt trần sau khi khởi động lại.
    const autoState = {
        suspended: false,
        suspendedReason: null,
        suspendedAt: null,
        consecutiveErrors: 0
    };

    let scheduler = null;
    let started = false;

    const store = {
        list: (options) => fr.listRecordsFiltered(options || {}, paths.requests),
        pending: (options) => fr.listPending(options || {}, paths.requests),
        history: (options) => fr.listHistory(options || {}, paths.requests),
        get: (requestId) => fr.getRecord(requestId, paths.requests),
        settings: () => fr.getSettings(paths.settings)
    };

    // ------------------------------------------------------------------
    // Thông báo
    // ------------------------------------------------------------------

    // Gửi thông báo cho cả hai kênh đang bật, ghi kết quả RIÊNG từng kênh.
    //
    // Bỏ qua kênh đã gửi thành công cho cùng lời mời + cùng loại thông báo. Nhờ
    // vậy listener và vòng đồng bộ cùng phát hiện một lời mời cũng chỉ báo một lần,
    // và restart không gửi lại.
    async function deliverNotifications(request, account, kind, options = {}) {
        const settings = store.settings();
        const results = {};
        // Lấy lại bản ghi mới nhất: trạng thái thông báo có thể vừa được ghi bởi
        // một luồng khác.
        const fresh = store.get(request.requestId) || request;

        for (const channel of [NOTIFICATION_CHANNEL.OFFICIAL, NOTIFICATION_CHANNEL.ZCA]) {
            const config = settings.notifications?.[channel] || {};
            if (config.enabled !== true) {
                results[channel] = { skipped: true, reason: "channel_disabled" };
                continue;
            }
            if (fr.hasNotified(fresh, channel, kind) && !options.force) {
                results[channel] = { skipped: true, reason: "already_sent" };
                continue;
            }

            let outcome;
            try {
                outcome = await notify({ channel, kind, request: fresh, account });
            } catch (error) {
                outcome = { ok: false, error: error?.message || String(error) };
            }
            const result = outcome || { ok: false, error: "không có phản hồi" };

            if (result.skipped) {
                results[channel] = { skipped: true, reason: result.reason || "skipped" };
                continue;
            }

            const status = result.ok ? NOTIFICATION_STATUS.SENT : NOTIFICATION_STATUS.FAILED;
            fr.setNotificationResult(fresh.requestId, channel, {
                kind,
                status,
                chatId: result.chatId || null,
                botId: result.botId || null,
                error: result.ok ? null : (result.error || "gửi thất bại")
            }, paths.requests);

            results[channel] = {
                ok: Boolean(result.ok),
                status,
                chatId: result.chatId || null,
                error: result.ok ? null : (result.error || "gửi thất bại")
            };

            if (!result.ok) {
                // Không ném: lời mời vẫn phải còn nguyên và vẫn chấp nhận được.
                log("warn", `thông báo ${channel} cho ${fresh.requestId} thất bại: ${result.error || "không rõ"}`);
            }
        }
        return results;
    }

    // ------------------------------------------------------------------
    // Chấp nhận / từ chối
    // ------------------------------------------------------------------

    // Thao tác chung cho chấp nhận và từ chối.
    //
    // `action` = "accept" | "reject". Mọi bước xác minh nằm ở đây để hai đường
    // không thể lệch nhau.
    async function processRequest(requestId, action, options = {}) {
        const method = options.method === PROCESSED_METHOD.AUTO ? PROCESSED_METHOD.AUTO : PROCESSED_METHOD.MANUAL;
        const actor = options.actor ? String(options.actor).slice(0, 120) : (method === PROCESSED_METHOD.AUTO ? "auto" : "admin");
        const record = store.get(requestId);

        if (!record) return { ok: false, reason: "not_found", error: "Không tìm thấy lời mời này." };
        if (!OPERABLE_STATUSES.includes(record.status)) {
            return {
                ok: false,
                reason: "already_processed",
                error: `Lời mời đã ở trạng thái "${record.status}" nên không thao tác lại được.`,
                record
            };
        }

        // Khóa theo lời mời: lần bấm thứ hai nhận "đang xử lý" thay vì gọi Zalo
        // lần nữa.
        if (inFlight.has(requestId)) {
            return { ok: false, reason: "in_progress", error: "Lời mời này đang được xử lý." };
        }

        const account = getAccount(record.accountId);
        if (!account || !account.friendApi) {
            // Không đánh dấu thất bại: tài khoản có thể chỉ đang mất kết nối. Giữ
            // nguyên lời mời để xử lý lại khi phiên sống lại.
            return { ok: false, reason: "account_offline", error: "Tài khoản ZCA của lời mời này không khả dụng." };
        }

        // Tài khoản đang ngắt kết nối: DỪNG, không thử gọi Zalo và không đụng vào
        // bản ghi. Gọi vào một phiên đã đóng sẽ ném lỗi và biến một lời mời bình
        // thường thành "cần kiểm tra" — sai hoàn toàn, vì chưa có gì được thử.
        const health = typeof account.friendRequestHealth === "function"
            ? account.friendRequestHealth()
            : { authenticated: account.authenticated === true };
        if (!health.authenticated) {
            return {
                ok: false,
                reason: "account_offline",
                error: "Tài khoản ZCA đang mất kết nối nên chưa xử lý được. Lời mời vẫn được giữ nguyên."
            };
        }

        inFlight.add(requestId);
        try {
            // Đánh dấu "đang xử lý" TRƯỚC khi gọi Zalo, có kiểm tra trạng thái
            // hiện tại: hai request đồng thời không thể cùng chiếm một lời mời.
            const claim = fr.applyTransition(requestId, REQUEST_STATUS.PROCESSING, {
                method,
                processedBy: actor,
                incrementAttempts: true,
                expectedStatuses: OPERABLE_STATUSES
            }, paths.requests);
            if (!claim.ok) {
                return {
                    ok: false,
                    reason: claim.reason || "already_processed",
                    error: "Lời mời vừa được xử lý bởi thao tác khác.",
                    record: claim.record || record
                };
            }

            // --- Bước 1: xác minh trạng thái hiện tại -------------------------
            let status;
            try {
                status = await account.friendApi.getStatus(record.userId);
            } catch (error) {
                const message = error?.message || String(error);
                fr.applyTransition(requestId, REQUEST_STATUS.REQUIRES_VERIFICATION, {
                    method,
                    processedBy: actor,
                    error: message,
                    note: "không kiểm tra được trạng thái kết bạn"
                }, paths.requests);
                await deliverNotifications(store.get(requestId) || record, account, NOTIFICATION_KIND.FAILED);
                return { ok: false, reason: "verification_failed", error: message };
            }

            if (status.isFriend) {
                // Đã là bạn (ví dụ được chấp nhận ở nơi khác). Không gọi API lần nữa.
                const done = fr.applyTransition(requestId, REQUEST_STATUS.ALREADY_FRIENDS, {
                    method,
                    processedBy: actor,
                    note: "Zalo báo hai bên đã là bạn"
                }, paths.requests);
                audit("friend_request.already_friends", { requestId, actor, method });
                return { ok: true, status: REQUEST_STATUS.ALREADY_FRIENDS, record: done.record, alreadyFriends: true };
            }

            // Chỉ kết luận "đã thu hồi" khi có BẰNG CHỨNG DƯƠNG.
            //
            // Cờ is_requested/is_requesting của Zalo đã từng trả 0 cho một lời mời
            // vẫn còn sống, khiến lời mời thật bị đánh dấu "đã thu hồi" và không
            // bao giờ chấp nhận được. Vì vậy cờ chỉ là gợi ý: cờ nói "không chờ"
            // thì phải kiểm lại danh sách lời mời đến rồi mới dám huỷ.
            if (action === "accept" && !pendingEvidence(status)) {
                const listed = await stillListedAsIncoming(account, record.userId);
                if (listed === false) {
                    const done = fr.applyTransition(requestId, REQUEST_STATUS.CANCELLED, {
                        method: PROCESSED_METHOD.SYSTEM,
                        processedBy: actor,
                        note: "lời mời không còn trong danh sách chờ của Zalo"
                    }, paths.requests);
                    audit("friend_request.cancelled", { requestId, actor, method });
                    return {
                        ok: false,
                        reason: "not_pending",
                        error: "Lời mời không còn chờ nữa (người gửi có thể đã thu hồi).",
                        record: done.record
                    };
                }
                // listed === true: cờ sai, lời mời vẫn còn ⇒ tiếp tục.
                // listed === null: không đọc được ⇒ thà để Zalo từ chối (failed,
                // thử lại được) còn hơn tự huỷ một lời mời thật.
                log("warn", `cờ trạng thái nói lời mời ${record.userId} không còn chờ, nhưng danh sách Zalo nói khác — vẫn thử chấp nhận`);
            }

            // --- Bước 2: gọi API thật ----------------------------------------
            try {
                if (action === "accept") {
                    await account.friendApi.accept(record.userId);
                } else {
                    await account.friendApi.reject(record.userId);
                }
            } catch (error) {
                const message = error?.message || String(error);
                const failed = fr.applyTransition(requestId, REQUEST_STATUS.FAILED, {
                    method,
                    processedBy: actor,
                    error: message,
                    note: action === "accept" ? "Zalo từ chối chấp nhận" : "Zalo từ chối từ chối"
                }, paths.requests);

                if (method === PROCESSED_METHOD.AUTO) {
                    autoState.consecutiveErrors += 1;
                    const limit = store.settings().autoAccept.suspendAfterErrors;
                    if (autoState.consecutiveErrors >= limit && !autoState.suspended) {
                        autoState.suspended = true;
                        autoState.suspendedReason = `tạm dừng sau ${autoState.consecutiveErrors} lỗi liên tiếp từ Zalo`;
                        autoState.suspendedAt = new Date().toISOString();
                        log("warn", `tự động chấp nhận bị TẠM DỪNG: ${autoState.suspendedReason}`);
                    }
                }

                await deliverNotifications(failed.record || record, account, NOTIFICATION_KIND.FAILED);
                audit("friend_request.failed", { requestId, actor, method, error: message });
                return { ok: false, reason: "provider_error", error: message, record: failed.record };
            }

            // --- Bước 3: xác nhận kết quả ------------------------------------
            //
            // Zalo nhận lệnh ngay nhưng trạng thái quan hệ cập nhật chậm, nên phải
            // đọc lại nhiều lần. Đọc lại lỗi KHÔNG biến một lần chấp nhận thành
            // công thành thất bại.
            if (action === "reject") {
                // Chỉ nhánh từ chối mới cần đọc trạng thái ngay tại đây; nhánh chấp
                // nhận dùng confirmFriendship() bên dưới. Đọc thêm một lần nữa chỉ
                // tốn request mà không thêm thông tin.
                let confirmed = null;
                try {
                    confirmed = await account.friendApi.getStatus(record.userId);
                } catch (_) {
                    confirmed = null;
                }
                const done = fr.applyTransition(requestId, REQUEST_STATUS.REJECTED, {
                    method,
                    processedBy: actor,
                    note: confirmed && pendingEvidence(confirmed) ? "đã từ chối; Zalo chưa cập nhật trạng thái" : "đã từ chối"
                }, paths.requests);
                audit("friend_request.rejected", { requestId, actor, method });
                return { ok: true, status: REQUEST_STATUS.REJECTED, record: done.record };
            }

            let confirmation = await confirmFriendship(account, record.userId, { delays: confirmDelays });

            if (confirmation.state === "not_friend") {
                // Sự kiện kết bạn có thể tới TRƯỚC khi Zalo ghi nhận lời mời ở phía
                // máy chủ, nên lần gọi accept đầu tiên có thể không có tác dụng.
                // Gọi lại một lần là an toàn: chấp nhận một lời mời đã được chấp
                // nhận không tạo thêm hệ quả nào.
                log("warn", `chưa thấy ${record.userId} trở thành bạn sau lần chấp nhận đầu — gọi lại một lần`);
                try {
                    await account.friendApi.accept(record.userId);
                } catch (error) {
                    log("warn", `gọi lại chấp nhận thất bại: ${error.message}`);
                }
                confirmation = await confirmFriendship(account, record.userId, { delays: confirmDelays });
            }

            if (confirmation.state === "not_friend") {
                // Đọc được trạng thái, và Zalo vẫn nói chưa phải bạn. Không được báo
                // "đã kết bạn" — nhưng PHẢI ghi lý do, nếu không thông báo sẽ chỉ
                // nói "gặp lỗi" mà không ai biết vì sao.
                const reason = "Zalo nhận lệnh chấp nhận nhưng sau vài giây vẫn báo chưa phải bạn";
                const done = fr.applyTransition(requestId, REQUEST_STATUS.REQUIRES_VERIFICATION, {
                    method,
                    processedBy: actor,
                    error: reason,
                    note: reason
                }, paths.requests);
                await deliverNotifications(done.record || record, account, NOTIFICATION_KIND.UNCONFIRMED);
                audit("friend_request.requires_verification", { requestId, actor, method, error: reason });
                return {
                    ok: false,
                    reason: "unconfirmed",
                    error: reason,
                    record: done.record
                };
            }

            const done = fr.applyTransition(requestId, REQUEST_STATUS.ACCEPTED, {
                method,
                processedBy: actor,
                note: confirmation.state === "friend"
                    ? "đã chấp nhận (Zalo xác nhận đã là bạn)"
                    : "đã chấp nhận; chưa đọc lại được trạng thái để xác nhận"
            }, paths.requests);

            autoState.consecutiveErrors = 0;
            audit("friend_request.accepted", { requestId, actor, method });
            log("info", `đã chấp nhận lời mời của ${record.displayName || record.userId} (${method})`);

            // Tin chào CHỈ sau khi đã chấp nhận thật. Lỗi gửi tin chào không được
            // làm hỏng trạng thái kết bạn vừa có.
            await maybeSendWelcome(done.record || record, account);

            if (method === PROCESSED_METHOD.AUTO) {
                const settings = store.settings();
                if (settings.autoAccept.notifyOnSuccess) {
                    await deliverNotifications(done.record || record, account, NOTIFICATION_KIND.ACCEPTED);
                }
            }

            return { ok: true, status: REQUEST_STATUS.ACCEPTED, record: done.record };
        } finally {
            inFlight.delete(requestId);
        }
    }

    // Tin chào chỉ gửi MỘT lần cho mỗi lời mời đã được chấp nhận.
    //
    // `force` dùng cho nút "Gửi tin chào" của quản trị viên: gửi lại theo yêu cầu
    // là hành động có chủ ý, khác với việc tự động gửi trùng.
    async function maybeSendWelcome(record, account, options = {}) {
        const settings = store.settings();
        if (settings.welcome.enabled !== true) {
            return { skipped: true, reason: "welcome_disabled" };
        }
        const message = String(settings.welcome.message || "").trim();
        if (!message) return { skipped: true, reason: "welcome_empty" };

        // GIÀNH QUYỀN GỬI trước, rồi mới gửi.
        //
        // Khóa ghi nhận là "zca:welcome" (kênh + loại), KHÔNG phải "welcome" —
        // đọc sai khóa thì bước chống gửi trùng không bao giờ chạy.
        //
        // Phải giành TRƯỚC khi gửi, không phải ghi dấu sau khi gửi: giữa hai thời
        // điểm đó, đường lời chào (khi người kia nhắn tin ngay sau khi được chấp
        // nhận) cũng thấy "chưa gửi" và gửi thêm một tin giống hệt.
        if (!options.force) {
            const claimed = fr.claimNotification(record.requestId, NOTIFICATION_CHANNEL.ZCA, "welcome", paths.requests);
            if (!claimed) return { skipped: true, reason: "already_sent" };
        }

        let outcome;
        try {
            outcome = await sendWelcome({ account, request: record, message });
        } catch (error) {
            outcome = { ok: false, error: error?.message || String(error) };
        }
        const result = outcome || { ok: false, error: "không có phản hồi" };
        if (result.skipped) {
            // Kênh tự bỏ qua (chưa đăng nhập, không có người nhận...). Phải NHẢ
            // quyền gửi, nếu không khóa "đang gửi" treo lại và lần gửi sau bị chặn.
            fr.releaseNotificationClaim(record.requestId, NOTIFICATION_CHANNEL.ZCA, "welcome", paths.requests);
            return result;
        }

        // Ghi riêng, không đụng tới kết quả thông báo quản trị viên.
        fr.setNotificationResult(record.requestId, NOTIFICATION_CHANNEL.ZCA, {
            kind: "welcome",
            status: result.ok ? NOTIFICATION_STATUS.SENT : NOTIFICATION_STATUS.FAILED,
            chatId: record.userId,
            error: result.ok ? null : (result.error || "gửi tin chào thất bại")
        }, paths.requests);
        if (!result.ok) {
            log("warn", `gửi tin chào cho ${record.userId} thất bại: ${result.error || "không rõ"}`);
        }
        return result;
    }

    // ------------------------------------------------------------------
    // Tự động chấp nhận
    // ------------------------------------------------------------------

    function autoAcceptState() {
        return {
            enabled: fr.autoAcceptEnabled(store.settings()),
            suspended: autoState.suspended,
            suspendedReason: autoState.suspendedReason,
            suspendedAt: autoState.suspendedAt,
            consecutiveErrors: autoState.consecutiveErrors
        };
    }

    // Kiểm tra hạn mức TRƯỚC khi gọi Zalo. Chỉ trả về lý do từ chối, không tự
    // quyết định gì thêm — nơi gọi dùng đúng kết quả này.
    function checkAutoAcceptLimits() {
        const settings = store.settings();
        if (!fr.autoAcceptEnabled(settings)) return { allowed: false, reason: "mode_not_auto" };
        if (autoState.suspended) return { allowed: false, reason: "suspended", detail: autoState.suspendedReason };

        const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const used = fr.countAutoAcceptsSince(sinceIso, paths.requests);
        if (used >= settings.autoAccept.maxPerHour) {
            return { allowed: false, reason: "hourly_limit", detail: `${used}/${settings.autoAccept.maxPerHour} trong một giờ` };
        }

        const last = fr.lastAutoAcceptAt(paths.requests);
        if (last) {
            const elapsed = Date.now() - Date.parse(last);
            if (Number.isFinite(elapsed) && elapsed < settings.autoAccept.minIntervalMs) {
                return {
                    allowed: false,
                    reason: "too_soon",
                    detail: `cần chờ ${Math.ceil((settings.autoAccept.minIntervalMs - elapsed) / 1000)}s`
                };
            }
        }
        return { allowed: true };
    }

    // ------------------------------------------------------------------
    // Phát hiện lời mời
    // ------------------------------------------------------------------

    // Một lời mời vừa được phát hiện: lưu xong thì thông báo, rồi (nếu bật) tự
    // động chấp nhận. Thứ tự này quan trọng — lời mời phải nằm trong kho TRƯỚC
    // khi bất cứ điều gì có thể thất bại.
    async function onDetected(record, account, source) {
        if (!record) return { notified: null, auto: null };
        const fresh = store.get(record.requestId) || record;

        const notified = await deliverNotifications(fresh, account, NOTIFICATION_KIND.NEW_REQUEST);

        let auto = null;
        const limits = checkAutoAcceptLimits();
        if (limits.allowed) {
            auto = await processRequest(fresh.requestId, "accept", {
                method: PROCESSED_METHOD.AUTO,
                actor: "auto"
            });
        } else if (fr.autoAcceptEnabled(store.settings())) {
            auto = { ok: false, reason: limits.reason, detail: limits.detail };
            log("info", `bỏ qua tự động chấp nhận ${fresh.requestId}: ${limits.reason}${limits.detail ? ` (${limits.detail})` : ""}`);
        }
        return { notified, auto, source };
    }

    // Sự kiện kết bạn từ listener. Chỉ xử lý sự kiện của CHÍNH tài khoản nhận.
    async function handleEvent(botId, event) {
        const account = getAccount(botId);
        if (!account || !event || !event.userId) return { ok: false, reason: "ignored" };

        if (event.type === "request") {
            const result = fr.upsertDetected({
                accountId: account.botId,
                userId: event.userId,
                message: event.message,
                source: "event"
            }, paths.requests);

            // Sự kiện không mang tên/ảnh. Lấy hồ sơ từ danh sách lời mời để thông
            // báo có tên thay vì chỉ có số. Lỗi ở bước làm đẹp này không được làm
            // hỏng việc ghi nhận.
            if (result.isNew) {
                try {
                    const candidates = await account.friendApi.listReceivedRequests();
                    const match = candidates.find((item) => item.userId === String(event.userId));
                    if (match) {
                        fr.upsertDetected({
                            accountId: account.botId,
                            userId: event.userId,
                            displayName: match.displayName,
                            avatar: match.avatar,
                            message: match.message || event.message,
                            requestedAt: match.requestedAt,
                            source: "event"
                        }, paths.requests);
                    }
                } catch (error) {
                    log("warn", `không lấy được hồ sơ cho lời mời ${event.userId}: ${error.message}`);
                }
            }

            if (!result.isNew) {
                // Đã biết lời mời này. Không thông báo lại, nhưng vẫn cho tự động
                // chấp nhận nếu lần trước bị chặn bởi hạn mức.
                if (fr.autoAcceptEnabled(store.settings()) && fr.isOpen(store.get(result.record.requestId))) {
                    const limits = checkAutoAcceptLimits();
                    if (limits.allowed) {
                        const auto = await processRequest(result.record.requestId, "accept", {
                            method: PROCESSED_METHOD.AUTO,
                            actor: "auto"
                        });
                        return { ok: true, duplicate: true, auto };
                    }
                }
                return { ok: true, duplicate: true };
            }

            const outcome = await onDetected(result.record, account, "event");
            return { ok: true, isNew: true, reopened: result.reopened, ...outcome };
        }

        if (event.type === "withdrawn" || event.type === "rejected") {
            // Người gửi huỷ lời mời. Phải đóng bản ghi, nếu không dashboard vẫn
            // hiện một lời mời không thể chấp nhận được.
            const requestId = fr.buildRequestId(account.botId, event.userId);
            const record = store.get(requestId);
            if (!record || !fr.isOpen(record)) return { ok: true, ignored: true };
            fr.applyTransition(requestId, REQUEST_STATUS.CANCELLED, {
                method: PROCESSED_METHOD.SYSTEM,
                note: event.type === "withdrawn" ? "người gửi đã thu hồi lời mời" : "lời mời đã bị từ chối"
            }, paths.requests);
            audit("friend_request.cancelled", { requestId, reason: event.type });
            return { ok: true, cancelled: true };
        }

        if (event.type === "friend_added") {
            // Có thể việc kết bạn xảy ra ngoài hệ thống (chấp nhận trên điện thoại).
            // Ghi nhận cho đúng lịch sử thay vì để bản ghi treo ở "đang chờ".
            const requestId = fr.buildRequestId(account.botId, event.userId);
            const record = store.get(requestId);
            if (!record || !fr.isOpen(record)) return { ok: true, ignored: true };
            fr.applyTransition(requestId, REQUEST_STATUS.ACCEPTED, {
                method: PROCESSED_METHOD.SYSTEM,
                note: "Zalo báo đã trở thành bạn (xử lý ngoài hệ thống)"
            }, paths.requests);
            return { ok: true, accepted: true };
        }

        return { ok: true, ignored: true };
    }

    // ------------------------------------------------------------------
    // Đồng bộ
    // ------------------------------------------------------------------

    // Đọc danh sách lời mời đang chờ từ Zalo và XÁC MINH từng mục.
    //
    // Bước xác minh là bắt buộc: getFriendRecommendations() trả cả gợi ý kết bạn
    // và lời mời đã xử lý. Chỉ những người thật sự đang chờ mới được ghi nhận.
    async function syncAccount(botId, options = {}) {
        const account = getAccount(botId);
        if (!account || !account.friendApi) {
            return { ok: false, reason: "unsupported", error: "Tài khoản này không phải ZCA nên không có lời mời kết bạn." };
        }

        const existingLock = syncLocks.get(account.botId);
        if (existingLock) return existingLock;

        const run = (async () => {
            const health = typeof account.friendRequestHealth === "function"
                ? account.friendRequestHealth()
                : { authenticated: Boolean(account.authenticated) };
            if (!health.authenticated) {
                return { ok: false, reason: "not_authenticated", error: "Tài khoản ZCA chưa đăng nhập." };
            }

            let candidates;
            try {
                candidates = await account.friendApi.listReceivedRequests();
            } catch (error) {
                return { ok: false, reason: "provider_error", error: error?.message || String(error) };
            }

            const limited = candidates.slice(0, MAX_SYNC_CANDIDATES);
            let added = 0;
            let skipped = 0;
            let markedFriends = 0;
            const errors = [];

            for (const candidate of limited) {
                try {
                    // Xác minh trước khi tin. Danh sách gợi ý không đủ căn cứ.
                    const status = await account.friendApi.getStatus(candidate.userId);

                    if (status.isFriend) {
                        const requestId = fr.buildRequestId(account.botId, candidate.userId);
                        const record = store.get(requestId);
                        if (record && fr.isOpen(record)) {
                            fr.applyTransition(requestId, REQUEST_STATUS.ALREADY_FRIENDS, {
                                method: PROCESSED_METHOD.SYSTEM,
                                note: "Zalo báo đã là bạn trong lúc đồng bộ"
                            }, paths.requests);
                            markedFriends += 1;
                        } else {
                            skipped += 1;
                        }
                        continue;
                    }

                    if (status.outgoingRequest && !status.incomingRequest) {
                        // CHỈ trường hợp này mới đủ căn cứ để loại: ta đã gửi lời mời
                        // cho họ, không phải họ gửi cho ta.
                        //
                        // KHÔNG loại khi cả hai cờ đều 0: đó chính là trường hợp cờ
                        // trả sai đã gặp thật (lời mời còn sống mà cờ = 0). Danh sách
                        // này đã được nhà cung cấp lọc theo recommType =
                        // ReceivedFriendRequest, nên nó là bằng chứng về chiều mạnh
                        // hơn cờ trạng thái.
                        skipped += 1;
                        continue;
                    }

                    const result = fr.upsertDetected({
                        accountId: account.botId,
                        userId: candidate.userId,
                        displayName: candidate.displayName,
                        avatar: candidate.avatar,
                        message: candidate.message,
                        requestedAt: candidate.requestedAt,
                        source: options.trigger || "sync"
                    }, paths.requests);

                    if (result.isNew) {
                        added += 1;
                        await onDetected(result.record, account, options.trigger || "sync");
                    }
                } catch (error) {
                    errors.push({ userId: candidate.userId, error: error?.message || String(error) });
                }
            }

            return {
                ok: true,
                accountId: account.botId,
                trigger: options.trigger || "sync",
                checked: limited.length,
                added,
                skipped,
                markedFriends,
                errors,
                truncated: candidates.length > limited.length
            };
        })();

        // Giữ khóa cho tới khi xong, rồi luôn nhả — kể cả khi lỗi.
        const guarded = run.finally(() => {
            if (syncLocks.get(account.botId) === guarded) syncLocks.delete(account.botId);
        });
        syncLocks.set(account.botId, guarded);
        return guarded;
    }

    // Đồng bộ mọi tài khoản ZCA đang đăng nhập. Một tài khoản lỗi không chặn các
    // tài khoản còn lại.
    async function syncAll(options = {}) {
        const accounts = listAccounts().filter((account) => account && account.friendApi);
        const results = [];
        for (const account of accounts) {
            try {
                results.push(await syncAccount(account.botId, options));
            } catch (error) {
                results.push({ ok: false, accountId: account.botId, error: error?.message || String(error) });
            }
        }
        return { ok: true, accounts: results };
    }

    // ------------------------------------------------------------------
    // Vòng đời
    // ------------------------------------------------------------------

    function start() {
        if (started) return { started: true, already: true };
        started = true;

        // Lời mời kẹt ở "đang xử lý" do tiến trình dừng giữa chừng phải được mở
        // khóa, nếu không chúng vĩnh viễn không xử lý lại được.
        //
        // staleAfterMs = 0 vì lúc KHỞI ĐỘNG mọi bản ghi "đang xử lý" đều đã chết:
        // PM2 chạy đúng một tiến trình (instances:1, fork), nên không có thao tác
        // nào còn sống để chờ. Dùng ngưỡng 2 phút ở đây sẽ bỏ sót những bản ghi vừa
        // bị kẹt ngay trước khi restart — và chúng sẽ kẹt mãi vì không có vòng nào
        // chạy lại bước khôi phục.
        const recovered = fr.recoverStuckProcessing({ staleAfterMs: 0, filePath: paths.requests });
        if (recovered > 0) log("warn", `đã mở khóa ${recovered} lời mời kẹt ở trạng thái đang xử lý`);

        scheduleNextSync();
        return { started: true };
    }

    function stop() {
        started = false;
        if (scheduler) {
            clearTimeout(scheduler);
            scheduler = null;
        }
        return { stopped: true };
    }

    // Nhịp đồng bộ đọc lại từ cấu hình mỗi vòng, nên đổi khoảng đồng bộ trên
    // dashboard có hiệu lực mà không cần restart.
    function scheduleNextSync() {
        if (!started) return;
        if (scheduler) clearTimeout(scheduler);
        const settings = store.settings();
        const delay = settings.syncIntervalMs;

        scheduler = setTimeout(async () => {
            scheduler = null;
            if (!started) return;
            try {
                if (settings.mode !== HANDLING_MODE.DISABLED) {
                    await syncAll({ trigger: "interval" });
                }
            } catch (error) {
                log("warn", `đồng bộ định kỳ thất bại: ${error.message}`);
            } finally {
                scheduleNextSync();
            }
        }, delay);
        scheduler.unref?.();
    }

    // ------------------------------------------------------------------
    // Trạng thái cho dashboard
    // ------------------------------------------------------------------

    function accountSummary() {
        return listAccounts()
            .filter((account) => account && account.friendApi)
            .map((account) => {
                const health = typeof account.friendRequestHealth === "function"
                    ? account.friendRequestHealth()
                    : { authenticated: false };
                return {
                    accountId: account.botId,
                    displayName: account.displayName || account.botId,
                    label: account.displayName ? `${account.displayName} · ${account.botId}` : account.botId,
                    uid: account.ownUid || null,
                    authenticated: Boolean(health.authenticated),
                    listenerConnected: Boolean(health.listenerConnected),
                    status: account.status || null,
                    lastFriendEventAt: health.lastFriendEventAt || null
                };
            });
    }

    function getState(options = {}) {
        const settings = store.settings();
        return {
            settings,
            mode: settings.mode,
            autoAccept: { ...autoAcceptState(), ...checkAutoAcceptLimits() },
            accounts: accountSummary(),
            recipients: describeRecipients(),
            pending: store.pending({ accountId: options.accountId || null }),
            history: store.history({
                accountId: options.accountId || null,
                search: options.search || null,
                limit: options.limit || 200
            }),
            counts: (() => {
                const all = store.list({ limit: fr.LIMITS.historyLimit });
                return {
                    pending: all.filter((record) => fr.isOpen(record)).length,
                    accepted: all.filter((record) => record.status === REQUEST_STATUS.ACCEPTED).length,
                    rejected: all.filter((record) => record.status === REQUEST_STATUS.REJECTED).length,
                    failed: all.filter((record) => RETRYABLE_STATUSES.has(record.status)).length,
                    total: all.length
                };
            })()
        };
    }

    // ------------------------------------------------------------------
    // Cấu hình
    // ------------------------------------------------------------------

    function updateSettings(patch = {}, meta = {}) {
        const before = store.settings();
        const after = fr.updateSettings(patch || {}, paths.settings);

        // Đổi chế độ/chặn tự động thì phải xóa trạng thái tạm dừng: quản trị viên
        // vừa can thiệp, nên coi như đã xử lý sự cố.
        if (before.mode !== after.mode || patch?.resetAutoSuspend === true) {
            autoState.suspended = false;
            autoState.suspendedReason = null;
            autoState.suspendedAt = null;
            autoState.consecutiveErrors = 0;
        }

        audit("friend_request.settings_updated", { actor: meta.actor || null, patch: Object.keys(patch || {}) });

        // Áp nhịp đồng bộ mới ngay, không cần restart.
        if (started) scheduleNextSync();
        return after;
    }

    // Gửi lại thông báo của MỘT kênh. Chỉ kênh lỗi mới được gửi lại; kênh đã
    // thành công giữ nguyên, đúng yêu cầu "đừng gửi lại tin đã gửi được".
    async function retryNotification(requestId, channel, options = {}) {
        const record = store.get(requestId);
        if (!record) return { ok: false, error: "Không tìm thấy lời mời này." };
        const name = String(channel || "").trim();
        if (!Object.values(NOTIFICATION_CHANNEL).includes(name)) {
            return { ok: false, error: "Kênh thông báo không hợp lệ." };
        }
        const account = getAccount(record.accountId);
        if (!account) return { ok: false, error: "Tài khoản ZCA của lời mời này không khả dụng." };

        const kind = options.kind || NOTIFICATION_KIND.NEW_REQUEST;
        if (fr.hasNotified(record, name, kind)) {
            return { ok: true, skipped: true, reason: "already_sent" };
        }

        let outcome;
        try {
            outcome = await notify({ channel: name, kind, request: record, account, retry: true });
        } catch (error) {
            outcome = { ok: false, error: error?.message || String(error) };
        }
        const result = outcome || { ok: false, error: "không có phản hồi" };

        fr.setNotificationResult(requestId, name, {
            kind,
            status: result.ok ? NOTIFICATION_STATUS.SENT : NOTIFICATION_STATUS.FAILED,
            chatId: result.chatId || null,
            botId: result.botId || null,
            error: result.ok ? null : (result.error || "gửi thất bại")
        }, paths.requests);

        return { ok: Boolean(result.ok), channel: name, chatId: result.chatId || null, error: result.ok ? null : (result.error || "gửi thất bại") };
    }

    // Gửi tin chào cho một người ĐÃ được chấp nhận kết bạn.
    //
    // Cần thiết vì tin chào chỉ đi đúng lúc chấp nhận: nếu lúc đó tính năng đang
    // tắt, hoặc nội dung được đặt sau, người đó sẽ không bao giờ nhận được — và
    // nút "gửi lại" không được phép lặng lẽ không làm gì.
    async function sendWelcomeFor(requestId, options = {}) {
        const record = store.get(requestId);
        if (!record) return { ok: false, error: "Không tìm thấy lời mời này." };
        if (![REQUEST_STATUS.ACCEPTED, REQUEST_STATUS.ALREADY_FRIENDS].includes(record.status)) {
            return { ok: false, error: "Chỉ gửi tin chào cho người đã được chấp nhận kết bạn." };
        }
        const account = getAccount(record.accountId);
        if (!account || !account.friendApi) {
            return { ok: false, error: "Tài khoản ZCA của người này không khả dụng." };
        }
        const result = await maybeSendWelcome(record, account, { force: options.force === true });
        if (result?.skipped) {
            const reasons = {
                welcome_disabled: "Tin chào đang TẮT trong cài đặt.",
                welcome_empty: "Chưa nhập nội dung tin chào.",
                already_sent: "Tin chào đã được gửi cho người này rồi."
            };
            return { ok: false, skipped: true, reason: result.reason, error: reasons[result.reason] || "Không gửi được." };
        }
        audit("friend_request.welcome_sent", { requestId, actor: options.actor || null, result: result?.ok ? "success" : "failed" });
        return {
            ok: Boolean(result?.ok),
            chatId: record.userId,
            error: result?.ok ? null : (result?.error || "gửi tin chào thất bại"),
            state: getState()
        };
    }

    // Gửi thử một kênh để quản trị viên biết cấu hình đúng chưa.
    async function testNotification(channel) {
        const name = String(channel || "").trim();
        if (!Object.values(NOTIFICATION_CHANNEL).includes(name)) {
            return { ok: false, error: "Kênh thông báo không hợp lệ." };
        }
        const settings = store.settings();
        if (settings.notifications?.[name]?.enabled !== true) {
            return { ok: false, error: "Kênh này đang tắt." };
        }
        const sample = {
            requestId: `test::${name}::${Date.now()}`,
            accountId: null,
            userId: null,
            displayName: "Người gửi mẫu",
            message: "Đây là tin thử cấu hình thông báo.",
            detectedAt: new Date().toISOString(),
            status: REQUEST_STATUS.PENDING,
            test: true
        };
        try {
            const result = await notify({ channel: name, kind: NOTIFICATION_KIND.NEW_REQUEST, request: sample, account: null, test: true });
            return {
                ok: Boolean(result?.ok),
                channel: name,
                chatId: result?.chatId || null,
                error: result?.ok ? null : (result?.error || result?.reason || "gửi thất bại")
            };
        } catch (error) {
            return { ok: false, channel: name, error: error?.message || String(error) };
        }
    }

    return {
        // Phát hiện
        handleEvent,
        syncAccount,
        syncAll,
        refresh: (options) => syncAll({ trigger: "manual", ...(options || {}) }),
        // Thao tác
        accept: (requestId, options) => processRequest(requestId, "accept", options),
        reject: (requestId, options) => processRequest(requestId, "reject", options),
        retryNotification,
        sendWelcomeFor,
        testNotification,
        // Cấu hình + trạng thái
        getSettings: () => store.settings(),
        updateSettings,
        getState,
        autoAcceptState,
        checkAutoAcceptLimits,
        // Vòng đời
        start,
        stop,
        isStarted: () => started
    };
}

module.exports = {
    MAX_SYNC_CANDIDATES,
    OPERABLE_STATUSES,
    createFriendRequestService
};
