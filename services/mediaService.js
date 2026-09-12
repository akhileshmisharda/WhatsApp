const fs = require("fs");
const path = require("path");

const {
    downloadMediaMessage
} = require("@whiskeysockets/baileys");

async function saveMedia(sock, msg, mediaType) {

    try {

        let extension = "bin";

        switch (mediaType) {

            case "images":
                extension = "jpg";
                break;

            case "videos":
                extension = "mp4";
                break;

            case "audio":
                extension = "ogg";
                break;

            case "documents":

                if (msg.message.documentMessage?.fileName) {

                    const ext = path.extname(
                        msg.message.documentMessage.fileName
                    );

                    if (ext)
                        extension = ext.replace(".", "");

                }

                break;
        }

        const buffer = await downloadMediaMessage(

            msg,

            "buffer",

            {},

            {
                logger: sock.logger,
                reuploadRequest: sock.updateMediaMessage
            }

        );

        const mobile = (
            msg.key.remoteJidAlt ||
            msg.key.remoteJid
        )
            .replace("@s.whatsapp.net", "")
            .replace("@lid", "");

        const folder = path.join(

            __dirname,

            "..",

            "uploads",

            mediaType,

            mobile

        );

        fs.mkdirSync(folder, {
            recursive: true
        });

        const fileName =
            Date.now() + "." + extension;

        const filePath =
            path.join(folder, fileName);

        fs.writeFileSync(
            filePath,
            buffer
        );

        return {

            success: true,

            mobile,

            mediaType,

            extension,

            fileName,

            filePath

        };

    }
    catch (err) {

        console.log("MEDIA ERROR");

        console.log(err);

        return {

            success: false

        };

    }

}

module.exports = {

    saveMedia

};