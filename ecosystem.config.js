module.exports = {
    apps: [{
        name: "zalobot",
        script: "main.js",
        cwd: __dirname,
        autorestart: true,
        max_restarts: 10,
        restart_delay: 5000,
        time: true,
        env: {
            NODE_ENV: "production",
            PORT: process.env.PORT || 6003,
            ADMIN_PORT: process.env.ADMIN_PORT || process.env.PORT || 6003,
            FIREBASE_SERVICE_ACCOUNT_FILE: '/home/dpdns-zalobot-mrnauthdev/htdocs/firebase-service-account.json'
        }
    }]
};
