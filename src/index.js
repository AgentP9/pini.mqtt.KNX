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

// ── Repeat-publish timers ──────────────────────────────────────────────────────

/** Minimum allowed repeat interval in milliseconds. */
const MIN_REPEAT_INTERVAL_MS = 1000;

/**
 * Active repeat timers for GA-level publishing.
 * key: group address string  →  value: { timer, topic, value }
 */
const repeatTimers = new Map();

/**
 * Active repeat timers for route-level publishing.
 * key: `${gaAddress}::${route.mqttTopic}`  →  timer handle
 */
const routeRepeatTimers = new Map();

/**
 * Publish a repeat tick: the plain value to `topic` and the current Unix
 * timestamp (seconds) to `topic/ts`.  The companion timestamp topic always
 * carries a changing value so that automation platforms which implement
 * application-level change-detection (e.g. Home Assistant's state_changed
 * event) are still triggered on every tick even when the main value is
 * unchanged.
 */
function publishRepeatTick(topic, value) {
  mqttHandler.publish(topic, value);
  mqttHandler.publish(`${topic}/ts`, String(Math.floor(Date.now() / 1000)));
}

/**
 * Start (or restart) a GA-level repeat timer.
 * The timer self-cancels if the GA no longer has a repeatInterval.
 */
function startRepeatTimer(address, topic, value, intervalSec) {
  stopRepeatTimer(address);
  const ms = Math.max(MIN_REPEAT_INTERVAL_MS, intervalSec * 1000);
  const timer = setInterval(() => {
    const ga = config.groupAddresses.find((g) => g.address === address);
    if (!ga || !(Number(ga.repeatInterval) > 0)) {
      clearInterval(timer);
      repeatTimers.delete(address);
      return;
    }
    publishRepeatTick(topic, value);
    console.log(`[BRIDGE] Repeat KNX→MQTT ${address} → ${topic} = ${value}`);
  }, ms);
  repeatTimers.set(address, { timer, topic, value });
}

function stopRepeatTimer(address) {
  const existing = repeatTimers.get(address);
  if (existing) {
    clearInterval(existing.timer);
    repeatTimers.delete(address);
  }
}

/**
 * Start (or restart) a route-level repeat timer.
 * The timer self-cancels if the route no longer has a repeatInterval.
 */
function startRouteRepeatTimer(gaAddress, route, value, intervalSec) {
  const key = `${gaAddress}::${route.mqttTopic}`;
  stopRouteRepeatTimer(key);
  const ms = Math.max(MIN_REPEAT_INTERVAL_MS, intervalSec * 1000);
  const timer = setInterval(() => {
    const ga = config.groupAddresses.find((g) => g.address === gaAddress);
    const currentRoute = ga && Array.isArray(ga.routes)
      ? ga.routes.find((r) => r.mqttTopic === route.mqttTopic)
      : null;
    if (!currentRoute || !(Number(currentRoute.repeatInterval) > 0)) {
      clearInterval(timer);
      routeRepeatTimers.delete(key);
      return;
    }
    publishRepeatTick(route.mqttTopic, value);
    console.log(`[BRIDGE] Repeat route KNX→MQTT ${gaAddress} → ${route.mqttTopic} = ${value}`);
  }, ms);
  routeRepeatTimers.set(key, timer);
}

function stopRouteRepeatTimer(key) {
  const existing = routeRepeatTimers.get(key);
  if (existing) {
    clearInterval(existing);
    routeRepeatTimers.delete(key);
  }
}

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

      // GA-level repeat timer
      const gaInterval = Number(ga.repeatInterval);
      if (gaInterval > 0) {
        startRepeatTimer(address, topic, String(value), gaInterval);
      } else {
        stopRepeatTimer(address);
      }

      // Custom routes: publish to each configured route topic (with optional value mapping)
      if (Array.isArray(ga.routes)) {
        for (const route of ga.routes) {
          if (!route.mqttTopic) continue;
          const routeValue = applyValueMap(String(value), route.valueMap);
          mqttHandler.publish(route.mqttTopic, routeValue);
          console.log(`[BRIDGE] Route KNX→MQTT ${address} → ${route.mqttTopic} = ${routeValue}`);

          // Route-level repeat timer
          const routeInterval = Number(route.repeatInterval);
          if (routeInterval > 0) {
            startRouteRepeatTimer(address, route, routeValue, routeInterval);
          } else {
            stopRouteRepeatTimer(`${address}::${route.mqttTopic}`);
          }
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
      if (route.mqttTopic !== topic) continue;

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
