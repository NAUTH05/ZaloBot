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
// CÁCH CHẠY
//
// Lệnh shell chỉ dùng để XEM TRƯỚC và XEM BÁO CÁO — chúng không cần nhà cung cấp:
//
//   # 1. Xem trước (không gửi, không ghi gì)
//   node scripts/sendRecoveredAnnouncement.js \
//       --campaign reset-2026-09 --message-file announce.txt
//
//   # 2. Xem báo cáo tiến độ của một chiến dịch
//   node scripts/sendRecoveredAnnouncement.js --campaign reset-2026-09 --report
//
// GỬI THẬT phải chạy BÊN TRONG tiến trình chính (PM2), vì chỉ tiến trình đó mới giữ
// nhà cung cấp — và phiên ZCA. Một tiến trình shell riêng không bao giờ chạm tới
// registry đang chạy, nên --send từ shell sẽ bị TỪ CHỐI (đúng như mong đợi: mở phiên
// Zalo thứ hai sẽ tranh khoá phiên và làm hỏng phiên đang đăng nhập).
//
// Cách kích hoạt đúng: gọi API quản trị đã xác thực admin (được main.js nối vào
// runRecoveredAnnouncement) — xem ANNOUNCEMENT.md để có lệnh curl đầy đủ.
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
// 4. LỖI VĨNH VIỄN KHÔNG ĐƯỢC THỬ LẠI Ở BOT KHÁC. 410/422 = bỏ qua vĩnh viễn, kể
//    cả ở lần --resume sau (ghi `permanent: true` vào checkpoint).
//
// 5. TIMEOUT ĐƯỢC XỬ LÝ THẬN TRỌNG. Một lần gửi bị timeout KHÔNG được coi là đã
//    gửi (sẽ gửi lại ở lần --resume), nhưng cũng KHÔNG tự động thử lại ngay trong
//    cùng một lượt — tránh gửi trùng cho người đã nhận.
//
// 5b. NHỊP GỬI THEO TỪNG NHÀ CUNG CẤP (announcementPacing.js). Đợt đầu tiên bắn
//    196 đích trong ~2 giây và nhận lại 136 lỗi 429. Từ nay mỗi nhà cung cấp có
//    nhịp riêng: một đích tại một thời điểm, cách nhau `intervalMs`; gặp 429 thì
//    chờ theo `Retry-After` (hoặc giãn cách tăng dần kèm nhiễu), và 429 lặp lại
//    trong cửa sổ ⇒ TẠM DỪNG nhà cung cấp đó thay vì thử nốt số còn lại. Nhà cung
//    cấp bị tạm dừng chỉ ảnh hưởng chính nó; các nhà cung cấp khác tiếp tục.
//
// 6. MÃ CHIẾN DỊCH GẮN VỚI NỘI DUNG. Checkpoint lưu vân tay (nguồn + nội dung tin).
//    Đổi nội dung mà giữ nguyên mã chiến dịch ⇒ TỪ CHỐI chạy, vì người đã nhận bản
//    cũ sẽ bị bỏ qua âm thầm và không bao giờ nhận bản mới. Phải dùng mã mới.
//
// 7. ZCA TRONG CÙNG TIẾN TRÌNH. Tài khoản Zalo cá nhân giữ khoá phiên độc quyền.
//    Không được mở tiến trình thứ hai tranh khoá đó. Phần ZCA chỉ gửi được khi hàm
//    này chạy bên trong tiến trình chính đang giữ phiên — nếu không, báo cáo phần đó
//    là "hoãn" (deferred), KHÔNG phải "đã gửi".
//
// 8. KHÔNG RÒ RỈ DANH TÍNH. Log chỉ in số đếm, tên bot và vân tay rút gọn.
// ============================================================================
const crypto = require("crypto");
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
const {
    PACING_DEFAULTS,
    createPacingController,
    resolvePacingOptions
} = require("../announcementPacing");

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

// Vân tay NỘI DUNG của một chiến dịch: hàm băm (nguồn + nội dung tin).
//
// Vì sao cần: mã chiến dịch do người vận hành đặt tay. Nếu đổi nội dung thông báo
// mà vẫn dùng lại cùng mã, checkpoint cũ sẽ khiến script bỏ qua những người đã nhận
// bản CŨ — họ không bao giờ nhận bản MỚI, và cũng không có cảnh báo nào. Gắn vân tay
// vào checkpoint để phát hiện và TỪ CHỐI thay vì âm thầm tái sử dụng.
//
// Hàm băm đầy đủ (SHA-256) chứ không rút gọn: đây là khoá an toàn, không phải nhãn
// hiển thị. Danh sách người nhận được sắp xếp trước khi băm nên thứ tự trong file
// nguồn không làm đổi vân tay.
function campaignContentHash(recipients, message) {
    const keys = recipients.map((item) => item.key).sort();
    const hasher = crypto.createHash("sha256");
    hasher.update("v1\n");
    hasher.update(String(message == null ? "" : message));
    hasher.update("\n");
    for (const key of keys) hasher.update(`${key}\n`);
    return hasher.digest("hex");
}

// Chuẩn hoá nội dung tin để băm: bỏ khoảng trắng ở hai đầu, giữ nguyên phần thân.
function normalizeCampaignMessage(message) {
    return String(message == null ? "" : message).trim();
}

// Soạn kế hoạch gửi: bỏ những người đã gửi thành công VÀ những người đã thất bại
// VĨNH VIỄN ở lần chạy trước.
//
// Lỗi vĩnh viễn (410 chat không tồn tại, 422 không có quyền) không bao giờ tự khỏi.
// Thử lại chỉ tốn thời gian và có thể khiến nhà cung cấp đánh dấu spam. Chúng bị bỏ
// qua vĩnh viễn, KHÔNG bao giờ được chuyển sang bot khác để thử lại.
//
// Lỗi TẠM THỜI (timeout, 429, 5xx) thì ngược lại: giữ nguyên trong danh sách để lần
// --resume sau thử lại — nhưng không thử lại trong cùng một lượt.
function planSend(recipients, checkpoint) {
    const done = new Set(Object.keys(checkpoint?.sent || {}));
    const permanentlyFailed = new Set(
        Object.entries(checkpoint?.failed || {})
            .filter(([, detail]) => detail && detail.permanent === true)
            .map(([key]) => key)
    );
    const toSend = [];
    let alreadySent = 0;
    let skippedPermanent = 0;
    for (const recipient of recipients) {
        if (done.has(recipient.key)) {
            alreadySent += 1;
            continue;
        }
        if (permanentlyFailed.has(recipient.key)) {
            skippedPermanent += 1;
            continue;
        }
        toSend.push(recipient);
    }
    return { toSend, alreadySent, skippedPermanent };
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

// `resolveBotConfigs()` trả về { bots, errors, warnings } chứ KHÔNG phải một mảng
// trần. Nhận nhầm kiểu sẽ khiến `.find` ném TypeError ngay khi gửi tin thật đầu
// tiên — nên chuẩn hoá ở đây, và chấp nhận cả mảng trần để hàm thuần vẫn kiểm thử
// được mà không cần dựng cấu hình môi trường.
function normalizeOfficialConfigs(officialConfigs) {
    if (Array.isArray(officialConfigs)) return officialConfigs;
    if (officialConfigs && Array.isArray(officialConfigs.bots)) return officialConfigs.bots;
    return [];
}

// Cổng kiểm tra trạng thái nhà cung cấp. Trả về { available, reason }.
//
// Nhà cung cấp chính thức cần token; ZCA cần phiên đã đăng nhập trong CÙNG tiến
// trình. Không có thì đích thuộc nhà cung cấp đó bị HOÃN, không phải thất bại.
function checkProviderAvailability(botId, runtimeRegistry, officialConfigs) {
    // Nhà cung cấp đang chạy trong tiến trình là bằng chứng MẠNH NHẤT: có runtime
    // nghĩa là bot đã khởi động và giữ token/phiên. Kiểm tra trước để không phụ
    // thuộc vào việc cấu hình môi trường có đọc được hay không.
    const runtime = runtimeRegistry?.get?.(botId);
    if (runtime) {
        if (isZcaId(botId) && typeof runtime.health === "function") {
            const health = runtime.health();
            if (health && health.ready === false) return { available: false, reason: "zca_not_ready" };
        }
        return { available: true };
    }
    if (isZcaId(botId)) {
        // Tài khoản cá nhân không có "cấu hình token" để dựa vào — chỉ có phiên.
        return { available: false, reason: "zca_not_running_in_process" };
    }
    const config = normalizeOfficialConfigs(officialConfigs).find((item) => item.botId === botId);
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

// Kiểm tra hình dạng trạng thái nhịp đọc từ checkpoint. Một file hỏng/viết dở phải
// bị BỎ QUA (coi như chưa có), không được làm sập đợt gửi: mất trạng thái tạm dừng
// chỉ khiến ta thử lại sớm hơn, còn ném lỗi thì cả chiến dịch dừng.
//
// Lưu ý về `null`: `Number(null)` là 0 nên nếu chỉ dựa vào `Number.isFinite` thì một
// phần tử `null` trong `strikes` sẽ lọt qua thành mốc thời gian 0 — vô hại nhưng sai.
// Vì vậy phải loại tường minh trước khi ép kiểu.
function sanitizeStrikeList(raw) {
    if (!Array.isArray(raw)) return [];
    const result = [];
    for (const item of raw) {
        if (item === null || item === undefined || item === "") continue;
        const numeric = Number(item);
        if (Number.isFinite(numeric)) result.push(numeric);
    }
    return result;
}

function sanitizePacingState(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const result = {};
    for (const [botId, value] of Object.entries(raw)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        result[String(botId)] = {
            strikes: sanitizeStrikeList(value.strikes),
            strikeCount: Number(value.strikeCount) || 0,
            pausedUntil: Number(value.pausedUntil) || 0,
            pauseReason: value.pauseReason || null,
            sent: Number(value.sent) || 0
        };
    }
    return result;
}

function readCheckpoint(campaignId) {
    const file = checkpointPath(campaignId);
    if (!fs.existsSync(file)) {
        return {
            campaignId, contentHash: null, sent: {}, failed: {}, deferred: {},
            paused: {}, pacing: {}, updatedAt: null
        };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        return {
            campaignId,
            contentHash: typeof parsed.contentHash === "string" ? parsed.contentHash : null,
            sent: parsed.sent && typeof parsed.sent === "object" ? parsed.sent : {},
            failed: parsed.failed && typeof parsed.failed === "object" ? parsed.failed : {},
            deferred: parsed.deferred && typeof parsed.deferred === "object" ? parsed.deferred : {},
            // Trạng thái tạm dừng theo nhà cung cấp (nhịp gửi) — đọc lại được sau khi
            // tiến trình chết, để một nhà cung cấp đang bị khoá tốc độ không bị thử
            // lại ngay ở lần chạy tiếp.
            paused: parsed.paused && typeof parsed.paused === "object" ? parsed.paused : {},
            pacing: sanitizePacingState(parsed.pacing),
            updatedAt: parsed.updatedAt || null
        };
    } catch (error) {
        throw new Error(`Checkpoint hỏng, không dám ghi đè: ${file} (${error.message})`);
    }
}

// Đối chiếu checkpoint đang có với nội dung của lượt chạy này.
//
// Trả về { ok, reason } — `ok: false` nghĩa là KHÔNG được gửi: mã chiến dịch đã gắn
// với một nội dung/nguồn khác, nên tái sử dụng sẽ khiến người đã nhận bản cũ bị bỏ
// qua một cách âm thầm. Người vận hành phải đổi mã chiến dịch (hoặc xoá checkpoint
// nếu thực sự muốn gửi lại).
function verifyCheckpointContent(checkpoint, contentHash) {
    if (!checkpoint || !checkpoint.contentHash) return { ok: true, reason: null };
    if (checkpoint.contentHash === contentHash) return { ok: true, reason: null };
    return {
        ok: false,
        reason:
            `Mã chiến dịch "${checkpoint.campaignId}" đã được dùng cho một nội dung/nguồn KHÁC ` +
            `(vân tay ${checkpoint.contentHash.slice(0, 12)}…, nay là ${contentHash.slice(0, 12)}…). ` +
            "Dùng mã chiến dịch mới để không bỏ sót người đã nhận bản cũ, " +
            "hoặc xoá checkpoint nếu thực sự muốn gửi lại."
    };
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
//
// Kết quả trả về có BỐN trạng thái, và chúng khác nhau về hệ quả:
//   sent       — Zalo đã nhận. Không bao giờ gửi lại.
//   deferred   — chưa gửi được vì lý do hạ tầng (nhà cung cấp tắt/chưa sẵn sàng).
//   rate_limit — 429. KHÔNG phải thất bại của người nhận; sẽ thử lại ở lần resume.
//   failed     — lỗi vĩnh viễn (410/422: bỏ qua mãi mãi) hoặc lỗi tạm thời khác.
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
        if (classification.kind === DELIVERY_ERROR_KIND.RATE_LIMIT) {
            // 429 là chuyện của NHÀ CUNG CẤP, không phải của người nhận. Nơi gọi phải
            // chậm lại (hoặc tạm dừng) rồi mới thử lại — không bao giờ bắn tiếp.
            return { status: "rate_limit", reason: classification.reason || "rate_limit", error };
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
        source: get("--source") || get("-s") || DEFAULT_SOURCE,
        // Nhịp gửi. Mặc định thận trọng (xem PACING_DEFAULTS); cờ này chỉ để người
        // vận hành điều chỉnh khi cần, và luôn bị kẹp về khoảng an toàn.
        intervalMs: get("--interval-ms") || get("--interval")
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
    const permanent = Object.values(checkpoint.failed).filter((item) => item?.permanent === true).length;
    const deferred = Object.keys(checkpoint.deferred).length;
    const rateLimited = Object.values(checkpoint.deferred)
        .filter((item) => item?.reason === "rate_limited" || item?.reason === "provider_paused_rate_limited").length;
    console.log(`[Announce] Chiến dịch: ${campaignId}`);
    console.log(`[Announce]   đã gửi: ${sent} · thất bại: ${failed} (vĩnh viễn: ${permanent}) · hoãn: ${deferred} (429: ${rateLimited})`);
    console.log(`[Announce]   vân tay nội dung: ${checkpoint.contentHash ? checkpoint.contentHash.slice(0, 12) + "…" : "(chưa có)"}`);
    console.log(`[Announce]   cập nhật lần cuối: ${checkpoint.updatedAt || "(chưa chạy)"}`);
    const byBot = {};
    for (const key of Object.keys(checkpoint.sent)) {
        const bot = key.split("::")[0];
        byBot[bot] = (byBot[bot] || 0) + 1;
    }
    console.log(`[Announce]   đã gửi theo bot: ${formatCounts(byBot)}`);
    const pausedBots = Object.keys(checkpoint.paused || {});
    if (pausedBots.length > 0) {
        console.log(`[Announce]   ĐANG TẠM DỪNG (429): ${pausedBots.join(", ")} — còn lại sẽ thử lại khi chạy resume.`);
    }
    return {
        campaignId,
        sent,
        failed,
        permanent,
        deferred,
        rateLimited,
        paused: checkpoint.paused,
        pacing: checkpoint.pacing,
        contentHash: checkpoint.contentHash,
        updatedAt: checkpoint.updatedAt,
        perBot: byBot,
        failedDetail: checkpoint.failed,
        deferredDetail: checkpoint.deferred
    };
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

    if (!args.messageFile && !options.messageOverride) {
        throw new Error("Bắt buộc có --message-file <đường dẫn> (file chứa nội dung thông báo).");
    }
    // Nội dung có thể đến từ file (đường CLI) hoặc từ tham số (đường API quản trị).
    // Cả hai đều cho ra cùng một chuỗi đã trim, nên vân tay nội dung luôn so sánh được.
    let message;
    let messageOrigin;
    if (options.messageOverride) {
        message = String(options.messageOverride).trim();
        messageOrigin = options.messageSource || "(tham số)";
    } else {
        const messagePath = path.resolve(args.messageFile);
        if (!fs.existsSync(messagePath)) throw new Error(`Không tìm thấy file nội dung: ${messagePath}`);
        message = fs.readFileSync(messagePath, "utf8").trim();
        messageOrigin = messagePath;
    }
    if (!message) throw new Error(`Nội dung thông báo rỗng (nguồn: ${messageOrigin}).`);

    const raw = readSourceFile(args.source);
    const { recipients, excluded, perBot, duplicates } = classifyRecipients(raw);
    const contentHash = campaignContentHash(recipients, normalizeCampaignMessage(message));

    console.log(`[Announce] Chiến dịch: ${args.campaign}`);
    console.log(`[Announce] Nguồn: ${path.resolve(args.source)}`);
    console.log(`[Announce] Người nhận hợp lệ: ${recipients.length}. Theo bot: ${formatCounts(perBot)}`);
    console.log(`[Announce] Trùng lặp trong nguồn (đã gộp): ${duplicates}`);
    console.log(`[Announce] Vân tay nội dung: ${contentHash.slice(0, 12)}…`);
    reportExcluded(excluded);

    if (recipients.length === 0) {
        console.log("[Announce] Không có người nhận nào đủ điều kiện. Dừng.");
        return { sent: 0, reason: "no_recipients" };
    }

    // Nguồn có ZCA: chỉ gửi được khi hàm này chạy BÊN TRONG tiến trình chính đang
    // giữ phiên. Chạy từ shell riêng thì không có registry, nên phần ZCA sẽ bị hoãn
    // — xem ANNOUNCEMENT.md để biết cách kích hoạt qua API quản trị.
    const zcaRecipients = recipients.filter((item) => isZcaId(item.botId));
    if (zcaRecipients.length > 0) {
        console.log(
            `[Announce] Lưu ý: ${zcaRecipients.length} đích thuộc tài khoản ZCA. ` +
            "Phiên ZCA chỉ tồn tại trong tiến trình chính, nên muốn gửi được phần này " +
            "phải chạy TRONG tiến trình đó (xem ANNOUNCEMENT.md); " +
            "nếu không chúng sẽ được báo là 'hoãn'."
        );
    }

    const checkpoint = readCheckpoint(args.campaign);
    const contentCheck = verifyCheckpointContent(checkpoint, contentHash);
    if (!contentCheck.ok) throw new Error(contentCheck.reason);

    const { toSend, alreadySent, skippedPermanent } = planSend(recipients, checkpoint);
    console.log(`[Announce] Checkpoint đã có: ${alreadySent} người đã gửi (sẽ bỏ qua).`);
    if (skippedPermanent > 0) {
        console.log(`[Announce] Bỏ qua vĩnh viễn (410/422 lần trước): ${skippedPermanent}.`);
    }
    console.log(`[Announce] Còn phải gửi: ${toSend.length}.`);

    if (!args.send) {
        console.log("");
        console.log("[Announce] DRY-RUN: chưa gửi gì, chưa ghi gì.");
        console.log("[Announce] Thêm --send để gửi thật (phải chạy trong tiến trình chính).");
        return {
            dryRun: true,
            planned: toSend.length,
            alreadySent,
            skippedPermanent,
            perBot,
            contentHash,
            recipients: recipients.length,
            excluded: excluded.length
        };
    }

    // Gửi thật cần nhà cung cấp đang chạy. Nhà cung cấp được lấy qua registry.
    //
    // Chỉ tiến trình chính mới có registry — và do đó mới có phiên ZCA. Một tiến
    // trình shell riêng KHÔNG BAO GIỜ tự mở phiên Zalo (sẽ tranh khoá phiên ZCA và
    // làm hỏng phiên đang đăng nhập), nên ở đây TỪ CHỐI thay vì thử mở phiên mới.
    const runtimeRegistry = resolveRuntimeRegistry(options);
    if (!runtimeRegistry) {
        throw new Error(
            "Không tìm thấy registry nhà cung cấp đang chạy. " +
            "Đợt gửi phải được kích hoạt TỪ BÊN TRONG tiến trình chính (main.js) — " +
            "xem ANNOUNCEMENT.md để biết cách gọi qua API quản trị. " +
            "Tiến trình shell riêng không tự mở phiên Zalo để tránh tranh khoá phiên ZCA."
        );
    }
    const officialConfigs = resolveBotConfigs(process.env);
    const getProvider = (botId) => runtimeRegistry.get(botId) || null;

    // Nhịp gửi theo từng nhà cung cấp. Cấu hình lấy từ tham số dòng lệnh > tham số
    // hàm > biến môi trường > mặc định thận trọng.
    //
    // `options.pacing` cho phép ghi đè ngưỡng tạm dừng/khoảng chờ (kiểm thử và vận
    // hành đặc biệt cần giá trị chặt hơn mặc định). Luôn đi qua `resolvePacingOptions`
    // để không có đường nào đặt được nhịp nhanh hơn sàn an toàn.
    const pacingOptions = resolvePacingOptions({
        intervalMs: args.intervalMs ?? options.intervalMs
    }, options.env || process.env);
    const pacing = createPacingController({
        settings: { ...pacingOptions, ...(options.pacing || {}) },
        sleep: options.sleep,
        now: options.now,
        log: (level, text) => console[level === "warn" ? "warn" : "log"](text)
    });
    // Khôi phục trạng thái tạm dừng đã lưu: một nhà cung cấp vừa bị khoá tốc độ ở
    // lần chạy trước KHÔNG được thử lại ngay lập tức.
    pacing.restore(checkpoint.pacing);
    checkpoint.pacing = pacing.snapshot();

    console.log(
        `[Announce] Nhịp gửi: ${pacingOptions.intervalMs}ms/đích, một đích mỗi nhà cung cấp cùng lúc; ` +
        `429 ⇒ chờ theo Retry-After hoặc ${pacingOptions.backoffBaseMs}ms×2^n (trần ${pacingOptions.backoffMaxMs}ms); ` +
        `quá ${pacingOptions.maxRateLimitStrikes} lần 429/${Math.round(pacingOptions.strikeWindowMs / 1000)}s ⇒ tạm dừng ${Math.round(pacingOptions.pauseMs / 1000)}s.`
    );
    // Cảnh báo SỚM nhà cung cấp nào còn đang bị tạm dừng từ lần chạy trước, để người
    // vận hành biết vì sao đợt này có thể bỏ qua cả một tài khoản.
    const nowAtStart = Date.now();
    for (const [botId, info] of Object.entries(pacing.stats(nowAtStart))) {
        if (info.paused) {
            console.log(
                `[Announce] LƯU Ý: ${botId} đang tạm dừng (${info.pauseReason}) — ` +
                `còn ${Math.ceil(info.resumeInMs / 1000)}s. Đích của tài khoản này sẽ được ghi "hoãn".`
            );
        }
    }

    // Gắn vân tay NGAY khi bắt đầu ghi, để lần chạy sau đối chiếu được nội dung.
    checkpoint.contentHash = contentHash;

    let sent = 0;
    let failed = 0;
    let deferred = 0;
    let rateLimited = 0;

    // Gom đích theo nhà cung cấp để nhịp của nhà cung cấp này không cản nhà cung cấp
    // khác. Chạy hết nhóm này rồi mới sang nhóm kế tiếp: tổng thời gian như nhau,
    // nhưng một tài khoản bị khoá tốc độ chỉ làm chậm chính nó.
    const groups = new Map();
    for (const recipient of toSend) {
        if (!groups.has(recipient.botId)) groups.set(recipient.botId, []);
        groups.get(recipient.botId).push(recipient);
    }

    for (const [botId, group] of groups) {
        // Nhà cung cấp tắt/chưa sẵn sàng ⇒ hoãn cả nhóm, không phải thất bại.
        const availability = checkProviderAvailability(botId, runtimeRegistry, officialConfigs);
        if (!availability.available) {
            for (const recipient of group) {
                deferred += 1;
                checkpoint.deferred[recipient.key] = { reason: availability.reason, at: new Date().toISOString() };
            }
            writeCheckpoint(args.campaign, checkpoint);
            continue;
        }

        let pausing = false;
        for (const recipient of group) {
            if (pausing) break;

            // Chờ tới lượt của nhà cung cấp này. Trả về lý do khi nó đang bị TẠM DỪNG
            // — lúc đó KHÔNG chờ hết thời gian tạm dừng (chờ 10 phút trong một request
            // là vô nghĩa), mà ghi "hoãn" cho phần còn lại và đi tiếp nhà cung cấp khác.
            const gate = await pacing.waitTurn(botId);
            if (gate && gate.reason === "paused") {
                for (const rest of group.slice(group.indexOf(recipient))) {
                    deferred += 1;
                    checkpoint.deferred[rest.key] = {
                        reason: "provider_paused_rate_limited",
                        resumeInMs: gate.waitMs,
                        at: new Date().toISOString()
                    };
                }
                checkpoint.paused[botId] = {
                    reason: "rate_limited",
                    resumeInMs: gate.waitMs,
                    at: new Date().toISOString()
                };
                checkpoint.pacing = pacing.snapshot();
                writeCheckpoint(args.campaign, checkpoint);
                console.log(
                    `[Announce] ${botId} đang tạm dừng vì 429 — ${group.length - group.indexOf(recipient)} đích còn lại được ghi "hoãn".`
                );
                break;
            }

            const outcome = await sendOne(getProvider, recipient, message);
            const at = new Date().toISOString();

            if (outcome.status === "sent") {
                sent += 1;
                pacing.onSuccess(botId);
                checkpoint.sent[recipient.key] = { at };
                delete checkpoint.deferred[recipient.key];
                delete checkpoint.failed[recipient.key];
                delete checkpoint.paused[botId];
            } else if (outcome.status === "deferred") {
                deferred += 1;
                checkpoint.deferred[recipient.key] = { reason: outcome.reason, at };
            } else if (outcome.status === "rate_limit") {
                rateLimited += 1;
                // 429 KHÔNG phải thất bại của người nhận: ghi "hoãn" để lần resume sau
                // thử lại, và dùng chính lần 429 này để tính thời gian chờ.
                const strike = pacing.onRateLimit(botId, outcome.error);
                checkpoint.deferred[recipient.key] = {
                    reason: "rate_limited",
                    strike: strike.strikeCount,
                    at
                };
                delete checkpoint.failed[recipient.key];
                checkpoint.pacing = pacing.snapshot();
                if (strike.paused) {
                    // Vượt ngưỡng ⇒ TẠM DỪNG nhà cung cấp. Mọi đích còn lại của nó
                    // được ghi "hoãn" ngay, KHÔNG bắn nốt — đây là chốt chặn để một
                    // lần 429 không biến thành vòng lặp 429 nhanh.
                    const index = group.indexOf(recipient);
                    const remaining = group.slice(index + 1);
                    for (const rest of remaining) {
                        deferred += 1;
                        checkpoint.deferred[rest.key] = {
                            reason: "provider_paused_rate_limited",
                            resumeInMs: strike.pauseMs,
                            at
                        };
                    }
                    checkpoint.paused[botId] = {
                        reason: "rate_limited",
                        strikeCount: strike.strikeCount,
                        resumeInMs: strike.pauseMs,
                        at
                    };
                    pausing = true;
                    console.log(
                        `[Announce] ${botId}: 429 lặp lại (${strike.strikeCount} lần) ⇒ tạm dừng; ` +
                        `${remaining.length} đích còn lại được ghi "hoãn" (sẽ thử lại ở lần chạy tiếp).`
                    );
                } else if (strike.retryDelayMs > 0) {
                    // Chưa vượt ngưỡng: chờ đúng khoảng đề xuất rồi mới gửi tin kế tiếp.
                    await (options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(strike.retryDelayMs);
                }
            } else {
                failed += 1;
                checkpoint.failed[recipient.key] = {
                    reason: outcome.reason,
                    permanent: Boolean(outcome.permanent),
                    at
                };
            }

            // Ghi checkpoint sau MỖI kết quả: dừng đột ngột không được làm mất tiến độ.
            writeCheckpoint(args.campaign, checkpoint);
        }
        checkpoint.pacing = pacing.snapshot();
        writeCheckpoint(args.campaign, checkpoint);
    }

    const file = writeCheckpoint(args.campaign, checkpoint);
    const pausedBots = Object.keys(checkpoint.paused || {});
    console.log("");
    console.log(
        `[Announce] XONG. đã gửi: ${sent} · thất bại: ${failed} · hoãn: ${deferred} ` +
        `(trong đó 429: ${rateLimited}) · bỏ qua vĩnh viễn: ${skippedPermanent ?? 0}`
    );
    if (pausedBots.length > 0) {
        console.log(
            `[Announce] Nhà cung cấp đang tạm dừng vì 429: ${pausedBots.join(", ")}. ` +
            "Chờ hết thời gian tạm dừng rồi chạy lại bước resume — xem ANNOUNCEMENT.md."
        );
    }
    console.log(`[Announce] Checkpoint: ${file}`);
    console.log("[Announce] Chạy lại với --report để xem báo cáo đầy đủ.");
    return {
        sent,
        failed,
        deferred,
        rateLimited,
        skippedPermanent,
        alreadySent,
        contentHash,
        paused: checkpoint.paused,
        pacing: pacing.stats()
    };
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
    PACING_DEFAULTS,
    UNVERIFIED_LABEL,
    campaignContentHash,
    checkProviderAvailability,
    checkpointPath,
    classifyRecipients,
    fingerprint,
    main,
    normalizeCampaignMessage,
    normalizeOfficialConfigs,
    normalizeSourceRecords,
    parseArgs,
    planSend,
    printReport,
    readCheckpoint,
    readSourceFile,
    recipientKey,
    resolveRuntimeRegistry,
    sanitizePacingState,
    sendOne,
    verifyCheckpointContent,
    writeCheckpoint
};
