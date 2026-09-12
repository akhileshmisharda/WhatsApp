const axios = require('axios');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AQ.Ab8RN6LN2HSUHjVSqjwTH-wFSKetRUpJlDn2_okpkDJ0-ZjMKg';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

/**
 * Extracts structured Aadhaar details from an image buffer using Gemini 1.5 Flash
 * @param {Buffer} buffer - Image buffer
 * @returns {Promise<Object>}
 */
async function extractAadhaarWithGemini(buffer) {
    try {
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
  "pincode": "6-digit Indian postal PIN code or null",
  "card_side": "front / back / both / unknown"
}

Output ONLY raw valid JSON without markdown formatting or code blocks.
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

        const response = await axios.post(GEMINI_API_URL, requestBody, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
        });

        const textResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const cleanedJsonStr = textResponse.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
        const parsed = JSON.parse(cleanedJsonStr);

        return {
            success: true,
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
                pincode: parsed.pincode || "Not Found",
                cardSide: parsed.card_side || "front"
            }
        };
    } catch (err) {
        console.error("❌ [GeminiVision] Aadhaar Extraction Error:", err.response?.data || err.message);
        return {
            success: false,
            error: err.message,
            data: {
                aadharNumber: "Not Found",
                nameEnglish: "Not Found",
                dob: "Not Found"
            }
        };
    }
}

/**
 * Extracts structured PAN details from an image buffer using Gemini 1.5 Flash
 * @param {Buffer} buffer - Image buffer
 * @returns {Promise<Object>}
 */
async function extractPanWithGemini(buffer) {
    try {
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

Output ONLY raw valid JSON without markdown formatting or code blocks.
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

        const response = await axios.post(GEMINI_API_URL, requestBody, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
        });

        const textResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const cleanedJsonStr = textResponse.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
        const parsed = JSON.parse(cleanedJsonStr);

        return {
            success: true,
            data: {
                panNumber: parsed.pan_number || "Not Found",
                name: parsed.name || "Not Found",
                fatherName: parsed.father_name || "Not Found",
                dob: parsed.dob || "Not Found"
            }
        };
    } catch (err) {
        console.error("❌ [GeminiVision] PAN Extraction Error:", err.response?.data || err.message);
        return {
            success: false,
            error: err.message,
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

