# Heating setpoints: openHAB → MQTT → KNX

## Cross-repository contract

The authoritative KNX group addresses come from `AgentP9/openhab-config/ill54-groups.xml` (ETS export). OpenHAB maps heating items in `items/knx.items` via MQTT channels in `things/mqtt-topics.things` to the group address topics below.

| Room | Temperature feedback (KNX → MQTT) | Setpoint (MQTT → KNX, KNX → MQTT) |
| --- | --- | --- |
| Büro | `knx/1/0/0` | `knx/1/0/1` |
| Flur Keller | `knx/1/0/3` | `knx/1/0/4` |
| Hobby | `knx/1/0/6` | `knx/1/0/7` |
| Essküche | `knx/1/1/0` | `knx/1/1/1` |
| Wohnzimmer | `knx/1/1/3` | `knx/1/1/4` |
| Gäste WC | `knx/1/1/6` | `knx/1/1/7` |
| Flur EG | `knx/1/1/9` | `knx/1/1/10` |
| Bad | `knx/1/2/0` | `knx/1/2/1` |
| Schlafzimmer | `knx/1/2/3` | `knx/1/2/4` |
| Kind 1 | `knx/1/2/6` | `knx/1/2/7` |
| Kind 2 | `knx/1/2/9` | `knx/1/2/10` |
| Flur OG | `knx/1/2/12` | `knx/1/2/13` |

All these addresses use **DPT 9.001** (2-byte KNX temperature). The observed setpoint is labeled “Aktueller Sollwert” in the ETS export. **Verify in ETS that this communication object is writable by a bus GroupValue_Write** before deploying automated setpoint commands: the export lists group addresses and DPTs, not communication-object flags. An HVAC controller may instead require a distinct base-setpoint or setpoint-offset object.

## Existing deployments: important volume behavior

`docker-compose.yml` mounts a named volume `config:/app/config`. The Dockerfile copies the repository's `config/groupaddresses.json` into the image, but **Docker does not overwrite a populated named volume on image rebuild**. Merging this change alone is therefore not guaranteed to update a running container.

**Safe production rollout (without deleting the volume):**

1. Back up the active configuration from the container (for example: `docker cp pinimqtt4knx:/app/config/groupaddresses.json ./groupaddresses.backup.json`).
2. In the bridge UI (or `GET /api/groupaddresses`), inspect the current group-address list. It may contain dynamically added routes not committed to Git.
3. Merge only the 24 new heating entries from the updated repository JSON into that **active** list by `address`, retaining unrelated entries/routes. The dashboard's import endpoint `POST /api/groupaddresses/import` supports an `{"addresses":[...]}` array; use only the new heating entries, **not** an indiscriminate replacement of the active JSON.
4. Restart the bridge container after import. A restart is important because the handler's in-memory configuration is initialized when the process starts; the import endpoint mutates the shared array, but a restart makes the effective configuration unambiguous.
5. Confirm `GET /api/groupaddresses` includes every heating entry, including `1/1/4` with `dpt: 9.001` and a bidirectional direction.
6. With ETS Group Monitor active, change **one** room's setpoint in openHAB and look for the matching GroupValue_Write. Do not modify all zones at once.

For example, raising the Wohnzimmer setpoint to 21.5 °C should publish the numeric MQTT value to `knx/1/1/4`, and the bridge should write address `1/1/4` with `DPT9.001`.

## Troubleshooting

- **No MQTT message** at `knx/1/1/4`: inspect openHAB MQTT Thing link, command handling and broker connection.
- **`Unknown group address 1/1/4 – message ignored`**: the active bridge configuration lacks the GA. Import it and restart.
- **`MQTT→KNX blocked`**: a conflicting `direction: knx2mqtt` is active.
- **`Cannot write – not connected`**: check the KNXnet/IP tunnel.
- **Bridge logs write but no GroupValue_Write on ETS bus monitor**: check the KNXnet/IP connection and the output status; do not assume a log entry confirms bus delivery.
- **Bus telegram arrives but thermostat ignores it**: inspect ETS communication-object write flags and whether “Aktueller Sollwert” is writable or is merely feedback. The `Sollwertverschiebung` group addresses have a different type (`DPST-1-7` in the export); they are **not** a drop-in replacement for DPT 9.001 temperatures.

Note: the bridge's default `knx/#` subscription sees its own KNX→MQTT messages. A configured bidirectional GA may produce a loop/duplicate write when the bridge publishes KNX status to the same topic. Verify this on one room before extending the rollout.
