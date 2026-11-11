const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.BOT_TOKEN ||= "test-token";
process.env.NODE_ENV = "test";
// Trợ lý AI tắt: bài kiểm tra này chứng minh lệnh thường vẫn chạy khi không có AI.
process.env.AI_ASSISTANT_ENABLED = "false";
delete process.env.DEEPSEEK_API_KEY;

// Cách ly khỏi file runtime thật ở gốc dự án (`node --test` chạy song song).
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

// Chặn gọi API LHU thật.
const schedulePath = require.resolve("../lhuSchedule");
const realSchedule = require(schedulePath);
require.cache[schedulePath] = {
    id: schedulePath,
    filename: schedulePath,
    loaded: true,
    exports: {
        ...realSchedule,
        fetchStudentSchedule: async (studentId) => ({
            studentId,
            studentName: "Sinh viên thử",
            lessons: [],
            semesterStart: null,
            semesterEnd: null,
            totalRecords: 0
        })
    }
};

const ZaloBot = require("node-zalo-bot");
const sent = [];
ZaloBot.prototype.sendMessage = function (chatId, text) {
    sent.push({ chatId: String(chatId), text: String(text) });
    return Promise.resolve();
};

const main = require("../main.js");
const { registry: admissionRegistry } = require("../contactAdmission");

const CHAT_ID = "chat-routing";
const USER_ID = "user-routing";

function message(text) {
    return {
        text,
        chat: { id: CHAT_ID, type: "private" },
        from: { id: USER_ID, display_name: "Người dùng" }
    };
}

async function run(text) {
    sent.length = 0;
    // Chat đã được tiếp nhận ⇒ thao tác ghi chạy ngay, không bị hoãn.
    admissionRegistry.admit("bot1", CHAT_ID);
    await main.handleIncomingMessage({ botId: "bot1" }, message(text));
    return sent.map((item) => item.text).join("\n");
}

test("lệnh có dấu / vẫn chạy đúng engine cũ", async () => {
    const output = await run("/luumssv 123456789");
    assert.match(output, /123456789/);
    assert.match(output, /MSSV/);
});

test("lệnh không dấu được quy về lệnh chính tắc", async () => {
    const output = await run("luumssv 123456789");
    assert.match(output, /123456789/);
    assert.match(output, /MSSV/);
});

test("ngoặc vuông quanh đối số và giờ một chữ số được chấp nhận", async () => {
    await run("/luumssv [123456789]");
    const output = await run("/nhanlich 6:00 homnay");
    assert.match(output, /06:00/);
});

test("nhiều lệnh trong một tin chỉ trả về MỘT tổng kết", async () => {
    await run("/luumssv 123456789");
    sent.length = 0;
    admissionRegistry.admit("bot1", CHAT_ID);

    await main.handleIncomingMessage({ botId: "bot1" }, message("luumssv [123456789], nhanlich 6:00 hôm nay, nhanlich 20:00 hôm sau"));

    const output = sent.map((item) => item.text).join("\n");
    assert.match(output, /06:00/);
    assert.match(output, /20:00/);
    assert.equal(sent.length, 1, "không được gửi ba câu trả lời riêng lẻ");
});

test("lô lệnh có phần tử sai thì không ghi gì và báo rõ", async () => {
    const before = JSON.stringify(memoryFiles.get(fileKey(path.join(__dirname, "..", "subscriptions.json"))));
    const output = await run("luumssv 12345, nhanlich 06:00 homnay");
    assert.match(output, /CHƯA HIỂU RÕ|không hợp lệ/i);
    const after = JSON.stringify(memoryFiles.get(fileKey(path.join(__dirname, "..", "subscriptions.json"))));
    assert.equal(after, before, "không được ghi khi lô lệnh sai");
});

test("AI tắt: tin nhắn thường không nhận phản hồi, và không có lệnh quản trị nào chạy", async () => {
    const plain = await run("tớ muốn nhận lịch lúc 6 giờ sáng");
    assert.equal(plain, "", "không được gửi gì khi trợ lý AI tắt");

    // Lệnh quản trị thiếu dấu "/" phải bị bỏ qua hoàn toàn, không phát thông báo.
    const broadcast = await run("thongbao hệ thống bảo trì lúc 22:00");
    assert.equal(broadcast, "", "không được chạy lệnh quản trị khi thiếu dấu /");
});

test("câu nói bắt đầu bằng 'nhận lịch' không bị chạy như lệnh", async () => {
    const output = await run("Nhận lịch lúc 9 giờ tối hôm sau");
    // AI đang tắt trong bài này ⇒ đường dự phòng đưa về engine lệnh để người dùng
    // nhận hướng dẫn cú pháp, KHÔNG phải im lặng.
    assert.match(output, /Cú pháp|SAI CÚ PHÁP/i);
    assert.ok(!/ĐÃ BẬT THÔNG BÁO/.test(output), "không được đăng ký gì từ một câu nói");
});

test("parseCommand giữ nguyên văn bản tự do của lệnh quản trị", () => {
    const parsed = main.parseCommand("/thongbao Hệ thống bảo trì lúc 22:00");
    assert.equal(parsed.command, "thongbao");
    assert.equal(parsed.argument, "Hệ thống bảo trì lúc 22:00");
});

test("chuẩn hoá giờ chạy trước kiểm tra nghiêm ngặt", () => {
    assert.deepEqual(main.parseNhanLichArgument("6:00 homnay", "123456789"), {
        studentId: "123456789",
        notificationTime: "06:00",
        targetDayOffset: 0
    });
    assert.deepEqual(main.parseSuaGioNhanLichArgument("1 8:00 homsau"), {
        id: 1,
        notificationTime: "08:00",
        targetDayOffset: 1
    });
    // Không làm yếu kiểm tra: giờ sai và ngày thiếu vẫn bị từ chối.
    assert.equal(main.parseNhanLichArgument("25:00 homnay", "123456789").error, "time");
    assert.equal(main.parseNhanLichArgument("6:00", "123456789").error, "day");
    assert.equal(main.parseNhanLichArgument("6:00 homnay", null).error, "student");
});

/* -------------------------------------------------------------------------- */
/* /lich theo ngày tuỳ chọn                                                    */
/* -------------------------------------------------------------------------- */

test("parseScheduleDateArgument tách đúng MSSV và ngày", () => {
    const withDate = main.parseScheduleDateArgument("123456789 thứ 5");
    assert.equal(withDate.studentPart, "123456789");
    assert.equal(withDate.resolved.dateKey.length, 10);

    const dateOnly = main.parseScheduleDateArgument("ngày mai");
    assert.equal(dateOnly.studentPart, "");
    assert.ok(dateOnly.resolved);

    const nothing = main.parseScheduleDateArgument("");
    assert.equal(nothing.studentPart, "");
    assert.equal(nothing.resolved, null);

    const tooMany = main.parseScheduleDateArgument("123 456 mai");
    assert.equal(tooMany.error, "syntax");
});

test("/lich có ngày trả về lịch của ngày đó, không phải hôm nay", async () => {
    const output = await run("/lich 123456789 thứ 5");
    assert.ok(!/LỆNH KHÔNG HỢP LỆ/.test(output), "phải nhận diện được cú pháp có ngày");
    assert.match(output, /LỊCH HỌC|KHÔNG CÓ LỊCH HỌC/);
});

test("/lichngaymai (gõ dính) được hiểu là /lich ngaymai", async () => {
    const output = await run("/lichngaymai 123456789");
    assert.ok(!/LỆNH KHÔNG HỢP LỆ/.test(output), "không được báo lệnh không hợp lệ");
    assert.match(output, /LỊCH HỌC|KHÔNG CÓ LỊCH HỌC/);
});

test("parseLeadMinutes hiểu phút và giờ", () => {
    assert.equal(main.parseLeadMinutes("60"), 60);
    assert.equal(main.parseLeadMinutes("10 phút"), 10);
    assert.equal(main.parseLeadMinutes("1 tiếng"), 60);
    assert.equal(main.parseLeadMinutes("1h"), 60);
    assert.equal(main.parseLeadMinutes("0"), 0);
    assert.equal(main.parseLeadMinutes(""), null);
    assert.equal(main.parseLeadMinutes("abc"), "invalid");
    assert.equal(main.parseLeadMinutes("500"), "invalid");
});

test("chỉ cảnh báo cú pháp mới kéo theo phần giải thích của trợ lý", () => {
    assert.equal(main.looksLikeSyntaxError(["# {orange}⚠ SAI CÚ PHÁP{/orange}"]), true);
    assert.equal(main.looksLikeSyntaxError(["# {orange}⚠ CHƯA CÓ MSSV{/orange}"]), true);
    assert.equal(main.looksLikeSyntaxError(["# {orange}⚠ MSSV KHÔNG HỢP LỆ{/orange}"]), true);
    assert.equal(main.looksLikeSyntaxError(["# {orange}⚠ LỆNH KHÔNG HỢP LỆ{/orange}"]), true);

    // Từ chối quyền và kết quả bình thường thì KHÔNG kéo theo AI.
    assert.equal(main.looksLikeSyntaxError(["# {orange}⚠ KHÔNG CÓ QUYỀN{/orange}"]), false);
    assert.equal(main.looksLikeSyntaxError(["# {green}✓ ĐÃ LƯU MSSV{/green}"]), false);
    assert.equal(main.looksLikeSyntaxError([]), false);
});
