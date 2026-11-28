'use strict';

const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const DeviceStore = require('./deviceStore');
const RoutingStore = require('./routingStore');
const { buildOpenHabExport, zip } = require('./openhabExport');
const config = require('./config');

class WebServer {
  /**
   * @param {number} port
   * @param {import('events').EventEmitter} eventEmitter
   * @param {Array<{ address: string, name?: string, dpt?: string, comment?: string }>} groupAddresses
   * @param {string} groupAddressesPath
   */
  constructor(port, eventEmitter, groupAddresses, groupAddressesPath) {
    this.port = port;
    this.eventEmitter = eventEmitter;
    this.groupAddresses = groupAddresses;
    this.groupAddressesPath = groupAddressesPath;
    this.deviceStore = new DeviceStore(groupAddresses, groupAddressesPath);
    this.routingStore = new RoutingStore(this.deviceStore, groupAddresses);
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = new Server(this.server);

    this.app.use(express.json());

    // Serve static frontend
    this.app.use(express.static(path.join(__dirname, '../public')));

    this.app.get('/api/routing/diagnostics', (_req, res) => res.json({ issues: this.routingStore.diagnostics() }));
    this.app.post('/api/routing/diagnostics/accept', (req, res) => {
      try {
        if (typeof req.body?.key !== 'string' || typeof req.body?.accepted !== 'boolean') return res.status(400).json({ error: 'key and accepted required' });
        this.routingStore.setDiagnosticAcceptance(req.body.key, req.body.accepted);
        const data = { issues: this.routingStore.diagnostics() };
        this.io.emit('routing-diagnostics', data);
        return res.json(data);
      } catch (err) { return res.status(err.message === 'Diagnostic not found' ? 404 : 500).json({ error: err.message }); }
    });

    // Internal Astro values, not MQTT endpoints. Configuration is part of routing.json.
    this.app.get('/api/logic/astro/status', (_req, res) => res.json(this.astro?.snapshot() || {}));

    // Staircase light logic: configuration and live countdown.
    this.app.get('/api/logic/staircase', (_req, res) => res.json(this.staircaseLogic.list()));
    const saveStaircase = (req, res, id) => {
      try {
        const block = this.staircaseLogic.save(req.body, id);
        if (!block) return res.status(404).json({ error: 'Logic block not found' });
        return res.json(block);
      } catch (err) { return res.status(400).json({ error: err.message }); }
    };
    this.app.post('/api/logic/staircase', (req, res) => saveStaircase(req, res));
    this.app.put('/api/logic/staircase/:id', (req, res) => saveStaircase(req, res, req.params.id));
    this.app.delete('/api/logic/staircase/:id', (req, res) => {
      try {
        if (!this.staircaseLogic.remove(req.params.id)) return res.status(404).json({ error: 'Logic block not found' });
        return res.json({ ok: true });
      } catch (err) { return res.status(500).json({ error: err.message }); }
    });

    // Device templates only reference existing group addresses. Existing GA routes stay untouched.
    this.app.get('/api/rooms', (_req, res) => res.json(this.deviceStore.listRooms()));
    const publishRooms = () => this.io.emit('rooms', this.deviceStore.listRooms());
    const saveRoom = (req, res, id) => {
      try {
        const room = this.deviceStore.saveRoom(req.body, id);
        if (!room) return res.status(404).json({ error: 'Room not found' });
        publishRooms();
        return res.json(room);
      } catch (err) { return res.status(err.code ? 500 : 400).json({ error: err.message }); }
    };
    this.app.post('/api/rooms', (req, res) => saveRoom(req, res));
    this.app.put('/api/rooms/:id', (req, res) => saveRoom(req, res, req.params.id));
    this.app.delete('/api/rooms/:id', (req, res) => {
      try {
        if (!this.deviceStore.removeRoom(req.params.id)) return res.status(404).json({ error: 'Room not found' });
        publishRooms();
        return res.json({ ok: true });
      } catch (err) { return res.status(err.code ? 500 : 409).json({ error: err.message }); }
    });
    this.app.get('/api/device-templates', (_req, res) => res.json(this.deviceStore.templates()));
    this.app.get('/api/devices', (_req, res) => res.json(this.deviceStore.list()));
    const publishDevices = () => this.io.emit('devices', this.deviceStore.list());
    const saveDevice = (req, res, id) => {
      try {
        const device = this.deviceStore.save(req.body, id);
        if (!device) return res.status(404).json({ error: 'Device not found' });
        publishDevices();
        publishRooms();
        return res.json(device);
      } catch (err) {
        return res.status(err.message.includes('persist') || err.code ? 500 : 400).json({ error: err.message });
      }
    };
    this.app.post('/api/devices', (req, res) => saveDevice(req, res));
    this.app.put('/api/devices/:id', (req, res) => saveDevice(req, res, req.params.id));
    this.app.delete('/api/devices/:id', (req, res) => {
      try {
        if (!this.deviceStore.remove(req.params.id)) return res.status(404).json({ error: 'Device not found' });
        publishDevices();
        publishRooms();
        return res.json({ ok: true });
      } catch (err) { return res.status(500).json({ error: err.message }); }
    });

    // Visual routing designer: save a complete validated graph atomically.
    this.app.get('/api/routing/settings', (_req, res) => res.json({ knxMqttBaseTopic: this.routingStore.knxMqttBaseTopic }));
    this.app.put('/api/routing/settings', (req, res) => {
      try {
        const data = this.routingStore.save({ ...this.routingStore.list(), knxMqttBaseTopic: req.body?.knxMqttBaseTopic });
        this.eventEmitter.emit('routing-changed', data);
        res.json({ knxMqttBaseTopic: data.knxMqttBaseTopic });
      } catch (err) { res.status(400).json({ error: err.message }); }
    });
    // Snapshot export: openHAB MQTT Generic Thing and Items bundled into a ZIP.
    this.app.get('/api/export/openhab', (_req, res) => {
      try {
        const exportData = buildOpenHabExport(this.routingStore.list(), this.deviceStore.devices);
        const archive = zip(exportData.files);
        res.set('Content-Type', 'application/zip');
        res.set('Content-Disposition', 'attachment; filename="pini-mqtt-knx-openhab.zip"');
        res.set('Cache-Control', 'no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        res.send(archive);
      } catch (err) {
        res.status(500).json({ error: 'openHAB export failed: ' + err.message });
      }
    });
    this.app.get('/api/routing', (_req, res) => res.json(this.routingStore.list()));
    this.app.put('/api/routing', (req, res) => {
      try {
        const proposed = req.body || {};
        for (const block of this.staircaseLogic.list().filter(b => b.routeId)) {
          const current = this.routingStore.routes.find(r => r.id === block.routeId);
          const next = proposed.routes?.find(r => r.id === block.routeId);
          if (!current || !next || next.bidirectional || JSON.stringify(current.from) !== JSON.stringify(next.from) || JSON.stringify(current.to) !== JSON.stringify(next.to)) {
            return res.status(409).json({ error: 'Connection has staircase logic: remove the logic before deleting, reversing or rewiring the connection (' + block.name + ')' });
          }
        }
        for (const block of this.staircaseLogic.list()) {
          if (block.enableInput?.type !== 'astro' && block.input.type !== 'astro') continue;
          for (const endpoint of [block.enableInput, block.input].filter(e => e?.type === 'astro')) {
            const pos = endpoint.value.lastIndexOf(':');
            const id = endpoint.value.slice(0, pos), signal = endpoint.value.slice(pos + 1);
            if (!(proposed.astroBlocks || this.routingStore.astroBlocks).some(b => b.id === id) || !['sunriseStart','sunriseEnd','sunsetStart','sunsetEnd','day'].includes(signal))
              return res.status(409).json({ error: 'Astro-Ausgang wird von Logikbaustein '+block.name+' verwendet. Verbindung zuerst entfernen.' });
          }
        }
        const data = this.routingStore.save(proposed);
        this.eventEmitter.emit('routing-changed', data);
        res.json(data);
      } catch (err) { res.status(400).json({ error: err.message }); }
    });

    // Diagnostic write only for an existing room-heating device's setpoint object.
    // This endpoint never changes configuration or fabricates a confirmed device value.
    this.app.post('/api/devices/:id/setpoint', (req, res) => {
      const device = this.deviceStore.devices.find(d => d.id === req.params.id);
      if (!device) return res.status(404).json({ error: 'Device not found' });
      if (device.templateId !== 'room-heating') return res.status(400).json({ error: 'Not a heating device' });
      const address = device.addresses && device.addresses.setpoint;
      const ga = this.groupAddresses.find(g => g.address === address);
      if (!ga || ga.dpt !== '9.001') {
        return res.status(409).json({ error: 'Setpoint GA missing or not writable as DPT 9.001' });
      }
      const value = req.body && req.body.value;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 5 || value > 35 || Math.abs(value * 10 - Math.round(value * 10)) > 1e-7) {
        return res.status(400).json({ error: 'Setpoint must be 5–35 °C in 0.1 °C increments' });
      }
      if (this._status.KNX !== true) return res.status(503).json({ error: 'KNX disconnected' });
      if (this.eventEmitter.listenerCount('device-setpoint-write') !== 1) return res.status(503).json({ error: 'KNX write handler unavailable' });
      let answered = false;
      this.eventEmitter.emit('device-setpoint-write', { address, value, respond: result => {
        if (answered) return;
        answered = true;
        res.status(result.status || (result.ok ? 202 : 502)).json(result);
      } });
    });

    // Switch command is distinct from feedback; never treat a send as an actuator status.
    this.app.post('/api/devices/:id/switch', (req, res) => {
      const device = this.deviceStore.devices.find(d => d.id === req.params.id);
      if (!device) return res.status(404).json({ error: 'Device not found' });
      if (device.templateId !== 'switch') return res.status(400).json({ error: 'Not a switch device' });
      const address = device.addresses && device.addresses.command;
      const ga = this.groupAddresses.find(g => g.address === address);
      if (!ga || ga.dpt !== '1.001') {
        return res.status(409).json({ error: 'Switch command GA missing or not writable as DPT 1.001' });
      }
      if (typeof req.body?.value !== 'boolean') return res.status(400).json({ error: 'Switch value must be boolean' });
      if (this._status.KNX !== true) return res.status(503).json({ error: 'KNX disconnected' });
      if (this.eventEmitter.listenerCount('device-switch-write') !== 1) return res.status(503).json({ error: 'KNX write handler unavailable' });
      let answered = false;
      this.eventEmitter.emit('device-switch-write', { address, value: req.body.value, respond: result => {
        if (answered) return;
        answered = true;
        res.status(result.status || (result.ok ? 202 : 502)).json(result);
      } });
    });

    // ── REST: group addresses ──────────────────────────────────────────────────

    // GET all configured group addresses
    this.app.get('/api/groupaddresses', (_req, res) => {
      res.json(this.groupAddresses);
    });

    // POST – add or update a group address
    this.app.post('/api/groupaddresses', (req, res) => {
      const { address, name, dpt, comment } = req.body || {};
      if (!address) return res.status(400).json({ error: 'address is required' });

      const entry = {
        address,
        name: name || '',
        dpt: dpt || '',
        comment: comment || '',
      };

      const idx = this.groupAddresses.findIndex((g) => g.address === address);
      const previous = idx >= 0 ? this.groupAddresses[idx] : null;

      if (idx >= 0) {
        this.groupAddresses[idx] = entry;
      } else {
        this.groupAddresses.push(entry);
      }

      if (this._saveGroupAddresses()) {
        this.eventEmitter.emit('ga-saved', entry);
        this.io.emit('groupaddresses', this._enrichGAs());
        publishDevices();
        return res.json(entry);
      }

      // Revert in-memory change on save failure
      if (previous) {
        this.groupAddresses[idx] = previous;
      } else {
        this.groupAddresses.pop();
      }
      return res.status(500).json({ error: 'Failed to persist configuration' });
    });

    // POST /api/groupaddresses/import – apply explicitly reviewed ETS changes.
    this.app.post('/api/groupaddresses/import', (req, res) => {
      const { addresses, expected } = req.body || {};
      if (!Array.isArray(addresses) || !Array.isArray(expected)) {
        return res.status(400).json({ error: 'addresses and expected arrays are required; review the import first' });
      }
      const currentByAddress = new Map(this.groupAddresses.map(g => [g.address, g]));
      const expectedByAddress = new Map(expected.map(g => [g.address, g]));
      const normalized = [];
      const seen = new Set();
      for (const item of addresses) {
        if (!item || typeof item.address !== 'string' || !/^\d+\/\d+\/\d+$/.test(item.address) || seen.has(item.address)) {
          return res.status(400).json({ error: 'Invalid or duplicate group address in import' });
        }
        seen.add(item.address);
        const before = currentByAddress.get(item.address);
        const snapshot = expectedByAddress.get(item.address);
        // A preview entry containing only an address denotes a *new* GA.
        // Do not mistake that marker for an existing GA with empty fields.
        const expectedExisting = snapshot && ['name', 'dpt', 'comment'].some(field => Object.hasOwn(snapshot, field));
        if (!snapshot || JSON.stringify(before ? [before.name || '', before.dpt || '', before.comment || ''] : null) !==
            JSON.stringify(expectedExisting ? [snapshot.name || '', snapshot.dpt || '', snapshot.comment || ''] : null)) {
          return res.status(409).json({ error: 'Gruppenadresse ' + item.address + ' hat sich seit der Importvorschau geändert. Bitte Import erneut prüfen.', address: item.address, code: 'IMPORT_PREVIEW_STALE' });
        }
        const entry = { ...(before || {}), address: item.address };
        for (const field of ['name', 'dpt', 'comment']) {
          if (Object.prototype.hasOwnProperty.call(item, field)) {
            if (typeof item[field] !== 'string') return res.status(400).json({ error: 'Invalid ' + field });
            entry[field] = item[field];
          }
        }
        normalized.push(entry);
      }
      let added = 0, updated = 0;
      const next = this.groupAddresses.map(g => ({ ...g }));
      for (const entry of normalized) {
        const idx = next.findIndex(g => g.address === entry.address);
        if (idx < 0) { next.push(entry); added++; }
        else if (['name', 'dpt', 'comment'].some(field => (next[idx][field] || '') !== (entry[field] || ''))) {
          next[idx] = entry; updated++;
        }
      }
      if (!added && !updated) {
        try {
          this.routingStore.persistAcceptedDiagnostics([]);
          this.io.emit('routing-diagnostics', { issues: this.routingStore.diagnostics() });
          return res.json({ ok: true, added, updated });
        } catch (err) { return res.status(500).json({ error: 'Failed to reset diagnostic acceptance' }); }
      }
      const previous = this.groupAddresses.map(g => ({ ...g }));
      this.groupAddresses.splice(0, this.groupAddresses.length, ...next);
      if (this._saveGroupAddresses()) {
        try { this.routingStore.persistAcceptedDiagnostics([]); }
        catch (err) { return res.status(500).json({ error: 'Group addresses saved but diagnostic acceptance could not be reset' }); }
        this.io.emit('groupaddresses', this._enrichGAs());
        this.io.emit('routing-diagnostics', { issues: this.routingStore.diagnostics() });
        return res.json({ ok: true, added, updated });
      }
      this.groupAddresses.splice(0, this.groupAddresses.length, ...previous);
      return res.status(500).json({ error: 'Failed to persist configuration' });
    });

    // DELETE – remove a group address (address may contain slashes, captured by wildcard)
    this.app.delete('/api/groupaddresses/*', (req, res) => {
      const address = decodeURIComponent(req.params[0]);
      const idx = this.groupAddresses.findIndex((g) => g.address === address);
      if (idx < 0) return res.status(404).json({ error: 'Not found' });

      const [removed] = this.groupAddresses.splice(idx, 1);
      if (this._saveGroupAddresses()) {
        this.io.emit('groupaddresses', this._enrichGAs());
        return res.json({ ok: true });
      }

      // Revert in-memory change on save failure
      this.groupAddresses.splice(idx, 0, removed);
      return res.status(500).json({ error: 'Failed to persist configuration' });
    });

    // ── Connection status tracking ─────────────────────────────────────────────
    this._status = { KNX: false, MQTT: false };

    // Keep a rolling in-memory log (last 200 entries) for late-joining clients
    this._log = [];

    // Last received value per group address (address → value string)
    this._lastValues = {};
    this._pendingValues = {};

    this.io.on('connection', (socket) => {
      console.log('[WEB] Client connected');
      // Send existing log and current state to the new client
      socket.emit('init', this._log);
      Object.entries(this._status).forEach(([service, connected]) => {
        socket.emit('status', { service, connected });
      });
      socket.emit('groupaddresses', this._enrichGAs());
      socket.emit('devices', this.deviceStore.list());
      socket.emit('value-snapshot', { values: this._lastValues, pending: this._pendingValues });
      socket.on('mqtt-restart', () => this.eventEmitter.emit('mqtt-restart'));
      socket.on('disconnect', () => console.log('[WEB] Client disconnected'));
    });

    eventEmitter.on('routing-traffic', entry => this.io.emit('routing-traffic', entry));

    // Forward traffic events to all web clients
    eventEmitter.on('traffic', (entry) => {
      this._log.push(entry);
      if (this._log.length > 200) this._log.shift();
      // Send incremental value changes over Socket.IO; no page reload/polling.
      // Outbound commands are shown as pending, never as confirmed bus feedback.
      if (entry.configured !== false && entry.address) {
        if (entry.direction === 'KNX→MQTT' && !entry.outbound) {
          this._lastValues[entry.address] = entry.value;
          delete this._pendingValues[entry.address];
          this.io.emit('ga-value', { address: entry.address, value: entry.value, confirmed: true });
        } else if (entry.direction === 'MQTT→KNX' || entry.direction === 'WEB→KNX') {
          this._pendingValues[entry.address] = entry.value;
          this.io.emit('ga-value', { address: entry.address, value: entry.value, confirmed: false });
        }
      }
      this.io.emit('traffic', entry);
    });

    // Forward connection-status changes to all web clients
    eventEmitter.on('status', (data) => {
      this._status[data.service] = data.connected;
      this.io.emit('status', data);
    });

    this.server.listen(port, () => {
      console.log(`[WEB] Dashboard available at http://localhost:${port}`);
    });
  }

  /** Merge last-known values into the GA list before sending to clients. */
  _enrichGAs() {
    return this.groupAddresses.map((ga) => {
      const lastValue = this._lastValues[ga.address];
      return lastValue !== undefined ? { ...ga, lastValue } : { ...ga };
    });
  }

  _saveGroupAddresses() {
    try {
      fs.writeFileSync(
        this.groupAddressesPath,
        JSON.stringify(this.groupAddresses, null, 2),
        'utf8'
      );
      console.log(`[WEB] Saved ${this.groupAddresses.length} group address(es) to ${this.groupAddressesPath}`);
      return true;
    } catch (err) {
      console.error('[WEB] Failed to save group addresses:', err.message);
      return false;
    }
  }
}

module.exports = WebServer;
