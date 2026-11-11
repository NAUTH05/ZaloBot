const test = require("node:test");
const assert = require("node:assert/strict");
const { paginate } = require("../adminPagination");

test("pagination clamps pages and reports ranges", () => {
    assert.deepEqual(paginate([1, 2, 3, 4, 5], 2, 2), { items: [3, 4], page: 2, pageSize: 2, total: 5, totalPages: 3, from: 3, to: 4 });
    assert.equal(paginate([1, 2, 3], 99, 2).page, 2);
    assert.deepEqual(paginate([], 4, 20), { items: [], page: 1, pageSize: 20, total: 0, totalPages: 0, from: 0, to: 0 });
});
