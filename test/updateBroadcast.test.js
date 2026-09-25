const test = require("node:test");
const assert = require("node:assert/strict");

process.env.BOT_TOKEN ||= "test-token";
// Đặt trước khi require main.js: quyền owner lấy từ các biến này.
process.env.OWNER_USER_ID = "broadcast-owner-user";
process.env.OWNER_CHAT_ID = "broadcast-owner-chat";

const ELIGIBLE_CHAT = "broadcast-test-chat-a";
const MUTED_CHAT = "broadcast-test-chat-b";
// Mỗi đích phải khai báo TÀI KHOẢN sở hữu: đợt phát tin định tuyến theo
// (botId, chatId), và đích không rõ tài khoản bị bỏ qua chứ không đoán bot 1.
const TARGETS = [
    { chatId: ELIGIBLE_CHAT, chatType: "private", botId: "bot1" },
    { chatId: MUTED_CHAT, chatType: "private", botId: "bot1" }
];
// Chat B đã tắt tính năng thông báo chung trong chat directory.
const MUTED_CHATS = new Set([MUTED_CHAT]);

// Thay các store bằng stub trước khi main.js nạp chúng, để bài kiểm tra không
// ghi vào interactions.json / chatDirectory.json / subscriptions.json dùng chung
// (các file này cũng được các bài kiểm tra khác đọc song song).
function stubModule(request, overrides) {
    const resolved = require.resolve(request);
    const original = require(request);
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: { ...original, ...overrides }
    };
}

stubModule("../interactionRegistry", { getInteractionTargets: () => TARGETS.map((item) => ({ ...item })) });
stubModule("../subscriptions", { getAllSubscriptions: () => ({}) });
stubModule("../chatDirectory", {
    isChatEligible: (chatId) => !MUTED_CHATS.has(String(chatId)),
    upsertChat: () => null,
    recordDeliverySuccess: () => null,
    recordDeliveryFailure: () => null
});

// Chặn mọi lời gọi Zalo API để quan sát nội dung thực sự được gửi đi.
const ZaloBot = require("node-zalo-bot");
const sent = [];
ZaloBot.prototype.sendMessage = function (chatId, text) {
    sent.push({ chatId: String(chatId), text: String(text) });
    return Promise.resolve();
};

const main = require("../main.js");

function message(userId, chatId) {
    return { text: "", chat: { id: chatId, type: "private" }, from: { id: userId, display_name: "Người dùng" } };
}

async function run(command, argument, { owner = true } = {}) {
    sent.length = 0;
    const userId = owner ? process.env.OWNER_USER_ID : "non-owner-user-xyz";
    const chatId = owner ? process.env.OWNER_CHAT_ID : "non-owner-chat-xyz";
    await main.handleCommand(message(userId, chatId), { command, argument });
    return [...sent];
}

const forChat = (messages, chatId) => messages.filter((item) => item.chatId === chatId);

test("/update gửi thông báo cập nhật một lần cho mỗi chat đủ điều kiện", async () => {
    const messages = await run("update", "Đã bổ sung tuỳ chọn giờ nhận lịch");

    const delivered = forChat(messages, ELIGIBLE_CHAT);
    assert.equal(delivered.length, 1, "/update phải gửi đúng một tin cho mỗi chat đủ điều kiện");
    assert.match(delivered[0].text, /\[THÔNG BÁO CẬP NHẬT\]/);
    assert.ok(delivered[0].text.includes("Đã bổ sung tuỳ chọn giờ nhận lịch"));

    // Chat đã tắt thông báo chung không được nhận, và không gửi kèm bản thông báo chung.
    assert.equal(forChat(messages, MUTED_CHAT).length, 0, "không được gửi tới chat đã tắt tính năng broadcast");
    assert.equal(messages.filter((item) => item.text.includes("[THÔNG BÁO CHUNG]")).length, 0, "/update không được gửi kèm thông báo chung");

    const summary = forChat(messages, process.env.OWNER_CHAT_ID);
    assert.equal(summary.length, 1, "owner nhận đúng một bản tổng kết");
    assert.match(summary[0].text, /ĐÃ GỬI THÔNG BÁO CẬP NHẬT/);
    assert.match(summary[0].text, /Tổng cuộc trò chuyện:\*\* 1/);
    assert.match(summary[0].text, /Gửi thành công:\*\* 1/);
    assert.match(summary[0].text, /Gửi lỗi:\*\* 0/);
});

test("/thongbao gửi thông báo chung và không dùng từ ngữ cập nhật", async () => {
    const messages = await run("thongbao", "Hệ thống sẽ bảo trì lúc 22:00");

    const delivered = forChat(messages, ELIGIBLE_CHAT);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].text, /\[THÔNG BÁO CHUNG\]/);
    assert.ok(delivered[0].text.includes("Hệ thống sẽ bảo trì lúc 22:00"));
    assert.ok(!/cập nhật/i.test(delivered[0].text), "/thongbao không được ngụ ý là thông báo cập nhật");
    assert.equal(forChat(messages, MUTED_CHAT).length, 0);
    assert.equal(messages.filter((item) => item.text.includes("[THÔNG BÁO CẬP NHẬT]")).length, 0, "/thongbao không được gửi kèm thông báo cập nhật");

    const summary = forChat(messages, process.env.OWNER_CHAT_ID);
    assert.equal(summary.length, 1);
    assert.match(summary[0].text, /ĐÃ GỬI THÔNG BÁO CHUNG/);
    assert.match(summary[0].text, /Gửi thành công:\*\* 1/);
});

test("/update và /thongbao đều chỉ dành cho owner", async () => {
    for (const command of ["update", "thongbao"]) {
        const messages = await run(command, "Nội dung thử", { owner: false });
        assert.equal(messages.length, 1, `/${command} phải trả về đúng một tin khi thiếu quyền`);
        assert.match(messages[0].text, /KHÔNG CÓ QUYỀN/);
        assert.equal(forChat(messages, ELIGIBLE_CHAT).length, 0, `/${command} không được phát tán khi thiếu quyền`);
    }
});

test("/update và /thongbao trả lời rõ ràng khi thiếu nội dung", async () => {
    const update = await run("update", "");
    assert.equal(update.length, 1);
    assert.match(update[0].text, /THIẾU NỘI DUNG/);
    assert.match(update[0].text, /Cú pháp:\*\* \/update \[Nội dung cập nhật\]/);
    assert.match(update[0].text, /Ví dụ:\*\* \/update/);
    assert.match(update[0].text, /\/thongbao \[Nội dung thông báo\]/);
    assert.equal(forChat(update, ELIGIBLE_CHAT).length, 0);

    const thongbao = await run("thongbao", "");
    assert.equal(thongbao.length, 1);
    assert.match(thongbao[0].text, /THIẾU NỘI DUNG/);
    assert.match(thongbao[0].text, /Cú pháp:\*\* \/thongbao \[Nội dung thông báo\]/);
    assert.match(thongbao[0].text, /Ví dụ:\*\* \/thongbao/);
    assert.match(thongbao[0].text, /\/update \[Nội dung cập nhật\]/);
    assert.equal(forChat(thongbao, ELIGIBLE_CHAT).length, 0);
});

test("hai lệnh dùng chung một cơ chế gửi nhưng không gửi trùng cho nhau", async () => {
    const update = await run("update", "Bản cập nhật A");
    const thongbao = await run("thongbao", "Thông báo B");

    assert.equal(forChat(update, ELIGIBLE_CHAT).length, 1);
    assert.equal(forChat(thongbao, ELIGIBLE_CHAT).length, 1);
    assert.ok(!forChat(thongbao, ELIGIBLE_CHAT)[0].text.includes("Bản cập nhật A"));
    assert.ok(!forChat(update, ELIGIBLE_CHAT)[0].text.includes("Thông báo B"));
    // Mỗi lần chạy chỉ có một bản tổng kết.
    assert.equal(forChat(update, process.env.OWNER_CHAT_ID).length, 1);
    assert.equal(forChat(thongbao, process.env.OWNER_CHAT_ID).length, 1);
});

test("/update được gợi ý khi gõ sai lệnh và có ví dụ trong COMMAND_EXAMPLES", () => {
    assert.equal(main.suggestCommandCorrection("updatetinhnang"), "/update tinhnang");
    assert.equal(main.suggestCommandCorrection("updte"), "/update Đã bổ sung tuỳ chọn ngày nhận lịch");
    assert.equal(main.suggestCommandCorrection("thongbao"), "/thongbao Hệ thống sẽ bảo trì lúc 22:00");
});
