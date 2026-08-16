const https = require("https");
const { getApiDateTimeInfo, getVietnamDateInfo, getVietnamWeekInfo } = require("./timezone");
const { fetchStudentSchedule } = require("./lhuSchedule");

function formatScheduleContextForAi(scheduleData, date = new Date(), numWeeks = 4) {
    const studentName = scheduleData.studentName || "Sinh viên";
    const studentId = scheduleData.studentId;
    const current = getVietnamDateInfo(date);

    // Lấy ngày Thứ Hai của tuần hiện tại làm mốc
    const week0 = getVietnamWeekInfo(date);
    const monday0 = new Date(`${week0.days[0].dateKey}T00:00:00.000Z`);
    const dayMs = 24 * 60 * 60 * 1000;

    const weeks = [];
    const daysMap = new Map();
    const weekLabels = ["TUẦN NÀY", "TUẦN SAU (TUẦN TỚI)", "TUẦN SAU NỮA", "TUẦN THỨ 4"];

    for (let w = 0; w < numWeeks; w += 1) {
        const weekDays = [];
        for (let d = 0; d < 7; d += 1) {
            const dayOffset = w * 7 + d;
            const dayDate = new Date(monday0.getTime() + dayOffset * dayMs);
            const y = dayDate.getUTCFullYear();
            const m = String(dayDate.getUTCMonth() + 1).padStart(2, "0");
            const day = String(dayDate.getUTCDate()).padStart(2, "0");
            const dateKey = `${y}-${m}-${day}`;
            const weekday = new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", weekday: "long" }).format(dayDate);
            const dayObj = { dateKey, weekday, formattedDate: `${day}/${m}/${y}`, lessons: [] };
            weekDays.push(dayObj);
            daysMap.set(dateKey, dayObj);
        }
        const label = weekLabels[w] || `TUẦN THỨ ${w + 1}`;
        const rangeStr = `${weekDays[0].formattedDate} đến ${weekDays[6].formattedDate}`;
        weeks.push({ weekIndex: w, label, rangeStr, days: weekDays });
    }

    const lessons = scheduleData.lessons || [];
    for (const lesson of lessons) {
        const info = getApiDateTimeInfo(lesson.ThoiGianBD);
        if (!info?.dateKey || !daysMap.has(info.dateKey)) continue;

        const endInfo = getApiDateTimeInfo(lesson.ThoiGianKT);
        const statusNum = Number(lesson.TinhTrang || 0);
        let statusStr = "Đang học";
        if (statusNum === 6) statusStr = "Nghỉ lễ";
        else if (![0, 4, 5, 10].includes(statusNum)) statusStr = "Báo nghỉ";
        if (Number(lesson.CalenType) === 2) statusStr = "Lịch thi";

        daysMap.get(info.dateKey).lessons.push({
            subject: lesson.TenMonHoc || "Chưa rõ môn",
            time: `${info.hour}:${info.minute} - ${endInfo?.hour || "?"}:${endInfo?.minute || "?"}`,
            room: [lesson.TenPhong, lesson.TenCoSo].filter(Boolean).join(" - ") || "Chưa xếp phòng",
            teacher: lesson.GiaoVien || "",
            status: statusStr
        });
    }

    const weekSummaries = [];
    for (const wObj of weeks) {
        const dayLines = [];
        for (const dayObj of wObj.days) {
            const activeLessons = dayObj.lessons.filter((l) => l.status !== "Báo nghỉ");
            const offLessons = dayObj.lessons.filter((l) => l.status === "Báo nghỉ");

            if (activeLessons.length === 0) {
                if (offLessons.length > 0) {
                    dayLines.push(`  - ${dayObj.weekday} ${dayObj.formattedDate}: BÁO NGHỈ TOÀN BỘ (Lớp nghỉ học)`);
                } else {
                    dayLines.push(`  - ${dayObj.weekday} ${dayObj.formattedDate}: KHÔNG CÓ LỊCH HỌC (RẢNH)`);
                }
            } else {
                const lessonDescs = dayObj.lessons.map(
                    (l) => `${l.time} · ${l.subject} [${l.status}] (${l.room})`
                ).join("; ");
                dayLines.push(`  - ${dayObj.weekday} ${dayObj.formattedDate}: ${activeLessons.length} buổi (${lessonDescs})`);
            }
        }
        weekSummaries.push(`=== ${wObj.label} (${wObj.rangeStr}) ===\n${dayLines.join("\n")}`);
    }

    return {
        studentId,
        studentName,
        currentDate: current.formattedDate,
        weekday: current.weekday,
        thisWeekRange: weeks[0]?.rangeStr,
        nextWeekRange: weeks[1]?.rangeStr,
        nextNextWeekRange: weeks[2]?.rangeStr,
        summaryText: `Lịch học của sinh viên ${studentName} (MSSV: ${studentId}):\n` +
            `HÔM NAY LÀ: ${current.weekday}, ${current.formattedDate}\n\n` +
            `${weekSummaries.join("\n\n")}`
    };
}

function callGeminiApi(prompt, apiKey, modelName = process.env.GEMINI_MODEL || "gemini-1.5-flash") {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            contents: [{
                parts: [{ text: prompt }]
            }]
        });

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
        const req = https.request(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload)
            },
            timeout: 25000
        }, (res) => {
            const chunks = [];
            res.on("data", chunk => chunks.push(chunk));
            res.on("end", () => {
                try {
                    const data = Buffer.concat(chunks).toString("utf8");
                    const parsed = JSON.parse(data);
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        reject(new Error(parsed.error?.message || `Gemini API lỗi ${res.statusCode}`));
                        return;
                    }
                    const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (!text) reject(new Error("Gemini API không trả kết quả dạng văn bản"));
                    else resolve(text);
                } catch (e) {
                    reject(new Error("Không thể đọc phản hồi từ Gemini API"));
                }
            });
        });

        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("Gemini API phản hồi quá chậm (Timeout)")));
        req.write(payload);
        req.end();
    });
}

function callGeminiInteractionsApi(prompt, apiKey, modelName = "gemini-2.5-flash") {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            model: modelName,
            input: prompt
        });

        const url = `https://generativelanguage.googleapis.com/v1beta/interactions?key=${apiKey}`;
        const req = https.request(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload)
            },
            timeout: 25000
        }, (res) => {
            const chunks = [];
            res.on("data", chunk => chunks.push(chunk));
            res.on("end", () => {
                try {
                    const data = Buffer.concat(chunks).toString("utf8");
                    const parsed = JSON.parse(data);
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        reject(new Error(parsed.error?.message || `Interactions API lỗi ${res.statusCode}`));
                        return;
                    }
                    const text = parsed.outputs?.[0]?.text || parsed.steps?.[0]?.outputs?.[0]?.text;
                    if (!text) reject(new Error("Interactions API không trả kết quả văn bản"));
                    else resolve(text);
                } catch (e) {
                    reject(new Error("Không thể đọc phản hồi từ Interactions API"));
                }
            });
        });

        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("Interactions API Timeout")));
        req.write(payload);
        req.end();
    });
}

async function askScheduleAi(userQuestion, scheduleData, date = new Date()) {
    const apiKey = (process.env.GEMINI_API_KEY || process.env.AI_API_KEY || "").trim();
    if (!apiKey || apiKey === "your_gemini_api_key_here") {
        throw new Error("BOT chưa được dán GEMINI_API_KEY vào file .env. Vui lòng dán Gemini API Key của bạn vào file .env rồi khởi động lại BOT.");
    }

    const context = formatScheduleContextForAi(scheduleData, date, 4);
    const systemPrompt = `Bạn là Trợ lý AI thông minh phụ trách giải đáp lịch học cho sinh viên Đại học Lạc Hồng (LHU).\n\n` +
        `QUY TẮC BẮT BUỘC VỀ PHÂN CHIA THỜI GIAN:\n` +
        `- Hôm nay là: ${context.weekday}, ${context.currentDate}\n` +
        `- "TUẦN NÀY" = Khoảng thời gian (${context.thisWeekRange})\n` +
        `- "TUẦN SAU" / "TUẦN TỚI" = Khoảng thời gian (${context.nextWeekRange})\n` +
        `- "TUẦN SAU NỮA" = Khoảng thời gian (${context.nextNextWeekRange})\n\n` +
        `NHIỆM VỤ & QUY TẮC PHẢN HỒI:\n` +
        `1. Khi sinh viên hỏi về "tuần sau" hoặc "tuần tới", bạn BẮT BUỘC chỉ trả lời dữ liệu nằm trong khoảng (${context.nextWeekRange}). NGHIÊM CẤM nhảy sang khoảng thời gian (${context.nextNextWeekRange}).\n` +
        `2. Ngày được tính là RẢNH (không phải lên lớp) bao gồm: Ngày KHÔNG CÓ LỊCH HỌC hoặc Ngày toàn bộ ca học bị BÁO NGHỈ.\n` +
        `3. Liệt kê rõ ràng, thân thiện bằng tiếng Việt, trình bày dạng danh sách có dấu gạch đầu dòng kèm Thứ và Ngày/Tháng/Năm cụ thể.\n` +
        `4. Tuyệt đối không bịa đặt dữ liệu lịch học ngoài danh sách dưới đây.\n\n` +
        `DƯỚI ĐÂY LÀ CHI TIẾT LỊCH HỌC THEO TỪNG TUẦN:\n\n` +
        `${context.summaryText}\n\n` +
        `Câu hỏi của sinh viên: "${userQuestion}"`;

    const candidateModels = Array.from(new Set([
        process.env.GEMINI_MODEL,
        "gemini-2.5-flash",
        "gemini-2.0-flash",
        "gemini-1.5-flash-latest",
        "gemini-1.5-flash",
        "gemini-pro"
    ].filter(Boolean)));

    let lastError = null;
    for (const modelName of candidateModels) {
        try {
            return await callGeminiApi(systemPrompt, apiKey, modelName);
        } catch (err) {
            lastError = err;
        }
    }

    // Nếu generateContent không hoạt động với các mô hình trên, thử Interactions API dự phòng
    try {
        return await callGeminiInteractionsApi(systemPrompt, apiKey, "gemini-2.5-flash");
    } catch (_) {}

    const rawMsg = lastError?.message || "";
    if (rawMsg.includes("is not found for API version") || rawMsg.includes("API key not valid") || rawMsg.includes("PERMISSION_DENIED")) {
        throw new Error(
            "Gemini API Key trong file .env không hợp lệ hoặc tài khoản Google chưa kích hoạt Generative Language API.\n" +
            "> **Cách xử lý:**\n" +
            "1. Truy cập https://aistudio.google.com/app/apikey để tạo mới API Key miễn phí.\n" +
            "2. Dán mã Key mới (dạng AIzaSy...) vào GEMINI_API_KEY trong file .env và khởi động lại BOT."
        );
    }

    throw lastError || new Error("Không thể kết nối tới các mô hình Gemini API.");
}

module.exports = {
    askScheduleAi,
    callGeminiApi,
    formatScheduleContextForAi
};
