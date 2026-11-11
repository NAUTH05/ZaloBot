// ============================================================================
// Nhóm HỖ TRỢ: nhận tin bình thường nhưng KHÔNG chào tự động.
//
// Hai yêu cầu đi kèm nhau, nên phải canh cùng lúc:
//   1. Bật "nhận mọi tin" cho MỘT nhóm ⇒ tin thường của thành viên được ghi vào
//      Chat Center để quản trị viên đọc và trả lời tay.
//   2. Bot KHÔNG được gửi lời chào tự động vào nhóm — kể cả khi có người tag.
//      Lời chào trong nhóm là phát cho toàn bộ thành viên, và vì cổng tiếp nhận
//      chỉ nằm trong bộ nhớ nên nó sẽ lặp lại sau mỗi lần khởi động.
//
// Bài dưới đây chạy qua handleIncomingMessage thật với nhà cung cấp giả.
// ============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

/* -------------------------------------------------------------------------- */
/* Cài đặt giả lập TRƯỚC khi nạp main.js                                      */
/* -------------------------------------------------------------------------- */

// 1. Firestore trong bộ nhớ: groupPolicy ghi/đọc qua đây.
const persistencePath = require.resolve(path.join(ROOT, "firestorePersistence"));
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
        },
        flushPersistenceWrites: async () => undefined,
        getPersistenceStatus: () => ({ backend: "test" })
    }
};

// 2. Ghi lại lịch sử tin nhắn thay vì gọi Firestore thật.
const recorderPath = require.resolve(path.join(ROOT, "messageRecorder"));
const realRecorder = require(recorderPath);
const recorded = [];

require.cache[recorderPath] = {
    id: recorderPath,
    filename: recorderPath,
    loaded: true,
    exports: {
        ...realRecorder,
        recordMessage: async (input) => {
            recorded.push(input);
            return { recorded: true, messageId: `msg-${recorded.length}` };
        }
    }
};

const { registerBots, clearBots, runWithBot } = require("../botContext");
const { createOfficialProvider } = require("../providers/officialProvider");
const groupPolicy = require("../groupPolicy");
const main = require("../main");

function officialWithRecorder(botId, displayName) {
    const provider = createOfficialProvider({ botId, token: `token-${botId}`, displayName });
    provider.sent = [];
    provider.client = {
        on() { return this; },
        startPolling: async () => true,
        stopPolling: async () => true,
        getMe: async () => ({ name: displayName }),
        sendMessage: async (chatId, text) => {
            provider.sent.push({ chatId: String(chatId), text: String(text) });
            return { ok: true };
        }
    };
    return provider;
}

function groupMessage(text, extra = {}) {
    return {
        text,
        chat: { id: "group-1", type: "group", title: "Nhóm hỗ trợ" },
        from: { id: "user-1", display_name: "Sinh viên" },
        ...extra
    };
}

function privateMessage(text) {
    return {
        text,
        chat: { id: "private-1", type: "private" },
        from: { id: "user-1", display_name: "Sinh viên" }
    };
}

function resetRecorded() {
    recorded.length = 0;
}

// Chính sách được lưu trong "tệp" dùng chung của cả tệp test, nên phải xoá giữa
// các bài — nếu không, bài sau thừa hưởng chế độ của bài trước.
function resetPolicy() {
    groupPolicy.setChatMode({ botId: "bot1", chatId: "group-1", mode: null });
    groupPolicy.setChatMode({ botId: "bot2", chatId: "group-1", mode: null });
}

function setIngest(botId, chatId) {
    groupPolicy.setChatMode({ botId, chatId, mode: "ingest" });
}

/* -------------------------------------------------------------------------- */
/* 1. Nhận tin để hỗ trợ                                                      */
/* -------------------------------------------------------------------------- */

test("NHÓM bật 'nhận mọi tin': tin thường được GHI NHẬN, bot không gửi gì", async (t) => {
    clearBots();
    resetRecorded();
    resetPolicy();
    t.after(() => clearBots());
    const bot = officialWithRecorder("bot1", "Alessandra");
    registerBots([bot]);
    setIngest("bot1", "group-1");

    await runWithBot(bot, () => main.handleIncomingMessage(bot, groupMessage("cho em hỏi lịch thi với ạ")));

    assert.equal(recorded.length, 1, "tin phải được ghi vào Chat Center để quản trị viên đọc");
    assert.equal(recorded[0].text, "cho em hỏi lịch thi với ạ");
    assert.equal(recorded[0].chatType, "group");
    assert.equal(recorded[0].source, "inbound_group", "Chat Center phải biết đây là tin nhóm");
    assert.equal(recorded[0].chatId, "group-1");
    assert.equal(bot.sent.length, 0, "bot KHÔNG được tự trả lời tin thường trong nhóm");
});

test("NHÓM chưa bật: tin thường không được ghi nhận (giữ hành vi cũ)", async (t) => {
    clearBots();
    resetRecorded();
    resetPolicy();
    t.after(() => clearBots());
    const bot = officialWithRecorder("bot1", "Alessandra");
    registerBots([bot]);

    await runWithBot(bot, () => main.handleIncomingMessage(bot, groupMessage("mai học môn gì vậy cả nhà")));

    assert.equal(recorded.length, 0, "nhóm lớp không được ghi mọi tin");
    assert.equal(bot.sent.length, 0);
});

test("bật cho bot1 KHÔNG ảnh hưởng cùng chatId ở bot2", async (t) => {
    clearBots();
    resetRecorded();
    resetPolicy();
    t.after(() => clearBots());
    const bot1 = officialWithRecorder("bot1", "Alessandra");
    const bot2 = officialWithRecorder("bot2", "MrYukitoBoBo");
    registerBots([bot1, bot2]);
    setIngest("bot1", "group-1");

    await runWithBot(bot2, () => main.handleIncomingMessage(bot2, groupMessage("tin thường")));

    assert.equal(recorded.length, 0, "chính sách phải theo (bot, chat), không theo chatId trần");
});

/* -------------------------------------------------------------------------- */
/* 2. Không chào tự động trong nhóm                                           */
/* -------------------------------------------------------------------------- */

test("NHÓM được tag: KHÔNG gửi lời chào tự động", async (t) => {
    clearBots();
    resetRecorded();
    resetPolicy();
    t.after(() => clearBots());
    const bot = officialWithRecorder("bot1", "Alessandra");
    registerBots([bot]);

    // Tin không phải lệnh, chat chưa được tiếp nhận — đúng điều kiện cũ của nhánh
    // chào mừng. Trước đây nhánh đó phát lời chào cho cả nhóm.
    await runWithBot(bot, () => main.handleIncomingMessage(bot, groupMessage("@Alessandra chào bạn")));

    assert.equal(bot.sent.length, 0, "lời chào trong nhóm là phát cho toàn bộ thành viên");
});

test("NHÓM bật 'nhận mọi tin' + tag: vẫn không chào", async (t) => {
    clearBots();
    resetRecorded();
    resetPolicy();
    t.after(() => clearBots());
    const bot = officialWithRecorder("bot1", "Alessandra");
    registerBots([bot]);
    setIngest("bot1", "group-1");

    await runWithBot(bot, () => main.handleIncomingMessage(bot, groupMessage("@Alessandra chào bạn")));

    assert.equal(bot.sent.length, 0);
});

test("NHÓM + lệnh: vẫn trả lời bình thường", async (t) => {
    clearBots();
    resetRecorded();
    resetPolicy();
    t.after(() => clearBots());
    const bot = officialWithRecorder("bot1", "Alessandra");
    registerBots([bot]);

    await runWithBot(bot, () => main.handleIncomingMessage(bot, groupMessage("@Alessandra /help")));

    // /help gửi phần chữ và cả ảnh minh hoạ, nên số tin không cố định — chỉ cần
    // có đáp và đáp đúng trong NHÓM.
    assert.ok(bot.sent.length >= 1, "lệnh phải được đáp");
    assert.ok(bot.sent.every((item) => item.chatId === "group-1"), "phải trả lời trong nhóm, không phải người gửi");
});

test("CHAT RIÊNG: lời chào vẫn hoạt động như cũ", async (t) => {
    clearBots();
    resetRecorded();
    resetPolicy();
    t.after(() => clearBots());
    const bot = officialWithRecorder("bot1", "Alessandra");
    registerBots([bot]);

    await runWithBot(bot, () => main.handleIncomingMessage(bot, privateMessage("chào bot")));

    assert.equal(bot.sent.length, 1, "chat riêng là nơi lời chào có nghĩa");
    assert.equal(bot.sent[0].chatId, "private-1");
});

/* -------------------------------------------------------------------------- */
/* 3. Không rò rỉ câu trả lời tự động cho cả nhóm                              */
/* -------------------------------------------------------------------------- */

test("NHÓM bật 'nhận mọi tin' nhưng bị chặn quyền: KHÔNG phát 'không có quyền' cho cả nhóm", async (t) => {
    clearBots();
    resetRecorded();
    resetPolicy();
    t.after(() => clearBots());
    const bot = officialWithRecorder("bot1", "Alessandra");
    registerBots([bot]);
    setIngest("bot1", "group-1");

    const accessControl = require("../accessControl");
    const previousMode = accessControl.getAccessSummary().botMode;
    accessControl.setAccessMode("bot", "blocklist");
    accessControl.blockTarget({ targetId: "group-1", targetName: "Nhóm hỗ trợ" });
    t.after(() => {
        accessControl.unblockTarget({ targetId: "group-1" });
        accessControl.setAccessMode("bot", previousMode);
    });

    await runWithBot(bot, () => main.handleIncomingMessage(bot, groupMessage("tin thường")));

    assert.equal(bot.sent.length, 0, "từ chối quyền cho từng tin thường sẽ spam cả nhóm");
    assert.equal(recorded.length, 1, "nhưng tin vẫn được ghi để quản trị viên thấy");
});
