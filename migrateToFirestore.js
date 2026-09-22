const path = require("path");

// Nạp .env theo thư mục dự án để lệnh chạy đúng dù được gọi từ thư mục nào.
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

const { importJsonDirectory } = require("./firestorePersistence");
const { getCollectionName, getDatabaseId } = require("./firebaseConfig");

const sourceDirectory = path.resolve(process.argv[2] || path.join(__dirname, "recent_json"));

async function main() {
    console.log(`[Migrate] Nguồn: ${sourceDirectory}`);
    console.log(`[Migrate] Database: ${getDatabaseId()} · Collection: ${getCollectionName()}`);

    let result;
    try {
        result = await importJsonDirectory(sourceDirectory);
    } catch (error) {
        console.error(`[Migrate] Thất bại: ${error.message}`);
        process.exitCode = 1;
        return;
    }

    if (result.items.length === 0) {
        console.error(
            `[Migrate] Không tìm thấy file .json nào trong ${result.sourceDirectory}. ` +
            "Kiểm tra lại thư mục nguồn hoặc truyền đường dẫn khác: npm run migrate:firestore -- <thư-mục>"
        );
        process.exitCode = 1;
        return;
    }

    console.log(
        `[Migrate] Đã ghi ${result.items.length} file JSON lên Firestore ` +
        `(project ${result.target.projectId} · database ${result.target.databaseId} · collection ${result.target.collectionName}):`
    );
    for (const item of result.items) {
        console.log(`- ${item.fileName} -> ${result.target.collectionName}/${item.storeId}`);
    }
}

main();
