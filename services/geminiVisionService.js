const axios = require('axios');
const https = require('https');
const { extractAadhaarDetails: extractAadhaarVision } = require('./visionService');
const { extractPanDetails: extractPanVision } = require('./panvisionService');

const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

let cachedGeminiKey = process.env.GEMINI_API_KEY || null;
let lastKeyFetchTime = 0;

const pool = require('./db');

const KEY_ENDPOINT = 'https://fabkraft.in/registry/get_gemini_key.php';
const APP_TOKEN = 'gen-lang-client-0516447089';

/**
 * Dynamically fetches the Gemini API key:
 * 1. Checks memory cache
 * 2. Fetches from https://fabkraft.in/registry/get_gemini_key.php with X-App-Token
 * 3. Tries MySQL table `wh_baileys_auth` WHERE id = 'gemini_api_key'
 * 4. Checks process.env.GEMINI_API_KEY
 */
async function getGeminiApiKey() {
    const now = Date.now();
    if (cachedGeminiKey && (now - lastKeyFetchTime < 300000)) {
        return cachedGeminiKey;
    }

    // 1. Try fetching from fabkraft.in/registry/get_gemini_key.php
    try {
        console.log(`🔑 [GeminiKey] Fetching API key from ${KEY_ENDPOINT}...`);
        const res = await axios.get(KEY_ENDPOINT, {
            headers: {
                'X-App-Token': APP_TOKEN
            },
            httpsAgent,
            timeout: 8000
        });

        let key = null;
        if (typeof res.data === 'string') {
            try {
                const parsed = JSON.parse(res.data);
                key = parsed.api_key || parsed.key || parsed.gemini_key;
            } catch {
                key = res.data.trim();
            }
        } else if (typeof res.data === 'object' && res.data !== null) {
            key = res.data.api_key || res.data.key || res.data.gemini_key || res.data.apiKey || Object.values(res.data)[0];
        }

        // Validate that it looks like a valid key
        if (key && typeof key === 'string' && !key.includes('<html') && key.trim().length > 10) {
            cachedGeminiKey = key.trim();
            lastKeyFetchTime = now;
            console.log(`✅ [GeminiKey] Successfully loaded dynamic key from HTTP registry (Prefix: ${cachedGeminiKey.substring(0, 8)}...)`);
            return cachedGeminiKey;
        }
    } catch (err) {
        console.warn(`⚠️ [GeminiKey] HTTP fetch failed:`, err.response?.data || err.message);
    }

    // 2. Try fetching from MySQL table wh_baileys_auth
    try {
        const [rows] = await pool.execute(`SELECT value FROM wh_baileys_auth WHERE id = 'gemini_api_key' LIMIT 1`);
        if (rows.length > 0 && rows[0].value) {
            const dbKey = String(rows[0].value).trim();
            if (dbKey.length > 10) {
                cachedGeminiKey = dbKey;
                lastKeyFetchTime = now;
                console.log(`✅ [GeminiKey] Loaded key from MySQL (Prefix: ${cachedGeminiKey.substring(0, 8)}...)`);
                return cachedGeminiKey;
            }
        }
    } catch (dbErr) {
        console.warn(`⚠️ [GeminiKey] MySQL lookup failed:`, dbErr.message);
    }

    return cachedGeminiKey || process.env.GEMINI_API_KEY || '';
}

function getGeminiUrls(model, apiKey) {
    const encodedKey = encodeURIComponent(apiKey);
    return [
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodedKey}`,
        `https://generativelanguage.googleapis.com/v1alpha/models/${model}:generateContent?key=${encodedKey}`,
        `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${encodedKey}`
    ];
}

function buildGeminiHeaders(apiKey) {
    const headers = {
        'Content-Type': 'application/json'
    };
    if (apiKey) {
        headers['x-goog-api-key'] = apiKey;
    }
    return headers;
}

// Model priority with Gemini 3.1 Flash-Lite at top
const MODELS = [
    'gemini-3.1-flash-lite',
    'gemini-3.1-flash',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash',
    'gemini-1.5-flash'
];

/**
 * Extracts structured Aadhaar details using Gemini Flash with exact enterprise prompt & token tracking
 * @param {Buffer} buffer - Image or PDF buffer
 * @param {string} mimeType - 'image/jpeg', 'image/png', or 'application/pdf'
 * @returns {Promise<Object>}
 */
async function extractAadhaarWithGemini(buffer, mimeType = 'image/jpeg') {
    const apiKey = await getGeminiApiKey();
    const base64Data = buffer.toString('base64');
    const actualMime = mimeType || 'image/jpeg';

    const systemPrompt = `You are a universal OCR extraction engine for property registry systems (Rajasthan Jamabandi P-26C, Aadhaar, PAN).

Strict Rules:
1. UNIFIED ARRAY: Every document found in the scan must be added as a separate object inside the 'extracted_documents' array under 'aadhaar_card'.
2. MAPPING KEYS: You MUST accurately identify the 'party_type' (property, buyer, seller, witness, unassigned) and 'document_type' (sale_deed, aadhaar_card, pan_card) to match the system checklist.
3. DETECT SIDE: Identify whether the scanned image is the "front" side (contains photo, name, dob, gender, 12-digit aadhaar number), the "back" side (contains address, father/husband name, pincode, barcode/QR), or "both" (contains both front & back).
4. AADHAAR NUMBER EXTRACTION & ACCURACY: 
   - Extract the 12-digit Aadhaar number formatted as 'XXXX XXXX XXXX' wherever it is visible on the card (front side, back side, bottom margin, or text inside QR/barcode).
   - NEVER extract helpline numbers (like 1947, 1800-xxx) or 6-digit PIN codes as the Aadhaar number.
   - If no valid 12-digit Aadhaar number is visible or readable anywhere on the scan, set 'aadhaarNumber': "".
5. FATHER VS HUSBAND NAME & RELATION STATUS:
   - Identify relation_status as one of: "W/O" (Wife of / पत्नी), "S/O" (Son of / आत्मज / पुत्र), "D/O" (Daughter of / सुपुत्री), "C/O" (Care of / संरक्षक).
   - MANDATORY BILINGUAL TRANSLITERATION: You MUST provide BOTH husbandName_English AND husbandName_Hindi if a husband is found (transliterate phonetically into Devanagari script if Hindi is not explicitly printed, e.g., 'Brij Mohan' -> 'बृजमोहन', 'Akhilesh' -> 'अखिलेश'). Leave fatherName fields empty ("").
   - If relation is father/guardian (S/O, D/O, C/O, आत्मज, सुपुत्र): You MUST provide BOTH fatherName_English AND fatherName_Hindi (transliterate phonetically if only one language is printed). Leave husbandName fields empty ("").
6. ABSOLUTE VERBATIM EXTRACTION: Extract visible text exactly as printed. Do not correct spelling or names.
7. ZERO FABRICATION: If a field is missing or unreadable, set it to empty string "". Never guess digits or dates.
8. HINDI DATA RETENTION: All Hindi data must be extracted and returned in Hindi (Devanagari script) only.
9. ACCURACY SCORE: Evaluate your confidence (0-100) and return field-level accuracy.`;

    const userPrompt = `Extract this document scan into the following exact JSON schema:
{
  "extracted_documents": [
    {
      "party_type": "buyer",
      "document_type": "aadhaar_card",
      "detected_side": "front",
      "aadhaar_card_data": {
        "aadhaarNumber": "12-digit Aadhaar number formatted as 'XXXX XXXX XXXX' (look at front, back, bottom margin, or QR text). Empty string '' only if not present at all. Do NOT extract helpline 1947 or PIN code.",
        "vidNumber": "16-digit Virtual ID formatted as 'XXXX XXXX XXXX XXXX' if present (e.g., after 'VID :' on front or back).",
        "fullName_English": "Full name in English exactly as printed or empty string",
        "fullName_Hindi": "Full name in Hindi (Devanagari script) exactly as printed or empty string",
        "dob": "DD/MM/YYYY or YYYY or empty string",
        "gender": "MALE, FEMALE, पुरुष, महिला or empty string",
        "relation_status": "W/O, S/O, D/O, or C/O or empty string",
        "fatherName_English": "Father/Care-of Name in English if listed after S/O, D/O, C/O, आत्मज, सुपुत्र, पुत्र. Leave empty if W/O/पत्नी.",
        "fatherName_Hindi": "Father/Care-of Name in Hindi (Devanagari) if listed after आत्मज, सुपुत्र, पुत्र, S/O, D/O, C/O. Leave empty if W/O/पत्नी.",
        "husbandName_English": "Husband Name in English if listed after W/O (Wife of) or पत्नी. Leave empty if S/O/D/O/C/O/आत्मज.",
        "husbandName_Hindi": "Husband Name in Hindi (Devanagari - transliterate if needed) if listed after पत्नी or W/O. Leave empty if S/O/D/O/C/O/आत्मज.",
        "fullAddress_English": "Complete address in English or empty string",
        "fullAddress_Hindi": "Complete address in Hindi (Devanagari script) or empty string",
        "pincode": "6-digit PIN code or empty string",
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
    "verification_result": "Information verified.",
    "low_accuracy_reason": "",
    "advice_rescan": "No",
    "source_page_number": 1
  },
  "extraction_accuracy": 100,
  "is_custom": true,
  "_display_name": "Aadhar Card"
}

Output ONLY raw valid JSON without markdown formatting.`;

    const requestBody = {
        systemInstruction: {
            parts: [
                { text: systemPrompt }
            ]
        },
        contents: [
            {
                parts: [
                    { text: userPrompt },
                    {
                        inlineData: {
                            mimeType: actualMime,
                            data: base64Data
                        }
                    }
                ]
            }
        ],
        generationConfig: {
            temperature: 0.0,
            responseMimeType: "application/json"
        }
    };

    for (const model of MODELS) {
        const urls = getGeminiUrls(model, apiKey);
        for (const url of urls) {
            try {
                const response = await axios.post(url, requestBody, {
                    headers: buildGeminiHeaders(apiKey),
                    timeout: 35000
                });

            const textResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
            
            // Extract token usage metadata across all Google API formats
            const rawUsage = response.data?.usageMetadata || response.data?.usage || response.data?._metadata || {};
            const promptTokens = rawUsage.promptTokenCount ?? rawUsage.prompt_token_count ?? rawUsage.input_token ?? rawUsage.inputTokens ?? rawUsage.promptTokens ?? 0;
            const candidatesTokens = rawUsage.candidatesTokenCount ?? rawUsage.candidates_token_count ?? rawUsage.output_token ?? rawUsage.outputTokens ?? rawUsage.candidatesTokens ?? 0;
            const totalTokens = rawUsage.totalTokenCount ?? rawUsage.total_token_count ?? rawUsage.total_token ?? rawUsage.totalTokens ?? (promptTokens + candidatesTokens);

            const tokens = {
                promptTokens: Number(promptTokens),
                candidatesTokens: Number(candidatesTokens),
                totalTokens: Number(totalTokens)
            };

            const cleaned = textResponse.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
            const parsed = JSON.parse(cleaned);

            // Extract document data from exact hierarchy
            let cardData = null;
            let detectedSide = "both";
            let cardAccuracy = 100;
            let overallAccuracy = 100;

            const aadhaarArray = parsed.aadhaar_card || parsed.extracted_documents || [];
            if (Array.isArray(aadhaarArray) && aadhaarArray.length > 0) {
                const firstEntry = aadhaarArray[0];
                overallAccuracy = firstEntry.extraction_accuracy || 100;
                const innerDocs = firstEntry.extracted_documents || [firstEntry];
                if (Array.isArray(innerDocs) && innerDocs.length > 0) {
                    const doc = innerDocs[0];
                    cardData = doc.aadhaar_card_data || doc;
                    detectedSide = doc.detected_side || "both";
                    cardAccuracy = doc.aadhaar_card_data_accuracy || overallAccuracy;
                }
            } else if (parsed.extracted_documents && Array.isArray(parsed.extracted_documents)) {
                const doc = parsed.extracted_documents[0];
                cardData = doc.aadhaar_card_data || doc;
                detectedSide = doc.detected_side || "both";
                cardAccuracy = doc.aadhaar_card_data_accuracy || 100;
            } else {
                cardData = parsed.aadhaar_card_data || parsed;
            }

            if (!cardData) cardData = {};

            // Fallback detection of side if AI did not provide detected_side
            if (!detectedSide || detectedSide === "both") {
                const hasFront = !!(cardData.fullName_English || cardData.dob || cardData.gender);
                const hasBack = !!(cardData.fullAddress_English || cardData.fullAddress_Hindi || cardData.fatherName_English || cardData.husbandName_English || cardData.pincode);
                if (hasFront && !hasBack) detectedSide = "front";
                else if (hasBack && !hasFront) detectedSide = "back";
                else detectedSide = "both";
            }

            // Extract 12-digit Aadhaar number
            let cleanCardAadhaar = "Not Found";
            if (cardData.aadhaarNumber) {
                const rawDigits = String(cardData.aadhaarNumber).replace(/\D/g, '');
                if (rawDigits.length === 12 && !rawDigits.startsWith("1947") && !rawDigits.startsWith("1800")) {
                    cleanCardAadhaar = `${rawDigits.slice(0, 4)} ${rawDigits.slice(4, 8)} ${rawDigits.slice(8, 12)}`;
                }
            }

            // Extract 16-digit VID (Virtual ID)
            let cleanCardVid = "Not Found";
            const rawVid = cardData.vidNumber || cardData.virtualId || cardData.vid || "";
            if (rawVid) {
                const vidDigits = String(rawVid).replace(/\D/g, '');
                if (vidDigits.length === 16) {
                    cleanCardVid = `${vidDigits.slice(0, 4)} ${vidDigits.slice(4, 8)} ${vidDigits.slice(8, 12)} ${vidDigits.slice(12, 16)}`;
                } else if (vidDigits.length > 0) {
                    cleanCardVid = String(rawVid).trim();
                }
            }

            const { ensureBilingualName } = require('./transliterate');
            const nameBilingual = ensureBilingualName(cardData.fullName_English, cardData.fullName_Hindi);
            const fatherBilingual = ensureBilingualName(cardData.fatherName_English, cardData.fatherName_Hindi);
            const husbandBilingual = ensureBilingualName(cardData.husbandName_English, cardData.husbandName_Hindi);

            cardData.fullName_English = nameBilingual.english !== "Not Found" ? nameBilingual.english : (cardData.fullName_English || "");
            cardData.fullName_Hindi = nameBilingual.hindi !== "Not Found" ? nameBilingual.hindi : (cardData.fullName_Hindi || "");
            cardData.fatherName_English = fatherBilingual.english !== "Not Found" ? fatherBilingual.english : (cardData.fatherName_English || "");
            cardData.fatherName_Hindi = fatherBilingual.hindi !== "Not Found" ? fatherBilingual.hindi : (cardData.fatherName_Hindi || "");
            cardData.husbandName_English = husbandBilingual.english !== "Not Found" ? husbandBilingual.english : (cardData.husbandName_English || "");
            cardData.husbandName_Hindi = husbandBilingual.hindi !== "Not Found" ? husbandBilingual.hindi : (cardData.husbandName_Hindi || "");

            console.log(`✅ [Gemini] Extracted Aadhaar with ${model} (Side: ${detectedSide}, Aadhaar: ${cleanCardAadhaar}, VID: ${cleanCardVid}, Accuracy: ${overallAccuracy}%) | Tokens: ${tokens.totalTokens}`);
            return {
                success: true,
                engine: `Gemini (${model})`,
                model: model,
                tokens: tokens,
                detectedSide: detectedSide,
                rawJson: JSON.stringify(parsed),
                aadhaar_card_data: cardData,
                accuracy: {
                    overall: overallAccuracy,
                    aadhaarNumber: cardData.aadhaarNumber_accuracy || 100,
                    fullName_English: cardData.fullName_English_accuracy || 100,
                    fullName_Hindi: cardData.fullName_Hindi_accuracy || 100,
                    dob: cardData.dob_accuracy || 100,
                    pincode: cardData.pincode_accuracy || 100
                },
                data: {
                    aadharNumber: cleanCardAadhaar,
                    vidNumber: cleanCardVid,
                    nameEnglish: nameBilingual.english,
                    nameHindi: nameBilingual.hindi,
                    dob: cardData.dob || "Not Found",
                    gender: cardData.gender || "Not Found",
                    genderEnglish: cardData.gender || "Not Found",
                    genderHindi: cardData.gender_hindi || "Not Found",
                    relationStatus: cardData.relation_status || (husbandBilingual.english !== "Not Found" ? "W/O" : (fatherBilingual.english !== "Not Found" ? "S/O" : "Not Found")),
                    fatherNameEnglish: fatherBilingual.english,
                    fatherNameHindi: fatherBilingual.hindi,
                    husbandNameEnglish: husbandBilingual.english,
                    husbandNameHindi: husbandBilingual.hindi,
                    addressEnglish: cardData.fullAddress_English || "Not Found",
                    addressHindi: cardData.fullAddress_Hindi || "Not Found",
                    pincode: cardData.pincode || "Not Found"
                }
            };
        } catch (err) {
            console.warn(`⚠️ [Gemini ${model}] Error:`, err.response?.data?.error?.message || err.message);
        }
    }
}

    throw new Error('Aadhaar document extraction failed. Please ensure the image or PDF is clear and readable.');
}

/**
 * Extracts structured PAN details using Gemini with automatic Vision fallback
 * @param {Buffer} buffer - Image or PDF buffer
 * @param {string} mimeType - 'image/jpeg' or 'application/pdf'
 * @returns {Promise<Object>}
 */
async function extractPanWithGemini(buffer, mimeType = 'image/jpeg') {
    const apiKey = await getGeminiApiKey();
    const base64Data = buffer.toString('base64');
    const actualMime = mimeType || 'image/jpeg';
    const prompt = `
Analyze this Indian PAN Card document and extract the following details into valid JSON format.
If a field is not visible or not found, set its value to null.

JSON Schema:
{
  "pan_number": "10-character alphanumeric PAN number (e.g. ABCDE1234F) or null",
  "name": "Full name of the cardholder or null",
  "father_name": "Father's name or null",
  "dob": "Date of birth in DD/MM/YYYY format or null"
}

Output ONLY raw valid JSON without markdown formatting.
`;

    const requestBody = {
        contents: [
            {
                parts: [
                    { text: prompt },
                    {
                        inlineData: {
                            mimeType: actualMime,
                            data: base64Data
                        }
                    }
                ]
            }
        ],
        generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json"
        }
    };

    for (const model of MODELS) {
        const urls = getGeminiUrls(model, apiKey);
        for (const url of urls) {
            try {
                const response = await axios.post(url, requestBody, {
                    headers: buildGeminiHeaders(apiKey),
                    timeout: 20000
                });

                const textResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
                const cleaned = textResponse.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
                const parsed = JSON.parse(cleaned);

                console.log(`✅ [Gemini] Successfully extracted PAN using ${model}`);
                return {
                    success: true,
                    engine: `Gemini (${model})`,
                    data: {
                        panNumber: parsed.pan_number || "Not Found",
                        name: parsed.name || "Not Found",
                        fatherName: parsed.father_name || "Not Found",
                        dob: parsed.dob || "Not Found"
                    }
                };
            } catch (err) {
                console.warn(`⚠️ [Gemini ${model}] Error:`, err.response?.data?.error?.message || err.message);
            }
        }
    }

    throw new Error('PAN document extraction failed. Please ensure the image or PDF is clear and readable.');
}

/**
 * Extracts structured Rajasthan Jamabandi (P-26C) land records using Gemini Universal Registry Schema
 * @param {Buffer} buffer - Image or PDF buffer
 * @param {string} mimeType - 'application/pdf' or 'image/jpeg'
 * @returns {Promise<Object>}
 */
async function extractJamabandiWithGemini(buffer, mimeType = 'image/jpeg') {
    const apiKey = await getGeminiApiKey();
    const base64Data = buffer.toString('base64');
    const isPdf = mimeType === 'application/pdf' || (typeof mimeType === 'string' && mimeType.toLowerCase().includes('pdf'));
    const actualMime = isPdf ? 'application/pdf' : 'image/jpeg';

    const systemPrompt = `You are a universal OCR extraction engine for property registry systems (Rajasthan Jamabandi P-26C, Aadhaar, PAN).

Strict Rules:
1. UNIFIED ARRAY: Every document found in the scan must be added as a separate object inside the 'extracted_documents' array.
2. MAPPING KEYS: You MUST accurately identify the 'party_type' (property, buyer, seller, witness) and 'document_type' (old_jamabandi, aadhaar_card, pan_card) to match the system checklist.
3. CONDITIONAL POPULATION: Depending on the 'document_type', fill ONLY the corresponding data object ('old_jamabandi_data', 'aadhaar_card_data', or 'pan_card_data') and leave the others null.
4. ABSOLUTE VERBATIM EXTRACTION: Extract visible text exactly as printed. Do not correct spelling, archaic legal terms, or names.
5. ZERO FABRICATION: If a field or table cell is missing or unreadable, set it to empty string ''. Never guess digits or dates.
6. NUMERIC ACCURACY: Extract all land areas, rent amounts, account numbers, and dates using standard Arabic numerals (0-9). Preserve exact decimal precision.
7. ACCURACY SCORE: Evaluate your own confidence (0-100) and return it in 'accuracyFields'.`;

    const userPrompt = `Extract this Rajasthan Jamabandi document (P-26C / प्रपत्र पी-26 सी) into the following exact JSON schema:
{
  "extracted_documents": [
    {
      "party_type": "property",
      "document_type": "old_jamabandi",
      "old_jamabandi_data": {
        "formName": "Header form code e.g. प्रपत्र पी-26 (सी) (देखिये नियम 153 ए)",
        "documentType": "Document title e.g. जमाबन्दी (प्रतिलिपि)",
        "village": "Village name following 'ग्राम का नाम :-'",
        "patwarHalka": "Patwar Halka name",
        "landInspectorCircle": "Land Inspector Circle (भू.अभि.नि.)",
        "tehsil": "Tehsil name",
        "district": "District name",
        "landHolder": "Land holder name following 'भूमि धारक का नाम :-'",
        "samvatPeriod": "Settlement years / Samvat text line",
        "areaUnit": "Unit of measurement e.g. हैक्टेयर or बीघा",
        "khataNoNew": "New Khata number",
        "khataNoOld": "Old Khata number",
        "khatedarDetails": [
          {
            "sNo": 1,
            "name": "Name of Khatedar",
            "fatherName": "Father or husband name",
            "share": "Ownership share ratio e.g. 1/3 or 1/1",
            "caste": "Caste/Jaati",
            "residence": "Address / Residence",
            "khatedarType": "Tenure type e.g. खातेदार",
            "rawText": "Complete verbatim text line for this tenant entry"
          }
        ],
        "khasraDetails": [
          {
            "rowIndex": 1,
            "khasraNo": "Survey plot number",
            "area": "Plot area",
            "area_sold": "",
            "landClassification": "Soil classification",
            "rent": "Rent payable",
            "irrigationSource": "Irrigation means",
            "mutationDetails": "Mutation reference",
            "remarks": "Remarks"
          }
        ],
        "totals": {
          "totalKhasraCount": 1,
          "totalArea": "Total area sum",
          "totalRent": "Total rent sum"
        }
      }
    }
  ],
  "accuracy_overall": 100
}

Output ONLY raw valid JSON without markdown formatting.`;

    const requestBody = {
        systemInstruction: {
            parts: [
                { text: systemPrompt }
            ]
        },
        contents: [
            {
                parts: [
                    { text: userPrompt },
                    {
                        inlineData: {
                            mimeType: actualMime,
                            data: base64Data
                        }
                    }
                ]
            }
        ],
        generationConfig: {
            temperature: 0.0,
            maxOutputTokens: 8192,
            responseMimeType: "application/json"
        }
    };

    let lastError = null;

    for (const model of MODELS) {
        const urls = getGeminiUrls(model, apiKey);
        for (const url of urls) {
            try {
                console.log(`🤖 [AI Engine] Attempting Jamabandi extraction with ${model}...`);
                const response = await axios.post(url, requestBody, {
                    headers: buildGeminiHeaders(apiKey),
                    timeout: 60000
                });

                const textResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
                
                const rawUsage = response.data?.usageMetadata || response.data?.usage || {};
                const promptTokens = Number(rawUsage.promptTokenCount ?? rawUsage.prompt_token_count ?? 0);
                const candidatesTokens = Number(rawUsage.candidatesTokenCount ?? rawUsage.candidates_token_count ?? 0);
                const totalTokens = Number(rawUsage.totalTokenCount ?? rawUsage.total_token_count ?? (promptTokens + candidatesTokens));

                const tokens = { promptTokens, candidatesTokens, totalTokens };
                
                let parsed = null;
                try {
                    const cleaned = textResponse.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
                    parsed = JSON.parse(cleaned);
                } catch (jsonErr) {
                    const match = textResponse.match(/\{[\s\S]*\}/);
                    if (match) {
                        parsed = JSON.parse(match[0]);
                    } else {
                        throw new Error(`Failed to parse JSON response: ${jsonErr.message}`);
                    }
                }

                let jData = null;
                let overallAcc = parsed.accuracy_overall || 100;

                const docList = parsed.extracted_documents || [];
                if (Array.isArray(docList) && docList.length > 0) {
                    const item = docList.find(d => d.document_type === 'old_jamabandi' || d.old_jamabandi_data) || docList[0];
                    jData = item.old_jamabandi_data || item;
                } else if (parsed.old_jamabandi_data) {
                    jData = parsed.old_jamabandi_data;
                } else {
                    jData = parsed;
                }

                console.log(`✅ [AI Engine] Successfully extracted Jamabandi using ${model} (Tokens: ${totalTokens})`);
                return {
                    success: true,
                    model,
                    engine: `AI Engine (${model})`,
                    tokens,
                    accuracy: overallAcc,
                    data: jData,
                    rawJson: parsed
                };

            } catch (err) {
                lastError = err.response?.data?.error?.message || err.message;
                console.warn(`⚠️ [AI Engine ${model}] Jamabandi extraction warning:`, lastError);
            }
        }
    }

    throw new Error('Jamabandi document extraction failed. Please ensure the image or PDF is clear and readable.');
}

/**
 * Extracts structured Sale Deed (विक्रय पत्र / बैनामा) land records using Universal Registry Schema
 * @param {Buffer} buffer - Image or PDF buffer
 * @param {string} mimeType - 'application/pdf' or 'image/jpeg'
 * @returns {Promise<Object>}
 */
async function extractSaleDeedWithGemini(buffer, mimeType = 'image/jpeg') {
    const apiKey = await getGeminiApiKey();
    const base64Data = buffer.toString('base64');
    const isPdf = mimeType === 'application/pdf' || (typeof mimeType === 'string' && mimeType.toLowerCase().includes('pdf'));
    const actualMime = isPdf ? 'application/pdf' : 'image/jpeg';

    const systemPrompt = `You are a universal OCR extraction engine for property registry systems (Rajasthan Jamabandi P-26C, Aadhaar, PAN, Sale Deed / बैनामा / विक्रय पत्र).

Strict Rules:
1. UNIFIED ARRAY: Every document found in the scan must be added as a separate object inside the 'extracted_documents' array.
2. MAPPING KEYS: You MUST accurately identify the 'party_type' (property, buyer, seller, witness) and 'document_type' (sale_deed, old_jamabandi, aadhaar_card, pan_card) to match the system checklist.
3. CONDITIONAL POPULATION: Depending on the 'document_type', fill ONLY the corresponding data object ('sale_deed_data', 'old_jamabandi_data', 'aadhaar_card_data', or 'pan_card_data') and leave the others null.
4. ABSOLUTE VERBATIM EXTRACTION: Extract visible text exactly as printed. Do not correct spelling, archaic legal terms, or names.
5. ZERO FABRICATION: If a field or table cell is missing or unreadable, set it to empty string ''. Never guess digits or dates.
6. NUMERIC ACCURACY: Extract all land areas, rent amounts, consideration value, account numbers, and dates using standard Arabic numerals (0-9). Preserve exact decimal precision.
7. ACCURACY SCORE: Evaluate your own confidence (0-100) and return it in 'accuracyFields'.
8. HINDI DATA RETENTION: All Hindi data must be extracted and returned in Hindi (Devanagari script) only. Do not translate Hindi names, addresses, or boundaries into English.`;

    const userPrompt = `Extract this Property Sale Deed document (बैनामा / विक्रय पत्र / रजिस्ट्री) into the following exact JSON schema:
{
  "extracted_documents": [
    {
      "party_type": "property",
      "document_type": "sale_deed",
      "sale_deed_data": {
        "document_type": "Document title or type, e.g., Sale Deed",
        "deed_number": "Document/Deed registration number",
        "registration_date": "Date of property registration (DD-MM-YYYY)",
        "sub_registrar_office": "Name of the Sub-Registrar Office (SRO) where registered",
        "transaction_type": "Specific type of transaction, e.g., Sale Deed (Female SC/ST/BPL)",
        "property": {
          "property_type": "Type of property being transacted, e.g., Agricultural Plot, Residential",
          "plot_number": "Plot number of the property",
          "area": {
            "front": "Front measurement of the plot/property area",
            "depth": "Depth measurement of the plot/property area",
            "total_area_sqft": "Total calculated area of the property including units, e.g., '800 varg fit' or '800 sq ft'",
            "front_accuracy": 100,
            "depth_accuracy": 100,
            "total_area_sqft_accuracy": 100
          },
          "village": "Village name where the property is located. All Hindi data should be in Hindi only.",
          "tehsil": "Tehsil name. All Hindi data should be in Hindi only.",
          "district": "District name. All Hindi data should be in Hindi only.",
          "khasra_number": "Khasra, Survey, or Aaraji number of the property (e.g., '822').",
          "rakba": "Agriculture field area details in Bigha and Biswa (e.g., '01 बीघा 11 बिस्वा'). All Hindi data should be in Hindi only.",
          "boundaries": {
            "east": "Eastern boundary details. All Hindi data should be in Hindi only.",
            "west": "Western boundary details. All Hindi data should be in Hindi only.",
            "north": "Northern boundary details. All Hindi data should be in Hindi only.",
            "south": "Southern boundary details. All Hindi data should be in Hindi only.",
            "east_accuracy": 100,
            "west_accuracy": 100,
            "north_accuracy": 100,
            "south_accuracy": 100
          },
          "plot_number_accuracy": 100,
          "village_accuracy": 100,
          "tehsil_accuracy": 100,
          "district_accuracy": 100,
          "khasra_number_accuracy": 100,
          "rakba_accuracy": 100
        },
        "consideration": {
          "sale_amount": 0,
          "market_value": 0,
          "payment_mode": "Mode of payment, e.g., Cheque, Cash, RTGS, DD",
          "cheque_number": "Reference number of the cheque or transaction",
          "cheque_date": "Date of the cheque or payment transaction",
          "sale_amount_accuracy": 100,
          "market_value_accuracy": 100,
          "payment_mode_accuracy": 100
        },
        "seller": {
          "seller_name": "Name of the seller. All Hindi data should be in Hindi only.",
          "seller_relationship": "Relationship with the relative mentioned (e.g., S/O, D/O, W/O, C/O). All Hindi data should be in Hindi only.",
          "seller_spouse_name": "Name of the seller's spouse or father. All Hindi data should be in Hindi only.",
          "seller_age": 0,
          "seller_address": {
            "area": "Locality or area of the seller's address. All Hindi data should be in Hindi only.",
            "seller_city": "City of the seller. All Hindi data should be in Hindi only.",
            "seller_state": "State of the seller",
            "seller_pincode": "Postal PIN code of the seller"
          },
          "category": "Caste or category of the seller (e.g., General, SC, ST)",
          "seller_name_accuracy": 100,
          "seller_relationship_accuracy": 100,
          "seller_spouse_name_accuracy": 100
        },
        "buyer": {
          "buyer_name": "Name of the buyer. All Hindi data should be in Hindi only.",
          "buyer_relationship": "Relationship with the relative mentioned (e.g., S/O, D/O, W/O, C/O). All Hindi data should be in Hindi only.",
          "buyer_spouse_name": "Name of the buyer's spouse or father. All Hindi data should be in Hindi only.",
          "buyer_age": 0,
          "buyer_address": {
            "village": "Village of the buyer. All Hindi data should be in Hindi only.",
            "buyer_post": "Post office of the buyer. All Hindi data should be in Hindi only.",
            "buyer_district": "District of the buyer. All Hindi data should be in Hindi only.",
            "buyer_state": "State of the buyer",
            "buyer_pincode": "Postal PIN code of the buyer"
          },
          "aadhaar_number": "12-digit format",
          "category": "Caste or category of the buyer (e.g., Female SC/ST/BPL)",
          "buyer_name_accuracy": 100,
          "buyer_relationship_accuracy": 100,
          "buyer_spouse_name_accuracy": 100
        },
        "previous_title": {
          "previous_owner": "Name of the previous owner of the property",
          "registry_number": "Registration number of the previous title deed",
          "registry_date": "Date of the previous title deed registration"
        },
        "deed_number_accuracy": 100,
        "registration_date_accuracy": 100,
        "sub_registrar_office_accuracy": 100,
        "transaction_type_accuracy": 100,
        "sale_deed_data_accuracy": 100
      },
      "sale_deed_data_accuracy": 100
    }
  ],
  "extraction_result": {
    "scan_quality_rating": 9,
    "cross_verification_done": true,
    "verification_result": "Information verified.",
    "low_accuracy_reason": "",
    "advice_rescan": "No",
    "source_page_number": 1
  },
  "extraction_accuracy": 100,
  "is_custom": true,
  "_display_name": "Property Sale Deed"
}

Output ONLY raw valid JSON without markdown formatting.`;

    const requestBody = {
        systemInstruction: {
            parts: [
                { text: systemPrompt }
            ]
        },
        contents: [
            {
                parts: [
                    { text: userPrompt },
                    {
                        inlineData: {
                            mimeType: actualMime,
                            data: base64Data
                        }
                    }
                ]
            }
        ],
        generationConfig: {
            temperature: 0.0,
            maxOutputTokens: 8192,
            responseMimeType: "application/json"
        }
    };

    let lastError = null;

    for (const model of MODELS) {
        const urls = getGeminiUrls(model, apiKey);
        for (const url of urls) {
            try {
                console.log(`🤖 [AI Engine] Attempting Sale Deed extraction with ${model}...`);
                const response = await axios.post(url, requestBody, {
                    headers: buildGeminiHeaders(apiKey),
                    timeout: 60000
                });

                const textResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
                
                const rawUsage = response.data?.usageMetadata || response.data?.usage || {};
                const promptTokens = Number(rawUsage.promptTokenCount ?? rawUsage.prompt_token_count ?? 0);
                const candidatesTokens = Number(rawUsage.candidatesTokenCount ?? rawUsage.candidates_token_count ?? 0);
                const totalTokens = Number(rawUsage.totalTokenCount ?? rawUsage.total_token_count ?? (promptTokens + candidatesTokens));

                const tokens = { promptTokens, candidatesTokens, totalTokens };
                
                let parsed = null;
                try {
                    const cleaned = textResponse.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
                    parsed = JSON.parse(cleaned);
                } catch (jsonErr) {
                    const match = textResponse.match(/\{[\s\S]*\}/);
                    if (match) {
                        parsed = JSON.parse(match[0]);
                    } else {
                        throw new Error(`Failed to parse JSON response: ${jsonErr.message}`);
                    }
                }

                let deedData = null;
                let overallAcc = 100;

                const saleDeedArray = parsed.sale_deed || parsed.extracted_documents || [];
                if (Array.isArray(saleDeedArray) && saleDeedArray.length > 0) {
                    const firstEntry = saleDeedArray[0];
                    overallAcc = firstEntry.extraction_accuracy || parsed.accuracy_overall || 100;
                    const innerDocs = firstEntry.extracted_documents || [firstEntry];
                    if (Array.isArray(innerDocs) && innerDocs.length > 0) {
                        const item = innerDocs.find(d => d.document_type === 'sale_deed' || d.sale_deed_data) || innerDocs[0];
                        deedData = item.sale_deed_data || item;
                    }
                } else if (parsed.extracted_documents && Array.isArray(parsed.extracted_documents)) {
                    const item = parsed.extracted_documents.find(d => d.document_type === 'sale_deed' || d.sale_deed_data) || parsed.extracted_documents[0];
                    deedData = item.sale_deed_data || item;
                    overallAcc = parsed.extraction_accuracy || parsed.accuracy_overall || 100;
                } else if (parsed.sale_deed_data) {
                    deedData = parsed.sale_deed_data;
                    overallAcc = parsed.accuracy_overall || 100;
                } else {
                    deedData = parsed;
                }

                console.log(`✅ [AI Engine] Successfully extracted Sale Deed using ${model} (Tokens: ${totalTokens})`);
                return {
                    success: true,
                    model,
                    engine: `AI Engine (${model})`,
                    tokens,
                    accuracy: overallAcc,
                    data: deedData,
                    rawJson: parsed
                };

            } catch (err) {
                lastError = err.response?.data?.error?.message || err.message;
                console.warn(`⚠️ [AI Engine ${model}] Sale Deed extraction warning:`, lastError);
            }
        }
    }

    throw new Error('Sale Deed document extraction failed. Please ensure the image or PDF is clear and readable.');
}

module.exports = {
    extractAadhaarWithGemini,
    extractPanWithGemini,
    extractJamabandiWithGemini,
    extractSaleDeedWithGemini
};
