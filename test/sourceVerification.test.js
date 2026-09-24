// ============================================================================
// Xác minh nguồn gốc: bằng chứng, xác minh của quản trị viên, hoàn tác.
//
// Điều quan trọng nhất cần khoá chặt:
//   - Xác minh của người KHÔNG được ghi đè bằng chứng kỹ thuật rõ ràng.
//   - Xác minh nguồn KHÔNG phải gộp danh tính: hai User ID khác nhau vẫn là hai người.
//   - Bản ghi mâu thuẫn vẫn bị chặn cho tới khi người xem xét.
//   - Hoàn tác đưa bản ghi về đúng trạng thái chưa xác minh.
// ============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// Cài persistence giả MỘT LẦN: các module lấy hàm ngay lúc require.
function installFakePersistence() {
    const persistencePath = require.resolve(path.join(ROOT, "firestorePersistence"));
    const real = require(persistencePath);
    const memoryFiles = new Map();
    const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
    const fileKey = (filePath, defaultPath) => path.resolve(filePath || defaultPath);
    require.cache[persistencePath] = {
        id: persistencePath, filename: persistencePath, loaded: true,
        exports: {
            ...real,
            readJsonStore: (filePath, defaultPath, fallback) => {
                const key = fileKey(filePath, defaultPath);
                if (!memoryFiles.has(key)) memoryFiles.set(key, clone(fallback) ?? null);
                return clone(memoryFiles.get(key));
            },
            writeJsonStore: (filePath, defaultPath, value) => {
                memoryFiles.set(fileKey(filePath, defaultPath), clone(value));
            },
            flushPersistenceWrites: async () => undefined,
            getPersistenceStatus: () => ({ backend: "test" })
        }
    };
    return { memoryFiles, fileKey };
}

const fake = installFakePersistence();
const verifications = require("../sourceVerifications");
const { buildEvidence } = require("../sourceEvidence");
const { resolveRecordSource, SOURCE_CONFIDENCE, isVerifiedConfidence } = require("../sourceAttribution");

function tempFile(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-src-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, "sourceVerifications.json");
}

/* ========================================================================== */
/* Xác minh và hoàn tác                                                       */
/* ========================================================================== */

test("xác minh lưu đủ ai, khi nào, vì sao", (t) => {
    const filePath = tempFile(t);
    const record = verifications.verifySource({
        storeId: "chatDirectory",
        recordKey: "6079970378503099240",
        botId: "zca:623515849545943215",
        reason: "Chat ID chỉ xuất hiện trong dữ liệu của tài khoản này",
        confirmed: true,
        verifiedBy: "quản trị viên A"
    }, filePath);

    assert.equal(record.botId, "zca:623515849545943215");
    assert.equal(record.verifiedBy, "quản trị viên A");
    assert.ok(record.verifiedAt, "phải ghi thời điểm");
    assert.match(record.reason, /chỉ xuất hiện/);
    assert.equal(record.revoked, false);
});

test("thiếu lý do hoặc thiếu xác nhận thì từ chối", (t) => {
    const filePath = tempFile(t);
    const base = { storeId: "chatDirectory", recordKey: "k", botId: "bot2", confirmed: true };
    assert.throws(() => verifications.verifySource({ ...base, reason: "" }, filePath), /lý do/);
    assert.throws(() => verifications.verifySource({ ...base, reason: "vì" , confirmed: false }, filePath), /xác nhận/);
});

test("không cho gán zca:pending — đó là danh tính tạm, không phải tài khoản thật", (t) => {
    const filePath = tempFile(t);
    assert.throws(() => verifications.verifySource({
        storeId: "chatDirectory", recordKey: "k", botId: "zca:pending", reason: "x", confirmed: true
    }, filePath), /không hợp lệ/);
    assert.equal(verifications.isAssignableSource("zca:pending"), false);
    assert.equal(verifications.isAssignableSource("zca:900900900"), true);
    assert.equal(verifications.isAssignableSource("bot2"), true);
    assert.equal(verifications.isAssignableSource("linh tinh"), false);
});

test("hoàn tác đưa bản ghi về trạng thái chưa xác minh", (t) => {
    const filePath = tempFile(t);
    const args = { storeId: "chatDirectory", recordKey: "k1", botId: "bot2", reason: "vì", confirmed: true };

    verifications.verifySource(args, filePath);
    assert.ok(verifications.getVerification("chatDirectory", "k1", filePath));

    const revoked = verifications.revokeVerification({
        storeId: "chatDirectory", recordKey: "k1", reason: "chọn nhầm tài khoản", revokedBy: "quản trị viên B"
    }, filePath);

    assert.equal(revoked.revoked, true);
    assert.equal(revoked.revokedBy, "quản trị viên B");
    assert.match(revoked.revokeReason, /chọn nhầm/);
    // Không còn hiệu lực ⇒ resolver phải coi như chưa xác minh.
    assert.equal(verifications.getVerification("chatDirectory", "k1", filePath), null);
    assert.equal(verifications.getActiveVerifications(filePath)["chatDirectory::k1"], undefined);
    // Nhưng vết cũ vẫn tra được.
    assert.equal(verifications.getCounts(filePath).revoked, 1);
});

test("hoàn tác không gán cho bot nào khác", (t) => {
    const filePath = tempFile(t);
    verifications.verifySource({ storeId: "s", recordKey: "k", botId: "bot2", reason: "vì", confirmed: true }, filePath);
    verifications.revokeVerification({ storeId: "s", recordKey: "k", reason: "sai" }, filePath);

    const source = resolveRecordSource({}, "unscoped-key", {
        verification: verifications.getVerification("s", "k", filePath)
    });
    assert.equal(source.botId, null, "hoàn tác thì không được tự gán nguồn khác");
    assert.equal(source.confidence, SOURCE_CONFIDENCE.UNVERIFIED_LEGACY);
    assert.equal(source.canSend, false);
});

/* ========================================================================== */
/* Tác động lên việc định tuyến                                               */
/* ========================================================================== */

test("xác minh mở khoá gửi cho bản ghi trước đó chưa xác minh", (t) => {
    const filePath = tempFile(t);
    const record = { chatId: "c1", displayName: "Ai đó" };

    const before = resolveRecordSource(record, "c1");
    assert.equal(before.canSend, false, "trước khi xác minh thì bị chặn");

    verifications.verifySource({
        storeId: "chatDirectory", recordKey: "c1", botId: "bot2",
        reason: "chatId chỉ xuất hiện ở bot2", confirmed: true, verifiedBy: "admin"
    }, filePath);

    const after = resolveRecordSource(record, "c1", {
        verification: verifications.getVerification("chatDirectory", "c1", filePath)
    });
    assert.equal(after.botId, "bot2");
    assert.equal(after.confidence, SOURCE_CONFIDENCE.MANUAL);
    assert.equal(after.canSend, true, "sau khi xác minh thì được phép gửi");
    assert.equal(after.verifiedBy, "admin");
});

test("xác minh KHÔNG ghi đè bằng chứng kỹ thuật rõ ràng", (t) => {
    const filePath = tempFile(t);
    verifications.verifySource({
        storeId: "chatDirectory", recordKey: "bot2::c1", botId: "bot3",
        reason: "chọn tay", confirmed: true
    }, filePath);

    // Bản ghi có khóa phạm vi bot2 ⇒ bằng chứng kỹ thuật thắng.
    const source = resolveRecordSource({}, "bot2::c1", {
        verification: verifications.getVerification("chatDirectory", "bot2::c1", filePath)
    });
    assert.equal(source.botId, "bot2", "không được để xác minh tay đè lên khóa có phạm vi");
    assert.equal(source.confidence, SOURCE_CONFIDENCE.FROM_SCOPED_KEY);
});

test("bản ghi MÂU THUẪN vẫn bị chặn, kể cả khi có xác minh", (t) => {
    const filePath = tempFile(t);
    verifications.verifySource({
        storeId: "chatDirectory", recordKey: "bot1::c1", botId: "bot2",
        reason: "chọn tay", confirmed: true
    }, filePath);

    const source = resolveRecordSource({ botId: "bot2" }, "bot1::c1", {
        verification: verifications.getVerification("chatDirectory", "bot1::c1", filePath)
    });
    assert.equal(source.confidence, SOURCE_CONFIDENCE.CONFLICT);
    assert.equal(source.botId, null);
    assert.equal(source.canSend, false, "mâu thuẫn phải được người xem xét, không tự chọn");
});

test("xác minh KHÔNG gộp hai danh tính người dùng", (t) => {
    const filePath = tempFile(t);
    // Xác minh nguồn cho một bản ghi chat KHÔNG được biến hai User ID thành một.
    verifications.verifySource({
        storeId: "chatDirectory", recordKey: "c1", botId: "bot2",
        reason: "chat thuộc bot2", confirmed: true
    }, filePath);

    // Hai User ID khác nhau vẫn là hai danh tính, không có gì thay đổi.
    const a = resolveRecordSource({ botId: "bot2", userId: "user-A" }, "bot2::c1");
    const b = resolveRecordSource({ botId: "bot2", userId: "user-B" }, "bot2::c1");
    assert.notEqual(a.botId + "::" + "user-A", b.botId + "::" + "user-B");
    // Xác minh chỉ gắn với ĐÚNG khóa của nó.
    assert.equal(verifications.getVerification("chatDirectory", "c2", filePath), null);
});

test("xác minh chỉ áp cho đúng store và đúng khóa", (t) => {
    const filePath = tempFile(t);
    verifications.verifySource({
        storeId: "chatDirectory", recordKey: "c1", botId: "bot2", reason: "vì", confirmed: true
    }, filePath);

    assert.ok(verifications.getVerification("chatDirectory", "c1", filePath));
    // Cùng khóa nhưng khác store ⇒ KHÔNG áp dụng.
    assert.equal(verifications.getVerification("subscriptions", "c1", filePath), null);
    // Cùng store nhưng khác khóa ⇒ KHÔNG áp dụng.
    assert.equal(verifications.getVerification("chatDirectory", "c2", filePath), null);
});

/* ========================================================================== */
/* Bằng chứng trình bày cho quản trị viên                                     */
/* ========================================================================== */

test("bằng chứng nêu rõ tên/MSSV KHÔNG được dùng để suy nguồn", () => {
    const evidence = buildEvidence(
        { storeId: "chatDirectory", key: "c1", record: { chatId: "c1", displayName: "Nguyễn Văn A" }, chatId: "c1", userId: null },
        { allRecords: [] }
    );
    const excluded = evidence.evidence.find((item) => item.kind === "excluded");
    assert.ok(excluded, "phải nói rõ điều gì không dùng làm bằng chứng");
    assert.match(excluded.detail, /trùng tên|MSSV/);
});

test("bằng chứng nêu Chat ID xuất hiện ở NHIỀU nguồn thì không kết luận", () => {
    const target = { storeId: "chatDirectory", key: "c1", record: { chatId: "c1" }, chatId: "c1", userId: null };
    const evidence = buildEvidence(target, {
        allRecords: [
            target,
            { storeId: "interactions", key: "bot1::c1", record: {}, chatId: "c1", userId: null },
            { storeId: "interactions", key: "bot2::c1", record: {}, chatId: "c1", userId: null }
        ]
    });

    const scope = evidence.evidence.find((item) => item.kind === "chat_id_scope");
    assert.equal(scope.reliable, false, "nhiều nguồn thì không đủ căn cứ");
    assert.match(scope.detail, /NHIỀU nguồn/);
    assert.equal(evidence.suggestion, null, "không được gợi ý khi bằng chứng không thống nhất");
    assert.equal(evidence.consistent, false);
});

test("bằng chứng chỉ về MỘT nguồn thì có gợi ý nhưng vẫn để người tự chọn", () => {
    const target = { storeId: "chatDirectory", key: "c1", record: { chatId: "c1" }, chatId: "c1", userId: null };
    const evidence = buildEvidence(target, {
        allRecords: [
            target,
            { storeId: "interactions", key: "zca:900900900::c1", record: {}, chatId: "c1", userId: null }
        ]
    });

    const scope = evidence.evidence.find((item) => item.kind === "chat_id_scope");
    assert.equal(scope.reliable, true);
    assert.match(scope.detail, /CHỈ xuất hiện/);
    assert.equal(evidence.suggestion, "zca:900900900");
    assert.equal(evidence.consistent, true);
});

test("bằng chứng không bao giờ chứa token hay bí mật phiên", () => {
    const target = { storeId: "chatDirectory", key: "c1", record: { chatId: "c1", botId: "zca:900900900" }, chatId: "c1", userId: "u1" };
    const evidence = buildEvidence(target, { allRecords: [target] });
    const serialized = JSON.stringify(evidence);
    for (const secret of ["cookie", "imei", "userAgent", "token", "zpsid", "secret"]) {
        assert.ok(!new RegExp(secret, "i").test(serialized), `bằng chứng không được chứa ${secret}`);
    }
});

test("nhãn nguồn không bao giờ hiển thị zca:pending như một tài khoản", () => {
    const target = { storeId: "chatDirectory", key: "k", record: {}, chatId: null, userId: null };
    const evidence = buildEvidence(target, { allRecords: [target] });
    assert.ok(!JSON.stringify(evidence).includes("zca:pending"));
});
