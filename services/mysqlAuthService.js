const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const pool = require('./db');

/**
 * Custom MySQL Auth State store for Baileys
 * Stores authentication keys and credentials inside `wh_baileys_auth` table in GoDaddy MySQL.
 */
async function useMySQLAuthState() {
    const writeData = async (id, data) => {
        const jsonStr = JSON.stringify(data, BufferJSON.replacer);
        await pool.execute(
            `INSERT INTO wh_baileys_auth (id, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)`,
            [id, jsonStr]
        );
    };

    const readData = async (id) => {
        try {
            const [rows] = await pool.execute(
                `SELECT value FROM wh_baileys_auth WHERE id = ?`,
                [id]
            );
            if (rows.length > 0) {
                return JSON.parse(rows[0].value, BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            console.error(`[MySQLAuth] Error reading key ${id}:`, error.message);
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await pool.execute(`DELETE FROM wh_baileys_auth WHERE id = ?`, [id]);
        } catch (error) {
            console.error(`[MySQLAuth] Error deleting key ${id}:`, error.message);
        }
    };

    // 1. Fetch or initialize credentials
    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(key, value));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            await writeData('creds', creds);
        }
    };
}

module.exports = { useMySQLAuthState };

