'use strict';

const EventEmitter = require('events');
const config = require('./config');
const KnxHandler = require('./knxHandler');
const MqttHandler = require('./mqttHandler');
const WebServer = require('./webServer');

const eventEmitter = new EventEmitter();

// ── Web dashboard ──────────────────────────────────────────────────────────────
const webServer = new WebServer(config.webPort, eventEmitter, config.groupAddresses, config.groupAddressesPath); // eslint-disable-line no-unused-vars

// ── Connections ────────────────────────────────────────────────────────────────
const knxHandler = new KnxHandler(config.knx, config.groupAddresses);
const mqttHandler = new MqttHandler(config.mqtt, config.topicPrefix);

// ── Router helpers ─────────────────────────────────────────────────────────────

/**
 * Apply a valueMap to a decoded KNX value before publishing to a custom MQTT topic.
 * Returns the original value unchanged when no mapping is defined or matched.
 * @param {string} value   Decoded KNX value string.
 * @param {Object|undefined} valueMap  e.g. { "ON": "PLAY", "OFF": "STOP" }
 * @returns {string}
 */
function applyValueMap(value, valueMap) {
  if (!valueMap) return value;
  const mapped = valueMap[String(value)];
  return mapped !== undefined ? String(mapped) : String(value);
}

/**
 * Reverse-apply a valueMap: convert an MQTT payload back to a KNX value string
 * so it can be forwarded to the KNX bus.
 * @param {string} value    MQTT payload string.
 * @param {Object|undefined} valueMap
 * @returns {string}
 */
function applyReverseValueMap(value, valueMap) {
  if (!valueMap) return value;
  const entry = Object.entries(valueMap).find(([, v]) => String(v) === String(value));
  return entry ? entry[0] : String(value);
}

/**
 * Subscribe the MQTT handler to all custom route topics currently in the config.
 * Safe to call multiple times (broker deduplicates subscriptions).
 */
function subscribeRouteTopics() {
  const seen = new Set();
  for (const ga of config.groupAddresses) {
    if (!Array.isArray(ga.routes)) continue;
    for (const route of ga.routes) {
      if (route.mqttTopic && !seen.has(route.mqttTopic)) {
        seen.add(route.mqttTopic);
        mqttHandler.subscribe(route.mqttTopic);
      }
    }
  }
}

// ── Visual Routing Designer (sidecar, legacy routes stay active) ───────────────
const routingStore = webServer.routingStore;
function subscribeVisualRoutes() {
  for (const route of routingStore.routes) {
    if (route.enabled && ['mqtt', 'mqttDevice'].includes(route.from.type)) {
      try { const endpoint = routingStore.resolve(route.from, routingStore.endpoints); if (endpoint.topic) mqttHandler.subscribe(endpoint.topic); } catch (err) { console.warn('[ROUTING]', err.message); }
    }
  }
}
function routePayload(value, type, toKnx, transform) {
  if (transform?.kind === 'json') {
    let parsed;
    try { parsed = typeof value === 'string' ? JSON.parse(value) : value; }
    catch { return null; }
    let extracted = parsed;
    for (const segment of transform.path.split('.')) {
      if (!extracted || typeof extracted !== 'object' || !Object.hasOwn(extracted, segment)) return null;
      extracted = extracted[segment];
    }
    if (extracted === null || typeof extracted === 'object') return null;
    const raw = String(extracted);
    const mapped = transform.values?.[raw] ?? (Object.hasOwn(transform,'defaultValue') ? transform.defaultValue : extracted);
    return routePayload(mapped, type, toKnx, null);
  }
  if (transform?.kind === 'constant') return String(transform.value);
  if (transform?.kind === 'map') {
    const raw = String(value);
    const normalized = ['1','true','on'].includes(raw.toLowerCase()) ? 'ON' : ['0','false','off'].includes(raw.toLowerCase()) ? 'OFF' : raw;
    const mapped = transform.values[raw] ?? transform.values[normalized];
    return mapped === undefined ? (Object.hasOwn(transform,'defaultValue') ? String(transform.defaultValue) : raw) : String(mapped);
  }
  if (type !== 'boolean') return String(value);
  const v = String(value).trim().toLowerCase();
  if (['1','true','on','ein'].includes(v)) return toKnx ? '1' : 'true';
  if (['0','false','off','aus'].includes(v)) return toKnx ? '0' : 'false';
  return null;
}
knxHandler.on('groupValueWrite', ({ address, value }) => {
  for (const route of routingStore.routes) {
    if (!route.enabled || route.from.type !== 'device') continue;
    try {
      const source = routingStore.resolve(route.from, routingStore.endpoints);
      if (source.address !== address) continue;
      const destination = routingStore.resolve(route.to, routingStore.endpoints);
      const payload = routePayload(value, source.type, false, route.transform);
      if (payload === null) continue;
      mqttHandler.publish(destination.topic, payload);
      eventEmitter.emit('routing-traffic', { id: route.id, value: payload, direction: 'KNX→MQTT', timestamp: new Date().toISOString() });
    } catch (err) { console.warn('[ROUTING] Invalid KNX route:', err.message); }
  }
});
mqttHandler.on('message', ({ topic, value }) => {
  for (const route of routingStore.routes) {
    if (!route.enabled || !['mqtt', 'mqttDevice'].includes(route.from.type)) continue;
    try {
      const source = routingStore.resolve(route.from, routingStore.endpoints);
      if (source.topic !== topic) continue;
      const destination = routingStore.resolve(route.to, routingStore.endpoints);
      const payload = routePayload(value, source.type, true, route.transform);
      if (payload === null || !knxHandler.connected) continue;
      if (!knxHandler.write(destination.address, payload)) continue;
      eventEmitter.emit('routing-traffic', { id: route.id, value: payload, direction: 'MQTT→KNX', timestamp: new Date().toISOString() });
    } catch (err) { console.warn('[ROUTING] Invalid MQTT route:', err.message); }
  }
});
mqttHandler.on('connected', subscribeVisualRoutes);
eventEmitter.on('routing-changed', subscribeVisualRoutes);

// ── KNX → MQTT ─────────────────────────────────────────────────────────────────
knxHandler.on('groupValueWrite', ({ address, src, value, name }) => {
  const topic = `${config.topicPrefix}/${address}`;
  const ga = config.groupAddresses.find((g) => g.address === address);
  const configured = Boolean(ga);

  // Only forward to MQTT when the address is in the configuration
  if (configured) {
    const direction = ga.direction || 'both';
    // Forward to MQTT only when direction allows KNX→MQTT
    if (direction === 'both' || direction === 'knx2mqtt') {
      mqttHandler.publish(topic, value);

      // Custom routes: publish to each configured route topic (with optional value mapping)
      if (Array.isArray(ga.routes)) {
        for (const route of ga.routes) {
          if (!route.mqttTopic || routingStore.migrated(address, route.mqttTopic, 'knx2mqtt')) continue;
          const routeValue = applyValueMap(String(value), route.valueMap);
          mqttHandler.publish(route.mqttTopic, routeValue);
          console.log(`[BRIDGE] Route KNX→MQTT ${address} → ${route.mqttTopic} = ${routeValue}`);

        }
      }
    } else {
      console.log(`[BRIDGE] KNX→MQTT blocked for ${address} (direction=${direction})`);
    }
  }

  eventEmitter.emit('traffic', {
    direction: 'KNX→MQTT',
    address,
    name: name || address,
    topic,
    value: String(value),
    dpt: ga ? ga.dpt : undefined,
    src,
    configured,
    timestamp: new Date().toISOString(),
  });
});

// ── MQTT → KNX ─────────────────────────────────────────────────────────────────
mqttHandler.on('message', ({ topic, value }) => {
  const prefix = config.topicPrefix + '/';

  // ── Default path: topic matches knx/<address> ──────────────────────────────
  if (topic.startsWith(prefix)) {
    // Extract group address from topic  e.g. "knx/9/0/1" → "9/0/1"
    const address = topic.slice(prefix.length);

    // Only forward if the group address is listed in the config (security guard)
    const ga = config.groupAddresses.find((g) => g.address === address);
    if (!ga) {
      console.warn(`[BRIDGE] Unknown group address ${address} – message ignored`);
      return;
    }

    const direction = ga.direction || 'both';
    if (direction === 'both' || direction === 'mqtt2knx') {
      knxHandler.write(address, value);

      eventEmitter.emit('traffic', {
        direction: 'MQTT→KNX',
        address,
        name: ga.name || address,
        topic,
        value,
        dpt: ga.dpt,
        configured: true,
        timestamp: new Date().toISOString(),
      });
    } else {
      console.log(`[BRIDGE] MQTT→KNX blocked for ${address} (direction=${direction})`);
    }
    return;
  }

  // ── Router path: topic matches a custom route mqttTopic ───────────────────
  for (const ga of config.groupAddresses) {
    if (!Array.isArray(ga.routes)) continue;
    for (const route of ga.routes) {
      if (route.mqttTopic !== topic || routingStore.migrated(ga.address, topic, 'mqtt2knx')) continue;

      const direction = ga.direction || 'both';
      if (direction === 'both' || direction === 'mqtt2knx') {
        // Reverse-map MQTT payload → KNX value string
        const knxValue = applyReverseValueMap(value, route.valueMap);
        console.log(`[BRIDGE] Route MQTT→KNX ${topic} → ${ga.address} = ${knxValue}`);
        knxHandler.write(ga.address, knxValue);

        eventEmitter.emit('traffic', {
          direction: 'MQTT→KNX',
          address: ga.address,
          name: ga.name || ga.address,
          topic,
          value,
          dpt: ga.dpt,
          configured: true,
          timestamp: new Date().toISOString(),
        });
      } else {
        console.log(`[BRIDGE] Route MQTT→KNX blocked for ${ga.address} (direction=${direction})`);
      }
      return;
    }
  }
});

// Dashboard diagnostic write: direct KNX send, no MQTT loop and no optimistic confirmation.
eventEmitter.on('device-setpoint-write', ({ address, value, respond }) => {
  if (!knxHandler.connected) return respond({ ok: false, status: 503, error: 'KNX disconnected' });
  const ok = knxHandler.write(address, String(value));
  if (!ok) return respond({ ok: false, status: 502, error: 'KNX write failed' });
  eventEmitter.emit('traffic', {
    direction: 'WEB→KNX', address,
    name: (config.groupAddresses.find(g => g.address === address) || {}).name || address,
    topic: null, value: String(value), dpt: '9.001', configured: true,
    outbound: true, timestamp: new Date().toISOString(),
  });
  respond({ ok: true, status: 202, message: 'Write sent to KNX library; bus/device confirmation pending' });
});

// Switch command: send only; state is exclusively derived from status group address.
eventEmitter.on('device-switch-write', ({ address, value, respond }) => {
  if (!knxHandler.connected) return respond({ ok: false, status: 503, error: 'KNX disconnected' });
  const raw = value ? '1' : '0';
  const ok = knxHandler.write(address, raw);
  if (!ok) return respond({ ok: false, status: 502, error: 'KNX write failed' });
  eventEmitter.emit('traffic', {
    direction: 'WEB→KNX', address,
    name: (config.groupAddresses.find(g => g.address === address) || {}).name || address,
    topic: null, value: raw, dpt: '1.001', configured: true,
    outbound: true, timestamp: new Date().toISOString(),
  });
  respond({ ok: true, status: 202, message: 'Switch command submitted; status feedback pending' });
});

// ── Status events ──────────────────────────────────────────────────────────────
knxHandler.on('connected', () =>
  eventEmitter.emit('status', { service: 'KNX', connected: true })
);
knxHandler.on('disconnected', () =>
  eventEmitter.emit('status', { service: 'KNX', connected: false })
);
mqttHandler.on('connected', () => {
  eventEmitter.emit('status', { service: 'MQTT', connected: true });
  // Subscribe to custom route topics once the MQTT connection is established
  subscribeRouteTopics();
});
mqttHandler.on('disconnected', () =>
  eventEmitter.emit('status', { service: 'MQTT', connected: false })
);

// When a group address is saved via the web UI, re-subscribe to any new route topics
eventEmitter.on('ga-saved', () => {
  if (mqttHandler.connected) subscribeRouteTopics();
});

// Allow dashboard-triggered MQTT restart (refreshes connection + subscriptions)
eventEmitter.on('mqtt-restart', () => mqttHandler.restart());
