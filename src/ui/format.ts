/**
 * UI 표시용 헬퍼: 한국어 라벨, 숫자 포맷, DOM 생성 헬퍼.
 * core 를 읽기만 하고 상태를 바꾸지 않는다.
 */
import {
  BASE_STAT_KEYS,
  CHOICE_RARITY_COLOR,
  CHOICE_RARITY_NAME_KO,
  DAY_STEPS,
  JOB_NAME_KO,
  MONSTER_TIER_NAME_KO,
  MONSTER_TIER_ORDER,
  STAT_CATEGORY,
  STEPS_PER_DAY,
  STEP_KIND_NAME_KO,
  stepKindOf,
  type BaseStatKey,
  type Character,
  type ChoiceRarity,
  type MainJob,
  type MonsterTier,
  type RunPhase,
  type StatCategory,
  type StepKind,
  type SubJobId,
  type Team,
  type VictoryRule,
} from '../core/types';
import { SUBJOBS } from '../core/data/jobs';
import { getSkill } from '../core/data/skills';
import { powerRating, statTotal } from '../core/stats';
import { expectedPlayerPower } from '../core/data/monsters';

/** 캔버스 아이콘용 직업 한 글자 */
export const JOB_GLYPH: Record<MainJob, string> = {
  swordsman: '검', tank: '탱', berserker: '광', assassin: '암', archer: '궁',
  sniper: '저', mage: '마', summoner: '소', healer: '힐',
};

/** 캔버스 아이콘용 몬스터 한 글자 (난이도별) */
export const MONSTER_GLYPH: Record<MonsterTier, string> = {
  low: '몬', mid: '마', high: '왕',
};

/** 몬스터 난이도 표시 색 (카드 테두리 등) */
export const MONSTER_TIER_COLOR: Record<MonsterTier, string> = {
  low: '#9d6bb0', mid: '#d4587c', high: '#ff6b4a',
};

/** 난이도별 목표 승률 안내 문구 (GDD 7.3.1) */
export const MONSTER_TIER_HINT_KO: Record<MonsterTier, string> = {
  low: '거의 확실한 승리',
  mid: '유리하지만 방심은 금물',
  high: '반반. 크게 벌거나 크게 잃는다',
};

export const REASON_KO: Record<string, string> = {
  annihilation: '상대 전멸',
  timeout_hp: '시간 종료 · 잔여 HP 합 비교',
  capture: '거점 점령',
  timeout_draw: '시간 종료 · 무승부',
  timeout_capture: '시간 종료 · 거점 점령 진행도 비교',
  timeout: '시간 종료',
};

export function reasonKo(reason: string): string {
  return REASON_KO[reason] ?? reason;
}

export const VICTORY_KO: Record<VictoryRule, string> = {
  annihilation: '상대 전멸 (시간 초과 시 무승부)',
  annihilation_or_hp: '상대 전멸 또는 시간 종료 시 잔여 HP 합 비교',
  capture_or_annihilation: '중앙 거점 점령 또는 상대 전멸',
};

export function stars(rarity: number): string {
  const r = Math.max(1, Math.min(5, Math.round(rarity)));
  return '★'.repeat(r) + '☆'.repeat(5 - r);
}

export function fmtSec(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

export function fmtNum(n: number): string {
  return Math.round(n).toLocaleString('ko-KR');
}

export function fmtPct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/** 부호를 붙인 정수 ('+12' / '-5' / '0') */
export function fmtSigned(n: number): string {
  const v = Math.round(n);
  return v > 0 ? `+${v}` : String(v);
}

/** 카테고리별 평균 스탯 (신체/정신/기술/이능) */
export function categoryAverages(c: Character): Record<StatCategory, number> {
  const sum: Record<StatCategory, number> = { body: 0, mind: 0, skill: 0, magic: 0 };
  const cnt: Record<StatCategory, number> = { body: 0, mind: 0, skill: 0, magic: 0 };
  for (const k of BASE_STAT_KEYS) {
    const cat = STAT_CATEGORY[k];
    sum[cat] += c.stats[k] ?? 0;
    cnt[cat] += 1;
  }
  return {
    body: cnt.body ? sum.body / cnt.body : 0,
    mind: cnt.mind ? sum.mind / cnt.mind : 0,
    skill: cnt.skill ? sum.skill / cnt.skill : 0,
    magic: cnt.magic ? sum.magic / cnt.magic : 0,
  };
}

export function statsOfCategory(cat: StatCategory): BaseStatKey[] {
  return BASE_STAT_KEYS.filter((k) => STAT_CATEGORY[k] === cat);
}

/** 세부 직업 표시명 (모르면 id 그대로) */
export function subJobName(id: SubJobId | null): string {
  if (!id) return '';
  try {
    const def = SUBJOBS[id];
    return def ? def.name : id;
  } catch {
    return id;
  }
}

/** '마법사 · 화염 마법사' 형태 */
export function jobLabel(c: Pick<Character, 'mainJob' | 'subJob'>): string {
  const main = JOB_NAME_KO[c.mainJob] ?? c.mainJob;
  const sub = subJobName(c.subJob);
  return sub ? `${main} · ${sub}` : main;
}

export function skillName(id: string): string {
  try {
    return getSkill(id).name;
  } catch {
    return id;
  }
}

export function skillTypeKo(id: string): string {
  try {
    return getSkill(id).type === 'active' ? '액티브' : '패시브';
  } catch {
    return '';
  }
}

// ───────────── 전투력 ─────────────

/** 캐릭터 전투력 (스킬/세부직업 데이터가 깨져 있어도 예외를 던지지 않는다) */
export function safePower(c: Character): number {
  try {
    return Math.round(powerRating(c));
  } catch {
    return statTotal(c);
  }
}

// ───────────── 희귀도 ─────────────

export function rarityKo(r: ChoiceRarity): string {
  return CHOICE_RARITY_NAME_KO[r] ?? r;
}

export function rarityColor(r: ChoiceRarity): string {
  return CHOICE_RARITY_COLOR[r] ?? '#9aa3ad';
}

// ───────────── 일차 / 스텝 ─────────────

export function phaseKo(p: RunPhase): string {
  switch (p) {
    case 'select_team': return '팀 선택';
    case 'choice': return '선택지';
    case 'monster_select': return '몬스터 난이도 선택';
    case 'monster_battle': return '몬스터 전투';
    case 'pre_battle': return '전투 준비';
    case 'battle': return '5:5 전투';
    case 'day_end': return '하루 마무리';
    case 'done': return '육성 완료';
    default: return String(p);
  }
}

export function stepKindKo(step: number): string {
  return STEP_KIND_NAME_KO[stepKindOf(step)];
}

/** '3스텝 · 몬스터' */
export function stepLabel(step: number): string {
  if (step <= 0 || step > STEPS_PER_DAY) return '—';
  return `${step}스텝 · ${stepKindKo(step)}`;
}

/** 하루 5스텝의 종류 목록 (HUD 칩용) */
export function dayStepKinds(): StepKind[] {
  return DAY_STEPS.slice();
}

// ───────────── 몬스터 ─────────────

export function tierKo(t: MonsterTier): string {
  return MONSTER_TIER_NAME_KO[t] ?? t;
}

/** 몬스터 팀 편성 미리보기: 같은 종류를 묶어 '슬라임 ×3' 형태로 */
export function composition(team: Team): { label: string; job: MainJob; count: number }[] {
  const out: { label: string; job: MainJob; count: number }[] = [];
  for (const c of team.members) {
    // '슬라임 A' / '슬라임 2' 처럼 뒤에 붙은 개체 구분자를 떼어 같은 종류로 묶는다
    const label = c.name.replace(/[\s_-]*(?:[A-Z]|\d+)$/, '').trim() || c.name;
    const found = out.find((x) => x.label === label && x.job === c.mainJob);
    if (found) found.count += 1;
    else out.push({ label, job: c.mainJob, count: 1 });
  }
  return out;
}

export type DifficultyLevel = 'easy' | 'normal' | 'hard' | 'deadly';

const DIFFICULTY_STEPS: readonly { label: string; level: DifficultyLevel }[] = [
  { label: '쉬움', level: 'easy' },
  { label: '보통', level: 'normal' },
  { label: '어려움', level: 'hard' },
  { label: '매우 위험', level: 'deadly' },
];

/**
 * 몬스터 전투력 / 우리 팀 전투력 비율 → 한국어 난이도 라벨 (일반 비교용).
 *
 * 주의: 몬스터 카드에는 쓰지 않는다. 전투력은 '스탯 합 + 스킬 × 30' 점수라서 같은 점수라도
 * 소수 정예가 다수 약체보다 훨씬 강하다. 실제로 하급 '동굴 박쥐 떼'는 점수비 1.16, 고급 '골렘 군주'는
 * 0.67 로 나와 점수비만 보면 난이도가 거꾸로 표시된다. 카드에는 monsterDifficultyKo 를 쓸 것.
 */
export function difficultyKo(ratio: number): { label: string; level: DifficultyLevel } {
  if (!Number.isFinite(ratio) || ratio <= 0) return { label: '알 수 없음', level: 'normal' };
  if (ratio < 0.7) return DIFFICULTY_STEPS[0];
  if (ratio < 0.95) return DIFFICULTY_STEPS[1];
  if (ratio < 1.2) return DIFFICULTY_STEPS[2];
  return DIFFICULTY_STEPS[3];
}

/**
 * 몬스터 카드용 예상 난이도.
 * 기준은 난이도 등급(하급 쉬움 / 중급 보통 / 고급 어려움)이고, 우리 팀이 그 일차의
 * 표준 성장 곡선(monsters.ts 의 expectedPlayerPower)보다 뒤처졌거나 앞섰으면 한 단계 움직인다.
 * 등급별 목표 승률(95~100 / 80 / 50%)과 방향이 어긋나지 않는다.
 */
export function monsterDifficultyKo(
  tier: MonsterTier,
  ourPower: number,
  day: number,
): { label: string; level: DifficultyLevel } {
  const base = MONSTER_TIER_ORDER.indexOf(tier);
  const standard = expectedPlayerPower(day);
  let shift = 0;
  if (standard > 0 && ourPower > 0) {
    const rel = ourPower / standard;
    if (rel < 0.94) shift = 1; // 표준보다 약한 팀 → 한 단계 위험
    else if (rel > 1.1) shift = -1; // 표준보다 강한 팀 → 한 단계 수월
  }
  const i = Math.max(0, Math.min(DIFFICULTY_STEPS.length - 1, base + shift));
  return DIFFICULTY_STEPS[i];
}

// ───────────── DOM 헬퍼 ─────────────

export type Child = Node | string | number | null | undefined | false | Child[];

function appendChildren(el: Node, children: Child[]): void {
  for (const ch of children) {
    if (ch === null || ch === undefined || ch === false) continue;
    if (Array.isArray(ch)) {
      appendChildren(el, ch);
    } else if (ch instanceof Node) {
      el.appendChild(ch);
    } else {
      el.appendChild(document.createTextNode(String(ch)));
    }
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, unknown> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') {
        el.className = String(v);
      } else if (k === 'style') {
        el.setAttribute('style', String(v));
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'disabled' || k === 'checked' || k === 'selected' || k === 'hidden') {
        (el as unknown as Record<string, unknown>)[k] = Boolean(v);
      } else if (k === 'value') {
        (el as unknown as Record<string, unknown>)['value'] = String(v);
      } else if (v === true) {
        el.setAttribute(k, '');
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  appendChildren(el, children);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}
