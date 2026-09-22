// Điều khiển dừng tiến trình an toàn cho SIGINT/SIGTERM.
// Tách riêng để có thể kiểm thử mà không cần khởi động tiến trình thật.
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8000;

function createShutdownController(options = {}) {
    const {
        timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
        log = () => {},
        stopScheduler = async () => {},
        stopPolling = async () => {},
        closeDashboard = async () => {},
        flushPersistence = async () => {},
        exit = (code) => { process.exit(code); }
    } = options;

    let started = false;
    let running = null;

    async function runSteps(signal) {
        const steps = [];
        const actions = [
            ["scheduler", stopScheduler],
            ["polling", stopPolling],
            ["dashboard", closeDashboard],
            ["persistence", flushPersistence]
        ];
        for (const [name, action] of actions) {
            try {
                await action(signal);
                steps.push({ name, ok: true });
            } catch (error) {
                const message = error?.message || String(error);
                steps.push({ name, ok: false, error: message });
                log(`[Runtime] Không thể dừng ${name}: ${message}`);
            }
        }
        return { timedOut: false, steps };
    }

    async function execute(signal) {
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
