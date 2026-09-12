const pool = require('./db');

function sanitizeInput(val) {
    if (val === undefined || val === null) return null;
    const str = String(val).trim();
    if (str === "" || str.toLowerCase() === "not found") return null;
    return str;
}

/**
 * Inserts an entry into the master tracking table `wh_uploads`
 */
async function logImageUpload({ receiverMobile, senderMobile, imageCaption, imageId, uploadUri }) {
    try {
        const sql = `
            INSERT INTO wh_uploads (
                receiver_mobile, sender_mobile, image_caption, image_id, upload_uri
            ) VALUES (?, ?, ?, ?, ?)
        `;
        const params = [
            sanitizeInput(receiverMobile) || 'Unknown',
            sanitizeInput(senderMobile) || 'Unknown',
            sanitizeInput(imageCaption) || 'Unknown',
            sanitizeInput(imageId),
            sanitizeInput(uploadUri)
        ];

        const [result] = await pool.execute(sql, params);
        return result.insertId;
    } catch (err) {
        console.error('❌ [documentDbService] Error logging to wh_uploads:', err.message);
        throw err;
    }
}

/**
 * Inserts or updates an Aadhaar record in `wh_aadhar_records`
 */
async function insertOrUpdateAadhaar({
    uploadId,
    aadharNumber,
    virtualId,
    nameEnglish,
    nameHindi,
    dob,
    genderEnglish,
    genderHindi,
    addressEnglish,
    addressHindi,
    pincode,
    senderMobile,
    receiverMobile,
    uploadUri
}) {
    const cleanAadhaar = sanitizeInput(aadharNumber);
    if (!cleanAadhaar) {
        throw new Error("Aadhaar Number is required for database operations.");
    }

    const payload = {
        upload_id: uploadId || null,
        aadhar_number: cleanAadhaar,
        virtual_id: sanitizeInput(virtualId),
        name_english: sanitizeInput(nameEnglish),
        name_hindi: sanitizeInput(nameHindi),
        dob: sanitizeInput(dob),
        gender_english: sanitizeInput(genderEnglish),
        gender_hindi: sanitizeInput(genderHindi),
        address_english: sanitizeInput(addressEnglish),
        address_hindi: sanitizeInput(addressHindi),
        pincode: sanitizeInput(pincode),
        sender_mobile: sanitizeInput(senderMobile) || 'Unknown',
        receiver_mobile: sanitizeInput(receiverMobile) || 'Unknown'
    };

    // Determine Front vs Back image based on extracted fields
    const hasAddress = !!payload.address_english || !!payload.address_hindi;
    const hasPersonalInfo = !!payload.name_english || !!payload.dob || !!payload.gender_english;

    let frontUri = null;
    let backUri = null;

    if (hasAddress && !hasPersonalInfo) {
        backUri = uploadUri;
    } else {
        frontUri = uploadUri;
    }

    try {
        const [rows] = await pool.execute(
            'SELECT * FROM wh_aadhar_records WHERE aadhar_number = ?',
            [payload.aadhar_number]
        );

        if (rows.length === 0) {
            // INSERT
            const insertSql = `
                INSERT INTO wh_aadhar_records (
                    upload_id, aadhar_number, virtual_id, name_english, name_hindi,
                    dob, gender_english, gender_hindi, address_english, address_hindi,
                    pincode, sender_mobile, receiver_mobile, front_image_uri, back_image_uri
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;

            const insertParams = [
                payload.upload_id,
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
                payload.sender_mobile,
                payload.receiver_mobile,
                frontUri,
                backUri
            ];

            const [result] = await pool.execute(insertSql, insertParams);

            return {
                status: 'success',
                action: 'inserted',
                recordId: result.insertId,
                message: 'New Aadhaar record created.'
            };
        } else {
            // UPDATE existing non-destructively
            const updateClauses = [];
            const updateParams = [];

            const fields = [
                'upload_id', 'virtual_id', 'name_english', 'name_hindi',
                'dob', 'gender_english', 'gender_hindi', 'address_english',
                'address_hindi', 'pincode', 'sender_mobile', 'receiver_mobile'
            ];

            for (const f of fields) {
                if (payload[f] !== null) {
                    updateClauses.push(`${f} = ?`);
                    updateParams.push(payload[f]);
                }
            }

            if (frontUri !== null) {
                updateClauses.push('front_image_uri = ?');
                updateParams.push(frontUri);
            }
            if (backUri !== null) {
                updateClauses.push('back_image_uri = ?');
                updateParams.push(backUri);
            }

            if (updateClauses.length === 0) {
                return { status: 'success', action: 'none', message: 'No new data to update.' };
            }

            updateParams.push(payload.aadhar_number);
            const updateSql = `
                UPDATE wh_aadhar_records
                SET ${updateClauses.join(', ')}
                WHERE aadhar_number = ?
            `;

            await pool.execute(updateSql, updateParams);

            return {
                status: 'success',
                action: 'updated',
                message: 'Existing Aadhaar record updated.'
            };
        }
    } catch (err) {
        console.error('❌ [documentDbService] Aadhaar DB Error:', err.message);
        throw err;
    }
}

/**
 * Inserts or updates a PAN record in `wh_pan_records`
 */
async function insertOrUpdatePan({
    uploadId,
    panNumber,
    name,
    fatherName,
    dob,
    senderMobile,
    receiverMobile,
    uploadUri
}) {
    const cleanPan = sanitizeInput(panNumber);
    if (!cleanPan) {
        throw new Error("PAN Number is required for database operations.");
    }

    const payload = {
        upload_id: uploadId || null,
        pan_number: cleanPan,
        name: sanitizeInput(name),
        father_name: sanitizeInput(fatherName),
        dob: sanitizeInput(dob),
        sender_mobile: sanitizeInput(senderMobile) || 'Unknown',
        receiver_mobile: sanitizeInput(receiverMobile) || 'Unknown',
        image_uri: sanitizeInput(uploadUri)
    };

    try {
        const [rows] = await pool.execute(
            'SELECT * FROM wh_pan_records WHERE pan_number = ?',
            [payload.pan_number]
        );

        if (rows.length === 0) {
            const insertSql = `
                INSERT INTO wh_pan_records (
                    upload_id, pan_number, name, father_name, dob,
                    sender_mobile, receiver_mobile, image_uri
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `;
            const params = [
                payload.upload_id,
                payload.pan_number,
                payload.name,
                payload.father_name,
                payload.dob,
                payload.sender_mobile,
                payload.receiver_mobile,
                payload.image_uri
            ];
            const [result] = await pool.execute(insertSql, params);

            return {
                status: 'success',
                action: 'inserted',
                recordId: result.insertId,
                message: 'New PAN record created.'
            };
        } else {
            const updateClauses = [];
            const updateParams = [];

            const fields = ['upload_id', 'name', 'father_name', 'dob', 'sender_mobile', 'receiver_mobile', 'image_uri'];
            for (const f of fields) {
                if (payload[f] !== null) {
                    updateClauses.push(`${f} = ?`);
                    updateParams.push(payload[f]);
                }
            }

            if (updateClauses.length === 0) {
                return { status: 'success', action: 'none', message: 'No new data.' };
            }

            updateParams.push(payload.pan_number);
            const updateSql = `
                UPDATE wh_pan_records
                SET ${updateClauses.join(', ')}
                WHERE pan_number = ?
            `;
            await pool.execute(updateSql, updateParams);

            return {
                status: 'success',
                action: 'updated',
                message: 'Existing PAN record updated.'
            };
        }
    } catch (err) {
        console.error('❌ [documentDbService] PAN DB Error:', err.message);
        throw err;
    }
}

module.exports = {
    logImageUpload,
    insertOrUpdateAadhaar,
    insertOrUpdatePan
};

