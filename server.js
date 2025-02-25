const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const Pino = require('pino');
const archiver = require('archiver');
const readline = require('readline');
const {
  default: ToxxicTechConnect,
  useMultiFileAuthState,
  DisconnectReason,
  makeInMemoryStore,
} = require('@whiskeysockets/baileys');
const config = require('./config.js');

const app = express();
const PORT = process.env.PORT || 3000;
const sessionDir = path.join(process.cwd(), 'session');

// Ensure session directory exists
fs.ensureDirSync(sessionDir);

// Logger functions for consistent console output
const log = (message) => console.log(`[KAIZEN | ${config.prefix}] → ${message}`);
const errorLog = (message) => console.error(`[KAIZEN | ${config.prefix}] → ❌ ${message}`);

// In-memory store for sessions
const store = makeInMemoryStore({
  logger: Pino().child({ level: 'silent', stream: 'store' }),
});

// Helper function to zip a session directory
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

// Generates a random session ID (similar to your CLI bot example)
const generateRandomId = () => Math.floor(10000000 + Math.random() * 90000000);

// Creates a unique directory for each session
const getUserSessionDir = (sessionName) => path.join(sessionDir, sessionName);

// Returns the expected zip file path for a session
const getSessionZipPath = (sessionName) =>
  path.join(sessionDir, `${sessionName}.zip`);

/**
 * Initialize and start a WhatsApp connection.
 * This function adapts the CLI bot's startSocket.
 */
const startSocket = async (sessionName) => {
  const userSessionDir = getUserSessionDir(sessionName);
  fs.ensureDirSync(userSessionDir);

  const { state, saveCreds } = await useMultiFileAuthState(userSessionDir);
  const sock = ToxxicTechConnect({
    logger: Pino({ level: 'silent' }),
    printQRInTerminal: true,
    auth: state,
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

  // Save credentials when updated and zip the session directory
  sock.ev.on('creds.update', async () => {
    await saveCreds();
    const sessionZipPath = getSessionZipPath(sessionName);
    await zipSession(userSessionDir, sessionZipPath);
    log(`Session saved and zipped for ${sessionName}`);
  });

  // Handle connection updates and reconnect if necessary
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      errorLog(`Connection closed. Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) startSocket(sessionName);
    } else if (connection === 'open') {
      log(`Successfully connected for session ${sessionName}`);
    }
  });

  return sock;
};

/**
 * API endpoint to pair a new WhatsApp session.
 * The user must supply a phone number via ?q=
 * This endpoint starts the socket, requests a pairing code, and returns the code along with a session download link.
 */
app.get('/pair', async (req, res) => {
  const phoneNumber = req.query.q;
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number is required in ?q=' });
  }

  try {
    // Create a unique session name based on phone number and random ID
    const randomId = generateRandomId();
    const sessionName = `${phoneNumber}-${randomId}`;

    // Start socket (the session remains alive)
    const sock = await startSocket(sessionName);

    // Retry logic to request pairing code (up to 3 attempts)
    let code;
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        code = await sock.requestPairingCode(phoneNumber);
        if (code) break;
      } catch (error) {
        errorLog(`Attempt ${attempt + 1}: Failed to generate pairing code - ${error.message}`);
      }
      // Wait 2 seconds before retrying
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!code) throw new Error('Max retries reached. Pairing code generation failed.');

    // Format the code to appear as blocks of 4 characters
    code = code.match(/.{1,4}/g)?.join('-') || code;

    const downloadLink = `${req.protocol}://${req.get('host')}/session/${sessionName}.zip`;
    log(`Pairing code for ${phoneNumber}: ${code}`);
    return res.json({
      pairing_code: code,
      session_id: sessionName,
      session_download: downloadLink,
    });
  } catch (error) {
    errorLog(`Error generating pairing code: ${error.message}`);
    return res.status(500).json({ error: 'Failed to generate pairing code' });
  }
});

/**
 * API endpoint to download a session as a ZIP file.
 */
app.get('/session/:sessionId.zip', async (req, res) => {
  const sessionId = req.params.sessionId;
  const sessionZipPath = getSessionZipPath(sessionId);

  if (!fs.existsSync(sessionZipPath)) {
    return res.status(404).json({ error: 'Session not found. Pair first.' });
  }
  return res.download(sessionZipPath, `${sessionId}.zip`);
});

/**
 * Start the Express server.
 */
app.listen(PORT, () => {
  log(`API running on port ${PORT}`);
});
