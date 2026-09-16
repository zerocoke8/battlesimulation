/**
 * 직업 9종 × 세부 직업 3종 정의 (GDD §3.1).
 * 스킬 id 는 문자열로만 참조한다 (skills.ts 가 이 파일을 import 하므로 순환 방지).
 *
 * v0.6 풀 규약:
 *  - 모든 메인 직업의 기본 풀(skillPool)에는 적 광역 피해 스킬이 최소 1개 있다 (검사 회전 베기, 탱커 충격파, 버서커 대지 강타,
 *    암살자 연막 단검, 궁수 화살비, 저격수 폭발탄, 마법사 마력 폭발·비전 폭풍·메테오, 소환사 정령 폭발, 힐러 심판의 빛).
 *  - 마법사 starterSkills 는 둘 다 광역이다. 기본 풀 5~7개, 세부 직업 풀 2~4개를 유지한다.
 *
 * v0.7: SubJobDef.adaptationBonus (맵 적응도 가산). 지금은 mage_ice { glacier: 25 } 만 쓴다.
 *  분화 적용(statBonus + adaptationBonus + grantedSkills)은 growth/choices.ts 의 applySubJob 하나로만 한다
 *  (플레이어 선택지·생성 상대팀·몬스터 어느 경로든). 이 파일은 skills.ts 가 import 하므로 스킬 슬롯 규칙을 여기 둘 수 없다.
 */
import type { BaseStatKey, JobDef, MainJob, SubJobDef, SubJobId } from '../types';
import { MAIN_JOBS } from '../types';

type StatPartial = Partial<Record<BaseStatKey, number>>;

/** 근접 직업 기본 사거리 */
export const MELEE_RANGE = 1.6;

// ───────────────────────── 세부 직업 ─────────────────────────

const SWORDSMAN_SUBJOBS: SubJobDef[] = [
  {
    id: 'swordsman_great',
    name: '대검사',
    desc: '거대한 검으로 광역 피해를 입힌다. 근력과 체력이 크게 오르지만 민첩이 둔해진다.',
    statBonus: { strength: 8, vitality: 6, agility: -4 },
    growthMod: { strength: 1.2, vitality: 1.15, agility: 0.85 },
    grantedSkills: ['swordsman_great_cleave'],
    skillPool: ['swordsman_great_earthbreak'],
  },
  {
    id: 'swordsman_swift',
    name: '쾌검사',
    desc: '빠른 연속 공격으로 몰아친다. 민첩과 회피가 오른다.',
    statBonus: { agility: 8, evasion: 6, moveSpeed: 4 },
    growthMod: { agility: 1.25, evasion: 1.15, moveSpeed: 1.1 },
    grantedSkills: ['swordsman_swift_flurry'],
    skillPool: ['swordsman_swift_step'],
  },
  {
    id: 'swordsman_magic',
    name: '마검사',
    desc: '검에 마력을 부여해 이능 피해를 함께 입힌다. 마력과 저항이 오른다.',
    statBonus: { magicPower: 14, resistance: 6, castSpeed: 4 },
    growthMod: { magicPower: 1.4, resistance: 1.15, castSpeed: 1.1 },
    grantedSkills: ['swordsman_magic_blade'],
    skillPool: ['swordsman_magic_ward'],
  },
];

const TANK_SUBJOBS: SubJobDef[] = [
  {
    id: 'tank_wall',
    name: '철벽',
    desc: '방패로 모든 공격을 받아낸다. 방어기술과 체력이 크게 오른다.',
    statBonus: { defenseTech: 10, vitality: 6, moveSpeed: -3 },
    growthMod: { defenseTech: 1.3, vitality: 1.15, moveSpeed: 0.9 },
    grantedSkills: ['tank_wall_guard'],
    skillPool: ['tank_wall_stance'],
  },
  {
    id: 'tank_thorns',
    name: '가시갑옷',
    desc: '받은 피해를 공격자에게 되돌려준다. 체력과 근력이 오른다.',
    statBonus: { vitality: 6, strength: 6, composure: 4 },
    growthMod: { vitality: 1.15, strength: 1.15, composure: 1.1 },
    grantedSkills: ['tank_thorns_armor'],
    skillPool: ['tank_thorns_burst'],
  },
  {
    id: 'tank_taunt',
    name: '도발자',
    desc: '적의 어그로를 자신에게 집중시킨다. 용기와 침착, 저항이 오른다.',
    statBonus: { courage: 10, composure: 6, resistance: 6 },
    growthMod: { courage: 1.3, composure: 1.15, resistance: 1.15 },
    grantedSkills: ['tank_taunt_roar'],
    skillPool: ['tank_taunt_presence'],
  },
];

const BERSERKER_SUBJOBS: SubJobDef[] = [
  {
    id: 'berserker_frenzy',
    name: '광전사',
    desc: '체력이 낮을수록 강해진다. 근력과 용기, 치명이 오른다.',
    statBonus: { strength: 8, courage: 8, critical: 5 },
    growthMod: { strength: 1.25, courage: 1.2, critical: 1.1 },
    grantedSkills: ['berserker_frenzy_strike'],
    skillPool: ['berserker_frenzy_will'],
  },
  {
    id: 'berserker_blood',
    name: '피의 계약자',
    desc: '피해를 입힌 만큼 체력을 흡수한다. 체력과 근력이 오른다.',
    statBonus: { vitality: 8, strength: 5, stamina: 4 },
    growthMod: { vitality: 1.25, strength: 1.1, stamina: 1.1 },
    grantedSkills: ['berserker_blood_pact'],
    skillPool: ['berserker_blood_rite'],
  },
  {
    id: 'berserker_breaker',
    name: '파괴자',
    desc: '적의 방어를 무시하고 부순다. 근력과 명중이 오른다.',
    statBonus: { strength: 10, accuracy: 6, mastery: 4 },
    growthMod: { strength: 1.3, accuracy: 1.15, mastery: 1.1 },
    grantedSkills: ['berserker_breaker_crush'],
    skillPool: ['berserker_breaker_armor_break'],
  },
];

const ASSASSIN_SUBJOBS: SubJobDef[] = [
  {
    id: 'assassin_shadow',
    name: '그림자 암살자',
    desc: '은신에 특화되어 후방의 적을 처형한다. 민첩과 치명이 오른다.',
    statBonus: { agility: 8, critical: 8, focus: 4 },
    growthMod: { agility: 1.2, critical: 1.25, focus: 1.1 },
    grantedSkills: ['assassin_shadow_veil'],
    skillPool: ['assassin_shadow_execute'],
  },
  {
    id: 'assassin_poison',
    name: '독 암살자',
    desc: '독으로 지속 피해를 입힌다. 숙련도와 명중이 오른다.',
    statBonus: { mastery: 8, accuracy: 6, focus: 4 },
    growthMod: { mastery: 1.25, accuracy: 1.15, focus: 1.1 },
    grantedSkills: ['assassin_poison_blade'],
    skillPool: ['assassin_poison_cloud'],
  },
  {
    id: 'assassin_mirage',
    name: '환영 암살자',
    desc: '환영으로 적의 공격을 흘려보낸다. 회피와 이동속도가 오른다.',
    statBonus: { evasion: 10, moveSpeed: 6, agility: 4 },
    growthMod: { evasion: 1.3, moveSpeed: 1.15, agility: 1.1 },
    grantedSkills: ['assassin_mirage_clone'],
    skillPool: ['assassin_mirage_flicker'],
  },
];

const ARCHER_SUBJOBS: SubJobDef[] = [
  {
    id: 'archer_rapid',
    name: '속사 궁수',
    desc: '쉴 새 없이 화살을 퍼붓는다. 민첩과 명중이 오른다.',
    statBonus: { agility: 10, accuracy: 5, stamina: 4 },
    growthMod: { agility: 1.3, accuracy: 1.1, stamina: 1.1 },
    grantedSkills: ['archer_rapid_barrage'],
    skillPool: ['archer_rapid_reflex'],
  },
  {
    id: 'archer_precise',
    name: '정밀 궁수',
    desc: '급소를 노려 치명타를 낸다. 집중과 치명이 오른다.',
    statBonus: { focus: 8, critical: 8, accuracy: 4 },
    growthMod: { focus: 1.25, critical: 1.25, accuracy: 1.1 },
    grantedSkills: ['archer_precise_shot'],
    skillPool: ['archer_precise_focus'],
  },
  {
    id: 'archer_trap',
    name: '함정 궁수',
    desc: '설치물과 함정으로 전장을 통제한다. 판단력과 숙련도가 오른다.',
    statBonus: { judgment: 8, mastery: 8, mana: 6 },
    growthMod: { judgment: 1.2, mastery: 1.2, mana: 1.15 },
    grantedSkills: ['archer_trap_turret'],
    skillPool: ['archer_trap_snare'],
  },
];

const SNIPER_SUBJOBS: SubJobDef[] = [
  {
    id: 'sniper_pierce',
    name: '관통 저격수',
    desc: '직선상의 모든 적을 꿰뚫는다. 근력과 명중이 오른다.',
    statBonus: { strength: 8, accuracy: 6, focus: 4 },
    growthMod: { strength: 1.25, accuracy: 1.15, focus: 1.1 },
    grantedSkills: ['sniper_pierce_shot'],
    skillPool: ['sniper_pierce_heavy'],
  },
  {
    id: 'sniper_magic',
    name: '마탄 저격수',
    desc: '마력을 담은 탄환을 쏜다. 마력이 크게 오른다.',
    statBonus: { magicPower: 20, mana: 8, castSpeed: 6 },
    growthMod: { magicPower: 1.5, mana: 1.2, castSpeed: 1.15 },
    grantedSkills: ['sniper_magic_bullet'],
    skillPool: ['sniper_magic_hex'],
  },
  {
    id: 'sniper_watcher',
    name: '감시자',
    desc: '넓은 시야로 적을 표시하고 약화시킨다. 판단력과 집중이 오른다.',
    statBonus: { judgment: 10, focus: 6, accuracy: 6 },
    growthMod: { judgment: 1.3, focus: 1.15, accuracy: 1.15 },
    grantedSkills: ['sniper_watcher_mark'],
    skillPool: ['sniper_watcher_vision'],
  },
];

const MAGE_SUBJOBS: SubJobDef[] = [
  {
    id: 'mage_fire',
    name: '화염 마법사',
    desc: '광역 폭딜과 화상. 마력이 크게 오른다.',
    statBonus: { magicPower: 10, mana: 5, courage: 4 },
    growthMod: { magicPower: 1.3, mana: 1.1, courage: 1.1 },
    grantedSkills: ['mage_fire_fireball'],
    skillPool: ['mage_fire_storm', 'mage_fire_rain', 'mage_fire_armor'],
  },
  {
    id: 'mage_lightning',
    name: '전기 마법사',
    desc: '연쇄 번개와 마비. 시전속도와 집중이 오른다.',
    statBonus: { castSpeed: 10, focus: 6, magicPower: 4 },
    growthMod: { castSpeed: 1.3, focus: 1.15, magicPower: 1.1 },
    grantedSkills: ['mage_lightning_chain'],
    skillPool: ['mage_lightning_field', 'mage_lightning_storm'],
  },
  {
    id: 'mage_ice',
    name: '냉기 마법사',
    desc: '둔화와 빙결로 전장을 얼린다. 침착과 저항이 오르고 빙하에 익숙해진다.',
    statBonus: { composure: 8, resistance: 8, magicPower: 4 },
    growthMod: { composure: 1.2, resistance: 1.2, magicPower: 1.1 },
    grantedSkills: ['mage_ice_shard'],
    skillPool: ['mage_ice_nova', 'mage_ice_blizzard'],
    // v0.7: 분화 시 빙하 적응도 +25 (상한 100). 눈보라 피해 배율(hazardAdaptationMult)에 직접 반영된다.
    adaptationBonus: { glacier: 25 },
  },
];

const SUMMONER_SUBJOBS: SubJobDef[] = [
  {
    id: 'summoner_beast',
    name: '야수 소환사',
    desc: '근접 야수를 여럿 소환한다. 체력과 근력이 오른다.',
    statBonus: { vitality: 8, strength: 8, courage: 4 },
    growthMod: { vitality: 1.2, strength: 1.3, courage: 1.1 },
    grantedSkills: ['summoner_beast_pack'],
    skillPool: ['summoner_beast_fury'],
  },
  {
    id: 'summoner_spirit',
    name: '정령 소환사',
    desc: '원거리 정령을 소환한다. 마력과 마력회복이 오른다.',
    statBonus: { magicPower: 10, manaRegen: 8, castSpeed: 4 },
    growthMod: { magicPower: 1.3, manaRegen: 1.2, castSpeed: 1.1 },
    grantedSkills: ['summoner_spirit_call'],
    skillPool: ['summoner_spirit_link'],
  },
  {
    id: 'summoner_necro',
    name: '사령술사',
    desc: '해골 병사를 다수 일으킨다. 마력량과 저항이 오른다.',
    statBonus: { mana: 10, resistance: 6, magicPower: 6 },
    growthMod: { mana: 1.25, resistance: 1.15, magicPower: 1.15 },
    grantedSkills: ['summoner_necro_raise'],
    skillPool: ['summoner_necro_curse'],
  },
];

const HEALER_SUBJOBS: SubJobDef[] = [
  {
    id: 'healer_priest',
    name: '신관',
    desc: '직접 회복에 특화. 마력과 시전속도가 오른다.',
    statBonus: { magicPower: 10, castSpeed: 8, mana: 4 },
    growthMod: { magicPower: 1.3, castSpeed: 1.2, mana: 1.1 },
    grantedSkills: ['healer_priest_great_heal'],
    skillPool: ['healer_priest_purify'],
  },
  {
    id: 'healer_druid',
    name: '드루이드',
    desc: '지속 회복과 자연의 힘. 마력회복과 체력이 오른다.',
    statBonus: { manaRegen: 10, vitality: 6, magicPower: 5 },
    growthMod: { manaRegen: 1.3, vitality: 1.15, magicPower: 1.1 },
    grantedSkills: ['healer_druid_regrowth'],
    skillPool: ['healer_druid_thorns'],
  },
  {
    id: 'healer_ward',
    name: '결계사',
    desc: '보호막과 버프로 아군을 지킨다. 저항과 협동이 오른다.',
    statBonus: { resistance: 10, teamwork: 8, composure: 4 },
    growthMod: { resistance: 1.3, teamwork: 1.2, composure: 1.1 },
    grantedSkills: ['healer_ward_barrier'],
    skillPool: ['healer_ward_empower'],
  },
];

// ───────────────────────── 메인 직업 ─────────────────────────

/** 스탯 프로필과 성장 계수를 함께 정의하기 위한 도우미. growth 는 프로필 평균에서 자동 유도한 뒤 override 로 덮는다. */
function growthFromProfile(profile: StatPartial, override: StatPartial = {}): StatPartial {
  const out: StatPartial = {};
  for (const key of Object.keys(profile) as BaseStatKey[]) {
    const avg = profile[key]!;
    // 평균 40 → 1.0, 70 → 1.45, 20 → 0.7 (0.5~1.5 로 클램프)
    const g = Math.min(1.5, Math.max(0.5, Math.round((1 + (avg - 40) * 0.015) * 100) / 100));
    out[key] = g;
  }
  for (const key of Object.keys(override) as BaseStatKey[]) out[key] = override[key];
  return out;
}

const SWORDSMAN_PROFILE: StatPartial = {
  vitality: 52, strength: 60, agility: 52, moveSpeed: 48, stamina: 50,
  judgment: 45, courage: 52, composure: 45, teamwork: 45, focus: 45,
  accuracy: 52, evasion: 42, defenseTech: 50, critical: 45, mastery: 52,
  magicPower: 28, mana: 32, manaRegen: 32, castSpeed: 35, resistance: 40,
};
const TANK_PROFILE: StatPartial = {
  vitality: 68, strength: 50, agility: 32, moveSpeed: 35, stamina: 60,
  judgment: 42, courage: 65, composure: 58, teamwork: 55, focus: 35,
  accuracy: 42, evasion: 28, defenseTech: 66, critical: 28, mastery: 40,
  magicPower: 20, mana: 35, manaRegen: 35, castSpeed: 30, resistance: 52,
};
const BERSERKER_PROFILE: StatPartial = {
  vitality: 60, strength: 68, agility: 48, moveSpeed: 46, stamina: 50,
  judgment: 32, courage: 72, composure: 30, teamwork: 35, focus: 42,
  accuracy: 50, evasion: 35, defenseTech: 40, critical: 58, mastery: 45,
  magicPower: 22, mana: 28, manaRegen: 30, castSpeed: 30, resistance: 35,
};
const ASSASSIN_PROFILE: StatPartial = {
  vitality: 46, strength: 50, agility: 68, moveSpeed: 62, stamina: 42,
  judgment: 52, courage: 40, composure: 42, teamwork: 32, focus: 60,
  accuracy: 55, evasion: 62, defenseTech: 30, critical: 62, mastery: 50,
  magicPower: 25, mana: 32, manaRegen: 30, castSpeed: 40, resistance: 35,
};
const ARCHER_PROFILE: StatPartial = {
  vitality: 40, strength: 52, agility: 58, moveSpeed: 50, stamina: 48,
  judgment: 50, courage: 40, composure: 48, teamwork: 48, focus: 52,
  accuracy: 62, evasion: 45, defenseTech: 32, critical: 50, mastery: 50,
  magicPower: 25, mana: 32, manaRegen: 32, castSpeed: 40, resistance: 38,
};
const SNIPER_PROFILE: StatPartial = {
  vitality: 32, strength: 55, agility: 42, moveSpeed: 40, stamina: 42,
  judgment: 55, courage: 35, composure: 58, teamwork: 38, focus: 68,
  accuracy: 70, evasion: 38, defenseTech: 26, critical: 65, mastery: 52,
  magicPower: 28, mana: 32, manaRegen: 30, castSpeed: 45, resistance: 35,
};
const MAGE_PROFILE: StatPartial = {
  vitality: 32, strength: 22, agility: 38, moveSpeed: 38, stamina: 36,
  judgment: 55, courage: 35, composure: 50, teamwork: 45, focus: 55,
  accuracy: 45, evasion: 35, defenseTech: 25, critical: 40, mastery: 50,
  magicPower: 68, mana: 65, manaRegen: 60, castSpeed: 62, resistance: 52,
};
const SUMMONER_PROFILE: StatPartial = {
  vitality: 40, strength: 25, agility: 35, moveSpeed: 38, stamina: 42,
  judgment: 55, courage: 38, composure: 50, teamwork: 58, focus: 45,
  accuracy: 42, evasion: 35, defenseTech: 30, critical: 35, mastery: 55,
  magicPower: 58, mana: 68, manaRegen: 65, castSpeed: 50, resistance: 50,
};
const HEALER_PROFILE: StatPartial = {
  vitality: 42, strength: 22, agility: 36, moveSpeed: 40, stamina: 45,
  judgment: 58, courage: 38, composure: 60, teamwork: 65, focus: 45,
  accuracy: 40, evasion: 38, defenseTech: 30, critical: 28, mastery: 55,
  magicPower: 60, mana: 60, manaRegen: 60, castSpeed: 58, resistance: 58,
};

export const JOBS: Record<MainJob, JobDef> = {
  swordsman: {
    id: 'swordsman',
    name: '검사',
    role: 'melee_dps',
    desc: '근접 딜/브루저. 균형 잡힌 스탯으로 전열과 중열을 오간다.',
    baseRange: MELEE_RANGE,
    attackSchool: 'phys',
    statProfile: SWORDSMAN_PROFILE,
    growth: growthFromProfile(SWORDSMAN_PROFILE, { strength: 1.35, agility: 1.2, defenseTech: 1.15 }),
    hpBonus: 60,
    starterSkills: ['swordsman_slash', 'swordsman_iron_stance'],
    skillPool: ['swordsman_slash', 'swordsman_charge', 'swordsman_whirlwind', 'swordsman_iron_stance', 'swordsman_blade_mastery'],
    subJobs: SWORDSMAN_SUBJOBS,
  },
  tank: {
    id: 'tank',
    name: '탱커',
    role: 'tank',
    desc: '전열 방어, 어그로. 전진해 적을 붙잡고 아군을 지킨다.',
    baseRange: MELEE_RANGE,
    attackSchool: 'phys',
    statProfile: TANK_PROFILE,
    growth: growthFromProfile(TANK_PROFILE, { vitality: 1.5, defenseTech: 1.45, courage: 1.35, agility: 0.7, magicPower: 0.5 }),
    hpBonus: 150,
    starterSkills: ['tank_bash', 'tank_endurance'],
    skillPool: ['tank_bash', 'tank_shockwave', 'tank_fortify', 'tank_shield_wall', 'tank_endurance', 'tank_bulwark'],
    subJobs: TANK_SUBJOBS,
  },
  berserker: {
    id: 'berserker',
    name: '버서커',
    role: 'melee_dps',
    desc: '근접 폭딜, 체력 소모형. 후퇴하지 않고 끝까지 싸운다.',
    baseRange: MELEE_RANGE,
    attackSchool: 'phys',
    statProfile: BERSERKER_PROFILE,
    growth: growthFromProfile(BERSERKER_PROFILE, { strength: 1.5, courage: 1.45, critical: 1.3, judgment: 0.7, composure: 0.7, magicPower: 0.5 }),
    hpBonus: 90,
    starterSkills: ['berserker_smash', 'berserker_thick_skin'],
    skillPool: ['berserker_rage', 'berserker_smash', 'berserker_ground_slam', 'berserker_leap', 'berserker_reckless', 'berserker_thick_skin'],
    subJobs: BERSERKER_SUBJOBS,
  },
  assassin: {
    id: 'assassin',
    name: '암살자',
    role: 'assassin',
    desc: '은신, 후방 침투, 단일 폭딜. 적의 딜러를 노린다.',
    baseRange: MELEE_RANGE,
    attackSchool: 'phys',
    statProfile: ASSASSIN_PROFILE,
    growth: growthFromProfile(ASSASSIN_PROFILE, { agility: 1.5, evasion: 1.4, critical: 1.4, focus: 1.3, vitality: 0.8, teamwork: 0.7 }),
    // v0.5 보정: 100 → 140. 10일차 암살자 승률 36% (하한 35%)·생존율 19% 로 전 직업 최저였다
    hpBonus: 140,
    starterSkills: ['assassin_ambush', 'assassin_smoke'],
    skillPool: ['assassin_stealth', 'assassin_ambush', 'assassin_smoke_daggers', 'assassin_shadowstep', 'assassin_smoke', 'assassin_lethal'],
    subJobs: ASSASSIN_SUBJOBS,
  },
  archer: {
    id: 'archer',
    name: '궁수',
    role: 'ranged_dps',
    desc: '중거리 지속 딜. 안정적인 사거리에서 계속 화살을 쏜다.',
    baseRange: 8,
    attackSchool: 'phys',
    statProfile: ARCHER_PROFILE,
    growth: growthFromProfile(ARCHER_PROFILE, { accuracy: 1.4, agility: 1.3, critical: 1.2, defenseTech: 0.8, magicPower: 0.6 }),
    hpBonus: 0,
    starterSkills: ['archer_power_shot', 'archer_quick_draw'],
    skillPool: ['archer_power_shot', 'archer_multishot', 'archer_arrow_rain', 'archer_retreat_shot', 'archer_eagle_eye', 'archer_quick_draw'],
    subJobs: ARCHER_SUBJOBS,
  },
  sniper: {
    id: 'sniper',
    name: '저격수',
    role: 'ranged_dps',
    desc: '장거리 단발 고화력. 최대 사거리를 유지하며 한 발에 승부한다.',
    baseRange: 12,
    attackSchool: 'phys',
    statProfile: SNIPER_PROFILE,
    growth: growthFromProfile(SNIPER_PROFILE, { accuracy: 1.5, critical: 1.45, focus: 1.4, vitality: 0.7, defenseTech: 0.7, magicPower: 0.6 }),
    hpBonus: -30,
    starterSkills: ['sniper_snipe', 'sniper_steady'],
    skillPool: ['sniper_snipe', 'sniper_kneecap', 'sniper_explosive_shot', 'sniper_finisher', 'sniper_steady', 'sniper_long_barrel'],
    subJobs: SNIPER_SUBJOBS,
  },
  mage: {
    id: 'mage',
    name: '마법사',
    role: 'mage',
    desc: '원거리 광역/제어. 마력으로 다수의 적을 태우고 얼리고 마비시킨다.',
    baseRange: 7,
    attackSchool: 'magic',
    statProfile: MAGE_PROFILE,
    growth: growthFromProfile(MAGE_PROFILE, { magicPower: 1.5, mana: 1.4, castSpeed: 1.4, manaRegen: 1.3, strength: 0.5, defenseTech: 0.7 }),
    hpBonus: -20,
    // v0.6: 시작 스킬은 광역 2종 중 하나. 분화 전에도 광역 장판(비전 폭풍·메테오)을 쓸 수 있게 기본 풀에 넣는다
    starterSkills: ['mage_blast', 'mage_arcane_storm'],
    skillPool: ['mage_bolt', 'mage_blast', 'mage_arcane_storm', 'mage_meteor', 'mage_barrier', 'mage_meditation', 'mage_arcane_mind'],
    subJobs: MAGE_SUBJOBS,
  },
  summoner: {
    id: 'summoner',
    name: '소환사',
    role: 'summoner',
    desc: '소환물로 전선을 형성한다. 본체는 후방에서 마력을 관리한다.',
    baseRange: 6,
    attackSchool: 'magic',
    statProfile: SUMMONER_PROFILE,
    growth: growthFromProfile(SUMMONER_PROFILE, { mana: 1.45, manaRegen: 1.4, magicPower: 1.3, teamwork: 1.3, strength: 0.6, agility: 0.8 }),
    hpBonus: 0,
    starterSkills: ['summoner_call_beast', 'summoner_bond'],
    skillPool: ['summoner_call_beast', 'summoner_drain', 'summoner_spirit_burst', 'summoner_empower', 'summoner_bond', 'summoner_deep_well'],
    subJobs: SUMMONER_SUBJOBS,
  },
  healer: {
    id: 'healer',
    name: '힐러',
    role: 'healer',
    desc: '회복, 지원. 아군 뒤에서 체력이 낮은 아군을 회복한다.',
    baseRange: 6,
    attackSchool: 'magic',
    statProfile: HEALER_PROFILE,
    growth: growthFromProfile(HEALER_PROFILE, { magicPower: 1.4, teamwork: 1.45, composure: 1.3, castSpeed: 1.3, strength: 0.5, critical: 0.6 }),
    hpBonus: 20,
    starterSkills: ['healer_heal', 'healer_blessing'],
    skillPool: ['healer_heal', 'healer_group_heal', 'healer_smite', 'healer_judgment', 'healer_blessing', 'healer_serenity'],
    subJobs: HEALER_SUBJOBS,
  },
};

// ───────────────────────── 세부 직업 조회 ─────────────────────────

function buildSubJobs(): Record<SubJobId, SubJobDef> {
  const out: Record<SubJobId, SubJobDef> = {};
  for (const job of MAIN_JOBS) {
    for (const sub of JOBS[job].subJobs) out[sub.id] = sub;
  }
  return out;
}

export const SUBJOBS: Record<SubJobId, SubJobDef> = buildSubJobs();

/** 세부 직업 → 메인 직업 역참조 */
const SUBJOB_OWNER: Record<SubJobId, MainJob> = (() => {
  const out: Record<SubJobId, MainJob> = {};
  for (const job of MAIN_JOBS) {
    for (const sub of JOBS[job].subJobs) out[sub.id] = job;
  }
  return out;
})();

export function getSubJob(id: SubJobId): SubJobDef {
  const def = SUBJOBS[id];
  if (!def) throw new Error(`알 수 없는 세부 직업: ${id}`);
  return def;
}

export function jobOfSubJob(id: SubJobId): MainJob {
  const job = SUBJOB_OWNER[id];
  if (!job) throw new Error(`알 수 없는 세부 직업: ${id}`);
  return job;
}

/** 메인 직업의 세부 직업 id 목록 (표시 순서 고정) */
export function subJobIdsOf(job: MainJob): SubJobId[] {
  return JOBS[job].subJobs.map((s) => s.id);
}
