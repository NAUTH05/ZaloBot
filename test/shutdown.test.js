const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_SHUTDOWN_TIMEOUT_MS, createShutdownController } = require("../shutdown");

function controllerWith(overrides = {}) {
    const calls = [];
    const exitCodes = [];
    const controller = createShutdownController({
        timeoutMs: 200,
        log: () => {},
        stopScheduler: async () => { calls.push("scheduler"); },
        stopOutboundQueues: async () => { calls.push("outbound queues"); },
        stopPolling: async () => { calls.push("providers"); },
        closeDashboard: async () => { calls.push("dashboard"); },
        flushPersistence: async () => { calls.push("persistence"); },
        stopMetrics: async () => { calls.push("metrics"); },
        exit: (code) => { exitCodes.push(code); },
        ...overrides
    });
    return { controller, calls, exitCodes };
}

test("shutdown chỉ chạy một lần và theo đúng thứ tự", async () => {
    const { controller, calls, exitCodes } = controllerWith();

    const first = controller.run("SIGTERM");
    const second = controller.run("SIGTERM");
    assert.equal(first, second, "lần gọi thứ hai phải dùng lại cùng một lần chạy");
    await first;

    assert.deepEqual(calls, ["scheduler", "outbound queues", "providers", "dashboard", "persistence", "metrics"]);
    assert.deepEqual(exitCodes, [0]);
    assert.equal(controller.isRunning(), true);
});

test("flushPersistenceWrites được chờ trước khi thoát", async () => {
    let flushed = false;
    const { controller, exitCodes } = controllerWith({
        flushPersistence: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            flushed = true;
        },
        exit: (code) => {
            assert.equal(flushed, true, "phải flush xong mới thoát");
            exitCodes.push(code);
        }
    });

    await controller.run("SIGINT");
    assert.deepEqual(exitCodes, [0]);
});

test("một bước lỗi không chặn các bước còn lại", async () => {
    const { controller, calls, exitCodes } = controllerWith({
        stopPolling: async () => { throw new Error("polling stop failed"); }
    });

    await controller.run("SIGTERM");

    // Bước lỗi bị bỏ qua, các bước còn lại vẫn chạy đủ và đúng thứ tự.
    assert.deepEqual(calls, ["scheduler", "outbound queues", "dashboard", "persistence", "metrics"]);
    assert.deepEqual(exitCodes, [0]);
});

test("quá thời gian dừng thì thoát với mã lỗi", async () => {
    const { controller, calls, exitCodes } = controllerWith({
        timeoutMs: 20,
        stopScheduler: () => new Promise(() => {})
    });

    await controller.run("SIGTERM");

    assert.deepEqual(exitCodes, [1]);
    assert.deepEqual(calls, [], "không chờ được bước nào thì không chạy tiếp");
});

test("thời gian dừng mặc định là số dương", () => {
    assert.equal(typeof DEFAULT_SHUTDOWN_TIMEOUT_MS, "number");
    assert.ok(DEFAULT_SHUTDOWN_TIMEOUT_MS > 0);
});

test("dừng máy hoàn tất nhanh khi các bước bình thường", async () => {
    const { controller } = controllerWith();
    const begin = Date.now();
    await controller.run("SIGTERM");
    const elapsed = Date.now() - begin;

    // Các bước giả đều tức thời, nên tổng phải rất nhỏ. Đây là chốt chống hồi quy:
    // nếu một bước bị treo (ví dụ polling.stop() gọi sai API), thời gian sẽ vọt lên.
    assert.ok(elapsed < 500, `dừng máy phải nhanh, mất ${elapsed}ms`);
});

test("bước dừng hàng đợi gửi chạy TRƯỚC khi ngắt nhà cung cấp", async () => {
    const order = [];
    const { controller } = controllerWith({
        stopOutboundQueues: async () => { order.push("queues"); },
        stopPolling: async () => { order.push("providers"); }
    });
    await controller.run("SIGTERM");
    assert.deepEqual(order, ["queues", "providers"], "phải ngừng nhận việc gửi mới trước khi ngắt provider");
});

test("metrics được dừng ở bước cuối", async () => {
    const order = [];
    const { controller } = controllerWith({
        flushPersistence: async () => { order.push("persistence"); },
        stopMetrics: async () => { order.push("metrics"); }
    });
    await controller.run("SIGTERM");
    assert.deepEqual(order, ["persistence", "metrics"]);
});
