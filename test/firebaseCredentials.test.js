const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { normalizePrivateKey } = require("../firestorePersistence");

test("normalizes quoted Windows dotenv PEM values", () => {
    const key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
    const dotenvValue = '"' + key.replace(/\n/g, "\\\\n") + '"';
    const normalized = normalizePrivateKey(dotenvValue);
    assert.equal(normalized, key.trim());
    assert.doesNotThrow(() => crypto.createPrivateKey(normalized));
});
