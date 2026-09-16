/**
 * 파생 전투 수치 계산 (GDD §4.2).
 * 기본 스탯(1~100) → 실제 전투 수치. 전투 중 자주 호출되므로 할당을 최소화한다.
 *
 * 규칙 요약
 *  - 맵 보정(mapModifier)은 maxHp, physAtk, magAtk, physDef, magDef, atkSpeed, moveSpeed 에만 곱한다.
 *    (확률·배율·사거리·MP 계열에는 적용하지 않는다)
 *  - 패시브 스킬의 passiveMods(%) 와 외부 pctMods(%: 시너지/버프) 는 키별로 합산한 뒤
 *    마지막에 value × (1 + pct/100) 로 한 번 곱한다.
 *  - critChance / critMult / cooldownReduction 은 퍼센트 값(150 = 1.5배). accuracy / evasion 은 원본 스탯값이며
 *    적중 공식은 sim 에 있다 (편의용 hitChancePct 를 여기서도 제공).
 *  - Character.derivedMult(몬스터 전용 최종 배율)는 맵 보정·pctMods 가 모두 끝난 뒤 마지막에 곱해진다.
 */
import type { BaseStatKey, Character, DerivedStatKey, DerivedStats, MapType } from './types';
import { BASE_STAT_KEYS, DERIVED_STAT_KEYS, STAT_MAX, STAT_MIN } from './types';
import { JOBS } from './data/jobs';
import { getSkill } from './data/skills';

/** 스탯 값을 STAT_MIN..STAT_MAX 로 반올림·클램프. NaN 은 STAT_MIN. */
export function clampStat(v: number): number {
  if (v !== v) return STAT_MIN; // NaN
  const r = Math.round(v);
  if (r < STAT_MIN) return STAT_MIN;
  if (r > STAT_MAX) return STAT_MAX;
  return r;
}

/** 맵 적응도 → 배율. (적응도 − 50) × 0.4% → 0.8 ~ 1.2 (GDD 4.2) */
export function mapModifier(adaptation: number): number {
  let a = adaptation;
  if (a !== a) a = 50;
  if (a < STAT_MIN) a = STAT_MIN;
  if (a > STAT_MAX) a = STAT_MAX;
  const m = 1 + (a - 50) * 0.004;
  return m < 0.8 ? 0.8 : m > 1.2 ? 1.2 : m;
}

/** 적중률 % = 70 + (명중 − 회피) × 0.3, 하한 30 상한 100 (GDD 4.2). sim 이 같은 공식을 쓰도록 편의 제공. */
export function hitChancePct(accuracy: number, evasion: number): number {
  const h = 70 + (accuracy - evasion) * 0.3;
  return h < 30 ? 30 : h > 100 ? 100 : h;
}

export const COOLDOWN_REDUCTION_CAP = 40;

/**
 * 기본 공격 속도 기준값 (초당 타격 수, 민첩 0 기준). v0.5 까지 1.0.
 * v0.6: 스킬 위력을 크게 올리면서 전투 시간(60~120초)을 지키려면 기본 공격이 차지하던 피해 몫을 스킬에 넘겨야 한다.
 * HP 를 올리면 스킬 1회 피해가 상대 HP 대비 작아져 "맞는 체감" 목표(단일 18~30%)와 충돌하므로, 기본 공격 빈도를 낮춰
 * 기본 공격 비중 30~45% · 스킬 비중 55~70% 를 맞춘다. 스킬 시전·쿨타임에는 영향이 없다 (소환물은 자체 공격 간격을 쓴다).
 */
export const BASIC_ATTACK_SPEED_BASE = 0.6;

/**
 * 최대 HP 공식 상수: (HP_BASE + 체력² × HP_VIT_SQ + 직업 보정 × 3) × HP_SCALE.
 * v0.5: 900 + 체력² × 0.8. v0.6: 600 + 체력² × 0.95 — 체력 45(1일차)에서는 거의 같고(2520 → 2524), 체력 60~70(10일차)에서는 6~9% 높다.
 * 스킬 위력을 올린 뒤 1일차 전투가 10일차보다 길어지는 문제를, 성장한 팀의 HP 만 더 늘리는 방식으로 풀었다 (1일차 < 10일차 목표).
 * v0.7: 맵이 40×30 → 28×20 으로 줄어 접전이 빨리 붙으면서 4:4 평균 전투 시간이 목표 하한(60초) 근처로 내려갔다
 * (10일차 평원 52~64초, 빙하 50~55초, 1일차 58초). 스킬 계수를 깎지 않고 HP 전체에 HP_SCALE 을 곱해 되돌린다.
 * 체력² 형태(고정항 ↑ / 제곱항 ↓)를 바꾸는 방식은 체력이 낮은 다수 유닛(8기 떼 몬스터)에 유리하고 1기 보스에 불리해
 * 몬스터 인원 구간 편차(±8%p)를 깨뜨리므로, 비례 배율만 쓴다 (플레이어·상대·몬스터 모두 같은 배율).
 * v0.7 보정 2차: 1.12 에서는 탱커·힐러가 많은 편성(지원 4~5명, 탱커 3명)이 120초를 넘겨 전장 붕괴로 끝나는 비율이
 * 시드 풀링 15.7% (시드 77 10일차 19.5%) 로 목표(< 15%)를 넘었다. 사막 지구력·이동속도, 힐 계수·쿨타임은 측정상 효과가 없었고
 * (피로는 공·방을 같이 깎는다), HP 배율만이 붕괴 종료 비율을 움직였다 → 1.05 (시드 1·4242·9001 풀링 13.6%, 평균 전투 시간 67~72초,
 * 1일차 64초, 스킬 비중 64~66%, 눈보라 비중 12~16%, 몬스터 승률은 양 팀 비례라 변화 없음).
 */
export const HP_BASE = 600;
export const HP_VIT_SQ = 0.95;
/** 최대 HP 전체 배율 (v0.7). 1.0 = v0.6 값. 전투 시간·붕괴 종료 비율 보정 전용 — 승률·비중에는 거의 영향이 없다 */
export const HP_SCALE = 1.05;

/** 맵 보정이 곱해지는 파생 수치 */
const MAP_SCALED: readonly DerivedStatKey[] = ['maxHp', 'physAtk', 'magAtk', 'physDef', 'magDef', 'atkSpeed', 'moveSpeed'];

function statOf(c: Character, k: BaseStatKey): number {
  const v = c.stats[k];
  return v === undefined || v !== v ? STAT_MIN : v;
}

/**
 * 파생 전투 수치 계산.
 * @param c 캐릭터
 * @param map 현재 맵 (적응도 보정)
 * @param pctMods 추가 % 보정 (시너지/버프). 패시브 스킬 보정과 합산되어 마지막에 곱해진다.
 */
export function computeDerived(c: Character, map: MapType, pctMods?: Partial<Record<DerivedStatKey, number>>): DerivedStats {
  const job = JOBS[c.mainJob];
  const hpBonus = job ? job.hpBonus : 0;
  const baseRange = job ? job.baseRange : 1.5;

  const vitality = statOf(c, 'vitality');
  const strength = statOf(c, 'strength');
  const agility = statOf(c, 'agility');
  const moveSpeed = statOf(c, 'moveSpeed');
  const composure = statOf(c, 'composure');
  const focus = statOf(c, 'focus');
  const accuracy = statOf(c, 'accuracy');
  const evasion = statOf(c, 'evasion');
  const defenseTech = statOf(c, 'defenseTech');
  const critical = statOf(c, 'critical');
  const mastery = statOf(c, 'mastery');
  const magicPower = statOf(c, 'magicPower');
  const mana = statOf(c, 'mana');
  const manaRegen = statOf(c, 'manaRegen');
  const castSpeed = statOf(c, 'castSpeed');
  const resistance = statOf(c, 'resistance');

  const adaptation = c.adaptation ? c.adaptation[map] : 50;
  const mapMod = mapModifier(adaptation === undefined ? 50 : adaptation);

  // 쿨타임 감소: 숙련도 × 0.4% (상한 40%). GDD 초안의 0.25% 는 상한에 닿을 수 없어 0.4 로 조정.
  const cdr = mastery * 0.4;
  const d: DerivedStats = {
    // 최대 HP: 체력에 대해 초선형(체력²) — 성장할수록 공격력보다 HP 가 빨리 늘어 후반 전투가 길어진다 (GDD 6.1 전투 시간 목표).
    // 고정항 300 → 900: 체력이 낮은 편성(하급 몬스터, 초반 4:4)의 전투가 목표 하한 40초를 크게 밑돌았다.
    // 고정항은 양 팀에 똑같이 더해지므로 승률은 그대로 두고 짧은 쪽 꼬리만 끌어올린다.
    // 체력 40 ≈ 2180, 체력 55 ≈ 3320 (+직업 보정 × 3).
    maxHp: (HP_BASE + vitality * vitality * HP_VIT_SQ + hpBonus * 3) * HP_SCALE * mapMod,
    physAtk: (strength * 1.0 + mastery * 0.3) * mapMod,
    magAtk: (magicPower * 1.0 + mastery * 0.3) * mapMod,
    physDef: (defenseTech * 0.8 + vitality * 0.2) * mapMod,
    magDef: (resistance * 0.8 + composure * 0.2) * mapMod,
    atkSpeed: BASIC_ATTACK_SPEED_BASE * (1 + agility / 200) * mapMod,
    moveSpeed: 3.0 * (1 + moveSpeed / 150) * mapMod,
    critChance: focus * 0.4,
    critMult: 150 + critical * 0.5,
    accuracy,
    evasion,
    maxMp: 50 + mana * 2,
    mpRegen: 1 + manaRegen * 0.08,
    castSpeed: 1 + castSpeed / 200,
    cooldownReduction: cdr > COOLDOWN_REDUCTION_CAP ? COOLDOWN_REDUCTION_CAP : cdr,
    range: baseRange,
  };

  // ── % 보정 합산: 패시브 스킬 + 외부 pctMods ──
  let pct: Partial<Record<DerivedStatKey, number>> | null = null;
  const skills = c.skills;
  for (let i = 0; i < skills.length; i++) {
    const sk = getSkill(skills[i]);
    if (sk.type !== 'passive' || !sk.passiveMods) continue;
    const mods = sk.passiveMods;
    for (let j = 0; j < DERIVED_STAT_KEYS.length; j++) {
      const k = DERIVED_STAT_KEYS[j];
      const v = mods[k];
      if (v === undefined || v === 0) continue;
      if (pct === null) pct = {};
      pct[k] = (pct[k] || 0) + v;
    }
  }
  if (pctMods) {
    for (let j = 0; j < DERIVED_STAT_KEYS.length; j++) {
      const k = DERIVED_STAT_KEYS[j];
      const v = pctMods[k];
      if (v === undefined || v === 0) continue;
      if (pct === null) pct = {};
      pct[k] = (pct[k] || 0) + v;
    }
  }
  if (pct !== null) {
    for (let j = 0; j < DERIVED_STAT_KEYS.length; j++) {
      const k = DERIVED_STAT_KEYS[j];
      const v = pct[k];
      if (v === undefined) continue;
      let mult = 1 + v / 100;
      if (mult < 0) mult = 0;
      d[k] = d[k] * mult;
    }
  }

  // ── 최종 배율: Character.derivedMult (몬스터 전용). 모든 계산이 끝난 뒤 마지막에 곱한다 ──
  const dm = c.derivedMult;
  if (dm !== undefined) {
    for (let j = 0; j < DERIVED_STAT_KEYS.length; j++) {
      const k = DERIVED_STAT_KEYS[j];
      const v = dm[k];
      if (v === undefined || v === 1) continue;
      d[k] = d[k] * (v < 0 ? 0 : v);
    }
  }

  // ── 최종 정규화: 정수 HP/MP, 하한·상한 ──
  d.maxHp = Math.max(1, Math.round(d.maxHp));
  d.maxMp = Math.max(0, Math.round(d.maxMp));
  if (d.physAtk < 0) d.physAtk = 0;
  if (d.magAtk < 0) d.magAtk = 0;
  if (d.physDef < 0) d.physDef = 0;
  if (d.magDef < 0) d.magDef = 0;
  if (d.atkSpeed < 0.1) d.atkSpeed = 0.1;
  if (d.moveSpeed < 0) d.moveSpeed = 0;
  if (d.critChance < 0) d.critChance = 0;
  else if (d.critChance > 100) d.critChance = 100;
  if (d.critMult < 100) d.critMult = 100;
  if (d.mpRegen < 0) d.mpRegen = 0;
  if (d.castSpeed < 0.1) d.castSpeed = 0.1;
  if (d.cooldownReduction < 0) d.cooldownReduction = 0;
  else if (d.cooldownReduction > COOLDOWN_REDUCTION_CAP) d.cooldownReduction = COOLDOWN_REDUCTION_CAP;
  if (d.range < 0.5) d.range = 0.5;

  return d;
}

/** 맵 보정이 곱해지는 파생 수치인지 (표시/디버그용) */
export function isMapScaled(k: DerivedStatKey): boolean {
  for (let i = 0; i < MAP_SCALED.length; i++) if (MAP_SCALED[i] === k) return true;
  return false;
}

/** 기본 스탯 20개 합 */
export function statTotal(c: Character): number {
  let sum = 0;
  for (let i = 0; i < BASE_STAT_KEYS.length; i++) sum += statOf(c, BASE_STAT_KEYS[i]);
  return sum;
}

/** 표시용 대략적 전투력: 스탯 합 + 스킬 수 × 30 */
export function powerRating(c: Character): number {
  return statTotal(c) + c.skills.length * 30;
}
