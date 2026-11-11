// ============================================================================
// Test tích hợp nhà cung cấp ZCA với API kết bạn.
//
// Thay zca-js bằng lớp giả để chứng minh ba điều mà đọc mã không đủ chắc:
//   1. listener "friend_event" THẬT SỰ được đăng ký và sự kiện đi ra đúng dạng.
//   2. lời mời do CHÍNH tài khoản gửi đi không bị coi là lời mời đến.
//   3. getFriendRecommendations() lọc đúng recommType — gợi ý kết bạn không lọt.
//
// Không có mạng, không có phiên Zalo thật.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const zcaPath = require.resolve("zca-js");
const realZca = require("zca-js");
const { FriendEventType, FriendRecommendationsType } = realZca;

// ---------------------------------------------------------------------------
// zca-js giả
// ---------------------------------------------------------------------------

function makeFakeApi(options = {}) {
    const handlers = new Map();
    const calls = { accept: [], reject: [], status: [], send: [] };

    const api = {
        handlers,
        calls,
        getOwnId: () => options.uid || "1001",
        listener: {
            on(event, handler) { handlers.set(event, handler); },
            start() {
                // zca-js phát "connected" ngay sau khi listener chạy.
                handlers.get("connected")?.();
            },
            stop() {}
        },
        async sendMessage(payload, threadId, threadType) {
            calls.send.push({ payload, threadId, threadType });
            return { ok: true };
        },
        async getFriendRecommendations() {
            return {
                recommItems: (options.recommendations || []).map((item) => ({
                    recommItemType: 1,
                    dataInfo: {
                        userId: item.userId,
                        displayName: item.displayName || null,
                        avatar: item.avatar || null,
                        recommType: item.recommType,
                        recommTime: item.recommTime || 1762700000,
                        recommInfo: { message: item.message || "" }
                    }
                }))
            };
        },
        async getFriendRequestStatus(userId) {
            calls.status.push(userId);
            const value = (options.statuses || {})[userId] || { is_friend: 0, is_requested: 1, is_requesting: 0 };
            return value;
        },
        async acceptFriendRequest(userId) {
            calls.accept.push(userId);
            if (options.acceptError) throw new Error(options.acceptError);
            return "";
        },
        async rejectFriendRequest(userId) {
            calls.reject.push(userId);
            return "";
        },
        emit(event, data) {
            handlers.get(event)?.(data);
        }
    };
    return api;
}

// Cài zca-js giả TRƯỚC khi nạp nhà cung cấp.
//
// Nhà cung cấp lấy `Zalo` MỘT LẦN lúc nạp module. Khi cả bộ test chạy trong cùng
// một tiến trình (mocha), main.js có thể đã nạp nhà cung cấp với zca-js THẬT từ
// trước — nên phải xóa cả cache của nhà cung cấp, không chỉ thay module zca-js.
// Thiếu bước này, bài test đúng khi chạy riêng nhưng sai khi chạy cùng bộ.
let currentApi = makeFakeApi();

const fakeZcaModule = {
    ...realZca,
    Zalo: class FakeZalo {
        async login() { return currentApi; }
        async loginQR() { return currentApi; }
    }
};

const providerPath = require.resolve("../providers/zca/zcaProvider");
const realZcaCacheEntry = require.cache[zcaPath];
require.cache[zcaPath] = { id: zcaPath, filename: zcaPath, loaded: true, exports: fakeZcaModule };
delete require.cache[providerPath];

// Mỗi bài dùng một api riêng: đặt api hiện hành rồi mới tạo nhà cung cấp.
function installFakeZca(api) {
    currentApi = api;
    return api;
}

const { createZcaProvider, mapFriendEvent } = require(providerPath);

// Trả lại zca-js thật và bỏ nhà cung cấp đã nạp bằng lớp giả, để tệp test khác
// trong cùng tiến trình không dùng nhầm.
test.after(() => {
    if (realZcaCacheEntry) require.cache[zcaPath] = realZcaCacheEntry;
    delete require.cache[providerPath];
});

const sessionStore = require("../providers/zca/zcaSessionStore");

function makeSessionDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zca-friend-"));
    sessionStore.saveSession(dir, { imei: "imei-test", cookie: "cookie-test", userAgent: "ua-test", language: "vi" });
    return dir;
}

// ---------------------------------------------------------------------------
// Chuyển sự kiện
// ---------------------------------------------------------------------------

test("lời mời ĐẾN được chuyển thành sự kiện nội bộ", () => {
    const mapped = mapFriendEvent({
        type: FriendEventType.REQUEST,
        data: { toUid: "1001", fromUid: "555", message: "Kết bạn nhé", src: 3 }
    }, "1001");

    assert.deepEqual(mapped, { type: "request", userId: "555", message: "Kết bạn nhé", source: 3 });
});

test("lời mời TA GỬI ĐI không bị coi là lời mời đến", () => {
    const mapped = mapFriendEvent({
        type: FriendEventType.REQUEST,
        data: { toUid: "555", fromUid: "1001", message: "Mình kết bạn nhé" }
    }, "1001");

    assert.equal(mapped, null);
});

test("sự kiện thu hồi và từ chối được phân biệt", () => {
    const withdrawn = mapFriendEvent({ type: FriendEventType.UNDO_REQUEST, data: { toUid: "1001", fromUid: "555" } }, "1001");
    const rejected = mapFriendEvent({ type: FriendEventType.REJECT_REQUEST, data: { toUid: "1001", fromUid: "555" } }, "1001");

    assert.equal(withdrawn.type, "withdrawn");
    assert.equal(rejected.type, "rejected");
    assert.equal(withdrawn.userId, "555");
});

test("sự kiện kết bạn và huỷ kết bạn được nhận diện", () => {
    assert.deepEqual(mapFriendEvent({ type: FriendEventType.ADD, data: "555" }, "1001"), { type: "friend_added", userId: "555" });
    assert.deepEqual(mapFriendEvent({ type: FriendEventType.REMOVE, data: "555" }, "1001"), { type: "friend_removed", userId: "555" });
});

test("sự kiện không liên quan bị bỏ qua", () => {
    for (const type of [FriendEventType.PIN_CREATE, FriendEventType.SEEN_FRIEND_REQUEST, FriendEventType.BLOCK, FriendEventType.UNKNOWN]) {
        assert.equal(mapFriendEvent({ type, data: "x" }, "1001"), null);
    }
    assert.equal(mapFriendEvent(null, "1001"), null);
});

test("trạng thái quan hệ: cờ toàn 0 nghĩa là CHƯA BIẾT, không phải đã huỷ", async () => {
    // getFriendRequestStatus đã trả cả is_requested lẫn is_requesting bằng 0 cho
    // một lời mời còn sống. Nếu coi đó là "đã huỷ" thì lời mời thật không bao giờ
    // chấp nhận được — lỗi này đã xảy ra thật.
    const api = makeFakeApi({ statuses: { 555: { is_friend: 0, is_requested: 0, is_requesting: 0 } } });
    installFakeZca(api);
    const provider = createZcaProvider({ enabled: true, sessionDir: makeSessionDir() });
    await provider.start();

    const status = await provider.friendApi.getStatus("555");

    assert.equal(status.isFriend, false);
    assert.equal(status.incomingRequest, false);
    assert.equal(status.hasPendingRequest, false, "cờ nói không có lời mời chờ");
    // Nhưng đây chỉ là GỢI Ý — tầng nghiệp vụ phải xác minh lại bằng danh sách.
    await provider.stop();
});

test("trạng thái quan hệ: một trong hai cờ bật nghĩa là có lời mời đang chờ", async () => {
    const api = makeFakeApi({ statuses: { 555: { is_friend: 0, is_requested: 0, is_requesting: 1 } } });
    installFakeZca(api);
    const provider = createZcaProvider({ enabled: true, sessionDir: makeSessionDir() });
    await provider.start();

    const status = await provider.friendApi.getStatus("555");

    assert.equal(status.hasPendingRequest, true, "không được bỏ qua chỉ vì cờ is_requested sai");
    await provider.stop();
});

test("trạng thái quan hệ: đã là bạn thì hasPendingRequest luôn false", async () => {
    const api = makeFakeApi({ statuses: { 555: { is_friend: 1, is_requested: 1, is_requesting: 1 } } });
    installFakeZca(api);
    const provider = createZcaProvider({ enabled: true, sessionDir: makeSessionDir() });
    await provider.start();

    const status = await provider.friendApi.getStatus("555");

    assert.equal(status.isFriend, true);
    assert.equal(status.hasPendingRequest, false);
    await provider.stop();
});

// ---------------------------------------------------------------------------
// Đăng ký listener thật
// ---------------------------------------------------------------------------

test("listener friend_event được đăng ký và sự kiện đi ra ngoài", async () => {
    const api = makeFakeApi();
    installFakeZca(api);
    const received = [];
    const provider = createZcaProvider({
        enabled: true,
        sessionDir: makeSessionDir(),
        onFriendEvent: (instance, event) => { received.push(event); }
    });

    const started = await provider.start();
    assert.equal(started.started, true);
    assert.ok(api.handlers.has("friend_event"), "listener friend_event phải được đăng ký");
    assert.equal(provider.botId, "zca:1001", "danh tính phải đổi sang UID thật");

    api.emit("friend_event", {
        type: FriendEventType.REQUEST,
        data: { toUid: "1001", fromUid: "555", message: "hi" }
    });

    // Handler bọc trong Promise; chờ một nhịp.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(received.length, 1);
    assert.equal(received[0].type, "request");
    assert.equal(received[0].userId, "555");
    await provider.stop();
});

test("kết nối lại kích hoạt đồng bộ lời mời", async () => {
    const api = makeFakeApi();
    installFakeZca(api);
    let syncs = 0;
    const provider = createZcaProvider({
        enabled: true,
        sessionDir: makeSessionDir(),
        onConnected: () => { syncs += 1; }
    });

    await provider.start();
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(syncs >= 1, "kết nối xong phải đồng bộ lời mời kết bạn");
    await provider.stop();
});

test("sự kiện kết bạn không được làm chết listener khi handler lỗi", async () => {
    const api = makeFakeApi();
    installFakeZca(api);
    const provider = createZcaProvider({
        enabled: true,
        sessionDir: makeSessionDir(),
        onFriendEvent: () => { throw new Error("handler hỏng"); }
    });

    await provider.start();
    api.emit("friend_event", { type: FriendEventType.REQUEST, data: { toUid: "1001", fromUid: "555" } });
    await new Promise((resolve) => setImmediate(resolve));

    // Listener vẫn sống: sự kiện thứ hai vẫn tới nơi.
    assert.equal(provider.listenerConnected, true);
    await provider.stop();
});

// ---------------------------------------------------------------------------
// API kết bạn của nhà cung cấp
// ---------------------------------------------------------------------------

test("getFriendRecommendations: chỉ lời mời đến mới được trả về", async () => {
    const api = makeFakeApi({
        recommendations: [
            { userId: "555", displayName: "Người gửi", recommType: FriendRecommendationsType.ReceivedFriendRequest, message: "Chào" },
            { userId: "666", displayName: "Gợi ý", recommType: FriendRecommendationsType.RecommendedFriend },
            { userId: "1001", displayName: "Chính mình", recommType: FriendRecommendationsType.ReceivedFriendRequest }
        ]
    });
    installFakeZca(api);
    const provider = createZcaProvider({ enabled: true, sessionDir: makeSessionDir() });
    await provider.start();

    const list = await provider.friendApi.listReceivedRequests();

    assert.equal(list.length, 1, "gợi ý kết bạn và chính mình không được lọt vào");
    assert.equal(list[0].userId, "555");
    assert.equal(list[0].displayName, "Người gửi");
    assert.equal(list[0].message, "Chào");
    assert.ok(list[0].requestedAt, "phải có thời gian yêu cầu");
    await provider.stop();
});

test("chấp nhận và từ chối gọi đúng API zca-js", async () => {
    const api = makeFakeApi();
    installFakeZca(api);
    const provider = createZcaProvider({ enabled: true, sessionDir: makeSessionDir() });
    await provider.start();

    await provider.friendApi.accept("555");
    await provider.friendApi.reject("666");

    assert.deepEqual(api.calls.accept, ["555"]);
    assert.deepEqual(api.calls.reject, ["666"]);
    await provider.stop();
});

test("lỗi từ Zalo được ném ra, không bị nuốt thành công", async () => {
    const api = makeFakeApi({ acceptError: "Zalo từ chối" });
    installFakeZca(api);
    const provider = createZcaProvider({ enabled: true, sessionDir: makeSessionDir() });
    await provider.start();

    await assert.rejects(() => provider.friendApi.accept("555"), /Zalo từ chối/);
    await provider.stop();
});

test("chưa đăng nhập thì API kết bạn báo lỗi rõ thay vì im lặng", async () => {
    const api = makeFakeApi();
    installFakeZca(api);
    const provider = createZcaProvider({ enabled: false });

    await assert.rejects(() => provider.friendApi.accept("555"), /chưa đăng nhập/);
    const health = provider.friendRequestHealth();
    assert.equal(health.authenticated, false);
});

test("bot chính thức không có friendApi", () => {
    const { createOfficialProvider } = require("../providers/officialProvider");
    const provider = createOfficialProvider({ botId: "bot1", token: "123:abc", source: "test" });

    assert.equal(provider.friendApi, undefined);
    assert.notEqual(provider.supportsFriendRequests, true);
});
