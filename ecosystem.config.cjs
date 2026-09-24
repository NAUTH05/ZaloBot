// PM2 configuration for ZaloBot.
//
// ZaloBot MUST run as EXACTLY ONE process. Cluster mode would create multiple
// copies of Zalo polling, the scheduler and dashboard listeners, which produces
// duplicated notifications. Keep `instances: 1` and `exec_mode: "fork"`.
//
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 status
//   pm2 logs zalobot
const path = require("path");

module.exports = {
    apps: [{
        name: "zalobot",
        script: "main.js",
        cwd: __dirname,
        instances: 1,
        exec_mode: "fork",
        autorestart: true,
        max_restarts: 10,
        min_uptime: "30s",
        restart_delay: 5000,
        // Must stay above SHUTDOWN_TIMEOUT_MS so pending Firestore writes can flush.
        kill_timeout: 15000,
        listen_timeout: 8000,
        // ------------------------------------------------------------------
        // max_memory_restart is a LAST-RESORT SAFETY GUARD, not the memory
        // strategy. It exists so a genuinely runaway process gets recycled
        // instead of taking the VPS down with it.
        //
        // It is NOT a fix for memory growth. Restarting hides the symptom and
        // costs a full cold start (Firestore hydrate + provider login) every
        // time it fires. Fix retention in the application instead:
        //   - persistence writes are coalesced per store (firestorePersistence.js)
        //   - startup reconciliation writes at most once per store, not once per record
        //   - outbound sends are bounded per provider (sendQueue.js)
        //   - duplicate listeners/timers are guarded
        //
        // Raise this only after measuring; do NOT lower it back to 512M without
        // evidence, because RSS is expected to exceed heap (Buffers, sockets,
        // native gRPC/Firestore and WebSocket state live outside the V8 heap).
        //
        // 1.5G gives roughly 2x headroom over observed steady-state RSS while
        // still catching an unbounded leak before it exhausts the host.
        // ------------------------------------------------------------------
        max_memory_restart: "1536M",
        time: true,
        merge_logs: true,
        watch: false,
        env: {
            NODE_ENV: "production",
            TZ: "Asia/Ho_Chi_Minh"
        }
        // Firebase credentials are read from .env (FIREBASE_SERVICE_ACCOUNT_FILE).
        // If you prefer to inject them through PM2 instead, add:
        //   FIREBASE_SERVICE_ACCOUNT_FILE: "/absolute/path/to/service-account.json"
    }]
};
