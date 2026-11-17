'use strict';

const fs = require('fs');

const groupAddressesPath =
  process.env.GROUP_ADDRESSES_PATH || '/app/config/groupaddresses.json';

let groupAddresses = [];
try {
  const raw = fs.readFileSync(groupAddressesPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('groupaddresses.json must be an array');
  groupAddresses = parsed.map(({ address, name, dpt, comment }) => ({ address, name, dpt, ...(comment !== undefined ? { comment } : {}) }));
  console.log(`Loaded ${groupAddresses.length} group address(es) from ${groupAddressesPath}`);
} catch (err) {
  console.warn(`Could not load group addresses from ${groupAddressesPath}: ${err.message}`);
}

module.exports = {
  knx: {
    ipAddr: process.env.KNX_IP || '192.168.1.1',
    ipPort: parseInt(process.env.KNX_PORT, 10) || 3671,
  },
  mqtt: {
    host: process.env.MQTT_HOST || 'localhost',
    port: parseInt(process.env.MQTT_PORT, 10) || 1883,
    username: process.env.MQTT_USER || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
  },
  webPort: parseInt(process.env.WEB_PORT, 10) || 3000,
  groupAddressesPath,
  groupAddresses,
};
