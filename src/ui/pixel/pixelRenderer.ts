/**
 * 도트 스프라이트 렌더러 (v0.7, 기본 모드). `IBattleRenderer` 구현. 간단 모드(`../render.ts`)와 같은 BattleFrame 을 소비한다.
 *
 * 파이프라인 (docs/SPRITES.md §7)
 *  1. 오프스크린 캔버스 (1 유닛 = PIXELS_PER_UNIT(32) px, 맵 + 사방 MAP_MARGIN_UNITS 여백):
 *     지형(terrain.ts, 캐시) → 어둠 맵 안개(시야로 뚫음) → 예고·장판(디더링) → 죽은 유닛 → 살아있는 유닛(y 오름차순)
 *     → 폭발 플래시 → 이펙트(effects.ts)
 *  2. 화면 캔버스로 `imageSmoothingEnabled = false` 로 확대·축소. 정수로 내려도 캔버스의 90% 이상을 채우면 정수 배율,
 *     아니면 소수 배율 최근접 보간 (검은 띠 최소화). 가운데 정렬.
 *  3. 화면 캔버스에 벡터 오버레이: HP·MP·시전 바, 상태 점, 이름표, 보호막 링, 영역 라벨, 플로팅 텍스트·말풍선(BattleOverlay),
 *     전장 붕괴 배너, 전투 종료.
 *
 * 유닛 상태 → 애니메이션 (시뮬레이션 시간 기준, 배속·리플레이 동일)
 *  - alive false → death 1회 뒤 마지막 프레임 유지(반투명)
 *  - casting → cast (반복)
 *  - 최근 attack 애니메이션 길이(시트 메타 frames/fps, 기본 4/12 ≈ 0.33초) 안에 attack/skill 이벤트의 시전자 → attack 1회
 *  - 최근 HIT_ANIM_SEC 안에 피격(attack.to, miss 아님) → hit 1회 + HIT_FLASH_SEC 동안 흰 깜빡임
 *  - 이전 틱 대비 이동 → walk, 아니면 idle
 *  - facing 이 왼쪽(cos < 0)이면 좌우 반전
 *
 * 스프라이트 시트는 `SpriteProvider.resolveSheet(key, tint)` 로 매 프레임 조회한다 (비동기 로드가 끝나면 다음 프레임부터 바뀐다).
 * 제공자가 없거나 예외를 던지면 이 파일의 내장 자리표시(placeholder) 시트로 그린다 — 절대 멈추지 않는다.
 */
import type { BattleFrame, MapDef, MonsterTier, UnitSnapshot, ZoneSide, ZoneSnapshot } from '../../core/types';
import { MAP_MARGIN_UNITS } from '../../core/types';
import {
  BattleOverlay,
  HP_BAR_W,
  HP_BAR_W_DENSE,
  MONSTER_EDGE,
  TEAM_COLOR,
  TEAM_COLOR_LIGHT,
  ZONE_NEUTRAL_COLOR,
  ZONE_NEUTRAL_LIGHT,
  clamp01,
  drawAttritionBanner,
  drawFinishedOverlay,
  drawNameLabel,
  drawStatusDots,
  drawUnitBars,
  findBossIds,
  fitCanvasToMap,
  hexToRgba,
  isDenseFrame,
  nameFontPx,
  statusDotsHeight,
  traceZonePath,
  zoneCenter,
  type IBattleRenderer,
  type MonsterTierMap,
  type OverlayGeom,
} from '../render';
import { zoneLabel } from '../format';
import {
  DEFAULT_META,
  PIXELS_PER_UNIT,
  SUMMON_KINDS,
  animFinished,
  animFrameAt,
  spriteKeyForSummon,
  spriteKeyForUnit,
  type AnimName,
  type SpriteKey,
  type SpriteMeta,
  type SpriteSheet,
} from './spriteTypes';
import { BLIZZARD_COLORS, SIDE_COLOR, SIDE_MP_COLOR, tintForSubJob } from './palette';
import { drawJobIcon } from './icons';
import { buildTerrain, createCanvas, ctx2d, hashNoise, makeDitherPattern, type TerrainLayer } from './terrain';
import { EffectSystem } from './effects';

// ───────────────────────── 스프라이트 제공자 계약 ─────────────────────────

/**
 * 스프라이트 시트 제공자. 로더/생성기 모듈이 구현한다.
 *  - resolveSheet: **동기**. 외부 에셋이 로드됐으면 그것, 아니면 코드 생성 임시 시트. tint 는 세부 직업 틴트 색(hex) 또는 undefined.
 *    null/undefined 를 돌려주면 렌더러의 내장 자리표시 시트를 쓴다.
 *  - preload: 전투 시작 시 키 목록을 미리 적재 (선택).
 */
export interface SpriteProvider {
  resolveSheet(key: SpriteKey, tint?: string): SpriteSheet | null | undefined;
  preload?(keys: readonly SpriteKey[]): Promise<unknown> | void;
}

export interface PixelRendererOptions {
  /** 캐릭터 id → 몬스터 난이도 (몬스터 전투에서만) */
  monsters?: MonsterTierMap;
  sprites?: SpriteProvider | null;
}

/**
 * 1회 재생 애니메이션의 유지 시간 = 시트 메타의 frames / fps (+ε: 마지막 프레임이 최소 한 틱은 보이게).
 * 실제 판정은 유닛별 시트 메타(`animHoldSec`)로 하고, 아래 상수는 기본 메타 기준값(문서·테스트용)이다.
 */
const ANIM_HOLD_EPS = 1e-6;
export function animHoldSec(meta: SpriteMeta, anim: AnimName): number {
  const d = meta.anims[anim];
  return d.frames / d.fps + ANIM_HOLD_EPS;
}
/** attack 애니메이션이 유지되는 시간 (attack/skill 이벤트 뒤). 기본 메타: 4프레임 @ 12fps ≈ 0.333초 */
export const ATTACK_ANIM_SEC = animHoldSec(DEFAULT_META, 'attack');
/** hit 애니메이션 유지 시간. 기본 메타: 2프레임 @ 10fps = 0.2초 */
export const HIT_ANIM_SEC = animHoldSec(DEFAULT_META, 'hit');
/** 피격 흰 깜빡임 시간 */
export const HIT_FLASH_SEC = 0.12;
/** 죽은 뒤 마지막 프레임의 투명도 */
const DEAD_ALPHA = 0.55;
/** 은신 투명도 */
const STEALTH_ALPHA = 0.45;

/** 난이도별 스프라이트 배율. 보스는 BOSS_SPRITE_MULT 를 더 곱한다 */
const MONSTER_SPRITE_MULT: Record<MonsterTier, number> = { low: 1.0, mid: 1.12, high: 1.25 };
const BOSS_SPRITE_MULT = 1.3;
const SUMMON_SPRITE_MULT = 0.8;
const DENSE_SPRITE_MULT = 0.9;
const MAX_SPRITE_MULT = 1.8;

/** 오버레이: 발 위치에서 스프라이트 머리까지 (맵 단위, 배율 1 기준). 64px 시트에서 앵커 58 − 머리 여백 8 = 50px */
const SPRITE_HEAD_UNITS = 50 / PIXELS_PER_UNIT;

/** 어둠 맵 안개 색 */
const FOG_COLOR = 'rgba(4,8,22,0.62)';

/** 정수 배율로 내렸을 때 원래 배율의 이 비율 이상이면 정수 배율을 쓴다 (그 이하면 소수 배율 최근접 보간) */
export const INTEGER_SNAP_MIN = 0.9;

/**
 * (v0.8) 좌우 반전 최소 유지 시간 (시뮬레이션 초). 타겟이 좌우로 흔들려도 스프라이트가 덜덜 떨지 않게,
 * 마지막 반전 뒤 이 시간이 지나기 전에는 반전을 바꾸지 않는다.
 */
export const FLIP_HOLD_SEC = 0.3;

/** (v0.8) 직업 썸네일: HP 바 높이 배수 · 최소 크기 · 바와의 간격(px) */
const ICON_BAR_MULT = 1.9;
const ICON_MIN_PX = 9;
const ICON_BAR_MULT_DENSE = 1.6;
const ICON_MIN_PX_DENSE = 8;
const ICON_GAP_PX = 2;
/**
 * 밀집 프레임에서 '썸네일이 붙는 유닛'(= 살아있는 캐릭터. 몬스터·소환물은 애초에 썸네일이 없다)이
 * 이 수 이상이면 썸네일을 생략한다. 몬스터까지 세면 몬스터가 많은 밀집 전투에서 항상 이 수를 넘겨
 * 밀집 분기가 영영 실행되지 않는다 (v0.8 수정).
 */
const ICON_DENSE_SKIP_UNITS = 8;

interface UnitAnimState {
  anim: AnimName;
  startSec: number;
  lastX: number;
  lastY: number;
  moving: boolean;
  wasAlive: boolean;
  deathSec: number;
  lastAttackSec: number;
  lastHitSec: number;
  /** 현재 좌우 반전 상태 (true = 왼쪽을 본다) 와 마지막으로 바뀐 시각 */
  flip: boolean;
  lastFlipSec: number;
}

function newState(u: UnitSnapshot, now: number): UnitAnimState {
  return {
    anim: u.alive ? 'idle' : 'death',
    startSec: u.alive ? now : now - 100,
    lastX: u.x,
    lastY: u.y,
    moving: false,
    wasAlive: u.alive,
    deathSec: u.alive ? 0 : now - 100,
    lastAttackSec: -100,
    lastHitSec: -100,
    flip: Math.cos(u.facing) < 0,
    lastFlipSec: now - FLIP_HOLD_SEC,
  };
}

// ───────────────────────── 내장 자리표시 시트 ─────────────────────────

let placeholderSheet: SpriteSheet | null = null;

/**
 * 제공자가 없을 때 쓰는 최소 시트: 회색 인형 (머리·몸·다리), 6행 × 6열, 열마다 팔·다리 위치가 조금씩 다르다.
 * 진짜 임시 스프라이트는 제공자 모듈이 만든다. 이것은 안전망이다.
 */
function getPlaceholderSheet(): SpriteSheet {
  if (placeholderSheet) return placeholderSheet;
  const fw = DEFAULT_META.frameW;
  const fh = DEFAULT_META.frameH;
  const cols = 6;
  const rows = 6;
  const c = createCanvas(fw * cols, fh * rows);
  const ctx = ctx2d(c);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const ox = col * fw;
      const oy = row * fh;
      const bob = row === 1 ? (col % 2) * 2 : row === 0 ? (col % 2) : 0;
      const lean = row === 2 ? col * 2 : row === 4 ? -3 : 0;
      const fall = row === 5 ? Math.min(3, col) * 6 : 0;
      ctx.fillStyle = '#15121c';
      // 외곽선 포함 몸통
      ctx.fillRect(ox + 22 + lean, oy + 24 + bob + fall, 20, 26);
      ctx.fillStyle = '#7a7f8c';
      ctx.fillRect(ox + 24 + lean, oy + 26 + bob + fall, 16, 22);
      // 머리
      ctx.fillStyle = '#15121c';
      ctx.fillRect(ox + 24 + lean, oy + 12 + bob + fall, 16, 14);
      ctx.fillStyle = '#e9bd8f';
      ctx.fillRect(ox + 26 + lean, oy + 14 + bob + fall, 12, 10);
      ctx.fillStyle = '#1a1220';
      ctx.fillRect(ox + 34 + lean, oy + 18 + bob + fall, 2, 2);
      // 다리
      const step = row === 1 ? (col % 3) * 2 : 0;
      ctx.fillStyle = '#15121c';
      ctx.fillRect(ox + 25 + lean - step, oy + 48 + fall, 6, 10);
      ctx.fillRect(ox + 33 + lean + step, oy + 48 + fall, 6, 10);
      ctx.fillStyle = '#3a3a44';
      ctx.fillRect(ox + 26 + lean - step, oy + 48 + fall, 4, 8);
      ctx.fillRect(ox + 34 + lean + step, oy + 48 + fall, 4, 8);
      // 팔 (공격 행은 앞으로 뻗음)
      const armX = row === 2 ? 40 + col * 3 : row === 3 ? 36 : 38;
      const armY = row === 2 ? 30 : row === 3 ? 20 - (col % 2) * 2 : 32 + bob;
      ctx.fillStyle = '#15121c';
      ctx.fillRect(ox + armX + lean, oy + armY + fall, 8, 6);
      ctx.fillStyle = '#e9bd8f';
      ctx.fillRect(ox + armX + 1 + lean, oy + armY + 1 + fall, 6, 4);
    }
  }
  placeholderSheet = { key: 'placeholder', image: c, meta: DEFAULT_META, tintable: false };
  return placeholderSheet;
}

// ───────────────────────── 렌더러 ─────────────────────────

export class PixelRenderer implements IBattleRenderer {
  private readonly screen: CanvasRenderingContext2D;
  private map: MapDef;
  private readonly monsters: MonsterTierMap;
  private sprites: SpriteProvider | null;

  private terrain: TerrainLayer;
  private readonly off: HTMLCanvasElement;
  private readonly offCtx: CanvasRenderingContext2D;
  private fog: HTMLCanvasElement | null = null;
  /** 피격 깜빡임·빙결 틴트용 임시 캔버스 */
  private readonly scratch: HTMLCanvasElement;
  private readonly scratchCtx: CanvasRenderingContext2D;

  private readonly overlay = new BattleOverlay();
  private readonly effects = new EffectSystem();
  private readonly states = new Map<string, UnitAnimState>();
  private bossIds: Set<string> | null = null;
  private dense = false;
  /** 이 프레임에서 직업 썸네일을 그릴지 (밀집 + 유닛 과다면 생략) */
  private icons = true;
  private lastTick = -1;
  private lastFrame: BattleFrame | null = null;

  /** 화면 배율 (오프스크린 px → 화면 px) 과 오프셋 */
  private scale = 1;
  private offX = 0;
  private offY = 0;

  constructor(private readonly canvas: HTMLCanvasElement, map: MapDef, opts: PixelRendererOptions = {}) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 컨텍스트를 만들 수 없습니다.');
    this.screen = ctx;
    this.map = map;
    this.monsters = opts.monsters ?? {};
    this.sprites = opts.sprites ?? null;
    this.terrain = buildTerrain(map);
    this.off = createCanvas(this.terrain.width, this.terrain.height);
    this.offCtx = ctx2d(this.off);
    this.scratch = createCanvas(DEFAULT_META.frameW, DEFAULT_META.frameH);
    this.scratchCtx = ctx2d(this.scratch);
    fitCanvasToMap(canvas, map);
    this.computeFit();
  }

  /** 스프라이트 제공자 교체 (로더가 늦게 준비되는 경우) */
  setSpriteProvider(p: SpriteProvider | null): void {
    this.sprites = p;
  }

  /** 새 전투 시작: 맵 교체 + 전투별 상태(애니메이션·보스·이펙트·플로팅 텍스트) 초기화 */
  setMap(map: MapDef): void {
    this.map = map;
    this.terrain = buildTerrain(map);
    this.off.width = this.terrain.width;
    this.off.height = this.terrain.height;
    this.offCtx.imageSmoothingEnabled = false;
    this.fog = null;
    this.states.clear();
    this.bossIds = null;
    this.dense = false;
    this.lastTick = -1;
    this.lastFrame = null;
    this.effects.clear();
    this.overlay.clear();
    fitCanvasToMap(this.canvas, map);
    this.computeFit();
  }

  resize(): void {
    fitCanvasToMap(this.canvas, this.map);
    this.computeFit();
    if (this.lastFrame) this.draw(this.lastFrame);
  }

  /** 전투 시작 시 이 프레임의 유닛 키 + 소환물 4종을 미리 적재한다 */
  preloadForFrame(frame: BattleFrame): void {
    const keys: SpriteKey[] = [];
    const seen = new Set<string>();
    for (const u of frame.units) {
      const k = spriteKeyForUnit(u);
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
    for (const kind of SUMMON_KINDS) {
      const k = spriteKeyForSummon(kind);
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
    this.preloadKeys(keys);
  }

  preloadKeys(keys: readonly SpriteKey[]): void {
    if (!this.sprites || !this.sprites.preload) return;
    try {
      const r = this.sprites.preload(keys);
      if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(() => undefined);
    } catch {
      /* 무시: 폴백 스프라이트로 그린다 */
    }
  }

  /**
   * 화면 캔버스 크기에 맞는 배율·오프셋.
   * 배율 ≥ 1 이고 정수로 내려도 캔버스의 INTEGER_SNAP_MIN 이상을 채우면 정수 배율(픽셀 완전 정렬), 아니면 그대로 최근접 보간.
   * (DPR 1.25~1.75 에서 무조건 내리면 맵이 캔버스의 53~74% 로 줄고 검은 띠가 생긴다 — 간단 모드와 같은 크기를 유지한다)
   */
  private computeFit(): void {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const raw = Math.min(W / this.terrain.width, H / this.terrain.height);
    const snapped = Math.floor(raw);
    this.scale = raw >= 1 && snapped / raw >= INTEGER_SNAP_MIN ? snapped : raw;
    this.offX = Math.round((W - this.terrain.width * this.scale) / 2);
    this.offY = Math.round((H - this.terrain.height * this.scale) / 2);
  }

  // ───── 좌표 ─────

  /** 맵 좌표 → 오프스크린 px */
  private px(x: number): number {
    return this.terrain.originX + x * PIXELS_PER_UNIT;
  }
  private py(y: number): number {
    return this.terrain.originY + y * PIXELS_PER_UNIT;
  }
  /** 맵 좌표 → 화면 px */
  private sx(x: number): number {
    return this.offX + this.px(x) * this.scale;
  }
  private sy(y: number): number {
    return this.offY + this.py(y) * this.scale;
  }
  /** 화면 px / 맵 유닛 */
  private get unitPx(): number {
    return PIXELS_PER_UNIT * this.scale;
  }

  private tierOf(u: UnitSnapshot): MonsterTier | null {
    if (u.job === 'summon') return null;
    return this.monsters[u.id] ?? null;
  }

  /** 스프라이트 배율 (소환물 작게, 몬스터는 난이도·보스에 따라 크게, 밀집 시 캐릭터 조금 작게) */
  private sizeMult(u: UnitSnapshot): number {
    if (u.job === 'summon') return SUMMON_SPRITE_MULT;
    const tier = this.tierOf(u);
    if (!tier) return this.dense ? DENSE_SPRITE_MULT : 1;
    let m = MONSTER_SPRITE_MULT[tier];
    if (this.bossIds?.has(u.id)) m *= BOSS_SPRITE_MULT;
    return Math.min(MAX_SPRITE_MULT, m);
  }

  // ───── 프레임 ─────

  draw(frame: BattleFrame): void {
    if (fitCanvasToMap(this.canvas, this.map)) this.computeFit();
    this.lastFrame = frame;
    const now = frame.timeSec;

    const byId = new Map<string, UnitSnapshot>();
    for (const u of frame.units) byId.set(u.id, u);

    if (!this.bossIds) this.bossIds = findBossIds(frame, this.monsters);
    this.dense = isDenseFrame(frame);
    // 썸네일 생략 판정은 실제로 썸네일이 붙는 유닛(살아있는 캐릭터)만 센다.
    // 죽은 유닛·몬스터·소환물까지 세면 밀집 전투에서는 언제나 한도를 넘어 썸네일이 통째로 사라진다.
    let iconUnits = 0;
    for (const u of frame.units) {
      if (!u.alive || u.job === 'summon' || this.tierOf(u) !== null) continue;
      iconUnits += 1;
    }
    this.icons = !this.dense || iconUnits < ICON_DENSE_SKIP_UNITS;

    if (frame.tick !== this.lastTick) {
      this.overlay.ingest(frame.events, byId);
      this.effects.ingest(frame.events, byId);
      this.advanceStates(frame, byId);
      this.lastTick = frame.tick;
    }
    this.overlay.prune(now);
    this.effects.prune(now);

    // 1. 오프스크린
    const o = this.offCtx;
    o.save();
    o.imageSmoothingEnabled = false;
    o.drawImage(this.terrain.canvas, 0, 0);
    if (this.map.visionRadius > 0) this.drawFog(frame);

    const zones: ZoneSnapshot[] = frame.zones ?? [];
    for (const z of zones) {
      if (z.phase === 'telegraph') this.drawTelegraph(o, z, now);
      else if (z.phase === 'active') this.drawLinger(o, z, now);
    }

    const dead = frame.units.filter((u) => !u.alive).sort((a, b) => a.y - b.y);
    const alive = frame.units.filter((u) => u.alive).sort((a, b) => a.y - b.y || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const u of dead) this.drawSprite(o, u, now);
    for (const u of alive) {
      this.drawFootMarker(o, u);
      this.drawSprite(o, u, now);
    }

    for (const z of zones) if (z.phase === 'flash') this.drawFlash(o, z);
    this.effects.draw(o, now, (x) => this.px(x), (y) => this.py(y), PIXELS_PER_UNIT);
    o.restore();

    // 2. 화면으로 확대·축소 (최근접)
    const s = this.screen;
    const W = this.canvas.width;
    const H = this.canvas.height;
    s.save();
    s.imageSmoothingEnabled = false;
    s.fillStyle = '#0b0e14';
    s.fillRect(0, 0, W, H);
    s.drawImage(this.off, 0, 0, this.off.width, this.off.height, this.offX, this.offY, this.off.width * this.scale, this.off.height * this.scale);
    s.restore();

    // 3. 벡터 오버레이
    s.save();
    for (const z of zones) if (z.phase === 'telegraph') this.drawZoneLabel(s, z);
    for (const u of dead) this.drawDeadLabel(s, u);
    for (const u of alive) this.drawUnitOverlay(s, u, frame);
    this.overlay.draw(s, now, byId, this.geom());
    drawAttritionBanner(s, frame.attritionPctPerSec ?? 0, now, W, H, this.unitPx);
    if (frame.finished) drawFinishedOverlay(s, W, H, this.unitPx);
    s.restore();
  }

  private geom(): OverlayGeom {
    return {
      toScreen: (x, y) => ({ x: this.sx(x), y: this.sy(y) }),
      unitPx: this.unitPx,
      width: this.canvas.width,
      height: this.canvas.height,
      floatLift: 1.9,
      bubbleAnchor: (u) => {
        const s = this.unitPx;
        const barH = Math.max(2, s * 0.28);
        const barTop = this.barTopOf(u, s, barH);
        const hasShield = u.statuses.some((st) => st.kind === 'shield');
        return { x: this.sx(u.x), y: barTop - (hasShield ? barH * 0.4 : 0) - statusDotsHeight(s) };
      },
    };
  }

  /** HP 바 위쪽 y (화면 px): 스프라이트 머리 위 */
  private barTopOf(u: UnitSnapshot, s: number, barH: number): number {
    const head = SPRITE_HEAD_UNITS * this.sizeMult(u);
    return this.sy(u.y) - (head + 0.2) * s - barH;
  }

  // ───── 애니메이션 상태 ─────

  private advanceStates(frame: BattleFrame, byId: Map<string, UnitSnapshot>): void {
    const now = frame.timeSec;
    for (const e of frame.events) {
      if (e.kind === 'attack') {
        const a = this.states.get(e.from) ?? (byId.get(e.from) ? this.ensureState(byId.get(e.from) as UnitSnapshot, now) : null);
        if (a) a.lastAttackSec = e.t;
        if (!e.miss) {
          const t = this.states.get(e.to) ?? (byId.get(e.to) ? this.ensureState(byId.get(e.to) as UnitSnapshot, now) : null);
          if (t) t.lastHitSec = e.t;
        }
      } else if (e.kind === 'skill') {
        const a = this.states.get(e.from) ?? (byId.get(e.from) ? this.ensureState(byId.get(e.from) as UnitSnapshot, now) : null);
        if (a) a.lastAttackSec = e.t;
      } else if (e.kind === 'hazard_damage' && e.phase === 'impact') {
        const t = this.states.get(e.to) ?? (byId.get(e.to) ? this.ensureState(byId.get(e.to) as UnitSnapshot, now) : null);
        if (t) t.lastHitSec = e.t;
      }
    }
    for (const u of frame.units) {
      const st = this.ensureState(u, now);
      const moved = Math.hypot(u.x - st.lastX, u.y - st.lastY) > 1e-3;
      st.moving = moved;
      st.lastX = u.x;
      st.lastY = u.y;

      let desired: AnimName;
      let start = now;
      if (!u.alive) {
        if (st.wasAlive) st.deathSec = now;
        desired = 'death';
        start = st.deathSec;
      } else if (u.casting) {
        desired = 'cast';
      } else if (now - st.lastAttackSec < this.holdSecFor(u, 'attack')) {
        desired = 'attack';
        start = st.lastAttackSec;
      } else if (now - st.lastHitSec < this.holdSecFor(u, 'hit')) {
        desired = 'hit';
        start = st.lastHitSec;
      } else if (moved) {
        desired = 'walk';
      } else {
        desired = 'idle';
      }
      st.wasAlive = u.alive;

      // 좌우 반전: FLIP_HOLD_SEC 이 지나야 바뀐다 (덜덜 떨림 방지)
      const wantFlip = Math.cos(u.facing) < 0;
      if (wantFlip !== st.flip && now - st.lastFlipSec >= FLIP_HOLD_SEC) {
        st.flip = wantFlip;
        st.lastFlipSec = now;
      }

      if (desired !== st.anim) {
        st.anim = desired;
        st.startSec = start;
      } else if ((desired === 'attack' || desired === 'hit') && start > st.startSec) {
        // 같은 애니메이션이 연속으로 다시 발동 → 처음부터
        st.startSec = start;
      }
    }
  }

  /** 이 유닛의 시트 메타 기준 1회 재생 유지 시간 (외부 시트가 프레임 수·fps 를 바꿔도 마지막 프레임까지 보인다) */
  private holdSecFor(u: UnitSnapshot, anim: 'attack' | 'hit'): number {
    return animHoldSec(this.sheetFor(u).meta, anim);
  }

  private ensureState(u: UnitSnapshot, now: number): UnitAnimState {
    let st = this.states.get(u.id);
    if (!st) {
      st = newState(u, now);
      this.states.set(u.id, st);
    }
    return st;
  }

  // ───── 시트 조회 ─────

  private sheetFor(u: UnitSnapshot): SpriteSheet {
    const key = spriteKeyForUnit(u);
    if (this.sprites) {
      try {
        const tint = u.job === 'summon' || this.tierOf(u) ? undefined : tintForSubJob(u.subJob);
        const sheet = this.sprites.resolveSheet(key, tint);
        if (sheet && sheet.image && sheet.meta) return sheet;
      } catch {
        /* 폴백 */
      }
    }
    return getPlaceholderSheet();
  }

  // ───── 오프스크린: 유닛 ─────

  /** 발밑 팀 색 타원 (A/B 구분). 몬스터는 난이도 색 테두리, 보스는 두 겹 */
  private drawFootMarker(o: CanvasRenderingContext2D, u: UnitSnapshot): void {
    const m = this.sizeMult(u);
    const cx = this.px(u.x);
    const cy = this.py(u.y);
    const rx = 9 * m;
    const ry = 4 * m;
    const tier = this.tierOf(u);
    const stealthed = u.statuses.some((st) => st.kind === 'stealth');
    o.save();
    o.globalAlpha = stealthed ? 0.3 : 0.75;
    o.beginPath();
    o.ellipse(cx, cy + 1, rx, ry, 0, 0, Math.PI * 2);
    o.fillStyle = u.job === 'summon' ? TEAM_COLOR_LIGHT[u.side] : TEAM_COLOR[u.side];
    o.fill();
    o.lineWidth = 2;
    o.strokeStyle = tier ? MONSTER_EDGE[tier] : 'rgba(0,0,0,0.55)';
    o.stroke();
    if (tier && this.bossIds?.has(u.id)) {
      o.beginPath();
      o.ellipse(cx, cy + 1, rx + 5, ry + 3, 0, 0, Math.PI * 2);
      o.setLineDash([4, 3]);
      o.strokeStyle = MONSTER_EDGE[tier];
      o.stroke();
    }
    o.restore();
  }

  private drawSprite(o: CanvasRenderingContext2D, u: UnitSnapshot, now: number): void {
    const st = this.states.get(u.id) ?? this.ensureState(u, now);
    const sheet = this.sheetFor(u);
    const meta = sheet.meta;
    const def = meta.anims[st.anim] ?? DEFAULT_META.anims[st.anim];
    const col = animFrameAt(def, st.startSec, now);
    const fw = meta.frameW;
    const fh = meta.frameH;
    const sxImg = col * fw;
    const syImg = def.row * fh;
    const m = this.sizeMult(u) * this.overlay.pulseOf(u.id, now);
    const flip = st.flip;

    const stealthed = u.statuses.some((s) => s.kind === 'stealth');
    const frozen = u.statuses.some((s) => s.kind === 'freeze');
    const flash = u.alive && now - st.lastHitSec >= 0 && now - st.lastHitSec < HIT_FLASH_SEC;
    let alpha = 1;
    if (!u.alive) alpha = animFinished(def, st.startSec, now) ? DEAD_ALPHA : 1;
    else if (stealthed) alpha = STEALTH_ALPHA;

    // 깜빡임·빙결 틴트가 필요하면 스크래치 캔버스를 거친다
    let src: CanvasImageSource = sheet.image;
    let srcX = sxImg;
    let srcY = syImg;
    if (flash || frozen) {
      if (this.scratch.width !== fw || this.scratch.height !== fh) {
        this.scratch.width = fw;
        this.scratch.height = fh;
        this.scratchCtx.imageSmoothingEnabled = false;
      }
      const sc = this.scratchCtx;
      sc.save();
      sc.clearRect(0, 0, fw, fh);
      sc.drawImage(sheet.image, sxImg, syImg, fw, fh, 0, 0, fw, fh);
      sc.globalCompositeOperation = 'source-atop';
      sc.fillStyle = flash ? 'rgba(255,255,255,0.85)' : 'rgba(110,200,255,0.5)';
      sc.fillRect(0, 0, fw, fh);
      sc.restore();
      src = this.scratch;
      srcX = 0;
      srcY = 0;
    }

    const ax = meta.anchor.x * m;
    const ay = meta.anchor.y * m;
    const dw = fw * m;
    const dh = fh * m;
    const cx = Math.round(this.px(u.x));
    const cy = Math.round(this.py(u.y));

    o.save();
    o.globalAlpha = alpha;
    o.imageSmoothingEnabled = false;
    o.translate(cx, cy);
    if (flip) o.scale(-1, 1);
    o.drawImage(src, srcX, srcY, fw, fh, Math.round(-ax), Math.round(-ay), Math.round(dw), Math.round(dh));
    o.restore();

    // 기절: 머리 위를 도는 노란 점
    if (u.alive && u.statuses.some((s) => s.kind === 'stun')) {
      o.fillStyle = '#ffd54a';
      for (let i = 0; i < 3; i++) {
        const ang = now * 6 + (i * Math.PI * 2) / 3;
        o.fillRect(Math.round(cx + Math.cos(ang) * 8) - 1, Math.round(cy - ay - 4 + Math.sin(ang) * 3) - 1, 2, 2);
      }
    }
  }

  // ───── 오프스크린: 안개 (어둠 맵) ─────

  private drawFog(frame: BattleFrame): void {
    if (!this.fog) this.fog = createCanvas(this.terrain.width, this.terrain.height);
    const f = ctx2d(this.fog);
    const ox = this.terrain.originX;
    const oy = this.terrain.originY;
    const mw = this.map.width * PIXELS_PER_UNIT;
    const mh = this.map.height * PIXELS_PER_UNIT;
    f.save();
    f.clearRect(0, 0, this.fog.width, this.fog.height);
    f.fillStyle = FOG_COLOR;
    f.fillRect(ox, oy, mw, mh);
    // 안개 얼룩 (디더)
    const dot = makeDitherPattern(f, 'rgba(2,4,14,0.5)', 1);
    if (dot) {
      f.fillStyle = dot;
      f.fillRect(ox, oy, mw, mh);
    }
    f.globalCompositeOperation = 'destination-out';
    const vr = this.map.visionRadius * PIXELS_PER_UNIT;
    for (const u of frame.units) {
      if (!u.alive) continue;
      const cx = this.px(u.x);
      const cy = this.py(u.y);
      f.beginPath();
      f.arc(cx, cy, vr, 0, Math.PI * 2);
      f.fillStyle = '#000';
      f.fill();
      // 가장자리 디더 링
      const ring = makeDitherPattern(f, '#000000', 2);
      if (ring) {
        f.beginPath();
        f.arc(cx, cy, vr + 10, 0, Math.PI * 2);
        f.fillStyle = ring;
        f.fill();
      }
    }
    f.restore();
    this.offCtx.drawImage(this.fog, 0, 0);
  }

  // ───── 오프스크린: 영역 ─────

  private zoneColors(side: ZoneSide): { color: string; light: string } {
    if (side === 'neutral') return { color: ZONE_NEUTRAL_COLOR, light: ZONE_NEUTRAL_LIGHT };
    return { color: TEAM_COLOR[side], light: TEAM_COLOR_LIGHT[side] };
  }

  private trace(o: CanvasRenderingContext2D, z: ZoneSnapshot, frac0 = 0, frac1 = 1): boolean {
    return traceZonePath(o, z, (x) => this.px(x), (y) => this.py(y), PIXELS_PER_UNIT, frac0, frac1);
  }

  private fillDither(o: CanvasRenderingContext2D, color: string, density: 1 | 2 | 3, alpha: number): void {
    const pat = makeDitherPattern(o, color, density);
    o.globalAlpha = alpha;
    o.fillStyle = pat ?? hexToRgba(color, 0.4);
    o.fill();
    o.globalAlpha = 1;
  }

  /** 예고: 성긴 디더 바탕 + 진행률만큼 촘촘한 안쪽 + 점선 테두리. 기믹은 흰 눈송이 */
  private drawTelegraph(o: CanvasRenderingContext2D, z: ZoneSnapshot, now: number): void {
    const { color, light } = this.zoneColors(z.side);
    const neutral = z.side === 'neutral';
    const p = clamp01(z.progress);
    o.save();
    if (this.trace(o, z)) this.fillDither(o, color, 1, neutral ? 0.9 : 0.75);
    if (p > 0 && this.trace(o, z, 0, p)) this.fillDither(o, color, 2, 0.85);
    if (this.trace(o, z)) {
      o.setLineDash([6, 4]);
      o.lineDashOffset = -Math.round(now * 24);
      o.lineWidth = 2;
      o.strokeStyle = neutral ? light : color;
      o.stroke();
      o.setLineDash([]);
    }
    if (neutral && z.shape === 'circle') this.drawFlakes(o, z, now, 0.5 + 0.5 * p);
    o.restore();
  }

  /** 장판: 체커 디더 + 실선 테두리 + 퍼지는 고리. 기믹은 눈송이 */
  private drawLinger(o: CanvasRenderingContext2D, z: ZoneSnapshot, now: number): void {
    const { color, light } = this.zoneColors(z.side);
    const neutral = z.side === 'neutral';
    const p = clamp01(z.progress);
    o.save();
    if (this.trace(o, z)) this.fillDither(o, color, 2, 0.8 * (1 - 0.5 * p));
    // 퍼지는 고리 2개
    for (let i = 0; i < 2; i++) {
      const f = (now * 0.7 + i / 2) % 1;
      const ok = z.shape === 'circle' ? this.trace(o, z, 0, f) : this.trace(o, z, Math.max(0, f - 0.12), f);
      if (!ok) continue;
      o.globalAlpha = 0.5 * (1 - f);
      o.lineWidth = 2;
      o.strokeStyle = light;
      o.stroke();
      o.globalAlpha = 1;
    }
    if (this.trace(o, z)) {
      o.lineWidth = 2;
      o.strokeStyle = color;
      o.stroke();
    }
    if (neutral && z.shape === 'circle') this.drawFlakes(o, z, now, 0.9 * (1 - 0.5 * p));
    o.restore();
  }

  /** 폭발 플래시: 밝은 체커 채움이 사라지며 테두리가 바깥으로 */
  private drawFlash(o: CanvasRenderingContext2D, z: ZoneSnapshot): void {
    const { color, light } = this.zoneColors(z.side);
    const p = clamp01(z.progress);
    const fade = 1 - p;
    o.save();
    if (this.trace(o, z)) this.fillDither(o, light, 3, 0.9 * fade);
    if (this.trace(o, z, 0, 1 + 0.35 * p)) {
      o.globalAlpha = fade;
      o.lineWidth = 3;
      o.strokeStyle = color;
      o.stroke();
    }
    o.restore();
  }

  /** 눈보라 입자 (흰·하늘색 2~3px). 고정 패턴이 시뮬레이션 시간에 따라 아래로 흐른다 */
  private drawFlakes(o: CanvasRenderingContext2D, z: ZoneSnapshot, now: number, alpha: number): void {
    const n = Math.min(70, Math.round(z.radius * z.radius * 3.5));
    o.globalAlpha = alpha;
    for (let i = 0; i < n; i++) {
      const a = hashNoise(i, 1, 201) * Math.PI * 2;
      const rr = Math.sqrt(hashNoise(i, 2, 203)) * z.radius;
      const speed = 0.8 + hashNoise(i, 3, 205) * 0.8;
      const fall = ((now * speed + hashNoise(i, 4, 207) * 1.6) % 1.6) - 0.8;
      const fx = z.x + Math.cos(a) * rr + Math.sin(now * 2 + i) * 0.15;
      const fy = z.y + Math.sin(a) * rr * 0.85 + fall;
      if (Math.hypot(fx - z.x, fy - z.y) > z.radius) continue;
      o.fillStyle = BLIZZARD_COLORS[i % BLIZZARD_COLORS.length];
      const sz = i % 5 === 0 ? 3 : 2;
      o.fillRect(Math.floor(this.px(fx) / 2) * 2, Math.floor(this.py(fy) / 2) * 2, sz, sz);
    }
    o.globalAlpha = 1;
  }

  // ───── 화면 오버레이 ─────

  private drawZoneLabel(s: CanvasRenderingContext2D, z: ZoneSnapshot): void {
    const big = z.shape === 'circle' ? z.radius >= 1.6 : (z.width ?? 0) >= 1.2;
    if (!big) return;
    const u = this.unitPx;
    const neutral = z.side === 'neutral';
    const c = zoneCenter(z);
    s.save();
    s.fillStyle = neutral ? 'rgba(20,40,60,0.9)' : 'rgba(255,255,255,0.9)';
    s.font = `${neutral ? 'bold ' : ''}${Math.max(8, u * 0.4)}px sans-serif`;
    s.textAlign = 'center';
    s.textBaseline = 'middle';
    s.shadowColor = neutral ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)';
    s.shadowBlur = 3;
    s.fillText(zoneLabel(z.skillId), this.sx(c.x), this.sy(c.y));
    s.restore();
  }

  private drawDeadLabel(s: CanvasRenderingContext2D, u: UnitSnapshot): void {
    if (u.job === 'summon') return;
    const px = this.unitPx;
    s.save();
    s.globalAlpha = 0.35;
    s.fillStyle = '#ffffff';
    s.font = `${nameFontPx(px, this.dense)}px sans-serif`;
    s.textAlign = 'center';
    s.textBaseline = 'top';
    s.fillText(u.name, this.sx(u.x), this.sy(u.y) + px * 0.15);
    s.restore();
  }

  private drawUnitOverlay(s: CanvasRenderingContext2D, u: UnitSnapshot, frame: BattleFrame): void {
    const px = this.unitPx;
    const isSummon = u.job === 'summon';
    const tier = this.tierOf(u);
    const isBoss = tier !== null && !!this.bossIds?.has(u.id);
    const m = this.sizeMult(u);
    const x = this.sx(u.x);
    const y = this.sy(u.y);
    const stealthed = u.statuses.some((st) => st.kind === 'stealth');
    const shield = u.statuses.find((st) => st.kind === 'shield');
    const invuln = u.statuses.some((st) => st.kind === 'invuln');

    s.save();
    if (stealthed) s.globalAlpha = 0.6;

    // 보호막 / 무적 링 (발밑 타원)
    if (shield || invuln) {
      s.beginPath();
      s.ellipse(x, y + px * 0.03, px * 0.42 * m, px * 0.2 * m, 0, 0, Math.PI * 2);
      s.strokeStyle = invuln ? 'rgba(255,255,255,0.9)' : 'rgba(120,200,255,0.9)';
      s.lineWidth = Math.max(1, px * 0.1);
      s.stroke();
    }

    // HP 바 + MP 바 + 붕괴 테두리
    const barW = (isSummon ? 1.2 : isBoss ? 3.0 : this.dense ? HP_BAR_W_DENSE : HP_BAR_W) * px;
    const barH = Math.max(2, px * 0.28);
    const barTop = this.barTopOf(u, px, barH);
    const bars = drawUnitBars(s, {
      cx: x, top: barTop, barW, barH, u, showMp: !isSummon, attritionPct: frame.attritionPctPerSec ?? 0, now: frame.timeSec,
      hpColor: SIDE_COLOR[u.side], mpColor: SIDE_MP_COLOR,
    });

    // 직업 썸네일 (HP 바 왼쪽 바깥). 캐릭터만 — 소환물·몬스터는 없다
    if (this.icons && !isSummon && tier === null && u.job !== 'summon') {
      const iconPx = this.dense
        ? Math.max(ICON_MIN_PX_DENSE, Math.round(barH * ICON_BAR_MULT_DENSE))
        : Math.max(ICON_MIN_PX, Math.round(barH * ICON_BAR_MULT));
      const ix = x - barW / 2 - ICON_GAP_PX - iconPx;
      const iy = barTop + barH / 2 - iconPx / 2;
      drawJobIcon(s, u.job, ix, iy, iconPx, u.side);
    }

    // 시전 진행 바 (노랑, MP 바 아래)
    if (u.casting) {
      const ch = Math.max(1, barH * 0.4);
      const cy = bars.bottom + 1;
      s.fillStyle = 'rgba(0,0,0,0.5)';
      s.fillRect(x - barW / 2, cy, barW, ch);
      s.fillStyle = '#ffe082';
      s.fillRect(x - barW / 2, cy, barW * clamp01(u.casting.progress), ch);
    }

    // 상태 점
    drawStatusDots(s, u, x, bars.dotsY - px * 0.3, px);

    // 이름 (발 아래). 보스는 난이도 색
    if (!isSummon) {
      const color = isBoss && tier ? MONSTER_EDGE[tier] : '#ffffff';
      drawNameLabel(s, u, x, y + px * 0.15, px, this.dense, color);
    }
    s.restore();
  }
}
