const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTargetUserOptions, findTargetUser, resolveTargetUserId, resolveTargetChat } = require("../targetUsers");

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
