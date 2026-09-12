const mediaService = require("../services/mediaService");
const uploadService = require("../services/uploadService");
const { extractAadhaarDetails } = require("../services/ocrService");

module.exports = {
    handleMedia: async ({ sock, msg, employee, wa }) => {
        const mediaType = wa.getMediaType(msg);
        if (!mediaType) return;

        // Extract caption or text from message
        const captionText = wa.getText(msg).trim().toLowerCase();
        
        // Target Chat JID (sender) & Admin JID
        const senderJid = msg.key.remoteJid;
        const adminJid = "919610238234@s.whatsapp.net";

        // Fetch Group Name if message originates from a WhatsApp Group
        const groupName = await wa.getGroupName(sock, msg);
        const isGroup = senderJid.endsWith('@g.us');
        
        let senderMobile = "Unknown";
        let employeeName = employee && employee.name ? employee.name : "Not Registered / Unknown";

        if (employee && employee.mobile) {
            senderMobile = employee.mobile;
        } else if (isGroup && msg.key.participant) {
            senderMobile = msg.key.participant.replace('@s.whatsapp.net', '').replace('@lid', '');
        } else if (!isGroup) {
            senderMobile = senderJid.replace('@s.whatsapp.net', '').replace('@lid', '');
        }

        const sourceContext = groupName ? `Group: ${groupName}` : `Direct Private Chat`;

        console.log("\nDownloading Media...");
        const result = await mediaService.saveMedia(sock, msg, mediaType);

        if (result.success) {
            console.log("Local Save Success:", result.filePath);

            // --- 🪪 AADHAAR OCR PROCESSING BRANCH ---
            if (mediaType === 'image' && (captionText.includes('aadhar card') || captionText.includes('aadhaar card'))) {
                try {
                    // Send processing status to sender
                    await sock.sendMessage(senderJid, { 
                        text: "⏳ *Processing Aadhaar Card image... Please wait.*" 
                    }, { quoted: msg });

                    // Extract fields from downloaded image
                    const details = await extractAadhaarDetails(result.filePath);

                    // Formulate response to send back to the user
                    const responseMessage = 
                        `🪪 *Aadhaar Details Extracted Successfully*\n\n` +
                        `👤 *Name:* ${details.name}\n` +
                        `📅 *DOB / YOB:* ${details.dob}\n` +
                        `🚻 *Gender:* ${details.gender}\n` +
                        `🔢 *Aadhaar Number:* [Aadhaar Redacted]`;

                    // Send extracted information back to sender
                    await sock.sendMessage(senderJid, { text: responseMessage }, { quoted: msg });

                } catch (ocrError) {
                    console.error("❌ Aadhaar extraction error:", ocrError.message);
                    await sock.sendMessage(senderJid, { 
                        text: "❌ *Failed to extract details from Aadhaar image.* Please make sure the image is clear and well-lit." 
                    }, { quoted: msg });
                }
            }

            // --- SERVER UPLOAD ROUTINE ---
            console.log("Uploading to Server...");
            const upload = await uploadService.uploadMedia(
                result.filePath,
                senderMobile,
                mediaType,
                groupName || "Direct Chat"
            );

            if (upload.success) {
                console.log("✅ Upload Successful - Notifying Admin");
                
                await sock.sendMessage(adminJid, {
                    text: `✅ *MEDIA UPLOAD SUCCESS*\n\n` +
                          `👤 *Employee Name:* ${employeeName}\n` +
                          `📱 *Mobile Number:* ${senderMobile}\n` +
                          `🏠 *Source:* ${sourceContext}\n` +
                          `📁 *Media Type:* ${mediaType}\n` +
                          `⚙️ *Server Status:* Uploaded successfully\n` +
                          `🕒 *Time:* ${new Date().toLocaleString("en-IN")}`
                });

            } else {
                console.log("❌ Upload Failed / Rejected by Server - Notifying Admin");
                
                const serverReason = (upload.response && (upload.response.message || upload.response.error)) || "Server rejected upload";

                await sock.sendMessage(adminJid, {
                    text: `❌ *MEDIA UPLOAD REJECTED / FAILED*\n\n` +
                          `👤 *Employee Name:* ${employeeName}\n` +
                          `📱 *Mobile Number:* ${senderMobile}\n` +
                          `🏠 *Source:* ${sourceContext}\n` +
                          `📁 *Media Type:* ${mediaType}\n` +
                          `⚠️ *Reason:* ${serverReason}\n` +
                          `🕒 *Time:* ${new Date().toLocaleString("en-IN")}`
                });
            }
        } else {
            console.log("❌ Local Save Failed - Notifying Admin");
            
            await sock.sendMessage(adminJid, {
                text: `❌ *LOCAL MEDIA SAVE FAILED*\n\n` +
                      `👤 *Employee Name:* ${employeeName}\n` +
                      `📱 *Mobile Number:* ${senderMobile}\n` +
                      `🏠 *Source:* ${sourceContext}\n` +
                      `⚠️ *Error:* Failed to process/save incoming ${mediaType} locally.\n` +
                      `🕒 *Time:* ${new Date().toLocaleString("en-IN")}`
            });
        }
    }
};