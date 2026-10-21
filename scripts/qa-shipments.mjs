/**
 * Shipments gate: add a container by its number alone, let automatic
 * tracking fill in the ship and dates, and prove the board, the globe pin
 * and the free-time alerts agree.
 *
 * Container tracking (/api/shipments/track) and the ship lookup
 * (/api/vessels/find) are stubbed in the browser, so the run needs no
 * FindTEU or AISStream key and never depends on real voyages. Dates are
 * written relative to the browser's own today.
 *
 * The board runs first with the server's shared list hidden (the browser
 * keeps the list, as on a static host), then once against the dev server's
 * real shared list (/api/shipments/store), which it leaves as it found it.
 *
 * Needs a dev server (npm run dev).
 *
 *   node scripts/qa-shipments.mjs [--url http://localhost:4173] [--shot out.png]
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function record(name, ok, detail = '') {
  results.push(ok);
  console.log(
    `  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
}

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
  const lookups = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    // The ship reports an ETA five days out: three days later than planned.
    const etaMs = Date.now() + 5 * 86_400_000;
    const day = (offset) => {
      const date = new Date(Date.now() + offset * 86_400_000);
      const pad = (v) => String(v).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    };
    const tracked = [];
    let sharedList = false;
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/shipments/store') && !sharedList)
        return request.respond({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'not_found' }),
        });
      if (url.pathname === '/api/shipments/track') {
        tracked.push(url.searchParams.get('container'));
        return request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            configured: true,
            terminal49: 'registered',
            tracking: {
              source: 'FindTEU',
              carrier: 'msc',
              completed: false,
              pol: { port: 'Gioia Tauro', code: 'ITGIT' },
              pod: { port: 'Montreal', code: 'CAMTR' },
              destination: { port: 'Toronto', code: 'CATOR' },
              vessel: {
                name: 'QA TESTSHIP',
                imo: '9900123',
                mmsi: '990000123',
              },
              dates: { portEta: day(2) },
              fetchedAt: Date.now(),
            },
          }),
        });
      }
      if (url.pathname !== '/api/vessels/find') return request.continue();
      lookups.push(url.searchParams.get('q'));
      return request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          query: url.searchParams.get('q'),
          configured: true,
          status: 'live',
          matches: [
            {
              lat: 47.35,
              lon: -70.05,
              name: 'QA TESTSHIP',
              mmsi: '990000123',
              imo: '9900123',
              speed: 13.4,
              course: 230,
              destination: 'CAMTR',
              eta: new Date(etaMs).toISOString(),
              last_position_epoch: Math.floor(Date.now() / 1000) - 120,
            },
          ],
        }),
      });
    });

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
    await page.evaluate(() => {
      localStorage.removeItem('gev.shipments.v1');
      localStorage.removeItem('gev.shipments.notified.v1');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
      { timeout: 90000 },
    );
    await sleep(1500);

    const enabled = await page.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('shipments', true),
    );
    record('layer enables', enabled === true);

    await page.evaluate(() =>
      window.__godsEyeView.dataManager.setLayerParams('shipments', {
        command: 'add',
      }),
    );
    await page.waitForSelector('#shipments-board[open] form', {
      timeout: 5000,
    });
    record('Add container opens the board form', true);

    const hint = async () =>
      page.$eval(
        '#shipments-board .shipments-hint',
        (node) => node.textContent,
      );
    await page.type(
      '#shipments-board input[name="container"]',
      'mscu 123456 5',
    );
    const typo = await hint();
    record('a wrong check digit is called out', /typo/.test(typo), typo);
    await page.$eval('#shipments-board input[name="container"]', (node) => {
      node.value = 'MSCU1234566';
      node.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const valid = await hint();
    record('a valid MSC number is recognised', /MSC/.test(valid), valid);

    // Nothing but the number: no ship, no dates.
    await page.click('#shipments-board button[type="submit"]');
    await page.waitForSelector('#shipments-board .shipment-card', {
      timeout: 5000,
    });
    await sleep(1500);

    const card = await page.$eval(
      '#shipments-board .shipment-card',
      (node) => node.innerText,
    );
    record(
      'tracking fills in the route, ship and ETA from the number alone',
      card.includes('MSCU1234566') &&
        /At sea/i.test(card) &&
        card.includes('Gioia Tauro → Montreal → Toronto') &&
        card.includes('QA TESTSHIP') &&
        /Tracked by FindTEU/.test(card) &&
        tracked.includes('MSCU1234566'),
      card.replace(/\s+/g, ' ').slice(0, 200),
    );
    record(
      'only the ship name is sent to the lookup',
      lookups.length > 0 &&
        lookups.every((q) => q === 'QA TESTSHIP' || q === '990000123'),
      lookups.join(','),
    );
    record(
      'the ship’s own later ETA is flagged',
      /3 days later than planned/.test(card),
    );

    const pin = await page.evaluate(() => {
      const layer =
        window.__godsEyeView.dataManager.layers.get('shipments').module;
      const shipment = layer.board.list()[0];
      return {
        lastSeen: shipment?.lastSeen ?? null,
        mmsi: shipment?.vessel.mmsi,
        entities: window.__godsEyeView.viewer.dataSources
          .getByName('shipments')[0]
          ?.entities.values.map((entity) => entity.id),
      };
    });
    record(
      'the tracked ship is found live and pinned on the globe',
      pin.lastSeen?.name === 'QA TESTSHIP' &&
        pin.lastSeen?.mmsi === '990000123' &&
        pin.entities?.some((id) => id.startsWith('shipment:')),
      JSON.stringify(pin.entities),
    );

    // A second box already at the ramp with one free day left and no truck.
    await page.evaluate(() => {
      const day = (offset) => {
        const date = new Date(Date.now() + offset * 86_400_000);
        const pad = (v) => String(v).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      };
      const layer =
        window.__godsEyeView.dataManager.layers.get('shipments').module;
      layer.board.save({
        container: 'MSKU1234567',
        dates: {
          discharged: day(-6),
          railDeparted: day(-4),
          rampArrived: day(-1),
          rampLfd: day(1),
        },
        holds: { customs: true },
      });
      return layer.board.check();
    });
    await sleep(800);
    const urgent = await page.$eval(
      '#shipments-board .shipment-card',
      (node) => node.innerText,
    );
    record(
      'the most urgent box sorts first with its alerts',
      urgent.includes('MSKU1234567') &&
        /1 free day left/.test(urgent) &&
        /book a truck/.test(urgent) &&
        /Customs hold/.test(urgent),
      urgent.replace(/\s+/g, ' ').slice(0, 200),
    );
    const toast = await page.evaluate(() =>
      document.body.innerText.includes('MSKU1234567 —'),
    );
    record('an urgent alert raises a toast', toast);

    const row = await page.evaluate(() => {
      const controls = window.__godsEyeView.dataManager.layers
        .get('shipments')
        .module.getRowControls();
      return {
        info: controls.info,
        items: controls.list.items.map((i) => i.text),
      };
    });
    record(
      'the layer row lists both boxes',
      row.items.length === 2 && /need action|needs action/.test(row.info),
      `${row.info} | ${row.items.join(' | ')}`,
    );

    const privacy = await page.evaluate(() => {
      const raw = localStorage.getItem('gev.shipments.v1') || '';
      return {
        stored: raw.includes('MSCU1234566'),
        inUrl: location.href.includes('MSCU'),
      };
    });
    record(
      'kept in browser storage, never in the URL',
      privacy.stored && !privacy.inUrl,
    );

    // The same board on the server's shared list.
    sharedList = true;
    const before = await page.evaluate(async () => {
      const answer = await fetch('/api/shipments/store');
      return answer.ok ? (await answer.json()).shipments.length : -1;
    });
    await page.evaluate(() => {
      localStorage.removeItem('gev.shipments.v1');
      localStorage.removeItem('gev.shipments.v1.copied-to-server');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
      { timeout: 90000 },
    );
    await sleep(2500);
    const shared = await page.evaluate(async () => {
      const layer =
        window.__godsEyeView.dataManager.layers.get('shipments').module;
      const saved = layer.board.save({ container: 'TGHU0000008' });
      const id = saved.shipment?.id;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const list = await (await fetch('/api/shipments/store')).json();
      const onServer = list.shipments.some((item) => item.id === id);
      const inBrowser = (
        localStorage.getItem('gev.shipments.v1') || ''
      ).includes('TGHU0000008');
      layer.board.remove(id);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const after = await (await fetch('/api/shipments/store')).json();
      return {
        problem: saved.problem,
        mode: list.mode,
        onServer,
        inBrowser,
        removed: !after.shipments.some((item) => item.id === id),
        count: after.shipments.length,
      };
    });
    record(
      'with the shared list, a container is kept on the server, not the browser',
      before >= 0 &&
        shared.mode === 'server' &&
        shared.onServer &&
        !shared.inBrowser,
      JSON.stringify(shared),
    );
    record(
      'removing it removes it from the shared list',
      shared.removed && shared.count === before,
    );

    if (SHOT) {
      await page.screenshot({ path: SHOT.replace(/(\.png)?$/, '-board.png') });
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        const layer =
          window.__godsEyeView.dataManager.layers.get('shipments').module;
        layer.board.showOnGlobe(layer.board.list()[0].id);
      });
      await sleep(4000);
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
