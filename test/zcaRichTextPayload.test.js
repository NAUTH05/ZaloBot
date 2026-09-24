// ============================================================================
// Xác minh PAYLOAD THẬT mà nhà cung cấp ZCA gửi đi.
//
// Bài kiểm tra renderer chỉ chứng minh hàm chuyển đổi đúng. Bài này chứng minh
// nhà cung cấp thực sự gọi api.sendMessage với { msg, styles } — và rằng bot
// chính thức vẫn nhận Markdown nguyên vẹn như trước.
// ============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.BOT_TOKEN = "richtext-token-1";

const { createZcaProvider } = require("../providers/zca/zcaProvider");
const { createOfficialProvider } = require("../providers/officialProvider");
const { registerBots, clearBots, runWithBot } = require("../botContext");

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

const ZCA_UID = "777000777";
const ZCA_BOT_ID = `zca:${ZCA_UID}`;

// Nhà cung cấp ZCA đã "đăng nhập", với api giả ghi lại đúng payload nhận được.
function loggedInZca(t, options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zca-payload-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const provider = createZcaProvider({ enabled: true, sessionDir: dir, displayName: "Tài khoản thử" });
    provider.sent = [];
    provider.failStyled = Boolean(options.failStyled);
    provider.botId = ZCA_BOT_ID;
    provider.ownUid = ZCA_UID;
    provider.authenticated = true;
    provider.status = "connected";
    provider.rememberThread("chat-1", "private");
    provider.api = {
        sendMessage: async (payload, threadId, threadType) => {
            provider.sent.push({ payload, threadId, threadType });
            // Giả lập Zalo từ chối payload có styles.
            if (provider.failStyled && payload && typeof payload === "object" && payload.styles) {
                throw new Error("Zalo từ chối styles");
            }
            return { message: { msgId: 1 }, attachment: [] };
        },
        getOwnId: () => ZCA_UID
    };
    return provider;
}

function seedChat(botId, chatId = "chat-1") {
    memoryFiles.set(fileKey(path.join(ROOT, "chatDirectory.json")), {
        schemaVersion: 3,
        chats: {
            [`${botId}::${chatId}`]: {
                chatId, botId, chatType: "private", displayName: "Chat thử", userId: "user-1", status: "active"
            }
        },
        deletedChatIds: {}
    });
}

/* -------------------------------------------------------------------------- */
/* Payload của ZCA                                                            */
/* -------------------------------------------------------------------------- */

test("ZCA gửi { msg, styles } và msg KHÔNG còn ký hiệu định dạng", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const zca = loggedInZca(t);
    seedChat(ZCA_BOT_ID);
    registerBots([zca]);

    await zca.sendMessage("chat-1", "# {green}✓ ĐÃ LƯU{/green}\n\n> Dùng **/help** để xem lệnh.");

    assert.equal(zca.sent.length, 1);
    const { payload, threadId } = zca.sent[0];

    assert.equal(typeof payload, "object", "payload phải là object, không phải chuỗi");
    assert.ok("msg" in payload, "payload phải có trường msg");
    assert.ok(Array.isArray(payload.styles), "payload phải có mảng styles");
    assert.equal(threadId, "chat-1");

    // Văn bản cuối sạch ký hiệu định dạng.
    assert.equal(payload.msg, "✓ ĐÃ LƯU\n\n│ Dùng /help để xem lệnh.");
    assert.ok(!payload.msg.includes("**"));
    assert.ok(!payload.msg.includes("{green}"));
    assert.ok(!payload.msg.includes("# "));

    // Mọi span trỏ đúng văn bản cuối.
    for (const style of payload.styles) {
        assert.ok(style.start + style.len <= payload.msg.length, "span vượt biên");
        assert.ok(style.len > 0, "span rỗng");
    }
});

test("payload thật có styles trỏ đúng từng đoạn", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const zca = loggedInZca(t);
    seedChat(ZCA_BOT_ID);
    registerBots([zca]);

    await zca.sendMessage("chat-1", "**/lichtuan [MSSV]**\nXem lịch học trong tuần.");

    const { payload } = zca.sent[0];
    assert.equal(payload.msg, "/lichtuan [MSSV]\nXem lịch học trong tuần.");
    const bold = payload.styles.filter((s) => s.st === "b");
    assert.equal(bold.length, 1);
    assert.equal(payload.msg.slice(bold[0].start, bold[0].start + bold[0].len), "/lichtuan [MSSV]");
});

test("nội dung không có định dạng thì không gửi kèm styles", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const zca = loggedInZca(t);
    seedChat(ZCA_BOT_ID);
    registerBots([zca]);

    await zca.sendMessage("chat-1", "Chỉ là chữ thường, không định dạng.");

    const { payload } = zca.sent[0];
    assert.equal(payload.msg, "Chỉ là chữ thường, không định dạng.");
    assert.equal(payload.styles, undefined, "không có định dạng thì không gửi mảng styles rỗng");
});

test("Zalo từ chối styles thì thử lại ĐÚNG MỘT LẦN, không kèm styles và không kèm Markdown", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const zca = loggedInZca(t, { failStyled: true });
    seedChat(ZCA_BOT_ID);
    registerBots([zca]);

    await zca.sendMessage("chat-1", "**quan trọng**");

    assert.equal(zca.sent.length, 2, "phải thử lại đúng một lần");
    // Lần đầu có styles.
    assert.ok(zca.sent[0].payload.styles, "lần đầu phải kèm styles");
    // Lần hai không có styles, nhưng vẫn là văn bản đã bỏ ký hiệu định dạng.
    assert.equal(zca.sent[1].payload.styles, undefined);
    assert.equal(zca.sent[1].payload.msg, "quan trọng");
    assert.ok(!zca.sent[1].payload.msg.includes("**"), "không được gửi lại Markdown thô");
});

test("tin nhắn trong nhóm vẫn dùng ThreadType.Group kèm styles", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const zca = loggedInZca(t);
    seedChat(ZCA_BOT_ID, "group-1");
    zca.rememberThread("group-1", "group");
    registerBots([zca]);

    await zca.sendMessage("group-1", "**Thông báo nhóm**");

    assert.equal(zca.sent[0].threadType, 1, "ThreadType.Group = 1");
    assert.equal(zca.sent[0].payload.msg, "Thông báo nhóm");
});

/* -------------------------------------------------------------------------- */
/* Chia tin: mỗi đoạn phải có styles riêng, đúng offset của đoạn đó           */
/* -------------------------------------------------------------------------- */

test("tin dài bị chia đoạn thì mỗi đoạn có styles đúng theo đoạn đó", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const zca = loggedInZca(t);
    seedChat(ZCA_BOT_ID);
    registerBots([zca]);

    // Mỗi khối dài hơn 750 ký tự ⇒ chắc chắn bị chia thành nhiều tin.
    const block = (n) => `# {green}KHỐI ${n}{/green}\n\n${"Nội dung thử nghiệm. ".repeat(50)}`;
    await runWithBot(zca, () => main.sendMessage("chat-1", [block(1), block(2), block(3)].join("\n\n")));

    assert.ok(zca.sent.length > 1, `phải bị chia thành nhiều tin, nhận ${zca.sent.length}`);

    for (const [index, item] of zca.sent.entries()) {
        const { payload } = item;
        assert.ok(!payload.msg.includes("**"), `đoạn ${index} còn ký hiệu thô`);
        assert.ok(!payload.msg.includes("{green}"), `đoạn ${index} còn {green}`);
        assert.ok(!payload.msg.includes("# "), `đoạn ${index} còn dấu #`);
        // Mỗi span của đoạn phải nằm trong đoạn đó — không lệch sang đoạn khác.
        for (const style of payload.styles || []) {
            assert.ok(
                style.start + style.len <= payload.msg.length,
                `đoạn ${index}: span vượt biên (${style.start}+${style.len} > ${payload.msg.length})`
            );
        }
    }

    // Đoạn đầu phải có style xanh của chính nó.
    const firstGreen = (zca.sent[0].payload.styles || []).find((s) => s.st === "c_15a85f");
    assert.ok(firstGreen, "đoạn đầu phải giữ được màu xanh");
    assert.equal(
        zca.sent[0].payload.msg.slice(firstGreen.start, firstGreen.start + firstGreen.len),
        "KHỐI 1"
    );
});

/* -------------------------------------------------------------------------- */
/* Bot chính thức không đổi                                                   */
/* -------------------------------------------------------------------------- */

test("bot chính thức vẫn nhận Markdown NGUYÊN VẸN, không qua renderer ZCA", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const official = createOfficialProvider({ botId: "bot1", token: "richtext-token-1" });
    official.sent = [];
    official.client = {
        on() { return this; },
        startPolling: async () => true,
        sendMessage: async (chatId, text, options) => {
            official.sent.push({ chatId, text, options });
            return { ok: true };
        },
        getMe: async () => ({ name: "Bot thử" })
    };
    seedChat("bot1");
    registerBots([official]);

    await runWithBot(official, () => main.sendMessage("chat-1", "# {green}✓ ĐÃ LƯU{/green}\n\nDùng **/help**."));

    assert.equal(official.sent.length, 1);
    const { text, options } = official.sent[0];

    // Markdown phải còn nguyên — bot chính thức tự hiểu qua parse_mode.
    assert.equal(text, "# {green}✓ ĐÃ LƯU{/green}\n\nDùng **/help**.");
    assert.ok(text.includes("**"), "bot chính thức phải nhận nguyên **");
    assert.ok(text.includes("{green}"), "bot chính thức phải nhận nguyên {green}");
    assert.ok(text.startsWith("# "), "bot chính thức phải nhận nguyên dấu #");
    assert.equal(options.parse_mode, "markdown", "phải giữ parse_mode = markdown");

    // Và không được gửi dạng object { msg, styles }.
    assert.equal(typeof text, "string");
});

test("hai nhà cung cấp nhận cùng một template theo hai cách khác nhau", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const official = createOfficialProvider({ botId: "bot1", token: "richtext-token-1" });
    official.sent = [];
    official.client = {
        on() { return this; },
        startPolling: async () => true,
        sendMessage: async (chatId, text, options) => { official.sent.push({ text, options }); return { ok: true }; },
        getMe: async () => ({ name: "Bot thử" })
    };

    const zca = loggedInZca(t);
    seedChat("bot1");
    seedChat(ZCA_BOT_ID);
    registerBots([official, zca]);

    const template = "# {orange}[TRỢ GIÚP]{/orange}\n\nDùng **/help** để xem danh sách lệnh.";

    await runWithBot(official, () => main.sendMessage("chat-1", template));
    await runWithBot(zca, () => main.sendMessage("chat-1", template));

    // Cùng một template, hai kiểu payload khác nhau — đúng như thiết kế.
    assert.ok(official.sent[0].text.includes("{orange}"), "bot chính thức giữ nguyên cú pháp màu");
    assert.equal(official.sent[0].options.parse_mode, "markdown");

    const zcaPayload = zca.sent[0].payload;
    assert.equal(zcaPayload.msg, "[TRỢ GIÚP]\n\nDùng /help để xem danh sách lệnh.");
    assert.ok(!zcaPayload.msg.includes("{orange}"));
    assert.ok(zcaPayload.styles.some((s) => s.st === "c_f27806"), "ZCA phải có style màu cam");
});
