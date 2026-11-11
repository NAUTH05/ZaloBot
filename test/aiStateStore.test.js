const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createAiStateStore, dayKey, monthKey } = require("../ai/aiStateStore");
const { estimateCostUsd, loadAiConfig } = require("../ai/aiConfig");

const tempFile = path.join(os.tmpdir(), `ai-state-test-${process.pid}-${Date.now()}.json`);

test.after(() => {
    try { fs.unlinkSync(tempFile); } catch (_) { /* không có cũng không sao */ }
});

function freshStore() {
    try { fs.unlinkSync(tempFile); } catch (_) { /* ignore */ }
    return createAiStateStore({ filePath: tempFile, defaultPath: tempFile });
}

test("khóa tháng và ngày tính theo giờ Việt Nam", () => {
    assert.equal(monthKey(new Date("2026-11-11T10:00:00Z")), "2026-11");
    // 23:30 UTC ngày 10 = 06:30 sáng 11/11 giờ Việt Nam.
    assert.equal(dayKey(new Date("2026-11-10T23:30:00Z")), "2026-11-11");
});

test("cộng dồn token và chi phí trong tháng", () => {
    const store = freshStore();
    const date = new Date("2026-11-11T10:00:00Z");

    store.recordUsage({ usage: { promptTokens: 1000, completionTokens: 500 }, costUsd: 0.0001, date });
    store.recordUsage({ usage: { promptTokens: 2000, completionTokens: 1000 }, costUsd: 0.0002, date });

    const usage = store.getMonthUsage(date);
    assert.equal(usage.requests, 2);
    assert.equal(usage.promptTokens, 3000);
    assert.equal(usage.completionTokens, 1500);
    assert.equal(usage.costUsd, 0.0003);
});

test("ngân sách chặn cứng khi chi phí chạm trần", () => {
    const store = freshStore();
    const date = new Date("2026-11-11T10:00:00Z");
    assert.equal(store.isBudgetExhausted({ budgetUsd: 2, date }), false);

    store.recordUsage({ usage: {}, costUsd: 2, date });
    assert.equal(store.isBudgetExhausted({ budgetUsd: 2, date }), true);
    // Ngân sách 0 hoặc không hợp lệ nghĩa là "không đặt trần", không phải "cấm tất cả".
    assert.equal(store.isBudgetExhausted({ budgetUsd: 0, date }), false);
});

test("hạn mức theo người và theo toàn hệ thống", () => {
    const store = freshStore();
    const date = new Date("2026-11-11T10:00:00Z");

    assert.equal(store.consumeQuota({ key: "bot1::chat::a", perUserLimit: 2, date }).allowed, true);
    assert.equal(store.consumeQuota({ key: "bot1::chat::a", perUserLimit: 2, date }).allowed, true);
    const third = store.consumeQuota({ key: "bot1::chat::a", perUserLimit: 2, date });
    assert.equal(third.allowed, false);
    assert.equal(third.reason, "user_daily_limit");

    // Người khác vẫn còn lượt.
    assert.equal(store.consumeQuota({ key: "bot1::chat::b", perUserLimit: 2, date }).allowed, true);

    const global = freshStore();
    assert.equal(global.consumeQuota({ key: "bot1::chat::a", globalLimit: 1, date }).allowed, true);
    const second = global.consumeQuota({ key: "bot1::chat::b", globalLimit: 1, date });
    assert.equal(second.allowed, false);
    assert.equal(second.reason, "global_daily_limit");
});

test("hạn mức đếm lại theo ngày mới", () => {
    const store = freshStore();
    const day1 = new Date("2026-11-11T10:00:00Z");
    const day2 = new Date("2026-11-12T10:00:00Z");

    assert.equal(store.consumeQuota({ key: "bot1::chat::a", perUserLimit: 1, date: day1 }).allowed, true);
    assert.equal(store.consumeQuota({ key: "bot1::chat::a", perUserLimit: 1, date: day1 }).allowed, false);
    assert.equal(store.consumeQuota({ key: "bot1::chat::a", perUserLimit: 1, date: day2 }).allowed, true);
});

test("đánh dấu đã thông báo xử lý dữ liệu", () => {
    const store = freshStore();
    assert.equal(store.hasSeenDisclosure("bot1::chat::a"), false);
    store.markDisclosure("bot1::chat::a", new Date("2026-11-11T10:00:00Z"));
    assert.equal(store.hasSeenDisclosure("bot1::chat::a"), true);
    assert.equal(store.hasSeenDisclosure("bot1::chat::b"), false);
});

test("ước tính chi phí dùng đúng token do API báo về", () => {
    const config = loadAiConfig({});
    const cost = estimateCostUsd({ promptTokens: 1_000_000, completionTokens: 0 }, config);
    assert.equal(cost, config.priceInputPer1mUsd);

    const outputCost = estimateCostUsd({ promptTokens: 0, completionTokens: 1_000_000 }, config);
    assert.equal(outputCost, config.priceOutputPer1mUsd);

    assert.equal(estimateCostUsd({}, config), 0);
});

test("cấu hình AI đọc đúng biến môi trường và bỏ giá trị rác", () => {
    const config = loadAiConfig({
        AI_ASSISTANT_ENABLED: "true",
        DEEPSEEK_API_KEY: "  sk-abc  ",
        AI_MAX_HISTORY_MESSAGES: "abc",
        AI_MAX_REQUESTS_PER_USER_PER_DAY: "-5",
        AI_MONTHLY_BUDGET_USD: "1.5",
        AI_ENABLE_GROUP_ASSISTANT: "yes"
    });

    assert.equal(config.enabled, true);
    assert.equal(config.configured, true);
    assert.equal(config.apiKey, "sk-abc");
    // Giá trị rác quay về mặc định thay vì biến thành 0.
    assert.equal(config.maxHistoryMessages, 8);
    assert.equal(config.maxRequestsPerUserPerDay, 10);
    assert.equal(config.monthlyBudgetUsd, 1.5);
    assert.equal(config.enableGroupAssistant, true);
});

test("bật cờ nhưng thiếu khóa thì không coi là đã cấu hình", () => {
    const config = loadAiConfig({ AI_ASSISTANT_ENABLED: "true" });
    assert.equal(config.enabled, true);
    assert.equal(config.configured, false);
});
