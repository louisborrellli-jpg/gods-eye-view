/**
 * Shipments gate: add a container through the board form, link its ship,
 * and prove the board, the globe pin and the free-time alerts agree.
 *
 * The ship lookup (/api/vessels/find) is stubbed in the browser, so the run
 * needs no AISStream key and never depends on which ships are on air. Dates
 * are written relative to the browser's own today.
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
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = new URL(request.url());
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

    await page.type('#shipments-board input[name="vessel"]', 'QA TESTSHIP');
    await page.evaluate(() => {
      const day = (offset) => {
        const date = new Date(Date.now() + offset * 86_400_000);
        const pad = (v) => String(v).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      };
      const form = document.querySelector('#shipments-board form');
      form.elements.namedItem('date:portEta').value = day(2);
      form.elements.namedItem('free:ramp').value = '3';
    });
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
      'the card shows the box, its line and the stage',
      card.includes('MSCU1234566') &&
        card.includes('MSC') &&
        /At sea/i.test(card),
      card.replace(/\s+/g, ' ').slice(0, 160),
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
      'the ship is remembered and pinned on the globe',
      pin.lastSeen?.name === 'QA TESTSHIP' &&
        pin.mmsi === '990000123' &&
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
