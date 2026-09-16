/**
 * 캐릭터 풀 / 상대팀 랜덤 생성 (GDD §7.1, §7.2 1단계 상대).
 * 모든 난수는 Rng 만 사용한다. 순회 순서는 BASE_STAT_KEYS / MAP_TYPES / MAIN_JOBS 고정.
 */
import { Rng } from '../rng';
import type { Adaptation, BaseStatKey, Character, MainJob, MapType, StatBlock, Team } from '../types';
import { BASE_STAT_KEYS, MAIN_JOBS, MAP_TYPES, MAX_ACTIVE_SKILLS, MAX_PASSIVE_SKILLS, STAT_MAX, STAT_MIN } from '../types';
import { JOBS } from '../data/jobs';
import { getSkill, skillPoolFor } from '../data/skills';
import { autoSynergies } from '../data/synergies';
import { clampStat, powerRating, statTotal } from '../stats';
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
 * (평균 +7.5/스탯, 성장 계수 1.5 스탯은 약 +11). 10일 육성을 잘 마친 플레이어 팀(+130~160/캐릭터)과 맞춘 값.
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
 * 일차별 5:5 상대팀 목표 전투력 (teamPower 척도 = 스탯 합 + 스킬 수 × 30). 인덱스 0 이 1일차.
 *
 * 보정 기준: `npm run headless -- --growth --policy greedy` 로 측정한 표준 성장 플레이어의 일차별 전투력
 * (1일차 4693 → 10일차 6110) 대비 1~5일차는 약 1.02배, 6~10일차는 약 0.965배.
 * 6일차에 상대가 전원 분화하는데, 분화는 전투력 '점수'보다 실전 값어치가 커서 그 구간부터 점수 목표를
 * 한 단계 낮춰야 승률이 평평해진다 (그래서 5일차 목표가 6일차보다 높다).
 * 실측 승률(시드 1~32, 탐욕 정책, 320판): 일차별 44~56%, 전체 50.6%.
 * 이 표만 고치면 상대 강도 곡선 전체가 바뀐다.
 */
export const OPPONENT_POWER_BY_DAY: readonly number[] = [
  4702, // 1일차 (첫날은 양쪽 다 갓 만든 팀이라 동급)
  4963, // 2일차
  5120, // 3일차
  5305, // 4일차
  5525, // 5일차
  5365, // 6일차 — 여기서 상대가 전원 세부 직업으로 분화한다. 분화는 점수보다 실전 값어치가 커서
  5490, // 7일차    같은 승률을 유지하려면 점수 목표를 오히려 한 단계 낮춰야 한다 (5일차 > 6일차)
  5633, // 8일차
  5767, // 9일차
  5900, // 10일차
];

/** 일차별 상대팀 목표 전투력. 표 밖의 일차는 양 끝 기울기로 선형 외삽한다 */
export function opponentPowerTarget(day: number): number {
  const t = OPPONENT_POWER_BY_DAY;
  const last = t.length - 1;
  const d = day !== day ? 1 : day;
  if (d <= 1) return t[0] + (t[1] - t[0]) * (d - 1);
  // d === t.length 는 마지막 일차 그 자체다 (외삽 아님)
  if (d >= t.length) return t[last] + (t[last] - t[last - 1]) * (d - t.length);
  const i = Math.floor(d) - 1;
  const frac = d - Math.floor(d);
  return frac === 0 ? t[i] : t[i] + (t[i + 1] - t[i]) * frac;
}

/**
 * 팀 전투력이 목표치가 되도록 스탯을 가감한다.
 * 분배는 성장 계수 비율(generateCharacter 와 같은 규칙)을 따르고, 스탯 상한(1~100)에 걸려 남은 몫은
 * 여유가 있는 스탯에 다시 돌린다. 순회는 members / BASE_STAT_KEYS 고정 순서.
 */
function fitTeamPower(team: Team, target: number): void {
  const members = team.members;
  if (members.length === 0) return;
  for (let pass = 0; pass < 4; pass++) {
    const diff = target - teamPower(team);
    if (Math.abs(diff) < members.length) return;
    const per = diff / members.length;
    for (let i = 0; i < members.length; i++) {
      const c = members[i];
      const def = JOBS[c.mainJob];
      let wSum = 0;
      for (const k of BASE_STAT_KEYS) {
        const room = per >= 0 ? STAT_MAX - c.stats[k] : c.stats[k] - STAT_MIN;
        if (room > 0) wSum += (def.growth[k] ?? 1) * (c.growthVariance[k] ?? 1);
      }
      if (wSum <= 0) continue;
      for (const k of BASE_STAT_KEYS) {
        const room = per >= 0 ? STAT_MAX - c.stats[k] : c.stats[k] - STAT_MIN;
        if (room <= 0) continue;
        const w = (def.growth[k] ?? 1) * (c.growthVariance[k] ?? 1);
        c.stats[k] = clampStat(c.stats[k] + (per * w) / wSum);
      }
    }
  }
}

/**
 * 일차에 맞게 스케일링된 5:5 상대팀 (GDD §7.6 1단계).
 * - day ≥ 3: 탱커 또는 힐러 1명 이상. 같은 직업 최대 2명.
 * - day ≥ 6: 전원 세부 직업 분화 (statBonus + grantedSkills)
 * - floor(day/4) 개의 추가 스킬, 맵 적응도 소폭 훈련, 자동 시너지
 * - 마지막에 fitTeamPower 로 팀 전투력을 opponentPowerTarget(day) 에 맞춘다.
 *   (스킬·분화로 얻은 전투력만큼 스탯이 줄어드므로, 강도 곡선은 위 표 하나로 결정된다)
 */
export function generateOpponentTeam(rng: Rng, day: number, map: MapType, idPrefix: string): Team {
  const powerLevel = Math.max(0, Math.min(1, (day - 1) / 9));

  const jobs: MainJob[] = [];
  if (day >= 3) jobs.push(rng.pick(['tank', 'healer'] as const));
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

  // 세부 직업 분화 (day ≥ 6)
  if (day >= 6) {
    for (const c of members) {
      const subs = JOBS[c.mainJob].subJobs;
      if (subs.length === 0) continue;
      const sub = rng.pick(subs);
      applyEffect(team, { kind: 'set_subjob', charId: c.id, subJob: sub.id });
    }
  }

  // 추가 스킬 구매 (day/4: 10일차 상대는 +2개. 폭딜 성장을 완만하게 해 후반 전투가 초반보다 길어지도록)
  const extra = Math.floor(day / 4);
  for (const c of members) {
    for (let k = 0; k < extra; k++) {
      if (!learnRandomFromPool(rng, c)) break;
    }
  }

  // 팀 전투력을 일차 목표치에 맞춘다 (스킬·분화로 오른 만큼 스탯이 줄어든다)
  fitTeamPower(team, opponentPowerTarget(day));

  // 성장으로 인한 등급 갱신 (표시용)
  for (const c of members) c.rarity = computeRarity(c);

  team.synergies = autoSynergies(team);
  return team;
}

// ───────────────────────── 팀 전투력 ─────────────────────────

/**
 * 팀 전투력 요약값 = 멤버 powerRating(스탯 합 + 스킬 수 × 30) 의 단순 합.
 * 진행 HUD 표시와 몬스터 강도 스케일링의 공통 기준이다. 순회 순서는 members 배열 순서로 고정.
 * 몬스터처럼 derivedMult 를 가진 유닛의 실제 강도는 여기에 반영되지 않는다
 * (몬스터 쪽 보정은 data/monsters.ts 의 monsterTeamPower 가 담당한다).
 */
export function teamPower(team: Team): number {
  let sum = 0;
  const members = team.members;
  for (let i = 0; i < members.length; i++) sum += powerRating(members[i]);
  return sum;
}
