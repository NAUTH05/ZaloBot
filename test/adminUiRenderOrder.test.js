// ============================================================================
// Thứ tự khai báo trong các hàm vẽ giao diện của admin-ui/app.js
//
// Lỗi thật đã xảy ra hai lần:
//   1. `chatStream` — khôi phục tab chạy trước khi khối `let` được khởi tạo.
//   2. `welcomed` — dùng trong template literal TRƯỚC dòng `const welcomed = ...`.
//      Vì lỗi ném trong .then() của lần đồng bộ nên giao diện báo
//      "Đồng bộ thất bại: Cannot access 'welcomed' before initialization".
//
// `node --check` chỉ kiểm cú pháp nên không bắt được vùng tạm thời chết (TDZ).
// Bài này chốt bằng cách kiểm tra thứ tự ngay trong tệp nguồn.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const APP_PATH = path.join(__dirname, "..", "admin-ui", "app.js");
const source = fs.readFileSync(APP_PATH, "utf8");

// Lấy thân một hàm.
//
// Phải bỏ qua danh sách tham số trước: `function renderX(record, options = {})`
// có một cặp ngoặc nhọn NGAY TRONG tham số, nên "dấu { đầu tiên" không phải thân hàm.
function functionBody(name) {
    const start = source.indexOf(`function ${name}(`);
    if (start < 0) return null;

    const parenStart = source.indexOf("(", start);
    if (parenStart < 0) return null;
    let parenDepth = 0;
    let parenEnd = -1;
    for (let index = parenStart; index < source.length; index += 1) {
        if (source[index] === "(") parenDepth += 1;
        else if (source[index] === ")") {
            parenDepth -= 1;
            if (parenDepth === 0) { parenEnd = index; break; }
        }
    }
    if (parenEnd < 0) return null;

    const braceStart = source.indexOf("{", parenEnd);
    if (braceStart < 0) return null;
    let depth = 0;
    for (let index = braceStart; index < source.length; index += 1) {
        const char = source[index];
        if (char === "{") depth += 1;
        else if (char === "}") {
            depth -= 1;
            if (depth === 0) return source.slice(braceStart, index + 1);
        }
    }
    return null;
}

// Tên các hàm vẽ của tab Friend Requests. Giới hạn ở đây để không báo nhầm những
// chỗ dùng biến trong closure được gọi muộn (hợp lệ).
const RENDER_FUNCTIONS = [
    "renderFriendRequestCard",
    "renderFriendRequests",
    "renderFriendRequestBanner",
    "renderFriendRequestSettings",
    "renderFriendRequestChannels"
];

test("không dùng biến trước khi khai báo trong các hàm vẽ Friend Requests", () => {
    const problems = [];

    for (const name of RENDER_FUNCTIONS) {
        const body = functionBody(name);
        assert.ok(body, `không tìm thấy hàm ${name}`);

        // Chỉ xét phần BÊN TRONG ${...} của template literal.
        //
        // Nếu quét cả chuỗi HTML thô thì thuộc tính `value="..."` hay
        // `candidate.source` sẽ bị coi là "dùng biến" và báo nhầm — chữ trong HTML
        // không phải mã, chỉ phần nội suy mới chạy.
        const interpolations = [...body.matchAll(/\$\{([^{}]*)\}/g)]
            .map((match) => ({ text: match[1], index: match.index }));

        const declarations = [...body.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/g)];
        for (const declaration of declarations) {
            const identifier = declaration[1];
            const declaredAt = declaration.index;

            // `(?<!\.)` để `candidate.source` không bị coi là dùng biến `source`:
            // tên thuộc tính không phải biến.
            const pattern = new RegExp(`(?<!\\.)\\b${identifier.replace(/\$/g, "\\$")}\\b`);
            const firstUse = interpolations.find((item) => pattern.test(item.text));

            if (firstUse && firstUse.index < declaredAt) {
                problems.push(`${name}: "${identifier}" được dùng trong \${...} ở vị trí ${firstUse.index} nhưng khai báo ở ${declaredAt}`);
            }
        }
    }

    assert.deepEqual(problems, [], `TDZ — dùng biến trước khi khai báo sẽ làm cả bảng không vẽ được:\n${problems.join("\n")}`);
});

test("mọi giá trị dẫn xuất của thẻ lời mời được khai báo trước chuỗi HTML", () => {
    const body = functionBody("renderFriendRequestCard");
    assert.ok(body);

    const actionsAt = body.indexOf("const actions =");
    assert.notEqual(actionsAt, -1, "phải có const actions");

    // Mọi const/let khác phải đứng trước `const actions`, trừ những biến chỉ dùng
    // trong phần return (acted, method) — chúng không xuất hiện trong template của actions.
    for (const name of ["canWelcome", "welcomeStatus", "welcomeButton", "acceptReject", "operable", "busy"]) {
        const at = body.search(new RegExp(`\\b(?:const|let)\\s+${name}\\s*=`));
        assert.notEqual(at, -1, `thiếu khai báo ${name}`);
        assert.ok(at < actionsAt, `${name} phải được khai báo trước const actions`);
    }
});

test("nhãn nút tin chào dựa trên trạng thái thông báo, không phải bản ghi", () => {
    const body = functionBody("renderFriendRequestCard");
    assert.ok(body);

    // Lỗi cũ: `welcomed === "sent"` — welcomed là BẢN GHI nên luôn sai, nhãn không
    // bao giờ đổi thành "Gửi lại tin chào".
    assert.ok(!/welcomed\s*===\s*"sent"/.test(body), "không được so sánh bản ghi với chuỗi trạng thái");
    assert.ok(/welcomeStatus\s*===\s*"sent"/.test(body), "phải so sánh trạng thái thông báo");
});

test("hộp thoại chưa xác minh nguồn phải mở được đường xác minh, không chỉ báo lỗi", () => {
    const body = functionBody("requireVerifiedSource");
    assert.ok(body, "phải có hàm requireVerifiedSource");

    // Bản trước chỉ nói "chạy npm run migrate:attribution" nên người dùng bị kẹt:
    // nút "Xác minh nguồn" nằm ngay trên dòng nhưng hộp thoại không nhắc tới.
    assert.match(body, /data-open-verify/, "phải có nút mở phần xác minh nguồn");
    assert.match(body, /openVerifySource\(/, "nút phải thực sự gọi openVerifySource");
    assert.match(body, /Xác minh nguồn/, "phải nói rõ nút nằm ở cột thao tác của dòng");
});

test("hai chỗ chặn thao tác đều truyền bản ghi để hộp thoại có bằng chứng", () => {
    for (const [name, call] of [["openUser", "requireVerifiedSource(wantedBot, \"người dùng này\", user)"],
                                ["openChat", "requireVerifiedSource(verifiedBotId, \"cuộc trò chuyện này\", chatRecord)"]]) {
        const body = functionBody(name);
        assert.ok(body, `thiếu ${name}`);
        assert.ok(body.includes(call), `${name} phải truyền bản ghi vào cổng xác minh`);
    }
});
