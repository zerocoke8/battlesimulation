/**
 * 결정론적 실시간 전투 시뮬레이션 (GDD §6).
 *
 * - 고정 틱(TICK_RATE). 모든 난수는 new Rng(input.seed) 에서만 나온다.
 * - 유닛 배열 순서: 팀 A 멤버(팀 순서) → 팀 B 멤버(팀 순서) → 소환물(생성 순서). 매 틱 이 순서로 처리한다.
 * - 어느 쪽 팀이든 1~MONSTER_TEAM_MAX 명을 세울 수 있다. MapDef.spawnA/spawnB 는 대열 기준 열(anchor)일 뿐이고
 *   실제 위치는 computeFormation 이 인원 수·역할에 맞춰 난수 없이 만든다 (GDD §7.3.2).
 * - 광역 스킬(enemy_area / line)은 시전 완료 시 즉시 적용하지 않고 Zone 을 만든다 (GDD §6.5).
 *   예고(telegraph) → impact → (linger 장판). 예고 시작 시 영역 안의 적마다 회피 판정 1회 (GDD §4.4).
 *   Zone 은 생성 순서 배열로 관리하고 매 틱 유닛 처리 뒤에 처리한다. 시전자가 죽어도 Zone 은 남는다.
 * - DOM / Math.random / Date 를 절대 사용하지 않는다.
 */
import {
  ALLY_AREA_FLASH_SEC,
  DEFAULT_TELEGRAPH_SEC,
  DERIVED_STAT_KEYS,
  SHORT_TELEGRAPH_SEC,
  TICK_DT,
  TICK_RATE,
  ZONE_FLASH_SEC,
} from '../types';
import type {
  BattleEvent,
  BattleFrame,
  BattleInput,
  BattleResult,
  BattleSimulator,
  Character,
  DerivedStatKey,
  DerivedStats,
  MainJob,
  MapDef,
  Role,
  SkillDef,
  SkillEffect,
  StatusKind,
  SubJobId,
  SummonUnitId,
  SynergyDef,
  Team,
  TeamSide,
  UnitBattleStats,
  UnitSnapshot,
  ZonePhase,
  ZoneShape,
  ZoneSnapshot,
} from '../types';
import { Rng } from '../rng';
import { computeDerived } from '../stats';
import { MAPS } from '../data/maps';
import { JOBS } from '../data/jobs';
import { getSkill, SUMMON_UNITS } from '../data/skills';

// ───────────────────────── 상수 ─────────────────────────

const FATIGUE_START_SEC = 30; // 지구력 감소 시작. GDD 4.2 초안은 60초였으나 평균 전투 시간(60~70초)의 후반부에 지구력이 영향을 주도록 30초로 조정
const FATIGUE_RATE_PER_SEC = 0.004; // 지구력 0 기준 초당 감소율
const FATIGUE_CAP = 0.3; // 최대 30% 감소
const SEPARATION_DIST = 0.8;
const RETARGET_TICKS = 10;
const RETREAT_SEC = 2;
const RETREAT_COOLDOWN_SEC = 8;
const MAX_RESULT_EVENTS = 5000;
const HEALER_BACK_DIST = 4;
const HEALER_FLEE_DIST = 3;
const TEAMWORK_DRIFT_DIST = 8;
const KITE_RATIO = 0.4;
const RANGE_SLACK = 0.5;
const FREEZE_DAMAGE_MULT = 1.25;
const SUMMON_DEF_COEF = 0.5;
const INTERRUPT_COOLDOWN_SEC = 1;
const ASSASSIN_BACKLINE_SLACK = 2; // 암살자가 후방 딜러를 우선하는 거리 여유 (가장 가까운 적보다 이만큼 멀어도 허용)
const CAPTURE_EVENT_TICKS = TICK_RATE; // 점령 진행 이벤트 간격 (1초)

// 광역 회피 (GDD §4.4)
const DODGE_SPEED_MULT = 1.15; // 회피 이동 속도 배율
const DODGE_ESCAPE_MARGIN = 0.6; // 영역 경계 밖 여유
const DODGE_CENTER_EPS = 0.5; // 이 거리 안이면 '중심에 맞은 것' 으로 보고 시전자 반대쪽으로 탈출

// 광역 영역 표시 틱 수
const ZONE_FLASH_TICKS = Math.max(1, Math.round(ZONE_FLASH_SEC * TICK_RATE));
const ALLY_AREA_FLASH_TICKS = Math.max(1, Math.round(ALLY_AREA_FLASH_SEC * TICK_RATE));

// 대열 (GDD §7.3.2). 기준 열(anchor)에서의 x 오프셋은 '상대 쪽' 이 양수.
const FORMATION_FRONT_OFFSET = 1.2; // 전열: 기준 열보다 상대 쪽으로
const FORMATION_BACK_OFFSET = 1.0; // 후열: 기준 열 뒤
const FORMATION_COLUMN_GAP = 1.4; // 한 줄이 넘칠 때 추가 열 간격 / 저격수 열 간격
const FORMATION_MAX_PER_COLUMN = 4; // 한 열 최대 인원
const FORMATION_ROW_SPACING = 3.0; // 세로 간격
const FORMATION_MARGIN = 0.8; // 맵 경계 여유
const FORMATION_MIN_SEP = 0.8; // 유닛 최소 간격

const FATIGUE_KEYS: readonly DerivedStatKey[] = ['physAtk', 'magAtk', 'physDef', 'magDef', 'atkSpeed', 'moveSpeed'];

const HARMFUL_STATUS: Record<StatusKind, boolean> = {
  stun: true, slow: true, burn: true, poison: true, freeze: true, silence: true, taunt: true,
  stealth: false, shield: false, lifesteal: false, reflect: false, regen: false, invuln: false,
};

/** 대열 안 우선순위 (낮을수록 열의 중앙에 가깝게) */
const SPAWN_PRIORITY: Record<MainJob, number> = {
  tank: 0, swordsman: 1, berserker: 1, assassin: 2, summoner: 3, archer: 4, mage: 5, sniper: 6, healer: 7,
};
const FRONTLINE_JOB: Record<MainJob, boolean> = {
  tank: true, swordsman: true, berserker: true, assassin: true,
  summoner: false, archer: false, mage: false, sniper: false, healer: false,
};
const BACKLINE_JOB: Record<MainJob, boolean> = {
  tank: false, swordsman: false, berserker: false, assassin: false,
  summoner: true, archer: true, mage: true, sniper: true, healer: true,
};

// ───────────────────────── 런타임 구조 ─────────────────────────

interface Status {
  kind: StatusKind;
  remaining: number; // 초. Infinity 면 영구(패시브)
  value: number;
  source: number; // 시전 유닛 idx (-1 없음)
}

interface Buff {
  stat: DerivedStatKey;
  pct: number; // 음수면 디버프
  remaining: number;
}

interface CastState {
  skillIdx: number;
  targetIdx: number;
  tx: number;
  ty: number;
  progress: number;
  total: number;
}

interface Unit {
  idx: number;
  id: string;
  name: string;
  side: TeamSide;
  job: MainJob | 'summon';
  subJob: SubJobId | null;
  role: Role | 'summon';
  isSummon: boolean;
  ownerId?: string;
  ownerIdx: number;
  char: Character | null;
  attackSchool: 'phys' | 'magic';
  /** 소환물 기본 파생 수치 (버프 적용 전) */
  summonRaw: DerivedStats | null;

  x: number;
  y: number;
  facing: number;
  hp: number;
  mp: number;
  alive: boolean;

  base: DerivedStats; // computeDerived 결과 (시너지/버프 포함)
  eff: DerivedStats; // 피로 적용 후 실사용 수치
  fatigue: number;
  dirty: boolean;
  synIds: string[];
  synMods: Partial<Record<DerivedStatKey, number>>;
  stealthBonus: number;

  buffs: Buff[];
  statuses: Status[];
  activeSkills: SkillDef[];
  cooldowns: number[];
  cast: CastState | null;
  attackTimer: number;
  targetIdx: number;
  retargetTick: number;
  retreatUntil: number;
  retreatReadyAt: number;
  summonExpire: number;
  visible: boolean; // 적 팀에게 보이는가 (시야)

  /** 회피 이동 (GDD §4.4): 이 틱까지 dodgeX/dodgeY 로만 이동한다. -1 이면 없음 */
  dodgeUntilTick: number;
  /**
   * 회피 이동을 시작하는 틱 (= 영역 생성 틱 + 1). 생성 틱에 시전자보다 뒤에 처리되는 유닛이 그 틱에 한 번 더
   * 움직여 처리 순서에 따라 이동 틱 수가 달라지는 것을 막는다. 예고 N틱이면 어느 쪽이든 정확히 N번 움직인다.
   */
  dodgeFromTick: number;
  dodgeX: number;
  dodgeY: number;

  // AI 에 쓰는 기본 스탯
  judgment: number;
  agility: number;
  courage: number;
  teamwork: number;
  stamina: number;
  composure: number;
  resistance: number;
  strength: number;
  focus: number;

  stats: UnitBattleStats;
}

interface TeamRuntime {
  side: TeamSide;
  team: Team;
  members: Unit[]; // 비소환물
  all: Unit[]; // 소환물 포함
  spawnCenterX: number;
  spawnCenterY: number;
}

/**
 * 스킬 효과 적용 시점의 시전자 수치 스냅샷.
 * Zone 은 예고 뒤에 효과를 적용하므로 시전자가 죽어도 쓸 수 있도록 공격력 등을 따로 들고 있다.
 */
interface EffectSource {
  u: Unit;
  physAtk: number;
  magAtk: number;
  critChance: number;
  critMult: number;
  accuracy: number;
  stealthedAtCast: boolean;
  missingPct: number;
}

/** 효과 적용 범위: all = 전부, harmful = 영역 대상(피해·해로운 상태·디버프·넉백)만, helpful = 그 외(시전자 측)만 */
type EffectMode = 'all' | 'harmful' | 'helpful';

/**
 * 광역 영역 런타임 (GDD §6.5.2). types.ts 에는 내보내지 않는 내부 구조.
 * 시간은 결정론을 위해 틱 정수로 센다 (remainingSec = ticks × TICK_DT).
 */
interface Zone {
  id: string;
  side: TeamSide;
  casterIdx: number;
  casterId: string;
  skillId: string;
  skill: SkillDef;
  shape: ZoneShape;
  x: number;
  y: number;
  radius: number; // circle 반경. line 이면 0
  x2?: number; // line 끝점
  y2?: number;
  width?: number; // line 전체 폭 (= halfWidth × 2)
  // line 내부 계산용
  dirX: number;
  dirY: number;
  length: number;
  halfWidth: number;
  /** 효과의 '목표 지점' (circle 중심 / line 끝점). 넉백 기준점은 x,y */
  tx: number;
  ty: number;
  /** 생성 틱. 생성 틱에는 카운트를 줄이지 않아 예고가 정확히 telegraphSec 뒤(생성 틱 + 틱 수)에 적용된다 */
  createdTick: number;
  telegraphTicksTotal: number;
  telegraphTicksLeft: number;
  flashTicksLeft: number;
  lingerTicksTotal: number;
  lingerTicksLeft: number;
  impactDone: boolean;
  /** 표시용(아군 광역 / 즉시 적용 광역의 폭발 표시). 장판 피해 없음 */
  displayOnly: boolean;
  src: EffectSource;
  lingerSchool: 'phys' | 'magic';
  lingerAtk: number; // impact 시점 시전자 공격력 (캐시)
  lingerMult: number; // 맵 마법 계열 배율
}

// ───────────────────────── 유틸 ─────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function dist(a: Unit, b: Unit): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function distXY(a: Unit, x: number, y: number): number {
  const dx = a.x - x;
  const dy = a.y - y;
  return Math.sqrt(dx * dx + dy * dy);
}

function hasStatus(u: Unit, kind: StatusKind): boolean {
  for (let i = 0; i < u.statuses.length; i++) if (u.statuses[i].kind === kind) return true;
  return false;
}

function statusValue(u: Unit, kind: StatusKind): number {
  let v = 0;
  for (let i = 0; i < u.statuses.length; i++) {
    const s = u.statuses[i];
    if (s.kind === kind && s.value > v) v = s.value;
  }
  return v;
}

function removeStatus(u: Unit, kind: StatusKind): boolean {
  let removed = false;
  for (let i = u.statuses.length - 1; i >= 0; i--) {
    if (u.statuses[i].kind === kind) {
      u.statuses.splice(i, 1);
      removed = true;
    }
  }
  return removed;
}

function isDisabled(u: Unit): boolean {
  return hasStatus(u, 'stun') || hasStatus(u, 'freeze');
}

function emptyDerived(): DerivedStats {
  const d = {} as DerivedStats;
  for (let i = 0; i < DERIVED_STAT_KEYS.length; i++) d[DERIVED_STAT_KEYS[i]] = 0;
  return d;
}

function copyDerived(dst: DerivedStats, src: DerivedStats): void {
  for (let i = 0; i < DERIVED_STAT_KEYS.length; i++) {
    const k = DERIVED_STAT_KEYS[i];
    dst[k] = src[k];
  }
}

/** Zone impact 시점으로 미뤄지는 효과인가 (영역 안의 적에게 적용되는 것) */
function isZoneDeferredEffect(e: SkillEffect): boolean {
  switch (e.kind) {
    case 'damage':
    case 'debuff':
    case 'knockback':
      return true;
    case 'status':
      return HARMFUL_STATUS[e.status];
    case 'heal':
    case 'buff':
    case 'cleanse':
    case 'restore_mp':
    case 'summon':
    case 'dash':
      return false;
  }
}

function skillHasHeal(sk: SkillDef): boolean {
  for (let i = 0; i < sk.effects.length; i++) if (sk.effects[i].kind === 'heal') return true;
  return false;
}

function skillHasDamage(sk: SkillDef): boolean {
  for (let i = 0; i < sk.effects.length; i++) if (sk.effects[i].kind === 'damage') return true;
  return false;
}

/** 장판 피해 계열: 첫 피해 효과의 계열, 없으면 이능 */
function lingerSchoolOf(sk: SkillDef): 'phys' | 'magic' {
  for (let i = 0; i < sk.effects.length; i++) {
    const e = sk.effects[i];
    if (e.kind === 'damage') return e.school;
  }
  return 'magic';
}

function isAllySkill(sk: SkillDef): boolean {
  return sk.target === 'self' || sk.target === 'ally' || sk.target === 'ally_area' || sk.target === 'ally_lowest_hp';
}

function safeGetSkill(id: string): SkillDef | null {
  try {
    return getSkill(id);
  } catch {
    return null;
  }
}

// ───────────────────────── 공개 도우미 ─────────────────────────

/**
 * 광역 회피 확률 (GDD §4.4 확정 공식).
 * clamp(판단력 × 0.006 + 민첩 × 0.003, 0.05, 0.85). 예고 < 0.5초면 절반. 예고가 없으면(≤ 0) 0.
 * v0.5 보정: 기본항 0.10 → 0. 0.10 에서는 판단력 30·민첩 30 유닛의 인지율이 37% 라 §11 목표(30% 미만)를 넘었고,
 * 이동속도 30 유닛도 반경 3 을 0.8초 안에 벗어나 인지가 그대로 회피로 이어졌다 (계수만으로는 두 목표를 동시에 못 맞춘다:
 * 30/30 < 0.30 과 80/70 ≥ 0.66 은 기본항 ≤ 0 에서만 양립). 기본항 0 이면 30/30 → 27%, 80/70 → 69%.
 */
export function dodgeChance(judgment: number, agility: number, telegraphSec: number): number {
  if (!(telegraphSec > 0)) return 0;
  let p = judgment * 0.006 + agility * 0.003;
  p = clamp(p, 0.05, 0.85);
  if (telegraphSec < 0.5) p *= 0.5;
  return p;
}

/**
 * 스킬의 실제 예고 시간(초). SkillDef.telegraphSec 이 있으면 그 값(0 이상),
 * 없으면 enemy_area / line 피해 스킬 0.8 (시전자 중심 소형 근접 광역: radius ≤ 2.5 이고 range ≤ 2 이면 0.3), 그 외 0.
 */
export function telegraphSecOf(sk: SkillDef): number {
  if (sk.telegraphSec !== undefined) return sk.telegraphSec > 0 ? sk.telegraphSec : 0;
  if (sk.target !== 'enemy_area' && sk.target !== 'line') return 0;
  if (!skillHasDamage(sk)) return 0;
  const r = sk.radius ?? 2;
  if (r <= 2.5 && sk.range <= 2) return SHORT_TELEGRAPH_SEC;
  return DEFAULT_TELEGRAPH_SEC;
}

/**
 * 대열 생성 (GDD §7.3.2). 난수를 쓰지 않으며 팀 순서·직업(역할)·맵에만 의존한다.
 * 반환 배열은 members 와 같은 인덱스.
 *  - 기준 열: spawnA/spawnB 의 x 평균, 대열 중심: y 평균 (배열이 비면 x=4 / width-4, y=height/2).
 *  - 전열(tank / melee_dps / assassin)은 기준 열보다 상대 쪽 +1.2, 후열(ranged/mage/summoner/healer)은 −1.0,
 *    저격수는 후열보다 한 열 더 뒤. 한 열은 최대 4명, 넘치면 열을 하나 더 만든다.
 *  - 열 안에서는 세로로 균등 분포(간격 3, 인원이 많으면 줄임), 우선순위(탱커 등)가 중앙.
 *  - 맵 경계 안(여유 0.8), 유닛 간 최소 간격 0.8 보장.
 */
export function computeFormation(map: MapDef, side: TeamSide, members: readonly Character[]): { x: number; y: number }[] {
  const n = members.length;
  const out: { x: number; y: number }[] = new Array(n);
  if (n === 0) return out;
  const anchors = side === 'A' ? map.spawnA : map.spawnB;
  let ax = 0;
  let cy = 0;
  if (anchors.length > 0) {
    for (let i = 0; i < anchors.length; i++) {
      ax += anchors[i].x;
      cy += anchors[i].y;
    }
    ax /= anchors.length;
    cy /= anchors.length;
  } else {
    ax = side === 'A' ? 4 : map.width - 4;
    cy = map.height / 2;
  }
  const dir = side === 'A' ? 1 : -1;
  const minX = FORMATION_MARGIN;
  const maxX = map.width - FORMATION_MARGIN;
  const minY = FORMATION_MARGIN;
  const maxY = map.height - FORMATION_MARGIN;

  type Entry = { i: number; p: number };
  const front: Entry[] = [];
  const back: Entry[] = [];
  const snipers: Entry[] = [];
  for (let i = 0; i < n; i++) {
    const c = members[i];
    const job = JOBS[c.mainJob];
    const role: Role = job ? job.role : 'melee_dps';
    const e: Entry = { i, p: SPAWN_PRIORITY[c.mainJob] ?? 5 };
    if (c.mainJob === 'sniper') snipers.push(e);
    else if (role === 'tank' || role === 'melee_dps' || role === 'assassin') front.push(e);
    else back.push(e);
  }
  const byPriority = (a: Entry, b: Entry): number => (a.p !== b.p ? a.p - b.p : a.i - b.i);
  front.sort(byPriority);
  back.sort(byPriority);
  snipers.sort(byPriority);

  const place = (group: Entry[], laneX: (col: number) => number): number => {
    const cols = Math.ceil(group.length / FORMATION_MAX_PER_COLUMN);
    for (let c = 0; c < cols; c++) {
      const start = c * FORMATION_MAX_PER_COLUMN;
      const end = Math.min(group.length, start + FORMATION_MAX_PER_COLUMN);
      const cnt = end - start;
      const x = clamp(laneX(c), minX, maxX);
      const spacing = Math.min(FORMATION_ROW_SPACING, (maxY - minY) / Math.max(1, cnt));
      // 슬롯 순서: 중앙에서 가까운 것부터 (같으면 위쪽 먼저)
      const slots: number[] = [];
      for (let k = 0; k < cnt; k++) slots.push(k);
      const mid = (cnt - 1) / 2;
      slots.sort((a, b) => {
        const oa = Math.abs(a - mid);
        const ob = Math.abs(b - mid);
        return oa !== ob ? oa - ob : a - b;
      });
      for (let k = 0; k < cnt; k++) {
        const y = clamp(cy + (slots[k] - mid) * spacing, minY, maxY);
        out[group[start + k].i] = { x, y };
      }
    }
    return cols;
  };
  place(front, (c) => ax + dir * (FORMATION_FRONT_OFFSET + c * FORMATION_COLUMN_GAP));
  const backCols = place(back, (c) => ax - dir * (FORMATION_BACK_OFFSET + c * FORMATION_COLUMN_GAP));
  place(snipers, (c) => ax - dir * (FORMATION_BACK_OFFSET + (Math.max(1, backCols) + c) * FORMATION_COLUMN_GAP));

  // 겹침 해소 (경계 클램프로 열이 합쳐진 경우). 순서 고정이므로 결정론적.
  for (let iter = 0; iter < 16; iter++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = out[i];
        const b = out[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= FORMATION_MIN_SEP) continue;
        const need = FORMATION_MIN_SEP - d + 0.05;
        // 세로로 밀어낸다 (중심에서 먼 쪽으로). 경계에 막히면 반대쪽, 그래도 막히면 뒤로.
        const sign = b.y >= cy ? 1 : -1;
        let ny = b.y + sign * need;
        if (ny > maxY || ny < minY) ny = b.y - sign * need;
        if (ny <= maxY && ny >= minY) {
          b.y = ny;
        } else {
          b.x = clamp(b.x - dir * need, minX, maxX);
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  return out;
}

/** 결정론 테스트용: 유닛 위치/HP 와 광역 영역을 소수점 3자리로 묶은 문자열 */
export function hashFrame(f: BattleFrame): string {
  let s = 't' + f.tick;
  for (let i = 0; i < f.units.length; i++) {
    const u = f.units[i];
    s += ';' + u.id + ':' + u.x.toFixed(3) + ',' + u.y.toFixed(3) + ',' + u.hp.toFixed(3) + ',' + (u.alive ? 1 : 0);
  }
  for (let i = 0; i < f.zones.length; i++) {
    const z = f.zones[i];
    s += ';z' + z.id + ':' + z.phase + ',' + z.x.toFixed(3) + ',' + z.y.toFixed(3) + ',' + z.remainingSec.toFixed(3);
  }
  if (f.capture) s += ';c' + f.capture.progressA.toFixed(3) + '/' + f.capture.progressB.toFixed(3);
  return s;
}

// ───────────────────────── 시뮬레이터 ─────────────────────────

class Battle implements BattleSimulator {
  readonly input: BattleInput;
  private readonly map: MapDef;
  private readonly rng: Rng;
  private readonly units: Unit[] = [];
  private readonly teams: Record<TeamSide, TeamRuntime>;
  private tick = 0;
  private time = 0;
  private readonly maxTicks: number;
  private readonly hardCapTicks: number;
  private events: BattleEvent[] = [];
  private readonly allEvents: BattleEvent[] = [];
  private frame: BattleFrame;
  private _finished = false;
  private _result: BattleResult | null = null;
  private winner: TeamSide | 'draw' = 'draw';
  private reason = '';
  private captureA = 0;
  private captureB = 0;
  private captureHolder: TeamSide | null = null;
  private summonCounter = 0;
  private zoneCounter = 0;
  /** 광역 영역. 생성 순서 고정 */
  private zones: Zone[] = [];
  private readonly visionRadius: number;

  constructor(input: BattleInput) {
    this.input = input;
    this.map = MAPS[input.map];
    this.rng = new Rng(input.seed);
    this.maxTicks = Math.max(1, Math.round(this.map.timeLimitSec * TICK_RATE));
    this.hardCapTicks = this.maxTicks + 1;
    this.visionRadius = this.map.visionRadius;

    this.teams = {
      A: this.makeTeamRuntime('A', input.teamA, this.map.spawnA),
      B: this.makeTeamRuntime('B', input.teamB, this.map.spawnB),
    };
    this.spawnTeam(this.teams.A);
    this.spawnTeam(this.teams.B);

    this.evaluateSynergies();
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      this.recomputeDerived(u);
      u.hp = u.eff.maxHp;
      u.mp = u.eff.maxMp;
    }
    this.frame = this.buildFrame([]);
  }

  get finished(): boolean {
    return this._finished;
  }

  // ───────── 초기화 ─────────

  private makeTeamRuntime(side: TeamSide, team: Team, spawns: { x: number; y: number }[]): TeamRuntime {
    let sx = 0;
    let sy = 0;
    if (spawns.length > 0) {
      for (let i = 0; i < spawns.length; i++) {
        sx += spawns[i].x;
        sy += spawns[i].y;
      }
      sx /= spawns.length;
      sy /= spawns.length;
    } else {
      sx = side === 'A' ? 4 : this.map.width - 4;
      sy = this.map.height / 2;
    }
    return { side, team, members: [], all: [], spawnCenterX: sx, spawnCenterY: sy };
  }

  /** 인원 수(1~8)에 맞는 대열로 스폰. 유닛 순서는 팀 순서 그대로 */
  private spawnTeam(tr: TeamRuntime): void {
    const members = tr.team.members;
    const pos = computeFormation(this.map, tr.side, members);
    for (let i = 0; i < members.length; i++) {
      const u = this.createCharacterUnit(members[i], tr.side, pos[i].x, pos[i].y);
      tr.members.push(u);
      tr.all.push(u);
    }
  }

  private newStats(id: string, name: string, side: TeamSide): UnitBattleStats {
    return { id, name, side, damageDealt: 0, damageTaken: 0, healingDone: 0, kills: 0, deaths: 0, skillsUsed: 0, survived: true };
  }

  private createCharacterUnit(c: Character, side: TeamSide, x: number, y: number): Unit {
    const jobDef = JOBS[c.mainJob];
    const actives: SkillDef[] = [];
    const passiveStatuses: Status[] = [];
    let activeCount = 0;
    let passiveCount = 0;
    for (let i = 0; i < c.skills.length; i++) {
      const sk = safeGetSkill(c.skills[i]);
      if (!sk) continue;
      if (sk.type === 'active') {
        if (activeCount >= 3) continue;
        activeCount++;
        actives.push(sk);
      } else {
        if (passiveCount >= 2) continue;
        passiveCount++;
        if (sk.passiveStatus) {
          for (let j = 0; j < sk.passiveStatus.length; j++) {
            const ps = sk.passiveStatus[j];
            passiveStatuses.push({ kind: ps.status, remaining: Infinity, value: ps.value, source: -1 });
          }
        }
      }
    }
    const u: Unit = {
      idx: this.units.length,
      id: c.id,
      name: c.name,
      side,
      job: c.mainJob,
      subJob: c.subJob,
      role: jobDef.role,
      isSummon: false,
      ownerIdx: -1,
      char: c,
      attackSchool: jobDef.attackSchool,
      summonRaw: null,
      x,
      y,
      facing: side === 'A' ? 0 : Math.PI,
      hp: 1,
      mp: 0,
      alive: true,
      base: emptyDerived(),
      eff: emptyDerived(),
      fatigue: 1,
      dirty: true,
      synIds: [],
      synMods: {},
      stealthBonus: 0,
      buffs: [],
      statuses: passiveStatuses,
      activeSkills: actives,
      cooldowns: actives.map(() => 0),
      cast: null,
      attackTimer: 0,
      targetIdx: -1,
      retargetTick: 0,
      retreatUntil: -1,
      retreatReadyAt: 0,
      summonExpire: Infinity,
      visible: true,
      dodgeUntilTick: -1,
      dodgeFromTick: 0,
      dodgeX: x,
      dodgeY: y,
      judgment: c.stats.judgment,
      agility: c.stats.agility,
      courage: c.stats.courage,
      teamwork: c.stats.teamwork,
      stamina: c.stats.stamina,
      composure: c.stats.composure,
      resistance: c.stats.resistance,
      strength: c.stats.strength,
      focus: c.stats.focus,
      stats: this.newStats(c.id, c.name, side),
    };
    for (let i = 0; i < passiveStatuses.length; i++) passiveStatuses[i].source = u.idx;
    this.units.push(u);
    return u;
  }

  private createSummonUnit(owner: Unit, unitId: SummonUnitId, x: number, y: number, durationSec: number): Unit {
    const def = SUMMON_UNITS[unitId];
    this.summonCounter++;
    const id = `${owner.id}_s${this.summonCounter}`;
    const raw = emptyDerived();
    const ob = owner.base;
    raw.maxHp = ob.maxHp * def.hpCoef;
    raw.physAtk = def.school === 'phys' ? ob.physAtk * def.atkCoef : 0;
    raw.magAtk = def.school === 'magic' ? ob.magAtk * def.atkCoef : 0;
    raw.physDef = ob.physDef * SUMMON_DEF_COEF;
    raw.magDef = ob.magDef * SUMMON_DEF_COEF;
    raw.atkSpeed = def.attackIntervalSec > 0 ? 1 / def.attackIntervalSec : 1;
    raw.moveSpeed = def.moveSpeed;
    raw.critChance = ob.critChance;
    raw.critMult = ob.critMult;
    raw.accuracy = ob.accuracy;
    raw.evasion = ob.evasion * 0.5;
    raw.maxMp = 0;
    raw.mpRegen = 0;
    raw.castSpeed = 1;
    raw.cooldownReduction = 0;
    raw.range = def.range;

    const u: Unit = {
      idx: this.units.length,
      id,
      name: def.name,
      side: owner.side,
      job: 'summon',
      subJob: null,
      role: 'summon',
      isSummon: true,
      ownerId: owner.id,
      ownerIdx: owner.idx,
      char: null,
      attackSchool: def.school,
      summonRaw: raw,
      x,
      y,
      facing: owner.facing,
      hp: 1,
      mp: 0,
      alive: true,
      base: emptyDerived(),
      eff: emptyDerived(),
      fatigue: 1,
      dirty: true,
      synIds: [],
      synMods: {},
      stealthBonus: 0,
      buffs: [],
      statuses: [],
      activeSkills: [],
      cooldowns: [],
      cast: null,
      attackTimer: 0.5,
      targetIdx: -1,
      retargetTick: 0,
      retreatUntil: -1,
      retreatReadyAt: 0,
      summonExpire: this.time + durationSec,
      visible: true,
      dodgeUntilTick: -1,
      dodgeFromTick: 0,
      dodgeX: x,
      dodgeY: y,
      judgment: owner.judgment,
      agility: owner.agility,
      courage: 100,
      teamwork: 0,
      stamina: 100,
      composure: owner.composure,
      resistance: owner.resistance,
      strength: owner.strength,
      focus: owner.focus,
      stats: this.newStats(id, def.name, owner.side),
    };
    this.units.push(u);
    this.teams[owner.side].all.push(u);
    this.recomputeDerived(u);
    u.hp = u.eff.maxHp;
    return u;
  }

  // ───────── 파생 수치 ─────────

  private recomputeDerived(u: Unit): void {
    const mods: Partial<Record<DerivedStatKey, number>> = {};
    let any = false;
    for (let i = 0; i < DERIVED_STAT_KEYS.length; i++) {
      const k = DERIVED_STAT_KEYS[i];
      const v = u.synMods[k];
      if (v) {
        mods[k] = (mods[k] ?? 0) + v;
        any = true;
      }
    }
    for (let i = 0; i < u.buffs.length; i++) {
      const b = u.buffs[i];
      mods[b.stat] = (mods[b.stat] ?? 0) + b.pct;
      any = true;
    }
    if (u.char) {
      const d = computeDerived(u.char, this.input.map, any ? mods : undefined);
      copyDerived(u.base, d);
    } else if (u.summonRaw) {
      copyDerived(u.base, u.summonRaw);
      if (any) {
        for (let i = 0; i < DERIVED_STAT_KEYS.length; i++) {
          const k = DERIVED_STAT_KEYS[i];
          const pct = mods[k];
          if (pct) u.base[k] = u.base[k] * Math.max(0, 1 + pct / 100);
        }
      }
    }
    u.dirty = false;
    this.updateEff(u);
    if (u.hp > u.eff.maxHp) u.hp = u.eff.maxHp;
    if (u.mp > u.eff.maxMp) u.mp = u.eff.maxMp;
  }

  private updateEff(u: Unit): void {
    copyDerived(u.eff, u.base);
    if (u.fatigue < 1) {
      for (let i = 0; i < FATIGUE_KEYS.length; i++) {
        const k = FATIGUE_KEYS[i];
        u.eff[k] = u.base[k] * u.fatigue;
      }
    }
    if (u.eff.atkSpeed < 0.1) u.eff.atkSpeed = 0.1;
    if (u.eff.castSpeed < 0.2) u.eff.castSpeed = 0.2;
    if (u.eff.moveSpeed < 0) u.eff.moveSpeed = 0;
    if (u.eff.maxHp < 1) u.eff.maxHp = 1;
  }

  private updateFatigue(u: Unit): void {
    if (u.isSummon) return;
    if (this.time <= FATIGUE_START_SEC) return;
    const decay = Math.min(
      FATIGUE_CAP,
      (this.time - FATIGUE_START_SEC) * ((100 - clamp(u.stamina, 0, 100)) / 100) * FATIGUE_RATE_PER_SEC * this.map.staminaDrainMult,
    );
    const f = 1 - decay;
    if (f !== u.fatigue) {
      u.fatigue = f;
      this.updateEff(u);
    }
  }

  // ───────── 시너지 ─────────

  private evaluateSynergies(): void {
    this.evaluateTeamSynergies(this.teams.A);
    this.evaluateTeamSynergies(this.teams.B);
  }

  private evaluateTeamSynergies(tr: TeamRuntime): void {
    const members = tr.members;
    const n = members.length;
    // 유닛별 활성 시너지 id / 합산 mods 를 새로 만든다
    const ids: string[][] = [];
    const mods: Partial<Record<DerivedStatKey, number>>[] = [];
    const stealth: number[] = [];
    for (let i = 0; i < n; i++) {
      ids.push([]);
      mods.push({});
      stealth.push(0);
    }
    const syns = tr.team.synergies;
    for (let s = 0; s < syns.length; s++) {
      const syn = syns[s];
      const involved = this.synergyInvolved(tr, syn);
      if (!involved) continue;
      const targets = syn.scope === 'team' ? members : involved;
      for (let t = 0; t < targets.length; t++) {
        const idx = members.indexOf(targets[t]);
        if (idx < 0) continue;
        ids[idx].push(syn.id);
        const m = mods[idx];
        for (let k = 0; k < DERIVED_STAT_KEYS.length; k++) {
          const key = DERIVED_STAT_KEYS[k];
          const v = syn.mods[key];
          if (v) m[key] = (m[key] ?? 0) + v;
        }
        if (syn.bonusStealthSec) stealth[idx] += syn.bonusStealthSec;
      }
    }
    for (let i = 0; i < n; i++) {
      const u = members[i];
      const a = u.synIds;
      const b = ids[i];
      let same = a.length === b.length;
      if (same) {
        for (let k = 0; k < a.length; k++) {
          if (a[k] !== b[k]) {
            same = false;
            break;
          }
        }
      }
      if (!same) {
        u.synIds = b;
        u.synMods = mods[i];
        u.dirty = true;
      }
      u.stealthBonus = stealth[i];
    }
  }

  /** 조건 만족 시 관련 유닛 목록, 아니면 null */
  private synergyInvolved(tr: TeamRuntime, syn: SynergyDef): Unit[] | null {
    const cond = syn.condition;
    const members = tr.members;
    switch (cond.kind) {
      case 'always':
        return members;
      case 'map':
        return cond.map === this.input.map ? members : null;
      case 'job_count': {
        const list: Unit[] = [];
        for (let i = 0; i < members.length; i++) if (members[i].job === cond.job) list.push(members[i]);
        return list.length >= cond.count ? list : null;
      }
      case 'adjacency': {
        let ua: Unit | null = null;
        let ub: Unit | null = null;
        for (let i = 0; i < members.length; i++) {
          if (members[i].id === cond.a) ua = members[i];
          if (members[i].id === cond.b) ub = members[i];
        }
        if (!ua || !ub || ua === ub) return null;
        if (!ua.alive || !ub.alive) return null;
        if (dist(ua, ub) > cond.adjRadius) return null;
        return [ua, ub];
      }
    }
  }

  // ───────── 틱 ─────────

  step(): BattleFrame {
    if (this._finished) return this.frame;
    this.tick++;
    this.time = this.tick * TICK_DT;
    this.events = [];

    this.evaluateSynergies();
    this.updateVision();

    const units = this.units;
    const count = units.length; // 이번 틱에 새로 생긴 소환물은 다음 틱부터 행동
    for (let i = 0; i < count; i++) {
      const u = units[i];
      if (!u.alive) continue;
      this.tickUnit(u);
    }
    this.separate();
    this.tickZones(); // 광역 영역: 유닛 처리 뒤, 생성 순서
    this.updateCapture();
    this.checkVictory();

    this.frame = this.buildFrame(this.events);
    if (this._finished) this._result = this.buildResult();
    return this.frame;
  }

  currentFrame(): BattleFrame {
    return this.frame;
  }

  result(): BattleResult | null {
    return this._result;
  }

  runToEnd(): BattleResult {
    let guard = 0;
    while (!this._finished && guard < this.hardCapTicks + 2) {
      this.step();
      guard++;
    }
    if (!this._finished) {
      this.resolveTimeout();
      this.frame = this.buildFrame(this.events);
      this._result = this.buildResult();
    }
    return this._result as BattleResult;
  }

  private updateVision(): void {
    const r = this.visionRadius;
    const units = this.units;
    if (r <= 0) {
      for (let i = 0; i < units.length; i++) units[i].visible = true;
      return;
    }
    const r2 = r * r;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u.alive) {
        u.visible = false;
        continue;
      }
      const enemies = u.side === 'A' ? this.teams.B.all : this.teams.A.all;
      let vis = false;
      for (let j = 0; j < enemies.length; j++) {
        const e = enemies[j];
        if (!e.alive) continue;
        const dx = e.x - u.x;
        const dy = e.y - u.y;
        if (dx * dx + dy * dy <= r2) {
          vis = true;
          break;
        }
      }
      u.visible = vis;
    }
  }

  private tickUnit(u: Unit): void {
    const dt = TICK_DT;
    // 소환물 지속시간
    if (u.isSummon && this.time >= u.summonExpire) {
      u.alive = false;
      u.hp = 0;
      u.statuses.length = 0;
      u.cast = null;
      return;
    }
    // 타이머
    for (let i = 0; i < u.cooldowns.length; i++) if (u.cooldowns[i] > 0) u.cooldowns[i] -= dt;
    if (u.attackTimer > 0) u.attackTimer -= dt;
    if (u.eff.mpRegen > 0 && u.mp < u.eff.maxMp) u.mp = Math.min(u.eff.maxMp, u.mp + u.eff.mpRegen * dt);

    // 상태 틱 (도트/재생/만료)
    this.tickStatuses(u);
    if (!u.alive) return;

    // 버프 만료
    if (u.buffs.length > 0) {
      for (let i = u.buffs.length - 1; i >= 0; i--) {
        const b = u.buffs[i];
        b.remaining -= dt;
        if (b.remaining <= 0) {
          u.buffs.splice(i, 1);
          u.dirty = true;
        }
      }
    }
    if (u.dirty) this.recomputeDerived(u);
    this.updateFatigue(u);

    // 기절/빙결 중에는 행동 불가. 시전은 취소하지 않고 멈춘다 —
    // 시전 중단 여부는 applyStatus 의 집중(focus) 저항 판정이 단일 기준이다.
    if (isDisabled(u)) return;

    // 회피 이동 중 (GDD §4.4 / §6.2): 예고가 끝날 때까지 탈출점으로만 움직이고 다른 행동은 하지 않는다
    if (u.dodgeUntilTick >= this.tick) {
      // 생성 틱(dodgeFromTick 이전)에는 움직이지 않는다 → 처리 순서와 무관하게 예고 틱 수만큼만 이동한다
      if (this.tick >= u.dodgeFromTick) this.dodgeMove(u);
      return;
    }

    // 시전 중
    if (u.cast) {
      const cs = u.cast;
      cs.progress += dt * u.eff.castSpeed;
      if (cs.progress >= cs.total) {
        u.cast = null;
        this.executeSkill(u, cs.skillIdx, cs.targetIdx, cs.tx, cs.ty);
      }
      return;
    }

    // 타겟 선택
    this.updateTarget(u);

    // 후퇴 판단 (용기)
    if (
      u.retreatUntil < this.time &&
      this.time >= u.retreatReadyAt &&
      u.courage < 50 &&
      u.hp < u.eff.maxHp * 0.3
    ) {
      u.retreatUntil = this.time + RETREAT_SEC;
      u.retreatReadyAt = this.time + RETREAT_SEC + RETREAT_COOLDOWN_SEC;
    }

    // 스킬
    if (u.activeSkills.length > 0 && !hasStatus(u, 'silence')) {
      if (this.trySkills(u)) return;
    }

    // 기본 공격
    const target = u.targetIdx >= 0 ? this.units[u.targetIdx] : null;
    if (target && target.alive && u.attackTimer <= 0) {
      const d = dist(u, target);
      if (d <= u.eff.range + RANGE_SLACK) {
        this.basicAttack(u, target);
      }
    }

    // 이동
    this.moveUnit(u, target && target.alive ? target : null);
  }

  private tickStatuses(u: Unit): void {
    const dt = TICK_DT;
    const list = u.statuses;
    if (list.length === 0) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (s.kind === 'burn' || s.kind === 'poison') {
        // 죽은 유닛은 행동하지 않는다: 시전자가 죽었으면 지속 피해의 딜량/킬 공적을 주지 않는다
        const srcRaw = s.source >= 0 ? this.units[s.source] : null;
        const src = srcRaw && srcRaw.alive ? srcRaw : null;
        this.dealDamage(src, u, s.value * dt, s.kind === 'burn' ? 'magic' : 'phys', false, false);
        if (!u.alive) return;
      } else if (s.kind === 'regen') {
        this.heal(s.source >= 0 ? this.units[s.source] : null, u, s.value * dt, false);
      }
      if (s.remaining !== Infinity) {
        s.remaining -= dt;
        if (s.remaining <= 0 || (s.kind === 'shield' && s.value <= 0)) list.splice(i, 1);
      }
    }
  }

  // ───────── 타겟팅 ─────────

  private isTargetable(e: Unit): boolean {
    return e.alive && e.visible && !hasStatus(e, 'stealth');
  }

  private updateTarget(u: Unit): void {
    // 도발: 시전자 강제
    for (let i = 0; i < u.statuses.length; i++) {
      const s = u.statuses[i];
      if (s.kind === 'taunt' && s.source >= 0) {
        const src = this.units[s.source];
        if (src.alive && src.side !== u.side) {
          u.targetIdx = src.idx;
          return;
        }
      }
    }
    const cur = u.targetIdx >= 0 ? this.units[u.targetIdx] : null;
    const curValid = cur !== null && this.isTargetable(cur);
    if (curValid && this.tick < u.retargetTick) return;
    u.retargetTick = this.tick + RETARGET_TICKS;
    const picked = this.pickTarget(u);
    u.targetIdx = picked ? picked.idx : -1;
  }

  private pickTarget(u: Unit): Unit | null {
    const enemies = u.side === 'A' ? this.teams.B.all : this.teams.A.all;
    let nearest: Unit | null = null;
    let nearestD = Infinity;
    let anyCandidate = false;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!this.isTargetable(e)) continue;
      anyCandidate = true;
      const d = dist(u, e);
      if (d < nearestD) {
        nearestD = d;
        nearest = e;
      }
    }
    if (!anyCandidate) return null;

    if (u.isSummon || u.role === 'tank' || u.role === 'healer') return nearest;

    if (u.role === 'assassin') {
      // 후방 딜러 우선
      let best: Unit | null = null;
      let bestD = Infinity;
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (e.isSummon || e.job === 'summon' || !BACKLINE_JOB[e.job]) continue;
        if (!this.isTargetable(e)) continue;
        const d = dist(u, e);
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      }
      // 은신 중이거나 후방 딜러가 사실상 가장 가까울 때만 후방을 노린다. 아니면 전열을 가로질러 걸어가다 죽으므로 가장 가까운 적.
      if (best && (hasStatus(u, 'stealth') || bestD <= nearestD + ASSASSIN_BACKLINE_SLACK)) return best;
      return nearest;
    }

    if (u.judgment < 60) return nearest;

    // 판단력 높음: 체력 낮고 위험한 적 우선
    let maxDanger = 1;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!this.isTargetable(e)) continue;
      const dg = Math.max(e.eff.physAtk, e.eff.magAtk);
      if (dg > maxDanger) maxDanger = dg;
    }
    let best: Unit | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!this.isTargetable(e)) continue;
      const hpRatio = e.hp / e.eff.maxHp;
      const danger = Math.max(e.eff.physAtk, e.eff.magAtk) / maxDanger;
      const d = dist(u, e);
      let score = hpRatio * 100 + (1 - danger) * 40 + d * 1.5;
      if (e.isSummon) score += 30;
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best ?? nearest;
  }

  // ───────── 이동 ─────────

  private isRangedBehavior(u: Unit): boolean {
    if (u.isSummon) return u.eff.range >= 3;
    return u.role === 'ranged_dps' || u.role === 'mage' || u.role === 'summoner';
  }

  private moveUnit(u: Unit, target: Unit | null): void {
    const tr = this.teams[u.side];
    let dx = 0;
    let dy = 0;
    let wantMove = false;

    const teamworkDrift = (): { x: number; y: number } | null => {
      if (u.isSummon || u.teamwork < 60) return null;
      const members = tr.members;
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (let i = 0; i < members.length; i++) {
        const m = members[i];
        if (!m.alive) continue;
        cx += m.x;
        cy += m.y;
        n++;
      }
      if (n <= 1) return null;
      cx /= n;
      cy /= n;
      if (distXY(u, cx, cy) <= TEAMWORK_DRIFT_DIST) return null;
      return { x: cx - u.x, y: cy - u.y };
    };

    if (u.retreatUntil >= this.time) {
      // 후퇴: 자기 스폰 방향
      const d = distXY(u, tr.spawnCenterX, tr.spawnCenterY);
      if (d > 1) {
        dx = tr.spawnCenterX - u.x;
        dy = tr.spawnCenterY - u.y;
        wantMove = true;
      }
    } else if (u.role === 'healer') {
      // 힐러: 전열 아군 뒤 4유닛
      let front: Unit | null = null;
      let frontD = Infinity;
      let anyAlly: Unit | null = null;
      let anyD = Infinity;
      const members = tr.members;
      for (let i = 0; i < members.length; i++) {
        const m = members[i];
        if (!m.alive || m === u) continue;
        const d = dist(u, m);
        if (m.job !== 'summon' && FRONTLINE_JOB[m.job]) {
          if (d < frontD) {
            frontD = d;
            front = m;
          }
        }
        if (d < anyD) {
          anyD = d;
          anyAlly = m;
        }
      }
      const anchor = front ?? anyAlly;
      if (target && dist(u, target) < HEALER_FLEE_DIST) {
        dx = u.x - target.x;
        dy = u.y - target.y;
        wantMove = true;
      } else if (anchor) {
        let bx = tr.spawnCenterX - anchor.x;
        let by = tr.spawnCenterY - anchor.y;
        const bl = Math.sqrt(bx * bx + by * by);
        if (bl > 0.001) {
          bx /= bl;
          by /= bl;
        } else {
          bx = u.side === 'A' ? -1 : 1;
          by = 0;
        }
        const wx = anchor.x + bx * HEALER_BACK_DIST;
        const wy = anchor.y + by * HEALER_BACK_DIST;
        if (distXY(u, wx, wy) > 1) {
          dx = wx - u.x;
          dy = wy - u.y;
          wantMove = true;
        }
      } else if (target) {
        const d = dist(u, target);
        if (d > u.eff.range * 0.9) {
          dx = target.x - u.x;
          dy = target.y - u.y;
          wantMove = true;
        }
      } else {
        const adv = this.advancePoint(u);
        dx = adv.x - u.x;
        dy = adv.y - u.y;
        wantMove = true;
      }
    } else if (target) {
      const d = dist(u, target);
      const range = u.eff.range;
      const ranged = this.isRangedBehavior(u);
      if (ranged && d < range * KITE_RATIO) {
        dx = u.x - target.x;
        dy = u.y - target.y;
        wantMove = true;
      } else if (d > range * 0.9) {
        dx = target.x - u.x;
        dy = target.y - u.y;
        wantMove = true;
        const drift = teamworkDrift();
        if (drift) {
          const l1 = Math.sqrt(dx * dx + dy * dy) || 1;
          const l2 = Math.sqrt(drift.x * drift.x + drift.y * drift.y) || 1;
          dx = dx / l1 + (drift.x / l2) * 0.7;
          dy = dy / l1 + (drift.y / l2) * 0.7;
        }
      } else {
        const drift = teamworkDrift();
        if (drift) {
          dx = drift.x;
          dy = drift.y;
          wantMove = true;
        }
      }
    } else {
      const adv = this.advancePoint(u);
      dx = adv.x - u.x;
      dy = adv.y - u.y;
      wantMove = distXY(u, adv.x, adv.y) > 0.5;
    }

    if (!wantMove) return;
    this.stepToward(u, dx, dy, 1, Infinity);
  }

  /**
   * (dx,dy) 방향으로 한 틱 이동. speedMult 는 이동속도 배율(회피 1.15), maxLen 은 이번 틱 최대 이동 거리.
   * 둔화·맵 이동속도 배율·빙하 미끄러짐·경계 클램프를 여기서 한 번에 처리한다.
   */
  private stepToward(u: Unit, dx: number, dy: number, speedMult: number, maxLen: number): void {
    const map = this.map;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.0001) return;
    dx /= len;
    dy /= len;

    let speed = u.eff.moveSpeed * map.moveSpeedMult * speedMult;
    const slow = statusValue(u, 'slow');
    if (slow > 0) speed *= Math.max(0, 1 - slow);
    if (speed <= 0) return;
    let stepLen = speed * TICK_DT;
    if (stepLen > maxLen) stepLen = maxLen;
    if (stepLen <= 0) return;
    let nx = u.x + dx * stepLen;
    let ny = u.y + dy * stepLen;
    if (map.slipFactor > 0) {
      // 빙하: 진행 방향에 수직인 미끄러짐
      const wobble = this.rng.float(-1, 1) * map.slipFactor * stepLen;
      nx += -dy * wobble;
      ny += dx * wobble;
    }
    u.x = clamp(nx, 0.5, map.width - 0.5);
    u.y = clamp(ny, 0.5, map.height - 0.5);
    u.facing = Math.atan2(dy, dx);
  }

  /** 회피 이동: 탈출점으로 이동속도 × 1.15. 도착하면 그 자리에서 예고가 끝나길 기다린다 */
  private dodgeMove(u: Unit): void {
    const dx = u.dodgeX - u.x;
    const dy = u.dodgeY - u.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.05) return;
    this.stepToward(u, dx, dy, DODGE_SPEED_MULT, len);
  }

  /** 보이는 적이 없을 때 향할 지점 */
  private advancePoint(u: Unit): { x: number; y: number } {
    const map = this.map;
    const enemy = u.side === 'A' ? this.teams.B : this.teams.A;
    // 살아있는 적이 있으면 가장 가까운 적의 위치로 향한다 (시야 밖이어도 '마지막 목격 위치' 수준의 AI).
    // 어둠 맵에서 중앙↔적 스폰 사이만 오가며 적을 영영 못 찾는 무승부를 막는다.
    let nearest: Unit | null = null;
    let nearestD = Infinity;
    for (let i = 0; i < enemy.all.length; i++) {
      const e = enemy.all[i];
      if (!e.alive) continue;
      const d = dist(u, e);
      if (d < nearestD) {
        nearestD = d;
        nearest = e;
      }
    }
    if (nearest) return { x: nearest.x, y: nearest.y };
    let px: number;
    let py: number;
    if (map.capture) {
      px = map.capture.x;
      py = map.capture.y;
    } else {
      px = map.width / 2;
      py = map.height / 2;
    }
    if (distXY(u, px, py) <= 2) {
      return { x: enemy.spawnCenterX, y: enemy.spawnCenterY };
    }
    return { x: px, y: py };
  }

  private separate(): void {
    const units = this.units;
    const map = this.map;
    const n = units.length;
    for (let i = 0; i < n; i++) {
      const a = units[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < n; j++) {
        const b = units[j];
        if (!b.alive) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.sqrt(dx * dx + dy * dy);
        if (d >= SEPARATION_DIST) continue;
        if (d < 0.0001) {
          dx = 1;
          dy = 0;
          d = 0.0001;
        }
        const push = (SEPARATION_DIST - d) * 0.5;
        const ux = dx / d;
        const uy = dy / d;
        a.x = clamp(a.x - ux * push, 0.5, map.width - 0.5);
        a.y = clamp(a.y - uy * push, 0.5, map.height - 0.5);
        b.x = clamp(b.x + ux * push, 0.5, map.width - 0.5);
        b.y = clamp(b.y + uy * push, 0.5, map.height - 0.5);
      }
    }
  }

  // ───────── 피해 / 회복 ─────────

  private breakStealth(u: Unit): void {
    removeStatus(u, 'stealth');
  }

  /**
   * 피해 적용. 반환값은 실제 HP 감소량.
   * ignoreShield=false 면 보호막이 먼저 흡수. allowReflect 는 반사 재귀 방지.
   */
  private dealDamage(src: Unit | null, victim: Unit, amount: number, school: 'phys' | 'magic', allowReflect: boolean, isDirect: boolean): number {
    if (!victim.alive || amount <= 0) return 0;
    if (hasStatus(victim, 'invuln')) return 0;
    if (hasStatus(victim, 'freeze')) amount *= FREEZE_DAMAGE_MULT;
    let remaining = amount;
    // 보호막 흡수
    for (let i = 0; i < victim.statuses.length && remaining > 0; i++) {
      const s = victim.statuses[i];
      if (s.kind !== 'shield' || s.value <= 0) continue;
      const absorb = Math.min(s.value, remaining);
      s.value -= absorb;
      remaining -= absorb;
    }
    if (remaining > 0) {
      victim.hp -= remaining;
      victim.stats.damageTaken += remaining;
      if (src) src.stats.damageDealt += remaining;
    }
    if (src && src.alive && src !== victim && isDirect) {
      const ls = statusValue(src, 'lifesteal');
      if (ls > 0 && remaining > 0) this.heal(src, src, remaining * ls, false);
      if (allowReflect && school === 'phys') {
        const rf = statusValue(victim, 'reflect');
        if (rf > 0) this.dealDamage(victim, src, amount * rf, 'phys', false, false);
      }
    }
    if (victim.hp <= 0) this.kill(victim, src);
    return remaining;
  }

  /**
   * 직접 물리 피해에 대한 반사량을 피해 적용 전에 계산한다 (dealDamage 와 같은 무효 조건).
   * 공격 이벤트를 먼저 기록한 뒤 applyReflect 로 반사를 적용하면 "죽은 유닛이 공격" 하는 이벤트 순서가 생기지 않는다.
   */
  private reflectAmount(victim: Unit, amount: number, school: 'phys' | 'magic'): number {
    if (school !== 'phys' || !victim.alive || amount <= 0) return 0;
    if (hasStatus(victim, 'invuln')) return 0;
    const rf = statusValue(victim, 'reflect');
    if (rf <= 0) return 0;
    return (hasStatus(victim, 'freeze') ? amount * FREEZE_DAMAGE_MULT : amount) * rf;
  }

  private applyReflect(attacker: Unit, victim: Unit, amount: number): void {
    if (amount <= 0 || !attacker.alive || attacker === victim) return;
    this.dealDamage(victim, attacker, amount, 'phys', false, false);
  }

  private kill(victim: Unit, killer: Unit | null): void {
    if (!victim.alive) return;
    victim.alive = false;
    victim.hp = 0;
    victim.cast = null;
    victim.dodgeUntilTick = -1;
    victim.statuses.length = 0;
    victim.buffs.length = 0;
    victim.stats.deaths += 1;
    victim.stats.survived = false;
    let killerId = victim.id;
    if (killer && killer !== victim) {
      killer.stats.kills += 1;
      killerId = killer.id;
    }
    this.pushEvent({ t: this.time, kind: 'kill', killer: killerId, victim: victim.id });
  }

  private heal(src: Unit | null, target: Unit, amount: number, emit: boolean): number {
    if (!target.alive || amount <= 0) return 0;
    const actual = Math.min(amount, target.eff.maxHp - target.hp);
    if (actual <= 0) return 0;
    target.hp += actual;
    if (src) src.stats.healingDone += actual;
    if (emit && src) this.pushEvent({ t: this.time, kind: 'heal', from: src.id, to: target.id, amount: Math.round(actual) });
    return actual;
  }

  private hitRoll(attacker: Unit, victim: Unit): boolean {
    return this.hitRollAcc(attacker.eff.accuracy, victim);
  }

  private hitRollAcc(accuracy: number, victim: Unit): boolean {
    const chance = clamp(70 + (accuracy - victim.eff.evasion) * 0.3, 30, 100);
    return this.rng.chance(chance / 100);
  }

  private critRoll(attacker: Unit): boolean {
    return this.critRollChance(attacker.eff.critChance);
  }

  private critRollChance(critChance: number): boolean {
    const c = clamp(critChance, 0, 100);
    if (c <= 0) return false;
    return this.rng.chance(c / 100);
  }

  private basicAttack(u: Unit, target: Unit): void {
    u.attackTimer = 1 / u.eff.atkSpeed;
    u.facing = Math.atan2(target.y - u.y, target.x - u.x);
    this.breakStealth(u);
    const school = u.attackSchool;
    if (!this.hitRoll(u, target)) {
      this.pushEvent({ t: this.time, kind: 'attack', from: u.id, to: target.id, damage: 0, crit: false, school, miss: true });
      return;
    }
    const atk = school === 'phys' ? u.eff.physAtk : u.eff.magAtk;
    const def = school === 'phys' ? target.eff.physDef : target.eff.magDef;
    let dmg = atk * (100 / (100 + Math.max(0, def)));
    const crit = this.critRoll(u);
    if (crit) dmg *= u.eff.critMult / 100;
    // 반사는 공격 이벤트를 기록한 뒤 적용한다 (이벤트 순서: 공격 → 반사 → 킬)
    const reflect = this.reflectAmount(target, dmg, school);
    // 공격 이벤트를 피해 적용 전에 기록한다 (dealDamage 가 킬 이벤트를 밀어 넣으므로). 피해량은 같은 객체에 채운다.
    const ev = { t: this.time, kind: 'attack' as const, from: u.id, to: target.id, damage: 0, crit, school };
    this.pushEvent(ev);
    ev.damage = Math.round(this.dealDamage(u, target, dmg, school, false, true));
    this.applyReflect(u, target, reflect);
  }

  // ───────── 상태이상 ─────────

  private applyStatus(target: Unit, kind: StatusKind, durationSec: number, value: number, source: Unit | null, chance: number): void {
    if (!target.alive) return;
    const harmful = HARMFUL_STATUS[kind];
    let duration = durationSec;
    if (harmful) {
      if (hasStatus(target, 'invuln')) {
        this.pushEvent({ t: this.time, kind: 'status', to: target.id, status: kind, applied: false });
        return;
      }
      chance *= 1 - clamp(target.resistance, 0, 100) * 0.002;
      duration *= 1 - clamp(target.composure, 0, 100) * 0.002;
    }
    if (chance < 1 && !this.rng.chance(Math.max(0, chance))) {
      this.pushEvent({ t: this.time, kind: 'status', to: target.id, status: kind, applied: false });
      return;
    }
    if (kind === 'stealth') duration += this.map.stealthBonusSec + target.stealthBonus;
    if (duration <= 0) duration = TICK_DT;
    const srcIdx = source ? source.idx : -1;
    // 같은 종류의 기존 항목과 합친다. 단, 패시브(영구, remaining=Infinity) 항목에는 시한부 적용을 합치지 않는다 —
    // 합치면 패시브 값이 영구히 덮어써진다. 보호막은 흡수량 합산이므로 예외.
    let existing: Status | null = null;
    for (let i = 0; i < target.statuses.length; i++) {
      const s = target.statuses[i];
      if (s.kind !== kind) continue;
      if (s.remaining === Infinity && kind !== 'shield') continue;
      existing = s;
      break;
    }
    if (existing) {
      if (kind === 'shield') existing.value += value;
      else if (value > existing.value) existing.value = value;
      if (existing.remaining !== Infinity && duration > existing.remaining) existing.remaining = duration;
      if (srcIdx >= 0) existing.source = srcIdx;
    } else {
      target.statuses.push({ kind, remaining: duration, value, source: srcIdx });
    }
    // 시전 중단 (집중으로 저항)
    if ((kind === 'stun' || kind === 'freeze') && target.cast) {
      if (!this.rng.chance(clamp(target.focus, 0, 100) * 0.003)) {
        const cs = target.cast;
        target.cast = null;
        if (cs.skillIdx < target.cooldowns.length && target.cooldowns[cs.skillIdx] < INTERRUPT_COOLDOWN_SEC) {
          target.cooldowns[cs.skillIdx] = INTERRUPT_COOLDOWN_SEC;
        }
      }
    }
    this.pushEvent({ t: this.time, kind: 'status', to: target.id, status: kind, applied: true });
  }

  /**
   * 장판 안에 계속 있는 유닛의 기존 상태를 조용히(이벤트·판정 없이) 갱신한다.
   * 시한부 항목의 남은 시간을 durationSec(침착 보정) 이상으로 늘리고 값이 크면 덮어쓴다. 기존 항목이 없으면 false.
   */
  private refreshStatus(target: Unit, kind: StatusKind, durationSec: number, value: number, source: Unit | null): boolean {
    let duration = durationSec;
    if (HARMFUL_STATUS[kind]) duration *= 1 - clamp(target.composure, 0, 100) * 0.002;
    if (duration <= 0) duration = TICK_DT;
    for (let i = 0; i < target.statuses.length; i++) {
      const s = target.statuses[i];
      if (s.kind !== kind || s.remaining === Infinity) continue;
      if (duration > s.remaining) s.remaining = duration;
      if (value > s.value) s.value = value;
      if (source) s.source = source.idx;
      return true;
    }
    return false;
  }

  private cleanse(target: Unit): void {
    for (let i = target.statuses.length - 1; i >= 0; i--) {
      if (HARMFUL_STATUS[target.statuses[i].kind]) target.statuses.splice(i, 1);
    }
    let changed = false;
    for (let i = target.buffs.length - 1; i >= 0; i--) {
      if (target.buffs[i].pct < 0) {
        target.buffs.splice(i, 1);
        changed = true;
      }
    }
    if (changed) target.dirty = true;
  }

  private addBuff(target: Unit, stat: DerivedStatKey, pct: number, durationSec: number): void {
    if (!target.alive || pct === 0) return;
    target.buffs.push({ stat, pct, remaining: Math.max(TICK_DT, durationSec) });
    target.dirty = true;
  }

  // ───────── 스킬 ─────────

  private trySkills(u: Unit): boolean {
    for (let i = 0; i < u.activeSkills.length; i++) {
      if (u.cooldowns[i] > 0) continue;
      const sk = u.activeSkills[i];
      if (u.mp < sk.mpCost) continue;
      const tgt = this.findSkillTarget(u, sk);
      if (!tgt) continue;
      if (!this.checkCondition(u, sk, tgt.idx)) continue;
      if (sk.castTimeSec > 0) {
        // MP 와 쿨타임은 시전 완료(executeSkill) 시점에 소모된다. 그래서 시전이 취소되면 자연히 환불·미시작 상태다.
        u.cast = { skillIdx: i, targetIdx: tgt.idx, tx: tgt.x, ty: tgt.y, progress: 0, total: sk.castTimeSec };
        if (tgt.idx >= 0 && tgt.idx !== u.idx) {
          const t = this.units[tgt.idx];
          u.facing = Math.atan2(t.y - u.y, t.x - u.x);
        }
      } else {
        this.executeSkill(u, i, tgt.idx, tgt.x, tgt.y);
      }
      return true;
    }
    return false;
  }

  private findSkillTarget(u: Unit, sk: SkillDef): { idx: number; x: number; y: number } | null {
    const range = sk.range > 0 ? sk.range : u.eff.range;
    switch (sk.target) {
      case 'self':
        return { idx: u.idx, x: u.x, y: u.y };
      case 'enemy':
      case 'enemy_area':
      case 'line': {
        const cur = u.targetIdx >= 0 ? this.units[u.targetIdx] : null;
        if (cur && this.isTargetable(cur) && dist(u, cur) <= range + RANGE_SLACK) return { idx: cur.idx, x: cur.x, y: cur.y };
        const enemies = u.side === 'A' ? this.teams.B.all : this.teams.A.all;
        let best: Unit | null = null;
        let bestD = Infinity;
        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (!this.isTargetable(e)) continue;
          const d = dist(u, e);
          if (d <= range + RANGE_SLACK && d < bestD) {
            bestD = d;
            best = e;
          }
        }
        return best ? { idx: best.idx, x: best.x, y: best.y } : null;
      }
      case 'ally':
      case 'ally_lowest_hp':
      case 'ally_area': {
        const ally = this.lowestHpAlly(u, range);
        if (!ally) return null;
        if (skillHasHeal(sk) && !sk.aiCondition) {
          const threshold = u.judgment >= 60 ? 0.75 : 0.9;
          if (ally.hp / ally.eff.maxHp >= threshold) return null;
        }
        return { idx: ally.idx, x: ally.x, y: ally.y };
      }
    }
  }

  private lowestHpAlly(u: Unit, range: number): Unit | null {
    const members = this.teams[u.side].members;
    let best: Unit | null = null;
    let bestRatio = Infinity;
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      if (!m.alive) continue;
      if (m !== u && dist(u, m) > range + RANGE_SLACK) continue;
      const r = m.hp / m.eff.maxHp;
      if (r < bestRatio) {
        bestRatio = r;
        best = m;
      }
    }
    if (!best && u.alive) best = u;
    return best;
  }

  private checkCondition(u: Unit, sk: SkillDef, targetIdx: number): boolean {
    const cond = sk.aiCondition;
    if (!cond || cond === 'always') return true;
    const target = targetIdx >= 0 ? this.units[targetIdx] : null;
    switch (cond) {
      case 'self_hp_below_50':
        return u.hp < u.eff.maxHp * 0.5;
      case 'self_hp_below_30':
        return u.hp < u.eff.maxHp * 0.3;
      case 'ally_hp_below_60':
      case 'ally_hp_below_40': {
        const th = cond === 'ally_hp_below_60' ? 0.6 : 0.4;
        const members = this.teams[u.side].members;
        for (let i = 0; i < members.length; i++) {
          const m = members[i];
          if (m.alive && m.hp < m.eff.maxHp * th) return true;
        }
        return false;
      }
      case 'enemies_clustered_2':
      case 'enemies_clustered_3': {
        const need = cond === 'enemies_clustered_2' ? 2 : 3;
        const cx = target && target.side !== u.side ? target.x : u.x;
        const cy = target && target.side !== u.side ? target.y : u.y;
        const r = sk.radius ?? 3;
        const enemies = u.side === 'A' ? this.teams.B.all : this.teams.A.all;
        let n = 0;
        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (e.alive && distXY(e, cx, cy) <= r) n++;
        }
        return n >= need;
      }
      case 'target_hp_below_30': {
        const t = target && target.side !== u.side ? target : u.targetIdx >= 0 ? this.units[u.targetIdx] : null;
        return !!t && t.alive && t.hp < t.eff.maxHp * 0.3;
      }
      case 'out_of_range': {
        const t = u.targetIdx >= 0 ? this.units[u.targetIdx] : null;
        return !!t && t.alive && dist(u, t) > u.eff.range + RANGE_SLACK;
      }
      case 'not_stealthed':
        return !hasStatus(u, 'stealth');
      case 'no_summons': {
        const all = this.teams[u.side].all;
        for (let i = 0; i < all.length; i++) {
          const s = all[i];
          if (s.isSummon && s.alive && s.ownerIdx === u.idx) return false;
        }
        return true;
      }
    }
  }

  /** 시전자의 현재 수치 스냅샷 (Zone 이 예고 뒤에 쓰기 위해) */
  private snapshotSource(u: Unit): EffectSource {
    return {
      u,
      physAtk: u.eff.physAtk,
      magAtk: u.eff.magAtk,
      critChance: u.eff.critChance,
      critMult: u.eff.critMult,
      accuracy: u.eff.accuracy,
      stealthedAtCast: hasStatus(u, 'stealth'),
      missingPct: (1 - u.hp / u.eff.maxHp) * 100,
    };
  }

  /**
   * 시전 완료. MP·쿨타임을 소모하고 효과를 적용한다.
   *  - enemy_area / line 에 예고(telegraph) 또는 장판(linger)이 있으면 Zone 을 만들고 영역 대상 효과는 impact 로 미룬다.
   *    시전자 측 효과(버프·소환·돌진 등)는 즉시 적용.
   *  - 그 외는 즉시 적용. ally_area 는 0.4초 표시용 영역, 예고 없는 적 광역은 폭발 표시만 남긴다.
   */
  private executeSkill(u: Unit, skillIdx: number, targetIdx: number, tx: number, ty: number): void {
    if (!u.alive) return;
    const sk = u.activeSkills[skillIdx];
    if (!sk) return;
    u.mp = Math.max(0, u.mp - sk.mpCost);
    u.cooldowns[skillIdx] = sk.cooldownSec * (1 - clamp(u.eff.cooldownReduction, 0, 90) / 100);
    u.stats.skillsUsed += 1;

    const allySkill = isAllySkill(sk);
    const range = sk.range > 0 ? sk.range : u.eff.range;

    // 대상 재확인 (시전 중 죽었을 수 있음)
    let primaryUnit: Unit | null = targetIdx >= 0 ? this.units[targetIdx] : null;
    if (allySkill) {
      if (sk.target === 'self') primaryUnit = u;
      else if (!primaryUnit || !primaryUnit.alive) {
        primaryUnit = this.lowestHpAlly(u, range);
      }
    } else {
      if (!primaryUnit || !this.isTargetable(primaryUnit)) {
        const alt = this.findSkillTarget(u, sk);
        primaryUnit = alt && alt.idx >= 0 ? this.units[alt.idx] : null;
      }
    }
    if (primaryUnit && primaryUnit.alive) {
      tx = primaryUnit.x;
      ty = primaryUnit.y;
    }
    if (primaryUnit && primaryUnit !== u) u.facing = Math.atan2(ty - u.y, tx - u.x);

    this.pushEvent({ t: this.time, kind: 'skill', from: u.id, skillId: sk.id, to: primaryUnit ? primaryUnit.id : null, x: tx, y: ty });

    const src = this.snapshotSource(u);
    const isZoneTarget = sk.target === 'enemy_area' || sk.target === 'line';
    const tele = isZoneTarget ? telegraphSecOf(sk) : 0;

    if (isZoneTarget && (tele > 0 || (sk.linger !== undefined && sk.linger.durationSec > 0))) {
      // 시전자 측 효과는 즉시 (돌진이 있으면 영역 기준점이 바뀌므로 먼저)
      this.applyEffects(src, sk, 'helpful', () => [], () => [u], tx, ty, u.x, u.y, primaryUnit, false);
      if (skillHasDamage(sk)) this.breakStealth(u);
      const z = this.makeZone(u, sk, src, tx, ty);
      this.zones.push(z);
      this.pushEvent({ t: this.time, kind: 'zone', from: u.id, skillId: sk.id, x: z.x, y: z.y });
      if (tele > 0) {
        const ticks = Math.max(1, Math.round(tele * TICK_RATE));
        z.telegraphTicksTotal = ticks;
        z.telegraphTicksLeft = ticks;
        this.rollDodges(z, tele);
      } else {
        // 예고 없는 장판: 즉시 impact 후 장판만 남는다
        this.impactZone(z);
      }
      return;
    }

    // ── 즉시 적용 ──
    const primaries = this.resolvePrimaryTargets(u, sk, primaryUnit, tx, ty);
    const enemies = u.side === 'A' ? this.teams.B.all : this.teams.A.all;

    let harmfulTargets: Unit[] | null = null;
    let helpfulTargets: Unit[] | null = null;
    const getHarmful = (): Unit[] => {
      if (harmfulTargets) return harmfulTargets;
      if (!allySkill) harmfulTargets = primaries;
      else {
        // 아군/자신 대상 스킬의 해로운 효과: 시전자 주변 적
        const r = sk.radius ?? u.eff.range;
        const list: Unit[] = [];
        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (e.alive && dist(u, e) <= r + RANGE_SLACK) list.push(e);
        }
        harmfulTargets = list;
      }
      return harmfulTargets;
    };
    const getHelpful = (): Unit[] => {
      if (helpfulTargets) return helpfulTargets;
      helpfulTargets = allySkill ? primaries : [u];
      return helpfulTargets;
    };

    this.applyEffects(src, sk, 'all', getHarmful, getHelpful, tx, ty, u.x, u.y, primaryUnit, allySkill);

    // 표시용 영역
    if (sk.target === 'ally_area') {
      const cx = primaryUnit && primaryUnit.alive ? primaryUnit.x : u.x;
      const cy = primaryUnit && primaryUnit.alive ? primaryUnit.y : u.y;
      const z = this.makeZone(u, sk, src, cx, cy);
      z.impactDone = true;
      z.displayOnly = true;
      z.lingerTicksTotal = ALLY_AREA_FLASH_TICKS;
      z.lingerTicksLeft = ALLY_AREA_FLASH_TICKS;
      this.zones.push(z);
      this.pushEvent({ t: this.time, kind: 'zone', from: u.id, skillId: sk.id, x: z.x, y: z.y });
    } else if (isZoneTarget) {
      const z = this.makeZone(u, sk, src, tx, ty);
      z.impactDone = true;
      z.displayOnly = true;
      z.flashTicksLeft = ZONE_FLASH_TICKS;
      this.zones.push(z);
      this.pushEvent({ t: this.time, kind: 'zone', from: u.id, skillId: sk.id, x: z.x, y: z.y });
    }
  }

  /**
   * 스킬 효과 목록 적용.
   * @param mode all = 전부 / harmful = 영역 대상 효과(Zone impact)만 / helpful = 시전자 측 효과만
   * @param ox,oy 넉백 기준점 (즉시 적용은 시전자 위치, Zone 은 영역 기준점)
   * harmful 모드에서는 시전자가 죽어 있어도 계속 적용한다 (이미 던져진 마법).
   */
  private applyEffects(
    src: EffectSource,
    sk: SkillDef,
    mode: EffectMode,
    getHarmful: () => Unit[],
    getHelpful: () => Unit[],
    tx: number,
    ty: number,
    ox: number,
    oy: number,
    primaryUnit: Unit | null,
    allySkill: boolean,
  ): void {
    const u = src.u;
    for (let ei = 0; ei < sk.effects.length; ei++) {
      const e = sk.effects[ei];
      const deferred = isZoneDeferredEffect(e);
      if (mode === 'harmful' && !deferred) continue;
      if (mode === 'helpful' && deferred) continue;
      if (!u.alive && mode !== 'harmful' && e.kind !== 'summon') break;
      switch (e.kind) {
        case 'damage': {
          const targets = getHarmful();
          if (targets.length === 0) break;
          let mult = e.coef;
          if (e.magic && e.magic !== 'none') mult *= this.map.schoolBonus[e.magic] ?? 1;
          else if (e.school === 'magic' && sk.magic !== 'none') mult *= this.map.schoolBonus[sk.magic] ?? 1;
          if (e.bonusIfStealth && src.stealthedAtCast) mult *= 1 + e.bonusIfStealth;
          if (e.bonusPerMissingHpPct) mult *= 1 + e.bonusPerMissingHpPct * src.missingPct;
          this.breakStealth(u);
          const atk = e.school === 'phys' ? src.physAtk : src.magAtk;
          const ignore = clamp(e.ignoreDefPct ?? 0, 0, 1);
          for (let ti = 0; ti < targets.length; ti++) {
            const t = targets[ti];
            if (!t.alive) continue;
            if (e.school === 'phys' && !this.hitRollAcc(src.accuracy, t)) {
              this.pushEvent({ t: this.time, kind: 'attack', from: u.id, to: t.id, damage: 0, crit: false, school: 'phys', miss: true });
              continue;
            }
            const def = (e.school === 'phys' ? t.eff.physDef : t.eff.magDef) * (1 - ignore);
            let dmg = atk * mult * (100 / (100 + Math.max(0, def)));
            const crit = this.critRollChance(src.critChance);
            if (crit) dmg *= src.critMult / 100;
            const reflect = this.reflectAmount(t, dmg, e.school);
            // 공격 이벤트 → 피해(킬) → 반사 순서 유지: 이벤트를 먼저 넣고 피해량을 채운다
            const ev = { t: this.time, kind: 'attack' as const, from: u.id, to: t.id, damage: 0, crit, school: e.school };
            this.pushEvent(ev);
            ev.damage = Math.round(this.dealDamage(u, t, dmg, e.school, false, true));
            this.applyReflect(u, t, reflect);
          }
          break;
        }
        case 'heal': {
          const targets = getHelpful();
          const amount = src.magAtk * e.coef;
          for (let ti = 0; ti < targets.length; ti++) this.heal(u, targets[ti], amount, true);
          break;
        }
        case 'status': {
          const harmful = HARMFUL_STATUS[e.status];
          const targets = harmful ? getHarmful() : getHelpful();
          const value = e.value ?? (e.status === 'shield' ? src.magAtk : 0);
          for (let ti = 0; ti < targets.length; ti++) {
            this.applyStatus(targets[ti], e.status, e.durationSec, value, u, e.chance ?? 1);
          }
          break;
        }
        case 'buff': {
          const targets = getHelpful();
          for (let ti = 0; ti < targets.length; ti++) this.addBuff(targets[ti], e.stat, e.pct, e.durationSec);
          break;
        }
        case 'debuff': {
          const targets = getHarmful();
          for (let ti = 0; ti < targets.length; ti++) this.addBuff(targets[ti], e.stat, -Math.abs(e.pct), e.durationSec);
          break;
        }
        case 'summon': {
          const n = Math.max(1, Math.floor(e.count));
          for (let k = 0; k < n; k++) {
            const ang = u.facing + ((k - (n - 1) / 2) * Math.PI) / 4;
            const sx = clamp(u.x + Math.cos(ang) * 1.5, 0.5, this.map.width - 0.5);
            const sy = clamp(u.y + Math.sin(ang) * 1.5, 0.5, this.map.height - 0.5);
            const s = this.createSummonUnit(u, e.unit, sx, sy, e.durationSec);
            this.pushEvent({ t: this.time, kind: 'summon', owner: u.id, unitId: s.id });
          }
          break;
        }
        case 'dash': {
          let dx = tx - u.x;
          let dy = ty - u.y;
          if (allySkill || (primaryUnit && primaryUnit.side === u.side)) {
            const t = u.targetIdx >= 0 ? this.units[u.targetIdx] : null;
            if (t && t.alive) {
              dx = t.x - u.x;
              dy = t.y - u.y;
            } else {
              dx = Math.cos(u.facing);
              dy = Math.sin(u.facing);
            }
          }
          const len = Math.sqrt(dx * dx + dy * dy);
          if (len < 0.0001) break;
          const move = Math.min(e.distance, Math.max(0, len - 0.8));
          if (move <= 0) break;
          u.x = clamp(u.x + (dx / len) * move, 0.5, this.map.width - 0.5);
          u.y = clamp(u.y + (dy / len) * move, 0.5, this.map.height - 0.5);
          u.facing = Math.atan2(dy, dx);
          break;
        }
        case 'knockback': {
          const targets = getHarmful();
          for (let ti = 0; ti < targets.length; ti++) {
            const t = targets[ti];
            if (!t.alive) continue;
            let dx = t.x - ox;
            let dy = t.y - oy;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len < 0.0001) {
              dx = Math.cos(u.facing);
              dy = Math.sin(u.facing);
            } else {
              dx /= len;
              dy /= len;
            }
            const resist = clamp(1 - clamp(t.strength, 0, 100) / 200, 0.3, 1);
            const d = e.distance * resist;
            t.x = clamp(t.x + dx * d, 0.5, this.map.width - 0.5);
            t.y = clamp(t.y + dy * d, 0.5, this.map.height - 0.5);
          }
          break;
        }
        case 'cleanse': {
          const targets = getHelpful();
          for (let ti = 0; ti < targets.length; ti++) this.cleanse(targets[ti]);
          break;
        }
        case 'restore_mp': {
          const targets = getHelpful();
          for (let ti = 0; ti < targets.length; ti++) {
            const t = targets[ti];
            if (t.alive) t.mp = Math.min(t.eff.maxMp, t.mp + e.amount);
          }
          break;
        }
      }
    }
  }

  private resolvePrimaryTargets(u: Unit, sk: SkillDef, primary: Unit | null, tx: number, ty: number): Unit[] {
    const enemies = u.side === 'A' ? this.teams.B.all : this.teams.A.all;
    switch (sk.target) {
      case 'self':
        return [u];
      case 'enemy':
        return primary && primary.alive && primary.side !== u.side ? [primary] : [];
      case 'ally':
      case 'ally_lowest_hp':
        return primary && primary.alive && primary.side === u.side ? [primary] : [];
      case 'enemy_area': {
        const r = sk.radius ?? 2;
        const list: Unit[] = [];
        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (e.alive && distXY(e, tx, ty) <= r) list.push(e);
        }
        return list;
      }
      case 'ally_area': {
        const r = sk.radius ?? 3;
        const cx = primary && primary.alive ? primary.x : u.x;
        const cy = primary && primary.alive ? primary.y : u.y;
        // 소환물 포함 (소환사 강화 등 '아군과 소환물' 대상 스킬)
        const allies = this.teams[u.side].all;
        const list: Unit[] = [];
        for (let i = 0; i < allies.length; i++) {
          const m = allies[i];
          if (m.alive && distXY(m, cx, cy) <= r) list.push(m);
        }
        return list;
      }
      case 'line': {
        const width = sk.radius ?? 1;
        const length = sk.range > 0 ? sk.range : u.eff.range;
        let dx = tx - u.x;
        let dy = ty - u.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.0001) {
          dx = Math.cos(u.facing);
          dy = Math.sin(u.facing);
        } else {
          dx /= len;
          dy /= len;
        }
        const list: Unit[] = [];
        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (!e.alive) continue;
          const rx = e.x - u.x;
          const ry = e.y - u.y;
          const proj = rx * dx + ry * dy;
          if (proj < -0.5 || proj > length + RANGE_SLACK) continue;
          const perp = Math.abs(rx * dy - ry * dx);
          if (perp <= width) list.push(e);
        }
        return list;
      }
    }
  }

  // ───────── 광역 영역 (Zone) ─────────

  /**
   * Zone 생성 (아직 목록에 넣지 않음).
   *  - enemy_area / ally_area: (tx,ty) 중심 원, 반경 sk.radius.
   *  - line: 시전자 위치 → (tx,ty) 방향 선분, 길이 = 스킬 사거리, 반폭 = sk.radius (스냅샷 width 는 전체 폭 = 반폭 × 2).
   */
  private makeZone(u: Unit, sk: SkillDef, src: EffectSource, tx: number, ty: number): Zone {
    this.zoneCounter++;
    const z: Zone = {
      id: 'z' + this.zoneCounter,
      side: u.side,
      casterIdx: u.idx,
      casterId: u.id,
      skillId: sk.id,
      skill: sk,
      shape: 'circle',
      x: tx,
      y: ty,
      radius: sk.radius ?? (sk.target === 'ally_area' ? 3 : 2),
      dirX: 0,
      dirY: 0,
      length: 0,
      halfWidth: 0,
      tx,
      ty,
      createdTick: this.tick,
      telegraphTicksTotal: 0,
      telegraphTicksLeft: 0,
      flashTicksLeft: 0,
      lingerTicksTotal: 0,
      lingerTicksLeft: 0,
      impactDone: false,
      displayOnly: false,
      src,
      lingerSchool: 'magic',
      lingerAtk: 0,
      lingerMult: 1,
    };
    if (sk.target === 'line') {
      let dx = tx - u.x;
      let dy = ty - u.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.0001) {
        dx = Math.cos(u.facing);
        dy = Math.sin(u.facing);
      } else {
        dx /= len;
        dy /= len;
      }
      const length = sk.range > 0 ? sk.range : u.eff.range;
      z.shape = 'line';
      z.x = u.x;
      z.y = u.y;
      z.radius = 0;
      z.dirX = dx;
      z.dirY = dy;
      z.length = length;
      z.halfWidth = sk.radius ?? 1;
      z.x2 = u.x + dx * length;
      z.y2 = u.y + dy * length;
      z.width = z.halfWidth * 2;
      z.tx = z.x2;
      z.ty = z.y2;
    }
    return z;
  }

  /** 유닛 중심이 영역 안에 있는가 */
  private zoneContains(z: Zone, u: Unit): boolean {
    return this.zoneContainsPoint(z, u.x, u.y);
  }

  /** 점 (x, y) 가 영역 안에 있는가 */
  private zoneContainsPoint(z: Zone, x: number, y: number): boolean {
    if (z.shape === 'circle') {
      const dx = x - z.x;
      const dy = y - z.y;
      return Math.sqrt(dx * dx + dy * dy) <= z.radius;
    }
    const rx = x - z.x;
    const ry = y - z.y;
    const proj = rx * z.dirX + ry * z.dirY;
    if (proj < -0.5 || proj > z.length + RANGE_SLACK) return false;
    const perp = Math.abs(rx * z.dirY - ry * z.dirX);
    return perp <= z.halfWidth;
  }

  /**
   * 영역 경계 밖으로 가장 가까운 탈출점 (+DODGE_ESCAPE_MARGIN 여유), 맵 경계 안으로 클램프.
   * 가장 가까운 방향이 맵 가장자리에 막혀 영역 안에 남으면 ±90° → 반대 방향 순으로 대안을 고른다 (순서 고정 → 결정론).
   */
  private escapePoint(z: Zone, u: Unit): { x: number; y: number } {
    const map = this.map;
    const minX = 0.5;
    const maxX = map.width - 0.5;
    const minY = 0.5;
    const maxY = map.height - 0.5;
    if (z.shape === 'circle') {
      let dx = u.x - z.x;
      let dy = u.y - z.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < DODGE_CENTER_EPS) {
        // 중심(≈자기 자리)에 떨어진 광역: 가장 가까운 밖이 없으므로 시전자 반대쪽으로. 시전자와 겹치면 바라보는 반대쪽.
        const c = this.units[z.casterIdx];
        dx = z.x - c.x;
        dy = z.y - c.y;
        const l2 = Math.sqrt(dx * dx + dy * dy);
        if (l2 < 0.0001) {
          dx = -Math.cos(u.facing);
          dy = -Math.sin(u.facing);
        } else {
          dx /= l2;
          dy /= l2;
        }
      } else {
        dx /= len;
        dy /= len;
      }
      const r = z.radius + DODGE_ESCAPE_MARGIN;
      const need = z.radius + DODGE_ESCAPE_MARGIN * 0.5;
      // 후보 방향: 가장 가까운 밖 → 왼쪽 90° → 오른쪽 90° → 반대
      const cx = [dx, -dy, dy, -dx];
      const cy = [dy, dx, -dx, -dy];
      let bestX = z.x;
      let bestY = z.y;
      let bestD = -1;
      for (let i = 0; i < 4; i++) {
        const ex = clamp(z.x + cx[i] * r, minX, maxX);
        const ey = clamp(z.y + cy[i] * r, minY, maxY);
        const d = Math.sqrt((ex - z.x) * (ex - z.x) + (ey - z.y) * (ey - z.y));
        if (d >= need) return { x: ex, y: ey };
        if (d > bestD) {
          bestD = d;
          bestX = ex;
          bestY = ey;
        }
      }
      return { x: bestX, y: bestY };
    }
    // line: 선분에 수직으로 빠져나간다. 정확히 선 위에 있으면 왼쪽 법선 우선. 막히면 반대 법선.
    const rx = u.x - z.x;
    const ry = u.y - z.y;
    const proj = rx * z.dirX + ry * z.dirY;
    const px = z.x + z.dirX * proj;
    const py = z.y + z.dirY * proj;
    const nx = -z.dirY;
    const ny = z.dirX;
    const s = rx * nx + ry * ny;
    const sign = s >= 0 ? 1 : -1;
    const w = z.halfWidth + DODGE_ESCAPE_MARGIN;
    const need = z.halfWidth + DODGE_ESCAPE_MARGIN * 0.5;
    let bestX = px;
    let bestY = py;
    let bestD = -1;
    for (let i = 0; i < 2; i++) {
      const sg = i === 0 ? sign : -sign;
      const ex = clamp(px + nx * sg * w, minX, maxX);
      const ey = clamp(py + ny * sg * w, minY, maxY);
      const perp = Math.abs((ex - z.x) * z.dirY - (ey - z.y) * z.dirX);
      if (perp >= need) return { x: ex, y: ey };
      if (perp > bestD) {
        bestD = perp;
        bestX = ex;
        bestY = ey;
      }
    }
    return { x: bestX, y: bestY };
  }

  /** 회피 가능 조건: 기절·빙결 아님, 이동속도 > 0, 도발 아님 */
  private canDodge(u: Unit): boolean {
    if (!u.alive || isDisabled(u)) return false;
    if (u.eff.moveSpeed <= 0) return false;
    if (hasStatus(u, 'taunt')) return false;
    return true;
  }

  /** 예고 시작 시 영역 안의 적마다 회피 판정 1회 (GDD §4.4) */
  private rollDodges(z: Zone, telegraphSec: number): void {
    const enemies = z.side === 'A' ? this.teams.B.all : this.teams.A.all;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.alive || !this.zoneContains(z, e)) continue;
      if (!this.canDodge(e)) continue;
      const p = dodgeChance(e.judgment, e.agility, telegraphSec);
      if (p <= 0 || !this.rng.chance(p)) continue;
      const until = this.tick + z.telegraphTicksTotal;
      if (e.dodgeUntilTick >= this.tick) {
        // 이미 다른 영역을 피하는 중: 기존 탈출점이 새 영역 밖이면 그대로 두고(앞서 성공한 회피를 무효화하지 않는다),
        // 안이면 새 영역의 탈출점으로 바꾼다. 기한은 둘 중 늦은 쪽.
        if (this.zoneContainsPoint(z, e.dodgeX, e.dodgeY)) {
          const esc = this.escapePoint(z, e);
          e.dodgeX = esc.x;
          e.dodgeY = esc.y;
        }
        if (until > e.dodgeUntilTick) e.dodgeUntilTick = until;
      } else {
        const esc = this.escapePoint(z, e);
        e.dodgeX = esc.x;
        e.dodgeY = esc.y;
        e.dodgeUntilTick = until;
        e.dodgeFromTick = this.tick + 1;
      }
      // 시전 취소. MP·쿨타임은 시전 완료 시점에 소모되므로 취소하면 아무것도 잃지 않는다 (환불·미시작).
      e.cast = null;
      this.pushEvent({ t: this.time, kind: 'dodge', unit: e.id, skillId: z.skillId });
    }
  }

  /** impact: 영역 안의 적에게 스킬의 영역 대상 효과를 적용하고 장판을 시작한다 */
  private impactZone(z: Zone): void {
    const caster = this.units[z.casterIdx];
    if (caster.alive) {
      // 시전자가 살아 있으면 impact 시점 수치 (버프 반영). 은신/잃은 HP 는 시전 시점 기준 유지
      const fresh = this.snapshotSource(caster);
      fresh.stealthedAtCast = z.src.stealthedAtCast;
      fresh.missingPct = z.src.missingPct;
      z.src = fresh;
    }
    const enemies = z.side === 'A' ? this.teams.B.all : this.teams.A.all;
    const targets: Unit[] = [];
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.alive && this.zoneContains(z, e)) targets.push(e);
    }
    this.applyEffects(z.src, z.skill, 'harmful', () => targets, () => [caster], z.tx, z.ty, z.x, z.y, null, false);

    z.impactDone = true;
    z.telegraphTicksLeft = 0;
    z.flashTicksLeft = ZONE_FLASH_TICKS;
    const lg = z.skill.linger;
    if (lg && lg.durationSec > 0) {
      const ticks = Math.max(1, Math.round(lg.durationSec * TICK_RATE));
      z.lingerTicksTotal = ticks;
      z.lingerTicksLeft = ticks;
      const school = lingerSchoolOf(z.skill);
      z.lingerSchool = school;
      z.lingerAtk = school === 'phys' ? z.src.physAtk : z.src.magAtk;
      z.lingerMult = school === 'magic' && z.skill.magic !== 'none' ? (this.map.schoolBonus[z.skill.magic] ?? 1) : 1;
    }
  }

  /** 장판 한 틱: 안에 있는 적에게 dpsCoef × 캐시된 공격력 × dt 피해(방어 적용)와 상태 */
  private tickLinger(z: Zone): void {
    const lg = z.skill.linger;
    if (!lg) return;
    const caster = this.units[z.casterIdx];
    const enemies = z.side === 'A' ? this.teams.B.all : this.teams.A.all;
    const base = z.lingerAtk * lg.dpsCoef * TICK_DT * z.lingerMult;
    const st = lg.status;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.alive || !this.zoneContains(z, e)) continue;
      if (base > 0) {
        const def = z.lingerSchool === 'phys' ? e.eff.physDef : e.eff.magDef;
        const dmg = base * (100 / (100 + Math.max(0, def)));
        this.dealDamage(caster, e, dmg, z.lingerSchool, false, false);
        if (!e.alive) continue;
      }
      if (st) {
        const value = st.value ?? 0;
        if (!this.refreshStatus(e, st.status, st.durationSec, value, caster)) {
          this.applyStatus(e, st.status, st.durationSec, value, caster, 1);
        }
      }
    }
  }

  /** 매 틱 (유닛 처리 뒤) Zone 을 생성 순서로 처리하고 끝난 것을 제거한다 */
  private tickZones(): void {
    const zones = this.zones;
    const n = zones.length;
    if (n === 0) return;
    for (let i = 0; i < n; i++) {
      const z = zones[i];
      if (z.createdTick === this.tick) continue; // 생성 틱: 카운트 유지 (프레임에는 progress 0 으로 보인다)
      if (!z.impactDone) {
        z.telegraphTicksLeft--;
        if (z.telegraphTicksLeft <= 0) this.impactZone(z);
        continue; // impact 틱의 프레임은 flash 로 보인다
      }
      if (z.flashTicksLeft > 0) z.flashTicksLeft--;
      if (z.lingerTicksLeft > 0) {
        if (!z.displayOnly) this.tickLinger(z);
        z.lingerTicksLeft--;
      }
    }
    let w = 0;
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      if (z.impactDone && z.flashTicksLeft <= 0 && z.lingerTicksLeft <= 0) continue;
      zones[w++] = z;
    }
    zones.length = w;
  }

  // ───────── 거점 / 승리 ─────────

  private updateCapture(): void {
    const cap = this.map.capture;
    if (!cap || this.map.victory !== 'capture_or_annihilation') return;
    let a = 0;
    let b = 0;
    const r2 = cap.radius * cap.radius;
    const units = this.units;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u.alive || u.isSummon) continue;
      const dx = u.x - cap.x;
      const dy = u.y - cap.y;
      if (dx * dx + dy * dy <= r2) {
        if (u.side === 'A') a++;
        else b++;
      }
    }
    const rate = TICK_DT / Math.max(0.1, cap.secondsToCapture);
    const prevHolder = this.captureHolder;
    let holder: TeamSide | null = null;
    if (a > 0 && b === 0) {
      holder = 'A';
      this.captureA = Math.min(1, this.captureA + rate);
      this.captureB = Math.max(0, this.captureB - rate);
    } else if (b > 0 && a === 0) {
      holder = 'B';
      this.captureB = Math.min(1, this.captureB + rate);
      this.captureA = Math.max(0, this.captureA - rate);
    }
    this.captureHolder = holder;
    if (holder && (holder !== prevHolder || this.tick % CAPTURE_EVENT_TICKS === 0)) {
      this.pushEvent({ t: this.time, kind: 'capture', side: holder, progress: holder === 'A' ? this.captureA : this.captureB });
    }
  }

  private aliveCount(side: TeamSide): number {
    const members = this.teams[side].members;
    let n = 0;
    for (let i = 0; i < members.length; i++) if (members[i].alive) n++;
    return n;
  }

  private hpSum(side: TeamSide): number {
    const members = this.teams[side].members;
    let s = 0;
    for (let i = 0; i < members.length; i++) if (members[i].alive) s += members[i].hp;
    return s;
  }

  private finish(winner: TeamSide | 'draw', reason: string): void {
    this._finished = true;
    this.winner = winner;
    this.reason = reason;
    this.pushEvent({ t: this.time, kind: 'end', winner, reason });
  }

  private checkVictory(): void {
    if (this._finished) return;
    const aliveA = this.aliveCount('A');
    const aliveB = this.aliveCount('B');
    if (aliveA === 0 && aliveB === 0) {
      this.finish('draw', 'annihilation');
      return;
    }
    if (aliveB === 0) {
      this.finish('A', 'annihilation');
      return;
    }
    if (aliveA === 0) {
      this.finish('B', 'annihilation');
      return;
    }
    if (this.map.victory === 'capture_or_annihilation') {
      if (this.captureA >= 1 && this.captureB >= 1) {
        this.finish('draw', 'capture');
        return;
      }
      if (this.captureA >= 1) {
        this.finish('A', 'capture');
        return;
      }
      if (this.captureB >= 1) {
        this.finish('B', 'capture');
        return;
      }
    }
    if (this.tick >= this.maxTicks) this.resolveTimeout();
  }

  private resolveTimeout(): void {
    if (this._finished) return;
    switch (this.map.victory) {
      case 'annihilation':
        this.finish('draw', 'timeout_draw');
        return;
      case 'annihilation_or_hp':
        this.finishByHp();
        return;
      case 'capture_or_annihilation': {
        if (this.captureA > this.captureB) this.finish('A', 'timeout_capture');
        else if (this.captureB > this.captureA) this.finish('B', 'timeout_capture');
        else this.finishByHp();
        return;
      }
    }
  }

  private finishByHp(): void {
    const a = this.hpSum('A');
    const b = this.hpSum('B');
    if (a > b) this.finish('A', 'timeout_hp');
    else if (b > a) this.finish('B', 'timeout_hp');
    else this.finish('draw', 'timeout_draw');
  }

  // ───────── 이벤트 / 프레임 / 결과 ─────────

  private pushEvent(e: BattleEvent): void {
    this.events.push(e);
    if (this.allEvents.length < MAX_RESULT_EVENTS) this.allEvents.push(e);
  }

  private zoneSnapshot(z: Zone): ZoneSnapshot {
    let phase: ZonePhase;
    let progress: number;
    let remainingSec: number;
    if (!z.impactDone) {
      phase = 'telegraph';
      remainingSec = z.telegraphTicksLeft * TICK_DT;
      progress = z.telegraphTicksTotal > 0 ? 1 - z.telegraphTicksLeft / z.telegraphTicksTotal : 1;
    } else if (z.flashTicksLeft > 0) {
      phase = 'flash';
      remainingSec = z.flashTicksLeft * TICK_DT;
      progress = 1 - z.flashTicksLeft / ZONE_FLASH_TICKS;
    } else {
      phase = 'active';
      remainingSec = z.lingerTicksLeft * TICK_DT;
      progress = z.lingerTicksTotal > 0 ? 1 - z.lingerTicksLeft / z.lingerTicksTotal : 1;
    }
    const snap: ZoneSnapshot = {
      id: z.id,
      side: z.side,
      skillId: z.skillId,
      shape: z.shape,
      x: z.x,
      y: z.y,
      radius: z.radius,
      phase,
      progress: clamp(progress, 0, 1),
      remainingSec,
    };
    if (z.shape === 'line') {
      snap.x2 = z.x2;
      snap.y2 = z.y2;
      snap.width = z.width;
    }
    return snap;
  }

  private buildFrame(events: BattleEvent[]): BattleFrame {
    const snaps: UnitSnapshot[] = new Array(this.units.length);
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      const statuses: UnitSnapshot['statuses'] = [];
      for (let k = 0; k < u.statuses.length; k++) {
        const s = u.statuses[k];
        statuses.push({
          kind: s.kind,
          remainingSec: s.remaining === Infinity ? 9999 : Math.round(s.remaining * 100) / 100,
          value: Math.round(s.value * 100) / 100,
        });
      }
      let casting: UnitSnapshot['casting'] = null;
      if (u.cast) {
        const sk = u.activeSkills[u.cast.skillIdx];
        casting = { skillId: sk ? sk.id : '', progress: clamp(u.cast.total > 0 ? u.cast.progress / u.cast.total : 1, 0, 1) };
      }
      const snap: UnitSnapshot = {
        id: u.id,
        name: u.name,
        side: u.side,
        job: u.job,
        subJob: u.subJob,
        x: u.x,
        y: u.y,
        facing: u.facing,
        hp: u.hp,
        maxHp: u.eff.maxHp,
        mp: u.mp,
        maxMp: u.eff.maxMp,
        alive: u.alive,
        statuses,
        casting,
        targetId: u.alive && u.targetIdx >= 0 ? this.units[u.targetIdx].id : null,
      };
      if (u.isSummon && u.ownerId) snap.ownerId = u.ownerId;
      snaps[i] = snap;
    }
    const zones: ZoneSnapshot[] = new Array(this.zones.length);
    for (let i = 0; i < this.zones.length; i++) zones[i] = this.zoneSnapshot(this.zones[i]);
    const capture =
      this.map.victory === 'capture_or_annihilation' && this.map.capture
        ? { progressA: this.captureA, progressB: this.captureB, holder: this.captureHolder }
        : null;
    return {
      tick: this.tick,
      timeSec: this.time,
      units: snaps,
      events,
      zones,
      capture,
      finished: this._finished,
    };
  }

  private buildResult(): BattleResult {
    const unitStats: UnitBattleStats[] = [];
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      const s = u.stats;
      unitStats.push({
        id: s.id,
        name: s.name,
        side: s.side,
        damageDealt: Math.round(s.damageDealt),
        damageTaken: Math.round(s.damageTaken),
        healingDone: Math.round(s.healingDone),
        kills: s.kills,
        deaths: s.deaths,
        skillsUsed: s.skillsUsed,
        survived: u.alive,
      });
    }
    let mvpId: string | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.isSummon) continue;
      if (this.winner !== 'draw' && u.side !== this.winner) continue;
      const s = u.stats;
      const score = s.damageDealt + s.healingDone * 1.2 + s.kills * 150;
      if (score > bestScore) {
        bestScore = score;
        mvpId = u.id;
      }
    }
    return {
      seed: this.input.seed,
      map: this.input.map,
      winner: this.winner,
      reason: this.reason,
      durationSec: Math.round(this.time * 100) / 100,
      totalTicks: this.tick,
      unitStats,
      mvpId,
      events: this.allEvents,
    };
  }
}

export function createBattle(input: BattleInput): BattleSimulator {
  return new Battle(input);
}
