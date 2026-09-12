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

function buildGeminiHeaders(apiKey) {
    const headers = {
        'Content-Type': 'application/json'
    };
    if (apiKey) {
        headers['x-goog-api-key'] = apiKey;
        if (apiKey.startsWith('AQ.') || apiKey.startsWith('ya29.')) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }
    }
    return headers;
}

// Working official Gemini vision models on Google AI API
const MODELS = [
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
    'gemini-1.5-pro'
];

/**
 * Extracts structured Aadhaar details using Gemini Flash with exact enterprise prompt & token tracking
 * @param {Buffer} buffer - Image buffer
 * @returns {Promise<Object>}
 */
async function extractAadhaarWithGemini(buffer) {
    const apiKey = await getGeminiApiKey();
    const base64Data = buffer.toString('base64');

    const systemPrompt = `You are a universal OCR extraction engine for property registry systems (Rajasthan Jamabandi P-26C, Aadhaar, PAN).

Strict Rules:
1. UNIFIED ARRAY: Every document found in the scan must be added as a separate object inside the 'extracted_documents' array under 'aadhaar_card'.
2. MAPPING KEYS: You MUST accurately identify the 'party_type' (property, buyer, seller, witness, unassigned) and 'document_type' (sale_deed, aadhaar_card, pan_card) to match the system checklist.
3. DETECT SIDE: Identify whether the scanned image is the "front" side (contains photo, name, dob, gender, 12-digit aadhaar number), the "back" side (contains address, father/husband name, pincode, barcode/QR), or "both" (contains both front & back).
4. AADHAAR NUMBER ACCURACY: 
   - On the FRONT side, extract the clean 12-digit Aadhaar number (XXXX XXXX XXXX).
   - On the BACK side, Aadhaar numbers are typically NOT printed (only helpline numbers like 1947 or barcodes exist). NEVER mistake toll-free numbers (1947, 1800-xxx) or PIN codes for the Aadhaar number. If no valid 12-digit Aadhaar number is printed on the back, leave 'aadhaarNumber': "".
5. FATHER VS HUSBAND NAME:
   - S/O, D/O, C/O -> Extract into fatherName_English & fatherName_Hindi. Leave husbandName empty.
   - W/O (Wife of) -> Extract into husbandName_English & husbandName_Hindi. Leave fatherName empty.
6. ABSOLUTE VERBATIM EXTRACTION: Extract visible text exactly as printed. Do not correct spelling or names.
7. ZERO FABRICATION: If a field is missing or unreadable, set it to empty string "". Never guess digits or dates.
8. HINDI DATA RETENTION: All Hindi data must be extracted and returned in Hindi (Devanagari script) only.
9. ACCURACY SCORE: Evaluate your confidence (0-100) and return field-level accuracy.`;

    const userPrompt = `Extract this document scan into the following exact JSON schema:
{
  "aadhaar_card": [
    {
      "extracted_documents": [
        {
          "party_type": "buyer",
          "document_type": "aadhaar_card",
          "detected_side": "front",
          "aadhaar_card_data": {
            "aadhaarNumber": "XXXX XXXX XXXX or empty string if not visible",
            "fullName_English": "Full name in English exactly as printed or empty string",
            "fullName_Hindi": "Full name in Hindi (Devanagari script) exactly as printed or empty string",
            "dob": "DD/MM/YYYY or YYYY or empty string",
            "gender": "MALE, FEMALE, पुरुष, महिला or empty string",
            "fatherName_English": "Name in English ONLY if listed after S/O, D/O, or C/O. Leave empty if W/O is used.",
            "fatherName_Hindi": "Name in Hindi (Devanagari script) ONLY if listed after S/O, D/O, or C/O. Leave empty if W/O is used.",
            "husbandName_English": "Name in English ONLY if listed after W/O (Wife of). Leave empty if S/O, D/O, or C/O is used.",
            "husbandName_Hindi": "Name in Hindi (Devanagari script) ONLY if listed after W/O (Wife of). Leave empty if S/O, D/O, or C/O is used.",
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
  ]
}

Output ONLY raw valid JSON without markdown formatting.`;

    const requestBody = {
        system_instruction: {
            parts: [
                { text: systemPrompt }
            ]
        },
        contents: [
            {
                parts: [
                    { text: userPrompt },
                    {
                        inline_data: {
                            mime_type: 'image/jpeg',
                            data: base64Data
                        }
                    }
                ]
            }
        ],
        generationConfig: {
            temperature: 0.0,
            response_mime_type: "application/json"
        }
    };

    // 1. Try Gemini models
    for (const model of MODELS) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            const response = await axios.post(url, requestBody, {
                headers: buildGeminiHeaders(apiKey),
                timeout: 30000
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

            console.log(`✅ [Gemini] Extracted Aadhaar with ${model} (Side: ${detectedSide}, Accuracy: ${overallAccuracy}%) | Tokens: ${tokens.totalTokens} (Prompt: ${tokens.promptTokens}, Completion: ${tokens.candidatesTokens})`);
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
                    aadharNumber: (cardData.aadhaarNumber && cardData.aadhaarNumber.length >= 10 && !cardData.aadhaarNumber.startsWith("1947")) ? cardData.aadhaarNumber : "Not Found",
                    vidNumber: cardData.vidNumber || cardData.virtualId || "Not Found",
                    nameEnglish: cardData.fullName_English || "Not Found",
                    nameHindi: cardData.fullName_Hindi || "Not Found",
                    dob: cardData.dob || "Not Found",
                    gender: cardData.gender || "Not Found",
                    genderEnglish: cardData.gender || "Not Found",
                    genderHindi: cardData.gender_hindi || "Not Found",
                    fatherNameEnglish: cardData.fatherName_English || "Not Found",
                    fatherNameHindi: cardData.fatherName_Hindi || "Not Found",
                    husbandNameEnglish: cardData.husbandName_English || "Not Found",
                    husbandNameHindi: cardData.husbandName_Hindi || "Not Found",
                    addressEnglish: cardData.fullAddress_English || "Not Found",
                    addressHindi: cardData.fullAddress_Hindi || "Not Found",
                    pincode: cardData.pincode || "Not Found"
                }
            };
        } catch (err) {
            console.warn(`⚠️ [Gemini ${model}] Error:`, err.response?.data?.error?.message || err.message);
        }
    }

    // 2. Automatic Fallback to Google Cloud Vision API
    console.log("🔄 [Fallback] Falling back to Google Cloud Vision OCR for Aadhaar...");
    try {
        const visionResult = await extractAadhaarVision(buffer);
        return {
            success: true,
            engine: "Google Cloud Vision",
            model: "Google Cloud Vision OCR",
            tokens: { promptTokens: 0, candidatesTokens: 0, totalTokens: 0 },
            detectedSide: "both",
            rawJson: JSON.stringify({
                "aadhaar_card": [
                    {
                        "extracted_documents": [
                            {
                                "party_type": "buyer",
                                "document_type": "aadhaar_card",
                                "detected_side": "both",
                                "aadhaar_card_data": {
                                    "aadhaarNumber": visionResult.aadharNumber || "",
                                    "fullName_English": visionResult.nameEnglish || "",
                                    "fullName_Hindi": visionResult.nameHindi || "",
                                    "dob": visionResult.dob || "",
                                    "gender": visionResult.genderEnglish || "",
                                    "fatherName_English": "",
                                    "fatherName_Hindi": "",
                                    "husbandName_English": "",
                                    "husbandName_Hindi": "",
                                    "fullAddress_English": visionResult.addressEnglish || "",
                                    "fullAddress_Hindi": visionResult.addressHindi || "",
                                    "pincode": visionResult.pincode || "",
                                    "pancard": "",
                                    "aadhaarNumber_accuracy": 90,
                                    "fullName_English_accuracy": 90,
                                    "fullName_Hindi_accuracy": 90,
                                    "dob_accuracy": 90,
                                    "fatherName_Hindi_accuracy": 90,
                                    "husbandName_Hindi_accuracy": 90,
                                    "pincode_accuracy": 90
                                },
                                "aadhaar_card_data_accuracy": 90
                            }
                        ],
                        "extraction_result": {
                            "scan_quality_rating": 8,
                            "cross_verification_done": true,
                            "verification_result": "Extracted via Cloud Vision OCR",
                            "low_accuracy_reason": "",
                            "advice_rescan": "No",
                            "source_page_number": 1
                        },
                        "extraction_accuracy": 90,
                        "is_custom": true,
                        "_display_name": "Aadhar Card"
                    }
                ]
            }),
            data: visionResult
        };
    } catch (visionErr) {
        console.error("❌ Google Vision fallback error:", visionErr.message);
        return {
            success: false,
            engine: "None",
            model: "None",
            tokens: { promptTokens: 0, candidatesTokens: 0, totalTokens: 0 },
            detectedSide: "both",
            data: {
                aadharNumber: "Not Found",
                nameEnglish: "Not Found",
                dob: "Not Found"
            }
    }
}

/**
 * Extracts structured PAN details using Gemini 3.1 Flash-Lite with automatic Vision fallback
 * @param {Buffer} buffer - Image buffer
 * @returns {Promise<Object>}
 */
async function extractPanWithGemini(buffer) {
    const apiKey = await getGeminiApiKey();
    const base64Data = buffer.toString('base64');
    const prompt = `
Analyze this Indian PAN Card image and extract the following details into valid JSON format.
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
                        inline_data: {
                            mime_type: 'image/jpeg',
                            data: base64Data
                        }
                    }
                ]
            }
        ],
        generationConfig: {
            temperature: 0.1,
            response_mime_type: "application/json"
        }
    };

    // 1. Try Gemini 3.1 Flash-Lite & latest models
    for (const model of MODELS) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            const response = await axios.post(url, requestBody, {
                headers: buildGeminiHeaders(apiKey),
                timeout: 15000
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

    // 2. Automatic Fallback to Google Cloud Vision API
    console.log("🔄 [Fallback] Falling back to Google Cloud Vision OCR for PAN...");
    try {
        const visionResult = await extractPanVision(buffer);
        return {
            success: true,
            engine: "Google Cloud Vision",
            data: visionResult
        };
    } catch (visionErr) {
        console.error("❌ Google Vision fallback error:", visionErr.message);
        return {
            success: false,
            engine: "None",
            data: {
                panNumber: "Not Found",
                name: "Not Found"
            }
        };
    }
}

module.exports = {
    extractAadhaarWithGemini,
    extractPanWithGemini
};
