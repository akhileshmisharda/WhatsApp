const db = require("./db"); // Uses your existing database connection module

let staffCache = [];

/**
 * Fetch staff directly from MySQL database
 */
async function loadStaffFromDB() {
    try {
        // Query staff table directly
        const [rows] = await db.query("SELECT id, name, mobile FROM staff");

        if (Array.isArray(rows)) {
            staffCache = rows.map(item => ({
                staffId: String(item.id),
                name: item.name,
                mobile: String(item.mobile)
            }));
            return staffCache;
        }
    } catch (err) {
        console.error("❌ Failed to fetch staff from MySQL DB:", err.message);
    }
    return staffCache;
}

/**
 * Get employee by mobile number
 */
async function getEmployee(mobile) {
    if (!mobile) return null;
    if (staffCache.length === 0) {
        await loadStaffFromDB();
    }

    const cleanMobile = mobile.replace(/\D/g, "");
    const last10 = cleanMobile.slice(-10);

    return staffCache.find(emp => {
        const empClean = emp.mobile.replace(/\D/g, "");
        return empClean === cleanMobile || empClean.slice(-10) === last10;
    });
}

/**
 * Returns all active staff members
 */
async function getAllEmployees() {
    if (staffCache.length === 0) {
        await loadStaffFromDB();
    }
    return staffCache;
}

module.exports = {
    getEmployee,
    getAllEmployees
};