const pool = require('./services/db');

async function initializePanTable() {
    const dropTableQuery = `DROP TABLE IF EXISTS pan_records;`;

    const createTableQuery = `
        CREATE TABLE pan_records (
            id INT AUTO_INCREMENT PRIMARY KEY,
            
            -- Unique Identifiers
            pan_number VARCHAR(10) NOT NULL UNIQUE,            -- Format: 'ABCDE1234F'
            
            -- Personal Details
            name VARCHAR(255) DEFAULT NULL,
            father_name VARCHAR(255) DEFAULT NULL,
            dob VARCHAR(10) DEFAULT NULL,                      -- Format: 'DD/MM/YYYY'
            
            -- Storage & Tracking Metadata
            inserted_by_mobile VARCHAR(20) NOT NULL,           -- Sender's Phone Number
            image_path VARCHAR(512) DEFAULT NULL,              -- Saved PAN image location
            
            -- System Timestamps
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;

    try {
        console.log("⏳ Initializing 'pan_records' table...");
        await pool.execute(dropTableQuery);
        await pool.execute(createTableQuery);
        console.log("✅ Table 'pan_records' created successfully.");
    } catch (error) {
        console.error("❌ Failed to initialize PAN table:", error.message);
    } finally {
        process.exit();
    }
}

initializePanTable();