const { createCanvas } = require("canvas");
const fs = require("fs");
const path = require("path");

const WIDTH = 1080;
const HEIGHT = 1350;

const LEFT = 70;
const TOP = 420;

const CELL_W = 135;
const CELL_H = 95;

const COLORS = {
    bg: "#F4F7FB",
    header: "#17335C",
    white: "#FFFFFF",
    border: "#D9E2EC",
    text: "#1F2937",
    green: "#27AE60",
    red: "#E74C3C",
    blue: "#3498DB",
    yellow: "#F1C40F",
    grey: "#BDC3C7"
};

function drawRoundRect(ctx, x, y, w, h, r, color) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
}

function drawCircle(ctx, x, y, color) {
    ctx.beginPath();
    ctx.arc(x, y, 20, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
}

function statusColor(status) {
    switch (status) {
        case "P":
            return COLORS.green;
        case "A":
            return COLORS.red;
        case "H":
            return COLORS.blue;
        case "L":
            return COLORS.yellow;
        default:
            return COLORS.grey;
    }
}

function getMonthName(month) {
    return [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December"
    ][parseInt(month) - 1];
}

function calcSummary(attendance) {
    let p = 0;
    let a = 0;
    let h = 0;
    let l = 0;
    let totalMarkedDays = 0;
    let totalWorkedAttendance = 0;

    for (let i = 1; i <= 31; i++) {
        const d = attendance[i];
        if (!d || d === "" || !d.status) continue;
        
        totalMarkedDays++;
        switch (d.status) {
            case "P": 
                p++; 
                totalWorkedAttendance += 1.0;
                break;
            case "A": 
                a++; 
                break;
            case "H": 
                h++; 
                totalWorkedAttendance += 0.5; // H counts as half day
                break;
            case "L": 
                l++; 
                break;
        }
    }

    const percent = totalMarkedDays === 0 ? 0 : ((totalWorkedAttendance / totalMarkedDays) * 100).toFixed(1);
    return { p, a, h, l, total: totalMarkedDays, percent };
}

async function generate(employee, month, year) {
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    drawRoundRect(ctx, 40, 40, 1000, 110, 18, COLORS.header);

    ctx.fillStyle = "white";
    ctx.font = "bold 46px Arial";
    ctx.fillText("AK Consultancy", 190, 105);
    ctx.font = "26px Arial";
    ctx.fillText("Monthly Attendance Report", 330, 145);

    drawRoundRect(ctx, 40, 180, 1000, 180, 15, COLORS.white);

    ctx.fillStyle = COLORS.text;
    ctx.font = "bold 30px Arial";
    ctx.fillText(employee.name, 80, 235);

    ctx.font = "24px Arial";
    ctx.fillText("Staff ID : " + employee.staff_id, 80, 285);
    ctx.fillText("Department : " + employee.department, 450, 235);
    ctx.fillText("Designation : " + employee.designation, 450, 285);

    ctx.font = "bold 34px Arial";
    ctx.fillText(getMonthName(month) + " " + year, 360, 395);

    //==========================================
    // Calendar Header
    //==========================================
    const weekNames = ["Sun", "Mon", "Tue", "Wes", "Thu", "Fri", "Sat"];

    for (let i = 0; i < 7; i++) {
        drawRoundRect(ctx, LEFT + i * CELL_W, TOP, CELL_W - 5, 45, 8, COLORS.header);
        ctx.fillStyle = "white";
        ctx.font = "bold 20px Arial";
        ctx.textAlign = "center";
        ctx.fillText(weekNames[i], LEFT + i * CELL_W + (CELL_W - 5) / 2, TOP + 30);
    }

    //------------------------------------------
    const firstDay = new Date(year, month - 1, 1).getDay();
    const lastDay = new Date(year, month, 0).getDate();

    let row = 0;
    let col = firstDay;

    //------------------------------------------
    for (let day = 1; day <= lastDay; day++) {
        const x = LEFT + col * CELL_W;
        const y = TOP + 55 + row * CELL_H;

        drawRoundRect(ctx, x, y, CELL_W - 5, CELL_H - 5, 10, "white");

        ctx.strokeStyle = COLORS.border;
        ctx.strokeRect(x, y, CELL_W - 5, CELL_H - 5);

        ctx.fillStyle = COLORS.text;
        ctx.font = "bold 18px Arial";
        ctx.textAlign = "left";
        ctx.fillText(day, x + 12, y + 25);

        const data = employee.attendance[day];

        if (data !== "" && data) {
            const clr = statusColor(data.status);
            drawCircle(ctx, x + 60, y + 52, clr);

            ctx.fillStyle = "white";
            ctx.font = "bold 18px Arial";
            ctx.textAlign = "center";
            ctx.fillText(data.status, x + 60, y + 58);

            if (data.ot > 0) {
                ctx.fillStyle = COLORS.blue;
                ctx.font = "14px Arial";
                ctx.fillText("OT " + data.ot, x + 60, y + 82);
            }
        }

        col++;
        if (col > 6) {
            col = 0;
            row++;
        }
    }

    ctx.textAlign = "left";
    const summary = calcSummary(employee.attendance);

    //==========================================
    // Summary Box
    //==========================================
    drawRoundRect(ctx, 40, 1030, 1000, 220, 15, COLORS.white);

    ctx.fillStyle = COLORS.header;
    ctx.font = "bold 28px Arial";
    ctx.fillText("Attendance Summary", 70, 1075);

    const boxW = 170;
    const startX = 70;
    const startY = 1110;
    const gap = 20;

    function summaryBox(x, title, value, color) {
        drawRoundRect(ctx, x, startY, boxW, 90, 10, color);
        ctx.fillStyle = "white";
        ctx.font = "bold 20px Arial";
        ctx.textAlign = "center";
        ctx.fillText(title, x + boxW/2, startY + 35);

        ctx.font = "bold 32px Arial";
        ctx.fillText(value, x + boxW/2, startY + 72);
    }

    summaryBox(startX, "Present", summary.p, COLORS.green);
    summaryBox(startX + (boxW + gap), "Absent", summary.a, COLORS.red);
    summaryBox(startX + 2 * (boxW + gap), "Half Day", summary.h, COLORS.blue);
    summaryBox(startX + 3 * (boxW + gap), "Leave", summary.l, COLORS.yellow);

    //==========================================
    // Percentage
    //==========================================
    drawRoundRect(ctx, 790, 1095, 180, 110, 12, COLORS.header);

    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.font = "20px Arial";
    ctx.fillText("Attendance", 880, 1135);

    ctx.font = "bold 38px Arial";
    ctx.fillText(summary.percent + "%", 880, 1185);

    //==========================================
    // Footer
    //==========================================
    ctx.textAlign = "center";
    ctx.fillStyle = "#666";
    ctx.font = "20px Arial";
    ctx.fillText("Generated : " + new Date().toLocaleString("en-IN"), 70, 1295);

    ctx.textAlign = "center";
    ctx.fillText("AK Consultancy ERP", 1000, 1295);

    //==========================================
    // Save JPG
    //==========================================
    const dir = path.join("./generated", "attendance");
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const fileName = employee.staff_id + "_" + month + "_" + year + ".jpg";
    const output = path.join(dir, fileName);

    fs.writeFileSync(
        output,
        canvas.toBuffer("image/jpeg", { quality: 0.95 })
    );

    console.log("Calendar Ready");
    return output;
}

module.exports = {
    generate
};