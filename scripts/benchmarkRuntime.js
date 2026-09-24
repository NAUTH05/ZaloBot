// ============================================================================
// Đo hiệu năng cục bộ — KHÔNG cần Zalo thật, KHÔNG cần Firestore thật.
//
// Dùng để đo trước/sau khi tối ưu:
//   - thời gian hydrate (đọc store)
//   - thời gian đối chiếu sổ chat + SỐ LẦN GHI
//   - thời gian khởi động nhà cung cấp (tuần tự vs song song)
//   - số bản sao snapshot bị giữ trong hàng đợi ghi
//   - RSS đỉnh khi bắn một đợt broadcast
//
// Chạy: node scripts/benchmarkRuntime.js
// ============================================================================
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// Độ trễ giả lập cho mỗi lần đọc/ghi Firestore. Mạng thật tới Firestore ở VN
// thường 100–1000ms; dùng 250ms để thấy rõ ảnh hưởng của việc đọc tuần tự.
const READ_LATENCY_MS = Number(process.env.BENCH_READ_LATENCY_MS || 250);
const WRITE_LATENCY_MS = Number(process.env.BENCH_WRITE_LATENCY_MS || 120);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */
/* Firestore giả: đếm số lần đọc/ghi và mô phỏng độ trễ mạng                  */
/* -------------------------------------------------------------------------- */
const stats = { reads: 0, writes: 0, writesByStore: {}, maxConcurrentWrites: 0, activeWrites: 0, persistenceWrites: 0 };
const documents = new Map();

function resetStats() {
    stats.reads = 0;
    stats.writes = 0;
    stats.writesByStore = {};
    stats.maxConcurrentWrites = 0;
    stats.activeWrites = 0;
    stats.persistenceWrites = 0;
}

async function fakeRead(storeId) {
    stats.reads += 1;
    await sleep(READ_LATENCY_MS);
    return documents.has(storeId) ? JSON.parse(JSON.stringify(documents.get(storeId))) : null;
}

async function fakeWrite(storeId, value) {
    stats.writes += 1;
    stats.writesByStore[storeId] = (stats.writesByStore[storeId] || 0) + 1;
    stats.activeWrites += 1;
    stats.maxConcurrentWrites = Math.max(stats.maxConcurrentWrites, stats.activeWrites);
    try {
        await sleep(WRITE_LATENCY_MS);
        documents.set(storeId, JSON.parse(JSON.stringify(value)));
    } finally {
        stats.activeWrites -= 1;
    }
}

/* -------------------------------------------------------------------------- */
/* Dữ liệu giả: 100 người dùng, 500 chat, đăng ký tương ứng                    */
/* -------------------------------------------------------------------------- */
const USER_COUNT = Number(process.env.BENCH_USERS || 100);
const CHAT_COUNT = Number(process.env.BENCH_CHATS || 500);

function seedData() {
    const chats = {};
    const interactions = {};
    const subscriptions = {};

    for (let index = 0; index < CHAT_COUNT; index += 1) {
        const chatId = `chat-${index}`;
        const userId = `user-${index % USER_COUNT}`;
        const botId = index % 3 === 0 ? "bot2" : index % 5 === 0 ? "bot3" : "bot1";
        const prefix = botId === "bot1" ? "" : `${botId}::`;

        chats[`${prefix}${chatId}`] = {
            chatId, botId, chatType: index % 7 === 0 ? "group" : "private",
            displayName: `Chat ${index}`, userId, status: "active",
            notificationOverrides: { feature: index % 11 === 0 },
            createdAt: "2026-01-01T00:00:00.000Z"
        };
        interactions[`${prefix}${chatId}`] = {
            chatId, botId, chatType: "private",
            members: { [userId]: { userId, displayName: `User ${userId}`, status: "active" } },
            lastUserId: userId,
            firstInteractionAt: "2026-01-01T00:00:00.000Z",
            lastInteractionAt: "2026-09-01T00:00:00.000Z"
        };
        subscriptions[`${prefix}${chatId}::${userId}`] = {
            contextVersion: 2, botId, chatId, userId,
            userDisplayName: `User ${userId}`, studentId: `123000${index}`,
            notificationTimes: [{ id: 1, time: "06:30", targetDayOffset: 0 }],
            notificationsEnabled: true, updatedAt: "2026-09-01T00:00:00.000Z"
        };
    }

    return {
        chatDirectory: { schemaVersion: 3, chats: {}, deletedChatIds: {} },
        interactions,
        subscriptions,
        adminSettings: {},
        accessControl: {},
        classStartNotifications: {},
        scheduleSnapshots: {},
        adminAudit: {},
        adminLogs: {}
    };
}

/* -------------------------------------------------------------------------- */
/* Cài persistence giả vào require cache                                      */
/* -------------------------------------------------------------------------- */
function installFakePersistence() {
    const persistencePath = require.resolve(path.join(ROOT, "firestorePersistence"));
    const real = require(persistencePath);
    const memoryFiles = new Map();
    const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
    const fileKey = (filePath, defaultPath) => path.resolve(filePath || defaultPath);

    require.cache[persistencePath] = {
        id: persistencePath, filename: persistencePath, loaded: true,
        exports: {
            ...real,
            readJsonStore: (filePath, defaultPath, fallback) => {
                const key = fileKey(filePath, defaultPath);
                if (!memoryFiles.has(key)) memoryFiles.set(key, clone(fallback) ?? null);
                return clone(memoryFiles.get(key));
            },
            writeJsonStore: (filePath, defaultPath, value) => {
                // Đếm ở ĐÚNG tầng persistence: mỗi lần gọi là một lần ghi Firestore
                // đầy đủ cho cả store, không phải một lần ghi file.
                stats.persistenceWrites += 1;
                memoryFiles.set(fileKey(filePath, defaultPath), clone(value));
            },
            flushPersistenceWrites: async () => undefined,
            getPersistenceStatus: () => ({ backend: "benchmark" })
        }
    };
    // Đặt lại một store trong persistence giả. Phải đi qua đây vì readDirectory()
    // đọc từ readJsonStore, không đọc từ đĩa.
    const resetStore = (fullPath, value) => {
        memoryFiles.set(fileKey(fullPath, fullPath), value === null ? null : JSON.parse(JSON.stringify(value)));
    };
    return { memoryFiles, fileKey, resetStore };
}

/* -------------------------------------------------------------------------- */
/* Các phép đo                                                                */
/* -------------------------------------------------------------------------- */

// Đo việc đọc store: tuần tự (hiện tại) so với song song (đề xuất).
async function measureHydrate(storeIds) {
    const sequentialStart = Date.now();
    for (const storeId of storeIds) await fakeRead(storeId);
    const sequentialMs = Date.now() - sequentialStart;
    const sequentialReads = stats.reads;

    resetStats();
    const parallelStart = Date.now();
    await Promise.all(storeIds.map((storeId) => fakeRead(storeId)));
    const parallelMs = Date.now() - parallelStart;

    resetStats();
    return { sequentialMs, parallelMs, storeCount: storeIds.length, sequentialReads };
}

// Đo số lần ghi khi cập nhật liên tục một store (kiểm tra coalescing).
async function measureBurstWrites(mutate) {
    resetStats();
    const start = Date.now();
    await mutate();
    const elapsed = Date.now() - start;
    const result = { writes: stats.writes, elapsedMs: elapsed };
    resetStats();
    return result;
}

function formatMb(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function snapshotMemory(label) {
    const usage = process.memoryUsage();
    return {
        label,
        rss: usage.rss,
        heapUsed: usage.heapUsed,
        heapTotal: usage.heapTotal,
        external: usage.external,
        arrayBuffers: usage.arrayBuffers || 0
    };
}

function printMemory(snapshot) {
    console.log(
        `  ${snapshot.label.padEnd(26)} rss=${formatMb(snapshot.rss).padStart(9)} ` +
        `heapUsed=${formatMb(snapshot.heapUsed).padStart(9)} heapTotal=${formatMb(snapshot.heapTotal).padStart(9)} ` +
        `external=${formatMb(snapshot.external).padStart(9)} arrayBuffers=${formatMb(snapshot.arrayBuffers).padStart(9)}`
    );
}

/* -------------------------------------------------------------------------- */

async function main() {
    console.log("=== ZaloBot benchmark ===");
    console.log(`Firestore giả: đọc ${READ_LATENCY_MS}ms, ghi ${WRITE_LATENCY_MS}ms mỗi thao tác`);
    console.log(`Dữ liệu: ${USER_COUNT} người dùng, ${CHAT_COUNT} chat`);
    console.log("");

    const memory = [];
    memory.push(snapshotMemory("trước khi nạp dữ liệu"));

    const seed = seedData();
    const storeIds = Object.keys(seed);
    memory.push(snapshotMemory("sau khi tạo dữ liệu giả"));
    printMemory(memory[memory.length - 1]);

    console.log("");
    console.log("--- Phase 19: đọc store khi hydrate ---");
    const hydrate = await measureHydrate(storeIds);
    console.log(`  tuần tự : ${String(hydrate.sequentialMs).padStart(6)}ms  (${hydrate.storeCount} store × ${READ_LATENCY_MS}ms)`);
    console.log(`  song song: ${String(hydrate.parallelMs).padStart(6)}ms`);
    console.log(`  cải thiện: ${(hydrate.sequentialMs / Math.max(hydrate.parallelMs, 1)).toFixed(1)}×`);

    const fake = installFakePersistence();
    process.env.BOT_TOKEN = process.env.BOT_TOKEN || "bench-token-1";
    process.env.BOT_2_TOKEN = process.env.BOT_2_TOKEN || "bench-token-2";
    process.env.BOT_3_TOKEN = process.env.BOT_3_TOKEN || "bench-token-3";

    const chatDirectory = require(path.join(ROOT, "chatDirectory"));
    const { upsertChat } = chatDirectory;

    const dirFile = path.join(ROOT, "chatDirectory.json");
    const interactionFile = path.join(ROOT, "interactions.json");
    const subscriptionFile = path.join(ROOT, "subscriptions.json");

    // Ghi dữ liệu giả vào store trong bộ nhớ để hàm đối chiếu đọc được.
    const fsModule = require("node:fs");
    const tmp = fsModule.mkdtempSync(path.join(os.tmpdir(), "zalobot-bench-"));
    fsModule.writeFileSync(path.join(tmp, "chatDirectory.json"), JSON.stringify(seed.chatDirectory), "utf8");
    fsModule.writeFileSync(path.join(tmp, "interactions.json"), JSON.stringify(seed.interactions), "utf8");
    fsModule.writeFileSync(path.join(tmp, "subscriptions.json"), JSON.stringify(seed.subscriptions), "utf8");

    console.log("");
    console.log("--- Phase 3: đối chiếu sổ chat khi khởi động ---");
    // Đo cách HIỆN TẠI: gọi upsertChat cho từng bản ghi (đọc + ghi cả sổ mỗi lần).
    const perCallWrites = { count: 0 };
    const originalWriteLocal = fsModule.writeFileSync;
    let directoryWrites = 0;
    fsModule.writeFileSync = function patched(target, ...rest) {
        if (String(target).includes("chatDirectory")) directoryWrites += 1;
        return originalWriteLocal.call(this, target, ...rest);
    };

    stats.persistenceWrites = 0;
    const reconStart = Date.now();
    const targets = Object.values(seed.interactions);
    for (const target of targets) {
        upsertChat({
            chatId: target.chatId, chatType: target.chatType,
            displayName: target.lastUserDisplayName, userId: target.lastUserId
        }, path.join(tmp, "chatDirectory.json"));
    }
    fsModule.writeFileSync = originalWriteLocal;
    const reconMs = Date.now() - reconStart;

    const oldWrites = stats.persistenceWrites;
    console.log(`  CŨ  (upsertChat từng bản ghi): ${reconMs}ms, ${oldWrites} lần ghi`);
    perCallWrites.count = oldWrites;

    // Cách MỚI, trường hợp NGUỘI: sổ chat rỗng, phải thêm 500 bản ghi.
    fake.resetStore(path.join(tmp, "chatDirectory.json"), { schemaVersion: 3, chats: {}, deletedChatIds: {} });
    const { reconcileChatDirectory } = chatDirectory;
    stats.persistenceWrites = 0;
    const newStart = Date.now();
    const changed = reconcileChatDirectory(targets.map((target) => ({
        chatId: target.chatId, chatType: target.chatType,
        displayName: target.lastUserDisplayName, userId: target.lastUserId
    })), path.join(tmp, "chatDirectory.json"));
    const newMs = Date.now() - newStart;
    console.log(`  MỚI (reconcileChatDirectory): ${newMs}ms, ${stats.persistenceWrites} lần ghi (${changed} bản ghi đổi)`);

    // Chạy lại khi KHÔNG có gì đổi: phải là 0 lần ghi.
    stats.persistenceWrites = 0;
    const noopStart = Date.now();
    reconcileChatDirectory(targets.map((target) => ({
        chatId: target.chatId, chatType: target.chatType,
        displayName: target.lastUserDisplayName, userId: target.lastUserId
    })), path.join(tmp, "chatDirectory.json"));
    console.log(`  MỚI lần hai (không đổi gì): ${Date.now() - noopStart}ms, ${stats.persistenceWrites} lần ghi`);
    console.log(`  ⇒ giảm ${(oldWrites / Math.max(stats.persistenceWrites, 1)).toFixed(0)}× số lần ghi`);

    console.log("");
    console.log("--- Phase 5: khởi động nhà cung cấp ---");
    const providerDelayMs = Number(process.env.BENCH_PROVIDER_DELAY_MS || 10000);
    const fakeProvider = (name) => ({
        name,
        start: async () => { await sleep(providerDelayMs); return name; }
    });
    const providers = ["bot1", "bot2", "bot3", "zca"].map(fakeProvider);

    // Tuần tự (hiện tại)
    let sequentialStart = Date.now();
    for (const provider of providers) await provider.start();
    const sequentialProviderMs = Date.now() - sequentialStart;

    // Song song (đề xuất)
    const concurrentStart = Date.now();
    await Promise.allSettled(providers.map((provider) => provider.start()));
    const concurrentProviderMs = Date.now() - concurrentStart;

    console.log(`  tuần tự  (${providers.length} nhà cung cấp × ${providerDelayMs}ms): ${sequentialProviderMs}ms`);
    console.log(`  song song: ${concurrentProviderMs}ms`);

    console.log("");
    console.log("--- Phase 2: hàng đợi ghi khi cập nhật dồn dập ---");
    // Phần này MÔ PHỎNG cách cũ (nối một Promise cho mỗi thay đổi) để làm mốc so
    // sánh. Hành vi mới — mỗi store chỉ một writer, không giữ N bản sao — được
    // kiểm chứng trong test/performanceOptimizations.test.js qua hàng đợi thật.
    // Mô phỏng 100 thay đổi liên tiếp: đo số bản sao bị giữ.
    const burst = await measureBurstWrites(async () => {
        let chain = Promise.resolve();
        const bigState = seed.subscriptions;
        for (let index = 0; index < 100; index += 1) {
            const snapshot = JSON.parse(JSON.stringify(bigState));
            chain = chain.then(() => fakeWrite("subscriptions", snapshot));
        }
        await chain;
    });
    console.log(`  CŨ (mô phỏng): ${burst.writes} lần ghi cho 100 thay đổi (${burst.elapsedMs}ms)`);
    console.log(`  ⇒ cách cũ giữ ${burst.writes} bản sao đầy đủ trong hàng đợi; cách mới tối đa 1`);

    memory.push(snapshotMemory("sau các phép đo"));
    console.log("");
    console.log("--- Bộ nhớ ---");
    for (const item of memory) printMemory(item);

    fsModule.rmSync(tmp, { recursive: true, force: true });
    console.log("");
    console.log("=== hết benchmark ===");
}

main().catch((error) => { console.error("benchmark lỗi:", error); process.exitCode = 1; });
