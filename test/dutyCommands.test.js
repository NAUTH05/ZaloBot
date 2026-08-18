const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    addDutySchedule,
    deleteDutySchedule,
    getDutyScheduleForDate,
    getDutySchedules,
    updateDutySchedule
} = require("../dutyScheduleStore");

function temporaryDutyFile(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-duty-cmd-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return path.join(directory, "dutyScheduleData.json");
}

test("kiểm tra quy trình Admin quản lý lịch trực đầy đủ", (t) => {
    const filePath = temporaryDutyFile(t);

    // 1. Thêm lịch trực
    const added = addDutySchedule("[25/08] [Nguyễn Văn A - Trần Thị B]", filePath);
    assert.equal(added.id, 1);
    assert.equal(added.dateStr, "25/08");
    assert.equal(added.assigned, "Nguyễn Văn A - Trần Thị B");

    // 2. Tra cứu danh sách
    const list = getDutySchedules(filePath);
    assert.equal(list.length, 1);

    // 3. Sửa lịch trực
    const updated = updateDutySchedule(1, "[25/08] [Nguyễn Văn A - Lê Văn C]", filePath);
    assert.equal(updated.assigned, "Nguyễn Văn A - Lê Văn C");

    // 4. Kiểm tra lịch trực ngày 25/08
    const date25 = new Date("2026-08-25T08:00:00+07:00");
    const todayDuties = getDutyScheduleForDate(date25, filePath);
    assert.equal(todayDuties.length, 1);
    assert.equal(todayDuties[0].assigned, "Nguyễn Văn A - Lê Văn C");

    // 5. Xóa lịch trực
    const deleted = deleteDutySchedule(1, filePath);
    assert.equal(deleted.id, 1);
    assert.equal(getDutySchedules(filePath).length, 0);
});

test("kiểm tra đăng ký và hủy đăng ký thông báo lịch trực /dangkylich", (t) => {
    const {
        disableDutyNotifications,
        enableDutyNotifications,
        getDutySubscriptions
    } = require("../dutyScheduleStore");

    const filePath = temporaryDutyFile(t);
    const context1 = { chatId: "chat_user_1", userDisplayName: "Nguyễn Văn A" };
    const context2 = { chatId: "group_chat_2", chatTitle: "Nhóm Ban Cán Sự" };

    assert.equal(getDutySubscriptions(filePath).length, 0);

    // Đăng ký
    enableDutyNotifications(context1, filePath);
    enableDutyNotifications(context2, filePath);
    const subs = getDutySubscriptions(filePath);
    assert.equal(subs.length, 2);
    assert.equal(subs.some((s) => s.chatId === "chat_user_1"), true);
    assert.equal(subs.some((s) => s.chatId === "group_chat_2"), true);

    // Hủy đăng ký
    assert.equal(disableDutyNotifications(context1, filePath), true);
    assert.equal(getDutySubscriptions(filePath).length, 1);
    assert.equal(getDutySubscriptions(filePath)[0].chatId, "group_chat_2");
});

