/**
 * 로그라이크 선택지 생성·적용 (GDD §7.3).
 * - generateChoices: 사이클/팀 상태에 맞춰 정확히 CHOICES_PER_CYCLE 개의 서로 다른 선택지
 * - applyChoice / applyEffect: 선택지 효과 적용 (스탯 클램프, 스킬 슬롯 제한 준수)
 */
import { Rng, hashSeed } from '../rng';
import type {
  BaseStatKey, Character, Choice, ChoiceEffect, ChoiceKind, MainJob, MapType, RunState, StatCategory,
  SubJobDef, Team,
} from '../types';
import {
  BASE_STAT_KEYS, CHOICES_PER_CYCLE, CHOICE_KIND_NAME_KO, JOB_NAME_KO, MAIN_JOBS, MAP_NAME_KO, MAP_TYPES,
  MAX_ACTIVE_SKILLS, MAX_PASSIVE_SKILLS, STAT_CATEGORY, STAT_CATEGORY_NAME_KO, STAT_NAME_KO, TOTAL_CYCLES,
} from '../types';
import { JOBS, getSubJob } from '../data/jobs';
import { getSkill, skillPoolFor } from '../data/skills';
import { generateSynergyCandidates } from '../data/synergies';
import { clampStat } from '../stats';

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

/** 양의 성장량을 직업 성장 계수로 보정 (GDD 4.3). 최소 1. */
function scaled(base: number, c: Character, k: BaseStatKey): number {
  return Math.max(1, Math.round(base * growthOf(c, k)));
}

/** 직업이 잘 성장하는 스탯을 우선 선택 */
function pickStat(rng: Rng, c: Character): BaseStatKey {
  const weights = BASE_STAT_KEYS.map((k) => {
    const g = growthOf(c, k);
    return g * g;
  });
  return rng.weighted(BASE_STAT_KEYS, weights);
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

// ───────────────────────── 선택지 가중치 ─────────────────────────

const KINDS: readonly ChoiceKind[] = [
  'big_single', 'small_multi', 'tradeoff', 'gamble', 'skill', 'job_change', 'adaptation', 'synergy', 'sacrifice',
];

function kindWeights(cycle: number): Record<ChoiceKind, number> {
  if (cycle <= 3) {
    return {
      big_single: 18, small_multi: 22, tradeoff: 8, gamble: 8, skill: 18, subjob: 0,
      job_change: cycle >= 3 ? 8 : 0, adaptation: 14, synergy: 6, sacrifice: 4,
    };
  }
  if (cycle <= 6) {
    return {
      big_single: 18, small_multi: 14, tradeoff: 12, gamble: 12, skill: 14, subjob: 0,
      job_change: 8, adaptation: 10, synergy: 10, sacrifice: 6,
    };
  }
  return {
    big_single: 22, small_multi: 8, tradeoff: 14, gamble: 16, skill: 10, subjob: 0,
    job_change: 8, adaptation: 6, synergy: 16, sacrifice: 8,
  };
}

// ───────────────────────── 개별 선택지 생성 ─────────────────────────

interface Ctx {
  state: RunState;
  team: Team;
  rng: Rng;
  cycle: number;
  seq: number;
}

function makeId(ctx: Ctx, kind: ChoiceKind): string {
  return `ch${ctx.cycle}_${ctx.state.choiceIndex}_${ctx.seq++}_${kind}`;
}

function buildBigSingle(ctx: Ctx): Choice {
  const { rng, team } = ctx;
  const c = rng.pick(team.members);
  if (rng.chance(0.7)) {
    const stat = pickStat(rng, c);
    const delta = scaled(rng.int(12, 18), c, stat);
    return {
      id: makeId(ctx, 'big_single'), kind: 'big_single',
      title: `${CHOICE_KIND_NAME_KO.big_single}: ${c.name}의 ${statName(stat)}`,
      desc: `${c.name}의 ${statName(stat)} ${fmt(delta)}.`,
      charIds: [c.id],
      effects: [{ kind: 'stat', charId: c.id, stat, delta }],
    };
  }
  const category = rng.pick(CATEGORIES);
  const delta = rng.int(6, 8);
  return {
    id: makeId(ctx, 'big_single'), kind: 'big_single',
    title: `${CHOICE_KIND_NAME_KO.big_single}: ${c.name}의 ${STAT_CATEGORY_NAME_KO[category]}`,
    desc: `${c.name}의 ${STAT_CATEGORY_NAME_KO[category]} 카테고리 스탯 5개 각각 ${fmt(delta)}.`,
    charIds: [c.id],
    effects: [{ kind: 'stat_category', charId: c.id, category, delta }],
  };
}

function buildSmallMulti(ctx: Ctx): Choice {
  const { rng, team } = ctx;
  const n = Math.min(team.members.length, rng.int(2, 3));
  const chars = rng.sample(team.members, n);
  const stat = pickStat(rng, chars[0]);
  const effects: ChoiceEffect[] = [];
  const parts: string[] = [];
  for (const c of chars) {
    const delta = scaled(rng.int(5, 7), c, stat);
    effects.push({ kind: 'stat', charId: c.id, stat, delta });
    parts.push(`${c.name} ${fmt(delta)}`);
  }
  return {
    id: makeId(ctx, 'small_multi'), kind: 'small_multi',
    title: `${CHOICE_KIND_NAME_KO.small_multi}: ${statName(stat)}`,
    desc: `${statName(stat)} 훈련 — ${parts.join(', ')}.`,
    charIds: chars.map((c) => c.id),
    effects,
  };
}

function buildTradeoff(ctx: Ctx): Choice | null {
  const { rng, team } = ctx;
  if (team.members.length < 4) return null;
  const picked = rng.sample(team.members, 4);
  const gainers = picked.slice(0, 3);
  const loser = picked[3];
  const effects: ChoiceEffect[] = [];
  const parts: string[] = [];
  for (const c of gainers) {
    const stat = pickStat(rng, c);
    const delta = scaled(8, c, stat);
    effects.push({ kind: 'stat', charId: c.id, stat, delta });
    parts.push(`${c.name} ${statName(stat)} ${fmt(delta)}`);
  }
  const lossStat = rng.pick(BASE_STAT_KEYS);
  const loss = -6;
  effects.push({ kind: 'stat', charId: loser.id, stat: lossStat, delta: loss });
  return {
    id: makeId(ctx, 'tradeoff'), kind: 'tradeoff',
    title: `${CHOICE_KIND_NAME_KO.tradeoff}: ${loser.name}${iGa(loser.name)} 양보`,
    desc: `${parts.join(', ')}. 대신 ${loser.name}의 ${statName(lossStat)} ${fmt(loss)}.`,
    charIds: picked.map((c) => c.id),
    effects,
  };
}

function buildGamble(ctx: Ctx): Choice {
  const { rng, team } = ctx;
  const c = rng.pick(team.members);
  const stat = pickStat(rng, c);
  const pct = rng.int(55, 75);
  const gain = scaled(rng.int(18, 25), c, stat);
  const loss = -rng.int(5, 8);
  return {
    id: makeId(ctx, 'gamble'), kind: 'gamble',
    title: `${CHOICE_KIND_NAME_KO.gamble}: ${c.name}의 ${statName(stat)} (${pct}%)`,
    desc: `${pct}% 확률로 ${c.name}의 ${statName(stat)} ${fmt(gain)}. 실패 시 ${statName(stat)} ${fmt(loss)}.`,
    charIds: [c.id],
    effects: [{ kind: 'stat', charId: c.id, stat, delta: gain }],
    successChance: pct / 100,
    failEffects: [{ kind: 'stat', charId: c.id, stat, delta: loss }],
  };
}

function buildSkill(ctx: Ctx): Choice | null {
  const { rng, team } = ctx;
  const candidates: { c: Character; pool: string[] }[] = [];
  for (const c of team.members) {
    const pool = skillPoolFor(c);
    if (pool.length > 0) candidates.push({ c, pool });
  }
  if (candidates.length === 0) return null;
  const { c, pool } = rng.pick(candidates);
  const skillId = rng.pick(pool);
  const def = getSkill(skillId);
  const max = def.type === 'active' ? MAX_ACTIVE_SKILLS : MAX_PASSIVE_SKILLS;
  let note = '';
  if (countType(c, def.type) >= max) {
    const old = oldestOfType(c, def.type);
    if (old) note = ` (${skillTypeKo(def.type)} 슬롯이 가득 차 [${getSkill(old).name}]${eulReul(getSkill(old).name)} 잊습니다)`;
  }
  return {
    id: makeId(ctx, 'skill'), kind: 'skill',
    title: `${CHOICE_KIND_NAME_KO.skill}: [${def.name}]`,
    desc: `${c.name}${iGa(c.name)} ${skillTypeKo(def.type)} 스킬 [${def.name}]${eulReul(def.name)} 습득합니다${note}. ${def.desc}`,
    charIds: [c.id],
    effects: [{ kind: 'learn_skill', charId: c.id, skillId }],
  };
}

function buildJobChange(ctx: Ctx): Choice | null {
  const { rng, team, cycle } = ctx;
  if (cycle < 3) return null;
  // 육성의 마지막 선택(10사이클 3번째)에서는 재분화 기회가 없으므로 직업 변경을 내지 않는다
  if (cycle >= TOTAL_CYCLES && ctx.state.choiceIndex >= CHOICES_PER_CYCLE - 1) return null;
  const c = rng.pick(team.members);
  const others = MAIN_JOBS.filter((j) => j !== c.mainJob);
  const newJob = rng.pick(others);
  const statLossPct = 10;
  const starter = JOBS[newJob].starterSkills;
  const starterName = starter.length > 0 ? getSkill(starter[hashSeed(c.id) % starter.length]).name : null;
  return {
    id: makeId(ctx, 'job_change'), kind: 'job_change',
    title: `${CHOICE_KIND_NAME_KO.job_change}: ${c.name} → ${JOB_NAME_KO[newJob]}`,
    desc:
      `${c.name}${eulReul(c.name)} ${JOB_NAME_KO[c.mainJob]}에서 ${JOB_NAME_KO[newJob]}${euro(JOB_NAME_KO[newJob])} 변경합니다. ` +
      `모든 스탯 -${statLossPct}%, 세부 직업 초기화(재분화 기회 부여), 새 직업에 맞지 않는 스킬 상실` +
      (starterName ? `, 시작 스킬 [${starterName}] 습득.` : '.'),
    charIds: [c.id],
    effects: [{ kind: 'change_job', charId: c.id, mainJob: newJob, statLossPct }],
  };
}

function buildAdaptation(ctx: Ctx): Choice {
  const { rng, team } = ctx;
  const map = rng.pick(MAP_TYPES);
  if (rng.chance(0.5)) {
    const delta = 8;
    return {
      id: makeId(ctx, 'adaptation'), kind: 'adaptation',
      title: `${CHOICE_KIND_NAME_KO.adaptation}: 팀 전체 ${MAP_NAME_KO[map]}`,
      desc: `팀 전체의 ${MAP_NAME_KO[map]} 적응도 ${fmt(delta)}.`,
      charIds: team.members.map((c) => c.id),
      effects: [{ kind: 'adaptation', charId: 'all', map, delta }],
    };
  }
  const c = rng.pick(team.members);
  const delta = 15;
  return {
    id: makeId(ctx, 'adaptation'), kind: 'adaptation',
    title: `${CHOICE_KIND_NAME_KO.adaptation}: ${c.name}의 ${MAP_NAME_KO[map]}`,
    desc: `${c.name}의 ${MAP_NAME_KO[map]} 적응도 ${fmt(delta)} (현재 ${c.adaptation[map]}).`,
    charIds: [c.id],
    effects: [{ kind: 'adaptation', charId: c.id, map, delta }],
  };
}

function buildSynergy(ctx: Ctx): Choice | null {
  const { rng, team } = ctx;
  const cands = generateSynergyCandidates(team, rng, 1);
  if (cands.length === 0) return null;
  const syn = cands[0];
  const charIds: string[] = [];
  if (syn.condition.kind === 'adjacency') charIds.push(syn.condition.a, syn.condition.b);
  else if (syn.condition.kind === 'job_count') {
    for (const c of team.members) if (c.mainJob === syn.condition.job) charIds.push(c.id);
  } else {
    for (const c of team.members) charIds.push(c.id);
  }
  return {
    id: makeId(ctx, 'synergy'), kind: 'synergy',
    title: `${CHOICE_KIND_NAME_KO.synergy}: ${syn.name}`,
    desc: `시너지 [${syn.name}] 획득. ${syn.desc}`,
    charIds,
    effects: [{ kind: 'add_synergy', synergy: syn }],
  };
}

function buildSacrifice(ctx: Ctx): Choice {
  const { rng, team } = ctx;
  const c = rng.pick(team.members);
  const effects: ChoiceEffect[] = [];
  let costText: string;
  const charIds = [c.id];

  if (c.skills.length > 0 && rng.chance(0.5)) {
    const skillId = rng.pick(c.skills);
    const sname = getSkill(skillId).name;
    effects.push({ kind: 'forget_skill', charId: c.id, skillId });
    costText = `${c.name}${iGa(c.name)} 스킬 [${sname}]${eulReul(sname)} 포기`;
  } else {
    const category = rng.pick(CATEGORIES);
    const delta = -10;
    effects.push({ kind: 'stat_category', charId: c.id, category, delta });
    costText = `${c.name}의 ${STAT_CATEGORY_NAME_KO[category]} 카테고리 스탯 5개 각각 ${fmt(delta)}`;
  }

  let rewardText: string;
  const others = team.members.filter((m) => m.id !== c.id);
  if (others.length > 0 && rng.chance(0.6)) {
    const stat = rng.pick(BASE_STAT_KEYS);
    const delta = 5;
    for (const o of others) {
      effects.push({ kind: 'stat', charId: o.id, stat, delta });
      charIds.push(o.id);
    }
    rewardText = `나머지 팀원 ${others.length}명의 ${statName(stat)} ${fmt(delta)}`;
  } else {
    const delta = 60;
    effects.push({ kind: 'bonus_points', delta });
    rewardText = `보너스 포인트 ${fmt(delta)}`;
  }

  return {
    id: makeId(ctx, 'sacrifice'), kind: 'sacrifice',
    title: `${CHOICE_KIND_NAME_KO.sacrifice}: ${c.name}의 결단`,
    desc: `${costText}하는 대신 ${rewardText}.`,
    charIds,
    effects,
  };
}

function buildSubJob(ctx: Ctx, c: Character, sub: SubJobDef): Choice {
  const bonusParts: string[] = [];
  for (const k of BASE_STAT_KEYS) {
    const v = sub.statBonus[k];
    if (v !== undefined && v !== 0) bonusParts.push(`${statName(k)} ${fmt(v)}`);
  }
  const skillNames = sub.grantedSkills.map((id) => `[${getSkill(id).name}]`);
  const desc =
    `${c.name}${eulReul(c.name)} ${JOB_NAME_KO[c.mainJob]} → ${sub.name}${euro(sub.name)} 분화합니다. ${sub.desc}` +
    (bonusParts.length ? ` 스탯 보정: ${bonusParts.join(', ')}.` : '') +
    (skillNames.length ? ` 습득 스킬: ${skillNames.join(', ')}.` : '');
  return {
    id: makeId(ctx, 'subjob'), kind: 'subjob',
    title: `${CHOICE_KIND_NAME_KO.subjob}: ${sub.name}`,
    desc,
    charIds: [c.id],
    effects: [{ kind: 'set_subjob', charId: c.id, subJob: sub.id }],
  };
}

function build(ctx: Ctx, kind: ChoiceKind): Choice | null {
  switch (kind) {
    case 'big_single': return buildBigSingle(ctx);
    case 'small_multi': return buildSmallMulti(ctx);
    case 'tradeoff': return buildTradeoff(ctx);
    case 'gamble': return buildGamble(ctx);
    case 'skill': return buildSkill(ctx);
    case 'job_change': return buildJobChange(ctx);
    case 'adaptation': return buildAdaptation(ctx);
    case 'synergy': return buildSynergy(ctx);
    case 'sacrifice': return buildSacrifice(ctx);
    case 'subjob': return null;
  }
}

function signature(ch: Choice): string {
  return `${ch.kind}|${JSON.stringify(ch.effects)}|${JSON.stringify(ch.failEffects ?? null)}`;
}

/** 이번 생성에서 분화 선택지를 받아야 할 캐릭터 (예정 사이클이 현재 사이클 이하이고 아직 미분화) */
function scheduledSubJobChar(state: RunState, team: Team): Character | null {
  for (const c of team.members) {
    const due = state.subJobChoiceCycle[c.id];
    if (due !== undefined && due <= state.cycle && c.subJob === null && JOBS[c.mainJob].subJobs.length > 0) return c;
  }
  return null;
}

// ───────────────────────── 공개 API ─────────────────────────

/**
 * 정확히 CHOICES_PER_CYCLE 개의 서로 다른 선택지를 만든다.
 * 분화 예정 캐릭터가 있으면 그 캐릭터의 세부 직업 3종이 각각 하나의 선택지가 된다.
 */
export function generateChoices(state: RunState, rng: Rng): Choice[] {
  const team = state.team;
  if (!team) throw new Error('팀이 없는 상태에서는 선택지를 만들 수 없습니다.');
  const ctx: Ctx = { state, team, rng, cycle: state.cycle, seq: 0 };

  const due = scheduledSubJobChar(state, team);
  if (due) {
    const subs = JOBS[due.mainJob].subJobs;
    const out: Choice[] = [];
    for (let i = 0; i < subs.length && out.length < CHOICES_PER_CYCLE; i++) out.push(buildSubJob(ctx, due, subs[i]));
    // 세부 직업이 3개 미만인 예외 상황: 나머지는 일반 선택지로 채운다
    fillGeneral(ctx, out);
    return out;
  }

  const out: Choice[] = [];
  fillGeneral(ctx, out);
  return out;
}

function fillGeneral(ctx: Ctx, out: Choice[]): void {
  const weights = kindWeights(ctx.cycle);
  const usedKinds = new Set<ChoiceKind>();
  const sigs = new Set<string>(out.map(signature));
  let guard = 0;
  while (out.length < CHOICES_PER_CYCLE && guard++ < 60) {
    const avail = KINDS.filter((k) => weights[k] > 0 && !usedKinds.has(k));
    if (avail.length === 0) break;
    const kind = ctx.rng.weighted(avail, avail.map((k) => weights[k]));
    usedKinds.add(kind);
    const ch = build(ctx, kind);
    if (!ch) continue;
    const sig = signature(ch);
    if (sigs.has(sig)) continue;
    sigs.add(sig);
    out.push(ch);
  }
  // 예비: 종류가 모자라면 집중 훈련으로 채우되 내용이 겹치지 않게 한다
  let fallback = 0;
  while (out.length < CHOICES_PER_CYCLE && fallback++ < 100) {
    const ch = buildBigSingle(ctx);
    const sig = signature(ch);
    if (sigs.has(sig)) continue;
    sigs.add(sig);
    out.push(ch);
  }
}

/**
 * 선택지 적용. 도박형은 rng.chance(successChance) 로 성공 여부 결정.
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
    for (const id of choice.charIds) delete state.subJobChoiceCycle[id];
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

function setSubJob(c: Character, subJobId: string): void {
  const sub = getSubJob(subJobId);
  c.subJob = sub.id;
  for (const k of BASE_STAT_KEYS) {
    const v = sub.statBonus[k];
    if (v !== undefined && v !== 0) c.stats[k] = clampStat(c.stats[k] + v);
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

/** 효과 1개를 팀에 적용한다. bonus_points 는 팀 정보만으로는 처리할 수 없으므로 여기서는 무시 (applyChoice 가 처리). */
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
      if (c) setSubJob(c, e.subJob);
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
