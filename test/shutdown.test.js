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
        stopPolling: async () => { calls.push("polling"); },
        closeDashboard: async () => { calls.push("dashboard"); },
        flushPersistence: async () => { calls.push("persistence"); },
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

    assert.deepEqual(calls, ["scheduler", "polling", "dashboard", "persistence"]);
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

    assert.deepEqual(calls, ["scheduler", "dashboard", "persistence"]);
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
