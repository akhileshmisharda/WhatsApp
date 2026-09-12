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
const { extractAadhaarWithGemini, extractPanWithGemini } = require('./services/geminiVisionService');
const {
    logImageUpload,
    insertOrUpdateAadhaar,
    insertOrUpdatePan
} = require('./services/documentDbService');

// ---------------------------------------------------------
// 1. STATE, VERSION & EVENT LOGS
// ---------------------------------------------------------
const APP_VERSION = "v4.9.5-NON-OVERLAPPING-IMAGES";

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
        service: 'Fabkraft WhatsApp Document AI & Uploader',
        version: APP_VERSION,
        ai_engine: 'Powered by FabKraft - AI',
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

app.listen(PORT, '0.0.0.0', () => {
    logEvent("SERVER", `Express server listening on 0.0.0.0:${PORT} [Version: ${APP_VERSION}]`);
});

// ---------------------------------------------------------
// 3. SENDER PHONE NUMBER & MESSAGE EXTRACTOR
// ---------------------------------------------------------
async function getActualPhoneNumber(senderJid, msg) {
    if (msg?.key?.fromMe) {
        return currentBotNumber;
    }

    if (!senderJid) return "Unknown";

    // Case 1: Standard phone number JID
    if (senderJid.endsWith('@s.whatsapp.net')) {
        return senderJid.split('@')[0].replace(/[^0-9]/g, "");
    }

    // Case 2: Check alternative participant fields provided by Baileys
    if (msg.key?.remoteJidAlt && msg.key.remoteJidAlt.endsWith('@s.whatsapp.net')) {
        return msg.key.remoteJidAlt.split('@')[0].replace(/[^0-9]/g, "");
    }
    if (msg.key?.participant && msg.key.participant.endsWith('@s.whatsapp.net')) {
        return msg.key.participant.split('@')[0].replace(/[^0-9]/g, "");
    }

    // Case 3: WhatsApp LID -> Look up mapped phone number in MySQL
    if (senderJid.endsWith('@lid')) {
        const lidId = senderJid.split('@')[0].replace(/[^0-9]/g, "");
        try {
            const [rows] = await pool.execute(
                `SELECT value FROM wh_baileys_auth WHERE id IN (?, ?)`,
                [`lid-mapping-${lidId}`, `lid-mapping-${lidId}_reverse`]
            );
            for (const r of rows) {
                if (r.value) {
                    const clean = String(r.value).replace(/[^0-9]/g, "");
                    if (clean.length >= 10 && clean.length <= 13) return clean;
                }
            }
        } catch (e) {
            console.error("LID lookup error:", e.message);
        }
        return lidId;
    }

    return senderJid.split('@')[0].replace(/[^0-9]/g, "");
}

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

                // Prevent bot infinite reply loops
                if (text.startsWith('✅ *') || text.startsWith('⏳ *') || text.startsWith('👋 *') || text.startsWith('🤖 *') || text.startsWith('❌ *') || text.startsWith('🪪 *') || text.startsWith('💳 *')) {
                    continue;
                }

                // Allow self-messages ONLY if sending Aadhaar/PAN image or "hi"
                const isAadhaarTag = /^(a|aadhar|adhar)\b/i.test(captionText) || captionText.includes("aadhar") || captionText.includes("adhar");
                const isPanTag = /^(p|pan)\b/i.test(captionText) || captionText.includes("pan");
                const isExactGreeting = /^(hi|hello|hey|menu|help|start)$/i.test(captionText);

                if (msg.key.fromMe) {
                    if (!((isImage && (isAadhaarTag || isPanTag)) || (isExactGreeting && !isImage))) {
                        continue;
                    }
                }

                const senderMobile = await getActualPhoneNumber(senderJid, msg);

                logEvent("LIVE_MESSAGE", `From: ${senderMobile} | Text: "${text}" | Image: ${isImage}`);

                // 1. Strict Greeting only
                if (isExactGreeting && !isImage) {
                    logEvent("MENU_REPLY", `Sending menu to ${senderMobile}`);
                    await sendMenuResponse(sock, senderJid, msg);
                    continue;
                }

                // 2. Document Processing (ONLY if caption has aadhar/a or pan/p)
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
                    await handleAadhaarGeminiFlow(sock, targetMsgObj, senderJid, senderMobile, quotedRef);
                } else if (isImage && isPanTag) {
                    await handlePanGeminiFlow(sock, targetMsgObj, senderJid, senderMobile, quotedRef);
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
        `*Welcome to Fabkraft Document Assistant*\n` +
        `*Build Version:* \`${APP_VERSION}\`\n\n` +
        `Send your document images with the appropriate caption to extract data & save automatically:\n\n` +
        `*Aadhaar Card:*\n` +
        `• Caption: *a* or *aadhar*\n` +
        `• Extracted: Name (English/Hindi), Relation Status, Father/Husband Name, DOB, Gender, Aadhaar No, VID, Address & PIN\n\n` +
        `*PAN Card:*\n` +
        `• Caption: *p* or *pan*\n` +
        `• Extracted: Name, Father's Name, DOB, PAN No\n\n` +
        `Powered by FabKraft AI`;

    await sock.sendMessage(replyJid, { text: menuText }, { quoted: quotedMsg });
}

/**
 * Handles Aadhaar Upload + Gemini 3.1 Flash-Lite Structured AI Extraction
 */
async function handleAadhaarGeminiFlow(sock, imageMsgObj, replyJid, senderMobile, quotedRef = null) {
    logEvent("AADHAAR_START", `Processing Aadhaar with Gemini for ${senderMobile}...`);

    await sock.sendMessage(replyJid, {
        text: `Aadhaar Card detected. Extracting details and saving...`
    }, { quoted: quotedRef || imageMsgObj });

    try {
        const buffer = await downloadMediaMessage(
            imageMsgObj,
            'buffer',
            {},
            { logger: P({ level: "silent" }), reconnectMode: 'on-demand' }
        );

        const timestamp = Date.now();
        const fileName = `aadhar_${senderMobile}_${timestamp}.jpg`;

        // 1. Parallel Execution: Upload to Fabkraft & Extract with Gemini
        const [uploadResult, geminiResult] = await Promise.all([
            uploadToFabkraft(buffer, fileName, 'aadhar'),
            extractAadhaarWithGemini(buffer)
        ]);

        if (!uploadResult.success) {
            throw new Error(`Server upload failed: ${uploadResult.error}`);
        }

        const uploadUri = uploadResult.uploadUri;
        const details = geminiResult.data || {};

        // 2. Insert record into wh_uploads
        const uploadId = await logImageUpload({
            receiverMobile: currentBotNumber,
            senderMobile: senderMobile,
            imageCaption: 'Aadhar Card',
            imageId: details.aadharNumber || `DOC${timestamp.toString().slice(-6)}`,
            uploadUri: uploadUri
        });

        const tokens = geminiResult.tokens || { promptTokens: 0, candidatesTokens: 0, totalTokens: 0 };
        const accuracy = geminiResult.accuracy || { overall: 100, aadhaarNumber: 100, fullName_English: 100, fullName_Hindi: 100, dob: 100, pincode: 100 };

        let dbResult = null;

        // 3. Upsert into wh_aadhar_records with intelligent Front/Back merging
        dbResult = await insertOrUpdateAadhaar({
            uploadId,
            aadharNumber: details.aadharNumber,
            virtualId: details.vidNumber,
            nameEnglish: details.nameEnglish,
            nameHindi: details.nameHindi,
            dob: details.dob,
            genderEnglish: details.genderEnglish,
            genderHindi: details.genderHindi,
            relationStatus: details.relationStatus,
            fatherNameEnglish: details.fatherNameEnglish,
            fatherNameHindi: details.fatherNameHindi,
            husbandNameEnglish: details.husbandNameEnglish,
            husbandNameHindi: details.husbandNameHindi,
            addressEnglish: details.addressEnglish,
            addressHindi: details.addressHindi,
            pincode: details.pincode,
            rawJson: geminiResult.rawJson || geminiResult.aadhaar_card_data,
            detectedSide: geminiResult.detectedSide,
            tokensPrompt: tokens.promptTokens,
            tokensCompletion: tokens.candidatesTokens,
            tokensTotal: tokens.totalTokens,
            aiModel: geminiResult.model || geminiResult.engine,
            accuracyOverall: accuracy.overall,
            accuracyAadhaarNumber: accuracy.aadhaarNumber,
            accuracyNameEnglish: accuracy.fullName_English,
            accuracyNameHindi: accuracy.fullName_Hindi,
            accuracyDob: accuracy.dob,
            accuracyPincode: accuracy.pincode,
            senderMobile: senderMobile,
            receiverMobile: currentBotNumber,
            uploadUri: uploadUri
        });

        const { ensureBilingualName } = require('./services/transliterate');
        const bName = ensureBilingualName(details.nameEnglish, details.nameHindi);
        const bFather = ensureBilingualName(details.fatherNameEnglish, details.fatherNameHindi);
        const bHusband = ensureBilingualName(details.husbandNameEnglish, details.husbandNameHindi);

        const displayVal = (val) => (val && String(val).trim().length > 0 && val !== "Not Found") ? val : "Not Found";

        let relationLine = "";
        if (details.relationStatus && details.relationStatus !== "Not Found") {
            relationLine += `*Relation Status:* ${details.relationStatus}\n`;
        }
        if (bFather.english !== "Not Found") {
            relationLine += `*Father's Name (English):* ${bFather.english}\n`;
        }
        if (bFather.hindi !== "Not Found") {
            relationLine += `*Father's Name (Hindi):* ${bFather.hindi}\n`;
        }
        if (bHusband.english !== "Not Found") {
            relationLine += `*Husband's Name (English):* ${bHusband.english}\n`;
        }
        if (bHusband.hindi !== "Not Found") {
            relationLine += `*Husband's Name (Hindi):* ${bHusband.hindi}\n`;
        }

        const sideLabel = dbResult?.side === 'both' ? 'Front & Back (Complete)' : (dbResult?.side === 'back' ? 'Back Side' : 'Front Side');
        const actionLabel = dbResult?.action === 'updated' ? ' (Merged with Existing Record)' : '';

        const replyText = 
            `*AADHAAR EXTRACTED & SAVED*${actionLabel}\n\n` +
            `*Upload ID:* #${uploadId}\n` +
            `*Document Scan:* ${sideLabel}\n` +
            `*Sent By:* ${senderMobile}\n\n` +
            `*Name (English):* ${displayVal(bName.english)}\n` +
            `*Name (Hindi):* ${displayVal(bName.hindi)}\n` +
            relationLine +
            `*DOB / YOB:* ${displayVal(details.dob)}\n` +
            `*Gender:* ${displayVal(details.genderEnglish)}\n` +
            `*Aadhaar Number:* ${displayVal(details.aadharNumber)}\n` +
            `*Virtual ID (VID):* ${displayVal(details.vidNumber)}\n` +
            `*Address:* ${displayVal(details.addressEnglish)}\n` +
            `*PIN Code:* ${displayVal(details.pincode)}\n` +
            `*Accuracy Score:* ${accuracy.overall}%\n\n` +
            `Powered by FabKraft AI`;

        await sock.sendMessage(replyJid, { text: replyText }, { quoted: quotedRef || imageMsgObj });
        logEvent("AADHAAR_SUCCESS", `Aadhaar processed with ID #${uploadId} for ${senderMobile}`);

    } catch (err) {
        logEvent("AADHAAR_ERROR", `Failed for ${senderMobile}: ${err.message}`);
        await sock.sendMessage(replyJid, {
            text: `Processing Failed: ${err.message}. Please try again.`
        }, { quoted: quotedRef || imageMsgObj });
    }
}

/**
 * Handles PAN Upload + Gemini 3.1 Flash-Lite Structured AI Extraction
 */
async function handlePanGeminiFlow(sock, imageMsgObj, replyJid, senderMobile, quotedRef = null) {
    logEvent("PAN_START", `Processing PAN with Gemini for ${senderMobile}...`);

    await sock.sendMessage(replyJid, {
        text: `PAN Card detected. Extracting details and saving...`
    }, { quoted: quotedRef || imageMsgObj });

    try {
        const buffer = await downloadMediaMessage(
            imageMsgObj,
            'buffer',
            {},
            { logger: P({ level: "silent" }), reconnectMode: 'on-demand' }
        );

        const timestamp = Date.now();
        const fileName = `pan_${senderMobile}_${timestamp}.jpg`;

        // 1. Parallel Execution: Upload to Fabkraft & Extract with Gemini
        const [uploadResult, geminiResult] = await Promise.all([
            uploadToFabkraft(buffer, fileName, 'pan'),
            extractPanWithGemini(buffer)
        ]);

        if (!uploadResult.success) {
            throw new Error(`Server upload failed: ${uploadResult.error}`);
        }

        const uploadUri = uploadResult.uploadUri;
        const details = geminiResult.data || {};

        // 2. Insert record into wh_uploads
        const uploadId = await logImageUpload({
            receiverMobile: currentBotNumber,
            senderMobile: senderMobile,
            imageCaption: 'PAN Card',
            imageId: details.panNumber || `DOC${timestamp.toString().slice(-6)}`,
            uploadUri: uploadUri
        });

        // 3. Upsert into wh_pan_records
        if (details.panNumber && details.panNumber !== "Not Found") {
            await insertOrUpdatePan({
                uploadId,
                panNumber: details.panNumber,
                name: details.name,
                fatherName: details.fatherName,
                dob: details.dob,
                senderMobile: senderMobile,
                receiverMobile: currentBotNumber,
                uploadUri: uploadUri
            });
        }

        const displayVal = (val) => (val && String(val).trim().length > 0 && val !== "Not Found") ? val : "Not Found";

        const replyText = 
            `*PAN CARD EXTRACTED & SAVED*\n\n` +
            `*Upload ID:* #${uploadId}\n` +
            `*Sent By:* ${senderMobile}\n\n` +
            `*Name:* ${displayVal(details.name)}\n` +
            `*Father's Name:* ${displayVal(details.fatherName)}\n` +
            `*Date of Birth:* ${displayVal(details.dob)}\n` +
            `*PAN Number:* ${displayVal(details.panNumber)}\n\n` +
            `Powered by FabKraft AI`;

        await sock.sendMessage(replyJid, { text: replyText }, { quoted: quotedRef || imageMsgObj });
        logEvent("PAN_SUCCESS", `PAN processed with ID #${uploadId} for ${senderMobile}`);

    } catch (err) {
        logEvent("PAN_ERROR", `Failed for ${senderMobile}: ${err.message}`);
        await sock.sendMessage(replyJid, {
            text: `Processing Failed: ${err.message}. Please try again.`
        }, { quoted: quotedRef || imageMsgObj });
    }
}

// Start WhatsApp Bot
startBot();