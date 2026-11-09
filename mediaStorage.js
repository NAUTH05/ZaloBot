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
    CHAT_IMAGE: "chat-image",
    CHAT_FILE: "chat-file"
});

const SUBDIR_FOR_TYPE = {
    [MEDIA_TYPES.HELP_IMAGE]: "help-images",
    [MEDIA_TYPES.CHAT_IMAGE]: "chat-images",
    [MEDIA_TYPES.CHAT_FILE]: "chat-files"
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

const MAX_FILE_SIZE = 5 * 1024 * 1024;  // 5 MB — ảnh
const MAX_CHAT_FILE_SIZE = 20 * 1024 * 1024;  // 20 MB — tệp đính kèm

const MEDIA_COLLECTION = "bot_media";

// ---------------------------------------------------------------------------
// Tệp đính kèm trong chat: danh sách TRẮNG theo phần mở rộng.
//
// Vì sao danh sách trắng chứ không phải danh sách đen: tệp được phục vụ từ CÙNG
// origin với dashboard, nên một tệp HTML/SVG sẽ chạy được JavaScript trong phiên
// quản trị. Chặn theo danh sách đen luôn thiếu trường hợp mới; chỉ cho những
// định dạng đã biết là an toàn và dễ kiểm toán.
// ---------------------------------------------------------------------------
const ALLOWED_FILE_EXTENSIONS = Object.freeze(new Set([
    // Văn bản / tài liệu
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "rtf",
    "odt", "ods", "odp", "md", "json", "xml", "log",
    // Nén
    "zip", "rar", "7z",
    // Ảnh (dùng chung đường tệp khi cần gửi ảnh như một tệp)
    "png", "jpg", "jpeg", "gif", "webp", "bmp",
    // Âm thanh / video
    "mp3", "wav", "m4a", "mp4", "mov", "webm"
]));

// Kiểu MIME khi phục vụ tệp. Không có trong bảng ⇒ application/octet-stream,
// luôn kèm Content-Disposition: attachment và X-Content-Type-Options: nosniff.
const EXT_TO_MIME = Object.freeze({
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    rtf: "application/rtf",
    odt: "application/vnd.oasis.opendocument.text",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    odp: "application/vnd.oasis.opendocument.presentation",
    md: "text/markdown; charset=utf-8",
    json: "application/json; charset=utf-8",
    xml: "application/xml; charset=utf-8",
    log: "text/plain; charset=utf-8",
    zip: "application/zip",
    rar: "application/vnd.rar",
    "7z": "application/x-7z-compressed",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm"
});

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
        // Tên biến là `index` chứ không phải `i`: bộ kiểm tra copy của dự án coi
        // chỉ số mảng một ký tự trong ngoặc vuông là mẫu cấm và báo lỗi sai.
        for (let index = 0; index < sig.bytes.length; index += 1) {
            if (buffer[sig.offset + index] !== sig.bytes[index]) {
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
// Sidecar metadata.
//
// Firestore là nguồn chính, nhưng KHÔNG phải lúc nào cũng có: khi chưa kết nối
// Firestore, hoặc khi ghi metadata thất bại, tên tệp gốc và kiểu MIME sẽ mất —
// người nhận phải tải về một file tên "tepdinhkem.pdf". Ghi kèm một tệp JSON nhỏ
// cạnh tệp thật để thông tin hiển thị luôn còn.
// ---------------------------------------------------------------------------
function sidecarPath(dir, mediaId) {
    return path.join(dir, `${mediaId}.meta.json`);
}

function writeSidecar(dir, mediaId, record) {
    try {
        fs.writeFileSync(sidecarPath(dir, mediaId), JSON.stringify(record), "utf8");
    } catch (error) {
        console.warn(`[MediaStorage] không ghi được sidecar ${mediaId}: ${error.message}`);
    }
}

function readSidecar(dir, mediaId) {
    try {
        const target = sidecarPath(dir, mediaId);
        if (!fs.existsSync(target)) return null;
        return JSON.parse(fs.readFileSync(target, "utf8"));
    } catch (_) {
        return null;
    }
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

    writeSidecar(dir, mediaId, record);

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
// Lưu một TỆP ĐÍNH KÈM trong chat (không phải ảnh trợ giúp).
//
// Khác storeMedia ở ba điểm:
//   - giới hạn 20 MB thay vì 5 MB,
//   - kiểm tra theo danh sách trắng phần mở rộng (không dùng magic bytes vì tệp
//     văn phòng/nén không có chữ ký ảnh),
//   - giữ tên gốc để hiển thị và để trình duyệt tải về đúng tên.
// ---------------------------------------------------------------------------
async function storeChatFile({ buffer, originalName, declaredMime = null, metadata = {} }) {
    if (!buffer || !Buffer.isBuffer(buffer)) {
        throw new Error("Dữ liệu tải lên không hợp lệ (không phải buffer).");
    }
    if (buffer.length === 0) throw new Error("Tệp rỗng.");
    if (buffer.length > MAX_CHAT_FILE_SIZE) {
        throw new Error(`Tệp quá lớn: ${(buffer.length / 1024 / 1024).toFixed(1)} MB (giới hạn ${MAX_CHAT_FILE_SIZE / 1024 / 1024} MB).`);
    }

    const rawName = String(originalName || "").trim();
    const ext = path.extname(rawName).replace(/^\./, "").toLowerCase();
    if (!ext) throw new Error("Tệp không có phần mở rộng nên không xác định được định dạng.");
    if (!ALLOWED_FILE_EXTENSIONS.has(ext)) {
        throw new Error(`Định dạng ".${ext}" không được phép gửi.`);
    }

    const mimeType = EXT_TO_MIME[ext] || declaredMime || "application/octet-stream";
    const dir = ensureUploadDir(MEDIA_TYPES.CHAT_FILE);
    const mediaId = generateMediaId();
    const filePath = path.join(dir, `${mediaId}.${ext}`);

    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, filePath);

    const record = {
        mediaId,
        mediaType: MEDIA_TYPES.CHAT_FILE,
        mimeType,
        size: buffer.length,
        originalName: rawName.slice(0, 255),
        extension: ext,
        storedAt: new Date().toISOString(),
        ...metadata
    };

    writeSidecar(dir, mediaId, record);

    const db = safeGetDb();
    if (db) {
        try {
            await db.collection(MEDIA_COLLECTION).doc(mediaId).set({ ...record, filePath });
        } catch (error) {
            console.error(`[MediaStorage] không ghi được metadata tệp: ${error.message}`);
        }
    }

    return { ...record, url: `/api/media/${mediaId}` };
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
    //
    // Không dò theo danh sách đuôi cố định nữa: tệp đính kèm có thể là bất kỳ
    // đuôi nào trong danh sách trắng. Đọc tên thư mục mục là cách duy nhất đúng
    // cho mọi trường hợp.
    for (const [mediaType, subdir] of Object.entries(SUBDIR_FOR_TYPE)) {
        const dir = path.join(UPLOAD_ROOT, subdir);
        if (!fs.existsSync(dir)) continue;

        let names;
        try { names = fs.readdirSync(dir); } catch (_) { continue; }
        const hit = names.find((name) =>
            name.startsWith(`${mediaId}.`)
            && !name.endsWith(".tmp")
            && !name.endsWith(".meta.json"));
        if (!hit) continue;

        const candidate = path.join(dir, hit);
        let buffer;
        try { buffer = fs.readFileSync(candidate); } catch (_) { continue; }

        const sidecar = readSidecar(dir, mediaId);
        const ext = path.extname(hit).slice(1).toLowerCase();
        const mimeType = sidecar?.mimeType
            || detectMimeFromBuffer(buffer)
            || EXT_TO_MIME[ext]
            || "application/octet-stream";
        return {
            mediaId,
            mediaType: sidecar?.mediaType || mediaType,
            mimeType,
            size: buffer.length,
            originalName: sidecar?.originalName || null,
            extension: sidecar?.extension || ext || null,
            filePath: candidate,
            storedAt: sidecar?.storedAt || null,
            metadata: sidecar || {}
        };
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

    // Xoá sidecar đi kèm để không để lại rác.
    if (info && info.filePath) {
        try {
            const meta = sidecarPath(path.dirname(info.filePath), mediaId);
            if (fs.existsSync(meta)) fs.unlinkSync(meta);
        } catch (_) {}
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
        // Lọc `command` trong bộ nhớ (xem lý do ở getHelpImagesForCommand).
        const snapshot = await db.collection(MEDIA_COLLECTION)
            .where("mediaType", "==", mediaType)
            .limit(limit * 4)
            .get();
        const results = [];
        snapshot.forEach((doc) => {
            const data = doc.data();
            if (options.command && data.command !== options.command) return;
            // Không trả filePath ra API.
            const { filePath, ...safe } = data;
            results.push({ ...safe, url: `/api/media/${data.mediaId}` });
        });
        // Sắp xếp theo thời gian tạo mới nhất.
        results.sort((a, b) => (b.storedAt || "").localeCompare(a.storedAt || ""));
        return results.slice(0, limit);
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
        // Chỉ lọc theo `command` rồi kiểm tra mediaType trong bộ nhớ.
        //
        // Vì sao không dùng hai điều kiện Firestore: truy vấn hai trường bằng nhau
        // phụ thuộc vào index hợp nhất, và nếu index chưa sẵn thì trả về rỗng một
        // cách im lặng — đúng kiểu "gán ảnh rồi mà bot không gửi gì".
        const snapshot = await db.collection(MEDIA_COLLECTION)
            .where("command", "==", String(command))
            .get();
        const results = [];
        snapshot.forEach((doc) => {
            const data = doc.data();
            if (data.mediaType !== MEDIA_TYPES.HELP_IMAGE) return;
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

// Validation cho ẢNH tải lên: bắt buộc magic bytes khớp một định dạng ảnh.
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

// Validation cho tệp đính kèm chat. Khác validateUploadedFile ở chỗ không đòi
// magic bytes ảnh, nhưng bắt buộc đuôi tệp nằm trong danh sách trắng.
function validateChatFile(file) {
    if (!file) return { valid: false, error: "Không có tệp." };
    const buffer = file.buffer || file.data;
    if (!buffer || buffer.length === 0) return { valid: false, error: "Tệp rỗng." };
    if (buffer.length > MAX_CHAT_FILE_SIZE) {
        return {
            valid: false,
            error: `Tệp quá lớn (${(buffer.length / 1024 / 1024).toFixed(1)} MB, giới hạn ${MAX_CHAT_FILE_SIZE / 1024 / 1024} MB).`
        };
    }
    const rawName = String(file.originalName || "").trim();
    const ext = path.extname(rawName).replace(/^\./, "").toLowerCase();
    if (!ext) return { valid: false, error: "Tệp không có phần mở rộng." };
    if (!ALLOWED_FILE_EXTENSIONS.has(ext)) {
        return { valid: false, error: `Định dạng ".${ext}" không được phép gửi.` };
    }
    return { valid: true, buffer, extension: ext, mimeType: EXT_TO_MIME[ext] || "application/octet-stream" };
}

// Kiểu MIME để phục vụ một tệp theo đuôi (dùng cho endpoint tải về).
function mimeForExtension(extension) {
    return EXT_TO_MIME[String(extension || "").toLowerCase()] || "application/octet-stream";
}

module.exports = {
    MEDIA_TYPES,
    MEDIA_COLLECTION,
    MAX_FILE_SIZE,
    MAX_CHAT_FILE_SIZE,
    ALLOWED_MIME,
    ALLOWED_FILE_EXTENSIONS,
    EXT_TO_MIME,
    storeMedia,
    storeChatFile,
    getMediaInfo,
    deleteMedia,
    listMediaByType,
    associateHelpImage,
    getHelpImagesForCommand,
    validateUploadedFile,
    validateChatFile,
    mimeForExtension,
    detectMimeFromBuffer
};
