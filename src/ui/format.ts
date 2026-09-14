/**
 * UI 표시용 헬퍼: 한국어 라벨, 숫자 포맷, DOM 생성 헬퍼.
 */
import {
  BASE_STAT_KEYS,
  JOB_NAME_KO,
  STAT_CATEGORY,
  type BaseStatKey,
  type Character,
  type MainJob,
  type StatCategory,
  type SubJobId,
  type VictoryRule,
} from '../core/types';
import { SUBJOBS } from '../core/data/jobs';
import { getSkill } from '../core/data/skills';

/** 캔버스 아이콘용 직업 한 글자 */
export const JOB_GLYPH: Record<MainJob, string> = {
  swordsman: '검', tank: '탱', berserker: '광', assassin: '암', archer: '궁',
  sniper: '저', mage: '마', summoner: '소', healer: '힐',
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
