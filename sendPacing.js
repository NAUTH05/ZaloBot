// ============================================================================
// Nhịp gửi cho thông báo hàng loạt và thông báo theo lịch.
//
// VÌ SAO CẦN
//
// Gửi 100+ tin trong vài giây là nguyên nhân trực tiếp của hai sự cố đã xảy ra:
//   - Bot chính thức: hàng loạt lỗi 429 (đã ghi trong announcementPacing.js).
//   - Tài khoản Zalo CÁ NHÂN (ZCA): Zalo nhận yêu cầu, KHÔNG tạo tin, và KHÔNG trả
//     lỗi. Bảng tổng kết báo "đã gửi 100+ người" trong khi rất nhiều người không
//     nhận được gì. Đây chính là báo cáo "bot nói đã gửi mà không ai thấy".
//
// BA VIỆC MÔ-ĐUN NÀY LÀM
//
//   1. TUẦN TỰ THEO NHÀ CUNG CẤP. `waitTurn` chỉ có nghĩa nếu các lần gửi không
//      chạy song song: 100 lần gọi đồng thời đều thấy `lastSendAt` cũ và cùng vượt
//      cổng ⇒ vẫn là bắn một loạt. Khoá theo botId biến nó thành gửi lần lượt.
//
//   2. MỖI NHÀ CUNG CẤP MỘT NHỊP. Tài khoản cá nhân phải chậm hơn hẳn bot chính
//      thức — Zalo siết việc gửi hàng loạt từ tài khoản cá nhân mạnh hơn nhiều.
//
//   3. BỊ GIỚI HẠN TỐC ĐỘ THÌ CHẬM LẠI, KHÔNG BẮN TIẾP. Dùng lại bộ điều khiển
//      nhịp đã kiểm chứng của announcementPacing.js (429 ⇒ chờ, 3 lần ⇒ tạm dừng
//      nhà cung cấp và trả `deferred` cho phần còn lại).
//
// Trả về `deferred` chứ không phải `failed` khi nhà cung cấp đang tạm dừng: người
// vận hành cần biết "chưa gửi, chạy lại sau" khác với "đích này hỏng".
// ============================================================================

const { createPacingController } = require("./announcementPacing");
const { isZcaId } = require("./bots");
const { DELIVERY_ERROR_KIND } = require("./deliveryErrors");

// Mặc định thận trọng: bot chính thức 1,2 giây/tin; tài khoản cá nhân 3 giây/tin
// (100 người ≈ 5 phút). Chỉnh được bằng biến môi trường mà không sửa mã.
const DEFAULT_OFFICIAL_INTERVAL_MS = 1200;
const DEFAULT_ZCA_INTERVAL_MS = 3000;

function envInterval(env, name, fallback) {
    const value = Number(env?.[name]);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function createSendPacer(options = {}) {
    const env = options.env || process.env;
    const enabled = options.enabled !== false;
    const log = typeof options.log === "function" ? options.log : () => {};
    const now = options.now;
    const sleep = options.sleep;

    const controllers = {
        official: createPacingController({
            settings: { intervalMs: envInterval(env, "BROADCAST_INTERVAL_MS", DEFAULT_OFFICIAL_INTERVAL_MS) },
            now,
            sleep,
            log
        }),
        zca: createPacingController({
            settings: { intervalMs: envInterval(env, "BROADCAST_ZCA_INTERVAL_MS", DEFAULT_ZCA_INTERVAL_MS) },
            now,
            sleep,
            log
        })
    };

    // Chuỗi công việc theo từng nhà cung cấp — đây là thứ bảo đảm TUẦN TỰ.
    const locks = new Map();

    function controllerFor(botId) {
        return isZcaId(botId) ? controllers.zca : controllers.official;
    }

    function withLock(botId, task) {
        const key = String(botId || "unknown");
        const previous = locks.get(key) || Promise.resolve();
        const next = previous.then(task, task);
        // Chuỗi không bao giờ được ở trạng thái rejected: nếu không, mọi lần gửi
        // sau sẽ nhận lỗi của lần trước thay vì chạy.
        locks.set(key, next.then(() => {}, () => {}));
        return next;
    }

    // Chạy `task` trong đúng nhịp của nhà cung cấp sở hữu `botId`.
    //
    // `task` trả về `{ sent }` hoặc `{ failed, error }` (cùng dạng sendNotification).
    // Trả về `{ deferred: true, retryAfterMs }` khi nhà cung cấp đang bị tạm dừng.
    async function run(botId, task) {
        if (!enabled) return task();
        return withLock(botId, async () => {
            const controller = controllerFor(botId);
            const gate = await controller.waitTurn(botId);
            if (gate) {
                return { deferred: true, reason: gate.reason || "provider_paused", retryAfterMs: gate.waitMs };
            }
            const outcome = await task();
            if (outcome?.sent) {
                controller.onSuccess(botId);
            } else if (outcome?.failed && outcome.error?.deliveryClassification?.kind === DELIVERY_ERROR_KIND.RATE_LIMIT) {
                const limit = controller.onRateLimit(botId, outcome.error);
                if (limit?.paused) {
                    log("warn", `${botId}: ${limit.strikeCount} lần bị giới hạn tốc độ ⇒ tạm dừng ${Math.round((limit.pauseMs || 0) / 1000)}s`);
                }
            }
            return outcome;
        });
    }

    function stats() {
        return {
            enabled,
            official: controllers.official.stats(),
            zca: controllers.zca.stats()
        };
    }

    function reset(botId) {
        if (botId === undefined) {
            controllers.official.reset();
            controllers.zca.reset();
            return;
        }
        controllerFor(botId).reset(botId);
    }

    return { enabled, controllerFor, reset, run, stats };
}

module.exports = {
    DEFAULT_OFFICIAL_INTERVAL_MS,
    DEFAULT_ZCA_INTERVAL_MS,
    createSendPacer,
    envInterval
};
