// ============================================================================
// Media của tin nhắn ĐI VÀO.
//
// Vì sao phải tải về thay vì lưu URL của Zalo:
//   - URL CDN của Zalo có hạn và gắn phiên; vài ngày sau là ảnh chết.
//   - CSP của dashboard là `img-src 'self'`, nên ảnh ngoài miền bị chặn — muốn
//     hiển thị phải nới CSP cho một danh sách miền ngày càng dài.
//   - Tải về rồi phục vụ qua /api/media/<id> giữ nguyên một đường ảnh duy nhất,
//     dùng lại đúng cơ chế của ảnh gửi đi.
//
// Nguyên tắc an toàn: chỉ tải http/https, có timeout, có trần kích thước, và
// không bao giờ để lỗi tải ảnh làm hỏng việc ghi lịch sử tin nhắn.
// ============================================================================
const {
    MEDIA_TYPES,
    storeMedia,
    storeChatFile
} = require("./mediaStorage");

const DOWNLOAD_TIMEOUT_MS = 12000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const PHOTO_URL_KEYS = ["url", "href", "file_url", "fileUrl", "photo_url", "photoUrl", "link", "normalUrl", "hdUrl", "thumb"];
const FILE_NAME_KEYS = ["file_name", "fileName", "filename", "name", "title", "display_name"];

function firstString(source, keys) {
    if (!source || typeof source !== "object") return null;
    for (const key of keys) {
        const value = source[key];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
}

// Lấy URL ảnh từ nhiều hình dạng khác nhau:
//   - chuỗi URL (một số bản API trả thẳng)
//   - mảng các cỡ ảnh (Telegram-style: phần tử lớn nhất thường ở cuối)
//   - object có url/href/...
function pickMediaUrl(value) {
    if (!value) return null;
    if (typeof value === "string") return value.trim() || null;
    if (Array.isArray(value)) {
        // Duyệt NGƯỢC: API kiểu Telegram xếp cỡ nhỏ trước, lớn sau.
        for (let index = value.length - 1; index >= 0; index -= 1) {
            const found = pickMediaUrl(value[index]);
            if (found) return found;
        }
        return null;
    }
    if (typeof value === "object") return firstString(value, PHOTO_URL_KEYS);
    return null;
}

function pickFileName(value, fallback) {
    if (value && typeof value === "object") {
        const found = firstString(value, FILE_NAME_KEYS);
        if (found) return found;
    }
    return fallback;
}

function isHttpUrl(url) {
    try {
        const parsed = new URL(String(url));
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch (_) {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Chuẩn hoá attachment của một tin nhắn vào.
//
// Đầu vào có thể là:
//   - tin của bot chính thức: { photo }, { document }
//   - tin đã qua adapter ZCA: { attachments: [{ kind, url, name }] }
//
// Trả về: [{ kind: "image"|"file", url, name }]
// ---------------------------------------------------------------------------
function extractInboundAttachments(msg = {}) {
    const found = [];
    const seen = new Set();

    const push = (kind, url, name) => {
        const value = String(url || "").trim();
        if (!value || seen.has(value)) return;
        if (!isHttpUrl(value)) return;   // bỏ mọi scheme lạ (file:, data:…)
        seen.add(value);
        found.push({ kind, url: value, name: name || (kind === "image" ? "anh.jpg" : "tepdinhkem.bin") });
    };

    // Bot chính thức.
    const photoUrl = pickMediaUrl(msg.photo);
    if (photoUrl) push("image", photoUrl, pickFileName(msg.photo, "anh.jpg"));

    const documentUrl = pickMediaUrl(msg.document);
    if (documentUrl) push("file", documentUrl, pickFileName(msg.document, "tepdinhkem.bin"));

    // Adapter ZCA đã chuẩn hoá sẵn.
    if (Array.isArray(msg.attachments)) {
        for (const item of msg.attachments) {
            if (!item || !item.url) continue;
            push(item.kind === "file" ? "file" : "image", item.url, item.name);
        }
    }

    return found;
}

// Mô tả tạm để UI hiện "đang tải" ngay khi tin tới, trước khi tải xong.
function pendingDescriptors(attachments) {
    return attachments.map((item) => ({
        type: item.kind,
        pending: true,
        name: item.name
    }));
}

async function downloadToBuffer(url, { maxBytes, fetchImpl, timeoutMs = DOWNLOAD_TIMEOUT_MS }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const declaredLength = Number(response.headers?.get?.("content-length") || 0);
        if (declaredLength && declaredLength > maxBytes) {
            throw new Error(`tệp quá lớn (${declaredLength} bytes)`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length === 0) throw new Error("nội dung rỗng");
        if (buffer.length > maxBytes) throw new Error(`tệp quá lớn (${buffer.length} bytes)`);
        return buffer;
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------
// Tải và lưu các attachment của tin vào.
//
// Không bao giờ ném: mỗi attachment hỏng được ghi lại thành mục `failed` để UI
// hiện đúng "không tải được", thay vì làm hỏng cả tin nhắn.
// ---------------------------------------------------------------------------
async function ingestInboundAttachments(attachments, options = {}) {
    if (!Array.isArray(attachments) || attachments.length === 0) return [];

    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== "function") {
        return attachments.map((item) => ({ type: item.kind, failed: true, name: item.name, error: "không có fetch" }));
    }

    const stored = [];
    for (const item of attachments) {
        try {
            const isImage = item.kind === "image";
            const buffer = await downloadToBuffer(item.url, {
                maxBytes: isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES,
                fetchImpl
            });

            if (isImage) {
                const media = await storeMedia({
                    buffer,
                    originalName: item.name || "anh.jpg",
                    mediaType: MEDIA_TYPES.CHAT_IMAGE,
                    metadata: { source: "inbound" }
                });
                stored.push({
                    type: "image",
                    mediaId: media.mediaId,
                    url: media.url,
                    name: media.originalName || item.name,
                    size: media.size,
                    mimeType: media.mimeType
                });
            } else {
                const media = await storeChatFile({
                    buffer,
                    originalName: item.name || "tepdinhkem.bin"
                });
                stored.push({
                    type: "file",
                    mediaId: media.mediaId,
                    url: media.url,
                    name: media.originalName || item.name,
                    size: media.size,
                    mimeType: media.mimeType
                });
            }
        } catch (error) {
            stored.push({
                type: item.kind,
                failed: true,
                name: item.name,
                error: String(error.message || error).slice(0, 200)
            });
        }
    }

    return stored;
}

module.exports = {
    DOWNLOAD_TIMEOUT_MS,
    MAX_FILE_BYTES,
    MAX_IMAGE_BYTES,
    extractInboundAttachments,
    ingestInboundAttachments,
    isHttpUrl,
    pendingDescriptors,
    pickMediaUrl
};
