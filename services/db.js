const mysql = require('mysql2/promise');

// Configure database credentials for AK ERP
const pool = mysql.createPool({
    host: '50.63.129.30',
    user: 'rishyamittal',
    password: 'Mousekamakan@123',
    database: 'rishya',
    waitForConnections: true,
    connectionLimit: 20,
    maxIdle: 10,
    idleTimeout: 60000,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 30000
});

module.exports = pool;