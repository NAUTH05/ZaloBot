const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = [10, 20, 25, 50, 100];

function normalizePageSize(value, fallback = DEFAULT_PAGE_SIZE) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function paginate(items = [], page = 1, pageSize = DEFAULT_PAGE_SIZE) {
    const source = Array.isArray(items) ? items : [];
    const size = normalizePageSize(pageSize);
    const total = source.length;
    const totalPages = total ? Math.ceil(total / size) : 0;
    const requestedPage = Number(page);
    const currentPage = totalPages ? Math.min(Math.max(Number.isInteger(requestedPage) ? requestedPage : 1, 1), totalPages) : 1;
    const startIndex = totalPages ? (currentPage - 1) * size : 0;
    return {
        items: source.slice(startIndex, startIndex + size),
        page: currentPage,
        pageSize: size,
        total,
        totalPages,
        from: total ? startIndex + 1 : 0,
        to: total ? Math.min(startIndex + size, total) : 0
    };
}

module.exports = { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, normalizePageSize, paginate };
