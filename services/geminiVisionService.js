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
 * Extracts structured Aadhaar details using Gemini 3.1 Flash-Lite with automatic Vision fallback
 * @param {Buffer} buffer - Image buffer
 * @returns {Promise<Object>}
 */
async function extractAadhaarWithGemini(buffer) {
    const apiKey = await getGeminiApiKey();
    const base64Data = buffer.toString('base64');
    const prompt = `
Analyze this Indian Aadhaar Card image and extract the following details into valid JSON format.
If a field is not visible or not found, set its value to null.

JSON Schema:
{
  "aadhar_number": "12-digit clean number formatted as XXXX XXXX XXXX or null",
  "vid_number": "16-digit Virtual ID if present or null",
  "name_english": "Full name in English or null",
  "name_hindi": "Full name in Hindi (Devanagari) or null",
  "dob": "Date of birth in DD/MM/YYYY format or Year of birth or null",
  "gender_english": "Male / Female / Transgender or null",
  "gender_hindi": "पुरुष / महिला / ट्रांसजेंडर or null",
  "address_english": "Complete address in English or null",
  "address_hindi": "Complete address in Hindi or null",
  "pincode": "6-digit Indian postal PIN code or null"
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

            console.log(`✅ [Gemini] Successfully extracted Aadhaar using ${model}`);
            return {
                success: true,
                engine: `Gemini (${model})`,
                data: {
                    aadharNumber: parsed.aadhar_number || "Not Found",
                    vidNumber: parsed.vid_number || "Not Found",
                    nameEnglish: parsed.name_english || "Not Found",
                    nameHindi: parsed.name_hindi || "Not Found",
                    dob: parsed.dob || "Not Found",
                    genderEnglish: parsed.gender_english || "Not Found",
                    genderHindi: parsed.gender_hindi || "Not Found",
                    addressEnglish: parsed.address_english || "Not Found",
                    addressHindi: parsed.address_hindi || "Not Found",
                    pincode: parsed.pincode || "Not Found"
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
