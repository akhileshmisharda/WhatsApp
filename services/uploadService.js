const axios = require('axios');
const FormData = require('form-data');
const https = require('https');
const http = require('http');

const FABKRAFT_UPLOAD_URL = process.env.FABKRAFT_UPLOAD_URL || 'https://fabkraft.in/WhatsAppFolder/upload.php';

// Bypass self-signed or unverified SSL certificate issues on fabkraft.in
const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});
const httpAgent = new http.Agent();

/**
 * Uploads an image buffer directly to fabkraft.in/WhatsAppFolder/uploads/
 * @param {Buffer} buffer - Image file buffer
 * @param {string} fileName - Desired filename
 * @param {string} category - Category subfolder ('aadhar', 'pan', 'general')
 * @returns {Promise<{success: boolean, uploadUri?: string, error?: string}>}
 */
async function uploadToFabkraft(buffer, fileName, category = 'general', mimeType = null) {
    try {
        const isPdf = fileName.toLowerCase().endsWith('.pdf') || mimeType === 'application/pdf';
        const contentType = mimeType || (isPdf ? 'application/pdf' : 'image/jpeg');

        const form = new FormData();
        form.append('file', buffer, { filename: fileName, contentType: contentType });
        form.append('fileName', fileName);
        form.append('category', category);

        console.log(`📤 [UploadService] Sending ${fileName} to ${FABKRAFT_UPLOAD_URL}...`);

        const response = await axios.post(FABKRAFT_UPLOAD_URL, form, {
            headers: form.getHeaders(),
            httpsAgent: httpsAgent,
            httpAgent: httpAgent,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 60000
        });

        console.log(`📥 [UploadService] Server Response:`, response.data);

        if (response.data && response.data.status === 'success') {
            console.log(`✅ [UploadService] Successfully uploaded to Fabkraft: ${response.data.upload_uri}`);
            return {
                success: true,
                uploadUri: response.data.upload_uri,
                fileName: response.data.fileName
            };
        } else {
            console.error(`❌ [UploadService] Upload failed on server:`, response.data);
            return {
                success: false,
                error: response.data?.message || 'Server returned non-success status'
            };
        }
    } catch (err) {
        console.error(`❌ [UploadService] Request failed:`, err.message);
        return {
            success: false,
            error: err.message
        };
    }
}

module.exports = { uploadToFabkraft };