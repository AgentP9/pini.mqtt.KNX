'use strict';

const EventEmitter = require('events');
const mqtt = require('mqtt');

const RECONNECT_MIN_DELAY = 1000;   // 1 s
const RECONNECT_MAX_DELAY = 60000;  // 60 s

class MqttHandler extends EventEmitter {
  /**
   * @param {{ host: string, port: number, username?: string, password?: string }} config
   * @param {string} topicPrefix  e.g. "knx"
   */
  constructor(config, topicPrefix) {
    super();
    this.config = config;
    this.topicPrefix = topicPrefix;
    this.client = null;
    this.connected = false;
    this._manualReconnectRequested = false;
    this._reconnectDelay = RECONNECT_MIN_DELAY;
    this._reconnectTimer = null;
    this._connect();
  }

  _connect() {
    const url = `mqtt://${this.config.host}:${this.config.port}`;
    const options = {
      reconnectPeriod: 0, // disable automatic reconnect; we handle it with backoff
    };
    if (this.config.username) options.username = this.config.username;
    if (this.config.password) options.password = this.config.password;

    console.log(`[MQTT] Connecting to ${url} …`);
    this.client = mqtt.connect(url, options);

    this.client.on('connect', () => {
      this.connected = true;
      this._reconnectDelay = RECONNECT_MIN_DELAY; // reset backoff on success
      console.log('[MQTT] Connected');
      this.emit('connected');
    });

    this.client.on('message', (topic, message) => {
      const value = message.toString();
      console.log(`[MQTT] Message ${topic} = ${value}`);
      this.emit('message', { topic, value });
    });

    this.client.on('error', (err) => {
      this.connected = false;
      console.error('[MQTT] Error:', err.message);
      this.emit('error', err);
    });

    this.client.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) {
        this.emit('disconnected');
      }
      if (this._manualReconnectRequested) {
        this._manualReconnectRequested = false;
        this._connect();
        return;
      }
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return; // already scheduled
    const delay = this._reconnectDelay;
    console.log(`[MQTT] Reconnecting in ${delay / 1000}s …`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_DELAY);
      this._connect();
    }, delay);
  }

  /**
   * Subscribe to an additional MQTT topic beyond the default prefix wildcard.
   * Safe to call at any time; silently skips when not connected.
   * @param {string} topic
   */
  subscribe(topic) {
    if (!this.client || !this.connected) return;
    this.client.subscribe(topic, (err) => {
      if (err) console.error('[MQTT] Subscribe error:', err.message);
      else console.log(`[MQTT] Subscribed to ${topic}`);
    });
  }

  /**
   * Publish a value to an MQTT topic.
   * @param {string} topic
   * @param {string|number} value
   */
  publish(topic, value) {
    if (!this.client || !this.connected) {
      console.error('[MQTT] Cannot publish – not connected');
      return;
    }
    const payload = typeof value === 'object' ? JSON.stringify(value) : String(value);
    this.client.publish(topic, payload, { retain: false });
    console.log(`[MQTT] Publish ${topic} = ${payload}`);
  }

  /**
   * Restart the MQTT connection and refresh subscriptions.
   */
  restart() {
    console.log('[MQTT] Restart requested');
    this._reconnectDelay = RECONNECT_MIN_DELAY;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._manualReconnectRequested) return;
    if (!this.client) {
      this._connect();
      return;
    }
    this._manualReconnectRequested = true;
    this.client.end(false);
  }
}

module.exports = MqttHandler;
