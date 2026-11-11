// ============================================================================
// Nguồn gốc của một bản ghi: thuộc bot nào, và điều đó có ĐƯỢC XÁC MINH không.
//
// Vì sao cần một module riêng:
//
// Trước đây cả server lẫn dashboard đều tự suy ra nguồn, và cả hai đều mặc định
// về bot1 khi thiếu thông tin:
//   - adminDataService.botIdOf() dùng parseScopedKey(key).botId, mà hàm đó trả
//     bot1 cho MỌI khóa không có phạm vi, và cờ `scoped: false` bị bỏ qua.
//   - admin-ui/app.js recordBotId() chỉ chấp nhận /^bot\d+$/, nên khóa
//     "zca:<uid>" không khớp và bị đổi thành bot1.
//
// Hệ quả: bản ghi của tài khoản Zalo cá nhân hiển thị là "bot1", và bản ghi cũ
// không rõ nguồn cũng bị gán cho bot1 mà không có dấu hiệu nào.
//
// Module này là NGUỒN DUY NHẤT cho quy tắc đó. Nó không bao giờ tự gán bot1 khi
// không có bằng chứng: thiếu bằng chứng thì trả về trạng thái CHƯA XÁC MINH.
// ============================================================================
const { normalizeBotId, parseScopedKey, LEGACY_BOT_ID } = require("./bots");

// Mức độ tin cậy của nguồn.
const SOURCE_CONFIDENCE = Object.freeze({
    // Có trường botId rõ ràng và (nếu khóa có phạm vi) khớp với khóa.
    VERIFIED: "verified",
    // Thiếu trường botId nhưng khóa có phạm vi ⇒ khóa chính là bằng chứng.
    FROM_SCOPED_KEY: "from_scoped_key",
    // Quản trị viên đã xác nhận nguồn và ghi rõ lý do.
    MANUAL: "manual",
    // Không có trường botId và khóa không có phạm vi ⇒ KHÔNG đủ căn cứ.
    UNVERIFIED_LEGACY: "unverified_legacy",
    // Trường botId mâu thuẫn với phạm vi của khóa ⇒ không tin được cái nào.
    CONFLICT: "conflict"
});

const CONFIDENCE_LABELS = Object.freeze({
    [SOURCE_CONFIDENCE.VERIFIED]: "Đã xác minh",
    [SOURCE_CONFIDENCE.FROM_SCOPED_KEY]: "Đã xác minh (theo khóa lưu trữ)",
    [SOURCE_CONFIDENCE.MANUAL]: "Đã xác minh (quản trị viên xác nhận)",
    [SOURCE_CONFIDENCE.UNVERIFIED_LEGACY]: "Chưa xác minh",
    [SOURCE_CONFIDENCE.CONFLICT]: "Nguồn mâu thuẫn"
});

// Nguồn chưa xác minh thì KHÔNG được gửi tin: gửi sai bot là gửi cho người khác.
function isVerifiedConfidence(confidence) {
    return confidence === SOURCE_CONFIDENCE.VERIFIED
        || confidence === SOURCE_CONFIDENCE.FROM_SCOPED_KEY
        || confidence === SOURCE_CONFIDENCE.MANUAL;
}

// Nguồn có phải tài khoản Zalo cá nhân (ZCA) không. Dùng để hiển thị tách bạch
// với bot chính thức, KHÔNG dùng để định tuyến — định tuyến luôn dùng botId.
function isPersonalAccountSource(botId) {
    return String(botId || "").startsWith("zca:");
}

// Nhãn hiển thị an toàn khi không có tên thật từ Zalo.
function describeSourceKind(botId) {
    if (!botId) return "Chưa rõ nguồn";
    return isPersonalAccountSource(botId) ? "Tài khoản Zalo cá nhân" : "Bot Zalo chính thức";
}

// Quy tắc trung tâm. `key` là khóa lưu trữ thô trong store (có thể có tiền tố
// `botN::` hoặc `zca:<uid>::`), hoặc rỗng nếu nơi gọi không có khóa.
//
// `options.verification` là bản ghi xác minh của quản trị viên cho đúng bản ghi này
// (nếu có). Xác minh của người KHÔNG ghi đè bằng chứng kỹ thuật — nó chỉ được dùng
// khi bằng chứng không đủ để kết luận, tức là đúng những bản ghi đang chưa xác minh.
function resolveRecordSource(record, key = "", options = {}) {
    const declared = normalizeBotId(record?.botId);
    const parsed = parseScopedKey(key);
    const keyBotId = parsed.scoped ? parsed.botId : null;
    const verification = options.verification || null;

    // Xác minh của quản trị viên đứng trước phần suy đoán, nhưng đứng SAU bằng chứng
    // kỹ thuật rõ ràng: nếu bản ghi đã có nguồn xác minh được thì không cần tới nó,
    // và một xác minh cũ không được phép ghi đè dữ liệu mới hơn.
    const manualFallback = () => {
        if (!verification || !verification.botId) return null;
        return {
            botId: verification.botId,
            confidence: SOURCE_CONFIDENCE.MANUAL,
            label: CONFIDENCE_LABELS[SOURCE_CONFIDENCE.MANUAL],
            canSend: true,
            declaredBotId: declared,
            keyBotId,
            verifiedBy: verification.verifiedBy || null,
            verifiedAt: verification.verifiedAt || null,
            verifyReason: verification.reason || null,
            reason: null
        };
    };

    // Mâu thuẫn: hai nguồn thông tin nói khác nhau. Không tin cái nào — kể cả xác
    // minh của người, vì chính sự mâu thuẫn là điều cần người xem lại.
    if (declared && keyBotId && declared !== keyBotId) {
        return {
            botId: null,
            confidence: SOURCE_CONFIDENCE.CONFLICT,
            label: CONFIDENCE_LABELS[SOURCE_CONFIDENCE.CONFLICT],
            canSend: false,
            declaredBotId: declared,
            keyBotId,
            reason: `Trường botId ghi "${declared}" nhưng khóa lưu trữ thuộc "${keyBotId}".`
        };
    }

    // Có trường botId rõ ràng: đây là nguồn gốc do chính hệ thống ghi ra.
    if (declared) {
        return {
            botId: declared,
            confidence: SOURCE_CONFIDENCE.VERIFIED,
            label: CONFIDENCE_LABELS[SOURCE_CONFIDENCE.VERIFIED],
            canSend: true,
            declaredBotId: declared,
            keyBotId,
            reason: null
        };
    }

    // Thiếu trường botId nhưng khóa có phạm vi: khóa chính là bằng chứng.
    if (keyBotId) {
        return {
            botId: keyBotId,
            confidence: SOURCE_CONFIDENCE.FROM_SCOPED_KEY,
            label: CONFIDENCE_LABELS[SOURCE_CONFIDENCE.FROM_SCOPED_KEY],
            canSend: true,
            declaredBotId: null,
            keyBotId,
            reason: null
        };
    }

    // Không botId, khóa trần. TRƯỚC ĐÂY trường hợp này bị gán cho bot1.
    // Nay giữ trung lập: không có bằng chứng thì không được đoán.
    const manual = manualFallback();
    if (manual) return manual;

    return {
        botId: null,
        confidence: SOURCE_CONFIDENCE.UNVERIFIED_LEGACY,
        label: CONFIDENCE_LABELS[SOURCE_CONFIDENCE.UNVERIFIED_LEGACY],
        canSend: false,
        declaredBotId: null,
        keyBotId: null,
        legacyCandidateBotId: LEGACY_BOT_ID,
        reason: "Không có trường botId và khóa lưu trữ không có phạm vi, nên chưa xác định được nguồn."
    };
}

// Khóa gộp phải gồm nguồn: cùng một chatId ở hai bot là hai cuộc trò chuyện khác
// nhau. Bản ghi chưa xác minh dùng khóa riêng để không trộn với bot nào.
function scopedIdentityKey(botId, chatId) {
    return `${botId || "__unverified__"}::${chatId}`;
}

module.exports = {
    CONFIDENCE_LABELS,
    SOURCE_CONFIDENCE,
    describeSourceKind,
    isPersonalAccountSource,
    isVerifiedConfidence,
    resolveRecordSource,
    scopedIdentityKey
};
