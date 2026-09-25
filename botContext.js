// ============================================================================
// Ngữ cảnh bot đang xử lý.
//
// Codebase này gọi `sendMessage()` và các hàm lưu trữ từ hơn một trăm chỗ. Thay
// vì luồn thêm tham số botId qua tất cả các chỗ đó, ta dùng AsyncLocalStorage —
// đúng cách mà `dashboardCommandContext` trong main.js đã làm.
//
// Quy tắc:
//   - Mỗi handler tin nhắn chạy trong ngữ cảnh của bot nhận được tin đó, nên
//     trả lời luôn đi ra bằng đúng bot ấy.
//   - Mỗi lần gửi theo lịch chạy trong ngữ cảnh của bot SỞ HỮU đăng ký đó.
//   - Không có ngữ cảnh ⇒ mặc định là bot 1. Đây là đường tương thích cho mọi
//     lối gọi cũ và cho bản triển khai một token.
// ============================================================================
const { AsyncLocalStorage } = require("async_hooks");
const { LEGACY_BOT_ID, describeBot, normalizeBotId, providerTypeOf } = require("./bots");

const storage = new AsyncLocalStorage();
const registry = new Map();

function registerBot(runtime) {
    if (!runtime || !runtime.botId) throw new Error("registerBot cần một runtime có botId");
    registry.set(runtime.botId, runtime);
    return runtime;
}

function registerBots(runtimes = []) {
    for (const runtime of runtimes) registerBot(runtime);
    return [...registry.values()];
}

// Đổi danh tính của một nhà cung cấp đã đăng ký.
//
// Cần cho ZCA: UID của tài khoản cá nhân chỉ biết được SAU khi đăng nhập, mà khóa
// lưu trữ lại phụ thuộc vào danh tính. Trước khi biết UID, nhà cung cấp nằm dưới
// một khóa tạm; sau khi đăng nhập thì chuyển sang "zca:<uid>" thật.
function rekeyBot(oldBotId, newBotId) {
    const from = normalizeBotId(oldBotId);
    const to = normalizeBotId(newBotId);
    if (!from || !to || from === to) return null;

    const runtime = registry.get(from);
    if (!runtime) return null;
    // Không cho phép ghi đè một nhà cung cấp khác đang tồn tại.
    if (registry.has(to)) return null;

    registry.delete(from);
    runtime.botId = to;
    registry.set(to, runtime);
    return runtime;
}

function clearBots() {
    registry.clear();
}

function listBots() {
    return [...registry.values()];
}

function listEnabledBots() {
    return [...registry.values()].filter((runtime) => runtime.enabled !== false);
}

function getBot(botId) {
    const normalized = normalizeBotId(botId);
    if (!normalized) return null;
    return registry.get(normalized) || null;
}

// Bot 1 là mặc định lịch sử: mọi lối gọi chưa biết bot nào đều thuộc về nó.
function getLegacyBot() {
    return registry.get(LEGACY_BOT_ID) || null;
}

// Bot đang xử lý. Không có ngữ cảnh ⇒ bot 1. Nếu bot 1 chưa được đăng ký (ví
// dụ trong bài kiểm tra chỉ dựng bot 2) thì trả về bot bật đầu tiên, để lỗi
// hiện ra ở nơi dùng chứ không âm thầm gửi sai danh tính.
function getCurrentBot() {
    const ambient = storage.getStore();
    if (ambient) return ambient;
    const legacy = getLegacyBot();
    if (legacy) return legacy;
    const [first] = listEnabledBots();
    return first || null;
}

function getCurrentBotId() {
    return getCurrentBot()?.botId || LEGACY_BOT_ID;
}

// Chạy `fn` trong ngữ cảnh của một bot. Nhận botId hoặc chính runtime.
function runWithBot(botOrId, fn) {
    const runtime = typeof botOrId === "string" ? getBot(botOrId) : botOrId;
    if (!runtime) {
        throw new Error(`Không tìm thấy bot để chạy ngữ cảnh: ${String(botOrId)}`);
    }
    return storage.run(runtime, fn);
}

// Bọc một hàm async để nó luôn chạy trong ngữ cảnh của một bot cố định. Dùng cho
// callback của scheduler và các handler theo từng bot.
function bindBot(botOrId, fn) {
    const runtime = typeof botOrId === "string" ? getBot(botOrId) : botOrId;
    if (!runtime) {
        throw new Error(`Không tìm thấy bot để gắn ngữ cảnh: ${String(botOrId)}`);
    }
    return (...args) => storage.run(runtime, () => fn(...args));
}

// Mô tả an toàn cho dashboard/API: không bao giờ chứa token.
// Mô tả an toàn cho dashboard/API.
//
// Mỗi nhà cung cấp tự cung cấp getIdentity()/getStatus() nên phần thân nhà cung
// cấp riêng (token của bot chính thức, phiên của tài khoản cá nhân) không bao giờ
// đi ra ngoài qua đường này.
function describeRegisteredBots() {
    return listBots().map((runtime) => {
        const identity = typeof runtime.getIdentity === "function" ? runtime.getIdentity() : {};
        const status = typeof runtime.getStatus === "function" ? runtime.getStatus() : {};
        return {
            ...describeBot(runtime),
            providerType: providerTypeOf(runtime.botId),
            isPersonalAccount: runtime.isPersonalAccount === true,
            ...identity,
            status: status.status || runtime.status || (runtime.enabled === false ? "disabled" : "enabled"),
            health: typeof runtime.health === "function" ? runtime.health() : null
        };
    });
}

module.exports = {
    bindBot,
    clearBots,
    describeRegisteredBots,
    getBot,
    getCurrentBot,
    getCurrentBotId,
    getLegacyBot,
    listBots,
    listEnabledBots,
    registerBot,
    registerBots,
    rekeyBot,
    runWithBot
};
