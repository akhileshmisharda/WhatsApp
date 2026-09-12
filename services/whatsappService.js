function getSender(msg) {
    // 1. Group sender is in msg.key.participant or msg.participant
    // 2. Direct chat sender is in msg.key.remoteJidAlt or msg.key.remoteJid
    let senderJid = msg.key.participant || msg.participant || msg.key.remoteJidAlt || msg.key.remoteJid || "";

    if (Array.isArray(senderJid)) {
        senderJid = senderJid[0] || "";
    }

    return senderJid;
}

/**
 * Get Group Subject/Name if the message was sent in a Group
 */
async function getGroupName(sock, msg) {
    const jid = msg.key.remoteJid;
    if (jid && jid.endsWith("@g.us")) {
        try {
            const metadata = await sock.groupMetadata(jid);
            return metadata.subject || "WhatsApp Group";
        } catch (err) {
            console.error("[WhatsAppService] Error fetching group metadata:", err.message);
            return "WhatsApp Group";
        }
    }
    return ""; // Empty string if direct chat
}

function getMessageType(msg) {
    if (!msg.message) return "";
    return Object.keys(msg.message)[0];
}

function getText(msg) {
    if (!msg.message) return "";
    if (msg.message.conversation) return msg.message.conversation;
    if (msg.message.extendedTextMessage) return msg.message.extendedTextMessage.text;
    if (msg.message.imageMessage) return msg.message.imageMessage.caption || "";
    if (msg.message.videoMessage) return msg.message.videoMessage.caption || "";
    if (msg.message.documentMessage) return msg.message.documentMessage.caption || "";
    return "";
}

function hasImage(msg) { return !!msg.message?.imageMessage; }
function hasVideo(msg) { return !!msg.message?.videoMessage; }
function hasDocument(msg) { return !!msg.message?.documentMessage; }
function hasAudio(msg) { return !!msg.message?.audioMessage; }

function getMediaType(msg) {
    if (hasImage(msg)) return "images";
    if (hasVideo(msg)) return "videos";
    if (hasDocument(msg)) return "documents";
    if (hasAudio(msg)) return "audio";
    return "";
}

/**
 * Send a WhatsApp reply using the active Baileys socket
 */
async function reply(sock, msg, text) {
    try {
        const jid = msg.key.remoteJid;
        await sock.sendMessage(jid, { text }, { quoted: msg });
    } catch (err) {
        console.error("[WhatsAppService] Error sending message via Baileys:", err.message);
    }
}

module.exports = {
    getSender,
    getGroupName,
    getMessageType,
    getText,
    hasImage,
    hasVideo,
    hasDocument,
    hasAudio,
    getMediaType,
    reply
};