const pool = require('./db');

function sanitizeInput(val) {
    if (val === undefined || val === null) return null;
    const str = String(val).trim();
    if (str === "" || str.toLowerCase() === "not found") return null;
    return str;
}

/**
 * Inserts or updates PAN card details non-destructively in `pan_records`.
 */
async function insertOrUpdatePan(data) {
    const panNumber = sanitizeInput(data.panNumber);

    if (!panNumber) {
        throw new Error("PAN Number is required for database operations.");
    }

    const payload = {
        pan_number: panNumber,
        name: sanitizeInput(data.name),
        father_name: sanitizeInput(data.fatherName),
        dob: sanitizeInput(data.dob),
        inserted_by_mobile: sanitizeInput(data.insertedByMobile),
        image_path: sanitizeInput(data.imagePath)
    };

    try {
        const [rows] = await pool.execute(
            'SELECT * FROM pan_records WHERE pan_number = ?',
            [payload.pan_number]
        );

        if (rows.length === 0) {
            const insertSql = `
                INSERT INTO pan_records (
                    pan_number, name, father_name, dob, inserted_by_mobile, image_path
                ) VALUES (?, ?, ?, ?, ?, ?)
            `;

            const insertParams = [
                payload.pan_number,
                payload.name,
                payload.father_name,
                payload.dob,
                payload.inserted_by_mobile,
                payload.image_path
            ];

            const [result] = await pool.execute(insertSql, insertParams);

            return {
                status: 'success',
                action: 'inserted',
                insertId: result.insertId
            };

        } else {
            const updateClauses = [];
            const updateParams = [];

            const fields = ['name', 'father_name', 'dob', 'inserted_by_mobile', 'image_path'];

            for (const field of fields) {
                if (payload[field] !== null) {
                    updateClauses.push(`${field} = ?`);
                    updateParams.push(payload[field]);
                }
            }

            if (updateClauses.length === 0) {
                return {
                    status: 'success',
                    action: 'none',
                    message: 'Record exists, no new valid data supplied.'
                };
            }

            updateParams.push(payload.pan_number);

            const updateSql = `
                UPDATE pan_records 
                SET ${updateClauses.join(', ')} 
                WHERE pan_number = ?
            `;

            await pool.execute(updateSql, updateParams);

            return {
                status: 'success',
                action: 'updated'
            };
        }

    } catch (error) {
        console.error("❌ PAN DB Error:", error.message);
        throw error;
    }
}

module.exports = { insertOrUpdatePan };