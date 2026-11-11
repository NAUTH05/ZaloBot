// ============================================================================
// Khôi phục sổ tương tác sau reset Firestore.
//
// Trọng tâm kiểm tra KHÔNG phải "nhập được nhiều hay ít", mà là:
//   - bản ghi thiếu botId KHÔNG được nhập và KHÔNG bao giờ thành đích phát tin;
//   - bản ghi mâu thuẫn (khóa lệch botId) bị từ chối;
//   - dữ liệu ghi SAU reset không bị ghi đè, chỉ được báo cáo là va chạm;
//   - khóa lưu trữ đúng quy tắc bot1 giữ khóa trần, danh tính khác có tiền tố;
//   - không rò rỉ chatId/userId ra log (chỉ dùng vân tay rút gọn).
// ============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    UNVERIFIED_LABEL,
    classifySourceRecords,
    countByBot,
    fingerprint,
    interactionStorageKey,
    mergeImport,
    normalizeSourceRecords,
    parseArgs,
    planImport,
    readSourceFile
} = require("../scripts/recoverInteractions");

const CHAT_A = "chat-alpha";
const CHAT_B = "chat-beta";
const ZCA_ID = "zca:700700700";

/* -------------------------------------------------------------------------- */
/* Phân loại nguồn: chỉ nhập bản ghi có quyền sở hữu tường minh                */
/* -------------------------------------------------------------------------- */

test("bản ghi thiếu botId KHÔNG được nhập và bị báo là chưa xác minh", () => {
    const source = {
        [CHAT_A]: { chatId: CHAT_A, botId: "bot1", chatType: "private" },
        [CHAT_B]: { chatId: CHAT_B, chatType: "private" } // không có botId
    };

    const { importable, rejected, perBot } = classifySourceRecords(source);

    assert.equal(importable.length, 1, "chỉ bản ghi có botId tường minh được nhập");
    assert.equal(importable[0].botId, "bot1");
    assert.deepEqual(perBot, { bot1: 1 });
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].chatId, CHAT_B);
    assert.match(rejected[0].reason, /không khai báo botId/);
});

test("botId sai định dạng bị từ chối, không đoán bot1", () => {
    const source = {
        "chat-x": { chatId: "chat-x", botId: "bot-1" }, // sai định dạng (có gạch ngang)
        "chat-y": { chatId: "chat-y", botId: "chính" }, // không phải danh tính nào
        "chat-z": { chatId: "chat-z", botId: "zca:" } // thiếu UID
    };

    const { importable, rejected } = classifySourceRecords(source);

    assert.equal(importable.length, 0);
    assert.equal(rejected.length, 3, "cả ba đều là danh tính không hợp lệ");
    for (const item of rejected) assert.match(item.reason, /không khai báo botId/);
});

test("botId hợp lệ về cú pháp nhưng bot chưa cấu hình vẫn được nhập (sẽ bị bỏ qua khi gửi)", () => {
    // bot9 đúng cú pháp botN. Script không phán xét việc nó có đang bật hay không:
    // đích của bot đang tắt được getBroadcastTargets() bỏ qua an toàn.
    const { importable, rejected } = classifySourceRecords({
        [`bot9::${CHAT_A}`]: { chatId: CHAT_A, botId: "bot9" }
    });

    assert.equal(importable.length, 1);
    assert.equal(importable[0].botId, "bot9");
    assert.equal(rejected.length, 0);
});

test("khóa có tiền tố botN:: được ghi vào đúng không gian khóa", () => {
    const source = {
        [`${ZCA_ID}::${CHAT_B}`]: { chatId: CHAT_B, botId: ZCA_ID }
    };

    const { importable } = classifySourceRecords(source);

    assert.equal(importable.length, 1);
    assert.equal(importable[0].key, interactionStorageKey(ZCA_ID, CHAT_B));
    assert.equal(importable[0].key, `${ZCA_ID}::${CHAT_B}`);
});

test("khóa lệch với botId là MÂU THUẪN và bị từ chối", () => {
    // Khóa nói bot2 nhưng trường botId nói bot1: không có căn cứ nào để chọn.
    const source = {
        [`bot2::${CHAT_A}`]: { chatId: CHAT_A, botId: "bot1" }
    };

    const { importable, rejected } = classifySourceRecords(source);

    assert.equal(importable.length, 0, "không được tự chọn một trong hai nguồn mâu thuẫn");
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /lệch với botId/);
});

test("bot1 giữ khóa trần, danh tính khác có tiền tố", () => {
    assert.equal(interactionStorageKey("bot1", CHAT_A), CHAT_A);
    assert.equal(interactionStorageKey("bot2", CHAT_A), `bot2::${CHAT_A}`);
    assert.equal(interactionStorageKey(ZCA_ID, CHAT_A), `${ZCA_ID}::${CHAT_A}`);
});

test("cùng (botId, chatId) trùng trong file nguồn: giữ bản đầu, báo bản sau", () => {
    const source = [
        { chatId: CHAT_A, botId: "bot1", chatTitle: "lần đầu" },
        { chatId: CHAT_A, botId: "bot1", chatTitle: "lần sau" }
    ];

    const { importable, rejected } = classifySourceRecords(source);

    assert.equal(importable.length, 1);
    assert.equal(importable[0].record.chatTitle, "lần đầu");
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /trùng lặp/);
});

test("cùng chatId ở hai bot là HAI bản ghi, không bị coi là trùng", () => {
    const source = {
        [CHAT_A]: { chatId: CHAT_A, botId: "bot1" },
        [`${ZCA_ID}::${CHAT_A}`]: { chatId: CHAT_A, botId: ZCA_ID }
    };

    const { importable } = classifySourceRecords(source);

    assert.equal(importable.length, 2, "cùng Chat ID nhưng khác tài khoản là hai cuộc trò chuyện");
    assert.deepEqual(
        importable.map((item) => item.botId).sort(),
        ["bot1", ZCA_ID].sort()
    );
});

test("bản ghi không phải object hoặc thiếu chatId bị bỏ qua, không ném lỗi", () => {
    assert.deepEqual(normalizeSourceRecords(null), []);
    assert.deepEqual(normalizeSourceRecords("không phải object"), []);
    assert.deepEqual(classifySourceRecords({ a: 1, b: null }).importable.length, 0);
    const { rejected } = classifySourceRecords({ a: { botId: "bot1" } });
    assert.equal(rejected[0].reason, "thiếu chatId");
});

/* -------------------------------------------------------------------------- */
/* Kế hoạch nhập: bảo toàn dữ liệu ghi sau reset                               */
/* -------------------------------------------------------------------------- */

test("bản ghi đã có trong sổ hiện tại KHÔNG bị ghi đè, chỉ báo va chạm", () => {
    const current = {
        "chat-khac": { chatId: "chat-khac", botId: "bot1", chatTitle: "không liên quan" }
    };
    // Sổ hiện tại đã có CHAT_A do bot ghi sau reset, với nội dung mới hơn.
    current[interactionStorageKey("bot1", CHAT_A)] = {
        chatId: CHAT_A,
        botId: "bot1",
        chatTitle: "ghi sau reset",
        lastInteractionAt: "2027-01-01T00:00:00.000Z"
    };

    const source = {
        [CHAT_A]: { chatId: CHAT_A, botId: "bot1", chatTitle: "bản cũ khôi phục" },
        [CHAT_B]: { chatId: CHAT_B, botId: "bot1", chatTitle: "bản mới" }
    };
    const { importable } = classifySourceRecords(source);

    const { toAdd, collisions } = planImport(current, importable);

    assert.equal(collisions.length, 1, "bản ghi đã tồn tại phải được báo là va chạm");
    assert.equal(collisions[0].chatId, CHAT_A);
    assert.equal(toAdd.length, 1, "chỉ bản ghi vắng mặt mới được thêm");
    assert.equal(toAdd[0].chatId, CHAT_B);

    const merged = mergeImport(current, toAdd);
    assert.equal(merged[interactionStorageKey("bot1", CHAT_A)].chatTitle, "ghi sau reset", "dữ liệu mới phải được giữ nguyên");
    assert.equal(merged[interactionStorageKey("bot1", CHAT_B)].chatTitle, "bản mới");
});

test("trộn không mất bản ghi cũ nào và không sửa bản ghi nguồn tại chỗ", () => {
    const current = { "chat-keep": { chatId: "chat-keep", botId: "bot1", chatTitle: "giữ" } };
    const item = { botId: "bot1", chatId: CHAT_B, key: CHAT_B, record: { chatId: CHAT_B, botId: "bot1", chatTitle: "mới" } };

    const merged = mergeImport(current, [item]);

    assert.equal(Object.keys(merged).length, 2);
    assert.equal(merged["chat-keep"].chatTitle, "giữ");
    // Bản ghi nguồn không bị sửa tại chỗ.
    assert.equal(Object.prototype.hasOwnProperty.call(item.record, "botId") && item.record.botId, "bot1");
    assert.equal(current[CHAT_B], undefined, "sổ hiện tại không bị sửa tại chỗ");
});

/* -------------------------------------------------------------------------- */
/* Đếm theo bot để báo cáo                                                     */
/* -------------------------------------------------------------------------- */

test("đếm theo bot gom bản ghi thiếu botId vào nhãn chưa xác minh", () => {
    const store = {
        [CHAT_A]: { chatId: CHAT_A, botId: "bot1" },
        [`bot2::${CHAT_B}`]: { chatId: CHAT_B, botId: "bot2" },
        [`${ZCA_ID}::${CHAT_A}`]: { chatId: CHAT_A, botId: ZCA_ID },
        "chat-mo-ho": { chatId: "chat-mo-ho" }
    };

    const counts = countByBot(store);

    assert.equal(counts.bot1, 1);
    assert.equal(counts.bot2, 1);
    assert.equal(counts[ZCA_ID], 1);
    assert.equal(counts[UNVERIFIED_LABEL], 1, "bản ghi thiếu botId phải được đếm riêng, không gán cho bot1");
    assert.equal(Object.prototype.hasOwnProperty.call(counts, "bot1") && counts.bot1 === 1, true);
});

test("đếm theo bot chịu được payload hỏng", () => {
    assert.deepEqual(countByBot(null), {});
    assert.deepEqual(countByBot([]), {});
    assert.deepEqual(countByBot("không phải object"), {});
});

/* -------------------------------------------------------------------------- */
/* Không rò rỉ danh tính người nhận                                            */
/* -------------------------------------------------------------------------- */

test("vân tay rút gọn không chứa ID gốc và ổn định", () => {
    const mark = fingerprint(CHAT_A);

    assert.equal(mark.includes(CHAT_A), false, "không được để lộ chatId trong log");
    assert.equal(mark, fingerprint(CHAT_A), "cùng đầu vào phải cho cùng vân tay");
    assert.notEqual(mark, fingerprint(CHAT_B));
    assert.equal(fingerprint(""), "(trống)", "giá trị rỗng vẫn có nhãn thay thế thay vì khoảng trắng khó đọc");
});

/* -------------------------------------------------------------------------- */
/* Tham số dòng lệnh và đọc file                                               */
/* -------------------------------------------------------------------------- */

test("mặc định là dry-run, chỉ --apply mới ghi", () => {
    assert.equal(parseArgs([]).apply, false);
    assert.equal(parseArgs(["--source", "x.json"]).apply, false);
    assert.equal(parseArgs(["--apply"]).apply, true);
    assert.equal(parseArgs(["--apply", "--source", "x.json"]).apply, true);
});

test("đường dẫn nguồn lấy từ --source, mặc định là recovered-interactions.json", () => {
    assert.match(parseArgs([]).source, /recovered-interactions\.json$/);
    assert.equal(parseArgs(["--source", "custom.json"]).source, "custom.json");
    assert.equal(parseArgs(["-s", "custom.json"]).source, "custom.json");
});

test("file nguồn thiếu hoặc JSON hỏng báo lỗi rõ ràng", () => {
    assert.throws(() => readSourceFile(path.join(os.tmpdir(), "khong-ton-tai-12345.json")), /Không tìm thấy file khôi phục/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recover-source-"));
    try {
        const broken = path.join(dir, "broken.json");
        fs.writeFileSync(broken, "{ không phải json", "utf8");
        assert.throws(() => readSourceFile(broken), /không phải JSON hợp lệ/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* Đầu-cuối: nguồn 242 bản ghi có 46 bản ghi chưa xác minh                     */
/* -------------------------------------------------------------------------- */

test("nguồn giống thực tế: 46 bản ghi chưa xác minh bị loại khỏi đường gửi", () => {
    // Mô phỏng hình dạng nguồn khôi phục: phần lớn có botId, phần còn lại thì không.
    const source = {};
    const verified = [
        { botId: "bot1", count: 5 },
        { botId: "bot2", count: 4 },
        { botId: "bot3", count: 3 },
        { botId: ZCA_ID, count: 2 }
    ];
    verified.forEach(({ botId, count }) => {
        for (let index = 0; index < count; index += 1) {
            const chatId = `${botId}-chat-${index}`;
            const key = interactionStorageKey(botId, chatId);
            source[key] = { chatId, botId, chatType: "private" };
        }
    });
    for (let index = 0; index < 6; index += 1) {
        const chatId = `unknown-chat-${index}`;
        source[chatId] = { chatId, chatType: "private" }; // cố ý thiếu botId
    }

    const { importable, rejected, perBot } = classifySourceRecords(source);

    assert.equal(importable.length, 14);
    assert.deepEqual(perBot, { bot1: 5, bot2: 4, bot3: 3, [ZCA_ID]: 2 });
    assert.equal(rejected.length, 6, "bản ghi chưa xác minh không được nhập");

    // Không bản ghi chưa xác minh nào lọt vào danh sách nhập.
    for (const item of importable) {
        assert.notEqual(item.botId, UNVERIFIED_LABEL);
        assert.match(item.botId, /^(bot\d+|zca:.+)$/);
    }
});
