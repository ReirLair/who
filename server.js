import express from 'express';
import { useMultiFileAuthState, ToxxicTechConnect } from '@whiskeysockets/baileys';
import Pino from 'pino';
import fs from 'fs-extra';
import path from 'path';
import archiver from 'archiver';

const app = express();
const PORT = process.env.PORT || 3000;
const sessionDir = path.join(process.cwd(), 'session');

// Ensure session directory exists
fs.ensureDirSync(sessionDir);

// Logger
const log = (message) => console.log(`[SESSION-API] → ${message}`);
const errorLog = (message) => console.error(`[SESSION-API] → ❌ ${message}`);

// Function to generate a random 8-digit number
const generateRandomId = () => Math.floor(10000000 + Math.random() * 90000000);

// Function to zip session directory
const zipSession = async (sessionPath, sessionZipPath) => {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(sessionZipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve(true));
        archive.on('error', (err) => reject(err));

        archive.pipe(output);
        archive.directory(sessionPath, false);
        archive.finalize();
    });
};

// Pairing route: `/pair?q=2347087243475`
app.get('/pair', async (req, res) => {
    const phoneNumber = req.query.q;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required in ?q=' });
    }

    try {
        const randomId = generateRandomId();
        const sessionName = `${phoneNumber}-${randomId}`;
        const userSessionDir = path.join(sessionDir, sessionName);
        const sessionZipPath = path.join(sessionDir, `${sessionName}.zip`);

        fs.ensureDirSync(userSessionDir);

        const { state, saveCreds } = await useMultiFileAuthState(userSessionDir);

        const sock = ToxxicTechConnect({
            logger: Pino({ level: 'silent' }),
            auth: state,
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
        });

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            await zipSession(userSessionDir, sessionZipPath); // Auto-zip session when paired
            log(`Session saved and zipped for ${sessionName}`);
        });

        let code = await sock.requestPairingCode(phoneNumber);
        code = code?.match(/.{1,4}/g)?.join('-') || code;

        const downloadLink = `${req.protocol}://${req.get('host')}/session/${sessionName}.zip`;
        res.json({ pairing_code: code, session_id: sessionName, session_download: downloadLink });

        log(`Pairing code for ${phoneNumber}: ${code}`);
    } catch (error) {
        errorLog(`Error generating pairing code: ${error.message}`);
        res.status(500).json({ error: 'Failed to generate pairing code' });
    }
});

// Session download route: `/session/{phoneNumber}-{randomId}.zip`
app.get('/session/:sessionId.zip', async (req, res) => {
    const sessionId = req.params.sessionId;
    const sessionZipPath = path.join(sessionDir, `${sessionId}.zip`);

    if (!fs.existsSync(sessionZipPath)) {
        return res.status(404).json({ error: 'Session not found. Pair first.' });
    }
    res.download(sessionZipPath, `${sessionId}.zip`);
});

app.listen(PORT, () => log(`API running on port ${PORT}`));
