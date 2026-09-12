const vision = require('@google-cloud/vision');
const path = require('path');
const fs = require('fs');

const keyFilePath = path.join(__dirname, '../google-key.json');
const clientOptions = fs.existsSync(keyFilePath) ? { keyFilename: keyFilePath } : {};
const client = new vision.ImageAnnotatorClient(clientOptions);

/**
 * Extracts Name, Father's Name, DOB, and PAN Number from an image buffer.
 */
async function extractPanDetails(imageBuffer) {
    try {
        const [result] = await client.textDetection(imageBuffer);
        const text = result.fullTextAnnotation ? result.fullTextAnnotation.text : '';

        if (!text) {
            return {
                panNumber: "Not Found",
                name: "Not Found",
                fatherName: "Not Found",
                dob: "Not Found"
            };
        }

        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        let panNumber = "Not Found";
        let name = "Not Found";
        let fatherName = "Not Found";
        let dob = "Not Found";

        const panRegex = /[A-Z]{5}[0-9]{4}[A-Z]{1}/;
        const dobRegex = /\b(0[1-9]|[12][0-9]|3[01])[\/\-.](0[1-9]|1[012])[\/\-.](19|20)\d\d\b/;

        const panMatch = text.match(panRegex);
        if (panMatch) {
            panNumber = panMatch[0];
        }

        const dobMatch = text.match(dobRegex);
        if (dobMatch) {
            dob = dobMatch[0].replace(/[\-.]/g, '/');
        }

        const cleanLines = lines.filter(line => 
            !line.toUpperCase().includes("INCOME TAX") &&
            !line.toUpperCase().includes("GOVT") &&
            !line.toUpperCase().includes("INDIA") &&
            !line.toUpperCase().includes("DEPARTMENT") &&
            !line.toUpperCase().includes("PERMANENT ACCOUNT") &&
            !line.toUpperCase().includes("CARD") &&
            !panRegex.test(line) &&
            !dobRegex.test(line)
        );

        if (cleanLines.length >= 1) {
            name = cleanLines[0];
        }
        if (cleanLines.length >= 2) {
            fatherName = cleanLines[1];
        }

        return {
            panNumber,
            name,
            fatherName,
            dob
        };

    } catch (error) {
        console.error("❌ PAN Vision Extraction Error:", error.message);
        return {
            panNumber: "Not Found",
            name: "Not Found",
            fatherName: "Not Found",
            dob: "Not Found"
        };
    }
}

module.exports = { extractPanDetails };