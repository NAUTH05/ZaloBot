const test = require("node:test");
const assert = require("node:assert/strict");

process.env.BOT_TOKEN ||= "test-token";

const { registerRuntimeJobs } = require("../main");

test("scheduler đăng ký gửi lịch trực phòng 411 lúc 06:00 giờ Việt Nam", () => {
    const jobs = [];
    const scheduler = {
        scheduleJob(config, handler) {
            jobs.push({ config, handler });
        }
    };

    registerRuntimeJobs(scheduler);

    const dutyJob = jobs.find(({ config }) => config.rule === "0 6 * * *");
    assert.ok(dutyJob, "thiếu job gửi lịch trực 411 lúc 06:00");
    assert.equal(dutyJob.config.tz, "Asia/Ho_Chi_Minh");
    assert.equal(typeof dutyJob.handler, "function");

    const minuteJob = jobs.find(({ config }) => config.rule === "* * * * *");
    assert.ok(minuteJob, "thiếu scheduler trung tâm chạy mỗi phút");
    assert.equal(minuteJob.config.tz, "Asia/Ho_Chi_Minh");
    assert.equal(typeof minuteJob.handler, "function");
});
