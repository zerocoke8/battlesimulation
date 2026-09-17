/**
 * 도트 렌더러 팔레트 (v0.7).
 *  - 색 변환 유틸 (hex ↔ rgb ↔ hsl)
 *  - 임시 스프라이트가 쓰는 공용 색 상수 (피부·금속·뼈·외곽선 …)
 *  - 직업별 기본 색 (채도 있는 옷 색 = 틴트 대상)
 *  - 세부 직업 틴트 색 (docs/SPRITES.md §5). 시트의 채도 있는 픽셀의 색상(hue)만 이 색으로 돌린다.
 *  - 마법 계열별 이펙트 색
 * 순수 함수·상수만 있고 DOM 을 쓰지 않는다 (self-check 를 node 에서 돌릴 수 있게).
 */
import type { MagicSchool, MainJob, SubJobId, TeamSide } from '../../core/types';

export type RGB = readonly [number, number, number];

// ───────────────────────── 색 변환 ─────────────────────────

const HEX_CACHE = new Map<string, RGB>();

/** '#rgb' / '#rrggbb' → [r,g,b]. 잘못된 문자열은 자홍(#ff00ff) 으로 눈에 띄게 한다 */
export function hexToRgb(hex: string): RGB {
  const cached = HEX_CACHE.get(hex);
  if (cached) return cached;
  let h = hex.charAt(0) === '#' ? hex.slice(1) : hex;
  if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
  let rgb: RGB;
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) {
    rgb = [255, 0, 255];
  } else {
    rgb = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  HEX_CACHE.set(hex, rgb);
  return rgb;
}

function hex2(v: number): string {
  const c = Math.max(0, Math.min(255, Math.round(v)));
  return (c < 16 ? '0' : '') + c.toString(16);
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + hex2(r) + hex2(g) + hex2(b);
}

/** rgb(0~255) → [h(0~360), s(0~1), l(0~1)] */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-6) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) * 60;
  else if (max === gg) h = ((bb - rr) / d + 2) * 60;
  else h = ((rr - gg) / d + 4) * 60;
  return [h, s, l];
}

function hueToRgbComponent(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

/** [h(0~360), s, l] → rgb(0~255) */
export function hslToRgb(h: number, s: number, l: number): RGB {
  if (s <= 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = (((h % 360) + 360) % 360) / 360;
  return [
    Math.round(hueToRgbComponent(p, q, hk + 1 / 3) * 255),
    Math.round(hueToRgbComponent(p, q, hk) * 255),
    Math.round(hueToRgbComponent(p, q, hk - 1 / 3) * 255),
  ];
}

/** 색을 어둡게/밝게. amount −1~1 (명도 가산) */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const [nr, ng, nb] = hslToRgb(h, s, Math.max(0, Math.min(1, l + amount)));
  return rgbToHex(nr, ng, nb);
}

// ───────────────────────── 공용 색 ─────────────────────────

/** 외곽선. 채도가 낮아 틴트 대상에서 빠진다 */
export const OUTLINE = '#15121c';
export const WHITE = '#ffffff';
export const EYE = '#1a1220';

export const SKIN = '#e9bd8f';
export const SKIN_DARK = '#c48f66';
export const SKIN_GREEN = '#6f9c3a'; // 고블린·오크
export const SKIN_GREEN_DARK = '#4b6d24';
export const SKIN_GREY = '#8d8fa0'; // 악마·망령
export const SKIN_RED = '#b8352c'; // 마신

export const METAL = '#b8bcc6';
export const METAL_DARK = '#6d727e';
export const METAL_LIGHT = '#e7e9ee';
export const RUST = '#8a5a3c';
export const WOOD = '#8c5a2b';
export const WOOD_DARK = '#5d3a17';
export const BONE = '#ebe6d2';
export const BONE_DARK = '#b5ae95';
export const LEATHER = '#6b4a2a';
export const LEATHER_DARK = '#432c17';
export const CLOTH_GREY = '#5a5a66';
export const CLOTH_GREY_DARK = '#3a3a44';
export const STONE = '#8f8a80';
export const STONE_DARK = '#5f5a52';
export const STONE_LIGHT = '#b8b2a6';
export const SHADOW_PURPLE = '#2b1740';

// ───────────────────────── 진영 색 (v0.8, 도트 모드 전용) ─────────────────────────

/**
 * 진영 색. 도트 모드에서 HP 바를 체력 비율이 아니라 진영으로 칠하고, 직업 썸네일의 테두리로도 쓴다.
 * A = 플레이어(파랑), B = 상대(빨강). 간단 모드는 이 색을 쓰지 않는다 (기존 초록/노랑/빨강 유지).
 */
export const SIDE_COLOR: Record<TeamSide, string> = { A: '#3d8bff', B: '#ff4d4d' };

/**
 * 진영 색 HP 바 아래에 붙는 MP 바 색. 기본 파랑(#6fa8ff)은 A 진영 파랑과 색상(hue)이 사실상 같아
 * 두 바가 한 덩어리로 보이므로, 색상이 확실히 다른 보라를 쓴다 (간단 모드는 기존 파랑 유지).
 */
export const SIDE_MP_COLOR = '#b388ff';

/** 진영 색의 어두운 변형. 직업 썸네일 바탕 (= 글리프 외곽선) 색 */
export const SIDE_COLOR_DARK: Record<TeamSide, string> = {
  A: shade(SIDE_COLOR.A, -0.42),
  B: shade(SIDE_COLOR.B, -0.42),
};

/** 직업 썸네일 색 묶음: 바탕 = 어두운 진영색, 테두리 = 진영색, 글리프 = 흰색 */
export const ICON_BG_COLOR: Record<TeamSide, string> = SIDE_COLOR_DARK;
export const ICON_BORDER_COLOR: Record<TeamSide, string> = SIDE_COLOR;
export const ICON_FG_COLOR = '#f2f6ff';

// ───────────────────────── 직업 기본 색 ─────────────────────────

export interface JobPalette {
  /** 옷·망토 주색. 채도 ≥ 0.35 라 세부 직업 틴트 대상 */
  main: string;
  /** 주색의 어두운 변형 (주름·그림자). 역시 채도 있음 */
  dark: string;
  /** 포인트 색 (장식·보석). 채도 있음 */
  accent: string;
  /** 시전 글로우 색 */
  glow: string;
}

export const JOB_PALETTE: Record<MainJob, JobPalette> = {
  swordsman: { main: '#3d6fd8', dark: '#274a9a', accent: '#f0c040', glow: '#9ec2ff' },
  tank: { main: '#2f8f5a', dark: '#1f5f3c', accent: '#e0b040', glow: '#a4f0c4' },
  berserker: { main: '#c8402f', dark: '#8a2a1e', accent: '#f0c040', glow: '#ff9c7a' },
  assassin: { main: '#5b3fa8', dark: '#3b2870', accent: '#c94bd6', glow: '#c9a6ff' },
  archer: { main: '#4d9a3a', dark: '#2f6a24', accent: '#e0b040', glow: '#c6f59a' },
  sniper: { main: '#b56b2a', dark: '#7a4519', accent: '#3fa0e0', glow: '#ffd27a' },
  mage: { main: '#4a4ad8', dark: '#2f2f96', accent: '#f0c040', glow: '#b3b3ff' },
  summoner: { main: '#2a9d8f', dark: '#1a6a60', accent: '#e076c0', glow: '#9af0e4' },
  healer: { main: '#e0a838', dark: '#a87820', accent: '#f0f0f0', glow: '#fff3b0' },
};

// ───────────────────────── 세부 직업 틴트 ─────────────────────────

/** 틴트 대상 픽셀 조건 (docs/SPRITES.md §5): 채도 ≥ 0.35, 명도 0.2~0.85 */
export const TINT_SAT_MIN = 0.35;
export const TINT_LIGHT_MIN = 0.2;
export const TINT_LIGHT_MAX = 0.85;

const RED = '#d6453c';
const GREEN = '#3fbf5a';
const BLUE = '#3f7fe0';

/**
 * 세부 직업 id → 틴트 색. 마법사·검사는 고유 색, 나머지는 세부 직업 순서대로 빨강/초록/파랑.
 * 여기 없는 id (분화 전 null 포함) 는 틴트 없음.
 */
export const SUBJOB_TINT: Record<SubJobId, string> = {
  swordsman_great: '#d61f3c', // 진홍
  swordsman_swift: '#22c1b8', // 청록
  swordsman_magic: '#9a4fe0', // 보라
  tank_wall: RED, tank_thorns: GREEN, tank_taunt: BLUE,
  berserker_frenzy: RED, berserker_blood: GREEN, berserker_breaker: BLUE,
  assassin_shadow: RED, assassin_poison: GREEN, assassin_mirage: BLUE,
  archer_rapid: RED, archer_precise: GREEN, archer_trap: BLUE,
  sniper_pierce: RED, sniper_magic: GREEN, sniper_watcher: BLUE,
  mage_fire: '#ff6a1f', // 주황·빨강
  mage_lightning: '#f2d21a', // 노랑
  mage_ice: '#7fd8ff', // 하늘
  summoner_beast: RED, summoner_spirit: GREEN, summoner_necro: BLUE,
  healer_priest: RED, healer_druid: GREEN, healer_ward: BLUE,
};

export function tintForSubJob(subJob: SubJobId | null | undefined): string | undefined {
  if (!subJob) return undefined;
  return SUBJOB_TINT[subJob];
}

/**
 * RGBA 픽셀 배열의 채도 있는 픽셀만 tint 의 색상(hue)으로 돌린다. 명도·채도는 유지. 제자리 변경.
 * 피부·금속·외곽선처럼 채도가 낮은 픽셀과 매우 밝거나 어두운 픽셀은 그대로 둔다.
 * 명시적 RGBA 마스크가 있으면 채도 기준 대신 마스크의 알파로 영역을 한정한다.
 */
export function applyHueTint(data: Uint8ClampedArray, tint: string, mask?: Uint8ClampedArray): void {
  const [tr, tg, tb] = hexToRgb(tint);
  const [th, ts] = rgbToHsl(tr, tg, tb);
  // 회색 계열 틴트(채도 낮음)면 아무것도 바꾸지 않는다
  if (ts < 0.15) return;
  const cache = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue;
    if (mask && !mask[i + 3]) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const packed = (r << 16) | (g << 8) | b;
    const hit = cache.get(packed);
    if (hit !== undefined) {
      data[i] = (hit >> 16) & 255;
      data[i + 1] = (hit >> 8) & 255;
      data[i + 2] = hit & 255;
      continue;
    }
    const [, s, l] = rgbToHsl(r, g, b);
    let out = packed;
    if (mask || (s >= TINT_SAT_MIN && l >= TINT_LIGHT_MIN && l <= TINT_LIGHT_MAX)) {
      const [nr, ng, nb] = hslToRgb(th, s, l);
      out = (nr << 16) | (ng << 8) | nb;
    }
    cache.set(packed, out);
    data[i] = (out >> 16) & 255;
    data[i + 1] = (out >> 8) & 255;
    data[i + 2] = out & 255;
  }
}

// ───────────────────────── 마법 계열 색 ─────────────────────────

export interface SchoolPalette {
  /** 중심 (가장 밝음) */
  core: string;
  /** 주색 */
  main: string;
  /** 가장자리·어두운 색 */
  dark: string;
}

/** 스킬 파티클·시전 글로우·투사체 색. 'none' 은 물리 (흰·회색) */
export const MAGIC_SCHOOL_COLOR: Record<MagicSchool, SchoolPalette> = {
  fire: { core: '#fff1a8', main: '#ff7a1f', dark: '#b3341a' },
  lightning: { core: '#ffffff', main: '#ffe94a', dark: '#8a5cff' },
  ice: { core: '#ffffff', main: '#8fe3ff', dark: '#3c7fd6' },
  holy: { core: '#ffffff', main: '#ffe9a0', dark: '#e0b040' },
  nature: { core: '#eaffc8', main: '#6fd648', dark: '#2f7d32' },
  shadow: { core: '#d9b3ff', main: '#7a3fbf', dark: '#2a1040' },
  none: { core: '#ffffff', main: '#e0e0e0', dark: '#8a8a8a' },
};

/** 눈보라(hazard) 입자 색: 흰·하늘색 */
export const BLIZZARD_COLORS: readonly string[] = ['#ffffff', '#dff6ff', '#9fe0ff', '#6fc4ff'];
