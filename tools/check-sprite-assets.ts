import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { ALL_SPRITE_KEYS, ANIM_NAMES, DEFAULT_META, parseSpriteMeta } from '../src/ui/pixel/spriteTypes';
import { applyHueTint } from '../src/ui/pixel/palette';

for (const key of ALL_SPRITE_KEYS) {
  const prefix = `public/sprites/${key}`;
  const meta = parseSpriteMeta(JSON.parse(readFileSync(`${prefix}.json`, 'utf8')));
  assert(meta, key);
  assert.equal(meta.frameW, 64);
  assert.equal(meta.frameH, 64);
  assert.deepEqual(meta.anchor, { x: 32, y: 58 });
  for (const name of ANIM_NAMES) assert.deepEqual(meta.anims[name], DEFAULT_META.anims[name]);
  const paths = [`${prefix}.png`];
  if (meta.tintMask) paths.push(`public/sprites/${meta.tintMask}`);
  for (const path of paths) {
    const png = readFileSync(path);
    assert.equal(png.subarray(1, 4).toString(), 'PNG', path);
    assert.equal(png.readUInt32BE(16), 384, path);
    assert.equal(png.readUInt32BE(20), 384, path);
  }
  assert(existsSync(`art/aseprite/${key}.aseprite`), key);
}

// A blush color and a muted garment share the same input buffer. Only garment
// pixels may change, even if the blush passes the legacy saturation heuristic.
const original = new Uint8ClampedArray([246, 116, 123, 255, 117, 125, 174, 255, 255, 235, 221, 255]);
const pixels = new Uint8ClampedArray(original);
const mask = new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0]);
applyHueTint(pixels, '#48bb78', mask);
assert.deepEqual(pixels.slice(0, 4), original.slice(0, 4), 'blush must stay unchanged');
assert.deepEqual(pixels.slice(8), original.slice(8), 'eyelids must stay unchanged');
assert.notDeepEqual(pixels.slice(4, 7), original.slice(4, 7), 'muted clothing must recolor');
assert.equal(pixels[7], 255);
assert.equal(parseSpriteMeta({ ...DEFAULT_META, tintMask: '../face.png' })?.tintMask, undefined);

const report = JSON.parse(readFileSync('art/verification.json', 'utf8'));
assert.equal(report.passed, true);
assert.equal(report.sprites, ALL_SPRITE_KEYS.length);
assert.equal(report.frames, ALL_SPRITE_KEYS.length * 24);
console.log(`PASS: ${ALL_SPRITE_KEYS.length} asset contracts, protected face tint, ${report.frames} Aseprite frames`);
