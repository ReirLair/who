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

// Helper function to zip the session directory
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

// Generates a random session ID
const generateRandomId = () =>
  Math.floor(10000000 + Math.random() * 90000000).toString();

// Returns the expected zip file path for a session
const getSessionZipPath = (sessionName) =>
  path.join(sessionDir, `${sessionName}.zip`);

/**
 * Initialize and start a WhatsApp connection.
 * This version uses the exact session stuff as in your bot script.
 */
const startSocket = () => {
  // In the bot script the session is always stored under 'session'
  useMultiFileAuthState('session').then(({ state, saveCreds }) => {
    // Create a new socket instance using your settings
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
      const sessionZipPath = getSessionZipPath('session');
      await zipSession(sessionDir, sessionZipPath);
      log(`Session saved and zipped for session "session"`);
    });

    // Handle connection updates and reconnect if necessary
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'close') {
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        errorLog(`Connection closed. Reconnecting: ${shouldReconnect}`);
        if (shouldReconnect) startSocket();
      } else if (connection === 'open') {
        log(`Successfully connected!`);
      }
    });

    // If not registered (i.e. not paired) then request pairing code.
    if (!sock.authState.creds.registered) {
      // For the API, we allow a phone number to be passed as a query parameter.
      // If none is provided, we use CLI input.
      const phoneNumber =
        process.env.PHONE ||
        (() => {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          return new Promise((resolve) => {
            rl.question('Enter your phone number with country code:\n', (answer) => {
              rl.close();
              resolve(answer);
            });
          });
        })();
      Promise.resolve(phoneNumber).then(async (pn) => {
        const formattedPhoneNumber = pn.replace(/[^\d]/g, '');
        let code;
        try {
          code = await sock.requestPairingCode(formattedPhoneNumber);
          code = code.match(/.{1,4}/g)?.join('-') || code;
          log(`Pairing code: ${code}`);
        } catch (err) {
          errorLog(`Error requesting pairing code: ${err.message}`);
        }
      });
    }
  });
};

// --- API Endpoints ---

/**
 * GET /pair?q=PHONE_NUMBER
 *
 * This endpoint starts the socket (using the exact session logic from your bot script)
 * and returns a pairing code along with a download link for the session ZIP.
 */
app.get('/pair', async (req, res) => {
  // For this API, we use the same "session" store as your bot script.
  // The phone number should be passed via the ?q= query.
  const phoneNumber = req.query.q;
  if (!phoneNumber) {
    return res
      .status(400)
      .json({ error: 'Phone number is required in ?q=' });
  }

  try {
    // Generate a random session suffix so that the pairing code can be tied to a specific pairing request.
    // In the original bot script, the session was simply "session". Here, we allow multiple pairing attempts.
    const randomId = generateRandomId();
    const sessionName = `session-${phoneNumber}-${randomId}`;
    const sessionPath = path.join(sessionDir, sessionName);
    // Create a unique directory for this pairing session
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
      log(`Created session directory: ${sessionName}`);
    }

    // Start a new socket using this specific session directory
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
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

    // Save credentials and zip the session directory when creds update
    sock.ev.on('creds.update', async () => {
      await saveCreds();
      const sessionZipPath = getSessionZipPath(sessionName);
      await zipSession(sessionPath, sessionZipPath);
      log(`Session saved and zipped for ${sessionName}`);
    });

    // Handle connection updates and reconnect if necessary
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'close') {
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        errorLog(`Connection closed. Reconnecting: ${shouldReconnect}`);
        if (shouldReconnect) startSocket();
      } else if (connection === 'open') {
        log(`Successfully connected for session ${sessionName}`);
      }
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

    // Format the code in blocks of 4 characters
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
    return res
      .status(500)
      .json({ error: 'Failed to generate pairing code' });
  }
});

/**
 * GET /session/:sessionId.zip
 *
 * Endpoint to download the session ZIP file.
 */
app.get('/session/:sessionId.zip', (req, res) => {
  const sessionId = req.params.sessionId;
  const sessionZipPath = getSessionZipPath(sessionId);
  if (!fs.existsSync(sessionZipPath)) {
    return res
      .status(404)
      .json({ error: 'Session not found. Pair first.' });
  }
  return res.download(sessionZipPath, `${sessionId}.zip`);
});

/**
 * Start the Express server.
 */
app.listen(PORT, () => {
  log(`API running on port ${PORT}`);
  // Also start the default bot socket (using the "session" directory)
  startSocket();
});
