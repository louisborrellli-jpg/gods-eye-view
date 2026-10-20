# God's Eye: Windsor edition

A Windsor–Detroit layer on top of God's Eye View. Everything here is public,
government-published data. No private cameras, no tracking people.

## Windsor mode (the simple view)

The app opens straight on Windsor with cameras, flights and rain radar on,
and the busy menus hidden. One panel on the left:

- **⌂ Windsor** flies back over the city; **Cameras / Flights / Radar** toggle
  those layers.
- **Border wait**: live car waits at the Ambassador, Tunnel and Gordie Howe,
  both directions (orange 15+ min, red 30+). Click a crossing to fly there.
- **Advanced ▸** brings back every control; **◂ Simple** (bottom left) returns.
  The choice is remembered.

Click any camera marker on the map to see its live image in the viewer on
the right. Turn Windsor mode off entirely with `VITE_WINDSOR_MODE=0` in `.env`.

## What this fork adds

| Feature | Data | Live? | Key |
| --- | --- | --- | --- |
| **Border waits, both directions** — Ambassador Bridge, Detroit–Windsor Tunnel, Gordie Howe, Blue Water | CBSA (into Canada) + U.S. CBP (into the U.S.): cars, NEXUS, trucks, FAST, lanes open | Refreshed every 3 min | None |
| **Detroit-side traffic cameras** — ~300 nearest the riverfront (Jefferson, Lodge, I-75, I-94, I-96…) | Michigan DOT Mi Drive | Live stills | None (opt-in flag) |
| **Windsor/Ontario cameras** — 401, EC Row, Herb Gray Parkway, plus the rest of Ontario (the original project fixed the key requirement the same day) | Ontario 511 | Live stills | Free 511on.ca key |
| **Coast Guard river cameras** — Detroit River at Windsor, Livingstone Channel, Lake St. Clair, Blue Water Bridge, Sarnia | Canadian Coast Guard | Stills every few min | None (opt-in flag) |
| **Highway incidents, closures, construction** (401, 3, 77, bridge approaches) | Ontario 511 events | Every 2 min | Same 511 key |
| **`get_border_waits`** tool for Claude and voice | Above | | |
| **`windsor_commute_brief`** tool — "is my drive backed up?" | Traffic flow + highway incidents + destination weather + cameras along the route + border waits if you cross | | TomTom for traffic speeds |

Everything the base app already does still works: live flights over Windsor
(keyless), ships on the Detroit River (free AISStream key), satellites,
radar, lightning, quakes, the voice agent, the spy-movie visual modes.

## Setup (about 10 minutes)

Needs **Node 24** (`node -v`).

```sh
git clone <your fork>
cd gods-eye-view
npm install
cp .env.example .env
```

In `.env`, set:

```sh
ONTARIO_511_API_KEY=...    # free: make a 511on.ca account → Developers → request key
CCTV_MDOT_ENABLED=1        # Detroit cameras
CCTV_CCG_ENABLED=1         # Coast Guard river cameras
TOMTOM_API_KEY=...         # free tier at my.tomtom.com — real traffic speeds
AISSTREAM_API_KEY=...      # optional, free at aisstream.io — ships on the river
```

### Windsor focus (recommended)

The camera catalog is capped at 4,000 and split evenly across every enabled
region, so with the defaults Ontario only gets ~245 of its 925 cameras and
Detroit ~245 of ~800. Turn off the far-away packs so all the local ones fit:

```sh
CCTV_MDOT_MAX_SOURCES=800
CCTV_TFL_ENABLED=0
CCTV_FINTRAFFIC_ENABLED=0
CCTV_DRIVEBC_ENABLED=0
CCTV_TXDOT_ENABLED=0
CCTV_TALLINN_ENABLED=0
CCTV_TARKTEE_ENABLED=0
CCTV_WARENDORF_ENABLED=0
CCTV_NSW_ENABLED=0
CCTV_CALGARY_ENABLED=0
CCTV_CATALONIA_ENABLED=0
CCTV_DELDOT_ENABLED=0
CCTV_KINGCOUNTY_ENABLED=0
CCTV_WSDOT_ENABLED=0
CCTV_VEGVESEN_ENABLED=0
```

With that: all 925 Ontario, ~800 Michigan, 6 Coast Guard, plus Toronto,
Austin and California (the last two can't be switched off) — about 260 live
cameras in the Windsor–Detroit area alone.

Then `npm run dev` and open http://localhost:4173.

### Talk to it from Claude Desktop

```sh
npm run build:panel
```

Claude Desktop → Settings → Developer → Edit Config:

```json
{
  "mcpServers": {
    "gods-eye-view": {
      "command": "node",
      "args": ["/FULL/PATH/gods-eye-view/server/mcp/stdio.js", "--api-base", "http://localhost:4173"]
    }
  }
}
```

Quit Claude Desktop fully, reopen, new chat, keep `npm run dev` running. Try:

- "Is the bridge or the tunnel faster into Detroit right now?"
- "Commute brief from my place on Walker Rd to the Ren Cen."
- "Show me the cameras on Huron Church."

## Honest limits

- **Transit Windsor buses** don't publish live GPS publicly (schedule only), so
  a bus layer would be schedule-estimated, not live.
- **CBSA's own timestamp is broken** ("Invalid DateTime"), so Canada-bound
  times show when we last read them. CBP's U.S.-bound times are stamped by CBP.
- **Mi Drive's terms** don't say anything explicit about reuse, so it's opt-in
  and fine for personal use. Don't publish it publicly without asking MDOT.
- Camera views are stills that refresh every minute or two, not video.

## Roadmap

1. **Border pins on the globe** with a HUD ticker (data's done; this is the Cesium renderer).
2. **City intersection webcams** via Windy (Ouellette & Tecumseh etc.; free key).
3. **Environment Canada weather alerts** for Essex County.
4. **"Jarvis" alerts:** a scheduled check around 4:45 p.m. on weekdays that
   pings you only if your route home or a bridge is backed up.
5. **Your own stuff:** your vehicles' GPS (if the telematics has an API) and
   your own home cameras on your local network.

Out of bounds, permanently: face recognition, private or unsecured cameras,
phone or plate tracking of people, anything you're not authorized to access.
