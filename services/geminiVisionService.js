const axios = require('axios');
const https = require('https');
const { extractAadhaarDetails: extractAadhaarVision } = require('./visionService');
const { extractPanDetails: extractPanVision } = require('./panvisionService');

const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

let cachedGeminiKey = process.env.GEMINI_API_KEY || null;
let lastKeyFetchTime = 0;

/**
 * Dynamically fetches the Gemini API key from https://fabkraft.in/get_gemini_key.php
 * Caches in memory for 5 minutes.
 */
async function getGeminiApiKey() {
    const now = Date.now();
    if (cachedGeminiKey && (now - lastKeyFetchTime < 300000)) {
        return cachedGeminiKey;
    }

    try {
        console.log('🔑 [GeminiKey] Fetching API key from https://fabkraft.in/get_gemini_key.php...');
        const res = await axios.get('https://fabkraft.in/get_gemini_key.php', {
            httpsAgent,
            timeout: 10000
        });

        let key = null;
        if (typeof res.data === 'string') {
            key = res.data.trim();
        } else if (typeof res.data === 'object' && res.data !== null) {
            key = res.data.key || res.data.api_key || res.data.gemini_key || res.data.apiKey || Object.values(res.data)[0];
        }

        if (key && typeof key === 'string' && key.trim().length > 5) {
            cachedGeminiKey = key.trim();
            lastKeyFetchTime = now;
            console.log(`✅ [GeminiKey] Successfully loaded dynamic key (Prefix: ${cachedGeminiKey.substring(0, 8)}...)`);
            return cachedGeminiKey;
        }
    } catch (err) {
        console.warn(`⚠️ [GeminiKey] Failed to fetch key from fabkraft.in:`, err.message);
    }

    return cachedGeminiKey || process.env.GEMINI_API_KEY || '';
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
                headers: { 
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey
                },
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
                headers: { 
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey
                },
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
