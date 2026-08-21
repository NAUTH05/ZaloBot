require("dotenv").config();

const path = require("path");
const { importJsonDirectory } = require("./firestorePersistence");

const sourceDirectory = path.resolve(process.argv[2] || path.join(__dirname, "recent_json"));

importJsonDirectory(sourceDirectory)
    .then((items) => {
        console.log(`Đã migrate ${items.length} file JSON lên Firestore:`);
        for (const item of items) console.log(`- ${item.fileName} -> bot_state/${item.storeId}`);
    })
    .catch((error) => {
        console.error("Migration Firestore thất bại:", error.message);
        process.exitCode = 1;
    });
