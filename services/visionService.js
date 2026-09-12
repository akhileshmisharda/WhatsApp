const vision = require('@google-cloud/vision');
const path = require('path');
const fs = require('fs');

// Initialize Google Vision Client (Fallback to Application Default Credentials on Cloud Run)
const keyFilePath = path.join(__dirname, '../google-key.json');
const clientOptions = fs.existsSync(keyFilePath) ? { keyFilename: keyFilePath } : {};
const client = new vision.ImageAnnotatorClient(clientOptions);

/**
 * Header strings to ignore when extracting names and details
 */
const IGNORED_NAME_KEYWORDS = [
    "GOVERNMENT", "INDIA", "BHARAT", "SARKAR", "AUTHORITY", "IDENTIFICATION",
    "UNIQUE", "UIDAI", "ENROLMENT", "HELP", "WWW", "FATHER", "HUSBAND",
    "DOB", "DATE OF BIRTH", "YEAR OF BIRTH", "MALE", "FEMALE", "TRANSGENDER",
    "ADDRESS", "MERI PEHCHAN", "MERA AADHAAR", "DOWNLOAD", "ISSUE DATE"
];

/**
 * Extracts text from an image buffer using Google Vision API and parses key Aadhaar fields
 * @param {Buffer} imageBuffer 
 * @returns {Promise<Object>} Extracted details
 */
async function extractAadhaarDetails(imageBuffer) {
    try {
        const [result] = await client.textDetection(imageBuffer);
        const text = result.fullTextAnnotation ? result.fullTextAnnotation.text : '';

        if (!text) {
            return {
                nameEnglish: "Not Found",
                nameHindi: "Not Found",
                dob: "Not Found",
                genderEnglish: "Not Found",
                genderHindi: "Not Found",
                aadharNumber: "Not Found",
                vidNumber: "Not Found",
                addressEnglish: "Not Found",
                addressHindi: "Not Found",
                pincode: "Not Found"
            };
        }

        console.log("\n--- RAW GOOGLE VISION TEXT ---");
        console.log(text);
        console.log("------------------------------\n");

        const lines = text
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);

        let nameEnglish = "Not Found";
        let nameHindi = "Not Found";

        // ===============================
        // 1. EXTRACT HINDI & ENGLISH NAME
        // ===============================
        // Case A: Letter format with "To" block
        const toIndex = lines.findIndex(l => /^To$/i.test(l) || /^प्रति$/i.test(l));

        if (toIndex !== -1 && toIndex + 2 < lines.length) {
            const possibleHindi = lines[toIndex + 1];
            const possibleEnglish = lines[toIndex + 2];

            if (/[\u0900-\u097F]/.test(possibleHindi)) {
                nameHindi = possibleHindi;
            }
            if (/^[A-Za-z\s.'-]+$/.test(possibleEnglish)) {
                nameEnglish = possibleEnglish;
            }
        }

        // Case B: Standard Aadhaar card format (Name line directly above DOB)
        if (nameEnglish === "Not Found") {
            const dobIndex = lines.findIndex(l => 
                /DOB|Date of Birth|जन्म तिथि|जन्मतिथि|Year of Birth|जन्म वर्ष/i.test(l)
            );

            if (dobIndex > 0) {
                // Check up to 3 lines above DOB for English and Hindi names
                for (let i = dobIndex - 1; i >= Math.max(0, dobIndex - 3); i--) {
                    const line = lines[i];
                    const isIgnored = IGNORED_NAME_KEYWORDS.some(k => line.toUpperCase().includes(k));
                    
                    if (!isIgnored) {
                        if (nameEnglish === "Not Found" && /^[A-Za-z\s.'-]+$/.test(line) && line.length >= 3) {
                            nameEnglish = line;
                        } else if (nameHindi === "Not Found" && /[\u0900-\u097F]/.test(line) && line.length >= 3) {
                            nameHindi = line;
                        }
                    }
                }
            }
        }

        // Case C: Regex fallback for English Name before Relationship / DOB
        if (nameEnglish === "Not Found") {
            const engMatch = text.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)\n+(?:S\/O|C\/O|D\/O|W\/O):/i) ||
                             text.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)\n+(?:जन्म तिथि|DOB|Date of Birth)/i);
            if (engMatch) {
                nameEnglish = engMatch[1].trim();
            }
        }

        // ===============================
        // 2. EXTRACT DOB / YOB
        // ===============================
        let dob = "Not Found";
        const dobMatch = text.match(/(?:DOB|Date of Birth|जन्म तिथि|जन्मतिथि)[^\d]*(\d{2}[\/\-]\d{2}[\/\-]\d{4})/i) ||
                         text.match(/\b(\d{2}[\/\-]\d{2}[\/\-]\d{4})\b/) ||
                         text.match(/(?:Year of Birth|YOB|जन्म वर्ष)[^\d]*(\d{4})/i);
        if (dobMatch) {
            dob = dobMatch[1].trim().replace(/-/g, '/');
        }

        // ===============================
        // 3. EXTRACT GENDER
        // ===============================
        let genderEnglish = "Not Found";
        let genderHindi = "Not Found";

        if (/MALE|पुरुष/i.test(text) && !/FEMALE/i.test(text)) {
            genderEnglish = "Male";
            genderHindi = "पुरुष";
        } else if (/FEMALE|महिला/i.test(text)) {
            genderEnglish = "Female";
            genderHindi = "महिला";
        } else if (/TRANSGENDER/i.test(text)) {
            genderEnglish = "Transgender";
            genderHindi = "ट्रांसजेंडर";
        }

        // ===============================
        // 4. EXTRACT 16-DIGIT VID NUMBER
        // ===============================
        let vidNumber = "Not Found";
        const vidMatch = text.match(/VID\s*:?\s*(\d{4}\s*\d{4}\s*\d{4}\s*\d{4})/i) ||
                         text.match(/VID\s*:?\s*(\d{16})/i);

        if (vidMatch) {
            const rawVidDigits = vidMatch[1].replace(/\D/g, "");
            if (rawVidDigits.length === 16) {
                vidNumber = `${rawVidDigits.slice(0, 4)} ${rawVidDigits.slice(4, 8)} ${rawVidDigits.slice(8, 12)} ${rawVidDigits.slice(12, 16)}`;
            }
        }

        // ===============================
        // 5. EXTRACT 12-DIGIT AADHAAR NUMBER
        // ===============================
        const aadharNumber = extract12DigitAadhaar(text);

        // ===============================
        // 6. EXTRACT ADDRESS & PINCODE
        // ===============================
        let addressEnglish = "Not Found";
        let addressHindi = "Not Found";
        let pincode = "Not Found";

        const pinMatch = text.match(/\b([1-9][0-9]{5})\b/);
        if (pinMatch) {
            pincode = pinMatch[1];
        }

        const engAddressMatch = text.match(/Address:\s*([\s\S]*?\d{6})/i) ||
                                text.match(/(?:S\/O|C\/O|D\/O|W\/O):?\s*([\s\S]*?\d{6})/i);
        if (engAddressMatch) {
            addressEnglish = engAddressMatch[1]
                .replace(/\n+/g, ' ')
                .replace(/^[:\s]*[के\s]+/i, '') 
                .trim();
        }

        const hindiAddressMatch = text.match(/पता:?\s*([\s\S]*?\d{6})/i) ||
                                  text.match(/आत्मज:?\s*([\s\S]*?\d{6})/i);
        if (hindiAddressMatch) {
            addressHindi = hindiAddressMatch[1]
                .replace(/\n+/g, ' ')
                .replace(/^[:\s]*(?:S\/O|C\/O|D\/O|W\/O)+/i, '')
                .trim();
        }

        return {
            nameEnglish,
            nameHindi,
            dob,
            genderEnglish,
            genderHindi,
            aadharNumber,
            vidNumber,
            addressEnglish,
            addressHindi,
            pincode
        };

    } catch (error) {
        console.error("Google Vision API Error:", error);
        throw error;
    }
}

/**
 * Robust 12-digit Aadhaar extraction logic
 */
function extract12DigitAadhaar(rawText) {
    // 1. Flatten all line breaks, blank lines, and tabs into single spaces FIRST
    let cleaned = rawText.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ");

    // 2. Remove VIDs (16-digit blocks) safely so they don't confuse the 12-digit search
    cleaned = cleaned.replace(/VID\s*:?\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}/gi, "")
                     .replace(/VID\s*:?\s*\d{16}/gi, "");

    // 3. Tokenize and search for 3 consecutive 4-digit groups
    const tokens = cleaned.split(" ").map(t => t.trim()).filter(Boolean);

    for (let i = 0; i <= tokens.length - 3; i++) {
        if (/^\d{4}$/.test(tokens[i]) && 
            /^\d{4}$/.test(tokens[i + 1]) && 
            /^\d{4}$/.test(tokens[i + 2])) {
            return `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
        }
    }

    // 4. Fallback 14-character sliding window (Handles "XXXX XXXX XXXX")
    for (let i = 0; i <= cleaned.length - 14; i++) {
        const windowStr = cleaned.substring(i, i + 14);
        if (/^\d{4} \d{4} \d{4}$/.test(windowStr)) {
            return windowStr;
        }
    }

    // 5. Last fallback for 12 continuous digits without spaces
    const continuousMatch = cleaned.match(/\b\d{12}\b/);
    if (continuousMatch) {
        const d = continuousMatch[0];
        return `${d.slice(0, 4)} ${d.slice(4, 8)} ${d.slice(8, 12)}`;
    }

    return "Not Found";
}

module.exports = { extractAadhaarDetails };