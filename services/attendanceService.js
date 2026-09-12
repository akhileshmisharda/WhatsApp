const axios = require("axios");

const calendarService = require("./calendarService");
const whatsappSender = require("./whatsappSender");

const API_URL = "http://fabkraft.in/ERP/whatsapp/getAttendanceMonth.php";

async function getAttendance(month = "", year = "") {
    try {
        let url = API_URL;

        if (month !== "" && year !== "") {
            url += `?month=${month}&year=${year}`;
        }

        console.log("Downloading Attendance...");
        const response = await axios.get(url);
        return response.data;
    }
    catch (err) {
        console.log(err.message);
        return null;
    }
}

async function sendAttendanceToAll(sock) {
    const data = await getAttendance();

    if (!data) {
        console.log("Attendance Download Failed");
        return;
    }

    // Extract target month and year from the API payload wrapper, or fallback to current system date strings
    const targetMonth = data.month || String(new Date().getMonth() + 1).padStart(2, '0');
    const targetYear = data.year || String(new Date().getFullYear());

    console.log("");
    console.log("===================================");
    console.log("Employees :", data.employees.length);
    console.log("Target Period :", `${targetMonth}/${targetYear}`);
    console.log("===================================");

for (const employee of data.employees) {
    if (!employee.mobile || employee.mobile.trim() === "") {
        console.log(`\nSkipping ${employee.name}: No mobile number available.`);
        continue;
    }

    console.log("");
    console.log("Generating Calendar...");
    console.log(employee.name);

    // ✅ Create a safe shallow clone right here before passing it to calendarService
    // This stops calendarService from altering the real employee.mobile property
    const generatorCopy = { ...employee };
    const image = await calendarService.generate(generatorCopy, targetMonth, targetYear);

    // ✅ Pass the pristine, unmodified original employee object to the WhatsApp sender
    await whatsappSender.sendAttendance(
        sock,
        employee,
        image
    );
}
}

module.exports = {
    getAttendance,
    sendAttendanceToAll
};