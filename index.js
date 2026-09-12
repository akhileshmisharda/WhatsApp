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
const { logImageUpload } = require('./services/documentDbService');

// ---------------------------------------------------------
// 1. STATE, VERSION & EVENT LOGS
// ---------------------------------------------------------
const APP_VERSION = "v3.0.0-PROD";

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
        service: 'Fabkraft WhatsApp Document Uploader',
        version: APP_VERSION,
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
        version: APP_VERSION,
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

        const result = await sock.sendMessage(jid, { text: `🤖 *Test Message (${APP_VERSION}):*\n${text}` });
        logEvent("OUTGOING_SUCCESS", `Test message delivered to ${jid}`);

        res.json({
            success: true,
            version: APP_VERSION,
            message: `Test message sent to ${targetMobile}`,
            resultId: result?.key?.id,
            status: connectionStatus
        });
    } catch (err) {
        logEvent("OUTGOING_ERROR", `Failed to send to ${targetMobile}: ${err.message}`);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => {
    logEvent("SERVER", `Express server listening on port ${PORT} [Version: ${APP_VERSION}]`);
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
    logEvent("WHATSAPP_INIT", `Starting WhatsApp Socket (${APP_VERSION}) with MySQL Auth State...`);
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
            // Ignore offline history sync dumps
            if (type !== "notify") return;

            const nowSeconds = Math.floor(Date.now() / 1000);

            for (const msg of messages) {
                if (!msg.message) continue;

                // Never reply to self
                if (msg.key.fromMe) continue;

                const senderJid = msg.key.remoteJid;
                if (!senderJid) continue;

                // NEVER touch groups, broadcasts, newsletters
                if (
                    senderJid.endsWith('@g.us') || 
                    senderJid.endsWith('@broadcast') || 
                    senderJid.endsWith('@newsletter') ||
                    senderJid === 'status@broadcast'
                ) {
                    continue;
                }

                // Ignore messages older than 10 seconds
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

                // 2. Document Tag Detection (ONLY process if caption has aadhar or pan)
                const isAadhaarTag = captionText.includes("aadhar") || captionText.includes("adhar");
                const isPanTag = captionText.includes("pan");

                // If image has no aadhar/pan caption, DO NOTHING (silent)
                if (!isAadhaarTag && !isPanTag) {
                    continue;
                }

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
                    await handleDirectUpload(sock, targetMsgObj, senderJid, senderMobile, 'Aadhar Card', 'aadhar', quotedRef);
                } else if (isImage && isPanTag) {
                    await handleDirectUpload(sock, targetMsgObj, senderJid, senderMobile, 'PAN Card', 'pan', quotedRef);
                }
            }
        } catch (err) {
            logEvent("MESSAGE_UPSERT_ERROR", err.message);
        }
    });
}

/**
 * Sends a helpful menu guide to the user with Version ID
 */
async function sendMenuResponse(sock, replyJid, quotedMsg) {
    const menuText = 
        `👋 *Welcome to Fabkraft Document Uploader!*\n` +
        ` *Build Version:* \`${APP_VERSION}\`\n\n` +
        `Send your document images with the appropriate caption to upload directly to Fabkraft ERP:\n\n` +
        `🪪 *Aadhaar Card:*\n` +
        `• Send image with caption *\`aadhar\`* or *\`adhar\`*\n\n` +
        `💳 *PAN Card:*\n` +
        `• Send image with caption *\`pan\`*\n\n` +
        `🌐 *Storage:* All files are stored at \`fabkraft.in/WhatsAppFolder/uploads/\` and saved with an Upload ID.\n\n` +
        `_Active on Google Cloud Run_`;

    await sock.sendMessage(replyJid, { text: menuText }, { quoted: quotedMsg });
}

/**
 * Handles Direct Image Upload (No OCR) & Database Logging in wh_uploads
 */
async function handleDirectUpload(sock, imageMsgObj, replyJid, senderMobile, docTitle, category, quotedRef = null) {
    logEvent("UPLOAD_START", `Uploading ${docTitle} from ${senderMobile}...`);

    await sock.sendMessage(replyJid, {
        text: `⏳ *${docTitle} detected! Uploading directly to Fabkraft server...*`
    }, { quoted: quotedRef || imageMsgObj });

    try {
        const buffer = await downloadMediaMessage(
            imageMsgObj,
            'buffer',
            {},
            { logger: P({ level: "silent" }), reconnectMode: 'on-demand' }
        );

        const timestamp = Date.now();
        const fileName = `${category}_${senderMobile}_${timestamp}.jpg`;

        // 1. Upload file buffer to fabkraft.in/WhatsAppFolder/uploads/<category>/
        const uploadResult = await uploadToFabkraft(buffer, fileName, category);
        const uploadUri = uploadResult.success ? uploadResult.uploadUri : `https://fabkraft.in/WhatsAppFolder/uploads/${category}/${fileName}`;

        // 2. Insert record into wh_uploads
        const uploadId = await logImageUpload({
            receiverMobile: currentBotNumber,
            senderMobile: senderMobile,
            imageCaption: docTitle,
            imageId: String(uploadIdAutoId(timestamp)),
            uploadUri: uploadUri
        });

        // 3. Format current date & time (IST)
        const dateStr = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

        const replyText = 
            `✅ *${docTitle.toUpperCase()} UPLOADED SUCCESSFULLY*\n\n` +
            `🆔 *Upload ID:* #${uploadId}\n` +
            `📁 *Document Type:* ${docTitle}\n` +
            `📱 *Bot Account:* ${currentBotNumber}\n` +
            `📲 *Sent By:* ${senderMobile}\n` +
            `📅 *Uploaded At:* ${dateStr}\n` +
            `🔖 *Version:* \`${APP_VERSION}\`\n\n` +
            `🌐 *Server Link:*\n${uploadUri}`;

        await sock.sendMessage(replyJid, { text: replyText }, { quoted: quotedRef || imageMsgObj });
        logEvent("UPLOAD_SUCCESS", `${docTitle} uploaded with ID #${uploadId} for ${senderMobile}`);

    } catch (err) {
        logEvent("UPLOAD_ERROR", `Failed to upload for ${senderMobile}: ${err.message}`);
        await sock.sendMessage(replyJid, {
            text: `❌ *Failed to upload ${docTitle}.* Please try again.`
        }, { quoted: quotedRef || imageMsgObj });
    }
}

function uploadIdAutoId(ts) {
    return `DOC${ts.toString().slice(-6)}`;
}

// Start WhatsApp Bot
startBot();