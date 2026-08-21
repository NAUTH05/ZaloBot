const crypto = require("crypto");

const password = String(process.env.ADMIN_PASSWORD_TO_HASH || "");
if (password.length < 12) {
    console.error("Set ADMIN_PASSWORD_TO_HASH to a password of at least 12 characters.");
    process.exitCode = 1;
} else {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    console.log(`ADMIN_PASSWORD_HASH=scrypt$${salt.toString("hex")}$${hash.toString("hex")}`);
}
