const attendanceService = require("../services/attendanceService");

module.exports = {
    execute: async ({ sock, msg }) => {
        console.log("########################################");
        console.log("ADMIN COMMAND: SEND ATTENDANCE");
        console.log("########################################");

        await sock.sendMessage(msg.key.remoteJid, { text: "⏳ Generating attendance reports..." });
        await attendanceService.sendAttendanceToAll(sock);
        await sock.sendMessage(msg.key.remoteJid, { text: "✅ Attendance sending completed." });
    }
};