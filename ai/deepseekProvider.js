// Adapter DeepSeek (OpenAI-compatible Chat Completions).
//
// Vì sao tự viết bằng `https` thay vì thêm SDK: dự án đã dùng đúng cách này cho
// Gemini (aiAssistant.js) và yêu cầu không thêm phụ thuộc không cần thiết. Ở đây
// chỉ có một endpoint, một định dạng JSON, nên một lớp mỏng là đủ và dễ kiểm thử.
//
// Quy ước an toàn:
//   - Không bao giờ ghi log khóa API, header Authorization hay toàn bộ URL có key.
//   - Mọi lỗi được phân loại thành `kind` để nơi gọi quyết định thông điệp.
//   - Chỉ thử lại lỗi TẠM THỜI (429/5xx/timeout/mạng). 402 (hết số dư) và 401
//     (sai khóa) là lỗi dứt khoát: thử lại chỉ tốn thời gian của người dùng.

const https = require("https");

const ENDPOINT_PATH = "/chat/completions";

const ERROR_KIND = Object.freeze({
    AUTH: "auth",
    INSUFFICIENT_QUOTA: "insufficient_quota",
    RATE_LIMIT: "rate_limit",
    BAD_REQUEST: "bad_request",
    SERVER: "server",
    TIMEOUT: "timeout",
    NETWORK: "network",
    BAD_RESPONSE: "bad_response",
    DISABLED: "disabled"
});

const RETRYABLE_KINDS = new Set([
    ERROR_KIND.RATE_LIMIT,
    ERROR_KIND.SERVER,
    ERROR_KIND.TIMEOUT,
    ERROR_KIND.NETWORK
]);

class AiProviderError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = "AiProviderError";
        this.kind = options.kind || ERROR_KIND.NETWORK;
        this.statusCode = options.statusCode || null;
        this.retryable = options.retryable === undefined
            ? RETRYABLE_KINDS.has(this.kind)
            : options.retryable;
        this.retryAfterMs = options.retryAfterMs || null;
        this.attempts = options.attempts || 1;
    }
}

// Một request HTTPS thô. Tách riêng để bộ kiểm tra thay được bằng hàm giả mà
// không cần mạng thật và không cần khóa API thật.
function httpsTransport({ url, method = "POST", headers = {}, body = "", timeoutMs = 20000 }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            fn(value);
        };

        const request = https.request(url, { method, headers, timeout: timeoutMs }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => finish(resolve, {
                statusCode: response.statusCode || 0,
                headers: response.headers || {},
                body: Buffer.concat(chunks).toString("utf8")
            }));
            response.on("error", (error) => finish(reject, error));
        });

        request.on("error", (error) => finish(reject, error));
        request.on("timeout", () => {
            request.destroy();
            finish(reject, Object.assign(new Error("Hết thời gian chờ phản hồi"), { code: "ETIMEDOUT" }));
        });
        if (body) request.write(body);
        request.end();
    });
}

function parseRetryAfterMs(headers) {
    const raw = headers?.["retry-after"];
    if (raw === undefined || raw === null) return null;
    const seconds = Number(String(raw).trim());
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30000);
    return null;
}

// Đọc thông điệp lỗi của nhà cung cấp nhưng KHÔNG trả nguyên văn cho người dùng:
// nội dung đó có thể chứa chi tiết hạ tầng. Chỉ dùng để ghi log nội bộ.
function describeErrorBody(body) {
    try {
        const parsed = JSON.parse(body);
        const message = parsed?.error?.message || parsed?.message;
        return typeof message === "string" ? message.slice(0, 300) : "";
    } catch (_) {
        return "";
    }
}

function classifyStatus(statusCode, headers, body) {
    if (statusCode === 401 || statusCode === 403) {
        return new AiProviderError("Khóa DeepSeek không hợp lệ hoặc không có quyền", {
            kind: ERROR_KIND.AUTH,
            statusCode,
            retryable: false
        });
    }
    if (statusCode === 402) {
        return new AiProviderError("Tài khoản DeepSeek đã hết số dư", {
            kind: ERROR_KIND.INSUFFICIENT_QUOTA,
            statusCode,
            retryable: false
        });
    }
    if (statusCode === 429) {
        return new AiProviderError("DeepSeek giới hạn tần suất", {
            kind: ERROR_KIND.RATE_LIMIT,
            statusCode,
            retryable: true,
            retryAfterMs: parseRetryAfterMs(headers)
        });
    }
    if (statusCode >= 500) {
        return new AiProviderError("Máy chủ DeepSeek đang lỗi", {
            kind: ERROR_KIND.SERVER,
            statusCode,
            retryable: true,
            retryAfterMs: parseRetryAfterMs(headers)
        });
    }
    const detail = describeErrorBody(body);
    return new AiProviderError(detail ? `Yêu cầu DeepSeek không hợp lệ: ${detail}` : "Yêu cầu DeepSeek không hợp lệ", {
        kind: ERROR_KIND.BAD_REQUEST,
        statusCode,
        retryable: false
    });
}

function normalizeUsage(raw) {
    const promptTokens = Number(raw?.prompt_tokens || 0);
    const completionTokens = Number(raw?.completion_tokens || 0);
    const totalTokens = Number(raw?.total_tokens || promptTokens + completionTokens);
    return {
        promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
        completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
        totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0
    };
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// `options.transport` cho phép bộ kiểm tra bơm phản hồi giả. `options.sleep`
// cho phép bỏ qua thời gian chờ thật khi thử lại.
function createDeepSeekProvider(options = {}) {
    const apiKey = String(options.apiKey || "").trim();
    const baseUrl = String(options.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
    const model = options.model || "deepseek-chat";
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20000;
    const maxRetries = Number.isInteger(options.maxRetries) ? Math.max(0, options.maxRetries) : 2;
    const backoffMs = Number(options.backoffMs) >= 0 ? Number(options.backoffMs) : 400;
    const transport = typeof options.transport === "function" ? options.transport : httpsTransport;
    const sleep = typeof options.sleep === "function" ? options.sleep : delay;

    function assertUsable() {
        if (!apiKey) {
            throw new AiProviderError("Chưa cấu hình DEEPSEEK_API_KEY", {
                kind: ERROR_KIND.DISABLED,
                retryable: false
            });
        }
    }

    function buildPayload({ messages, maxTokens, temperature = 0.3, jsonMode = true }) {
        const payload = {
            model,
            messages,
            max_tokens: Number(maxTokens) > 0 ? Number(maxTokens) : 500,
            temperature,
            stream: false
        };
        if (jsonMode) payload.response_format = { type: "json_object" };
        return payload;
    }

    async function requestOnce(payload) {
        const url = `${baseUrl}${ENDPOINT_PATH}`;
        let response;
        try {
            response = await transport({
                url,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Length": Buffer.byteLength(JSON.stringify(payload))
                },
                body: JSON.stringify(payload),
                timeoutMs
            });
        } catch (error) {
            const timedOut = error?.code === "ETIMEDOUT" || /timeout|hết thời gian/i.test(String(error?.message || ""));
            throw new AiProviderError(timedOut ? "DeepSeek phản hồi quá chậm" : "Không kết nối được tới DeepSeek", {
                kind: timedOut ? ERROR_KIND.TIMEOUT : ERROR_KIND.NETWORK,
                retryable: true
            });
        }

        const statusCode = Number(response?.statusCode || 0);
        const body = String(response?.body || "");
        if (statusCode < 200 || statusCode >= 300) {
            throw classifyStatus(statusCode, response?.headers || {}, body);
        }

        let parsed;
        try {
            parsed = JSON.parse(body);
        } catch (_) {
            throw new AiProviderError("DeepSeek trả về dữ liệu không đọc được", {
                kind: ERROR_KIND.BAD_RESPONSE,
                statusCode,
                retryable: false
            });
        }

        const choice = parsed?.choices?.[0];
        const text = choice?.message?.content;
        if (typeof text !== "string" || text.trim() === "") {
            throw new AiProviderError("DeepSeek không trả về nội dung", {
                kind: ERROR_KIND.BAD_RESPONSE,
                statusCode,
                retryable: false
            });
        }

        return {
            text,
            usage: normalizeUsage(parsed?.usage),
            model: parsed?.model || model,
            finishReason: choice?.finish_reason || null,
            requestId: parsed?.id || null
        };
    }

    async function complete(request = {}) {
        assertUsable();
        const payload = buildPayload(request);
        let lastError = null;

        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
            try {
                const result = await requestOnce(payload);
                return { ...result, attempts: attempt + 1 };
            } catch (error) {
                lastError = error;
                const retryable = error instanceof AiProviderError ? error.retryable : false;
                if (!retryable || attempt === maxRetries) break;
                const wait = error.retryAfterMs != null ? error.retryAfterMs : backoffMs * (attempt + 1);
                await sleep(wait);
            }
        }

        if (lastError instanceof AiProviderError) {
            lastError.attempts = Math.min(maxRetries + 1, (lastError.attempts || 1));
            throw lastError;
        }
        throw new AiProviderError("Không gọi được DeepSeek", { kind: ERROR_KIND.NETWORK });
    }

    return {
        complete,
        get model() { return model; },
        get baseUrl() { return baseUrl; }
    };
}

module.exports = {
    AiProviderError,
    ENDPOINT_PATH,
    ERROR_KIND,
    RETRYABLE_KINDS,
    classifyStatus,
    createDeepSeekProvider,
    httpsTransport,
    normalizeUsage
};
