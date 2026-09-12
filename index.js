const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const path = require('path');
const P = require('pino');
const qrcode = require('qrcode-terminal');

const {
    default: makeWASocket,
    fetchLatestBaileysVersion,
    DisconnectReason,
    downloadMediaMessage,
    useMultiFileAuthState
} = require('@whiskeysockets/baileys');

// Services
const pool = require('./services/db');
const { useMySQLAuthState } = require('./services/mysqlAuthService');
const { uploadToFabkraft } = require('./services/uploadService');
const { extractAadhaarDetails } = require('./services/visionService');
const { extractPanDetails } = require('./services/panvisionService');
const {
    logImageUpload,
    insertOrUpdateAadhaar,
    insertOrUpdatePan
} = require('./services/documentDbService');

// ---------------------------------------------------------
// 1. EXPRESS HTTP SERVER (Mandatory for Cloud Run Port 8080)
// ---------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

app.get('/', (req, res) => {
    res.json({
        status: 'online',
        service: 'Fabkraft WhatsApp ERP Document Parser',
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => {
    console.log(`🌐 Express server listening on port ${PORT}`);
});

// ---------------------------------------------------------
// 2. WHATSAPP BOT ENGINE
// ---------------------------------------------------------
let currentBotNumber = "Unknown";

async function startBot() {
    console.log("🚀 Initializing WhatsApp Socket with MySQL Auth State...");

    let authState, saveCreds;
    try {
        const mySqlAuth = await useMySQLAuthState();
        authState = mySqlAuth.state;
        saveCreds = mySqlAuth.saveCreds;
        console.log("✅ Using MySQL-backed session storage (wh_baileys_auth)");
    } catch (authErr) {
        console.warn("⚠️ MySQL Auth failed, falling back to local ./auth folder:", authErr.message);
        const fileAuth = await useMultiFileAuthState("./auth");
        authState = fileAuth.state;
        saveCreds = fileAuth.saveCreds;
    }

    const { version } = await fetchLatestBaileysVersion();
    const logger = P({ level: "silent" });
    logger.child = () => logger;

    const sock = makeWASocket({
        version,
        auth: authState,
        printQRInTerminal: true,
        logger: logger,
        browser: ["Fabkraft Cloud Parser", "Chrome", "1.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
        if (qr) {
            console.log("\n======================================");
            console.log("      PLEASE SCAN QR CODE BELOW       ");
            console.log("======================================\n");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "open") {
            currentBotNumber = sock.user?.id ? sock.user.id.split(':')[0].replace(/[^0-9]/g, "") : "Unknown";
            console.log("\n======================================");
            console.log("✅ WhatsApp Connected Successfully!");
            console.log(`📱 QR Code Bot Mobile Number: ${currentBotNumber}`);
            console.log("🤖 Ready for Aadhaar & PAN Processing & Fabkraft Uploads...");
            console.log("======================================\n");
        }

        if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ Connection closed. Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                startBot();
            } else {
                console.log("❌ Logged out. Resetting session credentials.");
            }
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        try {
            if (type !== "notify") return;
            const msg = messages[0];
            if (!msg.message) return;

            // Unwrap nested messages (viewOnce, ephemeral, etc.)
            let messageContent = msg.message;
            while (
                messageContent?.ephemeralMessage?.message ||
                messageContent?.viewOnceMessage?.message ||
                messageContent?.viewOnceMessageV2?.message ||
                messageContent?.documentWithCaptionMessage?.message
            ) {
                messageContent = 
                    messageContent.ephemeralMessage?.message ||
                    messageContent.viewOnceMessage?.message ||
                    messageContent.viewOnceMessageV2?.message ||
                    messageContent.documentWithCaptionMessage?.message;
            }

            const quotedMsg = messageContent?.extendedTextMessage?.contextInfo?.quotedMessage;
            const isQuotedImage = !!quotedMsg?.imageMessage;
            const isDirectImage = !!messageContent?.imageMessage;

            const rawCaption = 
                messageContent?.imageMessage?.caption ||
                messageContent?.conversation ||
                messageContent?.extendedTextMessage?.text ||
                "";

            const captionText = rawCaption.trim().toLowerCase();
            const senderJid = msg.key.remoteJid;
            const senderMobile = senderJid ? senderJid.split('@')[0].replace(/[^0-9]/g, "") : "Unknown";

            const isAadhaarTag = captionText.includes("aadhar") || captionText.includes("adhar");
            const isPanTag = captionText.includes("pan");

            let targetMsgObj = msg;
            let quotedRef = null;

            if (isQuotedImage) {
                targetMsgObj = {
                    message: quotedMsg,
                    key: {
                        remoteJid: senderJid,
                        id: messageContent.extendedTextMessage.contextInfo.stanzaId,
                        participant: messageContent.extendedTextMessage.contextInfo.participant
                    }
                };
                quotedRef = msg;
            }

            if ((isDirectImage || isQuotedImage) && isAadhaarTag) {
                await handleAadhaarFlow(sock, targetMsgObj, senderJid, senderMobile, rawCaption, quotedRef);
            } else if ((isDirectImage || isQuotedImage) && isPanTag) {
                await handlePanFlow(sock, targetMsgObj, senderJid, senderMobile, rawCaption, quotedRef);
            }
        } catch (err) {
            console.error("❌ Message Upsert Error:", err.message);
        }
    });
}

/**
 * Handles Aadhaar Card Image Detection, OCR, Fabkraft Upload, & Database Logging
 */
async function handleAadhaarFlow(sock, imageMsgObj, replyJid, senderMobile, userCaption, quotedRef = null) {
    console.log(`🪪 Aadhaar detected from ${senderMobile}...`);

    await sock.sendMessage(replyJid, {
        text: "⏳ *Aadhaar image detected! Processing and uploading to Fabkraft...*"
    }, { quoted: quotedRef || imageMsgObj });

    try {
        const buffer = await downloadMediaMessage(
            imageMsgObj,
            'buffer',
            {},
            { logger: P({ level: "silent" }), reconnectMode: 'on-demand' }
        );

        // 1. OCR Extraction
        const extracted = await extractAadhaarDetails(buffer);

        if (extracted.aadharNumber === "Not Found") {
            await sock.sendMessage(replyJid, {
                text: "⚠️ *Aadhaar Number could not be detected.* Please send a clearer image."
            }, { quoted: quotedRef || imageMsgObj });
            return;
        }

        const cleanAadhaar = extracted.aadharNumber.replace(/\s+/g, "");
        const fileName = `aadhar_${cleanAadhaar}_${Date.now()}.jpg`;

        // 2. Upload directly to fabkraft.in/WhatsAppFolder/uploads/aadhar/
        const uploadResult = await uploadToFabkraft(buffer, fileName, 'aadhar');
        const uploadUri = uploadResult.success ? uploadResult.uploadUri : `LOCAL_ONLY_${fileName}`;

        // 3. Insert into wh_uploads
        const uploadId = await logImageUpload({
            receiverMobile: currentBotNumber,
            senderMobile: senderMobile,
            imageCaption: userCaption || 'Aadhar Card',
            imageId: extracted.aadharNumber,
            uploadUri: uploadUri
        });

        // 4. Upsert into wh_aadhar_records
        const dbResult = await insertOrUpdateAadhaar({
            uploadId,
            aadharNumber: extracted.aadharNumber,
            virtualId: extracted.vidNumber,
            nameEnglish: extracted.nameEnglish,
            nameHindi: extracted.nameHindi,
            dob: extracted.dob,
            genderEnglish: extracted.genderEnglish,
            genderHindi: extracted.genderHindi,
            addressEnglish: extracted.addressEnglish,
            addressHindi: extracted.addressHindi,
            pincode: extracted.pincode,
            senderMobile: senderMobile,
            receiverMobile: currentBotNumber,
            uploadUri: uploadUri
        });

        const displayVal = (val) => (val && String(val).trim().length > 0 && val !== "Not Found") ? val : "Not Available";

        const replyText = 
            `🪪 *AADHAAR PROCESSED & UPLOADED*\n\n` +
            `📦 *Database Status:* ${dbResult.action.toUpperCase()}\n` +
            `📱 *QR Bot Account:* ${currentBotNumber}\n` +
            `📲 *Sent By:* ${senderMobile}\n\n` +
            `👤 *Name (English):* ${displayVal(extracted.nameEnglish)}\n` +
            `👤 *Name (Hindi):* ${displayVal(extracted.nameHindi)}\n` +
            `📅 *DOB / YOB:* ${displayVal(extracted.dob)}\n` +
            `🚻 *Gender:* ${displayVal(extracted.genderEnglish)}\n` +
            `🔢 *Aadhaar Number:* ${displayVal(extracted.aadharNumber)}\n` +
            `🔢 *Virtual ID (VID):* ${displayVal(extracted.vidNumber)}\n` +
            `🏠 *Address:* ${displayVal(extracted.addressEnglish)}\n\n` +
            `🌐 *Uploaded File URI:*\n${uploadUri}`;

        await sock.sendMessage(replyJid, { text: replyText }, { quoted: quotedRef || imageMsgObj });
        console.log(`✅ Aadhaar flow completed for ${senderMobile}`);

    } catch (err) {
        console.error("❌ Aadhaar processing failed:", err.message);
        await sock.sendMessage(replyJid, {
            text: "❌ *Failed to process Aadhaar card details.*"
        }, { quoted: quotedRef || imageMsgObj });
    }
}

/**
 * Handles PAN Card Image Detection, OCR, Fabkraft Upload, & Database Logging
 */
async function handlePanFlow(sock, imageMsgObj, replyJid, senderMobile, userCaption, quotedRef = null) {
    console.log(`💳 PAN Card detected from ${senderMobile}...`);

    await sock.sendMessage(replyJid, {
        text: "⏳ *PAN Card image detected! Processing and uploading to Fabkraft...*"
    }, { quoted: quotedRef || imageMsgObj });

    try {
        const buffer = await downloadMediaMessage(
            imageMsgObj,
            'buffer',
            {},
            { logger: P({ level: "silent" }), reconnectMode: 'on-demand' }
        );

        // 1. OCR Extraction
        const extracted = await extractPanDetails(buffer);

        if (extracted.panNumber === "Not Found") {
            await sock.sendMessage(replyJid, {
                text: "⚠️ *PAN Number could not be detected.* Please send a clearer image."
            }, { quoted: quotedRef || imageMsgObj });
            return;
        }

        const cleanPan = extracted.panNumber.replace(/\s+/g, "");
        const fileName = `pan_${cleanPan}_${Date.now()}.jpg`;

        // 2. Upload directly to fabkraft.in/WhatsAppFolder/uploads/pan/
        const uploadResult = await uploadToFabkraft(buffer, fileName, 'pan');
        const uploadUri = uploadResult.success ? uploadResult.uploadUri : `LOCAL_ONLY_${fileName}`;

        // 3. Insert into wh_uploads
        const uploadId = await logImageUpload({
            receiverMobile: currentBotNumber,
            senderMobile: senderMobile,
            imageCaption: userCaption || 'Pan Card',
            imageId: extracted.panNumber,
            uploadUri: uploadUri
        });

        // 4. Upsert into wh_pan_records
        const dbResult = await insertOrUpdatePan({
            uploadId,
            panNumber: extracted.panNumber,
            name: extracted.name,
            fatherName: extracted.fatherName,
            dob: extracted.dob,
            senderMobile: senderMobile,
            receiverMobile: currentBotNumber,
            uploadUri: uploadUri
        });

        const displayVal = (val) => (val && String(val).trim().length > 0 && val !== "Not Found") ? val : "Not Available";

        const replyText = 
            `💳 *PAN CARD PROCESSED & UPLOADED*\n\n` +
            `📦 *Database Status:* ${dbResult.action.toUpperCase()}\n` +
            `📱 *QR Bot Account:* ${currentBotNumber}\n` +
            `📲 *Sent By:* ${senderMobile}\n\n` +
            `👤 *Name:* ${displayVal(extracted.name)}\n` +
            `👨 *Father's Name:* ${displayVal(extracted.fatherName)}\n` +
            `📅 *Date of Birth:* ${displayVal(extracted.dob)}\n` +
            `🔢 *PAN Number:* ${displayVal(extracted.panNumber)}\n\n` +
            `🌐 *Uploaded File URI:*\n${uploadUri}`;

        await sock.sendMessage(replyJid, { text: replyText }, { quoted: quotedRef || imageMsgObj });
        console.log(`✅ PAN flow completed for ${senderMobile}`);

    } catch (err) {
        console.error("❌ PAN processing failed:", err.message);
        await sock.sendMessage(replyJid, {
            text: "❌ *Failed to process PAN card details.*"
        }, { quoted: quotedRef || imageMsgObj });
    }
}

// Start WhatsApp Bot
startBot();