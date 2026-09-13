const fs = require('fs');
const path = require('path');
const pool = require('./services/db');

async function initializeDatabase() {
    try {
        console.log("⏳ Initializing database tables with 'wh_' prefix...");
        const schemaPath = path.join(__dirname, 'schema.sql');
        const sql = fs.readFileSync(schemaPath, 'utf8');

        // Split queries by semicolon
        const queries = sql
            .split(';')
            .map(q => q.trim())
            .filter(q => q.length > 0 && !q.startsWith('--'));

        for (const query of queries) {
            await pool.execute(query);
        }

        console.log("✅ All tables created successfully:");
        console.log("   - wh_uploads (Master Image Uploads & Metadata)");
        console.log("   - wh_aadhar_card_records (Aadhaar Card Detailed Fields)");
        console.log("   - wh_pan_card_records (PAN Card Detailed Fields)");
        console.log("   - wh_old_jamabandi_records (Rajasthan Jamabandi P-26C Records)");
        console.log("   - wh_sale_deed_records (Property Sale Deed Records)");
        console.log("   - wh_baileys_auth (WhatsApp Session Storage for Cloud Run)");

    } catch (err) {
        console.error("❌ Database initialization error:", err.message);
    } finally {
        process.exit();
    }
}

initializeDatabase();