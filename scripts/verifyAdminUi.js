// Kiểm tra tĩnh cho giao diện dashboard: asset đầy đủ, không phụ thuộc UI bên
// ngoài, theme sáng/tối, chuyển động có tôn trọng prefers-reduced-motion, biến
// CSS không bị dùng mà chưa khai báo, và Command console có đủ trường target.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "admin-ui");
const files = ["index.html", "app.js", "styles.css", "admin-controls.css"];

function fail(message) {
    throw new Error(`Admin UI validation failed: ${message}`);
}

function read(file) {
    const full = path.join(root, file);
    if (!fs.existsSync(full) || fs.statSync(full).size === 0) fail(`missing asset ${file}`);
    return fs.readFileSync(full, "utf8");
}

const sources = Object.fromEntries(files.map((file) => [file, read(file)]));
const html = sources["index.html"];
const app = sources["app.js"];
const styles = sources["styles.css"];
const css = `${styles}\n${sources["admin-controls.css"]}`;

if (!html.includes('<base href="./"')) fail("index.html must use a relative base path");

// Không kéo thêm thư viện UI ngoài: mọi asset phải là tệp cục bộ.
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const target = match[1];
    if (/^(https?:)?\/\//i.test(target)) fail(`external asset is not allowed: ${target}`);
}
if (/cdn\.|unpkg|jsdelivr|bootstrap|tailwind/i.test(html)) fail("index.html must not depend on an external UI framework");

// Hai theme và chuyển động có thể tắt.
if (!/^:root\s*\{/m.test(styles)) fail("styles.css must define design tokens on :root");
if (!/html\[data-theme="dark"\]/.test(styles)) fail("styles.css must define the dark theme");
if (!css.includes("prefers-reduced-motion")) fail("styles.css must honour prefers-reduced-motion");
for (const token of ["--accent", "--surface", "--border", "--text", "--muted", "--ease"]) {
    if (!new RegExp(`${token}\\s*:`).test(css)) fail(`missing design token ${token}`);
}

// Mọi biến CSS được dùng đều phải được khai báo.
const defined = new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((match) => match[1]));
const used = new Set([...css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((match) => match[1]));
const undefinedTokens = [...used].filter((token) => !defined.has(token));
if (undefinedTokens.length) fail(`undefined CSS variables: ${undefinedTokens.join(", ")}`);

// Cấu trúc dashboard mà app.js thao tác trực tiếp vẫn phải tồn tại.
const requiredIds = ["loginView", "dashboardView", "loginForm", "loginError", "tabNav", "commandForm", "detailDialog", "appStatus", "metricGrid", "refreshButton", "logoutButton", "botFilter", "botGrid", "commandBot"];
for (const id of requiredIds) {
    if (!html.includes(`id="${id}"`)) fail(`index.html is missing #${id}`);
}

// Command console: chọn nhiều người nhận. Khóa gửi lên là mảng User ID thật.
if (!app.includes('id="targetUserInput"')) fail("Command console must render the target user combobox input");
if (!app.includes("combobox-list")) fail("Command console must render the combobox option list");
if (!app.includes('role="combobox"')) fail("the target user input must expose the combobox role");
if (!app.includes("aria-activedescendant")) fail("the combobox must support keyboard navigation");
if (!app.includes("/api/admin/target-users")) fail("the Command console must load the deduplicated target user list");
if (!app.includes("targetUserIds")) fail("Command console must post an array of target User IDs");
if (!app.includes('id="targetChips"')) fail("Command console must render removable chips for the selected users");
if (!app.includes('id="targetSelectAll"')) fail("Command console must offer select-all-filtered");
if (!app.includes('id="targetClearAll"')) fail("Command console must offer clear-selection");
if (!app.includes('id="targetCount"')) fail("Command console must show the selected count");
if (!app.includes('id="batchConfirm"')) fail("Command console must confirm before executing a batch");
if (!app.includes("progress-track")) fail("Command console must show batch progress");

// Phân loại đích phải lấy từ server (commandRegistry trả kèm `targeting`), không
// giữ bản sao danh sách lệnh trong giao diện — bản sao sẽ lệch khi lệnh đổi tên.
if (!app.includes("entry.targeting")) fail("Command console must read targeting from the command registry");
if (/\bperUserName\b|\bbroadcastNames\b/.test(app)) fail("Command console must not keep a local copy of the per-user/broadcast command lists");

// Nhiều bot: dashboard phải lọc theo bot và bắt buộc chọn bot khi gửi. Chat ID và
// User ID chỉ có nghĩa trong phạm vi một bot, nên thiếu hai thứ này là lỗi đúng đắn.
if (!app.includes("/api/admin/bots")) fail("Dashboard must load the bot list from /api/admin/bots");
if (!app.includes("function filterByBot")) fail("Dashboard must filter lists by bot");
if (!app.includes("function botBadge")) fail("Dashboard must label which bot a record belongs to");
// Cột Bot riêng trên bảng Users và Chat directory, không chỉ nhãn trong ô khác.
if (!app.includes("function botCell")) fail("Dashboard must render a Bot column");
if (!app.includes("${botCell(")) fail("Users and Chat directory rows must use the Bot column");
// Thao tác quản trị phải báo lỗi ra giao diện thay vì để Promise bị từ chối âm thầm.
if (!app.includes("async function runAction")) fail("Dashboard actions must be wrapped so failures are reported");
if (!/data-chat-bot|data-user-bot/.test(app)) fail("Row actions must carry the bot id");
// Bộ chọn người nhận không được gộp hai bot làm một.
if (!app.includes("const keyOf = (user)")) fail("Target user merging must key by (bot, user), not userId alone");
if (!app.includes("botLabel(recordBotId(user))")) fail("Target user options must show which bot they belong to");
if (!app.includes("function renderBotGrid")) fail("Dashboard must show per-bot status");
if (!app.includes("data-chat-bot")) fail("Chat row actions must carry the bot id, or a bot-2 chat opens bot-1's record");
if (!app.includes("botId: recordBotId(")) fail("Chat and subscription writes must send the bot id");
// Lệnh gửi tin phải có bot, và người nhận phải thuộc đúng bot đó.
if (!app.includes('$("#commandBot")')) fail("Command console must require an explicit bot selection");
if (!app.includes("item.botId !== botId")) fail("Command console must refuse recipients that belong to another bot");
if (!app.includes("botId,") || !app.includes("targetUserIds")) fail("Batch payload must include the bot id");

// Ô Target Chat ID rời đã bị bỏ: Chat ID chỉ được suy ra khi liên kết đủ tin cậy,
// không còn là trường nhập tay không có tác dụng.
if (app.includes('name="targetChatId"')) fail("Command console must not post a standalone targetChatId");

// Command console đi qua endpoint nhiều người nhận và vẫn giữ endpoint cũ cho
// client chỉ gửi một targetUserId.
if (!app.includes('api("/api/admin/commands/batch"')) fail("Command console must post batches to /api/admin/commands/batch");
if (!app.includes("/api/admin/commands/batch/")) fail("Command console must poll the batch job endpoint");

console.log("Admin UI validation passed");
