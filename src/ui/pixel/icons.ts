/**
 * 직업 픽셀 아이콘. 생성한 PNG 문양을 HP 바 왼쪽 진영 배지에 그린다.
 * 작은 크기는 면적 기반 불투명 픽셀로 표본화해 가는 자루가 사라지지 않게 한다.
 * 아래 16×16 마스크는 이미지 로드 전/실패 시의 폴백이다.
 *
 *  - 직업 9종을 16×16 알파 마스크(흑백)로 정의한다. 데이터는 문자열 16줄 × 16칸 ('#' = 칠함, '.' = 빈칸).
 *    마스크는 가장자리 1칸(0행/15행, 0열/15열)을 비워 두어 테두리와 겹치지 않는다.
 *  - 그릴 때 색을 입혀 (전경·배경·테두리) 캐시한다. 요청 크기 그대로의 캔버스에 정수 픽셀 격자로 래스터화하므로
 *    확대 시 최근접(nearest) 확대와 같고 흐려지지 않는다. 그리는 쪽도 imageSmoothingEnabled = false 를 쓴다.
 *  - 9~16px 에서도 읽히도록 실루엣은 굵게(선 굵기 2칸 이상), 얇은 대각선은 쓰지 않는다.
 *    작은 크기로 줄일 때는 목적지 픽셀이 덮는 원본 칸들의 채움 비율(COVERAGE_MIN)로 판정한다 (최근접보다 형태가 덜 깨진다).
 *  - 아이콘 글리프 둘레에는 배경색 1px 외곽선을 둘러 테두리 링과 붙어도 흰 글리프가 읽힌다.
 *
 * DOM 캔버스를 만들지만 시간·난수는 쓰지 않는다 (같은 인자 → 항상 같은 그림).
 */
import type { MainJob, TeamSide } from '../../core/types';
import { MAIN_JOBS } from '../../core/types';
import { ICON_BG_COLOR, ICON_BORDER_COLOR, ICON_FG_COLOR } from './palette';
import { createCanvas, ctx2d } from './terrain';
import { loadArtImage } from './imageAssets';

/** 마스크 격자 한 변 */
export const ICON_MASK_SIZE = 16;

/** 목적지 픽셀이 덮는 원본 칸 중 이 비율 이상이 칠해져 있으면 칠한다 (축소 시 판정) */
const COVERAGE_MIN = 0.38;

/** 캐시 상한 (직업 9 × 크기 몇 종 × 진영 2 정도라 넉넉하다) */
const CACHE_MAX = 192;

/**
 * 직업별 16×16 마스크.
 * 검사=검, 탱커=방패, 버서커=양손도끼, 암살자=단검 2개, 궁수=활, 저격수=장총(조준경),
 * 마법사=지팡이+별, 소환사=소환서(책), 힐러=십자가.
 */
export const JOB_ICON_MASK: Record<MainJob, readonly string[]> = {
  // 검: 위로 뻗은 날 + 가로 가드 + 자루·손잡이
  swordsman: [
    '................',
    '.......##.......',
    '......####......',
    '......####......',
    '......####......',
    '......####......',
    '......####......',
    '......####......',
    '....########....',
    '....########....',
    '......####......',
    '......####......',
    '......####......',
    '.....######.....',
    '.....######.....',
    '................',
  ],
  // 방패: 위는 넓고 아래로 갈수록 뾰족
  tank: [
    '................',
    '..############..',
    '..############..',
    '..############..',
    '..############..',
    '..############..',
    '..############..',
    '..############..',
    '...##########...',
    '...##########...',
    '....########....',
    '.....######.....',
    '......####......',
    '.......##.......',
    '................',
    '................',
  ],
  // 양손도끼: 넓은 양날 머리 + 긴 자루
  berserker: [
    '................',
    '.......##.......',
    '..############..',
    '..############..',
    '..############..',
    '..############..',
    '...##########...',
    '.....######.....',
    '.......##.......',
    '.......##.......',
    '.......##.......',
    '.......##.......',
    '.......##.......',
    '.......##.......',
    '.......##.......',
    '................',
  ],
  // 단검 2개 (하나는 위로, 하나는 아래로. 각각 가드가 있다).
  // 가드는 세로 2칸(짝수 행 쌍 6·7 / 8·9)이다 — 1칸이면 10px 로 줄일 때 칼날에서 떨어진 외톨이 1px 점이 된다.
  assassin: [
    '................',
    '..###...........',
    '..###......###..',
    '..###......###..',
    '..###......###..',
    '..###......###..',
    '..###.....#####.',
    '..###.....#####.',
    '.#####.....###..',
    '.#####.....###..',
    '..###......###..',
    '..###......###..',
    '..###......###..',
    '..###......###..',
    '...........###..',
    '................',
  ],
  // 활 + 시위에 걸린 화살
  archer: [
    '................',
    '....####........',
    '..#####.........',
    '..###...........',
    '.###............',
    '.###............',
    '.###.........##.',
    '.###..#########.',
    '.###..#########.',
    '.###.........##.',
    '..###...........',
    '..#####.........',
    '....####........',
    '................',
    '................',
    '................',
  ],
  // 장총: 위에 조준경, 가로로 긴 총열, 뒤(왼쪽 아래)에 개머리판 — 유일하게 '가로로 긴' 실루엣
  sniper: [
    '................',
    '................',
    '................',
    '.....######.....',
    '.....######.....',
    '.......##.......',
    '..############..',
    '..############..',
    '..############..',
    '.#####..........',
    '.#####..........',
    '.#####..........',
    '..####..........',
    '................',
    '................',
    '................',
  ],
  // 별(4각 별 보석) — 유일하게 '마름모' 실루엣
  mage: [
    '................',
    '................',
    '.......##.......',
    '......####......',
    '.....######.....',
    '....########....',
    '.##############.',
    '.##############.',
    '.##############.',
    '.##############.',
    '....########....',
    '.....######.....',
    '......####......',
    '.......##.......',
    '................',
    '................',
  ],
  // 소환서(펼친 책): 가운데 책등이 갈라져 있다
  summoner: [
    '................',
    '................',
    '..############..',
    '.##############.',
    '.#####....#####.',
    '.#####....#####.',
    '.#####....#####.',
    '.#####....#####.',
    '.#####....#####.',
    '.#####....#####.',
    '.##############.',
    '..############..',
    '................',
    '................',
    '................',
    '................',
  ],
  // 십자가
  healer: [
    '................',
    '......####......',
    '......####......',
    '......####......',
    '..############..',
    '..############..',
    '..############..',
    '......####......',
    '......####......',
    '......####......',
    '......####......',
    '......####......',
    '................',
    '................',
    '................',
    '................',
  ],
};

/** 16×16 불리언 배열로 펼친 마스크 (문자열 파싱은 직업당 1회) */
const FLAT_MASKS = new Map<MainJob, Uint8Array>();

function flatMask(job: MainJob): Uint8Array {
  const hit = FLAT_MASKS.get(job);
  if (hit) return hit;
  const rows = JOB_ICON_MASK[job];
  const out = new Uint8Array(ICON_MASK_SIZE * ICON_MASK_SIZE);
  for (let y = 0; y < ICON_MASK_SIZE; y++) {
    const row = rows[y] ?? '';
    for (let x = 0; x < ICON_MASK_SIZE; x++) {
      out[y * ICON_MASK_SIZE + x] = row.charAt(x) === '#' ? 1 : 0;
    }
  }
  FLAT_MASKS.set(job, out);
  return out;
}

/**
 * 16×16 마스크를 n×n 격자로 다시 뽑는다 (n > 16 이면 확대, 작으면 축소).
 * 목적지 칸이 덮는 원본 칸들의 채움 비율이 COVERAGE_MIN 이상이면 칠한다.
 * 결과가 완전히 비면(아주 작은 n) 한 칸이라도 걸치면 칠하는 규칙으로 되돌린다.
 */
export function sampleJobMask(job: MainJob, n: number): Uint8Array {
  const size = Math.max(1, Math.floor(n));
  const src = flatMask(job);
  const out = new Uint8Array(size * size);
  let any = false;
  for (let dy = 0; dy < size; dy++) {
    const sy0 = (dy * ICON_MASK_SIZE) / size;
    const sy1 = ((dy + 1) * ICON_MASK_SIZE) / size;
    for (let dx = 0; dx < size; dx++) {
      const sx0 = (dx * ICON_MASK_SIZE) / size;
      const sx1 = ((dx + 1) * ICON_MASK_SIZE) / size;
      let covered = 0;
      let total = 0;
      for (let sy = Math.floor(sy0); sy < Math.min(ICON_MASK_SIZE, Math.ceil(sy1)); sy++) {
        const hy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        if (hy <= 0) continue;
        for (let sx = Math.floor(sx0); sx < Math.min(ICON_MASK_SIZE, Math.ceil(sx1)); sx++) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          if (wx <= 0) continue;
          const area = hy * wx;
          total += area;
          if (src[sy * ICON_MASK_SIZE + sx]) covered += area;
        }
      }
      const on = total > 0 && covered / total >= COVERAGE_MIN;
      if (on) any = true;
      out[dy * size + dx] = on ? 1 : 0;
    }
  }
  if (any) return out;
  // 안전망: 너무 작아 아무것도 남지 않으면 '한 칸이라도 걸치면 칠함'
  for (let dy = 0; dy < size; dy++) {
    const sy0 = Math.floor((dy * ICON_MASK_SIZE) / size);
    const sy1 = Math.max(sy0 + 1, Math.ceil(((dy + 1) * ICON_MASK_SIZE) / size));
    for (let dx = 0; dx < size; dx++) {
      const sx0 = Math.floor((dx * ICON_MASK_SIZE) / size);
      const sx1 = Math.max(sx0 + 1, Math.ceil(((dx + 1) * ICON_MASK_SIZE) / size));
      let on = 0;
      for (let sy = sy0; sy < Math.min(ICON_MASK_SIZE, sy1) && !on; sy++) {
        for (let sx = sx0; sx < Math.min(ICON_MASK_SIZE, sx1); sx++) {
          if (src[sy * ICON_MASK_SIZE + sx]) {
            on = 1;
            break;
          }
        }
      }
      out[dy * size + dx] = on;
    }
  }
  return out;
}

/** 아이콘 테두리 두께 (px). 14px 이상이면 2px */
export function iconBorderPx(size: number): number {
  return size >= 14 ? 2 : 1;
}

// ───────────────────────── 캐시 ─────────────────────────

type IconCanvas = HTMLCanvasElement | OffscreenCanvas;

const ICON_CACHE = new Map<string, IconCanvas>();
const GENERATED_ICONS = new Map<MainJob, HTMLCanvasElement>();
const REQUESTED_ICONS = new Map<MainJob, Promise<boolean>>();

function requestJobArtwork(job: MainJob): Promise<boolean> {
  const pending = REQUESTED_ICONS.get(job);
  if (pending) return pending;
  const p = loadArtImage(`icons/${job}.png`).then((image) => {
    if (!image) return false;
    // Trim transparent padding for legibility in the tiny HP-bar badge.
    const source = createCanvas(image.naturalWidth, image.naturalHeight);
    const sourceCtx = ctx2d(source);
    sourceCtx.drawImage(image, 0, 0);
    const pixels = sourceCtx.getImageData(0, 0, source.width, source.height).data;
    let x0 = source.width, y0 = source.height, x1 = -1, y1 = -1;
    for (let y = 0; y < source.height; y++) {
      for (let x = 0; x < source.width; x++) {
        if (pixels[(y * source.width + x) * 4 + 3] < 128) continue;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y);
        x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
    if (x1 < x0) return false;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const edge = Math.max(w, h);
    const trimmed = createCanvas(128, 128);
    const tw = Math.max(1, Math.round(w / edge * 128));
    const th = Math.max(1, Math.round(h / edge * 128));
    ctx2d(trimmed).drawImage(source, x0, y0, w, h, Math.floor((128 - tw) / 2), Math.floor((128 - th) / 2), tw, th);
    GENERATED_ICONS.set(job, trimmed);
    for (const key of ICON_CACHE.keys()) if (key.startsWith(`${job}|`)) ICON_CACHE.delete(key);
    return true;
  }).catch(() => false);
  REQUESTED_ICONS.set(job, p);
  return p;
}

/**
 * 직업 아이콘 PNG 를 미리 받는다 (첫 실행 프리로드용). 잘라내기·캐시는 그리기 경로와 같은 것을 쓰고,
 * 같은 직업을 여러 번 불러도 요청은 한 번뿐이다. 성공하면 true (없거나 실패하면 false → 폴백 마스크로 그린다).
 */
export function preloadJobIcon(job: MainJob): Promise<boolean> {
  return requestJobArtwork(job);
}

/** Opaque area sampling keeps narrow generated strokes readable at 7–12 px. */
function drawGeneratedGlyph(ctx: CanvasRenderingContext2D, art: HTMLCanvasElement, x: number, y: number, n: number): void {
  const data = ctx2d(art).getImageData(0, 0, art.width, art.height).data;
  for (let dy = 0; dy < n; dy++) {
    const y0 = dy * art.height / n, y1 = (dy + 1) * art.height / n;
    for (let dx = 0; dx < n; dx++) {
      const x0 = dx * art.width / n, x1 = (dx + 1) * art.width / n;
      let area = 0, red = 0, green = 0, blue = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const hy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const at = (sy * art.width + sx) * 4;
          if (data[at + 3] < 128) continue;
          const weight = hy * (Math.min(sx + 1, x1) - Math.max(sx, x0));
          area += weight;
          red += data[at] * weight; green += data[at + 1] * weight; blue += data[at + 2] * weight;
        }
      }
      if (area < (x1 - x0) * (y1 - y0) * 0.24) continue;
      ctx.fillStyle = `rgb(${Math.round(red / area)},${Math.round(green / area)},${Math.round(blue / area)})`;
      ctx.fillRect(x + dx, y + dy, 1, 1);
    }
  }
}

/**
 * 직업 아이콘 캔버스 (size × size). 같은 인자면 캐시된 같은 캔버스를 돌려준다 — 호출자는 내용을 바꾸면 안 된다.
 * fg = 글리프 색, bg = 바탕(= 글리프 외곽선 색), border = 테두리 링 색.
 */
export function jobIconCanvas(job: MainJob, size: number, fg: string, bg: string, border: string): IconCanvas {
  void requestJobArtwork(job);
  const px = Math.max(6, Math.round(size));
  const key = `${job}|${px}|${fg}|${bg}|${border}`;
  const hit = ICON_CACHE.get(key);
  if (hit) return hit;

  const b = Math.min(iconBorderPx(px), Math.max(1, Math.floor((px - 4) / 2)));
  const inner = Math.max(1, px - b * 2);
  const c = createCanvas(px, px);
  const ctx = ctx2d(c);
  ctx.imageSmoothingEnabled = false;

  // 바탕 + 테두리 링
  ctx.fillStyle = border;
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = bg;
  ctx.fillRect(b, b, inner, inner);

  const artwork = GENERATED_ICONS.get(job);
  if (artwork) {
    drawGeneratedGlyph(ctx, artwork, b, b, inner);
  } else {
    // 글리프 (안쪽 상자 기준) + 배경색 1px 외곽선
    const mask = sampleJobMask(job, inner);
    const outline = new Uint8Array(px * px);
    ctx.fillStyle = bg;
    for (let y = 0; y < inner; y++) {
      for (let x = 0; x < inner; x++) {
        if (!mask[y * inner + x]) continue;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const ax = b + x + ox;
            const ay = b + y + oy;
            // 안쪽 상자 밖(= 진영 색 테두리 링)은 건드리지 않는다. 작은 크기로 줄이면 마스크가
            // 가장자리 칸까지 차기 때문에, 캔버스 경계만 자르면 외곽선이 링을 갉아먹는다 (v0.8 수정).
            if (ax < b || ay < b || ax >= px - b || ay >= px - b) continue;
            outline[ay * px + ax] = 1;
          }
        }
      }
    }
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        if (outline[y * px + x]) ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.fillStyle = fg;
    for (let y = 0; y < inner; y++) {
      for (let x = 0; x < inner; x++) {
        if (mask[y * inner + x]) ctx.fillRect(b + x, b + y, 1, 1);
      }
    }
  }

  if (ICON_CACHE.size >= CACHE_MAX) {
    const oldest = ICON_CACHE.keys().next();
    if (!oldest.done) ICON_CACHE.delete(oldest.value);
  }
  ICON_CACHE.set(key, c);
  return c;
}

/**
 * 직업 아이콘을 (x, y) 왼쪽 위 모서리에 size × size 로 그린다. 진영 색은 이 함수가 정한다.
 * 좌표는 정수로 맞춰 픽셀이 흐려지지 않게 한다.
 */
export function drawJobIcon(
  ctx: CanvasRenderingContext2D,
  job: MainJob,
  x: number,
  y: number,
  size: number,
  side: TeamSide,
): void {
  const px = Math.max(6, Math.round(size));
  const c = jobIconCanvas(job, px, ICON_FG_COLOR, ICON_BG_COLOR[side], ICON_BORDER_COLOR[side]);
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(c as CanvasImageSource, Math.round(x), Math.round(y), px, px);
  ctx.imageSmoothingEnabled = prev;
}

/** 직업 아이콘이 있는 직업 목록 (전부). 자체 점검·덤프용 */
export const ICON_JOBS: readonly MainJob[] = MAIN_JOBS;
