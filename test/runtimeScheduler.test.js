const test = require("node:test");
const assert = require("node:assert/strict");

process.env.BOT_TOKEN ||= "test-token";

const { registerRuntimeJobs } = require("../main");

test("scheduler không còn job lịch trực 06:00 sau khi tách phòng 411", () => {
    const jobs = [];
    const scheduler = {
        scheduleJob(config, handler) {
            jobs.push({ config, handler });
        }
    };

    registerRuntimeJobs(scheduler);

    // Lịch trực phòng 411 đã được tách sang bot riêng nên job 06:00 không còn ở đây.
    // Hai bot không bao giờ được gửi cùng một thông báo lịch trực.
    assert.equal(
        jobs.find(({ config }) => config.rule === "0 6 * * *"),
        undefined,
        "ZaloBot không được còn job gửi lịch trực 06:00"
    );

    const minuteJob = jobs.find(({ config }) => config.rule === "* * * * *");
    assert.ok(minuteJob, "thiếu scheduler trung tâm chạy mỗi phút");
    assert.equal(minuteJob.config.tz, "Asia/Ho_Chi_Minh");
    assert.equal(typeof minuteJob.handler, "function");

    const changeJob = jobs.find(({ config }) => config.rule === "*/15 * * * *");
    assert.ok(changeJob, "thiếu job kiểm tra thay đổi lịch");
    assert.equal(changeJob.config.tz, "Asia/Ho_Chi_Minh");

    const birthdayJob = jobs.find(({ config }) => config.rule === "5 0 27 8 *");
    assert.ok(birthdayJob, "thiếu job sinh nhật");
    assert.equal(birthdayJob.config.tz, "Asia/Ho_Chi_Minh");

    for (const job of jobs) {
        assert.equal(job.config.tz, "Asia/Ho_Chi_Minh", `job ${job.config.rule} phải dùng múi giờ Việt Nam`);
    }
});
