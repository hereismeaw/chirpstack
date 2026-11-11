# Local Docker mioty demo

Verified on 12 November 2026: the image built, the container became healthy,
Windows reached HTTP 200 and the published MQTT TCP port, and all six read-only
demo smoke checks passed (including two consecutive decoded MQTT uplinks).
Graceful shutdown completed all 13 native integration checks; the retained report
is [DOCKER_DEMO_E2E_REPORT.json](DOCKER_DEMO_E2E_REPORT.json). The container was
then recreated with the same named volume to verify fresh-fixture startup.
It became healthy again and passed the six smoke checks; the retained result is
[DOCKER_DEMO_SMOKE_REPORT.json](DOCKER_DEMO_SMOKE_REPORT.json).
These are network/API/asset checks; browser visual QA remains unperformed.

This runs a disposable management UI and native mioty simulator on this Windows
development machine. It uses the existing isolated real-service harness inside
one container: SQLite, Redis, Mosquitto, ChirpStack and a TLS-authenticated simulated
Base Station. It does not transmit RF or connect to an existing deployment.

## Start from PowerShell at the repository root

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/mioty/Start-Demo.ps1
docker compose -f compose.mioty-demo.yml ps
docker compose -f compose.mioty-demo.yml logs -f demo
```

Wait for `demo_ready` / container health `healthy`. Initial real-service checks
take about two minutes because crash recovery waits for an exclusive lease to
expire. Open <http://localhost:8080/> and log in with **admin / admin**. Ports
are published only to loopback. The normal development Compose stack is separate.

The start helper first builds the UI using the existing locked/generated API
client setup, then builds the SQLite binary in WSL with embedded UI assets.
Prerequisites are this repository's installed pnpm dependencies/generated
grpc-web clients, Node/Corepack, WSL's Rust 1.98.1/build dependencies and Docker
Desktop in Linux-container mode. The repository toolchain pin is unchanged.
The prepared build context is ignored under `.mioty-demo/context` and includes
only the binary, simulator/fixture code, API protos and image recipe. Source
trees, databases, test CA keys, package caches and host credentials are not
mounted into the container. The runtime image uses a non-root user.

After code changes, rerun the helper. To rebuild the runtime image from an
already prepared bundle without rebuilding UI/Rust, use `-SkipBuild`. Merely
restarting Compose uses the previous image. Do not treat it as a source rebuild.

## Inspect the seeded workflows

```powershell
docker compose -f compose.mioty-demo.yml exec demo cat /data/current.json
```

The manifest gives the tenant/application/profile/endpoint IDs and relative
`rf_path` and `events_path`. Append either path to the URL to open it after login.
There are two test tenants; the working fixture is **Mioty E2E A**.

Run the read-only container smoke checks (HTTP assets, login/API reads,
receive-only RF policy, Live Events and two consecutive MQTT messages):

```powershell
docker compose -f compose.mioty-demo.yml exec -T demo /opt/venv/bin/python tools/mioty/docker_smoke.py
```

1. Open its mioty network and Base Station. The gateway is a network simulator
   reporting `eu1`; the desired **TH920_925** policy is separate.
2. Open the RF path. Confirm receive-only mode, 920–925 MHz bounds and TX blockers.
   Try a channel whose occupied bandwidth crosses a boundary: saving must fail.
3. Inspect the mioty Device Profile and its JavaScript decoder. The seeded
   endpoint has class A, preattachment and write-only network keys. Create
   additional profiles/endpoints through the normal forms if desired.
4. Open the seeded endpoint's Events page. A real simulated TLS uplink with
   payload `01 02 03` is sent every five seconds. Inspect the typed mioty packet
   counter, decoded `firstByte: 1`, raw payload and Base Station details.
5. Watch the existing application MQTT integration on **localhost:1884**, topic
   `application/+/device/+/event/up` (MQTT v5, no credentials in this local demo).
   For example, from a machine with `mosquitto_sub`:

   ```sh
   mosquitto_sub -h localhost -p 1884 -V mqttv5 \
     -t 'application/+/device/+/event/up' -v
   ```

The simulator sends only to the original seeded endpoint. Changing its identity,
keys or disabling it may stop the simulator; restart the disposable demo to
restore the fixture. Additional endpoints require their own simulated/real peer.
No LoRaWAN RF gateway is included. Existing LoRaWAN forms and protocol selectors
remain available, but a physical LoRaWAN radio workflow is not established here.

## Stop, restart and data lifetime

```powershell
docker compose -f compose.mioty-demo.yml down
docker compose -f compose.mioty-demo.yml up -d
```

**Each container start creates a new fixture with new IDs and new credentials.**
Changes made in the UI are not automatically loaded into the next fixture.
Previous run files/logs remain in the dedicated `demo-data` volume for inspection;
they are not a supported backup/recovery workflow. Graceful shutdown stops the
simulator, deletes its original seeded endpoint/gateway, and writes the final
13-check report inside that run's directory. No existing database is touched.

Alternate host ports may be set in PowerShell before starting:

```powershell
$env:MIOTY_DEMO_HTTP_PORT = '8081'
$env:MIOTY_DEMO_MQTT_PORT = '1885'
```

Use the resulting URLs in `/data/current.json`. Do not expose these demo accounts
or anonymous MQTT ports to a LAN/public interface. Production configuration,
physical RF validation, ALB support and the existing full-UI lint backlog remain
separate work; see [UI_IMPLEMENTATION.md](UI_IMPLEMENTATION.md).
