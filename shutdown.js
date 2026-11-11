// Điều khiển dừng tiến trình an toàn cho SIGINT/SIGTERM.
// Tách riêng để có thể kiểm thử mà không cần khởi động tiến trình thật.
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8000;

function createShutdownController(options = {}) {
    const {
        timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
        log = () => {},
        stopScheduler = async () => {},
        stopOutboundQueues = async () => {},
        stopPolling = async () => {},
        closeDashboard = async () => {},
        flushPersistence = async () => {},
        stopMetrics = async () => {},
        exit = (code) => { process.exit(code); }
    } = options;

    let started = false;
    let running = null;

    async function runSteps(signal) {
        const steps = [];
        // Thứ tự có ý nghĩa:
        //   1. scheduler trước — không nhận thêm việc theo giờ nữa
        //   2. hàng đợi gửi — chờ các tin đang gửi dở kết thúc, không bắt đầu tin mới
        //   3. polling — ngắt nguồn tin vào
        //   4. dashboard — không nhận thêm thao tác quản trị
        //   5. persistence — ghi nốt trạng thái cuối cùng
        const actions = [
            ["scheduler", stopScheduler],
            ["outbound queues", stopOutboundQueues],
            ["providers", stopPolling],
            ["dashboard", closeDashboard],
            ["persistence", flushPersistence],
            ["metrics", stopMetrics]
        ];
        for (const [name, action] of actions) {
            const stepStart = Date.now();
            try {
                await action(signal);
                const elapsed = Date.now() - stepStart;
                steps.push({ name, ok: true, ms: elapsed });
                log(`[Shutdown] ${name}: ${elapsed}ms`);
            } catch (error) {
                const message = error?.message || String(error);
                const elapsed = Date.now() - stepStart;
                steps.push({ name, ok: false, error: message, ms: elapsed });
                log(`[Shutdown] ${name}: thất bại sau ${elapsed}ms - ${message}`);
            }
        }
        return { timedOut: false, steps };
    }

    async function execute(signal) {
        // Không kiểm tra `started` ở đây: run() đã lo việc chạy một lần duy nhất
        // và gọi execute() sau khi đặt cờ. Thêm chốt nữa ở đây sẽ khiến execute()
        // thoát ngay mà không chạy bước nào.
        const totalStart = Date.now();
        log(`[Runtime] Nhận ${signal}. Đang dừng an toàn...`);
        let timer = null;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
        });

        const result = await Promise.race([runSteps(signal), timeout]);
        if (timer) clearTimeout(timer);

        if (result.timedOut) {
            log(`[Runtime] Quá thời gian dừng ${timeoutMs}ms, thoát ngay.`);
            exit(1);
            return result;
        }

        log(`[Shutdown] total: ${Date.now() - totalStart}ms`);
        log("[Runtime] Đã dừng an toàn.");
        exit(0);
        return result;
    }

    // Chỉ chạy một lần dù nhận nhiều tín hiệu.
    function run(signal = "SIGTERM") {
        if (started) return running;
        started = true;
        running = execute(signal);
        return running;
    }

    return { run, isRunning: () => started };
}

module.exports = { DEFAULT_SHUTDOWN_TIMEOUT_MS, createShutdownController };
