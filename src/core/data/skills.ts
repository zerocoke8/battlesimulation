/**
 * 스킬 정의 (GDD §7.7, §6.5). 메인 직업당 5~7개 + 세부 직업당 2~4개 + 몬스터 전용.
 *
 * 규약:
 *  - damage.coef 는 공격력 배율.
 *  - buff/debuff 의 pct 는 항상 양수. buff 는 +pct%, debuff 는 -pct% 로 해석한다.
 *  - status.value: slow = 감소 비율(0~1), burn/poison/regen = 초당 절대량, shield = 흡수량, lifesteal/reflect = 비율.
 *  - passiveMods 는 파생 수치 % 보정 (stats.computeDerived 가 합산).
 *  - desc 는 손으로 쓰지 않는다. describeActive / describePassive 가 스펙 객체의 숫자(시전·예고·반경·계수 %·장판 지속·초당 %)를
 *    그대로 문장으로 만든다. 숫자를 바꾸면 설명도 같이 바뀌므로 '설명이 거짓말하는' 버그가 생기지 않는다.
 *    flavor 는 문장 앞에 붙는 짧은 연출 문구, note 는 문장 뒤에 붙는 보충 문구다.
 *
 * v0.5 광역 규약 (GDD §6.5):
 *  - 대상이 enemy_area / line 인 피해 스킬은 전부 telegraphSec(예고)을 명시한다.
 *      원거리 광역 DEFAULT_TELEGRAPH_SEC(0.8). 시전자 중심 소형 근접 광역(radius ≤ 2.5 이고 range ≤ 2)은 SHORT_TELEGRAPH_SEC(0.3).
 *      반경 3.5 이상의 큰 광역과 거대 보스 장판은 1.0~1.5.
 *  - 피해가 없는 적 광역(도발 등)은 telegraphSec 0 = 즉시. 아군 광역(ally_area)은 필드를 두지 않는다 (sim 이 즉시 적용 + 0.4초 표시).
 *  - 장판(linger)이 있는 스킬은 즉발 계수를 낮게 두고 linger 로 총 피해를 채운다.
 *  - 플레이어 광역 피해 스킬은 '적 2명 이상' AI 조건(enemies_clustered_2)을 두지 않는다. 4인 팀에서는 그 조건이
 *      거의 성립하지 않아 광역이 판당 1회도 안 나갔다. 단일 대상에 써도 계수가 단일기보다 높고 예고·회피 위험을 지므로 상시 사용이 맞다.
 *      쿨타임은 기본 광역 8~10초, 세부 직업 광역 10~15초. 원거리 광역 반경 3 (자신 중심 근접 광역은 SHORT 예고 조건 때문에 2.5 유지).
 *      반경 3 은 회피 보정 목표(GDD §11: 판단력 80·민첩 70 유닛이 예고 0.8초 광역을 절반 이상 회피)와 맞물린 값이다.
 *      반경 3.5~4 의 큰 장판은 그만큼 예고를 1.0~1.5초로 길게 둔다.
 *  - line 의 radius 는 반폭이다 (실제 폭 = radius × 2). desc 의 '폭 N' 은 실제 폭을 적는다.
 *
 * v0.6 위력 상향 ("스킬 맞는 체감이 나야 한다"):
 *  - v0.5 값 기준 액티브 피해 계수 단일 대상 ×1.6, 광역 즉발 ×1.5, 장판 dpsCoef ×1.4, 회복 계수 ×1.4. 기절·둔화·화상 같은 상태 수치는 그대로.
 *    몬스터 전용(mon_*)도 같은 배율. 목표 지표(10일차 스킬 피해 비중 55~70%, 주력 단일기 1회 = 상대 최대 HP 18~30%,
 *    광역 즉발 대상당 12~20% + 장판)는 헤드리스로 재고 보정A 가 맞춘다. 전투 시간 60~120초는 HP·방어 상수로 맞추고 스킬 계수를 다시 깎지 않는다.
 *    → 보정 결과와 최종 배율은 SKILL_LIST 바로 위의 '계수 메모' 참조 (피해 ×2.5 추가, MP ×1.7, 기본 공격 속도 0.6배).
 *  - 마법사 기본 풀에 오래 남는 장판 광역 2종(비전 폭풍·메테오)을 넣고 시작 스킬은 광역 2종 중 하나가 되게 했다.
 *    세부 직업 대표 장판: 냉기 블리자드, 전기 뇌우, 화염 화염 비. 기존 화염 폭풍·뇌전 장막·빙결 파동은 장판 5초.
 *  - 모든 메인 직업 기본 풀에 광역 피해 스킬을 최소 1개 둔다 (충격파·대지 강타·연막 단검·화살비·폭발탄·정령 폭발·심판의 빛).
 */
import type { Character, MainJob, SkillDef, SkillEffect, StatusKind, SummonUnitId } from '../types';
import { DEFAULT_TELEGRAPH_SEC, DERIVED_NAME_KO, SHORT_TELEGRAPH_SEC } from '../types';
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

const SUMMON_COUNTER: Record<SummonUnitId, string> = { beast: '마리', spirit: '체', skeleton: '체', turret: '기' };

// ───────────────────────── 정의 도우미 ─────────────────────────

type ActiveSpec = {
  id: string;
  name: string;
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
  /** 광역 예고 시간(초). 0 이면 즉시. 생략하면 sim 기본값 */
  telegraph?: number;
  /** 장판 */
  linger?: SkillDef['linger'];
  /** 장판을 부르는 이름 (기본 '장판'). 예: '불길', '점액' */
  lingerNoun?: string;
  /** 설명 문장 앞에 붙는 연출 문구 */
  flavor?: string;
  /** 설명 문장 뒤에 붙는 보충 문구 */
  note?: string;
};

type PassiveSpec = {
  id: string;
  name: string;
  job: MainJob;
  magic?: SkillDef['magic'];
  mods?: SkillDef['passiveMods'];
  status?: SkillDef['passiveStatus'];
  cost: number;
  flavor?: string;
};

const MAGIC_WORD: Record<SkillDef['magic'], string> = {
  fire: '화염', lightning: '전기', ice: '냉기', holy: '신성', nature: '자연', shadow: '암흑', none: '',
};

const AI_NOTE: Record<NonNullable<SkillDef['aiCondition']>, string> = {
  always: '',
  self_hp_below_50: 'HP 50% 이하일 때 사용.',
  self_hp_below_30: 'HP 30% 이하일 때 사용.',
  ally_hp_below_60: '아군 HP 60% 이하일 때 사용.',
  ally_hp_below_40: '아군 HP 40% 이하일 때 사용.',
  enemies_clustered_2: '적 2명 이상이 모여 있을 때 사용.',
  enemies_clustered_3: '적 3명 이상이 모여 있을 때 사용.',
  target_hp_below_30: 'HP 30% 이하의 적에게 사용.',
  out_of_range: '대상이 사거리 밖일 때 사용.',
  not_stealthed: '은신 중이 아닐 때 사용.',
  no_summons: '소환물이 없을 때 사용.',
};

/** 소수 둘째 자리까지, 불필요한 0 없이 */
function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** 계수(배율) → 정수 % */
function pct(coef: number): string {
  return String(Math.round(coef * 100));
}

/** 받침 유무에 따라 '와'/'과' */
function wa(word: string): string {
  const ch = word.charCodeAt(word.length - 1);
  if (ch >= 0xac00 && ch <= 0xd7a3) return (ch - 0xac00) % 28 === 0 ? '와' : '과';
  // 숫자·% 등으로 끝나면 읽는 소리 기준으로 대충 '와'
  return '와';
}

/** 받침 유무에 따라 '을'/'를' */
function eul(word: string): string {
  const ch = word.charCodeAt(word.length - 1);
  if (ch >= 0xac00 && ch <= 0xd7a3) return (ch - 0xac00) % 28 === 0 ? '를' : '을';
  return '를';
}

/** 구 목록을 'A, B와 C' 꼴로 잇는다 */
function joinKo(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  const head = parts.slice(0, -1).join(', ');
  return `${head}${wa(head)} ${parts[parts.length - 1]}`;
}

/** 피해 종류 수식어: '물리 공격력의 N% 피해' / '이능 공격력의 N% 화염 피해' */
function damageWord(school: 'phys' | 'magic', magic: SkillDef['magic']): string {
  if (school === 'phys') return '';
  return magic === 'none' ? '이능 ' : `${MAGIC_WORD[magic]} `;
}

/** 스킬의 장판 피해 계열 (sim 의 lingerSchoolOf 와 같은 규칙: 첫 피해 효과, 없으면 이능) */
function lingerSchool(effects: SkillEffect[]): 'phys' | 'magic' {
  for (let i = 0; i < effects.length; i++) {
    const e = effects[i];
    if (e.kind === 'damage') return e.school;
  }
  return 'magic';
}

function statusPhrase(status: StatusKind, d: number, v: number | undefined, chance: number | undefined): string {
  const c = chance !== undefined && chance < 1 ? `${pct(chance)}% 확률로 ` : '';
  const val = v ?? 0;
  switch (status) {
    case 'stun': return `${c}${num(d)}초 기절`;
    case 'freeze': return `${c}${num(d)}초 빙결`;
    case 'slow': return `${c}${num(d)}초 동안 이동 속도 ${pct(val)}% 감소`;
    case 'burn': return `${c}${num(d)}초 동안 초당 ${num(val)} 화상`;
    case 'poison': return `${c}${num(d)}초 동안 초당 ${num(val)} 독 피해(방어 무시)`;
    case 'stealth': return `${num(d)}초 동안 은신`;
    case 'taunt': return `${c}${num(d)}초 동안 도발(자신만 공격하게 한다)`;
    case 'shield': return `${num(d)}초 동안 ${num(val)} 피해를 흡수하는 보호막`;
    case 'silence': return `${c}${num(d)}초 동안 침묵`;
    case 'lifesteal': return `${num(d)}초 동안 입힌 피해의 ${pct(val)}% 흡혈`;
    case 'reflect': return `${num(d)}초 동안 받은 물리 피해의 ${pct(val)}% 반사`;
    case 'regen': return `${num(d)}초 동안 초당 ${num(val)} 회복`;
    case 'invuln': return `${num(d)}초 동안 무적`;
  }
}

/** 장판 안 상태: 지속은 매 틱 갱신되므로 적지 않는다 */
function lingerStatusPhrase(status: StatusKind, v: number | undefined): string {
  const val = v ?? 0;
  switch (status) {
    case 'slow': return `이동 속도 ${pct(val)}% 감소`;
    case 'burn': return `초당 ${num(val)} 화상`;
    case 'poison': return `초당 ${num(val)} 독 피해`;
    case 'stun': return '기절';
    case 'freeze': return '빙결';
    case 'silence': return '침묵';
    case 'taunt': return '도발';
    default: return '';
  }
}

function effectPhrases(s: ActiveSpec): { dash: string; main: string[] } {
  const main: string[] = [];
  let dash = '';
  // 같은 지속의 버프/디버프는 한 구로 묶는다
  const buffGroups: { kind: 'buff' | 'debuff'; d: number; items: string[]; idx: number }[] = [];
  for (const e of s.effects) {
    switch (e.kind) {
      case 'damage': {
        const atk = e.school === 'phys' ? '물리' : '이능';
        const kind = damageWord(e.school, e.magic ?? (e.school === 'magic' ? (s.magic ?? 'none') : 'none'));
        const ignore = e.ignoreDefPct ? `방어 ${pct(e.ignoreDefPct)}% 무시 ` : '';
        let p = `${ignore}${atk} 공격력의 ${pct(e.coef)}% ${kind}피해`;
        if (e.bonusIfStealth) p += `(은신 중 사용 시 피해 +${pct(e.bonusIfStealth)}%)`;
        if (e.bonusPerMissingHpPct) p += `(잃은 HP 1%당 피해 +${pct(e.bonusPerMissingHpPct)}%)`;
        main.push(p);
        break;
      }
      case 'heal':
        main.push(`이능 공격력의 ${pct(e.coef)}%만큼 회복`);
        break;
      case 'status':
        main.push(statusPhrase(e.status, e.durationSec, e.value, e.chance));
        break;
      case 'buff':
      case 'debuff': {
        const item = e.kind === 'buff' ? `${DERIVED_NAME_KO[e.stat]} +${num(e.pct)}%` : `${DERIVED_NAME_KO[e.stat]} -${num(e.pct)}%`;
        const g = buffGroups.find((x) => x.kind === e.kind && x.d === e.durationSec);
        if (g) g.items.push(item);
        else {
          main.push(''); // 자리 표시. 아래에서 채운다
          buffGroups.push({ kind: e.kind, d: e.durationSec, items: [item], idx: main.length - 1 });
        }
        break;
      }
      case 'summon':
        main.push(`${num(e.durationSec)}초 동안 유지되는 ${SUMMON_UNITS[e.unit].name} ${e.count}${SUMMON_COUNTER[e.unit]} 소환`);
        break;
      case 'dash':
        dash = `${num(e.distance)}칸 돌진해 `;
        break;
      case 'knockback':
        main.push(`${num(e.distance)}칸 넉백`);
        break;
      case 'cleanse':
        main.push('디버프 제거');
        break;
      case 'restore_mp':
        main.push(`MP ${num(e.amount)} 회복`);
        break;
    }
  }
  for (const g of buffGroups) {
    const who = g.kind === 'debuff' ? '적의 ' : '';
    main[g.idx] = `${num(g.d)}초 동안 ${who}${g.items.join(', ')}`;
  }
  return { dash, main: main.filter((m) => m.length > 0) };
}

/** 스펙 객체의 숫자로 설명 문장을 만든다 */
function describeActive(s: ActiveSpec, telegraphSec: number): string {
  const isZone = s.target === 'enemy_area' || s.target === 'line';
  const dealsDamage = s.effects.some((e) => e.kind === 'damage');
  const cast = s.cast ?? 0;
  const r = s.radius ?? 0;

  // 앞머리: 시전 · 예고
  let head = '';
  if (isZone && telegraphSec > 0) {
    head = cast > 0 ? `${num(cast)}초 시전, 예고 ${num(telegraphSec)}초 뒤 ` : `예고 ${num(telegraphSec)}초 뒤 `;
  } else if (cast > 0) {
    head = `${num(cast)}초 시전 후 `;
  }

  // 대상
  let target = '';
  switch (s.target) {
    case 'enemy': target = '적 하나에게 '; break;
    case 'enemy_area': {
      const selfCentered = s.range <= 2;
      const where = selfCentered ? `자신 주위 반경 ${num(r)} 안의 적 모두에게 ` : `반경 ${num(r)} 안의 적 모두에게 `;
      target = isZone && telegraphSec <= 0 && !dealsDamage ? `${where}즉시(예고 없음) ` : where;
      break;
    }
    case 'line': target = `직선상의 모든 적(폭 ${num(r * 2)})에게 `; break;
    case 'self': target = ''; break;
    case 'ally': target = '아군 하나에게 '; break;
    case 'ally_lowest_hp': target = 'HP가 가장 낮은 아군에게 '; break;
    case 'ally_area': target = `반경 ${num(r)} 안의 아군에게 즉시(예고 없음) `; break;
  }

  const { dash, main } = effectPhrases(s);
  let body = `${head}${dash}${target}${joinKo(main)}.`;

  if (s.linger && s.linger.durationSec > 0) {
    const school = lingerSchool(s.effects);
    const atk = school === 'phys' ? '물리' : '이능';
    const kind = damageWord(school, s.magic ?? 'none');
    const noun = s.lingerNoun ?? '장판';
    const parts: string[] = [];
    if (s.linger.dpsCoef > 0) parts.push(`초당 ${atk} 공격력의 ${pct(s.linger.dpsCoef)}% ${kind}피해`);
    if (s.linger.status) {
      const sp = lingerStatusPhrase(s.linger.status.status, s.linger.status.value);
      if (sp) parts.push(sp);
    }
    const nounParticle = (() => {
      const ch = noun.charCodeAt(noun.length - 1);
      return ch >= 0xac00 && ch <= 0xd7a3 && (ch - 0xac00) % 28 !== 0 ? '이' : '가';
    })();
    const given = joinKo(parts);
    body += ` ${noun}${nounParticle} ${num(s.linger.durationSec)}초 동안 장판으로 남아 안의 적에게 ${given}${eul(given)} 준다.`;
  }

  const ai = s.ai ? AI_NOTE[s.ai] : '';
  const out = [s.flavor ? s.flavor : '', body, s.note ?? '', ai].filter((x) => x.length > 0);
  return out.join(' ');
}

function describePassive(s: PassiveSpec): string {
  const parts: string[] = [];
  if (s.status) {
    for (const st of s.status) {
      if (st.status === 'reflect') parts.push(`받은 물리 피해의 ${pct(st.value)}%를 공격자에게 반사`);
      else if (st.status === 'lifesteal') parts.push(`입힌 피해의 ${pct(st.value)}%만큼 HP 회복`);
      else if (st.status === 'regen') parts.push(`초당 ${num(st.value)} 회복`);
      else parts.push(`상시 ${st.status}`);
    }
  }
  if (s.mods) {
    for (const key of Object.keys(s.mods) as (keyof typeof DERIVED_NAME_KO)[]) {
      const v = s.mods[key];
      if (v === undefined) continue;
      parts.push(`${DERIVED_NAME_KO[key]} ${v >= 0 ? '+' : ''}${num(v)}%`);
    }
  }
  const body = parts.length > 0 ? `${parts.join(', ')}.` : '';
  return [s.flavor ?? '', body].filter((x) => x.length > 0).join(' ');
}

/** 스킬의 실효 예고 시간 (스펙 단계). effectiveTelegraphSec 과 같은 규칙 */
function specTelegraph(s: ActiveSpec): number {
  if (s.telegraph !== undefined) return s.telegraph < 0 ? 0 : s.telegraph;
  if (s.target !== 'enemy_area' && s.target !== 'line') return 0;
  if (!s.effects.some((e) => e.kind === 'damage')) return 0;
  const r = s.radius ?? 0;
  if (s.target === 'enemy_area' && r <= 2.5 && s.range <= 2) return SHORT_TELEGRAPH_SEC;
  return DEFAULT_TELEGRAPH_SEC;
}

function active(s: ActiveSpec): SkillDef {
  const def: SkillDef = {
    id: s.id,
    name: s.name,
    desc: describeActive(s, specTelegraph(s)),
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
  if (s.telegraph !== undefined) def.telegraphSec = s.telegraph;
  if (s.linger !== undefined) def.linger = s.linger;
  return def;
}

function passive(s: PassiveSpec): SkillDef {
  return {
    id: s.id,
    name: s.name,
    desc: describePassive(s),
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
/** 광역 예고 기본값 (enemy_area / line 피해 스킬) */
const TG = DEFAULT_TELEGRAPH_SEC;
/** 시전자 중심 소형 근접 광역(radius ≤ 2.5, range ≤ 2) 예고 */
const TG_SHORT = SHORT_TELEGRAPH_SEC;
/** 반경 3.5 이상 큰 광역의 예고 */
const TG_LARGE = 1.0;

/**
 * v0.7 보정A (2026-09-17, 맵 28×20 · 전장 붕괴 · 눈보라 도입 후 재측정):
 *  - 전투 시간은 stats.ts HP_SCALE(1.12) 로 되돌렸고 스킬 계수는 깎지 않았다 (설계 원칙: "전투 시간은 HP·방어 상수로").
 *  - 회복 계수 −15% 도 시험했지만 붕괴 후 종료 비율(긴 꼬리)에 거의 효과가 없어(13.6% 예상 → 13.3% 실측) 되돌렸다.
 *    긴 전투는 힐러 교착이 아니라 30초 이후 지구력 피로로 후반 DPS 가 30~50% 떨어지는 구조 때문이다 (sim FATIGUE_*).
 *  - 암살자만 예외: HP 가 12% 오르자 10일차 승률이 32.6~35.5% 로 목표 하한(35%)에 걸렸다. 급습 14 → 16.5, 연막 단검 9.14 → 10.6,
 *    그림자 처형 12.32 → 14.3 (+16~18%). 1회 피해는 급습 ≈ 27% · 연막 단검 ≈ 17% 로 각 목표 구간(18~30 / 12~20) 안.
 */

// ───────────────────────── 스킬 목록 (정의 순서 고정) ─────────────────────────
//
// 계수 메모 (v0.6 보정A 확정, 2026-09-16 헤드리스 측정):
//  출발점([3] 배율: 단일 ×1.6, 광역 즉발 ×1.5, 장판 ×1.4, 회복 ×1.4)에서 주력기 1회 피해가 상대 최대 HP 의 5~8% 에 그쳐
//  ("맞는 체감" 목표 18~30% 의 1/3) 아래처럼 한 번 더 올렸다. 스킬 계수는 어느 것도 [3] 배율 아래로 내리지 않았다.
//   - 피해 계수(damage.coef) ×2.5, 장판 dpsCoef ×2.5, 회복 계수 ×2.0, 보호막 흡수량 ×2, 화상·중독 초당 피해 ×2 (몬스터 mon_* 도 동일 배율).
//   - MP 소모 ×1.7 (10일차의 액티브 3개 편성에서만 MP 가 병목이 되어 스킬 비중이 70% 를 넘지 않게 한다. 1일차 1스킬 편성엔 영향이 거의 없다).
//   - 쿨타임은 그대로. 예외: 베기·강궁 ×1.3 (1회 피해를 20% 대로 올리면서 판당 사용 횟수를 낮춤).
//   - 스킬별 추가 배율: 시작 스킬(베기·강궁·강타·저격·급습·방패 타격·비전 폭풍·마력 흡수)과 물리 단일기는 1.1~1.8배 더 올려
//     단일 주력기 18~26%, 광역 즉발 12~19% 에 맞췄다. 관통탄·연쇄 번개·대검 휘두르기·메테오는 30% 를 넘어 0.6~0.8배로 눌렀다
//     (메테오는 쿨타임 17초·시전 1.5초·예고 1.5초짜리 궁극기라 즉발 22~26% 를 허용). 암살자는 생존율이 낮아 급습·연막 단검·독칼을 더 올렸다.
//   - 기본 공격 비중은 stats.ts 의 BASIC_ATTACK_SPEED_BASE(1.0 → 0.6)로 내렸다. HP 를 올려 시간을 맞추면 스킬 1회 피해가 HP 대비 작아져
//     목표와 충돌하므로, HP 대신 기본 공격 빈도를 줄였다. 전투 시간은 HP_BASE/HP_VIT_SQ(600 + 체력² × 0.95)로 1일차 < 10일차를 만들었다.
//  측정(--games 200 --seed 5): 10일차 스킬 피해 비중 66.9% · 기본 공격 30.6% · 광역 23.1% · 평균 69.5초, 1일차 47.8% · 67.5초.
//  방패 타격·무릎 쏘기·마력 흡수·도약·돌진·후퇴 사격·독칼·응징처럼 기절·둔화·이동·MP 회복이 본체인 보조기는 8~13% 로 두었다 (주력기 목표 대상 아님).
//  보정B (2026-09-16, 검증 지적 반영. 시드 77·4242·8 에서 하한 아래이거나 여유 0~2p 였던 것만 올렸다. 전부 §6.5.6 허용 범위 안):
//   심판의 빛 5.36→6.8, 얼음 창 9.18→10.2, 메테오 4.97→9.0 (즉발 12~16% + 장판 4초 14% 로 합산 26~30%. 궁극기라 허용),
//   강궁 12.67→14.2, 충격파 6.34→8.2, 정령 폭발 6.83→7.4, 다중 사격 6.35→7.8 (하한에 2~3p 여유. 1차 7.5/13.6/7.0/7.2 에서는
//   시드 77 10일차 400판이 메테오 10.3 / 강궁 17.7 / 충격파 10.3 / 다중 사격 11.8% 로 여전히 하한 아래였다).
//   보조기 목록은 UTILITY_SKILL_IDS 로 내보내 헤드리스 주력기 표가 '보조' 로 표시하고 판정에서 뺀다.

const SKILL_LIST: SkillDef[] = [
  // ══════════ 검사 ══════════
  active({ id: 'swordsman_slash', name: '베기', job: 'swordsman', cd: 8, mp: 17, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 11.41 }], cost: 60 }),
  active({ id: 'swordsman_charge', name: '돌진', job: 'swordsman', cd: 10, mp: 26, range: 7, target: 'enemy', effects: [{ kind: 'dash', distance: 6 }, { kind: 'damage', school: 'phys', coef: 5.2 }], ai: 'out_of_range', cost: 80 }),
  active({ id: 'swordsman_whirlwind', name: '회전 베기', job: 'swordsman', cd: 8, mp: 34, range: MELEE, target: 'enemy_area', radius: 2.5, effects: [{ kind: 'damage', school: 'phys', coef: 6.83 }], cost: 100, telegraph: TG_SHORT }),
  passive({ id: 'swordsman_iron_stance', name: '철의 자세', job: 'swordsman', mods: { physDef: 10, maxHp: 5 }, cost: 70 }),
  passive({ id: 'swordsman_blade_mastery', name: '검술 숙련', job: 'swordsman', mods: { physAtk: 8, accuracy: 5 }, cost: 80 }),
  // 대검사
  active({ id: 'swordsman_great_cleave', name: '대검 휘두르기', job: 'swordsman', cd: 10, mp: 43, cast: 0.5, range: MELEE, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'phys', coef: 8.58 }], cost: 120, telegraph: TG }),
  active({ id: 'swordsman_great_earthbreak', name: '지각 붕괴', job: 'swordsman', cd: 12, mp: 60, cast: 1.0, range: MELEE, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'phys', coef: 6.38 }, { kind: 'status', status: 'stun', durationSec: 1, chance: 0.5 }], cost: 140, telegraph: TG, linger: { durationSec: 4, dpsCoef: 2.1, status: { status: 'slow', durationSec: 1, value: 0.35 } }, lingerNoun: '갈라진 땅' }),
  // 쾌검사
  active({ id: 'swordsman_swift_flurry', name: '연속 베기', flavor: '적 하나를 빠르게 여러 번 벤다.', job: 'swordsman', cd: 8, mp: 26, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 12.96 }], cost: 120 }),
  passive({ id: 'swordsman_swift_step', name: '질풍보', job: 'swordsman', mods: { atkSpeed: 12, evasion: 8 }, cost: 100 }),
  // 마검사
  active({ id: 'swordsman_magic_blade', name: '마력 참격', flavor: '검에 마력을 싣는다.', job: 'swordsman', cd: 9, mp: 34, range: 2.5, target: 'enemy', effects: [{ kind: 'damage', school: 'magic', coef: 11.6 }], cost: 120 }),
  passive({ id: 'swordsman_magic_ward', name: '마검 결계', job: 'swordsman', mods: { magDef: 15, magAtk: 10 }, cost: 100 }),

  // ══════════ 탱커 ══════════
  active({ id: 'tank_bash', name: '방패 타격', job: 'tank', cd: 10, mp: 26, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 6.24 }, { kind: 'status', status: 'stun', durationSec: 1, chance: 0.6 }], cost: 70 }),
  active({ id: 'tank_shockwave', name: '충격파', flavor: '방패로 땅을 내리쳐 충격파를 퍼뜨린다.', job: 'tank', cd: 10, mp: 34, range: MELEE, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'phys', coef: 8.2 }, { kind: 'knockback', distance: 2 }], cost: 100, telegraph: TG }),
  active({ id: 'tank_fortify', name: '요새화', job: 'tank', cd: 15, mp: 34, range: 0, target: 'self', effects: [{ kind: 'buff', stat: 'physDef', pct: 30, durationSec: 6 }, { kind: 'buff', stat: 'magDef', pct: 20, durationSec: 6 }], ai: 'self_hp_below_50', cost: 80 }),
  active({ id: 'tank_shield_wall', name: '방벽', job: 'tank', cd: 18, mp: 51, cast: 0.5, range: 0, target: 'ally_area', radius: 4, effects: [{ kind: 'status', status: 'shield', durationSec: 6, value: 760 }], cost: 110 }),
  passive({ id: 'tank_endurance', name: '인내', job: 'tank', mods: { maxHp: 12, physDef: 5 }, cost: 70 }),
  passive({ id: 'tank_bulwark', name: '견고', job: 'tank', mods: { physDef: 10, magDef: 10 }, cost: 90 }),
  // 철벽
  active({ id: 'tank_wall_guard', name: '철벽 방어', job: 'tank', cd: 14, mp: 34, range: 0, target: 'self', effects: [{ kind: 'status', status: 'shield', durationSec: 5, value: 1200 }, { kind: 'buff', stat: 'physDef', pct: 25, durationSec: 5 }], ai: 'self_hp_below_50', cost: 120 }),
  passive({ id: 'tank_wall_stance', name: '수호 자세', job: 'tank', mods: { physDef: 15, maxHp: 8 }, cost: 110 }),
  // 가시갑옷
  passive({ id: 'tank_thorns_armor', name: '가시 갑옷', job: 'tank', mods: { physDef: 5 }, status: [{ status: 'reflect', value: 0.25 }], cost: 120 }),
  active({ id: 'tank_thorns_burst', name: '가시 폭발', job: 'tank', cd: 8, mp: 34, range: MELEE, target: 'enemy_area', radius: 2.5, effects: [{ kind: 'damage', school: 'phys', coef: 8.42 }], cost: 110, telegraph: TG_SHORT }),
  // 도발자
  active({ id: 'tank_taunt_roar', name: '도발의 포효', job: 'tank', cd: 12, mp: 34, range: 5, target: 'enemy_area', radius: 5, effects: [{ kind: 'status', status: 'taunt', durationSec: 4 }], cost: 120, telegraph: 0 }),
  passive({ id: 'tank_taunt_presence', name: '위압감', job: 'tank', mods: { maxHp: 10, magDef: 8 }, cost: 100 }),

  // ══════════ 버서커 ══════════
  active({ id: 'berserker_rage', name: '분노', job: 'berserker', cd: 16, mp: 26, range: 0, target: 'self', effects: [{ kind: 'buff', stat: 'physAtk', pct: 25, durationSec: 8 }, { kind: 'buff', stat: 'atkSpeed', pct: 15, durationSec: 8 }], cost: 80 }),
  active({ id: 'berserker_smash', name: '강타', job: 'berserker', cd: 8, mp: 26, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 8.8 }], cost: 70 }),
  active({ id: 'berserker_ground_slam', name: '대지 강타', flavor: '땅을 내리쳐 주위를 뒤흔든다.', job: 'berserker', cd: 9, mp: 34, range: MELEE, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'phys', coef: 5.25 }], cost: 100, telegraph: TG, linger: { durationSec: 2, dpsCoef: 2.1 }, lingerNoun: '흔들리는 땅' }),
  active({ id: 'berserker_leap', name: '도약', job: 'berserker', cd: 12, mp: 26, range: 8, target: 'enemy', effects: [{ kind: 'dash', distance: 7 }, { kind: 'damage', school: 'phys', coef: 5.6 }], ai: 'out_of_range', cost: 80 }),
  passive({ id: 'berserker_reckless', name: '무모함', job: 'berserker', mods: { physAtk: 15, atkSpeed: 5 }, cost: 90 }),
  passive({ id: 'berserker_thick_skin', name: '두꺼운 피부', job: 'berserker', mods: { maxHp: 10 }, cost: 60 }),
  // 광전사
  active({ id: 'berserker_frenzy_strike', name: '광기의 일격', job: 'berserker', cd: 8, mp: 26, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 5.76, bonusPerMissingHpPct: 0.02 }], cost: 130, note: 'HP 50%면 피해 +100%.' }),
  passive({ id: 'berserker_frenzy_will', name: '죽음의 의지', job: 'berserker', mods: { critChance: 10, physAtk: 10 }, cost: 110 }),
  // 피의 계약자
  passive({ id: 'berserker_blood_pact', name: '피의 계약', job: 'berserker', status: [{ status: 'lifesteal', value: 0.2 }], cost: 130 }),
  active({ id: 'berserker_blood_rite', name: '피의 의식', job: 'berserker', cd: 15, mp: 34, range: 0, target: 'self', effects: [{ kind: 'buff', stat: 'physAtk', pct: 30, durationSec: 6 }, { kind: 'status', status: 'lifesteal', durationSec: 6, value: 0.3 }], ai: 'self_hp_below_50', cost: 120 }),
  // 파괴자
  active({ id: 'berserker_breaker_crush', name: '갑옷 분쇄', job: 'berserker', cd: 10, mp: 34, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 8.8, ignoreDefPct: 0.6 }], cost: 130 }),
  active({ id: 'berserker_breaker_armor_break', name: '방어 붕괴', job: 'berserker', cd: 12, mp: 34, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 5.2 }, { kind: 'debuff', stat: 'physDef', pct: 30, durationSec: 6 }], cost: 110 }),

  // ══════════ 암살자 ══════════
  active({ id: 'assassin_stealth', name: '은신', flavor: '타겟팅되지 않는다.', job: 'assassin', cd: 15, mp: 26, range: 0, target: 'self', effects: [{ kind: 'status', status: 'stealth', durationSec: 3 }], ai: 'not_stealthed', cost: 90 }),
  active({ id: 'assassin_ambush', name: '급습', job: 'assassin', cd: 8, mp: 26, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 16.5, bonusIfStealth: 1.0 }], cost: 80 }),
  active({ id: 'assassin_smoke_daggers', name: '연막 단검', flavor: '연막 속에서 단검을 사방으로 던진다.', job: 'assassin', cd: 9, mp: 34, range: MELEE, target: 'enemy_area', radius: 2.5, effects: [{ kind: 'damage', school: 'phys', coef: 10.6, bonusIfStealth: 0.5 }], cost: 100, telegraph: TG_SHORT }),
  active({ id: 'assassin_shadowstep', name: '그림자 걸음', flavor: '대상 방향으로 8칸 순간 이동한다.', job: 'assassin', cd: 10, mp: 17, range: 9, target: 'enemy', effects: [{ kind: 'dash', distance: 8 }], ai: 'out_of_range', cost: 70 }),
  passive({ id: 'assassin_smoke', name: '연막', job: 'assassin', mods: { evasion: 15 }, cost: 70 }),
  passive({ id: 'assassin_lethal', name: '급소 파악', job: 'assassin', mods: { critChance: 10, critMult: 15 }, cost: 90 }),
  // 그림자 암살자
  active({ id: 'assassin_shadow_veil', name: '그림자 장막', job: 'assassin', magic: 'shadow', cd: 14, mp: 26, range: 0, target: 'self', effects: [{ kind: 'status', status: 'stealth', durationSec: 4 }, { kind: 'buff', stat: 'moveSpeed', pct: 30, durationSec: 4 }], ai: 'not_stealthed', cost: 120 }),
  active({ id: 'assassin_shadow_execute', name: '그림자 처형', job: 'assassin', magic: 'shadow', cd: 12, mp: 43, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 14.3, bonusIfStealth: 0.5 }], ai: 'target_hp_below_30', cost: 140 }),
  // 독 암살자
  active({ id: 'assassin_poison_blade', name: '독칼', job: 'assassin', cd: 9, mp: 26, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 6.76 }, { kind: 'status', status: 'poison', durationSec: 6, value: 24 }], cost: 120 }),
  active({ id: 'assassin_poison_cloud', name: '독안개', job: 'assassin', cd: 10, mp: 43, range: 3, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'phys', coef: 6.81 }, { kind: 'status', status: 'poison', durationSec: 5, value: 20 }], cost: 120, telegraph: TG, linger: { durationSec: 4, dpsCoef: 2.1, status: { status: 'poison', durationSec: 2, value: 16 } }, lingerNoun: '독안개' }),
  // 환영 암살자
  active({ id: 'assassin_mirage_clone', name: '환영 분신', job: 'assassin', cd: 14, mp: 34, range: 0, target: 'self', effects: [{ kind: 'buff', stat: 'evasion', pct: 40, durationSec: 5 }, { kind: 'buff', stat: 'atkSpeed', pct: 20, durationSec: 5 }], cost: 120 }),
  passive({ id: 'assassin_mirage_flicker', name: '잔상', job: 'assassin', mods: { evasion: 12, moveSpeed: 8 }, cost: 100 }),

  // ══════════ 궁수 ══════════
  active({ id: 'archer_power_shot', name: '강궁', job: 'archer', cd: 9, mp: 17, range: 8, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 14.2 }], cost: 60 }),
  active({ id: 'archer_multishot', name: '다중 사격', job: 'archer', cd: 8, mp: 34, range: 8, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'phys', coef: 7.8 }], cost: 100, telegraph: TG }),
  active({ id: 'archer_arrow_rain', name: '화살비', flavor: '하늘 높이 화살을 쏘아 비처럼 쏟아지게 한다.', job: 'archer', cd: 12, mp: 51, cast: 0.6, range: 8, target: 'enemy_area', radius: 3.5, effects: [{ kind: 'damage', school: 'phys', coef: 6.75 }], cost: 110, telegraph: TG_LARGE, linger: { durationSec: 5, dpsCoef: 1.75 }, lingerNoun: '화살비' }),
  active({ id: 'archer_retreat_shot', name: '후퇴 사격', job: 'archer', cd: 12, mp: 26, range: 4, target: 'enemy', effects: [{ kind: 'knockback', distance: 3 }, { kind: 'damage', school: 'phys', coef: 4.8 }], cost: 80 }),
  passive({ id: 'archer_eagle_eye', name: '매의 눈', job: 'archer', mods: { accuracy: 10, range: 8 }, cost: 80 }),
  passive({ id: 'archer_quick_draw', name: '빠른 장전', job: 'archer', mods: { atkSpeed: 12 }, cost: 80 }),
  // 속사 궁수
  active({ id: 'archer_rapid_barrage', name: '화살 폭풍', flavor: '적 하나에게 화살을 퍼붓는다.', job: 'archer', cd: 8, mp: 26, range: 8, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 12.48 }], cost: 120 }),
  passive({ id: 'archer_rapid_reflex', name: '속사 반사신경', job: 'archer', mods: { atkSpeed: 18 }, cost: 110 }),
  // 정밀 궁수
  active({ id: 'archer_precise_shot', name: '정밀 사격', job: 'archer', cd: 10, mp: 26, cast: 0.5, range: 9, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 12.48 }], cost: 120 }),
  passive({ id: 'archer_precise_focus', name: '정밀 조준', job: 'archer', mods: { critChance: 12, critMult: 20 }, cost: 120 }),
  // 함정 궁수
  active({ id: 'archer_trap_turret', name: '화살탑 설치', job: 'archer', cd: 20, mp: 51, cast: 1.0, range: 0, target: 'self', effects: [{ kind: 'summon', unit: 'turret', count: 1, durationSec: 20 }], ai: 'no_summons', cost: 130 }),
  active({ id: 'archer_trap_snare', name: '올가미 함정', job: 'archer', cd: 8, mp: 34, range: 8, target: 'enemy_area', radius: 2.5, effects: [{ kind: 'damage', school: 'phys', coef: 6 }, { kind: 'status', status: 'slow', durationSec: 4, value: 0.5 }], cost: 110, telegraph: TG, linger: { durationSec: 4, dpsCoef: 1.93, status: { status: 'slow', durationSec: 1, value: 0.5 } }, lingerNoun: '함정' }),

  // ══════════ 저격수 ══════════
  active({ id: 'sniper_snipe', name: '저격', job: 'sniper', cd: 9, mp: 34, cast: 1.2, range: 12, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 11.96 }], cost: 80 }),
  active({ id: 'sniper_kneecap', name: '무릎 쏘기', job: 'sniper', cd: 10, mp: 26, range: 12, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 4.8 }, { kind: 'status', status: 'slow', durationSec: 3, value: 0.4 }], cost: 70 }),
  active({ id: 'sniper_explosive_shot', name: '폭발탄', flavor: '착탄 지점에서 터지는 탄환을 쏜다.', job: 'sniper', cd: 10, mp: 43, cast: 0.8, range: 12, target: 'enemy_area', radius: 2.5, effects: [{ kind: 'damage', school: 'phys', coef: 6 }], cost: 100, telegraph: TG }),
  active({ id: 'sniper_finisher', name: '마무리 사격', job: 'sniper', cd: 14, mp: 43, cast: 0.8, range: 12, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 11.4 }], ai: 'target_hp_below_30', cost: 110 }),
  passive({ id: 'sniper_steady', name: '안정된 호흡', job: 'sniper', mods: { accuracy: 12, critChance: 6 }, cost: 80 }),
  passive({ id: 'sniper_long_barrel', name: '장총신', job: 'sniper', mods: { range: 10, physAtk: 6 }, cost: 90 }),
  // 관통 저격수
  active({ id: 'sniper_pierce_shot', name: '관통탄', job: 'sniper', cd: 8, mp: 43, cast: 1.0, range: 12, target: 'line', radius: 1.4, effects: [{ kind: 'damage', school: 'phys', coef: 6.44 }], cost: 130, telegraph: TG }),
  active({ id: 'sniper_pierce_heavy', name: '중관통탄', job: 'sniper', cd: 11, mp: 51, cast: 1.2, range: 12, target: 'line', radius: 1.5, effects: [{ kind: 'damage', school: 'phys', coef: 6.34, ignoreDefPct: 0.4 }, { kind: 'knockback', distance: 2 }], cost: 140, telegraph: TG }),
  // 마탄 저격수
  active({ id: 'sniper_magic_bullet', name: '마탄', job: 'sniper', magic: 'shadow', cd: 10, mp: 43, cast: 0.8, range: 12, target: 'enemy', effects: [{ kind: 'damage', school: 'magic', coef: 11.96, magic: 'shadow' }], cost: 130 }),
  active({ id: 'sniper_magic_hex', name: '저주탄', job: 'sniper', magic: 'shadow', cd: 12, mp: 43, cast: 0.5, range: 12, target: 'enemy', effects: [{ kind: 'damage', school: 'magic', coef: 6, magic: 'shadow' }, { kind: 'debuff', stat: 'magDef', pct: 25, durationSec: 6 }], cost: 120 }),
  // 감시자
  active({ id: 'sniper_watcher_mark', name: '표적 지정', job: 'sniper', cd: 12, mp: 26, range: 12, target: 'enemy', effects: [{ kind: 'debuff', stat: 'evasion', pct: 30, durationSec: 8 }, { kind: 'debuff', stat: 'physDef', pct: 15, durationSec: 8 }], cost: 120 }),
  passive({ id: 'sniper_watcher_vision', name: '감시자의 눈', job: 'sniper', mods: { accuracy: 15, range: 12 }, cost: 120 }),

  // ══════════ 마법사 ══════════
  active({ id: 'mage_bolt', name: '마력탄', job: 'mage', cd: 6, mp: 20, cast: 0.4, range: 7, target: 'enemy', effects: [{ kind: 'damage', school: 'magic', coef: 8.4 }], cost: 60 }),
  active({ id: 'mage_blast', name: '마력 폭발', job: 'mage', cd: 8, mp: 43, cast: 0.8, range: 7, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'magic', coef: 6.83 }], cost: 100, telegraph: TG }),
  active({ id: 'mage_arcane_storm', name: '비전 폭풍', flavor: '비전 마력의 폭풍을 불러온다.', job: 'mage', cd: 10, mp: 51, cast: 0.8, range: 7, target: 'enemy_area', radius: 3.5, effects: [{ kind: 'damage', school: 'magic', coef: 6.17 }], cost: 100, telegraph: TG_LARGE, linger: { durationSec: 5, dpsCoef: 1.75 }, lingerNoun: '폭풍' }),
  active({ id: 'mage_meteor', name: '메테오', flavor: '하늘에서 운석을 떨어뜨린다.', job: 'mage', magic: 'fire', cd: 17, mp: 77, cast: 1.5, range: 7, target: 'enemy_area', radius: 3.5, effects: [{ kind: 'damage', school: 'magic', coef: 9.0, magic: 'fire' }, { kind: 'status', status: 'burn', durationSec: 4, value: 30 }], cost: 130, telegraph: 1.5, linger: { durationSec: 4, dpsCoef: 2.1, status: { status: 'burn', durationSec: 2, value: 24 } }, lingerNoun: '불길' }),
  active({ id: 'mage_barrier', name: '마력 장벽', job: 'mage', cd: 15, mp: 34, range: 0, target: 'self', effects: [{ kind: 'status', status: 'shield', durationSec: 6, value: 1000 }], ai: 'self_hp_below_50', cost: 80 }),
  passive({ id: 'mage_meditation', name: '명상', job: 'mage', mods: { mpRegen: 30, maxMp: 20 }, cost: 70 }),
  passive({ id: 'mage_arcane_mind', name: '비전 지성', job: 'mage', mods: { magAtk: 10, castSpeed: 8 }, cost: 90 }),
  // 화염
  active({ id: 'mage_fire_fireball', name: '화염구', job: 'mage', magic: 'fire', cd: 9, mp: 43, cast: 0.8, range: 7, target: 'enemy', effects: [{ kind: 'damage', school: 'magic', coef: 11.09, magic: 'fire' }, { kind: 'status', status: 'burn', durationSec: 4, value: 30 }], cost: 120 }),
  active({ id: 'mage_fire_storm', name: '화염 폭풍', job: 'mage', magic: 'fire', cd: 12, mp: 68, cast: 1.5, range: 7, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'magic', coef: 7.5, magic: 'fire' }, { kind: 'status', status: 'burn', durationSec: 5, value: 24 }], cost: 150, telegraph: TG, linger: { durationSec: 5, dpsCoef: 2.28, status: { status: 'burn', durationSec: 2, value: 24 } }, lingerNoun: '불길' }),
  active({ id: 'mage_fire_rain', name: '화염 비', flavor: '불덩이를 비처럼 쏟아붓는다.', job: 'mage', magic: 'fire', cd: 14, mp: 68, cast: 1.0, range: 7, target: 'enemy_area', radius: 3.5, effects: [{ kind: 'damage', school: 'magic', coef: 6, magic: 'fire' }, { kind: 'status', status: 'burn', durationSec: 5, value: 24 }], cost: 150, telegraph: TG_LARGE, linger: { durationSec: 5, dpsCoef: 2.1, status: { status: 'burn', durationSec: 2, value: 24 } }, lingerNoun: '불길' }),
  passive({ id: 'mage_fire_armor', name: '불꽃 갑옷', job: 'mage', magic: 'fire', mods: { magDef: 8 }, status: [{ status: 'reflect', value: 0.15 }], cost: 110 }),
  // 전기
  active({ id: 'mage_lightning_chain', name: '연쇄 번개', job: 'mage', magic: 'lightning', cd: 8, mp: 43, cast: 0.6, range: 7, target: 'line', radius: 1.8, effects: [{ kind: 'damage', school: 'magic', coef: 6.14, magic: 'lightning' }, { kind: 'status', status: 'stun', durationSec: 1, chance: 0.35 }], cost: 120, telegraph: TG }),
  active({ id: 'mage_lightning_field', name: '뇌전 장막', job: 'mage', magic: 'lightning', cd: 12, mp: 60, cast: 1.0, range: 7, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'magic', coef: 5.63, magic: 'lightning' }, { kind: 'status', status: 'stun', durationSec: 0.8, chance: 0.5 }], cost: 140, telegraph: TG, linger: { durationSec: 5, dpsCoef: 2.1 }, lingerNoun: '뇌전' }),
  active({ id: 'mage_lightning_storm', name: '뇌우', flavor: '먹구름을 불러 벼락을 계속 떨어뜨린다.', job: 'mage', magic: 'lightning', cd: 15, mp: 77, cast: 1.0, range: 7, target: 'enemy_area', radius: 4, effects: [{ kind: 'damage', school: 'magic', coef: 5.25, magic: 'lightning' }, { kind: 'status', status: 'stun', durationSec: 1, chance: 0.45 }], cost: 150, telegraph: 1.2, linger: { durationSec: 6, dpsCoef: 1.75 }, lingerNoun: '뇌우' }),
  // 냉기
  active({ id: 'mage_ice_shard', name: '얼음 창', job: 'mage', magic: 'ice', cd: 8, mp: 34, cast: 0.6, range: 7, target: 'enemy', effects: [{ kind: 'damage', school: 'magic', coef: 10.2, magic: 'ice' }, { kind: 'status', status: 'slow', durationSec: 4, value: 0.5 }], cost: 120 }),
  active({ id: 'mage_ice_nova', name: '빙결 파동', job: 'mage', magic: 'ice', cd: 12, mp: 68, cast: 1.2, range: 7, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'magic', coef: 5.63, magic: 'ice' }, { kind: 'status', status: 'freeze', durationSec: 1.5, chance: 0.5 }], cost: 150, telegraph: TG, linger: { durationSec: 5, dpsCoef: 2.1, status: { status: 'slow', durationSec: 1, value: 0.5 } }, lingerNoun: '냉기' }),
  active({ id: 'mage_ice_blizzard', name: '블리자드', flavor: '눈보라를 불러 넓은 땅을 얼린다.', job: 'mage', magic: 'ice', cd: 15, mp: 77, cast: 1.2, range: 7, target: 'enemy_area', radius: 4, effects: [{ kind: 'damage', school: 'magic', coef: 5.25, magic: 'ice' }, { kind: 'status', status: 'freeze', durationSec: 1.2, chance: 0.35 }], cost: 150, telegraph: 1.2, linger: { durationSec: 6, dpsCoef: 1.75, status: { status: 'slow', durationSec: 1, value: 0.5 } }, lingerNoun: '눈보라' }),

  // ══════════ 소환사 ══════════
  active({ id: 'summoner_call_beast', name: '야수 소환', job: 'summoner', magic: 'nature', cd: 20, mp: 60, cast: 1.0, range: 0, target: 'self', effects: [{ kind: 'summon', unit: 'beast', count: 1, durationSec: 30 }], ai: 'no_summons', cost: 90 }),
  active({ id: 'summoner_drain', name: '마력 흡수', job: 'summoner', cd: 8, mp: 9, range: 6, target: 'enemy', effects: [{ kind: 'damage', school: 'magic', coef: 6.76 }, { kind: 'restore_mp', amount: 15 }], cost: 60 }),
  active({ id: 'summoner_spirit_burst', name: '정령 폭발', flavor: '정령의 힘을 한 점에 모아 터뜨린다.', job: 'summoner', magic: 'nature', cd: 9, mp: 43, cast: 0.6, range: 6, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'magic', coef: 7.4, magic: 'nature' }], cost: 100, telegraph: TG }),
  active({ id: 'summoner_empower', name: '소환물 강화', job: 'summoner', cd: 15, mp: 34, range: 0, target: 'ally_area', radius: 6, effects: [{ kind: 'buff', stat: 'physAtk', pct: 20, durationSec: 8 }, { kind: 'buff', stat: 'magAtk', pct: 20, durationSec: 8 }], cost: 90, note: '소환물도 받는다.' }),
  passive({ id: 'summoner_bond', name: '유대', job: 'summoner', mods: { maxHp: 8, magAtk: 8 }, cost: 70 }),
  passive({ id: 'summoner_deep_well', name: '깊은 마력', job: 'summoner', mods: { maxMp: 30, mpRegen: 25 }, cost: 80 }),
  // 야수 소환사
  active({ id: 'summoner_beast_pack', name: '야수 무리', job: 'summoner', magic: 'nature', cd: 22, mp: 68, cast: 1.2, range: 0, target: 'self', effects: [{ kind: 'summon', unit: 'beast', count: 2, durationSec: 25 }], ai: 'no_summons', cost: 130 }),
  passive({ id: 'summoner_beast_fury', name: '야수의 분노', flavor: '소환물은 소환사의 공격력을 따른다.', job: 'summoner', mods: { physAtk: 15, atkSpeed: 10 }, cost: 100 }),
  // 정령 소환사
  active({ id: 'summoner_spirit_call', name: '정령 소환', job: 'summoner', cd: 20, mp: 60, cast: 1.0, range: 0, target: 'self', effects: [{ kind: 'summon', unit: 'spirit', count: 2, durationSec: 25 }], ai: 'no_summons', cost: 130 }),
  passive({ id: 'summoner_spirit_link', name: '정령 연결', job: 'summoner', mods: { magAtk: 12, mpRegen: 15 }, cost: 100 }),
  // 사령술사
  active({ id: 'summoner_necro_raise', name: '사령 소환', job: 'summoner', magic: 'shadow', cd: 22, mp: 68, cast: 1.2, range: 0, target: 'self', effects: [{ kind: 'summon', unit: 'skeleton', count: 3, durationSec: 25 }], ai: 'no_summons', cost: 130 }),
  active({ id: 'summoner_necro_curse', name: '저주', job: 'summoner', magic: 'shadow', cd: 10, mp: 43, cast: 0.5, range: 6, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'magic', coef: 9.95, magic: 'shadow' }, { kind: 'debuff', stat: 'physAtk', pct: 20, durationSec: 6 }], cost: 110, telegraph: TG }),

  // ══════════ 힐러 ══════════
  active({ id: 'healer_heal', name: '치유', job: 'healer', magic: 'holy', cd: 6, mp: 34, cast: 0.6, range: 6, target: 'ally_lowest_hp', effects: [{ kind: 'heal', coef: 5.6 }], ai: 'ally_hp_below_60', cost: 60 }),
  active({ id: 'healer_group_heal', name: '광역 치유', job: 'healer', magic: 'holy', cd: 15, mp: 60, cast: 1.0, range: 0, target: 'ally_area', radius: 4, effects: [{ kind: 'heal', coef: 3.36 }], ai: 'ally_hp_below_60', cost: 110 }),
  active({ id: 'healer_smite', name: '응징', job: 'healer', magic: 'holy', cd: 7, mp: 17, range: 6, target: 'enemy', effects: [{ kind: 'damage', school: 'magic', coef: 6.24, magic: 'holy' }], cost: 60 }),
  active({ id: 'healer_judgment', name: '심판의 빛', flavor: '하늘에서 신성한 빛기둥을 내린다.', job: 'healer', magic: 'holy', cd: 10, mp: 43, cast: 0.8, range: 6, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'magic', coef: 6.8, magic: 'holy' }], cost: 100, telegraph: TG }),
  passive({ id: 'healer_blessing', name: '축복', job: 'healer', magic: 'holy', mods: { magDef: 10, maxHp: 5 }, cost: 70 }),
  passive({ id: 'healer_serenity', name: '평정', job: 'healer', mods: { mpRegen: 25, castSpeed: 10 }, cost: 80 }),
  // 신관
  active({ id: 'healer_priest_great_heal', name: '대치유', job: 'healer', magic: 'holy', cd: 12, mp: 60, cast: 1.0, range: 6, target: 'ally_lowest_hp', effects: [{ kind: 'heal', coef: 8.4 }], ai: 'ally_hp_below_40', cost: 130 }),
  active({ id: 'healer_priest_purify', name: '정화', job: 'healer', magic: 'holy', cd: 10, mp: 34, range: 6, target: 'ally_lowest_hp', effects: [{ kind: 'cleanse' }, { kind: 'heal', coef: 2.8 }], ai: 'ally_hp_below_60', cost: 110 }),
  // 드루이드
  active({ id: 'healer_druid_regrowth', name: '재생', job: 'healer', magic: 'nature', cd: 10, mp: 34, cast: 0.4, range: 6, target: 'ally_lowest_hp', effects: [{ kind: 'heal', coef: 2.24 }, { kind: 'status', status: 'regen', durationSec: 8, value: 36 }], ai: 'ally_hp_below_60', cost: 120 }),
  active({ id: 'healer_druid_thorns', name: '가시 덩굴', job: 'healer', magic: 'nature', cd: 8, mp: 43, cast: 0.6, range: 6, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'magic', coef: 5.36, magic: 'nature' }, { kind: 'status', status: 'slow', durationSec: 3, value: 0.4 }], cost: 110, telegraph: TG, linger: { durationSec: 4, dpsCoef: 1.93, status: { status: 'slow', durationSec: 1, value: 0.4 } }, lingerNoun: '덩굴' }),
  // 결계사
  active({ id: 'healer_ward_barrier', name: '보호 결계', job: 'healer', magic: 'holy', cd: 16, mp: 60, cast: 0.8, range: 0, target: 'ally_area', radius: 4, effects: [{ kind: 'status', status: 'shield', durationSec: 6, value: 900 }], ai: 'ally_hp_below_60', cost: 130 }),
  active({ id: 'healer_ward_empower', name: '결계 강화', job: 'healer', magic: 'holy', cd: 18, mp: 51, cast: 0.5, range: 0, target: 'ally_area', radius: 4, effects: [{ kind: 'buff', stat: 'physDef', pct: 15, durationSec: 8 }, { kind: 'buff', stat: 'magDef', pct: 15, durationSec: 8 }], cost: 120 }),
];

// ───────────────────────── 몬스터 전용 스킬 ─────────────────────────
//
// id 는 전부 'mon_' 으로 시작한다. 어떤 직업 풀(JobDef.skillPool / SubJobDef.skillPool)에도 넣지 않으므로
// skillPoolFor 가 절대 돌려주지 않는다 (아래에 방어 필터도 둔다). 상점·선택지에도 등장하지 않는다.
// job 필드는 표시·AI 성향 참고용이며 실제 소속 풀과는 무관하다.
//
// '보스 장판' 스킬(mon_slime_wave / mon_shockwave / mon_quake_field / mon_glacial_prison / mon_meteor_fall)은
// 인원 1~2 의 거대 보스용이다: 반경 4~6, 예고 1.2~1.5초, 장판 2~4초. aiCondition 을 두지 않아 쿨타임마다 쓴다
// (보스 혼자 4명을 상대하므로 '적 2명 이상 밀집' 조건이면 거의 발동하지 못한다).
// v0.6: 플레이어와 같은 배율(단일 ×1.6, 광역 ×1.5, 장판 ×1.4, 회복 ×1.4)로 올려 상대 관계를 유지한다.

/** 몬스터 전용 스킬 id 접두사 */
export const MONSTER_SKILL_PREFIX = 'mon_';

export function isMonsterSkillId(id: string): boolean {
  return id.slice(0, MONSTER_SKILL_PREFIX.length) === MONSTER_SKILL_PREFIX;
}

const MONSTER_SKILL_LIST: SkillDef[] = [
  // ══════════ 하급 몬스터 ══════════
  active({ id: 'mon_bite', name: '물어뜯기', job: 'berserker', cd: 6, mp: 14, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 5.6 }], cost: 60 }),
  active({ id: 'mon_pack_howl', name: '무리의 포효', job: 'berserker', cd: 14, mp: 26, range: 0, target: 'ally_area', radius: 6, effects: [{ kind: 'buff', stat: 'physAtk', pct: 18, durationSec: 6 }, { kind: 'buff', stat: 'atkSpeed', pct: 10, durationSec: 6 }], cost: 90 }),
  passive({ id: 'mon_swarm_instinct', name: '군집 본능', flavor: '무리로 몰려다닌다.', job: 'berserker', mods: { atkSpeed: 10, evasion: 8 }, cost: 70 }),
  active({ id: 'mon_acid_splash', name: '산성 점액', job: 'tank', cd: 10, mp: 26, range: MELEE, target: 'enemy_area', radius: 2.5, effects: [{ kind: 'damage', school: 'phys', coef: 4.5 }, { kind: 'status', status: 'slow', durationSec: 3, value: 0.35 }], cost: 80, telegraph: TG_SHORT }),
  passive({ id: 'mon_tough_hide', name: '질긴 가죽', job: 'tank', mods: { physDef: 14, maxHp: 8 }, cost: 70 }),
  active({ id: 'mon_rusty_slash', name: '녹슨 칼질', job: 'swordsman', cd: 7, mp: 17, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 5.2 }], cost: 60 }),
  active({ id: 'mon_crude_arrow', name: '조잡한 화살', job: 'archer', cd: 7, mp: 17, range: 8, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 5.2 }], cost: 60 }),
  active({ id: 'mon_screech', name: '초음파 비명', job: 'assassin', cd: 11, mp: 26, range: 5, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'phys', coef: 3.6 }, { kind: 'status', status: 'slow', durationSec: 3, value: 0.4 }], ai: 'enemies_clustered_2', cost: 80, telegraph: TG }),
  passive({ id: 'mon_erratic_flight', name: '불규칙한 비행', flavor: '궤적을 읽기 어렵다.', job: 'assassin', mods: { evasion: 18, moveSpeed: 8 }, cost: 80 }),
  active({ id: 'mon_venom_spore', name: '독포자', job: 'healer', magic: 'nature', cd: 12, mp: 34, cast: 0.5, range: 6, target: 'enemy_area', radius: 2.5, effects: [{ kind: 'damage', school: 'magic', coef: 3.38, magic: 'nature' }, { kind: 'status', status: 'poison', durationSec: 5, value: 20 }], cost: 90, telegraph: TG, linger: { durationSec: 3, dpsCoef: 0.88, status: { status: 'poison', durationSec: 2, value: 12 } }, lingerNoun: '포자' }),
  active({ id: 'mon_spore_mend', name: '포자 치유', job: 'healer', magic: 'nature', cd: 8, mp: 34, cast: 0.5, range: 6, target: 'ally_lowest_hp', effects: [{ kind: 'heal', coef: 4.48 }], ai: 'ally_hp_below_60', cost: 90 }),
  // 하급 보스 장판 (거대 슬라임)
  active({ id: 'mon_slime_wave', name: '점액 파도', job: 'tank', cd: 14, mp: 34, cast: 0.6, range: 4, target: 'enemy_area', radius: 4, effects: [{ kind: 'damage', school: 'phys', coef: 4.88 }, { kind: 'status', status: 'slow', durationSec: 3, value: 0.4 }], cost: 110, telegraph: 1.2, linger: { durationSec: 3, dpsCoef: 0.88, status: { status: 'slow', durationSec: 1, value: 0.45 } }, lingerNoun: '점액' }),
  passive({ id: 'mon_gelatinous_body', name: '젤리 몸체', flavor: '타격이 몸 속으로 파묻힌다.', job: 'tank', mods: { maxHp: 20, physDef: 12 }, cost: 90 }),

  // ══════════ 중급 몬스터 ══════════
  active({ id: 'mon_heavy_cleave', name: '거친 내려치기', job: 'swordsman', cd: 8, mp: 26, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 7.6 }], cost: 100 }),
  active({ id: 'mon_war_cry', name: '전투 함성', job: 'tank', cd: 16, mp: 34, range: 0, target: 'ally_area', radius: 6, effects: [{ kind: 'buff', stat: 'physAtk', pct: 20, durationSec: 8 }, { kind: 'buff', stat: 'physDef', pct: 15, durationSec: 8 }], cost: 110 }),
  passive({ id: 'mon_iron_carapace', name: '강철 외피', job: 'tank', mods: { physDef: 18, magDef: 10, maxHp: 6 }, cost: 110 }),
  active({ id: 'mon_shield_slam', name: '방패 밀치기', job: 'tank', cd: 11, mp: 26, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 4.8 }, { kind: 'status', status: 'stun', durationSec: 1, chance: 0.55 }], cost: 100 }),
  active({ id: 'mon_wing_gust', name: '날갯짓', job: 'archer', cd: 12, mp: 26, range: 8, target: 'enemy', effects: [{ kind: 'knockback', distance: 3 }, { kind: 'damage', school: 'phys', coef: 4.8 }], cost: 100 }),
  active({ id: 'mon_dive_strike', name: '급강하', job: 'archer', cd: 11, mp: 26, range: 9, target: 'enemy', effects: [{ kind: 'dash', distance: 7 }, { kind: 'damage', school: 'phys', coef: 6.8 }], ai: 'out_of_range', cost: 110 }),
  active({ id: 'mon_backstab', name: '뒤치기', job: 'assassin', cd: 9, mp: 26, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 8, bonusIfStealth: 0.8 }], cost: 110 }),
  active({ id: 'mon_smoke_bomb', name: '연막탄', job: 'assassin', cd: 15, mp: 26, range: 0, target: 'self', effects: [{ kind: 'status', status: 'stealth', durationSec: 3 }], ai: 'not_stealthed', cost: 90 }),
  active({ id: 'mon_haunting_bolt', name: '원혼탄', job: 'mage', magic: 'shadow', cd: 8, mp: 31, cast: 0.5, range: 7, target: 'enemy', effects: [{ kind: 'damage', school: 'magic', coef: 7.2, magic: 'shadow' }], cost: 110 }),
  active({ id: 'mon_wail_of_woe', name: '비탄의 울음', job: 'mage', magic: 'shadow', cd: 14, mp: 48, cast: 0.8, range: 7, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'magic', coef: 5.85, magic: 'shadow' }, { kind: 'debuff', stat: 'physAtk', pct: 20, durationSec: 6 }], ai: 'enemies_clustered_2', cost: 120, telegraph: TG }),
  active({ id: 'mon_dark_ritual', name: '어둠의 의식', job: 'healer', magic: 'shadow', cd: 14, mp: 51, cast: 0.8, range: 0, target: 'ally_area', radius: 5, effects: [{ kind: 'heal', coef: 3.36 }, { kind: 'buff', stat: 'magDef', pct: 15, durationSec: 8 }], ai: 'ally_hp_below_60', cost: 120 }),
  // 중급 보스 장판 (오크 대족장)
  active({ id: 'mon_shockwave', name: '충격파', job: 'swordsman', cd: 14, mp: 43, cast: 0.6, range: 5, target: 'enemy_area', radius: 4, effects: [{ kind: 'damage', school: 'phys', coef: 7.13 }, { kind: 'knockback', distance: 2 }], cost: 130, telegraph: 1.2, linger: { durationSec: 2, dpsCoef: 1.05 }, lingerNoun: '흔들리는 땅' }),
  passive({ id: 'mon_chieftain_might', name: '대족장의 위엄', job: 'swordsman', mods: { physAtk: 15, maxHp: 15, physDef: 8 }, cost: 120 }),

  // ══════════ 고급 몬스터 ══════════
  active({ id: 'mon_frost_breath', name: '서리 숨결', job: 'mage', magic: 'ice', cd: 14, mp: 60, cast: 1.0, range: 8, target: 'enemy_area', radius: 3.5, effects: [{ kind: 'damage', school: 'magic', coef: 9.9, magic: 'ice' }, { kind: 'status', status: 'freeze', durationSec: 1.5, chance: 0.5 }], cost: 150, telegraph: TG }),
  active({ id: 'mon_dragon_roar', name: '용의 포효', job: 'mage', cd: 18, mp: 43, range: 8, target: 'enemy_area', radius: 6, effects: [{ kind: 'debuff', stat: 'physAtk', pct: 25, durationSec: 8 }, { kind: 'status', status: 'stun', durationSec: 0.8, chance: 0.3 }], cost: 140, telegraph: TG }),
  passive({ id: 'mon_ice_scale', name: '서리 비늘', job: 'mage', magic: 'ice', mods: { magDef: 20, maxHp: 12 }, cost: 130 }),
  active({ id: 'mon_abyss_claw', name: '심연의 발톱', job: 'berserker', magic: 'shadow', cd: 9, mp: 31, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 9.6, ignoreDefPct: 0.4 }], cost: 150 }),
  active({ id: 'mon_devour', name: '포식', job: 'berserker', cd: 12, mp: 34, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 8 }, { kind: 'status', status: 'lifesteal', durationSec: 6, value: 0.35 }], cost: 150 }),
  passive({ id: 'mon_dread_aura', name: '공포의 기운', job: 'berserker', magic: 'shadow', mods: { physAtk: 14, maxHp: 12 }, cost: 130 }),
  active({ id: 'mon_death_bolt', name: '죽음의 화살', job: 'mage', magic: 'shadow', cd: 9, mp: 43, cast: 0.6, range: 8, target: 'enemy', effects: [{ kind: 'damage', school: 'magic', coef: 9.6, magic: 'shadow' }], cost: 150 }),
  active({ id: 'mon_soul_drain', name: '영혼 흡수', job: 'mage', magic: 'shadow', cd: 10, mp: 34, cast: 0.4, range: 7, target: 'enemy', effects: [{ kind: 'damage', school: 'magic', coef: 6.4, magic: 'shadow' }, { kind: 'heal', coef: 2.8 }], cost: 140, note: '회복은 자신에게.' }),
  active({ id: 'mon_raise_dead', name: '망자 소환', job: 'summoner', magic: 'shadow', cd: 24, mp: 68, cast: 1.2, range: 0, target: 'self', effects: [{ kind: 'summon', unit: 'skeleton', count: 3, durationSec: 30 }], ai: 'no_summons', cost: 150 }),
  active({ id: 'mon_earth_slam', name: '대지 분쇄', job: 'tank', cd: 15, mp: 51, cast: 0.5, range: MELEE, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'phys', coef: 9 }, { kind: 'status', status: 'stun', durationSec: 1.2, chance: 0.6 }], cost: 150, telegraph: TG }),
  passive({ id: 'mon_granite_skin', name: '화강암 피부', job: 'tank', mods: { physDef: 28, maxHp: 15 }, cost: 140 }),
  passive({ id: 'mon_sovereign_aura', name: '군주의 위압', job: 'tank', mods: { maxHp: 20, physAtk: 12 }, cost: 150 }),
  active({ id: 'mon_hellfire', name: '지옥불', job: 'mage', magic: 'fire', cd: 16, mp: 60, cast: 1.2, range: 7, target: 'enemy_area', radius: 3, effects: [{ kind: 'damage', school: 'magic', coef: 7.5, magic: 'fire' }, { kind: 'status', status: 'burn', durationSec: 5, value: 40 }], ai: 'enemies_clustered_2', cost: 150, telegraph: TG, linger: { durationSec: 3, dpsCoef: 1.4, status: { status: 'burn', durationSec: 2, value: 30 } }, lingerNoun: '불길' }),
  active({ id: 'mon_demon_rend', name: '마신의 참격', job: 'swordsman', magic: 'shadow', cd: 8, mp: 31, range: MELEE, target: 'enemy', effects: [{ kind: 'damage', school: 'phys', coef: 9.2 }], cost: 150 }),
  active({ id: 'mon_dark_blessing', name: '암흑 축복', job: 'healer', magic: 'shadow', cd: 16, mp: 43, cast: 0.5, range: 0, target: 'ally_area', radius: 5, effects: [{ kind: 'buff', stat: 'physAtk', pct: 20, durationSec: 8 }, { kind: 'buff', stat: 'magAtk', pct: 20, durationSec: 8 }], cost: 140 }),
  active({ id: 'mon_unholy_mend', name: '사악한 치유', job: 'healer', magic: 'shadow', cd: 9, mp: 43, cast: 0.6, range: 6, target: 'ally_lowest_hp', effects: [{ kind: 'heal', coef: 6.72 }], ai: 'ally_hp_below_60', cost: 140 }),
  // 고급 보스 장판 (고대 골렘 / 서리 드래곤 / 화염 거인)
  active({ id: 'mon_quake_field', name: '대지진', job: 'tank', cd: 16, mp: 51, cast: 0.8, range: 6, target: 'enemy_area', radius: 5, effects: [{ kind: 'damage', school: 'phys', coef: 6.75 }, { kind: 'status', status: 'stun', durationSec: 0.8, chance: 0.4 }], cost: 160, telegraph: 1.4, linger: { durationSec: 3, dpsCoef: 1.23, status: { status: 'slow', durationSec: 1, value: 0.4 } }, lingerNoun: '갈라진 대지' }),
  active({ id: 'mon_glacial_prison', name: '빙하 감옥', job: 'mage', magic: 'ice', cd: 16, mp: 60, cast: 1.0, range: 8, target: 'enemy_area', radius: 4.5, effects: [{ kind: 'damage', school: 'magic', coef: 6, magic: 'ice' }, { kind: 'status', status: 'freeze', durationSec: 1.5, chance: 0.4 }], cost: 160, telegraph: 1.3, linger: { durationSec: 4, dpsCoef: 1.05, status: { status: 'slow', durationSec: 1, value: 0.5 } }, lingerNoun: '얼어붙은 바닥' }),
  active({ id: 'mon_meteor_fall', name: '유성 낙하', job: 'mage', magic: 'fire', cd: 18, mp: 68, cast: 1.0, range: 8, target: 'enemy_area', radius: 4, effects: [{ kind: 'damage', school: 'magic', coef: 9, magic: 'fire' }], cost: 160, telegraph: 1.5, linger: { durationSec: 3, dpsCoef: 1.58, status: { status: 'burn', durationSec: 2, value: 36 } }, lingerNoun: '불바다' }),
  passive({ id: 'mon_molten_core', name: '용암 심장', job: 'mage', magic: 'fire', mods: { magAtk: 15, maxHp: 15, magDef: 10 }, cost: 150 }),
  passive({ id: 'mon_ancient_bulk', name: '태고의 거체', flavor: '수천 년을 버틴 바위 몸.', job: 'tank', mods: { maxHp: 25, physDef: 20, magDef: 12 }, cost: 160 }),
];

// ───────────────────────── 조회 ─────────────────────────

/** 플레이어 스킬 + 몬스터 스킬. 정의 순서 고정 (플레이어 먼저) */
const ALL_SKILL_LIST: SkillDef[] = SKILL_LIST.concat(MONSTER_SKILL_LIST);

function buildSkillMap(): Record<string, SkillDef> {
  const out: Record<string, SkillDef> = {};
  for (const s of ALL_SKILL_LIST) {
    if (out[s.id]) throw new Error(`스킬 id 중복: ${s.id}`);
    if (s.linger && (s.linger.durationSec <= 0 || s.linger.dpsCoef < 0)) throw new Error(`장판 정의 오류: ${s.id}`);
    if (s.telegraphSec !== undefined && s.telegraphSec < 0) throw new Error(`예고 시간 오류: ${s.id}`);
    if (s.type === 'active' && (s.target === 'enemy_area' || s.target === 'line' || s.target === 'ally_area') && !(s.radius && s.radius > 0)) {
      throw new Error(`광역 스킬에 반경이 없다: ${s.id}`);
    }
    out[s.id] = s;
  }
  return out;
}

export const SKILLS: Record<string, SkillDef> = buildSkillMap();

/** 정의 순서가 고정된 플레이어 스킬 id 목록 (몬스터 전용 스킬 제외) */
export const SKILL_IDS: readonly string[] = SKILL_LIST.map((s) => s.id);

/** 몬스터 전용 스킬 id 목록 (정의 순서 고정) */
export const MONSTER_SKILL_IDS: readonly string[] = MONSTER_SKILL_LIST.map((s) => s.id);

/** 플레이어 + 몬스터 전체 스킬 id 목록 (정의 순서 고정) */
export const ALL_SKILL_IDS: readonly string[] = ALL_SKILL_LIST.map((s) => s.id);

export function getSkill(id: string): SkillDef {
  const def = SKILLS[id];
  if (!def) throw new Error(`알 수 없는 스킬: ${id}`);
  return def;
}

/** 광역(영역) 스킬인지: enemy_area / line / ally_area */
export function isAreaSkill(sk: SkillDef): boolean {
  return sk.target === 'enemy_area' || sk.target === 'line' || sk.target === 'ally_area';
}

/** 피해 효과가 하나라도 있는지 */
export function skillDealsDamage(sk: SkillDef): boolean {
  for (let i = 0; i < sk.effects.length; i++) if (sk.effects[i].kind === 'damage') return true;
  return false;
}

/** 적 광역 피해 스킬인지 (enemy_area / line 이고 피해 효과가 있음). 직업 풀 검증·UI 표시용 */
export function isAoeDamageSkill(sk: SkillDef): boolean {
  return (sk.target === 'enemy_area' || sk.target === 'line') && skillDealsDamage(sk);
}

/**
 * Zone(영역 예고·장판)을 만드는 스킬인지. UI 의 스킬명 외치기 연출이 말풍선 크기를 정할 때 쓴다.
 * 대상이 enemy_area / line 이거나, telegraphSec 또는 linger 가 정의된 스킬이면 true. 모르는 id 는 false.
 */
export function isZoneSkill(id: string): boolean {
  const sk = SKILLS[id];
  if (!sk) return false;
  if (sk.target === 'enemy_area' || sk.target === 'line') return true;
  if (sk.telegraphSec !== undefined && sk.telegraphSec > 0) return true;
  if (sk.linger !== undefined && sk.linger.durationSec > 0) return true;
  return false;
}

/**
 * 보조기: 기절·둔화·이동·넉백·MP 회복이 본체이고 피해는 덤인 액티브. 계수 메모의 주력기 목표(단일 18~30%, 광역 12~20%)
 * 대상이 아니며 8~13% 를 참고치로 둔다. 헤드리스 주력기 표는 이 목록을 '보조' 로 표시하고 판정하지 않는다.
 */
export const UTILITY_SKILL_IDS: readonly string[] = [
  'tank_bash', 'healer_smite', 'summoner_drain', 'sniper_kneecap',
  'berserker_leap', 'swordsman_charge', 'archer_retreat_shot', 'assassin_poison_blade',
];

/**
 * 스킬의 실효 예고 시간(초). SkillDef.telegraphSec 이 있으면 그 값, 없으면 GDD §6.5.1 의 기본 규칙:
 *  - ally_area → 0 (즉시)
 *  - enemy_area / line 피해 스킬: 시전자 중심 소형 근접 광역(radius ≤ 2.5, range ≤ 2) → SHORT_TELEGRAPH_SEC, 그 외 DEFAULT_TELEGRAPH_SEC
 *  - 피해 없는 enemy_area / line → 0
 *  - 광역이 아닌 스킬 → 0
 * sim 이 같은 규칙을 쓰도록 편의 제공. 데이터에서는 되도록 명시한다.
 */
export function effectiveTelegraphSec(sk: SkillDef): number {
  if (sk.telegraphSec !== undefined) return sk.telegraphSec < 0 ? 0 : sk.telegraphSec;
  if (sk.target === 'ally_area') return 0;
  if (sk.target !== 'enemy_area' && sk.target !== 'line') return 0;
  if (!skillDealsDamage(sk)) return 0;
  const r = sk.radius ?? 0;
  if (sk.target === 'enemy_area' && r <= 2.5 && sk.range <= 2) return SHORT_TELEGRAPH_SEC;
  return DEFAULT_TELEGRAPH_SEC;
}

/**
 * 캐릭터가 아직 모르는, 습득 가능한 스킬 id (메인 풀 + 세부 직업 풀). 순서 고정.
 * 몬스터 전용 스킬('mon_')은 절대 포함되지 않는다.
 */
export function skillPoolFor(c: Character): string[] {
  const known = new Set(c.skills);
  const out: string[] = [];
  const push = (id: string) => {
    if (isMonsterSkillId(id)) return;
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

/** 특정 직업 풀 전체 (메인 + 모든 세부 직업의 granted/pool). 표시/상점용. 몬스터 전용 스킬은 제외 */
export function allSkillsOfJob(job: MainJob): SkillDef[] {
  return SKILL_LIST.filter((s) => s.job === job);
}

/** 몬스터 전용 스킬 정의 목록 (표시/디버그용) */
export function allMonsterSkills(): SkillDef[] {
  return MONSTER_SKILL_LIST.slice();
}
