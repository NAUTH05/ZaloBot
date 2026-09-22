const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

// Kiểm tra thật qua CLI: khi Firestore không khởi tạo được, tiến trình phải
// dừng với mã lỗi và không được bật dashboard, scheduler hay Zalo polling.
test("thiếu file cấu hình Firebase thì dừng với mã lỗi và không chạy runtime", () => {
    const result = spawnSync(process.execPath, ["main.js"], {
        cwd: path.join(__dirname, ".."),
        encoding: "utf8",
        timeout: 60000,
        env: {
            ...process.env,
            NODE_ENV: "production",
            FIREBASE_SERVICE_ACCOUNT_FILE: "./khong-ton-tai-firebase.json"
        }
    });

    const output = `${result.stdout || ""}${result.stderr || ""}`;
    assert.equal(result.status, 1, `mã thoát phải là 1, nhận được ${result.status}\n${output}`);
    assert.match(output, /Không tìm thấy file cấu hình Firebase/);
    assert.match(output, /scheduler và Zalo polling không được bật/);
    assert.ok(!output.includes("[Dashboard] Listening on"), "dashboard không được khởi động");
    assert.ok(!output.includes("[Runtime] Scheduler started"), "scheduler không được khởi động");
    assert.ok(!output.includes("[Runtime] Zalo polling started"), "polling không được khởi động");
});
