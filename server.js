import express from 'express';
import { useMultiFileAuthState, makeWASocket, makeInMemoryStore } from '@whiskeysockets/baileys';
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

// In-memory store
const store = makeInMemoryStore({ logger: Pino().child({ level: 'silent', stream: 'store' }) });

/**
 * Function to zip a session directory
 */
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

/**
 * Generates a random session ID
 */
const generateRandomId = () => Math.floor(10000000 + Math.random() * 90000000);

/**
 * Function to initialize and start a WhatsApp connection
 */
const startSocket = async (sessionName) => {
    const userSessionDir = path.join(sessionDir, sessionName);
    const sessionZipPath = path.join(sessionDir, `${sessionName}.zip`);

    fs.ensureDirSync(userSessionDir);

    const { state, saveCreds } = await useMultiFileAuthState(userSessionDir);

    const sock = makeWASocket({
        logger: Pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        fireInitQueries: true,
        generateHighQualityLinkPreview: true,
        syncFullHistory: true,
        markOnlineOnConnect: true,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
    });

    store.bind(sock.ev);

    // Save session whenever credentials update
    sock.ev.on('creds.update', async () => {
        await saveCreds();
        await zipSession(userSessionDir, sessionZipPath);
        log(`Session saved and zipped for ${sessionName}`);
    });

    // Handle connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
            errorLog(`Connection closed. Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) startSocket(sessionName);
        } else if (connection === 'open') {
            log(`Successfully connected for session ${sessionName}`);
        }
    });

    return sock;
};

/**
 * Route to pair a new WhatsApp session
 */
app.get('/pair', async (req, res) => {
    const phoneNumber = req.query.q;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required in ?q=' });
    }

    try {
        const randomId = generateRandomId();
        const sessionName = `${phoneNumber}-${randomId}`;

        const sock = await startSocket(sessionName);
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

/**
 * Route to download a session as a ZIP file
 */
app.get('/session/:sessionId.zip', async (req, res) => {
    const sessionId = req.params.sessionId;
    const sessionZipPath = path.join(sessionDir, `${sessionId}.zip`);

    if (!fs.existsSync(sessionZipPath)) {
        return res.status(404).json({ error: 'Session not found. Pair first.' });
    }
    res.download(sessionZipPath, `${sessionId}.zip`);
});

/**
 * Start the Express server
 */
app.listen(PORT, () => log(`API running on port ${PORT}`));
