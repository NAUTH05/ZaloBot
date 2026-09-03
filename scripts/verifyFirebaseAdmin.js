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
    const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);
    if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !privateKey) {
        throw new Error("Set FIREBASE_SERVICE_ACCOUNT_FILE or FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY");
    }
    return { project_id: process.env.FIREBASE_PROJECT_ID, client_email: process.env.FIREBASE_CLIENT_EMAIL, private_key: privateKey };
}

function normalizePrivateKey(value) {
    let key = String(value || "").trim();
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
    return key
        .replace(/\\\\n/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\\r?\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\r/g, "")
        .replace(/\\+$/g, "")
        .trim();
}

async function main() {
    const { cert, getApps, initializeApp } = require("firebase-admin/app");
    const { getFirestore } = require("firebase-admin/firestore");
    const account = loadServiceAccount();
    if (!account.project_id || !account.client_email || !account.private_key) throw new Error("Service-account is missing required fields");
    if (!account.client_email.endsWith(".iam.gserviceaccount.com")) throw new Error("Service-account client_email is not a Google service-account identity");
    if (!account.private_key.includes("-----BEGIN PRIVATE KEY-----") || !account.private_key.includes("-----END PRIVATE KEY-----")) throw new Error("Firebase private key is not a complete PEM; use escaped \\n sequences or FIREBASE_SERVICE_ACCOUNT_FILE");
    try {
        if (!getApps().length) initializeApp({ credential: cert(account), projectId: account.project_id });
    } catch (error) {
        throw new Error(`Firebase credential rejected: ${error.message}`);
    }
    const db = getFirestore();
    const probe = `healthcheck_${Date.now()}`;
    await db.collection(process.env.FIREBASE_STATE_COLLECTION || "bot_state").doc(probe).set({ checkedAt: new Date().toISOString() });
    await db.collection(process.env.FIREBASE_STATE_COLLECTION || "bot_state").doc(probe).delete();
    console.log(`Firebase Admin verification passed for project ${account.project_id}`);
}

main().catch((error) => {
    const message = error.code === 16 || error.code === "16" || /UNAUTHENTICATED/i.test(error.message)
        ? "Google rejected the service-account token (UNAUTHENTICATED). Check Windows time sync, service-account key status, project ID, and PM2 environment; then rerun this command."
        : error.code === 7 || error.code === "7" || /PERMISSION_DENIED/i.test(error.message)
            ? "Firestore permission denied. Grant the service account access to the configured Firestore database/collection."
            : error.message;
    console.error(`Firebase Admin verification failed: ${message}`);
    process.exitCode = 1;
});
