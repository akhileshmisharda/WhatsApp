const fs = require("fs");

async function sendAttendance(sock, employee, imagePath) {

    try {

        const jid = employee.mobile + "@s.whatsapp.net";
        const adminJid = "919610238234@s.whatsapp.net";

        const imageBuffer = fs.readFileSync(imagePath);

        // 1. Send attendance calendar to the staff member
        await sock.sendMessage(

            jid,

            {

                image: imageBuffer,

                caption:

`🏭 AK Consultancy

Good Evening *${employee.name}*,

Please find your attendance summary for this month.

Month : *${new Date().toLocaleString("en-IN", {
    month: "long",
    year: "numeric"
})}*

Thank you.
*HR Department*`

            }

        );

        // 2. Also send a copy to the specified number (919610238234)
        await sock.sendMessage(

            adminJid,

            {

                image: imageBuffer,

                caption:

`📋 Attendance Copy Sent To:

👤 Employee: ${employee.name}
📱 Mobile: ${employee.mobile}
📅 Month: ${new Date().toLocaleString("en-IN", {
    month: "long",
    year: "numeric"
})}`

            }

        );

        console.log("--------------------------------");
        console.log("Attendance Sent to Staff & Admin");
        console.log(employee.name);
        console.log(employee.mobile);
        console.log("--------------------------------");

        return true;

    }
    catch (err) {

        console.log("--------------------------------");
        console.log("Send Failed");
        console.log(employee.name);
        console.log(err.message);
        console.log("--------------------------------");

        return false;

    }

}

module.exports = {

    sendAttendance

};