module.exports = {
    execute: async ({ sock, msg, employee }) => {
        console.log(`[Attendance] PRESENT: ${employee.name}`);
        
        await sock.sendMessage(msg.key.remoteJid, {
            text: `✅ Good Work, ${employee.name}!\n\nYour attendance has been marked as PRESENT.\n\n🕒 Time : ${new Date().toLocaleTimeString("en-IN")}\n\nKeep it up! 👍`
        });
    }
};