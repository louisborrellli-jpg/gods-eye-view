# Free keys, in the order worth getting them

The app runs with no keys at all. This page is the shortest path from that
keyless boot to the most live data per minute of signup effort. Every key here
is free; nothing on this page asks for a card.

The README's [API Keys](../README.md#-api-keys) section is the full reference,
including the metered providers (Google Maps, OpenAI) deliberately left out
here. `npm run doctor` prints which of these you already have, and names the
signup page for each one you don't.

## The ten-minute pass

Four signups, no card, biggest return first. Paste each into **POWER UP →
Provider Settings** in the running app — it writes this checkout's `.env` for
you — or set the variable yourself (see `.env.example`).

| #   | Key                                                                          | Variable               | What goes live                                                              |
| --- | ---------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| 1   | [AISStream](https://aisstream.io)                                            | `AISSTREAM_API_KEY`    | Live global ship positions. The single biggest jump in things moving on screen. |
| 2   | [Cesium ion](https://cesium.com/ion)                                         | `CESIUM_ION_TOKEN`     | Google Photorealistic 3D tiles and world terrain — the flat globe becomes a city you can fly through. |
| 3   | [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/api/map_key/)              | `FIRMS_MAP_KEY`        | Active fire detections, refreshed from the satellite overpasses.             |
| 4   | [TomTom](https://my.tomtom.com/keys)                                         | `TOMTOM_API_KEY`       | Real congestion colours. Without it the traffic layer is an honest simulation, and says so. |

Two notes on the ones with conditions:

- **Cesium ion** is free on the Community plan, which is for eligible
  individual, personal and non-commercial use, and has quotas. Use a public
  `assets:read` token, and check the
  [current pricing and eligibility](https://cesium.com/platform/cesium-ion/pricing/)
  before relying on it.
- **Cesium ion and Mapillary tokens reach the browser by design** — they are
  used client-side and will be visible in devtools. Scope and restrict them
  rather than trying to hide them. See [SECURITY.md](../SECURITY.md).

## Worth adding next

| Key                                                                            | Variable                                   | What it buys                                                                                   |
| ------------------------------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| [Mapillary](https://www.mapillary.com/dashboard/developers)                    | `MAPILLARY_CLIENT_TOKEN`                   | Street-level coverage and photos. Register an app, copy its Client Token.                      |
| [OpenSky](https://opensky-network.org)                                         | `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | More flight-polling credits. Aircraft already work anonymously; this raises the rate limit.  |
| [Ontario 511](https://511on.ca/my511/register)                                 | `ONTARIO_511_API_KEY`                      | The Ontario traffic-camera pack. Register, then request the key at 511on.ca/developers/doc.    |

## What already works with no key at all

Do not go looking for keys for these — they are live on first boot:

- **Aircraft** — OpenSky anonymous access, plus adsb.lol.
- **Aurora** — NOAA SWPC OVATION nowcast, refreshed about every five minutes.
- **Earthquakes** — USGS, M2.5+ over the last 24 h.
- **Satellites** — CelesTrak TLEs.
- **Weather** — NOAA and ECMWF: wind, rain radar, satellite cloud, lightning
  density, cyclone advisories.
- **CCTV** — the bundled public camera packs (Austin, Caltrans, TfL, DriveBC,
  TxDOT, Fintraffic, Tallinn and others).
- **Transit, bike share, routing** — GTFS feeds, GBFS, OSRM.
- **Radio** — Radio Browser.
- **Rocket launches** — Launch Library 2 public tier. `LL2_API_TOKEN` is a paid
  Patreon upgrade for higher limits, not a free signup; leave it blank.
- **Mapped ALPR cameras, submarine cables, military installations** — bundled
  and OpenStreetMap data.

## Reading what you have

```
npm run doctor
```

It reports Node and npm readiness, which capability each provider route is
currently on, and every credential it found — by source, never by value. An
unconfigured provider is printed with its cost tier and the page that issues
it, so the fastest way to answer "what am I missing?" is to run it.

A missing key never blocks startup. If the doctor says setup needs attention,
the cause is Node, npm or dependencies, and it lists the fix.
