const pool = require('./db');

function sanitizeInput(val) {
    if (val === undefined || val === null) return null;
    const str = String(val).trim();
    if (str === "" || str.toLowerCase() === "not found") return null;
    return str;
}

/**
 * Inserts or updates Aadhaar records in DB, intelligently assigning the uploaded
 * image to `front_image_path` or `back_image_path` based on extracted fields.
 */
async function insertOrUpdateAadhaar(data) {
    const aadharNumber = sanitizeInput(data.aadharNumber);

    if (!aadharNumber) {
        throw new Error("Aadhaar Number is required for database operations.");
    }

    const payload = {
        aadhar_number: aadharNumber,
        virtual_id: sanitizeInput(data.virtualId),
        name_english: sanitizeInput(data.nameEnglish),
        name_hindi: sanitizeInput(data.nameHindi),
        dob: sanitizeInput(data.dob),
        gender_english: sanitizeInput(data.genderEnglish),
        gender_hindi: sanitizeInput(data.genderHindi),
        address_english: sanitizeInput(data.addressEnglish),
        address_hindi: sanitizeInput(data.addressHindi),
        pincode: sanitizeInput(data.pincode),
        inserted_by_mobile: sanitizeInput(data.insertedByMobile)
    };

    const filePath = sanitizeInput(data.aadharFilePath);

    // Determine whether this upload represents the Back side only or Front / Full card
    const hasAddress = !!payload.address_english || !!payload.address_hindi;
    const hasPersonalInfo = !!payload.name_english || !!payload.dob || !!payload.gender_english;

    let frontPath = null;
    let backPath = null;

    if (hasAddress && !hasPersonalInfo) {
        // Back side image (contains address details but no name/dob)
        backPath = filePath;
    } else {
        // Front side image or full single-card image
        frontPath = filePath;
    }

    try {
        const [rows] = await pool.execute(
            'SELECT * FROM aadhar_records WHERE aadhar_number = ?',
            [payload.aadhar_number]
        );

        if (rows.length === 0) {
            // INSERT New Record
            const insertSql = `
                INSERT INTO aadhar_records (
                    aadhar_number, virtual_id, name_english, name_hindi, dob,
                    gender_english, gender_hindi, address_english, address_hindi,
                    pincode, inserted_by_mobile, front_image_path, back_image_path
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;

            const insertParams = [
                payload.aadhar_number,
                payload.virtual_id,
                payload.name_english,
                payload.name_hindi,
                payload.dob,
                payload.gender_english,
                payload.gender_hindi,
                payload.address_english,
                payload.address_hindi,
                payload.pincode,
                payload.inserted_by_mobile,
                frontPath,
                backPath
            ];

            const [result] = await pool.execute(insertSql, insertParams);

            return {
                status: 'success',
                action: 'inserted',
                insertId: result.insertId,
                message: 'New record created successfully.'
            };

        } else {
            // UPDATE Existing Record (Non-destructive)
            const updateClauses = [];
            const updateParams = [];

            const updateFields = [
                'virtual_id', 'name_english', 'name_hindi', 'dob',
                'gender_english', 'gender_hindi', 'address_english', 'address_hindi',
                'pincode', 'inserted_by_mobile'
            ];

            for (const field of updateFields) {
                if (payload[field] !== null) {
                    updateClauses.push(`${field} = ?`);
                    updateParams.push(payload[field]);
                }
            }

            // Dynamically assign image paths without overwriting existing side if present
            if (frontPath !== null) {
                updateClauses.push(`front_image_path = ?`);
                updateParams.push(frontPath);
            }
            if (backPath !== null) {
                updateClauses.push(`back_image_path = ?`);
                updateParams.push(backPath);
            }

            if (updateClauses.length === 0) {
                return {
                    status: 'success',
                    action: 'none',
                    message: 'Record exists, but no new valid data was provided.'
                };
            }

            updateParams.push(payload.aadhar_number);

            const updateSql = `
                UPDATE aadhar_records 
                SET ${updateClauses.join(', ')} 
                WHERE aadhar_number = ?
            `;

            await pool.execute(updateSql, updateParams);

            return {
                status: 'success',
                action: 'updated',
                message: 'Existing record updated cleanly.'
            };
        }

    } catch (error) {
        console.error("❌ Database Operation Error:", error.message);
        throw error;
    }
}

module.exports = { insertOrUpdateAadhaar };