const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTargetUserOptions, findTargetUser, resolveBatchTargets, resolveTargetUserId, resolveTargetChat } = require("../targetUsers");

function user(overrides = {}) {
    return {
        userId: "u1",
        displayName: "Nguyễn Văn A",
        status: "active",
        studentIds: [],
        chats: [],
        ...overrides
    };
}

function chat(overrides = {}) {
    return { chatId: "c1", chatType: "private", chatName: "", status: "active", memberStatus: "active", ...overrides };
}

test("danh sách khử trùng theo User ID và luôn dùng User ID làm khóa", () => {
    const options = buildTargetUserOptions({
        users: [
            user({ userId: "1001", displayName: "An" }),
            user({ userId: "1001", displayName: "An (trùng)" }),
            user({ userId: "1002", displayName: "Bình" })
        ]
    });

    assert.deepEqual(options.map((item) => item.userId), ["1001", "1002"]);
    assert.equal(options.length, 2);
});

test("tên hiển thị thiếu hoặc chỉ là placeholder được thay bằng ID", () => {
    const options = buildTargetUserOptions({
        users: [
            user({ userId: "2001", displayName: "" }),
            user({ userId: "2002", displayName: "User 2002" }),
            user({ userId: "2003", displayName: "Cường" })
        ]
    });
    const byId = new Map(options.map((item) => [item.userId, item]));

    assert.equal(byId.get("2001").displayName, "User 2001");
    assert.equal(byId.get("2002").displayName, "User 2002");
    assert.equal(byId.get("2003").displayName, "Cường");
});

test("Chat ID chỉ được điền kèm khi có đúng một chat riêng tư đang hoạt động", () => {
    const options = buildTargetUserOptions({
        users: [
            user({ userId: "3001", chats: [chat({ chatId: "3001" })] }),
            user({ userId: "3002", chats: [chat({ chatId: "g-1", chatType: "group" }), chat({ chatId: "3002" })] }),
            user({ userId: "3003", chats: [chat({ chatId: "g-2", chatType: "group" })] }),
            user({ userId: "3004", chats: [] }),
            user({ userId: "3005", chats: [chat({ chatId: "3005", chatType: "unknown" })] })
        ]
    });
    const byId = new Map(options.map((item) => [item.userId, item]));

    assert.equal(byId.get("3001").targetChatId, "3001");
    assert.equal(byId.get("3001").targetChatHint, "private");

    assert.equal(byId.get("3002").targetChatId, "");
    assert.equal(byId.get("3002").targetChatHint, "multiple");

    // Một ngữ cảnh nhưng là nhóm: không đủ tin cậy để tự điền Chat ID.
    assert.equal(byId.get("3003").targetChatId, "");
    assert.equal(byId.get("3003").targetChatHint, "unresolved");

    assert.equal(byId.get("3004").targetChatId, "");
    assert.equal(byId.get("3004").targetChatHint, "none");

    assert.equal(byId.get("3005").targetChatId, "");
    assert.equal(byId.get("3005").targetChatHint, "unresolved");
});

test("bản ghi cũ đã xoá hoặc đã tắt không được dùng để điền Chat ID", () => {
    const options = buildTargetUserOptions({
        users: [
            user({ userId: "4001", status: "removed", chats: [chat({ chatId: "4001", memberStatus: "removed" })] }),
            user({ userId: "4002", status: "disabled", chats: [chat({ chatId: "4002", status: "disabled" })] })
        ]
    });
    const byId = new Map(options.map((item) => [item.userId, item]));

    assert.equal(byId.get("4001").targetChatHint, "none");
    assert.equal(byId.get("4001").targetChatId, "");
    assert.equal(byId.get("4001").status, "removed");

    assert.equal(byId.get("4002").targetChatHint, "none");
    assert.equal(byId.get("4002").targetChatId, "");
    assert.equal(byId.get("4002").status, "disabled");
});

test("chat riêng tư lấy từ chat directory được bổ sung khi chưa có member record", () => {
    const options = buildTargetUserOptions({
        users: [],
        chats: [
            { chatId: "5001", chatType: "private", userId: "5001", displayName: "Trần Thị B", status: "active" },
            { chatId: "g-9", chatType: "group", userId: "g-9", displayName: "Nhóm trùng số", status: "active" }
        ]
    });

    assert.deepEqual(options.map((item) => item.userId), ["5001"]);
    assert.equal(options[0].displayName, "Trần Thị B");
    assert.equal(options[0].targetChatId, "5001");
});

test("Chat ID của nhóm không bao giờ bị coi là User ID", () => {
    const workspace = {
        users: [user({ userId: "6001", displayName: "An" })],
        chats: [{ chatId: "7001", chatType: "group", displayName: "Nhóm 411" }]
    };

    const rejected = resolveTargetUserId(workspace, "7001");
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /Chat ID của một nhóm/);

    assert.equal(resolveTargetUserId(workspace, "6001").ok, true);
    // Giá trị không nằm trong directory vẫn được chấp nhận để không khoá nhập tay.
    assert.deepEqual(resolveTargetUserId(workspace, "nhap-tay-9999"), { ok: true, userId: "nhap-tay-9999" });
    assert.deepEqual(resolveTargetUserId(workspace, ""), { ok: true, userId: "" });
});

test("tra cứu và chọn chat đích trả về đúng liên kết", () => {
    const workspace = {
        users: [user({ userId: "8001", displayName: "An", chats: [chat({ chatId: "8001" })] })]
    };

    const found = findTargetUser(workspace, "8001");
    assert.equal(found.userId, "8001");
    assert.equal(found.displayName, "An");
    assert.equal(found.targetChatId, "8001");
    assert.equal(findTargetUser(workspace, "khong-ton-tai"), null);

    assert.deepEqual(resolveTargetChat([chat({ chatId: "x", chatType: "group" })]), { targetChatId: "", targetChatHint: "unresolved" });
    assert.deepEqual(resolveTargetChat([chat({ chatId: "y" })]), { targetChatId: "y", targetChatHint: "private" });
    assert.deepEqual(resolveTargetChat([chat({ chatId: "y" }), chat({ chatId: "z" })]), { targetChatId: "", targetChatHint: "multiple" });
    assert.deepEqual(resolveTargetChat([]), { targetChatId: "", targetChatHint: "none" });
});

test("đầu vào rỗng hoặc thiếu trường không làm hỏng danh sách", () => {
    assert.deepEqual(buildTargetUserOptions(), []);
    assert.deepEqual(buildTargetUserOptions({}), []);
    assert.deepEqual(buildTargetUserOptions({ users: [null, {}, { userId: "  " }] }), []);
    assert.deepEqual(buildTargetUserOptions({ chats: [null, {}, { chatId: "c" }] }), []);
});

/* -------------------------------------------------------------------------- */
/* Chọn nhiều người nhận                                                      */
/* -------------------------------------------------------------------------- */

function batchWorkspace() {
    return {
        users: [
            { userId: "u1", displayName: "Nguyễn Văn A", status: "active", studentIds: ["111"], chats: [chat({ chatId: "c1" })] },
            { userId: "u2", displayName: "Trần Thị B", status: "active", studentIds: [], chats: [chat({ chatId: "c2" })] },
            { userId: "u3", displayName: "Lê Văn C", status: "active", studentIds: [], chats: [] }
        ],
        chats: [{ chatId: "g1", chatType: "group", displayName: "Nhóm lớp" }]
    };
}

test("khử trùng User ID và giữ nguyên thứ tự xuất hiện", () => {
    const result = resolveBatchTargets(batchWorkspace(), ["u2", "u1", "u2", "u1", "u3"]);

    assert.deepEqual(result.targets.map((item) => item.userId), ["u2", "u1", "u3"]);
    assert.deepEqual(result.duplicates, ["u2", "u1"]);
    assert.deepEqual(result.rejected, []);
});

test("cắt khoảng trắng, bỏ giá trị rỗng và báo lại", () => {
    const result = resolveBatchTargets(batchWorkspace(), ["  u1  ", "", "   ", null]);

    assert.deepEqual(result.targets.map((item) => item.userId), ["u1"]);
    assert.equal(result.rejected.length, 3);
    assert.ok(result.rejected.every((item) => /rỗng/.test(item.reason)));
});

test("Chat ID của nhóm bị từ chối, không lặng lẽ dùng làm User ID", () => {
    const result = resolveBatchTargets(batchWorkspace(), ["u1", "g1"]);

    assert.deepEqual(result.targets.map((item) => item.userId), ["u1"]);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0].reason, /Chat ID của một nhóm/);
});

test("User ID nhập tay không có trong gợi ý vẫn được chấp nhận", () => {
    const result = resolveBatchTargets(batchWorkspace(), ["u1", "nguoi-moi"]);

    assert.deepEqual(result.targets.map((item) => item.userId), ["u1", "nguoi-moi"]);
    const unknown = result.targets[1];
    assert.equal(unknown.known, false);
    assert.equal(unknown.chatId, "");
    assert.equal(unknown.displayName, "User nguoi-moi");
});

test("Chat ID chỉ được trả kèm khi liên kết đủ tin cậy", () => {
    const result = resolveBatchTargets(batchWorkspace(), ["u1", "u3"]);

    assert.equal(result.targets[0].chatId, "c1");
    assert.equal(result.targets[0].chatHint, "private");
    assert.equal(result.targets[1].chatId, "");
    assert.equal(result.targets[1].chatHint, "none");
});

test("giới hạn số người mỗi lượt, phần vượt được đếm chứ không cắt lặng lẽ", () => {
    const ids = Array.from({ length: 30 }, (unused, index) => `u${index}`);
    const result = resolveBatchTargets(batchWorkspace(), ids, { max: 5 });

    assert.equal(result.targets.length, 5);
    assert.equal(result.overflow, 25);
    assert.equal(result.max, 5);
});

test("đầu vào không phải mảng vẫn xử lý an toàn", () => {
    assert.deepEqual(resolveBatchTargets(batchWorkspace(), null).targets, []);
    assert.deepEqual(resolveBatchTargets(batchWorkspace(), undefined).targets, []);
    assert.deepEqual(resolveBatchTargets(batchWorkspace(), "").targets, []);
    assert.deepEqual(resolveBatchTargets(batchWorkspace(), "u1").targets.map((item) => item.userId), ["u1"]);
    assert.deepEqual(resolveBatchTargets().targets, []);
});

test("mặc định giới hạn 25 người mỗi lượt", () => {
    const ids = Array.from({ length: 40 }, (unused, index) => `u${index}`);
    const result = resolveBatchTargets(batchWorkspace(), ids);
    assert.equal(result.max, 25);
    assert.equal(result.targets.length, 25);
});
