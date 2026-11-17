'use strict';

const zlib = require('zlib');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Small ZIP writer, without external dependencies. Files are UTF-8, deflated and CRC-checked.
function zip(files) {
  const locals = [], directory = [];
  let offset = 0;
  for (const [name, contents] of Object.entries(files)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw Error('Invalid export filename');
    const filename = Buffer.from(name, 'utf8');
    const raw = Buffer.from(contents, 'utf8');
    const packed = zlib.deflateRawSync(raw);
    const checksum = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += local.length + filename.length + packed.length;
  }
  const centralSize = directory.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...directory, end]);
}

function safeId(value) {
  const normalized = String(value || 'topic').normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return (/^[A-Za-z]/.test(normalized) ? normalized : 't_' + normalized).slice(0, 65) || 'topic';
}
function quote(value) { return JSON.stringify(String(value)).replace(/\\u2028|\\u2029/g, ' '); }
function topicKey(ref) { return ref && (ref.type === 'mqtt' || ref.type === 'mqttDevice') ? ref.type + ':' + ref.id + ':' + (ref.signal || '') : null; }

function buildOpenHabExport(routing, devices = []) {
  const topics = new Map();
  for (const e of routing.endpoints || []) topics.set(topicKey({ type: 'mqtt', id: e.id }), { name: e.name, topic: e.topic, type: e.payloadType, key: 'mqtt:' + e.id + ':', state: false, command: false, active: false });
  for (const d of routing.mqttDevices || []) for (const signal of d.signals || []) {
    topics.set(topicKey({ type: 'mqttDevice', id: d.id, signal: signal.key }), {
      name: d.name + ' / ' + signal.label, topic: signal.topic, type: signal.payloadType,
      key: 'mqttDevice:' + d.id + ':' + signal.key, state: false, command: false, active: signal.enabled !== false,
      disabled: signal.enabled === false
    });
  }
  const notes = [];
  for (const route of routing.routes || []) {
    if (!route.enabled) continue;
    const from = topics.get(topicKey(route.from));
    const to = topics.get(topicKey(route.to));
    if (to) to.state = true; // KNX -> MQTT publishes a state topic
    if (from) from.command = true; // MQTT -> KNX consumes a command topic
    if (route.bidirectional) {
      if (from) from.state = true;
      if (to) to.command = true;
    }
    if (route.transform) notes.push('Route ' + route.id + ': value transformation is performed by the KNX/MQTT bridge; verify the MQTT payload format in openHAB.');
  }
  const entries = [...topics.values()].sort((a, b) => a.topic.localeCompare(b.topic));
  const used = new Set();
  for (const e of entries) {
    let id = safeId(e.name), index = 2;
    while (used.has(id)) id = safeId(e.name).slice(0, 55) + '_' + index++;
    used.add(id); e.id = id;
  }
  const channels = [], items = [];
  for (const e of entries) {
    const props = [];
    // Export every declared topic. A stateTopic on a command-only channel is useful
    // for diagnostics but must not be mistaken for a KNX-confirmed actuator state.
    if (e.state || !e.command) props.push('stateTopic=' + quote(e.topic));
    if (e.command) props.push('commandTopic=' + quote(e.topic));
    const kind = e.type === 'boolean' ? 'switch' : e.type === 'number' ? 'number' : 'string';
    if (kind === 'switch') props.push('on="true"', 'off="false"');
    channels.push('    Type ' + kind + ' : ' + e.id + ' ' + quote(e.name) + ' [ ' + props.join(', ') + ' ]');
    const itemKind = kind === 'switch' ? 'Switch' : kind === 'number' ? 'Number' : 'String';
    items.push(itemKind + ' ' + e.id + ' ' + quote(e.name) + ' { channel="mqtt:topic:knxExport:' + e.id + '" }');
    if (!e.state && !e.command) notes.push('Topic ' + e.topic + ': no enabled route; exported as read-only state channel.');
    if (e.command && !e.state) notes.push('Topic ' + e.topic + ': command-only route; no confirmed state is exported.');
    if (e.disabled) notes.push('Topic ' + e.topic + ': MQTT signal is disabled in the bridge.');
  }
  const things = '// openHAB MQTT Binding 4.x - Generic MQTT Thing\n' +
    '// Change mqtt:broker:knx to the UID of your existing MQTT Broker Thing.\n' +
    'Thing mqtt:topic:knxExport "KNX MQTT Bridge" (mqtt:broker:knx) {\n  Channels:\n' + channels.join('\n') + '\n}\n';
  const itemText = '// Generated MQTT items. Use with the generated .things file.\n' + items.join('\n') + '\n';
  const readme = [
    'openHAB export – pini.mqtt.KNX',
    '=============================',
    '',
    '1. Configure the openHAB MQTT Binding and a Broker Thing.',
    '2. Replace mqtt:broker:knx in knx-mqtt.things with your actual broker Thing UID.',
    '3. Copy knx-mqtt.things to $OPENHAB_CONF/things/ and knx-mqtt.items to $OPENHAB_CONF/items/.',
    '4. Review channel payload types and transformations before enabling controls.',
    '',
    'This export is a snapshot of the current routing configuration, not a live sync.',
    'Only enabled routes determine publish/subscribe directions; disabled and unused MQTT',
    'topics are included for completeness. No KNX group addresses are exported directly.',
    'Boolean channels assume MQTT payloads true/false. Adjust on/off mappings if needed.',
    'Command-only channels intentionally have no stateTopic; a command is not a status.',
    'The export does not create broker credentials or include secrets.',
    '',
    'Devices in source configuration: ' + devices.length,
    'MQTT topics exported: ' + entries.length,
    'Enabled routes: ' + (routing.routes || []).filter(r => r.enabled).length,
    '',
    'Review notes:',
    ...(notes.length ? [...new Set(notes)].map(note => '- ' + note) : ['- No additional notes.']),
    ''
  ].join('\n');
  return { files: { 'knx-mqtt.things': things, 'knx-mqtt.items': itemText, 'README.txt': readme }, topicCount: entries.length };
}
module.exports = { buildOpenHabExport, zip };
