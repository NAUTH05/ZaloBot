const test = require("node:test");
const assert = require("node:assert/strict");

const {
    AiProviderError,
    ERROR_KIND,
    createDeepSeekProvider
} = require("../ai/deepseekProvider");

const API_KEY = "sk-test-secret-key-do-not-log";

function jsonResponse(statusCode, payload, headers = {}) {
    return {
        statusCode,
        headers,
        body: typeof payload === "string" ? payload : JSON.stringify(payload)
    };
}

function okResponse(content, usage = { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 }) {
    return jsonResponse(200, {
        id: "chatcmpl-test",
        model: "deepseek-chat",
        choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
        usage
    });
}

function createProvider(transport, overrides = {}) {
    return createDeepSeekProvider({
        apiKey: API_KEY,
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
        timeoutMs: 5000,
        maxRetries: 2,
        backoffMs: 0,
        sleep: async () => {},
        transport,
        ...overrides
    });
}

test("gửi đúng yêu cầu JSON tới endpoint chat/completions và đọc usage", async () => {
    const calls = [];
    const provider = createProvider(async (request) => {
        calls.push(request);
        return okResponse('{"decision":"answer","reply":"Chào cậu","actions":[]}');
    });

    const result = await provider.complete({
        messages: [{ role: "user", content: "xin chào" }],
        maxTokens: 321,
        jsonMode: true
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.Authorization, `Bearer ${API_KEY}`);

    const body = JSON.parse(calls[0].body);
    assert.equal(body.model, "deepseek-chat");
    assert.equal(body.max_tokens, 321);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.stream, false);

    assert.match(result.text, /Chào cậu/);
    assert.deepEqual(result.usage, { promptTokens: 120, completionTokens: 40, totalTokens: 160 });
});

test("402 hết số dư là lỗi dứt khoát: không thử lại", async () => {
    let attempts = 0;
    const provider = createProvider(async () => {
        attempts += 1;
        return jsonResponse(402, { error: { message: "Insufficient Balance" } });
    });

    await assert.rejects(provider.complete({ messages: [] }), (error) => {
        assert.ok(error instanceof AiProviderError);
        assert.equal(error.kind, ERROR_KIND.INSUFFICIENT_QUOTA);
        assert.equal(error.retryable, false);
        return true;
    });
    assert.equal(attempts, 1);
});

test("429 được thử lại và tôn trọng Retry-After", async () => {
    const waits = [];
    let attempts = 0;
    const provider = createProvider(async () => {
        attempts += 1;
        if (attempts === 1) return jsonResponse(429, { error: { message: "rate limit" } }, { "retry-after": "2" });
        return okResponse('{"decision":"answer","reply":"ok","actions":[]}');
    }, { sleep: async (ms) => waits.push(ms) });

    const result = await provider.complete({ messages: [] });
    assert.equal(attempts, 2);
    assert.deepEqual(waits, [2000]);
    assert.match(result.text, /ok/);
});

test("503 được thử lại rồi bỏ cuộc sau số lần cho phép", async () => {
    let attempts = 0;
    const provider = createProvider(async () => {
        attempts += 1;
        return jsonResponse(503, { error: { message: "overloaded" } });
    });

    await assert.rejects(provider.complete({ messages: [] }), (error) => {
        assert.equal(error.kind, ERROR_KIND.SERVER);
        assert.equal(error.retryable, true);
        return true;
    });
    assert.equal(attempts, 3, "1 lần đầu + 2 lần thử lại");
});

test("timeout được phân loại và thử lại", async () => {
    let attempts = 0;
    const provider = createProvider(async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("Hết thời gian chờ phản hồi"), { code: "ETIMEDOUT" });
        return okResponse('{"decision":"answer","reply":"xong","actions":[]}');
    });

    const result = await provider.complete({ messages: [] });
    assert.equal(attempts, 2);
    assert.match(result.text, /xong/);
});

test("401 sai khóa không thử lại và không lộ khóa trong thông điệp", async () => {
    const provider = createProvider(async () => jsonResponse(401, { error: { message: `bad key ${API_KEY}` } }));

    await assert.rejects(provider.complete({ messages: [] }), (error) => {
        assert.equal(error.kind, ERROR_KIND.AUTH);
        assert.equal(error.retryable, false);
        assert.ok(!error.message.includes(API_KEY), "thông điệp lỗi không được chứa khóa");
        return true;
    });
});

test("thiếu khóa API thì không gọi mạng", async () => {
    let called = false;
    const provider = createDeepSeekProvider({
        apiKey: "",
        transport: async () => { called = true; return okResponse("{}"); }
    });

    await assert.rejects(provider.complete({ messages: [] }), (error) => {
        assert.equal(error.kind, ERROR_KIND.DISABLED);
        return true;
    });
    assert.equal(called, false);
});

test("phản hồi không phải JSON hoặc thiếu nội dung bị từ chối", async () => {
    const brokenJson = createProvider(async () => jsonResponse(200, "day khong phai json"));
    await assert.rejects(brokenJson.complete({ messages: [] }), (error) => {
        assert.equal(error.kind, ERROR_KIND.BAD_RESPONSE);
        return true;
    });

    const emptyContent = createProvider(async () => jsonResponse(200, { choices: [{ message: { content: "   " } }] }));
    await assert.rejects(emptyContent.complete({ messages: [] }), (error) => {
        assert.equal(error.kind, ERROR_KIND.BAD_RESPONSE);
        return true;
    });
});

test("400 bị coi là lỗi yêu cầu, không thử lại", async () => {
    let attempts = 0;
    const provider = createProvider(async () => {
        attempts += 1;
        return jsonResponse(400, { error: { message: "invalid parameter" } });
    });

    await assert.rejects(provider.complete({ messages: [] }), (error) => {
        assert.equal(error.kind, ERROR_KIND.BAD_REQUEST);
        return true;
    });
    assert.equal(attempts, 1);
});
