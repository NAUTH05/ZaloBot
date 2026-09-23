const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.BOT_TOKEN ||= "test-token";

// Cách ly khỏi file runtime thật ở gốc dự án (node --test chạy song song).
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

// Chặn gọi API LHU thật và ghi lại ngày được yêu cầu.
const schedulePath = require.resolve("../lhuSchedule");
const realSchedule = require(schedulePath);
const fetchCalls = [];
require.cache[schedulePath] = {
    id: schedulePath,
    filename: schedulePath,
    loaded: true,
    exports: {
        ...realSchedule,
        fetchStudentSchedule: async (studentId, date = new Date()) => {
            fetchCalls.push({ studentId, dateKey: date.toISOString() });
            return { studentId, studentName: "Sinh viên thử", lessons: [], semesterStart: null, semesterEnd: null, totalRecords: 0 };
        }
    }
};

// Cảnh báo thay đổi lịch là luồng độc lập: đếm số lần được gọi để chắc chắn nó
// không bị chạy lại theo từng ngày đích.
const changesPath = require.resolve("../scheduleChanges");
const realChanges = require(changesPath);
const changeChecks = [];
require.cache[changesPath] = {
    id: changesPath,
    filename: changesPath,
    loaded: true,
    exports: {
        ...realChanges,
        confirmScheduleChange: (data, date) => {
            changeChecks.push({ studentId: data.studentId, date });
            return { confirmed: false, changes: [] };
        },
        initializeScheduleSnapshot: () => {}
    }
};

const ZaloBot = require("node-zalo-bot");
const sent = [];
ZaloBot.prototype.sendMessage = function (chatId, text) {
    sent.push({ chatId: String(chatId), text: String(text) });
    return Promise.resolve();
};

const main = require("../main.js");
const {
    normalizeNotificationTimes,
    normalizeTargetDayOffset,
    migrateNotificationTargetDays,
    updateNotificationTime,
    removeNotificationTime,
    enableNotifications
} = require("../subscriptions");

const CHAT_DIRECTORY_KEY = fileKey(path.join(__dirname, "..", "chatDirectory.json"));

function seed({ times = [], studentId = "123000135", chatId = "chat-a", userId = "user-a" } = {}) {
    memoryFiles.clear();
    fetchCalls.length = 0;
    changeChecks.length = 0;
    sent.length = 0;
    memoryFiles.set(CHAT_DIRECTORY_KEY, {
        chats: [{ chatId, chatType: "private", displayName: "Chat thử", status: "active", userId, notificationOverrides: {}, deliveryHistory: [] }]
    });
    memoryFiles.set(fileKey(path.join(__dirname, "..", "subscriptions.json")), {
        [`${encodeURIComponent(chatId)}::${encodeURIComponent(userId)}`]: {
            contextVersion: 2,
            chatId,
            userId,
            userDisplayName: "Người thử",
            studentId,
            studentName: "Sinh viên thử",
            notificationTimes: times,
            notificationsEnabled: true,
            classStartNotificationsEnabled: false,
            updatedAt: new Date().toISOString()
        }
    });
    return { chatId, userId };
}

const REFERENCE = new Date("2026-09-23T06:00:00+07:00"); // 23/09/2026 06:00 giờ Việt Nam

/* -------------------------------------------------------------------------- */
/* Lưu trữ và di trú                                                          */
/* -------------------------------------------------------------------------- */

test("mỗi mốc lưu ngày đích riêng và cùng giờ có thể có cả hai ngày", () => {
    const times = normalizeNotificationTimes({
        notificationTimes: [
            { id: 1, time: "06:30", targetDayOffset: 0 },
            { id: 2, time: "06:30", targetDayOffset: 1 },
            { id: 3, time: "20:00", targetDayOffset: 1 }
        ]
    });

    assert.equal(times.length, 3, "hai mốc cùng giờ khác ngày đích phải cùng tồn tại");
    assert.deepEqual(times.map((item) => [item.id, item.time, item.targetDayOffset]), [
        [1, "06:30", 0],
        [2, "06:30", 1],
        [3, "20:00", 1]
    ]);
});

test("bản ghi cũ giữ nguyên hành vi trước/sau 20:00", () => {
    const times = normalizeNotificationTimes({
        notificationTimes: [
            { id: 1, time: "05:59" },
            { id: 2, time: "19:59" },
            { id: 3, time: "20:00" },
            { id: 4, time: "23:59" }
        ]
    });

    assert.deepEqual(times.map((item) => item.targetDayOffset), [0, 0, 1, 1]);
    // Không được để mọi mốc 20:00 đổ về lịch hôm nay.
    assert.equal(times[2].targetDayOffset, 1);
});

test("ngày đích đã lưu được ưu tiên hơn chính sách 20:00 cũ", () => {
    const times = normalizeNotificationTimes({
        notificationTimes: [
            { id: 1, time: "21:00", targetDayOffset: 0 },
            { id: 2, time: "06:00", targetDayOffset: 1 }
        ]
    });

    assert.deepEqual(times.map((item) => item.targetDayOffset), [0, 1]);
});

test("di trú idempotent: ghi lại ngày đích suy ra, chạy lần hai không đổi gì", () => {
    seed({ times: [{ id: 1, time: "06:00" }, { id: 2, time: "21:00" }] });

    const first = migrateNotificationTargetDays();
    assert.equal(first.changedSubscriptions, 1);
    assert.equal(first.migratedTimes, 2);

    const stored = memoryFiles.get(fileKey(path.join(__dirname, "..", "subscriptions.json")));
    const times = Object.values(stored)[0].notificationTimes;
    assert.deepEqual(times.map((item) => item.targetDayOffset), [0, 1]);

    const second = migrateNotificationTargetDays();
    assert.equal(second.changedSubscriptions, 0, "chạy lại không được ghi gì thêm");
    assert.equal(second.migratedTimes, 0);
});

test("di trú không làm mất id, MSSV, quyền sở hữu hay trạng thái bật", () => {
    seed({ times: [{ id: 7, time: "21:30" }] });
    migrateNotificationTargetDays();

    const stored = memoryFiles.get(fileKey(path.join(__dirname, "..", "subscriptions.json")));
    const subscription = Object.values(stored)[0];
    assert.equal(subscription.studentId, "123000135");
    assert.equal(subscription.chatId, "chat-a");
    assert.equal(subscription.userId, "user-a");
    assert.equal(subscription.notificationsEnabled, true);
    assert.equal(subscription.notificationTimes[0].id, 7, "ID phải được giữ nguyên");
    assert.equal(subscription.notificationTimes[0].targetDayOffset, 1);
});

test("normalizeTargetDayOffset chấp nhận 0/1 và suy ra khi thiếu", () => {
    assert.equal(normalizeTargetDayOffset(0, "21:00"), 0);
    assert.equal(normalizeTargetDayOffset(1, "06:00"), 1);
    assert.equal(normalizeTargetDayOffset("1", "06:00"), 1);
    assert.equal(normalizeTargetDayOffset(undefined, "06:00"), 0);
    assert.equal(normalizeTargetDayOffset(undefined, "20:00"), 1);
    assert.equal(normalizeTargetDayOffset("rác", "21:00"), 1);
});

/* -------------------------------------------------------------------------- */
/* Sửa và xóa theo ID                                                         */
/* -------------------------------------------------------------------------- */

test("sửa được cả giờ lẫn ngày đích của một mốc theo ID", () => {
    const context = seed({ times: [{ id: 1, time: "06:30", targetDayOffset: 0 }, { id: 2, time: "06:30", targetDayOffset: 1 }] });

    const updated = updateNotificationTime(context, 1, "07:00", 1);
    const times = normalizeNotificationTimes(updated);
    assert.deepEqual(times.map((item) => [item.id, item.time, item.targetDayOffset]), [
        [1, "07:00", 1],
        [2, "06:30", 1]
    ]);
});

test("sửa chỉ ngày đích khi không truyền giờ", () => {
    const context = seed({ times: [{ id: 1, time: "06:30", targetDayOffset: 0 }] });

    const updated = updateNotificationTime(context, 1, null, 1);
    const times = normalizeNotificationTimes(updated);
    assert.equal(times[0].time, "06:30");
    assert.equal(times[0].targetDayOffset, 1);
});

test("không cho hai mốc trùng cả giờ lẫn ngày đích", () => {
    const context = seed({ times: [{ id: 1, time: "06:30", targetDayOffset: 0 }, { id: 2, time: "07:00", targetDayOffset: 0 }] });

    // Đổi #2 thành 06:30 homnay -> trùng hoàn toàn với #1.
    assert.equal(updateNotificationTime(context, 2, "06:30", 0), null);
    // Nhưng 06:30 homsau thì hợp lệ.
    assert.ok(updateNotificationTime(context, 2, "06:30", 1));
});

test("xóa đúng mốc theo ID, giữ lại mốc cùng giờ khác ngày đích", () => {
    const context = seed({ times: [{ id: 1, time: "06:30", targetDayOffset: 0 }, { id: 2, time: "06:30", targetDayOffset: 1 }] });

    const removed = removeNotificationTime(context, 1);
    assert.equal(removed.removed.targetDayOffset, 0);
    const times = normalizeNotificationTimes(removed.subscription);
    assert.equal(times.length, 1);
    assert.equal(times[0].id, 2);
    assert.equal(times[0].targetDayOffset, 1);
});

/* -------------------------------------------------------------------------- */
/* Gửi lịch theo từng ngày đích                                               */
/* -------------------------------------------------------------------------- */

test("một lượt gửi phục vụ cả hai ngày đích", async () => {
    seed({
        times: [
            { id: 1, time: "06:30", targetDayOffset: 0 },
            { id: 2, time: "06:30", targetDayOffset: 1 }
        ]
    });

    const result = await main.sendDailySchedulesAtTime("06:30", REFERENCE);

    assert.equal(result.sent, 2, "mỗi ngày đích một tin");
    // Một lần lấy lịch cho hôm nay (23/09) và một lần cho hôm sau (24/09).
    const requested = fetchCalls.map((call) => call.dateKey.slice(0, 10)).sort();
    assert.deepEqual(requested, ["2026-09-23", "2026-09-24"]);
    // Nội dung mỗi tin đánh dấu đúng ngày.
    assert.ok(sent.some((item) => item.text.includes("HÔM NAY")));
    assert.ok(sent.some((item) => item.text.includes("NGÀY MAI")));
});

test("cảnh báo thay đổi lịch vẫn chỉ kiểm tra một lần cho mỗi MSSV", async () => {
    seed({
        times: [
            { id: 1, time: "06:30", targetDayOffset: 0 },
            { id: 2, time: "06:30", targetDayOffset: 1 }
        ]
    });

    await main.sendDailySchedulesAtTime("06:30", REFERENCE);

    assert.equal(changeChecks.length, 1, "kiểm tra thay đổi lịch là luồng độc lập, không chạy theo ngày đích");
    assert.equal(changeChecks[0].studentId, "123000135");
});

test("mốc 21:00 homnay và 06:00 homsau đều gửi đúng ngày", async () => {
    seed({ times: [{ id: 1, time: "21:00", targetDayOffset: 0 }] });
    const evening = new Date("2026-09-23T21:00:00+07:00");
    const result = await main.sendDailySchedulesAtTime("21:00", evening);

    assert.equal(result.sent, 1);
    // 21:00 hôm nay nhưng người dùng chọn lịch hôm nay -> vẫn là 23/09.
    assert.equal(fetchCalls[0].dateKey.slice(0, 10), "2026-09-23");

    seed({ times: [{ id: 1, time: "06:00", targetDayOffset: 1 }] });
    const morning = new Date("2026-09-23T06:00:00+07:00");
    await main.sendDailySchedulesAtTime("06:00", morning);
    // 06:00 sáng nhưng người dùng chọn lịch hôm sau -> 24/09.
    assert.equal(fetchCalls[0].dateKey.slice(0, 10), "2026-09-24");
});

test("không gửi cho mốc ở giờ khác", async () => {
    seed({ times: [{ id: 1, time: "20:00", targetDayOffset: 1 }] });

    const result = await main.sendDailySchedulesAtTime("06:30", REFERENCE);

    assert.equal(result.processed, false);
    assert.equal(sent.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Ranh giới thời gian theo giờ Việt Nam                                      */
/* -------------------------------------------------------------------------- */

test("qua nửa đêm, tháng và năm đều tính đúng theo giờ Việt Nam", async () => {
    const { getVietnamDateInfo } = require("../timezone");
    const cases = [
        // Gửi 23:59 ngày 30/09 chọn homsau -> 01/10.
        { at: new Date("2026-09-30T23:59:00+07:00"), offset: 1, expected: "2026-10-01" },
        // Gửi 00:00 ngày 01/10 chọn homnay -> 01/10.
        { at: new Date("2026-10-01T00:00:00+07:00"), offset: 0, expected: "2026-10-01" },
        // Qua năm mới.
        { at: new Date("2026-12-31T23:30:00+07:00"), offset: 1, expected: "2027-01-01" },
        { at: new Date("2027-01-01T00:05:00+07:00"), offset: 0, expected: "2027-01-01" },
        // Cuối tháng 2 năm nhuận.
        { at: new Date("2028-02-28T23:00:00+07:00"), offset: 1, expected: "2028-02-29" },
        // 23:30 giờ Việt Nam vẫn là ngày hôm đó, không phải hôm sau theo UTC.
        { at: new Date("2026-09-23T23:30:00+07:00"), offset: 0, expected: "2026-09-23" }
    ];

    for (const item of cases) {
        // Mốc giờ phải trùng thời điểm gửi thì mới được chọn.
        const info = getVietnamDateInfo(item.at);
        const time = `${String(info.hour).padStart(2, "0")}:${String(info.minute).padStart(2, "0")}`;
        seed({ times: [{ id: 1, time, targetDayOffset: item.offset }] });

        await main.sendDailySchedulesAtTime(time, item.at);

        assert.equal(fetchCalls.length, 1, `phải gửi đúng một lần cho ${time} ngày ${info.dateKey}`);
        assert.equal(fetchCalls[0].dateKey.slice(0, 10), item.expected, `gửi ${time} ngày ${info.dateKey}, offset ${item.offset}`);
    }
});

/* -------------------------------------------------------------------------- */
/* Đăng ký qua hàm lưu trữ                                                    */
/* -------------------------------------------------------------------------- */

test("đăng ký cùng giờ cho hai ngày đích tạo hai mốc riêng", () => {
    const context = seed({ times: [] });

    enableNotifications(context, { studentId: "123000135", studentName: "SV", notificationTime: "06:30", targetDayOffset: 0 });
    const afterFirst = normalizeNotificationTimes(require("../subscriptions").getSubscription(context));
    assert.equal(afterFirst.length, 1);

    enableNotifications(context, { studentId: "123000135", studentName: "SV", notificationTime: "06:30", targetDayOffset: 1 });
    const afterSecond = normalizeNotificationTimes(require("../subscriptions").getSubscription(context));
    assert.equal(afterSecond.length, 2, "cùng giờ khác ngày đích phải thêm mốc mới");
    assert.deepEqual(afterSecond.map((item) => item.targetDayOffset), [0, 1]);

    // Đăng ký lại đúng cặp đã có thì không thêm nữa.
    enableNotifications(context, { studentId: "123000135", studentName: "SV", notificationTime: "06:30", targetDayOffset: 1 });
    const afterThird = normalizeNotificationTimes(require("../subscriptions").getSubscription(context));
    assert.equal(afterThird.length, 2);
});

/* -------------------------------------------------------------------------- */
/* ID dạng số trần là chính tắc, "#ID" chỉ còn là tương thích                 */
/* -------------------------------------------------------------------------- */

async function runCommand(command, chatId = "chat-a", userId = "user-a") {
    sent.length = 0;
    const parsed = main.parseCommand(command);
    await main.handleCommand(
        { text: command, chat: { id: chatId, type: "private" }, from: { id: userId, display_name: "Người thử" } },
        parsed
    );
    return sent.map((item) => item.text).join("\n");
}

// Các mốc hiện có của một ngữ cảnh, đã chuẩn hoá.
function times(context) {
    return normalizeNotificationTimes(require("../subscriptions").getSubscription(context));
}

test("parseRecordId chấp nhận số trần và tiền tố #, từ chối mọi giá trị sai", () => {
    assert.equal(main.parseRecordId("1"), 1);
    assert.equal(main.parseRecordId("#1"), 1);
    assert.equal(main.parseRecordId(" 12 "), 12);
    assert.equal(main.parseRecordId("#42"), 42);

    for (const bad of ["0", "#0", "-1", "#-1", "1.5", "-1.5", "abc", "", "   ", "#", "1a", "a1", "1 2", "0x1", null, undefined]) {
        assert.equal(main.parseRecordId(bad), null, `parseRecordId(${JSON.stringify(bad)}) phải bị từ chối`);
    }
});

test("cú pháp sửa giờ nhận cả ID trần lẫn #ID", () => {
    assert.deepEqual(main.parseSuaGioNhanLichArgument("1 06:00 homnay"), { id: 1, notificationTime: "06:00", targetDayOffset: 0 });
    assert.deepEqual(main.parseSuaGioNhanLichArgument("#1 06:00 homnay"), { id: 1, notificationTime: "06:00", targetDayOffset: 0 });
    assert.deepEqual(main.parseSuaGioNhanLichArgument("1 homsau"), { id: 1, notificationTime: null, targetDayOffset: 1 });
    assert.deepEqual(main.parseSuaGioNhanLichArgument("#2 homsau"), { id: 2, notificationTime: null, targetDayOffset: 1 });

    assert.equal(main.parseSuaGioNhanLichArgument("0 06:00 homnay").error, "id");
    assert.equal(main.parseSuaGioNhanLichArgument("#0 06:00 homnay").error, "id");
    assert.equal(main.parseSuaGioNhanLichArgument("-1 06:00 homnay").error, "syntax");
    assert.equal(main.parseSuaGioNhanLichArgument("1.5 06:00 homnay").error, "syntax");
});

test("/suagionhanlich 1 06:00 homnay sửa đúng bản ghi, #1 vẫn tương thích", async () => {
    const context = seed({
        times: [
            { id: 1, time: "06:00", targetDayOffset: 0 },
            { id: 2, time: "21:00", targetDayOffset: 1 }
        ]
    });

    const plain = await runCommand("/suagionhanlich 1 06:30 homnay");
    assert.match(plain, /ĐÃ CẬP NHẬT/);
    assert.deepEqual(times(context).map((item) => [item.id, item.time, item.targetDayOffset]), [[1, "06:30", 0], [2, "21:00", 1]]);

    // Dạng #ID cũ trỏ đúng cùng bản ghi.
    const hashed = await runCommand("/suagionhanlich #1 08:00 homsau");
    assert.match(hashed, /ĐÃ CẬP NHẬT/);
    assert.equal(times(context)[0].time, "08:00");
    assert.equal(times(context)[0].targetDayOffset, 1);
    // Bản ghi ID 2 không bị đụng tới.
    assert.equal(times(context)[1].time, "21:00");
    assert.equal(times(context)[1].targetDayOffset, 1);
});

test("sửa chỉ ngày đích bằng ID trần không đổi giờ", async () => {
    const context = seed({ times: [{ id: 1, time: "06:30", targetDayOffset: 0 }] });

    const output = await runCommand("/suagionhanlich 1 homsau");
    assert.match(output, /ĐÃ CẬP NHẬT/);
    assert.equal(times(context)[0].time, "06:30");
    assert.equal(times(context)[0].targetDayOffset, 1);
});

test("/xoagionhanlich 1 và #1 trỏ đúng cùng một ID", async () => {
    const context = seed({
        times: [
            { id: 1, time: "06:00", targetDayOffset: 0 },
            { id: 2, time: "06:00", targetDayOffset: 1 }
        ]
    });

    const hashed = await runCommand("/xoagionhanlich #2");
    assert.match(hashed, /ĐÃ XÓA/);
    assert.deepEqual(times(context).map((item) => item.id), [1]);

    const plain = await runCommand("/xoagionhanlich 1");
    assert.match(plain, /ĐÃ XÓA/);
    assert.equal(times(context).length, 0);
});

test("ID 0, số âm, số thập phân và chuỗi rác bị từ chối, không đụng bản ghi", async () => {
    const context = seed({ times: [{ id: 1, time: "06:00", targetDayOffset: 0 }] });

    for (const bad of ["0", "#0", "-1", "1.5", "abc", "#", "1a"]) {
        const edit = await runCommand(`/suagionhanlich ${bad} 06:00 homnay`);
        assert.match(edit, /SAI CÚ PHÁP/, `sửa với ID "${bad}" phải bị từ chối`);

        const remove = await runCommand(`/xoagionhanlich ${bad}`);
        assert.match(remove, /SAI CÚ PHÁP/, `xoá với ID "${bad}" phải bị từ chối`);
    }

    // Không bản ghi nào bị thay đổi hay xoá.
    assert.deepEqual(times(context).map((item) => [item.id, item.time, item.targetDayOffset]), [[1, "06:00", 0]]);
});

test("danh sách giờ hiển thị ID không có dấu #", async () => {
    seed({ times: [{ id: 1, time: "06:00", targetDayOffset: 0 }, { id: 2, time: "20:00", targetDayOffset: 1 }] });

    const output = await runCommand("/gionhanlich");
    assert.match(output, /ID 1/);
    assert.match(output, /ID 2/);
    assert.ok(!/#1|#2/.test(output), "danh sách không được hiển thị #1/#2");
});
