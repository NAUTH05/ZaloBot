const path = require("path");

// Nạp .env theo thư mục dự án để lệnh chạy đúng dù được gọi từ thư mục nào.
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

const { importJsonDirectory } = require("./firestorePersistence");
const { getCollectionName, getDatabaseId } = require("./firebaseConfig");

const sourceDirectory = path.resolve(process.argv[2] || path.join(__dirname, "recent_json"));
// Phân biệt "người dùng chỉ định thư mục" với "dùng mặc định recent_json": chỉ
// trường hợp sau mới cần gợi ý thêm, vì rất dễ nhầm lệnh này với bước kiểm tra
// cấu hình Firebase.
const usingDefaultSource = !process.argv[2];

async function main() {
    console.log(`[Migrate] Nguồn: ${sourceDirectory}`);
    console.log(`[Migrate] Database: ${getDatabaseId()} · Collection: ${getCollectionName()}`);

    let result;
    try {
        result = await importJsonDirectory(sourceDirectory);
    } catch (error) {
        console.error(`[Migrate] Thất bại: ${error.message}`);
        // Lệnh này chỉ NHẬP DỮ LIỆU JSON CŨ lên Firestore. Nó không kiểm tra và
        // cũng không cần file service account để chạy đúng — nhưng khi thiếu
        // thư mục nguồn, thông báo lỗi rất dễ bị hiểu thành "Firebase chưa cấu
        // hình đúng". Nói rõ ra để khỏi mất thời gian dò nhầm hướng.
        if (usingDefaultSource) {
            console.error(
                "[Migrate] Lưu ý: lệnh này KHÔNG kiểm tra cấu hình Firebase. Nó chỉ nhập các file JSON " +
                "cũ trong thư mục recent_json/ lên Firestore."
            );
            console.error(
                "[Migrate] Máy chủ mới (dữ liệu đã ở Firestore) KHÔNG cần chạy migrate. " +
                "Muốn kiểm tra service account, chạy: npm run verify:firebase-admin"
            );
            console.error(
                "[Migrate] Muốn nhập từ thư mục khác: npm run migrate:firestore -- <đường-dẫn-thư-mục>"
            );
        }
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
