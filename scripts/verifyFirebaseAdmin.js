const fs = require("fs");
const path = require("path");

require("dotenv").config();

function loadServiceAccount() {
    const file = String(process.env.FIREBASE_SERVICE_ACCOUNT_FILE || process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "").trim();
    if (file) {
        const resolved = path.resolve(file);
        if (!fs.existsSync(resolved)) throw new Error(`Service-account file not found: ${resolved}`);
        try { return JSON.parse(fs.readFileSync(resolved, "utf8")); } catch (error) { throw new Error(`Invalid service-account JSON: ${error.message}`); }
    }
    const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\r?\\n/g, "\n").replace(/\\n/g, "\n");
    if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !privateKey) {
        throw new Error("Set FIREBASE_SERVICE_ACCOUNT_FILE or FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY");
    }
    return { project_id: process.env.FIREBASE_PROJECT_ID, client_email: process.env.FIREBASE_CLIENT_EMAIL, private_key: privateKey };
}

async function main() {
    const { cert, getApps, initializeApp } = require("firebase-admin/app");
    const { getFirestore } = require("firebase-admin/firestore");
    const account = loadServiceAccount();
    if (!account.project_id || !account.client_email || !account.private_key) throw new Error("Service-account is missing required fields");
    if (!getApps().length) initializeApp({ credential: cert(account), projectId: account.project_id });
    const db = getFirestore();
    const probe = `healthcheck_${Date.now()}`;
    await db.collection(process.env.FIREBASE_STATE_COLLECTION || "bot_state").doc(probe).set({ checkedAt: new Date().toISOString() });
    await db.collection(process.env.FIREBASE_STATE_COLLECTION || "bot_state").doc(probe).delete();
    console.log(`Firebase Admin verification passed for project ${account.project_id}`);
}

main().catch((error) => {
    console.error(`Firebase Admin verification failed: ${error.message}`);
    process.exitCode = 1;
});
