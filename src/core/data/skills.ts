/**
 * 스킬 정의 (GDD §7.4). 메인 직업당 5개 + 세부 직업당 2~3개.
 *
 * 규약:
 *  - damage.coef 는 공격력 배율 (액티브 1.2~3.0).
 *  - buff/debuff 의 pct 는 항상 양수. buff 는 +pct%, debuff 는 -pct% 로 해석한다.
 *  - status.value: slow = 감소 비율(0~1), burn/poison/regen = 초당 절대량, shield = 흡수량, lifesteal/reflect = 비율.
 *  - passiveMods 는 파생 수치 % 보정 (stats.computeDerived 가 합산).
 */
import type { Character, MainJob, SkillDef, SkillEffect, SummonUnitId } from '../types';
import { JOBS, SUBJOBS } from './jobs';

// ───────────────────────── 소환물 ─────────────────────────

export const SUMMON_UNITS: Record<
  SummonUnitId,
  { name: string; hpCoef: number; atkCoef: number; range: number; moveSpeed: number; school: 'phys' | 'magic'; attackIntervalSec: number }
> = {
  beast: { name: '야수', hpCoef: 0.45, atkCoef: 0.6, range: 1.5, moveSpeed: 4.0, school: 'phys', attackIntervalSec: 1.0 },
  spirit: { name: '정령', hpCoef: 0.3, atkCoef: 0.5, range: 6, moveSpeed: 3.2, school: 'magic', attackIntervalSec: 1.2 },
  skeleton: { name: '해골 병사', hpCoef: 0.35, atkCoef: 0.45, range: 1.5, moveSpeed: 3.0, school: 'phys', attackIntervalSec: 1.1 },
  turret: { name: '화살탑', hpCoef: 0.25, atkCoef: 0.7, range: 7, moveSpeed: 0, school: 'phys', attackIntervalSec: 1.0 },
};

// ───────────────────────── 정의 도우미 ─────────────────────────

type ActiveSpec = {
  id: string;
  name: string;
  desc: string;
  job: MainJob;
  magic?: SkillDef['magic'];
  cd: number;
  mp: number;
  cast?: number;
  range: number;
  target: SkillDef['target'];
  radius?: number;
  effects: SkillEffect[];
  ai?: SkillDef['aiCondition'];
  cost: number;
};

function active(s: ActiveSpec): SkillDef {
  return {
    id: s.id,
    name: s.name,
    desc: s.desc,
    type: 'active',
    job: s.job,
    magic: s.magic ?? 'none',
    cooldownSec: s.cd,
    mpCost: s.mp,
    castTimeSec: s.cast ?? 0,
    range: s.range,
    target: s.target,
    radius: s.radius,
    effects: s.effects,
    aiCondition: s.ai,
    cost: s.cost,
  };
}

type PassiveSpec = {
  id: string;
  name: string;
  desc: string;
  job: MainJob;
  magic?: SkillDef['magic'];
  mods?: SkillDef['passiveMods'];
  status?: SkillDef['passiveStatus'];
  cost: number;
};

function passive(s: PassiveSpec): SkillDef {
  return {
    id: s.id,
    name: s.name,
    desc: s.desc,
    type: 'passive',
    job: s.job,
    magic: s.magic ?? 'none',
    cooldownSec: 0,
    mpCost: 0,
    castTimeSec: 0,
    range: 0,
    target: 'self',
    effects: [],
    passiveMods: s.mods,
    passiveStatus: s.status,
    cost: s.cost,
  };
}

const MELEE = 1.6;

// ───────────────────────── 스킬 목록 (정의 순서 고정) ─────────────────────────

const SKILL_LIST: SkillDef[] = [
  // ══════════ 검사 ══════════
  active({ id: 'swordsman_slash', name: '베기', desc: '적 하나를 베어 물리 공격력의 160% 피해를 입힌다.', job: 'swordsman', cd: 6, mp: 10, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 1.6 }], cost: 60 }),
  active({ id: 'swordsman_charge', name: '돌진', desc: '6칸을 돌진해 적에게 물리 공격력의 130% 피해를 입힌다. 대상이 사거리 밖일 때 사용.', job: 'swordsman', cd: 10, mp: 15, range: 7, target: 'enemy', effects: [{ kind: 'dash', distance: 6 }, { kind: 'damage', school: 'phys', coef: 1.3 }], ai: 'out_of_range', cost: 80 }),
  active({ id: 'swordsman_whirlwind', name: '회전 베기', desc: '반경 2.5 안의 적 모두에게 물리 공격력의 140% 피해. 적이 2명 이상 모였을 때 사용.', job: 'swordsman', cd: 12, mp: 20, range: MELEE, target: 'enemy_area', radius: 2.5, effects: [{ kind: 'damage', school: 'phys', coef: 1.4 }], ai: 'enemies_clustered_2', cost: 100 }),
  passive({ id: 'swordsman_iron_stance', name: '철의 자세', desc: '물리 방어 +10%, 최대 HP +5%.', job: 'swordsman', mods: { physDef: 10, maxHp: 5 }, cost: 70 }),
  passive({ id: 'swordsman_blade_mastery', name: '검술 숙련', desc: '물리 공격 +8%, 적중 +5%.', job: 'swordsman', mods: { physAtk: 8, accuracy: 5 }, cost: 80 }),
  // 대검사
  active({ id: 'swordsman_great_cleave', name: '대검 휘두르기', desc: '0.5초 시전 후 반경 3 안의 적에게 물리 공격력의 220% 피해.', job: 'swordsman', cd: 14, mp: 25, cast: 0.5, range: MELEE, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'phys', coef: 2.2 }], ai: 'enemies_clustered_2', cost: 120 }),
  active({ id: 'swordsman_great_earthbreak', name: '지각 붕괴', desc: '1초 시전 후 반경 3 안의 적에게 물리 공격력의 180% 피해를 주고 50% 확률로 1초 기절.', job: 'swordsman', cd: 18, mp: 35, cast: 1.0, range: MELEE, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'phys', coef: 1.8 }, { kind: 'status', status: 'stun', durationSec: 1, chance: 0.5 }], ai: 'enemies_clustered_2', cost: 140 }),
  // 쾌검사
  active({ id: 'swordsman_swift_flurry', name: '연속 베기', desc: '적 하나를 빠르게 여러 번 베어 물리 공격력의 240% 피해.', job: 'swordsman', cd: 8, mp: 15, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 2.4 }], cost: 120 }),
  passive({ id: 'swordsman_swift_step', name: '질풍보', desc: '공격 속도 +12%, 회피 +8%.', job: 'swordsman', mods: { atkSpeed: 12, evasion: 8 }, cost: 100 }),
  // 마검사
  active({ id: 'swordsman_magic_blade', name: '마력 참격', desc: '검에 마력을 실어 이능 공격력의 200% 이능 피해를 입힌다.', job: 'swordsman', cd: 9, mp: 20, range: 2.5, target: 'enemy', effects: [{ kind: 'damage', school: 'magic', coef: 2.0 }], cost: 120 }),
  passive({ id: 'swordsman_magic_ward', name: '마검 결계', desc: '이능 방어 +15%, 이능 공격 +10%.', job: 'swordsman', mods: { magDef: 15, magAtk: 10 }, cost: 100 }),

  // ══════════ 탱커 ══════════
  active({ id: 'tank_bash', name: '방패 타격', desc: '적 하나에게 물리 공격력의 120% 피해를 주고 60% 확률로 1초 기절.', job: 'tank', cd: 10, mp: 15, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 1.2 }, { kind: 'status', status: 'stun', durationSec: 1, chance: 0.6 }], cost: 70 }),
  active({ id: 'tank_fortify', name: '요새화', desc: '6초 동안 물리 방어 +30%, 이능 방어 +20%. HP 50% 이하일 때 사용.', job: 'tank', cd: 15, mp: 20, range: 0, target: 'self', effects: [{ kind: 'buff', stat: 'physDef', pct: 30, durationSec: 6 }, { kind: 'buff', stat: 'magDef', pct: 20, durationSec: 6 }], ai: 'self_hp_below_50', cost: 80 }),
  active({ id: 'tank_shield_wall', name: '방벽', desc: '0.5초 시전 후 반경 4 안의 아군에게 380 피해를 흡수하는 보호막 (6초).', job: 'tank', cd: 18, mp: 30, cast: 0.5, range: 0, target: 'ally_area', radius: 4, effects: [{ kind: 'status', status: 'shield', durationSec: 6, value: 380 }], cost: 110 }),
  passive({ id: 'tank_endurance', name: '인내', desc: '최대 HP +12%, 물리 방어 +5%.', job: 'tank', mods: { maxHp: 12, physDef: 5 }, cost: 70 }),
  passive({ id: 'tank_bulwark', name: '견고', desc: '물리 방어 +10%, 이능 방어 +10%.', job: 'tank', mods: { physDef: 10, magDef: 10 }, cost: 90 }),
  // 철벽
  active({ id: 'tank_wall_guard', name: '철벽 방어', desc: '5초 동안 600 피해를 흡수하는 보호막과 물리 방어 +25%. HP 50% 이하일 때 사용.', job: 'tank', cd: 14, mp: 20, range: 0, target: 'self', effects: [{ kind: 'status', status: 'shield', durationSec: 5, value: 600 }, { kind: 'buff', stat: 'physDef', pct: 25, durationSec: 5 }], ai: 'self_hp_below_50', cost: 120 }),
  passive({ id: 'tank_wall_stance', name: '수호 자세', desc: '물리 방어 +15%, 최대 HP +8%.', job: 'tank', mods: { physDef: 15, maxHp: 8 }, cost: 110 }),
  // 가시갑옷
  passive({ id: 'tank_thorns_armor', name: '가시 갑옷', desc: '받은 물리 피해의 25%를 공격자에게 반사한다. 물리 방어 +5%.', job: 'tank', mods: { physDef: 5 }, status: [{ status: 'reflect', value: 0.25 }], cost: 120 }),
  active({ id: 'tank_thorns_burst', name: '가시 폭발', desc: '반경 2.5 안의 적에게 물리 공격력의 150% 피해.', job: 'tank', cd: 12, mp: 20, range: MELEE, target: 'enemy_area', radius: 2.5, effects: [{ kind: 'damage', school: 'phys', coef: 1.5 }], ai: 'enemies_clustered_2', cost: 110 }),
  // 도발자
  active({ id: 'tank_taunt_roar', name: '도발의 포효', desc: '반경 5 안의 적을 4초 동안 도발해 자신만 공격하게 한다.', job: 'tank', cd: 12, mp: 20, range: 5, target: 'enemy_area', radius: 5, effects: [{ kind: 'status', status: 'taunt', durationSec: 4 }], cost: 120 }),
  passive({ id: 'tank_taunt_presence', name: '위압감', desc: '최대 HP +10%, 이능 방어 +8%.', job: 'tank', mods: { maxHp: 10, magDef: 8 }, cost: 100 }),

  // ══════════ 버서커 ══════════
  active({ id: 'berserker_rage', name: '분노', desc: '8초 동안 물리 공격 +25%, 공격 속도 +15%.', job: 'berserker', cd: 16, mp: 15, range: 0, target: 'self', effects: [{ kind: 'buff', stat: 'physAtk', pct: 25, durationSec: 8 }, { kind: 'buff', stat: 'atkSpeed', pct: 15, durationSec: 8 }], cost: 80 }),
  active({ id: 'berserker_smash', name: '강타', desc: '적 하나에게 물리 공격력의 200% 피해.', job: 'berserker', cd: 8, mp: 15, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 2.0 }], cost: 70 }),
  active({ id: 'berserker_leap', name: '도약', desc: '7칸을 도약해 적에게 물리 공격력의 140% 피해. 대상이 사거리 밖일 때 사용.', job: 'berserker', cd: 12, mp: 15, range: 8, target: 'enemy', effects: [{ kind: 'dash', distance: 7 }, { kind: 'damage', school: 'phys', coef: 1.4 }], ai: 'out_of_range', cost: 80 }),
  passive({ id: 'berserker_reckless', name: '무모함', desc: '물리 공격 +15%, 공격 속도 +5%.', job: 'berserker', mods: { physAtk: 15, atkSpeed: 5 }, cost: 90 }),
  passive({ id: 'berserker_thick_skin', name: '두꺼운 피부', desc: '최대 HP +10%.', job: 'berserker', mods: { maxHp: 10 }, cost: 60 }),
  // 광전사
  active({ id: 'berserker_frenzy_strike', name: '광기의 일격', desc: '물리 공격력의 160% 피해. 잃은 HP 1%당 피해 +2% (HP 50%면 +100%).', job: 'berserker', cd: 8, mp: 15, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 1.6, bonusPerMissingHpPct: 0.02 }], cost: 130 }),
  passive({ id: 'berserker_frenzy_will', name: '죽음의 의지', desc: '치명타 확률 +10%, 물리 공격 +10%.', job: 'berserker', mods: { critChance: 10, physAtk: 10 }, cost: 110 }),
  // 피의 계약자
  passive({ id: 'berserker_blood_pact', name: '피의 계약', desc: '입힌 피해의 20%만큼 HP를 회복한다.', job: 'berserker', status: [{ status: 'lifesteal', value: 0.2 }], cost: 130 }),
  active({ id: 'berserker_blood_rite', name: '피의 의식', desc: '6초 동안 물리 공격 +30%, 입힌 피해의 30% 흡혈. HP 50% 이하일 때 사용.', job: 'berserker', cd: 15, mp: 20, range: 0, target: 'self', effects: [{ kind: 'buff', stat: 'physAtk', pct: 30, durationSec: 6 }, { kind: 'status', status: 'lifesteal', durationSec: 6, value: 0.3 }], ai: 'self_hp_below_50', cost: 120 }),
  // 파괴자
  active({ id: 'berserker_breaker_crush', name: '갑옷 분쇄', desc: '적의 방어 60%를 무시하고 물리 공격력의 220% 피해.', job: 'berserker', cd: 10, mp: 20, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 2.2, ignoreDefPct: 0.6 }], cost: 130 }),
  active({ id: 'berserker_breaker_armor_break', name: '방어 붕괴', desc: '물리 공격력의 130% 피해를 주고 6초 동안 적의 물리 방어 -30%.', job: 'berserker', cd: 12, mp: 20, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 1.3 }, { kind: 'debuff', stat: 'physDef', pct: 30, durationSec: 6 }], cost: 110 }),

  // ══════════ 암살자 ══════════
  active({ id: 'assassin_stealth', name: '은신', desc: '3초 동안 은신해 타겟팅되지 않는다.', job: 'assassin', cd: 15, mp: 15, range: 0, target: 'self', effects: [{ kind: 'status', status: 'stealth', durationSec: 3 }], ai: 'not_stealthed', cost: 90 }),
  active({ id: 'assassin_ambush', name: '급습', desc: '물리 공격력의 200% 피해. 은신 중 사용하면 피해 +100%.', job: 'assassin', cd: 8, mp: 15, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 2.0, bonusIfStealth: 1.0 }], cost: 80 }),
  active({ id: 'assassin_shadowstep', name: '그림자 걸음', desc: '대상 방향으로 8칸 순간 이동. 대상이 사거리 밖일 때 사용.', job: 'assassin', cd: 10, mp: 10, range: 9, target: 'enemy', effects: [{ kind: 'dash', distance: 8 }], ai: 'out_of_range', cost: 70 }),
  passive({ id: 'assassin_smoke', name: '연막', desc: '회피 +15%.', job: 'assassin', mods: { evasion: 15 }, cost: 70 }),
  passive({ id: 'assassin_lethal', name: '급소 파악', desc: '치명타 확률 +10%, 치명타 배율 +15%.', job: 'assassin', mods: { critChance: 10, critMult: 15 }, cost: 90 }),
  // 그림자 암살자
  active({ id: 'assassin_shadow_veil', name: '그림자 장막', desc: '4초 동안 은신하고 이동 속도 +30%.', job: 'assassin', magic: 'shadow', cd: 14, mp: 15, range: 0, target: 'self', effects: [{ kind: 'status', status: 'stealth', durationSec: 4 }, { kind: 'buff', stat: 'moveSpeed', pct: 30, durationSec: 4 }], ai: 'not_stealthed', cost: 120 }),
  active({ id: 'assassin_shadow_execute', name: '그림자 처형', desc: 'HP 30% 이하의 적에게 물리 공격력의 280% 피해. 은신 중이면 +50%.', job: 'assassin', magic: 'shadow', cd: 12, mp: 25, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 2.8, bonusIfStealth: 0.5 }], ai: 'target_hp_below_30', cost: 140 }),
  // 독 암살자
  active({ id: 'assassin_poison_blade', name: '독칼', desc: '물리 공격력의 130% 피해와 6초 동안 초당 12 방어 무시 독 피해.', job: 'assassin', cd: 9, mp: 15, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 1.3 }, { kind: 'status', status: 'poison', durationSec: 6, value: 12 }], cost: 120 }),
  active({ id: 'assassin_poison_cloud', name: '독안개', desc: '반경 2.5 안의 적에게 물리 공격력의 100% 피해와 5초 동안 초당 10 독 피해.', job: 'assassin', cd: 14, mp: 25, range: 3, target: 'enemy_area', radius: 2.5, effects: [{ kind: 'damage', school: 'phys', coef: 1.0 }, { kind: 'status', status: 'poison', durationSec: 5, value: 10 }], ai: 'enemies_clustered_2', cost: 120 }),
  // 환영 암살자
  active({ id: 'assassin_mirage_clone', name: '환영 분신', desc: '5초 동안 회피 +40%, 공격 속도 +20%.', job: 'assassin', cd: 14, mp: 20, range: 0, target: 'self', effects: [{ kind: 'buff', stat: 'evasion', pct: 40, durationSec: 5 }, { kind: 'buff', stat: 'atkSpeed', pct: 20, durationSec: 5 }], cost: 120 }),
  passive({ id: 'assassin_mirage_flicker', name: '잔상', desc: '회피 +12%, 이동 속도 +8%.', job: 'assassin', mods: { evasion: 12, moveSpeed: 8 }, cost: 100 }),

  // ══════════ 궁수 ══════════
  active({ id: 'archer_power_shot', name: '강궁', desc: '적 하나에게 물리 공격력의 180% 피해.', job: 'archer', cd: 7, mp: 10, range: 8, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 1.8 }], cost: 60 }),
  active({ id: 'archer_multishot', name: '다중 사격', desc: '반경 2.5 안의 적 모두에게 물리 공격력의 130% 피해.', job: 'archer', cd: 12, mp: 20, range: 8, target: 'enemy_area', radius: 2.5, effects: [{ kind: 'damage', school: 'phys', coef: 1.3 }], ai: 'enemies_clustered_2', cost: 100 }),
  active({ id: 'archer_retreat_shot', name: '후퇴 사격', desc: '적을 3칸 밀어내며 물리 공격력의 120% 피해.', job: 'archer', cd: 12, mp: 15, range: 4, target: 'enemy', effects: [{ kind: 'knockback', distance: 3 }, { kind: 'damage', school: 'phys', coef: 1.2 }], cost: 80 }),
  passive({ id: 'archer_eagle_eye', name: '매의 눈', desc: '적중 +10%, 사거리 +8%.', job: 'archer', mods: { accuracy: 10, range: 8 }, cost: 80 }),
  passive({ id: 'archer_quick_draw', name: '빠른 장전', desc: '공격 속도 +12%.', job: 'archer', mods: { atkSpeed: 12 }, cost: 80 }),
  // 속사 궁수
  active({ id: 'archer_rapid_barrage', name: '화살 폭풍', desc: '적 하나에게 화살을 퍼부어 물리 공격력의 260% 피해.', job: 'archer', cd: 8, mp: 15, range: 8, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 2.6 }], cost: 120 }),
  passive({ id: 'archer_rapid_reflex', name: '속사 반사신경', desc: '공격 속도 +18%.', job: 'archer', mods: { atkSpeed: 18 }, cost: 110 }),
  // 정밀 궁수
  active({ id: 'archer_precise_shot', name: '정밀 사격', desc: '0.5초 조준 후 물리 공격력의 240% 피해.', job: 'archer', cd: 10, mp: 15, cast: 0.5, range: 9, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 2.4 }], cost: 120 }),
  passive({ id: 'archer_precise_focus', name: '정밀 조준', desc: '치명타 확률 +12%, 치명타 배율 +20%.', job: 'archer', mods: { critChance: 12, critMult: 20 }, cost: 120 }),
  // 함정 궁수
  active({ id: 'archer_trap_turret', name: '화살탑 설치', desc: '1초 설치 후 20초 동안 유지되는 화살탑 1기를 소환한다. 소환물이 없을 때 사용.', job: 'archer', cd: 20, mp: 30, cast: 1.0, range: 0, target: 'self', effects: [{ kind: 'summon', unit: 'turret', count: 1, durationSec: 20 }], ai: 'no_summons', cost: 130 }),
  active({ id: 'archer_trap_snare', name: '올가미 함정', desc: '반경 2 안의 적에게 물리 공격력의 100% 피해와 4초 동안 이동 속도 50% 감소.', job: 'archer', cd: 12, mp: 20, range: 8, target: 'enemy_area', radius: 2, effects: [{ kind: 'damage', school: 'phys', coef: 1.0 }, { kind: 'status', status: 'slow', durationSec: 4, value: 0.5 }], cost: 110 }),

  // ══════════ 저격수 ══════════
  active({ id: 'sniper_snipe', name: '저격', desc: '1.2초 조준 후 물리 공격력의 260% 피해.', job: 'sniper', cd: 9, mp: 20, cast: 1.2, range: 12, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 2.6 }], cost: 80 }),
  active({ id: 'sniper_kneecap', name: '무릎 쏘기', desc: '물리 공격력의 120% 피해와 3초 동안 이동 속도 40% 감소.', job: 'sniper', cd: 10, mp: 15, range: 12, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 1.2 }, { kind: 'status', status: 'slow', durationSec: 3, value: 0.4 }], cost: 70 }),
  active({ id: 'sniper_finisher', name: '마무리 사격', desc: 'HP 30% 이하의 적에게 0.8초 조준 후 물리 공격력의 300% 피해.', job: 'sniper', cd: 14, mp: 25, cast: 0.8, range: 12, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 3.0 }], ai: 'target_hp_below_30', cost: 110 }),
  passive({ id: 'sniper_steady', name: '안정된 호흡', desc: '적중 +12%, 치명타 확률 +6%.', job: 'sniper', mods: { accuracy: 12, critChance: 6 }, cost: 80 }),
  passive({ id: 'sniper_long_barrel', name: '장총신', desc: '사거리 +10%, 물리 공격 +6%.', job: 'sniper', mods: { range: 10, physAtk: 6 }, cost: 90 }),
  // 관통 저격수
  active({ id: 'sniper_pierce_shot', name: '관통탄', desc: '1초 조준 후 직선상의 모든 적(폭 1)에게 물리 공격력의 220% 피해.', job: 'sniper', cd: 12, mp: 25, cast: 1.0, range: 12, target: 'line', radius: 1, effects: [{ kind: 'damage', school: 'phys', coef: 2.2 }], cost: 130 }),
  active({ id: 'sniper_pierce_heavy', name: '중관통탄', desc: '1.2초 조준 후 직선상의 적(폭 1.2)에게 방어 40% 무시 물리 공격력의 200% 피해와 2칸 넉백.', job: 'sniper', cd: 15, mp: 30, cast: 1.2, range: 12, target: 'line', radius: 1.2, effects: [{ kind: 'damage', school: 'phys', coef: 2.0, ignoreDefPct: 0.4 }, { kind: 'knockback', distance: 2 }], cost: 140 }),
  // 마탄 저격수
  active({ id: 'sniper_magic_bullet', name: '마탄', desc: '0.8초 시전 후 이능 공격력의 260% 이능 피해.', job: 'sniper', magic: 'shadow', cd: 10, mp: 25, cast: 0.8, range: 12, target: 'enemy', effects: [{ kind: 'damage', school: 'magic', coef: 2.6, magic: 'shadow' }], cost: 130 }),
  active({ id: 'sniper_magic_hex', name: '저주탄', desc: '이능 공격력의 150% 이능 피해와 6초 동안 적의 이능 방어 -25%.', job: 'sniper', magic: 'shadow', cd: 12, mp: 25, cast: 0.5, range: 12, target: 'enemy', effects: [{ kind: 'damage', school: 'magic', coef: 1.5, magic: 'shadow' }, { kind: 'debuff', stat: 'magDef', pct: 25, durationSec: 6 }], cost: 120 }),
  // 감시자
  active({ id: 'sniper_watcher_mark', name: '표적 지정', desc: '8초 동안 적의 회피 -30%, 물리 방어 -15%.', job: 'sniper', cd: 12, mp: 15, range: 12, target: 'enemy', effects: [{ kind: 'debuff', stat: 'evasion', pct: 30, durationSec: 8 }, { kind: 'debuff', stat: 'physDef', pct: 15, durationSec: 8 }], cost: 120 }),
  passive({ id: 'sniper_watcher_vision', name: '감시자의 눈', desc: '적중 +15%, 사거리 +12%.', job: 'sniper', mods: { accuracy: 15, range: 12 }, cost: 120 }),

  // ══════════ 마법사 ══════════
  active({ id: 'mage_bolt', name: '마력탄', desc: '0.4초 시전 후 이능 공격력의 150% 이능 피해.', job: 'mage', cd: 6, mp: 12, cast: 0.4, range: 7, target: 'enemy', effects: [{ kind: 'damage', school: 'magic', coef: 1.5 }], cost: 60 }),
  active({ id: 'mage_blast', name: '마력 폭발', desc: '0.8초 시전 후 반경 2.5 안의 적에게 이능 공격력의 140% 이능 피해.', job: 'mage', cd: 12, mp: 25, cast: 0.8, range: 7, target: 'enemy_area', radius: 2.5, effects: [{ kind: 'damage', school: 'magic', coef: 1.4 }], ai: 'enemies_clustered_2', cost: 100 }),
  active({ id: 'mage_barrier', name: '마력 장벽', desc: '6초 동안 500 피해를 흡수하는 보호막. HP 50% 이하일 때 사용.', job: 'mage', cd: 15, mp: 20, range: 0, target: 'self', effects: [{ kind: 'status', status: 'shield', durationSec: 6, value: 500 }], ai: 'self_hp_below_50', cost: 80 }),
  passive({ id: 'mage_meditation', name: '명상', desc: 'MP 회복 +30%, 최대 MP +20%.', job: 'mage', mods: { mpRegen: 30, maxMp: 20 }, cost: 70 }),
  passive({ id: 'mage_arcane_mind', name: '비전 지성', desc: '이능 공격 +10%, 시전 속도 +8%.', job: 'mage', mods: { magAtk: 10, castSpeed: 8 }, cost: 90 }),
  // 화염
  active({ id: 'mage_fire_fireball', name: '화염구', desc: '0.8초 시전 후 이능 공격력의 220% 화염 피해와 4초 동안 초당 15 화상.', job: 'mage', magic: 'fire', cd: 9, mp: 25, cast: 0.8, range: 7, target: 'enemy', effects: [{ kind: 'damage', school: 'magic', coef: 2.2, magic: 'fire' }, { kind: 'status', status: 'burn', durationSec: 4, value: 15 }], cost: 120 }),
  active({ id: 'mage_fire_storm', name: '화염 폭풍', desc: '1.5초 시전 후 반경 3 안의 적에게 이능 공격력의 200% 화염 피해와 5초 동안 초당 12 화상.', job: 'mage', magic: 'fire', cd: 18, mp: 40, cast: 1.5, range: 7, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'magic', coef: 2.0, magic: 'fire' }, { kind: 'status', status: 'burn', durationSec: 5, value: 12 }], ai: 'enemies_clustered_2', cost: 150 }),
  passive({ id: 'mage_fire_armor', name: '불꽃 갑옷', desc: '받은 물리 피해의 15%를 반사한다. 이능 방어 +8%.', job: 'mage', magic: 'fire', mods: { magDef: 8 }, status: [{ status: 'reflect', value: 0.15 }], cost: 110 }),
  // 전기
  active({ id: 'mage_lightning_chain', name: '연쇄 번개', desc: '0.6초 시전 후 직선상의 적(폭 1.5)에게 이능 공격력의 180% 전기 피해와 35% 확률로 1초 기절.', job: 'mage', magic: 'lightning', cd: 10, mp: 25, cast: 0.6, range: 7, target: 'line', radius: 1.5, effects: [{ kind: 'damage', school: 'magic', coef: 1.8, magic: 'lightning' }, { kind: 'status', status: 'stun', durationSec: 1, chance: 0.35 }], cost: 120 }),
  active({ id: 'mage_lightning_field', name: '뇌전 장막', desc: '1초 시전 후 반경 3 안의 적에게 이능 공격력의 140% 전기 피해와 50% 확률로 0.8초 기절.', job: 'mage', magic: 'lightning', cd: 16, mp: 35, cast: 1.0, range: 7, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'magic', coef: 1.4, magic: 'lightning' }, { kind: 'status', status: 'stun', durationSec: 0.8, chance: 0.5 }], ai: 'enemies_clustered_2', cost: 140 }),
  // 냉기
  active({ id: 'mage_ice_shard', name: '얼음 창', desc: '0.6초 시전 후 이능 공격력의 190% 냉기 피해와 4초 동안 이동 속도 50% 감소.', job: 'mage', magic: 'ice', cd: 8, mp: 20, cast: 0.6, range: 7, target: 'enemy', effects: [{ kind: 'damage', school: 'magic', coef: 1.9, magic: 'ice' }, { kind: 'status', status: 'slow', durationSec: 4, value: 0.5 }], cost: 120 }),
  active({ id: 'mage_ice_nova', name: '빙결 파동', desc: '1.2초 시전 후 반경 3 안의 적에게 이능 공격력의 150% 냉기 피해와 50% 확률로 1.5초 빙결.', job: 'mage', magic: 'ice', cd: 18, mp: 40, cast: 1.2, range: 7, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'magic', coef: 1.5, magic: 'ice' }, { kind: 'status', status: 'freeze', durationSec: 1.5, chance: 0.5 }], ai: 'enemies_clustered_2', cost: 150 }),

  // ══════════ 소환사 ══════════
  active({ id: 'summoner_call_beast', name: '야수 소환', desc: '1초 시전 후 30초 동안 유지되는 야수 1마리를 소환한다. 소환물이 없을 때 사용.', job: 'summoner', magic: 'nature', cd: 20, mp: 35, cast: 1.0, range: 0, target: 'self', effects: [{ kind: 'summon', unit: 'beast', count: 1, durationSec: 30 }], ai: 'no_summons', cost: 90 }),
  active({ id: 'summoner_drain', name: '마력 흡수', desc: '이능 공격력의 130% 이능 피해를 주고 MP 15를 회복한다.', job: 'summoner', cd: 8, mp: 5, range: 6, target: 'enemy', effects: [{ kind: 'damage', school: 'magic', coef: 1.3 }, { kind: 'restore_mp', amount: 15 }], cost: 60 }),
  active({ id: 'summoner_empower', name: '소환물 강화', desc: '반경 6 안의 아군과 소환물에게 8초 동안 물리 공격 +20%, 이능 공격 +20%.', job: 'summoner', cd: 15, mp: 20, range: 0, target: 'ally_area', radius: 6, effects: [{ kind: 'buff', stat: 'physAtk', pct: 20, durationSec: 8 }, { kind: 'buff', stat: 'magAtk', pct: 20, durationSec: 8 }], cost: 90 }),
  passive({ id: 'summoner_bond', name: '유대', desc: '최대 HP +8%, 이능 공격 +8%.', job: 'summoner', mods: { maxHp: 8, magAtk: 8 }, cost: 70 }),
  passive({ id: 'summoner_deep_well', name: '깊은 마력', desc: '최대 MP +30%, MP 회복 +25%.', job: 'summoner', mods: { maxMp: 30, mpRegen: 25 }, cost: 80 }),
  // 야수 소환사
  active({ id: 'summoner_beast_pack', name: '야수 무리', desc: '1.2초 시전 후 25초 동안 유지되는 야수 2마리를 소환한다. 소환물이 없을 때 사용.', job: 'summoner', magic: 'nature', cd: 22, mp: 40, cast: 1.2, range: 0, target: 'self', effects: [{ kind: 'summon', unit: 'beast', count: 2, durationSec: 25 }], ai: 'no_summons', cost: 130 }),
  passive({ id: 'summoner_beast_fury', name: '야수의 분노', desc: '물리 공격 +15%, 공격 속도 +10%. (소환물은 소환사의 공격력을 따른다)', job: 'summoner', mods: { physAtk: 15, atkSpeed: 10 }, cost: 100 }),
  // 정령 소환사
  active({ id: 'summoner_spirit_call', name: '정령 소환', desc: '1초 시전 후 25초 동안 유지되는 원거리 정령 2체를 소환한다. 소환물이 없을 때 사용.', job: 'summoner', cd: 20, mp: 35, cast: 1.0, range: 0, target: 'self', effects: [{ kind: 'summon', unit: 'spirit', count: 2, durationSec: 25 }], ai: 'no_summons', cost: 130 }),
  passive({ id: 'summoner_spirit_link', name: '정령 연결', desc: '이능 공격 +12%, MP 회복 +15%.', job: 'summoner', mods: { magAtk: 12, mpRegen: 15 }, cost: 100 }),
  // 사령술사
  active({ id: 'summoner_necro_raise', name: '사령 소환', desc: '1.2초 시전 후 25초 동안 유지되는 해골 병사 3체를 일으킨다. 소환물이 없을 때 사용.', job: 'summoner', magic: 'shadow', cd: 22, mp: 40, cast: 1.2, range: 0, target: 'self', effects: [{ kind: 'summon', unit: 'skeleton', count: 3, durationSec: 25 }], ai: 'no_summons', cost: 130 }),
  active({ id: 'summoner_necro_curse', name: '저주', desc: '반경 2.5 안의 적에게 이능 공격력의 120% 암흑 피해와 6초 동안 물리 공격 -20%.', job: 'summoner', magic: 'shadow', cd: 14, mp: 25, cast: 0.5, range: 6, target: 'enemy_area', radius: 2.5, effects: [{ kind: 'damage', school: 'magic', coef: 1.2, magic: 'shadow' }, { kind: 'debuff', stat: 'physAtk', pct: 20, durationSec: 6 }], ai: 'enemies_clustered_2', cost: 110 }),

  // ══════════ 힐러 ══════════
  active({ id: 'healer_heal', name: '치유', desc: '0.6초 시전 후 HP가 가장 낮은 아군을 이능 공격력의 200%만큼 회복. 아군 HP 60% 이하일 때 사용.', job: 'healer', magic: 'holy', cd: 6, mp: 20, cast: 0.6, range: 6, target: 'ally_lowest_hp', effects: [{ kind: 'heal', coef: 2.0 }], ai: 'ally_hp_below_60', cost: 60 }),
  active({ id: 'healer_group_heal', name: '광역 치유', desc: '1초 시전 후 반경 4 안의 아군을 이능 공격력의 120%만큼 회복. 아군 HP 60% 이하일 때 사용.', job: 'healer', magic: 'holy', cd: 15, mp: 35, cast: 1.0, range: 0, target: 'ally_area', radius: 4, effects: [{ kind: 'heal', coef: 1.2 }], ai: 'ally_hp_below_60', cost: 110 }),
  active({ id: 'healer_smite', name: '응징', desc: '이능 공격력의 130% 신성 피해.', job: 'healer', magic: 'holy', cd: 7, mp: 10, range: 6, target: 'enemy', effects: [{ kind: 'damage', school: 'magic', coef: 1.3, magic: 'holy' }], cost: 60 }),
  passive({ id: 'healer_blessing', name: '축복', desc: '이능 방어 +10%, 최대 HP +5%.', job: 'healer', magic: 'holy', mods: { magDef: 10, maxHp: 5 }, cost: 70 }),
  passive({ id: 'healer_serenity', name: '평정', desc: 'MP 회복 +25%, 시전 속도 +10%.', job: 'healer', mods: { mpRegen: 25, castSpeed: 10 }, cost: 80 }),
  // 신관
  active({ id: 'healer_priest_great_heal', name: '대치유', desc: '1초 시전 후 HP가 가장 낮은 아군을 이능 공격력의 300%만큼 회복. 아군 HP 40% 이하일 때 사용.', job: 'healer', magic: 'holy', cd: 12, mp: 35, cast: 1.0, range: 6, target: 'ally_lowest_hp', effects: [{ kind: 'heal', coef: 3.0 }], ai: 'ally_hp_below_40', cost: 130 }),
  active({ id: 'healer_priest_purify', name: '정화', desc: 'HP가 가장 낮은 아군의 디버프를 제거하고 이능 공격력의 100%만큼 회복.', job: 'healer', magic: 'holy', cd: 10, mp: 20, range: 6, target: 'ally_lowest_hp', effects: [{ kind: 'cleanse' }, { kind: 'heal', coef: 1.0 }], ai: 'ally_hp_below_60', cost: 110 }),
  // 드루이드
  active({ id: 'healer_druid_regrowth', name: '재생', desc: 'HP가 가장 낮은 아군을 이능 공격력의 80%만큼 회복하고 8초 동안 초당 18 회복.', job: 'healer', magic: 'nature', cd: 10, mp: 20, cast: 0.4, range: 6, target: 'ally_lowest_hp', effects: [{ kind: 'heal', coef: 0.8 }, { kind: 'status', status: 'regen', durationSec: 8, value: 18 }], ai: 'ally_hp_below_60', cost: 120 }),
  active({ id: 'healer_druid_thorns', name: '가시 덩굴', desc: '반경 2.5 안의 적에게 이능 공격력의 130% 자연 피해와 3초 동안 이동 속도 40% 감소.', job: 'healer', magic: 'nature', cd: 12, mp: 25, cast: 0.6, range: 6, target: 'enemy_area', radius: 2.5, effects: [{ kind: 'damage', school: 'magic', coef: 1.3, magic: 'nature' }, { kind: 'status', status: 'slow', durationSec: 3, value: 0.4 }], ai: 'enemies_clustered_2', cost: 110 }),
  // 결계사
  active({ id: 'healer_ward_barrier', name: '보호 결계', desc: '0.8초 시전 후 반경 4 안의 아군에게 6초 동안 450 피해를 흡수하는 보호막. 아군 HP 60% 이하일 때 사용.', job: 'healer', magic: 'holy', cd: 16, mp: 35, cast: 0.8, range: 0, target: 'ally_area', radius: 4, effects: [{ kind: 'status', status: 'shield', durationSec: 6, value: 450 }], ai: 'ally_hp_below_60', cost: 130 }),
  active({ id: 'healer_ward_empower', name: '결계 강화', desc: '반경 4 안의 아군에게 8초 동안 물리 방어 +15%, 이능 방어 +15%.', job: 'healer', magic: 'holy', cd: 18, mp: 30, cast: 0.5, range: 0, target: 'ally_area', radius: 4, effects: [{ kind: 'buff', stat: 'physDef', pct: 15, durationSec: 8 }, { kind: 'buff', stat: 'magDef', pct: 15, durationSec: 8 }], cost: 120 }),
];

// ───────────────────────── 조회 ─────────────────────────

function buildSkillMap(): Record<string, SkillDef> {
  const out: Record<string, SkillDef> = {};
  for (const s of SKILL_LIST) {
    if (out[s.id]) throw new Error(`스킬 id 중복: ${s.id}`);
    out[s.id] = s;
  }
  return out;
}

export const SKILLS: Record<string, SkillDef> = buildSkillMap();

/** 정의 순서가 고정된 전체 스킬 id 목록 */
export const SKILL_IDS: readonly string[] = SKILL_LIST.map((s) => s.id);

export function getSkill(id: string): SkillDef {
  const def = SKILLS[id];
  if (!def) throw new Error(`알 수 없는 스킬: ${id}`);
  return def;
}

/** 캐릭터가 아직 모르는, 습득 가능한 스킬 id (메인 풀 + 세부 직업 풀). 순서 고정 */
export function skillPoolFor(c: Character): string[] {
  const known = new Set(c.skills);
  const out: string[] = [];
  const push = (id: string) => {
    if (!known.has(id) && !out.includes(id)) out.push(id);
  };
  for (const id of JOBS[c.mainJob].skillPool) push(id);
  if (c.subJob) {
    const sub = SUBJOBS[c.subJob];
    if (sub) for (const id of sub.skillPool) push(id);
  }
  return out;
}

export function countSkills(c: Character): { active: number; passive: number } {
  let active = 0;
  let passive = 0;
  for (const id of c.skills) {
    const def = SKILLS[id];
    if (!def) continue;
    if (def.type === 'active') active++;
    else passive++;
  }
  return { active, passive };
}

/** 특정 직업 풀 전체 (메인 + 모든 세부 직업의 granted/pool). 표시/상점용 */
export function allSkillsOfJob(job: MainJob): SkillDef[] {
  return SKILL_LIST.filter((s) => s.job === job);
}
