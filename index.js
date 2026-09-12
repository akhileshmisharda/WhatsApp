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
// 1. STATE & EVENT LOGS
// ---------------------------------------------------------
let sock = null;
let currentBotNumber = "Unknown";
let connectionStatus = "initializing";
let lastConnectedAt = null;
let lastQrGeneratedAt = null;
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
// 2. EXPRESS HTTP SERVER (Cloud Run Entry & Diagnostics)
// ---------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

app.get('/', (req, res) => {
    res.json({
        service: 'Fabkraft WhatsApp ERP Document Parser',
        server_status: 'online',
        whatsapp_status: connectionStatus,
        bot_number: currentBotNumber,
        is_socket_ready: !!sock?.user,
        last_connected: lastConnectedAt,
        last_qr_generated: lastQrGeneratedAt,
        timestamp: new Date().toISOString()
    });
});

app.get('/logs', (req, res) => {
    res.json({
        whatsapp_status: connectionStatus,
        bot_number: currentBotNumber,
        is_socket_ready: !!sock?.user,
        recent_events: eventLogs
    });
});

app.get('/send-test', async (req, res) => {
    let targetMobile = req.query.to ? req.query.to.replace(/[^0-9]/g, "") : "919079377715";
    if (targetMobile.length === 10) targetMobile = `91${targetMobile}`;
    const text = req.query.text || "Hello from Fabkraft Cloud Run Bot!";

    if (!sock || connectionStatus !== "connected") {
        return res.status(503).json({
            success: false,
            error: "WhatsApp socket is currently not connected (Status: " + connectionStatus + ").",
            status: connectionStatus
        });
    }

    try {
        const jid = `${targetMobile}@s.whatsapp.net`;
        logEvent("OUTGOING_TEST", `Sending test message to ${jid}`, { text });

        const result = await sock.sendMessage(jid, { text: `🤖 *Test Message:*\n${text}` });
        logEvent("OUTGOING_SUCCESS", `Test message delivered to ${jid}`);

        res.json({
            success: true,
            message: `Test message sent to ${targetMobile}`,
            resultId: result?.key?.id,
            status: connectionStatus
        });
    } catch (err) {
        logEvent("OUTGOING_ERROR", `Failed to send to ${targetMobile}: ${err.message}`);
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
// 3. EXTRACT TEXT & MEDIA HELPER
// ---------------------------------------------------------
function getMessageDetails(msg) {
    if (!msg?.message) return { text: "", isImage: false, imageMessage: null };

    let content = msg.message;
    while (
        content?.ephemeralMessage?.message ||
        content?.viewOnceMessage?.message ||
        content?.viewOnceMessageV2?.message ||
        content?.documentWithCaptionMessage?.message
    ) {
        content = 
            content.ephemeralMessage?.message ||
            content.viewOnceMessage?.message ||
            content.viewOnceMessageV2?.message ||
            content.documentWithCaptionMessage?.message;
    }

    const text = 
        content?.conversation ||
        content?.extendedTextMessage?.text ||
        content?.imageMessage?.caption ||
        content?.documentMessage?.caption ||
        content?.videoMessage?.caption ||
        "";

    const isImage = !!content?.imageMessage;
    const quotedMsg = content?.extendedTextMessage?.contextInfo?.quotedMessage;
    const isQuotedImage = !!quotedMsg?.imageMessage;

    return {
        text: text.trim(),
        isImage: isImage || isQuotedImage,
        imageMessage: content?.imageMessage || quotedMsg?.imageMessage || null,
        isQuotedImage,
        quotedMsg,
        contextInfo: content?.extendedTextMessage?.contextInfo
    };
}

// ---------------------------------------------------------
// 4. WHATSAPP BOT ENGINE
// ---------------------------------------------------------
async function startBot() {
    logEvent("WHATSAPP_INIT", "Starting WhatsApp Socket with MySQL Auth State...");
    connectionStatus = "connecting";

    let authState, saveCreds;
    try {
        const mySqlAuth = await useMySQLAuthState();
        authState = mySqlAuth.state;
        saveCreds = mySqlAuth.saveCreds;
        logEvent("AUTH_SOURCE", "Using MySQL session (wh_baileys_auth)");

        if (authState?.creds?.me?.id) {
            currentBotNumber = authState.creds.me.id.split(':')[0].replace(/[^0-9]/g, "");
            logEvent("AUTH_CREDS", `Credentials loaded for: ${currentBotNumber}`);
        }
    } catch (authErr) {
        logEvent("AUTH_ERROR", `MySQL Auth failed, fallback to local: ${authErr.message}`);
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
        keepAliveIntervalMs: 25000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
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
            lastQrGeneratedAt = new Date().toISOString();
            logEvent("QR_GENERATED", "QR code waiting for scan");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "open") {
            connectionStatus = "connected";
            lastConnectedAt = new Date().toISOString();
            currentBotNumber = sock.user?.id ? sock.user.id.split(':')[0].replace(/[^0-9]/g, "") : currentBotNumber;
            logEvent("CONNECTED", `WhatsApp Connected Successfully! Bot: ${currentBotNumber}`);
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
                logEvent("LOGGED_OUT", "Logged out. Please scan QR code again.");
            }
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        try {
            // STRICT PROTECTION 1: Ignore all background history sync and offline dumps!
            if (type !== "notify") return;

            const nowSeconds = Math.floor(Date.now() / 1000);

            for (const msg of messages) {
                if (!msg.message) continue;

                // STRICT PROTECTION 2: Never reply to self
                if (msg.key.fromMe) continue;

                const senderJid = msg.key.remoteJid;
                if (!senderJid) continue;

                // STRICT PROTECTION 3: NEVER touch groups, broadcasts, newsletters
                if (
                    senderJid.endsWith('@g.us') || 
                    senderJid.endsWith('@broadcast') || 
                    senderJid.endsWith('@newsletter') ||
                    senderJid === 'status@broadcast'
                ) {
                    continue;
                }

                // STRICT PROTECTION 4: Ignore any message older than 10 seconds (discards buffer backlog)
                const msgTimestamp = typeof msg.messageTimestamp === 'number' 
                    ? msg.messageTimestamp 
                    : (msg.messageTimestamp?.low || 0);

                if (msgTimestamp && msgTimestamp < (nowSeconds - 10)) {
                    continue;
                }

                const { text, isImage, isQuotedImage, quotedMsg, contextInfo } = getMessageDetails(msg);
                const captionText = text.trim().toLowerCase();
                const senderMobile = senderJid.split('@')[0].replace(/[^0-9]/g, "");

                logEvent("LIVE_MESSAGE", `From: ${senderMobile} | Text: "${text}" | Image: ${isImage}`);

                // 1. Strict Explicit Greeting only (Must be exactly 'hi', 'hello', 'menu', 'help', 'start')
                const isExactGreeting = /^(hi|hello|hey|menu|help|start)$/i.test(captionText);
                if (isExactGreeting && !isImage) {
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
                            id: contextInfo?.stanzaId,
                            participant: contextInfo?.participant
                        }
                    };
                    quotedRef = msg;
                }

                if (isImage && isAadhaarTag) {
                    await handleAadhaarFlow(sock, targetMsgObj, senderJid, senderMobile, text, quotedRef);
                } else if (isImage && isPanTag) {
                    await handlePanFlow(sock, targetMsgObj, senderJid, senderMobile, text, quotedRef);
                } else if (isImage && !isAadhaarTag && !isPanTag) {
                    await sock.sendMessage(senderJid, {
                        text: "📸 *Image received!*\n\nPlease reply to this image with:\n• *`aadhar`* - To process as Aadhaar Card\n• *`pan`* - To process as PAN Card"
                    }, { quoted: msg });
                }
                // (Zero automatic fallback response for random text messages!)
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