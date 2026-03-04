#!/usr/bin/env node
/**
 * OpenHamClock Rig Listener v1.1.0
 *
 * A single, self-contained bridge between your radio and OpenHamClock.
 * Talks directly to your radio via USB/serial or TCI WebSocket —
 * no flrig, no rigctld needed.
 *
 * Distributed as a standalone executable — no Node.js installation required.
 *
 * Supported radios:
 *   • Yaesu    (FT-991A, FT-891, FT-710, FT-DX10, FT-DX101, FT-450, FT-817/818, etc.)
 *   • Kenwood / Elecraft  (TS-590, TS-890, K3, K4, KX3, KX2, etc.)
 *   • Icom    (IC-7300, IC-7610, IC-705, IC-9700, etc.)
 *   • TCI/SDR (Thetis/HL2, ANAN, SunSDR, ExpertSDR — via TCI WebSocket)
 *
 * Usage:
 *   ./rig-listener                     (interactive wizard on first run)
 *   ./rig-listener --port COM3         (quick start with port override)
 *   ./rig-listener --tci               (connect to TCI on localhost:40001)
 *   ./rig-listener --mock              (simulation mode, no radio needed)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const VERSION = '1.1.0';
const HTTP_PORT_DEFAULT = 5555;

// Config lives NEXT TO the executable (or cwd for dev), NOT inside the pkg snapshot
const CONFIG_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const CONFIG_FILE = path.join(CONFIG_DIR, 'rig-listener-config.json');

// ============================================
// RADIO STATE
// ============================================
const state = {
  freq: 0,
  mode: '',
  width: 0,
  ptt: false,
  connected: false,
  lastUpdate: 0,
};

let sseClients = [];

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter((c) => {
    try {
      c.write(msg);
      return true;
    } catch {
      return false;
    }
  });
}

function updateState(prop, value) {
  if (state[prop] === value) return;
  state[prop] = value;
  state.lastUpdate = Date.now();
  broadcast({ type: 'update', prop, value });
}

// ============================================
// YAESU CAT PROTOCOL (text, semicolon-terminated)
// FT-991A, FT-891, FT-710, FT-DX10, FT-DX101, FT-450D, etc.
// ============================================
const YAESU_MODES = {
  1: 'LSB',
  2: 'USB',
  3: 'CW',
  4: 'FM',
  5: 'AM',
  6: 'RTTY-LSB',
  7: 'CW-R',
  8: 'DATA-LSB',
  9: 'RTTY-USB',
  A: 'DATA-FM',
  B: 'FM-N',
  C: 'DATA-USB',
  D: 'AM-N',
};
const YAESU_MODES_REV = Object.fromEntries(Object.entries(YAESU_MODES).map(([k, v]) => [v, k]));

const YaesuProtocol = {
  buffer: '',

  buildPollCommands() {
    return ['FA;', 'MD0;', 'TX;'];
  },

  parseResponse(chunk) {
    this.buffer += chunk;
    const commands = [];
    let idx;
    while ((idx = this.buffer.indexOf(';')) !== -1) {
      commands.push(this.buffer.substring(0, idx + 1));
      this.buffer = this.buffer.substring(idx + 1);
    }
    for (const cmd of commands) {
      if (cmd === '?;') {
        console.log('[Yaesu] Radio returned error (?;) — command not recognised or radio busy');
      } else if (cmd.startsWith('FA') && cmd.length >= 11) {
        const freq = parseInt(cmd.substring(2, cmd.length - 1));
        if (freq > 0) updateState('freq', freq);
      } else if (cmd.startsWith('MD0') && cmd.length >= 4) {
        const code = cmd.charAt(3);
        const mode = YAESU_MODES[code] || code;
        updateState('mode', mode);
      } else if (cmd.startsWith('TX') && cmd.length >= 3) {
        updateState('ptt', cmd.charAt(2) !== '0');
      } else if (cmd.startsWith('IF') && cmd.length >= 27) {
        const freq = parseInt(cmd.substring(5, 14));
        if (freq > 0) updateState('freq', freq);
        const modeCode = cmd.charAt(21);
        const mode = YAESU_MODES[modeCode] || modeCode;
        if (mode) updateState('mode', mode);
      }
    }
  },

  setFreqCmd(hz) {
    return `FA${String(Math.round(hz)).padStart(9, '0')};`;
  },

  setModeCmd(mode) {
    const code = YAESU_MODES_REV[mode] || YAESU_MODES_REV[mode.toUpperCase()];
    return code ? `MD0${code};` : null;
  },

  setPttCmd(on) {
    return on ? 'TX1;' : 'TX0;';
  },
};

// ============================================
// KENWOOD / ELECRAFT PROTOCOL
// ============================================
const KENWOOD_MODES = {
  1: 'LSB',
  2: 'USB',
  3: 'CW',
  4: 'FM',
  5: 'AM',
  6: 'FSK',
  7: 'CW-R',
  9: 'FSK-R',
};
const KENWOOD_MODES_REV = Object.fromEntries(Object.entries(KENWOOD_MODES).map(([k, v]) => [v, k]));

const KenwoodProtocol = {
  buffer: '',

  buildPollCommands() {
    return ['FA;', 'MD;', 'TX;'];
  },

  parseResponse(chunk) {
    this.buffer += chunk;
    const commands = [];
    let idx;
    while ((idx = this.buffer.indexOf(';')) !== -1) {
      commands.push(this.buffer.substring(0, idx + 1));
      this.buffer = this.buffer.substring(idx + 1);
    }
    for (const cmd of commands) {
      if (cmd === '?;') {
        console.log('[Kenwood] Radio returned error (?;) — command not recognised or radio busy');
      } else if (cmd.startsWith('FA') && cmd.length >= 13) {
        const freq = parseInt(cmd.substring(2, cmd.length - 1));
        if (freq > 0) updateState('freq', freq);
      } else if (cmd.startsWith('MD') && cmd.length >= 3) {
        const code = cmd.charAt(2);
        updateState('mode', KENWOOD_MODES[code] || code);
      } else if (cmd.startsWith('TX') && cmd.length >= 3) {
        updateState('ptt', cmd.charAt(2) !== '0');
      } else if (cmd.startsWith('IF') && cmd.length >= 37) {
        const freq = parseInt(cmd.substring(2, 13));
        if (freq > 0) updateState('freq', freq);
        const modeCode = cmd.charAt(29);
        updateState('mode', KENWOOD_MODES[modeCode] || modeCode);
      }
    }
  },

  setFreqCmd(hz) {
    return `FA${String(Math.round(hz)).padStart(11, '0')};`;
  },

  setModeCmd(mode) {
    const code = KENWOOD_MODES_REV[mode] || KENWOOD_MODES_REV[mode.toUpperCase()];
    return code ? `MD${code};` : null;
  },

  setPttCmd(on) {
    return on ? 'TX1;' : 'RX;';
  },
};

// ============================================
// ICOM CI-V PROTOCOL (binary)
// ============================================
const ICOM_MODES = {
  0x00: 'LSB',
  0x01: 'USB',
  0x02: 'AM',
  0x03: 'CW',
  0x04: 'RTTY',
  0x05: 'FM',
  0x06: 'WFM',
  0x07: 'CW-R',
  0x08: 'RTTY-R',
  0x17: 'DV',
};
const ICOM_MODES_REV = Object.fromEntries(Object.entries(ICOM_MODES).map(([k, v]) => [v, parseInt(k)]));
const ICOM_ADDRESSES = {
  'IC-7300': 0x94,
  'IC-7610': 0x98,
  'IC-705': 0xa4,
  'IC-9700': 0xa2,
  'IC-7100': 0x88,
  'IC-7851': 0x8e,
  'IC-7600': 0x7a,
  'IC-746': 0x56,
  'IC-718': 0x5e,
};

const IcomProtocol = {
  buffer: Buffer.alloc(0),
  civAddr: 0x94,
  controllerAddr: 0xe0,

  buildPollCommands() {
    return [this._frame([0x03]), this._frame([0x04]), this._frame([0x1c, 0x00])];
  },

  _frame(payload) {
    return Buffer.from([0xfe, 0xfe, this.civAddr, this.controllerAddr, ...payload, 0xfd]);
  },

  parseResponse(chunk) {
    this.buffer = Buffer.concat([this.buffer, typeof chunk === 'string' ? Buffer.from(chunk, 'binary') : chunk]);
    while (true) {
      const start = this.buffer.indexOf(Buffer.from([0xfe, 0xfe]));
      if (start === -1) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const endIdx = this.buffer.indexOf(0xfd, start + 2);
      if (endIdx === -1) {
        this.buffer = this.buffer.subarray(start);
        return;
      }

      const frame = this.buffer.subarray(start, endIdx + 1);
      this.buffer = this.buffer.subarray(endIdx + 1);
      if (frame.length < 6) continue;
      if (frame[2] !== this.controllerAddr) continue;

      const cmd = frame[4];
      const data = frame.subarray(5, frame.length - 1);

      if ((cmd === 0x03 || cmd === 0x00) && data.length >= 5) {
        const freq = this._bcdToFreq(data);
        if (freq > 0) updateState('freq', freq);
      } else if ((cmd === 0x04 || cmd === 0x01) && data.length >= 1) {
        updateState('mode', ICOM_MODES[data[0]] || `MODE_${data[0].toString(16)}`);
      } else if (cmd === 0x1c && data.length >= 2 && data[0] === 0x00) {
        updateState('ptt', data[1] === 0x01);
      }
    }
  },

  _bcdToFreq(data) {
    let freq = 0,
      mult = 1;
    for (let i = 0; i < Math.min(data.length, 5); i++) {
      freq += (data[i] & 0x0f) * mult;
      mult *= 10;
      freq += ((data[i] >> 4) & 0x0f) * mult;
      mult *= 10;
    }
    return freq;
  },

  _freqToBcd(hz) {
    const buf = Buffer.alloc(5);
    let f = Math.round(hz);
    for (let i = 0; i < 5; i++) {
      const lo = f % 10;
      f = Math.floor(f / 10);
      const hi = f % 10;
      f = Math.floor(f / 10);
      buf[i] = (hi << 4) | lo;
    }
    return buf;
  },

  setFreqCmd(hz) {
    return this._frame([0x05, ...this._freqToBcd(hz)]);
  },

  setModeCmd(mode) {
    const code = ICOM_MODES_REV[mode] ?? ICOM_MODES_REV[mode.toUpperCase()];
    return code !== undefined ? this._frame([0x06, code, 0x01]) : null;
  },

  setPttCmd(on) {
    return this._frame([0x1c, 0x00, on ? 0x01 : 0x00]);
  },
};

// ============================================
// MOCK PROTOCOL
// ============================================
const MockProtocol = {
  buildPollCommands() {
    return [];
  },
  parseResponse() {},
  setFreqCmd() {
    return null;
  },
  setModeCmd() {
    return null;
  },
  setPttCmd() {
    return null;
  },
};

// ============================================
// TCI PROTOCOL (WebSocket — Thetis/HL2, SunSDR, ExpertSDR)
// https://github.com/ExpertSDR3/TCI
//
// TCI is a WebSocket-based transceiver control interface used by
// modern SDR applications: Thetis (Apache Labs HL2/ANAN),
// ExpertSDR (SunSDR), and others.  Unlike serial CAT protocols,
// TCI pushes state changes in real-time — no polling needed.
//
// Default endpoint: ws://localhost:40001
// ============================================
const TCI_MODES = {
  am: 'AM',
  sam: 'SAM',
  dsb: 'DSB',
  lsb: 'LSB',
  usb: 'USB',
  cw: 'CW',
  nfm: 'FM',
  wfm: 'WFM',
  digl: 'DATA-LSB',
  digu: 'DATA-USB',
  spec: 'SPEC',
  drm: 'DRM',
};
const TCI_MODES_REV = {
  LSB: 'lsb',
  USB: 'usb',
  CW: 'cw',
  'CW-R': 'cw',
  AM: 'am',
  FM: 'nfm',
  WFM: 'wfm',
  'DATA-USB': 'digu',
  'DATA-LSB': 'digl',
  'DATA-FM': 'nfm',
  'RTTY-USB': 'digu',
  'RTTY-LSB': 'digl',
  SAM: 'sam',
  DSB: 'dsb',
  DRM: 'drm',
};

const TciProtocol = {
  buffer: '',
  trx: 0, // transceiver index (0 = primary)
  vfo: 0, // VFO index (0 = VFO-A)

  // TCI pushes state — no polling required
  buildPollCommands() {
    return [];
  },

  parseResponse(chunk) {
    this.buffer += chunk;
    const messages = [];
    let idx;
    while ((idx = this.buffer.indexOf(';')) !== -1) {
      messages.push(this.buffer.substring(0, idx + 1));
      this.buffer = this.buffer.substring(idx + 1);
    }
    for (const raw of messages) {
      const msg = raw.replace(/;$/, '');
      // TCI format: "name:arg1,arg2,..."  or just "name"
      const colonIdx = msg.indexOf(':');
      const name = (colonIdx === -1 ? msg : msg.substring(0, colonIdx)).toLowerCase().trim();
      const argStr = colonIdx === -1 ? '' : msg.substring(colonIdx + 1);
      const args = argStr ? argStr.split(',').map((s) => s.trim()) : [];

      switch (name) {
        case 'vfo': {
          // vfo:rx,sub_vfo,freq_hz;
          const rx = parseInt(args[0]);
          const sub = parseInt(args[1]);
          const freq = parseInt(args[2]);
          if (rx === this.trx && sub === this.vfo && freq > 0) {
            updateState('freq', freq);
          }
          break;
        }
        case 'modulation': {
          // modulation:rx,mode_name;
          const rx = parseInt(args[0]);
          const modeName = (args[1] || '').toLowerCase();
          if (rx === this.trx && modeName) {
            updateState('mode', TCI_MODES[modeName] || modeName.toUpperCase());
          }
          break;
        }
        case 'trx': {
          // trx:rx,true|false;
          const rx = parseInt(args[0]);
          const txOn = (args[1] || '').toLowerCase() === 'true';
          if (rx === this.trx) {
            updateState('ptt', txOn);
          }
          break;
        }
        case 'rx_filter_band': {
          // rx_filter_band:rx,low_hz,high_hz;
          const rx = parseInt(args[0]);
          const lo = parseInt(args[1]);
          const hi = parseInt(args[2]);
          if (rx === this.trx && !isNaN(lo) && !isNaN(hi)) {
            updateState('width', hi - lo);
          }
          break;
        }
        case 'protocol':
          console.log(`[TCI] Server protocol: ${argStr}`);
          break;
        case 'device':
          console.log(`[TCI] Device: ${argStr}`);
          break;
        case 'receive_only':
          if ((args[0] || '').toLowerCase() === 'true') {
            console.log('[TCI] ⚠️  Radio is in receive-only mode (PTT disabled server-side)');
          }
          break;
        case 'ready':
          console.log('[TCI] Server ready');
          break;
        // Silently ignore high-frequency messages we don't need
        case 'iq_samplerate':
        case 'audio_samplerate':
        case 'iq_start':
        case 'iq_stop':
        case 'audio_start':
        case 'audio_stop':
        case 'spot':
        case 'drive':
        case 'tune_drive':
        case 'sql_enable':
        case 'sql_level':
        case 'mute':
        case 'rx_enable':
        case 'rx_sensors':
        case 'tx_sensors':
        case 'cw_macros_speed':
        case 'volume':
        case 'rx_smeter':
          break;
        default:
          // Log unknown commands at debug level
          // console.log(`[TCI] Unhandled: ${raw}`);
          break;
      }
    }
  },

  setFreqCmd(hz) {
    return `VFO:${this.trx},${this.vfo},${Math.round(hz)};`;
  },

  setModeCmd(mode) {
    const tciMode = TCI_MODES_REV[mode] || TCI_MODES_REV[mode.toUpperCase()] || mode.toLowerCase();
    return `MODULATION:${this.trx},${tciMode};`;
  },

  setPttCmd(on) {
    return `TRX:${this.trx},${on ? 'true' : 'false'};`;
  },
};

// ============================================
// SERIAL ENGINE
// ============================================
let serialPort = null;
let tciSocket = null;
let tciReconnectTimer = null;
let protocol = null;
let pollTimer = null;
let config = null;

async function initSerial(cfg) {
  config = cfg;
  const brand = cfg.radio.brand.toLowerCase();

  if (brand === 'yaesu') protocol = YaesuProtocol;
  else if (brand === 'kenwood' || brand === 'elecraft') protocol = KenwoodProtocol;
  else if (brand === 'icom') {
    protocol = IcomProtocol;
    IcomProtocol.civAddr = cfg.radio.civAddress || 0x94;
  } else if (brand === 'tci') {
    // Shouldn't reach here — main() routes TCI to initTci()
    return initTci(cfg);
  } else if (brand === 'mock') {
    protocol = MockProtocol;
    state.connected = true;
    state.freq = 14074000;
    state.mode = 'USB';
    return;
  } else {
    console.error(`[Error] Unknown brand: ${brand}`);
    process.exit(1);
  }

  let SerialPort;
  try {
    SerialPort = require('serialport').SerialPort;
  } catch (e) {
    console.error(`\n  ❌ Serial port library not available: ${e.message}`);
    if (!process.pkg) console.error('     Run: npm install');
    process.exit(1);
  }

  const portPath = cfg.serial.port;
  console.log(`[Serial] Opening ${portPath} at ${cfg.serial.baudRate} baud...`);

  try {
    serialPort = new SerialPort({
      path: portPath,
      baudRate: cfg.serial.baudRate,
      dataBits: cfg.serial.dataBits || 8,
      stopBits: cfg.serial.stopBits || 2,
      parity: cfg.serial.parity || 'none',
      autoOpen: false,
      hupcl: false, // Don't drop DTR/RTS when port closes — prevents re-init issues on Windows
    });
  } catch (e) {
    console.error(`[Serial] Failed to create port: ${e.message}`);
    process.exit(1);
  }

  serialPort.on('open', () => {
    console.log(`[Serial] ✅ Connected to ${portPath}`);
    state.connected = true;
    broadcast({ type: 'update', prop: 'connected', value: true });

    // Assert DTR HIGH so the radio's USB interface will send responses back.
    // Windows USB-serial drivers (CP210x, FTDI) default DTR to LOW on open;
    // terminal programs like PuTTY assert it HIGH, which is why they work out
    // of the box.  Without DTR the radio accepts commands but returns nothing —
    // connected shows true but freq/mode/ptt all stay at 0 (FT-DX10, FT-991A,
    // and other Yaesu/Icom radios with CP210x USB chips exhibit this symptom).
    serialPort.set({ dtr: true, rts: false }, (err) => {
      if (err) console.log(`[Serial] Warning: could not set DTR: ${err.message}`);
    });

    // Wait 300 ms before starting polls — on Windows the CP210x/FTDI USB driver
    // needs a moment after open before the receive path is fully active.  Without
    // this delay the first several responses from the radio are silently dropped,
    // leaving the listener in a permanently-stale state.
    setTimeout(() => {
      if (!serialPort?.isOpen) return;
      pollTimer = setInterval(() => {
        if (!serialPort?.isOpen) return;
        for (const cmd of protocol.buildPollCommands()) {
          try {
            serialPort.write(cmd);
          } catch (e) {
            console.log(`[Serial] Write error: ${e.message}`);
          }
        }
      }, cfg.radio.pollInterval || 500);
    }, 300);
  });

  serialPort.on('data', (data) => {
    protocol.parseResponse(brand === 'icom' ? data : data.toString('utf8'));
  });

  serialPort.on('error', (err) => {
    console.error(`[Serial] Error: ${err.message}`);
    state.connected = false;
    broadcast({ type: 'update', prop: 'connected', value: false });
  });

  serialPort.on('close', () => {
    console.log('[Serial] Disconnected — reconnecting in 5s...');
    state.connected = false;
    broadcast({ type: 'update', prop: 'connected', value: false });
    if (pollTimer) clearInterval(pollTimer);
    setTimeout(() => reconnect(cfg), 5000);
  });

  serialPort.open((err) => {
    if (err) {
      console.error(`[Serial] ❌ Cannot open ${portPath}: ${err.message}`);
      console.error('');
      console.error('  Troubleshooting:');
      console.error('    • Is the USB cable connected?');
      console.error('    • Is another program using this port? (flrig, WSJT-X, etc.)');
      if (process.platform === 'linux') console.error('    • Try: sudo usermod -a -G dialout $USER  (then log out/in)');
      if (process.platform === 'win32') console.error('    • Check Device Manager → Ports for correct COM port');
      console.error('');
      setTimeout(() => reconnect(cfg), 5000);
    }
  });
}

function reconnect(cfg) {
  if (serialPort) {
    try {
      serialPort.close();
    } catch {}
    serialPort = null;
  }
  console.log(`[Serial] Reconnecting to ${cfg.serial.port}...`);
  initSerial(cfg);
}

// ============================================
// TCI WebSocket ENGINE
// ============================================
async function initTci(cfg) {
  config = cfg;
  protocol = TciProtocol;
  TciProtocol.trx = cfg.tci?.trx || 0;
  TciProtocol.vfo = cfg.tci?.vfo || 0;

  const host = cfg.tci?.host || 'localhost';
  const port = cfg.tci?.port || 40001;
  const url = `ws://${host}:${port}`;

  // Resolve WebSocket implementation: prefer 'ws' npm package (works
  // inside pkg snapshots), fall back to Node 21+ built-in WebSocket.
  let WS;
  try {
    WS = require('ws');
  } catch {
    if (typeof globalThis.WebSocket !== 'undefined') {
      WS = globalThis.WebSocket;
    } else {
      console.error('\n  ❌ WebSocket library not available.');
      console.error('     Run: npm install ws');
      console.error('     (Node 21+ can also use the built-in WebSocket)\n');
      process.exit(1);
    }
  }

  function connect() {
    console.log(`[TCI] Connecting to ${url}...`);

    try {
      tciSocket = new WS(url);
    } catch (e) {
      console.error(`[TCI] Connection failed: ${e.message}`);
      scheduleReconnect();
      return;
    }

    // Use addEventListener — works on both 'ws' npm lib AND Node 21+ native WebSocket.
    // (.on() is ws-library-only and crashes with native WebSocket: "tciSocket.on is not a function")
    tciSocket.addEventListener('open', () => {
      console.log(`[TCI] ✅ Connected to ${url}`);
      state.connected = true;
      broadcast({ type: 'update', prop: 'connected', value: true });
      // Initiate TCI session — server will send device info, then state dump
      tciSocket.send('start;');
    });

    tciSocket.addEventListener('message', (evt) => {
      // ws lib: evt may be a Buffer; native WebSocket: evt is MessageEvent with .data
      const raw = evt.data !== undefined ? evt.data : evt;
      const msg = typeof raw === 'string' ? raw : raw.toString('utf8');
      protocol.parseResponse(msg);
    });

    tciSocket.addEventListener('error', (evt) => {
      // 'error' fires before 'close' — just log it, reconnect happens on 'close'
      const err = evt.error || evt;
      if (err.code === 'ECONNREFUSED') {
        console.error(`[TCI] Connection refused — is Thetis/ExpertSDR running with TCI enabled?`);
      } else {
        console.error(`[TCI] Error: ${err.message || 'connection error'}`);
      }
    });

    tciSocket.addEventListener('close', () => {
      console.log('[TCI] Disconnected — reconnecting in 5s...');
      state.connected = false;
      broadcast({ type: 'update', prop: 'connected', value: false });
      tciSocket = null;
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (tciReconnectTimer) return;
    tciReconnectTimer = setTimeout(() => {
      tciReconnectTimer = null;
      connect();
    }, 5000);
  }

  connect();
}

function sendToRadio(data) {
  // TCI transport: send via WebSocket
  if (tciSocket) {
    // readyState 1 = OPEN (works for both 'ws' lib and built-in WebSocket)
    if (tciSocket.readyState !== 1) return false;
    try {
      tciSocket.send(typeof data === 'string' ? data : data.toString());
      return true;
    } catch (e) {
      console.error(`[TCI] Send error: ${e.message}`);
      return false;
    }
  }
  // Serial transport
  if (!serialPort?.isOpen) return false;
  try {
    serialPort.write(data);
    return true;
  } catch (e) {
    console.error(`[Serial] Write error: ${e.message}`);
    return false;
  }
}

// ============================================
// HTTP SERVER (zero deps — built-in Node http)
// ============================================
function startServer(port) {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

    if (req.method === 'GET' && pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          connected: state.connected,
          freq: state.freq,
          mode: state.mode,
          width: state.width,
          ptt: state.ptt,
          timestamp: state.lastUpdate,
        }),
      );
    } else if (req.method === 'GET' && pathname === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(
        `data: ${JSON.stringify({ type: 'init', connected: state.connected, freq: state.freq, mode: state.mode, width: state.width, ptt: state.ptt })}\n\n`,
      );
      sseClients.push(res);
      req.on('close', () => {
        sseClients = sseClients.filter((c) => c !== res);
      });
    } else if (req.method === 'POST' && pathname === '/freq') {
      parseBody(req, (body) => {
        if (!body?.freq) {
          res.writeHead(400);
          res.end('{"error":"Missing freq"}');
          return;
        }
        const cmd = protocol.setFreqCmd(body.freq);
        if (cmd) {
          console.log(`[CMD] Freq → ${body.freq} Hz`);
          sendToRadio(cmd);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"success":true}');
      });
    } else if (req.method === 'POST' && pathname === '/mode') {
      parseBody(req, (body) => {
        if (!body?.mode) {
          res.writeHead(400);
          res.end('{"error":"Missing mode"}');
          return;
        }
        const cmd = protocol.setModeCmd(body.mode);
        if (cmd) {
          console.log(`[CMD] Mode → ${body.mode}`);
          sendToRadio(cmd);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"success":true}');
      });
    } else if (req.method === 'POST' && pathname === '/ptt') {
      parseBody(req, (body) => {
        if (!config?.radio?.pttEnabled && body?.ptt) {
          res.writeHead(403);
          res.end('{"error":"PTT disabled"}');
          return;
        }
        const cmd = protocol.setPttCmd(!!body?.ptt);
        if (cmd) {
          console.log(`[CMD] PTT → ${body.ptt ? 'ON' : 'OFF'}`);
          sendToRadio(cmd);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"success":true}');
      });
    } else if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'OpenHamClock Rig Listener', version: VERSION, connected: state.connected }));
    } else {
      res.writeHead(404);
      res.end('{"error":"Not found"}');
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[HTTP] Listening on port ${port}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  ❌ Port ${port} already in use.\n`);
      process.exit(1);
    }
  });
}

function parseBody(req, cb) {
  let d = '';
  req.on('data', (c) => (d += c));
  req.on('end', () => {
    try {
      cb(JSON.parse(d));
    } catch {
      cb(null);
    }
  });
}

// ============================================
// LIST SERIAL PORTS
// ============================================
async function listPorts() {
  try {
    return await require('serialport').SerialPort.list();
  } catch {
    return [];
  }
}

// ============================================
// INTERACTIVE SETUP WIZARD
// ============================================
async function runWizard() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));

  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │         Rig Listener — Setup Wizard          │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');

  // ── Brand selection (first, so we know whether serial or TCI) ──
  console.log('  📻 Radio type:\n');
  console.log('     1) Yaesu     (FT-991A, FT-891, FT-710, FT-DX10, FT-817/818)');
  console.log('     2) Kenwood   (TS-590, TS-890, TS-480, TS-2000)');
  console.log('     3) Elecraft  (K3, K4, KX3, KX2)');
  console.log('     4) Icom      (IC-7300, IC-7610, IC-705, IC-9700)');
  console.log('     5) SDR (TCI) (Thetis/HL2, ANAN, SunSDR, ExpertSDR)');
  console.log('');
  const brandChoice = (await ask('  Select radio type (1-5): ')).trim();
  const brand = { 1: 'yaesu', 2: 'kenwood', 3: 'elecraft', 4: 'icom', 5: 'tci' }[brandChoice] || 'yaesu';
  console.log(`\n  ✅ Type: ${brand.toUpperCase()}\n`);

  const model = (await ask('  Radio model (optional, e.g. FT-991A or HL2): ')).trim();

  let cfg;

  if (brand === 'tci') {
    // ── TCI setup — WebSocket, no serial port ──
    console.log('\n  🌐 TCI Connection');
    console.log('     Thetis default:    localhost:40001');
    console.log('     ExpertSDR default: localhost:40001\n');

    const tciHost = (await ask('  TCI host [localhost]: ')).trim() || 'localhost';
    const tciPort = parseInt((await ask('  TCI port [40001]: ')).trim()) || 40001;

    console.log('\n  📡 Transceiver / VFO selection');
    console.log('     Most setups use TRX 0 (primary receiver) and VFO 0 (VFO-A).');
    console.log('     Change only if you have a multi-TRX setup (e.g. IC-9700 + SunSDR).\n');

    const trx = parseInt((await ask('  TRX index [0]: ')).trim()) || 0;
    const vfo = parseInt((await ask('  VFO index (0=A, 1=B) [0]: ')).trim()) || 0;

    const httpPort =
      parseInt((await ask(`\n  HTTP port for OpenHamClock [${HTTP_PORT_DEFAULT}]: `)).trim()) || HTTP_PORT_DEFAULT;
    rl.close();

    cfg = {
      tci: { host: tciHost, port: tciPort, trx, vfo },
      radio: { brand: 'tci', model, pollInterval: 0, pttEnabled: false },
      server: { port: httpPort },
    };
  } else {
    // ── Serial setup — USB/serial CAT ──
    const ports = await listPorts();

    if (ports.length > 0) {
      console.log('  📟 Available serial ports:\n');
      ports.forEach((p, i) => {
        const mfg = p.manufacturer ? `  —  ${p.manufacturer}` : '';
        const sn = p.serialNumber ? ` (${p.serialNumber})` : '';
        console.log(`     ${i + 1}) ${p.path}${mfg}${sn}`);
      });
      console.log('');
    } else {
      console.log('  ⚠️  No serial ports detected.');
      console.log('     Make sure your radio is connected via USB.\n');
    }

    let selectedPort = '';
    if (ports.length > 0) {
      const choice = await ask(`  Select port (1-${ports.length}, or type path): `);
      const idx = parseInt(choice) - 1;
      selectedPort = idx >= 0 && idx < ports.length ? ports[idx].path : choice.trim();
    } else {
      selectedPort = (await ask('  Enter serial port (e.g. COM3 or /dev/ttyUSB0): ')).trim();
    }
    if (!selectedPort) {
      console.log('\n  ❌ No port selected.\n');
      rl.close();
      process.exit(1);
    }
    console.log(`\n  ✅ Port: ${selectedPort}\n`);

    const defaultBaud = brand === 'icom' ? 19200 : 38400;
    console.log(`  ⚡ Baud rate — must match your radio's CAT/CI-V setting`);
    console.log(`     Common: 4800, 9600, 19200, 38400, 115200`);
    const baudRate = parseInt((await ask(`  Baud rate [${defaultBaud}]: `)).trim()) || defaultBaud;

    const defaultStop = brand === 'yaesu' ? 2 : 1;
    const stopBits = parseInt((await ask(`  Stop bits (1 or 2) [${defaultStop}]: `)).trim()) || defaultStop;

    let civAddress = 0x94;
    if (brand === 'icom') {
      console.log('\n  🔧 Common Icom CI-V addresses:');
      Object.entries(ICOM_ADDRESSES).forEach(([n, a]) => console.log(`     ${n}: 0x${a.toString(16).toUpperCase()}`));
      const civInput = (await ask(`\n  CI-V address [0x${civAddress.toString(16).toUpperCase()}]: `)).trim();
      if (civInput) civAddress = parseInt(civInput, 16) || civAddress;
    }

    const httpPort =
      parseInt((await ask(`\n  HTTP port for OpenHamClock [${HTTP_PORT_DEFAULT}]: `)).trim()) || HTTP_PORT_DEFAULT;
    rl.close();

    cfg = {
      serial: { port: selectedPort, baudRate, dataBits: 8, stopBits, parity: 'none' },
      radio: { brand, model, civAddress, pollInterval: 500, pttEnabled: false },
      server: { port: httpPort },
    };
  }

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  console.log(`\n  💾 Config saved to ${CONFIG_FILE}`);
  console.log('     Delete this file to re-run the wizard.\n');
  return cfg;
}

// ============================================
// CLI
// ============================================
function parseCLI() {
  const args = process.argv.slice(2);
  const o = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port':
      case '-p':
        o.serialPort = args[++i];
        break;
      case '--baud':
      case '-b':
        o.baudRate = parseInt(args[++i]);
        break;
      case '--brand':
        o.brand = args[++i];
        break;
      case '--http-port':
        o.httpPort = parseInt(args[++i]);
        break;
      case '--tci':
        o.tci = true;
        break;
      case '--tci-host':
        o.tci = true;
        o.tciHost = args[++i];
        break;
      case '--tci-port':
        o.tci = true;
        o.tciPort = parseInt(args[++i]);
        break;
      case '--mock':
        o.mock = true;
        break;
      case '--wizard':
        o.forceWizard = true;
        break;
      case '--help':
      case '-h':
        console.log(`
OpenHamClock Rig Listener v${VERSION}

Connects your radio directly to OpenHamClock via USB or TCI.
No flrig or rigctld needed — just download and run!

First run:   rig-listener          (interactive wizard)
After setup: rig-listener          (uses saved config)

Options:
  --port, -p <port>    Serial port (COM3, /dev/ttyUSB0)
  --baud, -b <rate>    Baud rate
  --brand <brand>      yaesu | kenwood | elecraft | icom | tci
  --http-port <port>   HTTP port (default: 5555)
  --tci                Connect via TCI (default: localhost:40001)
  --tci-host <host>    TCI host (default: localhost)
  --tci-port <port>    TCI port (default: 40001)
  --mock               Simulation mode
  --wizard             Re-run setup wizard
  --help, -h           Show help

Serial radios (Yaesu, Kenwood, Elecraft, Icom):
  OpenHamClock Settings → Rig Control:
    ☑ Enable     Host: http://localhost     Port: 5555

TCI/SDR radios (Thetis, SunSDR, ExpertSDR):
  1. Enable TCI in your SDR application (Thetis → Setup → CAT → TCI)
  2. Run:  rig-listener --tci
  3. OpenHamClock Settings → Rig Control:
     ☑ Enable     Host: http://localhost     Port: 5555
`);
        process.exit(0);
    }
  }
  return o;
}

// ============================================
// MAIN
// ============================================
async function main() {
  const cli = parseCLI();

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log(`║  OpenHamClock Rig Listener v${VERSION}              ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // ── Mock mode ──
  if (cli.mock) {
    config = { radio: { brand: 'mock', pttEnabled: false }, server: { port: cli.httpPort || HTTP_PORT_DEFAULT } };
    protocol = MockProtocol;
    state.connected = true;
    state.freq = 14074000;
    state.mode = 'USB';
    console.log('  📻 Simulation mode — no radio needed\n');
    startServer(config.server.port);
    printInstructions(config.server.port);
    return;
  }

  // ── Quick-start TCI from CLI (no wizard, no config file needed) ──
  if (cli.tci && !cli.forceWizard) {
    const tciHost = cli.tciHost || 'localhost';
    const tciPort = cli.tciPort || 40001;
    const httpPort = cli.httpPort || HTTP_PORT_DEFAULT;

    const cfg = {
      tci: { host: tciHost, port: tciPort, trx: 0, vfo: 0 },
      radio: { brand: 'tci', model: '', pttEnabled: false },
      server: { port: httpPort },
    };

    console.log(`  📻 Radio: TCI/SDR`);
    console.log(`  🌐 TCI:   ws://${tciHost}:${tciPort}`);
    console.log(`  🌐 HTTP:  http://localhost:${httpPort}`);
    console.log('');

    startServer(httpPort);
    await initTci(cfg);
    printInstructions(httpPort, true);
    return;
  }

  // ── Load or create config ──
  let cfg;
  if (cli.forceWizard || !fs.existsSync(CONFIG_FILE)) {
    cfg = await runWizard();
  } else {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      console.log(`  📂 Loaded: ${CONFIG_FILE}`);
    } catch {
      cfg = await runWizard();
    }
  }

  // CLI overrides
  if (cli.serialPort && cfg.serial) cfg.serial.port = cli.serialPort;
  if (cli.baudRate && cfg.serial) cfg.serial.baudRate = cli.baudRate;
  if (cli.brand) cfg.radio.brand = cli.brand;
  if (cli.httpPort) cfg.server.port = cli.httpPort;
  if (cli.tciHost && cfg.tci) cfg.tci.host = cli.tciHost;
  if (cli.tciPort && cfg.tci) cfg.tci.port = cli.tciPort;

  const isTci = cfg.radio.brand === 'tci' || !!cfg.tci;

  if (isTci) {
    // ── TCI mode ──
    const tciHost = cfg.tci?.host || 'localhost';
    const tciPort = cfg.tci?.port || 40001;

    console.log(`  📻 Radio: TCI/SDR ${cfg.radio.model || ''}`);
    console.log(`  🌐 TCI:   ws://${tciHost}:${tciPort}`);
    console.log(`  🌐 HTTP:  http://localhost:${cfg.server.port}`);
    console.log('');

    startServer(cfg.server.port);
    await initTci(cfg);
    printInstructions(cfg.server.port, true);
  } else {
    // ── Serial mode ──
    if (!cfg.serial?.port) {
      console.error('  ❌ No serial port. Run with --wizard\n');
      process.exit(1);
    }

    console.log(`  📻 Radio: ${cfg.radio.brand.toUpperCase()} ${cfg.radio.model || ''}`);
    console.log(`  🔌 Port:  ${cfg.serial.port} @ ${cfg.serial.baudRate} baud`);
    console.log(`  🌐 HTTP:  http://localhost:${cfg.server.port}`);
    console.log('');

    startServer(cfg.server.port);
    await initSerial(cfg);
    printInstructions(cfg.server.port);
  }
}

function printInstructions(port, isTci = false) {
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │  In OpenHamClock → Settings → Rig Control:   │');
  console.log('  │    ☑ Enable Rig Control                      │');
  console.log(`  │    Host: http://localhost   Port: ${String(port).padEnd(10)}│`);
  if (isTci) {
    console.log('  │                                              │');
    console.log('  │  TCI: Ensure TCI is enabled in your SDR app  │');
    console.log('  │  (Thetis → Setup → CAT → Enable TCI)        │');
  }
  console.log('  │                                              │');
  console.log('  │  Press Ctrl+C to stop.  73!                  │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');
}

process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  if (pollTimer) clearInterval(pollTimer);
  if (tciReconnectTimer) clearTimeout(tciReconnectTimer);
  if (tciSocket) {
    try {
      tciSocket.send('stop;');
      tciSocket.close();
    } catch {}
    console.log('  73!');
    process.exit(0);
  } else if (serialPort?.isOpen) {
    serialPort.close(() => {
      console.log('  73!');
      process.exit(0);
    });
  } else {
    console.log('  73!');
    process.exit(0);
  }
});
process.on('SIGTERM', () => process.emit('SIGINT'));

main().catch((err) => {
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
});
