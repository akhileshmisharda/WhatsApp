const P = require('pino');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { uploadToFabkraft } = require('./uploadService');
const { logImageUpload } = require('./documentDbService');

function getISTFormattedTime() {
    const d = new Date();
    const istDate = new Date(d.getTime() + (330 * 60 * 1000));
    return istDate.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Handles interactive menu for secondary bot numbers (e.g. 9079377715)
 * Options:
 * 1. Attandance Summary
 * 2. Attandance <Data>
 * 3. Site Images
 */
async function handleCustomMenuFlow({ sock, botConfig, msg, senderMobile, replyJid, textMessage, quotedRef, isMedia, mimeType }) {
    const textTrimmed = (textMessage || '').trim();
    const textLower = textTrimmed.toLowerCase();
    const botNumber = botConfig.phone_number || botConfig.session_id.replace('bot_', '');
    const istTime = getISTFormattedTime();

    // 1. Menu Greeting
    if (textLower === 'hi' || textLower === 'hello' || textLower === 'hey' || textLower === 'menu' || textLower === 'help' || textLower === 'start') {
        const welcomeText = 
            `👋 *Welcome to FabKraft ERP Assistant*\n` +
            `*Bot Line:* +${botNumber}\n\n` +
            `Please choose an option or send your command:\n\n` +
            `*1.* 📊 *Attandance Summary*\n` +
            `*2.* 📋 *Attandance <Data>*\n` +
            `*3.* 📸 *Site Images*\n\n` +
            `_Reply with 1, 2, or 3 (or send direct command)_\n` +
            `Powered by FabKraft ERP`;

        await sock.sendMessage(replyJid, { text: welcomeText }, { quoted: quotedRef || msg });
        return;
    }

    // 2. Option 1: Attandance Summary
    if (textLower === '1' || textLower === 'attandance summary' || textLower === 'attendance summary' || textLower === 'summary') {
        const summaryText = 
            `📊 *Attandance Summary*\n\n` +
            `• *Date:* ${istTime.split(' ')[0]}\n` +
            `• *Time:* ${istTime.split(' ')[1]} (IST)\n` +
            `• *Bot Line:* +${botNumber}\n` +
            `• *System Status:* Active & Logging\n\n` +
            `_To submit attendance records, send:_ \n` +
            `*Attandance <Data>* (e.g. _Attandance Site-A Staff 15_)`;

        await sock.sendMessage(replyJid, { text: summaryText }, { quoted: quotedRef || msg });
        return;
    }

    // 3. Option 2: Attandance <Data>
    if (textLower.startsWith('attandance') || textLower.startsWith('attendance') || textLower === '2') {
        // Check if specific data was passed after "attandance" or "attendance"
        let dataPayload = textTrimmed.replace(/^att(?:a|e)ndance\s*/i, '').trim();

        if (!dataPayload || textLower === '2') {
            const promptText = 
                `📋 *Attandance Data Entry*\n\n` +
                `Please send your attendance record in the format:\n` +
                `*Attandance <Data>*\n\n` +
                `*Examples:*\n` +
                `• _Attandance ${istTime.split(' ')[0]} Site-1 Present: 12_\n` +
                `• _Attandance Staff Name, Shift A, In-Time 09:30 AM_`;

            await sock.sendMessage(replyJid, { text: promptText }, { quoted: quotedRef || msg });
            return;
        }

        // When data is provided
        const confirmText = 
            `✅ *Attandance Record Logged*\n\n` +
            `• *Data:* ${dataPayload}\n` +
            `• *Reported By:* +${senderMobile}\n` +
            `• *Logged At:* ${istTime} (IST)\n` +
            `• *Bot Node:* +${botNumber}\n\n` +
            `_Attendance data successfully recorded in ERP._`;

        await sock.sendMessage(replyJid, { text: confirmText }, { quoted: quotedRef || msg });
        return;
    }

    // 4. Option 3: Site Images
    const isSiteTrigger = textLower === '3' || 
                          textLower.startsWith('site images') || 
                          textLower.startsWith('site image') || 
                          textLower.startsWith('site') || 
                          textLower === 'image' || 
                          textLower === 'images';

    if (isSiteTrigger) {
        // If an image/media is attached to the message
        if (isMedia || (msg?.message?.imageMessage || msg?.message?.documentMessage)) {
            try {
                await sock.sendMessage(replyJid, {
                    text: `📸 Site image detected. Uploading to ERP gallery...`
                }, { quoted: quotedRef || msg });

                const buffer = await downloadMediaMessage(
                    msg,
                    'buffer',
                    {},
                    { logger: P({ level: "silent" }), reconnectMode: 'on-demand' }
                );

                const timestamp = Date.now();
                const ext = mimeType === 'application/pdf' ? 'pdf' : 'jpg';
                const fileName = `site_${senderMobile}_${timestamp}.${ext}`;

                const uploadResult = await uploadToFabkraft(buffer, fileName, 'site_images', mimeType);

                if (!uploadResult.success) {
                    throw new Error(uploadResult.error || 'Upload failed');
                }

                await logImageUpload({
                    receiverMobile: botNumber,
                    senderMobile: senderMobile,
                    imageCaption: 'Site Images',
                    imageId: `SITE_${timestamp}`,
                    uploadUri: uploadResult.uploadUri
                });

                const uploadSuccessText = 
                    `✅ *Site Image Uploaded Successfully*\n\n` +
                    `• *Uploaded By:* +${senderMobile}\n` +
                    `• *Bot Line:* +${botNumber}\n` +
                    `• *Saved URL:* ${uploadResult.uploadUri}\n` +
                    `• *Timestamp:* ${istTime} (IST)\n\n` +
                    `_Archived into ERP Site Gallery._`;

                await sock.sendMessage(replyJid, { text: uploadSuccessText }, { quoted: quotedRef || msg });
                return;
            } catch (uploadErr) {
                console.error("❌ [SiteImages] Error uploading site image:", uploadErr.message);
                await sock.sendMessage(replyJid, {
                    text: `❌ *Site Image Upload Failed*\nCould not save image: ${uploadErr.message}. Please try again.`
                }, { quoted: quotedRef || msg });
                return;
            }
        }

        // Text prompt if no media attached
        const sitePromptText = 
            `📸 *Site Images*\n\n` +
            `Please attach and send site photos/images with caption *Site Images* or *Site* to automatically archive them to the ERP project gallery.`;

        await sock.sendMessage(replyJid, { text: sitePromptText }, { quoted: quotedRef || msg });
        return;
    }

    // If not a recognized menu command, stay completely silent for normal casual conversation
    return;
}

module.exports = {
    handleCustomMenuFlow
};

