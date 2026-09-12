const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const fs = require('fs');
const path = require('path');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    downloadMediaMessage
} = require("@whiskeysockets/baileys");

const P = require("pino");
const qrcode = require("qrcode-terminal");

// Import Aadhaar services
const { extractAadhaarDetails } = require("./services/visionService");
const { insertOrUpdateAadhaar } = require("./services/aadharDbService");

// Import PAN services
const { extractPanDetails } = require("./services/panVisionService");
const { insertOrUpdatePan } = require("./services/panDbService");

const pool = require("./services/db");

// Upload directories
const AADHAR_UPLOAD_DIR = path.join(__dirname, 'uploads', 'aadhar');
const PAN_UPLOAD_DIR = path.join(__dirname, 'uploads', 'pan');

if (!fs.existsSync(AADHAR_UPLOAD_DIR)) fs.mkdirSync(AADHAR_UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(PAN_UPLOAD_DIR)) fs.mkdirSync(PAN_UPLOAD_DIR, { recursive: true });

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth");
    const { version } = await fetchLatestBaileysVersion();

    console.log("WhatsApp Version:", version);

    const logger = P({ level: "silent" });
    logger.child = () => logger;

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: logger,
        browser: ["Unified Doc Parser", "Chrome", "1.0"]
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
            console.log("\n======================================");
            console.log("✅ WhatsApp Connected Successfully");
            console.log("🤖 Ready for Aadhaar & PAN Card Processing...");
            console.log("======================================\n");
        }

        if (connection === "close") {
            console.log("Disconnected.");
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

            if (shouldReconnect) {
                console.log("Reconnecting...");
                startBot();
            } else {
                console.log("Logged out. Delete './auth' directory and restart.");
            }
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        try {
            if (type !== "notify") return;
            const msg = messages[0];
            if (!msg.message) return;

            // Unwrap nested message structures
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

            const rawCaption = 
                messageContent?.imageMessage?.caption ||
                messageContent?.conversation ||
                messageContent?.extendedTextMessage?.text ||
                "";

            const captionText = rawCaption.trim().toLowerCase();
            const isImage = !!messageContent?.imageMessage;
            const senderJid = msg.key.remoteJid;

            console.log(`\n📩 Event -> FromMe: ${msg.key.fromMe} | IsImage: ${isImage} | IsQuotedImage: ${isQuotedImage} | Text: "${rawCaption}"`);

            // Detect commands
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

            if ((isImage || isQuotedImage) && isAadhaarTag) {
                await processAndReplyAadhaar(sock, targetMsgObj, senderJid, quotedRef);
            } else if ((isImage || isQuotedImage) && isPanTag) {
                await processAndReplyPan(sock, targetMsgObj, senderJid, quotedRef);
            }

        } catch (err) {
            console.error("Error handling incoming message:", err.message);
        }
    });
}

/**
 * Aadhaar Processing Handler
 */
async function processAndReplyAadhaar(sock, imageMsgObj, replyJid, quotedMsgRef = null) {
    console.log(`🪪 Processing Aadhaar image for ${replyJid}...`);

    await sock.sendMessage(replyJid, { 
        text: "⏳ *Aadhaar image detected! Extracting details and updating database...*" 
    }, { quoted: quotedMsgRef || imageMsgObj });

    try {
        const buffer = await downloadMediaMessage(
            imageMsgObj,
            'buffer',
            {},
            { logger: P({ level: "silent" }), reconnectMode: 'on-demand' }
        );

        const extracted = await extractAadhaarDetails(buffer);

        if (extracted.aadharNumber === "Not Found") {
            await sock.sendMessage(replyJid, { 
                text: "⚠️ *Aadhaar Number could not be detected.* Please send a clearer image." 
            }, { quoted: quotedMsgRef || imageMsgObj });
            return;
        }

        const cleanPhone = replyJid.replace(/[^0-9]/g, "");
        const cleanAadhaar = extracted.aadharNumber.replace(/\s+/g, "");
        const fileName = `${cleanAadhaar}_${Date.now()}.jpg`;
        const filePath = path.join(AADHAR_UPLOAD_DIR, fileName);

        fs.writeFileSync(filePath, buffer);

        const dbResult = await insertOrUpdateAadhaar({
            aadharNumber: extracted.aadharNumber,
            virtualId: extracted.vidNumber,
            nameEnglish: extracted.nameEnglish,
            nameHindi: extracted.nameHindi,
            dob: extracted.dob,
            genderEnglish: extracted.genderEnglish,
            genderHindi: extracted.genderHindi,
            addressEnglish: extracted.addressEnglish,
            addressHindi: extracted.addressHindi,
            insertedByMobile: cleanPhone,
            aadharFilePath: filePath
        });

        const [dbRows] = await pool.execute(
            'SELECT * FROM aadhar_records WHERE aadhar_number = ?',
            [extracted.aadharNumber]
        );

        const fetchedRecord = dbRows.length > 0 ? dbRows[0] : {};

        console.log("\n==========================================");
        console.log(`📌 AADHAAR RECORD IN DATABASE [Action: ${dbResult.action.toUpperCase()}]`);
        console.log("==========================================");
        console.log(JSON.stringify(fetchedRecord, null, 4));
        console.log("==========================================\n");

        const displayVal = (val) => (val && String(val).trim().length > 0) ? val : "Not Available Yet";

        const replyText = 
            `🪪 *AADHAAR DATABASE RECORD UPDATED*\n\n` +
            `📦 *Database Status:* ${dbResult.action.toUpperCase()}\n\n` +
            `👤 *Name (English):* ${displayVal(fetchedRecord.name_english)}\n` +
            `👤 *Name (Hindi):* ${displayVal(fetchedRecord.name_hindi)}\n\n` +
            `📅 *DOB / YOB:* ${displayVal(fetchedRecord.dob)}\n\n` +
            `🚻 *Gender (English):* ${displayVal(fetchedRecord.gender_english)}\n` +
            `🚻 *Gender (Hindi):* ${displayVal(fetchedRecord.gender_hindi)}\n\n` +
            `🔢 *Aadhaar Number:* ${displayVal(fetchedRecord.aadhar_number)}\n` +
            `🔢 *Virtual ID (VID):* ${displayVal(fetchedRecord.virtual_id)}\n\n` +
            `🏠 *Address (English):* ${displayVal(fetchedRecord.address_english)}\n` +
            `🏠 *Address (Hindi):* ${displayVal(fetchedRecord.address_hindi)}\n\n` +
            `🖼️ *Front Image Saved:* ${fetchedRecord.front_image_path ? path.basename(fetchedRecord.front_image_path) : "Not Saved"}\n` +
            `🖼️ *Back Image Saved:* ${fetchedRecord.back_image_path ? path.basename(fetchedRecord.back_image_path) : "Not Saved"}`;

        await sock.sendMessage(replyJid, { text: replyText }, { quoted: quotedMsgRef || imageMsgObj });
        console.log(`✅ Aadhaar process completed for ${replyJid}`);

    } catch (err) {
        console.error("❌ Aadhaar Processing Error:", err.message);
        await sock.sendMessage(replyJid, { 
            text: "❌ *Failed to process Aadhaar Card details.* Please check server logs." 
        }, { quoted: quotedMsgRef || imageMsgObj });
    }
}

/**
 * PAN Processing Handler
 */
async function processAndReplyPan(sock, imageMsgObj, replyJid, quotedMsgRef = null) {
    console.log(`💳 Processing PAN Card image for ${replyJid}...`);

    await sock.sendMessage(replyJid, { 
        text: "⏳ *PAN Card image detected! Extracting details and updating database...*" 
    }, { quoted: quotedMsgRef || imageMsgObj });

    try {
        const buffer = await downloadMediaMessage(
            imageMsgObj,
            'buffer',
            {},
            { logger: P({ level: "silent" }), reconnectMode: 'on-demand' }
        );

        const extracted = await extractPanDetails(buffer);

        if (extracted.panNumber === "Not Found") {
            await sock.sendMessage(replyJid, { 
                text: "⚠️ *PAN Number could not be detected.* Please send a clearer image." 
            }, { quoted: quotedMsgRef || imageMsgObj });
            return;
        }

        const cleanPhone = replyJid.replace(/[^0-9]/g, "");
        const cleanPan = extracted.panNumber.replace(/\s+/g, "");
        const fileName = `${cleanPan}_${Date.now()}.jpg`;
        const filePath = path.join(PAN_UPLOAD_DIR, fileName);

        fs.writeFileSync(filePath, buffer);

        const dbResult = await insertOrUpdatePan({
            panNumber: extracted.panNumber,
            name: extracted.name,
            fatherName: extracted.fatherName,
            dob: extracted.dob,
            insertedByMobile: cleanPhone,
            imagePath: filePath
        });

        const [dbRows] = await pool.execute(
            'SELECT * FROM pan_records WHERE pan_number = ?',
            [extracted.panNumber]
        );

        const fetchedRecord = dbRows.length > 0 ? dbRows[0] : {};

        console.log("\n==========================================");
        console.log(`📌 PAN RECORD IN DATABASE [Action: ${dbResult.action.toUpperCase()}]`);
        console.log("==========================================");
        console.log(JSON.stringify(fetchedRecord, null, 4));
        console.log("==========================================\n");

        const displayVal = (val) => (val && String(val).trim().length > 0) ? val : "Not Available";

        const replyText = 
            `💳 *PAN CARD DATABASE RECORD UPDATED*\n\n` +
            `📦 *Database Status:* ${dbResult.action.toUpperCase()}\n\n` +
            `👤 *Name:* ${displayVal(fetchedRecord.name)}\n` +
            `👨 *Father's Name:* ${displayVal(fetchedRecord.father_name)}\n\n` +
            `📅 *Date of Birth:* ${displayVal(fetchedRecord.dob)}\n` +
            `🔢 *PAN Number:* ${displayVal(fetchedRecord.pan_number)}\n\n` +
            `📁 *Saved File:* ${fetchedRecord.image_path ? path.basename(fetchedRecord.image_path) : "Not Saved"}`;

        await sock.sendMessage(replyJid, { text: replyText }, { quoted: quotedMsgRef || imageMsgObj });
        console.log(`✅ PAN process completed for ${replyJid}`);

    } catch (err) {
        console.error("❌ PAN Processing Error:", err.message);
        await sock.sendMessage(replyJid, { 
            text: "❌ *Failed to process PAN Card details.* Please check server logs." 
        }, { quoted: quotedMsgRef || imageMsgObj });
    }
}

startBot();