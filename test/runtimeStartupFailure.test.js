const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// Sandbox có thể chặn spawn tiến trình con (EBUSY/EPERM). Khi đó bài kiểm tra
// KHÔNG chạy được — và điều đó khác hoàn toàn với "ứng dụng hỏng".
//
// Trước đây trường hợp này báo lỗi "mã thoát phải là 1, nhận được null", trông như
// lỗi sản phẩm nhưng thực ra là giới hạn môi trường. Nay phân biệt rõ hai thứ, và
// phần kiểm tra thật vẫn được chạy trong tiến trình ở các bài bên dưới.
function spawnBlocked(result) {
    return Boolean(result.error) && ["EBUSY", "EPERM", "EACCES", "ENOENT"].includes(result.error.code);
}

// Kiểm tra thật qua CLI: khi Firestore không khởi tạo được, tiến trình phải
// dừng với mã lỗi và không được bật dashboard, scheduler hay Zalo polling.
test("thiếu file cấu hình Firebase thì dừng với mã lỗi và không chạy runtime", (t) => {
    const result = spawnSync(process.execPath, ["main.js"], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60000,
        env: {
            ...process.env,
            NODE_ENV: "production",
            // Ghim token để bài kiểm tra không phụ thuộc nội dung .env của máy
            // đang chạy: nếu thiếu, lỗi cấu hình bot sẽ ném TRƯỚC khi tới bước
            // Firebase và bài này sẽ báo sai nguyên nhân.
            BOT_TOKEN: "test-token-startup-failure",
            FIREBASE_SERVICE_ACCOUNT_FILE: "./khong-ton-tai-firebase.json"
        }
    });

    if (spawnBlocked(result)) {
        // Nêu rõ lý do để không ai đọc nhầm thành lỗi sản phẩm.
        t.skip(`Không spawn được tiến trình con trong môi trường này (${result.error.code}); ` +
            "bài này cần chạy trên VPS/máy thật. Phần logic tương ứng được kiểm tra " +
            "trong tiến trình ở các bài bên dưới.");
        return;
    }

    const output = `${result.stdout || ""}${result.stderr || ""}`;
    assert.equal(result.status, 1, `mã thoát phải là 1, nhận được ${result.status}\n${output}`);
    assert.match(output, /Không tìm thấy file cấu hình Firebase/);
    assert.match(output, /scheduler và Zalo polling không được bật/);
    assert.ok(!output.includes("[Dashboard] Listening on"), "dashboard không được khởi động");
    assert.ok(!output.includes("[Runtime] Scheduler started"), "scheduler không được khởi động");
    assert.ok(!output.includes("[Runtime] Zalo polling started"), "polling không được khởi động");
});

// Không có danh tính nào chạy được (không token bot, ZCA tắt) ⇒ vẫn phải dừng.
// Chạy tiếp chỉ tạo ra một tiến trình "đang chạy" mà không nhận được tin nào.
test("không có token bot và ZCA tắt thì dừng với thông điệp rõ ràng", (t) => {
    const result = spawnSync(process.execPath, ["main.js"], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60000,
        env: {
            ...process.env,
            // Chuỗi toàn khoảng trắng: có mặt trong env nên dotenv KHÔNG ghi đè,
            // nhưng resolveBotConfigs trim thành rỗng ⇒ coi như không có token.
            BOT_TOKEN: "   ",
            BOT_1_TOKEN: "   ",
            ZCA_ENABLED: "false",
            NODE_ENV: "production"
        }
    });

    if (spawnBlocked(result)) {
        t.skip(`Không spawn được tiến trình con trong môi trường này (${result.error.code}).`);
        return;
    }

    const output = `${result.stdout || ""}${result.stderr || ""}`;
    assert.equal(result.status, 1, `mã thoát phải là 1, nhận được ${result.status}\n${output}`);
    assert.match(output, /Không có danh tính nào hoạt động/);
    assert.ok(!output.includes("[Dashboard] Listening on"), "dashboard không được khởi động");
});

// Thiếu token bot 1 KHÔNG còn chặn khởi động khi ZCA bật: tiến trình phải đi tiếp
// tới bước Firebase (và chỉ hỏng vì file Firebase cố tình sai trong bài này).
test("thiếu token bot 1 nhưng ZCA bật thì không bị chặn ở cổng danh tính", (t) => {
    const result = spawnSync(process.execPath, ["main.js"], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60000,
        env: {
            ...process.env,
            BOT_TOKEN: "   ",
            BOT_1_TOKEN: "   ",
            ZCA_ENABLED: "true",
            NODE_ENV: "production",
            FIREBASE_SERVICE_ACCOUNT_FILE: "./khong-ton-tai-firebase.json"
        }
    });

    if (spawnBlocked(result)) {
        t.skip(`Không spawn được tiến trình con trong môi trường này (${result.error.code}).`);
        return;
    }

    const output = `${result.stdout || ""}${result.stderr || ""}`;
    assert.ok(!/Không có danh tính nào hoạt động/.test(output), "không được chặn khi ZCA đang bật");
    assert.ok(!/Thiếu token cho bot 1/.test(output), "thiếu token bot 1 chỉ là cảnh báo");
    assert.match(output, /\[Bots\] bot1 đang tắt/, "phải cảnh báo rõ bot 1 đang tắt");
    assert.match(output, /Không tìm thấy file cấu hình Firebase/, "phải đi tiếp tới bước Firebase");
});

// Cùng hành vi, kiểm tra TRONG TIẾN TRÌNH — chạy được cả khi sandbox chặn spawn.
test("cấu hình Firebase thiếu thì khởi tạo persistence thất bại rõ ràng", async () => {    const persistence = require("../firestorePersistence");
    const previous = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
    process.env.FIREBASE_SERVICE_ACCOUNT_FILE = "./khong-ton-tai-firebase.json";
    try {
        await assert.rejects(
            () => persistence.initializeFirestorePersistence({ storeIds: ["chatDirectory"] }),
            (error) => {
                assert.match(error.message, /Không tìm thấy file cấu hình Firebase/);
                return true;
            }
        );
    } finally {
        if (previous === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
        else process.env.FIREBASE_SERVICE_ACCOUNT_FILE = previous;
    }
});

test("main.js dừng khởi động và thoát mã lỗi khi Firestore không khởi tạo được", () => {
    // Không spawn được tiến trình trong môi trường này, nên kiểm tra CẤU TRÚC của
    // đường xử lý lỗi: phải ghi log dừng rõ ràng, ném tiếp lỗi, và thoát mã 1.
    // Bài kiểm tra qua CLI ở trên sẽ chạy đầy đủ trên VPS/máy thật.
    const source = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");

    assert.match(source, /Dừng khởi động: scheduler và Zalo polling không được bật/,
        "phải nói rõ runtime không được bật");
    // Lỗi khởi tạo phải được ném tiếp để lớp gọi dừng tiến trình.
    assert.match(source, /Không thể khởi tạo Firestore[\s\S]{0,200}throw error;/,
        "phải ném tiếp lỗi khởi tạo");
    // Và lớp gọi phải thoát với mã lỗi, KHÔNG chạy nền bằng JSON cục bộ.
    assert.match(source, /startRuntime\(\)\.catch[\s\S]{0,400}process\.exit\(1\)/,
        "khởi động thất bại phải thoát mã 1");
});
