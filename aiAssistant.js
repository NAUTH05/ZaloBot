const https = require("https");
const { getApiDateTimeInfo, getVietnamDateInfo, getVietnamWeekInfo } = require("./timezone");
const { fetchStudentSchedule } = require("./lhuSchedule");

function formatScheduleContextForAi(scheduleData, date = new Date(), numWeeks = 3) {
    const studentName = scheduleData.studentName || "Sinh viên";
    const studentId = scheduleData.studentId;
    const current = getVietnamDateInfo(date);

    // Xây dựng danh sách các ngày trong N tuần tới
    const startDate = new Date(`${current.dateKey}T00:00:00.000Z`);
    const dayMs = 24 * 60 * 60 * 1000;
    const totalDays = numWeeks * 7;
    const daysMap = new Map();

    for (let i = 0; i < totalDays; i += 1) {
        const d = new Date(startDate.getTime() + i * dayMs);
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, "0");
        const day = String(d.getUTCDate()).padStart(2, "0");
        const dateKey = `${y}-${m}-${day}`;
        const weekday = new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", weekday: "long" }).format(d);
        daysMap.set(dateKey, { dateKey, weekday, formattedDate: `${day}/${m}/${y}`, lessons: [] });
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

    const daySummaries = [];
    const freeDays = [];

    for (const [dateKey, dayObj] of daysMap.entries()) {
        const activeLessons = dayObj.lessons.filter((l) => l.status !== "Báo nghỉ");
        const offLessons = dayObj.lessons.filter((l) => l.status === "Báo nghỉ");

        if (activeLessons.length === 0) {
            if (offLessons.length > 0) {
                freeDays.push(`${dayObj.weekday} ${dayObj.formattedDate} (Toàn bộ ca học bị BÁO NGHỈ)`);
                daySummaries.push(`- ${dayObj.weekday} ${dayObj.formattedDate}: BÁO NGHỈ (Không phải lên lớp)`);
            } else {
                freeDays.push(`${dayObj.weekday} ${dayObj.formattedDate} (Ngày rảnh không có lịch)`);
                daySummaries.push(`- ${dayObj.weekday} ${dayObj.formattedDate}: KHÔNG CÓ LỊCH HỌC`);
            }
        } else {
            const lessonDescs = dayObj.lessons.map(
                (l) => `${l.time} · ${l.subject} [${l.status}] (${l.room})`
            ).join("; ");
            daySummaries.push(`- ${dayObj.weekday} ${dayObj.formattedDate}: ${activeLessons.length} buổi (${lessonDescs})`);
        }
    }

    return {
        studentId,
        studentName,
        currentDate: current.formattedDate,
        summaryText: `Thông tin lịch học của sinh viên ${studentName} (MSSV: ${studentId}) từ ngày ${current.formattedDate} trong ${numWeeks} tuần tới:\n\n` +
            `DƯỚI ĐÂY LÀ CHI TIẾT TỪNG NGÀY:\n${daySummaries.join("\n")}\n\n` +
            `DANH SÁCH CÁC NGÀY RẢNH/BÁO NGHỈ (Không phải lên lớp):\n${freeDays.join("\n")}`
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
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => {
                try {
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

async function askScheduleAi(userQuestion, scheduleData, date = new Date()) {
    const apiKey = (process.env.GEMINI_API_KEY || process.env.AI_API_KEY || "").trim();
    if (!apiKey || apiKey === "your_gemini_api_key_here") {
        throw new Error("BOT chưa được dán GEMINI_API_KEY vào file .env. Vui lòng dán Gemini API Key của bạn vào file .env rồi khởi động lại BOT.");
    }

    const context = formatScheduleContextForAi(scheduleData, date, 3);
    const systemPrompt = `Bạn là Trợ lý AI thông minh phụ trách giải đáp lịch học cho sinh viên Đại học Lạc Hồng (LHU).\n` +
        `Dưới đây là thông tin chi tiết lịch học thực tế của sinh viên:\n\n` +
        `${context.summaryText}\n\n` +
        `NHIỆM VỤ CỦA BẠN:\n` +
        `1. Trả lời câu hỏi của sinh viên dựa trên dữ liệu lịch học ở trên.\n` +
        `2. Nếu sinh viên hỏi về ngày rảnh hoặc thời gian trống, hãy liệt kê chi tiết các ngày rảnh (ngày không có lịch học hoặc các ngày ca học bị BÁO NGHỈ).\n` +
        `3. Trả lời ngắn gọn, thân thiện, rõ ràng bằng tiếng Việt, có trình bày bullet point dễ đọc.\n` +
        `4. Tuyệt đối không bịa đặt các buổi học không có trong dữ liệu ở trên.\n\n` +
        `Câu hỏi của sinh viên: "${userQuestion}"`;

    const primaryModel = process.env.GEMINI_MODEL || "gemini-1.5-flash";
    try {
        return await callGeminiApi(systemPrompt, apiKey, primaryModel);
    } catch (firstError) {
        // Fallback sang gemini-2.0-flash nếu model chính không khả dụng
        if (primaryModel !== "gemini-2.0-flash") {
            try {
                return await callGeminiApi(systemPrompt, apiKey, "gemini-2.0-flash");
            } catch (_) {}
        }
        throw firstError;
    }
}

module.exports = {
    askScheduleAi,
    callGeminiApi,
    formatScheduleContextForAi
};
