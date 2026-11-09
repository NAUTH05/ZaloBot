// ============================================================================
// Media Storage — lưu trữ an toàn cho ảnh trợ giúp và ảnh chat.
//
// Hai loại media:
//   1. help-image: ảnh hướng dẫn gắn với lệnh /help <command>.
//   2. chat-image: ảnh đính kèm trong Chat Center (admin gửi/nhận).
//
// Nguyên tắc an toàn:
//   - File lưu trên đĩa dưới data/uploads/<type>/, thư mục đã gitignore.
//   - Tên file là ID ngẫu nhiên, KHÔNG dùng tên gốc (chống path traversal).
//   - Chỉ chấp nhận JPEG/PNG/GIF/WebP, giới hạn kích thước 5 MB.
//   - URL công khai dùng ID mờ (opaque), không để lộ đường đĩa.
//   - Metadata (filename, mime, size, command association, timestamps) lưu
//     trong Firestore collection riêng `bot_media`.
//   - Không bao giờ trả token/đường dẫn nội bộ ra API.
// ============================================================================

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PROJECT_ROOT = path.resolve(__dirname);
const UPLOAD_ROOT = path.join(PROJECT_ROOT, "data", "uploads");

const MEDIA_TYPES = Object.freeze({
    HELP_IMAGE: "help-image",
    CHAT_IMAGE: "chat-image"
});

const SUBDIR_FOR_TYPE = {
    [MEDIA_TYPES.HELP_IMAGE]: "help-images",
    [MEDIA_TYPES.CHAT_IMAGE]: "chat-images"
};

const ALLOWED_MIME = new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp"
]);

const MIME_TO_EXT = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp"
};

const MAX_FILE_SIZE = 5 * 1024 * 1024;  // 5 MB

const MEDIA_COLLECTION = "bot_media";

// Magic bytes để kiểm tra nội dung file thật sự là ảnh, không chỉ dựa vào MIME header.
const MAGIC_BYTES = [
    { mime: "image/jpeg", offset: 0, bytes: [0xFF, 0xD8, 0xFF] },
    { mime: "image/png",  offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
    { mime: "image/gif",  offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },  // GIF8
    { mime: "image/webp", offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }   // RIFF (WebP container)
];

function detectMimeFromBuffer(buffer) {
    for (const sig of MAGIC_BYTES) {
        let match = true;
        for (let i = 0; i < sig.bytes.length; i += 1) {
            if (buffer[sig.offset + i] !== sig.bytes[i]) {
                match = false;
                break;
            }
        }
        if (match) return sig.mime;
    }
    return null;
}

function ensureUploadDir(mediaType) {
    const subdir = SUBDIR_FOR_TYPE[mediaType];
    if (!subdir) throw new Error(`Loại media không hợp lệ: ${mediaType}`);
    const dir = path.join(UPLOAD_ROOT, subdir);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// Sinh ID ngẫu nhiên 16 byte hex dùng làm tên file và mediaId.
function generateMediaId() {
    return crypto.randomBytes(16).toString("hex");
}

// ---------------------------------------------------------------------------
// Lưu một file ảnh đã được đọc vào buffer.
//
// Trả về { mediaId, mediaType, mimeType, size, originalName, filePath, url }
// url là đường dẫn tương đối dùng trong API: /api/media/<mediaId>
// ---------------------------------------------------------------------------
async function storeMedia({ buffer, originalName, declaredMime, mediaType, metadata = {} }) {
    if (!buffer || !Buffer.isBuffer(buffer)) {
        throw new Error("Dữ liệu tải lên không hợp lệ (không phải buffer).");
    }
    if (buffer.length === 0) {
        throw new Error("File rỗng.");
    }
    if (buffer.length > MAX_FILE_SIZE) {
        throw new Error(`File quá lớn: ${buffer.length} bytes (giới hạn ${MAX_FILE_SIZE} bytes).`);
    }

    // Kiểm tra nội dung thật sự là ảnh bằng magic bytes, không tin MIME header.
    const detectedMime = detectMimeFromBuffer(buffer);
    if (!detectedMime) {
        throw new Error("File không phải ảnh hợp lệ (magic bytes không khớp).");
    }
    if (!ALLOWED_MIME.has(detectedMime)) {
        throw new Error(`Định dạng ảnh không được hỗ trợ: ${detectedMime}.`);
    }
    // Nếu declaredMime khác detectedMime thì dùng detectedMime (an toàn hơn).
    const mimeType = detectedMime;
    const ext = MIME_TO_EXT[mimeType] || ".bin";

    const dir = ensureUploadDir(mediaType);
    const mediaId = generateMediaId();
    const filename = `${mediaId}${ext}`;
    const filePath = path.join(dir, filename);

    // Ghi nguyên tử: ghi file tạm rồi rename.
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, filePath);

    const record = {
        mediaId,
        mediaType,
        mimeType,
        size: buffer.length,
        originalName: String(originalName || "").slice(0, 255),  // giới hạn độ dài tên
        storedAt: new Date().toISOString(),
        ...metadata
    };

    // Ghi metadata vào Firestore nếu có db.
    const db = safeGetDb();
    if (db) {
        try {
            await db.collection(MEDIA_COLLECTION).doc(mediaId).set({
                ...record,
                filePath  // chỉ lưu trong Firestore, không trả ra API
            });
        } catch (error) {
            console.error(`[MediaStorage] không ghi được metadata Firestore: ${error.message}`);
            // Vẫn trả về file đã lưu; metadata có thể phục hồi sau.
        }
    }

    // Bản trả về KHÔNG chứa filePath (bảo mật).
    return {
        ...record,
        url: `/api/media/${mediaId}`
    };
}

// ---------------------------------------------------------------------------
// Lấy đường dẫn file trên đĩa và metadata cho một mediaId.
// Dùng cho GET /api/media/:mediaId để phục vụ file.
// ---------------------------------------------------------------------------
async function getMediaInfo(mediaId) {
    // mediaId chỉ chứa hex; chống path traversal.
    if (!/^[a-f0-9]{32}$/.test(String(mediaId))) {
        return null;
    }

    // Thử đọc metadata từ Firestore trước.
    const db = safeGetDb();
    if (db) {
        try {
            const doc = await db.collection(MEDIA_COLLECTION).doc(mediaId).get();
            if (doc.exists) {
                const data = doc.data();
                if (data.filePath && fs.existsSync(data.filePath)) {
                    return {
                        mediaId,
                        mediaType: data.mediaType,
                        mimeType: data.mimeType,
                        size: data.size,
                        originalName: data.originalName || null,
                        filePath: data.filePath,
                        storedAt: data.storedAt || null,
                        metadata: data
                    };
                }
            }
        } catch (error) {
            console.error(`[MediaStorage] lỗi đọc metadata Firestore: ${error.message}`);
        }
    }

    // Fallback: quét thư mục upload để tìm file khớp mediaId.
    for (const subdir of Object.values(SUBDIR_FOR_TYPE)) {
        const dir = path.join(UPLOAD_ROOT, subdir);
        if (!fs.existsSync(dir)) continue;
        for (const ext of Object.values(MIME_TO_EXT)) {
            const candidate = path.join(dir, `${mediaId}${ext}`);
            if (fs.existsSync(candidate)) {
                const buffer = fs.readFileSync(candidate);
                const mimeType = detectMimeFromBuffer(buffer) || "application/octet-stream";
                return {
                    mediaId,
                    mediaType: null,
                    mimeType,
                    size: buffer.length,
                    originalName: null,
                    filePath: candidate,
                    storedAt: null,
                    metadata: {}
                };
            }
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// Xoá một file media theo mediaId.
// ---------------------------------------------------------------------------
async function deleteMedia(mediaId) {
    if (!/^[a-f0-9]{32}$/.test(String(mediaId))) return false;

    let deleted = false;

    // Xoá file trên đĩa.
    const info = await getMediaInfo(mediaId);
    if (info && info.filePath && fs.existsSync(info.filePath)) {
        try {
            fs.unlinkSync(info.filePath);
            deleted = true;
        } catch (error) {
            console.error(`[MediaStorage] không xoá được file ${mediaId}: ${error.message}`);
        }
    }

    // Xoá metadata trong Firestore.
    const db = safeGetDb();
    if (db) {
        try {
            await db.collection(MEDIA_COLLECTION).doc(mediaId).delete();
            deleted = true;
        } catch (error) {
            console.error(`[MediaStorage] không xoá được metadata ${mediaId}: ${error.message}`);
        }
    }

    return deleted;
}

// ---------------------------------------------------------------------------
// Liệt kê media theo loại (cho quản lý ảnh trợ giúp).
// ---------------------------------------------------------------------------
async function listMediaByType(mediaType, options = {}) {
    const limit = Math.min(Number(options.limit) || 50, 200);
    const db = safeGetDb();
    if (!db) return [];

    try {
        let query = db.collection(MEDIA_COLLECTION).where("mediaType", "==", mediaType);
        if (options.command) {
            query = query.where("command", "==", options.command);
        }
        const snapshot = await query.limit(limit).get();
        const results = [];
        snapshot.forEach((doc) => {
            const data = doc.data();
            // Không trả filePath ra API.
            const { filePath, ...safe } = data;
            results.push({ ...safe, url: `/api/media/${data.mediaId}` });
        });
        // Sắp xếp theo thời gian tạo mới nhất.
        results.sort((a, b) => (b.storedAt || "").localeCompare(a.storedAt || ""));
        return results;
    } catch (error) {
        console.error(`[MediaStorage] lỗi listMediaByType: ${error.message}`);
        return [];
    }
}

// ---------------------------------------------------------------------------
// Gắn/bỏ gắn ảnh với một lệnh help cụ thể.
// ---------------------------------------------------------------------------
async function associateHelpImage(mediaId, command) {
    if (!/^[a-f0-9]{32}$/.test(String(mediaId))) return false;
    const db = safeGetDb();
    if (!db) return false;

    try {
        await db.collection(MEDIA_COLLECTION).doc(mediaId).set({
            command: command || null,
            associatedAt: new Date().toISOString()
        }, { merge: true });
        return true;
    } catch (error) {
        console.error(`[MediaStorage] lỗi associateHelpImage: ${error.message}`);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Lấy danh sách ảnh cho một lệnh help.
// ---------------------------------------------------------------------------
async function getHelpImagesForCommand(command) {
    if (!command) return [];
    const db = safeGetDb();
    if (!db) return [];

    try {
        const snapshot = await db.collection(MEDIA_COLLECTION)
            .where("mediaType", "==", MEDIA_TYPES.HELP_IMAGE)
            .where("command", "==", command)
            .get();
        const results = [];
        snapshot.forEach((doc) => {
            const data = doc.data();
            const { filePath, ...safe } = data;
            results.push({ ...safe, url: `/api/media/${data.mediaId}` });
        });
        results.sort((a, b) => (a.storedAt || "").localeCompare(b.storedAt || ""));
        return results;
    } catch (error) {
        console.error(`[MediaStorage] lỗi getHelpImagesForCommand: ${error.message}`);
        return [];
    }
}

// Lấy db từ firestorePersistence một cách an toàn (không crash nếu chưa khởi tạo).
function safeGetDb() {
    try {
        const { getFirestoreDb } = require("./firestorePersistence");
        return getFirestoreDb();
    } catch (_) {
        return null;
    }
}

// Validation helper cho middleware xử lý upload.
function validateUploadedFile(file) {
    if (!file) return { valid: false, error: "Không có file." };
    if (file.truncated) return { valid: false, error: `File vượt giới hạn ${MAX_FILE_SIZE} bytes.` };
    const buffer = file.buffer || file.data;
    if (!buffer || buffer.length === 0) return { valid: false, error: "File rỗng." };
    if (buffer.length > MAX_FILE_SIZE) return { valid: false, error: "File quá lớn." };
    const detectedMime = detectMimeFromBuffer(buffer);
    if (!detectedMime) return { valid: false, error: "File không phải ảnh hợp lệ." };
    if (!ALLOWED_MIME.has(detectedMime)) return { valid: false, error: `Định dạng ${detectedMime} không được hỗ trợ.` };
    return { valid: true, mimeType: detectedMime, buffer };
}

module.exports = {
    MEDIA_TYPES,
    MEDIA_COLLECTION,
    MAX_FILE_SIZE,
    ALLOWED_MIME,
    storeMedia,
    getMediaInfo,
    deleteMedia,
    listMediaByType,
    associateHelpImage,
    getHelpImagesForCommand,
    validateUploadedFile,
    detectMimeFromBuffer
};
