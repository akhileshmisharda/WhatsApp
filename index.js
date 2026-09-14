try { require('dotenv').config(); } catch (e) {}
process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const path = require('path');
const P = require('pino');
const QRCode = require('qrcode');
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
const { useMySQLAuthState, clearSessionAuth, purgeCorruptSessionKeys } = require('./services/mysqlAuthService');
const { uploadToFabkraft } = require('./services/uploadService');
const { extractAadhaarWithGemini, extractPanWithGemini, extractJamabandiWithGemini, extractSaleDeedWithGemini } = require('./services/geminiVisionService');
const {
    logImageUpload,
    insertOrUpdateAadhaar,
    insertOrUpdatePan,
    insertJamabandiRecord,
    insertSaleDeedRecord,
    ensureBotManagementTablesExist,
    isSenderAllowed,
    getActiveBotInstances,
    getAllowedUsersList,
    updateBotStatus
} = require('./services/documentDbService');
const { handleCustomMenuFlow } = require('./services/botMenuRouter');

// ---------------------------------------------------------
// 1. STATE, VERSION & EVENT LOGS
// ---------------------------------------------------------
const APP_VERSION = "v5.5.4-RETRY-DOWNLOAD-AADHAAR-MERGE";

const botSockets = new Map(); // sessionId -> { sock, botConfig, qr, connectionStatus, lastConnectedAt, lastQrGeneratedAt, currentBotNumber }
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
// 2. EXPRESS HTTP SERVER & DASHBOARD
// ---------------------------------------------------------
const app = express();
const rawPort = (process.env.PORT || '').toString().trim();
const parsedPort = parseInt(rawPort.match(/\d+/)?.[0] || '8080', 10);
const PORT = (!isNaN(parsedPort) && parsedPort > 0) ? parsedPort : 8080;

app.use(express.json());

app.get('/', async (req, res) => {
    const sessionsList = [];
    for (const [sId, info] of botSockets.entries()) {
        sessionsList.push({
            session_id: sId,
            bot_name: info.botConfig?.bot_name || sId,
            menu_type: info.botConfig?.menu_type || 'DOCUMENT_OCR',
            bot_number: info.currentBotNumber || info.botConfig?.phone_number || 'Unknown',
            status: info.connectionStatus || 'initializing',
            is_ready: !!info.sock?.user,
            last_connected: info.lastConnectedAt,
            last_qr: info.lastQrGeneratedAt,
            qr_link: `/qr/${sId}`
        });
    }

    if (req.headers.accept && req.headers.accept.includes('application/json') && !req.query.html) {
        return res.json({
            service: 'Fabkraft Multi-Session WhatsApp Document AI & Uploader',
            version: APP_VERSION,
            server_status: 'online',
            total_bots: sessionsList.length,
            bots: sessionsList,
            timestamp: new Date().toISOString()
        });
    }

    // Modern HTML Web Dashboard
    const rowsHtml = sessionsList.map(s => {
        let badgeColor = s.status === 'connected' ? '#10b981' : (s.status.includes('qr') ? '#f59e0b' : '#ef4444');
        return `
            <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 12px; font-weight: bold;">${s.bot_name}</td>
                <td style="padding: 12px; font-family: monospace;"><code>${s.session_id}</code></td>
                <td style="padding: 12px;">+${s.bot_number}</td>
                <td style="padding: 12px;"><span style="background: #e2e8f0; padding: 4px 8px; border-radius: 4px; font-size: 12px;">${s.menu_type}</span></td>
                <td style="padding: 12px;">
                    <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${badgeColor}; margin-right: 6px;"></span>
                    <strong style="color: ${badgeColor};">${s.status.toUpperCase()}</strong>
                </td>
                <td style="padding: 12px; display: flex; gap: 6px;">
                    <a href="/qr/${s.session_id}" target="_blank" style="display: inline-block; background: #2563eb; color: white; padding: 6px 12px; border-radius: 6px; text-decoration: none; font-size: 13px;">📲 Scan QR</a>
                    <a href="/reset-qr/${s.session_id}" style="display: inline-block; background: #64748b; color: white; padding: 6px 10px; border-radius: 6px; text-decoration: none; font-size: 13px;" onclick="return confirm('Force reset and generate fresh QR for ${s.session_id}?')">🔄 Reset</a>
                </td>
            </tr>
        `;
    }).join('');

    const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Fabkraft WhatsApp Multi-Bot ERP Node</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; color: #1e293b; margin: 0; padding: 24px; }
                .container { max-width: 1000px; margin: 0 auto; background: white; border-radius: 12px; padding: 28px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
                h1 { margin-top: 0; color: #0f172a; display: flex; align-items: center; justify-content: space-between; }
                .badge { background: #dbeafe; color: #1e40af; font-size: 13px; font-weight: normal; padding: 4px 10px; border-radius: 20px; }
                table { width: 100%; border-collapse: collapse; margin-top: 20px; text-align: left; }
                th { background: #f1f5f9; padding: 12px; font-size: 13px; color: #475569; text-transform: uppercase; }
                .nav-links { margin-top: 24px; display: flex; gap: 12px; }
                .nav-links a { color: #2563eb; text-decoration: none; font-size: 14px; font-weight: 500; }
                .footer { margin-top: 30px; font-size: 13px; color: #94a3b8; text-align: center; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>
                    <span>🤖 Fabkraft Multi-Bot ERP Node</span>
                    <span class="badge">${APP_VERSION}</span>
                </h1>
                <p style="color: #64748b; margin-bottom: 20px;">Live WhatsApp Bot instances running concurrently on Fabkraft VPS Node.</p>

                <table>
                    <thead>
                        <tr>
                            <th>Bot Name</th>
                            <th>Session ID</th>
                            <th>Connected Number</th>
                            <th>Menu Workflow</th>
                            <th>Status</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHtml || '<tr><td colspan="6" style="padding: 20px; text-align: center;">No active bots initialized yet.</td></tr>'}
                    </tbody>
                </table>

                <div class="nav-links">
                    <a href="/allowed-users" target="_blank">🔐 View Allowed Numbers (Whitelist)</a>
                    <a href="/logs" target="_blank">📜 Event Logs</a>
                    <a href="/health" target="_blank">❤️ Server Health</a>
                </div>

                <div class="footer">
                    Powered by FabKraft AI Engine &middot; MySQL Multi-Session Sync Active
                </div>
            </div>
        </body>
        </html>
    `;

    res.send(html);
});

// Direct PNG QR Image endpoint
app.get('/qr-img/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const sessionInfo = botSockets.get(sessionId);

    if (!sessionInfo || !sessionInfo.qr) {
        return res.status(404).send('QR Code not available or session not active');
    }

    try {
        const buffer = await QRCode.toBuffer(sessionInfo.qr, { width: 320, margin: 2 });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        return res.send(buffer);
    } catch (err) {
        return res.status(500).send('Error generating QR image');
    }
});

// Browser QR Code Display for a specific Bot Session
app.get('/qr/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const sessionInfo = botSockets.get(sessionId);

    if (!sessionInfo) {
        return res.status(404).send(`<h3>❌ Bot Session '${sessionId}' not found.</h3><a href="/">Back to Dashboard</a>`);
    }

    const qrRaw = sessionInfo.qr;
    const status = sessionInfo.connectionStatus;
    const botName = sessionInfo.botConfig?.bot_name || sessionId;

    let qrImageTag = '';
    if (qrRaw) {
        try {
            const dataUrl = await QRCode.toDataURL(qrRaw, { width: 300, margin: 2 });
            qrImageTag = `<img src="${dataUrl}" alt="Scan QR Code" style="width: 280px; height: 280px; border-radius: 12px; display: block; margin: 15px auto; background: white; padding: 10px; box-shadow: 0 4px 10px rgba(0,0,0,0.2);" />`;
        } catch (e) {
            qrImageTag = `<img src="/qr-img/${sessionId}?t=${Date.now()}" alt="Scan QR Code" style="width: 280px; height: 280px; border-radius: 12px; display: block; margin: 15px auto; background: white; padding: 10px;" />`;
        }
    }

    const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Scan QR - ${botName}</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: white; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
                .card { background: #1e293b; border-radius: 16px; padding: 32px; text-align: center; max-width: 420px; width: 100%; box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
                h2 { margin-top: 0; color: #38bdf8; font-size: 22px; }
                .status { margin-top: 15px; font-size: 14px; color: #94a3b8; }
                .btn { display: inline-block; background: #38bdf8; color: #0f172a; font-weight: bold; padding: 10px 20px; border-radius: 8px; text-decoration: none; margin-top: 20px; }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>📲 ${botName}</h2>
                <p style="color: #94a3b8; font-size: 13px;">Session: <code>${sessionId}</code></p>

                ${status === 'connected' ? `
                    <div style="padding: 30px 10px;">
                        <div style="font-size: 56px;">✅</div>
                        <h3 style="color: #4ade80; margin-top: 10px;">Bot is Connected!</h3>
                        <p style="color: #94a3b8;">Phone: +${sessionInfo.currentBotNumber || 'Active'}</p>
                    </div>
                ` : (qrRaw ? `
                    ${qrImageTag}
                    <div class="status">Open <strong>WhatsApp &gt; Linked Devices &gt; Link a Device</strong> and scan this code.<br><small style="color: #64748b;">Auto-refreshing in 15s...</small></div>
                    <script>setTimeout(() => location.reload(), 15000);</script>
                ` : `
                    <div style="padding: 40px 10px;">
                        <div style="font-size: 44px;">⏳</div>
                        <p style="margin-top: 15px; color: #cbd5e1;">Generating QR Code... Status: <strong>${status}</strong></p>
                    </div>
                    <script>setTimeout(() => location.reload(), 3000);</script>
                `)}

                <div>
                    <a href="/" class="btn">⬅ Dashboard</a>
                </div>
            </div>
        </body>
        </html>
    `;

    res.send(html);
});

// Manual QR Reset & Force Re-Scan Endpoint
app.get('/reset-qr/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const sessionInfo = botSockets.get(sessionId);

    if (!sessionInfo) {
        return res.status(404).send(`Bot session '${sessionId}' not found.`);
    }

    try {
        logEvent("FORCE_RESET_QR", `Force clearing auth and regenerating QR for ${sessionId}`);
        await clearSessionAuth(sessionId);
        if (sessionInfo.sock) {
            try { sessionInfo.sock.end(undefined); } catch (e) {}
        }
        setTimeout(() => startBotSession(sessionInfo.botConfig), 1500);
        return res.redirect(`/qr/${sessionId}`);
    } catch (err) {
        return res.status(500).send(`Error resetting session: ${err.message}`);
    }
});

// Allowed Users / Whitelist API
app.get('/allowed-users', async (req, res) => {
    const users = await getAllowedUsersList();
    res.json({
        total: users.length,
        allowed_users: users
    });
});

app.get('/logs', (req, res) => {
    res.json({
        version: APP_VERSION,
        recent_events: eventLogs
    });
});

app.get('/send-test', async (req, res) => {
    const sessionId = req.query.session || Array.from(botSockets.keys())[0];
    const sessionInfo = botSockets.get(sessionId);

    if (!sessionInfo || sessionInfo.connectionStatus !== 'connected' || !sessionInfo.sock) {
        return res.status(503).json({
            success: false,
            error: `Bot session '${sessionId}' is not connected.`,
            status: sessionInfo?.connectionStatus || 'not_found'
        });
    }

    let targetMobile = req.query.to ? req.query.to.replace(/[^0-9]/g, "") : "919079377715";
    if (targetMobile.length === 10) targetMobile = `91${targetMobile}`;
    const text = req.query.text || `Hello from Fabkraft Bot (${sessionInfo.botConfig?.bot_name || sessionId})!`;

    try {
        const jid = `${targetMobile}@s.whatsapp.net`;
        logEvent("OUTGOING_TEST", `Sending test message via ${sessionId} to ${jid}`, { text });
        await sessionInfo.sock.sendMessage(jid, { text });
        res.json({ success: true, session: sessionId, message: `Sent test message to ${jid}` });
    } catch (err) {
        logEvent("OUTGOING_TEST_ERROR", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 [Server] Cloud Run Multi-Bot HTTP Listener active on 0.0.0.0:${PORT} (${APP_VERSION})`);
});

// ---------------------------------------------------------
// 3. UTILITIES & MESSAGE PARSING
// ---------------------------------------------------------
async function getActualPhoneNumber(senderJid, msg, sessionState = null) {
    if (!senderJid) return "Unknown";

    // 1. If message was sent from the bot's own connected device (e.g. self-testing / linked device)
    if (msg?.key?.fromMe) {
        if (sessionState?.currentBotNumber && sessionState.currentBotNumber !== "Unknown") {
            return sessionState.currentBotNumber;
        }
        if (sessionState?.botConfig?.phone_number) {
            return sessionState.botConfig.phone_number.replace(/[^0-9]/g, "");
        }
    }
    
    // 2. Direct WhatsApp mobile JID (e.g., 919079377715@s.whatsapp.net)
    if (senderJid.endsWith('@s.whatsapp.net')) {
        return senderJid.split('@')[0].replace(/[^0-9]/g, "");
    }

    // 3. Baileys v7+ direct participant identity fields
    if (msg?.key?.participantPn && msg.key.participantPn.endsWith('@s.whatsapp.net')) {
        return msg.key.participantPn.split('@')[0].replace(/[^0-9]/g, "");
    }
    if (msg?.key?.remoteJidPn && msg.key.remoteJidPn.endsWith('@s.whatsapp.net')) {
        return msg.key.remoteJidPn.split('@')[0].replace(/[^0-9]/g, "");
    }
    if (msg?.key?.participant && msg.key.participant.endsWith('@s.whatsapp.net')) {
        return msg.key.participant.split('@')[0].replace(/[^0-9]/g, "");
    }
    if (msg?.key?.remoteJidAlt && msg.key.remoteJidAlt.endsWith('@s.whatsapp.net')) {
        return msg.key.remoteJidAlt.split('@')[0].replace(/[^0-9]/g, "");
    }

    // 4. Context info participant
    const content = msg?.message;
    const contextInfo = content?.extendedTextMessage?.contextInfo || 
                        content?.imageMessage?.contextInfo ||
                        content?.documentMessage?.contextInfo ||
                        content?.videoMessage?.contextInfo;
    if (contextInfo?.participant && contextInfo.participant.endsWith('@s.whatsapp.net')) {
        const num = contextInfo.participant.split('@')[0].replace(/[^0-9]/g, "");
        if (num && num.length >= 10 && num.length <= 15) return num;
    }

    // 5. WhatsApp LID Resolution via MySQL lookup
    if (senderJid.endsWith('@lid')) {
        const lidId = senderJid.split('@')[0];
        try {
            const [rows] = await pool.execute(
                `SELECT value FROM wh_baileys_auth WHERE value LIKE ? LIMIT 10`,
                [`%${lidId}%`]
            );
            for (const r of rows) {
                if (r.value) {
                    const strVal = typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
                    const jidMatch = strVal.match(/(\d{10,14})@s\.whatsapp\.net/);
                    if (jidMatch && jidMatch[1]) {
                        return jidMatch[1];
                    }
                    const phoneMatch = strVal.match(/\b(91\d{10}|\d{10})\b/);
                    if (phoneMatch && phoneMatch[1]) {
                        return phoneMatch[1];
                    }
                }
            }
        } catch (e) {
            console.error("LID lookup error:", e.message);
        }
        return lidId;
    }

    return senderJid.split('@')[0].replace(/[^0-9]/g, "");
}

function sanitizeUserFacingError(err) {
    const raw = err?.message || String(err || '');
    if (
        raw.includes('Gemini') || 
        raw.includes('Google') || 
        raw.includes('Flash') || 
        raw.includes('OAuth') || 
        raw.includes('API key') ||
        raw.includes('credentials') ||
        raw.includes('quota') ||
        raw.includes('generateContent') ||
        raw.includes('JSON') ||
        raw.includes('failed to extract')
    ) {
        return "Could not extract document details. Please ensure the document is clear and readable, and try again.";
    }
    if (raw.includes('1006') || raw.includes('Connection Closed') || raw.includes('closed') || raw.includes('ECONNRESET')) {
        return "WhatsApp media download connection was briefly interrupted. Please resend the document image.";
    }
    return raw.length > 100 ? "Document processing failed. Please try again." : raw;
}

/**
 * Downloads WhatsApp media with automatic retry to handle transient network/socket glitches (e.g. 1006)
 */
async function downloadMediaWithRetry(mediaMsgObj, maxRetries = 3) {
    let lastErr = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await downloadMediaMessage(
                mediaMsgObj,
                'buffer',
                {},
                { logger: P({ level: "silent" }), reconnectMode: 'on-demand' }
            );
        } catch (err) {
            lastErr = err;
            console.warn(`⚠️ [MediaDownload] Download attempt ${attempt}/${maxRetries} failed (${err.message}). Retrying in 1.5s...`);
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 1500));
            }
        }
    }
    throw lastErr || new Error("Failed to download media after retries.");
}

function getMessageDetails(msg) {
    if (!msg?.message) return { text: "", isMedia: false, isImage: false, isPdf: false, mimeType: 'image/jpeg' };

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
    const docMsg = content?.documentMessage;
    const isDoc = !!docMsg;
    const isPdf = isDoc && (
        docMsg.mimetype === 'application/pdf' || 
        (docMsg.fileName && docMsg.fileName.toLowerCase().endsWith('.pdf'))
    );

    const quotedMsg = content?.extendedTextMessage?.contextInfo?.quotedMessage;
    const isQuotedImage = !!quotedMsg?.imageMessage;
    const quotedDoc = quotedMsg?.documentMessage;
    const isQuotedDoc = !!quotedDoc;
    const isQuotedPdf = isQuotedDoc && (
        quotedDoc.mimetype === 'application/pdf' || 
        (quotedDoc.fileName && quotedDoc.fileName.toLowerCase().endsWith('.pdf'))
    );

    const isMedia = isImage || isDoc || isQuotedImage || isQuotedDoc;
    const mimeType = (isPdf || isQuotedPdf || (isDoc && docMsg?.mimetype === 'application/pdf') || quotedDoc?.mimetype === 'application/pdf') 
        ? 'application/pdf' 
        : (docMsg?.mimetype || quotedDoc?.mimetype || 'image/jpeg');

    return {
        text: text.trim(),
        isMedia,
        isImage: isImage || isQuotedImage,
        isPdf: isPdf || isQuotedPdf,
        mimeType,
        quotedMsg,
        contextInfo: content?.extendedTextMessage?.contextInfo
    };
}

// ---------------------------------------------------------
// 4. MULTI-SESSION BOT LIFECYCLE
// ---------------------------------------------------------
async function startBotSession(botConfig) {
    const sessionId = botConfig.session_id;
    logEvent("BOT_SESSION_INIT", `Initializing session '${sessionId}' (${botConfig.bot_name}) with menu '${botConfig.menu_type}'...`);

    const sessionState = {
        sock: null,
        botConfig,
        qr: null,
        connectionStatus: "connecting",
        lastConnectedAt: null,
        lastQrGeneratedAt: null,
        currentBotNumber: botConfig.phone_number || "Unknown"
    };
    botSockets.set(sessionId, sessionState);

    let authState, saveCreds;
    try {
        const mySqlAuth = await useMySQLAuthState(sessionId);
        authState = mySqlAuth.state;
        saveCreds = mySqlAuth.saveCreds;

        if (authState?.creds?.me?.id) {
            sessionState.currentBotNumber = authState.creds.me.id.split(':')[0].replace(/[^0-9]/g, "");
            logEvent("AUTH_CREDS", `[${sessionId}] Credentials loaded for bot number: ${sessionState.currentBotNumber}`);
        }
    } catch (authErr) {
        logEvent("AUTH_ERROR", `[${sessionId}] MySQL Auth failed, using local fallback: ${authErr.message}`);
        const fileAuth = await useMultiFileAuthState(`./auth_${sessionId}`);
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
        keepAliveIntervalMs: 25000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        browser: ["Fabkraft Multi-Bot", "Chrome", "1.0"]
    });
    sessionState.sock = sock;

    sock.ev.on("creds.update", async () => {
        try {
            await saveCreds();
            logEvent("CREDS_UPDATED", `[${sessionId}] Credentials updated in MySQL`);
        } catch (e) {
            logEvent("CREDS_SAVE_ERROR", `[${sessionId}] ${e.message}`);
        }
    });

    sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
        if (qr) {
            sessionState.qr = qr;
            sessionState.connectionStatus = "waiting_for_qr_scan";
            sessionState.lastQrGeneratedAt = new Date().toISOString();
            logEvent("QR_GENERATED", `[${sessionId}] QR code generated. View at: /qr/${sessionId}`);
            qrcode.generate(qr, { small: true });

            await updateBotStatus(sessionId, {
                status: 'waiting_for_qr_scan',
                lastQrAt: sessionState.lastQrGeneratedAt
            });
        }

        if (connection === "open") {
            sessionState.qr = null;
            sessionState.connectionStatus = "connected";
            sessionState.lastConnectedAt = new Date().toISOString();
            sessionState.currentBotNumber = sock.user?.id ? sock.user.id.split(':')[0].replace(/[^0-9]/g, "") : sessionState.currentBotNumber;
            logEvent("CONNECTED", `[${sessionId}] WhatsApp Connected Successfully! Bot Number: ${sessionState.currentBotNumber}`);

            await updateBotStatus(sessionId, {
                status: 'connected',
                phoneNumber: sessionState.currentBotNumber,
                lastConnectedAt: sessionState.lastConnectedAt
            });
        }

        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLogout = statusCode === DisconnectReason.loggedOut || statusCode === 401;
            const shouldReconnect = !isLogout;
            sessionState.connectionStatus = isLogout ? "waiting_for_qr_scan" : "disconnected_reconnecting";
            
            logEvent("DISCONNECTED", `[${sessionId}] Connection closed (Code: ${statusCode}). Reconnecting: ${shouldReconnect}`, {
                error: lastDisconnect?.error?.message
            });

            await updateBotStatus(sessionId, {
                status: sessionState.connectionStatus
            });

            if (isLogout) {
                logEvent("LOGGED_OUT", `[${sessionId}] Logged out / auth reset. Clearing stale keys and generating fresh QR at: /qr/${sessionId}`);
                try {
                    await clearSessionAuth(sessionId);
                } catch (e) {}
                setTimeout(() => startBotSession(botConfig), 3000);
            } else {
                setTimeout(() => startBotSession(botConfig), 4000);
            }
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        try {
            console.log(`📩 [${sessionId}] messages.upsert received: type=${type}, count=${messages?.length || 0}`);
            if (type !== "notify") return;

            const nowSeconds = Math.floor(Date.now() / 1000);

            for (const msg of messages) {
                if (!msg.message) continue;

                const senderJid = msg.key.remoteJid;
                if (!senderJid) continue;

                if (
                    senderJid.endsWith('@g.us') || 
                    senderJid.endsWith('@broadcast') || 
                    senderJid.endsWith('@newsletter') ||
                    senderJid === 'status@broadcast'
                ) {
                    continue;
                }

                const msgTimestamp = typeof msg.messageTimestamp === 'number' 
                    ? msg.messageTimestamp 
                    : (msg.messageTimestamp?.low || 0);

                // Ignore messages older than 5 minutes (prevents reprocessing old backlog on startup)
                if (msgTimestamp && msgTimestamp < (nowSeconds - 300)) {
                    continue;
                }

                const { text, isMedia, isImage, isPdf, mimeType, quotedMsg, contextInfo } = getMessageDetails(msg);
                const captionText = text.trim().toLowerCase();

                console.log(`💬 [${sessionId}] Incoming from: ${senderJid} (fromMe: ${!!msg.key.fromMe}) | Text: "${text}" | isMedia: ${isMedia}`);

                // Prevent automated loopback replies from the bot itself
                if (
                    text.startsWith('✅') || text.startsWith('⏳') || text.startsWith('👋') || 
                    text.startsWith('🤖') || text.startsWith('❌') || text.startsWith('🪪') || 
                    text.startsWith('💳') || text.startsWith('⚠️') || text.startsWith('📊') || 
                    text.startsWith('📋') || text.startsWith('📸') || text.startsWith('ℹ️') ||
                    text.startsWith('*Welcome') || text.startsWith('Welcome')
                ) {
                    continue;
                }

                const currentBotNum = (sessionState.currentBotNumber || botConfig.phone_number || '').replace(/[^0-9]/g, "");
                const botIdNum = (sock.user?.id || '').split(':')[0].replace(/[^0-9]/g, "");
                const botLidNum = (sock.user?.lid || authState?.creds?.me?.lid || '').split(':')[0].split('@')[0].replace(/[^0-9]/g, "");
                const senderClean = senderJid.split('@')[0].replace(/[^0-9]/g, "");

                // Check if this message is in a self-chat (Message to yourself / testing on bot device)
                const isSelfChat = (
                    (currentBotNum && (senderJid.includes(currentBotNum) || senderClean.includes(currentBotNum))) ||
                    (botIdNum && (senderJid.includes(botIdNum) || senderClean.includes(botIdNum))) ||
                    (botLidNum && (senderJid.includes(botLidNum) || senderClean.includes(botLidNum))) ||
                    senderJid.endsWith('@lid') // Any @lid fromMe message is self-chat on WhatsApp web / linked device
                );

                // If user is sending a message from the bot's phone to a DIFFERENT contact (regular outgoing chat), ignore it
                if (msg.key.fromMe && !isSelfChat) {
                    continue;
                }

                const senderMobile = await getActualPhoneNumber(senderJid, msg, sessionState);

                // Clean reply JID (reply directly into whatever thread initiated the message)
                let replyJid = senderJid;
                if (!msg.key.fromMe && senderJid.endsWith('@lid') && senderMobile && senderMobile !== 'Unknown' && /^\d{10,14}$/.test(senderMobile)) {
                    const formattedPhone = senderMobile.length === 10 ? `91${senderMobile}` : senderMobile;
                    replyJid = `${formattedPhone}@s.whatsapp.net`;
                }

                // Command Triggers:
                const isAadhaarTag = /^(a|aadhar|adhar|aadhaar)\b/i.test(captionText) || captionText.includes("aadhar") || captionText.includes("adhar") || captionText.includes("aadhaar");
                const isPanTag = /^(p|pan)\b/i.test(captionText) || captionText.includes("pan");
                const isJamabandiTag = /^(j|jamabandi|jama|jb)\b/i.test(captionText) || captionText.includes("jamabandi") || captionText.includes("jama") || captionText.includes("जमाबंदी");
                const isSaleDeedTag = /^(s|sale_deed|saledeed|sale deed|registry|deed)\b/i.test(captionText) || captionText.includes("sale deed") || captionText.includes("sale_deed") || captionText.includes("saledeed") || captionText.includes("बैनामा") || captionText.includes("विक्रय पत्र") || captionText.includes("रजिस्ट्री");
                const isExactGreeting = /^(hi|hello|hey|menu|help|start|namaste|hlo|helo)[\s!.,?]*$/i.test(captionText) || 
                                        captionText === 'menu' || 
                                        captionText === 'hi' ||
                                        captionText === 'help' ||
                                        captionText === 'start';

                const isCustomMenuBot = botConfig.menu_type === 'CUSTOM_MENU' || 
                                        currentBotNum.includes('9079377715') || 
                                        sessionId.includes('9079377715') || 
                                        (botConfig.phone_number && botConfig.phone_number.includes('9079377715'));

                const isCustomMenuTag = isCustomMenuBot && (
                    isExactGreeting ||
                    /^(1|2|3)$/.test(captionText) ||
                    captionText.startsWith('attandance') ||
                    captionText.startsWith('attendance') ||
                    captionText.startsWith('site') ||
                    captionText.includes('attandance') ||
                    captionText.includes('attendance') ||
                    captionText.includes('site images') ||
                    isMedia
                );

                // Determine if this incoming message is an intentional bot command/trigger
                let isBotCommand = false;

                if (isCustomMenuBot) {
                    isBotCommand = isCustomMenuTag;
                } else {
                    // DOCUMENT_OCR Bot Line:
                    // 1. Exact greeting/menu command (text only)
                    // 2. Document upload with valid tag (a, p, j, s)
                    if (isExactGreeting && !isMedia) {
                        isBotCommand = true;
                    } else if ((isMedia || quotedMsg) && (isAadhaarTag || isPanTag || isJamabandiTag || isSaleDeedTag)) {
                        isBotCommand = true;
                    }
                }

                console.log(`🎯 [${sessionId}] isCustomMenuBot=${isCustomMenuBot} | isBotCommand=${isBotCommand} | isExactGreeting=${isExactGreeting}`);

                // If NOT a bot trigger, DO NOTHING! Let normal human chat work without any bot interruption.
                if (!isBotCommand) {
                    continue;
                }

                // ---------------------------------------------------------
                // ACCESS CONTROL LAYER (WH_ALLOWED_USERS WHITELIST CHECK)
                // Evaluated ONLY when someone intentionally triggers a bot command
                // ---------------------------------------------------------
                const authCheck = await isSenderAllowed(senderMobile, sessionId);
                console.log(`🔐 [${sessionId}] Access check for ${senderMobile}: allowed=${authCheck.allowed}`);

                if (!authCheck.allowed) {
                    logEvent("ACCESS_DENIED", `Blocked unauthorized trigger from ${senderMobile} on ${sessionId}: ${authCheck.reason}`);
                    try {
                        await sock.sendMessage(replyJid, {
                            text: `⚠️ *Access Restricted*\n\nYour mobile number (+${senderMobile}) is not authorized to use this service.\nPlease contact the administrator to request access.`
                        }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(replyJid, {
                            text: `⚠️ *Access Restricted*\n\nYour mobile number (+${senderMobile}) is not authorized to use this service.\nPlease contact the administrator to request access.`
                        });
                    }
                    continue;
                }

                logEvent("LIVE_MESSAGE", `[${sessionId}] Triggered by: ${senderMobile} (${authCheck.user?.user_name || 'User'}) | Text: "${text}" | Media: ${isMedia}`);

                let targetMsgObj = msg;
                let quotedRef = null;

                if (quotedMsg && (quotedMsg.imageMessage || quotedMsg.documentMessage)) {
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

                // ---------------------------------------------------------
                // ROUTE ACCORDING TO BOT MENU TYPE
                // ---------------------------------------------------------
                if (isCustomMenuBot) {
                    console.log(`🚀 [${sessionId}] Routing to Custom Menu Flow...`);
                    await handleCustomMenuFlow({
                        sock,
                        botConfig,
                        msg: targetMsgObj,
                        senderMobile,
                        replyJid,
                        textMessage: text,
                        quotedRef,
                        isMedia,
                        mimeType
                    });
                    continue;
                }

                // DOCUMENT_OCR Flow:
                if (isExactGreeting && !isMedia) {
                    console.log(`🚀 [${sessionId}] Sending OCR menu to ${senderMobile}...`);
                    logEvent("MENU_REPLY", `Sending OCR menu to ${senderMobile}`);
                    await sendMenuResponse(sessionId, sock, replyJid, msg, sessionState.currentBotNumber);
                    continue;
                }

                if (isAadhaarTag) {
                    await handleAadhaarGeminiFlow(sessionId, sock, targetMsgObj, replyJid, senderMobile, quotedRef, mimeType, sessionState.currentBotNumber);
                } else if (isPanTag) {
                    await handlePanGeminiFlow(sessionId, sock, targetMsgObj, replyJid, senderMobile, quotedRef, mimeType, sessionState.currentBotNumber);
                } else if (isJamabandiTag) {
                    await handleJamabandiGeminiFlow(sessionId, sock, targetMsgObj, replyJid, senderMobile, quotedRef, mimeType, sessionState.currentBotNumber);
                } else if (isSaleDeedTag) {
                    await handleSaleDeedGeminiFlow(sessionId, sock, targetMsgObj, replyJid, senderMobile, quotedRef, mimeType, sessionState.currentBotNumber);
                }
            }
        } catch (err) {
            console.error(`❌ [${sessionId}] Message upsert error:`, err);
            logEvent("MESSAGE_UPSERT_ERROR", `[${sessionId}] ${err.message}`);
        }
    });
}

/**
 * Initializes all active bot instances configured in MySQL
 */
async function startAllBots() {
    await ensureBotManagementTablesExist();
    const activeBots = await getActiveBotInstances();
    console.log(`🤖 [MultiBotManager] Found ${activeBots.length} active bot configurations in database.`);

    for (const bot of activeBots) {
        startBotSession(bot);
    }
}

/**
 * Reliably sends a message, retrying if the socket is temporarily reconnecting
 */
async function safeSendMessage(sessionId, fallbackSock, jid, content, options = {}) {
    let attempts = 0;
    while (attempts < 5) {
        attempts++;
        const activeSock = (sessionId && botSockets.get(sessionId)?.sock) || fallbackSock;
        try {
            if (!activeSock) throw new Error("No active socket available");
            return await activeSock.sendMessage(jid, content, options);
        } catch (err) {
            const isConnIssue = err.message?.includes('Connection Closed') || 
                                err.message?.includes('closed') || 
                                err.output?.statusCode === 428 ||
                                err.output?.statusCode === 440;
            if (isConnIssue && attempts < 5) {
                console.log(`⏳ [${sessionId || 'Bot'}] Socket reconnecting, waiting 2s to retry delivery (Attempt ${attempts}/5)...`);
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            if (options?.quoted) {
                try {
                    return await activeSock.sendMessage(jid, content);
                } catch (e2) {}
            }
            throw err;
        }
    }
}

/**
 * Sends a helpful OCR menu guide to the user
 */
async function sendMenuResponse(sessionId, sock, replyJid, quotedMsg, botNumber = "Unknown") {
    const menuText = 
        `*Welcome to Fabkraft Document Assistant*\n` +
        `*Bot Line:* +${botNumber} &middot; \`${APP_VERSION}\`\n\n` +
        `Send your document image or PDF with the appropriate caption to extract data & save automatically:\n\n` +
        `*Aadhaar Card:*\n` +
        `• Caption: *a* or *aadhar*\n` +
        `• Format: Image or PDF\n` +
        `• Extracted: Name (English/Hindi), Relation Status, Father/Husband Name, DOB, Gender, Aadhaar No, VID, Address & PIN\n\n` +
        `*PAN Card:*\n` +
        `• Caption: *p* or *pan*\n` +
        `• Format: Image or PDF\n` +
        `• Extracted: Name, Father's Name, DOB, PAN No\n\n` +
        `*Jamabandi (Rajasthan P-26C):*\n` +
        `• Caption: *j* or *jamabandi*\n` +
        `• Format: Image or PDF\n` +
        `• Extracted: Village, Patwar Halka, Tehsil, District, Khata No, Total Area, Khatedar List & Khasra Plots\n\n` +
        `*Sale Deed (बैनामा / विक्रय पत्र):*\n` +
        `• Caption: *s* or *sale_deed*\n` +
        `• Format: Image or PDF\n` +
        `• Extracted: Deed No, Registration Date, SRO, Property Details, Area/Rakba, Boundaries, Consideration/Cheque, Seller & Buyer Details\n\n` +
        `Powered by FabKraft AI`;

    await safeSendMessage(sessionId, sock, replyJid, { text: menuText }, { quoted: quotedMsg });
}

/**
 * Handles Aadhaar Upload + AI Extraction
 */
async function handleAadhaarGeminiFlow(sessionId, sock, mediaMsgObj, replyJid, senderMobile, quotedRef = null, mimeType = 'image/jpeg', currentBotNumber = 'Unknown') {
    logEvent("AADHAAR_START", `Processing Aadhaar (${mimeType}) with AI for ${senderMobile}...`);

    await safeSendMessage(sessionId, sock, replyJid, {
        text: `Aadhaar Card detected. Extracting details and saving...`
    }, { quoted: quotedRef || mediaMsgObj });

    try {
        const buffer = await downloadMediaWithRetry(mediaMsgObj, 3);

        const timestamp = Date.now();
        const ext = mimeType === 'application/pdf' ? 'pdf' : 'jpg';
        const fileName = `aadhar_${senderMobile}_${timestamp}.${ext}`;

        const [uploadResult, geminiResult] = await Promise.all([
            uploadToFabkraft(buffer, fileName, 'aadhar', mimeType),
            extractAadhaarWithGemini(buffer, mimeType)
        ]);

        if (!uploadResult.success) {
            throw new Error(`Server upload failed: ${uploadResult.error}`);
        }

        const uploadUri = uploadResult.uploadUri;
        const details = geminiResult.data || {};

        const uploadId = await logImageUpload({
            receiverMobile: currentBotNumber,
            senderMobile: senderMobile,
            imageCaption: 'Aadhar Card',
            imageId: details.aadharNumber || `DOC${timestamp.toString().slice(-6)}`,
            uploadUri: uploadUri
        });

        const tokens = geminiResult.tokens || { promptTokens: 0, candidatesTokens: 0, totalTokens: 0 };
        const accuracy = geminiResult.accuracy || { overall: 100, aadhaarNumber: 100, fullName_English: 100, fullName_Hindi: 100, dob: 100, pincode: 100 };

        const dbResult = await insertOrUpdateAadhaar({
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
            rawJson: geminiResult.rawJson,
            detectedSide: geminiResult.detectedSide,
            tokensPrompt: tokens.promptTokens,
            tokensCompletion: tokens.candidatesTokens,
            tokensTotal: tokens.totalTokens,
            aiModel: geminiResult.model,
            accuracyOverall: accuracy.overall,
            accuracyAadhaarNumber: accuracy.aadhaarNumber,
            accuracyNameEnglish: accuracy.fullName_English,
            accuracyNameHindi: accuracy.fullName_Hindi,
            accuracyDob: accuracy.dob,
            accuracyPincode: accuracy.pincode,
            senderMobile: senderMobile,
            receiverMobile: currentBotNumber,
            uploadUri: uploadUri,
            documentUri: uploadUri,
            mimeType: mimeType
        });

        const displayVal = (val) => (val && String(val).trim().length > 0 && val !== "Not Found") ? val : "Not Found";
        const bName = details.bilingualName || { english: details.nameEnglish, hindi: details.nameHindi };
        const bFather = details.bilingualFatherName || { english: details.fatherNameEnglish, hindi: details.fatherNameHindi };
        const bHusband = details.bilingualHusbandName || { english: details.husbandNameEnglish, hindi: details.husbandNameHindi };

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
        const recordId = dbResult?.recordId || uploadId;

        const replyText = 
            `*AADHAAR EXTRACTED & SAVED*${actionLabel}\n\n` +
            `*Record ID:* #${recordId}\n` +
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

        await safeSendMessage(sessionId, sock, replyJid, { text: replyText }, { quoted: quotedRef || mediaMsgObj });
        logEvent("AADHAAR_SUCCESS", `Aadhaar processed with Record ID #${recordId} for ${senderMobile}`);

    } catch (err) {
        logEvent("AADHAAR_ERROR", `Failed for ${senderMobile}: ${err.message}`);
        const userMsg = sanitizeUserFacingError(err);
        await safeSendMessage(sessionId, sock, replyJid, {
            text: `Processing Failed: ${userMsg}`
        }, { quoted: quotedRef || mediaMsgObj });
    }
}

/**
 * Handles PAN Upload + AI Extraction
 */
async function handlePanGeminiFlow(sessionId, sock, mediaMsgObj, replyJid, senderMobile, quotedRef = null, mimeType = 'image/jpeg', currentBotNumber = 'Unknown') {
    logEvent("PAN_START", `Processing PAN (${mimeType}) with AI for ${senderMobile}...`);

    await safeSendMessage(sessionId, sock, replyJid, {
        text: `PAN Card detected. Extracting details and saving...`
    }, { quoted: quotedRef || mediaMsgObj });

    try {
        const buffer = await downloadMediaWithRetry(mediaMsgObj, 3);

        const timestamp = Date.now();
        const ext = mimeType === 'application/pdf' ? 'pdf' : 'jpg';
        const fileName = `pan_${senderMobile}_${timestamp}.${ext}`;

        const [uploadResult, geminiResult] = await Promise.all([
            uploadToFabkraft(buffer, fileName, 'pan', mimeType),
            extractPanWithGemini(buffer, mimeType)
        ]);

        if (!uploadResult.success) {
            throw new Error(`Server upload failed: ${uploadResult.error}`);
        }

        const uploadUri = uploadResult.uploadUri;
        const details = geminiResult.data || {};

        const uploadId = await logImageUpload({
            receiverMobile: currentBotNumber,
            senderMobile: senderMobile,
            imageCaption: 'PAN Card',
            imageId: details.panNumber || `DOC${timestamp.toString().slice(-6)}`,
            uploadUri: uploadUri
        });

        let panResult = null;
        if (details.panNumber && details.panNumber !== "Not Found") {
            panResult = await insertOrUpdatePan({
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
        const panRecordId = panResult?.recordId || uploadId;

        const replyText = 
            `*PAN CARD EXTRACTED & SAVED*\n\n` +
            `*Record ID:* #${panRecordId}\n` +
            `*Sent By:* ${senderMobile}\n\n` +
            `*Name:* ${displayVal(details.name)}\n` +
            `*Father's Name:* ${displayVal(details.fatherName)}\n` +
            `*Date of Birth:* ${displayVal(details.dob)}\n` +
            `*PAN Number:* ${displayVal(details.panNumber)}\n\n` +
            `Powered by FabKraft AI`;

        await safeSendMessage(sessionId, sock, replyJid, { text: replyText }, { quoted: quotedRef || mediaMsgObj });
        logEvent("PAN_SUCCESS", `PAN processed with Record ID #${panRecordId} for ${senderMobile}`);

    } catch (err) {
        logEvent("PAN_ERROR", `Failed for ${senderMobile}: ${err.message}`);
        const userMsg = sanitizeUserFacingError(err);
        await safeSendMessage(sessionId, sock, replyJid, {
            text: `Processing Failed: ${userMsg}`
        }, { quoted: quotedRef || mediaMsgObj });
    }
}

/**
 * Handles Jamabandi Upload + AI Extraction
 */
async function handleJamabandiGeminiFlow(sessionId, sock, mediaMsgObj, replyJid, senderMobile, quotedRef = null, mimeType = 'image/jpeg', currentBotNumber = 'Unknown') {
    logEvent("JAMABANDI_START", `Processing Jamabandi (${mimeType}) with AI for ${senderMobile}...`);

    await safeSendMessage(sessionId, sock, replyJid, {
        text: `Jamabandi Document detected. Extracting land records and saving...`
    }, { quoted: quotedRef || mediaMsgObj });

    try {
        const buffer = await downloadMediaWithRetry(mediaMsgObj, 3);

        const timestamp = Date.now();
        const ext = mimeType === 'application/pdf' ? 'pdf' : 'jpg';
        const fileName = `jamabandi_${senderMobile}_${timestamp}.${ext}`;

        const [uploadResult, geminiResult] = await Promise.all([
            uploadToFabkraft(buffer, fileName, 'jamabandi', mimeType),
            extractJamabandiWithGemini(buffer, mimeType)
        ]);

        if (!uploadResult.success) {
            throw new Error(`Server upload failed: ${uploadResult.error}`);
        }

        const uploadUri = uploadResult.uploadUri;
        const details = geminiResult.data || {};
        const tokens = geminiResult.tokens || { promptTokens: 0, candidatesTokens: 0, totalTokens: 0 };
        const accuracy = geminiResult.accuracy || 100;

        const docId = details.khataNoNew ? `KHATA-${details.khataNoNew}` : `DOC${timestamp.toString().slice(-6)}`;

        const uploadId = await logImageUpload({
            receiverMobile: currentBotNumber,
            senderMobile: senderMobile,
            imageCaption: 'Jamabandi',
            imageId: docId,
            uploadUri: uploadUri
        });

        const jbResult = await insertJamabandiRecord({
            uploadId,
            formName: details.formName,
            documentType: details.documentType,
            village: details.village,
            patwarHalka: details.patwarHalka,
            landInspectorCircle: details.landInspectorCircle,
            tehsil: details.tehsil,
            district: details.district,
            landHolder: details.landHolder,
            samvatPeriod: details.samvatPeriod,
            areaUnit: details.areaUnit,
            khataNoNew: details.khataNoNew,
            khataNoOld: details.khataNoOld,
            totalKhasraCount: details.totals?.totalKhasraCount,
            totalArea: details.totals?.totalArea,
            totalRent: details.totals?.totalRent,
            khatedarDetails: details.khatedarDetails,
            khasraDetails: details.khasraDetails,
            rawJson: geminiResult.rawJson,
            tokensPrompt: tokens.promptTokens,
            tokensCompletion: tokens.candidatesTokens,
            tokensTotal: tokens.totalTokens,
            aiModel: geminiResult.model,
            accuracyOverall: accuracy,
            senderMobile: senderMobile,
            receiverMobile: currentBotNumber,
            documentUri: uploadUri,
            mimeType: mimeType
        });

        const displayVal = (val) => (val && String(val).trim().length > 0 && val !== "Not Found") ? val : "Not Found";
        const jamabandiRecordId = jbResult?.recordId || uploadId;

        const khatedars = Array.isArray(details.khatedarDetails) ? details.khatedarDetails : [];
        const khasras = Array.isArray(details.khasraDetails) ? details.khasraDetails : [];

        let khatedarSummary = "";
        if (khatedars.length > 0) {
            khatedarSummary = `*Khatedars (${khatedars.length}):* ` + khatedars.slice(0, 3).map(k => k.name).filter(Boolean).join(", ") + (khatedars.length > 3 ? ` + ${khatedars.length - 3} more` : "") + "\n";
        }

        const replyText = 
            `*JAMABANDI EXTRACTED & SAVED*\n\n` +
            `*Record ID:* #${jamabandiRecordId}\n` +
            `*Sent By:* ${senderMobile}\n\n` +
            `*Village (ग्राम):* ${displayVal(details.village)}\n` +
            `*Patwar Halka:* ${displayVal(details.patwarHalka)}\n` +
            `*Tehsil (तहसील):* ${displayVal(details.tehsil)}\n` +
            `*District (जिला):* ${displayVal(details.district)}\n` +
            `*Khata No (New / Old):* ${displayVal(details.khataNoNew)} / ${displayVal(details.khataNoOld)}\n` +
            `*Total Area:* ${displayVal(details.totals?.totalArea)} ${details.areaUnit || ''}\n` +
            `*Total Khasra Count:* ${details.totals?.totalKhasraCount || khasras.length || 'Not Found'}\n` +
            khatedarSummary +
            `*Accuracy Score:* ${accuracy}%\n\n` +
            `Powered by FabKraft AI`;

        await safeSendMessage(sessionId, sock, replyJid, { text: replyText }, { quoted: quotedRef || mediaMsgObj });
        logEvent("JAMABANDI_SUCCESS", `Jamabandi processed with Record ID #${jamabandiRecordId} for ${senderMobile}`);

    } catch (err) {
        logEvent("JAMABANDI_ERROR", `Failed for ${senderMobile}: ${err.message}`);
        const userMsg = sanitizeUserFacingError(err);
        await safeSendMessage(sessionId, sock, replyJid, {
            text: `Processing Failed: ${userMsg}`
        }, { quoted: quotedRef || mediaMsgObj });
    }
}

/**
 * Handles Sale Deed Upload + AI Extraction
 */
async function handleSaleDeedGeminiFlow(sessionId, sock, mediaMsgObj, replyJid, senderMobile, quotedRef = null, mimeType = 'image/jpeg', currentBotNumber = 'Unknown') {
    logEvent("SALEDEED_START", `Processing Sale Deed (${mimeType}) with AI for ${senderMobile}...`);

    await safeSendMessage(sessionId, sock, replyJid, {
        text: `Sale Deed Document detected. Extracting registry details and saving...`
    }, { quoted: quotedRef || mediaMsgObj });

    try {
        const buffer = await downloadMediaWithRetry(mediaMsgObj, 3);

        const timestamp = Date.now();
        const ext = mimeType === 'application/pdf' ? 'pdf' : 'jpg';
        const fileName = `saledeed_${senderMobile}_${timestamp}.${ext}`;

        const [uploadResult, geminiResult] = await Promise.all([
            uploadToFabkraft(buffer, fileName, 'saledeed', mimeType),
            extractSaleDeedWithGemini(buffer, mimeType)
        ]);

        if (!uploadResult.success) {
            throw new Error(`Server upload failed: ${uploadResult.error}`);
        }

        const uploadUri = uploadResult.uploadUri;
        const details = geminiResult.data || {};
        const tokens = geminiResult.tokens || { promptTokens: 0, candidatesTokens: 0, totalTokens: 0 };
        const accuracy = geminiResult.accuracy || 100;

        const docId = details.deed_number ? `DEED-${details.deed_number}` : `DOC${timestamp.toString().slice(-6)}`;

        const uploadId = await logImageUpload({
            receiverMobile: currentBotNumber,
            senderMobile: senderMobile,
            imageCaption: 'Sale Deed',
            imageId: docId,
            uploadUri: uploadUri
        });

        const prop = details.property || {};
        const area = prop.area || {};
        const cons = details.consideration || {};
        const seller = details.seller || {};
        const buyer = details.buyer || {};

        const sdResult = await insertSaleDeedRecord({
            uploadId,
            documentType: details.document_type || 'Sale Deed',
            deedNumber: details.deed_number,
            registrationDate: details.registration_date,
            subRegistrarOffice: details.sub_registrar_office,
            transactionType: details.transaction_type,
            propertyType: prop.property_type,
            plotNumber: prop.plot_number,
            khasraNumber: prop.khasra_number,
            village: prop.village,
            tehsil: prop.tehsil,
            district: prop.district,
            areaFront: area.front,
            areaDepth: area.depth,
            totalAreaSqft: area.total_area_sqft,
            rakba: prop.rakba,
            boundaries: prop.boundaries,
            saleAmount: cons.sale_amount,
            marketValue: cons.market_value,
            paymentMode: cons.payment_mode,
            chequeNumber: cons.cheque_number,
            chequeDate: cons.cheque_date,
            sellerName: seller.seller_name,
            sellerRelationship: seller.seller_relationship,
            sellerSpouseName: seller.seller_spouse_name,
            sellerAge: seller.seller_age,
            sellerCategory: seller.category,
            sellerAddress: seller.seller_address,
            buyerName: buyer.buyer_name,
            buyerRelationship: buyer.buyer_relationship,
            buyerSpouseName: buyer.buyer_spouse_name,
            buyerAge: buyer.buyer_age,
            buyerAadhaarNumber: buyer.aadhaar_number,
            buyerCategory: buyer.category,
            buyerAddress: buyer.buyer_address,
            previousTitle: details.previous_title,
            rawJson: geminiResult.rawJson,
            tokensPrompt: tokens.promptTokens,
            tokensCompletion: tokens.candidatesTokens,
            tokensTotal: tokens.totalTokens,
            aiModel: geminiResult.model,
            accuracyOverall: accuracy,
            senderMobile: senderMobile,
            receiverMobile: currentBotNumber,
            documentUri: uploadUri,
            mimeType: mimeType
        });

        const displayVal = (val) => (val && String(val).trim().length > 0 && val !== "Not Found") ? val : "Not Found";
        const saleDeedRecordId = sdResult?.recordId || uploadId;

        let areaText = displayVal(area.total_area_sqft || prop.rakba);
        let considerationText = cons.sale_amount ? `₹${Number(cons.sale_amount).toLocaleString('en-IN')}` : 'Not Found';

        const replyText = 
            `*SALE DEED EXTRACTED & SAVED*\n\n` +
            `*Record ID:* #${saleDeedRecordId}\n` +
            `*Sent By:* ${senderMobile}\n\n` +
            `*Deed / Registry No:* ${displayVal(details.deed_number)}\n` +
            `*Registration Date:* ${displayVal(details.registration_date)}\n` +
            `*Sub-Registrar Office:* ${displayVal(details.sub_registrar_office)}\n` +
            `*Village (ग्राम):* ${displayVal(prop.village)}\n` +
            `*Tehsil (तहसील):* ${displayVal(prop.tehsil)}\n` +
            `*District (जिला):* ${displayVal(prop.district)}\n` +
            `*Khasra / Plot No:* ${displayVal(prop.khasra_number || prop.plot_number)}\n` +
            `*Area / Rakba:* ${areaText}\n` +
            `*Sale Consideration:* ${considerationText}\n` +
            `*Seller:* ${displayVal(seller.seller_name)}\n` +
            `*Buyer:* ${displayVal(buyer.buyer_name)}\n` +
            `*Accuracy Score:* ${accuracy}%\n\n` +
            `Powered by FabKraft AI`;

        await safeSendMessage(sessionId, sock, replyJid, { text: replyText }, { quoted: quotedRef || mediaMsgObj });
        logEvent("SALEDEED_SUCCESS", `Sale Deed processed with Record ID #${saleDeedRecordId} for ${senderMobile}`);

    } catch (err) {
        logEvent("SALEDEED_ERROR", `Failed for ${senderMobile}: ${err.message}`);
        const userMsg = sanitizeUserFacingError(err);
        await safeSendMessage(sessionId, sock, replyJid, {
            text: `Processing Failed: ${userMsg}`
        }, { quoted: quotedRef || mediaMsgObj });
    }
}

// ---------------------------------------------------------
// 5. BOOTSTRAP ALL CONFIGURED BOT SESSIONS
// ---------------------------------------------------------
startAllBots().catch(err => {
    console.error("❌ [Main] Error starting bot sessions:", err);
});