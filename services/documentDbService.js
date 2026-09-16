const pool = require('./db');

function sanitizeInput(val) {
    if (val === undefined || val === null) return null;
    const str = String(val).trim();
    if (str === "" || str.toLowerCase() === "not found") return null;
    return str;
}

/**
 * Generates an exact Indian Standard Time (IST / UTC+05:30) timestamp formatted as 'YYYY-MM-DD HH:mm:ss'
 * Independent of server OS, Docker, or database default timezone.
 */
function getISTNow() {
    const d = new Date();
    const istDate = new Date(d.getTime() + (330 * 60 * 1000));
    return istDate.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Inserts an entry into the master tracking table `wh_uploads`
 */
async function logImageUpload({ receiverMobile, senderMobile, imageCaption, imageId, uploadUri }) {
    try {
        const istNow = getISTNow();
        const sql = `
            INSERT INTO wh_uploads (
                receiver_mobile, sender_mobile, image_caption, image_id, upload_uri, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        const params = [
            sanitizeInput(receiverMobile) || 'Unknown',
            sanitizeInput(senderMobile) || 'Unknown',
            sanitizeInput(imageCaption) || 'Unknown',
            sanitizeInput(imageId),
            sanitizeInput(uploadUri),
            istNow,
            istNow
        ];

        const [result] = await pool.execute(sql, params);
        return result.insertId;
    } catch (err) {
        console.error('❌ [documentDbService] Error logging to wh_uploads:', err.message);
        throw err;
    }
}

let columnsChecked = false;
async function ensureAadhaarColumnsExist() {
    if (columnsChecked) return;
    try {
        const createSql = `
            CREATE TABLE IF NOT EXISTS \`wh_aadhaar_card_records\` (
                \`id\` INT AUTO_INCREMENT PRIMARY KEY,
                \`upload_id\` INT DEFAULT NULL COMMENT 'Reference to wh_uploads.id',
                \`reference_id\` INT DEFAULT NULL COMMENT 'External Reference ID e.g. 3650 from A-3650',
                \`aadhar_number\` VARCHAR(20) NOT NULL UNIQUE COMMENT '12-digit Aadhaar Number',
                \`virtual_id\` VARCHAR(25) DEFAULT NULL COMMENT '16-digit VID',
                \`name_english\` VARCHAR(255) DEFAULT NULL,
                \`name_hindi\` VARCHAR(255) DEFAULT NULL,
                \`dob\` VARCHAR(20) DEFAULT NULL COMMENT 'DOB or YOB (DD/MM/YYYY or YYYY)',
                \`gender_english\` VARCHAR(20) DEFAULT NULL,
                \`gender_hindi\` VARCHAR(50) DEFAULT NULL,
                \`relation_status\` VARCHAR(50) DEFAULT NULL COMMENT 'W/O, S/O, D/O, or C/O',
                \`father_name_english\` VARCHAR(255) DEFAULT NULL,
                \`father_name_hindi\` VARCHAR(255) DEFAULT NULL,
                \`husband_name_english\` VARCHAR(255) DEFAULT NULL,
                \`husband_name_hindi\` VARCHAR(255) DEFAULT NULL,
                \`address_english\` TEXT DEFAULT NULL,
                \`address_hindi\` TEXT DEFAULT NULL,
                \`pincode\` VARCHAR(10) DEFAULT NULL,
                \`raw_json\` LONGTEXT DEFAULT NULL,
                \`tokens_prompt\` INT DEFAULT 0,
                \`tokens_completion\` INT DEFAULT 0,
                \`tokens_total\` INT DEFAULT 0,
                \`ai_model\` VARCHAR(100) DEFAULT NULL,
                \`accuracy_overall\` INT DEFAULT 100,
                \`accuracy_aadhaar_number\` INT DEFAULT 100,
                \`accuracy_name_english\` INT DEFAULT 100,
                \`accuracy_name_hindi\` INT DEFAULT 100,
                \`accuracy_dob\` INT DEFAULT 100,
                \`accuracy_pincode\` INT DEFAULT 100,
                \`sender_mobile\` VARCHAR(25) NOT NULL,
                \`receiver_mobile\` VARCHAR(25) NOT NULL,
                \`front_image_uri\` VARCHAR(500) DEFAULT NULL,
                \`back_image_uri\` VARCHAR(500) DEFAULT NULL,
                \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX \`idx_reference_id\` (\`reference_id\`),
                INDEX \`idx_aadhar_number\` (\`aadhar_number\`),
                INDEX \`idx_sender_mobile\` (\`sender_mobile\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `;
        await pool.execute(createSql);

        const [cols] = await pool.execute(`SHOW COLUMNS FROM wh_aadhaar_card_records`);
        const existingCols = cols.map(c => c.Field);
        
        const requiredCols = [
            { name: 'reference_id', def: 'INT DEFAULT NULL' },
            { name: 'relation_status', def: 'VARCHAR(50) DEFAULT NULL' },
            { name: 'father_name_english', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'father_name_hindi', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'husband_name_english', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'husband_name_hindi', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'raw_json', def: 'LONGTEXT DEFAULT NULL' },
            { name: 'tokens_prompt', def: 'INT DEFAULT 0' },
            { name: 'tokens_completion', def: 'INT DEFAULT 0' },
            { name: 'tokens_total', def: 'INT DEFAULT 0' },
            { name: 'ai_model', def: 'VARCHAR(100) DEFAULT NULL' },
            { name: 'accuracy_overall', def: 'INT DEFAULT 100' },
            { name: 'accuracy_aadhaar_number', def: 'INT DEFAULT 100' },
            { name: 'accuracy_name_english', def: 'INT DEFAULT 100' },
            { name: 'accuracy_name_hindi', def: 'INT DEFAULT 100' },
            { name: 'accuracy_dob', def: 'INT DEFAULT 100' },
            { name: 'accuracy_pincode', def: 'INT DEFAULT 100' }
        ];

        for (const col of requiredCols) {
            if (!existingCols.includes(col.name)) {
                await pool.execute(`ALTER TABLE wh_aadhaar_card_records ADD COLUMN \`${col.name}\` ${col.def}`);
                console.log(`✅ [Database] Added missing column '${col.name}' to wh_aadhaar_card_records`);
            }
        }
        columnsChecked = true;
    } catch (err) {
        console.warn('⚠️ [Database] Column check warning:', err.message);
    }
}

/**
 * Helper to determine if a new field value should replace the existing value based on accuracy and completeness
 */
function shouldUpdateField(newVal, newAcc, oldVal, oldAcc) {
    if (!newVal || newVal === "Not Found" || String(newVal).trim() === "") return false;
    if (!oldVal || oldVal === "Not Found" || String(oldVal).trim() === "") return true; // old is empty, new has value
    if (newAcc > (oldAcc || 0)) return true; // new accuracy is strictly higher
    if (newAcc === (oldAcc || 0) && String(newVal).length > String(oldVal).length) return true; // same accuracy, longer/richer string
    return false;
}

/**
 * Inserts or updates an Aadhaar record in `wh_aadhaar_card_records` with multi-sided (Front/Back) merging and accuracy-based field upgrades.
 */
async function insertOrUpdateAadhaar({
    uploadId,
    referenceId,
    aadharNumber,
    virtualId,
    nameEnglish,
    nameHindi,
    dob,
    genderEnglish,
    genderHindi,
    relationStatus,
    fatherNameEnglish,
    fatherNameHindi,
    husbandNameEnglish,
    husbandNameHindi,
    addressEnglish,
    addressHindi,
    pincode,
    rawJson,
    detectedSide,
    tokensPrompt,
    tokensCompletion,
    tokensTotal,
    aiModel,
    accuracyOverall,
    accuracyAadhaarNumber,
    accuracyNameEnglish,
    accuracyNameHindi,
    accuracyDob,
    accuracyPincode,
    senderMobile,
    receiverMobile,
    uploadUri,
    documentUri
}) {
    await ensureAadhaarColumnsExist();

    const actualUploadUri = sanitizeInput(uploadUri || documentUri);

    let cleanAadhaar = null;
    if (aadharNumber && aadharNumber !== "Not Found") {
        const digits = String(aadharNumber).replace(/\D/g, '');
        if (digits.length === 12 && !digits.startsWith("1947") && !digits.startsWith("1800")) {
            cleanAadhaar = `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8, 12)}`;
        }
    }

    const cleanSender = sanitizeInput(senderMobile) || 'Unknown';
    const cleanReceiver = sanitizeInput(receiverMobile) || 'Unknown';

    // Determine if current scan is Front vs Back
    let isFrontScan = detectedSide === 'front';
    let isBackScan = detectedSide === 'back';
    if (!isFrontScan && !isBackScan) {
        const hasFrontInfo = !!nameEnglish || !!dob || !!genderEnglish;
        const hasBackInfo = !!addressEnglish || !!addressHindi || !!fatherNameEnglish || !!husbandNameEnglish || !!pincode;
        if (hasFrontInfo && !hasBackInfo) isFrontScan = true;
        else if (hasBackInfo && !hasFrontInfo) isBackScan = true;
        else { isFrontScan = true; isBackScan = true; }
    }

    let resolvedRelation = sanitizeInput(relationStatus);
    if (!resolvedRelation) {
        if (husbandNameEnglish || husbandNameHindi) resolvedRelation = 'W/O';
        else if (fatherNameEnglish || fatherNameHindi) {
            if (genderEnglish && genderEnglish.toLowerCase() === 'female') resolvedRelation = 'D/O';
            else resolvedRelation = 'S/O';
        }
    }

    const { ensureBilingualName } = require('./transliterate');
    const nameBilingual = ensureBilingualName(nameEnglish, nameHindi);
    const fatherBilingual = ensureBilingualName(fatherNameEnglish, fatherNameHindi);
    const husbandBilingual = ensureBilingualName(husbandNameEnglish, husbandNameHindi);

    const parsedRefId = (referenceId !== undefined && referenceId !== null && !isNaN(parseInt(referenceId, 10))) 
        ? parseInt(referenceId, 10) 
        : null;

    const payload = {
        upload_id: uploadId || null,
        reference_id: parsedRefId,
        aadhar_number: cleanAadhaar,
        virtual_id: sanitizeInput(virtualId),
        name_english: sanitizeInput(nameBilingual.english),
        name_hindi: sanitizeInput(nameBilingual.hindi),
        dob: sanitizeInput(dob),
        gender_english: sanitizeInput(genderEnglish),
        gender_hindi: sanitizeInput(genderHindi),
        relation_status: resolvedRelation,
        father_name_english: sanitizeInput(fatherBilingual.english),
        father_name_hindi: sanitizeInput(fatherBilingual.hindi),
        husband_name_english: sanitizeInput(husbandBilingual.english),
        husband_name_hindi: sanitizeInput(husbandBilingual.hindi),
        address_english: sanitizeInput(addressEnglish),
        address_hindi: sanitizeInput(addressHindi),
        pincode: sanitizeInput(pincode),
        raw_json: typeof rawJson === 'object' ? JSON.stringify(rawJson) : sanitizeInput(rawJson),
        tokens_prompt: typeof tokensPrompt === 'number' ? tokensPrompt : 0,
        tokens_completion: typeof tokensCompletion === 'number' ? tokensCompletion : 0,
        tokens_total: typeof tokensTotal === 'number' ? tokensTotal : 0,
        ai_model: sanitizeInput(aiModel) || 'gemini-3.1-flash',
        accuracy_overall: typeof accuracyOverall === 'number' ? accuracyOverall : 100,
        accuracy_aadhaar_number: typeof accuracyAadhaarNumber === 'number' ? accuracyAadhaarNumber : 100,
        accuracy_name_english: typeof accuracyNameEnglish === 'number' ? accuracyNameEnglish : 100,
        accuracy_name_hindi: typeof accuracyNameHindi === 'number' ? accuracyNameHindi : 100,
        accuracy_dob: typeof accuracyDob === 'number' ? accuracyDob : 100,
        accuracy_pincode: typeof accuracyPincode === 'number' ? accuracyPincode : 100,
        sender_mobile: cleanSender,
        receiver_mobile: cleanReceiver
    };

    try {
        let existing = null;

        // 1. Strict Lookup: Exact valid 12-digit Aadhaar Number ONLY (Format: "XXXX XXXX XXXX")
        if (payload.aadhar_number && /^\d{4}\s\d{4}\s\d{4}$/.test(payload.aadhar_number)) {
            const [rows] = await pool.execute(
                'SELECT * FROM wh_aadhaar_card_records WHERE aadhar_number = ? LIMIT 1',
                [payload.aadhar_number]
            );
            if (rows.length > 0) {
                existing = rows[0];
                console.log(`🔍 [Aadhaar Match] Found existing record ID #${existing.id} matching Aadhaar "${payload.aadhar_number}"`);
            } else {
                console.log(`ℹ️ [Aadhaar No Match] Aadhaar "${payload.aadhar_number}" not in DB -> Inserting new record`);
            }
        } else {
            console.log(`ℹ️ [Aadhaar No 12-Digit Number] Extracted value "${payload.aadhar_number}" is not a valid 12-digit Aadhaar`);
            // If back scan has no Aadhaar number, match with the most recent front scan uploaded by this sender (last 15 mins)
            if (isBackScan && payload.sender_mobile && payload.sender_mobile !== 'Unknown') {
                try {
                    const [recentRows] = await pool.execute(
                        `SELECT * FROM wh_aadhaar_card_records 
                         WHERE sender_mobile = ? AND (back_image_uri IS NULL OR back_image_uri = '') 
                         ORDER BY id DESC LIMIT 1`,
                        [payload.sender_mobile]
                    );
                    if (recentRows.length > 0) {
                        existing = recentRows[0];
                        console.log(`🔗 [Aadhaar Merge] Matched back-side scan to recent front scan ID #${existing.id} for sender ${payload.sender_mobile}`);
                    }
                } catch (recErr) {
                    console.warn("⚠️ [Aadhaar Merge] Recent front scan match error:", recErr.message);
                }
            }
        }

        // Case A: New Record -> INSERT (Populate ONLY ONE image field at first time)
        if (!existing) {
            const finalAadhaarNum = payload.aadhar_number || `DOC${Date.now().toString().slice(-8)}`;
            
            // First time: If pure back scan -> back_image_uri, otherwise -> front_image_uri
            const frontUri = (isBackScan && !isFrontScan) ? null : actualUploadUri;
            const backUri = (isBackScan && !isFrontScan) ? actualUploadUri : null;

            const istNow = getISTNow();
            const insertSql = `
                INSERT INTO wh_aadhaar_card_records (
                    upload_id, reference_id, aadhar_number, virtual_id, name_english, name_hindi,
                    dob, gender_english, gender_hindi, relation_status, father_name_english, father_name_hindi,
                    husband_name_english, husband_name_hindi, address_english, address_hindi,
                    pincode, raw_json, tokens_prompt, tokens_completion, tokens_total, ai_model,
                    accuracy_overall, accuracy_aadhaar_number, accuracy_name_english,
                    accuracy_name_hindi, accuracy_dob, accuracy_pincode,
                    sender_mobile, receiver_mobile, front_image_uri, back_image_uri,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;

            const insertParams = [
                payload.upload_id,
                payload.reference_id,
                finalAadhaarNum,
                payload.virtual_id,
                payload.name_english,
                payload.name_hindi,
                payload.dob,
                payload.gender_english,
                payload.gender_hindi,
                payload.relation_status,
                payload.father_name_english,
                payload.father_name_hindi,
                payload.husband_name_english,
                payload.husband_name_hindi,
                payload.address_english,
                payload.address_hindi,
                payload.pincode,
                payload.raw_json,
                payload.tokens_prompt,
                payload.tokens_completion,
                payload.tokens_total,
                payload.ai_model,
                payload.accuracy_overall,
                payload.accuracy_aadhaar_number,
                payload.accuracy_name_english,
                payload.accuracy_name_hindi,
                payload.accuracy_dob,
                payload.accuracy_pincode,
                payload.sender_mobile,
                payload.receiver_mobile,
                frontUri,
                backUri,
                istNow,
                istNow
            ].map(v => (v === undefined ? null : v));

            const [result] = await pool.execute(insertSql, insertParams);

            let insertedRecord = null;
            try {
                const [rows] = await pool.execute('SELECT * FROM wh_aadhaar_card_records WHERE id = ? LIMIT 1', [result.insertId]);
                insertedRecord = rows[0] || null;
            } catch (e) {}

            return {
                status: 'success',
                action: 'inserted',
                recordId: result.insertId,
                record: insertedRecord,
                side: isBackScan && !isFrontScan ? 'back' : 'front',
                message: 'New Aadhaar record created.'
            };
        }

        // Case B: Existing Record Found -> Merge & Upgrade (Populate the second image field)
        const updateClauses = [];
        const updateParams = [];

        // Reference ID upgrade
        if (payload.reference_id !== null && payload.reference_id !== undefined) {
            updateClauses.push('`reference_id` = ?');
            updateParams.push(payload.reference_id);
        }

        // 1. Non-overlapping image assignment:
        if (existing.front_image_uri && !existing.back_image_uri) {
            updateClauses.push('`back_image_uri` = ?');
            updateParams.push(actualUploadUri);
        } else if (existing.back_image_uri && !existing.front_image_uri) {
            updateClauses.push('`front_image_uri` = ?');
            updateParams.push(actualUploadUri);
        } else if (isBackScan) {
            updateClauses.push('`back_image_uri` = ?');
            updateParams.push(actualUploadUri);
        } else {
            updateClauses.push('`front_image_uri` = ?');
            updateParams.push(actualUploadUri);
        }

        // 2. Aadhaar Number: If existing is valid, keep it; if new has valid and existing was dummy, update it
        if (payload.aadhar_number && payload.aadhar_number.replace(/\s/g, '').length >= 10 && (!existing.aadhar_number || existing.aadhar_number.startsWith("DOC"))) {
            updateClauses.push('`aadhar_number` = ?');
            updateParams.push(payload.aadhar_number);
        }

        // 3. Name English & Accuracy
        if (shouldUpdateField(payload.name_english, payload.accuracy_name_english, existing.name_english, existing.accuracy_name_english)) {
            updateClauses.push('`name_english` = ?', '`accuracy_name_english` = ?');
            updateParams.push(payload.name_english, payload.accuracy_name_english);
        }

        // 4. Name Hindi & Accuracy
        if (shouldUpdateField(payload.name_hindi, payload.accuracy_name_hindi, existing.name_hindi, existing.accuracy_name_hindi)) {
            updateClauses.push('`name_hindi` = ?', '`accuracy_name_hindi` = ?');
            updateParams.push(payload.name_hindi, payload.accuracy_name_hindi);
        }

        // 5. DOB & Accuracy
        if (shouldUpdateField(payload.dob, payload.accuracy_dob, existing.dob, existing.accuracy_dob)) {
            updateClauses.push('`dob` = ?', '`accuracy_dob` = ?');
            updateParams.push(payload.dob, payload.accuracy_dob);
        }

        // 6. Gender
        if (payload.gender_english && (!existing.gender_english || existing.gender_english === 'Not Found')) {
            updateClauses.push('`gender_english` = ?');
            updateParams.push(payload.gender_english);
        }
        if (payload.gender_hindi && (!existing.gender_hindi || existing.gender_hindi === 'Not Found')) {
            updateClauses.push('`gender_hindi` = ?');
            updateParams.push(payload.gender_hindi);
        }

        // 7. Relation Status
        if (payload.relation_status) {
            updateClauses.push('`relation_status` = ?');
            updateParams.push(payload.relation_status);
        }

        // 8. Father's Name (Always save if present in scan)
        if (payload.father_name_english) {
            updateClauses.push('`father_name_english` = ?');
            updateParams.push(payload.father_name_english);
        }
        if (payload.father_name_hindi) {
            updateClauses.push('`father_name_hindi` = ?');
            updateParams.push(payload.father_name_hindi);
        }

        // 9. Husband's Name (Always save if present in scan)
        if (payload.husband_name_english) {
            updateClauses.push('`husband_name_english` = ?');
            updateParams.push(payload.husband_name_english);
        }
        if (payload.husband_name_hindi) {
            updateClauses.push('`husband_name_hindi` = ?');
            updateParams.push(payload.husband_name_hindi);
        }

        // 9. Address & PIN
        if (payload.address_english && (!existing.address_english || existing.address_english === 'Not Found' || payload.address_english.length > existing.address_english.length)) {
            updateClauses.push('`address_english` = ?');
            updateParams.push(payload.address_english);
        }
        if (payload.address_hindi && (!existing.address_hindi || existing.address_hindi === 'Not Found' || payload.address_hindi.length > existing.address_hindi.length)) {
            updateClauses.push('`address_hindi` = ?');
            updateParams.push(payload.address_hindi);
        }
        if (shouldUpdateField(payload.pincode, payload.accuracy_pincode, existing.pincode, existing.accuracy_pincode)) {
            updateClauses.push('`pincode` = ?', '`accuracy_pincode` = ?');
            updateParams.push(payload.pincode, payload.accuracy_pincode);
        }

        // 10. Virtual ID
        if (payload.virtual_id && (!existing.virtual_id || existing.virtual_id === 'Not Found')) {
            updateClauses.push('`virtual_id` = ?');
            updateParams.push(payload.virtual_id);
        }

        // 11. Format exact merged JSON wrapper
        const mergedAadhaarNumber = (payload.aadhar_number && payload.aadhar_number !== 'Not Found' && !payload.aadhar_number.startsWith("DOC")) ? payload.aadhar_number : existing.aadhar_number;
        const mergedNameEng = payload.name_english || existing.name_english || "";
        const mergedNameHin = payload.name_hindi || existing.name_hindi || "";
        const mergedDob = payload.dob || existing.dob || "";
        const mergedGender = payload.gender_english || existing.gender_english || "";
        const mergedFatherEng = payload.father_name_english || existing.father_name_english || "";
        const mergedFatherHin = payload.father_name_hindi || existing.father_name_hindi || "";
        const mergedHusbandEng = payload.husband_name_english || existing.husband_name_english || "";
        const mergedHusbandHin = payload.husband_name_hindi || existing.husband_name_hindi || "";
        const mergedAddressEng = payload.address_english || existing.address_english || "";
        const mergedAddressHin = payload.address_hindi || existing.address_hindi || "";
        const mergedPincode = payload.pincode || existing.pincode || "";

        const finalMergedJsonObj = {
            "extracted_documents": [
                {
                    "party_type": "buyer",
                    "document_type": "aadhaar_card",
                    "detected_side": "both",
                    "aadhaar_card_data": {
                        "aadhaarNumber": mergedAadhaarNumber || "",
                        "fullName_English": mergedNameEng,
                        "fullName_Hindi": mergedNameHin,
                        "dob": mergedDob,
                        "gender": mergedGender,
                        "relation_status": payload.relation_status || existing.relation_status || "",
                        "fatherName_English": mergedFatherEng,
                        "fatherName_Hindi": mergedFatherHin,
                        "husbandName_English": mergedHusbandEng,
                        "husbandName_Hindi": mergedHusbandHin,
                        "fullAddress_English": mergedAddressEng,
                        "fullAddress_Hindi": mergedAddressHin,
                        "pincode": mergedPincode,
                        "pancard": "",
                        "aadhaarNumber_accuracy": 100,
                        "fullName_English_accuracy": 100,
                        "fullName_Hindi_accuracy": 100,
                        "dob_accuracy": 100,
                        "fatherName_Hindi_accuracy": 100,
                        "husbandName_Hindi_accuracy": 100,
                        "pincode_accuracy": 100
                    },
                    "aadhaar_card_data_accuracy": 100
                }
            ],
            "extraction_result": {
                "scan_quality_rating": 9,
                "cross_verification_done": true,
                "verification_result": "Information verified across Aadhaar card scans.",
                "low_accuracy_reason": "",
                "advice_rescan": "No",
                "source_page_number": 1
            },
            "extraction_accuracy": 100,
            "is_custom": true,
            "_display_name": "Aadhar Card"
        };

        updateClauses.push('`raw_json` = ?');
        updateParams.push(JSON.stringify(finalMergedJsonObj));

        // 12. Accumulate Tokens & Update Accuracy Rating
        const newTotalPrompt = (Number(existing.tokens_prompt) || 0) + (Number(payload.tokens_prompt) || 0);
        const newTotalCompletion = (Number(existing.tokens_completion) || 0) + (Number(payload.tokens_completion) || 0);
        const newTotalTokens = (Number(existing.tokens_total) || 0) + (Number(payload.tokens_total) || 0);
        const bestOverallAccuracy = Math.max(Number(existing.accuracy_overall) || 0, Number(payload.accuracy_overall) || 100);

        updateClauses.push('`tokens_prompt` = ?', '`tokens_completion` = ?', '`tokens_total` = ?', '`accuracy_overall` = ?', '`upload_id` = ?', '`updated_at` = ?');
        updateParams.push(newTotalPrompt, newTotalCompletion, newTotalTokens, bestOverallAccuracy, payload.upload_id || existing.upload_id, getISTNow());

        updateParams.push(existing.id);
        const updateSql = `
            UPDATE wh_aadhaar_card_records
            SET ${updateClauses.join(', ')}
            WHERE id = ?
        `;

        const sanitizedUpdateParams = updateParams.map(v => (v === undefined ? null : v));
        await pool.execute(updateSql, sanitizedUpdateParams);

        let mergedRecord = null;
        try {
            const [rows] = await pool.execute('SELECT * FROM wh_aadhaar_card_records WHERE id = ? LIMIT 1', [existing.id]);
            mergedRecord = rows[0] || null;
        } catch (e) {}

        const hasBoth = mergedRecord ? !!(mergedRecord.front_image_uri && mergedRecord.back_image_uri) : true;

        return {
            status: 'success',
            action: 'updated',
            recordId: existing.id,
            record: mergedRecord,
            side: hasBoth ? 'both' : (isFrontScan ? 'front' : 'back'),
            message: `Existing Aadhaar record ID #${existing.id} successfully updated with higher accuracy data.`
        };

    } catch (err) {
        console.error('❌ [documentDbService] Aadhaar DB Error:', err.message);
        throw err;
    }
}

let panCardTableChecked = false;
async function ensurePanCardTableExists() {
    if (panCardTableChecked) return;
    try {
        const createSql = `
            CREATE TABLE IF NOT EXISTS \`wh_pan_card_records\` (
                \`id\` INT AUTO_INCREMENT PRIMARY KEY,
                \`upload_id\` INT DEFAULT NULL COMMENT 'Reference to wh_uploads.id',
                \`reference_id\` INT DEFAULT NULL COMMENT 'External Reference ID e.g. 1234 from P-1234',
                \`pan_number\` VARCHAR(20) NOT NULL UNIQUE COMMENT '10-character Alphanumeric PAN',
                \`name\` VARCHAR(255) DEFAULT NULL,
                \`father_name\` VARCHAR(255) DEFAULT NULL,
                \`dob\` VARCHAR(20) DEFAULT NULL,
                \`sender_mobile\` VARCHAR(25) NOT NULL,
                \`receiver_mobile\` VARCHAR(25) NOT NULL,
                \`image_uri\` VARCHAR(500) DEFAULT NULL,
                \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX \`idx_reference_id\` (\`reference_id\`),
                INDEX \`idx_pan_number\` (\`pan_number\`),
                INDEX \`idx_sender_mobile\` (\`sender_mobile\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `;
        await pool.execute(createSql);

        const [cols] = await pool.execute(`SHOW COLUMNS FROM wh_pan_card_records`);
        const existingCols = cols.map(c => c.Field);
        if (!existingCols.includes('reference_id')) {
            await pool.execute(`ALTER TABLE wh_pan_card_records ADD COLUMN \`reference_id\` INT DEFAULT NULL`);
            console.log(`✅ [Database] Added missing column 'reference_id' to wh_pan_card_records`);
        }

        panCardTableChecked = true;
        console.log("✅ [Database] Checked/Created 'wh_pan_card_records' table");
    } catch (err) {
        console.warn("⚠️ [Database] PAN Card table check warning:", err.message);
    }
}

/**
 * Inserts or updates a PAN record in `wh_pan_card_records`
 */
async function insertOrUpdatePan({
    uploadId,
    referenceId,
    panNumber,
    name,
    fatherName,
    dob,
    senderMobile,
    receiverMobile,
    uploadUri
}) {
    await ensurePanCardTableExists();

    const cleanPan = sanitizeInput(panNumber);
    if (!cleanPan) {
        throw new Error("PAN Number is required for database operations.");
    }

    const parsedRefId = (referenceId !== undefined && referenceId !== null && !isNaN(parseInt(referenceId, 10))) 
        ? parseInt(referenceId, 10) 
        : null;

    const payload = {
        upload_id: uploadId || null,
        reference_id: parsedRefId,
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
            'SELECT * FROM wh_pan_card_records WHERE pan_number = ?',
            [payload.pan_number]
        );

        if (rows.length === 0) {
            const istNow = getISTNow();
            const insertSql = `
                INSERT INTO wh_pan_card_records (
                    upload_id, reference_id, pan_number, name, father_name, dob,
                    sender_mobile, receiver_mobile, image_uri,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            const params = [
                payload.upload_id,
                payload.reference_id,
                payload.pan_number,
                payload.name,
                payload.father_name,
                payload.dob,
                payload.sender_mobile,
                payload.receiver_mobile,
                payload.image_uri,
                istNow,
                istNow
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

            const fields = ['upload_id', 'reference_id', 'name', 'father_name', 'dob', 'sender_mobile', 'receiver_mobile', 'image_uri'];
            for (const f of fields) {
                if (payload[f] !== null) {
                    updateClauses.push(`${f} = ?`);
                    updateParams.push(payload[f]);
                }
            }

            if (updateClauses.length === 0) {
                return { status: 'success', action: 'none', recordId: rows[0].id, message: 'No new data.' };
            }

            updateClauses.push('`updated_at` = ?');
            updateParams.push(getISTNow());

            updateParams.push(payload.pan_number);
            const updateSql = `
                UPDATE wh_pan_card_records
                SET ${updateClauses.join(', ')}
                WHERE pan_number = ?
            `;
            await pool.execute(updateSql, updateParams);

            return {
                status: 'success',
                action: 'updated',
                recordId: rows[0].id,
                message: 'Existing PAN record updated.'
            };
        }
    } catch (err) {
        console.error('❌ [documentDbService] PAN DB Error:', err.message);
        throw err;
    }
}

let jamabandiTableChecked = false;
async function ensureJamabandiTableExists() {
    if (jamabandiTableChecked) return;
    try {
        const createSql = `
            CREATE TABLE IF NOT EXISTS \`wh_old_jamabandi_records\` (
                \`id\` INT AUTO_INCREMENT PRIMARY KEY,
                \`upload_id\` INT DEFAULT NULL COMMENT 'Reference to wh_uploads.id',
                \`reference_id\` INT DEFAULT NULL COMMENT 'External Reference ID e.g. 4750 from J-4750',
                \`form_name\` VARCHAR(255) DEFAULT NULL,
                \`document_type\` VARCHAR(255) DEFAULT NULL,
                \`village\` VARCHAR(255) DEFAULT NULL,
                \`patwar_halka\` VARCHAR(255) DEFAULT NULL,
                \`land_inspector_circle\` VARCHAR(255) DEFAULT NULL,
                \`tehsil\` VARCHAR(255) DEFAULT NULL,
                \`district\` VARCHAR(255) DEFAULT NULL,
                \`land_holder\` VARCHAR(255) DEFAULT NULL,
                \`samvat_period\` VARCHAR(255) DEFAULT NULL,
                \`area_unit\` VARCHAR(50) DEFAULT NULL,
                \`khata_no_new\` VARCHAR(50) DEFAULT NULL,
                \`khata_no_old\` VARCHAR(50) DEFAULT NULL,
                \`total_khasra_count\` INT DEFAULT 0,
                \`total_area\` VARCHAR(50) DEFAULT NULL,
                \`total_rent\` VARCHAR(50) DEFAULT NULL,
                \`khatedar_count\` INT DEFAULT 0,
                \`khatedar_details\` LONGTEXT DEFAULT NULL,
                \`khasra_details\` LONGTEXT DEFAULT NULL,
                \`raw_json\` LONGTEXT DEFAULT NULL,
                \`tokens_prompt\` INT DEFAULT 0,
                \`tokens_completion\` INT DEFAULT 0,
                \`tokens_total\` INT DEFAULT 0,
                \`ai_model\` VARCHAR(100) DEFAULT NULL,
                \`accuracy_overall\` INT DEFAULT 100,
                \`sender_mobile\` VARCHAR(25) NOT NULL,
                \`receiver_mobile\` VARCHAR(25) NOT NULL,
                \`document_uri\` VARCHAR(500) DEFAULT NULL,
                \`mime_type\` VARCHAR(50) DEFAULT 'image/jpeg',
                \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX \`idx_reference_id\` (\`reference_id\`),
                INDEX \`idx_village\` (\`village\`),
                INDEX \`idx_tehsil\` (\`tehsil\`),
                INDEX \`idx_district\` (\`district\`),
                INDEX \`idx_khata_new\` (\`khata_no_new\`),
                INDEX \`idx_sender_mobile\` (\`sender_mobile\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `;
        await pool.execute(createSql);

        const [cols] = await pool.execute(`SHOW COLUMNS FROM wh_old_jamabandi_records`);
        const existingCols = cols.map(c => c.Field);

        const requiredCols = [
            { name: 'upload_id', def: 'INT DEFAULT NULL' },
            { name: 'reference_id', def: 'INT DEFAULT NULL' },
            { name: 'form_name', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'document_type', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'village', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'patwar_halka', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'land_inspector_circle', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'tehsil', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'district', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'land_holder', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'samvat_period', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'area_unit', def: 'VARCHAR(50) DEFAULT NULL' },
            { name: 'khata_no_new', def: 'VARCHAR(50) DEFAULT NULL' },
            { name: 'khata_no_old', def: 'VARCHAR(50) DEFAULT NULL' },
            { name: 'total_khasra_count', def: 'INT DEFAULT 0' },
            { name: 'total_area', def: 'VARCHAR(50) DEFAULT NULL' },
            { name: 'total_rent', def: 'VARCHAR(50) DEFAULT NULL' },
            { name: 'khatedar_count', def: 'INT DEFAULT 0' },
            { name: 'khatedar_details', def: 'LONGTEXT DEFAULT NULL' },
            { name: 'khasra_details', def: 'LONGTEXT DEFAULT NULL' },
            { name: 'raw_json', def: 'LONGTEXT DEFAULT NULL' },
            { name: 'tokens_prompt', def: 'INT DEFAULT 0' },
            { name: 'tokens_completion', def: 'INT DEFAULT 0' },
            { name: 'tokens_total', def: 'INT DEFAULT 0' },
            { name: 'ai_model', def: 'VARCHAR(100) DEFAULT NULL' },
            { name: 'accuracy_overall', def: 'INT DEFAULT 100' },
            { name: 'sender_mobile', def: "VARCHAR(25) NOT NULL DEFAULT 'Unknown'" },
            { name: 'receiver_mobile', def: "VARCHAR(25) NOT NULL DEFAULT 'Unknown'" },
            { name: 'document_uri', def: 'VARCHAR(500) DEFAULT NULL' },
            { name: 'mime_type', def: "VARCHAR(50) DEFAULT 'image/jpeg'" }
        ];

        for (const col of requiredCols) {
            if (!existingCols.includes(col.name)) {
                await pool.execute(`ALTER TABLE wh_old_jamabandi_records ADD COLUMN \`${col.name}\` ${col.def}`);
                console.log(`✅ [Database] Added missing column '${col.name}' to wh_old_jamabandi_records`);
            }
        }

        jamabandiTableChecked = true;
        console.log("✅ [Database] Checked/Migrated 'wh_old_jamabandi_records' table");
    } catch (err) {
        console.warn("⚠️ [Database] Jamabandi table check warning:", err.message);
    }
}

/**
 * Inserts structured Rajasthan Jamabandi records into wh_old_jamabandi_records
 */
async function insertJamabandiRecord({
    uploadId,
    referenceId,
    formName,
    documentType,
    village,
    patwarHalka,
    landInspectorCircle,
    tehsil,
    district,
    landHolder,
    samvatPeriod,
    areaUnit,
    khataNoNew,
    khataNoOld,
    totalKhasraCount,
    totalArea,
    totalRent,
    khatedarDetails,
    khasraDetails,
    rawJson,
    tokensPrompt,
    tokensCompletion,
    tokensTotal,
    aiModel,
    accuracyOverall,
    senderMobile,
    receiverMobile,
    documentUri,
    mimeType
}) {
    await ensureJamabandiTableExists();

    const khatedarArray = Array.isArray(khatedarDetails) ? khatedarDetails : [];
    const khasraArray = Array.isArray(khasraDetails) ? khasraDetails : [];

    const parsedRefId = (referenceId !== undefined && referenceId !== null && !isNaN(parseInt(referenceId, 10))) 
        ? parseInt(referenceId, 10) 
        : null;

    const istNow = getISTNow();
    const insertSql = `
        INSERT INTO wh_old_jamabandi_records (
            upload_id, reference_id, form_name, document_type, village, patwar_halka,
            land_inspector_circle, tehsil, district, land_holder, samvat_period,
            area_unit, khata_no_new, khata_no_old, total_khasra_count, total_area,
            total_rent, khatedar_count, khatedar_details, khasra_details, raw_json,
            tokens_prompt, tokens_completion, tokens_total, ai_model, accuracy_overall,
            sender_mobile, receiver_mobile, document_uri, mime_type,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
        uploadId || null,
        parsedRefId,
        sanitizeInput(formName),
        sanitizeInput(documentType),
        sanitizeInput(village),
        sanitizeInput(patwarHalka),
        sanitizeInput(landInspectorCircle),
        sanitizeInput(tehsil),
        sanitizeInput(district),
        sanitizeInput(landHolder),
        sanitizeInput(samvatPeriod),
        sanitizeInput(areaUnit),
        sanitizeInput(khataNoNew),
        sanitizeInput(khataNoOld),
        typeof totalKhasraCount === 'number' ? totalKhasraCount : (khasraArray.length || 0),
        sanitizeInput(totalArea),
        sanitizeInput(totalRent),
        khatedarArray.length,
        JSON.stringify(khatedarArray),
        JSON.stringify(khasraArray),
        typeof rawJson === 'object' ? JSON.stringify(rawJson) : sanitizeInput(rawJson),
        typeof tokensPrompt === 'number' ? tokensPrompt : 0,
        typeof tokensCompletion === 'number' ? tokensCompletion : 0,
        typeof tokensTotal === 'number' ? tokensTotal : 0,
        sanitizeInput(aiModel) || 'gemini-3.1-flash',
        typeof accuracyOverall === 'number' ? accuracyOverall : 100,
        sanitizeInput(senderMobile) || 'Unknown',
        sanitizeInput(receiverMobile) || 'Unknown',
        sanitizeInput(documentUri),
        sanitizeInput(mimeType) || 'image/jpeg',
        istNow,
        istNow
    ];

    const [result] = await pool.execute(insertSql, params);

    return {
        status: 'success',
        action: 'inserted',
        recordId: result.insertId,
        message: 'New Jamabandi record created.'
    };
}

let saleDeedTableChecked = false;
async function ensureSaleDeedTableExists() {
    if (saleDeedTableChecked) return;
    try {
        const createSql = `
            CREATE TABLE IF NOT EXISTS \`wh_sale_deed_records\` (
                \`id\` INT AUTO_INCREMENT PRIMARY KEY,
                \`upload_id\` INT DEFAULT NULL COMMENT 'Reference to wh_uploads.id',
                \`reference_id\` INT DEFAULT NULL COMMENT 'External Reference ID e.g. 5552 from S-5552',
                \`document_type\` VARCHAR(255) DEFAULT NULL,
                \`deed_number\` VARCHAR(100) DEFAULT NULL,
                \`registration_date\` VARCHAR(50) DEFAULT NULL,
                \`sub_registrar_office\` VARCHAR(255) DEFAULT NULL,
                \`transaction_type\` VARCHAR(255) DEFAULT NULL,
                \`property_type\` VARCHAR(100) DEFAULT NULL,
                \`plot_number\` VARCHAR(100) DEFAULT NULL,
                \`khasra_number\` VARCHAR(100) DEFAULT NULL,
                \`village\` VARCHAR(255) DEFAULT NULL,
                \`tehsil\` VARCHAR(255) DEFAULT NULL,
                \`district\` VARCHAR(255) DEFAULT NULL,
                \`area_front\` VARCHAR(50) DEFAULT NULL,
                \`area_depth\` VARCHAR(50) DEFAULT NULL,
                \`total_area_sqft\` VARCHAR(100) DEFAULT NULL,
                \`rakba\` VARCHAR(100) DEFAULT NULL,
                \`boundaries\` LONGTEXT DEFAULT NULL,
                \`sale_amount\` DECIMAL(15,2) DEFAULT NULL,
                \`market_value\` DECIMAL(15,2) DEFAULT NULL,
                \`payment_mode\` VARCHAR(100) DEFAULT NULL,
                \`cheque_number\` VARCHAR(100) DEFAULT NULL,
                \`cheque_date\` VARCHAR(50) DEFAULT NULL,
                \`seller_name\` VARCHAR(255) DEFAULT NULL,
                \`seller_relationship\` VARCHAR(100) DEFAULT NULL,
                \`seller_spouse_name\` VARCHAR(255) DEFAULT NULL,
                \`seller_age\` INT DEFAULT NULL,
                \`seller_category\` VARCHAR(100) DEFAULT NULL,
                \`seller_address\` LONGTEXT DEFAULT NULL,
                \`buyer_name\` VARCHAR(255) DEFAULT NULL,
                \`buyer_relationship\` VARCHAR(100) DEFAULT NULL,
                \`buyer_spouse_name\` VARCHAR(255) DEFAULT NULL,
                \`buyer_age\` INT DEFAULT NULL,
                \`buyer_aadhaar_number\` VARCHAR(50) DEFAULT NULL,
                \`buyer_category\` VARCHAR(100) DEFAULT NULL,
                \`buyer_address\` LONGTEXT DEFAULT NULL,
                \`previous_title\` LONGTEXT DEFAULT NULL,
                \`raw_json\` LONGTEXT DEFAULT NULL,
                \`tokens_prompt\` INT DEFAULT 0,
                \`tokens_completion\` INT DEFAULT 0,
                \`tokens_total\` INT DEFAULT 0,
                \`ai_model\` VARCHAR(100) DEFAULT NULL,
                \`accuracy_overall\` INT DEFAULT 100,
                \`sender_mobile\` VARCHAR(25) NOT NULL,
                \`receiver_mobile\` VARCHAR(25) NOT NULL,
                \`document_uri\` VARCHAR(500) DEFAULT NULL,
                \`mime_type\` VARCHAR(50) DEFAULT 'image/jpeg',
                \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX \`idx_reference_id\` (\`reference_id\`),
                INDEX \`idx_deed_number\` (\`deed_number\`),
                INDEX \`idx_village\` (\`village\`),
                INDEX \`idx_tehsil\` (\`tehsil\`),
                INDEX \`idx_district\` (\`district\`),
                INDEX \`idx_sender_mobile\` (\`sender_mobile\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `;
        await pool.execute(createSql);

        const [cols] = await pool.execute(`SHOW COLUMNS FROM wh_sale_deed_records`);
        const existingCols = cols.map(c => c.Field);

        const requiredCols = [
            { name: 'upload_id', def: 'INT DEFAULT NULL' },
            { name: 'reference_id', def: 'INT DEFAULT NULL' },
            { name: 'document_type', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'deed_number', def: 'VARCHAR(100) DEFAULT NULL' },
            { name: 'registration_date', def: 'VARCHAR(50) DEFAULT NULL' },
            { name: 'sub_registrar_office', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'transaction_type', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'property_type', def: 'VARCHAR(100) DEFAULT NULL' },
            { name: 'plot_number', def: 'VARCHAR(100) DEFAULT NULL' },
            { name: 'khasra_number', def: 'VARCHAR(100) DEFAULT NULL' },
            { name: 'village', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'tehsil', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'district', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'area_front', def: 'VARCHAR(50) DEFAULT NULL' },
            { name: 'area_depth', def: 'VARCHAR(50) DEFAULT NULL' },
            { name: 'total_area_sqft', def: 'VARCHAR(100) DEFAULT NULL' },
            { name: 'rakba', def: 'VARCHAR(100) DEFAULT NULL' },
            { name: 'boundaries', def: 'LONGTEXT DEFAULT NULL' },
            { name: 'sale_amount', def: 'DECIMAL(15,2) DEFAULT NULL' },
            { name: 'market_value', def: 'DECIMAL(15,2) DEFAULT NULL' },
            { name: 'payment_mode', def: 'VARCHAR(100) DEFAULT NULL' },
            { name: 'cheque_number', def: 'VARCHAR(100) DEFAULT NULL' },
            { name: 'cheque_date', def: 'VARCHAR(50) DEFAULT NULL' },
            { name: 'seller_name', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'seller_relationship', def: 'VARCHAR(100) DEFAULT NULL' },
            { name: 'seller_spouse_name', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'seller_age', def: 'INT DEFAULT NULL' },
            { name: 'seller_category', def: 'VARCHAR(100) DEFAULT NULL' },
            { name: 'seller_address', def: 'LONGTEXT DEFAULT NULL' },
            { name: 'buyer_name', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'buyer_relationship', def: 'VARCHAR(100) DEFAULT NULL' },
            { name: 'buyer_spouse_name', def: 'VARCHAR(255) DEFAULT NULL' },
            { name: 'buyer_age', def: 'INT DEFAULT NULL' },
            { name: 'buyer_aadhaar_number', def: 'VARCHAR(50) DEFAULT NULL' },
            { name: 'buyer_category', def: 'VARCHAR(100) DEFAULT NULL' },
            { name: 'buyer_address', def: 'LONGTEXT DEFAULT NULL' },
            { name: 'previous_title', def: 'LONGTEXT DEFAULT NULL' },
            { name: 'raw_json', def: 'LONGTEXT DEFAULT NULL' },
            { name: 'tokens_prompt', def: 'INT DEFAULT 0' },
            { name: 'tokens_completion', def: 'INT DEFAULT 0' },
            { name: 'tokens_total', def: 'INT DEFAULT 0' },
            { name: 'ai_model', def: 'VARCHAR(100) DEFAULT NULL' },
            { name: 'accuracy_overall', def: 'INT DEFAULT 100' },
            { name: 'sender_mobile', def: "VARCHAR(25) NOT NULL DEFAULT 'Unknown'" },
            { name: 'receiver_mobile', def: "VARCHAR(25) NOT NULL DEFAULT 'Unknown'" },
            { name: 'document_uri', def: 'VARCHAR(500) DEFAULT NULL' },
            { name: 'mime_type', def: "VARCHAR(50) DEFAULT 'image/jpeg'" }
        ];

        for (const col of requiredCols) {
            if (!existingCols.includes(col.name)) {
                await pool.execute(`ALTER TABLE wh_sale_deed_records ADD COLUMN \`${col.name}\` ${col.def}`);
                console.log(`✅ [Database] Added missing column '${col.name}' to wh_sale_deed_records`);
            }
        }

        saleDeedTableChecked = true;
        console.log("✅ [Database] Checked/Migrated 'wh_sale_deed_records' table");
    } catch (err) {
        console.warn("⚠️ [Database] Sale Deed table check warning:", err.message);
    }
}

/**
 * Inserts structured Sale Deed records into wh_sale_deed_records
 */
async function insertSaleDeedRecord({
    uploadId,
    referenceId,
    documentType,
    deedNumber,
    registrationDate,
    subRegistrarOffice,
    transactionType,
    propertyType,
    plotNumber,
    khasraNumber,
    village,
    tehsil,
    district,
    areaFront,
    areaDepth,
    totalAreaSqft,
    rakba,
    boundaries,
    saleAmount,
    marketValue,
    paymentMode,
    chequeNumber,
    chequeDate,
    sellerName,
    sellerRelationship,
    sellerSpouseName,
    sellerAge,
    sellerCategory,
    sellerAddress,
    buyerName,
    buyerRelationship,
    buyerSpouseName,
    buyerAge,
    buyerAadhaarNumber,
    buyerCategory,
    buyerAddress,
    previousTitle,
    rawJson,
    tokensPrompt,
    tokensCompletion,
    tokensTotal,
    aiModel,
    accuracyOverall,
    senderMobile,
    receiverMobile,
    documentUri,
    mimeType
}) {
    await ensureSaleDeedTableExists();

    const parsedRefId = (referenceId !== undefined && referenceId !== null && !isNaN(parseInt(referenceId, 10))) 
        ? parseInt(referenceId, 10) 
        : null;

    const istNow = getISTNow();
    const insertSql = `
        INSERT INTO wh_sale_deed_records (
            upload_id, reference_id, document_type, deed_number, registration_date, sub_registrar_office,
            transaction_type, property_type, plot_number, khasra_number, village,
            tehsil, district, area_front, area_depth, total_area_sqft, rakba,
            boundaries, sale_amount, market_value, payment_mode, cheque_number,
            cheque_date, seller_name, seller_relationship, seller_spouse_name,
            seller_age, seller_category, seller_address, buyer_name,
            buyer_relationship, buyer_spouse_name, buyer_age, buyer_aadhaar_number,
            buyer_category, buyer_address, previous_title, raw_json,
            tokens_prompt, tokens_completion, tokens_total, ai_model, accuracy_overall,
            sender_mobile, receiver_mobile, document_uri, mime_type,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
        uploadId || null,
        parsedRefId,
        sanitizeInput(documentType),
        sanitizeInput(deedNumber),
        sanitizeInput(registrationDate),
        sanitizeInput(subRegistrarOffice),
        sanitizeInput(transactionType),
        sanitizeInput(propertyType),
        sanitizeInput(plotNumber),
        sanitizeInput(khasraNumber),
        sanitizeInput(village),
        sanitizeInput(tehsil),
        sanitizeInput(district),
        sanitizeInput(areaFront),
        sanitizeInput(areaDepth),
        sanitizeInput(totalAreaSqft),
        sanitizeInput(rakba),
        typeof boundaries === 'object' ? JSON.stringify(boundaries) : sanitizeInput(boundaries),
        typeof saleAmount === 'number' ? saleAmount : (parseFloat(saleAmount) || null),
        typeof marketValue === 'number' ? marketValue : (parseFloat(marketValue) || null),
        sanitizeInput(paymentMode),
        sanitizeInput(chequeNumber),
        sanitizeInput(chequeDate),
        sanitizeInput(sellerName),
        sanitizeInput(sellerRelationship),
        sanitizeInput(sellerSpouseName),
        typeof sellerAge === 'number' ? sellerAge : (parseInt(sellerAge, 10) || null),
        sanitizeInput(sellerCategory),
        typeof sellerAddress === 'object' ? JSON.stringify(sellerAddress) : sanitizeInput(sellerAddress),
        sanitizeInput(buyerName),
        sanitizeInput(buyerRelationship),
        sanitizeInput(buyerSpouseName),
        typeof buyerAge === 'number' ? buyerAge : (parseInt(buyerAge, 10) || null),
        sanitizeInput(buyerAadhaarNumber),
        sanitizeInput(buyerCategory),
        typeof buyerAddress === 'object' ? JSON.stringify(buyerAddress) : sanitizeInput(buyerAddress),
        typeof previousTitle === 'object' ? JSON.stringify(previousTitle) : sanitizeInput(previousTitle),
        typeof rawJson === 'object' ? JSON.stringify(rawJson) : sanitizeInput(rawJson),
        typeof tokensPrompt === 'number' ? tokensPrompt : 0,
        typeof tokensCompletion === 'number' ? tokensCompletion : 0,
        typeof tokensTotal === 'number' ? tokensTotal : 0,
        sanitizeInput(aiModel) || 'gemini-3.1-flash',
        typeof accuracyOverall === 'number' ? accuracyOverall : 100,
        sanitizeInput(senderMobile) || 'Unknown',
        sanitizeInput(receiverMobile) || 'Unknown',
        sanitizeInput(documentUri),
        sanitizeInput(mimeType) || 'image/jpeg',
        istNow,
        istNow
    ];

    const [result] = await pool.execute(insertSql, params);

    return {
        status: 'success',
        action: 'inserted',
        recordId: result.insertId,
        message: 'New Sale Deed record created.'
    };
}

// ---------------------------------------------------------
// MULTI-BOT SESSIONS & ACCESS CONTROL (WHITELIST)
// ---------------------------------------------------------

let allowedUsersCache = null;
let lastAllowedUsersFetch = 0;
const ALLOWED_USERS_CACHE_TTL = 30000; // 30 seconds

let botTablesChecked = false;
async function ensureBotManagementTablesExist() {
    if (botTablesChecked) return;
    try {
        // 1. wh_bot_instances
        const createBotInstancesSql = `
            CREATE TABLE IF NOT EXISTS \`wh_bot_instances\` (
                \`session_id\` VARCHAR(50) NOT NULL PRIMARY KEY COMMENT 'Unique session identifier',
                \`phone_number\` VARCHAR(25) DEFAULT NULL COMMENT 'WhatsApp phone number',
                \`bot_name\` VARCHAR(100) NOT NULL COMMENT 'Display label',
                \`menu_type\` VARCHAR(50) NOT NULL DEFAULT 'DOCUMENT_OCR' COMMENT 'DOCUMENT_OCR, CUSTOM_MENU, etc.',
                \`is_active\` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1=Active, 0=Disabled',
                \`connection_status\` VARCHAR(50) NOT NULL DEFAULT 'initializing',
                \`last_connected_at\` TIMESTAMP NULL DEFAULT NULL,
                \`last_qr_at\` TIMESTAMP NULL DEFAULT NULL,
                \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX \`idx_is_active\` (\`is_active\`),
                INDEX \`idx_phone_number\` (\`phone_number\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `;
        await pool.execute(createBotInstancesSql);

        // Seed default bots if table empty
        const [botRows] = await pool.execute(`SELECT COUNT(*) as cnt FROM wh_bot_instances`);
        if (botRows[0].cnt === 0) {
            await pool.execute(`
                INSERT INTO wh_bot_instances (session_id, phone_number, bot_name, menu_type, is_active)
                VALUES 
                ('bot_9610238234', '9610238234', 'Primary Registry OCR Scanner (9610238234)', 'DOCUMENT_OCR', 1),
                ('bot_9079377715', '9079377715', 'Secondary Bot (9079377715)', 'CUSTOM_MENU', 1)
            `);
            console.log("✅ [Database] Seeded initial bot instances in 'wh_bot_instances'");
        }

        // 2. wh_allowed_users
        const createAllowedUsersSql = `
            CREATE TABLE IF NOT EXISTS \`wh_allowed_users\` (
                \`id\` INT AUTO_INCREMENT PRIMARY KEY,
                \`mobile_number\` VARCHAR(25) NOT NULL UNIQUE COMMENT 'Sender mobile number',
                \`user_name\` VARCHAR(100) DEFAULT NULL COMMENT 'Name / Role',
                \`bot_session_id\` VARCHAR(50) NOT NULL DEFAULT 'all' COMMENT 'Allowed bot session or "all"',
                \`allowed_features\` VARCHAR(255) NOT NULL DEFAULT 'all' COMMENT 'Allowed features e.g. "all", "ocr", "custom"',
                \`is_active\` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1=Allowed, 0=Blocked',
                \`notes\` TEXT DEFAULT NULL,
                \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX \`idx_mobile_number\` (\`mobile_number\`),
                INDEX \`idx_bot_session\` (\`bot_session_id\`),
                INDEX \`idx_is_active\` (\`is_active\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `;
        await pool.execute(createAllowedUsersSql);

        // Seed default allowed numbers if empty
        const [userRows] = await pool.execute(`SELECT COUNT(*) as cnt FROM wh_allowed_users`);
        if (userRows[0].cnt === 0) {
            await pool.execute(`
                INSERT INTO wh_allowed_users (mobile_number, user_name, bot_session_id, allowed_features, is_active, notes)
                VALUES 
                ('919079377715', 'Akhilesh Mishra (Admin)', 'all', 'all', 1, 'Master Administrator'),
                ('919610238234', 'Registry Scanner Operator', 'all', 'all', 1, 'OCR Scanner Operator')
            `);
            console.log("✅ [Database] Seeded default authorized numbers in 'wh_allowed_users'");
        }

        // 3. wh_baileys_auth session_id migration
        try {
            await pool.execute(`
                CREATE TABLE IF NOT EXISTS \`wh_baileys_auth\` (
                    \`session_id\` VARCHAR(50) NOT NULL DEFAULT 'default',
                    \`id\` VARCHAR(255) NOT NULL,
                    \`value\` LONGTEXT,
                    PRIMARY KEY (\`session_id\`, \`id\`)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
            `);

            const [authCols] = await pool.execute(`SHOW COLUMNS FROM wh_baileys_auth`);
            const colNames = authCols.map(c => c.Field);
            if (!colNames.includes('session_id')) {
                console.log("🔄 [Database] Migrating wh_baileys_auth to multi-session composite primary key...");
                await pool.execute(`ALTER TABLE wh_baileys_auth ADD COLUMN \`session_id\` VARCHAR(50) NOT NULL DEFAULT 'default' FIRST`);
                await pool.execute(`ALTER TABLE wh_baileys_auth DROP PRIMARY KEY, ADD PRIMARY KEY (\`session_id\`, \`id\`)`);
                console.log("✅ [Database] wh_baileys_auth migrated successfully!");
            }
        } catch (authMigrateErr) {
            console.warn("⚠️ [Database] wh_baileys_auth check notice:", authMigrateErr.message);
        }

        botTablesChecked = true;
        console.log("✅ [Database] Checked/Migrated Bot Instances & Access Control Tables");
    } catch (err) {
        console.warn("⚠️ [Database] Bot management tables check warning:", err.message);
    }
}

/**
 * Normalizes phone numbers for comparison
 */
function getPhoneVariants(phone) {
    if (!phone) return [];
    const clean = String(phone).replace(/[^0-9]/g, '');
    const variants = new Set();
    if (clean) variants.add(clean);
    if (clean.startsWith('91') && clean.length === 12) {
        variants.add(clean.slice(2)); // 10-digit
    } else if (clean.length === 10) {
        variants.add(`91${clean}`); // 12-digit with 91
    }
    return Array.from(variants);
}

/**
 * Checks if a sender mobile number is authorized in wh_allowed_users
 */
async function isSenderAllowed(senderMobile, sessionId = 'all') {
    await ensureBotManagementTablesExist();

    if (!senderMobile || senderMobile === "Unknown") {
        return { allowed: false, user: null, reason: "Could not resolve sender mobile number." };
    }

    const now = Date.now();
    if (!allowedUsersCache || (now - lastAllowedUsersFetch > ALLOWED_USERS_CACHE_TTL)) {
        try {
            const [rows] = await pool.execute(
                `SELECT mobile_number, user_name, bot_session_id, allowed_features, is_active FROM wh_allowed_users`
            );
            allowedUsersCache = rows;
            lastAllowedUsersFetch = now;
        } catch (err) {
            console.error("❌ [AccessControl] Failed to fetch wh_allowed_users:", err.message);
            if (!allowedUsersCache) return { allowed: true, user: null };
        }
    }

    if (!allowedUsersCache || allowedUsersCache.length === 0) {
        return { allowed: true, user: null };
    }

    let variants = getPhoneVariants(senderMobile);

    // If senderMobile is a WhatsApp LID (digits > 13 not matching regular phone), try resolving from wh_baileys_auth
    if (senderMobile.length > 13 && !senderMobile.startsWith('91')) {
        try {
            // Check if LID is directly mapped in wh_baileys_auth to an allowed number
            const [authRows] = await pool.execute(
                `SELECT value FROM wh_baileys_auth WHERE value LIKE ? LIMIT 10`,
                [`%${senderMobile}%`]
            );
            for (const r of authRows) {
                const strVal = typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
                const jidMatch = strVal.match(/(\d{10,14})@s\.whatsapp\.net/);
                if (jidMatch && jidMatch[1]) {
                    const resolvedVariants = getPhoneVariants(jidMatch[1]);
                    variants = variants.concat(resolvedVariants);
                }
            }
        } catch (lidErr) {
            console.warn("⚠️ [AccessControl] LID search notice:", lidErr.message);
        }
    }

    // Check if the number matches any bot instance itself
    try {
        const [botRows] = await pool.execute(
            `SELECT phone_number FROM wh_bot_instances WHERE is_active = 1`
        );
        for (const b of botRows) {
            if (b.phone_number) {
                const bVariants = getPhoneVariants(b.phone_number);
                if (variants.some(v => bVariants.includes(v))) {
                    return {
                        allowed: true,
                        user: { user_name: 'Bot Owner / Operator', mobile_number: b.phone_number }
                    };
                }
            }
        }
    } catch (botErr) {
        // ignore
    }

    const match = allowedUsersCache.find(u => {
        const uVariants = getPhoneVariants(u.mobile_number);
        return variants.some(v => uVariants.includes(v));
    });

    if (!match) {
        return {
            allowed: false,
            user: null,
            reason: 'Number is not registered in authorized users whitelist.'
        };
    }

    if (Number(match.is_active) !== 1) {
        return {
            allowed: false,
            user: match,
            reason: 'User account is currently suspended/blocked.'
        };
    }

    const isSessionMatch = !match.bot_session_id || 
                           match.bot_session_id === 'all' || 
                           sessionId === 'all' || 
                           match.bot_session_id === sessionId ||
                           sessionId.includes(match.bot_session_id) ||
                           match.bot_session_id.includes(sessionId);

    if (!isSessionMatch) {
        return {
            allowed: false,
            user: match,
            reason: `User is authorized only for bot ${match.bot_session_id}.`
        };
    }

    return {
        allowed: true,
        user: match
    };
}

/**
 * Returns all active bot instances from wh_bot_instances
 */
async function getActiveBotInstances() {
    await ensureBotManagementTablesExist();
    try {
        const [rows] = await pool.execute(
            `SELECT * FROM wh_bot_instances WHERE is_active = 1 ORDER BY created_at ASC`
        );
        return rows;
    } catch (err) {
        console.error("❌ [Database] Failed to get active bot instances:", err.message);
        return [];
    }
}

/**
 * Returns all allowed users for dashboard/diagnostics
 */
async function getAllowedUsersList() {
    await ensureBotManagementTablesExist();
    try {
        const [rows] = await pool.execute(
            `SELECT id, mobile_number, user_name, bot_session_id, allowed_features, is_active, notes, created_at, updated_at FROM wh_allowed_users ORDER BY id ASC`
        );
        return rows;
    } catch (err) {
        console.error("❌ [Database] Failed to get allowed users:", err.message);
        return [];
    }
}

/**
 * Updates bot instance status in database
 */
async function updateBotStatus(sessionId, { status, phoneNumber, lastConnectedAt, lastQrAt }) {
    await ensureBotManagementTablesExist();
    try {
        const updates = [];
        const params = [];
        const istNow = getISTNow();

        if (status !== undefined) {
            updates.push('`connection_status` = ?');
            params.push(status);
        }
        if (phoneNumber !== undefined) {
            updates.push('`phone_number` = ?');
            params.push(phoneNumber);
        }
        if (lastConnectedAt !== undefined) {
            updates.push('`last_connected_at` = ?');
            params.push(istNow);
        }
        if (lastQrAt !== undefined) {
            updates.push('`last_qr_at` = ?');
            params.push(istNow);
        }

        if (updates.length === 0) return;

        updates.push('`updated_at` = ?');
        params.push(istNow);

        params.push(sessionId);
        await pool.execute(
            `UPDATE wh_bot_instances SET ${updates.join(', ')} WHERE session_id = ?`,
            params
        );
    } catch (err) {
        console.warn(`⚠️ [Database] Failed to update status for bot ${sessionId}:`, err.message);
    }
}

module.exports = {
    logImageUpload,
    insertOrUpdateAadhaar,
    insertOrUpdatePan,
    insertJamabandiRecord,
    insertSaleDeedRecord,
    ensureBotManagementTablesExist,
    isSenderAllowed,
    getActiveBotInstances,
    getAllowedUsersList,
    updateBotStatus
};

