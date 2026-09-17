/**
 * 도트 모드 지형 (v0.7). 맵별 픽셀 타일 패턴을 오프스크린 캔버스에 한 번 그려 캐시한다.
 *  - 1 맵 유닛 = PIXELS_PER_UNIT(32) px. 캔버스 크기 = (맵 폭 + 2×여백) × (맵 높이 + 2×여백) 유닛.
 *  - 사방 MAP_MARGIN_UNITS(1.5) 여백은 어두운 프레임. 유닛은 그 안(맵 영역)에만 있다.
 *  - 평원 풀 · 어둠 돌바닥(안개는 렌더러가 매 프레임 시야로 뚫는다) · 사막 모래 · 빙하 얼음.
 *  - 모든 무늬는 좌표 해시(hashNoise)로 결정된다. 난수·시간 없음 → 같은 맵이면 항상 같은 그림.
 * 디더링 패턴(makeDitherPattern)과 해시는 이펙트·영역 그리기도 같이 쓴다.
 */
import type { MapDef, MapType } from '../../core/types';
import { MAP_MARGIN_UNITS } from '../../core/types';
import { PIXELS_PER_UNIT } from './spriteTypes';
import { loadArtImage } from './imageAssets';

/** 프레임(여백) 색. 간단 모드의 FRAME_COLOR 와 같은 톤 */
export const PIXEL_FRAME_COLOR = '#0b0e14';
export const PIXEL_FRAME_LINE = '#2c3547';
export const PIXEL_FRAME_DOT = '#161c28';

/** 타일 한 변 (px). 0.5 유닛 */
const TILE = 16;

/** 결정적 2차원 해시 → 0~1. 정수·실수 좌표 모두 받는다 (표시 전용) */
export function hashNoise(x: number, y: number, salt = 0): number {
  let h = Math.imul(Math.floor(x) | 0, 374761393) ^ Math.imul(Math.floor(y) | 0, 668265263) ^ Math.imul(salt | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 캔버스 생성 (DOM 이 없는 환경에서는 예외) */
export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D 컨텍스트를 만들 수 없습니다.');
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

// ───────────────────────── 디더링 패턴 ─────────────────────────

/** 디더 밀도: 1 = 25%, 2 = 50%(체커), 3 = 75% */
export type DitherDensity = 1 | 2 | 3;

const patternCache = new Map<string, CanvasPattern>();

/**
 * 4×4 타일(2px 점) 디더 패턴. 색·밀도별로 캐시한다. 패턴 원점은 캔버스 원점이라 영역끼리 격자가 맞는다.
 * createPattern 이 null 을 주면(드묾) 호출자가 단색으로 대신한다.
 */
export function makeDitherPattern(ctx: CanvasRenderingContext2D, color: string, density: DitherDensity): CanvasPattern | null {
  const key = `${color}|${density}`;
  const hit = patternCache.get(key);
  if (hit) return hit;
  const tile = createCanvas(4, 4);
  const t = ctx2d(tile);
  t.fillStyle = color;
  if (density === 1) {
    t.fillRect(0, 0, 2, 2);
  } else if (density === 2) {
    t.fillRect(0, 0, 2, 2);
    t.fillRect(2, 2, 2, 2);
  } else {
    t.fillRect(0, 0, 4, 4);
    t.clearRect(2, 0, 2, 2);
  }
  const p = ctx.createPattern(tile, 'repeat');
  if (p) patternCache.set(key, p);
  return p;
}

// ───────────────────────── 지형 ─────────────────────────

export interface TerrainLayer {
  canvas: HTMLCanvasElement;
  /** 전체 캔버스 px 크기 (여백 포함) */
  width: number;
  height: number;
  pxPerUnit: number;
  /** 맵 원점의 캔버스 px 오프셋 (= 여백 × pxPerUnit) */
  originX: number;
  originY: number;
  mapId: MapType;
}

/** 맵 좌표 → 지형 캔버스 px */
export function terrainToPx(layer: TerrainLayer, x: number, y: number): { x: number; y: number } {
  return { x: layer.originX + x * layer.pxPerUnit, y: layer.originY + y * layer.pxPerUnit };
}

/**
 * 맵 정의로 지형 캔버스를 만든다. 전투 시작 시 한 번 (맵이 바뀌면 다시).
 */
export function buildTerrain(map: MapDef, pxPerUnit = PIXELS_PER_UNIT, margin = MAP_MARGIN_UNITS): TerrainLayer {
  const width = Math.round((map.width + margin * 2) * pxPerUnit);
  const height = Math.round((map.height + margin * 2) * pxPerUnit);
  const canvas = createCanvas(width, height);
  const ctx = ctx2d(canvas);
  const ox = Math.round(margin * pxPerUnit);
  const oy = Math.round(margin * pxPerUnit);
  const mw = Math.round(map.width * pxPerUnit);
  const mh = Math.round(map.height * pxPerUnit);

  drawFrame(ctx, width, height, ox, oy, mw, mh);

  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, mw, mh);
  ctx.clip();
  ctx.translate(ox, oy);
  switch (map.id) {
    case 'plains':
      drawPlains(ctx, mw, mh);
      break;
    case 'dark':
      drawDark(ctx, mw, mh, pxPerUnit);
      break;
    case 'desert':
      drawDesert(ctx, mw, mh, pxPerUnit);
      break;
    case 'glacier':
      drawGlacier(ctx, mw, mh, pxPerUnit);
      break;
    default:
      ctx.fillStyle = '#444';
      ctx.fillRect(0, 0, mw, mh);
  }
  // 중앙선: 2px 점선
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  const cxLine = Math.round(mw / 2) - 1;
  for (let y = 0; y < mh; y += 8) ctx.fillRect(cxLine, y, 2, 4);
  ctx.restore();

  // 맵 경계선
  ctx.fillStyle = PIXEL_FRAME_LINE;
  ctx.fillRect(ox - 2, oy - 2, mw + 4, 2);
  ctx.fillRect(ox - 2, oy + mh, mw + 4, 2);
  ctx.fillRect(ox - 2, oy - 2, 2, mh + 4);
  ctx.fillRect(ox + mw, oy - 2, 2, mh + 4);

  // Paint the generated map into this layer once decoded. Existing terrain is
  // immediately available while loading and remains the fallback on failure.
  void loadArtImage(`backgrounds/${map.id}.png`).then((image) => {
    if (!image) return;
    const ratio = Math.max(mw / image.naturalWidth, mh / image.naturalHeight);
    const sw = Math.min(image.naturalWidth, Math.round(mw / ratio));
    const sh = Math.min(image.naturalHeight, Math.round(mh / ratio));
    const sx = Math.floor((image.naturalWidth - sw) / 2);
    const sy = Math.floor((image.naturalHeight - sh) / 2);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, sx, sy, sw, sh, ox, oy, mw, mh);
    ctx.restore();
  });

  return { canvas, width, height, pxPerUnit, originX: ox, originY: oy, mapId: map.id };
}

/** 여백 프레임: 어두운 바탕 + 성긴 점 무늬 + 모서리 장식 */
function drawFrame(ctx: CanvasRenderingContext2D, W: number, H: number, ox: number, oy: number, mw: number, mh: number): void {
  ctx.fillStyle = PIXEL_FRAME_COLOR;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = PIXEL_FRAME_DOT;
  for (let y = 0; y < H; y += 8) {
    for (let x = ((y / 8) % 2) * 4; x < W; x += 8) {
      // 맵 영역 안은 건너뛴다 (어차피 덮이지만 픽셀 수를 아낀다)
      if (x >= ox && x < ox + mw && y >= oy && y < oy + mh) continue;
      ctx.fillRect(x, y, 2, 2);
    }
  }
  // 모서리 ㄱ자 장식
  ctx.fillStyle = PIXEL_FRAME_LINE;
  const L = 10;
  const corners = [
    [ox - 6, oy - 6, 1, 1],
    [ox + mw + 6, oy - 6, -1, 1],
    [ox - 6, oy + mh + 6, 1, -1],
    [ox + mw + 6, oy + mh + 6, -1, -1],
  ];
  for (const [cx, cy, sx, sy] of corners) {
    ctx.fillRect(sx > 0 ? cx : cx - L, sy > 0 ? cy : cy - 2, L, 2);
    ctx.fillRect(sx > 0 ? cx : cx - 2, sy > 0 ? cy : cy - L, 2, L);
  }
}

/** 평원: 풀. 타일별 명도 변화 + 풀 포기 + 드문 꽃 */
function drawPlains(ctx: CanvasRenderingContext2D, mw: number, mh: number): void {
  const base = ['#3b7a3c', '#3f8140', '#377238', '#428845'];
  const tuft = ['#5aa45a', '#4f9750'];
  const flower = ['#ffe36e', '#ffffff', '#ff9ccf'];
  for (let ty = 0; ty * TILE < mh; ty++) {
    for (let tx = 0; tx * TILE < mw; tx++) {
      const n = hashNoise(tx, ty, 11);
      ctx.fillStyle = base[Math.floor(n * base.length) % base.length];
      ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
      const x0 = tx * TILE;
      const y0 = ty * TILE;
      const n2 = hashNoise(tx, ty, 23);
      if (n2 > 0.55) {
        // 풀 포기: 세로 2px 막대 2~3개
        ctx.fillStyle = tuft[n2 > 0.8 ? 0 : 1];
        const bx = x0 + 2 + Math.floor(hashNoise(tx, ty, 31) * 10);
        const by = y0 + 4 + Math.floor(hashNoise(tx, ty, 37) * 8);
        ctx.fillRect(bx, by, 2, 4);
        ctx.fillRect(bx + 4, by - 2, 2, 4);
        if (n2 > 0.9) ctx.fillRect(bx + 2, by - 4, 2, 4);
      }
      const n3 = hashNoise(tx, ty, 41);
      if (n3 > 0.965) {
        ctx.fillStyle = flower[Math.floor(hashNoise(tx, ty, 43) * flower.length) % flower.length];
        const fx = x0 + 4 + Math.floor(hashNoise(tx, ty, 47) * 8);
        const fy = y0 + 4 + Math.floor(hashNoise(tx, ty, 53) * 8);
        ctx.fillRect(fx, fy, 2, 2);
      }
    }
  }
}

/** 어둠: 돌바닥 판석(1유닛) + 어두운 줄눈 + 균열. 안개는 렌더러가 시야로 뚫는다 */
function drawDark(ctx: CanvasRenderingContext2D, mw: number, mh: number, px: number): void {
  const slab = ['#232a3d', '#262e42', '#1f2637', '#293148'];
  const grout = '#141a2a';
  const edge = '#303a52';
  const crack = '#171d2d';
  const S = px; // 판석 한 변 = 1 유닛
  for (let sy = 0; sy * S < mh; sy++) {
    for (let sx = 0; sx * S < mw; sx++) {
      const x0 = sx * S;
      const y0 = sy * S;
      const n = hashNoise(sx, sy, 61);
      ctx.fillStyle = slab[Math.floor(n * slab.length) % slab.length];
      ctx.fillRect(x0, y0, S, S);
      // 줄눈 (오른쪽·아래)
      ctx.fillStyle = grout;
      ctx.fillRect(x0 + S - 2, y0, 2, S);
      ctx.fillRect(x0, y0 + S - 2, S, 2);
      // 위·왼쪽 밝은 모서리
      ctx.fillStyle = edge;
      ctx.fillRect(x0, y0, S - 2, 2);
      ctx.fillRect(x0, y0, 2, S - 2);
      // 균열
      const c = hashNoise(sx, sy, 67);
      if (c > 0.8) {
        ctx.fillStyle = crack;
        let cx = x0 + 6 + Math.floor(hashNoise(sx, sy, 71) * 14);
        let cy = y0 + 4;
        for (let k = 0; k < 8; k++) {
          ctx.fillRect(cx, cy, 2, 2);
          cy += 2;
          cx += hashNoise(sx + k, sy, 73) > 0.5 ? 2 : -2;
        }
      }
    }
  }
  // 흩어진 작은 돌 (밝은 점)
  ctx.fillStyle = '#3b4763';
  for (let i = 0; i < 90; i++) {
    const x = Math.floor(hashNoise(i, 1, 79) * mw / 2) * 2;
    const y = Math.floor(hashNoise(i, 2, 83) * mh / 2) * 2;
    ctx.fillRect(x, y, 2, 2);
  }
}

/** 사막: 모래 타일 + 물결(사구) 줄 + 자갈 */
function drawDesert(ctx: CanvasRenderingContext2D, mw: number, mh: number, px: number): void {
  const sand = ['#d4ad63', '#d9b46c', '#cfa75c', '#dcb873'];
  const duneDark = '#b8903f';
  const duneLight = '#ead08a';
  const pebble = '#a67c3e';
  for (let ty = 0; ty * TILE < mh; ty++) {
    for (let tx = 0; tx * TILE < mw; tx++) {
      const n = hashNoise(tx, ty, 91);
      ctx.fillStyle = sand[Math.floor(n * sand.length) % sand.length];
      ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
      if (hashNoise(tx, ty, 97) > 0.96) {
        ctx.fillStyle = pebble;
        ctx.fillRect(tx * TILE + 6, ty * TILE + 8, 2, 2);
        ctx.fillRect(tx * TILE + 8, ty * TILE + 8, 2, 2);
      }
    }
  }
  // 사구 물결: 4 유닛 간격의 가로 물결선 (2px 점 띠), 아래쪽에 밝은 띠
  const rows = Math.floor(mh / (px * 4));
  for (let i = 0; i <= rows; i++) {
    const baseY = i * px * 4 + px * 2;
    for (let x = 0; x < mw; x += 2) {
      const wave = Math.sin((x / px + i * 3) * 0.6) * px * 0.8;
      const y = Math.round((baseY + wave) / 2) * 2;
      if (hashNoise(x, i, 101) > 0.25) {
        ctx.fillStyle = duneDark;
        ctx.fillRect(x, y, 2, 2);
      }
      if (hashNoise(x, i, 103) > 0.6) {
        ctx.fillStyle = duneLight;
        ctx.fillRect(x, y + 4, 2, 2);
      }
    }
  }
}

/** 빙하: 얼음 타일 + 밝은 얼음 판 + 균열선 + 눈 더미 */
function drawGlacier(ctx: CanvasRenderingContext2D, mw: number, mh: number, px: number): void {
  const ice = ['#b4dcee', '#bde2f2', '#aad6ea', '#c6e8f5'];
  const shine = '#e6f6fc';
  const crack = '#7fb6d2';
  const snow = '#ffffff';
  for (let ty = 0; ty * TILE < mh; ty++) {
    for (let tx = 0; tx * TILE < mw; tx++) {
      const n = hashNoise(tx, ty, 113);
      ctx.fillStyle = ice[Math.floor(n * ice.length) % ice.length];
      ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
      const s = hashNoise(tx, ty, 127);
      if (s > 0.86) {
        // 반짝임: 대각선 2칸
        ctx.fillStyle = shine;
        ctx.fillRect(tx * TILE + 4, ty * TILE + 6, 2, 2);
        ctx.fillRect(tx * TILE + 6, ty * TILE + 4, 2, 2);
      }
      if (s < 0.06) {
        // 눈 더미 3×2
        ctx.fillStyle = snow;
        ctx.fillRect(tx * TILE + 4, ty * TILE + 8, 6, 2);
        ctx.fillRect(tx * TILE + 6, ty * TILE + 6, 2, 2);
      }
    }
  }
  // 균열선: 위에서 아래로 비스듬히 (2px 계단)
  ctx.fillStyle = crack;
  for (let i = 0; i < 7; i++) {
    let x = ((i * 5 + 2) % (mw / px)) * px;
    const dir = i % 2 === 0 ? 1 : -1;
    for (let y = 0; y < mh; y += 2) {
      ctx.fillRect(Math.round(x / 2) * 2, y, 2, 2);
      const step = hashNoise(i, y, 131);
      if (step > 0.6) x += dir * 2;
      else if (step < 0.08) x -= dir * 2;
    }
  }
}
