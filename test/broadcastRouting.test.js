// ============================================================================
// Định tuyến đợt phát tin (/thongbao, /update) theo (botId, chatId).
//
// Lỗi đang sửa:
//   1. getBroadcastTargets() gộp đích theo chatId TRẦN. Zalo cấp Chat ID theo từng
//      tài khoản, nên cùng một Chat ID ở hai bot là HAI cuộc trò chuyện với hai
//      người khác nhau — gộp lại là mất một người nhận.
//   2. sendBotAnnouncement() gọi sendNotification() NGOÀI ngữ cảnh bot sở hữu, nên
//      tin của bot 2 đi ra bằng token bot 1: nhắn cho người khác bằng tài khoản khác.
//   3. Bản ghi không rõ botId bị ngầm gán cho bot 1. Không có căn cứ thì KHÔNG gửi.
//
// Bài kiểm tra dựng hai nhà cung cấp ghi lại mọi lần gửi và chứng minh từng đích
// chỉ được phục vụ bởi ĐÚNG tài khoản sở hữu nó.
// ============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.BOT_TOKEN = "broadcast-route-token-1";
process.env.BOT_2_TOKEN = "broadcast-route-token-2";

const { createOfficialProvider } = require("../providers/officialProvider");
const { createZcaProvider } = require("../providers/zca/zcaProvider");
const { registerBots, clearBots, rekeyBot, getBot } = require("../botContext");

const ROOT = path.join(__dirname, "..");
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

const main = require("../main");

const CHAT_DIR = fileKey(path.join(ROOT, "chatDirectory.json"));
const INTERACTIONS = fileKey(path.join(ROOT, "interactions.json"));
const SUBSCRIPTIONS = fileKey(path.join(ROOT, "subscriptions.json"));

// Tài khoản thứ hai trong fixture. Dùng hằng số này thay vì viết cứng "bot2" ở mọi
// chỗ: bộ dữ liệu phải khớp với tài khoản mà registerAll() thực sự đăng ký, nếu
// không thì đích của tài khoản thứ hai bị bỏ qua vì "bot sở hữu đang tắt" — mà đó
// lại chính là thứ bài kiểm tra đang muốn chứng minh.
//
// `scopedKeyFor()` bọc tiền tố khóa đúng như scopeKey() làm trong sản phẩm:
// bot1 giữ khóa trần (không gian khóa cũ), tài khoản khác có tiền tố riêng.
function scopedKeyFor(botId, chatId) {
    return botId === "bot1" ? chatId : `${botId}::${chatId}`;
}

// CHUNG_CHAT xuất hiện ở CẢ HAI tài khoản: đây là trường hợp dễ hỏng nhất và cũng
// là trường hợp mà việc gộp theo chatId trần sẽ nuốt mất một người nhận.
const SHARED_CHAT = "same-chat-id-both-accounts";
const BOT1_ONLY_CHAT = "bot1-only-chat";
const BOT2_ONLY_CHAT = "bot2-only-chat";
const UNVERIFIED_CHAT = "record-without-account";

function seedStores({ withUnverified = true, secondBotId = "bot2" } = {}) {
    memoryFiles.clear();

    // Sổ chat có phạm vi theo bot: bot1 giữ khóa trần, tài khoản khác có tiền tố.
    memoryFiles.set(CHAT_DIR, {
        schemaVersion: 3,
        chats: {
            [scopedKeyFor("bot1", SHARED_CHAT)]: { chatId: SHARED_CHAT, botId: "bot1", chatType: "private", displayName: "Chung (bot1)", status: "active" },
            [scopedKeyFor(secondBotId, SHARED_CHAT)]: { chatId: SHARED_CHAT, botId: secondBotId, chatType: "private", displayName: `Chung (${secondBotId})`, status: "active" },
            [scopedKeyFor("bot1", BOT1_ONLY_CHAT)]: { chatId: BOT1_ONLY_CHAT, botId: "bot1", chatType: "private", displayName: "Chỉ bot1", status: "active" },
            [scopedKeyFor(secondBotId, BOT2_ONLY_CHAT)]: { chatId: BOT2_ONLY_CHAT, botId: secondBotId, chatType: "private", displayName: `Chỉ ${secondBotId}`, status: "active" }
        },
        deletedChatIds: {}
    });

    // Sổ tương tác mang botId tường minh; khóa cũng có phạm vi.
    const interactions = {
        [scopedKeyFor("bot1", SHARED_CHAT)]: { chatId: SHARED_CHAT, botId: "bot1", chatType: "private", chatTitle: "Chung (bot1)", lastUserId: "user-shared" },
        [scopedKeyFor(secondBotId, SHARED_CHAT)]: { chatId: SHARED_CHAT, botId: secondBotId, chatType: "private", chatTitle: `Chung (${secondBotId})`, lastUserId: "user-shared" },
        [scopedKeyFor("bot1", BOT1_ONLY_CHAT)]: { chatId: BOT1_ONLY_CHAT, botId: "bot1", chatType: "private", chatTitle: "Chỉ bot1", lastUserId: "user-a" },
        [scopedKeyFor(secondBotId, BOT2_ONLY_CHAT)]: { chatId: BOT2_ONLY_CHAT, botId: secondBotId, chatType: "private", chatTitle: `Chỉ ${secondBotId}`, lastUserId: "user-b" }
    };
    if (withUnverified) {
        // Bản ghi lịch sử KHÔNG khai báo botId. Không được đoán bot 1, cũng không
        // được gửi — kể cả khi sổ chat không có bản ghi nào cho chat này.
        interactions[UNVERIFIED_CHAT] = {
            chatId: UNVERIFIED_CHAT, chatType: "private", chatTitle: "Không rõ tài khoản", lastUserId: "user-c"
        };
    }
    memoryFiles.set(INTERACTIONS, interactions);
    memoryFiles.set(SUBSCRIPTIONS, {});
}

function officialWithRecorder(botId, token) {
    const provider = createOfficialProvider({ botId, token });
    provider.sent = [];
    provider.client = {
        on() { return this; },
        startPolling: async () => true,
        stopPolling: async () => true,
        sendMessage: async (chatId, text) => {
            provider.sent.push({ chatId: String(chatId), text, botId });
            return { ok: true };
        },
        getMe: async () => ({ name: `Bot ${botId}` })
    };
    return provider;
}

const ZCA_UID = "700700700";

function zcaWithRecorder(t, uid = ZCA_UID) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "broadcast-route-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const provider = createZcaProvider({ enabled: true, sessionDir: dir, displayName: "Tài khoản ZCA" });
    provider.sent = [];
    for (const chatId of [SHARED_CHAT, BOT1_ONLY_CHAT, BOT2_ONLY_CHAT, UNVERIFIED_CHAT]) {
        provider.rememberThread(chatId, "private");
    }
    provider.ownUid = uid;
    provider.authenticated = true;
    provider.status = "connected";
    provider.api = {
        sendMessage: async (text, threadId, threadType) => {
            provider.sent.push({ chatId: String(threadId), text, threadType, botId: provider.botId });
            return { message: { msgId: 1 }, attachment: [] };
        },
        getOwnId: () => uid
    };
    return provider;
}

// Dựng đúng trạng thái production: bot1 đăng ký thẳng, ZCA phải ĐỔI KHÓA ĐĂNG KÝ
// từ danh tính tạm "zca:pending" sang "zca:<uid>" sau khi đăng nhập.
//
// Đây không phải chi tiết của bài kiểm tra mà là ràng buộc thật: ZCA chưa biết UID
// cho tới khi đăng nhập, nên registry giữ nó dưới khóa tạm. Nếu bỏ bước rekey, mọi
// đích của tài khoản đó sẽ bị coi là "bot sở hữu đang tắt" và bị bỏ qua âm thầm.
//
// `secondBotId` quyết định tài khoản thứ hai là ai: mặc định là ZCA (đăng ký qua
// đường rekey), truyền "bot2" khi bài kiểm tra cần hai bot chính thức. Dữ liệu
// fixture PHẢI được gieo bằng cùng giá trị đó (seedStores({ secondBotId })).
function registerAll(t, { second = "zca" } = {}) {
    clearBots();
    t.after(() => clearBots());

    const bot1 = officialWithRecorder("bot1", "broadcast-route-token-1");
    const providers = [bot1];
    let bot2 = null;
    let zca = null;

    if (second === "bot2") {
        bot2 = officialWithRecorder("bot2", "broadcast-route-token-2");
        providers.push(bot2);
    } else if (second === "zca") {
        zca = zcaWithRecorder(t);
        // Đăng ký dưới danh tính tạm trước, rồi mới đổi khóa — đúng thứ tự thật.
        zca.botId = "zca:pending";
        providers.push(zca);
    }

    registerBots(providers);

    if (zca) {
        const realId = `zca:${zca.ownUid}`;
        zca.botId = realId;
        rekeyBot("zca:pending", realId);
        assert.ok(getBot(realId), "ZCA phải đăng ký được dưới danh tính thật sau khi đăng nhập");
    }
    return { bot1, bot2, zca, secondBotId: bot2 ? "bot2" : (zca ? zca.botId : null) };
}

const sentOf = (list) => list.map((item) => item.chatId);
const zcaId = (uid = ZCA_UID) => `zca:${uid}`;

/* ========================================================================== */

test("cùng một chatId ở hai tài khoản là HAI đích, không bị gộp làm một", (t) => {
    const { zca } = registerAll(t);
    seedStores({ secondBotId: zca.botId });

    const targets = main.getBroadcastTargets();
    const shared = targets.filter((target) => target.chatId === SHARED_CHAT);

    assert.equal(shared.length, 2, "cùng Chat ID ở hai tài khoản phải sinh HAI đích");
    assert.deepEqual(
        shared.map((target) => target.botId).sort(),
        ["bot1", zca.botId].sort(),
        "mỗi đích phải giữ đúng tài khoản sở hữu"
    );
});

test("đích không rõ tài khoản KHÔNG được phát tin và không hưởng lợi từ bot 1", (t) => {
    const { zca } = registerAll(t);
    seedStores({ secondBotId: zca.botId });

    const targets = main.getBroadcastTargets();
    assert.equal(
        targets.some((target) => target.chatId === UNVERIFIED_CHAT),
        false,
        "bản ghi thiếu botId không được trở thành đích phát tin"
    );
    assert.equal(targets.skipped.unverifiedSource >= 1, true, "phải đếm số đích bị bỏ qua để chẩn đoán");
});

test("/thongbao chỉ gửi qua CHÍNH tài khoản sở hữu từng đích", async (t) => {
    const { bot1, zca } = registerAll(t);
    seedStores({ secondBotId: zca.botId });

    await main.sendBotAnnouncement("Thông báo kiểm tra định tuyến", { operation: "announcement", logLabel: "thông báo chung" });

    // bot1 phục vụ đúng các đích của bot1, không đụng tới đích của ZCA.
    assert.deepEqual(
        [...new Set(sentOf(bot1.sent))].sort(),
        [BOT1_ONLY_CHAT, SHARED_CHAT].sort(),
        "bot1 chỉ được gửi cho đích thuộc bot1"
    );
    // ZCA phục vụ đúng các đích của ZCA.
    assert.deepEqual(
        [...new Set(sentOf(zca.sent))].sort(),
        [BOT2_ONLY_CHAT, SHARED_CHAT].sort(),
        "ZCA chỉ được gửi cho đích thuộc ZCA"
    );

    // Cùng Chat ID nhưng phải xuất hiện ở CẢ HAI tài khoản — không bị nuốt mất.
    assert.equal(bot1.sent.filter((item) => item.chatId === SHARED_CHAT).length, 1, "bot1 gửi một tin cho chat chung");
    assert.equal(zca.sent.filter((item) => item.chatId === SHARED_CHAT).length, 1, "ZCA gửi một tin cho chat chung");

    // Và không tài khoản nào gửi cho đích của tài khoản kia.
    assert.equal(zca.sent.some((item) => item.chatId === BOT1_ONLY_CHAT), false, "ZCA không được gửi cho đích của bot1");
    assert.equal(bot1.sent.some((item) => item.chatId === BOT2_ONLY_CHAT), false, "bot1 không được gửi cho đích của ZCA");
});

test("bản ghi chưa rõ tài khoản không nhận được thông báo nào", async (t) => {
    const { zca } = registerAll(t);
    seedStores({ secondBotId: zca.botId });

    await main.sendBotAnnouncement("Không được tới đích chưa xác minh", { operation: "announcement" });

    assert.equal(zca.sent.some((item) => item.chatId === UNVERIFIED_CHAT), false, "ZCA không được nhận đích chưa rõ tài khoản");
});

test("bot sở hữu đang tắt thì đích bị bỏ qua, KHÔNG gửi bằng bot khác", async (t) => {
    clearBots();
    t.after(() => clearBots());

    // Chỉ đăng ký bot1. Đích của tài khoản thứ hai phải bị bỏ qua, tuyệt đối không
    // rơi về bot1.
    const bot1 = officialWithRecorder("bot1", "broadcast-route-token-1");
    registerBots([bot1]);
    seedStores({ secondBotId: "bot2" });

    const targets = main.getBroadcastTargets();
    assert.equal(targets.some((target) => target.botId === "bot2"), false, "bot2 tắt thì không có đích bot2");
    assert.equal(targets.skipped.ownerBotOffline >= 1, true, "phải đếm đích bị bỏ qua vì bot sở hữu tắt");

    await main.sendBotAnnouncement("Không được rơi về bot1", { operation: "announcement" });
    assert.equal(bot1.sent.some((item) => item.chatId === BOT2_ONLY_CHAT), false, "bot1 không được gửi thay bot2 đang tắt");
    assert.equal(bot1.sent.some((item) => item.chatId === SHARED_CHAT), true, "đích của bot1 vẫn phải được gửi bình thường");
});

test("gửi lỗi ở một tài khoản không thử lại bằng tài khoản khác", async (t) => {
    const { bot1, zca } = registerAll(t);
    seedStores({ secondBotId: zca.botId });
    // ZCA hỏng hoàn toàn. Không được lấy bot1 gửi bù cho đích của ZCA.
    zca.api.sendMessage = async () => { throw new Error("ZCA tạm hỏng"); };

    await main.sendBotAnnouncement("Kiểm tra lỗi cục bộ", { operation: "announcement" });

    assert.equal(bot1.sent.some((item) => item.chatId === BOT2_ONLY_CHAT), false, "bot1 không được gửi bù cho đích của ZCA");
    assert.equal(bot1.sent.some((item) => item.chatId === BOT1_ONLY_CHAT), true, "đích của bot1 vẫn gửi được");
});

test("kiểm tra quyền chat chạy theo bot sở hữu: tắt ở ZCA không ảnh hưởng bot1", (t) => {
    const { zca } = registerAll(t);
    seedStores({ secondBotId: zca.botId });
    // Chat chung bị TẮT tính năng broadcast CHỈ ở phạm vi ZCA.
    const directory = memoryFiles.get(CHAT_DIR);
    directory.chats[`${zca.botId}::${SHARED_CHAT}`] = {
        ...directory.chats[`${zca.botId}::${SHARED_CHAT}`],
        notificationOverrides: { broadcast: false }
    };
    memoryFiles.set(CHAT_DIR, directory);

    const targets = main.getBroadcastTargets();
    const shared = targets.filter((target) => target.chatId === SHARED_CHAT);

    assert.equal(shared.length, 1, "chỉ đích chưa bị tắt còn lại");
    assert.equal(shared[0].botId, "bot1", "đích còn lại phải là của bot1");
    assert.equal(zcaId() && shared[0].botId !== zca.botId, true, "ZCA đã tắt thì không còn đích của ZCA");
});
