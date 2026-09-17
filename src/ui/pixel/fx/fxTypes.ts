/**
 * 스킬 이펙트 계약 (v0.9 설계 [1][2][3]).
 *
 * 스프라이트(spriteTypes.ts)와 같은 구조로, 이펙트도 외부 에셋을 넣으면 코드 수정 없이 교체된다.
 *   public/effects/<key>.png  — 한 줄(1행) 시트. 프레임을 왼쪽 → 오른쪽으로 나열
 *   public/effects/<key>.json — FxMeta
 *
 * 규격 요약
 *  - 프레임 크기는 키마다 다르다 (32 / 48 / 64, 장판 테두리는 반경마다 160~384). 1 유닛 = 32px.
 *  - anchor 는 이펙트의 기준점. 폭발·상태는 중심, 투사체는 진행 방향 기준 중심, 베기는 시전자 손 위치,
 *    zone_ring_*_r** 은 **원 전체**의 중심 (= 프레임 중앙. 테두리가 프레임 가장자리에 닿는다).
 *  - blend 'add' 는 가산 합성(밝게 빛나는 것: 폭발·마법·번개), 'normal' 은 일반(연기·베기·물리).
 *  - 정수 픽셀, 안티앨리어싱·블러 금지, 투명 PNG.
 * 제작 규격 문서: docs/EFFECTS.md (이 파일과 항상 일치시킬 것)
 *
 * 장판 테두리는 **필요한 크기 그대로** 만든다 (늘리지도, 이어 붙이지도 않는다).
 * 게임에서 실제로 쓰이는 (계열, 반경) 조합만 키가 되며, 그 목록은 손으로 적지 않고
 * core 의 게임 데이터(SKILLS · HAZARDS)에서 자동으로 만든다 — 밸런싱으로 반경이 바뀌면 목록도 따라간다.
 *
 * 이 파일은 순수 타입·상수·함수만 있고 DOM 을 쓰지 않는다 (node 에서 검사·덤프 가능).
 * core 는 **읽기만** 한다 (src/core 는 수정하지 않는다).
 */
import type { MagicSchool, SkillDef } from '../../../core/types';
import { SKILLS } from '../../../core/data/skills';
import { HAZARDS } from '../../../core/data/maps';

// ───────────────────────── 기본 타입 ─────────────────────────

export type FxKey = string;

export interface FxMeta {
  frameW: number;
  frameH: number;
  /** 시트의 프레임 수 (= 가로 칸 수) */
  frames: number;
  fps: number;
  /** 이펙트의 기준점 (프레임 안 픽셀 좌표) */
  anchor: { x: number; y: number };
  /** 'add' = 가산 합성(빛), 'normal' = 일반 합성 */
  blend: 'normal' | 'add';
  /** true 면 반복, false 면 1회 재생 후 끝 */
  loop: boolean;
}

export interface FxSheet {
  key: FxKey;
  image: CanvasImageSource;
  meta: FxMeta;
}

/** 외부 에셋 폴더 (Vite public/ 기준) */
export const FX_ASSET_DIR = 'effects/';

/** 1 맵 유닛의 픽셀 수 (스프라이트와 같은 배율) */
export const FX_PIXELS_PER_UNIT = 32;

// ───────────────────────── 계열 ─────────────────────────

/** 이펙트 계열 7종. 'phys' 는 무속성·물리 (core 의 MagicSchool 'none' 에 대응) */
export type FxSchool = 'fire' | 'ice' | 'lightning' | 'holy' | 'nature' | 'shadow' | 'phys';

/** 계열 순회는 항상 이 배열 순서로 (결정론) */
export const FX_SCHOOLS: readonly FxSchool[] = ['fire', 'ice', 'lightning', 'holy', 'nature', 'shadow', 'phys'];

/** 마법 계열 6종 (물리 제외). 투사체 마력구가 쓴다 */
export const FX_MAGIC_SCHOOLS: readonly FxSchool[] = ['fire', 'ice', 'lightning', 'holy', 'nature', 'shadow'];

/** 장판·예고는 맵 기믹(빙하 눈보라 등)을 위해 'neutral' 을 더 쓴다 */
export type FxZoneSchool = FxSchool | 'neutral';
export const FX_ZONE_SCHOOLS: readonly FxZoneSchool[] = [...FX_SCHOOLS, 'neutral'];

/** 상태 이펙트 4종 */
export type FxStatusKind = 'stun' | 'burn' | 'freeze' | 'shield';
export const FX_STATUS_KINDS: readonly FxStatusKind[] = ['stun', 'burn', 'freeze', 'shield'];

/** core 의 MagicSchool → 이펙트 계열 ('none' = 물리) */
export function fxSchoolOfMagic(school: MagicSchool | null | undefined): FxSchool {
  if (!school || school === 'none') return 'phys';
  return school;
}

/** 이펙트 계열 → core 의 MagicSchool (팔레트 조회용). 'phys' 는 'none' */
export function magicSchoolOfFx(school: FxSchool): MagicSchool {
  return school === 'phys' ? 'none' : school;
}

// ───────────────────────── 키 ─────────────────────────

/** A. 피격 폭발 */
export function impactFxKey(school: FxSchool): FxKey {
  return `impact_${school}`;
}
/** B. 투사체 마력구 (마법 계열 6종) */
export function projOrbFxKey(school: FxSchool): FxKey {
  return `proj_orb_${school}`;
}
/** C. 시전 */
export function castFxKey(school: FxSchool): FxKey {
  return `cast_${school}`;
}
/** E-2. 장판 내부 타일 */
export function zoneFillFxKey(school: FxZoneSchool): FxKey {
  return `zone_fill_${school}`;
}
/** F. 상태 */
export function statusFxKey(kind: FxStatusKind): FxKey {
  return `status_${kind}`;
}

/** D. 근접 베기 3종 */
export const FX_SLASH_KEYS: readonly FxKey[] = ['slash_light', 'slash_heavy', 'slash_pierce'];
/** B. 물리 투사체 2종 */
export const FX_PROJ_PHYS_KEYS: readonly FxKey[] = ['proj_arrow', 'proj_bullet'];
/** G. 기타 6종 */
export const FX_MISC_KEYS: readonly FxKey[] = [
  'heal_burst', 'buff_ring', 'crit_star', 'dodge_puff', 'death_poof', 'summon_circle',
];

// ─────────────── E-1. 장판 테두리 (반경마다 '실제 크기 그대로' 만든 원) ───────────────

/**
 * 테두리 키 이름 규칙: `zone_ring_<school>_r<반경×10>`.
 *   반경 3.5 화염 → `zone_ring_fire_r35`,  반경 6 물리 → `zone_ring_phys_r60`
 * 프레임 크기 = 반경 × 2 × 32 px 의 정사각형 (r25→160, r30→192, r35→224, r40→256, r45→288, r50→320, r60→384).
 * 원의 중심이 프레임 중앙(anchor)이고 테두리가 프레임 가장자리에 닿는다.
 * **늘리지도 이어 붙이지도 않는다.** 필요한 크기가 정해져 있으니 그 크기로 딱 맞게 그린다.
 */

/** 테두리 반경을 다루는 최소 단위 (맵 유닛). 키 이름의 ×10 값이 언제나 정수가 된다 */
export const FX_RING_RADIUS_STEP = 0.5;

/** 반경(유닛) → 0.5 단위로 반올림한 반경. 최소 한 단위 */
export function quantRingRadius(radiusUnits: number): number {
  if (!(radiusUnits > 0)) return FX_RING_RADIUS_STEP;
  const q = Math.round(radiusUnits / FX_RING_RADIUS_STEP) * FX_RING_RADIUS_STEP;
  return Math.max(FX_RING_RADIUS_STEP, Math.round(q * 10) / 10);
}

/** 반경 → 키 이름에 쓰는 정수 태그 (3.5 → 35) */
export function ringRadiusTag(radiusUnits: number): number {
  return Math.round(quantRingRadius(radiusUnits) * 10);
}

/** 반경의 테두리 프레임 한 변 (px) = 반경 × 2 × 32 */
export function ringFrameSize(radiusUnits: number): number {
  return Math.round(quantRingRadius(radiusUnits) * 2 * FX_PIXELS_PER_UNIT);
}

/** (계열, 반경) → 키 이름. 실제로 존재하는 키인지는 보지 않는다 (이름 규칙만) */
export function ringFxKeyOf(school: FxZoneSchool, radiusUnits: number): FxKey {
  return `zone_ring_${school}_r${ringRadiusTag(radiusUnits)}`;
}

/** 키 이름 → (계열, 반경). 규칙에 맞지 않으면 null */
export function parseRingFxKey(key: FxKey): { school: FxZoneSchool; radius: number } | null {
  if (key.indexOf('zone_ring_') !== 0) return null;
  const rest = key.slice('zone_ring_'.length);
  const cut = rest.lastIndexOf('_r');
  if (cut <= 0) return null;
  const school = rest.slice(0, cut) as FxZoneSchool;
  if (FX_ZONE_SCHOOLS.indexOf(school) < 0) return null;
  const tag = rest.slice(cut + 2);
  if (!/^[0-9]+$/.test(tag)) return null;
  const radius = Number(tag) / 10;
  if (!(radius > 0)) return null;
  return { school, radius };
}

/**
 * 스킬 정의 → 이펙트 계열. `effects.ts` 의 `schoolOfSkill` 과 같은 규칙이다
 * (피해 효과가 있으면 그 효과의 계열, 물리 피해는 'phys', 아니면 스킬의 계열).
 */
function ringSchoolOfSkill(sk: SkillDef): FxSchool {
  for (let i = 0; i < sk.effects.length; i++) {
    const e = sk.effects[i];
    if (e.kind !== 'damage') continue;
    if (e.school === 'phys') return 'phys';
    return fxSchoolOfMagic(e.magic ?? sk.magic);
  }
  return fxSchoolOfMagic(sk.magic);
}

/**
 * 게임 데이터에서 실제로 쓰이는 (계열, 반경) 조합을 모은다.
 *  - SKILLS 중 target 이 enemy_area / ally_area 이고 radius 가 있는 스킬 → 그 스킬의 계열과 반경
 *  - HAZARDS(맵 기믹) → 'neutral'. 반경은 최소(radius)부터 최대(maxRadius)까지 0.5 단위
 * 반경은 0.5 단위로 반올림한다. 결과는 계열별 오름차순 배열.
 */
function collectRingRadii(): Map<FxZoneSchool, number[]> {
  const acc = new Map<FxZoneSchool, Set<number>>();
  const add = (school: FxZoneSchool, radiusUnits: number): void => {
    if (!(radiusUnits > 0)) return;
    let set = acc.get(school);
    if (!set) {
      set = new Set<number>();
      acc.set(school, set);
    }
    set.add(quantRingRadius(radiusUnits));
  };

  const ids = Object.keys(SKILLS).sort();
  for (let i = 0; i < ids.length; i++) {
    const sk = SKILLS[ids[i]];
    if (!sk || (sk.target !== 'enemy_area' && sk.target !== 'ally_area')) continue;
    const r = sk.radius ?? 0;
    if (!(r > 0)) continue;
    add(ringSchoolOfSkill(sk), r);
  }

  for (let i = 0; i < HAZARDS.length; i++) {
    const hz = HAZARDS[i];
    const min = hz.radius;
    if (!(min > 0)) continue;
    const max = Math.max(min, hz.maxRadius ?? min);
    for (let r = quantRingRadius(min); r <= max + 1e-9; r = Math.round((r + FX_RING_RADIUS_STEP) * 10) / 10) {
      add('neutral', r);
    }
    add('neutral', max);
  }

  const out = new Map<FxZoneSchool, number[]>();
  for (const school of FX_ZONE_SCHOOLS) {
    const set = acc.get(school);
    if (!set || set.size === 0) continue;
    out.set(school, Array.from(set).sort((a, b) => a - b));
  }
  return out;
}

const RING_RADII: Map<FxZoneSchool, number[]> = collectRingRadii();

/** 그 계열에 존재하는 테두리 반경 (오름차순). 없으면 빈 배열 */
export function ringRadiiOf(school: FxZoneSchool): readonly number[] {
  return RING_RADII.get(school) ?? [];
}

/** 장판 테두리 키 전부 (계열 순서 × 반경 오름차순). 게임 데이터에서 자동으로 만들어진다 */
export const FX_RING_KEYS: readonly FxKey[] = (() => {
  const keys: FxKey[] = [];
  for (const school of FX_ZONE_SCHOOLS) {
    for (const r of ringRadiiOf(school)) keys.push(ringFxKeyOf(school, r));
  }
  return keys;
})();

const RING_KEY_SET = new Set<FxKey>(FX_RING_KEYS);

/** 그 계열에서 반경이 가장 가까운 키 (같으면 작은 반경). 계열에 키가 없으면 null */
function nearestRingKey(school: FxZoneSchool, radiusUnits: number): FxKey | null {
  const radii = ringRadiiOf(school);
  if (radii.length === 0) return null;
  let best = radii[0];
  let bestD = Math.abs(best - radiusUnits);
  for (let i = 1; i < radii.length; i++) {
    const d = Math.abs(radii[i] - radiusUnits);
    if (d < bestD - 1e-9) {
      best = radii[i];
      bestD = d;
    }
  }
  return ringFxKeyOf(school, best);
}

/**
 * (계열, 반경) → 테두리 키.
 * 정확히 맞는 키가 있으면 그것, 없으면 같은 계열에서 반경이 가장 가까운 키,
 * 그래도 없으면 물리(phys) 의 가장 가까운 키를 쓴다.
 */
export function ringFxKey(school: FxSchool, radiusUnits: number, neutral = false): FxKey {
  const zs: FxZoneSchool = neutral ? 'neutral' : school;
  const exact = ringFxKeyOf(zs, radiusUnits);
  if (RING_KEY_SET.has(exact)) return exact;
  return nearestRingKey(zs, radiusUnits) ?? nearestRingKey('phys', radiusUnits) ?? exact;
}

/**
 * 키를 실제 반경에 맞추는 배율 = 실제 반경 ÷ 키의 반경.
 * 정확히 맞는 키면 **정확히 1** (늘리지 않는다). 키가 규칙에 맞지 않으면 1.
 */
export function ringFxScale(key: FxKey, radiusUnits: number): number {
  const p = parseRingFxKey(key);
  if (!p || !(p.radius > 0) || !(radiusUnits > 0)) return 1;
  return radiusUnits / p.radius;
}

/** 전체 키 (A → G 순서 고정). 테두리 수는 게임 데이터에 따라 달라진다 */
export const FX_KEYS: readonly FxKey[] = [
  // A. 피격 폭발 7
  ...FX_SCHOOLS.map(impactFxKey),
  // B. 투사체 8
  ...FX_PROJ_PHYS_KEYS,
  ...FX_MAGIC_SCHOOLS.map(projOrbFxKey),
  // C. 시전 7
  ...FX_SCHOOLS.map(castFxKey),
  // D. 근접 베기 3
  ...FX_SLASH_KEYS,
  // E. 장판/예고 = 테두리(반경별) + 내부 타일 8
  ...FX_RING_KEYS,
  ...FX_ZONE_SCHOOLS.map(zoneFillFxKey),
  // F. 상태 4
  ...FX_STATUS_KINDS.map(statusFxKey),
  // G. 기타 6
  ...FX_MISC_KEYS,
];

/**
 * 제작 우선순위 3단계 (docs/EFFECTS.md 와 같은 구성).
 *  1순위 21종 = impact 7 + proj 8 + slash 3 + heal_burst + death_poof + crit_star
 *  2순위 = cast 7 + zone_ring(반경별, FX_RING_KEYS) + zone_fill 8
 *  3순위 7종 = status 4 + buff_ring + dodge_puff + summon_circle
 * 2순위 개수는 게임 데이터(스킬 반경)에 따라 달라진다 — `npm run effects:list` 로 확인한다.
 */
export const FX_PRIORITY_1: readonly FxKey[] = [
  ...FX_SCHOOLS.map(impactFxKey),
  ...FX_PROJ_PHYS_KEYS,
  ...FX_MAGIC_SCHOOLS.map(projOrbFxKey),
  ...FX_SLASH_KEYS,
  'heal_burst', 'death_poof', 'crit_star',
];
export const FX_PRIORITY_2: readonly FxKey[] = [
  ...FX_SCHOOLS.map(castFxKey),
  ...FX_RING_KEYS,
  ...FX_ZONE_SCHOOLS.map(zoneFillFxKey),
];
export const FX_PRIORITY_3: readonly FxKey[] = [
  ...FX_STATUS_KINDS.map(statusFxKey),
  'buff_ring', 'dodge_puff', 'summon_circle',
];
export const FX_PRIORITY_TIERS: readonly (readonly FxKey[])[] = [FX_PRIORITY_1, FX_PRIORITY_2, FX_PRIORITY_3];

/** 키의 분류 */
export type FxKeyKind = 'impact' | 'proj' | 'cast' | 'slash' | 'zone_ring' | 'zone_fill' | 'status' | 'misc';

export function fxKeyKind(key: FxKey): FxKeyKind {
  if (key.indexOf('impact_') === 0) return 'impact';
  if (key.indexOf('proj_') === 0) return 'proj';
  if (key.indexOf('cast_') === 0) return 'cast';
  if (key.indexOf('slash_') === 0) return 'slash';
  if (key.indexOf('zone_ring_') === 0) return 'zone_ring';
  if (key.indexOf('zone_fill_') === 0) return 'zone_fill';
  if (key.indexOf('status_') === 0) return 'status';
  return 'misc';
}

/** zone_fill_* 는 상하좌우로 이어 붙이는 타일이다 (좌우·상하 이음매 연속성 검사 대상) */
export function isFxTileKey(key: FxKey): boolean {
  return fxKeyKind(key) === 'zone_fill';
}

// ───────────────────────── 기본 메타 ─────────────────────────

function meta(
  frameW: number,
  frameH: number,
  frames: number,
  fps: number,
  anchor: { x: number; y: number },
  blend: 'normal' | 'add',
  loop: boolean,
): FxMeta {
  return { frameW, frameH, frames, fps, anchor, blend, loop };
}

function center(size: number): { x: number; y: number } {
  return { x: size / 2, y: size / 2 };
}

/** 계열 기본 합성: 물리만 일반 합성, 나머지는 가산 */
function schoolBlend(school: FxSchool): 'normal' | 'add' {
  return school === 'phys' ? 'normal' : 'add';
}

function zoneBlend(school: FxZoneSchool): 'normal' | 'add' {
  return school === 'phys' || school === 'neutral' ? 'normal' : 'add';
}

const DEFAULT_META_TABLE: Record<FxKey, FxMeta> = {};

// A. 피격 폭발 — 64×64, 6프레임 @20fps = 0.30초, 1회
for (const s of FX_SCHOOLS) {
  DEFAULT_META_TABLE[impactFxKey(s)] = meta(64, 64, 6, 20, center(64), schoolBlend(s), false);
}
// B. 투사체 — 32×32, 4프레임 @12fps 반복. 진행 방향(+x) 기준으로 그린다
DEFAULT_META_TABLE.proj_arrow = meta(32, 32, 4, 12, center(32), 'normal', true);
DEFAULT_META_TABLE.proj_bullet = meta(32, 32, 4, 12, center(32), 'add', true);
for (const s of FX_MAGIC_SCHOOLS) {
  DEFAULT_META_TABLE[projOrbFxKey(s)] = meta(32, 32, 4, 12, center(32), 'add', true);
}
// C. 시전 — 48×48, 4프레임 @10fps = 0.40초 반복. 시전자 발밑
for (const s of FX_SCHOOLS) {
  DEFAULT_META_TABLE[castFxKey(s)] = meta(48, 48, 4, 10, center(48), schoolBlend(s), true);
}
// D. 근접 베기 — 64×64, 4프레임 @24fps = 0.167초, 1회. 앵커 = 시전자 손 위치(호의 회전 중심)
DEFAULT_META_TABLE.slash_light = meta(64, 64, 4, 24, { x: 16, y: 32 }, 'normal', false);
DEFAULT_META_TABLE.slash_heavy = meta(64, 64, 4, 24, { x: 16, y: 32 }, 'normal', false);
DEFAULT_META_TABLE.slash_pierce = meta(64, 64, 4, 24, { x: 16, y: 32 }, 'normal', false);
// E-1. 장판 테두리 — 반경마다 '실제 크기 그대로'. 한 변 = 반경 × 2 × 32 px, 4프레임 @8fps 반복.
//      앵커는 프레임 중앙 = 원의 중심. 배율 1 로 그리므로 반경이 커져도 선의 굵기(픽셀 밀도)는 그대로다.
for (const key of FX_RING_KEYS) {
  const p = parseRingFxKey(key);
  if (!p) continue;
  const size = ringFrameSize(p.radius);
  DEFAULT_META_TABLE[key] = meta(size, size, 4, 8, center(size), zoneBlend(p.school), true);
}
// E-2. 장판 내부 타일 — 32×32, 4프레임 @8fps 반복.
//      타일의 앵커는 '타일 원점'(좌상단). 코드는 맵 격자에 맞춰 이어 붙인다
for (const s of FX_ZONE_SCHOOLS) {
  DEFAULT_META_TABLE[zoneFillFxKey(s)] = meta(32, 32, 4, 8, { x: 0, y: 0 }, zoneBlend(s), true);
}
// F. 상태 — 32×32, 4프레임 @8fps 반복. 유닛 머리 위/발밑
DEFAULT_META_TABLE.status_stun = meta(32, 32, 4, 8, center(32), 'normal', true);
DEFAULT_META_TABLE.status_burn = meta(32, 32, 4, 8, center(32), 'add', true);
DEFAULT_META_TABLE.status_freeze = meta(32, 32, 4, 8, center(32), 'add', true);
DEFAULT_META_TABLE.status_shield = meta(32, 32, 4, 8, center(32), 'add', true);
// G. 기타
DEFAULT_META_TABLE.heal_burst = meta(48, 48, 5, 15, center(48), 'add', false);
DEFAULT_META_TABLE.buff_ring = meta(48, 48, 4, 8, center(48), 'add', true);
DEFAULT_META_TABLE.crit_star = meta(32, 32, 4, 20, center(32), 'add', false);
DEFAULT_META_TABLE.dodge_puff = meta(32, 32, 4, 16, center(32), 'normal', false);
DEFAULT_META_TABLE.death_poof = meta(64, 64, 5, 12, center(64), 'normal', false);
DEFAULT_META_TABLE.summon_circle = meta(64, 64, 6, 10, center(64), 'add', false);

/** 키별 기본 메타 (설계 [3] 표). 외부 JSON 이 없거나 깨졌을 때와 코드 생성 임시 이펙트가 쓴다 */
export const FX_DEFAULT_META: Record<FxKey, FxMeta> = DEFAULT_META_TABLE;

/** 목록에 없는 키가 왔을 때 쓰는 메타 */
export const FX_FALLBACK_META: FxMeta = meta(32, 32, 4, 12, center(32), 'add', false);

/** 키의 기본 메타 (알 수 없는 키는 FX_FALLBACK_META) */
export function fxDefaultMeta(key: FxKey): FxMeta {
  return FX_DEFAULT_META[key] ?? FX_FALLBACK_META;
}

/** 외부 에셋 경로 (public/ 기준 상대 경로) */
export function fxAssetPaths(key: FxKey): { png: string; json: string } {
  return { png: `${FX_ASSET_DIR}${key}.png`, json: `${FX_ASSET_DIR}${key}.json` };
}

/** 시트 PNG 의 규격 크기 (프레임 수 × frameW, frameH) */
export function fxSheetSize(meta_: FxMeta): { w: number; h: number } {
  return { w: meta_.frameW * meta_.frames, h: meta_.frameH };
}

// ───────────────────────── 재생 ─────────────────────────

/** 1회 재생 시간 (초) = frames / fps */
export function fxDurationSec(meta_: FxMeta): number {
  if (meta_.fps <= 0 || meta_.frames <= 0) return 0;
  return meta_.frames / meta_.fps;
}

/**
 * 경과 시간(시뮬레이션 초) → 프레임 인덱스. 순수 함수.
 * 반복이면 순환하고, 비반복이 끝나면 **−1** (렌더러는 그리지 않는다).
 * 음수 경과(아직 시작 전)는 0 프레임으로 본다.
 */
export function fxFrameAt(meta_: FxMeta, elapsedSec: number): number {
  const frames = meta_.frames;
  if (frames <= 0) return -1;
  if (elapsedSec <= 0) return 0;
  const raw = Math.floor(elapsedSec * meta_.fps);
  if (meta_.loop) return ((raw % frames) + frames) % frames;
  return raw >= frames ? -1 : raw;
}

// ───────────────────────── JSON 파싱 ─────────────────────────

function numOr(v: unknown, fallback: number, min: number): number {
  return typeof v === 'number' && isFinite(v) && v >= min ? v : fallback;
}

/**
 * 외부 JSON → FxMeta. 깨졌거나 빠진 필드는 그 키의 기본값으로 채운다 (에러로 멈추지 않는다).
 */
export function parseFxMeta(raw: unknown, key: FxKey): FxMeta {
  const base = fxDefaultMeta(key);
  if (typeof raw !== 'object' || raw === null) return { ...base, anchor: { ...base.anchor } };
  const o = raw as Record<string, unknown>;
  const frameW = numOr(o.frameW, base.frameW, 1);
  const frameH = numOr(o.frameH, base.frameH, 1);
  const frames = Math.max(1, Math.round(numOr(o.frames, base.frames, 1)));
  const fps = numOr(o.fps, base.fps, 0.0001);
  const a = o.anchor as { x?: unknown; y?: unknown } | undefined;
  const anchor =
    a && typeof a.x === 'number' && typeof a.y === 'number' && isFinite(a.x) && isFinite(a.y)
      ? { x: a.x, y: a.y }
      : { ...base.anchor };
  const blend: 'normal' | 'add' = o.blend === 'add' ? 'add' : o.blend === 'normal' ? 'normal' : base.blend;
  const loop = typeof o.loop === 'boolean' ? o.loop : base.loop;
  return { frameW, frameH, frames, fps, anchor, blend, loop };
}
