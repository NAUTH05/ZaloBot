const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "admin-ui");
for (const file of ["index.html", "app.js", "styles.css", "admin-controls.css"]) {
    const full = path.join(root, file);
    if (!fs.existsSync(full) || fs.statSync(full).size === 0) throw new Error(`Missing admin UI asset: ${file}`);
}
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
if (!html.includes('<base href="./"')) throw new Error("Admin UI must use a relative base path");
console.log("Admin UI validation passed");
