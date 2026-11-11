// ============================================================================
// Giới hạn số việc chạy song song, và hàng đợi gửi RIÊNG cho từng nhà cung cấp.
//
// Vì sao cần:
//   - Gửi tuần tự (cách cũ) thì chậm: 500 đích × 200ms = 100 giây cho một thông báo.
//   - Gửi bằng Promise.all thì mở hàng trăm request cùng lúc, dễ ăn 429 và làm
//     RSS vọt lên vì mọi phản hồi đến cùng một lúc.
//   - Một hàng đợi chung cho mọi bot khiến bot1 phải chờ bot2, và một đợt thông báo
//     lớn có thể chặn luôn câu trả lời cho người dùng đang nhắn tới.
//
// Nên: mỗi nhà cung cấp một hàng đợi riêng, mỗi hàng đợi có trần song song, và
// việc tương tác (trả lời người dùng) được ưu tiên hơn việc hàng loạt.
// ============================================================================

const PRIORITY = Object.freeze({
    // Số nhỏ chạy trước.
    INTERACTIVE: 0,   // trả lời trực tiếp người dùng
    SCHEDULED: 1,     // nhắc lịch theo giờ
    BULK: 2           // thông báo hàng loạt
});

function positiveInt(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Hàng đợi FIFO có trần song song và mức ưu tiên.
//
// Hàng đợi này KHÔNG tự thử lại: việc thử lại (và chờ bao lâu) thuộc về nơi gọi,
// vì chỉ nơi đó mới biết lỗi là vĩnh viễn hay tạm thời.
function createSendQueue(options = {}) {
    const concurrency = positiveInt(options.concurrency, 8);
    const name = options.name || "queue";

    // Mỗi mức ưu tiên một hàng riêng để việc nhỏ luôn được chen trước việc lớn.
    const lanes = new Map([
        [PRIORITY.INTERACTIVE, []],
        [PRIORITY.SCHEDULED, []],
        [PRIORITY.BULK, []]
    ]);
    let active = 0;
    let idleResolvers = [];
    // Sau khi dừng nhận việc, hàng đợi vẫn chạy nốt việc đang chờ nhưng từ chối
    // mọi việc mới — để lúc tắt không bắt đầu thêm tin nhắn nào.
    let accepting = true;
    const stats = { queued: 0, active: 0, completed: 0, failed: 0, maxActive: 0 };

    function totalQueued() {
        let total = 0;
        for (const lane of lanes.values()) total += lane.length;
        return total;
    }

    function takeNext() {
        // Mức ưu tiên nhỏ nhất (quan trọng nhất) được lấy trước.
        for (const priority of [...lanes.keys()].sort((a, b) => a - b)) {
            const lane = lanes.get(priority);
            if (lane.length > 0) return lane.shift();
        }
        return null;
    }

    function drain() {
        while (active < concurrency) {
            const task = takeNext();
            if (!task) break;
            active += 1;
            stats.active = active;
            stats.maxActive = Math.max(stats.maxActive, active);

            // Số liệu completed/failed do chính wrapper của việc đó cập nhật.
            Promise.resolve()
                .then(task.run)
                .catch(() => {})
                .finally(() => {
                    active -= 1;
                    stats.active = active;
                    if (totalQueued() === 0 && active === 0) {
                        const resolvers = idleResolvers;
                        idleResolvers = [];
                        for (const resolve of resolvers) resolve();
                    } else {
                        drain();
                    }
                });
        }
    }

    // Xếp một việc vào hàng đợi. Trả về Promise của chính việc đó.
    function enqueue(run, priority = PRIORITY.BULK) {
        if (!accepting) {
            return Promise.reject(new Error("Hàng đợi đã dừng nhận việc (đang tắt tiến trình)"));
        }
        const lane = lanes.get(priority) || lanes.get(PRIORITY.BULK);
        return new Promise((resolve, reject) => {
            lane.push({
                async run() {
                    try {
                        const value = await run();
                        // Đếm TRƯỚC khi resolve: nếu đếm ở .then() bên ngoài thì
                        // người gọi await xong vẫn thấy số liệu chưa kịp cập nhật.
                        stats.completed += 1;
                        resolve(value);
                        return value;
                    } catch (error) {
                        stats.failed += 1;
                        reject(error);
                        throw error;
                    }
                }
            });
            stats.queued += 1;
            drain();
        });
    }

    // Chờ tới khi hàng đợi rỗng và không còn việc nào đang chạy.
    function onIdle() {
        if (totalQueued() === 0 && active === 0) return Promise.resolve();
        return new Promise((resolve) => idleResolvers.push(resolve));
    }

    function stopAccepting() {
        accepting = false;
    }

    return {
        concurrency,
        enqueue,
        stopAccepting,
        getStats: () => ({ name, concurrency, queued: totalQueued(), ...stats }),
        onIdle,
        get pending() { return totalQueued() + active; }
    };
}

// Bộ đếm cho toàn hệ thống: mỗi nhà cung cấp một hàng đợi riêng.
function createProviderQueues(options = {}) {
    const env = options.env || process.env;
    const officialConcurrency = positiveInt(
        options.officialConcurrency || env.OFFICIAL_SEND_CONCURRENCY, 8
    );
    const zcaConcurrency = positiveInt(
        options.zcaConcurrency || env.ZCA_SEND_CONCURRENCY, 4
    );

    const queues = new Map();

    function queueFor(botId) {
        const key = String(botId || "unknown");
        if (!queues.has(key)) {
            const isZca = key.startsWith("zca:");
            queues.set(key, createSendQueue({
                name: key,
                concurrency: isZca ? zcaConcurrency : officialConcurrency
            }));
        }
        return queues.get(key);
    }

    async function enqueueFor(botId, run, priority = PRIORITY.BULK) {
        return queueFor(botId).enqueue(run, priority);
    }

    async function drainAll() {
        await Promise.allSettled([...queues.values()].map((queue) => queue.onIdle()));
    }

    function getStats() {
        const result = {};
        for (const [botId, queue] of queues) result[botId] = queue.getStats();
        return result;
    }

    // Dừng nhận việc mới rồi chờ mọi việc đang chạy kết thúc.
    async function stopAll() {
        for (const queue of queues.values()) queue.stopAccepting();
        await drainAll();
    }

    return {
        drainAll,
        enqueueFor,
        getStats,
        queueFor,
        stopAll,
        get size() { return queues.size; }
    };
}

module.exports = { PRIORITY, createProviderQueues, createSendQueue, positiveInt };
