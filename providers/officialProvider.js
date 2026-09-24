// ============================================================================
// Nhà cung cấp bot chính thức (Zalo Bot Platform).
//
// Lớp này bọc `node-zalo-bot` để nó khớp với cùng một giao diện nhà cung cấp mà
// ZCA dùng. Hành vi gửi/nhận KHÔNG đổi so với trước: mọi thứ vẫn do chính client
// node-zalo-bot thực hiện, chỉ được đặt sau một giao diện chung.
// ============================================================================
const ZaloBot = require("node-zalo-bot");
const { LEGACY_BOT_ID, PROVIDER_TYPES, formatBotLabel, normalizeBotId, tokenFingerprint } = require("../bots");

// Lỗi 410 nghĩa là chat_id không còn hợp lệ vĩnh viễn. Giữ nguyên cách nhận diện
// cũ để hành vi gửi lại dạng plain text không đổi.
function isPermanentChatError(error) {
    const status = Number(error?.response?.statusCode || error?.statusCode || 0);
    if (status === 410) return true;
    return /410\s+The chat_id is invalid/i.test(String(error?.message || ""));
}

function createOfficialProvider(config = {}) {
    const botId = normalizeBotId(config.botId) || LEGACY_BOT_ID;
    const client = config.client || new ZaloBot(config.token, { polling: false });

    const provider = {
        botId,
        providerType: PROVIDER_TYPES.OFFICIAL,
        client,
        token: config.token,
        tokenSource: config.source || null,
        fingerprint: config.fingerprint || tokenFingerprint(config.token),
        configuredName: config.configuredName || null,
        verifiedName: config.verifiedName || null,
        displayName: config.displayName || config.configuredName || botId,
        monthlyMessageWarning: config.monthlyMessageWarning,
        enabled: true,
        status: "starting",
        lastError: null,
        lastErrorAt: null,
        pollingStartedAt: null,

        // Tin nhắn của bot chính thức hiểu markdown của Zalo, nên giữ nguyên.
        supportsMarkdown: true,
        isPermanentChatError,

        // Gửi thô. Việc chia tin và chuyển sang plain text nằm ở tầng chung
        // (main.js) để mọi nhà cung cấp dùng chung một hành vi.
        //
        // Đọc client tại thời điểm gọi thay vì đóng kín biến `client`: giữ một
        // nguồn sự thật duy nhất và cho phép thay client (kiểm thử, khôi phục).
        async sendMessage(chatId, text, options = {}) {
            return provider.client.sendMessage(chatId, text, options);
        },

        async start() {
            await provider.client.startPolling();
            provider.pollingStartedAt = new Date().toISOString();
            provider.status = "running";
            return true;
        },

        async stop() {
            // node-zalo-bot không có stopPolling công khai; instance Polling nội
            // bộ có stop(). Chỉ gọi khi thư viện thực sự cung cấp.
            const client = provider.client;
            if (typeof client.stopPolling === "function") return client.stopPolling();
            const polling = client._polling;
            if (polling && typeof polling.stop === "function") {
                return polling.stop({ cancel: true, reason: "Bot is shutting down" });
            }
            return undefined;
        },

        // Tên thật lấy từ Zalo Bot Platform bằng chính token của bot.
        async fetchIdentityName() {
            if (typeof provider.client.getMe !== "function") return null;
            return provider.client.getMe();
        },

        getIdentity() {
            return {
                providerType: PROVIDER_TYPES.OFFICIAL,
                botId,
                displayName: provider.displayName,
                label: formatBotLabel(provider),
                tokenSource: provider.tokenSource,
                tokenFingerprint: provider.fingerprint
            };
        },

        getStatus() {
            return {
                botId,
                providerType: PROVIDER_TYPES.OFFICIAL,
                status: provider.status,
                enabled: provider.enabled !== false,
                authenticated: provider.status === "running",
                listenerConnected: provider.status === "running",
                lastError: provider.lastError,
                lastErrorAt: provider.lastErrorAt,
                pollingStartedAt: provider.pollingStartedAt,
                lastActivityAt: provider.lastActivityAt || null
            };
        },

        health() {
            return { status: provider.status, lastError: provider.lastError, lastErrorAt: provider.lastErrorAt };
        }
    };

    return provider;
}

module.exports = { createOfficialProvider, isPermanentChatError };
