/**
 * 코드 생성 임시 스킬 이펙트 (v0.9 설계 [4]).
 *
 * 외부 에셋(public/effects/<key>.png)이 없을 때 쓰는 `FX_KEYS` 전부의 이펙트 시트를 결정론적으로 만든다.
 * (장판 테두리 키는 SKILLS·HAZARDS 의 (계열, 반경) 조합에서 자동으로 나오므로 개수는 고정이 아니다.
 *  현재 목록·개수는 `npm run effects:list` 로 확인한다.)
 *   - 난수·시간 함수를 쓰지 않는다. 같은 키는 항상 같은 그림 (해시 noise() 만 사용).
 *   - 시트 규격은 fxTypes.ts 의 FX_DEFAULT_META 와 같다: 한 줄(1행), 열 = 프레임.
 *   - 폭발은 중심 섬광 → 파편 확산 → 잔광 소멸의 3단, 투사체는 머리+꼬리,
 *     베기는 호를 그리는 칼자국, 장판 내부 타일(zone_fill)은 좌우·상하 이음매가 이어지도록 wrap 으로만 그리고,
 *     장판 테두리(zone_ring_<school>_r**)는 **그 반경의 실제 크기 그대로** 원 하나를 그린다
 *     (늘리지도 이어 붙이지도 않는다. 반경이 커지면 선이 길어질 뿐 굵기는 1~2 px 로 같다).
 *
 * 구조 (DOM 분리)
 *   buildFxFrameBuffer(key, f) / buildFxSheetBuffer(key) → PixelBuffer  ... 캔버스 없이 node 에서 호출 가능
 *   getFxSheet(key)                                     → FxSheet      ... 위 버퍼를 캔버스에 올린 것 (캐시)
 */
import type { FxKey, FxSchool, FxSheet, FxZoneSchool } from './fxTypes';
import { FX_KEYS, fxDefaultMeta, fxKeyKind, isFxTileKey, parseRingFxKey } from './fxTypes';
import { PixelBuffer, bufferToCanvas } from '../sprites';
import { BLIZZARD_COLORS, MAGIC_SCHOOL_COLOR, WHITE, hexToRgb, type SchoolPalette } from '../palette';

const TAU = Math.PI * 2;
const RAD = Math.PI / 180;

// ───────────────────────── 결정론 해시 ─────────────────────────

/** 정수 3개 → 0~1. 난수가 아니라 좌표 해시다 (같은 입력 = 항상 같은 값) */
function noise(a: number, b: number, c: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1442695041)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

// ───────────────────────── 프레임 툴킷 ─────────────────────────

/**
 * 프레임 경계를 넘는 픽셀을 어떻게 다룰지.
 *  'none' 잘라낸다 / 'xy' 좌우·상하 모두 반대편으로 돌린다 (이음매 없는 타일)
 */
export type FxWrap = 'none' | 'xy';

/**
 * 프레임 하나에 그리는 픽셀 툴킷. 좌표는 프레임 기준.
 * wrap 이 'xy' 면 경계를 넘는 픽셀이 반대편으로 돌아온다 (이음매가 구조적으로 이어진다).
 */
class FxG {
  constructor(
    readonly buf: PixelBuffer,
    readonly ox: number,
    readonly oy: number,
    readonly w: number,
    readonly h: number,
    readonly wrap: FxWrap = 'none',
  ) {}

  px(x: number, y: number, c: string, a = 255): void {
    let xi = Math.round(x);
    let yi = Math.round(y);
    if (this.wrap === 'xy') {
      xi = ((xi % this.w) + this.w) % this.w;
      yi = ((yi % this.h) + this.h) % this.h;
    } else {
      if (xi < 0 || xi >= this.w) return;
      if (yi < 0 || yi >= this.h) return;
    }
    const [r, g, b] = hexToRgb(c);
    this.buf.set(this.ox + xi, this.oy + yi, r, g, b, a);
  }

  rect(x: number, y: number, w: number, h: number, c: string, a = 255): void {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    const ww = Math.round(w);
    const hh = Math.round(h);
    for (let yy = 0; yy < hh; yy++) for (let xx = 0; xx < ww; xx++) this.px(x0 + xx, y0 + yy, c, a);
  }

  hline(x0: number, x1: number, y: number, c: string, a = 255): void {
    const a0 = Math.min(Math.round(x0), Math.round(x1));
    const a1 = Math.max(Math.round(x0), Math.round(x1));
    for (let x = a0; x <= a1; x++) this.px(x, y, c, a);
  }

  vline(x: number, y0: number, y1: number, c: string, a = 255): void {
    const a0 = Math.min(Math.round(y0), Math.round(y1));
    const a1 = Math.max(Math.round(y0), Math.round(y1));
    for (let y = a0; y <= a1; y++) this.px(x, y, c, a);
  }

  /** 브레젠험 선. w > 1 이면 w×w 브러시 */
  line(x0: number, y0: number, x1: number, y1: number, c: string, w = 1, a = 255): void {
    let xa = Math.round(x0);
    let ya = Math.round(y0);
    const xb = Math.round(x1);
    const yb = Math.round(y1);
    const dx = Math.abs(xb - xa);
    const dy = -Math.abs(yb - ya);
    const sx = xa < xb ? 1 : -1;
    const sy = ya < yb ? 1 : -1;
    let err = dx + dy;
    const off = Math.floor(w / 2);
    for (let guard = 0; guard < 512; guard++) {
      if (w <= 1) this.px(xa, ya, c, a);
      else for (let yy = 0; yy < w; yy++) for (let xx = 0; xx < w; xx++) this.px(xa - off + xx, ya - off + yy, c, a);
      if (xa === xb && ya === yb) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        xa += sx;
      }
      if (e2 <= dx) {
        err += dx;
        ya += sy;
      }
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, c: string, a = 255): void {
    if (rx <= 0 || ry <= 0) return;
    const ex = Math.ceil(rx);
    const ey = Math.ceil(ry);
    for (let yy = -ey; yy <= ey; yy++) {
      for (let xx = -ex; xx <= ex; xx++) {
        if ((xx * xx) / (rx * rx) + (yy * yy) / (ry * ry) <= 1.08) this.px(cx + xx, cy + yy, c, a);
      }
    }
  }

  disc(cx: number, cy: number, r: number, c: string, a = 255): void {
    this.ellipse(cx, cy, r, r, c, a);
  }

  /** 타원 테두리. thick 는 픽셀 두께 */
  ringE(cx: number, cy: number, rx: number, ry: number, thick: number, c: string, a = 255): void {
    if (rx <= 0 || ry <= 0) return;
    const m = Math.min(rx, ry);
    const ex = Math.ceil(rx) + thick + 1;
    const ey = Math.ceil(ry) + thick + 1;
    for (let yy = -ey; yy <= ey; yy++) {
      for (let xx = -ex; xx <= ex; xx++) {
        const d = Math.sqrt((xx * xx) / (rx * rx) + (yy * yy) / (ry * ry));
        if (Math.abs((d - 1) * m) <= thick / 2) this.px(cx + xx, cy + yy, c, a);
      }
    }
  }

  ring(cx: number, cy: number, r: number, thick: number, c: string, a = 255): void {
    this.ringE(cx, cy, r, r, thick, c, a);
  }

  /**
   * 점선 타원 테두리. dashes = 한 바퀴의 점선 개수, phase = 회전(0~1), duty = 칠해지는 비율.
   * 점선이 도는 느낌을 내는 데 쓴다.
   */
  ringDash(
    cx: number, cy: number, rx: number, ry: number, thick: number,
    c: string, dashes: number, phase: number, duty = 0.55, a = 255,
  ): void {
    if (rx <= 0 || ry <= 0) return;
    const m = Math.min(rx, ry);
    const ex = Math.ceil(rx) + thick + 1;
    const ey = Math.ceil(ry) + thick + 1;
    for (let yy = -ey; yy <= ey; yy++) {
      for (let xx = -ex; xx <= ex; xx++) {
        const d = Math.sqrt((xx * xx) / (rx * rx) + (yy * yy) / (ry * ry));
        if (Math.abs((d - 1) * m) > thick / 2) continue;
        const ang = Math.atan2(yy / ry, xx / rx);
        const t = ((ang / TAU) + 1) * dashes + phase * dashes;
        if (t - Math.floor(t) < duty) this.px(cx + xx, cy + yy, c, a);
      }
    }
  }

  /**
   * 점선 원. **원주만** 훑으므로 반경이 커져도 찍는 픽셀 수가 원주에 비례할 뿐이다 (큰 프레임에서도 빠르다).
   * dashes = 한 바퀴의 점선 칸 수, phase = 회전(1 = 점선 한 칸), duty = 한 칸에서 칠해지는 비율,
   * thick = 안쪽으로 겹치는 두께(px). 각도 간격이 1 px 보다 촘촘해 선이 끊기지 않는다.
   */
  dashCircle(
    cx: number, cy: number, r: number, thick: number,
    c: string, dashes: number, phase: number, duty = 0.6, a = 255,
  ): void {
    if (!(r >= 1) || !(dashes >= 1) || thick < 1) return;
    const steps = Math.max(24, Math.round(TAU * r * 1.5));
    for (let s = 0; s < steps; s++) {
      const u = s / steps;
      const t = u * dashes + phase;
      if (t - Math.floor(t) >= duty) continue;
      const ang = u * TAU;
      const ct = Math.cos(ang);
      const st = Math.sin(ang);
      for (let k = 0; k < thick; k++) this.px(cx + ct * (r - k), cy + st * (r - k), c, a);
    }
  }

  /** 호(arc). 각도는 도(度), 0 = 오른쪽, 음수 = 위 */
  arc(cx: number, cy: number, r: number, thick: number, a0Deg: number, a1Deg: number, c: string, a = 255): void {
    const a0 = a0Deg * RAD;
    const a1 = a1Deg * RAD;
    const n = Math.max(3, Math.ceil((Math.abs(a1 - a0) * Math.max(1, r)) / 0.7));
    const off = (thick - 1) / 2;
    for (let i = 0; i <= n; i++) {
      const t = a0 + (a1 - a0) * (i / n);
      const ct = Math.cos(t);
      const st = Math.sin(t);
      for (let k = 0; k < thick; k++) {
        const rr = r - off + k;
        this.px(cx + ct * rr, cy + st * rr, c, a);
      }
    }
  }

  /** 마름모 (얼음 조각·별의 기본형) */
  diamond(cx: number, cy: number, r: number, c: string, a = 255): void {
    const er = Math.ceil(r);
    for (let yy = -er; yy <= er; yy++) {
      for (let xx = -er; xx <= er; xx++) {
        if (Math.abs(xx) + Math.abs(yy) <= r) this.px(cx + xx, cy + yy, c, a);
      }
    }
  }

  /** 십자 */
  plus(cx: number, cy: number, r: number, c: string, a = 255): void {
    this.hline(cx - r, cx + r, cy, c, a);
    this.vline(cx, cy - r, cy + r, c, a);
  }

  /** 4방향 별 (긴 축 r, 짧은 대각 r/2) */
  star4(cx: number, cy: number, r: number, c: string, a = 255): void {
    this.plus(cx, cy, r, c, a);
    const d = Math.max(1, Math.round(r * 0.4));
    for (let i = 1; i <= d; i++) {
      this.px(cx + i, cy + i, c, a);
      this.px(cx - i, cy + i, c, a);
      this.px(cx + i, cy - i, c, a);
      this.px(cx - i, cy - i, c, a);
    }
  }

  /** 지그재그 번개 선 */
  zig(x0: number, y0: number, x1: number, y1: number, amp: number, segs: number, c: string, seed: number, w = 1): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    let px = x0;
    let py = y0;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const side = i % 2 === 0 ? 1 : -1;
      const off = i === segs ? 0 : side * amp * (0.5 + noise(i, seed, 5));
      const qx = x0 + dx * t + nx * off;
      const qy = y0 + dy * t + ny * off;
      this.line(px, py, qx, qy, c, w);
      px = qx;
      py = qy;
    }
  }

  /** 다른 버퍼의 불투명 픽셀을 디더로 솎아 얹는다 (잔광이 스러지는 3단 연출) */
  blitDither(src: PixelBuffer, keep: number, seed: number): void {
    for (let y = 0; y < Math.min(this.h, src.h); y++) {
      for (let x = 0; x < Math.min(this.w, src.w); x++) {
        const i = (y * src.w + x) * 4;
        const a = src.data[i + 3];
        if (a === 0) continue;
        if (keep < 1 && noise(x, y, seed) > keep) continue;
        this.buf.set(this.ox + x, this.oy + y, src.data[i], src.data[i + 1], src.data[i + 2], a);
      }
    }
  }

  /** 체커 디더로 채운 원 (부드러운 잔광을 픽셀답게) */
  ditherDisc(cx: number, cy: number, r0: number, r1: number, c: string, density: number, seed: number, a = 255): void {
    const er = Math.ceil(r1);
    for (let yy = -er; yy <= er; yy++) {
      for (let xx = -er; xx <= er; xx++) {
        const d = Math.hypot(xx, yy);
        if (d < r0 || d > r1) continue;
        if (noise(Math.round(cx) + xx, Math.round(cy) + yy, seed) > density) continue;
        this.px(cx + xx, cy + yy, c, a);
      }
    }
  }
}

// ───────────────────────── 계열 색·모티프 ─────────────────────────

function schoolPal(school: FxSchool): SchoolPalette {
  return MAGIC_SCHOOL_COLOR[school === 'phys' ? 'none' : school];
}

function zonePal(school: FxZoneSchool): SchoolPalette {
  if (school === 'neutral') return { core: BLIZZARD_COLORS[0], main: BLIZZARD_COLORS[2], dark: BLIZZARD_COLORS[3] };
  return schoolPal(school);
}

/** 프레임 진행(0~1) → 색 단계: 밝음 → 주색 → 어두움 */
function toneAt(pal: SchoolPalette, t: number): string {
  if (t < 0.34) return pal.core;
  if (t < 0.7) return pal.main;
  return pal.dark;
}

/**
 * 계열별 파편 한 조각. 형태가 계열마다 다르다.
 *  fire 둥근 불덩이 / ice 마름모 결정 / lightning 짧은 지그재그 / holy 십자 빛
 *  nature 잎사귀 / shadow 너덜한 덩어리 / phys 네모난 파편
 */
function schoolMote(g: FxG, school: FxSchool, x: number, y: number, size: number, c: string, seed: number): void {
  const s = Math.max(1, Math.round(size));
  switch (school) {
    case 'fire':
      g.disc(x, y, s, c);
      if (s >= 2) g.px(x, y - s, c);
      break;
    case 'ice':
      g.diamond(x, y, s + 0.5, c);
      break;
    case 'lightning':
      g.zig(x - s - 1, y - s, x + s + 1, y + s, 1.5, 3, c, seed);
      break;
    case 'holy':
      g.plus(x, y, s, c);
      break;
    case 'nature':
      g.ellipse(x, y, s + 0.6, s * 0.7 + 0.4, c);
      break;
    case 'shadow':
      g.disc(x, y, s, c);
      g.px(x + s, y - 1, c);
      g.px(x - s - 1, y + 1, c);
      break;
    default:
      g.rect(x - s + 1, y - s + 1, s, s, c);
      break;
  }
}

// ───────────────────────── A. 피격 폭발 ─────────────────────────

const IMPACT_R = [8, 15, 21, 25, 28, 30];
const IMPACT_FLASH = [8, 11, 6, 3, 0, 0];
const IMPACT_MOTES = [9, 14, 14, 12, 9, 6];

/** 계열 고유 뼈대 (섬광 위에 겹치는 큰 형태) */
function impactSkeleton(g: FxG, school: FxSchool, f: number, r: number, pal: SchoolPalette): void {
  const C = 32;
  const t = f / 5;
  const tone = toneAt(pal, t);
  switch (school) {
    case 'fire': {
      // 위로 솟는 불기둥 3갈래
      const hgt = [6, 16, 22, 20, 14, 8][f];
      for (let i = -1; i <= 1; i++) {
        const x = C + i * 9;
        const hh = hgt - Math.abs(i) * 5;
        if (hh <= 1) continue;
        for (let k = 0; k < hh; k++) {
          const wdt = Math.max(0, Math.round((1 - k / hh) * (4 - Math.abs(i))));
          g.hline(x - wdt, x + wdt, C - 4 - k, k < hh * 0.4 ? tone : pal.dark);
        }
      }
      break;
    }
    case 'ice': {
      // 6방향 결정 스파이크
      for (let i = 0; i < 6; i++) {
        const ang = i * 60 * RAD + (f % 2) * 0.12;
        const ex = C + Math.cos(ang) * r;
        const ey = C + Math.sin(ang) * r;
        g.line(C, C, ex, ey, tone, f < 3 ? 2 : 1);
        g.diamond(ex, ey, 2.5 - f * 0.3, pal.core);
      }
      break;
    }
    case 'lightning': {
      // 4갈래 번개
      for (let i = 0; i < 4; i++) {
        const ang = (i * 90 + 18 + f * 7) * RAD;
        g.zig(C, C, C + Math.cos(ang) * r, C + Math.sin(ang) * r, 4, 4, tone, i * 7 + f, f < 3 ? 2 : 1);
      }
      break;
    }
    case 'holy': {
      // 빛기둥 + 수평 후광
      const wdt = [10, 8, 6, 4, 3, 2][f];
      g.rect(C - wdt / 2, C - r, wdt, r * 2, tone);
      g.rect(C - wdt / 2 + 1, C - r + 2, Math.max(1, wdt - 2), r * 2 - 4, pal.core);
      g.ringE(C, C, r, Math.max(2, r * 0.32), 2, tone);
      break;
    }
    case 'nature': {
      // 퍼지는 포자 고리 + 안쪽 소용돌이
      g.ringDash(C, C, r * 0.8, r * 0.8, 2, tone, 10, f * 0.12, 0.5);
      for (let i = 0; i < 3; i++) {
        const a0 = (i * 120 + f * 24) * RAD;
        g.arc(C, C, r * 0.5, 1, (a0 / RAD), a0 / RAD + 70, pal.core);
      }
      break;
    }
    case 'shadow': {
      // 어두운 심연 + 촉수 (심연은 뒤 프레임에서 오므라든다)
      const core = Math.max(2, r * 0.5 * (f <= 2 ? 1 : 1 - (f - 2) * 0.22));
      g.disc(C, C, core, pal.dark);
      for (let i = 0; i < 5; i++) {
        const a0 = i * 72 + f * 11;
        const ex = C + Math.cos(a0 * RAD) * r;
        const ey = C + Math.sin(a0 * RAD) * r;
        g.zig(C, C, ex, ey, 3, 3, i % 2 === 0 ? pal.main : pal.dark, i + f);
      }
      g.ring(C, C, core, 1, pal.core);
      break;
    }
    default: {
      // phys: 십자 충격파 + 먼지
      const k = Math.max(1, 4 - f);
      g.rect(C - r, C - k / 2, r * 2, k, tone);
      g.rect(C - k / 2, C - r, k, r * 2, tone);
      g.ringDash(C, C, r, r * 0.7, 2, pal.dark, 12, f * 0.1, 0.45);
      break;
    }
  }
}

function drawImpact(g: FxG, school: FxSchool, f: number): void {
  const C = 32;
  const pal = schoolPal(school);
  const r = IMPACT_R[f] ?? 30;
  const flash = IMPACT_FLASH[f] ?? 0;
  const t = f / 5;
  const tone = toneAt(pal, t);

  // 1단 중심 섬광 + 사방으로 뻗는 빛살 (둥근 공으로 보이지 않게)
  if (flash > 0) {
    g.disc(C, C, flash, pal.main);
    g.disc(C, C, Math.max(1, flash - 3), pal.core);
    if (f === 0) g.disc(C, C, Math.max(1, flash - 6), WHITE);
    g.ditherDisc(C, C, flash, flash + 4, pal.main, 0.45, 5 + f);
  }
  if (f <= 1) {
    for (let i = 0; i < 8; i++) {
      const a = (i * 45 + f * 12) * RAD;
      const d0 = flash * 0.7;
      const d1 = r * (i % 2 === 0 ? 1.28 : 0.95);
      g.line(C + Math.cos(a) * d0, C + Math.sin(a) * d0, C + Math.cos(a) * d1, C + Math.sin(a) * d1, pal.core, i % 2 === 0 ? 2 : 1);
    }
  }

  // 계열 뼈대 (뒤쪽 프레임일수록 디더로 스러진다 = 3단 잔광 소멸)
  const keep = [1, 1, 1, 0.66, 0.42, 0.24][f] ?? 1;
  if (keep >= 1) {
    impactSkeleton(g, school, f, r, pal);
  } else {
    const tmp = new PixelBuffer(g.w, g.h);
    impactSkeleton(new FxG(tmp, 0, 0, g.w, g.h), school, f, r, pal);
    g.blitDither(tmp, keep, 7 + f * 5);
  }

  // 2단 파편 확산
  const count = IMPACT_MOTES[f] ?? 6;
  const drift = school === 'fire' ? -f * 2 : school === 'phys' || school === 'nature' ? f : 0;
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * TAU + (i % 2) * 0.24 + f * 0.06;
    const d = Math.min(29, r * (0.86 + 0.3 * noise(i, 3, 11)));
    const size = Math.max(1, 3.2 - f * 0.45);
    schoolMote(g, school, C + Math.cos(ang) * d, C + Math.sin(ang) * d + drift, size, i % 3 === 0 ? pal.core : tone, i + f);
  }

  // 3단 잔광 소멸 (흩어진 점)
  if (f >= 2) {
    g.ditherDisc(C, C, r * 0.45, r * 1.02, pal.dark, 0.1 + (5 - f) * 0.02, 17 + f * 3);
    if (f >= 4) g.ditherDisc(C, C, r * 0.2, r * 0.6, pal.main, 0.05, 29 + f);
  }
}

// ───────────────────────── B. 투사체 ─────────────────────────

/** 화살: 나무 대 + 금속 촉 + 깃. 오른쪽(+x) 이 진행 방향. 프레임마다 미세하게 흔들린다 */
function drawProjArrow(g: FxG, f: number): void {
  // 비행 중 흔들림: 화살 전체가 1px 위아래로 떨리고 깃이 반대로 펄럭인다
  const cy = 16 + [0, -1, 0, 1][f];
  const flut = [1, 0, -1, 0][f];
  // 대
  g.hline(6, 23, cy, '#8c5a2b');
  g.hline(6, 23, cy + 1, '#5d3a17');
  // 촉 (삼각형)
  for (let i = 0; i <= 6; i++) {
    const half = Math.max(0, 3 - Math.ceil(i / 2));
    g.vline(23 + i, cy - half, cy + half, i < 2 ? '#b8bcc6' : '#e7e9ee');
  }
  g.px(30, cy, WHITE);
  // 깃 (프레임마다 펄럭인다)
  for (let i = 0; i < 4; i++) {
    g.px(6 + i, cy - 1 - i * 0.7 + flut, '#d9d9e2');
    g.px(6 + i, cy + 2 + i * 0.7 - flut, '#a8a8b4');
  }
  // 바람 잔상 (길이가 돈다)
  const streak = [5, 3, 5, 3][f];
  g.hline(6 - streak, 5, cy - 2 + flut, '#7a7a88');
  g.hline(6 - Math.round(streak * 0.6), 5, cy + 3 - flut, '#55555f');
  g.px(2, cy + (f % 2 === 0 ? 1 : -1), '#55555f');
}

/** 탄환: 밝은 머리 + 길이가 변하는 섬광 꼬리 (총구 불꽃이 펄럭이는 느낌) */
function drawProjBullet(g: FxG, f: number): void {
  const cy = 16;
  const tail = [8, 15, 10, 17][f];
  const hr = [3, 4, 3, 4][f];
  const up = [1, 2, 1, 2][f];
  const dn = [2, 1, 2, 1][f];
  g.hline(21 - tail, 20, cy, '#ffb347');
  g.hline(21 - Math.round(tail * 0.7), 20, cy - up, '#ffe94a');
  g.hline(21 - Math.round(tail * 0.5), 20, cy + dn, '#ffe94a');
  g.hline(21 - Math.round(tail * 0.35), 20, cy - up - 1, '#ff9c2a');
  g.disc(22, cy, hr, '#ffe94a');
  g.disc(22, cy, hr - 1.4, WHITE);
  g.px(23 + hr, cy, '#fff8c0');
  // 흩날리는 불티
  for (let i = 0; i < 4; i++) {
    const x = 18 - i * 4 - f * 2;
    const y = cy + (i % 2 === 0 ? -4 : 4) - Math.round(noise(i, f, 3) * 3);
    g.px(x, y, i % 2 === 0 ? '#ffe94a' : '#ff9c2a');
    if (i === f % 4) g.px(x - 1, y, '#fff8c0');
  }
}

/** 마력구: 머리(핵 + 계열 후광) + 꼬리 3덩이 */
function drawProjOrb(g: FxG, school: FxSchool, f: number): void {
  const pal = schoolPal(school);
  const cy = 16;
  const hx = 20;
  const hr = [4, 5, 4.5, 5.5][f];
  // 후광
  g.disc(hx, cy, hr + 1.5, pal.dark);
  g.disc(hx, cy, hr, pal.main);
  g.disc(hx, cy, Math.max(1, hr - 2), pal.core);
  g.px(hx - 1, cy - 1, WHITE);
  // 계열 장식
  switch (school) {
    case 'ice':
      for (let i = 0; i < 4; i++) {
        const a = (i * 90 + f * 22) * RAD;
        g.diamond(hx + Math.cos(a) * (hr + 2), cy + Math.sin(a) * (hr + 2), 1.5, pal.core);
      }
      break;
    case 'lightning':
      for (let i = 0; i < 3; i++) {
        const a = (i * 120 + f * 40) * RAD;
        g.zig(hx, cy, hx + Math.cos(a) * (hr + 5), cy + Math.sin(a) * (hr + 5), 2, 3, pal.main, i + f);
      }
      break;
    case 'holy':
      g.ringDash(hx, cy, hr + 3, hr + 3, 1, pal.main, 8, f * 0.25, 0.5);
      break;
    case 'nature':
      for (let i = 0; i < 3; i++) {
        const a = (i * 120 + f * 30) * RAD;
        g.ellipse(hx + Math.cos(a) * (hr + 2), cy + Math.sin(a) * (hr + 2), 2, 1.2, pal.main);
      }
      break;
    case 'shadow':
      g.ditherDisc(hx, cy, hr, hr + 4, pal.dark, 0.45, 7 + f);
      break;
    default:
      g.ditherDisc(hx, cy, hr, hr + 3, pal.main, 0.35, 5 + f);
      break;
  }
  // 꼬리
  const wob = f % 2 === 0 ? 1 : -1;
  const tailPts: [number, number, number][] = [
    [14, cy + wob, 3],
    [9, cy - wob, 2],
    [5, cy + wob, 1],
  ];
  for (let i = 0; i < tailPts.length; i++) {
    const [tx, ty, tr] = tailPts[i];
    g.disc(tx, ty, tr, i === 0 ? pal.main : pal.dark);
    if (i === 0) g.disc(tx, ty, tr - 1.5, pal.core);
  }
}

// ───────────────────────── C. 시전 ─────────────────────────

function castGlyph(g: FxG, school: FxSchool, cx: number, cy: number, c: string, f: number): void {
  switch (school) {
    case 'fire':
      g.line(cx - 4, cy + 3, cx, cy - 4, c, 1);
      g.line(cx, cy - 4, cx + 4, cy + 3, c, 1);
      g.hline(cx - 4, cx + 4, cy + 3, c);
      break;
    case 'ice':
      g.diamond(cx, cy, 4, c);
      g.diamond(cx, cy, 2, WHITE);
      break;
    case 'lightning':
      g.zig(cx - 1, cy - 5, cx + 1, cy + 5, 3, 3, c, f, 2);
      break;
    case 'holy':
      g.plus(cx, cy, 5, c);
      g.px(cx, cy, WHITE);
      break;
    case 'nature':
      g.ellipse(cx, cy, 4, 2.5, c);
      g.vline(cx, cy - 5, cy + 5, c);
      break;
    case 'shadow':
      g.disc(cx, cy, 4, c);
      g.disc(cx, cy, 2, '#2a1040');
      break;
    default:
      g.rect(cx - 4, cy - 4, 8, 8, c);
      g.rect(cx - 2, cy - 2, 4, 4, '#3a3a44');
      break;
  }
}

/** 시전자 발밑 마법진: 도는 점선 두 겹 + 떠오르는 마력 알갱이 + 계열 문양 */
function drawCast(g: FxG, school: FxSchool, f: number): void {
  const pal = schoolPal(school);
  const cx = 24;
  const cy = 32;
  const phase = f / 4;
  g.ringDash(cx, cy, 20, 9, 2, pal.main, 8, phase, 0.55);
  g.ringDash(cx, cy, 20, 9, 1, pal.core, 8, phase + 0.5 / 8, 0.18);
  g.ringDash(cx, cy, 13, 6, 1, pal.dark, 6, -phase, 0.6);
  // 떠오르는 알갱이
  for (let i = 0; i < 6; i++) {
    const px = cx + (i - 2.5) * 6.4;
    const rise = ((f + i * 1.7) % 4) / 4;
    const py = cy - 2 - rise * 22;
    const c = rise < 0.4 ? pal.core : rise < 0.75 ? pal.main : pal.dark;
    g.px(px, py, c);
    if (i % 2 === 0) {
      g.px(px, py - 1, c);
      g.px(px + 1, py, c);
    }
  }
  // 계열 문양 (진 한가운데, 조금 떠 있다)
  castGlyph(g, school, cx, cy - 10 - (f % 2), pal.core, f);
  // 바닥 빛무리
  g.ditherDisc(cx, cy, 4, 18, pal.dark, 0.14, 13 + f);
}

// ───────────────────────── D. 근접 베기 ─────────────────────────

/** 호를 그리는 칼자국. pivot = 앵커(손 위치) */
function drawSlash(g: FxG, kind: 'light' | 'heavy' | 'pierce', f: number): void {
  const px0 = 16;
  const py0 = 32;
  if (kind === 'pierce') {
    // 찌르기: 앞으로 뻗었다가 날이 얇아진다
    const len = [20, 36, 44, 44][f];
    const thick = [5, 4, 2, 1][f];
    const body = f < 2 ? WHITE : '#cfd6e6';
    g.rect(px0, py0 - thick / 2, len, thick, body);
    if (f < 3) g.rect(px0, py0 - Math.max(1, thick - 2) / 2, len - 2, Math.max(1, thick - 2), WHITE);
    // 창끝 마름모
    g.diamond(px0 + len, py0, 5 - f, f < 3 ? WHITE : '#9fb0cc');
    // 충격선 (찌른 자리를 스치는 바람)
    if (f >= 1) {
      for (const s of [-1, 1]) {
        const y = py0 + s * (4 + f * 2);
        g.hline(px0 + 8 + f * 5, px0 + len - 8, y, '#6f7d99');
      }
    }
    if (f >= 2) {
      g.ditherDisc(px0 + len, py0, 3, 9 + f * 2, '#b9c6dd', 0.25, 21 + f);
    }
    return;
  }
  const heavy = kind === 'heavy';
  const r = heavy ? 31 : 27;
  const a0 = heavy ? -95 : -78;
  const a1 = heavy ? 88 : 72;
  // 칼끝(head)은 위 → 아래로 휘두르고, 꼬리(tail)는 한 박자 늦게 따라온다 (칼자국이 그어졌다 사라진다)
  const head = a0 + (a1 - a0) * ((f + 1) / 4);
  const tail = a0 + (a1 - a0) * Math.max(0, (f - 1.2) / 4);
  const thick = heavy ? [6, 5, 4, 2][f] : [4, 3, 2, 2][f];
  const edge = heavy ? '#fff2c0' : WHITE;
  const trail = heavy ? '#ffb347' : '#9ec2ff';
  // 꼬리 → 머리 순으로 두께가 커지는 칼자국
  const steps = 7;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const s0 = tail + (head - tail) * t;
    const s1 = tail + (head - tail) * ((i + 1) / (steps - 1));
    const th = Math.max(1, Math.round(thick * (0.35 + 0.65 * t)));
    g.arc(px0, py0, r, th, s0, s1, t > 0.55 ? edge : trail);
  }
  // 바깥 잔광 한 겹
  const sweep = head - tail;
  g.arc(px0, py0, r + (heavy ? 4 : 3), 1, tail + sweep * 0.25, head, trail);
  if (heavy) g.arc(px0, py0, r - 7, Math.max(1, thick - 3), tail + sweep * 0.4, head, trail);
  // 머리 끝 섬광
  const hx = px0 + Math.cos(head * RAD) * r;
  const hy = py0 + Math.sin(head * RAD) * r;
  if (f < 3) {
    g.disc(hx, hy, heavy ? 3.5 : 2.5, WHITE);
    g.star4(hx, hy, heavy ? 6 : 4, edge);
  } else {
    g.ditherDisc(hx, hy, 1, 7, trail, 0.3, 9);
  }
}

// ───────────────────────── E. 장판 테두리 / 내부 타일 ─────────────────────────

/**
 * 장판 테두리 — **그 반경의 실제 크기 그대로** 그린 원 하나 (한 변 = 반경 × 2 × 32 px).
 * 늘리지도(배율) 이어 붙이지도(조각 반복) 않는다. 원의 중심은 프레임 중앙(앵커)이고
 * 가장 바깥 고리가 프레임 가장자리에 닿는다 (잘리지 않게 1 px 안쪽).
 *
 *   ┌──────────────┐  ← 프레임 가장자리
 *   │  ╭────────╮  │     바깥 점선 고리 2 px (계열 밝은 색)
 *   │  │╭──────╮│  │     안쪽 점선 고리 1 px (반대 방향으로 돈다)
 *   │  ││  중심 ││  │     안쪽으로 뻗는 짧은 눈금 (4 px, 4개마다 7 px)
 *   │  │╰──────╯│  │
 *   │  ╰────────╯  │
 *   └──────────────┘
 *
 * **선 굵기는 반경과 무관하게 1~2 px 이다.** 점선 한 칸(≈8 px)·눈금 간격(≈16 px)도 픽셀 단위로 고정이라
 * 반경이 커지면 선이 길어질 뿐 밀도는 캐릭터 스프라이트와 같은 1:1 로 유지된다.
 * 프레임마다 점선이 한 칸의 1/4 씩 돌아 4프레임에 정확히 한 칸 = 반복 이음매가 없다.
 */
function drawZoneRing(g: FxG, school: FxZoneSchool, f: number): void {
  const pal = zonePal(school);
  const c = g.w / 2; // 원의 중심 = 프레임 중앙 = 앵커
  const rOut = c - 1; // 가장 바깥 고리 (프레임 가장자리에서 1 px 안쪽)
  if (rOut < 6) return;
  const phase = f / 4; // 4프레임에 점선 한 칸
  const circ = TAU * rOut;

  // 1) 바깥 점선 고리 2 px — 점선 한 칸 ≈ 8 px
  const outerDashes = Math.max(6, Math.round(circ / 8));
  g.dashCircle(c, c, rOut, 1, pal.core, outerDashes, phase, 0.62);
  g.dashCircle(c, c, rOut - 1, 1, pal.main, outerDashes, phase, 0.62);

  // 2) 안쪽 점선 고리 1 px — 반대 방향으로 돌아 테두리가 꼬이며 도는 느낌을 준다
  const rIn = rOut - 4;
  const innerDashes = Math.max(6, Math.round((TAU * rIn) / 12));
  g.dashCircle(c, c, rIn, 1, pal.main, innerDashes, -phase, 0.45);

  // 3) 안쪽으로 뻗는 짧은 눈금 — 간격 ≈16 px. 4개마다 하나는 길고 밝다 (개수를 4의 배수로 두어 이음매가 없다)
  const ticks = Math.max(8, Math.round(circ / 64) * 4);
  for (let i = 0; i < ticks; i++) {
    const ang = ((i + phase) / ticks) * TAU;
    const ct = Math.cos(ang);
    const st = Math.sin(ang);
    const long = i % 4 === 0;
    const len = long ? 7 : 4;
    const col = long ? pal.core : pal.main;
    for (let k = 2; k < 2 + len; k++) g.px(c + ct * (rOut - k), c + st * (rOut - k), col);
  }
}

/**
 * 장판 내부 타일. **모든 픽셀을 wrap 으로 찍어** 좌우·상하 이음매가 항상 이어진다.
 * 무늬 주기는 32 의 약수(8·16)만 쓴다.
 */
function drawZoneFill(g: FxG, school: FxZoneSchool, f: number): void {
  const pal = zonePal(school);
  const shift = f * 2;
  // 1) 대각 줄무늬 (주기 8 → 32 에서 이음매 없음)
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const d = (x + y + shift) % 8;
      if (d < 2) g.px(x, y, pal.dark);
      else if ((x - y + 64 + shift) % 8 === 0) g.px(x, y, pal.dark);
    }
  }
  // 2) 격자 덩어리 4개 (16 간격 → 이음매 없음)
  const bump = [0, 1, 2, 1][f];
  for (let i = 0; i < 4; i++) {
    const bx = (i % 2) * 16 + 8;
    const by = Math.floor(i / 2) * 16 + 8;
    const rr = 3 + (i % 2 === 0 ? bump : 2 - bump);
    switch (school) {
      case 'ice':
      case 'neutral':
        g.diamond(bx, by, rr, pal.main);
        g.diamond(bx, by, rr - 2, pal.core);
        break;
      case 'lightning':
        g.zig(bx - rr, by - rr, bx + rr, by + rr, 2, 3, pal.main, i);
        g.px(bx, by, pal.core);
        break;
      case 'holy':
        g.plus(bx, by, rr, pal.main);
        g.px(bx, by, pal.core);
        break;
      case 'nature':
        g.ellipse(bx, by, rr, rr * 0.6, pal.main);
        g.ellipse(bx, by, rr - 2, rr * 0.6 - 1, pal.core);
        break;
      case 'shadow':
        g.disc(bx, by, rr, pal.dark);
        g.ring(bx, by, rr, 1, pal.main);
        break;
      case 'phys':
        g.rect(bx - rr, by - rr, rr * 2, rr * 2, pal.dark);
        g.rect(bx - rr + 1, by - rr + 1, rr * 2 - 2, rr * 2 - 2, pal.main);
        break;
      default:
        g.disc(bx, by, rr, pal.main);
        g.disc(bx, by, rr - 2, pal.core);
        break;
    }
  }
  // 3) 흐르는 알갱이 (wrap 이동 → 이음매 없음).
  // 이동량은 프레임당 8 px = wrap 폭 32 의 약수라, 마지막 프레임 → 첫 프레임에서도 진행 방향이 유지된다
  // (프레임당 2 px 로 두면 4프레임 뒤 8 ≠ 32 라 루프 이음매에서만 거꾸로 튄다).
  const moteShift = f * 8;
  for (let i = 0; i < 10; i++) {
    const bx = Math.floor(noise(i, 2, 7) * 32) + moteShift;
    const by = Math.floor(noise(i, 5, 7) * 32) + (school === 'fire' ? -moteShift : moteShift);
    g.px(bx, by, i % 3 === 0 ? pal.core : pal.main);
    if (i % 4 === 0) g.px(bx + 1, by, pal.main);
  }
}

// ───────────────────────── F. 상태 ─────────────────────────

function drawStatus(g: FxG, kind: 'stun' | 'burn' | 'freeze' | 'shield', f: number): void {
  const C = 16;
  switch (kind) {
    case 'stun': {
      // 머리 위를 도는 별 3개
      for (let i = 0; i < 3; i++) {
        const a = (i * 120 + f * 30) * RAD;
        const x = C + Math.cos(a) * 10;
        const y = 12 + Math.sin(a) * 4;
        const big = Math.sin(a) > 0;
        g.star4(x, y, big ? 4 : 3, '#ffe94a');
        g.px(x, y, WHITE);
      }
      g.ringDash(C, 12, 10, 4, 1, '#c8a92a', 12, f * 0.25, 0.4);
      break;
    }
    case 'burn': {
      // 흔들리는 불꽃 3갈래 + 떠오르는 불티
      for (let i = -1; i <= 1; i++) {
        const x = C + i * 6 + (f % 2 === 0 ? 1 : -1) * (i === 0 ? 0 : 1);
        const hh = [10, 13, 11, 14][f] - Math.abs(i) * 4;
        for (let k = 0; k < hh; k++) {
          const w = Math.max(0, Math.round((1 - k / hh) * 3));
          g.hline(x - w, x + w, 24 - k, k < hh * 0.45 ? '#ff7a1f' : '#fff1a8');
        }
      }
      for (let i = 0; i < 3; i++) {
        const rise = ((f + i * 1.3) % 4) / 4;
        g.px(C + (i - 1) * 7, 20 - rise * 16, rise < 0.5 ? '#fff1a8' : '#ff7a1f');
      }
      break;
    }
    case 'freeze': {
      // 얼어붙은 결정 고리 + 위아래 고드름
      for (let i = 0; i < 6; i++) {
        const a = i * 60 * RAD;
        const rr = 9 + ((i + f) % 2);
        const x = C + Math.cos(a) * rr;
        const y = C + Math.sin(a) * rr * 0.8;
        g.diamond(x, y, 3 - ((i + f) % 2), '#8fe3ff');
        g.px(x, y, WHITE);
      }
      g.ringDash(C, C, 12, 10, 1, '#3c7fd6', 8, f * 0.125, 0.45);
      const ic = [4, 6, 5, 7][f];
      g.line(C, 4, C, 4 + ic, WHITE, 1);
      g.line(C, 28, C, 28 - ic, WHITE, 1);
      break;
    }
    default: {
      // shield: 육각 방벽 + 도는 광택
      const R = 12;
      const pts: [number, number][] = [];
      for (let i = 0; i < 6; i++) {
        const a = (i * 60 - 90) * RAD;
        pts.push([C + Math.cos(a) * R, C + Math.sin(a) * R]);
      }
      // 광택 두 줄기가 4프레임 동안 육각(6변)을 정확히 한 바퀴 돈다 (+1, +2, +1, +2).
      // 6 을 4 로 나눠 떨어지게 두면 f 와 f+3 이 같은 변 집합이 되어 한 프레임이 멈춰 보인다.
      const lead = [0, 1, 3, 4][f % 4];
      for (let i = 0; i < 6; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % 6];
        const lit = i === lead % 6 || i === (lead + 2) % 6;
        g.line(p[0], p[1], q[0], q[1], lit ? WHITE : '#5fd0ff', lit ? 2 : 1);
      }
      g.ringDash(C, C, R - 4, R - 4, 1, '#3c7fd6', 6, f * 0.16, 0.45);
      g.px(C, C, '#8fe3ff');
      break;
    }
  }
}

// ───────────────────────── G. 기타 ─────────────────────────

const HEAL_GREEN = '#7cf59a';
const HEAL_DARK = '#2f7d32';

function drawHealBurst(g: FxG, f: number): void {
  const C = 24;
  const cross = [4, 8, 10, 7, 4][f];
  const ring = [6, 12, 17, 21, 24][f];
  const tone = f < 2 ? WHITE : f < 4 ? HEAL_GREEN : HEAL_DARK;
  // 퍼지는 고리
  g.ringDash(C, C, ring, ring, f < 3 ? 2 : 1, f < 3 ? HEAL_GREEN : HEAL_DARK, 12, f * 0.15, 0.6);
  // 중심 십자
  if (cross > 0) {
    const w = Math.max(1, 5 - f);
    g.rect(C - cross, C - w / 2, cross * 2, w, tone);
    g.rect(C - w / 2, C - cross, w, cross * 2, tone);
    if (f < 3) {
      g.rect(C - cross + 1, C - 1, cross * 2 - 2, 2, WHITE);
      g.rect(C - 1, C - cross + 1, 2, cross * 2 - 2, WHITE);
    }
  }
  // 떠오르는 반짝임
  for (let i = 0; i < 6; i++) {
    const a = (i * 60 + f * 15) * RAD;
    const d = 8 + f * 3;
    const x = C + Math.cos(a) * d;
    const y = C + Math.sin(a) * d * 0.9 - f * 2;
    g.plus(x, y, f < 3 ? 2 : 1, i % 2 === 0 ? WHITE : HEAL_GREEN);
  }
  if (f >= 2) g.ditherDisc(C, C, 6, ring, HEAL_GREEN, 0.1, 41 + f);
}

function drawBuffRing(g: FxG, f: number): void {
  const C = 24;
  const cy = 36;
  const gold = '#ffd76a';
  const goldDark = '#a87820';
  const phase = f / 4;
  g.ringDash(C, cy, 19, 8, 2, gold, 10, phase, 0.62);
  g.ringDash(C, cy, 19, 8, 1, WHITE, 10, phase + 0.04, 0.22);
  g.ringDash(C, cy, 12, 5, 1, goldDark, 8, -phase, 0.55);
  // 위로 올라가는 쐐기 4개 (프레임마다 높이가 달라진다)
  for (let i = 0; i < 4; i++) {
    const x = C + (i - 1.5) * 11;
    const rise = ((f + i) % 4) / 4;
    const y = cy - 6 - rise * 26;
    const c = rise < 0.5 ? gold : goldDark;
    g.line(x - 5, y + 5, x, y, c, 2);
    g.line(x, y, x + 5, y + 5, c, 2);
    g.px(x, y + 1, WHITE);
  }
  g.ditherDisc(C, cy, 12, 18, goldDark, 0.08, 53 + f);
}

function drawCritStar(g: FxG, f: number): void {
  const C = 16;
  const r = [6, 11, 14, 15][f];
  const c = [WHITE, '#ffe94a', '#ff9c2a', '#ff6a1f'][f];
  if (f < 2) {
    g.star4(C, C, r, c);
    g.disc(C, C, 4 - f, WHITE);
    for (let i = 0; i < 4; i++) {
      const a = (i * 90 + 45) * RAD;
      g.line(C, C, C + Math.cos(a) * r * 0.55, C + Math.sin(a) * r * 0.55, '#ffe94a', 1);
    }
  } else {
    // 부서진 빛살
    for (let i = 0; i < 8; i++) {
      const a = i * 45 * RAD;
      const d0 = r * 0.45 + (f - 2) * 3;
      const d1 = r * (i % 2 === 0 ? 1 : 0.75);
      g.line(C + Math.cos(a) * d0, C + Math.sin(a) * d0, C + Math.cos(a) * d1, C + Math.sin(a) * d1, c, i % 2 === 0 ? 2 : 1);
    }
    g.disc(C, C, f === 2 ? 3 : 1.5, '#ffe94a');
    g.ditherDisc(C, C, r * 0.5, r, c, 0.2, 61 + f);
  }
}

function drawDodgePuff(g: FxG, f: number): void {
  const C = 16;
  const cy = 19;
  const r = [4, 8, 11, 13][f];
  const pale = ['#ffffff', '#e0e0e0', '#b0b0b8', '#8a8a8a'][f];
  // 좌우로 갈라지는 먼지 초승달
  g.arc(C, cy, r, f < 2 ? 3 : 2, 120, 240, pale);
  g.arc(C, cy, r, f < 2 ? 3 : 2, -60, 60, pale);
  // 흩어지는 알갱이
  for (let i = 0; i < 6; i++) {
    const a = (i * 60 + 30) * RAD;
    const d = r + 1 + f;
    g.px(C + Math.cos(a) * d, cy + Math.sin(a) * d * 0.6 - f, i % 2 === 0 ? pale : '#6f6f78');
  }
  // 바닥 그림자 선
  g.hline(C - r, C + r, cy + Math.round(r * 0.55), '#6f6f78');
  if (f >= 1) g.ditherDisc(C, cy, r * 0.4, r, pale, 0.18 - f * 0.03, 71 + f);
}

function drawDeathPoof(g: FxG, f: number): void {
  const C = 32;
  const smoke = ['#8d8fa0', '#5a5a66', '#3a3a44'];
  if (f === 0) {
    // 쓰러진 자리에서 터지는 검은 연기 덩어리
    g.disc(C, 36, 11, '#3a3a44');
    g.disc(C, 36, 6, '#8d8fa0');
    for (let i = 0; i < 8; i++) {
      const a = (i * 45 + 12) * RAD;
      g.line(C + Math.cos(a) * 9, 36 + Math.sin(a) * 9, C + Math.cos(a) * 16, 36 + Math.sin(a) * 16, '#5a5a66', i % 2 === 0 ? 2 : 1);
    }
    g.ditherDisc(C, 36, 11, 18, '#5a5a66', 0.42, 79);
    for (let i = 0; i < 4; i++) g.px(C + (i - 1.5) * 7, 30 - i, '#c9a6ff');
    return;
  }
  const rise = f * 5;
  const puffs: [number, number, number][] = [
    [C - 10, 38 - rise, 7],
    [C + 9, 36 - rise, 6],
    [C, 30 - rise, 9],
    [C - 4, 42 - rise, 5],
    [C + 5, 26 - rise, 5],
  ];
  for (let i = 0; i < puffs.length; i++) {
    const [x, y, r0] = puffs[i];
    const r = Math.max(1, r0 + f - 2 - i);
    const c = smoke[(i + f) % smoke.length];
    if (f <= 2) {
      g.disc(x, y, r, c);
      g.ditherDisc(x, y, r, r + 3, smoke[2], 0.4, 83 + i);
    } else {
      g.ring(x, y, r, 1, c);
      g.ditherDisc(x, y, 0, r, c, 0.35 - (f - 3) * 0.12, 89 + i + f);
    }
  }
  // 흩어지는 영혼 조각
  for (let i = 0; i < 5; i++) {
    const x = C + (i - 2) * 9 + (f % 2 === 0 ? 1 : -1);
    const y = 34 - rise - i * 2;
    g.px(x, y, '#c9a6ff');
    if (i % 2 === 0) g.px(x, y - 1, '#7a3fbf');
  }
}

function drawSummonCircle(g: FxG, f: number): void {
  const C = 32;
  const cy = 40;
  const teal = '#2a9d8f';
  const tealLight = '#9af0e4';
  const arcEnd = [30, 160, 270, 270, 270, 270][f];
  // 바깥 원을 시계 방향으로 그려 나간다 (f 0~1 은 아직 그리는 중)
  if (f <= 1) {
    for (let d = -90; d <= arcEnd; d += 1) {
      const x = C + Math.cos(d * RAD) * 26;
      const y = cy + Math.sin(d * RAD) * 12;
      g.px(x, y, tealLight);
      g.px(x, y + 1, teal);
    }
    const hx = C + Math.cos(arcEnd * RAD) * 26;
    const hy = cy + Math.sin(arcEnd * RAD) * 12;
    g.disc(hx, hy, 2.5, WHITE);
    g.star4(hx, hy, 5, tealLight);
  } else {
    g.ringE(C, cy, 26, 12, 2, tealLight);
    g.ringDash(C, cy, 26, 12, 1, WHITE, 16, f * 0.1, 0.3);
  }
  if (f >= 2) {
    g.ringDash(C, cy, 18, 8, 2, teal, 8, -f * 0.12, 0.55);
  }
  if (f >= 3) {
    // 룬 4개
    for (let i = 0; i < 4; i++) {
      const a = (i * 90 + f * 8) * RAD;
      const x = C + Math.cos(a) * 21;
      const y = cy + Math.sin(a) * 10;
      const c = f >= 4 ? WHITE : tealLight;
      g.diamond(x, y, 3, c);
      g.px(x, y, teal);
    }
  }
  if (f >= 4) {
    // 솟아오르는 빛기둥
    for (let i = 0; i < 3; i++) {
      const x = C + (i - 1) * 11;
      const hh = 12 + (f - 4) * 14 - Math.abs(i) * 5;
      g.rect(x - 1, cy - hh, 2, hh, i % 2 === 0 ? tealLight : teal);
      g.px(x, cy - hh - 1, WHITE);
    }
    g.ditherDisc(C, cy, 2, 24, tealLight, 0.12 + (f - 4) * 0.08, 97 + f);
  }
  if (f === 5) {
    g.ellipse(C, cy, 26, 12, teal, 120);
    g.ringE(C, cy, 30, 14, 1, WHITE);
  }
}

// ───────────────────────── 키 → 드로어 ─────────────────────────

type Drawer = (g: FxG, f: number) => void;

function schoolOfSuffix(key: FxKey, prefix: string): FxSchool {
  const s = key.slice(prefix.length) as FxSchool;
  return s;
}

function zoneSchoolOfSuffix(key: FxKey, prefix: string): FxZoneSchool {
  return key.slice(prefix.length) as FxZoneSchool;
}

/** 알 수 없는 키용 폴백: 계열 없는 작은 섬광 */
function drawFallback(g: FxG, f: number): void {
  const cx = g.w / 2;
  const cy = g.h / 2;
  const r = 3 + f * 3;
  g.ring(cx, cy, r, 2, '#e0e0e0');
  g.disc(cx, cy, Math.max(1, 5 - f), WHITE);
  g.ditherDisc(cx, cy, r, r + 3, '#8a8a8a', 0.3, 101 + f);
}

function drawerFor(key: FxKey): Drawer {
  switch (fxKeyKind(key)) {
    case 'impact': {
      const s = schoolOfSuffix(key, 'impact_');
      return (g, f) => drawImpact(g, s, f);
    }
    case 'proj': {
      if (key === 'proj_arrow') return (g, f) => drawProjArrow(g, f);
      if (key === 'proj_bullet') return (g, f) => drawProjBullet(g, f);
      const s = schoolOfSuffix(key, 'proj_orb_');
      return (g, f) => drawProjOrb(g, s, f);
    }
    case 'cast': {
      const s = schoolOfSuffix(key, 'cast_');
      return (g, f) => drawCast(g, s, f);
    }
    case 'slash': {
      const kind = key === 'slash_heavy' ? 'heavy' : key === 'slash_pierce' ? 'pierce' : 'light';
      return (g, f) => drawSlash(g, kind, f);
    }
    case 'zone_ring': {
      // 키 이름에 계열과 반경이 함께 들어 있다 (zone_ring_fire_r35). 크기는 메타(프레임 크기)가 이미 정해 준다
      const p = parseRingFxKey(key);
      if (!p) return drawFallback;
      const s = p.school;
      return (g, f) => drawZoneRing(g, s, f);
    }
    case 'zone_fill': {
      const s = zoneSchoolOfSuffix(key, 'zone_fill_');
      return (g, f) => drawZoneFill(g, s, f);
    }
    case 'status': {
      const kind = key.slice('status_'.length) as 'stun' | 'burn' | 'freeze' | 'shield';
      return (g, f) => drawStatus(g, kind, f);
    }
    default: {
      switch (key) {
        case 'heal_burst':
          return (g, f) => drawHealBurst(g, f);
        case 'buff_ring':
          return (g, f) => drawBuffRing(g, f);
        case 'crit_star':
          return (g, f) => drawCritStar(g, f);
        case 'dodge_puff':
          return (g, f) => drawDodgePuff(g, f);
        case 'death_poof':
          return (g, f) => drawDeathPoof(g, f);
        case 'summon_circle':
          return (g, f) => drawSummonCircle(g, f);
        default:
          return drawFallback;
      }
    }
  }
}

/**
 * 키의 경계 처리 방식.
 *  zone_fill_* 만 격자로 이어 붙이므로 좌우·상하를 wrap 한다.
 *  장판 테두리는 원 하나를 제 크기로 그리는 그림이라 이어 붙이지 않는다 (wrap 없음).
 */
function wrapOf(key: FxKey): FxWrap {
  return isFxTileKey(key) ? 'xy' : 'none';
}

const KNOWN = new Set<FxKey>(FX_KEYS);

/** 코드 생성 임시 이펙트가 있는 키인지 */
export function hasFxDesign(key: FxKey): boolean {
  return KNOWN.has(key);
}

// ───────────────────────── 버퍼 / 시트 ─────────────────────────

/**
 * 한 프레임을 픽셀 버퍼로 만든다 (캔버스 없이 동작 → node 덤프 가능).
 * f 는 0 ~ frames−1 로 잘린다.
 */
export function buildFxFrameBuffer(key: FxKey, frame: number): PixelBuffer {
  const meta = fxDefaultMeta(key);
  const buf = new PixelBuffer(meta.frameW, meta.frameH);
  const f = Math.max(0, Math.min(meta.frames - 1, Math.round(frame)));
  const g = new FxG(buf, 0, 0, meta.frameW, meta.frameH, wrapOf(key));
  drawerFor(key)(g, f);
  return buf;
}

const SHEET_BUFFERS = new Map<FxKey, PixelBuffer>();

/**
 * 키의 전체 시트(한 줄)를 픽셀 버퍼로 만든다 (캐시). DOM 을 쓰지 않는다.
 * 폭 = frameW × frames, 높이 = frameH.
 */
export function buildFxSheetBuffer(key: FxKey): PixelBuffer {
  const cached = SHEET_BUFFERS.get(key);
  if (cached) return cached;
  const meta = fxDefaultMeta(key);
  const sheet = new PixelBuffer(meta.frameW * meta.frames, meta.frameH);
  const drawer = drawerFor(key);
  const wrap = wrapOf(key);
  for (let f = 0; f < meta.frames; f++) {
    // 프레임을 따로 그린 뒤 시트에 복사한다 (wrap 이 이웃 프레임을 침범하지 않게)
    const frame = new PixelBuffer(meta.frameW, meta.frameH);
    drawer(new FxG(frame, 0, 0, meta.frameW, meta.frameH, wrap), f);
    const ox = f * meta.frameW;
    for (let y = 0; y < meta.frameH; y++) {
      const src = y * meta.frameW * 4;
      const dst = (y * sheet.w + ox) * 4;
      sheet.data.set(frame.data.subarray(src, src + meta.frameW * 4), dst);
    }
  }
  SHEET_BUFFERS.set(key, sheet);
  return sheet;
}

const FX_SHEETS = new Map<FxKey, FxSheet>();

/**
 * 코드 생성 임시 이펙트 시트 (캐시, 결정론적, 난수 없음).
 * 알 수 없는 키도 폴백 그림으로 항상 시트를 돌려준다 (에러로 멈추지 않는다).
 */
export function getFxSheet(key: FxKey): FxSheet {
  const hit = FX_SHEETS.get(key);
  if (hit) return hit;
  const sheet: FxSheet = { key, image: bufferToCanvas(buildFxSheetBuffer(key)), meta: fxDefaultMeta(key) };
  FX_SHEETS.set(key, sheet);
  return sheet;
}

/** 캐시 비우기 (테스트·핫리로드용) */
export function clearFxSpriteCache(): void {
  SHEET_BUFFERS.clear();
  FX_SHEETS.clear();
}
