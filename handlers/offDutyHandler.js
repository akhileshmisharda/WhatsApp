module.exports = {
    execute: async ({ sock, msg, employee }) => {
        console.log(`[Attendance] OFF DUTY: ${employee.name}`);
        
        await sock.sendMessage(msg.key.remoteJid, {
            text: `👋 Thank you, ${employee.name}!\n\nYour Off Duty has been recorded.\n\nHave a great day! 😊`
        });
    }
};