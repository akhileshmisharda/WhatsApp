const path = require("path");
const db = require("./db");

const ADMIN_NUMBERS = ["919079377715"];

let commandCache = [];

async function loadCommands() {
    try {
        console.log("[CommandRouter] Fetching commands from database...");
        const [rows] = await db.query("SELECT * FROM bot_commands WHERE is_active = 1");
        commandCache = rows;
        console.log(`[CommandRouter] Successfully loaded ${commandCache.length} commands from DB.`);
    } catch (err) {
        console.error("❌ Failed to load commands from DB, using fallback array:", err.message);
        commandCache = [
            { command_name: "menu", role_required: "ALL", handler_file: "menuHandler.js" },
            { command_name: "sendattendance", role_required: "ADMIN", handler_file: "sendAttendanceHandler.js" },
            { command_name: "summary", regex_pattern: "^attendance\\s+(\\d{2}-\\d{2}-\\d{4})$", role_required: "ADMIN", handler_file: "dailySummaryHandler.js" },
            { command_name: "onduty", role_required: "EMPLOYEE", handler_file: "onDutyHandler.js" },
            { command_name: "offduty", role_required: "EMPLOYEE", handler_file: "offDutyHandler.js" }
        ];
    }
}

// Initial Load
loadCommands();

async function handleCommand({ sock, msg, mobile, text, command, employee }) {
    const isAdmin = ADMIN_NUMBERS.includes(mobile);
    
    const userText = (text || "").trim().toLowerCase();
    const userCmd = (command || "").trim().toLowerCase();

    console.log(`[CommandRouter] Processing -> Command: '${userCmd}', Full Text: '${userText}'`);

    for (const cmd of commandCache) {
        let isMatch = false;
        let matchResult = null;

        const dbCmdName = (cmd.command_name || "").trim().toLowerCase();

        if (cmd.regex_pattern) {
            const regex = new RegExp(cmd.regex_pattern, "i");
            if (regex.test(text)) {
                isMatch = true;
                matchResult = text.match(regex);
            }
        } else if (dbCmdName === userCmd || dbCmdName === userText) {
            isMatch = true;
        }

        if (isMatch) {
            console.log(`[CommandRouter] ✅ Match found: ${cmd.command_name} -> Running ${cmd.handler_file}`);

            if (cmd.role_required === "ADMIN" && !isAdmin) {
                console.log(`[Unauthorized] Non-admin (${mobile}) tried command: ${cmd.command_name}`);
                return true;
            }

            if (cmd.role_required === "EMPLOYEE" && !employee) {
                console.log(`[Unauthorized] Unknown user (${mobile}) tried employee command.`);
                return true;
            }

            try {
                const handlerPath = path.join(__dirname, "../handlers", cmd.handler_file);
                const handler = require(handlerPath);
                await handler.execute({ sock, msg, mobile, text, command, employee, match: matchResult });
                return true;
            } catch (error) {
                console.error(`❌ Error executing handler ${cmd.handler_file}:`, error);
                return true;
            }
        }
    }

    console.log(`[CommandRouter] ❌ No match found for input: '${userText}'`);
    return false;
}

module.exports = { handleCommand, reloadCommands: loadCommands };