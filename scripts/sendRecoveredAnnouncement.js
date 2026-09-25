#!/usr/bin/env node
// ============================================================================
// Gửi MỘT LẦN thông báo tới danh sách liên hệ đã khôi phục — KHÔNG nạp chúng
// trở lại Firestore.
//
// BỐI CẢNH
//
// Sau khi dữ liệu bot bị đặt lại, ta có một file `recovered-interactions.json`
// chứa danh sách liên hệ cũ. Việc cần làm là gửi MỘT thông báo xin lỗi tới những
// người đó để họ tự thiết lập lại, NHƯNG KHÔNG được khôi phục danh bạ cũ vào
// Firestore — nạp lại sẽ hồi sinh dữ liệu đã hỏng và phá trạng thái sạch.
//
// Vì vậy script này đọc file nguồn như DỮ LIỆU ĐẦU VÀO thuần tuý. Nó KHÔNG BAO
// GIỜ ghi vào interactions, chatDirectory, subscriptions hay bất kỳ store nào.
//
//   # 1. Xem trước (không gửi, không ghi gì)
//   node scripts/sendRecoveredAnnouncement.js \
//       --campaign reset-2026-09 --message-file announce.txt
//
//   # 2. Gửi thật
//   node scripts/sendRecoveredAnnouncement.js \
//       --campaign reset-2026-09 --message-file announce.txt --send
//
//   # 3. Chạy tiếp sau khi bị dừng giữa chừng (tự bỏ qua người đã gửi thành công)
//   node scripts/sendRecoveredAnnouncement.js \
//       --campaign reset-2026-09 --message-file announce.txt --send --resume
//
//   # 4. Xem báo cáo tiến độ của một chiến dịch
//   node scripts/sendRecoveredAnnouncement.js --campaign reset-2026-09 --report
//
// ---------------------------------------------------------------------------
// QUY TẮC AN TOÀN (đọc trước khi sửa)
// ---------------------------------------------------------------------------
// 1. KHÔNG GHI FIRESTORE. Script chỉ đọc file nguồn và gửi tin. Checkpoint ghi ra
//    file cục bộ đã được .gitignore.
//
// 2. FAIL-CLOSED THEO NGUỒN. Chỉ gửi cho bản ghi khai báo `botId` hợp lệ. Không
//    đoán chủ sở hữu. Không bao giờ rơi từ bot2/bot3/ZCA về bot1.
//
// 3. CHỐNG GỬI TRÙNG. Khóa chống trùng là (botId, chatId), không phải chatId trần
//    — cùng Chat ID ở hai bot là hai người khác nhau. Một khi đã gửi thành công
//    thì checkpoint ghi lại và không bao giờ gửi lại, kể cả khi chạy lại.
//
// 4. LỖI VĨNH VIỄN KHÔNG ĐƯỢC THỬ LẠI Ở BOT KHÁC. 410/422 = bỏ qua vĩnh viễn.
//
// 5. TIMEOUT ĐƯỢC XỬ LÝ THẬN TRỌNG. Một lần gửi bị timeout KHÔNG được coi là đã
//    gửi (sẽ gửi lại ở lần --resume), nhưng cũng KHÔNG tự động thử lại ngay trong
//    cùng một lượt — tránh gửi trùng cho người đã nhận.
//
// 6. ZCA TRONG CÙNG TIẾN TRÌNH. Tài khoản Zalo cá nhân giữ khoá phiên độc quyền.
//    Không được mở tiến trình thứ hai tranh khoá đó. Script này chỉ gửi phần ZCA
//    khi tiến trình chính đang chạy và phiên đã đăng nhập — nếu không, báo cáo
//    phần đó là "hoãn" (deferred), KHÔNG phải "đã gửi".
//
// 7. KHÔNG RÒ RỈ DANH TÍNH. Log chỉ in số đếm, tên bot và vân tay rút gọn.
// ============================================================================
const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const {
    LEGACY_BOT_ID,
    isZcaId,
    normalizeBotId,
    providerTypeOf,
    resolveBotConfigs
} = require("../bots");
const { classifyDeliveryError, DELIVERY_ERROR_KIND } = require("../deliveryErrors");

const DEFAULT_SOURCE = path.join(__dirname, "..", "recovered-interactions.json");
const CHECKPOINT_DIR = path.join(__dirname, "..", "data", "announcement-checkpoints");

// Nhãn cho bản ghi không có botId hợp lệ. Chỉ dùng trong BÁO CÁO; không bao giờ gửi.
const UNVERIFIED_LABEL = "(chưa xác minh)";

/* -------------------------------------------------------------------------- */
/* Hàm thuần — kiểm tra được mà không cần mạng                                 */
/* -------------------------------------------------------------------------- */

// Khóa chống trùng: (botId, chatId). KHÔNG BAO GIỜ chỉ chatId.
function recipientKey(botId, chatId) {
    return `${botId}::${String(chatId)}`;
}

// Vân tay rút gọn để đối chiếu trong log mà không lộ danh tính.
function fingerprint(value) {
    const raw = String(value == null ? "" : value);
    if (!raw) return "(trống)";
    let hash = 0;
    for (let index = 0; index < raw.length; index += 1) {
        hash = (hash * 31 + raw.charCodeAt(index)) | 0;
    }
    return `#${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

// Chuẩn hoá nguồn (object khóa→bản ghi, hoặc mảng bản ghi) thành mảng phẳng.
function normalizeSourceRecords(raw) {
    const rows = [];
    if (Array.isArray(raw)) {
        for (const item of raw) {
            if (item && typeof item === "object" && item.chatId != null) rows.push({ key: null, record: item });
        }
        return rows;
    }
    if (!raw || typeof raw !== "object") return rows;
    for (const [key, value] of Object.entries(raw)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        rows.push({ key, record: value });
    }
    return rows;
}

// Phân loại TOÀN BỘ bản ghi nguồn thành danh sách người nhận hợp lệ.
//
// Trả về {
//   recipients: [{ botId, chatId, key }],
//   excluded:   [{ chatId, reason, botId }],
//   perBot:     { botId: n },
//   duplicates: n
// }
function classifyRecipients(raw) {
    const recipients = [];
    const excluded = [];
    const seen = new Map();
    let duplicates = 0;

    for (const { key, record } of normalizeSourceRecords(raw)) {
        const chatId = record.chatId == null ? null : String(record.chatId).trim();
        if (!chatId) {
            excluded.push({ chatId: null, botId: null, reason: "thiếu chatId" });
            continue;
        }
        const botId = normalizeBotId(record.botId);
        if (!botId) {
            excluded.push({ chatId, botId: null, reason: "không khai báo botId hợp lệ" });
            continue;
        }
        // Tiền tố khóa (nếu có) phải khớp botId. Lệch nhau ⇒ không tin được cái nào.
        if (key && typeof key === "string" && key.includes("::")) {
            const prefixBot = normalizeBotId(key.slice(0, key.indexOf("::")));
            if (prefixBot && prefixBot !== botId) {
                excluded.push({ chatId, botId, reason: `khóa "${key.slice(0, key.indexOf("::"))}::" lệch với botId "${botId}"` });
                continue;
            }
        }
        const dedupeKey = recipientKey(botId, chatId);
        if (seen.has(dedupeKey)) {
            duplicates += 1;
            continue;
        }
        seen.set(dedupeKey, true);
        recipients.push({ botId, chatId, key: dedupeKey });
    }

    const perBot = {};
    for (const item of recipients) perBot[item.botId] = (perBot[item.botId] || 0) + 1;

    return { recipients, excluded, perBot, duplicates };
}

// Soạn kế hoạch gửi: bỏ những người đã gửi thành công trong checkpoint cũ.
function planSend(recipients, checkpoint) {
    const done = new Set(Object.keys(checkpoint?.sent || {}));
    const toSend = [];
    let alreadySent = 0;
    for (const recipient of recipients) {
        if (done.has(recipient.key)) {
            alreadySent += 1;
            continue;
        }
        toSend.push(recipient);
    }
    return { toSend, alreadySent };
}

// Cổng kiểm tra trạng thái nhà cung cấp. Trả về { available, reason }.
//
// Nhà cung cấp chính thức cần token; ZCA cần phiên đã đăng nhập trong CÙNG tiến
// trình. Không có thì đích thuộc nhà cung cấp đó bị HOÃN, không phải thất bại.
function checkProviderAvailability(botId, runtimeRegistry, officialConfigs) {
    if (isZcaId(botId)) {
        const runtime = runtimeRegistry?.get?.(botId);
        if (!runtime) {
            return { available: false, reason: "zca_not_running_in_process" };
        }
        if (typeof runtime.health === "function") {
            const health = runtime.health();
            if (health && health.ready === false) return { available: false, reason: "zca_not_ready" };
        }
        return { available: true };
    }
    const config = (officialConfigs || []).find((item) => item.botId === botId);
    if (!config) return { available: false, reason: "bot_not_configured" };
    return { available: true };
}

/* -------------------------------------------------------------------------- */
/* Checkpoint (cục bộ, đã .gitignore)                                          */
/* -------------------------------------------------------------------------- */

function checkpointPath(campaignId) {
    const safe = String(campaignId).replace(/[^A-Za-z0-9_.-]/g, "_");
    return path.join(CHECKPOINT_DIR, `${safe}.json`);
}

function readCheckpoint(campaignId) {
    const file = checkpointPath(campaignId);
    if (!fs.existsSync(file)) return { campaignId, sent: {}, failed: {}, deferred: {}, updatedAt: null };
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        return {
            campaignId,
            sent: parsed.sent && typeof parsed.sent === "object" ? parsed.sent : {},
            failed: parsed.failed && typeof parsed.failed === "object" ? parsed.failed : {},
            deferred: parsed.deferred && typeof parsed.deferred === "object" ? parsed.deferred : {},
            updatedAt: parsed.updatedAt || null
        };
    } catch (error) {
        throw new Error(`Checkpoint hỏng, không dám ghi đè: ${file} (${error.message})`);
    }
}

// Ghi checkpoint NGUYÊN TỬ: ghi ra file tạm rồi đổi tên. Một lần ghi đứt giữa
// chừng không được làm mất tiến độ đã có (dẫn tới gửi trùng ở lần chạy sau).
function writeCheckpoint(campaignId, checkpoint) {
    fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
    const file = checkpointPath(campaignId);
    const tmp = `${file}.tmp`;
    const payload = { ...checkpoint, campaignId, updatedAt: new Date().toISOString() };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return file;
}

function readSourceFile(sourcePath) {
    const resolved = path.resolve(sourcePath);
    if (!fs.existsSync(resolved)) throw new Error(`Không tìm thấy file nguồn: ${resolved}`);
    try {
        return JSON.parse(fs.readFileSync(resolved, "utf8"));
    } catch (error) {
        throw new Error(`File nguồn không phải JSON hợp lệ: ${error.message}`);
    }
}

/* -------------------------------------------------------------------------- */
/* Gửi                                                                          */
/* -------------------------------------------------------------------------- */

// Gửi một tin qua nhà cung cấp cụ thể, KHÔNG BAO GIỜ rơi về bot khác.
//
// `getProvider(botId)` trả về nhà cung cấp đang chạy trong tiến trình, hoặc null.
async function sendOne(getProvider, recipient, message) {
    const provider = getProvider(recipient.botId);
    if (!provider) {
        return { status: "deferred", reason: "provider_unavailable" };
    }
    try {
        const result = await provider.sendMessage(recipient.chatId, message, { parse_mode: "markdown" });
        // Provider có thể trả về {message_id} hoặc không trả gì; cả hai đều là thành công.
        void result;
        return { status: "sent" };
    } catch (error) {
        const classification = classifyDeliveryError(error);
        if (classification.kind === DELIVERY_ERROR_KIND.PERMANENT) {
            // Bỏ qua VĨNH VIỄN. Không thử bot khác — không có cơ sở nào để đổi tài khoản.
            return { status: "failed", reason: classification.reason || "permanent", permanent: true };
        }
        // Tạm thời / không chắc chắn: giữ lại để lần --resume thử lại. KHÔNG thử lại
        // ngay trong cùng một lượt.
        return { status: "failed", reason: classification.reason || "transient", permanent: false };
    }
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                          */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
    const get = (flag) => {
        const index = argv.findIndex((value) => value === flag);
        return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
    };
    return {
        send: argv.includes("--send"),
        resume: argv.includes("--resume"),
        report: argv.includes("--report"),
        campaign: get("--campaign") || get("-c"),
        messageFile: get("--message-file") || get("-m"),
        source: get("--source") || get("-s") || DEFAULT_SOURCE
    };
}

function formatCounts(counts) {
    const keys = Object.keys(counts).sort();
    if (keys.length === 0) return "(không có)";
    return keys.map((key) => `${key}=${counts[key]}`).join(", ");
}

// Lấy registry nhà cung cấp của tiến trình chính.
//
// `options.runtimeRegistry` (khi gọi theo lập trình) được ưu tiên; nếu không thì
// đọc từ globalThis — nơi main.js đặt registry khi khởi động. Trả về null nếu
// không có, và nơi gọi PHẢI từ chối gửi thay vì tự mở phiên mới.
function resolveRuntimeRegistry(options = {}) {
    if (options.runtimeRegistry) return options.runtimeRegistry;
    return globalThis.__ZALOBOT_RUNTIMES__ || null;
}

function reportExcluded(excluded) {
    if (excluded.length === 0) return;
    const byReason = {};
    for (const item of excluded) byReason[item.reason] = (byReason[item.reason] || 0) + 1;
    console.log(`[Announce] LOẠI KHỎI đợt gửi: ${excluded.length} bản ghi không đủ điều kiện.`);
    for (const [reason, count] of Object.entries(byReason).sort()) {
        console.log(`[Announce]   - ${reason}: ${count}`);
    }
}

// In báo cáo một chiến dịch từ checkpoint, không gửi gì.
function printReport(campaignId) {
    const checkpoint = readCheckpoint(campaignId);
    const sent = Object.keys(checkpoint.sent).length;
    const failed = Object.keys(checkpoint.failed).length;
    const deferred = Object.keys(checkpoint.deferred).length;
    console.log(`[Announce] Chiến dịch: ${campaignId}`);
    console.log(`[Announce]   đã gửi: ${sent} · thất bại: ${failed} · hoãn: ${deferred}`);
    console.log(`[Announce]   cập nhật lần cuối: ${checkpoint.updatedAt || "(chưa chạy)"}`);
    const byBot = {};
    for (const key of Object.keys(checkpoint.sent)) {
        const bot = key.split("::")[0];
        byBot[bot] = (byBot[bot] || 0) + 1;
    }
    console.log(`[Announce]   đã gửi theo bot: ${formatCounts(byBot)}`);
}

async function main(argv = process.argv.slice(2), options = {}) {
    const args = parseArgs(argv);

    if (!args.campaign) {
        throw new Error("Bắt buộc có --campaign ID (ví dụ: --campaign reset-2026-09).");
    }
    if (args.report) {
        printReport(args.campaign);
        return { reported: true };
    }

    if (!args.messageFile) {
        throw new Error("Bắt buộc có --message-file <đường dẫn> (file chứa nội dung thông báo).");
    }
    const messagePath = path.resolve(args.messageFile);
    if (!fs.existsSync(messagePath)) throw new Error(`Không tìm thấy file nội dung: ${messagePath}`);
    const message = fs.readFileSync(messagePath, "utf8").trim();
    if (!message) throw new Error(`File nội dung rỗng: ${messagePath}`);

    const raw = readSourceFile(args.source);
    const { recipients, excluded, perBot, duplicates } = classifyRecipients(raw);

    console.log(`[Announce] Chiến dịch: ${args.campaign}`);
    console.log(`[Announce] Nguồn: ${path.resolve(args.source)}`);
    console.log(`[Announce] Người nhận hợp lệ: ${recipients.length}. Theo bot: ${formatCounts(perBot)}`);
    console.log(`[Announce] Trùng lặp trong nguồn (đã gộp): ${duplicates}`);
    reportExcluded(excluded);

    if (recipients.length === 0) {
        console.log("[Announce] Không có người nhận nào đủ điều kiện. Dừng.");
        return { sent: 0, reason: "no_recipients" };
    }

    // Nguồn có ZCA: nếu không chạy trong tiến trình chính, báo là HOÃN chứ không lỗi.
    const zcaRecipients = recipients.filter((item) => isZcaId(item.botId));
    if (zcaRecipients.length > 0) {
        console.log(
            `[Announce] Lưu ý: ${zcaRecipients.length} đích thuộc tài khoản ZCA. ` +
            "Script độc lập KHÔNG giữ phiên ZCA — hãy dùng --in-process khi bot chính đang chạy, " +
            "nếu không chúng sẽ được báo là 'hoãn'."
        );
    }

    const checkpoint = readCheckpoint(args.campaign);
    const { toSend, alreadySent } = planSend(recipients, checkpoint);
    console.log(`[Announce] Checkpoint đã có: ${alreadySent} người đã gửi (sẽ bỏ qua).`);
    console.log(`[Announce] Còn phải gửi: ${toSend.length}.`);

    if (!args.send) {
        console.log("");
        console.log("[Announce] DRY-RUN: chưa gửi gì, chưa ghi gì.");
        console.log("[Announce] Thêm --send để gửi thật.");
        return { dryRun: true, planned: toSend.length, alreadySent, perBot };
    }

    // Gửi thật cần nhà cung cấp đang chạy. Nhà cung cấp được lấy qua registry.
    //
    // `main.js` đăng ký registry của nó vào globalThis khi khởi động để đường CLI
    // này có thể gửi TRONG CÙNG tiến trình — điều kiện bắt buộc để dùng chung phiên
    // ZCA. Không có registry ⇒ từ chối chạy, thay vì mở tiến trình thứ hai tranh khoá.
    const runtimeRegistry = resolveRuntimeRegistry(options);
    if (!runtimeRegistry) {
        throw new Error(
            "Không tìm thấy registry nhà cung cấp đang chạy. " +
            "Hãy gọi hàm này từ tiến trình chính (main.js) khi bot đang chạy — " +
            "xem ANNOUNCEMENT.md. Script độc lập không tự mở phiên Zalo để tránh tranh khoá phiên ZCA."
        );
    }
    const officialConfigs = resolveBotConfigs(process.env);
    const getProvider = (botId) => runtimeRegistry.get(botId) || null;

    let sent = 0;
    let failed = 0;
    let deferred = 0;
    for (const recipient of toSend) {
        const availability = checkProviderAvailability(recipient.botId, runtimeRegistry, officialConfigs);
        if (!availability.available) {
            deferred += 1;
            checkpoint.deferred[recipient.key] = { reason: availability.reason, at: new Date().toISOString() };
            continue;
        }
        const outcome = await sendOne(getProvider, recipient, message);
        if (outcome.status === "sent") {
            sent += 1;
            checkpoint.sent[recipient.key] = { at: new Date().toISOString() };
            delete checkpoint.deferred[recipient.key];
            delete checkpoint.failed[recipient.key];
        } else if (outcome.status === "deferred") {
            deferred += 1;
            checkpoint.deferred[recipient.key] = { reason: outcome.reason, at: new Date().toISOString() };
        } else {
            failed += 1;
            checkpoint.failed[recipient.key] = { reason: outcome.reason, permanent: Boolean(outcome.permanent), at: new Date().toISOString() };
        }
        // Ghi checkpoint sau MỖI tin: dừng đột ngột không được làm mất tiến độ.
        writeCheckpoint(args.campaign, checkpoint);
    }

    const file = writeCheckpoint(args.campaign, checkpoint);
    console.log("");
    console.log(`[Announce] XONG. đã gửi: ${sent} · thất bại: ${failed} · hoãn: ${deferred}`);
    console.log(`[Announce] Checkpoint: ${file}`);
    console.log("[Announce] Chạy lại với --report để xem báo cáo đầy đủ.");
    return { sent, failed, deferred };
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[Announce] Thất bại: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    CHECKPOINT_DIR,
    DEFAULT_SOURCE,
    UNVERIFIED_LABEL,
    checkProviderAvailability,
    checkpointPath,
    classifyRecipients,
    fingerprint,
    main,
    normalizeSourceRecords,
    parseArgs,
    planSend,
    readCheckpoint,
    readSourceFile,
    recipientKey,
    resolveRuntimeRegistry,
    writeCheckpoint
};
