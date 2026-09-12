const mysql = require('mysql2/promise');

// Configure database credentials for AK ERP
const pool = mysql.createPool({
    host: '50.63.129.30',
    user: 'rishyamittal',          // Replace with your MySQL username
    password: 'Mousekamakan@123',          // Replace with your MySQL password
    database: 'rishya', // Replace with your database name
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool;