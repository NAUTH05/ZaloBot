const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const {
    createFirestore,
    describeFirebaseTarget,
    getCollectionName,
    getDatabaseId,
    loadServiceAccount
} = require("../firebaseConfig");

async function main() {
    const account = loadServiceAccount(process.env);
    const databaseId = getDatabaseId();
    const collectionName = getCollectionName();
    const db = createFirestore(account.credentials, databaseId);
    const target = describeFirebaseTarget({ credentials: account.credentials, databaseId, collectionName });

    const probe = `healthcheck_${Date.now()}`;
    await db.collection(collectionName).doc(probe).set({ checkedAt: new Date().toISOString() });
    await db.collection(collectionName).doc(probe).delete();

    console.log(
        `Firebase Admin verification passed for project ${target.projectId} · database ${target.databaseId} · collection ${target.collectionName}`
    );
}

main().catch((error) => {
    const message = error.code === 16 || error.code === "16" || /UNAUTHENTICATED/i.test(error.message)
        ? "Google rejected the service-account token (UNAUTHENTICATED). Check the server clock/time sync, service-account key status, project ID, and PM2 environment; then rerun this command."
        : error.code === 7 || error.code === "7" || /PERMISSION_DENIED/i.test(error.message)
            ? "Firestore permission denied. Grant the service account access to the configured Firestore database/collection."
            : error.message;
    console.error(`Firebase Admin verification failed: ${message}`);
    process.exitCode = 1;
});
