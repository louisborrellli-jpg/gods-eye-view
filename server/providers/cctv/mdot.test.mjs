import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MDOT_IMAGE_HOSTS,
  normalizeMdotImageUrl,
  parseMdotRow,
} from './mdot.js';
import { normalizeSourceItem } from './normalize.js';

test('thumbnail URLs normalize to the full-size still on the official host', () => {
  assert.equal(
    normalizeMdotImageUrl(
      'https://micamerasimages.net/thumbs/semtoc_cam_253.flv.jpg?item=1',
    ),
    'https://micamerasimages.net/semtoc_cam_253.jpg?item=1',
  );
  assert.equal(
    normalizeMdotImageUrl(
      'https://mdotjboss.state.mi.us/docs/drive/camfiles/rwis/12.jpg',
    ),
    'https://mdotjboss.state.mi.us/docs/drive/camfiles/rwis/12.jpg',
  );
  // Off-host or non-https is rejected.
  assert.equal(normalizeMdotImageUrl('https://evil.example/cam.jpg'), '');
  assert.equal(normalizeMdotImageUrl('http://micamerasimages.net/x.jpg'), '');
  assert.equal(normalizeMdotImageUrl('not a url'), '');
});

test('a list row parses into a placed, host-pinned camera', () => {
  const row = {
    county:
      'Wayne County <a href="/MiDrive/map?cameras=true&lat=42.491304&lon=-83.04479&zoom=15&id=1129" target="_blank">Go to</a>',
    route: '11 Mile',
    location: ' @  Mound',
    direction: 'NB',
    image:
      '<img alt="Traffic closest to camera is traveling north." id="1129Img" src="https://micamerasimages.net/thumbs/semtoc_cam_253.flv.jpg?item=1" height="170" width="250">',
  };
  const camera = normalizeSourceItem(parseMdotRow(row));
  assert.equal(camera.id, 'mdot-1129');
  assert.equal(camera.name, '11 Mile Mound');
  assert.equal(camera.city, 'Wayne');
  assert.ok(Math.abs(camera.lat - 42.491304) < 1e-5);
  assert.ok(Math.abs(camera.lon + 83.04479) < 1e-5);
  assert.equal(camera.feedType, 'image');
  assert.ok(
    MDOT_IMAGE_HOSTS.some((h) => camera.snapshotUrl.includes(h)),
    'frame stays on an official host',
  );
  assert.ok(!camera.snapshotUrl.includes('/thumbs/'));
});

test('rows without coordinates or an image are skipped', () => {
  assert.equal(
    parseMdotRow({
      county: 'Wayne County',
      image: '<img src="https://micamerasimages.net/x.jpg">',
    }),
    null,
  );
  assert.equal(
    parseMdotRow({ county: 'x lat=1&lon=2&zoom=15&id=9', image: 'no src' }),
    null,
  );
  assert.equal(parseMdotRow({}), null);
});
