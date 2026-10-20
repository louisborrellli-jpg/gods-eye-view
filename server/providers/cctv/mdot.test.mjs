import assert from 'node:assert/strict';
import test from 'node:test';
import { mdotCameraToSource, normalizeMdotImageUrl } from './mdot.js';

// Shape of a live Mi Drive list row (Oct 2026).
const row = {
  route: 'Jefferson',
  county:
    'Wayne County <a href="/MiDrive/map?cameras=true&lat=42.330688&lon=-83.04565&zoom=15&id=2600"target="_blank">Go to</a>',
  location: ' @ Beaubien',
  direction: 'Traffic closest to camera is traveling west.',
  image:
    '<img alt="" class="cameraImageForActivePane" id="2600Img" src="https://micamerasimages.net/thumbs/semtoc_cam_361.flv.jpg?item=1" height="170" width="250">',
};

test('a Mi Drive row becomes a Detroit camera with a full-size official still', () => {
  const camera = mdotCameraToSource(row);
  assert.equal(camera.id, 'mdot-2600');
  assert.equal(camera.name, 'Jefferson @ Beaubien');
  assert.equal(camera.city, 'Wayne County');
  assert.equal(camera.lat, 42.330688);
  assert.equal(camera.lon, -83.04565);
  assert.equal(camera.url, 'https://micamerasimages.net/semtoc_cam_361.jpg');
  assert.equal(camera.snapshotUrl, camera.url);
  assert.equal(camera.feedType, 'image');
  assert.equal(camera.sourceKind, 'mdot-midrive');
});

test('frames are pinned to micamerasimages.net over https', () => {
  assert.equal(
    normalizeMdotImageUrl('https://evil.example/semtoc_cam_1.jpg'),
    '',
  );
  assert.equal(
    normalizeMdotImageUrl('http://micamerasimages.net/semtoc_cam_1.jpg'),
    '',
  );
  assert.equal(
    normalizeMdotImageUrl('https://micamerasimages.net/admin/x.jpg'),
    '',
  );
  assert.equal(
    normalizeMdotImageUrl('https://micamerasimages.net.evil.example/x.jpg'),
    '',
  );
  assert.equal(
    normalizeMdotImageUrl('https://micamerasimages.net/grand_cam_036.jpg'),
    'https://micamerasimages.net/grand_cam_036.jpg',
  );
});

test('rows without Michigan coordinates, an id, or an official image are dropped', () => {
  assert.equal(mdotCameraToSource(null), null);
  assert.equal(
    mdotCameraToSource({
      ...row,
      county: row.county.replace('42.330688', '10.0'),
    }),
    null,
  );
  assert.equal(mdotCameraToSource({ ...row, county: 'Wayne County' }), null);
  assert.equal(
    mdotCameraToSource({
      ...row,
      image: '<img src="https://evil.example/a.jpg">',
    }),
    null,
  );
});
