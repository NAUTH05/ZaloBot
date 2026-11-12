// ============================================================================
// BỘ ĐIỀU PHỐI GỬI TIN THỐNG NHẤT CHO MỖI TÀI KHOẢN ZCA.
//
// VẤN ĐỀ TRƯỚC ĐÂY
//
// Có BA cơ chế giới hạn chạy song song, và không cơ chế nào bao trùm mọi đường gửi:
//
//   1. sendPacing.js — chỉ áp dụng khi `feature` là `broadcast` hoặc `schedule`.
//      Trả lời người dùng, tin chào, phản hồi đánh giá, tin thử của quản trị viên
//      và ảnh KHÔNG đi qua đây. Tệ hơn: trạng thái nhịp chỉ có HAI ô (official/zca),
//      nên hai tài khoản ZCA khác nhau dùng chung một nhịp — tài khoản này bị tạm
//      dừng thì tài khoản kia cũng đứng.
//   2. sendQueue.js — hàng đợi theo botId nhưng trần song song mặc định của ZCA là
//      4, tức bốn request có thể rời máy trong cùng một giây. Nhịp "5 giây/tin"
//      không có ý nghĩa gì khi bốn tin đi cùng lúc.
//   3. announcementPacing.js — chỉ dùng trong script thông báo một lần.
//
// Hệ quả: cùng một tài khoản ZCA vẫn có thể vượt giới hạn thật của Zalo, Zalo nhận
// yêu cầu nhưng KHÔNG tạo tin, và bot báo "đã gửi" trong khi người dùng không nhận
// được gì.
//
// MÔ-ĐUN NÀY LÀM GÌ
//
// Mỗi tài khoản ZCA có ĐÚNG MỘT làn gửi:
//
//   • Song song = 1. Không bao giờ có hai request cùng lúc cho một tài khoản.
//   • Khoảng cách tối thiểu giữa hai request thật, áp dụng cho MỌI đường gửi
//     (kể cả từng đoạn của tin dài, ảnh, tệp, tin thử).
//   • Ưu tiên: trả lời người dùng > thông báo theo lịch > hàng loạt.
//   • Cầu dao riêng cho từng tài khoản: 429 lặp lại, thiếu msgId lặp lại trên
//     nhiều người nhận, mã 123 lặp lại trên nhiều người nhận.
//   • Trạng thái tạm dừng được LƯU XUỐNG ĐĨA nên khởi động lại PM2 không xoá nó.
//
// VÌ SAO KHÔNG `sleep()` TRONG WORKER ĐANG GIỮ VIỆC
//
// Nếu lấy một việc ra khỏi hàng đợi rồi ngủ 10 giây, việc đó đã "chiếm chỗ": một
// câu trả lời người dùng đến sau phải chờ đúng 10 giây dù nó ưu tiên cao hơn. Vì
// vậy vòng bơm ở đây NGỦ TRƯỚC RỒI MỚI CHỌN việc — sau mỗi lần chờ, nó chọn lại
// việc ưu tiên cao nhất đang có. Khoảng cách luôn được tôn trọng, và việc gấp
// không bị việc lớn chặn.
//
// GIỚI HẠN CẦN NÓI RÕ
//
// 10 giây/tin KHÔNG phải hạn mức đã được Zalo công bố, và KHÔNG bảo đảm tài khoản
// không bị siết. Đây là tham số khởi đầu thận trọng để thử nghiệm có kiểm soát.
// Mô-đun này không và không được dùng để né giới hạn của Zalo.
// ============================================================================

const fs = require("fs");
const path = require("path");
const { isZcaId } = require("./bots");
const { PRIORITY } = require("./sendQueue");
const {
    DELIVERY_ERROR_KIND,
    DELIVERY_STATE,
    classifyDeliveryError
} = require("./deliveryErrors");

// ---------------------------------------------------------------------------
// Cấu hình — nằm ở zcaOutboundConfig.js để sendPacing.js dùng CÙNG một nguồn số.
// ---------------------------------------------------------------------------

const { ZCA_OUTBOUND_DEFAULTS, resolveZcaOutboundConfig } = require("./zcaOutboundConfig");
const DEFAULTS = ZCA_OUTBOUND_DEFAULTS;

// ---------------------------------------------------------------------------
// Lỗi "hoãn" — KHÔNG phải lỗi của người nhận
// ---------------------------------------------------------------------------

// Ném ra khi chưa thể gửi vì tài khoản đang tạm dừng. Tách hẳn khỏi lỗi thường để
// tầng trên không ghi nó vào bộ đếm thất bại của từng chat (nếu không, một đợt bị
// siết tốc độ sẽ làm mọi người nhận bị tạm dừng vĩnh viễn).
function createDeferredError(reason = "provider_paused", retryAfterMs = 0) {
    const error = new Error(`Hoãn gửi: ${reason}`);
    error.deliveryKind = DELIVERY_ERROR_KIND.DEFERRED;
    error.deferred = true;
    error.reason = reason;
    error.retryAfterMs = Number(retryAfterMs) || 0;
    return error;
}

// ---------------------------------------------------------------------------
// Cầu dao cấp tài khoản
// ---------------------------------------------------------------------------

const BREAKER_STATE = Object.freeze({
    NORMAL: "normal",
    SUSPECTED: "suspected",
    PAUSED: "paused",
    COOLDOWN_COMPLETED: "cooldown_completed"
});

// Trạng thái cầu dao của một tài khoản. Toàn bộ là dữ liệu thuần (không giữ
// promise/timer) để lưu xuống đĩa và kiểm thử được bằng đồng hồ giả.
function createBreakerState(overrides = {}) {
    return {
        state: BREAKER_STATE.NORMAL,
        pausedUntil: 0,
        pauseReason: null,
        rateLimitStrikes: [],
        // Mốc thời gian của các lần thiếu msgId / mã 123, mỗi mốc kèm NGƯỜI NHẬN.
        // Đếm theo người nhận KHÁC NHAU trong cửa sổ: cùng một người lỗi 5 lần không
        // phải bằng chứng tài khoản bị siết.
        unconfirmedEvents: [],
        recipientErrorEvents: [],
        recoverySuccesses: 0,
        lastRateLimitAt: 0,
        lastFailureAt: 0,
        ...overrides
    };
}

function pruneStrikes(list, nowMs, windowMs) {
    return (Array.isArray(list) ? list : []).filter((at) => Number.isFinite(Number(at)) && nowMs - Number(at) <= windowMs);
}

// Tính trạng thái kế tiếp sau khi cửa sổ trôi qua. Hàm THUẦN: không sửa tham số.
//
// `paused` hết hạn ⇒ `cooldown_completed`, KHÔNG phải `normal`. Giai đoạn phục hồi
// có chủ đích: tài khoản chỉ được gửi việc ưu tiên cao, và việc hàng loạt vẫn bị
// hoãn cho tới khi có vài lần gửi xác nhận liên tiếp. Nhờ vậy sau một lần bị siết,
// hệ thống không đổ nguyên một đợt vài trăm tin vào tài khoản vừa hồi phục.
function evaluateBreaker(state, nowMs, settings) {
    if (state.state === BREAKER_STATE.PAUSED) {
        if (nowMs < state.pausedUntil) {
            return { ...state, state: BREAKER_STATE.PAUSED };
        }
        return { ...state, state: BREAKER_STATE.COOLDOWN_COMPLETED, recoverySuccesses: 0 };
    }
    return state;
}

function breakerGate(state, nowMs, settings) {
    const evaluated = evaluateBreaker(state, nowMs, settings);
    if (evaluated.state === BREAKER_STATE.PAUSED) {
        return {
            allowed: false,
            state: evaluated.state,
            reason: evaluated.pauseReason || "paused",
            waitMs: Math.max(0, evaluated.pausedUntil - nowMs),
            blocksBulk: true,
            blocksAll: true
        };
    }
    if (evaluated.state === BREAKER_STATE.COOLDOWN_COMPLETED) {
        return {
            allowed: true,
            state: evaluated.state,
            reason: "cooldown_completed",
            waitMs: 0,
            // Chỉ chặn việc HÀNG LOẠT trong giai đoạn phục hồi.
            blocksBulk: true,
            blocksAll: false
        };
    }
    return { allowed: true, state: evaluated.state, reason: null, waitMs: 0, blocksBulk: false, blocksAll: false };
}

// Ghi nhận một lần 429. Trả về trạng thái mới (không sửa tham số vào).
function recordRateLimit(state, nowMs, settings) {
    const strikes = [...pruneStrikes(state.rateLimitStrikes, nowMs, settings.strikeWindowMs), nowMs];
    const exceeded = strikes.length >= settings.rateLimitStrikes;
    return {
        ...state,
        rateLimitStrikes: strikes,
        lastRateLimitAt: nowMs,
        lastFailureAt: nowMs,
        state: exceeded ? BREAKER_STATE.PAUSED : BREAKER_STATE.SUSPECTED,
        pausedUntil: exceeded ? nowMs + settings.pauseMs : state.pausedUntil,
        pauseReason: exceeded ? "rate_limited" : state.pauseReason,
        recoverySuccesses: exceeded ? 0 : state.recoverySuccesses
    };
}

// Ghi nhận một lần thiếu msgId. Chỉ NGƯỜI NHẬN KHÁC NHAU mới được đếm.
//
// `events` giữ cả mốc thời gian và người nhận để việc lọc theo cửa sổ không làm
// mất thông tin "ai đã gặp lỗi" — nhờ vậy đếm được số người nhận KHÁC NHAU.
function recordAccountScopedEvent(state, field, recipientKey, nowMs, settings, threshold, pauseReason) {
    const events = (Array.isArray(state[field]) ? state[field] : [])
        .filter((event) => event && Number.isFinite(Number(event.at)) && nowMs - Number(event.at) <= settings.strikeWindowMs);
    const nextEvents = [...events, { at: nowMs, recipientKey: String(recipientKey || "unknown") }];
    const distinctRecipients = new Set(nextEvents.map((event) => event.recipientKey));
    const exceeded = distinctRecipients.size >= threshold;
    return {
        ...state,
        [field]: nextEvents,
        lastFailureAt: nowMs,
        state: exceeded
            ? BREAKER_STATE.PAUSED
            : (state.state === BREAKER_STATE.NORMAL ? BREAKER_STATE.SUSPECTED : state.state),
        pausedUntil: exceeded ? nowMs + settings.pauseMs : state.pausedUntil,
        pauseReason: exceeded ? pauseReason : state.pauseReason,
        recoverySuccesses: exceeded ? 0 : state.recoverySuccesses
    };
}

function recordUnconfirmed(state, recipientKey, nowMs, settings) {
    return recordAccountScopedEvent(
        state, "unconfirmedEvents", recipientKey, nowMs, settings,
        settings.unconfirmedStrikes, "missing_message_id"
    );
}

// Ghi nhận một lần mã 123. Cùng quy tắc: đếm người nhận KHÁC NHAU.
function recordRecipientError(state, recipientKey, nowMs, settings) {
    return recordAccountScopedEvent(
        state, "recipientErrorEvents", recipientKey, nowMs, settings,
        settings.recipientStrikes, "recipient_restricted"
    );
}

function distinctRecipientCount(events, nowMs, windowMs) {
    const inWindow = (Array.isArray(events) ? events : [])
        .filter((event) => event && Number.isFinite(Number(event.at)) && nowMs - Number(event.at) <= windowMs);
    return new Set(inWindow.map((event) => event.recipientKey)).size;
}

// Ghi nhận một lần gửi CÓ XÁC NHẬN. Trong giai đoạn phục hồi, đủ số lần liên tiếp
// thì thoát về bình thường — cùng nhịp, không nhanh hơn.
function recordSuccess(state, nowMs, settings) {
    if (state.state !== BREAKER_STATE.COOLDOWN_COMPLETED) {
        return { ...state, recoverySuccesses: 0 };
    }
    const recoverySuccesses = (state.recoverySuccesses || 0) + 1;
    if (recoverySuccesses >= settings.recoverySuccesses) {
        return {
            ...state,
            state: BREAKER_STATE.NORMAL,
            pausedUntil: 0,
            pauseReason: null,
            recoverySuccesses: 0,
            rateLimitStrikes: [],
            unconfirmedEvents: [],
            recipientErrorEvents: []
        };
    }
    return { ...state, recoverySuccesses };
}

// ---------------------------------------------------------------------------
// Lưu trạng thái xuống đĩa (nguyên tử)
// ---------------------------------------------------------------------------

// Chỉ lưu phần KHÔNG thể suy ra lại: trạng thái cầu dao và mốc tạm dừng. Số liệu
// đếm trong ngày là chẩn đoán, không cần sống qua lần khởi động lại.
//
// Tuyệt đối không ghi cookie/phiên đăng nhập: tệp này chỉ có trạng thái nhịp.
function createStateStore(filePath) {
    const target = filePath || null;

    function read() {
        if (!target) return {};
        try {
            const raw = fs.readFileSync(target, "utf8");
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
            return parsed.accounts && typeof parsed.accounts === "object" ? parsed.accounts : {};
        } catch (error) {
            // Tệp hỏng/không đọc được ⇒ bắt đầu lại từ trạng thái an toàn. Không
            // bao giờ để lỗi đọc tệp làm hỏng tiến trình gửi tin.
            return {};
        }
    }

    function write(accounts) {
        if (!target) return false;
        try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            const payload = JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), accounts }, null, 2);
            const temp = `${target}.tmp`;
            // Ghi ra tệp tạm rồi đổi tên: một lần chết giữa chừng không để lại tệp
            // cụt khiến lần khởi động sau đọc ra trạng thái vô nghĩa.
            fs.writeFileSync(temp, payload, "utf8");
            fs.renameSync(temp, target);
            return true;
        } catch (error) {
            return false;
        }
    }

    return { read, write, filePath: target };
}

// ---------------------------------------------------------------------------
// Làn gửi của một tài khoản ZCA
// ---------------------------------------------------------------------------

function createAccountLane(options) {
    const {
        accountId,
        settings,
        now,
        sleep,
        log,
        store,
        onPersist
    } = options;

    // Hàng đợi theo mức ưu tiên. Số nhỏ = quan trọng hơn.
    const lanes = new Map([
        [PRIORITY.INTERACTIVE, []],
        [PRIORITY.SCHEDULED, []],
        [PRIORITY.BULK, []]
    ]);

    let breaker = createBreakerState();
    let pumping = false;
    let nextEligibleAt = 0;
    let idleResolvers = [];
    let stopped = false;

    // Số liệu chẩn đoán (trong bộ nhớ). Không phải nguồn sự thật về người dùng.
    const metrics = {
        confirmed: 0,
        unconfirmed: 0,
        recipientErrors: 0,
        rateLimited: 0,
        deferred: 0,
        failed: 0,
        lastConfirmedAt: 0,
        lastRateLimitAt: 0,
        lastDeferredAt: 0,
        recentRecipients: [],
        recentSendAt: []
    };

    function pendingCount() {
        let total = 0;
        for (const lane of lanes.values()) total += lane.length;
        return total;
    }

    // Trạng thái cầu dao ĐÃ đồng bộ với đồng hồ hiện tại.
    //
    // Cần thiết vì `paused` → `cooldown_completed` chỉ suy ra được từ `pausedUntil`:
    // nếu không ghi lại, bộ đếm phục hồi sẽ không bao giờ tăng (nó chỉ tăng khi
    // trạng thái đã là `cooldown_completed`) và tài khoản kẹt ở giai đoạn phục hồi.
    function current() {
        const evaluated = evaluateBreaker(breaker, now(), settings);
        if (evaluated !== breaker) breaker = evaluated;
        return breaker;
    }

    function takeNext() {
        for (const priority of [...lanes.keys()].sort((left, right) => left - right)) {
            const lane = lanes.get(priority);
            if (lane.length > 0) return lane.shift();
        }
        return null;
    }

    // Rút TOÀN BỘ việc đang chờ ra và trả `deferred` cho từng việc. Dùng khi tài
    // khoản bị tạm dừng: người gọi biết "chưa gửi" để lần chạy sau thử lại, thay vì
    // báo "đích hỏng".
    function drainAsDeferred(reason, retryAfterMs, filterPriority = null) {
        let drained = 0;
        for (const [priority, lane] of lanes) {
            if (filterPriority !== null && priority !== filterPriority) continue;
            const items = lane.splice(0, lane.length);
            for (const item of items) {
                metrics.deferred += 1;
                metrics.lastDeferredAt = now();
                const error = createDeferredError(reason, retryAfterMs);
                item.reject(error);
                drained += 1;
            }
        }
        if (drained > 0) {
            log("warn", `[Outbound] ${accountId}: hoãn ${drained} tin (${reason}).`);
        }
        return drained;
    }

    function resolveIdle() {
        if (totalPending() !== 0) return;
        const resolvers = idleResolvers;
        idleResolvers = [];
        for (const resolve of resolvers) resolve();
    }

    function totalPending() {
        return pendingCount();
    }

    // Vòng bơm: ngủ TRƯỚC, chọn việc SAU.
    //
    // Nhờ thứ tự này, một câu trả lời người dùng đến trong lúc đang chờ đủ nhịp sẽ
    // được chọn trước thông báo hàng loạt đang xếp hàng — mà khoảng cách giữa hai
    // request thật vẫn không bị vi phạm.
    async function pump() {
        if (pumping || stopped) return;
        pumping = true;
        try {
            while (!stopped) {
                if (pendingCount() === 0) {
                    resolveIdle();
                    return;
                }

                const gate = breakerGate(current(), now(), settings);
                if (gate.blocksAll) {
                    // Đang tạm dừng: hoãn hết phần còn lại và dừng vòng bơm. Việc mới
                    // đến sẽ bị từ chối ngay ở `enqueue` cho tới khi hết thời gian.
                    drainAsDeferred(gate.reason, gate.waitMs);
                    resolveIdle();
                    return;
                }

                const waitMs = Math.max(0, nextEligibleAt - now());
                if (waitMs > 0) {
                    await sleep(waitMs);
                    // Sau khi chờ, chọn lại theo mức ưu tiên: việc gấp vừa tới được
                    // ưu tiên hơn việc hàng loạt đã xếp trước.
                    continue;
                }

                const item = takeNext();
                if (!item) {
                    resolveIdle();
                    return;
                }

                // Giai đoạn phục hồi: chỉ cho việc ưu tiên cao đi qua.
                if (gate.blocksBulk && item.priority === PRIORITY.BULK) {
                    metrics.deferred += 1;
                    metrics.lastDeferredAt = now();
                    item.reject(createDeferredError("recovering", 0));
                    continue;
                }

                const startedAt = now();
                metrics.recentSendAt.push(startedAt);
                if (metrics.recentSendAt.length > settings.historySize) {
                    metrics.recentSendAt.splice(0, metrics.recentSendAt.length - settings.historySize);
                }

                try {
                    const value = await item.run();
                    onOutcome(item, value, null);
                    item.resolve(value);
                } catch (error) {
                    onOutcome(item, null, error);
                    item.reject(error);
                } finally {
                    // Nhịp tính từ lúc REQUEST KẾT THÚC, không phải lúc bắt đầu: thời
                    // gian mạng chậm không được rút ngắn khoảng cách thật giữa hai tin.
                    nextEligibleAt = now() + settings.intervalMs;
                }
            }
        } finally {
            pumping = false;
        }
    }

    // Cập nhật cầu dao theo kết quả. Đây là chỗ DUY NHẤT quyết định tài khoản có bị
    // tạm dừng hay không.
    function onOutcome(item, value, error) {
        const at = now();
        if (!error) {
            metrics.confirmed += 1;
            metrics.lastConfirmedAt = at;
            const next = recordSuccess(breaker, at, settings);
            if (next !== breaker) {
                breaker = next;
                persist();
            }
            return;
        }

        const classification = error?.deliveryClassification || classifyDeliveryError(error);
        // Gắn phân loại lên chính đối tượng lỗi: tầng trên (sendMessage, nhật ký gửi
        // tin, cổng tiếp nhận) không phải đoán lại, và mọi nơi đọc CÙNG một kết luận.
        if (error && typeof error === "object" && !error.deliveryClassification) {
            error.deliveryClassification = classification;
        }
        switch (classification.kind) {
            case DELIVERY_ERROR_KIND.RATE_LIMIT: {
                metrics.rateLimited += 1;
                metrics.lastRateLimitAt = at;
                const next = recordRateLimit(breaker, at, settings);
                if (next.state !== breaker.state) {
                    log("warn", `[Outbound] ${accountId}: 429 lần ${next.rateLimitStrikes} ⇒ ${next.state}`);
                }
                breaker = next;
                persist();
                break;
            }
            case DELIVERY_ERROR_KIND.UNCONFIRMED: {
                metrics.unconfirmed += 1;
                const next = recordUnconfirmed(breaker, item.recipientKey, at, settings);
                if (next.state !== breaker.state) {
                    log("warn", `[Outbound] ${accountId}: ${distinctRecipientCount(next.unconfirmedEvents, at, settings.strikeWindowMs)} người nhận thiếu msgId ⇒ ${next.state}`);
                }
                breaker = next;
                persist();
                break;
            }
            case DELIVERY_ERROR_KIND.RECIPIENT: {
                metrics.recipientErrors += 1;
                const next = recordRecipientError(breaker, item.recipientKey, at, settings);
                if (next.state !== breaker.state) {
                    log("warn", `[Outbound] ${accountId}: ${distinctRecipientCount(next.recipientErrorEvents, at, settings.strikeWindowMs)} người nhận bị mã 123 ⇒ ${next.state}`);
                }
                breaker = next;
                persist();
                break;
            }
            case DELIVERY_ERROR_KIND.PERMANENT:
            case DELIVERY_ERROR_KIND.FORMAT:
                metrics.failed += 1;
                break;
            case DELIVERY_ERROR_KIND.DEFERRED:
                metrics.deferred += 1;
                metrics.lastDeferredAt = at;
                break;
            default:
                metrics.failed += 1;
                break;
        }

        if (item.recipientKey) {
            metrics.recentRecipients.push(String(item.recipientKey));
            if (metrics.recentRecipients.length > settings.historySize) {
                metrics.recentRecipients.splice(0, metrics.recentRecipients.length - settings.historySize);
            }
        }
    }

    function persist() {
        if (typeof onPersist === "function") onPersist(accountId, breaker);
    }

    function enqueue(run, priority = PRIORITY.BULK, meta = {}) {
        if (stopped) {
            return Promise.reject(new Error("Bộ điều phối gửi đã dừng (đang tắt tiến trình)"));
        }

        // Tài khoản đang tạm dừng ⇒ từ chối NGAY, không xếp hàng. Xếp hàng rồi mới
        // hoãn sẽ giữ tham chiếu tới hàng trăm closure vô ích trong lúc chờ.
        const gate = breakerGate(current(), now(), settings);
        if (gate.blocksAll) {
            metrics.deferred += 1;
            metrics.lastDeferredAt = now();
            return Promise.reject(createDeferredError(gate.reason, gate.waitMs));
        }

        const lane = lanes.get(priority) || lanes.get(PRIORITY.BULK);
        return new Promise((resolve, reject) => {
            lane.push({ run, resolve, reject, priority, recipientKey: meta.recipientKey || null });
            pump().catch((error) => {
                log("error", `[Outbound] ${accountId}: vòng bơm lỗi — ${error.message}`);
            });
        });
    }

    function onIdle() {
        if (pendingCount() === 0 && !pumping) return Promise.resolve();
        return new Promise((resolve) => idleResolvers.push(resolve));
    }

    function stop() {
        stopped = true;
        drainAsDeferred("shutting_down", 0);
        resolveIdle();
    }

    // Khôi phục trạng thái đã lưu. Mốc tạm dừng còn hiệu lực thì tài khoản vẫn bị
    // tạm dừng — khởi động lại PM2 KHÔNG được xoá một lần tạm dừng đang có hiệu lực.
    function restore(saved) {
        if (!saved || typeof saved !== "object") return;
        const restored = createBreakerState({
            state: saved.state || BREAKER_STATE.NORMAL,
            pausedUntil: Number(saved.pausedUntil) || 0,
            pauseReason: saved.pauseReason || null,
            rateLimitStrikes: Array.isArray(saved.rateLimitStrikes) ? saved.rateLimitStrikes.map(Number).filter(Number.isFinite) : [],
            unconfirmedEvents: Array.isArray(saved.unconfirmedEvents)
                ? saved.unconfirmedEvents.filter((event) => event && Number.isFinite(Number(event.at)))
                : [],
            recipientErrorEvents: Array.isArray(saved.recipientErrorEvents)
                ? saved.recipientErrorEvents.filter((event) => event && Number.isFinite(Number(event.at)))
                : [],
            recoverySuccesses: Number(saved.recoverySuccesses) || 0,
            lastRateLimitAt: Number(saved.lastRateLimitAt) || 0,
            lastFailureAt: Number(saved.lastFailureAt) || 0
        });
        // Đánh giá lại theo đồng hồ hiện tại: một lần tạm dừng đã hết hạn từ lâu thì
        // chuyển sang giai đoạn phục hồi, không giữ nguyên `paused` vĩnh viễn.
        breaker = evaluateBreaker(restored, now(), settings);
    }

    function stats() {
        const gate = breakerGate(current(), now(), settings);
        const uniqueRecipients = new Set(metrics.recentRecipients).size;
        return {
            accountId,
            intervalMs: settings.intervalMs,
            concurrency: settings.concurrency,
            queueLength: pendingCount(),
            state: gate.state,
            paused: gate.state === BREAKER_STATE.PAUSED,
            pausedUntil: breaker.pausedUntil || null,
            pauseReason: breaker.pauseReason || null,
            resumeInMs: gate.waitMs,
            recovering: gate.state === BREAKER_STATE.COOLDOWN_COMPLETED,
            rateLimitStrikes: pruneStrikes(breaker.rateLimitStrikes, now(), settings.strikeWindowMs).length,
            unconfirmedRecipients: distinctRecipientCount(breaker.unconfirmedEvents, now(), settings.strikeWindowMs),
            recipientErrorRecipients: distinctRecipientCount(breaker.recipientErrorEvents, now(), settings.strikeWindowMs),
            confirmed: metrics.confirmed,
            unconfirmed: metrics.unconfirmed,
            recipientErrors: metrics.recipientErrors,
            rateLimited: metrics.rateLimited,
            deferred: metrics.deferred,
            failed: metrics.failed,
            lastConfirmedAt: metrics.lastConfirmedAt || null,
            lastRateLimitAt: metrics.lastRateLimitAt || null,
            lastDeferredAt: metrics.lastDeferredAt || null,
            // Chẩn đoán mẫu gửi: số tin gần đây và số người nhận khác nhau. Chỉ để
            // cảnh báo/giới hạn, không dùng để né cơ chế chống spam của Zalo.
            recentSendCount: metrics.recentSendAt.length,
            recentUniqueRecipients: uniqueRecipients
        };
    }

    // Người vận hành xử lý xong sự cố và muốn thử lại ngay. KHÔNG tự động tăng tốc:
    // nhịp vẫn là `settings.intervalMs`.
    function reset() {
        breaker = createBreakerState();
        persist();
        return true;
    }

    // Thoát giai đoạn phục hồi mà không xoá lịch sử lỗi — dùng khi đã xác minh thủ
    // công rằng tài khoản gửi được.
    function resume() {
        if (breaker.state === BREAKER_STATE.COOLDOWN_COMPLETED || breaker.state === BREAKER_STATE.PAUSED) {
            breaker = { ...breaker, state: BREAKER_STATE.NORMAL, pausedUntil: 0, pauseReason: null, recoverySuccesses: 0 };
            persist();
            return true;
        }
        return false;
    }

    return {
        accountId,
        enqueue,
        onIdle,
        stop,
        restore,
        stats,
        reset,
        resume,
        get breakerState() { return breaker.state; }
    };
}

// ---------------------------------------------------------------------------
// Bộ điều phối chung
// ---------------------------------------------------------------------------

// `officialQueues` là hàng đợi CŨ, giữ nguyên cho bot chính thức: trần song song
// 8, không có nhịp ZCA. Yêu cầu là "bot chính thức giữ nguyên hành vi", nên nhánh
// official chỉ chuyển tiếp.
function createOutboundLimiter(options = {}) {
    const env = options.env || process.env;
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const sleep = typeof options.sleep === "function"
        ? options.sleep
        : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const log = typeof options.log === "function" ? options.log : () => {};
    const officialQueues = options.officialQueues || null;
    const settings = options.settings || resolveZcaOutboundConfig(env);
    const store = createStateStore(options.stateFilePath === undefined
        ? path.join(__dirname, "data", "zca-outbound-state.json")
        : options.stateFilePath);

    // Trạng thái lưu: chỉ cầu dao của từng tài khoản.
    const savedAccounts = store.read();
    const persisted = { ...savedAccounts };

    const lanes = new Map();

    function persistAccount(accountId, breaker) {
        persisted[accountId] = {
            state: breaker.state,
            pausedUntil: breaker.pausedUntil,
            pauseReason: breaker.pauseReason,
            rateLimitStrikes: breaker.rateLimitStrikes,
            unconfirmedEvents: breaker.unconfirmedEvents,
            recipientErrorEvents: breaker.recipientErrorEvents,
            recoverySuccesses: breaker.recoverySuccesses,
            lastRateLimitAt: breaker.lastRateLimitAt,
            lastFailureAt: breaker.lastFailureAt
        };
        store.write(persisted);
    }

    function laneFor(botId) {
        const key = String(botId || "unknown");
        if (!lanes.has(key)) {
            const lane = createAccountLane({
                accountId: key,
                settings,
                now,
                sleep,
                log,
                store,
                onPersist: persistAccount
            });
            // Khôi phục NGAY khi tạo làn: lần gửi đầu tiên sau khởi động lại phải
            // thấy đúng trạng thái tạm dừng, không phải chờ một lượt nào đó.
            lane.restore(persisted[key]);
            lanes.set(key, lane);
        }
        return lanes.get(key);
    }

    // Cửa vào DUY NHẤT cho mọi lần gửi.
    //
    // Tài khoản ZCA → làn riêng của chính tài khoản đó (tuần tự + nhịp + cầu dao).
    // Bot chính thức → hàng đợi cũ, hành vi không đổi.
    function enqueue(botId, run, priority = PRIORITY.BULK, meta = {}) {
        if (isZcaId(botId)) {
            return laneFor(botId).enqueue(run, priority, meta);
        }
        if (!officialQueues) {
            return Promise.resolve().then(run);
        }
        return officialQueues.enqueueFor(botId, run, priority);
    }

    function getStats() {
        const accounts = {};
        for (const [accountId, lane] of lanes) accounts[accountId] = lane.stats();
        // Tài khoản đã lưu nhưng chưa có làn trong tiến trình này vẫn phải hiện ra:
        // người vận hành cần thấy "đang tạm dừng" ngay sau khi khởi động lại.
        for (const [accountId, saved] of Object.entries(persisted)) {
            if (accounts[accountId]) continue;
            const gate = breakerGate(
                createBreakerState({
                    state: saved.state || BREAKER_STATE.NORMAL,
                    pausedUntil: Number(saved.pausedUntil) || 0,
                    pauseReason: saved.pauseReason || null
                }),
                now(),
                settings
            );
            accounts[accountId] = {
                accountId,
                intervalMs: settings.intervalMs,
                concurrency: settings.concurrency,
                queueLength: 0,
                state: gate.state,
                paused: gate.state === BREAKER_STATE.PAUSED,
                pausedUntil: Number(saved.pausedUntil) || null,
                pauseReason: saved.pauseReason || null,
                resumeInMs: gate.waitMs,
                recovering: gate.state === BREAKER_STATE.COOLDOWN_COMPLETED,
                confirmed: 0,
                unconfirmed: 0,
                recipientErrors: 0,
                rateLimited: 0,
                deferred: 0,
                failed: 0
            };
        }
        return {
            intervalMs: settings.intervalMs,
            minIntervalMs: settings.minIntervalMs,
            concurrency: settings.concurrency,
            accounts
        };
    }

    async function drainAll() {
        await Promise.allSettled([...lanes.values()].map((lane) => lane.onIdle()));
        if (officialQueues && typeof officialQueues.drainAll === "function") {
            await officialQueues.drainAll();
        }
    }

    async function stopAll() {
        for (const lane of lanes.values()) lane.stop();
        if (officialQueues && typeof officialQueues.stopAll === "function") {
            await officialQueues.stopAll();
        }
        await drainAll();
    }

    return {
        settings,
        enqueue,
        getStats,
        drainAll,
        stopAll,
        laneFor,
        resume: (botId) => laneFor(botId).resume(),
        reset: (botId) => laneFor(botId).reset(),
        get accountCount() { return lanes.size; }
    };
}

module.exports = {
    BREAKER_STATE,
    DEFAULTS,
    breakerGate,
    createAccountLane,
    createBreakerState,
    createDeferredError,
    createOutboundLimiter,
    createStateStore,
    evaluateBreaker,
    recordRateLimit,
    recordRecipientError,
    recordSuccess,
    recordUnconfirmed,
    resolveZcaOutboundConfig
};
