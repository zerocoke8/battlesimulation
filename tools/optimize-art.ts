/**
 * 그림 에셋 축소 도구 (v0.9). `npm run art:optimize`
 *
 * public/ 의 PNG 는 화면에 실제로 그려지는 크기보다 훨씬 컸다. 브라우저가 최근접(nearest)으로 줄이면
 * 픽셀이 뭉개지는데 배포 용량은 그대로였다. 이 도구가 **표시 크기에 맞춘 그림**을 미리 만들어 둔다.
 *
 *  - 축소는 **박스 필터(면적 평균)**. 목적지 픽셀이 덮는 원본 픽셀들을 겹친 면적만큼 가중 평균한다.
 *    최근접과 달리 원본 디테일이 평균으로 살아남는다.
 *  - 알파가 있으면 **프리멀티플라이**(RGB × α) 해서 평균한 뒤 되돌린다. 투명 픽셀의 (보통 검은) RGB 가
 *    평균을 끌어당겨 가장자리에 검은 테두리가 생기는 것을 막는다.
 *  - 출력은 8bit PNG, deflate 레벨 9. 색 타입은 목표 표의 `colorType` 이 정한다 —
 *    알파가 필요 없는 배경은 2(RGB) 라 픽셀당 1바이트를 아끼고, 투명 배경이 필요한 아이콘은 6(RGBA) 이다.
 *    줄마다 5가지 스캔라인 필터를 다 해 보고 절댓값 합이 가장 작은 것을 고른다
 *    (libpng 와 같은 휴리스틱 — 압축률이 눈에 띄게 좋아진다). 필터의 픽셀 보폭은 색 타입에 맞춰 3/4 바이트다.
 *  - **원본 보존**: 줄이기 전에 원본을 `art/originals/<하위폴더>/<파일명>` 으로 옮겨 둔다.
 *    이미 거기 있으면 그것을 입력으로 삼는다 — 같은 파일을 두 번 줄여 화질이 깎이는 것을 막는다.
 *
 * PNG 디코딩·인코딩은 의존성 없이 직접 한다 (zlib 는 node 내장).
 *
 * 옵션:
 *   --check   파일을 쓰지 않고 현재 크기 · 목표 크기 · 절감량만 보여준다 (축소·인코딩은 실제로 해 본다)
 *   --help    도움말
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants as ZLIB, deflateSync, inflateSync } from 'node:zlib';

// ───────────────────────── 대상과 목표 크기 ─────────────────────────

/** 출력 색 타입. 2 = RGB(픽셀당 3바이트), 6 = RGBA(픽셀당 4바이트) */
type OutColorType = 2 | 6;

interface ArtTarget {
  /** public/ 아래 폴더 이름 (= art/originals/ 아래 폴더 이름) */
  readonly dir: string;
  readonly width: number;
  readonly height: number;
  /** 출력 색 타입. 알파를 쓰지 않는 그림은 2 로 두면 픽셀당 1바이트를 아낀다 */
  readonly colorType: OutColorType;
  /** 왜 이 크기인지 */
  readonly why: string;
}

/**
 * 표시 크기 근거
 *  - backgrounds: terrain.ts 가 맵 내부에만 그린다. 28×20 유닛 × 32px = 896×640 (MAP_DEFAULT_WIDTH/HEIGHT).
 *    배경은 맵을 빈틈없이 덮으므로 알파가 필요 없다 → colortype 2(RGB).
 *  - icons: icons.ts 가 투명 여백을 잘라 128×128 캔버스에 담고 최대 20px 배지로 그린다. 256 이면 여유가 충분하다.
 *    여백을 잘라내는 판정이 알파를 보므로 colortype 6(RGBA) 이어야 한다.
 */
const TARGETS: readonly ArtTarget[] = [
  { dir: 'backgrounds', width: 896, height: 640, colorType: 2, why: '맵 내부 28×20 유닛 × 32px' },
  { dir: 'icons', width: 256, height: 256, colorType: 6, why: '여백 제거 후 128×128 캔버스 → 최대 20px 배지' },
];

// ───────────────────────── PNG 디코더 ─────────────────────────

interface DecodedPng {
  width: number;
  height: number;
  /** RGBA 8bit, width × height × 4 */
  data: Uint8Array;
  /** 원본 색 타입 (보고용) */
  colorType: number;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** 비트 깊이별 샘플 → 0~255 */
function scaleSample(v: number, bitDepth: number): number {
  if (bitDepth === 8) return v;
  if (bitDepth === 4) return v * 17;
  if (bitDepth === 2) return v * 85;
  return v * 255; // 1
}

/** 한 스캔라인(언필터 완료)에서 index 번째 샘플을 읽는다 */
function readSample(line: Uint8Array, index: number, bitDepth: number): number {
  if (bitDepth === 8) return line[index];
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

/** 최소 PNG 디코더. 지원: 비트 깊이 1/2/4/8, 색 타입 0/2/3/4/6, 비인터레이스 */
function decodePng(buf: Buffer, label: string): DecodedPng {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) throw new Error(`${label}: PNG 시그니처가 아닙니다`);
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
      if (body[10] !== 0) throw new Error(`${label}: 알 수 없는 압축 방식입니다`);
      if (body[11] !== 0) throw new Error(`${label}: 알 수 없는 필터 방식입니다`);
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

  if (width <= 0 || height <= 0) throw new Error(`${label}: IHDR 를 읽지 못했습니다`);
  if (interlace !== 0) {
    throw new Error(`${label}: 인터레이스(Adam7) PNG 는 지원하지 않습니다. 인터레이스를 끄고 다시 저장하세요`);
  }
  if (bitDepth === 16) {
    throw new Error(`${label}: 16bit PNG 는 지원하지 않습니다. 채널당 8bit 로 다시 저장하세요`);
  }
  if (bitDepth !== 1 && bitDepth !== 2 && bitDepth !== 4 && bitDepth !== 8) {
    throw new Error(`${label}: 알 수 없는 비트 깊이 ${bitDepth} 입니다 (1/2/4/8 만 지원)`);
  }
  if (colorType !== 0 && colorType !== 2 && colorType !== 3 && colorType !== 4 && colorType !== 6) {
    throw new Error(`${label}: 알 수 없는 색 타입 ${colorType} 입니다 (0/2/3/4/6 만 지원)`);
  }
  if (idat.length === 0) throw new Error(`${label}: IDAT 가 없습니다`);
  if (colorType === 3 && !palette) throw new Error(`${label}: 팔레트 PNG 인데 PLTE 가 없습니다`);

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  const bitsPerPixel = channels * bitDepth;
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
  const bytesPerLine = Math.ceil((width * bitsPerPixel) / 8);

  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (bytesPerLine + 1) * height) {
    throw new Error(`${label}: 압축 해제 결과가 너무 짧습니다 (파일 손상)`);
  }

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
      else throw new Error(`${label}: 알 수 없는 스캔라인 필터 ${filter}`);
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

  return { width, height, data: out, colorType };
}

// ───────────────────────── PNG 인코더 (8bit RGBA) ─────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  Buffer.from(body.buffer, body.byteOffset, body.length).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/**
 * 8bit PNG 로 인코딩한다 (colortype 2 = RGB / 6 = RGBA). deflate 는 레벨 9.
 * 줄마다 필터 5종을 모두 계산해 부호 있는 절댓값 합이 가장 작은 것을 고른다 (libpng 휴리스틱).
 * 필터의 '왼쪽 픽셀' 오프셋(bpp)은 색 타입에 따라 3 또는 4 바이트다 — 여기를 틀리면 압축률만 나빠진다.
 *
 * 입력은 언제나 RGBA 버퍼다. colortype 2 면 알파를 버리고 RGB 만 쓰는데, 그러면 투명도가 사라지므로
 * 완전 불투명(알파 255)이 아닌 픽셀이 하나라도 있으면 오류를 낸다.
 */
function encodePng(width: number, height: number, rgba: Uint8Array, colorType: OutColorType, label: string): Buffer {
  const bpp = colorType === 2 ? 3 : 4;

  if (colorType === 2) {
    for (let i = 0; i < width * height; i++) {
      const a = rgba[i * 4 + 3];
      if (a !== 255) {
        const x = i % width;
        const y = Math.floor(i / width);
        throw new Error(
          `${label}: colortype 2(RGB) 로 내보내려면 모든 픽셀이 완전 불투명이어야 하는데 (${x},${y}) 의 알파가 ${a} 입니다. ` +
            '투명도가 필요한 그림이면 목표 표의 colorType 을 6 으로 두세요',
        );
      }
    }
  }

  const stride = width * bpp;
  const src = new Uint8Array(stride * height);
  if (colorType === 2) {
    for (let i = 0, o = 0; i < width * height; i++, o += 3) {
      src[o] = rgba[i * 4];
      src[o + 1] = rgba[i * 4 + 1];
      src[o + 2] = rgba[i * 4 + 2];
    }
  } else {
    src.set(rgba);
  }

  const raw = Buffer.alloc((stride + 1) * height);
  const prev = new Uint8Array(stride);
  const cand = [
    new Uint8Array(stride),
    new Uint8Array(stride),
    new Uint8Array(stride),
    new Uint8Array(stride),
    new Uint8Array(stride),
  ];

  for (let y = 0; y < height; y++) {
    const line = src.subarray(y * stride, y * stride + stride);
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const buf = cand[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const x = line[i];
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        let v: number;
        if (f === 0) v = x;
        else if (f === 1) v = x - a;
        else if (f === 2) v = x - b;
        else if (f === 3) v = x - ((a + b) >> 1);
        else v = x - paethPredictor(a, b, c);
        v &= 255;
        buf[i] = v;
        // 부호 있는 바이트로 본 절댓값의 합 — 작을수록 뒤의 deflate 가 잘 먹는다
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    const at = y * (stride + 1);
    raw[at] = best;
    raw.set(cand[best], at + 1);
    prev.set(line);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 비트 깊이
  ihdr[9] = colorType; // 2 = RGB, 6 = RGBA
  ihdr[10] = 0; // 압축
  ihdr[11] = 0; // 필터
  ihdr[12] = 0; // 인터레이스 없음

  const idat = deflateSync(raw, {
    level: 9,
    memLevel: 9,
    windowBits: 15,
    strategy: ZLIB.Z_DEFAULT_STRATEGY,
  });

  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

// ───────────────────────── 박스 필터 축소 ─────────────────────────

function clamp255(v: number): number {
  const n = Math.round(v);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

/**
 * 면적 평균(박스 필터)으로 다시 표본화한다. 최근접과 달리 목적지 픽셀이 덮는 원본 픽셀을
 * **겹친 면적만큼** 가중 평균하므로 디테일이 평균으로 남는다.
 * 알파는 프리멀티플라이 후 평균하고 되돌린다 (투명 픽셀의 RGB 가 새어 나오지 않게).
 */
export function resizeBox(src: DecodedPng, dw: number, dh: number): Uint8Array {
  const { width: sw, height: sh, data } = src;
  const out = new Uint8Array(dw * dh * 4);
  const xScale = sw / dw;
  const yScale = sh / dh;

  for (let dy = 0; dy < dh; dy++) {
    const y0 = dy * yScale;
    const y1 = Math.min(sh, (dy + 1) * yScale);
    const syStart = Math.floor(y0);
    const syEnd = Math.min(sh, Math.ceil(y1));
    for (let dx = 0; dx < dw; dx++) {
      const x0 = dx * xScale;
      const x1 = Math.min(sw, (dx + 1) * xScale);
      const sxStart = Math.floor(x0);
      const sxEnd = Math.min(sw, Math.ceil(x1));

      let area = 0; // Σ 면적
      let aSum = 0; // Σ (알파 × 면적)
      let rSum = 0; // Σ (R × 알파/255 × 면적)
      let gSum = 0;
      let bSum = 0;

      for (let sy = syStart; sy < syEnd; sy++) {
        const hy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (hy <= 0) continue;
        const row = sy * sw;
        for (let sx = sxStart; sx < sxEnd; sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (wx <= 0) continue;
          const w = hy * wx;
          const o = (row + sx) * 4;
          const a = data[o + 3];
          area += w;
          aSum += a * w;
          const pw = (a / 255) * w; // 프리멀티플라이 가중치
          rSum += data[o] * pw;
          gSum += data[o + 1] * pw;
          bSum += data[o + 2] * pw;
        }
      }

      const o = (dy * dw + dx) * 4;
      if (area <= 0 || aSum <= 0) {
        // 완전히 투명한 칸 — RGB 는 0 으로 둔다
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
        out[o + 3] = 0;
        continue;
      }
      // 프리멀티플라이 되돌리기: 분모 = Σ(알파/255 × 면적) = aSum / 255
      const div = aSum / 255;
      out[o] = clamp255(rSum / div);
      out[o + 1] = clamp255(gSum / div);
      out[o + 2] = clamp255(bSum / div);
      out[o + 3] = clamp255(aSum / area);
    }
  }
  return out;
}

// ───────────────────────── 표 출력 ─────────────────────────

/** 터미널 표시 폭 (한글·전각은 2칸) */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

function padEndW(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - displayWidth(s)));
}

function padStartW(s: string, n: number): string {
  return ' '.repeat(Math.max(0, n - displayWidth(s))) + s;
}

type Align = 'l' | 'r';

function printTable(header: readonly string[], rows: readonly (readonly string[])[], align: readonly Align[]): void {
  const widths = header.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => (align[i] === 'r' ? padStartW(c, widths[i]) : padEndW(c, widths[i]))).join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// ───────────────────────── 실행 ─────────────────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const ORIGINALS_DIR = join(ROOT, 'art', 'originals');

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`그림 에셋 축소 도구

  npm run art:optimize            public/ 의 그림을 표시 크기로 줄인다 (원본은 art/originals/ 에 보존)
  npm run art:optimize -- --check 파일을 쓰지 않고 현재 크기 · 목표 크기 · 절감량만 본다

대상:
${TARGETS.map(
  (t) =>
    `  public/${t.dir}/*.png  →  ${t.width}×${t.height} ${t.colorType === 2 ? 'RGB' : 'RGBA'}   (${t.why})`,
).join('\n')}

원본은 art/originals/<폴더>/<파일> 에 보존된다. 이미 있으면 그것을 입력으로 쓰므로
여러 번 돌려도 같은 결과가 나온다 (두 번 줄여 화질이 깎이지 않는다).`);
  process.exit(0);
}

interface Row {
  label: string;
  srcW: number;
  srcH: number;
  srcBytes: number;
  outW: number;
  outH: number;
  outBytes: number;
  outType: OutColorType;
}

const rows: Row[] = [];
const notes: string[] = [];
let failed = 0;

console.log(checkOnly ? '그림 에셋 점검 (--check: 파일을 쓰지 않습니다)\n' : '그림 에셋 축소\n');

for (const target of TARGETS) {
  const publicSub = join(PUBLIC_DIR, target.dir);
  if (!existsSync(publicSub)) {
    notes.push(`! public/${target.dir}/ 폴더가 없습니다 — 건너뜁니다`);
    continue;
  }
  const originalSub = join(ORIGINALS_DIR, target.dir);
  const files = readdirSync(publicSub, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.png'))
    .map((e) => e.name)
    .sort();

  if (files.length === 0) {
    notes.push(`! public/${target.dir}/ 에 PNG 가 없습니다`);
    continue;
  }

  for (const name of files) {
    const publicPath = join(publicSub, name);
    const originalPath = join(originalSub, name);
    const label = `${target.dir}/${name}`;

    // 원본 보존: 없으면 지금 것을 원본으로 옮겨 두고, 있으면 그것을 입력으로 쓴다
    let srcPath = publicPath;
    let restored = false;
    if (existsSync(originalPath)) {
      srcPath = originalPath;
      restored = true;
    } else if (!checkOnly) {
      mkdirSync(originalSub, { recursive: true });
      copyFileSync(publicPath, originalPath);
      srcPath = originalPath;
    }

    let src: DecodedPng;
    try {
      src = decodePng(readFileSync(srcPath), label);
    } catch (err) {
      console.error(`  ✗ ${label}: ${(err as Error).message}`);
      failed++;
      continue;
    }

    const srcBytes = statSync(srcPath).size;

    // 가로세로 비율이 크게 다르면 잘리거나 늘어난다 — 줄이기는 하되 알려 준다
    const srcRatio = src.width / src.height;
    const dstRatio = target.width / target.height;
    if (Math.abs(srcRatio - dstRatio) / dstRatio > 0.01) {
      notes.push(
        `! ${label}: 원본 비율 ${srcRatio.toFixed(3)} 이 목표 비율 ${dstRatio.toFixed(3)} 과 다릅니다 (가로세로가 늘어납니다)`,
      );
    }
    if (src.width < target.width || src.height < target.height) {
      notes.push(`! ${label}: 원본 ${src.width}×${src.height} 이 목표보다 작습니다 (확대하게 됩니다)`);
    }

    const resized = resizeBox(src, target.width, target.height);
    let png: Buffer;
    try {
      png = encodePng(target.width, target.height, resized, target.colorType, label);
    } catch (err) {
      console.error(`  ✗ ${(err as Error).message}`);
      failed++;
      continue;
    }

    if (!checkOnly) {
      writeFileSync(publicPath, png);
    }
    if (restored && !checkOnly) {
      notes.push(`· ${label}: art/originals 의 원본을 입력으로 썼습니다`);
    }

    rows.push({
      label,
      srcW: src.width,
      srcH: src.height,
      srcBytes,
      outW: target.width,
      outH: target.height,
      outBytes: png.length,
      outType: target.colorType,
    });
  }
}

if (rows.length > 0) {
  printTable(
    ['파일', '원본 크기', '원본 용량', '결과 크기', '형식', '결과 용량', '절감률'],
    rows.map((r) => [
      r.label,
      `${r.srcW}×${r.srcH}`,
      kb(r.srcBytes),
      `${r.outW}×${r.outH}`,
      r.outType === 2 ? 'RGB' : 'RGBA',
      kb(r.outBytes),
      `${((1 - r.outBytes / r.srcBytes) * 100).toFixed(1)}%`,
    ]),
    ['l', 'r', 'r', 'r', 'l', 'r', 'r'],
  );

  const totalSrc = rows.reduce((s, r) => s + r.srcBytes, 0);
  const totalOut = rows.reduce((s, r) => s + r.outBytes, 0);
  console.log();
  console.log(
    `합계 ${rows.length}개: ${kb(totalSrc)} → ${kb(totalOut)}  (−${kb(totalSrc - totalOut)}, 절감률 ${(
      (1 - totalOut / totalSrc) * 100
    ).toFixed(1)}%)`,
  );
}

if (notes.length > 0) {
  console.log();
  for (const n of notes) console.log(n);
}

if (failed > 0) {
  console.error(`\nFAIL: ${failed}개 파일을 처리하지 못했습니다`);
  process.exit(1);
}

console.log(
  checkOnly
    ? '\n점검만 했습니다. 실제로 줄이려면 npm run art:optimize 를 옵션 없이 돌리세요'
    : '\n완료. 원본은 art/originals/ 에 있습니다',
);
