// ============================================================================
// Tạm dừng trợ lý AI khi quản trị viên trả lời trực tiếp.
//
// Ba thứ phải đúng:
//   1. Trạng thái hết hạn được xét LÚC ĐỌC — không cần bộ hẹn giờ, và trợ lý tự
//      chạy lại đúng thời điểm đã đặt.
//   2. Phạm vi hẹp (một cuộc trò chuyện) thắng phạm vi rộng (toàn bộ).
//   3. Đang tạm dừng thì KHÔNG gọi mô hình, nhưng lệnh thường và lời xác nhận vẫn
//      hoạt động.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Cách ly khỏi adminSettings.json thật: cùng lý do như test/adminServer.test.js —
// `node --test` chạy song song và không file kiểm tra nào được ghi tệp runtime.
const persistencePath = require.resolve("../firestorePersistence");
const realPersistence = require(persistencePath);
const memoryFiles = new Map();
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const fileKey = (filePath, defaultPath) => path.resolve(filePath || defaultPath);

require.cache[persistencePath] = {
    id: persistencePath,
    filename: persistencePath,
    loaded: true,
    exports: {
        ...realPersistence,
        readJsonStore: (filePath, defaultPath, fallback) => {
            const key = fileKey(filePath, defaultPath);
            if (!memoryFiles.has(key)) memoryFiles.set(key, clone(fallback) ?? null);
            return clone(memoryFiles.get(key));
        },
        writeJsonStore: (filePath, defaultPath, value) => {
            memoryFiles.set(fileKey(filePath, defaultPath), clone(value));
        }
    }
};

const { normalizeAiPause, setAiPause, getAdminSettings } = require("../adminSettings");
const { describeAiPause, resolveAiPause } = require("../aiPause");
const { createAssistant } = require("../ai/assistantService");
const { loadAiConfig } = require("../ai/aiConfig");

function reset() {
    memoryFiles.clear();
}

const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

test("mục đã hết hạn bị loại khỏi trạng thái tạm dừng", () => {
    const state = normalizeAiPause({
        global: { paused: true, until: iso(-60_000) },
        chats: {
            "bot1::chat-old": { paused: true, until: iso(-1000) },
            "bot1::chat-live": { paused: true, until: iso(60_000) }
        }
    });

    assert.equal(state.global.paused, false, "đã quá `until` thì không còn tạm dừng");
    assert.deepEqual(Object.keys(state.chats), ["bot1::chat-live"]);
});

test("tạm dừng không có hạn vẫn còn hiệu lực", () => {
    const state = normalizeAiPause({ global: { paused: true, until: null } });
    assert.equal(state.global.paused, true);
    assert.equal(resolveAiPause(state, { botId: "bot1", chatId: "x" }).scope, "global");
});

test("phạm vi một cuộc trò chuyện thắng phạm vi toàn bộ", () => {
    const state = normalizeAiPause({
        global: { paused: true, reason: "trực hỗ trợ" },
        chats: { "bot2::chat-9": { paused: true, reason: "đang trả lời tay" } }
    });

    const chat = resolveAiPause(state, { botId: "bot2", chatId: "chat-9" });
    assert.equal(chat.scope, "chat");
    assert.equal(chat.reason, "đang trả lời tay");

    const other = resolveAiPause(state, { botId: "bot1", chatId: "chat-9" });
    assert.equal(other.scope, "global", "cùng chatId nhưng khác bot là cuộc trò chuyện khác");
});

test("setAiPause ghi vào adminSettings và tự hết hạn", () => {
    reset();
    setAiPause({ scope: "global", paused: true, minutes: 30, reason: "trực hỗ trợ", actor: "admin" });

    const saved = getAdminSettings().aiPause;
    assert.equal(saved.global.paused, true);
    assert.equal(saved.global.updatedBy, "admin");
    assert.ok(Date.parse(saved.global.until) > Date.now(), "until phải ở tương lai");

    const described = describeAiPause(saved);
    assert.equal(described.anyActive, true);
    assert.equal(described.global.active, true);

    setAiPause({ scope: "global", paused: false });
    assert.equal(getAdminSettings().aiPause.global.paused, false);
    assert.equal(describeAiPause(getAdminSettings().aiPause).anyActive, false);
});

test("tạm dừng theo cuộc trò chuyện cần đủ botId và chatId", () => {
    reset();
    assert.throws(() => setAiPause({ scope: "chat", chatId: "c1", paused: true }), /botId/);
    assert.throws(() => setAiPause({ scope: "chat", botId: "bot1", paused: true }), /chatId/);
    assert.throws(() => setAiPause({ scope: "nonsense", paused: true }), /scope/);
    assert.throws(() => setAiPause({ scope: "global", minutes: 5000 }), /minutes/);

    setAiPause({ scope: "chat", botId: "bot1", chatId: "c1", paused: true, minutes: 15 });
    const described = describeAiPause(getAdminSettings().aiPause);
    assert.equal(described.chats.length, 1);
    assert.equal(described.chats[0].botId, "bot1");
    assert.equal(described.chats[0].chatId, "c1");

    setAiPause({ scope: "chat", botId: "bot1", chatId: "c1", paused: false });
    assert.equal(describeAiPause(getAdminSettings().aiPause).chats.length, 0);
});

test("đang tạm dừng thì không gọi mô hình và không gửi gì", async () => {
    let providerCalls = 0;
    const provider = {
        async complete() {
            providerCalls += 1;
            throw new Error("không được gọi mô hình khi đang tạm dừng");
        }
    };
    const config = loadAiConfig({ AI_ASSISTANT_ENABLED: "true", DEEPSEEK_API_KEY: "sk-test", AI_COOLDOWN_MS: "0" });
    const sent = [];
    const assistant = createAssistant({
        config,
        provider,
        executor: { async prepare() { return { ok: true, steps: [] }; }, async execute() { return { ok: true, results: [] }; } },
        accessCheck: () => ({ allowed: true }),
        historyProvider: async () => [],
        getSubscription: () => null,
        isOwner: () => false,
        readAiSettings: () => ({}),
        readPause: () => ({ paused: true, scope: "global", reason: "trực hỗ trợ" }),
        logger: { warn() {}, error() {}, info() {} }
    });

    const outcome = await assistant.handleTurn({
        context: { botId: "bot1", chatId: "chat-1", userId: "user-1" },
        text: "hôm nay học gì?",
        send: async (message) => { sent.push(message); }
    });

    assert.equal(outcome.handled, false);
    assert.equal(outcome.reason, "ai_paused");
    assert.equal(providerCalls, 0, "tạm dừng phải chặn TRƯỚC khi gọi API");
    assert.deepEqual(sent, [], "im lặng hoàn toàn, không gửi câu giải thích");
});

test("trạng thái trả về cho dashboard có cờ active đã tính sẵn", () => {
    const described = describeAiPause(normalizeAiPause({
        global: { paused: true, until: iso(600_000), reason: "họp" },
        chats: { "bot1::c2": { paused: true, until: iso(600_000) } }
    }));
    assert.equal(described.global.active, true);
    assert.equal(described.global.reason, "họp");
    assert.equal(described.chats[0].active, true);
    assert.equal(described.anyActive, true);
});
