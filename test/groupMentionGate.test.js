// ============================================================================
// Cổng phản hồi trong nhóm.
//
// Lỗi gốc: bot nhận được mọi tin nhắn của nhóm, và mỗi tin không phải lệnh đều
// rơi vào nhánh chào mừng ⇒ bot "trả lời" cả nhóm dù không ai gọi nó.
//
// Bài kiểm tra dưới đây canh đúng điều đó ở hai tầng:
//   - tầng quyết định (resolveGroupReplyDecision) — thuần, không I/O;
//   - tầng thật (handleIncomingMessage) — có gửi tin thật qua nhà cung cấp giả.
// ============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// Firestore giả, cài TRƯỚC khi require main.js.
function installFakePersistence() {
    const persistencePath = require.resolve(path.join(ROOT, "firestorePersistence"));
    const real = require(persistencePath);
    const memoryFiles = new Map();
    const writes = { count: 0 };
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
                writes.count += 1;
                memoryFiles.set(fileKey(filePath, defaultPath), clone(value));
            },
            flushPersistenceWrites: async () => undefined,
            getPersistenceStatus: () => ({ backend: "test" })
        }
    };
    return { memoryFiles, writes };
}

const fake = installFakePersistence();

const {
    SKIP_REASON,
    groupReplyOptionsFromEnv,
    isBotMentioned,
    resolveGroupReplyDecision,
    stripBotMention
} = require("../groupMentions");
const { registerBots, clearBots, runWithBot } = require("../botContext");
const { createOfficialProvider } = require("../providers/officialProvider");
const main = require("../main");

// Nhà cung cấp giả ghi lại mọi lần gửi.
function officialWithRecorder(botId, displayName) {
    const provider = createOfficialProvider({ botId, token: `token-${botId}`, displayName });
    provider.sent = [];
    provider.client = {
        on() { return this; },
        startPolling: async () => true,
        stopPolling: async () => true,
        getMe: async () => ({ name: displayName }),
        sendMessage: async (chatId, text) => {
            provider.sent.push({ chatId: String(chatId), text });
            return { ok: true };
        }
    };
    return provider;
}

function groupMessage(text, extra = {}) {
    return {
        text,
        chat: { id: "group-1", type: "group", title: "Nhóm lớp" },
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

// Bot ZCA: danh tính có UID thật, tên hiển thị tiếng Việt.
const zcaRuntime = { botId: "zca:111222333", ownUid: "111222333", displayName: "Alessandra" };

/* ========================================================================== */
/* 1. Quyết định phản hồi                                                     */
/* ========================================================================== */

test("chat riêng: luôn phản hồi, không phụ thuộc tag", () => {
    const decision = resolveGroupReplyDecision({ msg: privateMessage("chào bot"), runtime: zcaRuntime });
    assert.equal(decision.isGroup, false);
    assert.equal(decision.respond, true);
    assert.equal(decision.reason, SKIP_REASON.NOT_GROUP);
});

test("nhóm: tin thường không tag bot thì KHÔNG phản hồi", () => {
    const decision = resolveGroupReplyDecision({ msg: groupMessage("cả nhà ơi mai học gì"), runtime: zcaRuntime });
    assert.equal(decision.isGroup, true);
    assert.equal(decision.respond, false, "không tag thì bot phải im lặng");
    assert.equal(decision.reason, SKIP_REASON.UNTAGGED);
    assert.equal(decision.mentioned, false);
});

test("nhóm: tag bot bằng danh sách mention (UID) thì phản hồi", () => {
    const msg = groupMessage("@Alessandra lịch mai thế nào", {
        meta: { mentions: [{ uid: "111222333", name: "Alessandra" }] }
    });
    const decision = resolveGroupReplyDecision({ msg, runtime: zcaRuntime });
    assert.equal(decision.mentioned, true);
    assert.equal(decision.respond, true);
    assert.equal(decision.reason, SKIP_REASON.MENTIONED);
});

test("nhóm: tag NGƯỜI KHÁC thì bot vẫn im lặng", () => {
    const msg = groupMessage("@Minh ơi cho tớ hỏi", {
        meta: { mentions: [{ uid: "999999", name: "Minh" }] }
    });
    const decision = resolveGroupReplyDecision({ msg, runtime: zcaRuntime });
    assert.equal(decision.mentioned, false, "mention của người khác không phải của bot");
    assert.equal(decision.respond, false);
});

test("nhóm: tag bằng chữ @Tên khi nền tảng không kèm danh sách mention", () => {
    const decision = resolveGroupReplyDecision({ msg: groupMessage("@Alessandra ơi"), runtime: zcaRuntime });
    assert.equal(decision.mentioned, true);
    assert.equal(decision.respond, true);
});

test("nhóm: so khớp tên bỏ dấu, không phân biệt hoa thường", () => {
    const runtime = { botId: "zca:1", ownUid: "1", displayName: "Nguyễn Văn Ánh" };
    const decision = resolveGroupReplyDecision({ msg: groupMessage("@nguyen van anh xem giúp"), runtime });
    assert.equal(decision.mentioned, true);
});

test("nhóm: lệnh /... vẫn chạy dù không tag (tương thích)", () => {
    const decision = resolveGroupReplyDecision({ msg: groupMessage("/help"), runtime: zcaRuntime });
    assert.equal(decision.isCommand, true);
    assert.equal(decision.respond, true);
    assert.equal(decision.reason, SKIP_REASON.COMMAND);
});

test("nhóm: chế độ chặt — lệnh cũng phải tag mới chạy", () => {
    const decision = resolveGroupReplyDecision({
        msg: groupMessage("/help"),
        runtime: zcaRuntime,
        options: { requireMention: true, allowCommandsWithoutMention: false }
    });
    assert.equal(decision.respond, false);
    assert.equal(decision.reason, SKIP_REASON.MENTION_REQUIRED_FOR_COMMAND);
});

test("nhóm: tag rồi mới gõ lệnh vẫn phân tích được lệnh", () => {
    const msg = groupMessage("@Alessandra /help", { meta: { mentions: [{ uid: "111222333" }] } });
    const decision = resolveGroupReplyDecision({ msg, runtime: zcaRuntime });
    assert.equal(decision.respond, true);
    assert.equal(decision.text, "/help", "phải bỏ phần tag trước khi phân tích lệnh");
    assert.equal(decision.isCommand, true);
});

test("nhóm: chỉ tag mà không nói gì vẫn là được gọi", () => {
    const msg = groupMessage("@Alessandra", { meta: { mentions: [{ uid: "111222333" }] } });
    const decision = resolveGroupReplyDecision({ msg, runtime: zcaRuntime });
    assert.equal(decision.respond, true);
    assert.equal(decision.text, "");
});

test("nhóm: tin rỗng không tag thì im lặng", () => {
    const decision = resolveGroupReplyDecision({ msg: groupMessage(""), runtime: zcaRuntime });
    assert.equal(decision.respond, false);
    assert.equal(decision.reason, SKIP_REASON.EMPTY);
});

test("tắt cổng nhóm thì quay lại hành vi cũ", () => {
    const decision = resolveGroupReplyDecision({
        msg: groupMessage("tin thường"),
        runtime: zcaRuntime,
        options: { requireMention: false }
    });
    assert.equal(decision.respond, true);
});

test("loại chat lạ (không rõ nhóm/riêng) vẫn phản hồi như chat riêng", () => {
    const msg = { text: "chào", chat: { id: "x" }, from: { id: "u" } };
    const decision = resolveGroupReplyDecision({ msg, runtime: zcaRuntime });
    assert.equal(decision.isGroup, false);
    assert.equal(decision.respond, true);
});

/* ========================================================================== */
/* 2. Nhận diện danh tính và bỏ tag                                           */
/* ========================================================================== */

test("nhận diện bot qua nhiều hình dạng mention", () => {
    const shapes = [
        { meta: { mentions: [{ uid: "111222333" }] } },
        { mentions: [{ uid: "111222333" }] },
        { data: { mentions: [{ userId: "111222333" }] } },
        { mentionIds: ["111222333"] },
        { mentioned_uids: ["111222333"] }
    ];
    for (const extra of shapes) {
        assert.equal(isBotMentioned(groupMessage("x", extra), zcaRuntime), true, JSON.stringify(extra));
    }
    assert.equal(isBotMentioned(groupMessage("x"), zcaRuntime), false);
});

test("bỏ tag không ăn mất nội dung phía sau", () => {
    assert.equal(stripBotMention("@Alessandra /dangky 123", zcaRuntime), "/dangky 123");
    assert.equal(stripBotMention("@Alessandra  ơi cho em hỏi", zcaRuntime), "ơi cho em hỏi");
    assert.equal(stripBotMention("/help", zcaRuntime), "/help", "không có tag thì giữ nguyên");
});

test("công tắc môi trường: mặc định bật cổng nhóm", () => {
    assert.deepEqual(groupReplyOptionsFromEnv({}), { requireMention: true, allowCommandsWithoutMention: true });
    assert.equal(groupReplyOptionsFromEnv({ GROUP_MENTION_ONLY: "0" }).requireMention, false);
    assert.equal(groupReplyOptionsFromEnv({ GROUP_ALLOW_COMMANDS_WITHOUT_MENTION: "false" }).allowCommandsWithoutMention, false);
    // Giá trị rác ⇒ giữ mặc định an toàn.
    assert.equal(groupReplyOptionsFromEnv({ GROUP_MENTION_ONLY: "maybe" }).requireMention, true);
});

/* ========================================================================== */
/* 3. Tầng thật: handleIncomingMessage                                        */
/* ========================================================================== */

test("NHÓM không tag: bot KHÔNG gửi gì cả", async (t) => {
    clearBots();
    t.after(() => clearBots());
    const bot = officialWithRecorder("bot1", "Alessandra");
    registerBots([bot]);

    const writesBefore = fake.writes.count;
    await runWithBot(bot, () => main.handleIncomingMessage(bot, groupMessage("mai học môn gì vậy cả nhà")));

    assert.equal(bot.sent.length, 0, "tin không tag không được trả lời");
    assert.equal(fake.writes.count, writesBefore, "tin bị bỏ qua không được ghi dữ liệu");
});

test("NHÓM có tag nhưng tin KHÔNG phải lệnh: KHÔNG gửi lời chào", async (t) => {
    clearBots();
    t.after(() => clearBots());
    const bot = officialWithRecorder("bot1", "Alessandra");
    registerBots([bot]);

    // Bài này TRƯỚC ĐÂY kỳ vọng đúng 1 tin gửi đi — và tin đó chính là lời chào.
    // Đó là hành vi sai: lời chào trong nhóm phát cho toàn bộ thành viên, và vì
    // cổng tiếp nhận chỉ nằm trong bộ nhớ nên nó lặp lại sau mỗi lần khởi động.
    // Lời chào chỉ có nghĩa trong cuộc trò chuyện riêng.
    await runWithBot(bot, () => main.handleIncomingMessage(bot, groupMessage("@Alessandra lịch mai thế nào")));

    assert.equal(bot.sent.length, 0, "không được chào tự động trong nhóm");
});

test("NHÓM có tag + LỆNH: vẫn trả lời trong nhóm", async (t) => {
    clearBots();
    t.after(() => clearBots());
    const bot = officialWithRecorder("bot1", "Alessandra");
    registerBots([bot]);

    await runWithBot(bot, () => main.handleIncomingMessage(bot, groupMessage("@Alessandra /help")));

    assert.ok(bot.sent.length >= 1, "lệnh phải được đáp");
    assert.ok(bot.sent.every((item) => item.chatId === "group-1"), "trả lời trong NHÓM, không phải người gửi");
});

test("NHÓM tag người khác: bot vẫn im lặng", async (t) => {
    clearBots();
    t.after(() => clearBots());
    const bot = officialWithRecorder("bot1", "Alessandra");
    registerBots([bot]);

    await runWithBot(bot, () => main.handleIncomingMessage(bot, groupMessage("@Minh ơi", {
        meta: { mentions: [{ uid: "999999", name: "Minh" }] }
    })));
    assert.equal(bot.sent.length, 0);
});

test("CHAT RIÊNG: hành vi cũ giữ nguyên (vẫn chào)", async (t) => {
    clearBots();
    t.after(() => clearBots());
    const bot = officialWithRecorder("bot1", "Alessandra");
    registerBots([bot]);

    await runWithBot(bot, () => main.handleIncomingMessage(bot, privateMessage("chào bot")));
    assert.equal(bot.sent.length, 1, "chat riêng vẫn phải phản hồi");
    assert.equal(bot.sent[0].chatId, "private-1");
});

test("HAI BOT cùng nhóm: tag bot2 thì chỉ bot2 trả lời", async (t) => {
    clearBots();
    t.after(() => clearBots());
    const bot1 = officialWithRecorder("bot1", "Alessandra");
    const bot2 = officialWithRecorder("bot2", "MrYukitoBoBo");
    registerBots([bot1, bot2]);

    // Tin vào bot1 nhưng tag UID của bot2 (bot2 dùng ZCA) ⇒ bot1 im lặng.
    const message = groupMessage("@MrYukitoBoBo giúp em với", {
        meta: { mentions: [{ uid: "222333444" }] }
    });
    await runWithBot(bot1, () => main.handleIncomingMessage(bot1, message));
    assert.equal(bot1.sent.length, 0, "bot1 không được trả lời tin tag bot2");
    assert.equal(bot2.sent.length, 0, "bot2 không nhận được sự kiện này");
});

/* ========================================================================== */
/* Tên người dùng gõ khi gọi bot (alias)                                       */
/* ========================================================================== */

const { botIdentityOf, parseAliases, resolveBotConfigs } = (() => ({
    botIdentityOf: require("../groupMentions").botIdentityOf,
    parseAliases: require("../bots").parseAliases,
    resolveBotConfigs: require("../bots").resolveBotConfigs
}))();

test("alias là tên người dùng gõ, khác tên tài khoản", () => {
    const runtime = { botId: "zca:999", ownUid: "999", verifiedName: "Nguyễn Thuận", aliases: ["Fatherbot"] };
    const identity = botIdentityOf(runtime);
    assert.ok(identity.names.includes("Fatherbot"));
    assert.ok(identity.names.includes("Nguyễn Thuận"));

    // Gõ tay "@Fatherbot" (không có mention cấu trúc) vẫn phải khớp.
    assert.equal(isBotMentioned({ text: "@Fatherbot lịch ngày mai thế nào" }, runtime), true);
    // Không phân biệt hoa thường và dấu.
    assert.equal(isBotMentioned({ text: "@fatherbot ơi" }, runtime), true);
});

test("alias nhận cả dạng chuỗi phân tách bằng dấu phẩy", () => {
    const runtime = { botId: "bot1", aliases: "Fatherbot, Lịch Học" };
    const identity = botIdentityOf(runtime);
    assert.ok(identity.names.includes("Fatherbot"));
    assert.ok(identity.names.includes("Lịch Học"));
});

test("không có alias và tên tài khoản khác thì vẫn bị coi là không nhắc", () => {
    const runtime = { botId: "zca:999", ownUid: "999", verifiedName: "Nguyễn Thuận" };
    assert.equal(isBotMentioned({ text: "@Fatherbot ơi" }, runtime), false);

    const decision = resolveGroupReplyDecision({
        msg: { text: "@Fatherbot ơi", chat: { id: "g1", type: "group" }, from: { id: "u1" } },
        runtime,
        text: "@Fatherbot ơi"
    });
    assert.equal(decision.respond, false);
    assert.equal(decision.reason, "untagged");
});

test("mention có cấu trúc vẫn thắng, không cần alias", () => {
    const runtime = { botId: "zca:999", ownUid: "999", verifiedName: "Nguyễn Thuận" };
    const msg = {
        text: "@Ai đó ơi",
        chat: { id: "g1", type: "group" },
        from: { id: "u1" },
        meta: { mentions: [{ uid: "999" }] }
    };
    assert.equal(isBotMentioned(msg, runtime), true);
});

test("parseAliases bỏ rỗng, bỏ trùng, giữ nguyên chữ", () => {
    assert.deepEqual(parseAliases("Fatherbot, Lịch Học , , fatherbot"), ["Fatherbot", "Lịch Học"]);
    assert.deepEqual(parseAliases(""), []);
    assert.deepEqual(parseAliases(null), []);
    assert.deepEqual(parseAliases(["A", "B"]), ["A", "B"]);
});

test("cấu hình đọc alias từ BOT_ALIASES và BOT_N_ALIASES", () => {
    const shared = resolveBotConfigs({ BOT_TOKEN: "t1", BOT_ALIASES: "Chung" });
    assert.deepEqual(shared.bots[0].aliases, ["Chung"]);

    const perBot = resolveBotConfigs({ BOT_TOKEN: "t1", BOT_1_ALIASES: "Riêng 1", BOT_ALIASES: "Chung" });
    assert.deepEqual(perBot.bots[0].aliases, ["Riêng 1", "Chung"], "alias riêng của bot đứng trước");
});
