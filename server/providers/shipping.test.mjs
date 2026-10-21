import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shippingProxy } from './shipping.js';

function serve(plugin) {
  let handler = null;
  plugin.configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  return (url) =>
    new Promise((resolve) => {
      const res = {
        destroyed: false,
        writeHead(status) {
          this.status = status;
        },
        end(body) {
          resolve({ status: this.status, body: JSON.parse(body) });
        },
      };
      handler({ method: 'GET', url, headers: {}, socket: {} }, res);
    });
}

const findTeuAnswer = {
  success: true,
  data: {
    scac: 'MSCU',
    pol: { port: 'Gioia Tauro', iso_code: 'ITGIT' },
    pod: { port: 'Montreal', iso_code: 'CAMTR', eta_date: '2026-10-24' },
    destination: { port: 'Toronto', iso_code: 'CATOR' },
    container: { number: 'MSCU1234566', completed: false },
    events: [],
  },
};

function fakeFetch(calls) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('terminal49'))
      return new Response('{}', { status: 201 });
    return new Response(JSON.stringify(findTeuAnswer), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

test('without keys nothing is fetched and the browser is told why', async () => {
  const calls = [];
  const get = serve(shippingProxy({ fetchImpl: fakeFetch(calls), env: {} }));
  assert.deepEqual((await get('/status')).body, {
    findteu: false,
    terminal49: false,
  });
  const answer = await get('/track?container=MSCU1234566');
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, {
    configured: false,
    tracking: null,
    terminal49: 'off',
  });
  assert.equal(calls.length, 0);
  assert.equal((await get('/track?container=../../etc')).status, 400);
});

test('FindTEU is asked once per container and Terminal49 gets it registered', async () => {
  const calls = [];
  const get = serve(
    shippingProxy({
      fetchImpl: fakeFetch(calls),
      env: { FINDTEU_API_KEY: 'k1', TERMINAL49_API_KEY: 't1' },
    }),
  );
  const first = await get('/track?container=mscu1234566&carrier=msc');
  assert.equal(first.status, 200);
  assert.equal(first.body.tracking.dates.portEta, '2026-10-24');
  assert.equal(first.body.tracking.destination.code, 'CATOR');
  assert.equal(first.body.terminal49, 'registered');
  const findTeu = calls.find((call) => call.url.includes('findteu'));
  assert.equal(findTeu.url, 'https://api.findteu.com/container/MSCU1234566');
  assert.equal(findTeu.init.headers['X-Authorization-ApiKey'], 'k1');
  assert.equal(String(findTeu.init.body), 'scac=MSCU');
  const t49 = calls.find((call) => call.url.includes('terminal49'));
  assert.equal(t49.init.headers.Authorization, 'Token t1');
  assert.deepEqual(JSON.parse(t49.init.body).data.attributes, {
    request_type: 'container',
    request_number: 'MSCU1234566',
    scac: 'MSCU',
  });
  await get('/track?container=MSCU1234566&carrier=msc');
  assert.equal(calls.length, 2, 'the second ask is answered from cache');
});

test('a FindTEU refusal is passed on in its own words', async () => {
  const get = serve(
    shippingProxy({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: false,
            error: {
              code: 203,
              text: 'API key has exceeded the limit of requests',
            },
          }),
          { status: 200 },
        ),
      env: { FINDTEU_API_KEY: 'k1' },
    }),
  );
  const answer = await get('/track?container=MSCU1234566');
  assert.equal(answer.status, 502);
  assert.equal(answer.body.error, 'API key has exceeded the limit of requests');
});
