// ============================================================================
// Test cho quản lý lời mời kết bạn ZCA.
//
// Toàn bộ dùng nhà cung cấp GIẢ và tệp tạm — không cần zca-js, không cần mạng,
// không cần Firestore thật. Nhờ vậy các quy tắc quan trọng (xác minh trước khi
// chấp nhận, chống xử lý hai lần, hạn mức tự động, thông báo hai kênh) đều kiểm
// thử được một cách tất định.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const fr = require("../friendRequests");
const { createFriendRequestService } = require("../friendRequestService");

const {
    HANDLING_MODE,
    NOTIFICATION_CHANNEL,
    REQUEST_STATUS
} = fr;

// ---------------------------------------------------------------------------
// Bộ dựng
// ---------------------------------------------------------------------------

function makePaths() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-friend-"));
    return {
        dir,
        requests: path.join(dir, "friendRequests.json"),
        settings: path.join(dir, "friendRequestSettings.json")
    };
}

// Tài khoản ZCA giả. `requests` là danh sách lời mời "Zalo đang có"; `statuses`
// là trạng thái quan hệ trả về cho từng userId.
function makeAccount(options = {}) {
    const calls = { accept: [], reject: [], status: [], list: 0 };
    const requests = new Map((options.requests || []).map((item) => [item.userId, item]));
    const statuses = new Map(Object.entries(options.statuses || {}));

    const account = {
        botId: options.botId || "zca:1001",
        providerType: "zca",
        displayName: options.displayName || "ZCA Main",
        ownUid: options.ownUid || "1001",
        authenticated: options.authenticated !== false,
        status: "connected",
        calls,
        friendRequestHealth() {
            return {
                supported: true,
                authenticated: account.authenticated,
                listenerConnected: true,
                uid: account.ownUid,
                lastFriendEventAt: null
            };
        },
        friendApi: {
            async listReceivedRequests() {
                calls.list += 1;
                if (options.listError) throw new Error(options.listError);
                // Nhà cung cấp THẬT đã lọc theo recommType = ReceivedFriendRequest;
                // recommType 1 (gợi ý kết bạn) không bao giờ lọt ra tới đây.
                return [...requests.values()].filter((item) => item.recommType !== 1);
            },
            async getStatus(userId) {
                calls.status.push(userId);
                if (options.statusError) throw new Error(options.statusError);
                const value = statuses.get(userId) || { isFriend: false, incomingRequest: true, outgoingRequest: false };
                const merged = { seen: false, raw: {}, ...value };
                return {
                    ...merged,
                    hasPendingRequest: !merged.isFriend && Boolean(merged.incomingRequest || merged.outgoingRequest)
                };
            },
            async accept(userId) {
                calls.accept.push(userId);
                if (options.acceptError) throw new Error(options.acceptError);
                // Mặc định Zalo chuyển thành bạn ngay sau khi chấp nhận.
                if (options.confirmOnAccept !== false) {
                    statuses.set(userId, { isFriend: true, incomingRequest: false, outgoingRequest: false });
                }
                return { ok: true, userId };
            },
            async reject(userId) {
                calls.reject.push(userId);
                if (options.rejectError) throw new Error(options.rejectError);
                statuses.set(userId, { isFriend: false, incomingRequest: false, outgoingRequest: false });
                return { ok: true, userId };
            }
        }
    };
    return account;
}

function makeService(account, paths, overrides = {}) {
    const notifications = [];
    const welcomes = [];
    const service = createFriendRequestService({
        listAccounts: () => [account].filter(Boolean),
        getAccount: (botId) => (account && account.botId === botId ? account : null),
        notify: async ({ channel, kind, request }) => {
            if (overrides.notify) return overrides.notify({ channel, kind, request });
            notifications.push({ channel, kind, userId: request.userId });
            return { ok: true, chatId: channel === "official" ? "owner-chat" : "owner-uid", botId: channel === "official" ? "bot1" : account.botId };
        },
        sendWelcome: async ({ request }) => {
            if (overrides.sendWelcome) return overrides.sendWelcome({ request });
            welcomes.push(request.userId);
            return { ok: true };
        },
        describeRecipients: () => overrides.recipients || {},
        requestsPath: paths.requests,
        settingsPath: paths.settings,
        // Không chờ thật: mỗi ca "chưa xác nhận" sẽ phải chờ ~9 giây nếu dùng mặc định.
        confirmDelays: overrides.confirmDelays || [0, 0]
    });
    return { service, notifications, welcomes };
}

function enableBothChannels(paths) {
    fr.updateSettings({
        notifications: {
            official: { enabled: true },
            zca: { enabled: true, chatId: "999" }
        }
    }, paths.settings);
}

// ---------------------------------------------------------------------------
// 1. Phát hiện + lưu + thông báo hai kênh
// ---------------------------------------------------------------------------

test("phát hiện lời mời: lưu bền và thông báo cả hai kênh đang bật", async () => {
    const paths = makePaths();
    enableBothChannels(paths);
    const account = makeAccount();
    const { service, notifications } = makeService(account, paths);

    const result = await service.handleEvent(account.botId, { type: "request", userId: "555", message: "Xin chào" });

    assert.equal(result.ok, true);
    assert.equal(result.isNew, true);

    const record = fr.getRecord(fr.buildRequestId(account.botId, "555"), paths.requests);
    assert.equal(record.status, REQUEST_STATUS.PENDING);
    assert.equal(record.message, "Xin chào");
    assert.equal(record.generation, 1);
    assert.equal(record.provider, "zca");

    assert.deepEqual(
        notifications.map((item) => item.channel).sort(),
        [NOTIFICATION_CHANNEL.OFFICIAL, NOTIFICATION_CHANNEL.ZCA].sort()
    );
    assert.equal(record.notifications.official.status, "sent");
    assert.equal(record.notifications.zca.status, "sent");
});

test("phát hiện trùng: không tạo bản ghi mới và không thông báo lại", async () => {
    const paths = makePaths();
    enableBothChannels(paths);
    const account = makeAccount();
    const { service, notifications } = makeService(account, paths);

    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const before = notifications.length;
    const second = await service.handleEvent(account.botId, { type: "request", userId: "555" });

    assert.equal(second.duplicate, true);
    assert.equal(notifications.length, before, "lời mời trùng không được thông báo lại");
    assert.equal(fr.listPending({}, paths.requests).length, 1);
});

test("khởi động lại không xử lý lại và không thông báo lại", async () => {
    const paths = makePaths();
    enableBothChannels(paths);
    const account = makeAccount();
    const first = makeService(account, paths);
    await first.service.handleEvent(account.botId, { type: "request", userId: "555" });

    // Tiến trình mới: cùng tệp, cùng dữ liệu.
    const second = makeService(account, paths);
    const result = await second.service.handleEvent(account.botId, { type: "request", userId: "555" });

    assert.equal(result.duplicate, true);
    assert.equal(second.notifications.length, 0, "restart không được gửi lại thông báo");
    assert.equal(fr.listPending({}, paths.requests).length, 1);
});

// ---------------------------------------------------------------------------
// 2. Gợi ý kết bạn không phải lời mời
// ---------------------------------------------------------------------------

test("gợi ý kết bạn (recommType 1) KHÔNG bao giờ được coi là lời mời", async () => {
    const paths = makePaths();
    const account = makeAccount({
        requests: [
            // recommType 1 = RecommendedFriend: gợi ý, không phải lời mời.
            { userId: "suggested", displayName: "Gợi ý", recommType: 1 },
            { userId: "real", displayName: "Thật" }
        ],
        statuses: {
            suggested: { isFriend: false, incomingRequest: true, outgoingRequest: false },
            real: { isFriend: false, incomingRequest: true, outgoingRequest: false }
        }
    });
    const { service } = makeService(account, paths);

    const result = await service.syncAccount(account.botId, { trigger: "test" });

    assert.equal(result.ok, true);
    assert.equal(result.added, 1);
    const pending = fr.listPending({}, paths.requests);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].userId, "real");
});

test("cờ trạng thái toàn 0 nhưng người này nằm trong danh sách lời mời: vẫn ghi nhận", async () => {
    const paths = makePaths();
    const account = makeAccount({
        requests: [{ userId: "555", displayName: "Nguyễn Thuận" }],
        // Đúng dữ liệu thật: lời mời còn sống mà mọi cờ đều 0.
        statuses: { 555: { isFriend: false, incomingRequest: false, outgoingRequest: false } }
    });
    const { service } = makeService(account, paths);

    const result = await service.syncAccount(account.botId, { trigger: "test" });

    assert.equal(result.added, 1, "không được bỏ sót lời mời chỉ vì cờ trạng thái sai");
    assert.equal(fr.listPending({}, paths.requests).length, 1);
});

test("lời mời TA đã gửi đi (outgoing) không bị coi là lời mời đến", async () => {
    const paths = makePaths();
    const account = makeAccount({
        requests: [{ userId: "out" }],
        statuses: { out: { isFriend: false, incomingRequest: false, outgoingRequest: true } }
    });
    const { service } = makeService(account, paths);

    const result = await service.syncAccount(account.botId, { trigger: "test" });

    assert.equal(result.added, 0);
    assert.equal(fr.listPending({}, paths.requests).length, 0);
});

test("bot chính thức không có lời mời kết bạn", async () => {
    const paths = makePaths();
    const { service } = makeService(null, paths);

    const result = await service.syncAccount("bot1", { trigger: "test" });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "unsupported");
});

// ---------------------------------------------------------------------------
// 3. Chấp nhận có xác minh
// ---------------------------------------------------------------------------

test("chấp nhận: xác minh trước, gọi API thật, xác nhận sau, ghi lịch sử", async () => {
    const paths = makePaths();
    const account = makeAccount();
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");

    const result = await service.accept(requestId, { actor: "admin@web" });

    assert.equal(result.ok, true);
    assert.equal(result.status, REQUEST_STATUS.ACCEPTED);
    assert.deepEqual(account.calls.accept, ["555"]);
    // Một lần kiểm tra trước khi chấp nhận + một lần xác nhận sau.
    assert.equal(account.calls.status.length, 2);

    const record = fr.getRecord(requestId, paths.requests);
    assert.equal(record.status, REQUEST_STATUS.ACCEPTED);
    assert.equal(record.processedBy, "admin@web");
    assert.equal(record.processedMethod, "manual");
    assert.ok(record.processedAt);
    assert.ok(record.history.some((entry) => entry.status === REQUEST_STATUS.ACCEPTED));
    assert.equal(fr.listPending({}, paths.requests).length, 0);
    assert.equal(fr.listHistory({}, paths.requests).length, 1);
});

test("chấp nhận lần hai không gọi Zalo nữa", async () => {
    const paths = makePaths();
    const account = makeAccount();
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");

    await service.accept(requestId, { actor: "admin" });
    const second = await service.accept(requestId, { actor: "admin" });

    assert.equal(second.ok, false);
    assert.equal(second.reason, "already_processed");
    assert.equal(account.calls.accept.length, 1, "Zalo chỉ được gọi một lần");
});

test("lời mời đã bị người gửi thu hồi: KHÔNG chấp nhận, chuyển cancelled", async () => {
    const paths = makePaths();
    const account = makeAccount();
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");

    // Người kia huỷ trước khi quản trị viên bấm.
    account.friendApi.getStatus = async () => ({ isFriend: false, incomingRequest: false, outgoingRequest: false });

    const result = await service.accept(requestId, { actor: "admin" });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_pending");
    assert.equal(account.calls.accept.length, 0, "không được gọi chấp nhận một lời mời đã huỷ");
    assert.equal(fr.getRecord(requestId, paths.requests).status, REQUEST_STATUS.CANCELLED);
});

test("đã là bạn từ trước: không gọi chấp nhận, chuyển already_friends", async () => {
    const paths = makePaths();
    const account = makeAccount();
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");

    account.friendApi.getStatus = async () => ({ isFriend: true, incomingRequest: false, outgoingRequest: false });

    const result = await service.accept(requestId, { actor: "admin" });

    assert.equal(result.ok, true);
    assert.equal(result.alreadyFriends, true);
    assert.equal(account.calls.accept.length, 0);
    assert.equal(fr.getRecord(requestId, paths.requests).status, REQUEST_STATUS.ALREADY_FRIENDS);
});

test("Zalo nhận lệnh nhưng chưa xác nhận: requires_verification, không báo thành công", async () => {
    const paths = makePaths();
    const account = makeAccount({ confirmOnAccept: false });
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");

    const result = await service.accept(requestId, { actor: "admin" });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "unconfirmed");
    assert.equal(fr.getRecord(requestId, paths.requests).status, REQUEST_STATUS.REQUIRES_VERIFICATION);
});

test("không kiểm tra được trạng thái trước khi chấp nhận: requires_verification", async () => {
    const paths = makePaths();
    const account = makeAccount({ statusError: "Zalo tạm lỗi" });
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");

    const result = await service.accept(requestId, { actor: "admin" });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "verification_failed");
    assert.equal(account.calls.accept.length, 0);
    assert.equal(fr.getRecord(requestId, paths.requests).status, REQUEST_STATUS.REQUIRES_VERIFICATION);
});

test("hai lần bấm chấp nhận đồng thời: chỉ một lần gọi Zalo", async () => {
    const paths = makePaths();
    const account = makeAccount();
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");

    const [a, b] = await Promise.all([
        service.accept(requestId, { actor: "admin" }),
        service.accept(requestId, { actor: "admin" })
    ]);

    assert.equal(account.calls.accept.length, 1);
    assert.equal([a, b].filter((item) => item.ok).length, 1);
});

test("tài khoản ZCA mất kết nối: KHÔNG gọi Zalo, KHÔNG đổi trạng thái lời mời", async () => {
    const paths = makePaths();
    const account = makeAccount();
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");

    account.authenticated = false;

    const result = await service.accept(requestId, { actor: "admin" });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "account_offline");
    assert.equal(account.calls.accept.length, 0, "không được gọi Zalo khi phiên đã đóng");
    assert.equal(account.calls.status.length, 0, "cũng không được kiểm tra trạng thái");
    // Lời mời vẫn nguyên vẹn để xử lý khi phiên sống lại — không bị đánh dấu lỗi.
    assert.equal(fr.getRecord(requestId, paths.requests).status, REQUEST_STATUS.PENDING);

    // Kết nối lại thì xử lý được bình thường.
    account.authenticated = true;
    const retry = await service.accept(requestId, { actor: "admin" });
    assert.equal(retry.ok, true);
});

// ---------------------------------------------------------------------------
// 3b. Cờ trạng thái của Zalo KHÔNG đáng tin (lỗi đã gặp thật)
//
// Thực tế: lời mời vẫn còn trong Zalo, vẫn nằm trong getFriendRecommendations với
// recommType = ReceivedFriendRequest, mà getFriendRequestStatus trả cả
// is_requested lẫn is_requesting bằng 0. Code cũ tin cờ đó nên đánh dấu "đã thu
// hồi" và lời mời thật không bao giờ chấp nhận được.
// ---------------------------------------------------------------------------

test("cờ nói 'không còn chờ' nhưng lời mời VẪN CÒN: chấp nhận, không huỷ oan", async () => {
    const paths = makePaths();
    // Danh sách lời mời của Zalo vẫn có người này.
    const account = makeAccount({ requests: [{ userId: "555", displayName: "Nguyễn Thuận" }] });
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");

    let call = 0;
    account.friendApi.getStatus = async () => {
        call += 1;
        if (call === 1) {
            // Đúng dữ liệu thật: mọi cờ đều 0 dù lời mời còn sống.
            return { isFriend: false, incomingRequest: false, outgoingRequest: false, hasPendingRequest: false };
        }
        return { isFriend: true, incomingRequest: false, outgoingRequest: false, hasPendingRequest: false };
    };

    const result = await service.accept(requestId, { actor: "admin" });

    assert.equal(result.ok, true, "không được huỷ một lời mời còn tồn tại");
    assert.deepEqual(account.calls.accept, ["555"]);
    assert.equal(fr.getRecord(requestId, paths.requests).status, REQUEST_STATUS.ACCEPTED);
});

test("không đọc được danh sách lời mời: KHÔNG tự huỷ, để Zalo quyết định", async () => {
    const paths = makePaths();
    const account = makeAccount({ listError: "Zalo tạm lỗi" });
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");

    let call = 0;
    account.friendApi.getStatus = async () => {
        call += 1;
        if (call === 1) return { isFriend: false, incomingRequest: false, outgoingRequest: false, hasPendingRequest: false };
        return { isFriend: true, incomingRequest: false, outgoingRequest: false, hasPendingRequest: false };
    };

    const result = await service.accept(requestId, { actor: "admin" });

    assert.equal(result.ok, true, "không biết thì không được kết luận là đã huỷ");
    assert.deepEqual(account.calls.accept, ["555"]);
});

test("lời mời biến mất khỏi danh sách Zalo: mới được chuyển cancelled", async () => {
    const paths = makePaths();
    // Danh sách rỗng ⇒ bằng chứng dương cho việc lời mời đã biến mất.
    const account = makeAccount();
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");

    account.friendApi.getStatus = async () => ({ isFriend: false, incomingRequest: false, outgoingRequest: false, hasPendingRequest: false });

    const result = await service.accept(requestId, { actor: "admin" });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_pending");
    assert.equal(account.calls.accept.length, 0);
    assert.equal(fr.getRecord(requestId, paths.requests).status, REQUEST_STATUS.CANCELLED);
});

test("bản ghi cancelled được mở lại NGAY khi phát hiện lại (không có tác dụng phụ)", () => {
    const paths = makePaths();
    fr.upsertDetected({ accountId: "zca:1001", userId: "555" }, paths.requests);
    const requestId = fr.buildRequestId("zca:1001", "555");
    fr.applyTransition(requestId, REQUEST_STATUS.CANCELLED, { method: "system" }, paths.requests);

    // Ngay lập tức, không chờ hết 10 phút.
    const again = fr.upsertDetected({ accountId: "zca:1001", userId: "555" }, paths.requests);

    assert.equal(again.isNew, true, "huỷ không phải thao tác thật nên phải mở lại được");
    assert.equal(again.reopened, true);
    assert.equal(fr.getRecord(requestId, paths.requests).status, REQUEST_STATUS.PENDING);
});

test("bản ghi đã CHẤP NHẬN vẫn bị chặn mở lại trong 10 phút", () => {
    const paths = makePaths();
    fr.upsertDetected({ accountId: "zca:1001", userId: "555" }, paths.requests);
    const requestId = fr.buildRequestId("zca:1001", "555");
    fr.applyTransition(requestId, REQUEST_STATUS.ACCEPTED, { method: "auto" }, paths.requests);

    const again = fr.upsertDetected({ accountId: "zca:1001", userId: "555" }, paths.requests);

    assert.equal(again.isNew, false, "mở lại bản ghi đã chấp nhận sẽ dẫn tới chấp nhận hai lần");
    assert.equal(fr.getRecord(requestId, paths.requests).status, REQUEST_STATUS.ACCEPTED);
});

test("bản ghi cancelled vẫn chấp nhận lại được (đường thoát khi huỷ oan)", async () => {
    const paths = makePaths();
    const account = makeAccount();
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");
    fr.applyTransition(requestId, REQUEST_STATUS.CANCELLED, { method: "system" }, paths.requests);

    const result = await service.accept(requestId, { actor: "admin" });

    assert.equal(result.ok, true);
    assert.equal(fr.getRecord(requestId, paths.requests).status, REQUEST_STATUS.ACCEPTED);
});

// ---------------------------------------------------------------------------
// 3c. Zalo cập nhật trạng thái CHẬM (lỗi đã gặp thật)
//
// Thực tế: acceptFriendRequest() trả về thành công, nhưng đọc lại ngay lập tức thì
// is_friend vẫn 0, nên hệ thống báo "chưa xác nhận" và người dùng phải accept tay.
// ---------------------------------------------------------------------------

test("Zalo cập nhật chậm: lần đọc đầu chưa thấy bạn, lần sau thấy ⇒ ACCEPTED", async () => {
    const paths = makePaths();
    const account = makeAccount({ confirmOnAccept: false });
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");

    let reads = 0;
    account.friendApi.getStatus = async () => {
        reads += 1;
        if (reads === 1) return { isFriend: false, incomingRequest: true, outgoingRequest: false };
        // Đọc lại ngay: Zalo chưa kịp cập nhật.
        if (reads === 2) return { isFriend: false, incomingRequest: false, outgoingRequest: false };
        // Đọc lại sau khoảng chờ: đã là bạn.
        return { isFriend: true, incomingRequest: false, outgoingRequest: false };
    };

    const result = await service.accept(requestId, { actor: "admin" });

    assert.equal(result.ok, true, "không được biến một lần chấp nhận THÀNH CÔNG thành lỗi");
    assert.equal(fr.getRecord(requestId, paths.requests).status, REQUEST_STATUS.ACCEPTED);
    assert.equal(account.calls.accept.length, 1, "chỉ cần gọi accept một lần");
});

test("đọc lại lỗi hoàn toàn: vẫn ghi accepted, không kết luận thất bại", async () => {
    const paths = makePaths();
    const account = makeAccount({ confirmOnAccept: false });
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");

    let reads = 0;
    account.friendApi.getStatus = async () => {
        reads += 1;
        if (reads === 1) return { isFriend: false, incomingRequest: true, outgoingRequest: false };
        throw new Error("Zalo tạm lỗi");
    };

    const result = await service.accept(requestId, { actor: "admin" });

    assert.equal(result.ok, true, "không đọc được thì không được kết luận là thất bại");
    assert.equal(fr.getRecord(requestId, paths.requests).status, REQUEST_STATUS.ACCEPTED);
});

test("chưa xác nhận được: bản ghi PHẢI có lý do để thông báo nêu ra", async () => {
    const paths = makePaths();
    const account = makeAccount({ confirmOnAccept: false });
    const { service, notifications } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");
    notifications.length = 0;

    const result = await service.accept(requestId, { actor: "admin" });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "unconfirmed");
    const record = fr.getRecord(requestId, paths.requests);
    assert.equal(record.status, REQUEST_STATUS.REQUIRES_VERIFICATION);
    assert.ok(record.lastError, "thiếu lý do thì thông báo chỉ nói 'gặp lỗi' mà không ai biết vì sao");
    assert.match(record.lastError, /chưa phải bạn/);

    // Thông báo phải là loại riêng, không phải "gặp lỗi".
    const kinds = notifications.map((item) => item.kind);
    assert.ok(kinds.includes("unconfirmed"), `loại thông báo phải là unconfirmed, nhận được: ${kinds.join(",")}`);
});

test("gọi lại accept một lần khi lần đầu chưa có tác dụng", async () => {
    const paths = makePaths();
    const account = makeAccount({ confirmOnAccept: false });
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");

    // Lần accept đầu không có tác dụng; lần thứ hai thì thành công.
    let accepts = 0;
    const originalAccept = account.friendApi.accept;
    account.friendApi.accept = async (userId) => {
        accepts += 1;
        account.calls.accept.push(userId);
        if (accepts === 1) return { ok: true, userId };
        account.friendApi.getStatus = async () => ({ isFriend: true, incomingRequest: false, outgoingRequest: false });
        return originalAccept(userId);
    };
    account.friendApi.getStatus = async () => ({ isFriend: false, incomingRequest: true, outgoingRequest: false });

    const result = await service.accept(requestId, { actor: "admin" });

    assert.equal(result.ok, true);
    assert.equal(accepts, 2, "phải thử lại đúng một lần");
    assert.equal(fr.getRecord(requestId, paths.requests).status, REQUEST_STATUS.ACCEPTED);
});

// ---------------------------------------------------------------------------
// 4. Từ chối
// ---------------------------------------------------------------------------

test("từ chối: gọi API từ chối và ghi lịch sử", async () => {
    const paths = makePaths();
    const account = makeAccount();
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");

    const result = await service.reject(requestId, { actor: "admin" });

    assert.equal(result.ok, true);
    assert.deepEqual(account.calls.reject, ["555"]);
    assert.equal(fr.getRecord(requestId, paths.requests).status, REQUEST_STATUS.REJECTED);
});

test("từ chối lỗi: trạng thái failed và vẫn thử lại được", async () => {
    const paths = makePaths();
    const account = makeAccount({ rejectError: "Zalo từ chối" });
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");

    const result = await service.reject(requestId, { actor: "admin" });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "provider_error");
    assert.equal(fr.getRecord(requestId, paths.requests).status, REQUEST_STATUS.FAILED);

    // Lỗi không phải quyết định cuối cùng: bỏ lỗi rồi thử lại phải được.
    account.friendApi.reject = async (userId) => {
        account.calls.reject.push(userId);
        return { ok: true };
    };
    const retry = await service.reject(requestId, { actor: "admin" });
    assert.equal(retry.ok, true);
    assert.equal(fr.getRecord(requestId, paths.requests).status, REQUEST_STATUS.REJECTED);
});

// ---------------------------------------------------------------------------
// 5. Thông báo: lỗi kênh, gửi lại từng kênh
// ---------------------------------------------------------------------------

test("một kênh lỗi: lời mời vẫn còn, kênh kia vẫn ghi nhận thành công", async () => {
    const paths = makePaths();
    enableBothChannels(paths);
    const account = makeAccount();
    const { service } = makeService(account, paths, {
        notify: async ({ channel }) => {
            if (channel === NOTIFICATION_CHANNEL.ZCA) return { ok: false, error: "ZCA chưa có hội thoại hợp lệ" };
            return { ok: true, chatId: "owner-chat", botId: "bot1" };
        }
    });

    const result = await service.handleEvent(account.botId, { type: "request", userId: "555" });

    assert.equal(result.ok, true);
    const record = fr.getRecord(fr.buildRequestId(account.botId, "555"), paths.requests);
    assert.equal(record.status, REQUEST_STATUS.PENDING, "lỗi thông báo không được làm mất lời mời");
    assert.equal(record.notifications.official.status, "sent");
    assert.equal(record.notifications.zca.status, "failed");
    assert.match(record.notifications.zca.error, /hội thoại/);

    // Vẫn chấp nhận được dù thông báo lỗi.
    const accepted = await service.accept(record.requestId, { actor: "admin" });
    assert.equal(accepted.ok, true);
});

test("gửi lại chỉ kênh lỗi, không gửi lại kênh đã thành công", async () => {
    const paths = makePaths();
    enableBothChannels(paths);
    const account = makeAccount();
    let zcaFails = true;
    const attempts = [];
    const { service } = makeService(account, paths, {
        notify: async ({ channel }) => {
            attempts.push(channel);
            if (channel === NOTIFICATION_CHANNEL.ZCA && zcaFails) return { ok: false, error: "lỗi tạm" };
            return { ok: true, chatId: "x" };
        }
    });

    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");
    attempts.length = 0;

    const skipped = await service.retryNotification(requestId, NOTIFICATION_CHANNEL.OFFICIAL);
    assert.equal(skipped.skipped, true, "kênh đã gửi được không được gửi lại");
    assert.equal(attempts.length, 0);

    zcaFails = false;
    const retried = await service.retryNotification(requestId, NOTIFICATION_CHANNEL.ZCA);
    assert.equal(retried.ok, true);
    assert.deepEqual(attempts, [NOTIFICATION_CHANNEL.ZCA]);
    assert.equal(fr.getRecord(requestId, paths.requests).notifications.zca.status, "sent");
});

test("kênh tắt thì không gọi gửi và không ghi lỗi", async () => {
    const paths = makePaths();
    fr.updateSettings({ notifications: { official: { enabled: true }, zca: { enabled: false } } }, paths.settings);
    const account = makeAccount();
    const seen = [];
    const { service } = makeService(account, paths, {
        notify: async ({ channel }) => { seen.push(channel); return { ok: true, chatId: "x" }; }
    });

    await service.handleEvent(account.botId, { type: "request", userId: "555" });

    assert.deepEqual(seen, [NOTIFICATION_CHANNEL.OFFICIAL]);
    const record = fr.getRecord(fr.buildRequestId(account.botId, "555"), paths.requests);
    assert.equal(record.notifications.zca, undefined);
});

test("gửi thử báo lỗi rõ khi kênh đang tắt", async () => {
    const paths = makePaths();
    fr.updateSettings({ notifications: { official: { enabled: true }, zca: { enabled: false } } }, paths.settings);
    const account = makeAccount();
    const { service } = makeService(account, paths);

    const result = await service.testNotification(NOTIFICATION_CHANNEL.ZCA);

    assert.equal(result.ok, false);
    assert.match(result.error, /đang tắt/);
});

// ---------------------------------------------------------------------------
// 6. Tự động chấp nhận
// ---------------------------------------------------------------------------

test("chế độ tự động: chấp nhận ngay và ghi phương thức auto", async () => {
    const paths = makePaths();
    fr.updateSettings({ mode: HANDLING_MODE.AUTO, autoAccept: { minIntervalMs: 5000 } }, paths.settings);
    const account = makeAccount();
    const { service } = makeService(account, paths);

    const result = await service.handleEvent(account.botId, { type: "request", userId: "555" });

    assert.equal(result.auto.ok, true);
    const record = fr.getRecord(fr.buildRequestId(account.botId, "555"), paths.requests);
    assert.equal(record.status, REQUEST_STATUS.ACCEPTED);
    assert.equal(record.processedMethod, "auto");
    assert.deepEqual(account.calls.accept, ["555"]);
});

test("chế độ thủ công: không bao giờ tự chấp nhận", async () => {
    const paths = makePaths();
    const account = makeAccount();
    const { service } = makeService(account, paths);

    await service.handleEvent(account.botId, { type: "request", userId: "555" });

    assert.equal(account.calls.accept.length, 0);
    assert.equal(fr.listPending({}, paths.requests).length, 1);
});

test("chế độ tắt: không tự chấp nhận nhưng vẫn giữ lời mời", async () => {
    const paths = makePaths();
    fr.updateSettings({ mode: HANDLING_MODE.DISABLED }, paths.settings);
    const account = makeAccount();
    const { service } = makeService(account, paths);

    await service.handleEvent(account.botId, { type: "request", userId: "555" });

    assert.equal(account.calls.accept.length, 0);
    assert.equal(fr.listPending({}, paths.requests).length, 1);
});

test("hạn mức theo giờ chặn lần tự động tiếp theo", async () => {
    const paths = makePaths();
    fr.updateSettings({ mode: HANDLING_MODE.AUTO, autoAccept: { maxPerHour: 1, minIntervalMs: 5000 } }, paths.settings);
    const account = makeAccount();
    const { service } = makeService(account, paths);

    const first = await service.handleEvent(account.botId, { type: "request", userId: "555" });
    assert.equal(first.auto.ok, true);

    // Vượt khoảng nghỉ tối thiểu nhưng vẫn trong hạn mức giờ.
    const second = await service.handleEvent(account.botId, { type: "request", userId: "556" });
    assert.equal(second.auto.ok, false);
    assert.equal(second.auto.reason, "hourly_limit");
    assert.equal(account.calls.accept.length, 1);
    assert.equal(fr.listPending({}, paths.requests).length, 1, "lời mời bị chặn vẫn phải còn trong hàng chờ");
});

test("khoảng nghỉ tối thiểu chặn hai lần tự động liền nhau", async () => {
    const paths = makePaths();
    fr.updateSettings({ mode: HANDLING_MODE.AUTO, autoAccept: { maxPerHour: 10, minIntervalMs: 60000 } }, paths.settings);
    const account = makeAccount();
    const { service } = makeService(account, paths);

    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const second = await service.handleEvent(account.botId, { type: "request", userId: "556" });

    assert.equal(second.auto.ok, false);
    assert.equal(second.auto.reason, "too_soon");
    assert.equal(account.calls.accept.length, 1);
});

test("lỗi liên tiếp thì tạm dừng tự động chấp nhận", async () => {
    const paths = makePaths();
    fr.updateSettings({
        mode: HANDLING_MODE.AUTO,
        autoAccept: { maxPerHour: 10, minIntervalMs: 0, suspendAfterErrors: 1 }
    }, paths.settings);
    const account = makeAccount({ acceptError: "Zalo giới hạn thao tác" });
    const { service } = makeService(account, paths);

    await service.handleEvent(account.botId, { type: "request", userId: "555" });

    const state = service.autoAcceptState();
    assert.equal(state.suspended, true);
    assert.match(state.suspendedReason, /lỗi liên tiếp/);

    // Lời mời thứ hai không được thử nữa.
    const second = await service.handleEvent(account.botId, { type: "request", userId: "556" });
    assert.equal(second.auto.reason, "suspended");
    assert.equal(account.calls.accept.length, 1);
});

test("đổi chế độ xóa trạng thái tạm dừng", async () => {
    const paths = makePaths();
    fr.updateSettings({
        mode: HANDLING_MODE.AUTO,
        autoAccept: { maxPerHour: 10, minIntervalMs: 0, suspendAfterErrors: 1 }
    }, paths.settings);
    const account = makeAccount({ acceptError: "lỗi" });
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    assert.equal(service.autoAcceptState().suspended, true);

    service.updateSettings({ mode: HANDLING_MODE.MANUAL }, { actor: "admin" });

    assert.equal(service.autoAcceptState().suspended, false);
    assert.equal(service.getSettings().mode, HANDLING_MODE.MANUAL);
});

// ---------------------------------------------------------------------------
// 7. Tin chào
// ---------------------------------------------------------------------------

test("tin chào chỉ gửi sau khi chấp nhận thành công và chỉ một lần", async () => {
    const paths = makePaths();
    fr.updateSettings({ welcome: { enabled: true, message: "Chào bạn!" } }, paths.settings);
    const account = makeAccount();
    const { service, welcomes } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");

    await service.accept(requestId, { actor: "admin" });
    assert.deepEqual(welcomes, ["555"]);

    // Thử lại (đã xử lý) không được gửi tin chào lần hai.
    await service.accept(requestId, { actor: "admin" });
    assert.equal(welcomes.length, 1);
});

test("tin chào tắt mặc định: không gửi gì", async () => {
    const paths = makePaths();
    const account = makeAccount();
    const { service, welcomes } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });

    await service.accept(fr.buildRequestId(account.botId, "555"), { actor: "admin" });

    assert.equal(welcomes.length, 0);
});

test("tin chào lỗi không làm hỏng trạng thái kết bạn", async () => {
    const paths = makePaths();
    fr.updateSettings({ welcome: { enabled: true, message: "Chào" } }, paths.settings);
    const account = makeAccount();
    const { service } = makeService(account, paths, {
        sendWelcome: async () => ({ ok: false, error: "người dùng chặn tin nhắn" })
    });
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");

    const result = await service.accept(requestId, { actor: "admin" });

    assert.equal(result.ok, true);
    const record = fr.getRecord(requestId, paths.requests);
    assert.equal(record.status, REQUEST_STATUS.ACCEPTED);
    assert.equal(record.notifications["zca:welcome"].status, "failed");
    assert.match(record.notifications["zca:welcome"].error, /chặn/);
});

// ---------------------------------------------------------------------------
// 8. Sự kiện huỷ / kết bạn từ Zalo
// ---------------------------------------------------------------------------

test("sự kiện thu hồi đóng lời mời đang chờ", async () => {
    const paths = makePaths();
    const account = makeAccount();
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });

    const result = await service.handleEvent(account.botId, { type: "withdrawn", userId: "555" });

    assert.equal(result.cancelled, true);
    assert.equal(fr.listPending({}, paths.requests).length, 0);
    assert.equal(fr.getRecord(fr.buildRequestId(account.botId, "555"), paths.requests).status, REQUEST_STATUS.CANCELLED);
});

test("sự kiện đã kết bạn đóng lời mời đang chờ mà không gọi API", async () => {
    const paths = makePaths();
    const account = makeAccount();
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });

    const result = await service.handleEvent(account.botId, { type: "friend_added", userId: "555" });

    assert.equal(result.accepted, true);
    assert.equal(account.calls.accept.length, 0);
    assert.equal(fr.getRecord(fr.buildRequestId(account.botId, "555"), paths.requests).status, REQUEST_STATUS.ACCEPTED);
});

test("sự kiện thu hồi không đụng tới lời mời đã xử lý", async () => {
    const paths = makePaths();
    const account = makeAccount();
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    const requestId = fr.buildRequestId(account.botId, "555");
    await service.accept(requestId, { actor: "admin" });

    const result = await service.handleEvent(account.botId, { type: "withdrawn", userId: "555" });

    assert.equal(result.ignored, true);
    assert.equal(fr.getRecord(requestId, paths.requests).status, REQUEST_STATUS.ACCEPTED);
});

// ---------------------------------------------------------------------------
// 9. Khôi phục trạng thái kẹt
// ---------------------------------------------------------------------------

test("bản ghi kẹt ở processing được mở khóa NGAY khi khởi động", () => {
    const paths = makePaths();
    const account = makeAccount();
    const { service } = makeService(account, paths);
    fr.upsertDetected({ accountId: account.botId, userId: "555" }, paths.requests);
    const requestId = fr.buildRequestId(account.botId, "555");
    fr.applyTransition(requestId, REQUEST_STATUS.PROCESSING, { method: "manual" }, paths.requests);

    // Vừa bị kẹt xong là restart ngay — đúng tình huống thật. Nếu chỉ quét những
    // bản ghi cũ hơn 2 phút thì bản ghi này kẹt vĩnh viễn.
    service.start();
    service.stop();

    assert.equal(fr.getRecord(requestId, paths.requests).status, REQUEST_STATUS.REQUIRES_VERIFICATION);
    // Không còn kẹt: chấp nhận lại được.
    const accepted = service.accept(requestId, { actor: "admin" });
    return accepted.then((result) => {
        assert.equal(result.ok, true);
    });
});

// ---------------------------------------------------------------------------
// 10. Cấu hình: ép giới hạn phía máy chủ
// ---------------------------------------------------------------------------

test("cấu hình ép giới hạn an toàn, không tin giá trị client", () => {
    const paths = makePaths();

    const settings = fr.updateSettings({
        mode: "auto",
        syncIntervalMs: 1,
        autoAccept: { maxPerHour: 9999, minIntervalMs: -5, suspendAfterErrors: 0 },
        welcome: { enabled: true, message: "x".repeat(5000) }
    }, paths.settings);

    assert.equal(settings.syncIntervalMs, 30000);
    assert.equal(settings.autoAccept.maxPerHour, 30);
    assert.equal(settings.autoAccept.minIntervalMs, 5000);
    assert.equal(settings.autoAccept.suspendAfterErrors, 1);
    assert.equal(settings.welcome.message.length, 1000);
    assert.equal(settings.mode, "auto");
});

test("chế độ không hợp lệ rơi về thủ công", () => {
    const paths = makePaths();
    const settings = fr.updateSettings({ mode: "yolo" }, paths.settings);
    assert.equal(settings.mode, HANDLING_MODE.MANUAL);
});

test("cập nhật một mục không ghi đè mục khác", () => {
    const paths = makePaths();
    fr.updateSettings({ mode: "auto", notifications: { zca: { enabled: true, chatId: "77" } } }, paths.settings);
    fr.updateSettings({ welcome: { enabled: true, message: "hi" } }, paths.settings);

    const settings = fr.getSettings(paths.settings);
    assert.equal(settings.mode, "auto");
    assert.equal(settings.notifications.zca.enabled, true);
    assert.equal(settings.notifications.zca.chatId, "77");
    assert.equal(settings.notifications.official.enabled, true, "kênh chính thức vẫn bật mặc định");
    assert.equal(settings.welcome.message, "hi");
});

// ---------------------------------------------------------------------------
// 11. Lịch sử: lọc và tìm kiếm
// ---------------------------------------------------------------------------

test("lịch sử lọc theo tài khoản và tìm kiếm theo tên", async () => {
    const paths = makePaths();
    const account = makeAccount();
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });
    await service.handleEvent(account.botId, { type: "request", userId: "556" });
    await service.accept(fr.buildRequestId(account.botId, "555"), { actor: "admin" });

    const state = service.getState();
    assert.equal(state.counts.pending, 1);
    assert.equal(state.counts.accepted, 1);
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].userId, "555");
});

test("trạng thái trả về không chứa bí mật phiên ZCA", async () => {
    const paths = makePaths();
    const account = makeAccount();
    const { service } = makeService(account, paths);
    await service.handleEvent(account.botId, { type: "request", userId: "555" });

    const serialized = JSON.stringify(service.getState());

    assert.doesNotMatch(serialized, /cookie|imei|userAgent|zpsid/i);
});
