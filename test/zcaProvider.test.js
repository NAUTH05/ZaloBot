const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const adapter = require("../providers/zca/zcaMessageAdapter");
const sessionStore = require("../providers/zca/zcaSessionStore");
const { createZcaProvider, ZCA_STATUS, describeCloseReason } = require("../providers/zca/zcaProvider");
const { createOfficialProvider } = require("../providers/officialProvider");
const { registerBot, registerBots, rekeyBot, clearBots, listBots, describeRegisteredBots } = require("../botContext");
const { normalizeBotId, providerTypeOf, storageKeyPrefix, scopeKey, parseScopedKey, zcaId, zcaUidOf, isZcaId, formatBotLabel } = require("../bots");

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zca-test-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

// Tài khoản Zalo cá nhân giả: UID cố định để khóa lưu trữ ổn định qua các lần chạy.
const OWN_UID = "1234567890123";

function fakeZcaMessage(overrides = {}) {
    const base = {
        type: 0,                                   // ThreadType.User
        threadId: "friend-uid-1",
        isSelf: false,
        data: {
            uidFrom: "friend-uid-1",
            dName: "Nguyễn Văn A",
            msgId: "msg-1",
            cliMsgId: "cli-1",
            ts: "1758000000000",
            content: "/help"
        }
    };
    return { ...base, ...overrides, data: { ...base.data, ...(overrides.data || {}) } };
}

/* -------------------------------------------------------------------------- */
/* Danh tính nhà cung cấp                                                     */
/* -------------------------------------------------------------------------- */

test("danh tính ZCA ổn định và suy ra từ UID thật", () => {
    assert.equal(zcaId(OWN_UID), `zca:${OWN_UID}`);
    assert.equal(zcaUidOf(`zca:${OWN_UID}`), OWN_UID);
    assert.equal(isZcaId(`zca:${OWN_UID}`), true);
    assert.equal(isZcaId("bot1"), false);
    assert.equal(providerTypeOf(`zca:${OWN_UID}`), "zca");
    assert.equal(providerTypeOf("bot1"), "official");
    // UID rỗng hoặc không hợp lệ không được tạo ra danh tính.
    assert.equal(zcaId(""), null);
    assert.equal(zcaId(null), null);
    assert.equal(normalizeBotId("zca:"), null);
});

test("không gian khóa của ZCA tách khỏi mọi bot chính thức", () => {
    const zcaBotId = `zca:${OWN_UID}`;
    assert.equal(storageKeyPrefix("bot1"), "", "bot 1 giữ khóa trần");
    assert.equal(storageKeyPrefix(zcaBotId), `${zcaBotId}::`);

    const key = scopeKey(zcaBotId, "chat-1::user-1");
    assert.equal(key, `${zcaBotId}::chat-1::user-1`);
    // Khóa ZCA có dấu ":" bên trong nên phải tách đúng.
    assert.deepEqual(parseScopedKey(key), { botId: zcaBotId, key: "chat-1::user-1", scoped: true });
    // Khóa của bot 1 và ZCA không bao giờ trùng nhau.
    assert.notEqual(scopeKey("bot1", "chat-1"), scopeKey(zcaBotId, "chat-1"));
});

test("nhãn ZCA không bao giờ bị trình bày thành bot chính thức", () => {
    const label = formatBotLabel({ botId: `zca:${OWN_UID}`, displayName: "Nguyễn Văn A" });
    assert.equal(label, `Nguyễn Văn A · zca:${OWN_UID}`);
    assert.ok(!label.includes("bot1"), "nhãn ZCA không được nhắc tới bot1");
    // Chưa biết danh tính thì chỉ hiện tên, không ghép bot1.
    assert.equal(formatBotLabel({ botId: null, displayName: "ZCA" }), "ZCA");
});

test("đổi khóa đăng ký khi biết UID, không cho ghi đè nhà cung cấp khác", (t) => {
    clearBots();
    t.after(() => clearBots());

    registerBot({ botId: "bot1", providerType: "official", getIdentity: () => ({}), getStatus: () => ({}) });
    registerBot({ botId: "zca:pending", providerType: "zca", getIdentity: () => ({}), getStatus: () => ({}) });

    assert.ok(rekeyBot("zca:pending", `zca:${OWN_UID}`), "phải đổi được khóa");
    assert.deepEqual(listBots().map((bot) => bot.botId).sort(), ["bot1", `zca:${OWN_UID}`].sort());
    // Không được ghi đè một nhà cung cấp đang tồn tại.
    assert.equal(rekeyBot(`zca:${OWN_UID}`, "bot1"), null);
});

/* -------------------------------------------------------------------------- */
/* Adapter tin nhắn                                                           */
/* -------------------------------------------------------------------------- */

test("tin nhắn cá nhân được chuyển đúng định dạng nội bộ", () => {
    const internal = adapter.toInternalMessage(fakeZcaMessage());
    assert.equal(internal.text, "/help");
    assert.equal(internal.chat.id, "friend-uid-1");
    assert.equal(internal.chat.type, "private");
    assert.equal(internal.from.id, "friend-uid-1");
    assert.equal(internal.from.display_name, "Nguyễn Văn A");
});

test("tin nhắn nhóm giữ CẢ người gửi lẫn ID nhóm", () => {
    const internal = adapter.toInternalMessage(fakeZcaMessage({
        type: 1,                        // ThreadType.Group
        threadId: "group-999",
        data: { uidFrom: "member-uid-7", dName: "Thành viên" }
    }));
    assert.equal(internal.chat.id, "group-999", "chat.id phải là nhóm");
    assert.equal(internal.chat.type, "group");
    assert.equal(internal.from.id, "member-uid-7", "from.id phải là người gửi");
    // Không được lẫn hai thứ này vào nhau.
    assert.notEqual(internal.chat.id, internal.from.id);
});

test("tin nhắn của chính tài khoản bị nhận diện để bỏ qua", () => {
    assert.equal(adapter.isSelfMessage(fakeZcaMessage({ isSelf: true })), true);
    assert.equal(adapter.isSelfMessage(fakeZcaMessage({ isSelf: false })), false);
    assert.equal(adapter.isSelfMessage(null), false);
});

test("nội dung không phải văn bản không bị bịa thành lệnh", () => {
    // Ảnh/sticker: content là object không có trường văn bản.
    assert.equal(adapter.extractText(fakeZcaMessage({ data: { content: { thumb: "x", href: "y" } } })), "");
    assert.equal(adapter.toInternalMessage(fakeZcaMessage({ data: { content: { thumb: "x" } } })).text, "");
    // Có trường văn bản thì vẫn lấy được.
    assert.equal(adapter.extractText(fakeZcaMessage({ data: { content: { msg: "xin chào" } } })), "xin chào");
});

test("tin nhắn thiếu threadId bị bỏ qua thay vì tạo bản ghi rác", () => {
    assert.equal(adapter.toInternalMessage(fakeZcaMessage({ threadId: "" })), null);
    assert.equal(adapter.toInternalMessage(null), null);
});

test("nhận diện được nhắc tới tài khoản trong nhóm", () => {
    const message = fakeZcaMessage({ type: 1, data: { mentions: [{ uid: OWN_UID, pos: 0, len: 5 }] } });
    assert.equal(adapter.isBotMentioned(message, OWN_UID), true);
    assert.equal(adapter.isBotMentioned(message, "someone-else"), false);
    assert.equal(adapter.isBotMentioned(fakeZcaMessage(), OWN_UID), false);
});

/* -------------------------------------------------------------------------- */
/* Kho phiên đăng nhập                                                        */
/* -------------------------------------------------------------------------- */

test("phiên ghi nguyên tử và đọc lại được", (t) => {
    const dir = tempDir(t);
    const credentials = {
        imei: "imei-abc",
        cookie: [{ name: "zpsid", value: "secret-cookie-value", domain: "zalo.me" }],
        userAgent: "UA/1.0",
        language: "vi"
    };

    sessionStore.saveSession(dir, credentials, { uid: OWN_UID });
    const loaded = sessionStore.readSession(dir);

    assert.equal(loaded.imei, "imei-abc");
    assert.equal(loaded.userAgent, "UA/1.0");
    assert.equal(loaded.uid, OWN_UID);
    assert.equal(loaded.cookie.length, 1);
    // Không được để lại file tạm.
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, [], "không được để lại file tạm sau khi ghi");
});

test("mô tả phiên KHÔNG bao giờ chứa cookie hay imei", (t) => {
    const dir = tempDir(t);
    sessionStore.saveSession(dir, {
        imei: "imei-secret-value",
        cookie: [{ name: "zpsid", value: "cookie-secret-value" }],
        userAgent: "UA-secret"
    }, { uid: OWN_UID });

    const described = sessionStore.describeSession(dir);
    const serialized = JSON.stringify(described);

    assert.equal(described.present, true);
    assert.equal(described.uid, OWN_UID);
    assert.equal(described.cookieCount, 1);
    for (const secret of ["imei-secret-value", "cookie-secret-value", "UA-secret"]) {
        assert.ok(!serialized.includes(secret), `mô tả phiên làm lộ ${secret}`);
    }
});

test("phiên thiếu trường bắt buộc bị coi là không có", (t) => {
    const dir = tempDir(t);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sessionStore.sessionFilePath(dir), JSON.stringify({ imei: "x" }), "utf8");
    assert.equal(sessionStore.readSession(dir), null, "phiên thiếu cookie/userAgent phải bị từ chối");
});

test("phiên hỏng không làm ném lỗi", (t) => {
    const dir = tempDir(t);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sessionStore.sessionFilePath(dir), "{ khong phai json", "utf8");
    assert.equal(sessionStore.readSession(dir), null);
    assert.equal(sessionStore.describeSession(dir).present, false);
});

test("khoá phiên ngăn hai tiến trình dùng chung một phiên", (t) => {
    const dir = tempDir(t);

    // Lần đầu: chưa có khóa ⇒ giành được.
    assert.equal(sessionStore.acquireLock(dir).ok, true);

    // Khóa cũ của một tiến trình ĐÃ CHẾT phải được chiếm lại, nếu không thì một
    // lần crash sẽ khoá cứng ZCA mãi mãi.
    fs.writeFileSync(sessionStore.lockFilePath(dir), JSON.stringify({ pid: 999999 }), "utf8");
    assert.equal(sessionStore.acquireLock(dir).ok, true, "khóa cũ của tiến trình đã chết phải được chiếm lại");

    // Khóa của một tiến trình CÒN SỐNG khác phải bị từ chối: hai tiến trình cùng
    // một phiên sẽ đá nhau (CloseReason 3000).
    const livePid = process.ppid && process.ppid !== process.pid ? process.ppid : null;
    if (livePid) {
        fs.writeFileSync(sessionStore.lockFilePath(dir), JSON.stringify({ pid: livePid }), "utf8");
        const blocked = sessionStore.acquireLock(dir);
        assert.equal(blocked.ok, false, "không được chiếm khóa của tiến trình còn sống");
        assert.match(blocked.reason, new RegExp(String(livePid)));
    }

    // releaseLock chỉ xoá khóa của CHÍNH mình.
    fs.writeFileSync(sessionStore.lockFilePath(dir), JSON.stringify({ pid: process.pid }), "utf8");
    sessionStore.releaseLock(dir);
    assert.equal(fs.existsSync(sessionStore.lockFilePath(dir)), false);

    // Không xoá khóa của người khác.
    if (livePid) {
        fs.writeFileSync(sessionStore.lockFilePath(dir), JSON.stringify({ pid: livePid }), "utf8");
        sessionStore.releaseLock(dir);
        assert.equal(fs.existsSync(sessionStore.lockFilePath(dir)), true, "không được xoá khóa của tiến trình khác");
    }
});

/* -------------------------------------------------------------------------- */
/* Vòng đời nhà cung cấp                                                      */
/* -------------------------------------------------------------------------- */

test("ZCA tắt thì không khởi động và không ảnh hưởng ai", async (t) => {
    const dir = tempDir(t);
    const provider = createZcaProvider({ enabled: false, sessionDir: dir });
    t.after(() => provider.stop());

    const result = await provider.start();
    assert.equal(result.started, false);
    assert.equal(result.reason, "disabled");
    assert.equal(provider.getStatus().status, ZCA_STATUS.DISABLED);
    assert.equal(provider.getStatus().enabled, false);
});

test("chưa có phiên thì yêu cầu đăng nhập QR, KHÔNG ném lỗi", async (t) => {
    const dir = tempDir(t);
    const provider = createZcaProvider({ enabled: true, sessionDir: dir });
    t.after(() => provider.stop());

    const result = await provider.start();
    assert.equal(result.started, false);
    assert.equal(result.reason, "no_session");
    assert.equal(provider.getStatus().status, ZCA_STATUS.AUTHENTICATION_REQUIRED);
    assert.equal(provider.getStatus().sessionPresent, false);
});

test("phiên hỏng bị xoá và yêu cầu đăng nhập lại, KHÔNG thử lại vô hạn", async (t) => {
    const dir = tempDir(t);
    sessionStore.saveSession(dir, { imei: "imei-x", cookie: [{ name: "a", value: "b" }], userAgent: "UA" });

    const provider = createZcaProvider({ enabled: true, sessionDir: dir });
    t.after(() => provider.stop());

    // login() sẽ thất bại vì phiên là giả; nhà cung cấp phải nuốt lỗi và yêu cầu
    // đăng nhập lại thay vì ném ra ngoài.
    const result = await provider.start();
    assert.equal(result.started, false);
    assert.equal(result.reason, "session_invalid");
    assert.equal(provider.getStatus().status, ZCA_STATUS.AUTHENTICATION_REQUIRED);
    // Phiên hỏng phải bị xoá để lần sau đăng nhập lại từ đầu.
    assert.equal(fs.existsSync(sessionStore.sessionFilePath(dir)), false, "phiên hỏng phải bị xoá");
});

test("gửi tin khi chưa đăng nhập báo lỗi rõ ràng thay vì im lặng", async (t) => {
    const dir = tempDir(t);
    const provider = createZcaProvider({ enabled: true, sessionDir: dir });
    t.after(() => provider.stop());
    await assert.rejects(() => provider.sendMessage("chat-1", "xin chào"), /chưa đăng nhập/);
});

test("trạng thái và danh tính của ZCA nêu rõ đây là tài khoản cá nhân", (t) => {
    const dir = tempDir(t);
    const provider = createZcaProvider({ enabled: true, sessionDir: dir, displayName: "Tài khoản thử" });
    t.after(() => provider.stop());

    const identity = provider.getIdentity();
    assert.equal(identity.providerType, "zca");
    assert.equal(identity.isPersonalAccount, true);
    // Tài khoản cá nhân KHÔNG có token — không được bịa ra một cái.
    assert.equal(identity.tokenSource, null);
    assert.equal(identity.tokenFingerprint, null);

    const status = provider.getStatus();
    assert.equal(status.providerType, "zca");
    assert.equal(status.isPersonalAccount, true);
    assert.ok("qrPending" in status && "sessionPresent" in status);
});

test("lý do ngắt kết nối được diễn giải, gồm cả xung đột Zalo Web", () => {
    assert.match(describeCloseReason(3000, ""), /trùng kết nối/);
    assert.match(describeCloseReason(3003, ""), /bị đá/);
    assert.match(describeCloseReason(1006, ""), /bất thường/);
    assert.match(describeCloseReason(9999, ""), /không rõ/);
});

/* -------------------------------------------------------------------------- */
/* Cách ly lỗi giữa các nhà cung cấp                                          */
/* -------------------------------------------------------------------------- */

test("mô tả nhà cung cấp tách bạch bot chính thức và tài khoản cá nhân", (t) => {
    clearBots();
    t.after(() => clearBots());

    const official = createOfficialProvider({ botId: "bot1", token: "secret-token-value" });
    const zca = createZcaProvider({ enabled: true, sessionDir: tempDir(t) });
    registerBots([official, zca]);

    const described = describeRegisteredBots();
    const serialized = JSON.stringify(described);

    assert.ok(!serialized.includes("secret-token-value"), "không được lộ token của bot chính thức");

    const officialEntry = described.find((item) => item.botId === "bot1");
    const zcaEntry = described.find((item) => item.providerType === "zca");
    assert.equal(officialEntry.providerType, "official");
    assert.equal(officialEntry.isPersonalAccount, false);
    assert.equal(typeof officialEntry.tokenFingerprint, "string");
    assert.equal(zcaEntry.isPersonalAccount, true);
    assert.equal(zcaEntry.tokenFingerprint, null);
});

test("ZCA lỗi không được làm hỏng nhà cung cấp chính thức", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const official = createOfficialProvider({ botId: "bot1", token: "token-1" });
    // Nhà cung cấp ZCA cố tình hỏng: login luôn ném lỗi.
    const brokenZca = createZcaProvider({ enabled: true, sessionDir: tempDir(t) });
    brokenZca.start = async () => { throw new Error("ZCA sập"); };
    registerBots([official, brokenZca]);

    // Bắt chước ranh giới lỗi ở main.js: lỗi một nhà cung cấp bị nuốt riêng.
    const started = [];
    const failed = [];
    for (const runtime of listBots()) {
        try {
            await runtime.start();
            started.push(runtime.botId);
        } catch (error) {
            failed.push(runtime.botId);
        }
    }

    assert.deepEqual(failed, ["zca:pending"], "chỉ ZCA được phép hỏng");
    // Bot chính thức vẫn phải ở trạng thái chạy được.
    assert.equal(official.getStatus().status, "running");
    assert.equal(official.getStatus().enabled, true);
});
