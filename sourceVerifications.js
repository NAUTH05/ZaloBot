// ============================================================================
// Xác minh nguồn gốc do QUẢN TRỊ VIÊN thực hiện, có ghi vết và có thể hoàn tác.
//
// Vì sao cần lớp riêng thay vì sửa thẳng trường botId của bản ghi:
//   - Ghi đè botId là mất thông tin gốc, không biết ai đổi và vì sao.
//   - Xác minh của người vẫn có thể SAI. Cần hoàn tác được mà không phải khôi phục
//     từ sao lưu.
//   - Giữ quyết định của người tách khỏi dữ liệu gốc: bản ghi vẫn nguyên vẹn, chỉ có
//     thêm một lớp phủ do người xác nhận.
//
// KHÔNG phải công cụ gộp danh tính: xác minh nguồn chỉ trả lời "bản ghi này thuộc
// tài khoản nào", KHÔNG nói "hai User ID này là cùng một người". Hai việc đó tách
// biệt hoàn toàn.
// ============================================================================
const path = require("path");
const { readJsonStore, writeJsonStore } = require("./firestorePersistence");

const FILE_PATH = path.join(__dirname, "sourceVerifications.json");
const SCHEMA_VERSION = 1;

// Nguồn được phép gán. Cố ý KHÔNG cho gán "zca:pending": đó là danh tính tạm, không
// phải một tài khoản thật.
function isAssignableSource(botId) {
    const value = String(botId || "").trim().toLowerCase();
    if (!value) return false;
    if (value === "zca:pending") return false;
    return /^bot\d+$/.test(value) || /^zca:[a-z0-9_-]+$/.test(value);
}

function emptyStore() {
    return { schemaVersion: SCHEMA_VERSION, verifications: {} };
}

function readStore(filePath = FILE_PATH) {
    try {
        const data = readJsonStore(filePath, FILE_PATH, emptyStore());
        return {
            schemaVersion: SCHEMA_VERSION,
            verifications: data && typeof data.verifications === "object" && data.verifications ? data.verifications : {}
        };
    } catch (error) {
        console.error("Không đọc được sourceVerifications.json:", error.message);
        return emptyStore();
    }
}

function writeStore(data, filePath = FILE_PATH) {
    writeJsonStore(filePath, FILE_PATH, data);
}

// Khóa xác minh: theo TỪNG STORE, vì cùng một khóa có thể tồn tại ở nhiều store.
function verificationKey(storeId, recordKey) {
    return `${String(storeId)}::${String(recordKey)}`;
}

function getVerification(storeId, recordKey, filePath = FILE_PATH) {
    const record = readStore(filePath).verifications[verificationKey(storeId, recordKey)];
    // Đã hoàn tác thì coi như không có.
    if (!record || record.revoked === true) return null;
    return record;
}

// Đọc toàn bộ bản đồ xác minh đang hiệu lực (đã bỏ bản ghi bị hoàn tác).
function getActiveVerifications(filePath = FILE_PATH) {
    const out = {};
    for (const [key, record] of Object.entries(readStore(filePath).verifications)) {
        if (record && record.revoked !== true) out[key] = record;
    }
    return out;
}

function nowIso() {
    return new Date().toISOString();
}

// Ghi nhận xác minh của quản trị viên.
//
// `reason` là bắt buộc: một thay đổi định tuyến không có lý do thì sau này không ai
// kiểm tra lại được vì sao nó được thực hiện.
function verifySource(input = {}, filePath = FILE_PATH) {
    const storeId = String(input.storeId || "").trim();
    const recordKey = String(input.recordKey || "").trim();
    const botId = String(input.botId || "").trim().toLowerCase();
    const reason = String(input.reason || "").trim();

    if (!storeId) throw new Error("Thiếu storeId");
    if (!recordKey) throw new Error("Thiếu recordKey");
    if (!isAssignableSource(botId)) throw new Error(`Nguồn không hợp lệ để gán: ${botId || "(trống)"}`);
    if (!reason) throw new Error("Phải nêu lý do xác minh");
    if (input.confirmed !== true) throw new Error("Phải xác nhận rõ ràng trước khi lưu");

    const data = readStore(filePath);
    const key = verificationKey(storeId, recordKey);
    const previous = data.verifications[key] || null;

    data.verifications[key] = {
        storeId,
        recordKey,
        botId,
        verifiedBy: String(input.verifiedBy || "").trim() || "unknown",
        verifiedAt: nowIso(),
        reason,
        // Giữ lại lịch sử: xác minh trước đó vẫn tra được.
        previousBotId: previous && previous.revoked !== true ? previous.botId : null,
        revoked: false,
        revokedBy: null,
        revokedAt: null
    };
    writeStore(data, filePath);
    return data.verifications[key];
}

// Hoàn tác một xác minh. Bản ghi trở lại trạng thái chưa xác minh — KHÔNG tự gán
// cho bot nào khác.
function revokeVerification(input = {}, filePath = FILE_PATH) {
    const storeId = String(input.storeId || "").trim();
    const recordKey = String(input.recordKey || "").trim();
    const reason = String(input.reason || "").trim();
    if (!storeId || !recordKey) throw new Error("Thiếu storeId hoặc recordKey");
    if (!reason) throw new Error("Phải nêu lý do hoàn tác");

    const data = readStore(filePath);
    const key = verificationKey(storeId, recordKey);
    const existing = data.verifications[key];
    if (!existing || existing.revoked === true) return null;

    existing.revoked = true;
    existing.revokedBy = String(input.revokedBy || "").trim() || "unknown";
    existing.revokedAt = nowIso();
    existing.revokeReason = reason;
    writeStore(data, filePath);
    return existing;
}

function listVerifications(filePath = FILE_PATH) {
    return Object.values(readStore(filePath).verifications)
        .filter((record) => record && record.revoked !== true)
        .sort((a, b) => String(b.verifiedAt).localeCompare(String(a.verifiedAt)));
}

function getCounts(filePath = FILE_PATH) {
    const all = Object.values(readStore(filePath).verifications);
    return {
        active: all.filter((record) => record && record.revoked !== true).length,
        revoked: all.filter((record) => record && record.revoked === true).length
    };
}

module.exports = {
    FILE_PATH,
    SCHEMA_VERSION,
    getActiveVerifications,
    getCounts,
    getVerification,
    isAssignableSource,
    listVerifications,
    revokeVerification,
    verificationKey,
    verifySource
};
