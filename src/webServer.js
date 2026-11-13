'use strict';

const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const DeviceStore = require('./deviceStore');

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
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = new Server(this.server);

    this.app.use(express.json());

    // Serve static frontend
    this.app.use(express.static(path.join(__dirname, '../public')));

    // Device templates only reference existing group addresses. Existing GA routes stay untouched.
    this.app.get('/api/device-templates', (_req, res) => res.json(this.deviceStore.templates()));
    this.app.get('/api/devices', (_req, res) => res.json(this.deviceStore.list()));
    const publishDevices = () => this.io.emit('devices', this.deviceStore.list());
    const saveDevice = (req, res, id) => {
      try {
        const device = this.deviceStore.save(req.body, id);
        if (!device) return res.status(404).json({ error: 'Device not found' });
        publishDevices();
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
        return res.json({ ok: true });
      } catch (err) { return res.status(500).json({ error: err.message }); }
    });

    // Diagnostic write only for an existing room-heating device's setpoint object.
    // This endpoint never changes configuration or fabricates a confirmed device value.
    this.app.post('/api/devices/:id/setpoint', (req, res) => {
      const device = this.deviceStore.devices.find(d => d.id === req.params.id);
      if (!device) return res.status(404).json({ error: 'Device not found' });
      if (device.templateId !== 'room-heating') return res.status(400).json({ error: 'Not a heating device' });
      const address = device.addresses && device.addresses.setpoint;
      const ga = this.groupAddresses.find(g => g.address === address);
      if (!ga || ga.dpt !== '9.001' || !['both', 'mqtt2knx'].includes(ga.direction || 'both')) {
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
      if (!ga || ga.dpt !== '1.001' || !['both', 'mqtt2knx'].includes(ga.direction || 'both')) {
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
      const { address, name, dpt, comment, routes, direction, repeatInterval } = req.body || {};
      if (!address) return res.status(400).json({ error: 'address is required' });

      const entry = {
        address,
        name: name || '',
        dpt: dpt || '',
        comment: comment || '',
        routes: Array.isArray(routes) ? routes : undefined,
      };
      // Remove the routes key entirely when not provided so the JSON stays clean
      if (!entry.routes) delete entry.routes;
      // Store direction only when it differs from the default ('both')
      if (direction && direction !== 'both') entry.direction = direction;
      // Store repeatInterval only when it is a positive number
      const ri = Number(repeatInterval);
      if (ri > 0) entry.repeatInterval = ri;

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

    // POST /api/groupaddresses/import – bulk add/update from an ETS XML export
    this.app.post('/api/groupaddresses/import', (req, res) => {
      const { addresses } = req.body || {};
      if (!Array.isArray(addresses)) {
        return res.status(400).json({ error: 'addresses array is required' });
      }

      let added = 0, updated = 0;
      for (const item of addresses) {
        const { address, name, dpt, comment, routes, direction, repeatInterval } = item || {};
        if (!address) continue;
        const entry = { address, name: name || '', dpt: dpt || '', comment: comment || '' };
        if (Array.isArray(routes)) {
          if (routes.length > 0) entry.routes = routes;
          // else: omit routes key so the JSON stays clean (mirrors POST endpoint behaviour)
        }
        // Store direction only when it differs from the default ('both')
        if (direction && direction !== 'both') entry.direction = direction;
        // Store repeatInterval only when it is a positive number
        const ri = Number(repeatInterval);
        if (ri > 0) entry.repeatInterval = ri;
        const idx = this.groupAddresses.findIndex((g) => g.address === address);
        if (idx >= 0) {
          // Merge: keep existing values unless the import provides new ones
          this.groupAddresses[idx] = { ...this.groupAddresses[idx], ...entry };
          updated++;
        } else {
          this.groupAddresses.push(entry);
          added++;
        }
      }

      if (this._saveGroupAddresses()) {
        this.io.emit('groupaddresses', this._enrichGAs());
        return res.json({ ok: true, added, updated });
      }
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
