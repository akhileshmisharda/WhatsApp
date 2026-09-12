const db = require("../services/db");

const ADMIN_NUMBERS = ["919079377715"];

module.exports = {
    execute: async ({ sock, msg, mobile }) => {
        console.log(`\n======================================`);
        console.log(`[MENU COMMAND INITIALIZED]`);
        console.log(`Sender Mobile: ${mobile}`);
        console.log(`Timestamp: ${new Date().toLocaleTimeString('en-IN')}`);

        try {
            console.log("➡️ Attempting connection to Database server...");

            // Query active commands from database
            const [activeCommands] = await db.query(
                "SELECT command_name, role_required, description FROM bot_commands WHERE is_active = 1"
            );

            console.log(`✅ DB Response Received. Total Rows: ${activeCommands ? activeCommands.length : 0}`);

            // Case: Database connected, but table returned 0 active commands
            if (!activeCommands || activeCommands.length === 0) {
                console.log("⚠️ DB Query returned empty active commands array.");

                await sock.sendMessage(msg.key.remoteJid, {
                    text: "⚠️ [DEBUG]: Database connected successfully, but no active commands were found in 'bot_commands' table."
                });
                console.log("======================================\n");
                return;
            }

            const isAdmin = ADMIN_NUMBERS.includes(mobile);

            // Filter staff vs admin commands
            const employeeCommands = activeCommands.filter(
                (cmd) => cmd.role_required === "EMPLOYEE" || cmd.role_required === "ALL"
            );

            const adminCommands = activeCommands.filter(
                (cmd) => cmd.role_required === "ADMIN"
            );

            let menuText = `📋 *FABKRAFT ERP - AVAILABLE COMMANDS*\n\n`;

            // Render Staff Commands
            if (employeeCommands.length > 0) {
                menuText += `*👤 Staff Commands:*\n`;
                employeeCommands.forEach((cmd) => {
                    const name = cmd.command_name.toUpperCase();
                    const desc = cmd.description || "No description provided";
                    menuText += `• *${name}* - ${desc}\n`;
                });
                menuText += `\n`;
            }

            // Render Admin Commands
            if (isAdmin && adminCommands.length > 0) {
                menuText += `*⚡ Admin Commands:*\n`;
                adminCommands.forEach((cmd) => {
                    const name = cmd.command_name.toUpperCase();
                    const desc = cmd.description || "No description provided";
                    menuText += `• *${name}* - ${desc}\n`;
                });
                menuText += `\n`;
            }

            menuText += `💬 _Reply with any command name to proceed._`;

            console.log("➡️ Sending rendered menu to WhatsApp...");
            await sock.sendMessage(msg.key.remoteJid, { text: menuText });
            console.log("✅ Menu sent successfully.");
            console.log("======================================\n");

        } catch (err) {
            console.error("❌ DB ERROR IN MENU HANDLER:");
            console.error(err);
            console.log("======================================\n");

            // Feedback sent to WhatsApp when connection or query fails
            await sock.sendMessage(msg.key.remoteJid, {
                text: `⚠️ *Server Connection Failed*\n\nError Details: ${err.message || "Unable to reach database"}`
            });
        }
    }
};