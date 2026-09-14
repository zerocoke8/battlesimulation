/**
 * 캐릭터 풀 / 상대팀 랜덤 생성 (GDD §7.1, §7.2 1단계 상대).
 * 모든 난수는 Rng 만 사용한다. 순회 순서는 BASE_STAT_KEYS / MAP_TYPES / MAIN_JOBS 고정.
 */
import { Rng } from '../rng';
import type { Adaptation, BaseStatKey, Character, MainJob, MapType, StatBlock, Team } from '../types';
import { BASE_STAT_KEYS, MAIN_JOBS, MAP_TYPES, MAX_ACTIVE_SKILLS, MAX_PASSIVE_SKILLS } from '../types';
import { JOBS } from '../data/jobs';
import { getSkill, skillPoolFor } from '../data/skills';
import { autoSynergies } from '../data/synergies';
import { clampStat, statTotal } from '../stats';
import { applyEffect } from '../growth/choices';

// ───────────────────────── 이름 ─────────────────────────

const NAME_FIRST = [
  '아', '라', '세', '리', '카', '루', '엘', '미', '유', '레', '시', '나', '테', '로', '한', '제', '이', '샤',
  '키', '마', '노', '바', '헤', '조', '에', '오', '델', '솔', '윤', '현', '휘', '율', '다', '가', '벨', '페',
  '사', '도', '지', '하', '아르', '이스', '에르',
];
const NAME_MID = [
  '르', '리', '나', '라', '미', '시', '베', '델', '로', '카', '사', '레', '아', '이', '오', '우', '에', '스',
  '티', '니', '렌', '피', '드', '타', '슈', '루',
];
const NAME_LAST = [
  '온', '린', '엘', '라', '스', '드', '아', '나', '르', '릭', '안', '델', '트', '이', '오', '테', '벨', '리',
  '크', '문', '셀', '카', '야', '네', '언', '렌', '엔', '스', '나', '움', '디', '노',
];

/** 한국어 표기가 자연스러운 판타지풍 이름 (2~4음절) */
export function randomName(rng: Rng): string {
  const syllables = rng.weighted([2, 3, 4] as const, [35, 50, 15]);
  let s = rng.pick(NAME_FIRST);
  for (let i = 1; i < syllables - 1; i++) s += rng.pick(NAME_MID);
  s += rng.pick(NAME_LAST);
  return s;
}

// ───────────────────────── 캐릭터 ─────────────────────────

/** 기본 스탯 합계와 직업 프로필 기대치의 차이로 등급(1~5)을 정한다 */
export function computeRarity(c: Character): number {
  const profile = JOBS[c.mainJob].statProfile;
  let expected = 0;
  for (const k of BASE_STAT_KEYS) expected += profile[k] ?? 40;
  const diff = statTotal(c) - expected;
  if (diff < -30) return 1;
  if (diff < -10) return 2;
  if (diff < 10) return 3;
  if (diff < 30) return 4;
  return 5;
}

/**
 * powerLevel 1 일 때 캐릭터 1명에게 더해지는 총 스탯 성장량. 성장 계수 비율로 20개 스탯에 분배된다
 * (평균 +7.5/스탯, 성장 계수 1.5 스탯은 약 +11). 10사이클 육성을 잘 마친 플레이어 팀(+130~160/캐릭터)과 맞춘 값.
 * 밸런싱 시 이 값만 조정하면 상대팀 강도가 바뀐다.
 */
export const GROWTH_BUDGET_AT_MAX = 150;

/**
 * 캐릭터 1명 생성.
 * - 기본 스탯: 직업 statProfile(없으면 40) ± 10, powerLevel(0~1) 에 따라 GROWTH_BUDGET_AT_MAX 를 성장 계수 가중으로 분배 가산
 * - 성장 편차 0.85~1.15, 맵 적응도 20~80, 시작 스킬 1개 (starterSkills 중 랜덤)
 */
export function generateCharacter(rng: Rng, job: MainJob, powerLevel: number, idPrefix?: string): Character {
  const def = JOBS[job];
  const pl = Math.max(0, Math.min(1, powerLevel));

  const growthVariance: Partial<Record<BaseStatKey, number>> = {};
  for (const k of BASE_STAT_KEYS) {
    growthVariance[k] = Math.round(rng.float(0.85, 1.15) * 100) / 100;
  }

  // 성장 예산(GROWTH_BUDGET_AT_MAX × powerLevel)을 성장 계수 비율로 스탯에 분배
  let growthSum = 0;
  for (const k of BASE_STAT_KEYS) growthSum += (def.growth[k] ?? 1) * (growthVariance[k] ?? 1);
  const stats = {} as StatBlock;
  for (const k of BASE_STAT_KEYS) {
    const base = def.statProfile[k] ?? 40;
    const variance = rng.int(-10, 10);
    const g = (def.growth[k] ?? 1) * (growthVariance[k] ?? 1);
    const boost = growthSum > 0 ? (GROWTH_BUDGET_AT_MAX * pl * g) / growthSum : 0;
    stats[k] = clampStat(base + variance + boost);
  }

  const adaptation = {} as Adaptation;
  for (const m of MAP_TYPES) adaptation[m] = rng.int(20, 80);

  const name = randomName(rng);
  const starter = def.starterSkills.length > 0 ? rng.pick(def.starterSkills) : null;
  const id = `${idPrefix ?? 'c'}_${rng.fork().toString(36)}`;

  const c: Character = {
    id,
    name,
    mainJob: job,
    subJob: null,
    stats,
    adaptation,
    growthVariance,
    skills: starter ? [starter] : [],
    rarity: 3,
  };
  c.rarity = computeRarity(c);
  return c;
}

/**
 * 가챠 풀 생성. size ≥ 18 이면 9직업 각 2명 이상 보장, 나머지는 랜덤 직업.
 * id 형식: p<seedfrag>_<n>_<hash>
 */
export function generatePool(rng: Rng, size: number): Character[] {
  const frag = rng.fork().toString(36).slice(0, 4);
  const jobs: MainJob[] = [];
  if (size >= 18) {
    for (const j of MAIN_JOBS) jobs.push(j, j);
  }
  while (jobs.length < size) jobs.push(rng.pick(MAIN_JOBS));
  const order = rng.shuffle(jobs.slice(0, size));
  const out: Character[] = [];
  for (let i = 0; i < order.length; i++) {
    out.push(generateCharacter(rng, order[i], 0, `p${frag}_${i}`));
  }
  return out;
}

// ───────────────────────── 상대팀 ─────────────────────────

const TEAM_PREFIX = [
  '북부', '남부', '동방', '서역', '흑철', '백은', '붉은', '푸른', '황금', '폭풍', '서리', '잿빛', '달빛',
  '불꽃', '천둥', '심연', '고원', '해안', '안개', '유리', '강철', '별빛',
];
const TEAM_SUFFIX = [
  '용병단', '기사단', '수호대', '결사대', '원정대', '습격대', '방랑자들', '늑대들', '사냥꾼들', '맹약',
  '연맹', '의용군', '수도회', '검은 손', '감시자들',
];

/** 한국어 팀 이름 (예: '북부 용병단') */
export function randomTeamName(rng: Rng): string {
  return `${rng.pick(TEAM_PREFIX)} ${rng.pick(TEAM_SUFFIX)}`;
}

function countJob(jobs: MainJob[], j: MainJob): number {
  let n = 0;
  for (const x of jobs) if (x === j) n++;
  return n;
}

function skillSlotsFree(c: Character, type: 'active' | 'passive'): boolean {
  let n = 0;
  for (const id of c.skills) if (getSkill(id).type === type) n++;
  return n < (type === 'active' ? MAX_ACTIVE_SKILLS : MAX_PASSIVE_SKILLS);
}

/** 빈 슬롯이 있는 타입의 스킬만 풀에서 골라 습득 (대체 없음) */
function learnRandomFromPool(rng: Rng, c: Character): boolean {
  const pool = skillPoolFor(c).filter((id) => skillSlotsFree(c, getSkill(id).type));
  if (pool.length === 0) return false;
  applyEffect({ id: '', name: '', members: [c], synergies: [] }, { kind: 'learn_skill', charId: c.id, skillId: rng.pick(pool) });
  return true;
}

/**
 * 사이클 수에 맞게 스케일링된 상대팀.
 * - powerLevel = (cycle-1)/9
 * - cycle ≥ 3: 탱커 또는 힐러 1명 이상. 같은 직업 최대 2명.
 * - cycle ≥ 6: 전원 세부 직업 분화 (statBonus + grantedSkills)
 * - floor(cycle/4) 개의 추가 스킬, 맵 적응도 소폭 훈련, 자동 시너지
 */
export function generateOpponentTeam(rng: Rng, cycle: number, map: MapType, idPrefix: string): Team {
  const powerLevel = Math.max(0, Math.min(1, (cycle - 1) / 9));

  const jobs: MainJob[] = [];
  if (cycle >= 3) jobs.push(rng.pick(['tank', 'healer'] as const));
  let guard = 0;
  while (jobs.length < 5 && guard++ < 200) {
    const j = rng.pick(MAIN_JOBS);
    if (countJob(jobs, j) >= 2) continue;
    jobs.push(j);
  }
  while (jobs.length < 5) jobs.push(MAIN_JOBS[jobs.length % MAIN_JOBS.length]);
  const order = rng.shuffle(jobs);

  const members: Character[] = [];
  for (let i = 0; i < 5; i++) {
    members.push(generateCharacter(rng, order[i], powerLevel, `${idPrefix}_${i}`));
  }

  const team: Team = { id: `${idPrefix}_team`, name: randomTeamName(rng), members, synergies: [] };

  // 맵 적응도 훈련: 전 맵 + 현재 맵 추가
  const adaptAll = Math.round(powerLevel * 15);
  const adaptMap = Math.round(powerLevel * 10);
  for (const c of members) {
    for (const m of MAP_TYPES) {
      c.adaptation[m] = clampStat(c.adaptation[m] + adaptAll + (m === map ? adaptMap : 0));
    }
  }

  // 세부 직업 분화 (cycle ≥ 6)
  if (cycle >= 6) {
    for (const c of members) {
      const subs = JOBS[c.mainJob].subJobs;
      if (subs.length === 0) continue;
      const sub = rng.pick(subs);
      applyEffect(team, { kind: 'set_subjob', charId: c.id, subJob: sub.id });
    }
  }

  // 추가 스킬 구매 (cycle/4: 10사이클 상대는 +2개. 폭딜 성장을 완만하게 해 후반 전투가 초반보다 길어지도록)
  const extra = Math.floor(cycle / 4);
  for (const c of members) {
    for (let k = 0; k < extra; k++) {
      if (!learnRandomFromPool(rng, c)) break;
    }
  }

  // 성장으로 인한 등급 갱신 (표시용)
  for (const c of members) c.rarity = computeRarity(c);

  team.synergies = autoSynergies(team);
  return team;
}
