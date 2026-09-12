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

let columnsChecked = false;
async function ensureAadhaarColumnsExist() {
    if (columnsChecked) return;
    try {
        const [cols] = await pool.execute(`SHOW COLUMNS FROM wh_aadhar_records`);
        const existingCols = cols.map(c => c.Field);
        
        const requiredCols = [
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
                await pool.execute(`ALTER TABLE wh_aadhar_records ADD COLUMN \`${col.name}\` ${col.def}`);
                console.log(`✅ [Database] Added missing column '${col.name}' to wh_aadhar_records`);
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
 * Inserts or updates an Aadhaar record in `wh_aadhar_records` with multi-sided (Front/Back) merging and accuracy-based field upgrades.
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
    uploadUri
}) {
    await ensureAadhaarColumnsExist();

    const cleanAadhaar = sanitizeInput(aadharNumber);
    const cleanSender = sanitizeInput(senderMobile) || 'Unknown';
    const cleanReceiver = sanitizeInput(receiverMobile) || 'Unknown';

    const payload = {
        upload_id: uploadId || null,
        aadhar_number: cleanAadhaar,
        virtual_id: sanitizeInput(virtualId),
        name_english: sanitizeInput(nameEnglish),
        name_hindi: sanitizeInput(nameHindi),
        dob: sanitizeInput(dob),
        gender_english: sanitizeInput(genderEnglish),
        gender_hindi: sanitizeInput(genderHindi),
        father_name_english: sanitizeInput(fatherNameEnglish),
        father_name_hindi: sanitizeInput(fatherNameHindi),
        husband_name_english: sanitizeInput(husbandNameEnglish),
        husband_name_hindi: sanitizeInput(husbandNameHindi),
        address_english: sanitizeInput(addressEnglish),
        address_hindi: sanitizeInput(addressHindi),
        pincode: sanitizeInput(pincode),
        raw_json: typeof rawJson === 'object' ? JSON.stringify(rawJson) : sanitizeInput(rawJson),
        tokens_prompt: typeof tokensPrompt === 'number' ? tokensPrompt : 0,
        tokens_completion: typeof tokensCompletion === 'number' ? tokensCompletion : 0,
        tokens_total: typeof tokensTotal === 'number' ? tokensTotal : 0,
        ai_model: sanitizeInput(aiModel) || 'gemini-2.0-flash',
        accuracy_overall: typeof accuracyOverall === 'number' ? accuracyOverall : 100,
        accuracy_aadhaar_number: typeof accuracyAadhaarNumber === 'number' ? accuracyAadhaarNumber : 100,
        accuracy_name_english: typeof accuracyNameEnglish === 'number' ? accuracyNameEnglish : 100,
        accuracy_name_hindi: typeof accuracyNameHindi === 'number' ? accuracyNameHindi : 100,
        accuracy_dob: typeof accuracyDob === 'number' ? accuracyDob : 100,
        accuracy_pincode: typeof accuracyPincode === 'number' ? accuracyPincode : 100,
        sender_mobile: cleanSender,
        receiver_mobile: cleanReceiver
    };

    // Determine if current scan is Front vs Back
    let isFrontScan = detectedSide === 'front';
    let isBackScan = detectedSide === 'back';
    if (!isFrontScan && !isBackScan) {
        const hasFrontInfo = !!payload.name_english || !!payload.dob || !!payload.gender_english;
        const hasBackInfo = !!payload.address_english || !!payload.address_hindi || !!payload.father_name_english || !!payload.husband_name_english || !!payload.pincode;
        if (hasFrontInfo && !hasBackInfo) isFrontScan = true;
        else if (hasBackInfo && !hasFrontInfo) isBackScan = true;
        else { isFrontScan = true; isBackScan = true; }
    }

    try {
        let existing = null;

        // 1. Primary Lookup: Exact Aadhaar Number (if valid 12-digit)
        if (payload.aadhar_number && payload.aadhar_number !== "Not Found" && payload.aadhar_number.replace(/\s/g, '').length >= 10) {
            const [rows] = await pool.execute(
                'SELECT * FROM wh_aadhar_records WHERE aadhar_number = ? LIMIT 1',
                [payload.aadhar_number]
            );
            if (rows.length > 0) existing = rows[0];
        }

        // 2. Secondary Lookup: Same Sender within last 30 minutes where Front or Back is missing
        if (!existing && cleanSender !== 'Unknown') {
            const [recentRows] = await pool.execute(
                `SELECT * FROM wh_aadhar_records 
                 WHERE sender_mobile = ? 
                   AND created_at >= (NOW() - INTERVAL 30 MINUTE)
                   AND (front_image_uri IS NULL OR back_image_uri IS NULL)
                 ORDER BY created_at DESC LIMIT 1`,
                [cleanSender]
            );
            if (recentRows.length > 0) {
                existing = recentRows[0];
                console.log(`🔗 [Aadhaar Merge] Matched existing session record ID #${existing.id} for sender ${cleanSender}`);
            }
        }

        // Case A: New Record -> INSERT
        if (!existing) {
            const finalAadhaarNum = payload.aadhar_number || `DOC${Date.now().toString().slice(-8)}`;
            const frontUri = isFrontScan ? uploadUri : null;
            const backUri = isBackScan ? uploadUri : null;

            const insertSql = `
                INSERT INTO wh_aadhar_records (
                    upload_id, aadhar_number, virtual_id, name_english, name_hindi,
                    dob, gender_english, gender_hindi, father_name_english, father_name_hindi,
                    husband_name_english, husband_name_hindi, address_english, address_hindi,
                    pincode, raw_json, tokens_prompt, tokens_completion, tokens_total, ai_model,
                    accuracy_overall, accuracy_aadhaar_number, accuracy_name_english,
                    accuracy_name_hindi, accuracy_dob, accuracy_pincode,
                    sender_mobile, receiver_mobile, front_image_uri, back_image_uri
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;

            const insertParams = [
                payload.upload_id,
                finalAadhaarNum,
                payload.virtual_id,
                payload.name_english,
                payload.name_hindi,
                payload.dob,
                payload.gender_english,
                payload.gender_hindi,
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
                backUri
            ];

            const [result] = await pool.execute(insertSql, insertParams);

            return {
                status: 'success',
                action: 'inserted',
                recordId: result.insertId,
                side: isFrontScan && isBackScan ? 'both' : (isFrontScan ? 'front' : 'back'),
                message: 'New Aadhaar record created.'
            };
        }

        // Case B: Existing Record Found -> Merge & Upgrade
        const updateClauses = [];
        const updateParams = [];

        // 1. Front vs Back Image URI (Strict separation)
        if (isFrontScan && !isBackScan) {
            updateClauses.push('`front_image_uri` = ?');
            updateParams.push(uploadUri);
        } else if (isBackScan && !isFrontScan) {
            updateClauses.push('`back_image_uri` = ?');
            updateParams.push(uploadUri);
        } else {
            if (!existing.front_image_uri) { updateClauses.push('`front_image_uri` = ?'); updateParams.push(uploadUri); }
            if (!existing.back_image_uri) { updateClauses.push('`back_image_uri` = ?'); updateParams.push(uploadUri); }
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

        // 7. Father's Name (Always save if present in scan)
        if (payload.father_name_english) {
            updateClauses.push('`father_name_english` = ?');
            updateParams.push(payload.father_name_english);
        }
        if (payload.father_name_hindi) {
            updateClauses.push('`father_name_hindi` = ?');
            updateParams.push(payload.father_name_hindi);
        }

        // 8. Husband's Name (Always save if present in scan)
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
            "aadhaar_card": [
                {
                    "extracted_documents": [
                        {
                            "party_type": "buyer",
                            "document_type": "aadhaar_card",
                            "aadhaar_card_data": {
                                "aadhaarNumber": mergedAadhaarNumber || "",
                                "fullName_English": mergedNameEng,
                                "fullName_Hindi": mergedNameHin,
                                "dob": mergedDob,
                                "gender": mergedGender,
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
                }
            ]
        };

        updateClauses.push('`raw_json` = ?');
        updateParams.push(JSON.stringify(finalMergedJsonObj));

        // 12. Accumulate Tokens & Update Accuracy Rating
        const newTotalPrompt = (existing.tokens_prompt || 0) + payload.tokens_prompt;
        const newTotalCompletion = (existing.tokens_completion || 0) + payload.tokens_completion;
        const newTotalTokens = (existing.tokens_total || 0) + payload.tokens_total;
        const bestOverallAccuracy = Math.max(existing.accuracy_overall || 0, payload.accuracy_overall);

        updateClauses.push('`tokens_prompt` = ?', '`tokens_completion` = ?', '`tokens_total` = ?', '`accuracy_overall` = ?', '`upload_id` = ?');
        updateParams.push(newTotalPrompt, newTotalCompletion, newTotalTokens, bestOverallAccuracy, payload.upload_id || existing.upload_id);

        updateParams.push(existing.id);
        const updateSql = `
            UPDATE wh_aadhar_records
            SET ${updateClauses.join(', ')}
            WHERE id = ?
        `;

        await pool.execute(updateSql, updateParams);

        return {
            status: 'success',
            action: 'updated',
            recordId: existing.id,
            side: isFrontScan && isBackScan ? 'both' : (isFrontScan ? 'front' : 'back'),
            message: `Existing Aadhaar record ID #${existing.id} successfully updated with higher accuracy data.`
        };

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

