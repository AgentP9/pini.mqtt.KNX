# Testing room-heating KNX setpoint writes

On a configured **Room heating** device card, enter a temperature between **5 and 35 °C** in increments of **0.1 °C**, then choose **Send to KNX**. The server resolves the setpoint group address from the device mapping; the browser never supplies a raw group address.

## Safety and diagnostics

- The API only accepts `POST /api/devices/:id/setpoint` with JSON `{"value":21.5}`.
- The target must be an existing `room-heating` device with a configured DPT `9.001` setpoint GA whose direction permits writing.
- If KNX is disconnected, the endpoint returns HTTP 503; malformed values return HTTP 400; invalid mapping returns HTTP 409.
- Successful HTTP 202 means **the KNX library accepted the write call**, **not** that the actuator received/applied the setpoint. Verify using ETS Group Monitor and, if supported, a subsequent KNX state telegram.
- The web write bypasses MQTT to avoid self-subscription loops; a `WEB→KNX` entry is recorded in the live log.
- Outgoing writes do **not** update the card's measured/setpoint display optimistically. Only incoming KNX traffic does.
- The KNX handler currently suppresses immediate local echo for 500 ms and processes `GroupValue_Write`, not `GroupValue_Response`. Therefore a successfully written setpoint may not automatically refresh on the card. Read-back/acknowledgement is a separate future enhancement.
- No user authentication is currently implemented for the dashboard. **Do not expose the web port publicly.** Restrict access to the trusted home LAN or protect it behind authenticated access before using write controls.

## Manual verification

1. Deploy the updated image and verify that the active persistent `groupaddresses.json` contains the correct heating GAs.
2. Create a room-heating device mapping, including its setpoint address.
3. Open ETS Group Monitor, send a conservative setpoint change, and verify the exact destination GA and DPT 9.001.
4. Disconnect KNX and verify the UI reports failure rather than success.
5. Verify that no MQTT echo-loop or unintended repeated writes occurs.
