const test = require("node:test");
const assert = require("node:assert/strict");

const {
    normalizeTimeToken,
    parseCommandHint,
    parseMultiCommandPlan,
    parseSingleCommand
} = require("../ai/commandNormalizer");

test("chuẩn hoá giờ: một chữ số thành HH:mm, không làm yếu kiểm tra hợp lệ", () => {
    const cases = [
        ["6:00", "06:00"],
        ["06:00", "06:00"],
        ["6h", "06:00"],
        ["6 giờ", "06:00"],
        ["600", "06:00"],
        ["2000", "20:00"],
        ["20:5", "20:05"],
        ["23:59", "23:59"]
    ];
    for (const [input, expected] of cases) {
        assert.equal(normalizeTimeToken(input), expected, `giờ ${input}`);
    }
    for (const bad of ["25:00", "24:00", "12:75", "abc", "", null, "123456789"]) {
        assert.equal(normalizeTimeToken(bad), null, `phải từ chối ${bad}`);
    }
});

test("lệnh có dấu / và không dấu được nhận như nhau", () => {
    const inputs = ["/luumssv 123456789", "luumssv 123456789", "LuuMSSV 123456789", "luumssv [123456789]"];
    for (const input of inputs) {
        assert.deepEqual(parseSingleCommand(input), { command: "luumssv", argument: "123456789" }, input);
    }
});

test("nhanlich nhận mọi cách viết ngày đích và giờ một chữ số", () => {
    const inputs = [
        "nhanlich 06:00 homnay",
        "nhanlich 6:00 hôm nay",
        "NHANLICH 6:00 HOMNAY",
        "nhanlich 20:00 hôm sau"
    ];
    const expectedArguments = ["06:00 homnay", "6:00 hôm nay", "6:00 HOMNAY", "20:00 hôm sau"];
    inputs.forEach((input, index) => {
        assert.deepEqual(parseSingleCommand(input), { command: "nhanlich", argument: expectedArguments[index] }, input);
    });
});

test("một tin chứa nhiều lệnh tạo đúng kế hoạch hành động", () => {
    const plan = parseMultiCommandPlan("luumssv [123456789], nhanlich 6:00 hôm nay, nhanlich 20:00 hôm sau");
    assert.ok(plan, "phải nhận diện được lô lệnh");
    assert.equal(plan.invalid.length, 0);
    assert.deepEqual(
        plan.actions.map((action) => ({ type: action.type, ...action })),
        [
            { type: "save_mssv", student_id: "123456789", sourceCommand: "luumssv", sourceText: "luumssv [123456789]" },
            { type: "register_notification", time: "06:00", target_day: "today", sourceCommand: "nhanlich", sourceText: "nhanlich 6:00 hôm nay" },
            { type: "register_notification", time: "20:00", target_day: "tomorrow", sourceCommand: "nhanlich", sourceText: "nhanlich 20:00 hôm sau" }
        ]
    );
});

test("lô lệnh nhận cả dấu xuống dòng, dấu chấm phẩy và từ nối", () => {
    const newline = parseMultiCommandPlan("luumssv 123456789\nnhanlich 06:00 homnay");
    assert.equal(newline.actions.length, 2);

    const semicolon = parseMultiCommandPlan("luumssv 123456789; nhanlich 06:00 homnay");
    assert.equal(semicolon.actions.length, 2);

    const conjunction = parseMultiCommandPlan("luumssv 123456789 và nhanlich 06:00 homnay");
    assert.equal(conjunction.actions.length, 2);
});

test("lô lệnh báo lỗi từng phần tử thay vì chạy mò", () => {
    const missingStudent = parseMultiCommandPlan("luumssv, nhanlich 06:00 homnay");
    assert.equal(missingStudent.invalid.length, 1);
    assert.equal(missingStudent.invalid[0].error, "missing_student_id");

    const invalidStudent = parseMultiCommandPlan("luumssv 12345, nhanlich 06:00 homnay");
    assert.equal(invalidStudent.invalid[0].error, "invalid_student_id");

    const missingDay = parseMultiCommandPlan("luumssv 123456789, nhanlich 06:00");
    assert.equal(missingDay.invalid[0].error, "missing_target_day");

    const invalidTime = parseMultiCommandPlan("luumssv 123456789, nhanlich 25:00 homnay");
    assert.equal(invalidTime.invalid[0].error, "invalid_time");
});

test("không tách câu khi có đoạn không phải lệnh đã biết", () => {
    // Gõ sai tên lệnh: KHÔNG được đoán rồi chạy.
    assert.equal(parseMultiCommandPlan("luumsv 123456789, nhanlich 6:00 homnay"), null);
    // Lệnh không gộp lô được (nhận văn bản tự do).
    assert.equal(parseMultiCommandPlan("/thongbao bảo trì, /luumssv 123456789"), null);
    // Trộn ngôn ngữ tự nhiên với lệnh.
    assert.equal(parseMultiCommandPlan("tớ muốn lưu mssv 123456789, nhanlich 6:00 homnay"), null);
    // Lệnh lạ hoàn toàn.
    assert.equal(parseMultiCommandPlan("xyz abc, abc xyz"), null);
});

test("không nhận diện lệnh quản trị và lệnh AI khi thiếu dấu /", () => {
    for (const input of ["thongbao nghi bao tri", "update ban moi", "xoachat 123", "blockbot 123", "ai hôm nay học gì"]) {
        assert.equal(parseSingleCommand(input), null, input);
    }
    // Tên lệnh TRÙNG với từ thường ngày không bao giờ được nhận diện thiếu dấu:
    // "lịch mai thế nào" là câu hỏi, không phải lệnh /lich.
    for (const input of ["lịch mai thế nào", "lich mai the nao", "time bay gio", "help me"]) {
        assert.equal(parseSingleCommand(input), null, input);
    }
    // Lệnh có dấu "/" vẫn do parser cũ xử lý — bộ phân tích không dấu cố ý
    // không nhận chúng, để không mở đường cho lệnh quản trị chạy thiếu dấu.
    assert.equal(parseSingleCommand("/thongbao nghi bao tri"), null);
});

test("lệnh trợ giúp và lệnh xem lịch vẫn nhận diện được", () => {
    assert.deepEqual(parseSingleCommand("gionhanlich"), { command: "gionhanlich", argument: "" });
    assert.deepEqual(parseSingleCommand("xoagionhanlich 1"), { command: "xoagionhanlich", argument: "1" });
    assert.deepEqual(parseSingleCommand("lichtuan"), { command: "lichtuan", argument: "" });
});

// Câu nói bình thường KHÔNG được biến thành lệnh chỉ vì hai chữ đầu trùng tên lệnh.
// Đây chính là lỗi đã gặp: "Nhận lịch lúc 9 giờ tối hôm sau" bị đưa sang engine
// lệnh và người dùng nhận "SAI CÚ PHÁP" cho một câu hỏi bình thường.
test("câu nói bắt đầu bằng tên lệnh nhưng đối số không hợp lệ thì không phải lệnh", () => {
    const sentences = [
        "Nhận lịch lúc 9 giờ tối hôm sau",
        "nhận lịch lúc 9h tối hôm sau",
        "luumssv giúp mình với",
        "nhanlich homnay"
    ];
    for (const input of sentences) {
        assert.equal(parseSingleCommand(input), null, `không được chạy như lệnh: ${input}`);
        assert.ok(parseCommandHint(input), `phải nhận ra đây là lệnh gõ thiếu: ${input}`);
    }
});

test("lệnh đủ tham số thì không còn là 'gợi ý' nữa", () => {
    assert.equal(parseCommandHint("luumssv 123456789"), null);
    assert.equal(parseCommandHint("nhanlich 6:00 homnay"), null);
    assert.equal(parseCommandHint("tớ muốn xem lịch"), null);
});
