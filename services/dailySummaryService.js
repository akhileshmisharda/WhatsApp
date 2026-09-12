const axios = require("axios");

// FIXED API Endpoint
const API_URL = "http://fabkraft.in/ERP/whatsapp/getAttendanceDay.php";

async function sendDailySummary(sock, remoteJid, inputDateString) {
    try {
        const parts = inputDateString.split("-");
        if (parts.length !== 3) {
            throw new Error("Invalid date format.");
        }

        const formattedApiDate = `${parts[2]}-${parts[1]}-${parts[0]}`;

        console.log(`Downloading Daily Summary for: ${formattedApiDate}...`);

        const response = await axios.get(`${API_URL}?date=${formattedApiDate}`);
        const data = response.data;

        if (!data || !data.success) {
            await sock.sendMessage(remoteJid, {
                text: `❌ Could not find data for date: ${inputDateString}`
            });
            return;
        }

        // Safe evaluation of the monospace markdown character string (```)
        // to prevent any syntax-highlighting or copy-paste token errors
        const MONO = String.fromCharCode(96, 96, 96); 

        // ===========================================
        // Build Modern WhatsApp Report Header
        // ===========================================
        let report = "";
        report += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
        report += "*AK Consultancy - Attendance Report*\n";
        report += `Date : *${data.date}*\n`;
        report += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";

        const totalEmployees =
            Number(data.total_present) +
            Number(data.total_halfday) +
            Number(data.total_absent);

        const attendance =
            totalEmployees > 0
                ? (
                    (
                        Number(data.total_present) +
                        (Number(data.total_halfday) * 0.5)
                    ) /
                    totalEmployees *
                    100
                ).toFixed(1)
                : "0";

        // ===========================================
        // Today's Overview Block
        // ===========================================
        const orgCost = data.total_cost ? Number(data.total_cost).toLocaleString("en-IN") : "0";

        report += `📌 *OverView for The Day :  [ ₹ ${orgCost} ]*\n`;
        report += `Present      : *${data.total_present}*\n`;
        report += `Half Day     : *${data.total_halfday}*\n`;
        report += `Absent       : *${data.total_absent}*\n`;
        report += `Attendance   : *${attendance}%*\n`;
        
        report += "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";

        // ===========================================
        // Department Wise Breakdown Iteration
        // ===========================================
        data.departments.forEach((dept) => {
            const formattedDeptCost = dept.dept_cost ? Number(dept.dept_cost).toLocaleString("en-IN") : "0";

            report += `\n*${dept.name.toUpperCase()} ---->* Cost *: ₹ ${formattedDeptCost}.00*\n`;
            report += `*Present : ${dept.present}  Half Day : ${dept.halfday}  Absent : ${dept.absent}*\n\n`;

            const present = [];
            const halfDay = [];
            const absent = [];

            // Set a fixed column width for text layout alignments
            const MAX_NAME_WIDTH = 18;

            dept.staff.forEach((staffEntry) => {
                const itemParts = staffEntry.split("||");
                const mainString = itemParts[0];
                const staffWage = itemParts[1] ? Number(itemParts[1]).toLocaleString("en-IN") : "0";

                let cleanName = mainString
                    .replace(/\[A\]|\[P\]|\[H\]/gi, "")
                    .trim();

                // Pad or truncate employee name for visual table row formatting
                if (cleanName.length > MAX_NAME_WIDTH) {
                    cleanName = cleanName.substring(0, MAX_NAME_WIDTH - 3) + "...";
                }
                const paddedName = cleanName.padEnd(MAX_NAME_WIDTH, " ");

                // Group entries into specific status category arrays using monospace markdown formatting
                if (
                    mainString.includes("[A]") ||
                    mainString.toLowerCase().includes("absent")
                ) {
                    absent.push(MONO + `❌ ${paddedName} ` + MONO);
                } else if (
                    mainString.includes("[H]") ||
                    mainString.toLowerCase().includes("half")
                ) {
                    halfDay.push(MONO + `⏳ ${paddedName} : [₹ ${staffWage}.00]` + MONO);
                } else {
                    present.push(MONO + `✔️ ${paddedName} : [₹ ${staffWage}.00]` + MONO);
                }
            });

            // Append Present Staff lists to document string
            if (present.length) {
                report += present.join("\n") + "\n";
            }

            // Append Half Day Staff lists to document string
            if (halfDay.length) {
                report += "\n" + halfDay.join("\n") + "\n";
            }

            // Append Absent Staff lists to document string
            if (absent.length) {
                report += "\n" + absent.join("\n") + "\n";
            }

            // ===========================================
            // Dynamic Work Done Summary (Attached per Department)
            // ===========================================
            if (dept.work_summary && dept.work_summary.trim() !== "") {
                report += `\n📝 *Work Done :* _${dept.work_summary.trim()}_\n`;
            }

            report += "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
        });

        // ===========================================
        // Footer Component
        // ===========================================
        report += "*Powered By AK ERP*";

        // Send compiled report payload back down WhatsApp socket pipeline
        await sock.sendMessage(remoteJid, {
            text: report
        });

        console.log("Daily Summary report successfully dispatched.");

    } catch (err) {
        console.error("Failed to build daily summary:", err);
        await sock.sendMessage(remoteJid, {
            text: `⚠️ Error executing summary: ${err.message}`
        });
    }
}

module.exports = { sendDailySummary };