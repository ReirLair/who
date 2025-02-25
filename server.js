const express = require('express');
const fs = require('fs');
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

// Create session directory if it doesn't exist
const sessionDir = path.join(__dirname, 'session');
if (!fs.existsSync(sessionDir)) {
  fs.mkdirSync(sessionDir, { recursive: true });
  console.log(`[KAIZEN | ${config.prefix}] → Created session directory.`);
}

// Logger functions
const log = (message) =>
  console.log(`[KAIZEN | ${config.prefix}] → ${message}`);
const errorLog = (message) =>
  console.error(`[KAIZEN | ${config.prefix}] → ❌ ${message}`);

// In-memory store for sessions (DO NOT change this)
const store = makeInMemoryStore({
  logger: Pino().child({ level: 'silent', stream: 'store' }),
});

// Helper function to zip a directory
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

// Returns the expected zip file path for a session
const getSessionZipPath = (sessionName) =>
  path.join(sessionDir, `${sessionName}.zip`);

/**
 * Default bot socket using the single "session" directory.
 * This mirrors your working bot script.
 * Note: printQRInTerminal is false.
 */
const startDefaultSocket = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('session');
  const sock = ToxxicTechConnect({
    logger: Pino({ level: 'silent' }),
    printQRInTerminal: false,
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

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    const sessionZipPath = getSessionZipPath('session');
    await zipSession(sessionDir, sessionZipPath);
    log(`Session saved and zipped for "session"`);
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      errorLog(`Connection closed. Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) startDefaultSocket();
    } else if (connection === 'open') {
      log(`Successfully connected!`);
    }
  });

  // If not paired, request pairing code using CLI input (if PHONE env variable is not set)
  if (!sock.authState.creds.registered) {
    const phoneNumber =
      process.env.PHONE ||
      (await new Promise((resolve) => {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        rl.question('Enter your phone number with country code:\n', (answer) => {
          rl.close();
          resolve(answer);
        });
      }));
    const formattedPhoneNumber = phoneNumber.replace(/[^\d]/g, '');
    try {
      let code = await sock.requestPairingCode(formattedPhoneNumber);
      code = code.match(/.{1,4}/g)?.join('-') || code;
      log(`Pairing code: ${code}`);
    } catch (err) {
      errorLog(`Error requesting pairing code: ${err.message}`);
    }
  }

  return sock;
};

/**
 * API endpoint to request a pairing code.
 * This endpoint uses a unique session folder per pairing request.
 * The pairing code is returned along with a download link for the zipped session.
 * Note: printQRInTerminal is false.
 *
 * GET /pair?q=PHONE_NUMBER
 */
app.get('/pair', async (req, res) => {
  const phoneNumber = req.query.q;
  if (!phoneNumber) {
    return res
      .status(400)
      .json({ error: 'Phone number is required in ?q=' });
  }

  try {
    // Use a unique session folder name for this pairing request.
    const sessionName = 'session'; // Use the same session as the bot for linking
    // (Using multiple sessions can lead to linking issues.)
    const sessionPath = sessionDir; // For our case, we use the same "session" folder.

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const sock = ToxxicTechConnect({
      logger: Pino({ level: 'silent' }),
      printQRInTerminal: false,
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

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      const sessionZipPath = getSessionZipPath(sessionName);
      await zipSession(sessionDir, sessionZipPath);
      log(`Session saved and zipped for "${sessionName}"`);
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'close') {
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        errorLog(`Connection closed. Reconnecting: ${shouldReconnect}`);
        if (shouldReconnect) startDefaultSocket();
      } else if (connection === 'open') {
        log(`Successfully connected for session "${sessionName}"`);
      }
    });

    // Wait for the connection to open before requesting the pairing code.
    await new Promise((resolve) => {
      const listener = (update) => {
        if (update.connection === 'open') {
          sock.ev.off('connection.update', listener);
          resolve();
        }
      };
      sock.ev.on('connection.update', listener);
    });

    // Retry logic to request a pairing code (up to 3 attempts)
    let code;
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        code = await sock.requestPairingCode(phoneNumber);
        if (code) break;
      } catch (error) {
        errorLog(
          `Attempt ${attempt + 1}: Failed to generate pairing code - ${error.message}`
        );
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!code)
      throw new Error('Max retries reached. Pairing code generation failed.');

    code = code.match(/.{1,4}/g)?.join('-') || code;
    const downloadLink = `${req.protocol}://${req.get('host')}/session/session.zip`;
    log(`Pairing code for ${phoneNumber}: ${code}`);
    return res.json({
      pairing_code: code,
      session_id: 'session',
      session_download: downloadLink,
    });
  } catch (error) {
    errorLog(`Error generating pairing code: ${error.message}`);
    return res
      .status(500)
      .json({ error: 'Failed to generate pairing code' });
  }
});

/**
 * API endpoint to download the session ZIP.
 *
 * GET /session/session.zip
 */
app.get('/session/session.zip', (req, res) => {
  const sessionZipPath = getSessionZipPath('session');
  if (!fs.existsSync(sessionZipPath)) {
    return res
      .status(404)
      .json({ error: 'Session not found. Pair first.' });
  }
  return res.download(sessionZipPath, 'session.zip');
});

/**
 * Start the Express server.
 */
app.listen(PORT, () => {
  log(`API running on port ${PORT}`);
  // Start the default bot socket (using the "session" directory)
  startDefaultSocket();
});
