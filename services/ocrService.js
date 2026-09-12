// services/ocrService.js
const { createWorker } = require('tesseract.js');

/**
 * Extracts standard text fields from an Aadhaar card image buffer.
 * @param {Buffer} imageBuffer 
 * @returns {Promise<Object>} Formatted fields object
 */
async function extractAadhaarDetails(imageBuffer) {
    const worker = await createWorker('eng');
    
    try {
        const { data: { text } } = await worker.recognize(imageBuffer);
        await worker.terminate();

        // Regex parsing patterns
        const nameMatch = text.match(/(?:To|Name|GOVERNMENT OF INDIA|UNIQUE IDENTIFICATION AUTHORITY OF INDIA)\n+([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)/i) 
                          || text.match(/([A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)+)/);
                          
        const dobMatch = text.match(/(?:DOB|Date of Birth|Year of Birth)[:\s]*(\d{2}\/\d{2}\/\d{4}|\d{4})/i);
        const genderMatch = text.match(/\b(Male|Female|Transgender)\b/i);

        return {
            name: nameMatch ? nameMatch[1].trim() : "Not Found",
            dob: dobMatch ? dobMatch[1].trim() : "Not Found",
            gender: genderMatch ? genderMatch[1].trim() : "Not Found",
            rawText: text
        };
    } catch (error) {
        await worker.terminate();
        throw error;
    }
}

module.exports = { extractAadhaarDetails };