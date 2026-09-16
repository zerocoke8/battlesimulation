/**
 * 몬스터 정의와 인카운터 생성 (GDD §7.3, v0.5).
 *
 * 설계 요약
 *  - 난이도 3종(하급/중급/고급) × 6종 = 총 18종. 몬스터 팀 인원은 MONSTER_TEAM_MIN~MONSTER_TEAM_MAX(1~8) 이고
 *    난이도마다 1~2명(단독 보스 / 보스 + 수하 1) · 3~4명 · 6~8명(떼) 편성이 모두 있다 (buildMonsterMap 이 검증).
 *  - 몬스터 유닛은 전부 기존 Character 로 만들어 sim 에 그대로 넣는다. AI 는 mainJob 을 그대로 재사용한다.
 *  - 스탯 상한(100) 때문에 후반 일차에서 강도를 더 못 올리는 문제는 Character.derivedMult 로 해결한다.
 *    buildMonsterTeam 은 먼저 스탯을 스케일하고, 상한에 걸려 모자란 만큼만 derivedMult 로 채운다.
 *  - 강도 기준값(monsterPowerTarget)은
 *      expectedPlayerPower(day) × dayDifficulty(tier, day, 종별 지수 보정) × earlyDayRelief(tier, day)
 *      × TIER_POWER_RATIO[tier] × MonsterDef.powerScale × countPowerFactor(인원).
 *    밸런싱에서 건드릴 값은 이 일곱 가지뿐이다: EXPECTED_TEAM_POWER_BY_DAY, DAY_DIFFICULTY_EXPONENT,
 *    SPECIES_DAY_EXPONENT_ADJUST(종별 일차 지수 보정), EARLY_DAY_RELIEF, TIER_POWER_RATIO,
 *    각 MonsterDef.powerScale, COUNT_POWER_FACTOR.
 *
 * 인원 보정 (countPowerFactor)
 *  - 팀 목표 전투력은 인원과 무관하게 '팀 합' 으로 맞추므로 떼는 한 기당 전투력 = 목표 / 인원 이 된다.
 *  - 6기 이상 떼는 집중 사격으로 한 기씩 빨리 녹아 실효 강도가 합보다 낮다 → ×1.15 (집중 사격 완화).
 *  - 1기 단독 보스는 회복을 받을 수 없고 모든 공격을 혼자 받는다 → ×1.25. 2기는 ×1.12.
 *  - 3~5기는 1.0. v0.5 실측에서는 이 값을 그대로 두고 종별 powerScale 로 인원 편차를 흡수했다
 *    (인원 구간 편차가 전 난이도에서 ±8%p 안에 들어왔다).
 *
 * 보정 현황 (v0.5, 2026-09-16 실측. `npm run headless -- --monster --runs 60`, 시드 1~60 / 3001~3060 두 그룹으로 확인)
 *   난이도 전체 승률: 하급 98.7 / 98.5%, 중급 77.8 / 82.3%, 고급 48.5 / 51.5% (그룹 순). 평균 전투 시간 54 / 63 / 72초.
 *   인원 구간(1~2 / 3~4 / 5~8) 편차: 하급 ≤2.3p, 중급 ≤4.2p, 고급 ≤7.2p (목표 ±8p).
 *   일차별 곡선: 전 종 × 전 일차 완전 탐색(일차당 360판)에서 고급 43~57%, 중급 77~85% 로 평평하다.
 *   (도구의 일차별 셀은 60판이라 표준오차가 ±6.4p 다. 한두 일차가 40~60 밖으로 나가는 것은 표본 잡음이다.)
 *   재보정 (2026-09-16, `--runs 40`, 시드 1 / 4242 / 9001 세 그룹 합산 1,200판/난이도): 고급이 53.4% 로 높고 심연 무리가 58.5% 라
 *   고급 4종의 powerScale 만 올렸다 (골렘 0.278→0.280, 화염 거인 0.492→0.495, 리치 0.901→0.907, 심연 1.097→1.110).
 *   결과: 하급 98.7 / 중급 81.8 / 고급 50.0%. 고급 인원 구간 49.3 / 50.3 / 50.9 (편차 1.5p), 중급 81.3 / 82.6 / 80.8.
 *   일차별 고급 41.7~57.5%, 중급 76.7~84.2%. 평균 전투 시간 54 / 61 / 72초.
 *   주의: 3~4명 구간은 난이도마다 종이 1~2개뿐이라 시드 그룹 하나(40회)에서는 구간 표본이 60판 안팎(표준오차 ±6p)이다.
 *   시드 4242 하나만 보면 고급 구간 편차가 18.9p 로 나왔지만 세 그룹 합산은 6.3p 였다. 구간 편차는 반드시 여러 그룹 합산으로 판정할 것.
 * 보정 현황 (v0.6, 2026-09-16. 스킬 위력 상향(단일 ×1.6 / 광역 ×1.5 / 장판 ×1.4) 뒤 재보정. `--runs 40`, 시드 1 / 4242 / 9001 합산 1,200판/난이도)
 *   상향 직후 실측: 하급 98.7% (중앙값 32초, 하한 40초 미달) / 중급 86.3% / 고급 57.4%. 고급 인원 구간 47.4 / 49.7 / 76.4 (편차 29p):
 *   6~7기 떼(리치 82%, 심연 71%)가 광역에 녹고, 1일차(플레이어 스킬 1개)는 전 난이도에서 8~20p 더 어려웠다(중급 66%, 고급 45%).
 *   조치: ① EXPECTED_TEAM_POWER_BY_DAY 실측 교체 ② EARLY_DAY_RELIEF 0.985→0.925 ③ 하급 비율 0.76→0.82 + 빠른 하급 떼 템플릿에
 *   HP 편중 derivedMult(maxHp 1.3~1.7 / physAtk 0.75~0.85: 전투 시간을 늘리되 치명적이지 않게) ④ 중급 비율 0.830→0.849
 *   ⑤ 고급 지수 0.48→0.37 + 비율 0.980→1.011 (2~4일차가 5~10일차보다 10p 쉬운 혹을 편다) ⑥ 종별 powerScale (아래 메모).
 *   결과: 하급 97.6 / 중급 82.0 / 고급 50.4%. 인원 구간 하급 95.9 / 96.8 / 100.0 (4.1p), 중급 82.1 / 81.9 / 82.2 (0.3p),
 *   고급 49.8 / 49.2 / 51.9 (2.6p). 고급 일차별 43~59% (1일차 49.2). 전투 시간 중앙값 43 / 41 / 50초, 평균 49 / 47 / 54초.
 *   보정 순서: ① EXPECTED_TEAM_POWER_BY_DAY 를 실측치로 교체 → ② 난이도별 TIER_POWER_RATIO / DAY_DIFFICULTY_EXPONENT
 *   → ③ 종별 powerScale(전체 승률) 과 SPECIES_DAY_EXPONENT_ADJUST(일차 기울기) 를 번갈아 수렴.
 *   같은 난이도 안에서 1기 보스와 8기 떼의 승률 편차 목표는 ±8%p (GDD §11).
 * 주의 1: 결정론 시뮬레이션이라 승률이 전투력에 매우 민감하다. 전투력 1% 변화가 승률 4~8%p 를 움직인다
 *         (50% 근처인 고급이 가장 가파르다). TIER_POWER_RATIO / powerScale 은 0.005~0.01 단위로만 움직이고
 *         반드시 두 시드 그룹으로 재측정할 것. 종별 승률의 표준오차는 60회 육성 기준 ±5%p 다.
 * 주의 2: EXPECTED_TEAM_POWER_BY_DAY 는 '몬스터 전투 직전(3스텝)' 평균 전투력 실측치로 갈아끼운다.
 *         `--monster` 출력의 '팀 전투력' 열이 그 값이다.
 * 주의 3: 기준 플레이어는 탐욕 정책(전투력 최대 카드)이다. 무작위 정책은 10일차 전투력이 약 10% 낮다.
 *
 * 결정론: 난수는 인자로 받은 Rng 만 사용하고, 순회는 BASE_STAT_KEYS / DERIVED_STAT_KEYS / MAP_TYPES /
 * units 배열 순서로 고정한다. DOM 참조 없음.
 */
import { Rng } from '../rng';
import type {
  Adaptation,
  BaseStatKey,
  Character,
  ChoiceRarity,
  DerivedStatKey,
  MainJob,
  MapType,
  MonsterDef,
  MonsterEncounter,
  MonsterReward,
  MonsterTier,
  MonsterUnitTemplate,
  StatBlock,
  Team,
} from '../types';
import {
  BASE_STAT_KEYS,
  DERIVED_STAT_KEYS,
  MAP_TYPES,
  MONSTER_TEAM_MAX,
  MONSTER_TEAM_MIN,
  MONSTER_TIER_ORDER,
  TEAM_SIZE,
  TOTAL_DAYS,
} from '../types';
import { JOBS } from './jobs';
import { SKILLS } from './skills';
import { clampStat, powerRating } from '../stats';

// ───────────────────────── 강도 기준 ─────────────────────────

/**
 * 표준 성장 플레이어(TEAM_SIZE = 4명)의 일차별 팀 전투력 (charGen.teamPower 와 같은 척도: 스탯 합 + 스킬 수 × 30).
 * v0.6 헤드리스(`--monster --runs 40`, 시드 1 / 4242 / 9001 세 그룹 평균)가 매 일차 3스텝(몬스터 전투 직전)에서 측정한 평균 실측치.
 * 세 그룹은 서로 ±15 안에서 같고 v0.5 표(시드 1~60)와도 ±25 안에서 같다. 인덱스 0 이 1일차. 육성 정책·선택지 크기가 바뀌면 다시 측정한다.
 */
export const EXPECTED_TEAM_POWER_BY_DAY: readonly number[] = [
  3774, // 1일차
  3921, // 2일차
  4073, // 3일차
  4249, // 4일차
  4421, // 5일차 (분화 시작)
  4580, // 6일차
  4702, // 7일차
  4841, // 8일차
  4967, // 9일차
  5088, // 10일차
];

/** 일차를 1..TOTAL_DAYS 로 클램프 */
function clampDay(day: number): number {
  if (day !== day) return 1; // NaN
  const d = Math.round(day);
  if (d < 1) return 1;
  if (d > TOTAL_DAYS) return TOTAL_DAYS;
  return d;
}

/**
 * 표준 성장 플레이어 기준 일차별 팀 전투력. 몬스터 강도 스케일링의 기준값이다.
 * 범위 밖의 일차는 양 끝 구간의 기울기로 선형 외삽한다.
 */
export function expectedPlayerPower(day: number): number {
  const table = EXPECTED_TEAM_POWER_BY_DAY;
  const last = table.length - 1;
  const d = day !== day ? 1 : day;
  if (d <= 1) {
    const slope = table[1] - table[0];
    return table[0] + slope * (d - 1);
  }
  if (d >= table.length) {
    // d === table.length 는 마지막 일차 그 자체다 (외삽 아님). 그래서 +1 을 더하지 않는다
    const slope = table[last] - table[last - 1];
    return table[last] + slope * (d - table.length);
  }
  const i = Math.floor(d) - 1;
  const frac = d - Math.floor(d);
  if (frac === 0) return table[i];
  return table[i] + (table[i + 1] - table[i]) * frac;
}

/**
 * 난이도별 목표 전투력 비율 (플레이어 팀 전투력 대비).
 * 목표 승률(하급 95~100 / 중급 80 / 고급 50%)에 맞춰 헤드리스 대량 시뮬레이션으로 보정하는 값이다.
 * '전투력 점수가 플레이어의 몇 %인가' 를 뜻한다. v0.5 실측: 하급은 v0.4 의 0.62 에서 0.76 으로 올렸다
 * (4인 팀은 하급을 30초대에 정리해 버려 전투 시간 하한 40초를 밑돌았다. 0.76 에서 평균 54초, 승률 98.5%).
 * 중급·고급은 v0.5 보정에서 0.845 / 0.993 → 0.830 / 0.980 으로 내렸다: 보정에 쓴 시드군(1~60)에서만 목표에 들고
 * 다른 시드군(9001~, 5001~)에서는 중급 -8p / 고급 -7p 였다. 세 시드군(각 난이도 600판) 평균으로 맞춘 값이다.
 * v0.6 (스킬 위력 상향 뒤): 하급 0.76→0.82 (전투 시간 중앙값 32→43초, 승률 98.7→97.6%), 중급 0.830→0.849 (86.3→82.0%),
 * 고급 0.980→1.011 (고급 지수를 0.48→0.37 로 내린 몫을 10일차 기준으로 되돌린 값. 지수와 세트로 움직인다).
 * 전투력 점수는 스탯 합이라 편성 형태를 모른다. 인원 차이는 countPowerFactor 가, 종별 효율 차이는
 * 각 MonsterDef.powerScale 이 흡수한다.
 */
export const TIER_POWER_RATIO: Record<MonsterTier, number> = {
  low: 0.82,
  mid: 0.855,
  high: 1.011,
};

/**
 * 일차 난이도 보정 지수 (난이도별).
 * 전투력 척도는 스탯 합(선형)이지만 실제 강도는 초선형(HP = 체력², 스킬·분화 누적)이라
 * 전투력 비율만 고정하면 일차에 따라 체감 난이도가 흘러간다.
 * 그 격차를 (해당 일차 전투력 / 1일차 전투력)^DAY_DIFFICULTY_EXPONENT[tier] 로 메운다.
 * v0.5 실측: 하급 0.30 / 중급 0.28 / 고급 0.48 에서 난이도 평균 곡선이 평평하다 (v0.4 는 0.17 / 0.17 / 0.37).
 * 중급 0.25 / 고급 0.44 에서는 1~5일차 대비 6~10일차 승률이 고급 +6~11p, 중급 +5p 로 올라가 지수를 0.03~0.04 올렸다
 * (세 시드군 합산 1~5일차 46.1% / 6~10일차 47.4%).
 * 4인 팀은 후반 스킬·분화의 비중이 커서 v0.4 보다 지수가 크다. 종별 편차는 SPECIES_DAY_EXPONENT_ADJUST 가 맡는다.
 * v0.6: 고급 0.48→0.37. 스킬 상향 뒤 고급 2~4일차가 5~10일차보다 10p 쉬웠다(67/62/58 vs 51). 지수를 내리고 TIER_POWER_RATIO.high 를
 * 0.980→1.011 로 올려 10일차 강도는 그대로 두고 2~4일차만 1~2% 올렸다 (결과 2~4일차 59/51/43, 5~10일차 44~55).
 * 하급·중급은 1일차를 뺀 곡선이 평평해 그대로 두었다 (1일차는 EARLY_DAY_RELIEF 가 맡는다).
 */
export const DAY_DIFFICULTY_EXPONENT: Record<MonsterTier, number> = {
  low: 0.30,
  mid: 0.28,
  high: 0.37,
};

/**
 * 종별 일차 난이도 지수 보정 (DAY_DIFFICULTY_EXPONENT[tier] 에 더해진다. 없으면 0).
 * 같은 난이도라도 편성마다 일차 곡선이 다르게 흐른다: 스탯이 낮은 떼는 유닛당 고정 HP 900 의 비중이 커서
 * 스케일이 오를수록 실효 강도가 초선형으로 늘고, 스탯이 이미 높은 보스는 상한(100)에 걸려 성장이 무뎌진다.
 * 그 차이를 종별 지수로 메워 1일차와 10일차 승률이 같은 구간에 머물게 한다. 헤드리스 실측으로 정한 값.
 */
export const SPECIES_DAY_EXPONENT_ADJUST: Record<string, number> = {
  // 하급 6종은 0 (승률 상한 근처라 기울기가 보이지 않는다)
  orc_warband: -0.039,
  harpy_flock: -0.015,
  living_armor: -0.047,
  bandit_crew: -0.245,
  wraith_choir: 0.041,
  orc_chieftain: -0.257,
  ancient_golem: 0.157,
  frost_dragon: -0.217,
  inferno_lord: -0.355,
  lich_host: -0.125,
  abyss_pack: 0.027,
  demon_legion: -0.154,
};

/** 종별 지수 보정 조회 (정의되지 않은 종은 0) */
export function speciesDayExponentAdjust(monsterId: string): number {
  const v = SPECIES_DAY_EXPONENT_ADJUST[monsterId];
  return v === undefined ? 0 : v;
}

/** 일차 난이도 보정 배율 (1일차 = 1.0). dayExpAdjust 는 종별 지수 보정 */
function dayDifficulty(tier: MonsterTier, day: number, dayExpAdjust: number = 0): number {
  const base = expectedPlayerPower(1);
  if (base <= 0) return 1;
  return Math.pow(expectedPlayerPower(day) / base, DAY_DIFFICULTY_EXPONENT[tier] + dayExpAdjust);
}

/**
 * 초반 일차 완화 배율. 인덱스 0 이 1일차이고, 표 길이를 넘는 일차는 1.0 이다.
 * 1일차는 스킬·분화가 하나도 없어 같은 전투력이라도 실제 강도가 낮다. v0.5 실측 0.985 (0.975 에서는 1일차 고급이 57%,
 * 0.96 에서는 73% 까지 올라갔다. 1.5% 가 승률 5~8%p 를 움직인다).
 * v0.6: 0.985→0.925. 스킬 위력이 ×1.5~1.6 오르자 스킬 2~4개를 가진 몬스터와 스킬 1개뿐인 1일차 플레이어의 격차가 커져
 * 1일차가 전 난이도에서 더 어려워졌다 (하급 92 / 중급 66 / 고급 45%). 0.925 에서 하급 91 / 중급 78 / 고급 49% (하급 1일차는
 * 스킬 없는 팀이 거대 슬라임·독버섯 장판을 못 피해 생기는 손실이라 비율로는 더 안 오른다).
 * 보정B: 난이도별로 나눴다. 하급 1일차가 세 시드 그룹 합산 90~92.5% 로 95% 하한 아래에 남아 하급만 0.925→0.90.
 * 중급 1일차는 합산 75.8~82% 로 하한 근처라 공통 값을 내리면 안 되므로 고급은 0.925 그대로. 중급은 TIER_POWER_RATIO.mid 와
 * 하피·망령 powerScale 을 올린 뒤 1일차가 합산 70.8% (67.5 / 77.5 / 67.5) 로 내려가 0.925→0.91 (73.3%) →0.89 (2~10일차는 목표 안이라 그대로).
 */
const EARLY_DAY_RELIEF: Record<MonsterTier, readonly number[]> = {
  low: [0.9],
  mid: [0.89],
  high: [0.925],
};

function earlyDayRelief(tier: MonsterTier, day: number): number {
  const table = EARLY_DAY_RELIEF[tier];
  const i = clampDay(day) - 1;
  return i < table.length ? table[i] : 1;
}

/**
 * 인원별 팀 목표 전투력 보정. 인덱스 0 이 1명. 길이 = MONSTER_TEAM_MAX.
 *  1명 1.25 (단독 보스: 회복 불가, 집중 사격) / 2명 1.12 / 3~5명 1.0 / 6명 이상 1.15 (떼: 집중 사격 완화)
 */
export const COUNT_POWER_FACTOR: readonly number[] = [1.25, 1.12, 1.0, 1.0, 1.0, 1.15, 1.15, 1.15];

/** 인원 수 → 팀 목표 전투력 배율. 범위 밖 인원은 양 끝 값 */
export function countPowerFactor(count: number): number {
  const n = count !== count ? 1 : Math.round(count);
  if (n <= 1) return COUNT_POWER_FACTOR[0];
  if (n >= COUNT_POWER_FACTOR.length) return COUNT_POWER_FACTOR[COUNT_POWER_FACTOR.length - 1];
  return COUNT_POWER_FACTOR[n - 1];
}

/**
 * 해당 일차·난이도·종의 목표 실효 전투력 (팀 합).
 * unitCount 를 생략하면 TEAM_SIZE(4) 로 보아 인원 보정이 1.0 이다. dayExpAdjust 는 종별 일차 지수 보정(기본 0).
 */
export function monsterPowerTarget(
  tier: MonsterTier,
  day: number,
  powerScale: number,
  unitCount: number = TEAM_SIZE,
  dayExpAdjust: number = 0,
): number {
  const d = clampDay(day);
  return (
    expectedPlayerPower(d) *
    dayDifficulty(tier, d, dayExpAdjust) *
    earlyDayRelief(tier, d) *
    TIER_POWER_RATIO[tier] *
    powerScale *
    countPowerFactor(unitCount)
  );
}

/** 난이도별 표시 등급 (Character.rarity, 표시용) */
const TIER_RARITY: Record<MonsterTier, number> = { low: 2, mid: 3, high: 5 };

/** powerRating 과 같은 스킬 1개당 전투력 가중치 */
const SKILL_POWER = 30;

/** 스탯 스케일 허용 범위. 상한을 넘는 강도는 derivedMult 가 맡는다 */
const STAT_SCALE_MIN = 0.45;
const STAT_SCALE_MAX = 1.5;
/** derivedMult 잔여 배율 허용 범위 */
const RESIDUAL_MIN = 0.6;
const RESIDUAL_MAX = 3.0;

/** 여러 마리일 때 붙는 구분 접미사 ('늑대 A', '늑대 B' …). 길이 ≥ MONSTER_TEAM_MAX */
const UNIT_SUFFIX: readonly string[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

// ───────────────────────── derivedMult ↔ 전투력 환산 ─────────────────────────

/**
 * 파생 수치 배율을 하나의 강도 스칼라로 환산할 때 쓰는 가중치 (합 = 1).
 * HP 와 공격력이 실제 전투 결과를 가장 크게 좌우하므로 비중을 크게 둔다.
 */
const MIX_WEIGHT: Partial<Record<DerivedStatKey, number>> = {
  maxHp: 0.35,
  physAtk: 0.2,
  magAtk: 0.1,
  physDef: 0.15,
  magDef: 0.1,
  atkSpeed: 0.1,
};

/** 잔여 배율 r 을 각 파생 수치에 나눠 실을 때의 상대 지수 (정규화 전) */
const SCALE_SHAPE: Partial<Record<DerivedStatKey, number>> = {
  maxHp: 1.2,
  physAtk: 1.0,
  magAtk: 1.0,
  physDef: 0.8,
  magDef: 0.8,
  atkSpeed: 0.3,
};

/** MIX_WEIGHT / SCALE_SHAPE 가 정의된 키 (DERIVED_STAT_KEYS 순서 고정) */
const MIX_KEYS: readonly DerivedStatKey[] = DERIVED_STAT_KEYS.filter((k) => MIX_WEIGHT[k] !== undefined);

/**
 * 정규화된 지수. Σ(MIX_WEIGHT[k] × SCALE_EXP[k]) = 1 이 되도록 맞춰,
 * 모든 키에 r^SCALE_EXP[k] 를 곱하면 mixFactor 가 정확히 r 배가 된다.
 */
const SCALE_EXP: Partial<Record<DerivedStatKey, number>> = (() => {
  let norm = 0;
  for (const k of MIX_KEYS) norm += (MIX_WEIGHT[k] ?? 0) * (SCALE_SHAPE[k] ?? 0);
  const out: Partial<Record<DerivedStatKey, number>> = {};
  for (const k of MIX_KEYS) out[k] = (SCALE_SHAPE[k] ?? 0) / norm;
  return out;
})();

/** derivedMult → 강도 배율 스칼라 (가중 기하평균). 없으면 1 */
function mixFactor(mult: Partial<Record<DerivedStatKey, number>> | undefined): number {
  if (!mult) return 1;
  let logSum = 0;
  for (let i = 0; i < MIX_KEYS.length; i++) {
    const k = MIX_KEYS[i];
    const v = mult[k];
    if (v === undefined || v <= 0 || v === 1) continue;
    logSum += (MIX_WEIGHT[k] ?? 0) * Math.log(v);
  }
  return logSum === 0 ? 1 : Math.exp(logSum);
}

/** 몬스터 유닛 1기의 실효 전투력 (스탯·스킬 기반 powerRating × derivedMult 강도) */
export function monsterUnitPower(c: Character): number {
  return powerRating(c) * mixFactor(c.derivedMult);
}

/** 몬스터 팀의 실효 전투력 합. 플레이어 팀의 teamPower 와 비교 가능한 척도 */
export function monsterTeamPower(team: Team): number {
  let sum = 0;
  const members = team.members;
  for (let i = 0; i < members.length; i++) sum += monsterUnitPower(members[i]);
  return sum;
}

/** 편성의 총 인원 (units 의 count 합) */
export function monsterUnitCount(def: MonsterDef): number {
  let n = 0;
  for (let i = 0; i < def.units.length; i++) n += Math.max(1, Math.floor(def.units[i].count));
  return n;
}

// ───────────────────────── 유닛 템플릿 정의 도우미 ─────────────────────────

function tpl(
  mainJob: MainJob,
  name: string,
  statProfile: Partial<Record<BaseStatKey, number>>,
  skills: string[],
  derivedMult?: Partial<Record<DerivedStatKey, number>>,
): MonsterUnitTemplate {
  return derivedMult ? { mainJob, name, statProfile, derivedMult, skills } : { mainJob, name, statProfile, skills };
}

// ───────────────────────── 하급 ─────────────────────────
//
// v0.6: 슬라임·들개·고블린·박쥐 템플릿에 HP 편중 derivedMult(maxHp 1.3~1.7 / physAtk 0.75~0.85)를 붙였다.
// 스킬 상향 뒤 하급 전투가 30초대(중앙값 32초)로 끝나 하한 40초를 밑돌았는데, 비율만 올리면 승률이 먼저 떨어진다.
// HP 를 두껍게 하고 공격을 깎으면 같은 목표 전투력에서 전투가 길어지되 치명적이지 않다 (mixFactor 가 배율을 전투력에 반영하므로
// 스탯 배율은 그만큼 낮아진다). 결과 하급 중앙값 43초 / 승률 97.6%. 들개(가장 빨리 녹는 6기 떼)만 1.7 / 0.75 로 더 세게 기울였다.

const T_SLIME = tpl('tank', '슬라임', {
  vitality: 52, strength: 28, agility: 14, moveSpeed: 14, stamina: 56,
  judgment: 16, courage: 55, composure: 40, teamwork: 20, focus: 14,
  accuracy: 36, evasion: 8, defenseTech: 40, critical: 10, mastery: 20,
  magicPower: 12,
}, ['mon_acid_splash', 'mon_tough_hide'], { maxHp: 1.3, physAtk: 0.85 });

const T_WILD_DOG = tpl('berserker', '들개', {
  vitality: 40, strength: 42, agility: 62, moveSpeed: 70, stamina: 40,
  courage: 60, composure: 26, focus: 30,
  accuracy: 46, evasion: 30, defenseTech: 16, critical: 40, mastery: 24,
  magicPower: 8, mana: 12,
}, ['mon_bite', 'mon_swarm_instinct'], { maxHp: 1.7, physAtk: 0.75 });

const T_GOBLIN_ARCHER = tpl('archer', '고블린 사수', {
  vitality: 38, strength: 34, agility: 48, moveSpeed: 48, stamina: 36,
  accuracy: 52, evasion: 28, defenseTech: 16, critical: 34, mastery: 34,
  magicPower: 10,
}, ['mon_crude_arrow', 'mon_swarm_instinct'], { maxHp: 1.5, physAtk: 0.8 });

const T_GOBLIN_FIGHTER = tpl('swordsman', '고블린 전사', {
  vitality: 44, strength: 42, agility: 40, moveSpeed: 44, stamina: 38,
  courage: 44, accuracy: 42, evasion: 20, defenseTech: 28, critical: 26, mastery: 30,
  magicPower: 10,
}, ['mon_rusty_slash', 'mon_tough_hide'], { maxHp: 1.5, physAtk: 0.8 });

const T_CAVE_BAT = tpl('assassin', '동굴 박쥐', {
  vitality: 36, strength: 32, agility: 72, moveSpeed: 76, stamina: 36,
  judgment: 26, courage: 34, focus: 32,
  accuracy: 42, evasion: 62, defenseTech: 12, critical: 32, mastery: 26,
  magicPower: 8,
}, ['mon_bite', 'mon_screech', 'mon_erratic_flight'], { maxHp: 1.5, physAtk: 0.8 });

const T_TOXIC_MUSHROOM = tpl('healer', '독버섯', {
  vitality: 40, strength: 10, agility: 8, moveSpeed: 6, stamina: 46,
  judgment: 40, teamwork: 55, composure: 48,
  accuracy: 30, evasion: 10, defenseTech: 20, mastery: 40,
  magicPower: 46, mana: 44, manaRegen: 46, castSpeed: 40, resistance: 40,
}, ['mon_venom_spore', 'mon_spore_mend']);

const T_SPORE_HUSK = tpl('tank', '포자 껍질', {
  vitality: 50, strength: 26, agility: 12, moveSpeed: 10, stamina: 50,
  courage: 48, composure: 44,
  accuracy: 36, evasion: 8, defenseTech: 42, mastery: 24,
  magicPower: 14, resistance: 38,
}, ['mon_acid_splash', 'mon_tough_hide']);

/** 하급 단독 보스. 느리고 광역 장판(점액 파도)으로 전열을 묶는다. 회피·이동속도가 낮은 팀이 고생한다 */
const T_GIANT_SLIME = tpl('tank', '거대 슬라임', {
  vitality: 74, strength: 46, agility: 16, moveSpeed: 16, stamina: 70,
  judgment: 24, courage: 70, composure: 56, teamwork: 20, focus: 20,
  accuracy: 44, evasion: 6, defenseTech: 50, critical: 14, mastery: 34,
  magicPower: 16, mana: 30, manaRegen: 30, castSpeed: 30, resistance: 36,
}, ['mon_slime_wave', 'mon_acid_splash', 'mon_gelatinous_body', 'mon_tough_hide'], { maxHp: 1.4, physAtk: 1.5, physDef: 1.1 });

// ───────────────────────── 중급 ─────────────────────────

const T_ORC_WARRIOR = tpl('swordsman', '오크 전사', {
  vitality: 58, strength: 66, agility: 42, moveSpeed: 44, stamina: 54,
  courage: 62, composure: 44,
  accuracy: 52, evasion: 26, defenseTech: 48, critical: 40, mastery: 46,
  magicPower: 12,
}, ['mon_heavy_cleave', 'mon_tough_hide']);

const T_ORC_SHIELD = tpl('tank', '오크 방패병', {
  vitality: 70, strength: 52, agility: 28, moveSpeed: 32, stamina: 62,
  courage: 66, composure: 58, teamwork: 54,
  accuracy: 44, evasion: 16, defenseTech: 64, critical: 20, mastery: 40,
  magicPower: 10, resistance: 48,
}, ['mon_shield_slam', 'mon_war_cry', 'mon_iron_carapace']);

const T_ORC_BERSERKER = tpl('berserker', '오크 광전사', {
  vitality: 54, strength: 70, agility: 50, moveSpeed: 50, stamina: 52,
  courage: 72, composure: 24,
  accuracy: 50, evasion: 28, defenseTech: 34, critical: 56, mastery: 42,
  magicPower: 10,
}, ['mon_heavy_cleave', 'mon_pack_howl']);

/** 중급 단독 보스. 충격파 장판(반경 4, 예고 1.2초)으로 뭉친 적을 밀어낸다 */
const T_ORC_CHIEFTAIN = tpl('swordsman', '오크 대족장', {
  vitality: 78, strength: 80, agility: 48, moveSpeed: 46, stamina: 70,
  judgment: 50, courage: 84, composure: 60, teamwork: 40, focus: 50,
  accuracy: 60, evasion: 26, defenseTech: 62, critical: 48, mastery: 56,
  magicPower: 14, mana: 36, manaRegen: 36, castSpeed: 34, resistance: 46,
}, ['mon_shockwave', 'mon_heavy_cleave', 'mon_chieftain_might', 'mon_tough_hide'], { maxHp: 1.6, physAtk: 1.6, physDef: 1.2 });

const T_HARPY_ARCHER = tpl('archer', '하피 사수', {
  vitality: 36, strength: 50, agility: 62, moveSpeed: 66, stamina: 44,
  judgment: 48, focus: 50,
  accuracy: 62, evasion: 46, defenseTech: 22, critical: 48, mastery: 44,
  magicPower: 12,
}, ['mon_crude_arrow', 'mon_wing_gust', 'mon_erratic_flight'], { maxHp: 1.4, physAtk: 0.8 });

const T_HARPY_RAIDER = tpl('assassin', '하피 습격자', {
  vitality: 36, strength: 48, agility: 66, moveSpeed: 72, stamina: 42,
  focus: 52,
  accuracy: 54, evasion: 54, defenseTech: 20, critical: 56, mastery: 42,
  magicPower: 12,
}, ['mon_dive_strike', 'mon_backstab', 'mon_erratic_flight'], { maxHp: 1.4, physAtk: 0.8 });

const T_LIVING_ARMOR = tpl('tank', '리빙 아머', {
  vitality: 80, strength: 58, agility: 24, moveSpeed: 28, stamina: 74,
  courage: 70, composure: 72, teamwork: 46,
  accuracy: 48, evasion: 12, defenseTech: 74, critical: 20, mastery: 44,
  magicPower: 10, resistance: 58,
}, ['mon_shield_slam', 'mon_war_cry', 'mon_iron_carapace'], { maxHp: 1.3, physDef: 1.15, magDef: 1.1 });

const T_AWAKENED_GREATSWORD = tpl('swordsman', '깨어난 대검', {
  vitality: 56, strength: 74, agility: 46, moveSpeed: 42, stamina: 58,
  courage: 62, composure: 58,
  accuracy: 56, evasion: 22, defenseTech: 46, critical: 44, mastery: 52,
  magicPower: 14, resistance: 40,
}, ['mon_heavy_cleave', 'mon_earth_slam', 'mon_iron_carapace'], { maxHp: 1.2, physAtk: 1.3 });

const T_BANDIT_ROGUE = tpl('assassin', '도적', {
  vitality: 40, strength: 54, agility: 64, moveSpeed: 62, stamina: 46,
  judgment: 48, focus: 54,
  accuracy: 56, evasion: 50, defenseTech: 26, critical: 58, mastery: 46,
  magicPower: 12,
}, ['mon_backstab', 'mon_smoke_bomb']);

const T_BANDIT_ARCHER = tpl('archer', '도적 궁수', {
  vitality: 38, strength: 52, agility: 56, moveSpeed: 52, stamina: 44,
  judgment: 46, focus: 48,
  accuracy: 62, evasion: 40, defenseTech: 26, critical: 46, mastery: 46,
  magicPower: 12,
}, ['mon_crude_arrow', 'mon_wing_gust']);

const T_BANDIT_BOSS = tpl('swordsman', '도적 두목', {
  vitality: 56, strength: 64, agility: 50, moveSpeed: 48, stamina: 54,
  courage: 60, judgment: 52, teamwork: 52,
  accuracy: 56, evasion: 30, defenseTech: 46, critical: 46, mastery: 50,
  magicPower: 14,
}, ['mon_heavy_cleave', 'mon_war_cry']);

const T_FIELD_SHAMAN = tpl('healer', '야전 주술사', {
  vitality: 40, strength: 16, agility: 30, moveSpeed: 40, stamina: 44,
  judgment: 56, teamwork: 60, composure: 54,
  accuracy: 38, evasion: 28, defenseTech: 22, mastery: 50,
  magicPower: 56, mana: 54, manaRegen: 52, castSpeed: 50, resistance: 48,
}, ['mon_dark_ritual', 'mon_venom_spore']);

const T_WRAITH = tpl('mage', '망령', {
  vitality: 34, strength: 12, agility: 44, moveSpeed: 44, stamina: 38,
  judgment: 52, composure: 52, focus: 50,
  accuracy: 44, evasion: 46, defenseTech: 16, critical: 36, mastery: 48,
  magicPower: 66, mana: 58, manaRegen: 54, castSpeed: 58, resistance: 50,
}, ['mon_haunting_bolt', 'mon_wail_of_woe'], { maxHp: 1.4, magAtk: 0.8 });

const T_SORROW_PRIEST = tpl('healer', '비탄의 사제', {
  vitality: 38, strength: 12, agility: 28, moveSpeed: 40, stamina: 42,
  judgment: 56, teamwork: 62, composure: 58,
  accuracy: 36, evasion: 30, defenseTech: 20, mastery: 52,
  magicPower: 58, mana: 56, manaRegen: 56, castSpeed: 54, resistance: 52,
}, ['mon_dark_ritual', 'mon_haunting_bolt']);

// ───────────────────────── 고급 ─────────────────────────

/** 고급 단독 보스. 대지진(반경 5, 예고 1.4초, 3초 장판)과 대지 분쇄. 이동속도·판단력이 낮은 팀은 장판에서 못 벗어난다 */
const T_ANCIENT_GOLEM = tpl('tank', '고대 골렘', {
  vitality: 96, strength: 84, agility: 22, moveSpeed: 24, stamina: 92,
  judgment: 46, courage: 90, composure: 84, teamwork: 30, focus: 40,
  accuracy: 60, evasion: 6, defenseTech: 90, critical: 40, mastery: 60,
  magicPower: 24, mana: 44, manaRegen: 44, castSpeed: 32, resistance: 72,
}, ['mon_quake_field', 'mon_earth_slam', 'mon_ancient_bulk', 'mon_sovereign_aura'], { maxHp: 1.4, physAtk: 1.9, magDef: 1.1 });

/** 고급 단독 보스. 빙하 감옥(반경 4.5, 예고 1.3초, 4초 장판) + 서리 숨결 + 용의 포효 */
const T_FROST_DRAGON = tpl('mage', '서리 드래곤', {
  vitality: 90, strength: 70, agility: 48, moveSpeed: 52, stamina: 80,
  judgment: 72, courage: 84, composure: 76, teamwork: 30, focus: 62,
  accuracy: 68, evasion: 30, defenseTech: 66, critical: 55, mastery: 70,
  magicPower: 90, mana: 84, manaRegen: 74, castSpeed: 70, resistance: 78,
}, ['mon_glacial_prison', 'mon_frost_breath', 'mon_dragon_roar', 'mon_ice_scale'], { maxHp: 1.4, magAtk: 1.7, physDef: 1.1, magDef: 1.15 });

/** 고급 보스(2인 편성의 본체). 유성 낙하(반경 4, 예고 1.5초, 3초 불바다) + 지옥불 */
const T_INFERNO_LORD = tpl('mage', '화염 거인', {
  vitality: 84, strength: 60, agility: 40, moveSpeed: 44, stamina: 78,
  judgment: 66, courage: 86, composure: 70, teamwork: 44, focus: 64,
  accuracy: 64, evasion: 20, defenseTech: 60, critical: 52, mastery: 68,
  magicPower: 92, mana: 82, manaRegen: 72, castSpeed: 66, resistance: 70,
}, ['mon_meteor_fall', 'mon_hellfire', 'mon_death_bolt', 'mon_molten_core'], { maxHp: 1.3, magAtk: 1.5, magDef: 1.1 });

const T_DEMON_GUARD = tpl('tank', '마신 근위병', {
  vitality: 80, strength: 62, agility: 32, moveSpeed: 34, stamina: 76,
  courage: 78, composure: 68, teamwork: 56,
  accuracy: 52, evasion: 16, defenseTech: 72, critical: 26, mastery: 48,
  magicPower: 24, resistance: 62,
}, ['mon_shield_slam', 'mon_war_cry', 'mon_sovereign_aura']);

const T_LICH = tpl('mage', '리치', {
  vitality: 66, strength: 22, agility: 40, moveSpeed: 40, stamina: 66,
  judgment: 76, courage: 70, composure: 78, teamwork: 50, focus: 70,
  accuracy: 62, evasion: 36, defenseTech: 46, critical: 50, mastery: 70,
  magicPower: 92, mana: 86, manaRegen: 78, castSpeed: 74, resistance: 78,
}, ['mon_death_bolt', 'mon_raise_dead', 'mon_soul_drain'], { maxHp: 1.6, magAtk: 1.15 });

const T_SKELETON_KNIGHT = tpl('swordsman', '해골 기사', {
  vitality: 50, strength: 60, agility: 42, moveSpeed: 42, stamina: 56,
  courage: 66, composure: 60,
  accuracy: 50, evasion: 20, defenseTech: 48, critical: 36, mastery: 44,
  magicPower: 18, resistance: 40,
}, ['mon_rusty_slash', 'mon_iron_carapace']);

const T_WRAITH_PRIEST = tpl('healer', '망령 사제', {
  vitality: 44, strength: 14, agility: 30, moveSpeed: 40, stamina: 46,
  judgment: 60, teamwork: 64, composure: 60,
  accuracy: 38, evasion: 30, defenseTech: 24, mastery: 56,
  magicPower: 62, mana: 60, manaRegen: 60, castSpeed: 56, resistance: 56,
}, ['mon_unholy_mend', 'mon_dark_blessing']);

/** 심연 떼의 선두. 마수보다 작지만 방어 무시 발톱과 흡혈은 그대로 */
const T_ABYSS_HUNTER = tpl('berserker', '심연의 사냥꾼', {
  vitality: 62, strength: 70, agility: 60, moveSpeed: 60, stamina: 60,
  judgment: 40, courage: 84, composure: 40, teamwork: 36, focus: 54,
  accuracy: 60, evasion: 28, defenseTech: 44, critical: 60, mastery: 52,
  magicPower: 30, mana: 36, manaRegen: 40, castSpeed: 32, resistance: 50,
}, ['mon_abyss_claw', 'mon_devour', 'mon_dread_aura']);

const T_SHADOW_TENDRIL = tpl('assassin', '그림자 촉수', {
  vitality: 42, strength: 54, agility: 66, moveSpeed: 60, stamina: 46,
  focus: 50,
  accuracy: 54, evasion: 56, defenseTech: 26, critical: 52, mastery: 44,
  magicPower: 30, resistance: 44,
}, ['mon_backstab', 'mon_erratic_flight']);

const T_DEMON_GLADIATOR = tpl('swordsman', '마신 검투사', {
  vitality: 62, strength: 76, agility: 58, moveSpeed: 54, stamina: 62,
  courage: 70, composure: 54,
  accuracy: 62, evasion: 32, defenseTech: 50, critical: 58, mastery: 60,
  magicPower: 30, resistance: 48,
}, ['mon_demon_rend', 'mon_dread_aura']);

const T_HELL_CASTER = tpl('mage', '지옥 술사', {
  vitality: 44, strength: 18, agility: 40, moveSpeed: 42, stamina: 46,
  judgment: 62, composure: 56, focus: 58,
  accuracy: 48, evasion: 34, defenseTech: 26, critical: 44, mastery: 58,
  magicPower: 78, mana: 70, manaRegen: 64, castSpeed: 66, resistance: 60,
}, ['mon_hellfire', 'mon_death_bolt']);

const T_FALLEN_PRIEST = tpl('healer', '타락 사제', {
  vitality: 48, strength: 16, agility: 32, moveSpeed: 40, stamina: 50,
  judgment: 62, teamwork: 66, composure: 62,
  accuracy: 40, evasion: 32, defenseTech: 26, mastery: 58,
  magicPower: 70, mana: 66, manaRegen: 64, castSpeed: 60, resistance: 60,
}, ['mon_unholy_mend', 'mon_dark_blessing']);

// ───────────────────────── 몬스터 종 정의 (18종) ─────────────────────────
//
// powerScale 메모 (v0.5 실측 보정값):
//  - 떼(6~8기)는 유닛당 고정 HP 900 이 인원만큼 쌓여 스탯 합 대비 실효 HP 가 두껍다. countPowerFactor 1.15 가
//    이미 붙지만 실측으로는 그래도 약해서 powerScale 이 1.1~1.27 로 올라갔다 (하피 1.27, 심연 1.11, 들개 1.15).
//  - 단독 보스(1기)와 2기 편성은 스탯 합 척도가 실제 강도를 크게 저평가한다 (HP = 체력², 유닛당 고정 HP 900,
//    derivedMult 잔여 배율이 HP 에 집중). 그래서 단독 보스는 0.28~0.36, 2기 편성은 0.49~0.63 이다
//    (countPowerFactor 1.25 / 1.12 가 따로 곱해진다). 이 값에서 스탯 배율은 0.7~1.0 근처에 온다.
//  - 승률은 powerScale 에 매우 민감하다: 1% 가 중급 4~6%p, 고급 6~8%p 를 움직인다. 0.005 단위로만 다듬을 것.
//  - 실측 종별 승률 (시드 1~60 / 3001~3060, 도구 기준): 하급 전 종 96~100%, 중급 72~88%, 고급 41~58%.
//  - v0.6 (스킬 위력 상향 뒤, 시드 1 / 4242 / 9001 합산): 광역 ×1.5 에 6~7기 떼가 녹아 리치 0.907→1.000, 심연 1.110→1.180 으로
//    크게 올렸고, 중급은 비율 상향과 함께 하피 1.272→1.335, 오크 전사대 1.000→1.040, 도적단 1.183→1.205, 리빙 아머 0.633→0.643,
//    망령 1.051→1.030, 대족장 0.364→0.358. 고급 보스는 골렘 0.280→0.276, 드래곤 0.312→0.311, 화염 거인 0.495→0.479.
//    하급은 거대 슬라임 0.336→0.330, 독버섯 1.113→1.100 (둘 다 1일차 손실이라 승률은 거의 안 움직였다).
//    결과 종별 승률: 하급 93.5~100%, 중급 80.3~83.8%, 고급 49.0~52.2%.
//  - 보정B (2026-09-16, 검증 지적 반영): 거대 슬라임 0.330→0.315 (합산 88.4% → 95% 이상). 하피 사수·습격자·망령 템플릿에
//    HP 편중 derivedMult(maxHp 1.4 / 공격 0.8)를 붙여 중급 전투 시간을 늘렸는데 mixFactor 보정만으로는 승률이 90% 대로 올라
//    하피 1.335→1.43, 망령 1.030→1.06 으로 되돌렸다 (하피는 derivedMult 뒤 powerScale 1% 당 승률 1p 정도만 움직여 크게 올렸다). 스킬 계수 보정B(플레이어 광역·주력기 상향)로 중급 전체가 86.5% 가 되어
//    TIER_POWER_RATIO.mid 0.849→0.855.

const MONSTER_LIST: MonsterDef[] = [
  // ══════════ 하급 ══════════
  {
    id: 'slime_swarm',
    name: '슬라임 무리',
    tier: 'low',
    desc: '끈적한 점액 덩어리 여덟이 느릿하게 밀려온다. 하나하나는 약하지만 수가 많아 광역 스킬의 가치를 보여준다.',
    units: [{ template: T_SLIME, count: 8 }],
    preferredMaps: ['plains', 'desert'],
    powerScale: 1.066,
  },
  {
    id: 'wild_dogs',
    name: '들개 떼',
    tier: 'low',
    desc: '굶주린 들개 여섯 마리. 빠르게 파고들어 후열을 물지만 한 마리씩은 금방 쓰러진다.',
    units: [{ template: T_WILD_DOG, count: 6 }],
    preferredMaps: ['plains', 'desert'],
    powerScale: 1.151,
  },
  {
    id: 'goblin_scouts',
    name: '고블린 정찰조',
    tier: 'low',
    desc: '전사 둘이 앞을 막고 사수 둘이 뒤에서 화살을 쏘는, 작지만 제법 갖춰진 넷.',
    units: [
      { template: T_GOBLIN_FIGHTER, count: 2 },
      { template: T_GOBLIN_ARCHER, count: 2 },
    ],
    preferredMaps: ['plains', 'dark'],
    powerScale: 1.116,
  },
  {
    id: 'cave_bats',
    name: '동굴 박쥐 떼',
    tier: 'low',
    desc: '어둠 속을 불규칙하게 날아다니는 큰 박쥐 둘. 회피가 높아 좀처럼 맞지 않고 비명으로 발을 묶는다.',
    units: [{ template: T_CAVE_BAT, count: 2 }],
    preferredMaps: ['dark'],
    powerScale: 0.784,
  },
  {
    id: 'mushroom_grove',
    name: '독버섯 군락',
    tier: 'low',
    desc: '움직이지 못하는 대신 서로를 치유하는 버섯 군락 넷. 독포자 장판 위에 오래 서 있으면 독이 쌓인다.',
    units: [
      { template: T_SPORE_HUSK, count: 2 },
      { template: T_TOXIC_MUSHROOM, count: 2 },
    ],
    preferredMaps: ['dark', 'plains'],
    powerScale: 1.100,
  },
  {
    id: 'giant_slime',
    name: '거대 슬라임',
    tier: 'low',
    desc: '집채만 한 슬라임 한 마리. 느리지만 점액 파도(예고 1.2초, 반경 4 장판)로 전열을 통째로 덮는다. 예고를 보고 비켜야 한다.',
    units: [{ template: T_GIANT_SLIME, count: 1 }],
    preferredMaps: ['desert', 'plains'],
    powerScale: 0.315,
  },

  // ══════════ 중급 ══════════
  {
    id: 'orc_warband',
    name: '오크 전사대',
    tier: 'mid',
    desc: '방패병이 전열을 세우고 전사 둘과 광전사가 밀고 들어오는 정석적인 넷 편성.',
    units: [
      { template: T_ORC_SHIELD, count: 1 },
      { template: T_ORC_WARRIOR, count: 2 },
      { template: T_ORC_BERSERKER, count: 1 },
    ],
    preferredMaps: ['plains', 'desert'],
    powerScale: 1.040,
  },
  {
    id: 'harpy_flock',
    name: '하피 무리',
    tier: 'mid',
    desc: '전열 없이 여섯이 모두 공중에서 때린다. 사수 넷이 거리를 벌리고 습격자 둘이 파고든다.',
    units: [
      { template: T_HARPY_ARCHER, count: 4 },
      { template: T_HARPY_RAIDER, count: 2 },
    ],
    preferredMaps: ['plains', 'glacier'],
    powerScale: 1.43,
  },
  {
    id: 'living_armor',
    name: '리빙 아머',
    tier: 'mid',
    desc: '주인 없는 갑옷 하나와 저절로 움직이는 대검 하나. 둘뿐이지만 대단히 단단하고 대검은 대지 분쇄로 광역 기절을 건다.',
    units: [
      { template: T_LIVING_ARMOR, count: 1 },
      { template: T_AWAKENED_GREATSWORD, count: 1 },
    ],
    preferredMaps: ['dark', 'glacier'],
    powerScale: 0.643,
  },
  {
    id: 'bandit_crew',
    name: '도적단',
    tier: 'mid',
    desc: '두목, 도적, 궁수, 주술사 넷. 회복을 끼고 있어 빠르게 정리하지 못하면 길어진다.',
    units: [
      { template: T_BANDIT_BOSS, count: 1 },
      { template: T_BANDIT_ROGUE, count: 1 },
      { template: T_BANDIT_ARCHER, count: 1 },
      { template: T_FIELD_SHAMAN, count: 1 },
    ],
    preferredMaps: ['dark', 'desert'],
    powerScale: 1.205,
  },
  {
    id: 'wraith_choir',
    name: '망령 성가대',
    tier: 'mid',
    desc: '망령 둘이 원혼탄과 비탄의 울음(예고 0.8초)을 퍼붓고 사제 하나가 이들을 치유한다. 셋 모두 원거리라 접근이 관건이다.',
    units: [
      { template: T_WRAITH, count: 2 },
      { template: T_SORROW_PRIEST, count: 1 },
    ],
    preferredMaps: ['dark', 'glacier'],
    powerScale: 1.06,
  },
  {
    id: 'orc_chieftain',
    name: '오크 대족장',
    tier: 'mid',
    desc: '부족을 홀로 이끄는 거대한 오크. 충격파(예고 1.2초, 반경 4)로 뭉친 적을 밀어내고 흔들리는 땅이 장판으로 남는다.',
    units: [{ template: T_ORC_CHIEFTAIN, count: 1 }],
    preferredMaps: ['plains', 'desert'],
    powerScale: 0.358,
  },

  // ══════════ 고급 ══════════
  {
    id: 'ancient_golem',
    name: '고대 골렘',
    tier: 'high',
    desc: '태고의 바위 거인 1기. 대지진(예고 1.4초, 반경 5, 3초 장판)과 대지 분쇄로 전열을 통째로 부순다. 예고를 보고 흩어지는 팀만 살아남는다.',
    units: [{ template: T_ANCIENT_GOLEM, count: 1 }],
    preferredMaps: ['desert', 'plains'],
    powerScale: 0.276,
  },
  {
    id: 'frost_dragon',
    name: '서리 드래곤',
    tier: 'high',
    desc: '홀로 하늘을 덮는 용. 빙하 감옥(예고 1.3초, 반경 4.5, 4초 냉기 장판)과 서리 숨결로 뭉친 적을 얼린다.',
    units: [{ template: T_FROST_DRAGON, count: 1 }],
    preferredMaps: ['glacier'],
    powerScale: 0.311,
  },
  {
    id: 'inferno_lord',
    name: '화염 거인',
    tier: 'high',
    desc: '용암으로 된 거인과 그를 지키는 마신 근위병 하나. 유성 낙하(예고 1.5초, 반경 4, 3초 불바다)는 늦게 움직이는 유닛을 태운다.',
    units: [
      { template: T_INFERNO_LORD, count: 1 },
      { template: T_DEMON_GUARD, count: 1 },
    ],
    preferredMaps: ['desert', 'dark'],
    powerScale: 0.479,
  },
  {
    id: 'lich_host',
    name: '리치의 군세',
    tier: 'high',
    desc: '리치가 망자를 계속 일으키고 해골 기사 넷과 사제가 이를 둘러싼다. 여섯 중 본체를 빨리 끊지 못하면 수가 불어난다.',
    units: [
      { template: T_LICH, count: 1 },
      { template: T_SKELETON_KNIGHT, count: 4 },
      { template: T_WRAITH_PRIEST, count: 1 },
    ],
    preferredMaps: ['dark', 'glacier'],
    powerScale: 1.000,
  },
  {
    id: 'abyss_pack',
    name: '심연의 마수 무리',
    tier: 'high',
    desc: '사냥꾼 둘이 방어를 무시하고 찢으며 흡혈하고 그림자 촉수 다섯이 후열을 노린다. 일곱이 한 번에 덤빈다.',
    units: [
      { template: T_ABYSS_HUNTER, count: 2 },
      { template: T_SHADOW_TENDRIL, count: 5 },
    ],
    preferredMaps: ['dark'],
    powerScale: 1.180,
  },
  {
    id: 'demon_legion',
    name: '마신 군단',
    tier: 'high',
    desc: '보스 없이 넷 전원이 강하다. 근위병·검투사·술사·사제가 완성된 팀처럼 움직인다.',
    units: [
      { template: T_DEMON_GUARD, count: 1 },
      { template: T_DEMON_GLADIATOR, count: 1 },
      { template: T_HELL_CASTER, count: 1 },
      { template: T_FALLEN_PRIEST, count: 1 },
    ],
    preferredMaps: [],
    powerScale: 0.909,
  },
];

// ───────────────────────── 조회 ─────────────────────────

/** 인원 패턴 구간 (GDD §7.3.2: 난이도마다 1~2 / 3~4 / 6~8 이 모두 있어야 한다) */
const COUNT_PATTERNS: readonly { name: string; min: number; max: number }[] = [
  { name: '1~2명', min: 1, max: 2 },
  { name: '3~4명', min: 3, max: 4 },
  { name: '6~8명', min: 6, max: MONSTER_TEAM_MAX },
];

function buildMonsterMap(): Record<string, MonsterDef> {
  const out: Record<string, MonsterDef> = {};
  for (const def of MONSTER_LIST) {
    if (out[def.id]) throw new Error(`몬스터 id 중복: ${def.id}`);
    for (const g of def.units) {
      if (g.count < 1) throw new Error(`몬스터 유닛 수 오류: ${def.id}`);
      for (const sk of g.template.skills) {
        if (!SKILLS[sk]) throw new Error(`알 수 없는 몬스터 스킬: ${def.id} / ${sk}`);
      }
    }
    const count = monsterUnitCount(def);
    if (count < MONSTER_TEAM_MIN || count > MONSTER_TEAM_MAX) {
      throw new Error(`몬스터 팀 인원은 ${MONSTER_TEAM_MIN}~${MONSTER_TEAM_MAX}명이어야 한다: ${def.id} (${count})`);
    }
    out[def.id] = def;
  }
  if (UNIT_SUFFIX.length < MONSTER_TEAM_MAX) throw new Error('UNIT_SUFFIX 가 MONSTER_TEAM_MAX 보다 짧다');
  for (const tier of MONSTER_TIER_ORDER) {
    const defs = MONSTER_LIST.filter((d) => d.tier === tier);
    if (defs.length < 4) throw new Error(`난이도 ${tier} 몬스터가 4종 미만이다 (${defs.length})`);
    for (const p of COUNT_PATTERNS) {
      let found = false;
      for (const d of defs) {
        const n = monsterUnitCount(d);
        if (n >= p.min && n <= p.max) {
          found = true;
          break;
        }
      }
      if (!found) throw new Error(`난이도 ${tier} 에 ${p.name} 편성이 없다`);
    }
  }
  return out;
}

export const MONSTERS: Record<string, MonsterDef> = buildMonsterMap();

/** 정의 순서가 고정된 전체 몬스터 id 목록 */
export const MONSTER_IDS: readonly string[] = MONSTER_LIST.map((d) => d.id);

/** 해당 난이도의 몬스터 정의 목록 (정의 순서 고정) */
export function monstersOfTier(tier: MonsterTier): MonsterDef[] {
  return MONSTER_LIST.filter((d) => d.tier === tier);
}

export function getMonster(id: string): MonsterDef {
  const def = MONSTERS[id];
  if (!def) throw new Error(`알 수 없는 몬스터: ${id}`);
  return def;
}

// ───────────────────────── 팀 생성 ─────────────────────────

interface UnitDraft {
  template: MonsterUnitTemplate;
  name: string;
  id: string;
  /** BASE_STAT_KEYS 순서의 기준 스탯 (스케일 1, 개체 편차 반영) */
  base: number[];
  /** 템플릿 derivedMult 의 강도 배율 */
  mix: number;
  /** 스킬 수 × SKILL_POWER */
  skillFlat: number;
}

/**
 * 몬스터 팀 생성 (인원 1~8).
 * - 유닛 스탯을 일차와 def.powerScale 에 맞춰 스케일하고, 스탯 상한 때문에 모자란 강도는 derivedMult 로 채운다.
 * - 결과 팀의 실효 전투력(monsterTeamPower) 합은 monsterPowerTarget(tier, day, powerScale, 인원) 에 맞춰진다.
 *   즉 떼는 한 기당 목표/인원(×1.15), 단독 보스는 목표 전체(×1.25)를 한 몸에 싣는다.
 * - 모든 유닛은 monster 표식, 한국어 이름(여러 마리면 'A'~'H' 구분), 전 맵 적응도 50 을 갖는다.
 */
export function buildMonsterTeam(def: MonsterDef, day: number, rng: Rng, idPrefix: string): Team {
  const d = clampDay(day);
  const unitCount = monsterUnitCount(def);
  const target = monsterPowerTarget(def.tier, d, def.powerScale, unitCount, speciesDayExponentAdjust(def.id));

  // ── 1. 개체 편차까지 확정한 기준 스탯 (이후 계산에는 난수를 쓰지 않는다) ──
  const drafts: UnitDraft[] = [];
  let index = 0;
  for (let gi = 0; gi < def.units.length; gi++) {
    const group = def.units[gi];
    const t = group.template;
    const count = Math.max(1, Math.floor(group.count));
    const jobProfile = JOBS[t.mainJob].statProfile;
    for (let n = 0; n < count; n++) {
      const base: number[] = new Array(BASE_STAT_KEYS.length);
      for (let k = 0; k < BASE_STAT_KEYS.length; k++) {
        const key = BASE_STAT_KEYS[k];
        const raw = t.statProfile[key] ?? jobProfile[key] ?? 40;
        base[k] = raw * rng.float(0.94, 1.06);
      }
      drafts.push({
        template: t,
        name: count > 1 ? `${t.name} ${UNIT_SUFFIX[n % UNIT_SUFFIX.length]}` : t.name,
        id: `${idPrefix}_${index}`,
        base,
        mix: mixFactor(t.derivedMult),
        skillFlat: t.skills.length * SKILL_POWER,
      });
      index++;
    }
  }

  // ── 2. 목표 전투력에 맞는 스탯 배율 s 를 이분 탐색 (스탯 상한 때문에 f(s) 가 비선형) ──
  const powerAt = (s: number): number => {
    let total = 0;
    for (let i = 0; i < drafts.length; i++) {
      const dr = drafts[i];
      let st = 0;
      for (let k = 0; k < dr.base.length; k++) st += clampStat(dr.base[k] * s);
      total += (st + dr.skillFlat) * dr.mix;
    }
    return total;
  };

  let statScale: number;
  if (powerAt(STAT_SCALE_MIN) >= target) {
    statScale = STAT_SCALE_MIN;
  } else if (powerAt(STAT_SCALE_MAX) <= target) {
    statScale = STAT_SCALE_MAX;
  } else {
    let lo = STAT_SCALE_MIN;
    let hi = STAT_SCALE_MAX;
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      if (powerAt(mid) < target) lo = mid;
      else hi = mid;
    }
    statScale = (lo + hi) / 2;
  }

  // ── 3. 스탯만으로 채우지 못한 몫을 derivedMult 잔여 배율로 넘긴다 ──
  const achieved = powerAt(statScale);
  let residual = achieved > 0 ? target / achieved : 1;
  if (residual < RESIDUAL_MIN) residual = RESIDUAL_MIN;
  else if (residual > RESIDUAL_MAX) residual = RESIDUAL_MAX;

  // ── 4. Character 생성 ──
  const members: Character[] = [];
  for (let i = 0; i < drafts.length; i++) {
    const dr = drafts[i];
    const t = dr.template;

    const stats = {} as StatBlock;
    for (let k = 0; k < BASE_STAT_KEYS.length; k++) {
      stats[BASE_STAT_KEYS[k]] = clampStat(dr.base[k] * statScale);
    }

    const adaptation = {} as Adaptation;
    for (let m = 0; m < MAP_TYPES.length; m++) adaptation[MAP_TYPES[m]] = 50;

    const derivedMult: Partial<Record<DerivedStatKey, number>> = {};
    const tmpl = t.derivedMult;
    for (let k = 0; k < DERIVED_STAT_KEYS.length; k++) {
      const key = DERIVED_STAT_KEYS[k];
      let v = tmpl ? tmpl[key] : undefined;
      const exp = SCALE_EXP[key];
      if (exp !== undefined) v = (v === undefined ? 1 : v) * Math.pow(residual, exp);
      if (v === undefined) continue;
      derivedMult[key] = Math.round(v * 10000) / 10000;
    }

    members.push({
      id: dr.id,
      name: dr.name,
      mainJob: t.mainJob,
      subJob: null,
      stats,
      adaptation,
      growthVariance: {},
      skills: t.skills.slice(),
      rarity: TIER_RARITY[def.tier],
      monster: { kind: t.name, tier: def.tier },
      derivedMult,
    });
  }

  return { id: `${idPrefix}_team`, name: def.name, members, synergies: [] };
}

// ───────────────────────── 보상 ─────────────────────────

const TIER_REWARD: Record<MonsterTier, { base: number; perDay: number; floor: ChoiceRarity | null; statBonus: number }> = {
  low: { base: 60, perDay: 6, floor: null, statBonus: 0 },
  mid: { base: 120, perDay: 10, floor: 'rare', statBonus: 0 },
  high: { base: 220, perDay: 16, floor: 'epic', statBonus: 3 },
};

/** 패배 시 포인트 지급 비율 */
export const MONSTER_LOSS_POINT_RATE = 0.4;

/**
 * 몬스터 전투 보상 (GDD §7.3.4).
 * 승리: 난이도별 포인트 + 일차 보정, 중급 이상은 다음 선택지 보장 등급, 고급은 팀 전원 랜덤 스탯 +3.
 * 패배: 포인트만 40%, 보장 등급과 추가 보상 없음.
 */
export function monsterReward(tier: MonsterTier, day: number, won: boolean): MonsterReward {
  const d = clampDay(day);
  const r = TIER_REWARD[tier];
  const full = r.base + d * r.perDay;
  if (!won) {
    return { points: Math.round(full * MONSTER_LOSS_POINT_RATE), rarityFloor: null, teamStatBonus: 0 };
  }
  return { points: Math.round(full), rarityFloor: r.floor, teamStatBonus: r.statBonus };
}

// ───────────────────────── 인카운터 ─────────────────────────

/**
 * 난이도 카드 1장 = 실제로 싸우게 될 편성.
 * 종류와 맵은 그날의 시드(rng)로 결정된다. reward 는 카드에 표시할 '승리 시' 보상이다
 * (실제 정산은 전투 후 monsterReward(tier, day, won) 로 다시 구한다).
 */
export function makeEncounter(tier: MonsterTier, day: number, rng: Rng, idPrefix: string): MonsterEncounter {
  const d = clampDay(day);
  const pool = monstersOfTier(tier);
  const def = rng.pick(pool);
  const maps = def.preferredMaps.length > 0 ? def.preferredMaps : MAP_TYPES;
  const map: MapType = rng.pick(maps);
  const team = buildMonsterTeam(def, d, rng, `${idPrefix}_${tier}`);
  return {
    id: `${idPrefix}_${tier}`,
    tier,
    monsterId: def.id,
    name: def.name,
    desc: def.desc,
    map,
    team,
    reward: monsterReward(tier, d, true),
    estimatedPower: Math.round(monsterTeamPower(team)),
  };
}

/** 난이도 3장(하급·중급·고급)을 한 번에 만든다. MONSTER_TIER_ORDER 순서 고정 */
export function makeEncounterSet(day: number, rng: Rng, idPrefix: string): MonsterEncounter[] {
  const out: MonsterEncounter[] = [];
  for (let i = 0; i < MONSTER_TIER_ORDER.length; i++) {
    out.push(makeEncounter(MONSTER_TIER_ORDER[i], day, rng, idPrefix));
  }
  return out;
}

/** 카드에 표시할 편성 요약. 예: '슬라임 ×8' / '리치, 해골 기사 ×4, 망령 사제' */
export function encounterComposition(enc: MonsterEncounter): string {
  const def = MONSTERS[enc.monsterId];
  if (!def) return `${enc.team.members.length}기`;
  const parts: string[] = [];
  for (let i = 0; i < def.units.length; i++) {
    const g = def.units[i];
    parts.push(g.count > 1 ? `${g.template.name} ×${g.count}` : g.template.name);
  }
  return parts.join(', ');
}
