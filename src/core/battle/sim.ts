/**
 * 결정론적 실시간 전투 시뮬레이션 (GDD §6).
 *
 * - 고정 틱(TICK_RATE). 모든 난수는 new Rng(input.seed) 에서만 나온다.
 * - 유닛 배열 순서: 팀 A 멤버 → 팀 B 멤버 → 소환물(생성 순서). 매 틱 이 순서로 처리한다.
 * - DOM / Math.random / Date 를 절대 사용하지 않는다.
 */
import {
  DERIVED_STAT_KEYS,
  TICK_DT,
  TICK_RATE,
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

const FATIGUE_KEYS: readonly DerivedStatKey[] = ['physAtk', 'magAtk', 'physDef', 'magDef', 'atkSpeed', 'moveSpeed'];

const HARMFUL_STATUS: Record<StatusKind, boolean> = {
  stun: true, slow: true, burn: true, poison: true, freeze: true, silence: true, taunt: true,
  stealth: false, shield: false, lifesteal: false, reflect: false, regen: false, invuln: false,
};

/** 스폰 시 전열 우선순위 (낮을수록 중앙에 가깝게) */
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

  // AI 에 쓰는 기본 스탯
  judgment: number;
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

function isBeneficialEffect(e: SkillEffect): boolean {
  switch (e.kind) {
    case 'heal':
    case 'buff':
    case 'cleanse':
    case 'restore_mp':
    case 'summon':
      return true;
    case 'status':
      return !HARMFUL_STATUS[e.status];
    case 'damage':
    case 'debuff':
    case 'knockback':
    case 'dash':
      return false;
  }
}

function skillHasHeal(sk: SkillDef): boolean {
  for (let i = 0; i < sk.effects.length; i++) if (sk.effects[i].kind === 'heal') return true;
  return false;
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

/** 결정론 테스트용: 유닛 위치/HP 를 소수점 3자리로 묶은 문자열 */
export function hashFrame(f: BattleFrame): string {
  let s = 't' + f.tick;
  for (let i = 0; i < f.units.length; i++) {
    const u = f.units[i];
    s += ';' + u.id + ':' + u.x.toFixed(3) + ',' + u.y.toFixed(3) + ',' + u.hp.toFixed(3) + ',' + (u.alive ? 1 : 0);
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

  private spawnTeam(tr: TeamRuntime): void {
    const map = this.map;
    const cx = map.width / 2;
    const cy = map.height / 2;
    const rawSpawns = tr.side === 'A' ? map.spawnA : map.spawnB;
    // 중앙에 가까운 스폰 지점부터 (안정 정렬: 거리 → 원래 순서)
    const spawns = rawSpawns
      .map((p, i) => ({ p, i, d: (p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy) }))
      .sort((a, b) => (a.d !== b.d ? a.d - b.d : a.i - b.i))
      .map((s) => s.p);
    const members = tr.team.members
      .map((c, i) => ({ c, i, p: SPAWN_PRIORITY[c.mainJob] ?? 5 }))
      .sort((a, b) => (a.p !== b.p ? a.p - b.p : a.i - b.i));

    for (let k = 0; k < members.length; k++) {
      const c = members[k].c;
      let px: number;
      let py: number;
      if (k < spawns.length) {
        px = spawns[k].x;
        py = spawns[k].y;
      } else {
        px = tr.side === 'A' ? 4 : map.width - 4;
        py = clamp(cy - 6 + 3 * k, 1, map.height - 1);
      }
      const u = this.createCharacterUnit(c, tr.side, px, py);
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
      judgment: c.stats.judgment,
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
      judgment: owner.judgment,
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
    const map = this.map;
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
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.0001) return;
    dx /= len;
    dy /= len;

    let speed = u.eff.moveSpeed * map.moveSpeedMult;
    const slow = statusValue(u, 'slow');
    if (slow > 0) speed *= Math.max(0, 1 - slow);
    if (speed <= 0) return;
    const stepLen = speed * TICK_DT;
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
    const chance = clamp(70 + (attacker.eff.accuracy - victim.eff.evasion) * 0.3, 30, 100);
    return this.rng.chance(chance / 100);
  }

  private critRoll(attacker: Unit): boolean {
    const c = clamp(attacker.eff.critChance, 0, 100);
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
    const dealt = this.dealDamage(u, target, dmg, school, false, true);
    this.pushEvent({ t: this.time, kind: 'attack', from: u.id, to: target.id, damage: Math.round(dealt), crit, school });
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

    const stealthedAtCast = hasStatus(u, 'stealth');
    const missingPct = (1 - u.hp / u.eff.maxHp) * 100;

    for (let ei = 0; ei < sk.effects.length; ei++) {
      const e = sk.effects[ei];
      if (!u.alive && e.kind !== 'summon') break;
      switch (e.kind) {
        case 'damage': {
          const targets = getHarmful();
          if (targets.length === 0) break;
          let mult = e.coef;
          if (e.magic && e.magic !== 'none') mult *= this.map.schoolBonus[e.magic] ?? 1;
          else if (e.school === 'magic' && sk.magic !== 'none') mult *= this.map.schoolBonus[sk.magic] ?? 1;
          if (e.bonusIfStealth && stealthedAtCast) mult *= 1 + e.bonusIfStealth;
          if (e.bonusPerMissingHpPct) mult *= 1 + e.bonusPerMissingHpPct * missingPct;
          this.breakStealth(u);
          const atk = e.school === 'phys' ? u.eff.physAtk : u.eff.magAtk;
          const ignore = clamp(e.ignoreDefPct ?? 0, 0, 1);
          for (let ti = 0; ti < targets.length; ti++) {
            const t = targets[ti];
            if (!t.alive) continue;
            if (e.school === 'phys' && !this.hitRoll(u, t)) {
              this.pushEvent({ t: this.time, kind: 'attack', from: u.id, to: t.id, damage: 0, crit: false, school: 'phys', miss: true });
              continue;
            }
            const def = (e.school === 'phys' ? t.eff.physDef : t.eff.magDef) * (1 - ignore);
            let dmg = atk * mult * (100 / (100 + Math.max(0, def)));
            const crit = this.critRoll(u);
            if (crit) dmg *= u.eff.critMult / 100;
            const reflect = this.reflectAmount(t, dmg, e.school);
            const dealt = this.dealDamage(u, t, dmg, e.school, false, true);
            this.pushEvent({ t: this.time, kind: 'attack', from: u.id, to: t.id, damage: Math.round(dealt), crit, school: e.school });
            this.applyReflect(u, t, reflect);
          }
          break;
        }
        case 'heal': {
          const targets = getHelpful();
          const amount = u.eff.magAtk * e.coef;
          for (let ti = 0; ti < targets.length; ti++) this.heal(u, targets[ti], amount, true);
          break;
        }
        case 'status': {
          const harmful = HARMFUL_STATUS[e.status];
          const targets = harmful ? getHarmful() : getHelpful();
          const value = e.value ?? (e.status === 'shield' ? u.eff.magAtk : 0);
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
            let dx = t.x - u.x;
            let dy = t.y - u.y;
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
    const members = this.teams[u.side].members;
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
    const capture =
      this.map.victory === 'capture_or_annihilation' && this.map.capture
        ? { progressA: this.captureA, progressB: this.captureB, holder: this.captureHolder }
        : null;
    return {
      tick: this.tick,
      timeSec: this.time,
      units: snaps,
      events,
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
