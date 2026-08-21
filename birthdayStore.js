const path = require("path");
const { readJsonStore, writeJsonStore } = require("./firestorePersistence");

const FILE_PATH = path.join(__dirname, "birthdayData.json");

function createEmptyState() {
    return {
        version: 1,
        nextQuestionId: 1,
        questions: [],
        deliveries: { invitations: {}, results: {} }
    };
}

function readState(filePath = FILE_PATH) {
    try {
        const data = readJsonStore(filePath, FILE_PATH, createEmptyState());
        const empty = createEmptyState();
        return {
            ...empty,
            ...(data && typeof data === "object" ? data : {}),
            questions: Array.isArray(data?.questions) ? data.questions : [],
            deliveries: {
                invitations: data?.deliveries?.invitations || {},
                results: data?.deliveries?.results || {}
            }
        };
    } catch (error) {
        console.error(`Không đọc được ${path.basename(filePath)}:`, error.message);
        return createEmptyState();
    }
}

function writeState(state, filePath = FILE_PATH) {
    writeJsonStore(filePath, FILE_PATH, state);
}

function normalizeYear(year) {
    const value = Number(year);
    if (!Number.isInteger(value) || value < 2000 || value > 9999) {
        throw new Error("Năm không hợp lệ");
    }
    return value;
}

function normalizeQuestionText(text) {
    const value = String(text || "").trim();
    if (!value) throw new Error("Câu hỏi không được để trống");
    if (value.length > 1000) throw new Error("Câu hỏi không được dài quá 1000 ký tự");
    return value;
}

function isBirthdayDate(dateInfo) {
    return String(dateInfo?.day) === "27" && String(dateInfo?.month) === "08";
}

function addQuestion({ year, text, author = {} }, date = new Date(), filePath = FILE_PATH) {
    const state = readState(filePath);
    const question = {
        id: state.nextQuestionId,
        year: normalizeYear(year),
        text: normalizeQuestionText(text),
        author: {
            userId: String(author.userId || ""),
            displayName: String(author.displayName || ""),
            chatId: String(author.chatId || "")
        },
        answer: "",
        createdAt: date.toISOString(),
        updatedAt: date.toISOString(),
        answeredAt: null
    };
    state.nextQuestionId += 1;
    state.questions.push(question);
    writeState(state, filePath);
    return question;
}

function getQuestions(year, filePath = FILE_PATH) {
    const normalizedYear = normalizeYear(year);
    return readState(filePath).questions
        .filter((question) => question.year === normalizedYear)
        .sort((a, b) => a.id - b.id);
}

function getLatestQuestionYear(filePath = FILE_PATH) {
    const years = readState(filePath).questions.map((question) => question.year);
    return years.length ? Math.max(...years) : null;
}

function findQuestion(state, id) {
    const numericId = Number(id);
    return state.questions.find((question) => question.id === numericId);
}

function updateQuestion(id, text, date = new Date(), filePath = FILE_PATH) {
    const state = readState(filePath);
    const question = findQuestion(state, id);
    if (!question) return null;
    question.text = normalizeQuestionText(text);
    question.updatedAt = date.toISOString();
    writeState(state, filePath);
    return question;
}

function deleteQuestion(id, filePath = FILE_PATH) {
    const state = readState(filePath);
    const question = findQuestion(state, id);
    if (!question) return null;
    state.questions = state.questions.filter((item) => item.id !== question.id);
    writeState(state, filePath);
    return question;
}

function answerQuestion(id, answer, date = new Date(), filePath = FILE_PATH) {
    const value = String(answer || "").trim();
    if (!value) throw new Error("Câu trả lời không được để trống");
    if (value.length > 4000) throw new Error("Câu trả lời không được dài quá 4000 ký tự");

    const state = readState(filePath);
    const question = findQuestion(state, id);
    if (!question) return null;
    question.answer = value;
    question.answeredAt = date.toISOString();
    question.updatedAt = date.toISOString();
    writeState(state, filePath);
    return question;
}

function wasInvitationSent(year, chatId, filePath = FILE_PATH) {
    const state = readState(filePath);
    return Boolean(state.deliveries.invitations[String(normalizeYear(year))]?.[String(chatId)]);
}

function markInvitationSent(year, chatId, date = new Date(), filePath = FILE_PATH) {
    const state = readState(filePath);
    const yearKey = String(normalizeYear(year));
    state.deliveries.invitations[yearKey] ||= {};
    state.deliveries.invitations[yearKey][String(chatId)] = date.toISOString();
    writeState(state, filePath);
}

function wasResultSent(year, chatId, digest, filePath = FILE_PATH) {
    const state = readState(filePath);
    return state.deliveries.results[String(normalizeYear(year))]?.[String(chatId)]?.digest === digest;
}

function markResultSent(year, chatId, digest, date = new Date(), filePath = FILE_PATH) {
    const state = readState(filePath);
    const yearKey = String(normalizeYear(year));
    state.deliveries.results[yearKey] ||= {};
    state.deliveries.results[yearKey][String(chatId)] = {
        digest,
        sentAt: date.toISOString()
    };
    writeState(state, filePath);
}

module.exports = {
    FILE_PATH,
    addQuestion,
    answerQuestion,
    createEmptyState,
    deleteQuestion,
    getLatestQuestionYear,
    getQuestions,
    isBirthdayDate,
    markInvitationSent,
    markResultSent,
    readState,
    updateQuestion,
    wasInvitationSent,
    wasResultSent
};
