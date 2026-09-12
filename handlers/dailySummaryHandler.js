const dailySummaryService = require("../services/dailySummaryService");

module.exports = {
    execute: async ({ sock, msg, match }) => {
        const targetDate = match[1];

        console.log("########################################");
        console.log(`ADMIN COMMAND: DAILY SUMMARY FOR ${targetDate}`);
        console.log("########################################");

        await sock.sendMessage(msg.key.remoteJid, { text: `Attendance Summary : *${targetDate}...*` });
        await dailySummaryService.sendDailySummary(sock, msg.key.remoteJid, targetDate);
    }
};