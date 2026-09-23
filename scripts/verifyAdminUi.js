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
const requiredIds = ["loginView", "dashboardView", "loginForm", "loginError", "tabNav", "commandForm", "detailDialog", "appStatus", "metricGrid", "refreshButton", "logoutButton"];
for (const id of requiredIds) {
    if (!html.includes(`id="${id}"`)) fail(`index.html is missing #${id}`);
}

// Command console: ô User ID dùng combobox, khóa gửi lên vẫn là targetUserId.
if (!app.includes('name="targetUserId"')) fail("Command console must post targetUserId");
if (!app.includes('name="targetChatId"')) fail("Command console must post targetChatId");
if (!app.includes('id="targetUserInput"')) fail("Command console must render the target user combobox input");
if (!app.includes("combobox-list")) fail("Command console must render the combobox option list");
if (!app.includes('role="combobox"')) fail("the target user input must expose the combobox role");
if (!app.includes("aria-activedescendant")) fail("the combobox must support keyboard navigation");
if (!app.includes("/api/admin/target-users")) fail("the Command console must load the deduplicated target user list");

// Command console vẫn gửi đúng endpoint hiện có.
if (!app.includes('api("/api/admin/commands"')) fail("Command console must keep posting to /api/admin/commands");

console.log("Admin UI validation passed");
