const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    addQuestion,
    answerQuestion,
    deleteQuestion,
    getQuestions,
    isBirthdayDate,
    markInvitationSent,
    markResultSent,
    updateQuestion,
    wasInvitationSent,
    wasResultSent
} = require("../birthdayStore");

function temporaryFile(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zalobot-birthday-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return path.join(directory, "birthdayData.json");
}

test("chỉ nhận diện đúng ngày sinh nhật 27/08", () => {
    assert.equal(isBirthdayDate({ day: "27", month: "08" }), true);
    assert.equal(isBirthdayDate({ day: "26", month: "08" }), false);
    assert.equal(isBirthdayDate({ day: "27", month: "09" }), false);
});

test("thêm, sửa, trả lời và xóa câu hỏi theo ID", (t) => {
    const filePath = temporaryFile(t);
    const date = new Date("2026-08-27T01:00:00.000Z");
    const created = addQuestion({
        year: 2026,
        text: "Câu hỏi đầu tiên?",
        author: { userId: "u1", displayName: "An", chatId: "c1" }
    }, date, filePath);

    assert.equal(created.id, 1);
    assert.equal(updateQuestion(1, "Câu hỏi đã sửa?", date, filePath).text, "Câu hỏi đã sửa?");
    assert.equal(answerQuestion(1, "Câu trả lời", date, filePath).answer, "Câu trả lời");
    assert.equal(getQuestions(2026, filePath).length, 1);
    assert.equal(deleteQuestion(1, filePath).id, 1);
    assert.deepEqual(getQuestions(2026, filePath), []);
});

test("lưu dấu gửi riêng theo năm, chat và nội dung công bố", (t) => {
    const filePath = temporaryFile(t);
    const date = new Date("2026-08-27T01:00:00.000Z");

    assert.equal(wasInvitationSent(2026, "chat-1", filePath), false);
    markInvitationSent(2026, "chat-1", date, filePath);
    assert.equal(wasInvitationSent(2026, "chat-1", filePath), true);
    assert.equal(wasInvitationSent(2027, "chat-1", filePath), false);

    markResultSent(2026, "chat-1", "digest-a", date, filePath);
    assert.equal(wasResultSent(2026, "chat-1", "digest-a", filePath), true);
    assert.equal(wasResultSent(2026, "chat-1", "digest-b", filePath), false);
});
