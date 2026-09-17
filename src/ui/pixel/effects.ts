/**
 * 도트 모드 이펙트 (v0.9). 전투 이벤트·프레임 상태 → 짧은 픽셀 연출.
 *
 * v0.9 부터 그리기는 **이펙트 시트(fx)** 를 우선 쓴다 (`src/ui/pixel/fx/*`, 규격은 docs/EFFECTS.md).
 * `resolveFx(key)` 가 시트를 주면 그것으로 그리고, 시트를 못 쓰면 v0.7 의 코드 파티클로 폴백한다.
 * 외부 에셋(public/effects/<key>.png)을 넣으면 이 파일을 고치지 않아도 그림이 바뀐다.
 *
 * 이벤트 → 연출
 *  - 스킬 피해(attack.skillId): `impact_<school>` + (물리 근접 스킬이면) `slash_heavy`. 폴백: 계열 파티클 폭발
 *  - 원거리 기본 공격(거리 > RANGED_DIST): `proj_*` 가 PROJECTILE_SEC(0.25초) 동안 진행 방향으로 회전해 날아가고 도착 시 `impact_phys`
 *  - 근접 기본 공격: 시전자 손 위치에서 `slash_light/heavy/pierce` (직업별). 폴백: 베기 호 + 불꽃
 *  - 치명타: `crit_star`, 회피(`dodge`): `dodge_puff` ('회피!' 텍스트는 오버레이가 계속 담당)
 *  - 처치(`kill`): `death_poof`, 소환(`summon`): `summon_circle`, 회복(`heal`): `heal_burst`
 *  - zone_damage / hazard_damage(linger) / dot: 작은 불꽃 (틱마다 오므로 시각 해시로 솎는다)
 *  - hazard_damage(impact): `impact_<school>`
 * 프레임 상태 → 연출 (이벤트가 아니라 매 프레임 유닛 상태에서 뽑는다)
 *  - 시전 중: 시전자 발밑 `cast_<school>` (진행률 × 시전 시간 = 재생 위치)
 *  - 상태: `status_freeze` / `status_shield` (발밑, 유닛 아래), `status_stun` / `status_burn` (머리 위, 유닛 위)
 *  - 이로운 지속 상태(재생·흡혈·반사·무적): 발밑 `buff_ring` (유닛당 1장)
 *
 * 모든 재생 위치는 `frame.timeSec`(시뮬레이션 시간)의 순수 함수다. 상태를 갱신하지 않으므로 리플레이·배속에서 같은 그림이 나온다.
 * `Date.now` / `Math.random` 을 쓰지 않는다. 좌표는 맵 단위로 보관하고 그릴 때 오프스크린 px 로 바꾼다.
 *
 * 성능: 한 프레임에 그리는 이펙트 수 상한
 *   = MAX_EFFECTS(128, 이벤트 이펙트는 하나가 최대 1장)
 *   + MAX_UNIT_FX(48, 시전·상태·버프)
 *   + 영역 fx(MAX_ZONE_FX_ZONES 8 × 최대 3장 — 예고가 바탕 채움·진행 채움·테두리로 가장 많이 쓴다)
 *   = MAX_FX_PER_FRAME(200).
 */
import type { BattleEvent, MagicSchool, MainJob, StatusKind, UnitSnapshot } from '../../core/types';
import { getSkill } from '../../core/data/skills';
import { JOB_PALETTE, MAGIC_SCHOOL_COLOR, BLIZZARD_COLORS, type SchoolPalette } from './palette';
import { hashNoise, createCanvas, ctx2d } from './terrain';
import {
  FX_KEYS,
  FX_PIXELS_PER_UNIT,
  castFxKey as fxCastKey,
  fxDurationSec,
  fxFrameAt,
  fxSchoolOfMagic,
  impactFxKey as fxImpactKey,
  projOrbFxKey,
  ringFxKey,
  ringFxScale,
  statusFxKey,
  zoneFillFxKey as fxZoneFillKey,
  type FxKey,
  type FxMeta,
  type FxSchool,
  type FxSheet,
} from './fx/fxTypes';
import { preloadFx, resolveFx } from './fx/fxLoader';

export type { FxKey, FxMeta, FxSchool, FxSheet };

/** 이 거리(맵 단위)보다 멀면 원거리 기본 공격 → 투사체 */
export const RANGED_DIST = 2.5;
/** 투사체 비행 시간 (시뮬레이션 초) */
export const PROJECTILE_SEC = 0.25;
/** 베기 호 지속 (초, 폴백 파티클) */
const SLASH_SEC = 0.2;
/** 폭발 파티클 수명 (초, 폴백) */
const BURST_SEC = 0.45;
/** 작은 불꽃 수명 (초) */
const SPARK_SEC = 0.3;
/** 시전 링 수명 (초, 폴백) */
const CAST_RING_SEC = 0.3;
/** 회복 반짝임 수명 (초, 폴백) */
const HEAL_SEC = 0.55;

/** 동시에 유지하는 이벤트 이펙트 상한 (오래된 것부터 버린다). 이펙트 하나는 한 프레임에 최대 1장을 그린다 */
const MAX_EFFECTS = 128;
/** 프레임 상태(시전·상태이상·버프) 이펙트의 프레임당 상한 */
export const MAX_UNIT_FX = 48;
/** 영역(예고·장판) 에 fx 시트를 씌우는 최대 개수 */
export const MAX_ZONE_FX_ZONES = 8;
/** 영역 하나가 한 프레임에 그리는 fx 최대 장수 (예고 = 바탕 채움 + 진행 채움 + 테두리) */
const MAX_FX_PER_ZONE = 3;
/** 한 프레임에 그리는 이펙트 총 상한 (유닛 16기 기준 여유). 위 세 상한의 합 = 200 */
export const MAX_FX_PER_FRAME = MAX_EFFECTS + MAX_UNIT_FX + MAX_ZONE_FX_ZONES * MAX_FX_PER_ZONE;

export type ProjectileKind = 'arrow' | 'bullet' | 'orb' | 'spark';

type Effect =
  | {
      kind: 'projectile'; born: number; life: number; fxLife: number; x: number; y: number; tx: number; ty: number;
      proj: ProjectileKind; color: string; seed: number; hit: boolean; fxKey: FxKey; impactKey: FxKey;
    }
  | {
      kind: 'slash'; born: number; life: number; fxLife: number; x: number; y: number; hx: number; hy: number;
      angle: number; color: string; seed: number; fxKey: FxKey;
    }
  | {
      kind: 'burst'; born: number; life: number; fxLife: number; x: number; y: number; school: MagicSchool;
      count: number; speed: number; seed: number; blizzard: boolean; fxKey: FxKey; scale: number;
    }
  | { kind: 'spark'; born: number; life: number; fxLife: number; x: number; y: number; school: MagicSchool; count: number; seed: number }
  | { kind: 'castRing'; born: number; life: number; fxLife: number; x: number; y: number; school: MagicSchool; seed: number }
  | { kind: 'heal'; born: number; life: number; fxLife: number; x: number; y: number; seed: number; fxKey: FxKey }
  | { kind: 'fx'; born: number; life: number; fxLife: number; x: number; y: number; fxKey: FxKey; scale: number; rot: number; alpha: number };

// ───────────────────────── fx 시트 접근 (전부 안전 폴백) ─────────────────────────

/**
 * fx 시트를 동기로 조회한다. 모듈이 없거나 예외를 던지면 null → 호출부는 기존 파티클로 폴백한다.
 * `resolveFx` 는 외부 에셋이 로드돼 있으면 그것을, 아니면 코드 생성 임시 시트를 돌려준다.
 */
export function tryFx(key: FxKey): FxSheet | null {
  try {
    const sheet = resolveFx(key);
    if (sheet && sheet.image && sheet.meta && sheet.meta.frames > 0) return sheet;
  } catch {
    /* fx 모듈을 못 쓰면 파티클 폴백 */
  }
  return null;
}

/** 전투 시작 시 외부 이펙트 시트를 미리 로드한다 (실패해도 조용히 임시 시트로 간다) */
export function preloadBattleFx(): void {
  try {
    preloadFx(FX_KEYS);
  } catch {
    /* 무시 */
  }
}

/** 시트 한 바퀴(= frames / fps) 길이. 못 읽으면 fallback */
export function fxSheetDuration(sheet: FxSheet | null, fallback: number): number {
  if (!sheet) return fallback;
  try {
    const d = fxDurationSec(sheet.meta);
    return d > 0 ? d : fallback;
  } catch {
    return fallback;
  }
}

/** 경과 시간의 프레임 번호. 비반복이 끝났으면 -1 */
export function fxFrameIndex(sheet: FxSheet | null, elapsedSec: number): number {
  if (!sheet) return -1;
  try {
    return fxFrameAt(sheet.meta, elapsedSec);
  } catch {
    return -1;
  }
}

/** 키의 재생 길이 (시트가 있으면 시트 기준, 없으면 fallback) */
function fxLifeOf(key: FxKey, fallback: number): number {
  return fxSheetDuration(tryFx(key), fallback);
}

// ───────────────────────── 프레임 한 장 잘라내기 (장판 타일용) ─────────────────────────

const FRAME_CANVAS = new WeakMap<object, Map<number, HTMLCanvasElement | OffscreenCanvas>>();

/**
 * 시트에서 프레임 하나만 잘라낸 캔버스 (캐시). `createPattern` 으로 장판 내부를 이어 붙일 때 쓴다.
 * 시트 이미지 객체를 키로 하므로 외부 에셋이 나중에 로드돼 교체돼도 캐시가 섞이지 않는다.
 */
export function fxFrameCanvas(sheet: FxSheet, frameIndex: number): CanvasImageSource | null {
  const meta = sheet.meta;
  if (frameIndex < 0 || meta.frameW <= 0 || meta.frameH <= 0) return null;
  const idx = Math.min(Math.max(0, Math.floor(frameIndex)), Math.max(0, meta.frames - 1));
  const img = sheet.image as unknown as object;
  let per = FRAME_CANVAS.get(img);
  if (!per) {
    per = new Map();
    FRAME_CANVAS.set(img, per);
  }
  const hit = per.get(idx);
  if (hit) return hit;
  try {
    const c = createCanvas(meta.frameW, meta.frameH);
    const cx = ctx2d(c);
    cx.imageSmoothingEnabled = false;
    cx.clearRect(0, 0, meta.frameW, meta.frameH);
    cx.drawImage(sheet.image, idx * meta.frameW, 0, meta.frameW, meta.frameH, 0, 0, meta.frameW, meta.frameH);
    per.set(idx, c);
    return c;
  } catch {
    return null;
  }
}

// ───────────────────────── 그리기 헬퍼 ─────────────────────────

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 이펙트 시트 한 장을 그린다 (v0.9 설계 [5]).
 *  - (x, y) 에 시트 메타의 anchor 가 놓인다. scale 은 1 = 원본 픽셀 크기(1 유닛 = 32px 캔버스 기준).
 *  - rotationRad 는 anchor 를 중심으로 한 회전 (투사체 진행 방향 등). 0 이면 픽셀 정렬을 위해 좌표를 정수로 내린다.
 *  - blend 가 'add' 면 가산 합성(`lighter`)으로 그린다.
 *  - 비반복(loop false) 시트의 재생이 끝났으면 (`fxFrameAt` < 0) 아무것도 그리지 않는다.
 * 컨텍스트 상태는 저장·복원하므로 호출 전후 상태가 바뀌지 않는다.
 */
export function drawFx(
  ctx: CanvasRenderingContext2D,
  sheet: FxSheet,
  elapsedSec: number,
  x: number,
  y: number,
  scale = 1,
  rotationRad = 0,
  alpha = 1,
): void {
  if (!sheet || !sheet.image || !sheet.meta) return;
  const meta = sheet.meta;
  const fw = meta.frameW;
  const fh = meta.frameH;
  if (!(fw > 0) || !(fh > 0) || !(scale > 0)) return;
  const a = clamp01(alpha);
  if (a <= 0) return;
  const frame = fxFrameIndex(sheet, elapsedSec);
  if (frame < 0) return;
  const col = Math.min(Math.max(0, Math.floor(frame)), Math.max(0, meta.frames - 1));
  ctx.save();
  try {
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = a;
    if (meta.blend === 'add') ctx.globalCompositeOperation = 'lighter';
    if (rotationRad === 0) {
      ctx.translate(Math.round(x), Math.round(y));
    } else {
      ctx.translate(x, y);
      ctx.rotate(rotationRad);
    }
    if (scale !== 1) ctx.scale(scale, scale);
    ctx.drawImage(sheet.image, col * fw, 0, fw, fh, -meta.anchor.x, -meta.anchor.y, fw, fh);
  } catch {
    /* 깨진 이미지: 이 프레임만 건너뛴다 */
  }
  ctx.restore();
}

// ───────────────────────── 키 만들기 ─────────────────────────

/** 피격 폭발 키 (MagicSchool 입력. 'none' → impact_phys) */
export function impactFxKey(school: MagicSchool): FxKey {
  return fxImpactKey(fxSchoolOfMagic(school));
}
/** 시전 키 (MagicSchool 입력) */
export function castFxKey(school: MagicSchool): FxKey {
  return fxCastKey(fxSchoolOfMagic(school));
}
/**
 * 영역 테두리 키. 반경마다 '실제 크기 그대로' 만든 원이라 **반경까지 넣어야** 키가 정해진다
 * (zone_ring_fire_r35 = 반경 3.5 화염). neutral(맵 기믹)은 계열과 무관하게 zone_ring_neutral_r**.
 * 정확히 맞는 키가 없으면 같은 계열에서 가장 가까운 반경의 키가 나온다 (그때만 배율이 1 이 아니다).
 */
export function zoneRingFxKey(school: MagicSchool, neutral: boolean, radiusUnits: number): FxKey {
  return ringFxKey(fxSchoolOfMagic(school), radiusUnits, neutral);
}

/** 테두리 키를 실제 반경에 맞추는 배율. 정확히 맞는 키면 1 (늘리지 않는다) */
export function zoneRingFxScale(key: FxKey, radiusUnits: number): number {
  return ringFxScale(key, radiusUnits);
}
/** 영역 내부 타일 키 */
export function zoneFillFxKey(school: MagicSchool, neutral: boolean): FxKey {
  return fxZoneFillKey(neutral ? 'neutral' : fxSchoolOfMagic(school));
}

/** 스킬 id → 이능 계열. 물리 스킬·모르는 id 는 'none' */
export function schoolOfSkill(skillId: string | undefined | null): MagicSchool {
  if (!skillId) return 'none';
  try {
    const sk = getSkill(skillId);
    const dmg = sk.effects.find((e) => e.kind === 'damage');
    if (dmg && dmg.kind === 'damage') {
      if (dmg.school === 'phys') return 'none';
      return dmg.magic ?? sk.magic ?? 'none';
    }
    return sk.magic ?? 'none';
  } catch {
    return 'none';
  }
}

/** 스킬 시전 시간 (초). 모르는 id 는 0 */
function castTimeOf(skillId: string): number {
  try {
    const t = getSkill(skillId).castTimeSec;
    return Number.isFinite(t) && t > 0 ? t : 0;
  } catch {
    return 0;
  }
}

/** 공격자 직업 → 투사체 종류 */
function projectileKindOf(job: MainJob | 'summon'): ProjectileKind {
  switch (job) {
    case 'archer':
      return 'arrow';
    case 'sniper':
      return 'bullet';
    case 'mage':
    case 'summoner':
    case 'healer':
      return 'orb';
    case 'summon':
      return 'spark';
    default:
      return 'spark';
  }
}

/** 마력구 계열 (proj_orb_<school> 은 마법 6계열만 있다. 물리 계열은 없다) */
function orbSchoolOf(u: UnitSnapshot): Exclude<FxSchool, 'phys'> {
  switch (u.subJob) {
    case 'mage_fire':
      return 'fire';
    case 'mage_lightning':
      return 'lightning';
    case 'mage_ice':
      return 'ice';
    // 사령술사·그림자 계열은 어둠 마력구를 쏜다 (proj_orb_shadow)
    case 'summoner_necro':
    case 'assassin_shadow':
      return 'shadow';
    default:
      break;
  }
  switch (u.job) {
    case 'healer':
      return 'holy';
    case 'summoner':
      return 'nature';
    case 'mage':
      return 'fire';
    default:
      return 'holy';
  }
}

function projectileFxKey(u: UnitSnapshot, proj: ProjectileKind): FxKey {
  switch (proj) {
    case 'arrow':
      return 'proj_arrow';
    case 'bullet':
      return 'proj_bullet';
    case 'orb':
      return projOrbFxKey(orbSchoolOf(u));
    default:
      return 'proj_bullet';
  }
}

/** 근접 베기 종류: 양손 큰 동작 / 찌르기 / 빠른 한 손 */
function slashFxKey(job: MainJob | 'summon', heavy: boolean): FxKey {
  if (heavy) return 'slash_heavy';
  switch (job) {
    case 'berserker':
    case 'tank':
      return 'slash_heavy';
    case 'assassin':
    case 'archer':
    case 'sniper':
      return 'slash_pierce';
    default:
      return 'slash_light';
  }
}

/**
 * 발밑에 `buff_ring` 을 깔 '이로운 상태'.
 * core 의 `buff` 효과(파생 수치 % 보정)는 `UnitSnapshot.statuses` 에 나타나지 않으므로,
 * 스냅샷에서 볼 수 있는 이로운 지속 상태만 모은다. 보호막은 전용 `status_shield` 가 따로 있어 제외하고,
 * 패시브로 영구히 붙는 것도 제외한다 (`isTemporaryBuff`).
 */
const BUFF_STATUS_KINDS: readonly StatusKind[] = ['regen', 'lifesteal', 'reflect', 'invuln'];

/**
 * 이보다 오래 남은 상태는 '영구'로 본다. sim 은 패시브 상태의 남은 시간을 9999초로 채우고
 * 스킬이 거는 버프는 길어야 10초 안쪽이라, 60초면 둘을 안전하게 가른다.
 */
const PERMANENT_STATUS_SEC = 60;

function isTemporaryBuff(kind: StatusKind, remainingSec: number): boolean {
  if (!(remainingSec > 0) || remainingSec >= PERMANENT_STATUS_SEC) return false;
  for (let i = 0; i < BUFF_STATUS_KINDS.length; i++) if (BUFF_STATUS_KINDS[i] === kind) return true;
  return false;
}

function projectileColorOf(u: UnitSnapshot): string {
  if (u.job === 'summon') return '#ffffff';
  const pal = JOB_PALETTE[u.job];
  return pal ? pal.glow : '#ffffff';
}

/** 2px 격자에 맞춘 사각형 */
function px2(ctx: CanvasRenderingContext2D, x: number, y: number, size = 2): void {
  ctx.fillRect(Math.floor(x / 2) * 2, Math.floor(y / 2) * 2, size, size);
}

// ───────────────────────── 이펙트 시스템 ─────────────────────────

export class EffectSystem {
  private effects: Effect[] = [];
  private seq = 0;
  /** 프레임 상태 이펙트(시전·상태)의 남은 예산. drawUnitFxUnder 에서 리셋하고 Over 까지 이어 쓴다 */
  private unitFxBudget = MAX_UNIT_FX;

  clear(): void {
    this.effects = [];
    this.unitFxBudget = MAX_UNIT_FX;
  }

  /** 이번 틱 이벤트를 받아들인다 (틱당 한 번). byId 는 현재 프레임의 유닛 */
  ingest(events: readonly BattleEvent[], byId: Map<string, UnitSnapshot>): void {
    for (const e of events) {
      const seed = ++this.seq;
      switch (e.kind) {
        case 'attack': {
          const to = byId.get(e.to);
          if (!to) break;
          const from = byId.get(e.from);
          if (e.skillId) {
            if (!e.miss) {
              const school = schoolOfSkill(e.skillId);
              const key = impactFxKey(school);
              this.push({
                kind: 'burst', born: e.t, life: BURST_SEC, fxLife: fxLifeOf(key, BURST_SEC), x: to.x, y: to.y - 0.6,
                school, count: e.crit ? 16 : 11, speed: e.crit ? 3.2 : 2.4, seed, blizzard: false,
                fxKey: key, scale: e.crit ? 1.2 : 1,
              });
              // 물리 계열 근접 스킬은 큰 베기 동작을 겹친다
              if (school === 'none' && from) {
                const d = Math.hypot(to.x - from.x, to.y - from.y);
                if (d <= RANGED_DIST) this.pushSlash(e.t, from, to, true, e.crit, seed);
              }
              if (e.crit) this.pushFx(e.t, 'crit_star', to.x, to.y - 1.1, 1, 0.2);
            }
            break;
          }
          if (!from) {
            if (!e.miss) this.pushSpark(e.t, to.x, to.y, 'none', 4, seed);
            break;
          }
          const dist = Math.hypot(to.x - from.x, to.y - from.y);
          if (dist > RANGED_DIST) {
            const proj = projectileKindOf(from.job);
            const fxKey = projectileFxKey(from, proj);
            this.push({
              kind: 'projectile', born: e.t, life: PROJECTILE_SEC, fxLife: PROJECTILE_SEC + SPARK_SEC,
              x: from.x, y: from.y - 0.9, tx: to.x, ty: to.y - 0.7,
              proj, color: projectileColorOf(from), seed, hit: !e.miss,
              fxKey, impactKey: impactFxKey('none'),
            });
          } else {
            this.pushSlash(e.t, from, to, false, e.crit, seed);
            if (!e.miss) this.pushSpark(e.t, to.x, to.y - 0.6, 'none', e.crit ? 6 : 3, seed + 1);
          }
          if (e.crit && !e.miss) this.pushFx(e.t, 'crit_star', to.x, to.y - 1.1, 1, 0.2);
          break;
        }
        case 'skill': {
          const u = byId.get(e.from);
          const x = u ? u.x : e.x;
          const y = u ? u.y : e.y;
          // 시전 중 연출은 프레임 상태(cast_*)가 담당한다. 이 링은 '시전 완료' 순간의 폴백 표시
          this.push({ kind: 'castRing', born: e.t, life: CAST_RING_SEC, fxLife: CAST_RING_SEC, x, y, school: schoolOfSkill(e.skillId), seed });
          break;
        }
        case 'zone_damage': {
          if (Math.round(e.t * 20) % 4 !== 0) break; // 틱마다 오므로 0.2초에 한 번만
          const to = byId.get(e.to);
          if (!to) break;
          this.pushSpark(e.t, to.x, to.y - 0.5, schoolOfSkill(e.skillId), 3, seed);
          break;
        }
        case 'hazard_damage': {
          const to = byId.get(e.to);
          if (!to) break;
          if (e.phase === 'impact') {
            const key = impactFxKey(e.school);
            this.push({
              kind: 'burst', born: e.t, life: BURST_SEC, fxLife: fxLifeOf(key, BURST_SEC), x: to.x, y: to.y - 0.4,
              school: e.school, count: 12, speed: 2.6, seed, blizzard: e.school === 'ice', fxKey: key, scale: 1,
            });
          } else if (Math.round(e.t * 20) % 5 === 0) {
            this.pushSpark(e.t, to.x, to.y - 0.5, e.school, 2, seed);
          }
          break;
        }
        case 'dot': {
          if (Math.round(e.t * 20) % 5 !== 0) break;
          const to = byId.get(e.to);
          if (!to) break;
          this.pushSpark(e.t, to.x, to.y - 0.8, e.status === 'burn' ? 'fire' : 'nature', 2, seed);
          break;
        }
        case 'reflect': {
          const to = byId.get(e.to);
          if (!to) break;
          this.pushSpark(e.t, to.x, to.y - 0.6, 'holy', 4, seed);
          break;
        }
        case 'heal': {
          const to = byId.get(e.to);
          if (!to) break;
          this.push({ kind: 'heal', born: e.t, life: HEAL_SEC, fxLife: fxLifeOf('heal_burst', HEAL_SEC), x: to.x, y: to.y, seed, fxKey: 'heal_burst' });
          break;
        }
        case 'dodge': {
          const u = byId.get(e.unit);
          if (!u) break;
          // '회피!' 텍스트는 오버레이가 계속 그린다. 여기서는 발밑 먼지만 얹는다
          this.pushFx(e.t, 'dodge_puff', u.x, u.y, 1, 0.25);
          break;
        }
        case 'kill': {
          const v = byId.get(e.victim);
          if (!v) break;
          this.pushFx(e.t, 'death_poof', v.x, v.y, 1, 0.42);
          break;
        }
        case 'summon': {
          const s = byId.get(e.unitId) ?? byId.get(e.owner);
          if (!s) break;
          this.pushFx(e.t, 'summon_circle', s.x, s.y, 1, 0.6);
          break;
        }
        default:
          break;
      }
    }
  }

  private pushSpark(t: number, x: number, y: number, school: MagicSchool, count: number, seed: number): void {
    this.push({ kind: 'spark', born: t, life: SPARK_SEC, fxLife: SPARK_SEC, x, y, school, count, seed });
  }

  /** 근접 베기. anchor 가 시전자 손 위치라 (hx, hy) 에서 대상 방향으로 회전한다 */
  private pushSlash(t: number, from: UnitSnapshot, to: UnitSnapshot, heavy: boolean, crit: boolean, seed: number): void {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const key = slashFxKey(from.job, heavy);
    this.push({
      kind: 'slash', born: t, life: SLASH_SEC, fxLife: fxLifeOf(key, SLASH_SEC),
      x: to.x, y: to.y - 0.6, hx: from.x, hy: from.y - 0.8, angle,
      color: crit ? '#ffd54a' : '#ffffff', seed, fxKey: key,
    });
  }

  /** 시트가 없으면 아무것도 그리지 않는 순수 fx (치명타·회피·사망·소환) */
  private pushFx(t: number, key: FxKey, x: number, y: number, scale: number, fallbackSec: number, rot = 0, alpha = 1): void {
    const life = fxLifeOf(key, fallbackSec);
    this.push({ kind: 'fx', born: t, life, fxLife: life, x, y, fxKey: key, scale, rot, alpha });
  }

  private push(e: Effect): void {
    this.effects.push(e);
    if (this.effects.length > MAX_EFFECTS) this.effects.splice(0, this.effects.length - MAX_EFFECTS);
  }

  /**
   * 지금 시점의 fx 재생 길이. `fxLife` 는 ingest 순간의 시트 길이라, 외부 에셋이 그 뒤에 로드돼
   * 프레임 수·fps 가 달라지면 값이 어긋난다. 매번 현재 시트로 다시 재어 뒷부분이 잘리지 않게 한다.
   */
  private fxLifeNow(e: Effect): number {
    switch (e.kind) {
      case 'projectile':
        // 비행(life) 이 끝난 뒤 도착 지점에서 impact 시트 한 바퀴를 더 재생한다
        return e.life + fxSheetDuration(tryFx(e.impactKey), SPARK_SEC);
      case 'slash':
      case 'burst':
      case 'heal':
      case 'fx':
        return fxSheetDuration(tryFx(e.fxKey), e.fxLife);
      default:
        return e.fxLife;
    }
  }

  /** 끝난 이펙트 제거. 투사체는 도착 후 충돌 연출까지 남긴다 */
  prune(now: number): void {
    this.effects = this.effects.filter((e) => {
      const extra = e.kind === 'projectile' ? SPARK_SEC : 0;
      const life = Math.max(e.life + extra, this.fxLifeNow(e));
      return now - e.born < life && now >= e.born;
    });
  }

  /** 디버그·테스트용: 현재 유지 중인 이벤트 이펙트 수 */
  get size(): number {
    return this.effects.length;
  }

  /**
   * 오프스크린 픽셀 캔버스에 그린다.
   * @param toX/toY 맵 좌표 → 오프스크린 px
   * @param px 1 유닛의 px
   */
  draw(ctx: CanvasRenderingContext2D, now: number, toX: (x: number) => number, toY: (y: number) => number, px: number): void {
    if (this.effects.length === 0) return;
    const fxScale = px / FX_PIXELS_PER_UNIT;
    ctx.save();
    for (const e of this.effects) {
      const age = now - e.born;
      if (age < 0) continue;
      switch (e.kind) {
        case 'projectile':
          this.drawProjectile(ctx, e, age, toX, toY, px, fxScale);
          break;
        case 'slash': {
          const sheet = tryFx(e.fxKey);
          if (sheet) drawFx(ctx, sheet, age, toX(e.hx), toY(e.hy), fxScale, e.angle, 1);
          else this.drawSlash(ctx, e, age, toX, toY, px);
          break;
        }
        case 'burst': {
          const sheet = tryFx(e.fxKey);
          if (sheet) drawFx(ctx, sheet, age, toX(e.x), toY(e.y), fxScale * e.scale, 0, 1);
          else this.drawBurst(ctx, e, age, toX, toY, px);
          break;
        }
        case 'spark':
          this.drawSpark(ctx, e, age, toX, toY, px);
          break;
        case 'castRing':
          this.drawCastRing(ctx, e, age, toX, toY, px);
          break;
        case 'heal': {
          const sheet = tryFx(e.fxKey);
          if (sheet) drawFx(ctx, sheet, age, toX(e.x), toY(e.y - 0.8), fxScale, 0, 1);
          else this.drawHeal(ctx, e, age, toX, toY, px);
          break;
        }
        case 'fx': {
          const sheet = tryFx(e.fxKey);
          if (sheet) drawFx(ctx, sheet, age, toX(e.x), toY(e.y), fxScale * e.scale, e.rot, e.alpha);
          break;
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // ───── 프레임 상태 이펙트 (시전·상태이상) ─────

  /**
   * 유닛보다 **아래** 에 깔리는 프레임 상태 이펙트: 시전 중 `cast_<school>`(발밑), `status_freeze` / `status_shield`(발밑),
   * 이로운 지속 상태의 `buff_ring`(발밑).
   * 프레임마다 예산(MAX_UNIT_FX)을 리셋하므로 `drawUnitFxOver` 보다 **먼저** 불러야 한다.
   */
  drawUnitFxUnder(
    ctx: CanvasRenderingContext2D,
    units: readonly UnitSnapshot[],
    now: number,
    toX: (x: number) => number,
    toY: (y: number) => number,
    px: number,
  ): void {
    this.unitFxBudget = MAX_UNIT_FX;
    const fxScale = px / FX_PIXELS_PER_UNIT;
    for (const u of units) {
      if (!u.alive) continue;
      if (this.unitFxBudget <= 0) return;
      if (u.casting) {
        const sheet = tryFx(castFxKey(schoolOfSkill(u.casting.skillId)));
        if (sheet) {
          const dur = castTimeOf(u.casting.skillId);
          const elapsed = dur > 0 ? clamp01(u.casting.progress) * dur : now;
          drawFx(ctx, sheet, elapsed, toX(u.x), toY(u.y), fxScale, 0, 0.9);
          this.unitFxBudget -= 1;
        }
      }
      let buffed = false;
      for (const st of u.statuses) {
        if (this.unitFxBudget <= 0) return;
        const key = st.kind === 'freeze' ? statusFxKey('freeze') : st.kind === 'shield' ? statusFxKey('shield') : null;
        if (!key) {
          // 패시브로 항상 붙어 있는 상태는 제외한다. 계속 켜져 있으면 연출이 아니라 잡음이다
          if (isTemporaryBuff(st.kind, st.remainingSec)) buffed = true;
          continue;
        }
        const sheet = tryFx(key);
        if (!sheet) continue;
        drawFx(ctx, sheet, now, toX(u.x), toY(u.y), fxScale, 0, 0.85);
        this.unitFxBudget -= 1;
      }
      // 이로운 지속 상태(재생·흡혈·반사·무적)는 발밑에 고리 하나만 (상태 수와 무관하게 1장)
      if (buffed && this.unitFxBudget > 0) {
        const sheet = tryFx('buff_ring');
        if (sheet) {
          drawFx(ctx, sheet, now, toX(u.x), toY(u.y), fxScale, 0, 0.7);
          this.unitFxBudget -= 1;
        }
      }
    }
  }

  /**
   * 유닛보다 **위** 에 얹는 프레임 상태 이펙트: `status_stun` / `status_burn` (머리 위).
   * headUnitsOf 는 발 위치에서 머리까지의 거리(맵 단위).
   */
  drawUnitFxOver(
    ctx: CanvasRenderingContext2D,
    units: readonly UnitSnapshot[],
    now: number,
    toX: (x: number) => number,
    toY: (y: number) => number,
    px: number,
    headUnitsOf: (u: UnitSnapshot) => number,
  ): void {
    const fxScale = px / FX_PIXELS_PER_UNIT;
    for (const u of units) {
      if (!u.alive) continue;
      if (this.unitFxBudget <= 0) return;
      let stun = false;
      let burn = false;
      for (const st of u.statuses) {
        if (st.kind === 'stun') stun = true;
        else if (st.kind === 'burn') burn = true;
      }
      if (!stun && !burn) continue;
      const head = headUnitsOf(u);
      const both = stun && burn;
      if (stun && this.unitFxBudget > 0) {
        const sheet = tryFx(statusFxKey('stun'));
        if (sheet) {
          drawFx(ctx, sheet, now, toX(u.x - (both ? 0.35 : 0)), toY(u.y - head - 0.35), fxScale, 0, 1);
          this.unitFxBudget -= 1;
        }
      }
      if (burn && this.unitFxBudget > 0) {
        const sheet = tryFx(statusFxKey('burn'));
        if (sheet) {
          drawFx(ctx, sheet, now, toX(u.x + (both ? 0.35 : 0)), toY(u.y - head - 0.35), fxScale, 0, 1);
          this.unitFxBudget -= 1;
        }
      }
    }
  }

  // ───── 폴백 파티클 (fx 시트를 못 쓸 때) ─────

  private drawProjectile(
    ctx: CanvasRenderingContext2D,
    e: Extract<Effect, { kind: 'projectile' }>,
    age: number,
    toX: (x: number) => number,
    toY: (y: number) => number,
    px: number,
    fxScale: number,
  ): void {
    if (age >= e.life) {
      // 도착: 작은 충돌 (빗나가면 없음)
      if (!e.hit) return;
      const a2 = age - e.life;
      const impact = tryFx(e.impactKey);
      if (impact) {
        drawFx(ctx, impact, a2, toX(e.tx), toY(e.ty), fxScale * 0.6, 0, 1);
        return;
      }
      const pal = MAGIC_SCHOOL_COLOR.none;
      const cx = toX(e.tx);
      const cy = toY(e.ty);
      const n = 4;
      for (let i = 0; i < n; i++) {
        const ang = hashNoise(i, e.seed, 7) * Math.PI * 2;
        const d = (0.15 + a2 * 1.6) * px;
        ctx.globalAlpha = Math.max(0, 1 - a2 / SPARK_SEC);
        ctx.fillStyle = a2 < SPARK_SEC * 0.4 ? pal.core : pal.main;
        px2(ctx, cx + Math.cos(ang) * d, cy + Math.sin(ang) * d, 2);
      }
      return;
    }
    const t = age / e.life;
    const x = e.x + (e.tx - e.x) * t;
    const y = e.y + (e.ty - e.y) * t - Math.sin(Math.PI * t) * (e.proj === 'arrow' ? 0.5 : 0.15);
    const dx = e.tx - e.x;
    const dy = e.ty - e.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const cx = toX(x);
    const cy = toY(y);

    const sheet = tryFx(e.fxKey);
    if (sheet) {
      // 진행 방향으로 회전해서 그린다 (anchor = 진행 방향 기준 중심)
      drawFx(ctx, sheet, age, cx, cy, fxScale, Math.atan2(dy, dx), 1);
      return;
    }

    ctx.globalAlpha = 1;
    switch (e.proj) {
      case 'arrow': {
        // 화살: 나무 대 3칸 + 흰 촉
        ctx.fillStyle = '#8c5a2b';
        for (let k = 1; k <= 3; k++) px2(ctx, cx - ux * k * 2, cy - uy * k * 2, 2);
        ctx.fillStyle = '#ffffff';
        px2(ctx, cx, cy, 2);
        ctx.fillStyle = '#d0d0d0';
        px2(ctx, cx - ux * 8 - uy * 2, cy - uy * 8 + ux * 2, 2);
        break;
      }
      case 'bullet': {
        // 탄환: 노란 3×3 + 꼬리
        ctx.fillStyle = '#ffe94a';
        px2(ctx, cx - 1, cy - 1, 3);
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = '#ffb347';
        px2(ctx, cx - ux * 3, cy - uy * 3, 2);
        ctx.globalAlpha = 0.3;
        px2(ctx, cx - ux * 6, cy - uy * 6, 2);
        break;
      }
      case 'orb': {
        // 마력구: 십자 5×5 + 흔들리는 꼬리
        ctx.fillStyle = e.color;
        px2(ctx, cx - 2, cy, 6);
        px2(ctx, cx, cy - 2, 2);
        px2(ctx, cx, cy + 2, 2);
        ctx.fillStyle = '#ffffff';
        px2(ctx, cx, cy, 2);
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = e.color;
        const wob = Math.sin(age * 40 + e.seed) * 2;
        px2(ctx, cx - ux * 5 - uy * wob, cy - uy * 5 + ux * wob, 2);
        px2(ctx, cx - ux * 9 + uy * wob, cy - uy * 9 - ux * wob, 2);
        break;
      }
      default: {
        ctx.fillStyle = '#ffffff';
        px2(ctx, cx, cy, 2);
        ctx.globalAlpha = 0.5;
        px2(ctx, cx - ux * 3, cy - uy * 3, 2);
      }
    }
  }

  private drawSlash(
    ctx: CanvasRenderingContext2D,
    e: Extract<Effect, { kind: 'slash' }>,
    age: number,
    toX: (x: number) => number,
    toY: (y: number) => number,
    px: number,
  ): void {
    const p = Math.min(1, age / e.life);
    const cx = toX(e.x);
    const cy = toY(e.y);
    const r = px * 0.65;
    const sweep = Math.PI * 0.7;
    const n = 9;
    ctx.fillStyle = e.color;
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      // 호가 순서대로 나타났다가 사라진다
      const show = f < p * 1.4 && f > (p - 0.45) * 1.4;
      if (!show) continue;
      const ang = e.angle - sweep / 2 + sweep * f;
      ctx.globalAlpha = 0.95 - 0.5 * f;
      px2(ctx, cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, i % 2 === 0 ? 3 : 2);
    }
  }

  private drawBurst(
    ctx: CanvasRenderingContext2D,
    e: Extract<Effect, { kind: 'burst' }>,
    age: number,
    toX: (x: number) => number,
    toY: (y: number) => number,
    px: number,
  ): void {
    const p = Math.min(1, age / e.life);
    const pal: SchoolPalette = MAGIC_SCHOOL_COLOR[e.school] ?? MAGIC_SCHOOL_COLOR.none;
    const cx = toX(e.x);
    const cy = toY(e.y);
    // 중심 섬광 (짧게)
    if (p < 0.25) {
      ctx.globalAlpha = 1 - p / 0.25;
      ctx.fillStyle = pal.core;
      const sz = 6 + Math.round(p * 20);
      px2(ctx, cx - sz / 2, cy - sz / 2, sz);
    }
    for (let i = 0; i < e.count; i++) {
      const ang = hashNoise(i, e.seed, 3) * Math.PI * 2;
      const spd = e.speed * (0.5 + hashNoise(i, e.seed, 5)) * px;
      // 감속 + 약한 중력
      const d = spd * age * (1 - 0.45 * p);
      const gx = cx + Math.cos(ang) * d;
      const gy = cy + Math.sin(ang) * d * 0.8 + (e.school === 'fire' ? -age * px * 0.6 : age * age * px * 1.4);
      ctx.globalAlpha = Math.max(0, 1 - p * p);
      let color: string;
      if (e.blizzard) {
        color = BLIZZARD_COLORS[i % BLIZZARD_COLORS.length];
      } else {
        color = p < 0.3 ? pal.core : p < 0.65 ? pal.main : pal.dark;
      }
      ctx.fillStyle = color;
      const big = e.school === 'lightning' ? (i % 3 === 0 ? 3 : 2) : i % 4 === 0 ? 3 : 2;
      px2(ctx, gx, gy, big);
      // 전기: 지그재그 꼬리
      if (e.school === 'lightning' && p < 0.5) {
        const zz = i % 2 === 0 ? 2 : -2;
        px2(ctx, gx - Math.cos(ang) * 4 + zz, gy - Math.sin(ang) * 4, 2);
      }
    }
  }

  private drawSpark(
    ctx: CanvasRenderingContext2D,
    e: Extract<Effect, { kind: 'spark' }>,
    age: number,
    toX: (x: number) => number,
    toY: (y: number) => number,
    px: number,
  ): void {
    const p = Math.min(1, age / e.life);
    const pal: SchoolPalette = MAGIC_SCHOOL_COLOR[e.school] ?? MAGIC_SCHOOL_COLOR.none;
    const cx = toX(e.x);
    const cy = toY(e.y);
    for (let i = 0; i < e.count; i++) {
      const ang = hashNoise(i, e.seed, 9) * Math.PI * 2;
      const d = (0.1 + age * 1.8 * (0.5 + hashNoise(i, e.seed, 11))) * px;
      ctx.globalAlpha = Math.max(0, 1 - p);
      ctx.fillStyle = p < 0.4 ? pal.core : pal.main;
      px2(ctx, cx + Math.cos(ang) * d, cy + Math.sin(ang) * d * 0.7 - age * px * 0.5, 2);
    }
  }

  private drawCastRing(
    ctx: CanvasRenderingContext2D,
    e: Extract<Effect, { kind: 'castRing' }>,
    age: number,
    toX: (x: number) => number,
    toY: (y: number) => number,
    px: number,
  ): void {
    const p = Math.min(1, age / e.life);
    const pal: SchoolPalette = MAGIC_SCHOOL_COLOR[e.school] ?? MAGIC_SCHOOL_COLOR.none;
    const cx = toX(e.x);
    const cy = toY(e.y);
    const r = (0.35 + p * 0.9) * px;
    const n = 12;
    ctx.globalAlpha = Math.max(0, 1 - p);
    ctx.fillStyle = p < 0.4 ? pal.core : pal.main;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + e.seed;
      px2(ctx, cx + Math.cos(ang) * r, cy + Math.sin(ang) * r * 0.45, 2);
    }
  }

  private drawHeal(
    ctx: CanvasRenderingContext2D,
    e: Extract<Effect, { kind: 'heal' }>,
    age: number,
    toX: (x: number) => number,
    toY: (y: number) => number,
    px: number,
  ): void {
    const p = Math.min(1, age / e.life);
    const cx = toX(e.x);
    const cy = toY(e.y);
    const n = 6;
    for (let i = 0; i < n; i++) {
      const ox = (hashNoise(i, e.seed, 13) - 0.5) * 1.2 * px;
      const delay = hashNoise(i, e.seed, 17) * 0.3;
      const a = age - delay;
      if (a < 0) continue;
      const y = cy - a * px * 2.2 - 0.3 * px;
      ctx.globalAlpha = Math.max(0, 1 - p);
      ctx.fillStyle = i % 2 === 0 ? '#7cf59a' : '#ffffff';
      // 작은 십자
      px2(ctx, cx + ox, y, 2);
      if (i % 3 === 0) {
        px2(ctx, cx + ox - 2, y, 2);
        px2(ctx, cx + ox + 2, y, 2);
        px2(ctx, cx + ox, y - 2, 2);
        px2(ctx, cx + ox, y + 2, 2);
      }
    }
  }
}
