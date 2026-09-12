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
// 1. STATE, SOCKET REF & IN-MEMORY EVENT LOGS
// ---------------------------------------------------------
let sock = null;
let currentBotNumber = "Unknown";
let connectionStatus = "initializing";
let lastConnectedAt = null;
let lastQrGeneratedAt = null;
let qrString = null;
const eventLogs = [];

function logEvent(type, message, data = null) {
    const entry = {
        time: new Date().toISOString(),
        type,
        message,
        data
    };
    eventLogs.unshift(entry);
    if (eventLogs.length > 50) eventLogs.pop();
    console.log(`[${entry.time}] [${type}] ${message}`, data ? JSON.stringify(data) : '');
}

// ---------------------------------------------------------
// 2. EXPRESS HTTP SERVER WITH LIVE DIAGNOSTIC ENDPOINTS
// ---------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// Main Status Endpoint
app.get('/', (req, res) => {
    res.json({
        service: 'Fabkraft WhatsApp ERP Document Parser',
        server_status: 'online',
        whatsapp_status: connectionStatus,
        bot_number: currentBotNumber,
        is_socket_ready: !!sock?.user,
        last_connected: lastConnectedAt,
        last_qr_generated: lastQrGeneratedAt,
        timestamp: new Date().toISOString(),
        diagnostic_urls: {
            view_live_logs: '/logs',
            test_send_message: '/send-test?to=9079377715&text=Hello'
        }
    });
});

// Live Event Logs Endpoint (Viewable directly in your browser)
app.get('/logs', (req, res) => {
    res.json({
        whatsapp_status: connectionStatus,
        bot_number: currentBotNumber,
        is_socket_ready: !!sock?.user,
        recent_events: eventLogs
    });
});

// Test Send Endpoint: Sends a test message and returns exact outcome
app.get('/send-test', async (req, res) => {
    const targetMobile = req.query.to ? req.query.to.replace(/[^0-9]/g, "") : "9079377715";
    const text = req.query.text || "Hello from Fabkraft Cloud Run Bot!";

    if (!sock) {
        return res.status(500).json({
            success: false,
            error: "WhatsApp socket is not initialized yet.",
            status: connectionStatus
        });
    }

    try {
        const jid = `${targetMobile}@s.whatsapp.net`;
        logEvent("OUTGOING_TEST", `Attempting test send to ${jid}`, { text });

        const result = await sock.sendMessage(jid, { text: `🤖 *Test Message:*\n${text}` });
        logEvent("OUTGOING_SUCCESS", `Test message sent successfully to ${jid}`);

        res.json({
            success: true,
            message: `Test message sent to ${targetMobile}`,
            resultId: result?.key?.id,
            status: connectionStatus
        });
    } catch (err) {
        logEvent("OUTGOING_ERROR", `Failed to send test message to ${targetMobile}: ${err.message}`);
        res.status(500).json({
            success: false,
            error: err.message,
            stack: err.stack
        });
    }
});

app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => {
    logEvent("SERVER", `Express server listening on port ${PORT}`);
});

// ---------------------------------------------------------
// 3. WHATSAPP BOT ENGINE
// ---------------------------------------------------------
async function startBot() {
    logEvent("WHATSAPP_INIT", "Initializing WhatsApp Socket with MySQL Auth State...");
    connectionStatus = "connecting";

    let authState, saveCreds;
    try {
        const mySqlAuth = await useMySQLAuthState();
        authState = mySqlAuth.state;
        saveCreds = mySqlAuth.saveCreds;
        logEvent("AUTH_SOURCE", "Using MySQL-backed session storage (wh_baileys_auth)");

        if (authState?.creds?.me?.id) {
            currentBotNumber = authState.creds.me.id.split(':')[0].replace(/[^0-9]/g, "");
            logEvent("AUTH_CREDS", `Loaded existing credentials for: ${currentBotNumber}`);
        }
    } catch (authErr) {
        logEvent("AUTH_ERROR", `MySQL Auth failed, falling back to local: ${authErr.message}`);
        const fileAuth = await useMultiFileAuthState("./auth");
        authState = fileAuth.state;
        saveCreds = fileAuth.saveCreds;
    }

    const { version } = await fetchLatestBaileysVersion();
    const logger = P({ level: "silent" });
    logger.child = () => logger;

    sock = makeWASocket({
        version,
        auth: authState,
        printQRInTerminal: true,
        logger: logger,
        browser: ["Fabkraft Cloud Parser", "Chrome", "1.0"]
    });

    sock.ev.on("creds.update", async () => {
        try {
            await saveCreds();
            logEvent("CREDS_UPDATED", "Credentials saved to MySQL");
        } catch (e) {
            logEvent("CREDS_SAVE_ERROR", e.message);
        }
    });

    sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
        if (qr) {
            connectionStatus = "waiting_for_qr_scan";
            qrString = qr;
            lastQrGeneratedAt = new Date().toISOString();
            logEvent("QR_GENERATED", "QR code generated, waiting for scan");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "open") {
            connectionStatus = "connected";
            lastConnectedAt = new Date().toISOString();
            currentBotNumber = sock.user?.id ? sock.user.id.split(':')[0].replace(/[^0-9]/g, "") : currentBotNumber;
            logEvent("CONNECTED", `WhatsApp Connected Successfully! Bot number: ${currentBotNumber}`);
        }

        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            connectionStatus = shouldReconnect ? "disconnected_reconnecting" : "logged_out";
            logEvent("DISCONNECTED", `Connection closed (Code: ${statusCode}). Reconnecting: ${shouldReconnect}`, {
                error: lastDisconnect?.error?.message
            });

            if (shouldReconnect) {
                setTimeout(startBot, 3000);
            } else {
                logEvent("LOGGED_OUT", "Logged out. Resetting session.");
            }
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        try {
            for (const msg of messages) {
                if (!msg.message) continue;

                // Unwrap nested messages
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
                
                if (!senderJid || senderJid === 'status@broadcast') continue;

                const senderMobile = senderJid.split('@')[0].replace(/[^0-9]/g, "");

                logEvent("MESSAGE_IN", `From: ${senderMobile} | Text: "${rawCaption}" | Image: ${isDirectImage || isQuotedImage}`);

                // 1. Menu / Greeting trigger
                const isGreetingOrMenu = /^(hi|hello|hey|menu|help|start|options|info)\b/i.test(captionText);
                if (isGreetingOrMenu && !isDirectImage && !isQuotedImage) {
                    logEvent("MENU_REPLY", `Sending menu to ${senderMobile}`);
                    await sendMenuResponse(sock, senderJid, msg);
                    continue;
                }

                // 2. Document Tag Detection
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
                } else if (isDirectImage && !isAadhaarTag && !isPanTag) {
                    await sock.sendMessage(senderJid, {
                        text: "📸 *Image received!*\n\nPlease reply to this image with:\n• *`aadhar`* - To process as Aadhaar Card\n• *`pan`* - To process as PAN Card"
                    }, { quoted: msg });
                } else if (!isDirectImage && !isQuotedImage && captionText.length > 0) {
                    await sendMenuResponse(sock, senderJid, msg);
                }
            }
        } catch (err) {
            logEvent("MESSAGE_UPSERT_ERROR", err.message);
        }
    });
}

/**
 * Sends a helpful menu guide to the user
 */
async function sendMenuResponse(sock, replyJid, quotedMsg) {
    const menuText = 
        `👋 *Welcome to Fabkraft Document Assistant!*\n\n` +
        `Here is how you can process your documents automatically:\n\n` +
        `🪪 *1. Aadhaar Card Processing:*\n` +
        `• Send an image of your Aadhaar Card with the caption *\`aadhar\`* or *\`adhar\`*.\n` +
        `• Or reply to any sent Aadhaar photo with *\`aadhar\`*.\n` +
        `• *Extracted:* Name (English & Hindi), DOB, Gender, Aadhaar Number, VID, Address & PIN code.\n\n` +
        `💳 *2. PAN Card Processing:*\n` +
        `• Send an image of your PAN Card with the caption *\`pan\`*.\n` +
        `• Or reply to any sent PAN photo with *\`pan\`*.\n` +
        `• *Extracted:* Name, Father's Name, DOB, PAN Number.\n\n` +
        `🌐 *Uploads & Storage:*\n` +
        `• All images are automatically stored at: \`fabkraft.in/WhatsAppFolder/uploads/\`\n` +
        `• All data records are saved in MySQL database with \`wh_\` tables.\n\n` +
        `_Send your image or type *hi* anytime!_`;

    await sock.sendMessage(replyJid, { text: menuText }, { quoted: quotedMsg });
}

/**
 * Handles Aadhaar Card Image Detection, OCR, Fabkraft Upload, & Database Logging
 */
async function handleAadhaarFlow(sock, imageMsgObj, replyJid, senderMobile, userCaption, quotedRef = null) {
    logEvent("AADHAAR_START", `Processing Aadhaar for ${senderMobile}`);

    await sock.sendMessage(replyJid, {
        text: "⏳ *Aadhaar image detected! Processing OCR and uploading to Fabkraft...*"
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
                text: "⚠️ *Aadhaar Number could not be detected.* Please send a clearer, un-cropped image."
            }, { quoted: quotedRef || imageMsgObj });
            return;
        }

        const cleanAadhaar = extracted.aadharNumber.replace(/\s+/g, "");
        const fileName = `aadhar_${cleanAadhaar}_${Date.now()}.jpg`;

        // 2. Upload directly to fabkraft.in/WhatsAppFolder/uploads/aadhar/
        const uploadResult = await uploadToFabkraft(buffer, fileName, 'aadhar');
        const uploadUri = uploadResult.success ? uploadResult.uploadUri : `https://fabkraft.in/WhatsAppFolder/uploads/aadhar/${fileName}`;

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
            `🪪 *AADHAAR PROCESSED & SAVED*\n\n` +
            `📦 *Database Status:* ${dbResult.action.toUpperCase()}\n` +
            `📱 *QR Bot Account:* ${currentBotNumber}\n` +
            `📲 *Sent By:* ${senderMobile}\n\n` +
            `👤 *Name (English):* ${displayVal(extracted.nameEnglish)}\n` +
            `👤 *Name (Hindi):* ${displayVal(extracted.nameHindi)}\n` +
            `📅 *DOB / YOB:* ${displayVal(extracted.dob)}\n` +
            `🚻 *Gender:* ${displayVal(extracted.genderEnglish)}\n` +
            `🔢 *Aadhaar Number:* ${displayVal(extracted.aadharNumber)}\n` +
            `🔢 *Virtual ID (VID):* ${displayVal(extracted.vidNumber)}\n` +
            `🏠 *Address:* ${displayVal(extracted.addressEnglish)}\n` +
            `📮 *PIN Code:* ${displayVal(extracted.pincode)}\n\n` +
            `🌐 *Uploaded File URI:*\n${uploadUri}`;

        await sock.sendMessage(replyJid, { text: replyText }, { quoted: quotedRef || imageMsgObj });
        logEvent("AADHAAR_COMPLETE", `Aadhaar flow completed for ${senderMobile}`, { aadharNumber: extracted.aadharNumber });

    } catch (err) {
        logEvent("AADHAAR_ERROR", `Failed for ${senderMobile}: ${err.message}`);
        await sock.sendMessage(replyJid, {
            text: "❌ *Failed to process Aadhaar card details.*"
        }, { quoted: quotedRef || imageMsgObj });
    }
}

/**
 * Handles PAN Card Image Detection, OCR, Fabkraft Upload, & Database Logging
 */
async function handlePanFlow(sock, imageMsgObj, replyJid, senderMobile, userCaption, quotedRef = null) {
    logEvent("PAN_START", `Processing PAN for ${senderMobile}`);

    await sock.sendMessage(replyJid, {
        text: "⏳ *PAN Card image detected! Processing OCR and uploading to Fabkraft...*"
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
        const uploadUri = uploadResult.success ? uploadResult.uploadUri : `https://fabkraft.in/WhatsAppFolder/uploads/pan/${fileName}`;

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
            `💳 *PAN CARD PROCESSED & SAVED*\n\n` +
            `📦 *Database Status:* ${dbResult.action.toUpperCase()}\n` +
            `📱 *QR Bot Account:* ${currentBotNumber}\n` +
            `📲 *Sent By:* ${senderMobile}\n\n` +
            `👤 *Name:* ${displayVal(extracted.name)}\n` +
            `👨 *Father's Name:* ${displayVal(extracted.fatherName)}\n` +
            `📅 *Date of Birth:* ${displayVal(extracted.dob)}\n` +
            `🔢 *PAN Number:* ${displayVal(extracted.panNumber)}\n\n` +
            `🌐 *Uploaded File URI:*\n${uploadUri}`;

        await sock.sendMessage(replyJid, { text: replyText }, { quoted: quotedRef || imageMsgObj });
        logEvent("PAN_COMPLETE", `PAN flow completed for ${senderMobile}`, { panNumber: extracted.panNumber });

    } catch (err) {
        logEvent("PAN_ERROR", `Failed for ${senderMobile}: ${err.message}`);
        await sock.sendMessage(replyJid, {
            text: "❌ *Failed to process PAN card details.*"
        }, { quoted: quotedRef || imageMsgObj });
    }
}

// Start WhatsApp Bot
startBot();