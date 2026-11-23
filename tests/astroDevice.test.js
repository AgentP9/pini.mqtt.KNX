'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const RoutingStore = require('../src/routingStore');

const page = fs.readFileSync(path.join(__dirname, '../public/routing.html'), 'utf8');
const templateSource = page.match(/const mqttTemplates=({[\s\S]*?});\s*function mqttTemplateUpgrade/);
assert.ok(templateSource, 'MQTT templates must be exposed in routing designer');
const templates = vm.runInNewContext('('+templateSource[1]+')');

test('Astro MQTT device has four named boolean output channels', () => {
  assert.deepEqual(Array.from(templates.astro || [], x => ({ key: x.key, label: x.label, suffix: x.suffix, payloadType: x.payloadType, direction: x.direction })), [
    { key: 'sunriseStart', label: 'Sunrise Start', suffix: '/sunrise/start', payloadType: 'boolean', direction: 'output' },
    { key: 'sunriseEnd', label: 'Sunrise End', suffix: '/sunrise/end', payloadType: 'boolean', direction: 'output' },
    { key: 'sunsetStart', label: 'Sunset Start', suffix: '/sunset/start', payloadType: 'boolean', direction: 'output' },
    { key: 'sunsetEnd', label: 'Sunset End', suffix: '/sunset/end', payloadType: 'boolean', direction: 'output' },
  ]);
  assert.match(page, /<option value="astro">Astro-Device<\/option>/);
});

test('Astro channels are persisted and resolvable as MQTT boolean sources', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knx-astro-'));
  try {
    const ga = { address: '1/0/8', dpt: '1.001' };
    const deviceStore = { file: path.join(dir, 'devices.json'), devices: [{ id: 'light', name: 'Light', templateId: 'switch', addresses: { command: ga.address } }], templates: () => [{ id: 'switch', objects: [{ key: 'command', dpt: '1.001' }] }] };
    const store = new RoutingStore(deviceStore, [ga], path.join(dir, 'routing.json'));
    const astro = { id: 'astro-1', name: 'Astro', templateId: 'astro', baseTopic: 'home/astro', signals: Array.from(templates.astro || [], signal => ({ key: signal.key, label: signal.label, topic: 'home/astro' + signal.suffix, payloadType: signal.payloadType, direction: signal.direction })) };
    const route = { id: 'rise', from: { type: 'mqttDevice', id: astro.id, signal: 'sunriseStart' }, to: { type: 'device', id: 'light', signal: 'command' }, enabled: true };
    store.save({ endpoints: [], mqttDevices: [astro], routes: [route] });
    assert.deepEqual(store.resolve(route.from), { topic: 'home/astro/sunrise/start', type: 'boolean', direction: 'output', enabled: true });
    assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).mqttDevices[0].signals.length, 4);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Astro signal names are visible in the routing designer', () => {
  const expression = page.match(/const endpointSignals=(\(\)=>[^\n]+);/)?.[1];
  assert.ok(expression, 'routing designer must render MQTT signals');
  const graph = { endpoints: [], mqttDevices: [{ id: 'astro', name: 'Astro', templateId: 'astro', signals: [{ key: 'sunriseStart', label: 'Sunrise Start', topic: 'home/astro/sunrise/start', payloadType: 'boolean', direction: 'output' }] }] };
  const signals = vm.runInNewContext(expression, { graph })();
  assert.equal(signals[0].name, 'Astro · Sunrise Start');
  assert.equal(signals[0].topic, 'home/astro/sunrise/start');
});
