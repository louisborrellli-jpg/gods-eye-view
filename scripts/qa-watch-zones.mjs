/**
 * Watch zones gate: drop a zone by tapping the globe, feed it a stubbed USGS
 * snapshot twice, and prove the second snapshot's new quake inside the zone
 * raises exactly one FLASH (log entry + toast) while a quake outside does not.
 *
 * Needs a dev server (npm run dev). The USGS feed is stubbed in the browser so
 * the result never depends on the day's real earthquakes; the emergency and
 * FIRMS feeds are switched off on the zone so only the stub is in play.
 *
 *   node scripts/qa-watch-zones.mjs [--url http://localhost:4173] [--shot out.png]
 *
 * PUPPETEER_EXECUTABLE_PATH selects the browser (see scripts/qa-chrome.mjs).
 */
import puppeteer from 'puppeteer';
import { chromeExecutablePath } from './qa-chrome.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const APP_URL = opt('--url', 'http://localhost:4173');
const SHOT = opt('--shot', null);
const USGS = 'earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function record(name, ok, detail = '') {
  results.push(ok);
  console.log(
    `  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
}

const quake = (id, lon, lat, mag) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [lon, lat, 10] },
  properties: { mag, time: Date.now(), place: 'QA' },
});

async function main() {
  const executablePath = chromeExecutablePath();
  const browser = await puppeteer.launch({
    headless: 'new',
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
    defaultViewport: { width: 1400, height: 900 },
  });
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    let snapshot = { type: 'FeatureCollection', features: [] };
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (request.url().includes(USGS))
        return request.respond({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify(snapshot),
        });
      return request.continue();
    });

    // ?welcome=0 keeps the first-run launcher from covering the globe centre.
    const url = new URL(APP_URL);
    url.searchParams.set('welcome', '0');
    await page.goto(url.href, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
      { timeout: 90000 },
    );
    await page.evaluate(() => localStorage.removeItem('gev.watchZones.v1'));
    await sleep(1500);

    const enabled = await page.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('watch-zones', true),
    );
    record('layer enables', enabled === true);

    const armed = await page.evaluate(() =>
      window.__godsEyeView.dataManager.setLayerParams('watch-zones', {
        command: 'add',
      }),
    );
    record('New zone arms the next tap', armed === true);

    const canvas = await page.$('canvas');
    const box = await canvas.boundingBox();
    const tap = { x: box.width / 2, y: box.height / 2 };
    const expected = await page.evaluate(({ x, y }) => {
      const { viewer } = window.__godsEyeView;
      const point = viewer.camera.pickEllipsoid({ x, y });
      if (!point) return null;
      const c = viewer.scene.globe.ellipsoid.cartesianToCartographic(point);
      return {
        lat: (c.latitude * 180) / Math.PI,
        lon: (c.longitude * 180) / Math.PI,
      };
    }, tap);
    // Already in the feed when the zone is drawn: background, never a FLASH.
    if (expected)
      snapshot = {
        type: 'FeatureCollection',
        features: [
          quake('qa-old', expected.lon + 0.05, expected.lat + 0.02, 3.1),
        ],
      };
    await page.mouse.click(box.x + tap.x, box.y + tap.y);
    await sleep(1500);

    const zone = await page.evaluate(() => {
      const layer =
        window.__godsEyeView.dataManager.layers.get('watch-zones').module;
      return layer.getAnalystRecords().find((r) => r.type === 'zone') || null;
    });
    record(
      'a tap drops a codenamed zone at the tapped point',
      Boolean(zone) &&
        zone.name === 'ONYX' &&
        Boolean(expected) &&
        Math.abs(zone.lat - expected.lat) < 0.5 &&
        Math.abs(zone.lon - expected.lon) < 0.5,
      zone
        ? `${zone.name} @ ${zone.lat.toFixed(2)}, ${zone.lon.toFixed(2)}`
        : await page.evaluate(
            () =>
              window.__godsEyeView.dataManager.layers
                .get('watch-zones')
                .module.getRowControls().info,
          ),
    );

    // Only the stubbed quake feed in play.
    await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      dm.setLayerParams('watch-zones', { command: 'kind:fire' });
      dm.setLayerParams('watch-zones', { command: 'kind:emergency' });
    });

    // The zone's creation sweep seeded qa-old; this sweep brings two new quakes.
    snapshot = {
      type: 'FeatureCollection',
      features: [
        quake('qa-old', zone.lon + 0.05, zone.lat + 0.02, 3.1),
        quake('qa-new', zone.lon + 0.1, zone.lat + 0.1, 5.4),
        quake('qa-far', zone.lon + 90, -zone.lat, 6.5),
      ],
    };
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.setLayerParams('watch-zones', {
        command: 'sweep',
      }),
    );
    await sleep(1500);

    const alerts = await page.evaluate(() => {
      const layer =
        window.__godsEyeView.dataManager.layers.get('watch-zones').module;
      return layer
        .getAnalystRecords()
        .filter((r) => r.type === 'alert')
        .map((r) => ({
          id: r.id,
          background: r.background,
          severity: r.severity,
        }));
    });
    const live = alerts.filter((a) => !a.background);
    record(
      'the old quake is background, only the new one inside alerts',
      live.length === 1 &&
        live[0].id === 'quake:qa-new' &&
        alerts.some((a) => a.background && a.id === 'quake:qa-old') &&
        !alerts.some((a) => a.id === 'quake:qa-far'),
      JSON.stringify(alerts),
    );

    const row = await page.evaluate(() => {
      const layer =
        window.__godsEyeView.dataManager.layers.get('watch-zones').module;
      const controls = layer.getRowControls();
      return {
        chips: controls.chips.map((c) => c.id),
        items: controls.list.items.map((i) => i.text),
        info: controls.info,
      };
    });
    record(
      'the layer row lists the zone and the FLASH',
      row.items.some((t) => t.includes('ONYX')) &&
        row.items.some((t) => t.includes('M5.4')),
      row.items.join(' | '),
    );
    const toast = await page.evaluate(() =>
      document.body.innerText.includes('FLASH'),
    );
    record('a FLASH toast is shown', toast);

    if (SHOT) {
      await page.evaluate(() =>
        window.__godsEyeView.dataManager.setLayerParams('watch-zones', {
          focus: 'a2',
        }),
      );
      await sleep(3000);
      await page.screenshot({ path: SHOT });
    }
    record('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
