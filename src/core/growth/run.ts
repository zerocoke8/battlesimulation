/**
 * 육성 상태 머신 — 10일 × 5스텝 (GDD §2, §7.2).
 * 순수 함수 집합. DOM/저장소 접근 없음.
 *
 * 하루의 스텝 순서는 고정이다:
 *   1스텝 선택지 → 2스텝 선택지 → 3스텝 몬스터 전투 → 4스텝 선택지 → 5스텝 4:4 전투 → 하루 마무리(day_end)
 *
 * 팀 인원은 TEAM_SIZE(4) 로 고정. 플레이어 팀·상대팀·고스트 모두 정확히 TEAM_SIZE 명이어야 하며,
 * 인원이 다른 고스트(구버전 저장)는 상대 풀에서 제외한다.
 *
 * 결정론: 모든 난수는 hashSeed(`${seed}:${day}:${step}:<purpose>:<counter>`) 에서 파생한다.
 * Rng 인스턴스는 절대 state 에 담지 않는다. 따라서 저장/불러오기 후 이어해도 같은 결과가 나온다.
 */
import { Rng, hashSeed } from '../rng';
import type {
  BaseStatKey, BattleInput, BattleResult, Character, Choice, ChoiceEffect, ChoiceRarity,
  DayRecord, GhostSnapshot, MapType, MonsterEncounter, MonsterReward, MonsterTier,
  RunState, StepKind, SynergyDef, Team,
} from '../types';
import {
  BASE_STAT_KEYS, BATTLE_STEP, CHOICE_STEPS, MAP_TYPES, MONSTER_STEP, MONSTER_TIER_NAME_KO,
  STAT_MAX, STEPS_PER_DAY, STEP_KIND_NAME_KO, SUBJOB_DAY_MAX, SUBJOB_DAY_MIN,
  TEAM_SIZE, TOTAL_DAYS, stepKindOf,
} from '../types';
import { generateOpponentTeam, generatePool } from '../gen/charGen';
import { applyChoice, applyEffect, generateChoices } from './choices';
import { autoSynergies } from '../data/synergies';
import { getSkill, skillPoolFor } from '../data/skills';
import { JOBS } from '../data/jobs';
import { makeEncounterSet, monsterReward } from '../data/monsters';
import { powerRating } from '../stats';

// ───────────────────────── 상수 ─────────────────────────

export const POOL_SIZE = 24;
/** 4:4 전투 보상 포인트 (일차 보정 별도) */
export const BONUS_WIN = 120;
export const BONUS_LOSE = 50;
export const BONUS_DRAW = 80;
/** 보너스 상점: 스탯 훈련 */
export const STAT_TRAIN_COST = 30;
export const STAT_TRAIN_DELTA = 4;
/** 보너스 상점: 선택지 리롤 */
export const REROLL_COST = 40;
/** 하루에 주어지는 리롤 횟수 (GDD §7.2) */
export const REROLLS_PER_DAY = 1;

export interface RunOptions {
  /** 과거 육성 스냅샷. 같은 일차의 고스트가 있으면 ghostChance 확률로 상대가 된다 */
  ghosts?: GhostSnapshot[];
  /**
   * 같은 일차의 고스트를 상대로 쓸 확률. 기본 1 — GDD §7.6 대로
   * "고스트 데이터가 쌓이기 전에는 생성 팀, 쌓인 뒤에는 같은 일차의 고스트"가 된다.
   * 밸런싱 도구에서 생성 팀 상대를 강제로 섞고 싶을 때만 낮춘다.
   */
  ghostChance?: number;
}

// ───────────────────────── 난수 ─────────────────────────

/** 모든 난수의 출발점. state 에는 Rng 를 저장하지 않는다. */
function rngFor(state: RunState, purpose: string, counter: string | number = 0): Rng {
  return new Rng(hashSeed(`${state.seed}:${state.day}:${state.step}:${purpose}:${counter}`));
}

/** 선택지 생성용. 리롤할 때마다 남은 리롤 수가 줄어 다른 세트가 나온다. */
function choiceRng(state: RunState): Rng {
  return rngFor(state, 'choices', state.rerolls);
}

// ───────────────────────── 복사 유틸 ─────────────────────────

function cloneCharacter(c: Character): Character {
  const out: Character = {
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
  if (c.monster) out.monster = { kind: c.monster.kind, tier: c.monster.tier };
  if (c.derivedMult) out.derivedMult = { ...c.derivedMult };
  return out;
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

/**
 * 표시용 팀 전투력 (HUD). 스탯 합 + 스킬 수 × 30.
 * 몬스터 카드의 estimatedPower(= monsters.ts 의 monsterTeamPower)와 같은 척도라 바로 비교할 수 있다.
 */
export function teamPower(t: Team | null): number {
  if (!t) return 0;
  let sum = 0;
  for (const c of t.members) sum += powerRating(c);
  return Math.round(sum);
}

/** 4:4 전투 포인트: 기본값 + 20 × (day-1)/3 (반올림) */
export function bonusFor(result: BattleResult, day: number): number {
  const outcome = playerOutcome(result);
  const base = outcome === 'win' ? BONUS_WIN : outcome === 'lose' ? BONUS_LOSE : BONUS_DRAW;
  return base + Math.round((20 * (day - 1)) / 3);
}

// ───────────────────────── 하루 진행 누적 (내부) ─────────────────────────

/**
 * 하루치 기록은 5스텝이 끝나야 DayRecord 로 확정된다 (BattleResult 가 필요하므로).
 * 그 전까지의 선택지·몬스터 전투 결과는 이 임시 기록에 모아 둔다.
 * RunState 에 직렬화되어 저장/불러오기 후에도 유지된다 (types.ts 계약 밖의 내부 필드).
 */
interface DayProgress {
  day: number;
  points: number;
  choices: { title: string; rarity: ChoiceRarity; success: boolean | null }[];
  monster: { tier: MonsterTier; name: string; won: boolean; result: BattleResult } | null;
}
type RunStateInternal = RunState & { dayProgress?: DayProgress };

function progressOf(state: RunState): DayProgress {
  const s = state as RunStateInternal;
  if (!s.dayProgress || s.dayProgress.day !== state.day) {
    s.dayProgress = { day: state.day, points: 0, choices: [], monster: null };
  }
  return s.dayProgress;
}

/** 오늘 지금까지 고른 선택지 (하루 마무리 화면 표시용) */
export function todayChoices(state: RunState): { title: string; rarity: ChoiceRarity; success: boolean | null }[] {
  return progressOf(state).choices.slice();
}

/** 오늘 지금까지 번 포인트 */
export function todayPoints(state: RunState): number {
  return progressOf(state).points;
}

/** 오늘의 몬스터 전투 결과 (없으면 null) */
export function todayMonster(state: RunState): DayProgress['monster'] {
  return progressOf(state).monster;
}

// ───────────────────────── 진행 표시 ─────────────────────────

/** 현재 스텝의 종류. 스텝이 아닌 단계(select_team / day_end / done)에서는 null */
export function currentStepKind(state: RunState): StepKind | null {
  if (state.step < 1 || state.step > STEPS_PER_DAY) return null;
  return stepKindOf(state.step);
}

/** 예: '3일차 · 3/5 몬스터' */
export function stepLabel(state: RunState): string {
  if (state.phase === 'select_team') return '팀 선택';
  if (state.phase === 'done') return '육성 완료';
  if (state.phase === 'day_end') return `${state.day}일차 마무리`;
  const kind = currentStepKind(state);
  if (!kind) return `${state.day}일차`;
  return `${state.day}일차 · ${state.step}/${STEPS_PER_DAY} ${STEP_KIND_NAME_KO[kind]}`;
}

// ───────────────────────── 분화 예정 ─────────────────────────

/**
 * 미분화 캐릭터의 분화 예정 일차를 보장한다 (직업 변경 등으로 생긴 누락/지연분 보정).
 *
 * 하루의 선택 스텝은 CHOICE_STEPS.length 개뿐이고 분화 세트는 스텝당 한 명이므로, 같은 날에 예정된 미분화 인원이
 * 그날 남은 선택 스텝 수를 넘지 않게 한다 (넘치면 원래 예정일을 지키던 캐릭터까지 다음 날로 밀렸다).
 *  1) 예정일이 이미 지난(이월) 캐릭터는 오늘부터 빈 슬롯이 있는 첫 날을 잡는다.
 *  2) 예정이 없는(직업 변경 직후) 캐릭터는 [max(오늘, SUBJOB_DAY_MIN), SUBJOB_DAY_MAX] 중 빈 슬롯이 남은 날에서 고른다.
 *     남은 날이 없으면 그 뒤 첫 빈 날. 이 함수는 항상 다음 선택지 세트를 만들기 직전에 불리므로 현재 스텝도 남은 슬롯으로 센다.
 */
function ensureSubJobSchedule(state: RunState): void {
  const team = requireTeam(state);
  const rng = rngFor(state, 'subjob_schedule', state.history.length);
  const maxPerDay = CHOICE_STEPS.length;
  let remainingToday = 0;
  for (const s of CHOICE_STEPS) if (s >= state.step) remainingToday++;
  if (remainingToday < 1) remainingToday = 1;
  const capOf = (day: number): number => (day === state.day ? remainingToday : maxPerDay);

  const counts = new Map<number, number>();
  const countOf = (day: number): number => counts.get(day) ?? 0;
  const assign = (id: string, day: number): void => {
    state.subJobChoiceDay[id] = day;
    counts.set(day, countOf(day) + 1);
  };
  const firstFreeFrom = (from: number): number => {
    let d = from;
    while (d < TOTAL_DAYS && countOf(d) >= capOf(d)) d++;
    return d;
  };

  const carried: Character[] = [];
  const unscheduled: Character[] = [];
  for (const c of team.members) {
    if (c.subJob !== null || JOBS[c.mainJob].subJobs.length === 0) {
      delete state.subJobChoiceDay[c.id];
      continue;
    }
    const due = state.subJobChoiceDay[c.id];
    if (due === undefined) unscheduled.push(c);
    else if (due < state.day) carried.push(c);
    else counts.set(due, countOf(due) + 1);
  }
  // 1) 이월: 오늘부터 빈 슬롯이 있는 첫 날 (팀 순서 고정)
  for (const c of carried) assign(c.id, firstFreeFrom(state.day));
  // 2) 미배정: 보장 구간 안에서 빈 슬롯이 남은 날 중 하나
  for (const c of unscheduled) {
    if (state.day >= SUBJOB_DAY_MAX) {
      assign(c.id, firstFreeFrom(state.day));
      continue;
    }
    const lo = Math.max(state.day, SUBJOB_DAY_MIN);
    const candidates: number[] = [];
    for (let d = lo; d <= SUBJOB_DAY_MAX; d++) if (countOf(d) < capOf(d)) candidates.push(d);
    if (candidates.length > 0) assign(c.id, candidates[rng.int(0, candidates.length - 1)]);
    else assign(c.id, firstFreeFrom(SUBJOB_DAY_MAX + 1));
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

// ───────────────────────── 몬스터 ─────────────────────────

/**
 * 3스텝의 난이도 카드 3장 (하급/중급/고급). 이미 만들어져 있으면 그대로 돌려준다.
 * 어떤 종·어떤 맵이 나올지는 그날의 시드로 정해진다 (data/monsters.ts).
 */
export function monsterOptions(state: RunState): MonsterEncounter[] {
  requireTeam(state);
  if (state.monsterOptions && state.monsterOptions.length > 0) return state.monsterOptions;
  const out = makeEncounterSet(state.day, rngFor(state, 'monster'), `enc${state.seed}_${state.day}`);
  if (out.length === 0) throw new Error('몬스터 정의가 없습니다 (data/monsters.ts).');
  state.monsterOptions = out;
  return out;
}

/** 선택지가 비어 있을 때처럼, 몬스터 카드가 비어 있으면 다시 만든다. 새로 만들었으면 true */
export function ensureMonsterOptions(state: RunState): boolean {
  if (!state.team || state.phase !== 'monster_select') return false;
  if (state.monsterOptions && state.monsterOptions.length > 0) return false;
  state.monsterOptions = null;
  monsterOptions(state);
  return true;
}

/** 몬스터 전투 입력. 전투 시드 = hashSeed(seed:day:3:monster_battle) */
export function monsterBattleInput(state: RunState): BattleInput {
  const team = requireTeam(state);
  const enc = state.currentMonster;
  if (!enc) throw new Error('몬스터가 선택되지 않았습니다.');
  return {
    seed: hashSeed(`${state.seed}:${state.day}:${MONSTER_STEP}:monster_battle:${enc.tier}`),
    map: enc.map,
    teamA: team,
    teamB: enc.team,
  };
}

/**
 * 난이도를 골라 몬스터 전투를 시작한다 (phase → 'monster_battle').
 * 난이도('low' | 'mid' | 'high') 또는 카드 인덱스(0~2) 어느 쪽으로도 고를 수 있다.
 */
export function pickMonster(state: RunState, tier: MonsterTier | number): BattleInput {
  requireTeam(state);
  if (state.phase !== 'monster_select') throw new Error('몬스터 선택 단계가 아닙니다.');
  const options = monsterOptions(state);
  const enc = typeof tier === 'number' ? options[tier] : options.find((e) => e.tier === tier);
  if (!enc) throw new Error(`해당 난이도의 몬스터가 없습니다: ${String(tier)}`);
  state.currentMonster = enc;
  state.phase = 'monster_battle';
  return monsterBattleInput(state);
}

/** 몬스터 관전 시작 (이미 고른 몬스터로 phase 를 'monster_battle' 로 맞추고 입력을 돌려준다) */
export function startMonsterBattle(state: RunState): BattleInput {
  requireTeam(state);
  if (!state.currentMonster) throw new Error('몬스터가 선택되지 않았습니다.');
  const input = monsterBattleInput(state);
  state.phase = 'monster_battle';
  return input;
}

/**
 * 몬스터 전투 종료: 보상 지급(패배 시 포인트 40%만), 보장 등급 설정, 4스텝 선택지로 진행.
 * 져도 진행은 계속된다.
 */
export function finishMonsterBattle(state: RunState, result: BattleResult): { won: boolean; reward: MonsterReward } {
  requireTeam(state);
  if (state.phase !== 'monster_battle' && state.phase !== 'monster_select') {
    throw new Error('몬스터 전투 단계가 아닙니다.');
  }
  const enc = state.currentMonster;
  if (!enc) throw new Error('몬스터가 선택되지 않았습니다.');

  const won = playerOutcome(result) === 'win';
  const reward: MonsterReward = monsterReward(enc.tier, state.day, won);

  state.bonusPoints += reward.points;
  const prog = progressOf(state);
  prog.points += reward.points;
  prog.monster = { tier: enc.tier, name: enc.name, won, result };
  if (reward.rarityFloor) state.rarityFloor = reward.rarityFloor;
  if (reward.teamStatBonus > 0) state.pendingTeamStatBonus += reward.teamStatBonus;

  // 4스텝 선택지로
  state.currentMonster = null;
  state.monsterOptions = null;
  state.step = MONSTER_STEP + 1;
  state.phase = 'choice';
  ensureSubJobSchedule(state);
  state.currentChoices = generateChoices(state, choiceRng(state));
  return { won, reward };
}

/** 몬스터 보상으로 받은 팀 전원 랜덤 스탯 상승을 적용한다. 적용한 양을 돌려준다. */
function applyPendingTeamStatBonus(state: RunState): number {
  const team = state.team;
  const amount = state.pendingTeamStatBonus;
  if (!team || amount <= 0) return 0;
  const rng = rngFor(state, 'team_bonus', state.day);
  for (const c of team.members) {
    const roomy = BASE_STAT_KEYS.filter((k) => c.stats[k] < STAT_MAX);
    const pool: readonly BaseStatKey[] = roomy.length > 0 ? roomy : BASE_STAT_KEYS;
    applyEffect(team, { kind: 'stat', charId: c.id, stat: rng.pick(pool), delta: amount });
  }
  state.pendingTeamStatBonus = 0;
  return amount;
}

// ───────────────────────── 상태 머신 ─────────────────────────

/** 새 육성 시작: 풀 생성, 팀 선택 단계 (day 0 / step 0) */
export function newRun(seed: number, _opts?: RunOptions): RunState {
  const s = seed >>> 0;
  const pool = generatePool(new Rng(hashSeed(`${s}:0:0:pool:0`)), POOL_SIZE);
  return {
    seed: s,
    phase: 'select_team',
    day: 0,
    step: 0,
    pool,
    team: null,
    bonusPoints: 0,
    currentMap: null,
    opponent: null,
    monsterOptions: null,
    currentMonster: null,
    currentChoices: [],
    rarityFloor: null,
    subJobChoiceDay: {},
    history: [],
    rerolls: 0,
    pendingTeamStatBonus: 0,
  };
}

/** 풀에서 정확히 TEAM_SIZE(4)명 선택 → 팀 구성, 1일차 1스텝(선택지)으로 진입 */
export function selectTeam(state: RunState, charIds: string[], teamName: string, _opts?: RunOptions): void {
  if (state.phase !== 'select_team') throw new Error('팀 선택 단계가 아닙니다.');
  if (charIds.length !== TEAM_SIZE) throw new Error(`정확히 ${TEAM_SIZE}명을 선택해야 합니다.`);
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
  state.day = 1;
  state.step = 1;
  state.phase = 'choice';
  state.bonusPoints = 0;
  state.history = [];
  state.currentChoices = [];
  state.monsterOptions = null;
  state.currentMonster = null;
  state.currentMap = null;
  state.opponent = null;
  state.rarityFloor = null;
  state.pendingTeamStatBonus = 0;
  state.rerolls = REROLLS_PER_DAY;
  (state as RunStateInternal).dayProgress = { day: 1, points: 0, choices: [], monster: null };

  // 분화 예정 일차: TEAM_SIZE 명을 [SUBJOB_DAY_MIN, SUBJOB_DAY_MAX](4~6일차) 에 최대한 고르게 분산한다.
  // 일차를 한 바퀴(셔플)씩 돌며 인원수만큼 슬롯을 채우므로 4인 팀이면 세 날 모두 최소 1명, 한 날만 2명이고
  // 그 '2명인 날'은 시드에 따라 달라진다 (같은 시드면 항상 같은 배정).
  const rng = new Rng(hashSeed(`${state.seed}:0:0:subjob:0`));
  const days: number[] = [];
  for (let d = SUBJOB_DAY_MIN; d <= SUBJOB_DAY_MAX; d++) days.push(d);
  const slots: number[] = [];
  while (slots.length < members.length) {
    const round = rng.shuffle(days);
    for (let i = 0; i < round.length && slots.length < members.length; i++) slots.push(round[i]);
  }
  const assigned = rng.shuffle(slots);
  state.subJobChoiceDay = {};
  for (let i = 0; i < members.length; i++) state.subJobChoiceDay[members[i].id] = assigned[i];

  state.currentChoices = generateChoices(state, choiceRng(state));
}

/** 현재 선택지가 분화 보장 세트(한 캐릭터의 세부 직업 3장)인지. 리롤해도 같은 카드가 나오므로 리롤 불가 */
export function isSubJobChoiceSet(state: RunState): boolean {
  return state.currentChoices.length > 0 && state.currentChoices.every((c) => c.kind === 'subjob');
}

/**
 * 선택 단계인데 선택지가 비어 있으면 (저장 데이터 정리 등) 다시 만든다.
 * 시드가 seed/day/step/rerolls 에서만 파생되므로 같은 상태에서는 같은 세트가 나온다.
 */
export function ensureChoices(state: RunState): boolean {
  if (!state.team || state.phase !== 'choice') return false;
  if (state.currentChoices.length > 0) return false;
  ensureSubJobSchedule(state);
  state.currentChoices = generateChoices(state, choiceRng(state));
  return true;
}

/** 리롤: 보너스 포인트 소모. 분화 세트는 리롤할 수 없다(포인트 차감 없이 false). */
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

/**
 * 선택지 하나를 고른다.
 *  - 1스텝 → 2스텝(선택지), 2스텝 → 3스텝(몬스터 선택), 4스텝 → 5스텝(4:4 전투 준비)
 * rarityFloor 는 이 시점에 소비된다 (리롤 중에는 유지).
 */
export function pickChoice(
  state: RunState,
  index: number,
  opts?: RunOptions,
): { success: boolean | null; applied: ChoiceEffect[]; choice: Choice } {
  const team = requireTeam(state);
  if (state.phase !== 'choice') throw new Error('선택 단계가 아닙니다.');
  const choice = state.currentChoices[index];
  if (!choice) throw new Error('존재하지 않는 선택지입니다.');

  const prevAutoIds = new Set<string>(autoSynergies(team).map((s: SynergyDef) => s.id));
  const pointsBefore = state.bonusPoints;
  const res = applyChoice(state, choice, rngFor(state, 'pick'));
  if (choice.kind === 'job_change') refreshAutoSynergies(team, prevAutoIds);

  const prog = progressOf(state);
  prog.choices.push({ title: choice.title, rarity: choice.rarity, success: res.success });
  const gained = state.bonusPoints - pointsBefore;
  if (gained > 0) prog.points += gained;

  state.rarityFloor = null;
  state.currentChoices = [];

  if (state.step === 1) {
    state.step = 2;
    state.phase = 'choice';
    ensureSubJobSchedule(state);
    state.currentChoices = generateChoices(state, choiceRng(state));
  } else if (state.step === 2) {
    state.step = MONSTER_STEP;
    state.phase = 'monster_select';
    state.monsterOptions = null;
    state.currentMonster = null;
    monsterOptions(state);
  } else {
    // 4스텝: 4:4 전투 준비
    prepareBattle(state, opts);
  }

  return { success: res.success, applied: res.applied, choice };
}

/**
 * 4:4 전투 준비: 맵(전날과 다른 맵), 상대(같은 일차 고스트 우선), phase 'pre_battle'.
 * 고스트는 같은 일차 · 다른 육성 시드 · 인원이 정확히 TEAM_SIZE 인 것만 상대 후보가 된다.
 */
export function prepareBattle(state: RunState, opts?: RunOptions): void {
  requireTeam(state);
  state.step = BATTLE_STEP;
  state.phase = 'pre_battle';
  state.monsterOptions = null;
  state.currentMonster = null;
  state.currentChoices = [];

  // 몬스터 보상(팀 전원 랜덤 스탯)은 이 전투부터 반영된다
  applyPendingTeamStatBonus(state);

  const rng = rngFor(state, 'prep');
  const prevMap = state.history.length > 0 ? state.history[state.history.length - 1].map : null;
  const candidates = MAP_TYPES.filter((m) => m !== prevMap);
  const map: MapType = rng.pick(candidates.length > 0 ? candidates : MAP_TYPES);

  const ghosts = (opts?.ghosts ?? []).filter(
    (g) => g.day === state.day && g.runSeed !== state.seed && g.team.members.length === TEAM_SIZE,
  );
  const ghostChance = opts?.ghostChance ?? 1;
  let opponent: Team;
  if (ghosts.length > 0 && rng.chance(ghostChance)) {
    opponent = cloneGhostTeam(rng.pick(ghosts), state.day);
  } else {
    opponent = generateOpponentTeam(rng, state.day, map, `o${state.day}`);
  }

  state.currentMap = map;
  state.opponent = opponent;
}

/** 이전 이름 호환 별칭 (구 API: prepareNextBattle) */
export const prepareNextBattle = prepareBattle;

/** 고스트 팀 복제. 캐릭터 id 에 'g_' 접두어를 붙여 플레이어 팀과 충돌하지 않게 한다 (이름은 유지). */
function cloneGhostTeam(g: GhostSnapshot, day: number): Team {
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
  t.id = `g_${g.runSeed}_${day}`;
  return t;
}

/** 4:4 전투 입력. 전투 시드 = hashSeed(seed:day:BATTLE_STEP:battle) */
export function battleInput(state: RunState): BattleInput {
  const team = requireTeam(state);
  if (!state.currentMap || !state.opponent) throw new Error('전투가 준비되지 않았습니다.');
  return {
    seed: hashSeed(`${state.seed}:${state.day}:${BATTLE_STEP}:battle`),
    map: state.currentMap,
    teamA: team,
    teamB: state.opponent,
  };
}

/** 4:4 관전 시작 (phase 'battle') */
export function startBattle(state: RunState): BattleInput {
  const input = battleInput(state);
  state.phase = 'battle';
  return input;
}

/** 4:4 전투 종료: 하루 기록 확정, 포인트 지급, 하루 마무리(day_end) */
export function finishBattle(state: RunState, result: BattleResult): void {
  const team = requireTeam(state);
  if (state.phase !== 'battle' && state.phase !== 'pre_battle') throw new Error('전투 단계가 아닙니다.');
  if (!state.currentMap) throw new Error('전투 맵이 없습니다.');

  const prog = progressOf(state);
  const points = bonusFor(result, state.day);
  state.bonusPoints += points;
  prog.points += points;

  const rec: DayRecord = {
    day: state.day,
    map: state.currentMap,
    result,
    opponentName: state.opponent ? state.opponent.name : '알 수 없음',
    monster: prog.monster,
    pointsEarned: prog.points,
    choicesTaken: prog.choices.slice(),
    teamSnapshot: cloneTeam(team),
  };
  state.history.push(rec);

  state.phase = 'day_end';
  state.step = 0;
  state.currentChoices = [];
}

/** 보너스 포인트로 스킬 구매 (하루 마무리 상점). 슬롯이 가득 차면 같은 타입의 가장 오래된 스킬을 대체한다. */
export function buySkill(state: RunState, charId: string, skillId: string): boolean {
  const team = state.team;
  if (!team || state.phase !== 'day_end') return false;
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
  if (!team || state.phase !== 'day_end') return false;
  const c = getMember(state, charId);
  if (!c) return false;
  if (c.stats[stat] >= STAT_MAX) return false;
  if (state.bonusPoints < STAT_TRAIN_COST) return false;
  state.bonusPoints -= STAT_TRAIN_COST;
  applyEffect(team, { kind: 'stat', charId, stat, delta: STAT_TRAIN_DELTA });
  return true;
}

/** 하루 마무리 종료 → 다음 날 1스텝, 10일차면 육성 완료 */
export function finishDay(state: RunState, opts?: RunOptions): void {
  requireTeam(state);
  if (state.phase !== 'day_end') throw new Error('하루 마무리 단계가 아닙니다.');
  void opts;

  applyPendingTeamStatBonus(state);

  if (state.day >= TOTAL_DAYS) {
    state.phase = 'done';
    state.step = 0;
    state.currentChoices = [];
    state.monsterOptions = null;
    state.currentMonster = null;
    state.currentMap = null;
    state.opponent = null;
    state.rerolls = 0;
    return;
  }

  state.day += 1;
  state.step = 1;
  state.phase = 'choice';
  state.rerolls = REROLLS_PER_DAY;
  state.monsterOptions = null;
  state.currentMonster = null;
  state.currentMap = null;
  state.opponent = null;
  (state as RunStateInternal).dayProgress = { day: state.day, points: 0, choices: [], monster: null };
  ensureSubJobSchedule(state);
  state.currentChoices = generateChoices(state, choiceRng(state));
}

/** 완료된(또는 진행 중인) 육성에서 고스트 스냅샷 목록을 만든다 (각 일차 4:4 전투 직전 팀, TEAM_SIZE 명) */
export function ghostsFromRun(state: RunState, savedAt: string): GhostSnapshot[] {
  const out: GhostSnapshot[] = [];
  for (const rec of state.history) {
    out.push({ runSeed: state.seed, day: rec.day, team: cloneTeam(rec.teamSnapshot), savedAt });
  }
  return out;
}

/** 표시용: 난이도 한국어 이름 */
export function tierName(tier: MonsterTier): string {
  return MONSTER_TIER_NAME_KO[tier];
}
