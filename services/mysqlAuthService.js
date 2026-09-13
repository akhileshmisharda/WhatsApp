const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const pool = require('./db');

/**
 * High-performance MySQL Auth State with In-Memory Cache & Batch Fetching isolated per session_id
 * @param {string} sessionId - Unique identifier for the bot instance (e.g., 'bot_9610238234', 'bot_9079377715')
 */
async function useMySQLAuthState(sessionId = 'default') {
    const memoryCache = new Map();

    const writeData = async (id, data) => {
        try {
            memoryCache.set(id, data);
            const jsonStr = JSON.stringify(data, BufferJSON.replacer);
            const istNow = new Date(Date.now() + (330 * 60 * 1000)).toISOString().slice(0, 19).replace('T', ' ');
            await pool.execute(
                `INSERT INTO wh_baileys_auth (session_id, id, value, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
                [sessionId, id, jsonStr, istNow]
            );
        } catch (error) {
            console.error(`[MySQLAuth:${sessionId}] Error saving key ${id}:`, error.message);
        }
    };

    const readData = async (id) => {
        if (memoryCache.has(id)) {
            return memoryCache.get(id);
        }
        try {
            const [rows] = await pool.execute(
                `SELECT value FROM wh_baileys_auth WHERE session_id = ? AND id = ?`,
                [sessionId, id]
            );
            if (rows.length > 0) {
                const parsed = JSON.parse(rows[0].value, BufferJSON.reviver);
                memoryCache.set(id, parsed);
                return parsed;
            }
            return null;
        } catch (error) {
            console.error(`[MySQLAuth:${sessionId}] Error reading key ${id}:`, error.message);
            return null;
        }
    };

    const removeData = async (id) => {
        memoryCache.delete(id);
        try {
            await pool.execute(`DELETE FROM wh_baileys_auth WHERE session_id = ? AND id = ?`, [sessionId, id]);
        } catch (error) {
            console.error(`[MySQLAuth:${sessionId}] Error deleting key ${id}:`, error.message);
        }
    };

    // 1. Fetch initial credentials
    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    const missingFromCache = [];

                    // Check in-memory cache first (0ms latency)
                    for (const id of ids) {
                        const key = `${type}-${id}`;
                        if (memoryCache.has(key)) {
                            let val = memoryCache.get(key);
                            if (type === 'app-state-sync-key' && val) {
                                val = proto.Message.AppStateSyncKeyData.fromObject(val);
                            }
                            data[id] = val;
                        } else {
                            missingFromCache.push(id);
                        }
                    }

                    // Fetch missing keys in a SINGLE batch SQL query isolated by session_id
                    if (missingFromCache.length > 0) {
                        try {
                            const keysToFetch = missingFromCache.map(id => `${type}-${id}`);
                            const placeholders = keysToFetch.map(() => '?').join(',');
                            const [rows] = await pool.query(
                                `SELECT id, value FROM wh_baileys_auth WHERE session_id = ? AND id IN (${placeholders})`,
                                [sessionId, ...keysToFetch]
                            );

                            const fetchedMap = new Map();
                            for (const row of rows) {
                                fetchedMap.set(row.id, JSON.parse(row.value, BufferJSON.reviver));
                            }

                            for (const id of missingFromCache) {
                                const key = `${type}-${id}`;
                                let val = fetchedMap.get(key) || null;
                                memoryCache.set(key, val);
                                if (type === 'app-state-sync-key' && val) {
                                    val = proto.Message.AppStateSyncKeyData.fromObject(val);
                                }
                                data[id] = val;
                            }
                        } catch (err) {
                            console.error(`[MySQLAuth:${sessionId}] Batch fetch error for ${type}:`, err.message);
                            for (const id of missingFromCache) {
                                data[id] = null;
                            }
                        }
                    }

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
