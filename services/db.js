const mysql = require('mysql2/promise');

// Helper to extract clean single values even if .env was pasted on one single line
function cleanEnv(val, fallback) {
    if (!val) return fallback;
    const str = String(val).trim();
    // If str contains multiple space-separated KEY=VALUE pairs, take just the first token
    const firstToken = str.split(/\s+/)[0];
    return firstToken || fallback;
}

const dbHost = cleanEnv(process.env.DB_HOST, '50.63.129.30');
const rawPort = cleanEnv(process.env.DB_PORT, '3306');
const dbPort = parseInt(rawPort.match(/\d+/)?.[0] || '3306', 10);
const dbUser = cleanEnv(process.env.DB_USER, 'rishyamittal');
const dbPassword = cleanEnv(process.env.DB_PASSWORD, 'Mousekamakan@123');
const dbName = cleanEnv(process.env.DB_NAME, 'rishya');

// Configure database credentials for AK ERP with Indian Standard Time (IST / +05:30)
const pool = mysql.createPool({
    host: dbHost,
    port: dbPort,
    user: dbUser,
    password: dbPassword,
    database: dbName,
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

// Enforce session timezone to Indian Standard Time (+05:30) on every new connection
if (pool.pool && typeof pool.pool.on === 'function') {
    pool.pool.on('connection', (connection) => {
        connection.query("SET time_zone = '+05:30'", (err) => {
            if (err) console.warn("⚠️ [Database] Connection timezone set warning:", err.message);
        });
    });
} else if (typeof pool.on === 'function') {
    pool.on('connection', (connection) => {
        connection.query("SET time_zone = '+05:30'", (err) => {
            if (err) console.warn("⚠️ [Database] Connection timezone set warning:", err.message);
        });
    });
}

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