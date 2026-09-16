/**
 * 로그라이크 선택지 생성·적용 (GDD §7.4, §7.5).
 *
 * 생성 순서가 중요하다: **먼저 카드별 희귀도를 뽑고, 그 희귀도에 맞는 크기로 효과를 만든다.**
 * (효과를 만든 뒤에 등급을 붙이지 않는다)
 *
 *  - generateChoices: 정확히 CHOICES_PER_SET 장. 중복 없음. rarityFloor 보장. 분화 예정이면 3장 모두 분화 카드
 *  - applyChoice / applyEffect: 효과 적용 (스탯 클램프, 스킬 슬롯 제한 준수)
 *  - applySubJob: 세부 직업 분화의 단일 적용 경로 (statBonus + adaptationBonus + grantedSkills). charGen 도 이것을 쓴다
 *  - estimatePowerDelta: 카드에 표시할 예상 전투력 상승치
 *
 * 난수는 인자로 받은 Rng 만 쓴다. Math.random / Date 금지. 순회는 항상 상수 배열 순서.
 *
 * 팀 인원은 TEAM_SIZE(4) 기준이다. 다수 대상 카드는 실제 team.members.length 로 인원을 잡되
 * (합동 훈련 2~3명, 편중 훈련 TEAM_SIZE-1 명 상승 + 1명 하락 = 4인 팀에서 3+1, 희생 = 나머지 전원)
 * 희귀도별 총 스탯 상승량 기준(RARITY_BUDGET)은 인원과 무관하게 유지한다 (GDD §7.4.2).
 */
import { Rng, hashSeed } from '../rng';
import type {
  BaseStatKey, Character, Choice, ChoiceEffect, ChoiceKind, ChoiceRarity, MainJob, MapType, RunState,
  StatCategory, SubJobDef, SubJobId, Team,
} from '../types';
import {
  BASE_STAT_KEYS, CHOICES_PER_SET, CHOICE_KIND_NAME_KO, CHOICE_RARITY_NAME_KO, CHOICE_RARITY_ORDER,
  CHOICE_RARITY_RANK, JOB_NAME_KO, MAIN_JOBS, MAP_NAME_KO, MAP_TYPES, MAX_ACTIVE_SKILLS, MAX_PASSIVE_SKILLS,
  STAT_CATEGORY, STAT_CATEGORY_NAME_KO, STAT_MAX, STAT_NAME_KO, TEAM_SIZE, TOTAL_DAYS,
} from '../types';
import { JOBS, getSubJob } from '../data/jobs';
import { getSkill, skillPoolFor } from '../data/skills';
import { generateSynergyCandidates } from '../data/synergies';
import { clampStat, statTotal } from '../stats';

// ───────────────────────── 텍스트 유틸 ─────────────────────────

/** 받침 유무에 따른 조사 선택. 한글이 아니면 without 을 쓴다. */
function josa(word: string, withBatchim: string, without: string): string {
  const code = word.charCodeAt(word.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return without;
  return (code - 0xac00) % 28 !== 0 ? withBatchim : without;
}
const iGa = (w: string) => josa(w, '이', '가');
const eulReul = (w: string) => josa(w, '을', '를');
const euro = (w: string) => josa(w, '으로', '로');

function fmt(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

function statName(k: BaseStatKey): string {
  return STAT_NAME_KO[k];
}

// ───────────────────────── 예상 전투력 가중치 (GDD §7.4.4) ─────────────────────────

/** 스탯 1 = 1 */
const W_STAT = 1;
/** 스킬 1개 = 25 */
const W_SKILL = 25;
/** 시너지 1개 = 20 */
const W_SYNERGY = 20;
/** 직업 분화 = 35 */
const W_SUBJOB = 35;
/** 맵 적응 1 = 0.4 */
const W_ADAPT = 0.4;
/** 보너스 포인트 1 = 0.15 (30포인트 ≈ 스탯 +4) */
const W_POINT = 0.15;

// ───────────────────────── 희귀도 ─────────────────────────

/** 희귀도별 총 스탯 상승량 기준 (GDD §7.4.2) */
const RARITY_BUDGET: Record<ChoiceRarity, [number, number]> = {
  common: [10, 16],
  rare: [20, 30],
  epic: [36, 50],
  legendary: [60, 85],
};

/** 트레이드오프·도박형이 위험을 지는 대가로 받는 상승량 배율 (최대 1.4배) */
const RISK_MULT = 1.4;

/** 희생 카드 한 장이 줄 수 있는 보너스 포인트 상한 (하루 벌이를 넘지 않게) */
const SACRIFICE_MAX_POINTS = 150;

/**
 * 편중 훈련(tradeoff)의 상승 인원. 팀에서 1명이 하락하고 나머지가 상승하되 최대 3명.
 * TEAM_SIZE = 4 → 3명 상승 + 1명 하락 (팀 전원 관여). TEAM_SIZE = 3 이면 2 + 1.
 */
const TRADEOFF_MAX_GAINERS = Math.max(2, Math.min(3, TEAM_SIZE - 1));

/** 합동 훈련(small_multi)의 대상 인원 범위. 전설은 팀 전원까지 갈 수 있다 */
const SMALL_MULTI_MIN = 2;
const SMALL_MULTI_MAX = Math.min(3, TEAM_SIZE);

/** 스킬 습득 카드의 등급은 스킬 가격으로 본다 (skills.ts 의 cost 는 60~150) */
const SKILL_COST_BAND: Record<ChoiceRarity, [number, number]> = {
  common: [0, 79],
  rare: [80, 109],
  epic: [110, 129],
  legendary: [130, 100000],
};

/** 일차별 희귀도 가중치 (GDD §7.4.1). CHOICE_RARITY_ORDER 순서 */
function rarityWeights(day: number): number[] {
  if (day <= 3) return [52, 32, 13, 3];
  if (day <= 7) return [44, 34, 17, 5];
  return [34, 35, 22, 9];
}

function rollRarity(rng: Rng, day: number): ChoiceRarity {
  return rng.weighted(CHOICE_RARITY_ORDER, rarityWeights(day));
}

function budgetFor(rng: Rng, rarity: ChoiceRarity): number {
  const [lo, hi] = RARITY_BUDGET[rarity];
  return rng.int(lo, hi);
}

/**
 * 표시 검증용: 예상 전투력 상승치를 희귀도 구간으로 되돌린다.
 * 생성은 희귀도 → 효과 순서이므로 이 함수는 검증/디버그에만 쓴다
 * (스킬·분화·시너지 카드는 스탯 환산값이 구간을 벗어날 수 있다).
 */
export function rarityForPowerDelta(delta: number): ChoiceRarity {
  if (delta < 18) return 'common';
  if (delta < 33) return 'rare';
  if (delta < 56) return 'epic';
  return 'legendary';
}

/** 총량을 n등분 (합이 정확히 total 이 되도록). 결정론적. */
function splitBudget(total: number, n: number): number[] {
  const out: number[] = [];
  let left = total;
  for (let i = 0; i < n; i++) {
    const v = Math.max(1, Math.round(left / (n - i)));
    out.push(v);
    left -= v;
  }
  return out;
}

// ───────────────────────── 성장 계수 ─────────────────────────

const CATEGORIES: readonly StatCategory[] = ['body', 'mind', 'skill', 'magic'];

function growthOf(c: Character, k: BaseStatKey): number {
  let g = (JOBS[c.mainJob].growth[k] ?? 1) * (c.growthVariance[k] ?? 1);
  if (c.subJob) {
    const sub = getSubJob(c.subJob);
    g *= sub.growthMod[k] ?? 1;
  }
  return Math.max(0.6, Math.min(1.4, g));
}

/**
 * 직업 성향은 '얼마나 오르는가'가 아니라 '어느 스탯이 오르는가'로 반영한다.
 * (상승량까지 성장 계수로 곱하면 희귀도별 총량 기준이 ±40% 흔들려 카드 등급 표시가 어긋난다)
 * room 이 있으면 상한(STAT_MAX)에 여유가 있는 스탯만 후보로 삼는다.
 */
function pickStat(rng: Rng, c: Character, room = 0): BaseStatKey {
  const roomy = BASE_STAT_KEYS.filter((k) => c.stats[k] + room <= STAT_MAX);
  const pool: readonly BaseStatKey[] = roomy.length > 0 ? roomy : BASE_STAT_KEYS;
  const weights = pool.map((k) => {
    const g = growthOf(c, k);
    return g * g;
  });
  return rng.weighted(pool, weights);
}

function findChar(team: Team, id: string): Character | null {
  for (const c of team.members) if (c.id === id) return c;
  return null;
}

function countType(c: Character, type: 'active' | 'passive'): number {
  let n = 0;
  for (const id of c.skills) if (getSkill(id).type === type) n++;
  return n;
}

function oldestOfType(c: Character, type: 'active' | 'passive'): string | null {
  for (const id of c.skills) if (getSkill(id).type === type) return id;
  return null;
}

function skillTypeKo(type: 'active' | 'passive'): string {
  return type === 'active' ? '액티브' : '패시브';
}

function slotFull(c: Character, type: 'active' | 'passive'): boolean {
  return countType(c, type) >= (type === 'active' ? MAX_ACTIVE_SKILLS : MAX_PASSIVE_SKILLS);
}

// ───────────────────────── 예상 전투력 상승치 ─────────────────────────

function effectPower(team: Team, e: ChoiceEffect): number {
  switch (e.kind) {
    case 'stat':
      return e.delta * W_STAT;
    case 'stat_category': {
      let n = 0;
      for (const k of BASE_STAT_KEYS) if (STAT_CATEGORY[k] === e.category) n++;
      return e.delta * n * W_STAT;
    }
    case 'adaptation': {
      const n = e.charId === 'all' ? team.members.length : 1;
      return e.delta * n * W_ADAPT;
    }
    case 'learn_skill': {
      const c = findChar(team, e.charId);
      if (!c) return W_SKILL;
      if (c.skills.includes(e.skillId)) return 0;
      // 슬롯이 가득 차 기존 스킬을 대체하면 순 이득이 줄어든다
      return slotFull(c, getSkill(e.skillId).type) ? W_SKILL * 0.4 : W_SKILL;
    }
    case 'forget_skill':
      return -W_SKILL;
    case 'set_subjob': {
      const sub = getSubJob(e.subJob);
      let v = W_SUBJOB;
      for (const k of BASE_STAT_KEYS) v += (sub.statBonus[k] ?? 0) * W_STAT;
      if (sub.adaptationBonus) {
        for (const m of MAP_TYPES) v += (sub.adaptationBonus[m] ?? 0) * W_ADAPT;
      }
      v += sub.grantedSkills.length * W_SKILL;
      return v;
    }
    case 'change_job': {
      const c = findChar(team, e.charId);
      if (!c) return 0;
      let v = -statTotal(c) * (e.statLossPct / 100) * W_STAT;
      const def = JOBS[e.mainJob];
      const allowed = new Set<string>([...def.skillPool, ...def.starterSkills]);
      let lost = 0;
      for (const id of c.skills) if (!allowed.has(id)) lost++;
      v -= lost * W_SKILL;
      if (def.starterSkills.length > 0) v += W_SKILL;
      if (c.subJob) v -= W_SUBJOB;
      return v;
    }
    case 'add_synergy':
      return W_SYNERGY;
    case 'bonus_points':
      return e.delta * W_POINT;
  }
}

function sumPower(team: Team, effects: readonly ChoiceEffect[]): number {
  let sum = 0;
  for (const e of effects) sum += effectPower(team, e);
  return sum;
}

/**
 * 카드에 표시할 예상 전투력 상승치 (GDD §7.4.4).
 * 가중치: 스탯 1 = 1, 스킬 = 25, 시너지 = 20, 직업 분화 = 35, 맵 적응 1 = 0.4.
 * 도박형은 성공 확률로 가중한 기댓값을 돌려준다.
 */
export function estimatePowerDelta(team: Team, choice: Choice): number {
  const win = sumPower(team, choice.effects);
  if (choice.successChance === undefined) return Math.round(win);
  const lose = sumPower(team, choice.failEffects ?? []);
  const p = Math.max(0, Math.min(1, choice.successChance));
  return Math.round(win * p + lose * (1 - p));
}

// ───────────────────────── 선택지 종류 가중치 ─────────────────────────

const KINDS: readonly ChoiceKind[] = [
  'big_single', 'small_multi', 'tradeoff', 'gamble', 'skill', 'adaptation', 'synergy', 'sacrifice',
];

/**
 * 희귀도별로 어울리는 종류.
 * 'subjob'(항상 에픽)과 'job_change'(등급 예산 밖)는 여기 넣지 않고 별도 경로로 만든다.
 */
const RARITY_KINDS: Record<ChoiceRarity, readonly ChoiceKind[]> = {
  common: ['big_single', 'small_multi', 'tradeoff', 'gamble', 'skill', 'adaptation', 'sacrifice'],
  rare: ['big_single', 'small_multi', 'tradeoff', 'gamble', 'skill', 'adaptation', 'synergy', 'sacrifice'],
  epic: ['big_single', 'small_multi', 'tradeoff', 'gamble', 'skill', 'adaptation', 'synergy', 'sacrifice'],
  legendary: ['big_single', 'small_multi', 'tradeoff', 'gamble', 'skill', 'synergy', 'sacrifice'],
};

/**
 * 직업 변경 카드가 한 세트에 낄 확률 (GDD §7.5 "낮은 확률 등장").
 * 등급 롤과 무관한 별도 경로다. 3일차부터, 재분화 기회가 남는 마지막 날 전까지만 나온다.
 */
function jobChangeChance(day: number): number {
  if (day < 3 || day >= TOTAL_DAYS) return 0;
  return day <= 7 ? 0.09 : 0.07;
}

function dayKindWeight(day: number, kind: ChoiceKind): number {
  if (day <= 3) {
    switch (kind) {
      case 'big_single': return 18;
      case 'small_multi': return 22;
      case 'tradeoff': return 8;
      case 'gamble': return 8;
      case 'skill': return 18;
      case 'job_change': return day >= 3 ? 6 : 0;
      case 'adaptation': return 14;
      case 'synergy': return 6;
      case 'sacrifice': return 4;
      case 'subjob': return 0;
    }
  }
  if (day <= 7) {
    switch (kind) {
      case 'big_single': return 18;
      case 'small_multi': return 14;
      case 'tradeoff': return 12;
      case 'gamble': return 12;
      case 'skill': return 14;
      case 'job_change': return 8;
      case 'adaptation': return 10;
      case 'synergy': return 10;
      case 'sacrifice': return 6;
      case 'subjob': return 0;
    }
  }
  switch (kind) {
    case 'big_single': return 22;
    case 'small_multi': return 8;
    case 'tradeoff': return 14;
    case 'gamble': return 16;
    case 'skill': return 10;
    case 'job_change': return 6;
    case 'adaptation': return 6;
    case 'synergy': return 16;
    case 'sacrifice': return 8;
    case 'subjob': return 0;
  }
}

// ───────────────────────── 개별 선택지 생성 ─────────────────────────

interface Ctx {
  state: RunState;
  team: Team;
  rng: Rng;
  day: number;
  seq: number;
}

function makeId(ctx: Ctx, kind: ChoiceKind): string {
  return `ch${ctx.day}_${ctx.state.step}r${ctx.state.rerolls}_${ctx.seq++}_${kind}`;
}

/** powerDelta 를 채워 완성한다 */
function mk(ctx: Ctx, base: Omit<Choice, 'powerDelta'>): Choice {
  const ch: Choice = { ...base, powerDelta: 0 };
  ch.powerDelta = estimatePowerDelta(ctx.team, ch);
  return ch;
}

function buildBigSingle(ctx: Ctx, rarity: ChoiceRarity): Choice {
  const { rng, team } = ctx;
  const budget = budgetFor(rng, rarity);
  const c = rng.pick(team.members);
  if (rng.chance(0.72)) {
    const stat = pickStat(rng, c, Math.round(budget * 0.5));
    return mk(ctx, {
      id: makeId(ctx, 'big_single'), kind: 'big_single', rarity,
      title: `${CHOICE_KIND_NAME_KO.big_single}: ${c.name}의 ${statName(stat)}`,
      desc: `${c.name}의 ${statName(stat)} ${fmt(budget)} (현재 ${c.stats[stat]}).`,
      charIds: [c.id],
      effects: [{ kind: 'stat', charId: c.id, stat, delta: budget }],
    });
  }
  const category = rng.pick(CATEGORIES);
  let n = 0;
  for (const k of BASE_STAT_KEYS) if (STAT_CATEGORY[k] === category) n++;
  const delta = Math.max(1, Math.round(budget / n));
  return mk(ctx, {
    id: makeId(ctx, 'big_single'), kind: 'big_single', rarity,
    title: `${CHOICE_KIND_NAME_KO.big_single}: ${c.name}의 ${STAT_CATEGORY_NAME_KO[category]}`,
    desc: `${c.name}의 ${STAT_CATEGORY_NAME_KO[category]} 카테고리 스탯 ${n}개 각각 ${fmt(delta)} (합계 ${fmt(delta * n)}).`,
    charIds: [c.id],
    effects: [{ kind: 'stat_category', charId: c.id, category, delta }],
  });
}

function buildSmallMulti(ctx: Ctx, rarity: ChoiceRarity): Choice {
  const { rng, team } = ctx;
  const budget = budgetFor(rng, rarity);
  // 일반·레어·에픽 2~3명, 전설은 3명~팀 전원(TEAM_SIZE). 총 상승량(budget)은 인원과 무관하게 희귀도 기준을 따른다.
  const want =
    rarity === 'legendary' ? rng.int(Math.min(3, TEAM_SIZE), TEAM_SIZE) : rng.int(SMALL_MULTI_MIN, SMALL_MULTI_MAX);
  const n = Math.max(1, Math.min(team.members.length, want));
  const chars = rng.sample(team.members, n);
  const stat = pickStat(rng, chars[0]);
  const parts = splitBudget(budget, n);
  const effects: ChoiceEffect[] = [];
  const texts: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const delta = parts[i];
    effects.push({ kind: 'stat', charId: chars[i].id, stat, delta });
    texts.push(`${chars[i].name} ${fmt(delta)}`);
  }
  return mk(ctx, {
    id: makeId(ctx, 'small_multi'), kind: 'small_multi', rarity,
    title: `${CHOICE_KIND_NAME_KO.small_multi}: ${statName(stat)} ${n}인`,
    desc: `${statName(stat)} 합동 훈련 — ${texts.join(', ')}. (합계 ${fmt(budget)})`,
    charIds: chars.map((c) => c.id),
    effects,
  });
}

function buildTradeoff(ctx: Ctx, rarity: ChoiceRarity): Choice | null {
  const { rng, team } = ctx;
  if (team.members.length < 3) return null;
  const budget = budgetFor(rng, rarity);
  const gainTotal = Math.round(budget * RISK_MULT);
  // 4인 팀: 3명 상승 + 1명 하락 (GDD §7.5). 인원이 더 적은 팀이면 (인원 − 1)명 상승.
  const gainerCount = Math.min(team.members.length - 1, TRADEOFF_MAX_GAINERS);
  const picked = rng.sample(team.members, gainerCount + 1);
  const gainers = picked.slice(0, gainerCount);
  const loser = picked[gainerCount];
  const parts = splitBudget(gainTotal, gainerCount);
  const effects: ChoiceEffect[] = [];
  const texts: string[] = [];
  for (let i = 0; i < gainers.length; i++) {
    const c = gainers[i];
    const stat = pickStat(rng, c, parts[i]);
    effects.push({ kind: 'stat', charId: c.id, stat, delta: parts[i] });
    texts.push(`${c.name} ${statName(stat)} ${fmt(parts[i])}`);
  }
  const lossStat = rng.pick(BASE_STAT_KEYS);
  const loss = -Math.max(2, Math.round(budget * 0.4));
  effects.push({ kind: 'stat', charId: loser.id, stat: lossStat, delta: loss });
  return mk(ctx, {
    id: makeId(ctx, 'tradeoff'), kind: 'tradeoff', rarity,
    title: `${CHOICE_KIND_NAME_KO.tradeoff}: ${loser.name}${iGa(loser.name)} 양보`,
    desc: `${texts.join(', ')}. 대신 ${loser.name}의 ${statName(lossStat)} ${fmt(loss)}.`,
    charIds: picked.map((c) => c.id),
    effects,
  });
}

function buildGamble(ctx: Ctx, rarity: ChoiceRarity): Choice {
  const { rng, team } = ctx;
  const budget = budgetFor(rng, rarity);
  const c = rng.pick(team.members);
  const gain = Math.round(budget * RISK_MULT);
  const stat = pickStat(rng, c, Math.round(gain * 0.5));
  const pct = rng.int(60, 80);
  const loss = -Math.max(2, Math.round(budget * 0.3));
  return mk(ctx, {
    id: makeId(ctx, 'gamble'), kind: 'gamble', rarity,
    title: `${CHOICE_KIND_NAME_KO.gamble}: ${c.name}의 ${statName(stat)} (성공률 ${pct}%)`,
    desc: `${pct}% 확률로 ${c.name}의 ${statName(stat)} ${fmt(gain)}. 실패 시 ${statName(stat)} ${fmt(loss)}. (현재 ${c.stats[stat]})`,
    charIds: [c.id],
    effects: [{ kind: 'stat', charId: c.id, stat, delta: gain }],
    successChance: pct / 100,
    failEffects: [{ kind: 'stat', charId: c.id, stat, delta: loss }],
  });
}

/** 스킬 카드의 등급은 스킬 가격 구간으로 정한다 (GDD §7.4.2) */
function buildSkill(ctx: Ctx, rarity: ChoiceRarity): Choice | null {
  const { rng, team } = ctx;
  const [lo, hi] = SKILL_COST_BAND[rarity];
  const cands: { c: Character; skillId: string }[] = [];
  for (const c of team.members) {
    for (const id of skillPoolFor(c)) {
      const cost = getSkill(id).cost;
      if (cost >= lo && cost <= hi) cands.push({ c, skillId: id });
    }
  }
  if (cands.length === 0) return null;
  const { c, skillId } = rng.pick(cands);
  const def = getSkill(skillId);
  let note = '';
  if (slotFull(c, def.type)) {
    const old = oldestOfType(c, def.type);
    if (old) note = ` (${skillTypeKo(def.type)} 슬롯이 가득 차 [${getSkill(old).name}]${eulReul(getSkill(old).name)} 잊습니다)`;
  }
  return mk(ctx, {
    id: makeId(ctx, 'skill'), kind: 'skill', rarity,
    title: `${CHOICE_KIND_NAME_KO.skill}: [${def.name}]`,
    desc: `${c.name}${iGa(c.name)} ${skillTypeKo(def.type)} 스킬 [${def.name}]${eulReul(def.name)} 습득합니다${note}. ${def.desc}`,
    charIds: [c.id],
    effects: [{ kind: 'learn_skill', charId: c.id, skillId }],
  });
}

/**
 * 직업 변경 카드. 희귀도 예산(총 스탯 상승량) 체계 밖의 특수 카드다.
 * 스탯을 잃는 대신 직업을 갈아엎는 선택이라 예상 전투력이 음수인 것이 정상이므로,
 * 카드 색이 값을 과장하지 않도록 등급은 실제 powerDelta 구간(rarityForPowerDelta)으로 정한다.
 * 스탯 손실은 GDD §7.5 의 -10% 를 그대로 쓴다.
 */
const JOB_CHANGE_STAT_LOSS_PCT = 10;

function buildJobChange(ctx: Ctx): Choice | null {
  const { rng, team, day } = ctx;
  if (day < 3) return null;
  // 마지막 날은 재분화 기회가 없으므로 직업 변경을 내지 않는다
  if (day >= TOTAL_DAYS) return null;
  const c = rng.pick(team.members);
  const others = MAIN_JOBS.filter((j) => j !== c.mainJob);
  const newJob = rng.pick(others);
  const statLossPct = JOB_CHANGE_STAT_LOSS_PCT;
  const starter = JOBS[newJob].starterSkills;
  const starterName = starter.length > 0 ? getSkill(starter[hashSeed(c.id) % starter.length]).name : null;
  const ch = mk(ctx, {
    id: makeId(ctx, 'job_change'), kind: 'job_change', rarity: 'common',
    title: `${CHOICE_KIND_NAME_KO.job_change}: ${c.name} → ${JOB_NAME_KO[newJob]}`,
    desc:
      `${c.name}${eulReul(c.name)} ${JOB_NAME_KO[c.mainJob]}에서 ${JOB_NAME_KO[newJob]}${euro(JOB_NAME_KO[newJob])} 변경합니다. ` +
      `모든 스탯 -${statLossPct}%, 세부 직업 초기화(재분화 기회 부여), 새 직업에 맞지 않는 스킬 상실` +
      (starterName ? `, 시작 스킬 [${starterName}] 습득.` : '.'),
    charIds: [c.id],
    effects: [{ kind: 'change_job', charId: c.id, mainJob: newJob, statLossPct }],
  });
  ch.rarity = rarityForPowerDelta(ch.powerDelta);
  return ch;
}

/**
 * 맵 적응 카드 설명 뒤에 붙는 맵별 효과 안내 (v0.7). 거점 같은 옛 규칙은 언급하지 않는다.
 * 빙하는 눈보라(기믹) 피해가 적응도로 줄어드는 점이 실제 승패에 개입하므로 그 사실을 알려 준다.
 */
function adaptationHint(map: MapType): string {
  switch (map) {
    case 'glacier': return ' 빙하 적응도가 높을수록 눈보라 피해가 줄어듭니다 (적응도 100 이면 -30%).';
    case 'desert': return ' 사막은 지구력 소모가 2배라 적응도가 낮으면 빨리 지칩니다.';
    case 'dark': return ' 어둠에서는 시야가 좁아 적응도가 낮으면 적을 늦게 봅니다.';
    case 'plains': return ' 평원은 개활지라 적응도가 전투 전반의 능률에 고르게 반영됩니다.';
  }
}

function buildAdaptation(ctx: Ctx, rarity: ChoiceRarity): Choice {
  const { rng, team } = ctx;
  const budget = budgetFor(rng, rarity);
  const teamWide = budget >= 20 || rng.chance(0.5);
  const map = rng.pick(MAP_TYPES);
  if (teamWide) {
    const n = Math.max(1, team.members.length);
    const delta = Math.max(3, Math.min(25, Math.round(budget / (W_ADAPT * n))));
    return mk(ctx, {
      id: makeId(ctx, 'adaptation'), kind: 'adaptation', rarity,
      title: `${CHOICE_KIND_NAME_KO.adaptation}: 팀 전체 ${MAP_NAME_KO[map]}`,
      desc: `팀 ${n}명 전원의 ${MAP_NAME_KO[map]} 적응도 ${fmt(delta)}.${adaptationHint(map)}`,
      charIds: team.members.map((c) => c.id),
      effects: [{ kind: 'adaptation', charId: 'all', map, delta }],
    });
  }
  const c = rng.pick(team.members);
  const delta = Math.max(5, Math.min(30, Math.round(budget / W_ADAPT)));
  return mk(ctx, {
    id: makeId(ctx, 'adaptation'), kind: 'adaptation', rarity,
    title: `${CHOICE_KIND_NAME_KO.adaptation}: ${c.name}의 ${MAP_NAME_KO[map]}`,
    desc: `${c.name}의 ${MAP_NAME_KO[map]} 적응도 ${fmt(delta)} (현재 ${c.adaptation[map]}).${adaptationHint(map)}`,
    charIds: [c.id],
    effects: [{ kind: 'adaptation', charId: c.id, map, delta }],
  });
}

function buildSynergy(ctx: Ctx, rarity: ChoiceRarity): Choice | null {
  const { rng, team } = ctx;
  const cands = generateSynergyCandidates(team, rng, 1);
  if (cands.length === 0) return null;
  const syn = cands[0];
  const budget = budgetFor(rng, rarity);
  const charIds: string[] = [];
  if (syn.condition.kind === 'adjacency') charIds.push(syn.condition.a, syn.condition.b);
  else if (syn.condition.kind === 'job_count') {
    for (const c of team.members) if (c.mainJob === syn.condition.job) charIds.push(c.id);
  } else {
    for (const c of team.members) charIds.push(c.id);
  }
  if (charIds.length === 0) for (const c of team.members) charIds.push(c.id);

  const effects: ChoiceEffect[] = [{ kind: 'add_synergy', synergy: syn }];
  // 시너지 자체는 20 상당. 남는 예산은 관련 캐릭터 스탯으로 채운다.
  const extra = budget - W_SYNERGY;
  let extraText = '';
  if (extra >= 4) {
    const targets: Character[] = [];
    for (const id of charIds) {
      const c = findChar(team, id);
      if (c && !targets.includes(c)) targets.push(c);
    }
    const parts = splitBudget(extra, targets.length);
    const texts: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const stat = pickStat(rng, targets[i], parts[i]);
      effects.push({ kind: 'stat', charId: targets[i].id, stat, delta: parts[i] });
      texts.push(`${targets[i].name} ${statName(stat)} ${fmt(parts[i])}`);
    }
    extraText = ` 추가로 ${texts.join(', ')}.`;
  }
  return mk(ctx, {
    id: makeId(ctx, 'synergy'), kind: 'synergy', rarity,
    title: `${CHOICE_KIND_NAME_KO.synergy}: ${syn.name}`,
    desc: `시너지 [${syn.name}] 획득. ${syn.desc}${extraText}`,
    charIds,
    effects,
  });
}

function buildSacrifice(ctx: Ctx, rarity: ChoiceRarity): Choice {
  const { rng, team } = ctx;
  const budget = budgetFor(rng, rarity);
  const c = rng.pick(team.members);
  const effects: ChoiceEffect[] = [];
  const charIds = [c.id];
  let costText: string;
  let costValue: number;

  if (c.skills.length > 1 && rng.chance(0.5)) {
    const skillId = rng.pick(c.skills);
    const sname = getSkill(skillId).name;
    effects.push({ kind: 'forget_skill', charId: c.id, skillId });
    costText = `${c.name}${iGa(c.name)} 스킬 [${sname}]${eulReul(sname)} 포기`;
    costValue = W_SKILL;
  } else {
    const category = rng.pick(CATEGORIES);
    let n = 0;
    for (const k of BASE_STAT_KEYS) if (STAT_CATEGORY[k] === category) n++;
    const delta = -Math.max(2, Math.round(budget / 10));
    effects.push({ kind: 'stat_category', charId: c.id, category, delta });
    costText = `${c.name}의 ${STAT_CATEGORY_NAME_KO[category]} 카테고리 스탯 ${n}개 각각 ${fmt(delta)}`;
    costValue = -delta * n;
  }

  // 희생의 보상은 '나머지 팀원 전원' (TEAM_SIZE − 1 명) 에게 간다
  const others = team.members.filter((m) => m.id !== c.id);
  const reward = budget + costValue;
  let rewardText: string;
  if (others.length > 0 && rng.chance(0.65)) {
    const stat = pickStat(rng, others[0]);
    const parts = splitBudget(reward, others.length);
    const texts: string[] = [];
    for (let i = 0; i < others.length; i++) {
      effects.push({ kind: 'stat', charId: others[i].id, stat, delta: parts[i] });
      charIds.push(others[i].id);
      texts.push(`${others[i].name} ${fmt(parts[i])}`);
    }
    rewardText = `나머지 팀원 ${others.length}명의 ${statName(stat)} 상승 (${texts.join(', ')})`;
  } else {
    // 포인트 환산은 W_POINT 기준이지만, 한 장으로 하루 벌이를 넘지 않도록 상한을 둔다.
    // 상한 때문에 포기한 대가를 다 갚지 못하는 몫(leftover)은 스탯으로 돌려준다.
    // (그러지 않으면 예산이 큰 에픽·전설 희생 카드의 예상 전투력이 음수가 된다)
    const points = Math.max(20, Math.min(SACRIFICE_MAX_POINTS, Math.round(reward / W_POINT / 10) * 10));
    effects.push({ kind: 'bonus_points', delta: points });
    rewardText = `보너스 포인트 ${fmt(points)}`;
    const leftover = Math.round(reward - points * W_POINT);
    if (leftover >= 4 && others.length > 0) {
      const stat = pickStat(rng, others[0]);
      const parts = splitBudget(leftover, others.length);
      const texts: string[] = [];
      for (let i = 0; i < others.length; i++) {
        effects.push({ kind: 'stat', charId: others[i].id, stat, delta: parts[i] });
        charIds.push(others[i].id);
        texts.push(`${others[i].name} ${fmt(parts[i])}`);
      }
      rewardText += `, 나머지 팀원 ${others.length}명의 ${statName(stat)} 상승 (${texts.join(', ')})`;
    }
  }

  return mk(ctx, {
    id: makeId(ctx, 'sacrifice'), kind: 'sacrifice', rarity,
    title: `${CHOICE_KIND_NAME_KO.sacrifice}: ${c.name}의 결단`,
    desc: `${costText}하는 대신 ${rewardText}.`,
    charIds,
    effects,
  });
}

/** 직업 분화 카드의 기준 등급. GDD §7.4.2 "직업 분화는 항상 에픽으로 본다" */
const SUBJOB_RARITY: ChoiceRarity = 'epic';

/**
 * 직업 분화 카드는 항상 에픽으로 본다 (GDD §7.4.2).
 * 단 rarityFloor 가 에픽보다 높으면(예: 전설 보장) 보장 계약을 깨지 않도록 그 등급으로 올린다.
 */
function buildSubJob(ctx: Ctx, c: Character, sub: SubJobDef, rarity: ChoiceRarity = SUBJOB_RARITY): Choice {
  const bonusParts: string[] = [];
  for (const k of BASE_STAT_KEYS) {
    const v = sub.statBonus[k];
    if (v !== undefined && v !== 0) bonusParts.push(`${statName(k)} ${fmt(v)}`);
  }
  const adaptParts: string[] = [];
  if (sub.adaptationBonus) {
    for (const m of MAP_TYPES) {
      const v = sub.adaptationBonus[m];
      if (v !== undefined && v !== 0) adaptParts.push(`${MAP_NAME_KO[m]} 적응도 ${fmt(v)}`);
    }
  }
  const skillNames = sub.grantedSkills.map((id) => `[${getSkill(id).name}]`);
  const desc =
    `${c.name}${eulReul(c.name)} ${JOB_NAME_KO[c.mainJob]} → ${sub.name}${euro(sub.name)} 분화합니다. ${sub.desc}` +
    (bonusParts.length ? ` 스탯 보정: ${bonusParts.join(', ')}.` : '') +
    (adaptParts.length ? ` 맵 적응: ${adaptParts.join(', ')}.` : '') +
    (skillNames.length ? ` 습득 스킬: ${skillNames.join(', ')}.` : '');
  return mk(ctx, {
    id: makeId(ctx, 'subjob'), kind: 'subjob', rarity,
    title: `${CHOICE_KIND_NAME_KO.subjob}: ${sub.name}`,
    desc,
    charIds: [c.id],
    effects: [{ kind: 'set_subjob', charId: c.id, subJob: sub.id }],
  });
}

function build(ctx: Ctx, kind: ChoiceKind, rarity: ChoiceRarity): Choice | null {
  switch (kind) {
    case 'big_single': return buildBigSingle(ctx, rarity);
    case 'small_multi': return buildSmallMulti(ctx, rarity);
    case 'tradeoff': return buildTradeoff(ctx, rarity);
    case 'gamble': return buildGamble(ctx, rarity);
    case 'skill': return buildSkill(ctx, rarity);
    case 'adaptation': return buildAdaptation(ctx, rarity);
    case 'synergy': return buildSynergy(ctx, rarity);
    case 'sacrifice': return buildSacrifice(ctx, rarity);
    // 등급 롤 밖의 카드들 (별도 경로에서 만든다)
    case 'job_change': return null;
    case 'subjob': return null;
  }
}

function signature(ch: Choice): string {
  return `${ch.kind}|${JSON.stringify(ch.effects)}|${JSON.stringify(ch.failEffects ?? null)}`;
}

/** 이번 생성에서 분화 선택지를 받아야 할 캐릭터 (예정 일차가 지났고 아직 미분화) */
function scheduledSubJobChar(state: RunState, team: Team): Character | null {
  for (const c of team.members) {
    const due = state.subJobChoiceDay[c.id];
    if (due !== undefined && due <= state.day && c.subJob === null && JOBS[c.mainJob].subJobs.length > 0) return c;
  }
  return null;
}

// ───────────────────────── 공개 API ─────────────────────────

/**
 * 정확히 CHOICES_PER_SET 장의 서로 다른 선택지를 만든다.
 *
 * 1) 분화 예정 캐릭터가 있으면 그 캐릭터의 세부 직업 3종이 그대로 3장이 된다
 *    (기준 에픽. rarityFloor 가 더 높으면 그 등급으로 올려 보장을 지킨다).
 * 2) 아니면 낮은 확률로 '직업 변경' 특수 카드 1장을 먼저 깔고(등급 예산 밖),
 *    남은 칸은 카드별 희귀도를 먼저 뽑고(일차별 가중치), state.rarityFloor 가 있으면 최소 1장을 그 등급 이상으로 올린 뒤,
 *    각 희귀도에 맞는 크기로 효과를 만든다. 같은 세트에 같은 종류·같은 내용의 카드는 넣지 않는다.
 *
 * rarityFloor 는 여기서 지우지 않는다 (리롤해도 보장이 유지되도록). run.ts 의 pickChoice 가 소비한다.
 */
export function generateChoices(state: RunState, rng: Rng): Choice[] {
  const team = state.team;
  if (!team) throw new Error('팀이 없는 상태에서는 선택지를 만들 수 없습니다.');
  const ctx: Ctx = { state, team, rng, day: state.day, seq: 0 };

  const due = scheduledSubJobChar(state, team);
  if (due) {
    // 분화 카드도 rarityFloor 보장을 지켜야 한다. 기준 등급(에픽)이 보장 등급보다 낮으면 그 등급으로 올린다.
    const floor = state.rarityFloor;
    const rarity: ChoiceRarity =
      floor && CHOICE_RARITY_RANK[floor] > CHOICE_RARITY_RANK[SUBJOB_RARITY] ? floor : SUBJOB_RARITY;
    const subs = JOBS[due.mainJob].subJobs;
    const out: Choice[] = [];
    for (let i = 0; i < subs.length && out.length < CHOICES_PER_SET; i++) out.push(buildSubJob(ctx, due, subs[i], rarity));
    if (out.length < CHOICES_PER_SET) fillGeneral(ctx, out); // 세부 직업이 3개 미만인 예외 상황
    return out;
  }

  const out: Choice[] = [];
  // 직업 변경은 등급 예산 밖의 특수 카드라 희귀도 롤이 아니라 별도 확률로 낸다 (세트당 최대 1장).
  if (rng.chance(jobChangeChance(state.day))) {
    const jc = buildJobChange(ctx);
    if (jc) out.push(jc);
  }
  fillGeneral(ctx, out);
  return out;
}

/** 희귀도 3장을 뽑고 rarityFloor 보장을 적용한다 */
function rollRaritySet(ctx: Ctx, count: number): ChoiceRarity[] {
  const rarities: ChoiceRarity[] = [];
  for (let i = 0; i < count; i++) rarities.push(rollRarity(ctx.rng, ctx.day));
  const floor = ctx.state.rarityFloor;
  if (floor) {
    const need = CHOICE_RARITY_RANK[floor];
    let best = 0;
    for (let i = 1; i < rarities.length; i++) {
      if (CHOICE_RARITY_RANK[rarities[i]] > CHOICE_RARITY_RANK[rarities[best]]) best = i;
    }
    if (CHOICE_RARITY_RANK[rarities[best]] < need) rarities[best] = floor;
  }
  return rarities;
}

function fillGeneral(ctx: Ctx, out: Choice[]): void {
  const need = CHOICES_PER_SET - out.length;
  if (need <= 0) return;
  const rarities = rollRaritySet(ctx, need);
  const usedKinds = new Set<ChoiceKind>(out.map((c) => c.kind));
  const sigs = new Set<string>(out.map(signature));

  for (let i = 0; i < need; i++) {
    const rarity = rarities[i];
    const allowed = RARITY_KINDS[rarity];
    let made: Choice | null = null;
    let guard = 0;
    const tried = new Set<ChoiceKind>();
    while (!made && guard++ < 24) {
      const avail = KINDS.filter(
        (k) => allowed.includes(k) && !usedKinds.has(k) && !tried.has(k) && dayKindWeight(ctx.day, k) > 0,
      );
      if (avail.length === 0) break;
      const kind = ctx.rng.weighted(avail, avail.map((k) => dayKindWeight(ctx.day, k)));
      tried.add(kind);
      const ch = build(ctx, kind, rarity);
      if (!ch) continue;
      if (sigs.has(signature(ch))) continue;
      made = ch;
    }
    // 예비: 집중 훈련은 항상 만들 수 있다 (내용이 겹치면 다시 뽑는다)
    let fallback = 0;
    while (!made && fallback++ < 40) {
      const ch = buildBigSingle(ctx, rarity);
      if (sigs.has(signature(ch))) continue;
      made = ch;
    }
    if (!made) made = buildBigSingle(ctx, rarity);
    usedKinds.add(made.kind);
    sigs.add(signature(made));
    out.push(made);
  }
}

/**
 * 선택지 적용. 도박형은 rng.chance(successChance) 로 성공 여부를 정한다.
 * bonus_points 효과는 state.bonusPoints 에 반영한다. 분화 선택지는 예정 목록에서 제거한다.
 */
export function applyChoice(state: RunState, choice: Choice, rng: Rng): { success: boolean | null; applied: ChoiceEffect[] } {
  const team = state.team;
  if (!team) throw new Error('팀이 없는 상태에서는 선택지를 적용할 수 없습니다.');

  let success: boolean | null = null;
  let applied: ChoiceEffect[];
  if (choice.successChance !== undefined) {
    success = rng.chance(choice.successChance);
    applied = success ? choice.effects : (choice.failEffects ?? []);
  } else {
    applied = choice.effects;
  }

  for (const e of applied) {
    if (e.kind === 'bonus_points') state.bonusPoints = Math.max(0, state.bonusPoints + e.delta);
    else applyEffect(team, e);
  }

  if (choice.kind === 'subjob') {
    for (const id of choice.charIds) delete state.subJobChoiceDay[id];
  }
  return { success, applied };
}

/** 스킬 습득. 같은 타입 슬롯이 가득 차면 가장 오래된(앞쪽) 스킬을 대체한다. */
function learnSkill(c: Character, skillId: string): void {
  if (c.skills.includes(skillId)) return;
  const def = getSkill(skillId);
  const max = def.type === 'active' ? MAX_ACTIVE_SKILLS : MAX_PASSIVE_SKILLS;
  if (countType(c, def.type) >= max) {
    const old = oldestOfType(c, def.type);
    if (old) c.skills.splice(c.skills.indexOf(old), 1);
  }
  c.skills.push(skillId);
}

/**
 * 세부 직업 분화 적용 (v0.7 단일 경로). statBonus 가산 → adaptationBonus 가산(상한 STAT_MAX) → grantedSkills 습득 순.
 * 플레이어 선택지(set_subjob)·생성 상대팀(charGen)·몬스터 어느 분화 경로든 반드시 이 함수를 쓴다.
 * 순회는 BASE_STAT_KEYS / MAP_TYPES 고정 순서. 난수 없음.
 */
export function applySubJob(c: Character, subJobId: SubJobId): void {
  const sub = getSubJob(subJobId);
  c.subJob = sub.id;
  for (const k of BASE_STAT_KEYS) {
    const v = sub.statBonus[k];
    if (v !== undefined && v !== 0) c.stats[k] = clampStat(c.stats[k] + v);
  }
  const adapt = sub.adaptationBonus;
  if (adapt) {
    for (const m of MAP_TYPES) {
      const v = adapt[m];
      if (v !== undefined && v !== 0) c.adaptation[m] = clampStat(c.adaptation[m] + v);
    }
  }
  for (const id of sub.grantedSkills) learnSkill(c, id);
}

function changeJob(c: Character, newJob: MainJob, statLossPct: number): void {
  const mult = 1 - statLossPct / 100;
  for (const k of BASE_STAT_KEYS) c.stats[k] = clampStat(c.stats[k] * mult);
  c.mainJob = newJob;
  c.subJob = null;
  const def = JOBS[newJob];
  const allowed = new Set<string>([...def.skillPool, ...def.starterSkills]);
  c.skills = c.skills.filter((id) => allowed.has(id));
  if (def.starterSkills.length > 0) {
    const starter = def.starterSkills[hashSeed(c.id) % def.starterSkills.length];
    learnSkill(c, starter);
  }
}

/** 효과 1개를 팀에 적용한다. bonus_points 는 팀 정보만으로 처리할 수 없으므로 여기서는 무시 (applyChoice 가 처리). */
export function applyEffect(team: Team, e: ChoiceEffect): void {
  switch (e.kind) {
    case 'stat': {
      const c = findChar(team, e.charId);
      if (c) c.stats[e.stat] = clampStat(c.stats[e.stat] + e.delta);
      return;
    }
    case 'stat_category': {
      const c = findChar(team, e.charId);
      if (!c) return;
      for (const k of BASE_STAT_KEYS) {
        if (STAT_CATEGORY[k] === e.category) c.stats[k] = clampStat(c.stats[k] + e.delta);
      }
      return;
    }
    case 'adaptation': {
      const targets = e.charId === 'all' ? team.members : [findChar(team, e.charId)];
      for (const c of targets) {
        if (c) c.adaptation[e.map] = clampStat(c.adaptation[e.map] + e.delta);
      }
      return;
    }
    case 'learn_skill': {
      const c = findChar(team, e.charId);
      if (c) learnSkill(c, e.skillId);
      return;
    }
    case 'forget_skill': {
      const c = findChar(team, e.charId);
      if (!c) return;
      const i = c.skills.indexOf(e.skillId);
      if (i >= 0) c.skills.splice(i, 1);
      return;
    }
    case 'set_subjob': {
      const c = findChar(team, e.charId);
      if (c) applySubJob(c, e.subJob);
      return;
    }
    case 'change_job': {
      const c = findChar(team, e.charId);
      if (c) changeJob(c, e.mainJob, e.statLossPct);
      return;
    }
    case 'add_synergy': {
      for (const s of team.synergies) if (s.id === e.synergy.id) return;
      team.synergies.push(e.synergy);
      return;
    }
    case 'bonus_points':
      return;
  }
}

/** 표시용: 선택지가 다루는 맵 (적응 훈련일 때) */
export function choiceMap(ch: Choice): MapType | null {
  for (const e of ch.effects) if (e.kind === 'adaptation') return e.map;
  return null;
}

/** 표시용: 희귀도 한국어 이름 */
export function rarityName(r: ChoiceRarity): string {
  return CHOICE_RARITY_NAME_KO[r];
}
