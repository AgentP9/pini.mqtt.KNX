'use strict';

const EventEmitter = require('events');
const knx = require('knx');

/**
 * Human-readable label pairs for DPT 1.x sub-types.
 * Index = DPT minor number; value = [label_for_0, label_for_1].
 * Entries not listed here fall back to ['OFF', 'ON'].
 */
const DPT1_NAMES = {
   1: ['OFF',           'ON'],
   2: ['FALSE',         'TRUE'],
   3: ['DISABLE',       'ENABLE'],
   4: ['NO RAMP',       'RAMP'],
   5: ['NO ALARM',      'ALARM'],
   6: ['LOW',           'HIGH'],
   7: ['DECREASE',      'INCREASE'],
   8: ['UP',            'DOWN'],
   9: ['OPEN',          'CLOSE'],
  10: ['STOP',          'START'],
  11: ['INACTIVE',      'ACTIVE'],
  12: ['NOT INVERTED',  'INVERTED'],
  17: ['OK',            'OK'],    // trigger – both states mean "trigger"
  18: ['FREE',          'OCCUPIED'],
  19: ['CLOSED',        'OPEN'],
};

/**
 * Decode a raw KNX buffer value according to its DPT.
 * Supported DPT major groups: 1 (boolean), 5 (unsigned byte), 9 (2-byte float).
 * Falls back to a hex string for unknown DPTs.
 */
function decodeKnxValue(rawValue, dpt) {
  const buf = Buffer.isBuffer(rawValue) ? rawValue : Buffer.from(rawValue);

  if (!dpt) {
    return buf.toString('hex');
  }

  const parts = String(dpt).split('.');
  const major = parts[0];
  switch (major) {
    case '1': { // DPT1 – boolean (1 bit)
      const bit = (buf[buf.length - 1] & 0x01);
      const minor = parts[1] ? parseInt(parts[1], 10) : 1;
      const pair = DPT1_NAMES[minor] || DPT1_NAMES[1];
      return bit ? pair[1] : pair[0];
    }

    case '5': // DPT5 – unsigned 8-bit integer
      return String(buf[0]);

    case '9': { // DPT9 – 2-byte float
      if (buf.length < 2) return buf.toString('hex');
      const sign = (buf[0] >> 7) & 1;
      const exp = (buf[0] >> 3) & 0x0f;
      const mantissaRaw = ((buf[0] & 0x07) << 8) | buf[1];
      const mantissa = sign ? mantissaRaw - 2048 : mantissaRaw;
      return String((0.01 * mantissa * Math.pow(2, exp)).toFixed(2));
    }

    default:
      return buf.toString('hex');
  }
}

/**
 * Encode a string value from MQTT into a format the KNX library can write,
 * based on the configured DPT.
 */
function encodeKnxValue(value, dpt) {
  if (!dpt) return value;

  const parts = String(dpt).split('.');
  const major = parts[0];
  const num = parseFloat(value);

  switch (major) {
    case '1': {
      const minor = parts[1] ? parseInt(parts[1], 10) : 1;
      const v = String(value).toUpperCase().trim();
      const pair = DPT1_NAMES[minor] || DPT1_NAMES[1];
      if (v === pair[1]) return 1;
      if (v === pair[0]) return 0;
      // Fallback for common truthy strings
      return (v === 'TRUE' || v === '1' || v === 'ON') ? 1 : 0;
    }
    case '5':
      return isNaN(num) ? 0 : Math.min(255, Math.max(0, Math.round(num)));
    case '9':
      return isNaN(num) ? 0 : num;
    default:
      return value;
  }
}

class KnxHandler extends EventEmitter {
  /**
   * @param {{ ipAddr: string, ipPort: number }} config
   * @param {Array<{ address: string, name?: string, dpt?: string }>} groupAddresses
   */
  constructor(config, groupAddresses) {
    super();
    this.config = config;
    this.groupAddresses = groupAddresses;
    this.connection = null;
    this.connected = false;
    // Track addresses the bridge itself wrote recently to suppress the bus echo
    this._recentWrites = new Set();
    this._connect();
  }

  /** Return the configured group address entry for a given address, or undefined. */
  _findGA(address) {
    return this.groupAddresses.find((ga) => ga.address === address);
  }

  _connect() {
    console.log(`[KNX] Connecting to ${this.config.ipAddr}:${this.config.ipPort} …`);
    this.connection = knx.Connection({
      ipAddr: this.config.ipAddr,
      ipPort: this.config.ipPort,
      handlers: {
        connected: () => {
          this.connected = true;
          console.log('[KNX] Connected');
          this.emit('connected');
        },
        disconnected: () => {
          this.connected = false;
          console.warn('[KNX] Disconnected');
          this.emit('disconnected');
        },
        event: (evt, src, dest, rawValue) => {
          if (evt !== 'GroupValue_Write') return;

          // Suppress echo: ignore writes the bridge itself sent to the bus
          if (this._recentWrites.has(dest)) {
            console.log(`[KNX] ${evt} src=${src} dest=${dest} – echo suppressed`);
            return;
          }

          const ga = this._findGA(dest);
          const value = decodeKnxValue(rawValue, ga && ga.dpt);
          const name = ga ? ga.name : undefined;

          console.log(`[KNX] ${evt} src=${src} dest=${dest} value=${value}`);
          this.emit('groupValueWrite', { address: dest, src, value, name });
        },
        error: (connstatus) => {
          this.connected = false;
          console.error('[KNX] Error:', connstatus);
          this.emit('error', connstatus);
        },
      },
    });
  }

  /**
   * Write a value to a KNX group address.
   * @param {string} address  e.g. "9/0/1"
   * @param {string} rawValue  string payload from MQTT
   */
  write(address, rawValue) {
    if (!this.connection || !this.connected) {
      console.error('[KNX] Cannot write – not connected');
      return false;
    }
    const ga = this._findGA(address);
    const value = encodeKnxValue(rawValue, ga && ga.dpt);
    try {
      if (ga && ga.dpt) {
        this.connection.write(address, value, `DPT${ga.dpt}`);
      } else {
        this.connection.write(address, value);
      }
      console.log(`[KNX] Write ${address} = ${value}`);

      // Mark address as recently written so the bus echo is suppressed
      this._recentWrites.add(address);
      setTimeout(() => this._recentWrites.delete(address), 500);
      return true;
    } catch (err) {
      console.error('[KNX] Write error:', err.message);
      return false;
    }
  }
}

module.exports = KnxHandler;
