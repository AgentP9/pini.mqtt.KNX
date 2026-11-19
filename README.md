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

## Mobile live monitor

Open **Live-Monitor** in the navigation or directly at `/monitor.html`. This is a read-only diagnostic interface designed for phones at the physical KNX switch or sensor. It provides:

- **Geräte**: KNX device signals, last confirmed received values and separately marked pending outbound writes. Values that have not been received since the bridge started are marked unknown.
- **Beobachten**: Select one device to follow its assigned group addresses and the Routing Designer events associated with that device. The device selection is preserved in the URL (`/monitor.html?device=<device-id>`).
- **Live-Log**: Last 200 incoming KNX/bridge events with address/topic/value search, pause and clear.

The monitor uses the existing Socket.IO connection; no page reloads, commands or configuration writes are performed. It also appears as a PWA shortcut. The bridge does not retain KNX value history across restarts, so the initial device status is the last value observed by the current process, **not** a fresh read of the KNX bus.

### Device-aware PWA start view

The PWA retains a single manifest (`id: /`, `start_url: /`) and a single service worker. When launched **standalone** on a narrow touch-screen phone (viewport under 768px with coarse pointer), its root URL redirects to `/monitor.html`. Desktop launches continue to open the dashboard. Explicit navigation to the dashboard (`/?dashboard=1`) and dashboard deep links (`/#view-devices`, `/#view-addresses`) bypass the redirect. This avoids creating a second PWA or changing the installed app identity.

## openHAB ZIP export

In **Verbindungen**, choose **openHAB Export (.zip)** to download a snapshot of all configured MQTT endpoint and MQTT-device topics. The ZIP contains:

- `knx-mqtt.things`: one openHAB MQTT Generic Thing with channels for every topic.
- `knx-mqtt.items`: linked openHAB Items (Switch, Number, String).
- `README.txt`: installation instructions, topic counts and warnings.

Set the MQTT broker UID in the generated `.things` file (default placeholder: `mqtt:broker:knx`) and place the files in the corresponding `things` and `items` directories under `$OPENHAB_CONF`. The export respects enabled Routing Designer directions: KNX→MQTT uses a state topic, MQTT→KNX uses a command topic, and bidirectional routes use both. Unconnected topics are included as read-only channels for completeness. A command-only channel is **not** treated as confirmed actuator state. Transformations continue to run in the bridge; review payload types and conversions before using the Items in automations. No credentials or secrets are included.

The endpoint is `GET /api/export/openhab`. The download is generated on demand and is not cached.
