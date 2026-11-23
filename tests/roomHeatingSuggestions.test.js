'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

for (const page of ['devices.html', 'addresses.html']) {
  test(page + ': detects room heating without GA adjacency', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8');
    const begin = html.indexOf('    const heatingTemplate=');
    const end = html.indexOf('    const shutterTemplate=', begin);
    assert.ok(begin > 0 && end > begin, 'heating suggestion block exists');
    const snippet = html.slice(begin, end);
    const configuredGAs = [
      { address: '1/0/3', name: 'Flur Temperatur Messwert', dpt: '9.001' },
      { address: '1/0/4', name: 'Flur Aktueller Sollwert', dpt: '9.001' },
      { address: '1/0/5', name: 'Flur Sollwertverschiebung', dpt: '1.007' },
      { address: '1/0/6', name: 'Hobby Temperatur Messwert', dpt: '9.001' },
      { address: '1/0/7', name: 'Hobby Aktueller Sollwert', dpt: '9.001' },
    ];
    const deviceTemplates = [{ id: 'room-heating', name: 'Room heating', objects: [
      { key: 'temperature', dpt: '9.001' }, { key: 'setpoint', dpt: '9.001' },
      { key: 'offset', dpt: '1.007', optional: true },
    ] }];
    const detect = new Function('ga', 'configuredGAs', 'deviceTemplates', 'occupied', 'gaDirectionMatches',
      snippet + '\nreturn null;');
    const check = ga => detect(ga, configuredGAs, deviceTemplates, new Set(),
      (g, o) => g.dpt === o.dpt);
    const result = check(configuredGAs[0]);
    assert.equal(result.templateId, 'room-heating');
    assert.equal(result.name, 'Flur');
    assert.deepEqual(result.addresses, { temperature: '1/0/3', setpoint: '1/0/4', offset: '1/0/5' });
    assert.deepEqual(check(configuredGAs[3]).addresses, { temperature: '1/0/6', setpoint: '1/0/7' });
    assert.equal(detect(configuredGAs[0], configuredGAs, deviceTemplates, new Set(['1/0/4']),
      (g, o) => g.dpt === o.dpt), null);
  });
}
