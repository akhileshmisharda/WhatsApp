const mysql = require('mysql2/promise');

// Configure database credentials for AK ERP with Indian Standard Time (IST / +05:30)
const pool = mysql.createPool({
    host: '50.63.129.30',
    user: 'rishyamittal',
    password: 'Mousekamakan@123',
    database: 'rishya',
    timezone: '+05:30',
    dateStrings: true,
    waitForConnections: true,
    connectionLimit: 20,
    maxIdle: 10,
    idleTimeout: 60000,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 30000
});

// Enforce session timezone to Indian Standard Time (+05:30)
(async () => {
    try {
        await pool.query("SET time_zone = '+05:30'");
        console.log("🕒 [Database] Session time zone set to Indian Standard Time (IST / +05:30)");
    } catch (err) {
        console.warn("⚠️ [Database] Timezone configuration warning:", err.message);
    }
})();

module.exports = pool;