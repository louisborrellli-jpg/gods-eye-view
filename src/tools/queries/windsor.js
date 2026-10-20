/**
 * Windsor–Detroit corridor queries: live border waits, and a one-call commute
 * brief that combines border waits, weather, traffic flow and the public
 * cameras along a trip.
 */

import { suggestView } from '../views.js';
import { defineTool, ToolError } from '../catalog.js';
import {
  AREA_SCHEMA,
  POINT_SCHEMA,
  areaCenter,
  resolveArea,
  resolvePoint,
  distanceKm,
} from '../area.js';
import { LIMIT_SCHEMA, capRows, countNoun } from '../results.js';

/** Downtown Windsor, used when a commute brief is asked with no endpoints. */
export const WINDSOR_CENTER = Object.freeze({ lat: 42.3149, lon: -83.0364 });
const CORRIDOR_PAD_DEG = 0.03; // ~3 km either side of the trip's box
const CAMERA_LIMIT = 6;
const ROUTE_EVENT_KM = 1.5; // events farther than this off the route are skipped

const fmt = (lane) => {
  if (!lane) return 'n/a';
  if (lane.status === 'closed') return 'closed';
  if (lane.status === 'pending') return 'update pending';
  if (lane.minutes === null) return 'n/a';
  return lane.minutes === 0 ? 'no delay' : `${lane.minutes} min`;
};

function crossingLine(crossing) {
  const ca = crossing.toCanada;
  const us = crossing.toUS;
  const toCa = ca.unavailable
    ? 'into Canada unavailable'
    : `into Canada ${fmt(ca.travellers)} (trucks ${fmt(ca.commercial)})`;
  const toUs = us.unavailable
    ? 'into US unavailable'
    : `into US ${fmt(us.travellers)} (NEXUS ${fmt(us.nexus)}, trucks ${fmt(us.commercial)})`;
  return `${crossing.name}: ${toCa}; ${toUs}.`;
}

/** The three Windsor–Detroit crossings; Blue Water is Sarnia, ~90 min away. */
const WINDSOR_CROSSINGS = new Set([
  'ambassador-bridge',
  'windsor-detroit-tunnel',
  'gordie-howe-bridge',
]);

/**
 * Fastest Windsor–Detroit crossing in one direction for cars, ignoring
 * closed/unknown lanes. Blue Water is reported but never "fastest" here,
 * since it's not a practical alternative from Windsor.
 */
function fastest(crossings, dir) {
  let best = null;
  for (const c of crossings) {
    if (!WINDSOR_CROSSINGS.has(c.id)) continue;
    const lane = c[dir]?.travellers;
    if (!lane || lane.minutes === null) continue;
    if (!best || lane.minutes < best.minutes)
      best = { id: c.id, name: c.name, minutes: lane.minutes };
  }
  return best;
}

async function readBorders(services, signal) {
  const snapshot = await services.borders.getSnapshot({ signal });
  if (snapshot.unavailable)
    throw new ToolError(
      'unavailable',
      'Border wait times are unavailable right now',
    );
  return snapshot;
}

function borderRows(snapshot) {
  return snapshot.crossings.map((c) => ({
    id: c.id,
    name: c.name,
    cities: c.cities,
    lat: c.lat,
    lon: c.lon,
    to_canada: c.toCanada.unavailable
      ? { unavailable: true, reason: c.toCanada.reason }
      : {
          cars_min: c.toCanada.travellers?.minutes ?? null,
          cars_status: c.toCanada.travellers?.status ?? null,
          trucks_min: c.toCanada.commercial?.minutes ?? null,
          trucks_status: c.toCanada.commercial?.status ?? null,
          read_at: c.toCanada.updatedAt,
        },
    to_us: c.toUS.unavailable
      ? { unavailable: true, reason: c.toUS.reason }
      : {
          cars_min: c.toUS.travellers?.minutes ?? null,
          cars_lanes_open: c.toUS.travellers?.lanesOpen ?? null,
          nexus_min: c.toUS.nexus?.minutes ?? null,
          trucks_min: c.toUS.commercial?.minutes ?? null,
          fast_min: c.toUS.fast?.minutes ?? null,
          port_status: c.toUS.portStatus ?? null,
          updated_at: c.toUS.updatedAt,
          notice: c.toUS.notice ?? null,
        },
  }));
}

export const getBorderWaits = defineTool({
  name: 'get_border_waits',
  title: 'Border wait times (Windsor–Detroit, Sarnia–Port Huron)',
  description:
    'Live border wait times in both directions at the Ambassador Bridge, ' +
    'Detroit–Windsor Tunnel, Gordie Howe International Bridge and Blue Water ' +
    'Bridge: cars, NEXUS and trucks, from CBSA (into Canada) and U.S. CBP ' +
    '(into the U.S.). Also names the fastest crossing each way.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  requires: ['borders'],
  async run(_args, { services, signal }) {
    const snapshot = await readBorders(services, signal);
    const crossings = borderRows(snapshot);
    const toUs = fastest(snapshot.crossings, 'toUS');
    const toCa = fastest(snapshot.crossings, 'toCanada');
    const tail = [
      toUs
        ? `Fastest Windsor crossing into the US: ${toUs.name} (${toUs.minutes} min).`
        : '',
      toCa
        ? `Fastest Windsor crossing into Canada: ${toCa.name} (${toCa.minutes} min).`
        : '',
      snapshot.stale ? '(Cached; upstream unavailable.)' : '',
      snapshot.partial && !snapshot.stale
        ? '(One direction may be cached.)'
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    return {
      summary:
        `${snapshot.crossings.map(crossingLine).join(' ')} ${tail}`.trim(),
      data: {
        view: suggestView(services, {
          point: WINDSOR_CENTER,
          altitudeM: 18_000,
          layers: ['cctv'],
        }),
        crossings,
        fastest_to_us: toUs,
        fastest_to_canada: toCa,
        fetched_at: snapshot.fetchedAt,
        stale: snapshot.stale,
        partial: snapshot.partial,
        source: snapshot.source,
        attribution: snapshot.attribution,
      },
    };
  },
});

/** Box around both trip ends, padded so roadside cameras are included. */
function corridorBox(a, b) {
  return [
    Math.min(a.lon, b.lon) - CORRIDOR_PAD_DEG,
    Math.min(a.lat, b.lat) - CORRIDOR_PAD_DEG,
    Math.max(a.lon, b.lon) + CORRIDOR_PAD_DEG,
    Math.max(a.lat, b.lat) + CORRIDOR_PAD_DEG,
  ];
}

/** Distance from point p to the straight segment a→b, in km (flat approx). */
function distanceToSegmentKm(p, a, b) {
  const kx = 111.32 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const ky = 110.57;
  const ax = a.lon * kx,
    ay = a.lat * ky;
  const bx = b.lon * kx,
    by = b.lat * ky;
  const px = p.lon * kx,
    py = p.lat * ky;
  const dx = bx - ax,
    dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2
    ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
    : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * The Detroit River's centreline, south (Lake Erie) to north (Lake St. Clair),
 * traced coarsely from the river channel. Canada lies east/south of it here.
 */
const DETROIT_RIVER = [
  { lat: 42.03, lon: -83.14 },
  { lat: 42.1, lon: -83.13 },
  { lat: 42.2, lon: -83.13 },
  { lat: 42.27, lon: -83.115 },
  { lat: 42.295, lon: -83.095 },
  { lat: 42.312, lon: -83.073 },
  { lat: 42.323, lon: -83.045 },
  { lat: 42.33, lon: -83.0 },
  { lat: 42.345, lon: -82.96 },
  { lat: 42.36, lon: -82.92 },
];

/** -1 / +1 side of the river for a point, using its nearest river segment. */
function riverSide(p) {
  let best = null;
  for (let i = 0; i < DETROIT_RIVER.length - 1; i++) {
    const a = DETROIT_RIVER[i];
    const b = DETROIT_RIVER[i + 1];
    const d = distanceToSegmentKm(p, a, b);
    if (!best || d < best.d) best = { d, a, b };
  }
  const { a, b } = best;
  return Math.sign(
    (b.lon - a.lon) * (p.lat - a.lat) - (b.lat - a.lat) * (p.lon - a.lon),
  );
}

/** Both ends near Windsor and on opposite banks of the Detroit River. */
export function crossesBorder(a, b) {
  const near = (p) => distanceKm(p, WINDSOR_CENTER) < 60;
  return near(a) && near(b) && riverSide(a) !== riverSide(b);
}

const EVENT_LABEL = {
  accidentsandincidents: 'Incident',
  roadwork: 'Construction',
  closures: 'Closure',
  specialevents: 'Event',
  generalinfo: 'Info',
  other: 'Event',
};

function eventRow(e, center) {
  return {
    id: e.id,
    kind: EVENT_LABEL[e.type] ?? 'Event',
    road: e.road,
    direction: e.direction,
    description: e.description,
    lanes: e.lanes,
    full_closure: e.fullClosure,
    lat: e.lat,
    lon: e.lon,
    updated_at: e.updatedAt,
    planned_end_at: e.plannedEndAt,
    ...(center
      ? { distance_km: Number(distanceKm(center, e).toFixed(2)) }
      : {}),
  };
}

/** Incidents and closures first, then construction; nearest first within each. */
const eventRank = (row) =>
  row.kind === 'Incident'
    ? 0
    : row.full_closure
      ? 1
      : row.kind === 'Closure'
        ? 2
        : 3;

function eventLine(row) {
  const where = [row.road, row.direction].filter(Boolean).join(' ');
  const what = row.full_closure
    ? 'FULL CLOSURE'
    : row.lanes || row.kind.toLowerCase();
  return `${row.kind} on ${where || 'unnamed road'} (${what})`;
}

export const getRoadEvents = defineTool({
  name: 'get_road_events',
  title: 'Road incidents, closures and construction (Ontario)',
  description:
    'Live collisions, closures and construction on Ontario provincial ' +
    'highways (401, 3, 77, bridge approaches…) from Ontario 511, in an area, ' +
    'incidents and full closures first. Does not cover city streets.',
  inputSchema: {
    type: 'object',
    properties: { area: AREA_SCHEMA, limit: LIMIT_SCHEMA },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['roadEvents'],
  async run(args, { services, signal }) {
    const area = await resolveArea(args.area, { services, signal });
    const snapshot = await services.roadEvents.getEvents({
      box: {
        west: area.west,
        south: area.south,
        east: area.east,
        north: area.north,
      },
      signal,
    });
    if (snapshot.unavailable)
      throw new ToolError(
        'unavailable',
        snapshot.reason || 'Road events are unavailable right now',
      );
    const center = areaCenter(area);
    const rows = snapshot.events
      .map((e) => eventRow(e, center))
      .sort(
        (a, b) => eventRank(a) - eventRank(b) || a.distance_km - b.distance_km,
      );
    const urgent = rows.filter((r) => eventRank(r) < 3);
    return {
      summary:
        `${countNoun(rows.length, 'road event')} on provincial highways in ${area.label}` +
        (urgent.length
          ? `; ${urgent.length} incident/closure: ${urgent.slice(0, 3).map(eventLine).join('; ')}.`
          : rows.length
            ? `, all construction: ${rows.slice(0, 3).map(eventLine).join('; ')}.`
            : '.') +
        (snapshot.stale ? ' (Cached; upstream unavailable.)' : ''),
      data: {
        view: suggestView(services, { area, layers: ['traffic', 'cctv'] }),
        ...capRows(rows, args.limit),
        coverage: snapshot.coverage,
        fetched_at: snapshot.fetchedAt,
        stale: snapshot.stale,
        attribution: snapshot.attribution,
      },
    };
  },
});

/** Windsor–Detroit crossing points, matching server/providers/borders.js. */
const CROSSING_POINTS = [
  {
    id: 'ambassador-bridge',
    name: 'Ambassador Bridge',
    lat: 42.3118,
    lon: -83.074,
  },
  {
    id: 'windsor-detroit-tunnel',
    name: 'Detroit–Windsor Tunnel',
    lat: 42.3213,
    lon: -83.0405,
  },
  {
    id: 'gordie-howe-bridge',
    name: 'Gordie Howe International Bridge',
    lat: 42.2893,
    lon: -83.0985,
  },
];
const CROSSING_MATCH_KM = 0.8;
const ROUTE_CAMERA_KM = 1;
const ROUTE_CAMERA_LIMIT = 8;
const MAX_PATH_POINTS = 400;

/** Keep at most `max` points, always including both ends. */
function thinPath(points, max) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
}

/** Distance from p to a polyline, and how far along it (0–1) the nearest point is. */
export function nearestOnPath(p, path) {
  let best = { km: Infinity, at: 0 };
  for (let i = 0; i < path.length - 1; i++) {
    const km = distanceToSegmentKm(p, path[i], path[i + 1]);
    if (km < best.km) best = { km, at: i / Math.max(1, path.length - 1) };
  }
  if (path.length === 1) best = { km: distanceKm(p, path[0]), at: 0 };
  return best;
}

/** The crossing a driving route passes over, if any. */
export function crossingOnPath(path) {
  let best = null;
  for (const c of CROSSING_POINTS) {
    const { km } = nearestOnPath(c, path);
    if (km <= CROSSING_MATCH_KM && (!best || km < best.km)) best = { ...c, km };
  }
  return best;
}

function pathBox(path) {
  const lats = path.map((p) => p.lat);
  const lons = path.map((p) => p.lon);
  return [
    Math.min(...lons) - 0.01,
    Math.min(...lats) - 0.01,
    Math.max(...lons) + 0.01,
    Math.max(...lats) + 0.01,
  ];
}

export const windsorCommuteBrief = defineTool({
  name: 'windsor_commute_brief',
  title: 'Commute brief (Windsor–Detroit)',
  description:
    'One answer for "is my drive backed up?" between two points in the ' +
    'Windsor–Detroit area, along the actual driving route: distance and ' +
    'drive time without traffic, which border crossing the route uses versus ' +
    'the fastest one right now, live traffic flow along the corridor, incidents, ' +
    'closures and construction on highways near the route (Ontario 511), weather at ' +
    'the destination, the public traffic cameras along the route in driving order (use ' +
    'get_cctv_snapshot to see one), and border waits when the trip crosses ' +
    'the river. Sections that are unavailable are marked as such.',
  inputSchema: {
    type: 'object',
    properties: {
      from: {
        ...POINT_SCHEMA,
        description: 'Trip start. Defaults to downtown Windsor.',
      },
      to: {
        ...POINT_SCHEMA,
        description: 'Trip end. Defaults to downtown Windsor.',
      },
    },
    additionalProperties: false,
  },
  requires: ['borders'],
  async run(args, { services, signal, tools }) {
    const from = args.from
      ? await resolvePoint(args.from, { services, signal })
      : { label: 'downtown Windsor', ...WINDSOR_CENTER };
    const to = args.to
      ? await resolvePoint(args.to, { services, signal })
      : { label: 'downtown Windsor', ...WINDSOR_CENTER };
    // The real driving route when the router answers; otherwise a straight
    // line, flagged, so the brief still answers.
    let route = null;
    let routeNote = null;
    if (services.routing) {
      try {
        const r = await services.routing.route([from, to], 'car', { signal });
        if (r?.ok && Array.isArray(r.geometry) && r.geometry.length > 1)
          route = r;
        else routeNote = r?.error || 'no route found';
      } catch (error) {
        if (signal?.aborted) throw error;
        routeNote =
          error instanceof ToolError ? error.message : 'routing unavailable';
      }
    } else routeNote = 'routing not configured';
    const path = route
      ? thinPath(
          route.geometry.map(([lon, lat]) => ({ lat, lon })),
          MAX_PATH_POINTS,
        )
      : [from, to];
    const bbox = route ? pathBox(path) : corridorBox(from, to);
    const usedCrossing = route ? crossingOnPath(path) : null;
    const crossing = Boolean(usedCrossing) || crossesBorder(from, to);

    const jobs = {
      traffic: tools.has('get_traffic_flow')
        ? tools.call('get_traffic_flow', { area: { bbox } })
        : null,
      weather: tools.has('get_weather')
        ? tools.call('get_weather', { location: { lat: to.lat, lon: to.lon } })
        : null,
      cameras: tools.has('find_cctv_cameras')
        ? tools.call('find_cctv_cameras', { area: { bbox }, limit: 200 })
        : null,
      borders: readBorders(services, signal),
      events: services.roadEvents
        ? services.roadEvents.getEvents({
            box: {
              west: bbox[0],
              south: bbox[1],
              east: bbox[2],
              north: bbox[3],
            },
            signal,
          })
        : null,
    };
    const keys = Object.keys(jobs).filter((k) => jobs[k]);
    const settled = await Promise.allSettled(keys.map((k) => jobs[k]));
    signal?.throwIfAborted();
    const got = {};
    keys.forEach((k, i) => {
      got[k] =
        settled[i].status === 'fulfilled'
          ? { ok: true, value: settled[i].value }
          : {
              ok: false,
              reason:
                settled[i].reason instanceof ToolError
                  ? settled[i].reason.message
                  : 'unavailable right now',
            };
    });

    const lines = [];
    const sections = {};

    if (route) {
      const km = route.distanceM / 1000;
      const min = Math.round(route.durationS / 60);
      sections.route = {
        source: 'driving_route',
        distance_km: Number(km.toFixed(1)),
        duration_min_no_traffic: min,
        crossing_used: usedCrossing ? usedCrossing.id : null,
        path_lon_lat: thinPath(path, 100).map((p) => [
          Number(p.lon.toFixed(5)),
          Number(p.lat.toFixed(5)),
        ]),
      };
      lines.push(
        `Driving ${km.toFixed(1)} km${usedCrossing ? ` via the ${usedCrossing.name}` : ''}, ` +
          `about ${min} min without traffic${crossing ? ' or border wait' : ''}.`,
      );
    } else {
      sections.route = { source: 'straight_line', reason: routeNote };
      lines.push(
        `(No driving route: ${routeNote}; matching cameras and incidents to a straight line.)`,
      );
    }

    if (got.traffic?.ok) {
      lines.push(got.traffic.value.summary);
      sections.traffic = {
        summary: got.traffic.value.summary,
        data: got.traffic.value.data,
      };
    } else {
      sections.traffic = {
        unavailable: true,
        reason: got.traffic?.reason ?? 'not configured',
      };
      lines.push(`Traffic flow unavailable (${sections.traffic.reason}).`);
    }

    if (got.weather?.ok) {
      lines.push(got.weather.value.summary);
      sections.weather = {
        summary: got.weather.value.summary,
        data: got.weather.value.data,
      };
    } else {
      sections.weather = {
        unavailable: true,
        reason: got.weather?.reason ?? 'not configured',
      };
    }

    if (got.cameras?.ok) {
      const all = got.cameras.value.data?.rows ?? [];
      const scored = all.map((c) => {
        const near = nearestOnPath(c, path);
        return {
          ...c,
          off_route_km: Number(near.km.toFixed(2)),
          along_route: Number(near.at.toFixed(3)),
        };
      });
      // Along a real route: cameras within reach, in the order you pass them.
      // On a straight line: just the nearest few.
      const along = route
        ? scored
            .filter((c) => c.off_route_km <= ROUTE_CAMERA_KM)
            .sort((a, b) => a.along_route - b.along_route)
            .slice(0, ROUTE_CAMERA_LIMIT)
        : scored
            .sort((a, b) => a.off_route_km - b.off_route_km)
            .slice(0, CAMERA_LIMIT);
      sections.cameras = { cameras: along, in_driving_order: Boolean(route) };
      lines.push(
        along.length
          ? `${countNoun(along.length, 'public camera')} ${route ? 'along the route, in order' : 'near the route'}: ${along
              .slice(0, 4)
              .map((c) => c.name)
              .join('; ')}${along.length > 4 ? '; …' : ''}.`
          : 'No public cameras in the catalog along this route.',
      );
    } else {
      sections.cameras = {
        unavailable: true,
        reason: got.cameras?.reason ?? 'not configured',
      };
    }

    if (got.events?.ok && !got.events.value.unavailable) {
      const onRoute = got.events.value.events
        .map((e) => ({
          ...eventRow(e),
          off_route_km: Number(nearestOnPath(e, path).km.toFixed(2)),
        }))
        .filter((r) => r.off_route_km <= (route ? 0.5 : ROUTE_EVENT_KM))
        .sort(
          (a, b) =>
            eventRank(a) - eventRank(b) || a.off_route_km - b.off_route_km,
        );
      sections.road_events = {
        events: onRoute,
        coverage: got.events.value.coverage,
      };
      lines.push(
        onRoute.length
          ? `${countNoun(onRoute.length, 'road event')} on highways near the route: ${onRoute
              .slice(0, 3)
              .map(eventLine)
              .join('; ')}.`
          : 'No incidents, closures or construction on provincial highways near the route.',
      );
    } else {
      sections.road_events = {
        unavailable: true,
        reason: got.events?.ok
          ? got.events.value.reason
          : (got.events?.reason ?? 'not configured'),
      };
    }

    if (got.borders?.ok) {
      const snap = got.borders.value;
      const rows = borderRows(snap);
      sections.borders = {
        crosses_border: crossing,
        crossings: rows,
        fastest_to_us: fastest(snap.crossings, 'toUS'),
        fastest_to_canada: fastest(snap.crossings, 'toCanada'),
        stale: snap.stale,
      };
      if (crossing) {
        const intoUs = riverSide(from) === riverSide(WINDSOR_CENTER);
        const best = intoUs
          ? sections.borders.fastest_to_us
          : sections.borders.fastest_to_canada;
        sections.borders.direction = intoUs ? 'to_us' : 'to_canada';
        const others = snap.crossings
          .filter((c) => WINDSOR_CROSSINGS.has(c.id) && c.id !== best?.id)
          .map(
            (c) =>
              `${c.name} ${fmt((intoUs ? c.toUS : c.toCanada)?.travellers)}`,
          )
          .join(', ');
        const wait = (m) => (m === 0 ? 'no delay' : `${m} min`);
        const usedRow = usedCrossing
          ? snap.crossings.find((c) => c.id === usedCrossing.id)
          : null;
        const usedWait = usedRow
          ? (intoUs ? usedRow.toUS : usedRow.toCanada)?.travellers?.minutes
          : null;
        sections.borders.crossing_used = usedCrossing?.id ?? null;
        let line = `Trip crosses into ${intoUs ? 'the US' : 'Canada'}. `;
        if (usedCrossing && Number.isInteger(usedWait)) {
          line += `Your route's ${usedCrossing.name}: ${wait(usedWait)}.`;
          if (
            best &&
            best.id !== usedCrossing.id &&
            usedWait - best.minutes >= 10
          )
            line += ` ${best.name} is ${usedWait - best.minutes} min faster right now (${wait(best.minutes)}); worth rerouting.`;
          else if (
            best &&
            best.id !== usedCrossing.id &&
            usedWait > best.minutes
          )
            line += ` ${best.name} is ${usedWait - best.minutes} min faster (${wait(best.minutes)}), probably not worth the detour.`;
          else if (best && best.id !== usedCrossing.id)
            line += ` Others: ${others}.`;
        } else if (best) {
          line +=
            `Fastest: ${best.name} (${wait(best.minutes)})` +
            (others ? `; ${others}.` : '.');
        } else line += 'No current wait times for this direction.';
        lines.push(line);
      }
    } else {
      sections.borders = { unavailable: true, reason: got.borders?.reason };
    }

    return {
      summary: `Commute ${from.label} → ${to.label}: ${lines.join(' ')}`,
      data: {
        view: suggestView(services, {
          area: {
            label: `${from.label} → ${to.label}`,
            west: bbox[0],
            south: bbox[1],
            east: bbox[2],
            north: bbox[3],
          },
          layers: ['traffic', 'cctv'],
        }),
        from,
        to,
        sections,
      },
    };
  },
});
