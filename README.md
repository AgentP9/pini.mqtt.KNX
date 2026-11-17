# pini.mqtt.KNX

KNX/MQTT bridge with a visual Routing Designer.

## Architecture

- **Group addresses** (`groupaddresses.json`) define KNX addresses, names, DPTs and comments. They do not define routing direction.
- **Devices** (`devices.json`) group KNX addresses into typed signals. A Switch requires a command address; its status address is optional.
- **Routing Designer** (`routing.json`) is the sole source of truth for enabled connections, their direction and value transformations. KNX→MQTT, MQTT→KNX, bidirectional and KNX→KNX connections are configured here.
- **MQTT devices** define topics and payload types. The bridge subscribes to topics referenced by enabled routes rather than implicitly subscribing to `knx/#`.

Only enabled Routing Designer connections forward telegrams. Merely adding a group address or a device does **not** automatically publish to MQTT or accept MQTT commands.

## Configuration

```json
[
  { "address": "1/0/0", "name": "Living room light", "dpt": "1.001", "comment": "Switch command" },
  { "address": "1/0/1", "name": "Living room status", "dpt": "1.011" }
]
```

The GA editor and ETS XML import preserve only the address, name, DPT and comment fields. Existing configurations may still contain obsolete fields; these are ignored by the runtime and omitted when the corresponding address is saved.

The web dashboard manages KNX group addresses and devices. Use **Routing Designer** to connect signals to MQTT topics, configure directions, enable/disable routes and edit transformations.

Dashboard switch and heating setpoint controls send explicit diagnostic KNX writes; they do not constitute MQTT routes or actuator confirmation.

## Deployment

Use the supplied `docker-compose.yml`, `Dockerfile` and `.env.example` for environment settings. Persist the configuration volume, especially `groupaddresses.json`, `devices.json` and `routing.json`.

Before deploying this breaking architecture cleanup, back up your configuration and verify that all desired data flows are represented by enabled routes. Implicit routing and migration/cleanup endpoints are no longer available.

## Testing

Run `npm test` to execute the Node.js regression tests. Verify real KNX and MQTT traffic in your installation before relying on automation.

## Progressive Web App (PWA)

The dashboard, KNX-Devices, group-address editor, Routing Designer and settings can be opened as one installable app. The web app manifest and service worker are served from the application origin. Use **App installieren** when offered by the browser, or on iOS use Safari → Share → Add to Home Screen.

**HTTPS is required** for service workers and installation on remote hosts (localhost is exempt). When using an IP address or local HTTP domain, configure a trusted HTTPS reverse proxy; the PWA cannot be installed reliably over plain HTTP.

The service worker caches only the static shell resources and the offline notice. It deliberately does **not** cache KNX/MQTT values, API responses, configuration screens or Socket.IO messages. If the server cannot be reached, navigation displays an offline notice rather than stale controls. All writes and live interactions require the server.

Test installability and the app icon in Chrome/Edge and Safari on the actual deployment origin. The current SVG icon is provided in the manifest; platform-specific PNG icons may be needed for optimal installation on some devices.
