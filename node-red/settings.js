const path = require('node:path');
const fs = require('node:fs');

const edgeStateFile = process.env.EDGE_STATE_FILE || path.join(__dirname, 'edge-state.json');

function loadEdgeState() {
  try {
    return JSON.parse(fs.readFileSync(edgeStateFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {};
  }
}

// The edge state (last settled weight of every shelf, fridge states) survives a restart through
// this file. It used to be written on every reading, and each write serialised every shelf ever
// seen, so the edge slowed down as the number of shelves grew and sent events in bursts during the load tests.
// Now it is written at most once a second, with the latest state; a crash loses at most one second
// of debounce memory, which only delays the next settled reading.
const SAVE_INTERVAL_MS = Number(process.env.EDGE_STATE_SAVE_MS || 1000);
let pendingState = null;
let saveTimer = null;
let lastSaveAt = 0;

function writeEdgeState() {
  saveTimer = null;
  if (pendingState === null) return;
  const source = pendingState;
  pendingState = null;
  lastSaveAt = Date.now();
  const state = typeof source.snapshot === 'function' ? source.snapshot() : source;
  const temporary = edgeStateFile + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(state));
  fs.renameSync(temporary, edgeStateFile);
}

// Accepts the edge processor itself (preferred, its snapshot is taken only when writing) or a
// plain state object.
function saveEdgeState(stateOrProcessor) {
  pendingState = stateOrProcessor;
  if (saveTimer) return;
  saveTimer = setTimeout(writeEdgeState, Math.max(0, lastSaveAt + SAVE_INTERVAL_MS - Date.now()));
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

process.once('exit', () => { if (saveTimer) clearTimeout(saveTimer); writeEdgeState(); });

function loadEdgeProcessor() {
  return require('./edge').createEdgeProcessor({ initialState: loadEdgeState() });
}

function signBusinessEvent(event) {
  if (process.env.EVENT_SIGNING_REQUIRED !== 'true') return event;
  const secret = process.env.EVENT_SIGNING_SECRET;
  if (!secret) throw new Error('Event signing secret is required');
  return require('../src/shared/events').signEvent(event, secret);
}

module.exports = {
  flowFile: 'flows.json',
  credentialSecret: process.env.NODE_RED_EPHEMERAL_CREDENTIALS === 'true' ? false : undefined,
  adminAuth: process.env.NODE_RED_ADMIN_PASSWORD_HASH ? {
    type: 'credentials',
    users: [{ username: 'admin', password: process.env.NODE_RED_ADMIN_PASSWORD_HASH,
      permissions: '*' }]
  } : undefined,
  functionExternalModules: false,
  functionGlobalContext: {
    edgeProcessor: loadEdgeProcessor(),
    saveEdgeState,
    signBusinessEvent
  },
  editorTheme: {
    projects: { enabled: false }
  }
};
