// ============================================================================
// Đo lường nhẹ cho runtime: bộ nhớ định kỳ và mốc thời gian khởi động.
//
// Không phụ thuộc thư viện ngoài. Mọi thứ đều có thể tắt qua biến môi trường để
// môi trường kiểm thử không bị log rác.
//
// Vì sao cần: sự cố PM2 restart vì RSS vượt ngưỡng trong khi heap V8 vẫn nhỏ cho
// thấy RSS đến từ bộ nhớ NGOÀI heap (đệm, ArrayBuffer, thư viện native, hàng đợi
// chờ ghi). Chỉ số heap không đủ để thấy điều đó — phải log cả external và
// arrayBuffers mới phân biệt được.
// ============================================================================

const MB = 1024 * 1024;

function readMemory() {
    const usage = process.memoryUsage();
    return {
        rss: usage.rss,
        heapUsed: usage.heapUsed,
        heapTotal: usage.heapTotal,
        external: usage.external,
        arrayBuffers: usage.arrayBuffers || 0
    };
}

function formatMb(bytes) {
    return `${(Number(bytes || 0) / MB).toFixed(1)}MB`;
}

function formatMemoryLine(memory) {
    return `rss=${formatMb(memory.rss)} heapUsed=${formatMb(memory.heapUsed)} ` +
        `heapTotal=${formatMb(memory.heapTotal)} external=${formatMb(memory.external)} ` +
        `arrayBuffers=${formatMb(memory.arrayBuffers)}`;
}

function isTruthy(value) {
    return ["1", "true", "yes", "on"].includes(String(value == null ? "" : value).trim().toLowerCase());
}

function positiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createRuntimeMetrics(options = {}) {
    const env = options.env || process.env;
    const enabled = options.enabled === undefined ? isTruthy(env.MEMORY_LOG_ENABLED) : options.enabled;
    const intervalMs = positiveNumber(options.intervalMs || env.MEMORY_LOG_INTERVAL_MS, 60000);
    const warnBytes = positiveNumber(options.warnMb || env.MEMORY_WARN_MB, 800) * MB;

    // Nguồn số liệu phụ do phần còn lại của ứng dụng cung cấp (hàng đợi ghi, hàng
    // đợi gửi, số job...). Không giữ tham chiếu tới chúng ngoài lúc gọi.
    let diagnosticsProvider = null;

    const startupMarks = [];
    const startupStart = Date.now();

    let timer = null;
    let lastSnapshot = readMemory();

    function mark(label) {
        const at = Date.now();
        startupMarks.push({ label, at, sinceStartMs: at - startupStart });
        console.log(`[Startup] ${label}: ${at - startupStart}ms`);
        return at;
    }

    function logMemory(label) {
        if (!enabled) return null;
        const memory = readMemory();
        lastSnapshot = memory;
        console.log(`[Memory] ${label ? `${label} ` : ""}${formatMemoryLine(memory)}`);
        if (memory.rss >= warnBytes) logWarning(memory);
        return memory;
    }

    // Khi RSS vượt ngưỡng, in thêm ngữ cảnh để biết cái gì đang giữ bộ nhớ — thay
    // vì chỉ báo "RSS cao" mà không nói được nguồn.
    function logWarning(memory) {
        console.warn(`[Memory] CẢNH BÁO vượt ${formatMb(warnBytes)}: ${formatMemoryLine(memory)}`);
        if (typeof diagnosticsProvider !== "function") return;
        try {
            const diagnostics = diagnosticsProvider() || {};
            for (const [key, value] of Object.entries(diagnostics)) {
                console.warn(`[Memory]   ${key}=${typeof value === "object" ? JSON.stringify(value) : value}`);
            }
        } catch (error) {
            console.warn(`[Memory]   không lấy được chẩn đoán: ${error.message}`);
        }
    }

    function start() {
        if (!enabled || timer) return false;
        // unref: log định kỳ không được giữ tiến trình sống khi đang tắt.
        timer = setInterval(() => logMemory(), intervalMs);
        if (typeof timer.unref === "function") timer.unref();
        logMemory("khởi động");
        return true;
    }

    function stop() {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    function summary() {
        const total = Date.now() - startupStart;
        const lines = startupMarks.map((item) => `[Startup] ${item.label}: ${item.sinceStartMs}ms`);
        lines.push(`[Startup] Full runtime ready: ${total}ms`);
        return { totalMs: total, marks: [...startupMarks], text: lines.join("\n") };
    }

    return {
        formatMemoryLine,
        logMemory,
        mark,
        readMemory,
        setDiagnosticsProvider: (fn) => { diagnosticsProvider = fn; },
        start,
        stop,
        summary,
        get enabled() { return enabled; },
        get lastSnapshot() { return lastSnapshot; }
    };
}

module.exports = { createRuntimeMetrics, formatMb, formatMemoryLine, readMemory };
