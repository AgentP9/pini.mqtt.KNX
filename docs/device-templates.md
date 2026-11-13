# Hybrid device templates

Devices are **metadata groupings** of existing KNX group addresses. The original `config/groupaddresses.json` format, KNX/MQTT routing, custom MQTT routes, and manual GA editing remain unchanged.

## Migration / deployment

- The first start with no `devices.json` results in an empty device list. Existing GAs continue to work.
- Add a device in the dashboard by selecting the **Room heating** template and mapping its existing group addresses explicitly. No automatic inference from adjacent addresses.
- Metadata is saved in `devices.json` next to the active `groupaddresses.json` (normally `/app/config/devices.json`). The existing Docker named volume `config:/app/config` persists both files. Optionally set `DEVICES_PATH` for a different location.
- **Back up the active Docker config volume** before deployment. A repository update does not overwrite the persistent volume.
- Deleting a device only removes its grouping. It never deletes any group address.
- If a GA is later deleted, the device remains visible with a missing-address warning; reassign the object in the editor.
- Existing addresses are not auto-grouped on migration to avoid misidentifying KNX objects. The UI continues to support ungrouped addresses.
- Template mapping requires matching DPTs and compatible direction settings. The optional setpoint shift uses DPT 1.007 and is not treated as a temperature.

## API

- `GET /api/device-templates`
- `GET /api/devices`
- `POST /api/devices` with `{ "name":"Office", "templateId":"room-heating", "addresses":{"temperature":"1/0/0","setpoint":"1/0/1","offset":"1/0/2"} }`
- `PUT /api/devices/:id` with the same body
- `DELETE /api/devices/:id`

Device IDs are stable UUIDs. A group address may belong to at most one device. No KNX writes occur when creating/editing a device.

## Validation

Run `node --test tests/deviceStore.test.js` on Node 18+.
