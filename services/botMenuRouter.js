/**
 * Bot Menu Router & Workflow Dispatcher
 * Allows different WhatsApp Bot numbers to run distinct interactive menus or workflows
 */

/**
 * Handles custom interactive menu for secondary bot numbers (e.g. 9079377715)
 */
async function handleCustomMenuFlow({ sock, botConfig, msg, senderMobile, replyJid, textMessage, quotedRef }) {
    const textLower = (textMessage || '').toLowerCase().trim();

    if (textLower === 'hi' || textLower === 'hello' || textLower === 'menu' || textLower === 'help' || textLower === 'start') {
        const welcomeText = 
            `👋 *Welcome to FabKraft Business Assistant*\n\n` +
            `*Bot Line:* ${botConfig.phone_number || botConfig.session_id}\n` +
            `*User:* +${senderMobile}\n\n` +
            `Please choose an option by replying with the number:\n\n` +
            `*1.* 📋 Check Registry Status\n` +
            `*2.* 🏢 Office Location & Timings\n` +
            `*3.* 📞 Request Agent Callback\n` +
            `*4.* ℹ️ System Information\n\n` +
            `_Reply with 1, 2, 3, or 4_\n` +
            `Powered by FabKraft AI`;

        await sock.sendMessage(replyJid, { text: welcomeText }, { quoted: quotedRef || msg });
        return;
    }

    if (textLower === '1') {
        await sock.sendMessage(replyJid, {
            text: `📋 *Registry Status Service*\nPlease send your 12-digit Aadhaar Number or Deed Number to look up status records.`
        }, { quoted: quotedRef || msg });
        return;
    }

    if (textLower === '2') {
        await sock.sendMessage(replyJid, {
            text: `🏢 *Office Information*\n\n*Working Hours:* 10:00 AM - 6:00 PM (Mon - Sat)\n*Location:* Sub-Registrar Complex, Rajasthan\n*Support Desk:* active`
        }, { quoted: quotedRef || msg });
        return;
    }

    if (textLower === '3') {
        await sock.sendMessage(replyJid, {
            text: `📞 *Callback Request Received*\nOur executive will call you on +${senderMobile} shortly during business hours.`
        }, { quoted: quotedRef || msg });
        return;
    }

    if (textLower === '4') {
        await sock.sendMessage(replyJid, {
            text: `ℹ️ *FabKraft Multi-Bot ERP Node*\n\n*Active Bot:* ${botConfig.bot_name}\n*Session:* ${botConfig.session_id}\n*Status:* Operational`
        }, { quoted: quotedRef || msg });
        return;
    }

    // If not a recognized menu command, stay completely silent for normal conversation
    return;
}

module.exports = {
    handleCustomMenuFlow
};

