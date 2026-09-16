/**
 * 몬스터 정의와 인카운터 생성 (GDD §7.3).
 *
 * 설계 요약
 *  - 난이도 3종(하급/중급/고급) × 최소 4종, 여기서는 총 15종. 편성 성격이 서로 다르다
 *    (약한 다수 / 원거리 위주 / 회복형 / 단단한 소수 / 보스 + 수하 / 강한 5기).
 *  - 몬스터 유닛은 전부 기존 Character 로 만들어 sim 에 그대로 넣는다. AI 는 mainJob 을 그대로 재사용한다.
 *  - 스탯 상한(100) 때문에 후반 일차에서 강도를 더 못 올리는 문제는 Character.derivedMult 로 해결한다.
 *    buildMonsterTeam 은 먼저 스탯을 스케일하고, 상한에 걸려 모자란 만큼만 derivedMult 로 채운다.
 *  - 강도 기준값(monsterPowerTarget)은
 *      expectedPlayerPower(day) × dayDifficulty(tier, day) × earlyDayRelief(day)
 *      × TIER_POWER_RATIO[tier] × MonsterDef.powerScale.
 *    밸런싱에서 건드릴 값은 이 다섯 가지뿐이다: EXPECTED_TEAM_POWER_BY_DAY, DAY_DIFFICULTY_EXPONENT,
 *    EARLY_DAY_RELIEF, TIER_POWER_RATIO, 각 MonsterDef.powerScale.
 *
 * 보정 현황 (4차 보정. `npm run headless -- --monster --runs 80` 실측, 난이도당 800판)
 *   기준 플레이어 = growth/run.ts 의 실제 육성 루프를 탐욕 정책(greedy: 전투력 최대 카드, 몬스터는 항상 중급)으로
 *   10일 완주시킨 팀. 매 일차 3스텝에서 하급·중급·고급을 모두 싸워 측정한다.
 *   (기준 플레이어는 탱커 또는 힐러 1명을 반드시 포함한다 — 상대팀도 3일차부터 그렇게 생성되므로
 *    한쪽만 보장이 없으면 표본의 1/3 이 구조적으로 불리해져 보정값이 어긋난다. tools/headless.ts 참조)
 *     시드 101~180 : 하급 98.9% / 중급 78.9% / 고급 49.0%
 *     시드 2001~2080: 하급 98.1% / 중급 80.3% / 고급 52.6%  → 목표(95~100 / 80 / 50) 달성.
 *   일차별 고급 승률도 평평하다 (1~6일 평균 46%, 7~10일 평균 49%. 차이는 표본 오차 범위).
 *   전투 시간(중앙값): 하급 52~53초 / 중급 56~58초 / 고급 89~91초. 120초 초과 비율 고급 20~22%.
 *   표본 60회(난이도당 600판)로는 시드군 간 ±5%p 가 흔들린다. 최종 확인은 반드시 --runs 80 이상,
 *   그리고 서로 다른 두 시드군으로 할 것. 종별 승률은 `--monster` 의 '몬스터 종별' 표를 볼 것.
 * 주의 1: 결정론 시뮬레이션이라 승률이 전투력에 매우 민감하다. 전투력 1% 변화가 승률 4~6%p 를 움직인다.
 *         TIER_POWER_RATIO / powerScale 은 0.01~0.02 단위로만 움직이고 반드시 재측정할 것.
 * 주의 2: EXPECTED_TEAM_POWER_BY_DAY 는 추정치가 아니라 위 실측 표본의 '몬스터 전투 직전(3스텝)' 평균 전투력이다.
 *         `--monster` 출력의 '팀 전투력' 열이 그 값이므로, 선택지·보너스 경제가 바뀌면 그 열을 그대로 옮겨 적고
 *         TIER_POWER_RATIO 를 다시 맞추면 된다.
 * 주의 3: 무작위 정책(--policy random) 플레이어는 10일차 전투력이 탐욕 정책보다 약 10% 낮아 승률이 크게 떨어진다.
 *         기준은 탐욕 정책이다.
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
  MONSTER_TIER_ORDER,
  TOTAL_DAYS,
} from '../types';
import { JOBS } from './jobs';
import { SKILLS } from './skills';
import { clampStat, powerRating } from '../stats';

// ───────────────────────── 강도 기준 ─────────────────────────

/**
 * 표준 성장 플레이어의 일차별 팀 전투력 (charGen.teamPower 와 같은 척도: 스탯 합 + 스킬 수 × 30).
 * 실측치다: `npm run headless -- --monster --runs 60` 이 매 일차 3스텝(몬스터 전투 직전)에 측정한
 * 탐욕 정책 육성 60회의 평균 팀 전투력을 그대로 옮긴 값. 인덱스 0 이 1일차.
 * 선택지 희귀도별 상승량이나 보너스 포인트 경제가 바뀌면 이 표부터 다시 측정해 갈아끼운다.
 */
export const EXPECTED_TEAM_POWER_BY_DAY: readonly number[] = [
  4706, // 1일차
  4852, // 2일차
  5001, // 3일차
  5188, // 4일차
  5374, // 5일차 (분화 시작)
  5550, // 6일차
  5672, // 7일차
  5811, // 8일차
  5955, // 9일차
  6090, // 10일차
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
 * 목표 승률(하급 95~100 / 중급 80 / 고급 50%)에 맞춰 헤드리스 대량 시뮬레이션으로 보정한 값이다.
 * 하급 0.62 / 중급 0.845 / 고급 0.993 은 '전투력 점수가 플레이어의 몇 %인가'를 뜻한다.
 * 전투력 점수는 스탯 합이라 편성 형태를 모른다. 같은 점수라도 소수 정예(보스 + 수하)는 다수 약체보다
 * 한 기당 훨씬 강하지만 유닛 수가 적어 집중 사격에 빨리 무너진다. 이 종별 효율 차이는
 * TIER_POWER_RATIO 가 아니라 각 MonsterDef.powerScale 이 흡수한다
 * (하급 다수 편성은 1.1~1.8, 고급 보스 편성은 0.6~0.9).
 */
export const TIER_POWER_RATIO: Record<MonsterTier, number> = {
  low: 0.62,
  mid: 0.845,
  high: 0.993,
};

/**
 * 일차 난이도 보정 지수 (난이도별).
 * 전투력 척도는 스탯 합(선형)이지만 실제 강도는 초선형(HP = 체력², 스킬·분화 누적)이라
 * 전투력 비율만 고정하면 일차에 따라 체감 난이도가 흘러간다.
 * 그 격차를 (해당 일차 전투력 / 1일차 전투력)^DAY_DIFFICULTY_EXPONENT[tier] 로 메운다.
 *
 * 난이도마다 값이 다른 이유(실측):
 *  - 하급·중급은 몬스터도 4~5기 다수 편성이라 플레이어와 같은 곡선으로 강해진다. 0.17 에서 일차별 승률이 평평했다.
 *  - 고급은 보스 1기 + 수하 소수 편성이라 유닛 수가 적고, 플레이어가 스킬·분화로 강해질수록
 *    집중 사격에 더 빨리 무너진다. 0.17 로는 1일차 38% → 10일차 63% 로 후반이 크게 쉬워져,
 *    기울기를 0.37 로 올리고 상수(TIER_POWER_RATIO.high)를 낮춰 평균을 50% 에 다시 맞췄다.
 *    4차 보정(HP 고정항 300→900, 보스 derivedMult 재배분) 뒤 실측에서도 1~6일 46% / 7~10일 49% 로
 *    평평했으므로 0.37 을 그대로 둔다. 내리면 후반이 다시 쉬워진다.
 */
export const DAY_DIFFICULTY_EXPONENT: Record<MonsterTier, number> = {
  low: 0.17,
  mid: 0.17,
  high: 0.37,
};

/** 일차 난이도 보정 배율 (1일차 = 1.0) */
function dayDifficulty(tier: MonsterTier, day: number): number {
  const base = expectedPlayerPower(1);
  if (base <= 0) return 1;
  return Math.pow(expectedPlayerPower(day) / base, DAY_DIFFICULTY_EXPONENT[tier]);
}

/**
 * 초반 일차 완화 배율. 인덱스 0 이 1일차이고, 표 길이를 넘는 일차는 1.0 이다.
 * 1일차는 스킬·분화가 하나도 없어 같은 전투력이라도 실제 강도가 낮다. 실측에서 세 난이도가
 * 모두 1일차에만 4~6%p 씩 낮게 나와(하급 94 / 중급 76 / 고급 42), 그 계통 오차만 되돌린다.
 */
const EARLY_DAY_RELIEF: readonly number[] = [0.989];

function earlyDayRelief(day: number): number {
  const i = clampDay(day) - 1;
  return i < EARLY_DAY_RELIEF.length ? EARLY_DAY_RELIEF[i] : 1;
}

/** 해당 일차·난이도·종의 목표 실효 전투력 */
export function monsterPowerTarget(tier: MonsterTier, day: number, powerScale: number): number {
  const d = clampDay(day);
  return expectedPlayerPower(d) * dayDifficulty(tier, d) * earlyDayRelief(d) * TIER_POWER_RATIO[tier] * powerScale;
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

/** 여러 마리일 때 붙는 구분 접미사 ('늑대 A', '늑대 B' …) */
const UNIT_SUFFIX: readonly string[] = ['A', 'B', 'C', 'D', 'E'];

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

// ───────────────────────── 하급 (약한 다수) ─────────────────────────

const T_SLIME = tpl('tank', '슬라임', {
  vitality: 58, strength: 30, agility: 14, moveSpeed: 14, stamina: 58,
  judgment: 18, courage: 55, composure: 42, teamwork: 20, focus: 16,
  accuracy: 38, evasion: 8, defenseTech: 46, critical: 10, mastery: 22,
  magicPower: 12,
}, ['mon_acid_splash', 'mon_tough_hide']);

const T_WILD_DOG = tpl('berserker', '들개', {
  vitality: 44, strength: 44, agility: 62, moveSpeed: 70, stamina: 42,
  courage: 60, composure: 26, focus: 30,
  accuracy: 46, evasion: 30, defenseTech: 18, critical: 40, mastery: 26,
  magicPower: 8, mana: 12,
}, ['mon_bite', 'mon_swarm_instinct']);

const T_GOBLIN_ARCHER = tpl('archer', '고블린 사수', {
  vitality: 38, strength: 34, agility: 48, moveSpeed: 48, stamina: 36,
  accuracy: 52, evasion: 28, defenseTech: 16, critical: 34, mastery: 34,
  magicPower: 10,
}, ['mon_crude_arrow', 'mon_swarm_instinct']);

const T_GOBLIN_FIGHTER = tpl('swordsman', '고블린 전사', {
  vitality: 44, strength: 42, agility: 40, moveSpeed: 44, stamina: 38,
  courage: 44, accuracy: 42, evasion: 20, defenseTech: 28, critical: 26, mastery: 30,
  magicPower: 10,
}, ['mon_rusty_slash', 'mon_tough_hide']);

const T_CAVE_BAT = tpl('assassin', '동굴 박쥐', {
  vitality: 34, strength: 30, agility: 70, moveSpeed: 74, stamina: 34,
  judgment: 24, courage: 34, focus: 30,
  accuracy: 40, evasion: 60, defenseTech: 10, critical: 30, mastery: 24,
  magicPower: 8,
}, ['mon_bite', 'mon_screech', 'mon_erratic_flight']);

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

// ───────────────────────── 중급 (균형 편성) ─────────────────────────

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

const T_HARPY_ARCHER = tpl('archer', '하피 사수', {
  vitality: 38, strength: 52, agility: 62, moveSpeed: 66, stamina: 46,
  judgment: 48, focus: 50,
  accuracy: 62, evasion: 46, defenseTech: 24, critical: 48, mastery: 46,
  magicPower: 12,
}, ['mon_crude_arrow', 'mon_wing_gust', 'mon_erratic_flight']);

const T_HARPY_RAIDER = tpl('assassin', '하피 습격자', {
  vitality: 38, strength: 50, agility: 66, moveSpeed: 72, stamina: 44,
  focus: 52,
  accuracy: 54, evasion: 54, defenseTech: 22, critical: 56, mastery: 44,
  magicPower: 12,
}, ['mon_dive_strike', 'mon_backstab', 'mon_erratic_flight']);

const T_LIVING_ARMOR = tpl('tank', '리빙 아머', {
  vitality: 74, strength: 54, agility: 24, moveSpeed: 28, stamina: 70,
  courage: 70, composure: 70, teamwork: 46,
  accuracy: 46, evasion: 12, defenseTech: 70, critical: 20, mastery: 42,
  magicPower: 10, resistance: 56,
}, ['mon_shield_slam', 'mon_war_cry', 'mon_iron_carapace']);

const T_AWAKENED_GREATSWORD = tpl('swordsman', '깨어난 대검', {
  vitality: 52, strength: 68, agility: 46, moveSpeed: 42, stamina: 56,
  courage: 62, composure: 58,
  accuracy: 54, evasion: 22, defenseTech: 44, critical: 42, mastery: 50,
  magicPower: 14, resistance: 40,
}, ['mon_heavy_cleave', 'mon_iron_carapace']);

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
  vitality: 32, strength: 12, agility: 44, moveSpeed: 44, stamina: 38,
  judgment: 52, composure: 52, focus: 50,
  accuracy: 44, evasion: 46, defenseTech: 16, critical: 36, mastery: 48,
  magicPower: 64, mana: 58, manaRegen: 54, castSpeed: 58, resistance: 50,
}, ['mon_haunting_bolt', 'mon_wail_of_woe']);

const T_SORROW_PRIEST = tpl('healer', '비탄의 사제', {
  vitality: 38, strength: 12, agility: 28, moveSpeed: 40, stamina: 42,
  judgment: 56, teamwork: 62, composure: 58,
  accuracy: 36, evasion: 30, defenseTech: 20, mastery: 52,
  magicPower: 58, mana: 56, manaRegen: 56, castSpeed: 54, resistance: 52,
}, ['mon_dark_ritual', 'mon_haunting_bolt']);

// ───────────────────────── 고급 (보스 + 수하 / 강한 5기) ─────────────────────────

const T_FROST_DRAGON = tpl('mage', '서리 드래곤', {
  vitality: 88, strength: 70, agility: 46, moveSpeed: 50, stamina: 76,
  judgment: 70, courage: 80, composure: 74, teamwork: 40, focus: 60,
  accuracy: 66, evasion: 30, defenseTech: 62, critical: 55, mastery: 68,
  magicPower: 86, mana: 80, manaRegen: 70, castSpeed: 68, resistance: 76,
  // HP 2.4 는 고급 전투를 120초 밖으로 밀어냈다. HP 를 덜고 이능 공격으로 옮겨 같은 강도를 더 짧게 낸다.
}, ['mon_frost_breath', 'mon_dragon_roar', 'mon_ice_scale'], { maxHp: 1.7, magAtk: 1.35, physDef: 1.2, magDef: 1.2 });

const T_FROST_WOLF = tpl('swordsman', '서리 늑대', {
  vitality: 52, strength: 62, agility: 56, moveSpeed: 64, stamina: 54,
  courage: 60,
  accuracy: 54, evasion: 30, defenseTech: 40, critical: 50, mastery: 44,
  magicPower: 20, resistance: 44,
}, ['mon_bite', 'mon_swarm_instinct']);

const T_ABYSS_BEAST = tpl('berserker', '심연의 마수', {
  vitality: 86, strength: 88, agility: 60, moveSpeed: 58, stamina: 80,
  judgment: 40, courage: 90, composure: 40, teamwork: 30, focus: 55,
  accuracy: 64, evasion: 26, defenseTech: 58, critical: 66, mastery: 60,
  magicPower: 40, mana: 40, manaRegen: 45, castSpeed: 35, resistance: 60,
}, ['mon_abyss_claw', 'mon_devour', 'mon_dread_aura'], { maxHp: 2.2, physAtk: 1.15 });

const T_SHADOW_TENDRIL = tpl('assassin', '그림자 촉수', {
  vitality: 44, strength: 56, agility: 66, moveSpeed: 60, stamina: 46,
  focus: 50,
  accuracy: 54, evasion: 56, defenseTech: 28, critical: 52, mastery: 46,
  magicPower: 30, resistance: 44,
}, ['mon_backstab', 'mon_erratic_flight']);

const T_LICH = tpl('mage', '리치', {
  vitality: 66, strength: 22, agility: 40, moveSpeed: 40, stamina: 66,
  judgment: 76, courage: 70, composure: 78, teamwork: 50, focus: 70,
  accuracy: 62, evasion: 36, defenseTech: 46, critical: 50, mastery: 70,
  magicPower: 92, mana: 86, manaRegen: 78, castSpeed: 74, resistance: 78,
}, ['mon_death_bolt', 'mon_raise_dead', 'mon_soul_drain'], { maxHp: 1.9, magAtk: 1.15 });

const T_SKELETON_KNIGHT = tpl('swordsman', '해골 기사', {
  vitality: 54, strength: 64, agility: 44, moveSpeed: 42, stamina: 58,
  courage: 66, composure: 60,
  accuracy: 52, evasion: 22, defenseTech: 50, critical: 38, mastery: 46,
  magicPower: 20, resistance: 40,
}, ['mon_rusty_slash', 'mon_iron_carapace']);

const T_WRAITH_PRIEST = tpl('healer', '망령 사제', {
  vitality: 44, strength: 14, agility: 30, moveSpeed: 40, stamina: 46,
  judgment: 60, teamwork: 64, composure: 60,
  accuracy: 38, evasion: 30, defenseTech: 24, mastery: 56,
  magicPower: 62, mana: 60, manaRegen: 60, castSpeed: 56, resistance: 56,
}, ['mon_unholy_mend', 'mon_dark_blessing']);

// 골렘 군주는 HP·물방이 너무 두꺼워 고급 전투 시간을 120초 밖으로 밀어냈다 (평균 142초, 76%가 120초 초과).
// maxHp 2.15→1.5 를 physAtk 1.48→1.9 로 옮겨 같은 강도를 더 짧게 낸다.
// HP 를 공격으로 옮기면 실제 강도가 올라가므로 powerScale 도 함께 재보정했다.
const T_GOLEM_LORD = tpl('tank', '골렘 군주', {
  vitality: 94, strength: 78, agility: 24, moveSpeed: 28, stamina: 90,
  judgment: 50, courage: 86, composure: 80, teamwork: 40, focus: 40,
  accuracy: 58, evasion: 10, defenseTech: 88, critical: 40, mastery: 56,
  magicPower: 26, mana: 40, manaRegen: 40, castSpeed: 30, resistance: 70,
}, ['mon_earth_slam', 'mon_granite_skin', 'mon_sovereign_aura'], { maxHp: 1.35, physAtk: 2.05, physDef: 1.15 });

const T_ROCK_GOLEM = tpl('tank', '바위 골렘', {
  vitality: 70, strength: 58, agility: 20, moveSpeed: 24, stamina: 74,
  courage: 70, composure: 64,
  accuracy: 46, evasion: 8, defenseTech: 66, critical: 22, mastery: 40,
  magicPower: 14, resistance: 52,
}, ['mon_shield_slam', 'mon_granite_skin']);

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

const T_DEMON_GUARD = tpl('tank', '마신 근위병', {
  vitality: 80, strength: 62, agility: 32, moveSpeed: 34, stamina: 76,
  courage: 78, composure: 68, teamwork: 56,
  accuracy: 52, evasion: 16, defenseTech: 72, critical: 26, mastery: 48,
  magicPower: 24, resistance: 62,
}, ['mon_shield_slam', 'mon_war_cry', 'mon_sovereign_aura']);

// ───────────────────────── 몬스터 종 정의 (15종) ─────────────────────────

const MONSTER_LIST: MonsterDef[] = [
  // ══════════ 하급: 약한 다수 ══════════
  {
    id: 'slime_swarm',
    name: '슬라임 무리',
    tier: 'low',
    desc: '끈적한 점액 덩어리 넷이 느릿하게 몰려온다. 단단하지만 공격이 약하고 발이 느리다.',
    units: [{ template: T_SLIME, count: 4 }],
    preferredMaps: ['plains', 'desert'],
    powerScale: 1.12,
  },
  {
    id: 'wild_dogs',
    name: '들개 떼',
    tier: 'low',
    desc: '굶주린 들개 다섯 마리. 하나하나는 약하지만 빠르게 파고들어 후열을 문다.',
    units: [{ template: T_WILD_DOG, count: 5 }],
    preferredMaps: ['plains', 'desert'],
    powerScale: 1.36,
  },
  {
    id: 'goblin_scouts',
    name: '고블린 정찰조',
    tier: 'low',
    desc: '전사 둘이 앞을 막고 사수 둘이 뒤에서 화살을 쏘는, 작지만 제법 갖춰진 정찰대.',
    units: [
      { template: T_GOBLIN_FIGHTER, count: 2 },
      { template: T_GOBLIN_ARCHER, count: 2 },
    ],
    preferredMaps: ['plains', 'dark'],
    powerScale: 1.32,
  },
  {
    id: 'cave_bats',
    name: '동굴 박쥐 떼',
    tier: 'low',
    desc: '어둠 속을 불규칙하게 날아다니는 박쥐 다섯. 회피가 높아 좀처럼 맞지 않는다.',
    units: [{ template: T_CAVE_BAT, count: 5 }],
    preferredMaps: ['dark'],
    powerScale: 1.60,
  },
  {
    id: 'mushroom_grove',
    name: '독버섯 군락',
    tier: 'low',
    desc: '움직이지 못하는 대신 서로를 치유하는 버섯 군락. 오래 끌면 독이 쌓인다.',
    units: [
      { template: T_SPORE_HUSK, count: 2 },
      { template: T_TOXIC_MUSHROOM, count: 2 },
    ],
    preferredMaps: ['dark', 'plains'],
    powerScale: 1.2,
  },

  // ══════════ 중급: 균형 편성 ══════════
  {
    id: 'orc_warband',
    name: '오크 전사대',
    tier: 'mid',
    desc: '방패병이 전열을 세우고 전사와 광전사가 밀고 들어오는 정석적인 다섯 명 편성.',
    units: [
      { template: T_ORC_SHIELD, count: 1 },
      { template: T_ORC_WARRIOR, count: 2 },
      { template: T_ORC_BERSERKER, count: 2 },
    ],
    preferredMaps: ['plains', 'desert'],
    powerScale: 1.010,
  },
  {
    id: 'harpy_flock',
    name: '하피 무리',
    tier: 'mid',
    desc: '전열 없이 다섯이 모두 공중에서 때린다. 사수 셋이 거리를 벌리고 습격자 둘이 파고든다.',
    units: [
      { template: T_HARPY_ARCHER, count: 3 },
      { template: T_HARPY_RAIDER, count: 2 },
    ],
    preferredMaps: ['plains', 'glacier'],
    powerScale: 1.190,
  },
  {
    id: 'living_armor',
    name: '리빙 아머',
    tier: 'mid',
    desc: '주인 없는 갑옷 넷. 수가 적은 대신 하나하나가 대단히 단단하다.',
    units: [
      { template: T_LIVING_ARMOR, count: 3 },
      { template: T_AWAKENED_GREATSWORD, count: 1 },
    ],
    preferredMaps: ['dark', 'glacier'],
    powerScale: 0.905,
  },
  {
    id: 'bandit_crew',
    name: '도적단',
    tier: 'mid',
    desc: '두목, 도적 둘, 궁수, 주술사. 회복을 끼고 있어 빠르게 정리하지 못하면 길어진다.',
    units: [
      { template: T_BANDIT_BOSS, count: 1 },
      { template: T_BANDIT_ROGUE, count: 2 },
      { template: T_BANDIT_ARCHER, count: 1 },
      { template: T_FIELD_SHAMAN, count: 1 },
    ],
    preferredMaps: ['dark', 'desert'],
    powerScale: 1.130,
  },
  {
    id: 'wraith_choir',
    name: '망령 성가대',
    tier: 'mid',
    desc: '망령 셋이 원혼탄을 퍼붓고 사제 하나가 이들을 치유한다. 전부 원거리라 접근이 관건이다.',
    units: [
      { template: T_WRAITH, count: 3 },
      { template: T_SORROW_PRIEST, count: 1 },
    ],
    preferredMaps: ['dark', 'glacier'],
    powerScale: 1.122,
  },

  // ══════════ 고급: 보스 + 수하 / 강한 5기 ══════════
  {
    id: 'frost_dragon',
    name: '서리 드래곤',
    tier: 'high',
    desc: '서리 숨결로 전열을 통째로 얼리는 용. 늑대 둘을 거느린다. 광역 빙결에 뭉치면 위험하다.',
    units: [
      { template: T_FROST_DRAGON, count: 1 },
      { template: T_FROST_WOLF, count: 2 },
    ],
    preferredMaps: ['glacier'],
    powerScale: 0.725,
  },
  {
    id: 'abyss_beast',
    name: '심연의 마수',
    tier: 'high',
    desc: '방어를 무시하고 찢으며 흡혈하는 거대 마수. 그림자 촉수 셋이 후열을 노린다.',
    units: [
      { template: T_ABYSS_BEAST, count: 1 },
      { template: T_SHADOW_TENDRIL, count: 3 },
    ],
    preferredMaps: ['dark'],
    powerScale: 0.808,
  },
  {
    id: 'lich_host',
    name: '리치의 군세',
    tier: 'high',
    desc: '리치가 망자를 계속 일으키고 사제가 이를 치유한다. 본체를 빨리 끊지 못하면 수가 불어난다.',
    units: [
      { template: T_LICH, count: 1 },
      { template: T_SKELETON_KNIGHT, count: 2 },
      { template: T_WRAITH_PRIEST, count: 1 },
    ],
    preferredMaps: ['dark', 'glacier'],
    powerScale: 0.723,
  },
  {
    id: 'golem_lord',
    name: '골렘 군주',
    tier: 'high',
    desc: '거대한 바위 군주와 골렘 둘. 셋뿐이지만 HP와 물리 방어가 두텁고 일격이 무거우며 광역 기절을 건다.',
    units: [
      { template: T_GOLEM_LORD, count: 1 },
      { template: T_ROCK_GOLEM, count: 2 },
    ],
    preferredMaps: ['desert', 'plains'],
    powerScale: 0.606,
  },
  {
    id: 'demon_legion',
    name: '마신 군단',
    tier: 'high',
    desc: '보스 없이 다섯 전원이 강하다. 근위병·검투사·술사·사제가 완성된 팀처럼 움직인다.',
    units: [
      { template: T_DEMON_GUARD, count: 1 },
      { template: T_DEMON_GLADIATOR, count: 2 },
      { template: T_HELL_CASTER, count: 1 },
      { template: T_FALLEN_PRIEST, count: 1 },
    ],
    preferredMaps: [],
    powerScale: 0.909,
  },
];

// ───────────────────────── 조회 ─────────────────────────

function buildMonsterMap(): Record<string, MonsterDef> {
  const out: Record<string, MonsterDef> = {};
  for (const def of MONSTER_LIST) {
    if (out[def.id]) throw new Error(`몬스터 id 중복: ${def.id}`);
    let count = 0;
    for (const g of def.units) {
      if (g.count < 1) throw new Error(`몬스터 유닛 수 오류: ${def.id}`);
      count += g.count;
      for (const sk of g.template.skills) {
        if (!SKILLS[sk]) throw new Error(`알 수 없는 몬스터 스킬: ${def.id} / ${sk}`);
      }
    }
    if (count < 1 || count > 5) throw new Error(`몬스터 팀 인원은 1~5명이어야 한다: ${def.id} (${count})`);
    out[def.id] = def;
  }
  for (const tier of MONSTER_TIER_ORDER) {
    let n = 0;
    for (const def of MONSTER_LIST) if (def.tier === tier) n++;
    if (n < 4) throw new Error(`난이도 ${tier} 몬스터가 4종 미만이다 (${n})`);
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
 * 몬스터 팀 생성.
 * - 유닛 스탯을 일차와 def.powerScale 에 맞춰 스케일하고, 스탯 상한 때문에 모자란 강도는 derivedMult 로 채운다.
 * - 결과 팀의 실효 전투력(monsterTeamPower)은 expectedPlayerPower(day) × TIER_POWER_RATIO[tier] × powerScale 에 맞춰진다.
 * - 모든 유닛은 monster 표식, 한국어 이름(여러 마리면 'A'/'B' 구분), 전 맵 적응도 50 을 갖는다.
 */
export function buildMonsterTeam(def: MonsterDef, day: number, rng: Rng, idPrefix: string): Team {
  const d = clampDay(day);
  const target = monsterPowerTarget(def.tier, d, def.powerScale);

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

/** 카드에 표시할 편성 요약. 예: '슬라임 ×4' */
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
