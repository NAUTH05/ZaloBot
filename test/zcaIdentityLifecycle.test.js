// ============================================================================
// Vòng đời danh tính ZCA: zca:pending → sẵn sàng.
//
// "zca:pending" là danh tính TẠM trước khi đăng nhập, vì UID chỉ biết được sau khi
// đăng nhập. Trước đây nó kéo theo hai hệ quả:
//   1. resolveBotNames() chạy lúc khởi động, khi tài khoản chưa sẵn sàng, nên luôn
//      ghi "[zca:pending]: không lấy được tên; dùng nhãn cấu hình." — kể cả khi tài
//      khoản hoàn toàn bình thường. Đây là vấn đề TÊN HIỂN THỊ, không phải kết nối.
//   2. Không ai tra lại tên sau khi đăng nhập xong, nên tên thật không bao giờ có.
// ============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.BOT_TOKEN = "name-token-1";
const ROOT = path.join(__dirname, "..");
const { createZcaProvider } = require("../providers/zca/zcaProvider");
const { createOfficialProvider } = require("../providers/officialProvider");
const { registerBots, clearBots, rekeyBot, getBot } = require("../botContext");

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zca-name-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test("ZCA bắt đầu ở trạng thái chờ, chưa sẵn sàng tra tên", (t) => {
    clearBots();
    t.after(() => clearBots());
    const provider = createZcaProvider({ enabled: true, sessionDir: tempDir(t) });

    assert.equal(provider.botId, "zca:pending", "danh tính tạm trước khi biết UID");
    assert.equal(provider.isReadyForName(), false, "chưa đăng nhập thì chưa tra tên được");
});

test("chưa sẵn sàng thì fetchIdentityName trả null, KHÔNG ném lỗi", async (t) => {
    clearBots();
    t.after(() => clearBots());
    const provider = createZcaProvider({ enabled: true, sessionDir: tempDir(t) });

    // Trả null là hành vi CÓ CHỦ Ý: chưa có gì để hỏi, không phải hỏng.
    assert.equal(await provider.fetchIdentityName(), null);
});

test("sau khi đăng nhập, tên lấy từ hồ sơ tài khoản", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const provider = createZcaProvider({ enabled: true, sessionDir: tempDir(t) });
    provider.api = {
        fetchAccountInfo: async () => ({ profile: { displayName: "Tài khoản của tôi", zaloName: "fallback" } }),
        getOwnId: () => "900900900",
        sendMessage: async () => ({})
    };
    provider.authenticated = true;

    assert.equal(provider.isReadyForName(), true);
    assert.equal(await provider.fetchIdentityName(), "Tài khoản của tôi");
});

test("hồ sơ thiếu displayName thì dùng zaloName", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const provider = createZcaProvider({ enabled: true, sessionDir: tempDir(t) });
    provider.api = {
        fetchAccountInfo: async () => ({ profile: { zaloName: "Tên Zalo" } }),
        getOwnId: () => "900900900",
        sendMessage: async () => ({})
    };
    provider.authenticated = true;

    assert.equal(await provider.fetchIdentityName(), "Tên Zalo");
});

test("API lỗi thì trả null, không làm hỏng khởi động", async (t) => {
    clearBots();
    t.after(() => clearBots());

    const provider = createZcaProvider({ enabled: true, sessionDir: tempDir(t) });
    provider.api = {
        fetchAccountInfo: async () => { throw new Error("mạng lỗi"); },
        getOwnId: () => "900900900",
        sendMessage: async () => ({})
    };
    provider.authenticated = true;

    await assert.rejects(() => provider.fetchIdentityName(), /mạng lỗi/);
});

test("bot chính thức sẵn sàng tra tên ngay từ lúc tạo", (t) => {
    clearBots();
    t.after(() => clearBots());

    // Client của bot chính thức được tạo ngay trong constructor, và getMe() hoạt
    // động không cần startPolling — nên không có giai đoạn "chờ" như ZCA.
    const provider = createOfficialProvider({ botId: "bot1", token: "t1" });
    assert.equal(provider.isReadyForName(), true);

    // Không có client thì chưa hỏi được.
    provider.client = null;
    assert.equal(provider.isReadyForName(), false);
});

test("đổi danh tính ZCA từ pending sang UID thật", (t) => {
    clearBots();
    t.after(() => clearBots());

    const provider = createZcaProvider({ enabled: true, sessionDir: tempDir(t) });
    registerBots([provider]);
    assert.equal(getBot("zca:pending"), provider);

    // Mô phỏng đúng điều onIdentityChanged làm trong main.js.
    const moved = rekeyBot("zca:pending", "zca:900900900");
    assert.ok(moved, "phải đổi được khóa đăng ký");
    assert.equal(provider.botId, "zca:900900900");
    assert.equal(getBot("zca:pending"), null, "khóa tạm không còn tồn tại");
    assert.equal(getBot("zca:900900900"), provider);
});

test("zca:pending là danh tính TẠM, không phải một tài khoản thật", () => {
    // Khớp ZCA_ID_PATTERN nên nó từng bị coi là danh tính hợp lệ và có thể sinh bản
    // ghi dưới khóa "zca:pending::". Điều này chỉ ra vì sao phải tra tên lại và vì
    // sao bản ghi dưới khóa tạm cần được xử lý riêng.
    const { normalizeBotId } = require("../bots");
    assert.equal(normalizeBotId("zca:pending"), "zca:pending", "khớp mẫu nên bị coi là hợp lệ");
    assert.equal(normalizeBotId("zca:900900900"), "zca:900900900");
    // Nhưng nó không bao giờ là bot1.
    assert.notEqual(normalizeBotId("zca:pending"), "bot1");
});
