const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const P = require('pino');

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth');

    const sock = makeWASocket({
        auth: state,
        logger: P({ level: 'silent' }),
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    // Monitor Incoming Messages
    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const msg = chatUpdate.messages[0];

            // Ignore system messages or messages without contents
            if (!msg || !msg.message) return;

            // Unpack message structure (handles ephemeral/viewOnce wrappers if any)
            const messageContent = msg.message.ephemeralMessage?.message || msg.message;

            // Check if incoming message is an Order from Catalog
            if (messageContent.orderMessage) {
                const order = messageContent.orderMessage;
                const senderJid = msg.key.remoteJid;
                const customerPhone = senderJid.split('@')[0];

                console.log('\n========================================');
                console.log('🛒 NEW CATALOG ORDER RECEIVED!');
                console.log(`👤 Customer JID: ${senderJid}`);
                console.log(`📱 Phone: ${customerPhone}`);
                console.log(`🆔 Order ID: ${order.orderId}`);
                console.log(`Status: ${order.status}`);
                console.log(`Token: ${order.token}`);
                console.log('----------------------------------------');

                // Extract Ordered Items
                const items = order.items || [];
                console.log(`📦 Total Unique Items: ${items.length}`);
                console.log(`🔢 Item Count Total: ${order.itemCount}`);

                let totalAmountCalculated = 0;

                items.forEach((item, idx) => {
                    // Price is sent in micro-units (divide by 1,000,000 to get base currency value)
                    const unitPrice = item.price ? item.price / 1000000 : 0;
                    const itemTotal = unitPrice * item.quantity;
                    totalAmountCalculated += itemTotal;

                    console.log(`\n  Item #${idx + 1}:`);
                    console.log(`  - Product ID / SKU: ${item.retailerId || item.item_retailer_id}`);
                    console.log(`  - Title: ${item.name || 'Catalog Item'}`);
                    console.log(`  - Quantity: ${item.quantity}`);
                    console.log(`  - Unit Price: ${unitPrice} ${order.currency || 'INR'}`);
                    console.log(`  - Total: ${itemTotal} ${order.currency || 'INR'}`);
                });

                console.log('----------------------------------------');
                console.log(`💰 Estimated Order Total: ${totalAmountCalculated} ${order.currency || 'INR'}`);
                if (order.message) {
                    console.log(`📝 Customer Note: "${order.message}"`);
                }
                console.log('========================================\n');

                // Send Confirmation Reply back to the customer
                await sock.sendMessage(senderJid, {
                    text: `✅ *Order Received!*\n\nThank you for your order (ID: ${order.orderId}).\nWe are processing your items and will get back to you shortly.`
                }, { quoted: msg });
            }
        } catch (err) {
            console.error('Error parsing catalog order:', err);
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Bot is active and listening for Catalog Orders!');
        }
    });
}

startBot();