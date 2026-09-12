const axios = require('axios');
const FormData = require('form-data');

const FABKRAFT_UPLOAD_URL = process.env.FABKRAFT_UPLOAD_URL || 'https://fabkraft.in/WhatsAppFolder/upload.php';

/**
 * Uploads an image buffer directly to fabkraft.in/WhatsAppFolder/uploads/
 * @param {Buffer} buffer - Image file buffer
 * @param {string} fileName - Desired filename
 * @param {string} category - Category subfolder ('aadhar', 'pan', 'general')
 * @returns {Promise<{success: boolean, uploadUri?: string, error?: string}>}
 */
async function uploadToFabkraft(buffer, fileName, category = 'general') {
    try {
        const form = new FormData();
        form.append('file', buffer, { filename: fileName });
        form.append('fileName', fileName);
        form.append('category', category);

        const response = await axios.post(FABKRAFT_UPLOAD_URL, form, {
            headers: form.getHeaders(),
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 60000
        });

        if (response.data && response.data.status === 'success') {
            console.log(`✅ [UploadService] Successfully uploaded to Fabkraft: ${response.data.upload_uri}`);
            return {
                success: true,
                uploadUri: response.data.upload_uri,
                fileName: response.data.fileName
            };
        } else {
            console.error(`❌ [UploadService] Server error:`, response.data);
            return {
                success: false,
                error: response.data?.message || 'Unknown server upload error'
            };
        }
    } catch (err) {
        console.error(`❌ [UploadService] Failed to upload to Fabkraft:`, err.message);
        return {
            success: false,
            error: err.message
        };
    }
}

module.exports = { uploadToFabkraft };