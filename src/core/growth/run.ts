/**
 * 육성 상태 머신 (GDD §2, §7.2). 순수 함수 집합 — DOM/저장소 접근 없음.
 * 모든 난수는 hashSeed(`${seed}:${cycle}:${purpose}:...`) 에서 파생되므로 저장/불러오기 후에도 결과가 같다.
 */
import { Rng, hashSeed } from '../rng';
import type {
  BaseStatKey, BattleInput, BattleResult, Character, ChoiceEffect, GhostSnapshot, MapType, RunState, SynergyDef, Team,
} from '../types';
import {
  CHOICES_PER_CYCLE, MAP_TYPES, STAT_MAX, SUBJOB_CHOICE_CYCLE_MAX, SUBJOB_CHOICE_CYCLE_MIN, TOTAL_CYCLES,
} from '../types';
import { generateOpponentTeam, generatePool } from '../gen/charGen';
import { applyChoice, applyEffect, generateChoices } from './choices';
import { autoSynergies } from '../data/synergies';
import { getSkill, skillPoolFor } from '../data/skills';
import { JOBS } from '../data/jobs';

export const POOL_SIZE = 24;
export const BONUS_WIN = 120;
export const BONUS_LOSE = 50;
export const BONUS_DRAW = 80;
export const STAT_TRAIN_COST = 30;
export const STAT_TRAIN_DELTA = 4;
export const REROLL_COST = 40;

export interface RunOptions {
  /** 과거 육성 스냅샷. 같은 사이클의 고스트가 있으면 ghostChance 확률로 상대가 된다 */
  ghosts?: GhostSnapshot[];
  /** 기본 0.6 */
  ghostChance?: number;
}

// ───────────────────────── 유틸 ─────────────────────────

function rngFor(state: RunState, purpose: string, extra = ''): Rng {
  return new Rng(hashSeed(`${state.seed}:${state.cycle}:${purpose}:${extra}`));
}

function choiceRng(state: RunState): Rng {
  return rngFor(state, 'choices', `${state.history.length}:${state.choiceIndex}:${1 - state.rerolls}`);
}

function cloneCharacter(c: Character): Character {
  return {
    id: c.id,
    name: c.name,
    mainJob: c.mainJob,
    subJob: c.subJob,
    stats: { ...c.stats },
    adaptation: { ...c.adaptation },
    growthVariance: { ...c.growthVariance },
    skills: c.skills.slice(),
    rarity: c.rarity,
  };
}

function cloneSynergy(s: SynergyDef): SynergyDef {
  return {
    id: s.id,
    name: s.name,
    desc: s.desc,
    condition: { ...s.condition },
    scope: s.scope,
    mods: { ...s.mods },
    ...(s.bonusStealthSec !== undefined ? { bonusStealthSec: s.bonusStealthSec } : {}),
  };
}

/** 팀 깊은 복사 */
export function cloneTeam(t: Team): Team {
  return {
    id: t.id,
    name: t.name,
    members: t.members.map(cloneCharacter),
    synergies: t.synergies.map(cloneSynergy),
  };
}

function requireTeam(state: RunState): Team {
  if (!state.team) throw new Error('아직 팀이 선택되지 않았습니다.');
  return state.team;
}

export function getMember(state: RunState, charId: string): Character | null {
  if (!state.team) return null;
  for (const c of state.team.members) if (c.id === charId) return c;
  return null;
}

/** 플레이어 팀은 항상 A 측 */
export function playerOutcome(result: BattleResult): 'win' | 'lose' | 'draw' {
  if (result.winner === 'A') return 'win';
  if (result.winner === 'B') return 'lose';
  return 'draw';
}

/** 사이클별 보너스: 기본값 + 20 × (cycle-1)/3 (반올림) */
export function bonusFor(result: BattleResult, cycle: number): number {
  const outcome = playerOutcome(result);
  const base = outcome === 'win' ? BONUS_WIN : outcome === 'lose' ? BONUS_LOSE : BONUS_DRAW;
  return base + Math.round((20 * (cycle - 1)) / 3);
}

/** 고스트 팀 복제. 캐릭터 id 에 'g_' 접두어를 붙여 플레이어 팀과 충돌하지 않게 한다 (이름은 유지). */
function cloneGhostTeam(g: GhostSnapshot, cycle: number): Team {
  const t = cloneTeam(g.team);
  const idMap = new Map<string, string>();
  for (const c of t.members) {
    const nid = `g_${c.id}`;
    idMap.set(c.id, nid);
    c.id = nid;
  }
  for (const s of t.synergies) {
    if (s.condition.kind === 'adjacency') {
      s.condition = {
        kind: 'adjacency',
        a: idMap.get(s.condition.a) ?? `g_${s.condition.a}`,
        b: idMap.get(s.condition.b) ?? `g_${s.condition.b}`,
        adjRadius: s.condition.adjRadius,
      };
    }
  }
  t.id = `g_${g.runSeed}_${cycle}`;
  return t;
}

/** 미분화 캐릭터의 분화 예정 사이클을 보장한다 (누락/지연분 보정). */
function ensureSubJobSchedule(state: RunState): void {
  const team = requireTeam(state);
  const rng = rngFor(state, 'subjob_schedule', `${state.history.length}`);
  for (const c of team.members) {
    if (c.subJob !== null || JOBS[c.mainJob].subJobs.length === 0) {
      delete state.subJobChoiceCycle[c.id];
      continue;
    }
    const due = state.subJobChoiceCycle[c.id];
    if (due !== undefined && due >= state.cycle) continue;
    if (due !== undefined && due < state.cycle) {
      // 같은 사이클에 3명 이상 몰린 경우 등: 이번 사이클로 이월
      state.subJobChoiceCycle[c.id] = state.cycle;
      continue;
    }
    // 예정 없음 (직업 변경 등): 남은 보장 구간 안에서 랜덤, 이미 지났으면 즉시
    if (state.cycle >= SUBJOB_CHOICE_CYCLE_MAX) state.subJobChoiceCycle[c.id] = state.cycle;
    else state.subJobChoiceCycle[c.id] = rng.int(Math.max(state.cycle, SUBJOB_CHOICE_CYCLE_MIN), SUBJOB_CHOICE_CYCLE_MAX);
  }
}

/** 직업 변경 등으로 조합이 바뀌었을 때 자동 시너지를 갱신한다 (선택지로 얻은 시너지는 유지). */
function refreshAutoSynergies(team: Team, prevAutoIds: Set<string>): void {
  const kept = team.synergies.filter((s) => !prevAutoIds.has(s.id));
  const auto = autoSynergies(team);
  const ids = new Set(kept.map((s) => s.id));
  for (const s of auto) {
    if (!ids.has(s.id)) {
      kept.push(s);
      ids.add(s.id);
    }
  }
  team.synergies = kept;
}

// ───────────────────────── 상태 머신 ─────────────────────────

/** 새 육성 시작: 풀 생성, 팀 선택 단계 */
export function newRun(seed: number, _opts?: RunOptions): RunState {
  const s = seed >>> 0;
  const pool = generatePool(new Rng(hashSeed(`${s}:0:pool`)), POOL_SIZE);
  return {
    seed: s,
    phase: 'select_team',
    cycle: 0,
    pool,
    team: null,
    bonusPoints: 0,
    currentMap: null,
    opponent: null,
    choiceIndex: 0,
    currentChoices: [],
    subJobChoiceCycle: {},
    history: [],
    rerolls: 0,
  };
}

/** 풀에서 5명 선택 → 팀 구성, 1사이클 전투 준비 */
export function selectTeam(state: RunState, charIds: string[], teamName: string, opts?: RunOptions): void {
  if (state.phase !== 'select_team') throw new Error('팀 선택 단계가 아닙니다.');
  if (charIds.length !== 5) throw new Error('정확히 5명을 선택해야 합니다.');
  const members: Character[] = [];
  const seen = new Set<string>();
  for (const id of charIds) {
    if (seen.has(id)) throw new Error('같은 캐릭터를 두 번 선택할 수 없습니다.');
    seen.add(id);
    const found = state.pool.find((c) => c.id === id);
    if (!found) throw new Error(`풀에 없는 캐릭터입니다: ${id}`);
    members.push(cloneCharacter(found));
  }
  const name = teamName.trim() || '나의 팀';
  const team: Team = { id: `team_${state.seed}`, name, members, synergies: [] };
  team.synergies = autoSynergies(team);
  state.team = team;
  state.cycle = 1;
  state.bonusPoints = 0;
  state.history = [];
  state.choiceIndex = 0;
  state.currentChoices = [];
  state.rerolls = 0;

  // 분화 예정 사이클: [4,6] 안에서 최대 2명씩 고르게 분산
  const rng = new Rng(hashSeed(`${state.seed}:0:subjob`));
  const slots: number[] = [];
  for (let r = 0; r < 2; r++) {
    for (let c = SUBJOB_CHOICE_CYCLE_MIN; c <= SUBJOB_CHOICE_CYCLE_MAX; c++) slots.push(c);
  }
  const assigned = rng.shuffle(slots).slice(0, members.length);
  state.subJobChoiceCycle = {};
  for (let i = 0; i < members.length; i++) state.subJobChoiceCycle[members[i].id] = assigned[i];

  prepareNextBattle(state, opts);
}

/** 현재 사이클의 전투 입력. 전투 시드 = hashSeed(seed:cycle:battle) */
export function battleInput(state: RunState): BattleInput {
  const team = requireTeam(state);
  if (!state.currentMap || !state.opponent) throw new Error('전투가 준비되지 않았습니다.');
  return {
    seed: hashSeed(`${state.seed}:${state.cycle}:battle`),
    map: state.currentMap,
    teamA: team,
    teamB: state.opponent,
  };
}

/** 관전 시작 (phase battle) 후 입력 반환 */
export function startBattle(state: RunState): BattleInput {
  const input = battleInput(state);
  state.phase = 'battle';
  return input;
}

/** 전투 종료: 기록 저장(전투 직전 팀 스냅샷), 보너스 지급, 보너스 단계 */
export function finishBattle(state: RunState, result: BattleResult): void {
  const team = requireTeam(state);
  if (state.phase !== 'battle' && state.phase !== 'pre_battle') throw new Error('전투 단계가 아닙니다.');
  if (!state.currentMap) throw new Error('전투 맵이 없습니다.');
  const snapshot = cloneTeam(team);
  const bonus = bonusFor(result, state.cycle);
  state.bonusPoints += bonus;
  state.history.push({
    cycle: state.cycle,
    map: state.currentMap,
    result,
    opponentName: state.opponent ? state.opponent.name : '알 수 없음',
    bonusEarned: bonus,
    choicesTaken: [],
    teamSnapshot: snapshot,
  });
  state.phase = 'bonus';
  state.rerolls = 1;
}

/** 보너스 포인트로 스킬 구매. 슬롯이 가득 차면 같은 타입의 가장 오래된 스킬을 대체한다. */
export function buySkill(state: RunState, charId: string, skillId: string): boolean {
  const team = state.team;
  if (!team || state.phase !== 'bonus') return false;
  const c = getMember(state, charId);
  if (!c) return false;
  if (!skillPoolFor(c).includes(skillId)) return false;
  const cost = getSkill(skillId).cost;
  if (state.bonusPoints < cost) return false;
  state.bonusPoints -= cost;
  applyEffect(team, { kind: 'learn_skill', charId, skillId });
  return true;
}

/** 보너스 포인트로 스탯 소폭 성장 (+STAT_TRAIN_DELTA) */
export function trainStat(state: RunState, charId: string, stat: BaseStatKey): boolean {
  const team = state.team;
  if (!team || state.phase !== 'bonus') return false;
  const c = getMember(state, charId);
  if (!c) return false;
  if (c.stats[stat] >= STAT_MAX) return false;
  if (state.bonusPoints < STAT_TRAIN_COST) return false;
  state.bonusPoints -= STAT_TRAIN_COST;
  applyEffect(team, { kind: 'stat', charId, stat, delta: STAT_TRAIN_DELTA });
  return true;
}

/** 보너스 단계 종료 → 로그라이크 선택 단계 */
export function finishBonus(state: RunState): void {
  requireTeam(state);
  if (state.phase !== 'bonus') throw new Error('보너스 단계가 아닙니다.');
  state.phase = 'choice';
  state.choiceIndex = 0;
  ensureSubJobSchedule(state);
  state.currentChoices = generateChoices(state, choiceRng(state));
}

/**
 * 선택지 하나를 고른다. 3번째 선택 후 다음 사이클 전투 준비, 10사이클이면 완료.
 * opts 는 다음 사이클 상대(고스트) 선택에 쓰인다.
 */
export function pickChoice(state: RunState, index: number, opts?: RunOptions): { success: boolean | null; applied: ChoiceEffect[] } {
  const team = requireTeam(state);
  if (state.phase !== 'choice') throw new Error('선택 단계가 아닙니다.');
  const choice = state.currentChoices[index];
  if (!choice) throw new Error('존재하지 않는 선택지입니다.');

  const prevAutoIds = new Set<string>(autoSynergies(team).map((s: SynergyDef) => s.id));
  const res = applyChoice(state, choice, rngFor(state, 'pick', `${state.choiceIndex}`));
  if (choice.kind === 'job_change') refreshAutoSynergies(team, prevAutoIds);

  const rec = state.history[state.history.length - 1];
  if (rec && rec.cycle === state.cycle) rec.choicesTaken.push({ title: choice.title, success: res.success });

  state.choiceIndex += 1;
  if (state.choiceIndex >= CHOICES_PER_CYCLE) {
    state.currentChoices = [];
    if (state.cycle >= TOTAL_CYCLES) {
      state.phase = 'done';
      state.choiceIndex = 0;
      state.currentMap = null;
      state.opponent = null;
    } else {
      state.cycle += 1;
      state.choiceIndex = 0;
      prepareNextBattle(state, opts);
    }
  } else {
    ensureSubJobSchedule(state);
    state.currentChoices = generateChoices(state, choiceRng(state));
  }
  return res;
}

/** 현재 선택지가 분화 보장 세트(한 캐릭터의 세부 직업 3장)인지. 이 세트는 리롤해도 같은 카드가 나오므로 리롤 불가 */
export function isSubJobChoiceSet(state: RunState): boolean {
  return state.currentChoices.length > 0 && state.currentChoices.every((c) => c.kind === 'subjob');
}

/**
 * 선택 단계인데 선택지가 비어 있으면(저장 데이터 정리 등) 다시 만든다.
 * choiceRng 가 seed/cycle/history/choiceIndex 에서 파생되므로 같은 시드에서는 같은 결과가 나온다.
 */
export function ensureChoices(state: RunState): boolean {
  if (!state.team || state.phase !== 'choice') return false;
  if (state.currentChoices.length > 0) return false;
  ensureSubJobSchedule(state);
  state.currentChoices = generateChoices(state, choiceRng(state));
  return true;
}

/** 리롤권 + 보너스 포인트로 현재 선택지를 다시 뽑는다. 분화 세트는 리롤할 수 없다(비용 없음, false). */
export function rerollChoices(state: RunState): boolean {
  if (!state.team || state.phase !== 'choice') return false;
  if (state.rerolls <= 0) return false;
  if (state.bonusPoints < REROLL_COST) return false;
  if (isSubJobChoiceSet(state)) return false;
  state.bonusPoints -= REROLL_COST;
  state.rerolls -= 1;
  state.currentChoices = generateChoices(state, choiceRng(state));
  return true;
}

/** 다음 전투 준비: 맵(직전 맵 제외 랜덤), 상대(고스트 또는 생성), phase pre_battle */
export function prepareNextBattle(state: RunState, opts?: RunOptions): void {
  requireTeam(state);
  const rng = rngFor(state, 'prep');
  const prevMap = state.history.length > 0 ? state.history[state.history.length - 1].map : null;
  const candidates = MAP_TYPES.filter((m) => m !== prevMap);
  const map: MapType = rng.pick(candidates);

  const ghosts = (opts?.ghosts ?? []).filter((g) => g.cycle === state.cycle && g.runSeed !== state.seed);
  const ghostChance = opts?.ghostChance ?? 0.6;
  let opponent: Team;
  if (ghosts.length > 0 && rng.chance(ghostChance)) {
    opponent = cloneGhostTeam(rng.pick(ghosts), state.cycle);
  } else {
    opponent = generateOpponentTeam(rng, state.cycle, map, `o${state.cycle}`);
  }

  state.currentMap = map;
  state.opponent = opponent;
  state.phase = 'pre_battle';
}

/** 완료된 육성에서 고스트 스냅샷 목록을 만든다 (각 사이클 전투 직전 팀) */
export function ghostsFromRun(state: RunState, savedAt: string): GhostSnapshot[] {
  const out: GhostSnapshot[] = [];
  for (const rec of state.history) {
    out.push({ runSeed: state.seed, cycle: rec.cycle, team: cloneTeam(rec.teamSnapshot), savedAt });
  }
  return out;
}
