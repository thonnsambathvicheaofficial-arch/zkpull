# ZK Report Puller

A small standalone app that collects attendance from ZKTeco devices and builds
reports. It gathers punches **two ways** and is **read-only toward every device**
— it never clears, wipes, or sends any command to a machine.

- **TCP Pull** — the app dials the device on port `4370` and reads its buffer.
- **ADMS Push** — push-capable devices POST their scans to this app; no port-forward needed.

## Run

```bash
npm install
npm start
```

Then open **http://localhost:8080**. Change the port with `PORT=9000 npm start`.

## Using it

**TCP pull (e.g. a K40):**
1. Devices → **+ Add Device** → Type = *TCP Pull*, enter the device IP and port `4370`.
2. Click **Pull** (or **Pull All**). Punches are read and deduped.
3. Run it on a machine on the **same network** as the device (or with a route to it).

**ADMS push (push-capable devices):**
1. On the device: **Comm → Cloud Server / ADMS → Server Address** = this PC's IP,
   **Port** = `8080` (both shown in the app header and the terminal on start).
2. The device appears automatically under Devices and streams scans in real time.
   Watch them arrive under **Activity**.

**Reports:** pick a date range and view — *Daily attendance* (In / Lunch / Out /
Hours / Late per person per day), *Employee summary*, or *Raw punches*. Export any
view to **Excel**.

**Employees:** map each device **PIN → Name** so reports read clearly (optional).

**Settings:** work-start time + grace (drives the *Late* flag), and an optional
auto-pull interval for TCP devices.

## How punches become a day

A person's punches for a day are resolved **by scan order**, not by clock windows:
first = **In**, last = **Out**, and with 4+ punches the 2nd and 2nd-to-last are
**Lunch Out / Lunch In**. Worked hours = (Out − In) − lunch gap.

## Timezone

ZKTeco devices report **local wall-clock time**. Run this app on a machine whose
clock is set to the **same timezone as the devices** (Cambodia / ICT) so times are
stored and shown exactly as the device recorded them. No conversion is applied.

## Data

Everything is stored locally as JSON under `./data/` (`punches.json`,
`devices.json`, `employees.json`, `settings.json`). No external services, no cloud.
Re-pulling is always safe — duplicate punches are ignored.
