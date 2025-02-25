const path = require('path');
const fs = require('fs');
const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));

// Helper function to extract session data
function extractSessionData(sessionString) {
  const parts = sessionString.split(';;;');
  if (parts.length === 2) {
    try {
      const sessionData = JSON.parse(parts[1]);
      return sessionData;
    } catch (error) {
      throw new Error('Invalid JSON format');
    }
  } else {
    throw new Error('Invalid session ID format');
  }
}

const rawSessionId = 'Put Session here';

let sessionId;
try {
  sessionId = extractSessionData(rawSessionId);
} catch (error) {
  console.error('Error extracting session ID:', error.message);
  sessionId = null;
}

// Bot Configuration
const config = {
  VERSION: packageJson.version, // Bot version from package.json
  SESSION_ID: sessionId || 'default-session-id', // Session data or placeholder
  OWNER: '‪3584573986503‬@s.whatsapp.net', // Owner's full WhatsApp JID
  PREFIX: '!', // Command prefix
  MODE: 'public', // Bot operation mode: 'private' or 'public'
};

module.exports = config;
