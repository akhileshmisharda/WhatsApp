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

// Prioritize Gemini 3.1 Flash-Lite & latest Flash-Lite vision models
const MODELS = [
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash-lite-preview-02-05',
    'gemini-2.0-flash',
    'gemini-1.5-flash-8b',
    'gemini-1.5-flash'
];

/**
 * Extracts structured Aadhaar details using Gemini 3.1 Flash-Lite with exact enterprise prompt & token tracking
 * @param {Buffer} buffer - Image buffer
 * @returns {Promise<Object>}
 */
async function extractAadhaarWithGemini(buffer) {
    const apiKey = await getGeminiApiKey();
    const base64Data = buffer.toString('base64');

    const systemPrompt = `You are a universal OCR extraction engine for property registry systems (Rajasthan Jamabandi P-26C, Aadhaar, PAN).

Strict Rules:
1. UNIFIED ARRAY: Every document found in the scan must be added as a separate object inside the 'extracted_documents' array.
2. MAPPING KEYS: You MUST accurately identify the 'party_type' (property, buyer, seller, witness, unassigned) and 'document_type' (sale_deed, aadhaar_card, pan_card) to match the system checklist.
3. CONDITIONAL POPULATION: Depending on the 'document_type', fill ONLY the corresponding data object ('sale_deed_data', 'aadhaar_card_data', or 'pan_card_data') and leave the others null.
4. ABSOLUTE VERBATIM EXTRACTION: Extract visible text exactly as printed. Do not correct spelling, archaic legal terms, or names.
5. ZERO FABRICATION: If a field or table cell is missing or unreadable, set it to empty string ''. Never guess digits or dates.
6. NUMERIC ACCURACY: Extract all land areas, rent amounts, account numbers, and dates using standard Arabic numerals (0-9). Preserve exact decimal precision.
7. ACCURACY SCORE: Evaluate your own confidence (0-100) and return it in 'accuracyFields'.
8. HINDI DATA RETENTION: All Hindi data must be extracted and returned in Hindi (Devanagari script) only. Do not translate Hindi names, addresses, or boundaries into English.`;

    const userPrompt = `Extract this document scan into the following exact JSON schema:
{
  "extracted_documents": [
    {
      "party_type": "buyer",
      "document_type": "aadhaar_card",
      "accuracyFields": {
        "aadhaarNumber": "100",
        "fullName_English": "100",
        "fullName_Hindi": "100",
        "dob": "100",
        "fatherName_Hindi": "100",
        "husbandName_Hindi": "100",
        "pincode": "100"
      },
      "aadhaar_card_data": {
        "aadhaarNumber": "12-digit format, e.g. XXXX XXXX XXXX",
        "fullName_English": "Extract full name in English exactly as printed.",
        "fullName_Hindi": "Extract full name in Hindi (Devanagari script) exactly as printed.",
        "dob": "DD/MM/YYYY or YYYY",
        "gender": "Extract gender (e.g., MALE, FEMALE, पुरुष, महिला)",
        "fatherName_English": "Extract name in English ONLY if listed after S/O, D/O, or C/O. Leave empty if W/O is used.",
        "fatherName_Hindi": "Extract name in Hindi (Devanagari script) ONLY if listed after S/O, D/O, or C/O. Leave empty if W/O is used.",
        "husbandName_English": "Extract name in English ONLY if listed after W/O (Wife of). Leave empty if S/O, D/O, or C/O is used.",
        "husbandName_Hindi": "Extract name in Hindi (Devanagari script) ONLY if listed after W/O (Wife of). Leave empty if S/O, D/O, or C/O is used.",
        "fullAddress_English": "Extract complete address in English.",
        "fullAddress_Hindi": "Extract complete address in Hindi (Devanagari script).",
        "pincode": "6-digit PIN code",
        "pancard": ""
      }
    }
  ]
}

Output ONLY raw valid JSON.`;

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

    // 1. Try Gemini 3.1 Flash-Lite & latest models
    for (const model of MODELS) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            const response = await axios.post(url, requestBody, {
                headers: buildGeminiHeaders(apiKey),
                timeout: 25000
            });

            const textResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
            const usage = response.data?.usageMetadata || {};
            const tokens = {
                promptTokens: usage.promptTokenCount || 0,
                candidatesTokens: usage.candidatesTokenCount || 0,
                totalTokens: usage.totalTokenCount || 0
            };

            const cleaned = textResponse.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
            const parsed = JSON.parse(cleaned);

            // Extract document data from array or direct object
            let cardData = null;
            let accuracyFields = {};
            if (Array.isArray(parsed.extracted_documents) && parsed.extracted_documents.length > 0) {
                const doc = parsed.extracted_documents.find(d => d.document_type === 'aadhaar_card' || d.aadhaar_card_data) || parsed.extracted_documents[0];
                if (doc) {
                    cardData = doc.aadhaar_card_data || doc;
                    accuracyFields = doc.accuracyFields || {};
                }
            }
            if (!cardData) {
                cardData = parsed.aadhaar_card_data || parsed;
            }

            console.log(`✅ [Gemini] Extracted Aadhaar with ${model} | Tokens: ${tokens.totalTokens} (Prompt: ${tokens.promptTokens}, Completion: ${tokens.candidatesTokens})`);
            return {
                success: true,
                engine: `Gemini (${model})`,
                model: model,
                tokens: tokens,
                rawJson: JSON.stringify(parsed),
                aadhaar_card_data: cardData,
                accuracyFields: accuracyFields,
                data: {
                    aadharNumber: cardData.aadhaarNumber || "Not Found",
                    vidNumber: cardData.vidNumber || cardData.virtualId || "Not Found",
                    nameEnglish: cardData.fullName_English || cardData.nameEnglish || "Not Found",
                    nameHindi: cardData.fullName_Hindi || cardData.nameHindi || "Not Found",
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
            data: visionResult
        };
    } catch (visionErr) {
        console.error("❌ Google Vision fallback error:", visionErr.message);
        return {
            success: false,
            engine: "None",
            data: {
                aadharNumber: "Not Found",
                nameEnglish: "Not Found",
                dob: "Not Found"
            }
        };
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
