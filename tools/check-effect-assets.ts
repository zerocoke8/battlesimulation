/**
 * 스킬 이펙트 에셋 검사기 (v0.9). `npm run effects:check`
 *
 * public/effects/ 안의 제작 에셋이 docs/EFFECTS.md 규격에 맞는지 본다.
 *  - 키 이름이 FX_KEYS 에 있는가
 *  - PNG 크기 = frameW × frames  ×  frameH
 *  - JSON 필드(frameW/frameH/frames/fps/anchor/blend/loop)와 타입·범위
 *  - 알파가 0 또는 255 인가 (안티앨리어싱·반투명 금지)
 *  - zone_fill_* 는 좌우·상하 이음매가 이어지는가 (격자로 이어 붙이는 타일)
 *  - 장판 테두리(zone_ring_<계열>_r<반경×10>)의 크기 — 프레임 한 변 = 반경 × 64 px, 시트 폭 = 한 변 × 프레임 수
 *    (테두리는 이어 붙이지 않고 그 크기로 딱 맞게 그리는 원이라 이음매 대신 크기를 본다)
 * 파일이 하나도 없으면 "아직 제작 에셋 없음 (임시 이펙트 사용 중)" 으로 통과한다.
 *
 * PNG 디코딩은 의존성 없이 직접 한다 (zlib 는 node 내장). 비인터레이스 PNG 만 읽는다.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import {
  FX_DEFAULT_META,
  FX_KEYS,
  isFxTileKey,
  parseFxMeta,
  parseRingFxKey,
  ringFrameSize,
  type FxKey,
  type FxMeta,
} from '../src/ui/pixel/fx/fxTypes';

// ───────────────────────── PNG 디코더 ─────────────────────────

interface DecodedPng {
  width: number;
  height: number;
  /** RGBA 8bit, width × height × 4 */
  data: Uint8Array;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** 비트 깊이별 샘플 → 0~255 */
function scaleSample(v: number, bitDepth: number): number {
  if (bitDepth === 8) return v;
  if (bitDepth === 16) return v >> 8;
  if (bitDepth === 4) return v * 17;
  if (bitDepth === 2) return v * 85;
  return v * 255; // 1
}

/** 한 스캔라인(언필터 완료)에서 index 번째 샘플을 읽는다 */
function readSample(line: Uint8Array, index: number, bitDepth: number): number {
  if (bitDepth === 8) return line[index];
  if (bitDepth === 16) return (line[index * 2] << 8) | line[index * 2 + 1];
  const perByte = 8 / bitDepth;
  const byte = line[Math.floor(index / perByte)];
  const shift = 8 - bitDepth * ((index % perByte) + 1);
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 최소 PNG 디코더. 지원: 비트 깊이 1/2/4/8/16, 색 타입 0/2/3/4/6, 비인터레이스 */
function decodePng(buf: Buffer): DecodedPng {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) throw new Error('PNG 시그니처가 아닙니다');
  }
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Buffer[] = [];

  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      if (body[10] !== 0) throw new Error('알 수 없는 압축 방식입니다');
      if (body[11] !== 0) throw new Error('알 수 없는 필터 방식입니다');
      interlace = body[12];
    } else if (type === 'PLTE') {
      palette = new Uint8Array(body);
    } else if (type === 'tRNS') {
      transparency = new Uint8Array(body);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len; // 길이(4) + 타입(4) + 데이터 + CRC(4)
  }

  if (width <= 0 || height <= 0) throw new Error('IHDR 를 읽지 못했습니다');
  if (interlace !== 0) throw new Error('인터레이스 PNG 는 지원하지 않습니다 (Adam7 해제 후 다시 저장하세요)');
  if (idat.length === 0) throw new Error('IDAT 가 없습니다');
  if (colorType === 3 && !palette) throw new Error('팔레트 PNG 인데 PLTE 가 없습니다');

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  const bitsPerPixel = channels * bitDepth;
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
  const bytesPerLine = Math.ceil((width * bitsPerPixel) / 8);

  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (bytesPerLine + 1) * height) throw new Error('압축 해제 결과가 너무 짧습니다 (파일 손상)');

  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(bytesPerLine);
  const line = new Uint8Array(bytesPerLine);

  for (let y = 0; y < height; y++) {
    const base = y * (bytesPerLine + 1);
    const filter = raw[base];
    for (let i = 0; i < bytesPerLine; i++) {
      const x = raw[base + 1 + i];
      const a = i >= bytesPerPixel ? line[i - bytesPerPixel] : 0;
      const b = prev[i];
      const c = i >= bytesPerPixel ? prev[i - bytesPerPixel] : 0;
      let v: number;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) v = x + paethPredictor(a, b, c);
      else throw new Error(`알 수 없는 스캔라인 필터 ${filter}`);
      line[i] = v & 255;
    }

    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;
      if (colorType === 0) {
        const raw0 = readSample(line, x, bitDepth);
        r = g = b = scaleSample(raw0, bitDepth);
        if (transparency && transparency.length >= 2 && ((transparency[0] << 8) | transparency[1]) === raw0) a = 0;
      } else if (colorType === 2) {
        r = scaleSample(readSample(line, x * 3, bitDepth), bitDepth);
        g = scaleSample(readSample(line, x * 3 + 1, bitDepth), bitDepth);
        b = scaleSample(readSample(line, x * 3 + 2, bitDepth), bitDepth);
      } else if (colorType === 3) {
        const idx = readSample(line, x, bitDepth);
        const p = palette as Uint8Array;
        r = p[idx * 3];
        g = p[idx * 3 + 1];
        b = p[idx * 3 + 2];
        a = transparency && idx < transparency.length ? transparency[idx] : 255;
      } else if (colorType === 4) {
        r = g = b = scaleSample(readSample(line, x * 2, bitDepth), bitDepth);
        a = scaleSample(readSample(line, x * 2 + 1, bitDepth), bitDepth);
      } else {
        r = scaleSample(readSample(line, x * 4, bitDepth), bitDepth);
        g = scaleSample(readSample(line, x * 4 + 1, bitDepth), bitDepth);
        b = scaleSample(readSample(line, x * 4 + 2, bitDepth), bitDepth);
        a = scaleSample(readSample(line, x * 4 + 3, bitDepth), bitDepth);
      }
      const o = (y * width + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }

    prev = line.slice();
  }

  return { width, height, data: out };
}

// ───────────────────────── 검사 결과 모으기 ─────────────────────────

const errors: string[] = [];
const warnings: string[] = [];

function fail(key: string, msg: string): void {
  errors.push(`  ✗ ${key}: ${msg}`);
}
function warn(key: string, msg: string): void {
  warnings.push(`  ! ${key}: ${msg}`);
}

// ───────────────────────── JSON 메타 검사 ─────────────────────────

const META_FIELDS = ['frameW', 'frameH', 'frames', 'fps', 'anchor', 'blend', 'loop'] as const;

function isPositiveInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** 원본 JSON 의 필드를 규격대로 검사한다. 오류는 errors 에 쌓는다 */
function checkMetaFields(key: FxKey, raw: unknown): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(key, 'JSON 최상위가 객체가 아닙니다');
    return;
  }
  const o = raw as Record<string, unknown>;
  for (const f of META_FIELDS) {
    if (!(f in o)) fail(key, `JSON 에 '${f}' 필드가 없습니다`);
  }
  if ('frameW' in o && !isPositiveInt(o.frameW)) fail(key, `frameW 는 1 이상의 정수여야 합니다 (현재 ${JSON.stringify(o.frameW)})`);
  if ('frameH' in o && !isPositiveInt(o.frameH)) fail(key, `frameH 는 1 이상의 정수여야 합니다 (현재 ${JSON.stringify(o.frameH)})`);
  if ('frames' in o && !isPositiveInt(o.frames)) fail(key, `frames 는 1 이상의 정수여야 합니다 (현재 ${JSON.stringify(o.frames)})`);
  if ('fps' in o && !(typeof o.fps === 'number' && Number.isFinite(o.fps) && o.fps > 0)) {
    fail(key, `fps 는 0 보다 큰 수여야 합니다 (현재 ${JSON.stringify(o.fps)})`);
  }
  if ('blend' in o && o.blend !== 'normal' && o.blend !== 'add') {
    fail(key, `blend 는 "normal" 또는 "add" 여야 합니다 (현재 ${JSON.stringify(o.blend)})`);
  }
  if ('loop' in o && typeof o.loop !== 'boolean') {
    fail(key, `loop 는 true/false 여야 합니다 (현재 ${JSON.stringify(o.loop)})`);
  }
  const anchor = o.anchor;
  if ('anchor' in o) {
    if (typeof anchor !== 'object' || anchor === null || Array.isArray(anchor)) {
      fail(key, 'anchor 는 { "x": 수, "y": 수 } 객체여야 합니다');
    } else {
      const a = anchor as Record<string, unknown>;
      const ax = a.x;
      const ay = a.y;
      if (typeof ax !== 'number' || !Number.isFinite(ax) || typeof ay !== 'number' || !Number.isFinite(ay)) {
        fail(key, 'anchor.x / anchor.y 는 수여야 합니다');
      } else {
        const w = isPositiveInt(o.frameW) ? (o.frameW as number) : 0;
        const h = isPositiveInt(o.frameH) ? (o.frameH as number) : 0;
        if (w > 0 && (ax < 0 || ax > w)) fail(key, `anchor.x ${ax} 가 프레임 폭 0~${w} 밖입니다`);
        if (h > 0 && (ay < 0 || ay > h)) fail(key, `anchor.y ${ay} 가 프레임 높이 0~${h} 밖입니다`);
      }
    }
  }
}

/** 기본 메타와 다른 값은 경고만 한다 (의도한 변경일 수 있다) */
function warnMetaDrift(key: FxKey, meta: FxMeta): void {
  const def = FX_DEFAULT_META[key];
  if (!def) return;
  const diffs: string[] = [];
  if (meta.frameW !== def.frameW || meta.frameH !== def.frameH) {
    diffs.push(`크기 ${meta.frameW}×${meta.frameH} (기본 ${def.frameW}×${def.frameH})`);
  }
  if (meta.frames !== def.frames) diffs.push(`frames ${meta.frames} (기본 ${def.frames})`);
  if (meta.fps !== def.fps) diffs.push(`fps ${meta.fps} (기본 ${def.fps})`);
  if (meta.blend !== def.blend) diffs.push(`blend ${meta.blend} (기본 ${def.blend})`);
  if (meta.loop !== def.loop) diffs.push(`loop ${meta.loop} (기본 ${def.loop})`);
  if (meta.anchor.x !== def.anchor.x || meta.anchor.y !== def.anchor.y) {
    diffs.push(`anchor (${meta.anchor.x},${meta.anchor.y}) (기본 (${def.anchor.x},${def.anchor.y}))`);
  }
  if (diffs.length > 0) warn(key, `기본 메타와 다릅니다 — ${diffs.join(', ')}. 의도한 값이면 그대로 두세요`);
}

// ───────────────────────── 픽셀 검사 ─────────────────────────

/** 알파는 0 또는 255 만 (안티앨리어싱·반투명 금지) */
function checkAlpha(key: FxKey, png: DecodedPng, meta: FxMeta): void {
  let bad = 0;
  let firstX = -1;
  let firstY = -1;
  let opaque = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const a = png.data[(y * png.width + x) * 4 + 3];
      if (a === 255) opaque++;
      else if (a !== 0) {
        bad++;
        if (firstX < 0) {
          firstX = x;
          firstY = y;
        }
      }
    }
  }
  if (bad > 0) {
    const frame = meta.frameW > 0 ? Math.floor(firstX / meta.frameW) : 0;
    const inX = meta.frameW > 0 ? firstX % meta.frameW : firstX;
    fail(key, `반투명 픽셀 ${bad}개 (알파는 0 또는 255 만). 처음 발견: 시트 (${firstX},${firstY}) = 프레임 ${frame} 의 (${inX},${firstY})`);
  }
  if (opaque === 0) warn(key, '불투명 픽셀이 하나도 없습니다 (빈 시트)');
}

/** 알파를 곱한 RGBA 채널값 (투명 픽셀의 RGB 차이는 무시된다) */
function premultiplied(png: DecodedPng, x: number, y: number, ch: number): number {
  const o = (y * png.width + x) * 4;
  const a = png.data[o + 3];
  if (ch === 3) return a;
  return (png.data[o + ch] * a) / 255;
}

function columnDiff(png: DecodedPng, x0: number, x1: number, y0: number, h: number): number {
  let sum = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let ch = 0; ch < 4; ch++) sum += Math.abs(premultiplied(png, x0, y, ch) - premultiplied(png, x1, y, ch));
  }
  return sum / (h * 4);
}

function rowDiff(png: DecodedPng, y0: number, y1: number, x0: number, w: number): number {
  let sum = 0;
  for (let x = x0; x < x0 + w; x++) {
    for (let ch = 0; ch < 4; ch++) sum += Math.abs(premultiplied(png, x, y0, ch) - premultiplied(png, x, y1, ch));
  }
  return sum / (w * 4);
}

/** 오름차순 정렬 후 90 퍼센타일 */
function percentile90(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
}

/**
 * 타일 이음매 검사 (`zone_fill_*` 전용).
 * 프레임마다 "오른쪽 끝 열 ↔ 왼쪽 첫 열"(좌우), "아래 끝 행 ↔ 위 첫 행"(상하) 의 차이를
 * 타일 안쪽의 이웃 열·행 차이(90 퍼센타일)와 비교한다. 경계에서만 뚝 끊기면 실패.
 * 원 내부를 바둑판처럼 채우는 타일이라 좌우·상하가 모두 이어져야 한다.
 */
function checkTileSeam(key: FxKey, png: DecodedPng, meta: FxMeta): void {
  const { frameW: fw, frameH: fh } = meta;
  const frameCount = Math.floor(png.width / fw);
  for (let f = 0; f < frameCount; f++) {
    const x0 = f * fw;

    const colInterior: number[] = [];
    for (let i = 0; i < fw - 1; i++) colInterior.push(columnDiff(png, x0 + i, x0 + i + 1, 0, fh));
    const colWrap = columnDiff(png, x0 + fw - 1, x0, 0, fh);
    const colLimit = percentile90(colInterior) * 1.5 + 6;
    if (colWrap > colLimit) {
      fail(key, `프레임 ${f}: 좌우 이음매가 끊깁니다 (경계 차이 ${colWrap.toFixed(1)} > 허용 ${colLimit.toFixed(1)}). x=${fw - 1} 열 다음에 x=0 열이 이어져야 합니다`);
    }

    const rowInterior: number[] = [];
    for (let i = 0; i < fh - 1; i++) rowInterior.push(rowDiff(png, i, i + 1, x0, fw));
    const rowWrap = rowDiff(png, fh - 1, 0, x0, fw);
    const rowLimit = percentile90(rowInterior) * 1.5 + 6;
    if (rowWrap > rowLimit) {
      fail(key, `프레임 ${f}: 상하 이음매가 끊깁니다 (경계 차이 ${rowWrap.toFixed(1)} > 허용 ${rowLimit.toFixed(1)}). y=${fh - 1} 행 다음에 y=0 행이 이어져야 합니다`);
    }

    // 가장자리가 통째로 비어 있으면 이음매 차이는 0 이지만 이어 붙인 자리가 눈에 보인다
    let edgeOpaque = 0;
    for (let y = 0; y < fh; y++) {
      edgeOpaque += png.data[(y * png.width + x0) * 4 + 3] > 0 ? 1 : 0;
      edgeOpaque += png.data[(y * png.width + x0 + fw - 1) * 4 + 3] > 0 ? 1 : 0;
    }
    for (let x = x0; x < x0 + fw; x++) {
      edgeOpaque += png.data[x * 4 + 3] > 0 ? 1 : 0;
      edgeOpaque += png.data[((fh - 1) * png.width + x) * 4 + 3] > 0 ? 1 : 0;
    }
    if (edgeOpaque === 0) {
      warn(key, `프레임 ${f}: 가장자리 네 변이 전부 비어 있습니다. 이어 붙이면 끊긴 자리가 보일 수 있습니다`);
    }
  }
}

/**
 * 장판 테두리 크기 검사.
 * 테두리는 이어 붙이지 않고 그 반경의 **실제 크기 그대로** 그린 원이라, 이음매 대신 크기가 규격이다.
 *   프레임 한 변 = 반경 × 2 × 32 px (정사각형),  시트 폭 = 프레임 한 변 × 프레임 수
 */
function checkRingSize(key: FxKey, png: DecodedPng, meta: FxMeta): void {
  const p = parseRingFxKey(key);
  if (!p) return;
  const need = ringFrameSize(p.radius);
  if (meta.frameW !== need || meta.frameH !== need) {
    fail(key, `반경 ${p.radius} 테두리의 프레임은 ${need}×${need} 여야 합니다 (= 반경 × 64). 현재 ${meta.frameW}×${meta.frameH}`);
    return;
  }
  const needW = need * meta.frames;
  if (png.width !== needW || png.height !== need) {
    fail(key, `시트는 ${needW}×${need} (= ${need} × ${meta.frames} 프레임) 여야 합니다. 현재 ${png.width}×${png.height}`);
  }
}

// ───────────────────────── 실행 ─────────────────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'public', 'effects');
const KEY_SET = new Set<string>(FX_KEYS);

if (!existsSync(DIR)) {
  console.log('PASS: 아직 제작 에셋 없음 (임시 이펙트 사용 중) — public/effects/ 폴더가 없습니다');
  process.exit(0);
}

const entries = readdirSync(DIR, { withFileTypes: true });
const pngKeys: string[] = [];
const jsonKeys = new Set<string>();

for (const e of entries) {
  if (e.isDirectory()) {
    warnings.push(`  ! ${e.name}/: 하위 폴더는 무시됩니다. 파일은 public/effects/ 바로 아래에 두세요`);
    continue;
  }
  const name = e.name;
  if (name === 'README.md' || name.charAt(0) === '.') continue;
  if (name.endsWith('.png')) pngKeys.push(name.slice(0, -4));
  else if (name.endsWith('.json')) jsonKeys.add(name.slice(0, -5));
  else warnings.push(`  ! ${name}: 규격 밖 파일입니다 (.png / .json 만 읽습니다)`);
}

if (pngKeys.length === 0 && jsonKeys.size === 0) {
  console.log('PASS: 아직 제작 에셋 없음 (임시 이펙트 사용 중)');
  if (warnings.length > 0) console.log(['경고:', ...warnings].join('\n'));
  process.exit(0);
}

pngKeys.sort();
let checked = 0;

for (const key of pngKeys) {
  if (!KEY_SET.has(key)) {
    fail(key, `FX_KEYS 에 없는 키입니다. 키 목록은 npm run effects:list 로 확인하세요 (총 ${FX_KEYS.length}종)`);
    continue;
  }
  const fxKey = key as FxKey;
  const jsonPath = join(DIR, `${key}.json`);
  let meta: FxMeta = FX_DEFAULT_META[fxKey];

  if (!jsonKeys.has(key)) {
    warn(key, `${key}.json 이 없습니다. 기본 메타로 읽힙니다`);
  } else {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(jsonPath, 'utf8'));
    } catch (err) {
      fail(key, `JSON 파싱 실패: ${(err as Error).message}`);
      raw = undefined;
    }
    if (raw !== undefined) {
      checkMetaFields(fxKey, raw);
      meta = parseFxMeta(raw, fxKey);
      warnMetaDrift(fxKey, meta);
    }
  }

  let png: DecodedPng;
  try {
    png = decodePng(readFileSync(join(DIR, `${key}.png`)));
  } catch (err) {
    fail(key, `PNG 를 읽지 못했습니다: ${(err as Error).message}`);
    continue;
  }

  const needW = meta.frameW * meta.frames;
  if (png.width !== needW || png.height !== meta.frameH) {
    fail(key, `시트 크기 ${png.width}×${png.height} 가 규격 ${needW}×${meta.frameH} (= ${meta.frameW}×${meta.frames} 프레임 × ${meta.frameH}) 와 다릅니다`);
    continue;
  }

  checkAlpha(fxKey, png, meta);
  // zone_fill_* 는 이어 붙이는 타일이라 좌우·상하 이음매를 본다.
  // 장판 테두리는 이어 붙이지 않는 '실제 크기 그대로'의 원이라 이음매 대신 **크기**를 본다.
  if (isFxTileKey(fxKey)) checkTileSeam(fxKey, png, meta);
  else checkRingSize(fxKey, png, meta);
  checked++;
}

for (const key of jsonKeys) {
  if (!pngKeys.includes(key)) {
    if (!KEY_SET.has(key)) fail(key, `FX_KEYS 에 없는 키입니다 (${key}.json)`);
    else fail(key, `${key}.png 이 없습니다. JSON 만 있으면 그 키는 임시 이펙트로 남습니다`);
  }
}

const missing = FX_KEYS.filter((k) => !pngKeys.includes(k));
console.log(`제작 에셋 ${checked}/${FX_KEYS.length}종 검사 (public/effects/)`);
if (missing.length > 0) {
  console.log(`  · 아직 없는 키 ${missing.length}종은 임시 이펙트로 나옵니다 (전체 목록: npm run effects:list)`);
}
if (warnings.length > 0) console.log(['경고:', ...warnings].join('\n'));

if (errors.length > 0) {
  console.error(['오류:', ...errors].join('\n'));
  console.error(`FAIL: 오류 ${errors.length}건. 규격은 docs/EFFECTS.md 를 보세요`);
  process.exit(1);
}

console.log(`PASS: 이펙트 에셋 ${checked}종이 규격에 맞습니다`);
