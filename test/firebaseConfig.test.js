const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { deleteApp, getApps } = require("firebase-admin/app");
const {
    DEFAULT_COLLECTION,
    DEFAULT_DATABASE_ID,
    createFirestore,
    describeFirebaseTarget,
    getCollectionName,
    getDatabaseId,
    isDefaultDatabaseId,
    loadServiceAccount,
    resolveServiceAccountPath
} = require("../firebaseConfig");
const { importJsonDirectory } = require("../firestorePersistence");

function temporaryDirectory(t, prefix) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function serviceAccount(overrides = {}) {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    return {
        type: "service_account",
        project_id: "zalobot-test",
        client_email: "firebase-adminsdk-test@zalobot-test.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
        ...overrides
    };
}

function writeServiceAccount(directory, fileName, data) {
    const filePath = path.join(directory, fileName);
    fs.writeFileSync(filePath, JSON.stringify(data), "utf8");
    return filePath;
}

test("đường dẫn tương đối được tính từ thư mục dự án", (t) => {
    const directory = temporaryDirectory(t, "zalobot-firebase-rel-");
    writeServiceAccount(directory, "zalobot-firebase-adminsdk-fbsvc.json", serviceAccount());

    assert.equal(
        resolveServiceAccountPath("./zalobot-firebase-adminsdk-fbsvc.json", directory),
        path.join(directory, "zalobot-firebase-adminsdk-fbsvc.json")
    );

    const loaded = loadServiceAccount(
        { FIREBASE_SERVICE_ACCOUNT_FILE: "./zalobot-firebase-adminsdk-fbsvc.json" },
        { projectRoot: directory }
    );
    assert.equal(loaded.source, "file");
    assert.equal(loaded.credentials.project_id, "zalobot-test");
    assert.match(loaded.credentials.private_key, /BEGIN PRIVATE KEY/);
});

test("đường dẫn tuyệt đối được giữ nguyên", (t) => {
    const directory = temporaryDirectory(t, "zalobot-firebase-abs-");
    const filePath = writeServiceAccount(directory, "service-account.json", serviceAccount());
    const absolutePath = path.resolve(filePath);

    assert.equal(resolveServiceAccountPath(absolutePath), path.normalize(absolutePath));

    const loaded = loadServiceAccount({ FIREBASE_SERVICE_ACCOUNT_FILE: absolutePath });
    assert.equal(loaded.source, "file");
    assert.equal(loaded.credentials.project_id, "zalobot-test");
});

test("bí danh FIREBASE_SERVICE_ACCOUNT_PATH vẫn hoạt động", (t) => {
    const directory = temporaryDirectory(t, "zalobot-firebase-legacy-");
    const filePath = writeServiceAccount(directory, "legacy.json", serviceAccount());
    const loaded = loadServiceAccount({ FIREBASE_SERVICE_ACCOUNT_PATH: filePath });
    assert.equal(loaded.source, "file");
    assert.equal(loaded.sourceVar, "FIREBASE_SERVICE_ACCOUNT_PATH");
});

test("thiếu file cấu hình Firebase báo lỗi rõ ràng", (t) => {
    const directory = temporaryDirectory(t, "zalobot-firebase-missing-");
    assert.throws(
        () => loadServiceAccount({ FIREBASE_SERVICE_ACCOUNT_FILE: "./khong-ton-tai.json" }, { projectRoot: directory }),
        /Không tìm thấy file cấu hình Firebase/
    );
});

test("thiếu biến cấu hình Firebase báo lỗi rõ ràng", () => {
    assert.throws(() => loadServiceAccount({}), /Thiếu cấu hình Firebase/);
});

test("JSON không hợp lệ báo lỗi rõ ràng", (t) => {
    const directory = temporaryDirectory(t, "zalobot-firebase-badjson-");
    fs.writeFileSync(path.join(directory, "broken.json"), "{ not json", "utf8");
    assert.throws(
        () => loadServiceAccount({ FIREBASE_SERVICE_ACCOUNT_FILE: "./broken.json" }, { projectRoot: directory }),
        /không phải JSON hợp lệ/
    );
});

test("thiếu trường bắt buộc thì liệt kê đúng tên trường", (t) => {
    const directory = temporaryDirectory(t, "zalobot-firebase-fields-");
    writeServiceAccount(directory, "partial.json", { type: "service_account", project_id: "zalobot-test" });
    assert.throws(
        () => loadServiceAccount({ FIREBASE_SERVICE_ACCOUNT_FILE: "./partial.json" }, { projectRoot: directory }),
        /client_email, private_key/
    );
});

test("email không phải service account Firebase bị từ chối", (t) => {
    const directory = temporaryDirectory(t, "zalobot-firebase-email-");
    writeServiceAccount(directory, "wrong-email.json", serviceAccount({ client_email: "someone@example.com" }));
    assert.throws(
        () => loadServiceAccount({ FIREBASE_SERVICE_ACCOUNT_FILE: "./wrong-email.json" }, { projectRoot: directory }),
        /client_email không phải email service account/
    );
});

test("khóa riêng không phải PEM hợp lệ bị từ chối", (t) => {
    const directory = temporaryDirectory(t, "zalobot-firebase-pem-");
    writeServiceAccount(directory, "bad-pem.json", serviceAccount({ private_key: "not-a-pem" }));
    assert.throws(
        () => loadServiceAccount({ FIREBASE_SERVICE_ACCOUNT_FILE: "./bad-pem.json" }, { projectRoot: directory }),
        /private_key không phải khóa PEM/
    );
});

test("database ID và collection name dùng giá trị mặc định an toàn", () => {
    assert.equal(getDatabaseId({}), DEFAULT_DATABASE_ID);
    assert.equal(getDatabaseId({ FIREBASE_DATABASE_ID: "  " }), DEFAULT_DATABASE_ID);
    assert.equal(getDatabaseId({ FIREBASE_DATABASE_ID: "zalobot-secondary" }), "zalobot-secondary");
    assert.equal(getCollectionName({}), DEFAULT_COLLECTION);
    assert.equal(getCollectionName({ FIREBASE_STATE_COLLECTION: "custom_state" }), "custom_state");

    assert.equal(isDefaultDatabaseId("(default)"), true);
    assert.equal(isDefaultDatabaseId(""), true);
    assert.equal(isDefaultDatabaseId("default"), true);
    assert.equal(isDefaultDatabaseId("zalobot-secondary"), false);

    assert.deepEqual(
        describeFirebaseTarget({ credentials: { project_id: "p" }, databaseId: "", collectionName: "" }),
        { projectId: "p", databaseId: "(default)", collectionName: "bot_state" }
    );
});

test("Firestore được tạo đúng database ID đã chọn", (t) => {
    const credentials = serviceAccount();
    t.after(() => { for (const app of getApps()) deleteApp(app); });

    const defaultDatabase = createFirestore(credentials, "(default)");
    const customDatabase = createFirestore(credentials, "zalobot-secondary");

    assert.equal(defaultDatabase.databaseId, "(default)");
    assert.equal(customDatabase.databaseId, "zalobot-secondary");
    assert.notEqual(defaultDatabase, customDatabase);
});

test("migration dừng sớm khi thư mục nguồn không tồn tại", async (t) => {
    const directory = temporaryDirectory(t, "zalobot-migrate-missing-");
    await assert.rejects(
        () => importJsonDirectory(path.join(directory, "khong-co")),
        /Không tìm thấy thư mục nguồn để migrate/
    );
});

test("migration báo rõ khi thư mục nguồn không có file JSON", async (t) => {
    const directory = temporaryDirectory(t, "zalobot-migrate-empty-");
    const result = await importJsonDirectory(directory);
    assert.deepEqual(result.items, []);
    assert.equal(result.sourceDirectory, path.resolve(directory));
});
