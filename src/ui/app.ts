/**
 * 브라우저 UI 진입점. #app 에 화면을 상태 기반으로 렌더링한다.
 * 시뮬레이션/육성 로직은 src/core 에 있고 여기서는 호출만 한다.
 *
 * 육성 구조 (v0.5): 10일 × 5스텝 — 선택 · 선택 · 몬스터 · 선택 · 4:4(TEAM_SIZE) 전투 → 하루 마무리.
 * 화면 왼쪽 위에는 항상 진행 HUD 가 떠 있다 (전투 관전 중에도).
 */
import {
  BASE_STAT_KEYS,
  CHOICE_KIND_NAME_KO,
  DAY_STEPS,
  JOB_NAME_KO,
  MAP_NAME_KO,
  MAP_TYPES,
  MAX_ACTIVE_SKILLS,
  MAX_PASSIVE_SKILLS,
  MONSTER_TIER_NAME_KO,
  MONSTER_TIER_ORDER,
  RENDER_MODE_NAME_KO,
  STAT_CATEGORY_NAME_KO,
  STAT_MAX,
  STAT_NAME_KO,
  STEPS_PER_DAY,
  STEP_KIND_NAME_KO,
  TEAM_SIZE,
  TICK_RATE,
  TOTAL_DAYS,
  type RenderMode,
  type BaseStatKey,
  type BattleEvent,
  type BattleFrame,
  type BattleInput,
  type BattleResult,
  type BattleSimulator,
  type Character,
  type Choice,
  type DayRecord,
  type GhostSnapshot,
  type MapType,
  type MonsterEncounter,
  type MonsterTier,
  type RunState,
  type StatCategory,
  type Team,
  type TeamSide,
  type UnitBattleStats,
} from '../core/types';
import { MAPS } from '../core/data/maps';
import { monsterReward as monsterRewardOf } from '../core/data/monsters';
import { getSkill, skillPoolFor, countSkills } from '../core/data/skills';
import { computeDerived, statTotal } from '../core/stats';
import { createBattle } from '../core/battle/sim';
import {
  BONUS_DRAW,
  BONUS_LOSE,
  BONUS_WIN,
  REROLL_COST,
  STAT_TRAIN_COST,
  STAT_TRAIN_DELTA,
  buySkill,
  ensureChoices,
  finishBattle,
  finishDay,
  finishMonsterBattle,
  isSubJobChoiceSet,
  monsterOptions,
  newRun,
  pickChoice,
  pickMonster,
  prepareBattle,
  rerollChoices,
  selectTeam,
  startBattle as runStartBattle,
  teamPower,
  trainStat,
} from '../core/growth/run';
import { BattleRenderer, monsterTiersOfInput, type IBattleRenderer } from './render';
import { PixelRenderer } from './pixel/pixelRenderer';
import { preloadSprites, resolveSheet } from './pixel/loader';
import { preloadAllArt, type PreloadProgress } from './preload';
import { SUMMON_KINDS, spriteKeyForSummon, spriteKeyForUnit } from './pixel/spriteTypes';
import * as storage from './storage';
import {
  MONSTER_TIER_COLOR,
  MONSTER_TIER_HINT_KO,
  VICTORY_KO,
  VS_LABEL,
  categoryAverages,
  clear,
  composition,
  monsterDifficultyKo,
  fmtNum,
  fmtRate,
  fmtSec,
  fmtSigned,
  h,
  schoolKo,
  jobLabel,
  phaseKo,
  rarityColor,
  rarityKo,
  reasonKo,
  safePower,
  skillName,
  skillTypeKo,
  isZoneSkillId,
  stars,
  statsOfCategory,
  stepLabel,
  subJobName,
  type Child,
} from './format';

// ───────────────────────── 앱 상태 ─────────────────────────

type View = 'loading' | 'start' | 'run' | 'pvp_setup' | 'battle' | 'result';
/** 'run' = 4:4 전투, 'monster' = 몬스터 전투, 'pvp' = 완성팀 대전 */
type BattleMode = 'run' | 'monster' | 'pvp';

/** 전투 화면 하단 로그 한 줄. seq 는 발생 순서 (표시 정렬용) */
interface KillLogLine {
  seq: number;
  kind: 'kill' | 'skill';
  html: string;
}
/** 킬 로그에 보이는 격파·점령·종료 줄 수 */
const KILL_LOG_KILL_MAX = 6;
/** 킬 로그에 남기는 스킬 줄 수 (로그가 넘치지 않게 최근 것만) */
const KILL_LOG_SKILL_MAX = 3;

interface BattleSession {
  mode: BattleMode;
  sim: BattleSimulator;
  input: BattleInput;
  /** 전투 상단에 표시할 부제 (몬스터 이름 등) */
  title: string;
  speed: number;
  paused: boolean;
  acc: number;
  lastTs: number;
  raf: number;
  /** 현재 렌더러 (도트/간단). 캔버스가 DOM 에 붙은 뒤 만들어진다 */
  renderer: IBattleRenderer | null;
  /** 현재 렌더 모드. 전환 시 같은 캔버스에 다른 렌더러를 붙인다 */
  renderMode: RenderMode;
  canvas: HTMLCanvasElement | null;
  wrap: HTMLElement | null;
  frame: BattleFrame;
  /** 킬 로그 줄 (HTML). kill = 격파·점령·종료, skill = '이름: 스킬명!' (최근 KILL_LOG_SKILL_MAX 개만 유지) */
  killLog: KillLogLine[];
  hud: {
    time: HTMLElement | null;
    hpA: HTMLElement | null;
    hpB: HTMLElement | null;
    hpAText: HTMLElement | null;
    hpBText: HTMLElement | null;
    kills: HTMLElement | null;
    capture: HTMLElement | null;
    capA: HTMLElement | null;
    capB: HTMLElement | null;
    /** 전장 붕괴 DOM 배너 (ATTRITION_START_SEC 이후 표시) */
    attrition: HTMLElement | null;
    speedBtns: HTMLButtonElement[];
    pauseBtn: HTMLButtonElement | null;
    modeBtn: HTMLButtonElement | null;
  };
}

/** 빈 HUD 참조 (전투 세션 생성 시) */
function emptyHud(): BattleSession['hud'] {
  return { time: null, hpA: null, hpB: null, hpAText: null, hpBText: null, kills: null, capture: null, capA: null, capB: null, attrition: null, speedBtns: [], pauseBtn: null, modeBtn: null };
}

interface LastResult {
  mode: BattleMode;
  input: BattleInput;
  result: BattleResult;
  /** 이 전투로 얻은 보너스 포인트 (pvp 는 null) */
  pointsEarned: number | null;
  /** 몬스터 전투였다면 그 정보 */
  monster: { tier: MonsterTier; name: string; won: boolean; reward: MonsterEncounter['reward'] } | null;
}

/** 앱을 열면 먼저 로딩 화면. 끝나거나 건너뛰면 시작 화면으로 가고 같은 세션에서 다시 보이지 않는다 */
let view: View = 'loading';
let run: RunState | null = null;
let battle: BattleSession | null = null;
let lastResult: LastResult | null = null;

/** 팀 선택 화면 임시 상태 */
const selection = { ids: [] as string[], name: '나의 팀' };
/** 보너스 상점에서 캐릭터별 훈련 스탯 선택 (재렌더링에도 유지) */
const trainSel: Record<string, BaseStatKey> = {};
/** 완성팀 대전 설정 */
const pvp = { aId: '', bId: '', map: 'plains' as MapType, seed: 1 };

const root = document.getElementById('app') ?? (() => {
  const d = document.createElement('div');
  d.id = 'app';
  document.body.appendChild(d);
  return d;
})();

/** 좌상단 고정 진행 HUD (전투 관전 중에도 보인다) */
const hudEl = h('div', { id: 'run-hud', class: 'run-hud' });
document.body.appendChild(hudEl);

// ───────────────────────── 유틸 ─────────────────────────

function randomSeed(): number {
  try {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return arr[0] >>> 0;
  } catch {
    return Math.floor(Math.random() * 4294967296) >>> 0;
  }
}

function parseSeed(v: string): number {
  const t = v.trim();
  if (!t) return randomSeed();
  const n = Number(t);
  if (Number.isFinite(n)) return Math.floor(Math.abs(n)) >>> 0;
  // 숫자가 아니면 문자열을 해시
  let hsh = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    hsh ^= t.charCodeAt(i);
    hsh = Math.imul(hsh, 0x01000193);
  }
  return hsh >>> 0;
}

function ghostsFor(state: RunState): GhostSnapshot[] {
  // 같은 시드의 과거 기록은 거울 대전이 되므로 제외
  return storage.loadGhosts().filter((g) => g.runSeed !== state.seed);
}

function persist(): void {
  if (run) storage.saveRun(run);
}

let toastTimer = 0;
function toast(msg: string, ms = 2200): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast' });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el && el.classList.remove('show'), ms);
}

/** 팀 전투력 (데이터가 깨져 있어도 예외를 던지지 않는다) */
function safeTeamPower(t: Team | null | undefined): number {
  if (!t) return 0;
  try {
    return teamPower(t);
  } catch {
    let sum = 0;
    for (const c of t.members) sum += safePower(c);
    return sum;
  }
}

function memberName(team: Team | null, id: string): string {
  if (!team) return id;
  const m = team.members.find((c) => c.id === id);
  return m ? m.name : id;
}

function winnerLabel(input: BattleInput, winner: TeamSide | 'draw'): string {
  if (winner === 'draw') return '무승부';
  return winner === 'A' ? input.teamA.name : input.teamB.name;
}

/** 두 팀의 캐릭터 id 가 겹치면 (같은 팀끼리 대전 등) B 팀 id 를 바꿔준다 */
function dedupeTeamIds(a: Team, b: Team): Team {
  const ids = new Set(a.members.map((c) => c.id));
  const overlap = a.id === b.id || b.members.some((c) => ids.has(c.id));
  if (!overlap) return b;
  const clone = JSON.parse(JSON.stringify(b)) as Team;
  const rename = (id: string) => (ids.has(id) ? `${id}_b` : id);
  clone.id = `${clone.id}_b`;
  clone.name = a.name === clone.name ? `${clone.name} (B)` : clone.name;
  for (const c of clone.members) c.id = rename(c.id);
  for (const syn of clone.synergies) {
    if (syn.condition.kind === 'adjacency') {
      syn.condition = { ...syn.condition, a: rename(syn.condition.a), b: rename(syn.condition.b) };
    }
  }
  return clone;
}

function safeSkillDesc(id: string): string {
  try {
    return getSkill(id).desc;
  } catch {
    return '';
  }
}

function safeSkillPool(c: Character): string[] {
  try {
    return skillPoolFor(c);
  } catch {
    return [];
  }
}

function safeCounts(c: Character): { active: number; passive: number } {
  try {
    return countSkills(c);
  } catch {
    let active = 0;
    let passive = 0;
    for (const id of c.skills) {
      try {
        if (getSkill(id).type === 'active') active++;
        else passive++;
      } catch {
        /* 무시 */
      }
    }
    return { active, passive };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

// ───────────────────────── 진행 HUD ─────────────────────────

function hudVisible(): boolean {
  if (!run) return false;
  if (view === 'run') return true;
  // 완성 팀 대전(pvp) 결과에는 육성 진행 정보가 무관하므로 숨긴다
  if (view === 'result') return !lastResult || lastResult.mode !== 'pvp';
  if (view === 'battle') return battle !== null && battle.mode !== 'pvp';
  return false;
}

/** 좌상단 고정 HUD 갱신. 400px 폭에서도 한 줄로 축약되어 화면을 가리지 않는다 */
function syncHud(): void {
  const show = hudVisible();
  document.body.classList.toggle('hud-on', show);
  clear(hudEl);
  hudEl.hidden = !show;
  if (!show || !run) return;
  const st = run;

  const dayText =
    st.phase === 'select_team' ? '팀 선택'
      : st.phase === 'done' ? '육성 완료'
        : `${st.day}일차`;
  const stepText =
    st.phase === 'select_team' ? '준비'
      : st.phase === 'day_end' ? '마무리'
        : st.phase === 'done' ? `${TOTAL_DAYS}/${TOTAL_DAYS}일`
          : `${st.step}/${STEPS_PER_DAY}`;

  const chips = DAY_STEPS.map((kind, i) => {
    const n = i + 1;
    let cls = 'future';
    if (st.phase === 'day_end' || st.phase === 'done') cls = 'done';
    else if (st.phase === 'select_team') cls = 'future';
    else if (n < st.step) cls = 'done';
    else if (n === st.step) cls = 'current';
    return h('span', { class: `hud-chip step-${kind} ${cls}`, title: `${n}스텝 ${STEP_KIND_NAME_KO[kind]}` }, STEP_KIND_NAME_KO[kind]);
  });

  hudEl.appendChild(
    h(
      'div',
      { class: 'hud-inner' },
      h('div', { class: 'hud-day' },
        h('strong', null, dayText),
        h('span', { class: 'hud-step' }, stepText),
      ),
      h('div', { class: 'hud-chips' }, chips),
      h('div', { class: 'hud-meta' },
        h('span', { class: 'hud-pt', title: '보너스 포인트' }, `${st.bonusPoints}pt`),
        h('span', { class: 'hud-power', title: '팀 전투력' }, `전투력 ${fmtNum(safeTeamPower(st.team))}`),
        st.rarityFloor ? h('span', { class: 'hud-floor', style: `color:${rarityColor(st.rarityFloor)}`, title: '다음 선택지 보장 등급' }, `${rarityKo(st.rarityFloor)}↑ 보장`) : null,
      ),
    ),
  );
}

// ───────────────────────── 공용 컴포넌트 ─────────────────────────

function header(title: string, sub?: string, right?: HTMLElement): HTMLElement {
  return h(
    'header',
    { class: 'topbar' },
    h('div', null, h('h1', null, title), sub ? h('div', { class: 'sub' }, sub) : null),
    right ?? null,
  );
}

function adaptationBars(c: Character): HTMLElement {
  return h(
    'div',
    { class: 'adapt' },
    MAP_TYPES.map((m) =>
      h(
        'div',
        { class: 'adapt-row', title: `${MAP_NAME_KO[m]} 적응도 ${c.adaptation[m]}` },
        h('span', { class: 'adapt-label' }, MAP_NAME_KO[m]),
        h('div', { class: 'bar' }, h('div', { class: `fill adapt-${m}`, style: `width:${Math.max(0, Math.min(100, c.adaptation[m]))}%` })),
        h('span', { class: 'adapt-val' }, String(c.adaptation[m])),
      ),
    ),
  );
}

function categoryChips(c: Character): HTMLElement {
  const avg = categoryAverages(c);
  const cats: StatCategory[] = ['body', 'mind', 'skill', 'magic'];
  return h(
    'div',
    { class: 'chips' },
    cats.map((cat) => h('span', { class: `chip cat-${cat}` }, `${STAT_CATEGORY_NAME_KO[cat]} ${Math.round(avg[cat])}`)),
  );
}

function skillChips(c: Character): HTMLElement {
  return h(
    'div',
    { class: 'chips' },
    c.skills.length === 0
      ? h('span', { class: 'chip muted' }, '스킬 없음')
      : c.skills.map((id) => h('span', { class: `chip ${skillTypeKo(id) === '패시브' ? 'passive' : 'active'}`, title: safeSkillDesc(id) }, skillName(id))),
  );
}

/** 20개 스탯 표 (카테고리 4열) */
function statTable(c: Character): HTMLElement {
  const cats: StatCategory[] = ['body', 'mind', 'skill', 'magic'];
  return h(
    'div',
    { class: 'stat-grid' },
    cats.map((cat) =>
      h(
        'div',
        { class: `stat-col cat-${cat}` },
        h('div', { class: 'stat-col-title' }, STAT_CATEGORY_NAME_KO[cat]),
        statsOfCategory(cat).map((k) =>
          h(
            'div',
            { class: 'stat-row' },
            h('span', null, STAT_NAME_KO[k]),
            h('span', { class: `stat-val ${c.stats[k] >= 70 ? 'hi' : c.stats[k] <= 30 ? 'lo' : ''}` }, String(c.stats[k])),
          ),
        ),
      ),
    ),
  );
}

function teamSummaryCard(team: Team, title: string, side?: TeamSide): HTMLElement {
  return h(
    'div',
    { class: `card team-card ${side ? `side-${side}` : ''}` },
    h('div', { class: 'card-title' }, title, ' ', h('span', { class: 'muted' }, team.name), ' ', h('span', { class: 'muted small' }, `전투력 ${fmtNum(safeTeamPower(team))}`)),
    h(
      'ul',
      { class: 'member-list' },
      team.members.map((c) =>
        h(
          'li',
          null,
          h('span', { class: `job-badge job-${c.mainJob} ${c.monster ? 'is-monster' : ''}` }, JOB_NAME_KO[c.mainJob]),
          h('span', { class: 'name' }, c.name),
          h('span', { class: 'muted small' }, c.monster ? MONSTER_TIER_NAME_KO[c.monster.tier] : subJobName(c.subJob) || '—'),
          h('span', { class: 'power' }, `전투력 ${safePower(c)}`),
        ),
      ),
    ),
    team.synergies.length > 0
      ? h('div', { class: 'synergy-list' }, team.synergies.map((s) => h('span', { class: 'chip synergy', title: s.desc }, s.name)))
      : null,
  );
}

/** 희귀도 배지 */
function rarityBadge(r: Choice['rarity']): HTMLElement {
  return h('span', { class: `chip rarity rarity-${r}`, style: `color:${rarityColor(r)}; border-color:${rarityColor(r)}` }, rarityKo(r));
}

// ───────────────────────── 렌더 루프 ─────────────────────────

/** 직전에 그린 화면 키. 화면이 바뀔 때만 맨 위로 스크롤한다 (같은 화면 갱신은 스크롤 위치 유지). */
let lastScreenKey = '';
/** 같은 화면을 다시 그려도 펼침 상태를 잃지 않도록 열린 <details> 키를 기억 */
const openDetails = new Set<string>();

function screenKey(): string {
  return view === 'run' && run ? `run:${run.phase}:${run.day}:${run.step}` : view;
}

function render(): void {
  const key = screenKey();
  const changed = key !== lastScreenKey;
  const prevY = window.scrollY;
  clear(root);
  switch (view) {
    case 'loading':
      root.appendChild(renderLoading());
      break;
    case 'start':
      root.appendChild(renderStart());
      break;
    case 'run':
      root.appendChild(renderRun());
      break;
    case 'pvp_setup':
      root.appendChild(renderPvpSetup());
      break;
    case 'battle':
      root.appendChild(renderBattle());
      break;
    case 'result':
      root.appendChild(renderResult());
      break;
  }
  // 화면 전환 시에만 맨 위로. 같은 화면의 재렌더(카드 선택, 구매, 리롤 등)는 스크롤 위치를 복원한다.
  const nextKey = screenKey();
  if (changed || nextKey !== key) window.scrollTo(0, 0);
  else window.scrollTo(0, prevY);
  lastScreenKey = nextKey;
  syncHud();
}

/** 재렌더 후에도 펼침 상태가 유지되는 <details> */
function persistentDetails(key: string, summary: string, ...body: Child[]): HTMLElement {
  const el = h('details', { class: 'details', open: openDetails.has(key) }, h('summary', null, summary), ...body);
  el.addEventListener('toggle', () => {
    if (el.open) openDetails.add(key);
    else openDetails.delete(key);
  });
  return el;
}

// ───────────────────────── 0. 로딩 (첫 실행 프리로드) ─────────────────────────

/** 이 시간이 지나면 '건너뛰고 시작' 버튼이 나타난다 (ms) */
const SKIP_BUTTON_DELAY_MS = 3000;

/** 로딩 화면 DOM 참조. 진행률은 화면 전체를 다시 그리지 않고 이 요소만 갱신한다 */
const loadingUi = {
  fill: null as HTMLElement | null,
  count: null as HTMLElement | null,
  pct: null as HTMLElement | null,
  label: null as HTMLElement | null,
  skip: null as HTMLButtonElement | null,
};
/** 로딩 화면을 이미 지났는가 (끝났거나 건너뛰었다). 같은 세션에서 다시 보이지 않는다 */
let loadingDone = false;
/** 건너뛰기 버튼이 보이는가 (재렌더에도 유지) */
let skipVisible = false;
let skipTimer = 0;
let loadingProgress: PreloadProgress = { loaded: 0, total: 0, failed: 0, label: '' };

function loadingPercent(p: PreloadProgress): number {
  if (p.total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((p.loaded / p.total) * 100)));
}

/**
 * 진행 막대 아래 한 줄: 방금 받은 자산 이름 + 폴백(임시 그림)으로 대체된 개수.
 * 실패한 자산은 코드 생성 시트·임시 이펙트로 그려지므로 경고가 아니라 안내다.
 */
function loadingLabelText(p: PreloadProgress): string {
  const base = p.label !== '' ? p.label : '준비 중';
  return p.failed > 0 ? `${base} · 임시 그림 ${p.failed}개` : base;
}

/** 진행 막대·숫자·퍼센트·자산 이름만 갱신 (DOM 재생성 없음) */
function syncLoadingUi(): void {
  const p = loadingProgress;
  const pct = loadingPercent(p);
  if (loadingUi.fill) loadingUi.fill.style.width = `${pct}%`;
  if (loadingUi.count) loadingUi.count.textContent = `그림 불러오는 중 ${p.loaded}/${p.total}`;
  if (loadingUi.pct) loadingUi.pct.textContent = `${pct}%`;
  if (loadingUi.label) loadingUi.label.textContent = loadingLabelText(p);
  if (loadingUi.skip) loadingUi.skip.hidden = !skipVisible;
}

/** 로딩 화면을 닫고 시작 화면으로. 남은 자산은 백그라운드에서 계속 받는다 */
function finishLoading(): void {
  if (loadingDone) return;
  loadingDone = true;
  window.clearTimeout(skipTimer);
  skipTimer = 0;
  loadingUi.fill = null;
  loadingUi.count = null;
  loadingUi.pct = null;
  loadingUi.label = null;
  loadingUi.skip = null;
  view = 'start';
  render();
}

function renderLoading(): HTMLElement {
  const fill = h('div', { class: 'loading-fill', style: `width:${loadingPercent(loadingProgress)}%` });
  const count = h('span', { class: 'loading-count' }, '그림 불러오는 중');
  const pct = h('span', { class: 'loading-pct' }, '0%');
  const label = h('div', { class: 'loading-label' }, loadingLabelText(loadingProgress));
  const skip = h('button', { class: 'btn ghost small', hidden: !skipVisible, onclick: finishLoading }, '건너뛰고 시작');
  loadingUi.fill = fill;
  loadingUi.count = count;
  loadingUi.pct = pct;
  loadingUi.label = label;
  loadingUi.skip = skip;

  const el = h(
    'div',
    { class: 'screen loading-screen' },
    h('div', { class: 'loading-box' },
      h('h1', { class: 'loading-title' }, `이능 ${VS_LABEL} 전투 시뮬레이터`),
      h('p', { class: 'muted small loading-sub' }, '캐릭터 · 이펙트 · 배경 그림을 미리 받는 중입니다. 처음 한 번만 기다리면 됩니다.'),
      h('div', { class: 'loading-bar' }, fill),
      h('div', { class: 'row between loading-status' }, count, pct),
      label,
      h('div', { class: 'row center loading-skip-row' }, skip),
    ),
  );
  syncLoadingUi();
  return el;
}

/** 첫 실행 프리로드 시작. 끝나거나 건너뛰면 시작 화면으로 넘어간다 */
function bootPreload(): void {
  skipTimer = window.setTimeout(() => {
    skipVisible = true;
    syncLoadingUi();
  }, SKIP_BUTTON_DELAY_MS);
  void preloadAllArt((p) => {
    loadingProgress = p;
    if (!loadingDone && view === 'loading') syncLoadingUi();
  }).then(finishLoading, finishLoading);
}

// ───────────────────────── 1. 시작 ─────────────────────────

function renderStart(): HTMLElement {
  const saved = storage.loadRun();
  const teams = storage.loadCompletedTeams();
  const ghosts = storage.loadGhosts();
  const seedInput = h('input', { class: 'input', type: 'text', inputmode: 'numeric', value: String(randomSeed()), placeholder: '시드 (숫자)' });

  const startNew = () => {
    if (saved && !window.confirm('진행 중인 육성이 있습니다. 새로 시작하면 기존 진행이 삭제됩니다. 계속할까요?')) return;
    const seed = parseSeed(seedInput.value);
    run = newRun(seed, { ghosts: storage.loadGhosts().filter((g) => g.runSeed !== seed) });
    selection.ids = [];
    selection.name = '나의 팀';
    persist();
    view = 'run';
    render();
  };

  const resume = () => {
    const s = storage.loadRun();
    if (!s) {
      toast('저장된 육성이 없습니다.');
      render();
      return;
    }
    run = s;
    if (s.phase === 'select_team') {
      // 다른 시드의 풀을 고르던 흔적이 남지 않도록 초기화
      selection.ids = [];
      selection.name = s.team ? s.team.name : '나의 팀';
    }
    // storage 가 전투 중 저장을 전투 직전 단계로 되돌려 준다. 부족한 데이터만 다시 만든다.
    restoreRunData(s);
    persist();
    view = 'run';
    render();
  };

  return h(
    'div',
    { class: 'screen start' },
    h('div', { class: 'hero' },
      h('h1', null, `이능 ${VS_LABEL} 전투 시뮬레이터`),
      h('p', { class: 'muted' }, `가챠 풀에서 ${TEAM_SIZE}명을 고르고 ${TOTAL_DAYS}일 동안 육성해 팀을 완성하세요. 하루는 선택 · 선택 · 몬스터 전투 · 선택 · ${VS_LABEL} 전투 다섯 스텝입니다. 전투는 자동으로 진행되며 관전만 합니다.`),
    ),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-title' }, '새 육성 시작'),
      h('div', { class: 'row' }, h('label', { class: 'label' }, '시드'), seedInput, h('button', { class: 'btn ghost', onclick: () => { seedInput.value = String(randomSeed()); } }, '랜덤')),
      h('p', { class: 'muted small' }, '같은 시드면 같은 캐릭터 풀, 같은 몬스터, 같은 상대가 나옵니다.'),
      h('button', { class: 'btn primary wide', onclick: startNew }, '새 육성 시작'),
    ),
    saved
      ? h(
          'div',
          { class: 'card' },
          h('div', { class: 'card-title' }, '이어하기'),
          h('p', { class: 'muted small' }, `시드 ${saved.seed} · ${saved.day > 0 ? `${saved.day}일차 ${saved.step > 0 ? stepLabel(saved.step) : ''}` : '팀 선택 중'} · 단계: ${phaseKo(saved.phase)}${saved.team ? ` · ${saved.team.name}` : ''}`),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', onclick: resume }, '이어하기'),
            h('button', { class: 'btn danger ghost', onclick: () => { if (window.confirm('진행 중인 육성을 삭제할까요?')) { storage.clearRun(); render(); } } }, '삭제'),
          ),
        )
      : null,
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-title' }, '완성 팀 대전'),
      h('p', { class: 'muted small' }, `저장된 완성 팀 ${teams.length}개 (2개 이상 필요)`),
      h('button', { class: 'btn', disabled: teams.length < 2, onclick: () => { view = 'pvp_setup'; if (teams.length >= 2) { pvp.aId = teams[0].id; pvp.bId = teams[1].id; } render(); } }, '완성 팀 대전'),
    ),
    h(
      'div',
      { class: 'card muted small' },
      h('div', null, `고스트 데이터 ${ghosts.length}개 (과거 육성의 일차별 팀 스냅샷, 같은 일차의 상대로 등장)`),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn ghost small', disabled: ghosts.length === 0, onclick: () => { if (window.confirm('고스트 데이터를 모두 삭제할까요?')) { storage.clearGhosts(); render(); } } }, '고스트 삭제'),
        h('button', { class: 'btn ghost small danger', onclick: () => { if (window.confirm('모든 저장 데이터(육성, 고스트, 완성 팀)를 삭제할까요?')) { storage.clearAll(); render(); } } }, '전체 초기화'),
      ),
    ),
  );
}

/** 이어하기 시 비어 있는 단계별 데이터를 다시 만든다 (같은 시드 → 같은 결과) */
function restoreRunData(s: RunState): void {
  try {
    if (s.phase === 'pre_battle' && (!s.currentMap || !s.opponent)) {
      prepareBattle(s, { ghosts: ghostsFor(s) });
    }
    if (s.phase === 'monster_select' && (!s.monsterOptions || s.monsterOptions.length === 0)) {
      monsterOptions(s);
    }
    if (s.phase === 'choice' && s.currentChoices.length === 0) {
      ensureChoices(s);
    }
  } catch {
    /* 복구 실패 시 각 화면에서 다시 시도한다 */
  }
}

// ───────────────────────── 육성 화면 분기 ─────────────────────────

function renderRun(): HTMLElement {
  if (!run) {
    view = 'start';
    return renderStart();
  }
  switch (run.phase) {
    case 'select_team':
      return renderSelectTeam(run);
    case 'choice':
      return renderChoice(run);
    case 'monster_select':
      return renderMonsterSelect(run);
    case 'monster_battle':
      // 관전 도중 화면을 떠났다면 난이도 선택으로 되돌린다
      run.phase = 'monster_select';
      run.currentMonster = null;
      persist();
      return renderMonsterSelect(run);
    case 'pre_battle':
      return renderPreBattle(run);
    case 'battle':
      run.phase = 'pre_battle';
      persist();
      return renderPreBattle(run);
    case 'day_end':
      return renderDayEnd(run);
    case 'done':
      return renderDone(run);
    default:
      return h('div', { class: 'screen' }, h('p', null, `알 수 없는 단계: ${String(run.phase)}`), h('button', { class: 'btn', onclick: () => { view = 'start'; render(); } }, '처음으로'));
  }
}

function backToStartButton(): HTMLElement {
  return h('button', { class: 'btn ghost small', onclick: () => { persist(); view = 'start'; render(); } }, '메인');
}

function noTeamScreen(): HTMLElement {
  return h('div', { class: 'screen' }, h('div', { class: 'card' }, '팀이 없습니다.'), backToStartButton());
}

// ───────────────────────── 2. 팀 선택 ─────────────────────────

function renderSelectTeam(state: RunState): HTMLElement {
  const nameInput = h('input', { class: 'input', type: 'text', value: selection.name, maxlength: 16, placeholder: '팀 이름' });
  nameInput.addEventListener('input', () => { selection.name = nameInput.value; });

  const confirm = () => {
    if (selection.ids.length !== TEAM_SIZE) { toast(`${TEAM_SIZE}명을 선택해야 합니다.`); return; }
    const name = (nameInput.value.trim() || '나의 팀').slice(0, 16);
    selectTeam(state, selection.ids.slice(), name, { ghosts: ghostsFor(state) });
    restoreRunData(state);
    persist();
    render();
  };

  const counts: Partial<Record<string, number>> = {};
  for (const id of selection.ids) {
    const c = state.pool.find((p) => p.id === id);
    if (c) counts[c.mainJob] = (counts[c.mainJob] ?? 0) + 1;
  }

  const bar = h(
    'div',
    { class: 'sticky-bar' },
    h('div', { class: 'row wrap' },
      h('strong', null, `선택 ${selection.ids.length}/${TEAM_SIZE}`),
      h('span', { class: 'chips' }, Object.entries(counts).map(([job, n]) => h('span', { class: `chip job-${job}` }, `${JOB_NAME_KO[job as keyof typeof JOB_NAME_KO]} ×${n}`))),
    ),
    h('div', { class: 'row' }, nameInput, h('button', { class: 'btn primary', disabled: selection.ids.length !== TEAM_SIZE, onclick: confirm }, `${TEAM_SIZE}명 확정`)),
  );

  const cards = state.pool.map((c) => {
    const selected = selection.ids.includes(c.id);
    const full = selection.ids.length >= TEAM_SIZE && !selected;
    return h(
      'div',
      {
        class: `card char-card ${selected ? 'selected' : ''} ${full ? 'dim' : ''}`,
        onclick: () => {
          if (selected) selection.ids = selection.ids.filter((x) => x !== c.id);
          else if (selection.ids.length < TEAM_SIZE) selection.ids.push(c.id);
          else { toast(`이미 ${TEAM_SIZE}명을 선택했습니다.`); return; }
          render();
        },
      },
      h('div', { class: 'char-head' },
        h('span', { class: `job-badge job-${c.mainJob}` }, JOB_NAME_KO[c.mainJob]),
        h('span', { class: 'name' }, c.name),
        h('span', { class: 'stars' }, stars(c.rarity)),
      ),
      h('div', { class: 'row between small' }, h('span', { class: 'muted' }, `전투력 ${safePower(c)}`), h('span', { class: 'muted' }, `합계 ${statTotal(c)}`)),
      categoryChips(c),
      adaptationBars(c),
      skillChips(c),
      selected ? h('div', { class: 'selected-mark' }, `${selection.ids.indexOf(c.id) + 1}`) : null,
    );
  });

  return h(
    'div',
    { class: 'screen' },
    header('팀 선택', `풀 ${state.pool.length}명 중 ${TEAM_SIZE}명을 고르세요 · 시드 ${state.seed} · 총 ${TOTAL_DAYS}일 육성`, backToStartButton()),
    bar,
    h('div', { class: 'grid cards' }, cards),
  );
}

// ───────────────────────── 3. 선택지 (1·2·4스텝) ─────────────────────────

function renderChoice(state: RunState): HTMLElement {
  const team = state.team;
  if (!team) return noTeamScreen();
  // 저장 데이터 정리 등으로 선택지가 비어 있으면 다시 만든다 (같은 시드에서 같은 결과)
  if (state.currentChoices.length === 0 && ensureChoices(state)) persist();
  const choices = state.currentChoices;

  const onPick = (index: number) => {
    if (!run) return;
    const choice = run.currentChoices[index];
    const r = pickChoice(run, index, { ghosts: ghostsFor(run) });
    if (choice) {
      const msg = r.success === true ? `성공! ${choice.title}` : r.success === false ? `실패... ${choice.title}` : `적용: ${choice.title}`;
      toast(msg, 2600);
    }
    restoreRunData(run);
    persist();
    render();
  };

  const subJobSet = isSubJobChoiceSet(state);
  const canReroll = !subJobSet && state.rerolls > 0 && state.bonusPoints >= REROLL_COST;

  const cards = choices.map((ch: Choice, i: number) =>
    h(
      'div',
      {
        class: `card choice-card kind-${ch.kind} rarity-${ch.rarity}`,
        style: `--rc:${rarityColor(ch.rarity)}`,
        onclick: () => onPick(i),
      },
      h('div', { class: 'row between wrap' },
        rarityBadge(ch.rarity),
        h('span', { class: `chip kind kind-${ch.kind}` }, CHOICE_KIND_NAME_KO[ch.kind] ?? ch.kind),
      ),
      h('div', { class: 'choice-title' }, ch.title),
      h('div', { class: 'choice-desc' }, ch.desc),
      h('div', { class: 'row between wrap small' },
        h('span', {
          class: `power-delta ${ch.powerDelta > 0 ? 'up' : ch.powerDelta < 0 ? 'down' : 'flat'}`,
          title: '예상 전투력 상승치',
        }, `전투력 ${fmtSigned(ch.powerDelta)}`),
        ch.successChance !== undefined
          ? h('span', { class: `chip chance ${ch.successChance >= 0.7 ? 'good' : ch.successChance >= 0.5 ? 'mid' : 'bad'}` }, `성공 ${Math.round(ch.successChance * 100)}%`)
          : h('span', { class: 'chip muted' }, '확정'),
      ),
      ch.charIds.length > 0 ? h('div', { class: 'chips' }, ch.charIds.map((id) => {
        const m = team.members.find((c) => c.id === id);
        return h('span', { class: `chip ${m ? `job-${m.mainJob}` : ''}` }, memberName(team, id));
      })) : null,
      ch.failEffects && ch.failEffects.length > 0 ? h('div', { class: 'tiny muted' }, '실패 시 불이익 있음') : null,
      h('button', { class: 'btn small wide', onclick: (ev: Event) => { ev.stopPropagation(); onPick(i); } }, '선택'),
    ),
  );

  return h(
    'div',
    { class: 'screen' },
    header(`${state.day}일차 · ${stepLabel(state.step)}`, `${team.name} · ${state.bonusPoints}pt · 전투력 ${fmtNum(safeTeamPower(team))}`, backToStartButton()),
    state.rarityFloor
      ? h('div', { class: 'card floor-note', style: `border-color:${rarityColor(state.rarityFloor)}` },
          `몬스터 전투 보상: 이번 세트에 ${rarityKo(state.rarityFloor)} 이상 카드가 1장 이상 등장합니다.`)
      : null,
    h('div', { class: 'row between wrap' },
      h('span', { class: 'muted small' }, subJobSet ? '직업 분화 선택입니다. 세 세부 직업 중 하나를 고르세요. (리롤 불가)' : '세 가지 중 하나를 고르세요. 결과는 즉시 적용됩니다.'),
      h('button', {
        class: 'btn ghost small',
        disabled: !canReroll,
        title: canReroll ? '' : subJobSet ? '분화 선택지는 리롤할 수 없습니다' : state.rerolls <= 0 ? '리롤권 없음' : '포인트 부족',
        onclick: () => {
          if (!run) return;
          const ok = rerollChoices(run);
          toast(ok ? `선택지를 리롤했습니다 (-${REROLL_COST}pt)` : '리롤할 수 없습니다.');
          persist();
          render();
        },
      }, `리롤 (${REROLL_COST}pt · ${state.rerolls}회)`),
    ),
    choices.length === 0 ? h('div', { class: 'card' }, '선택지가 없습니다.') : h('div', { class: 'grid three' }, cards),
    h('div', { class: 'card' }, h('div', { class: 'card-title' }, '현재 팀'), h('div', { class: 'member-brief' }, team.members.map((c) =>
      h('div', { class: 'brief' }, h('span', { class: `job-badge job-${c.mainJob}` }, JOB_NAME_KO[c.mainJob]), ' ', c.name, h('span', { class: 'muted small' }, ` ${subJobName(c.subJob)} · 전투력 ${safePower(c)}`)),
    ))),
  );
}

// ───────────────────────── 4. 몬스터 난이도 선택 (3스텝) ─────────────────────────

function renderMonsterSelect(state: RunState): HTMLElement {
  const team = state.team;
  if (!team) return noTeamScreen();
  let options: MonsterEncounter[] = state.monsterOptions ?? [];
  if (options.length === 0) {
    try {
      options = monsterOptions(state);
      persist();
    } catch {
      options = [];
    }
  }
  const ourPower = safeTeamPower(team);

  const start = (tier: MonsterTier) => {
    if (!run) return;
    const enc = (run.monsterOptions ?? []).find((e) => e.tier === tier);
    if (!enc) { toast('선택할 수 없는 몬스터입니다.'); return; }
    const input = pickMonster(run, tier);
    persist();
    startBattle(input, 'monster', `${MONSTER_TIER_NAME_KO[enc.tier]} · ${enc.name}`);
  };

  // 표시 순서는 항상 하급 → 중급 → 고급
  const list: MonsterEncounter[] = [];
  for (const tier of MONSTER_TIER_ORDER) {
    const enc = options.find((o) => o.tier === tier);
    if (enc) list.push(enc);
  }
  for (const enc of options) if (!list.includes(enc)) list.push(enc);

  const cards = list.map((enc) => monsterCard(enc, ourPower, state.day, start));

  return h(
    'div',
    { class: 'screen' },
    header(`${state.day}일차 · ${stepLabel(state.step)}`, `${team.name} · ${state.bonusPoints}pt · 전투력 ${fmtNum(ourPower)}`, backToStartButton()),
    h('div', { class: 'card' },
      h('div', { class: 'card-title' }, '몬스터 토벌'),
      h('p', { class: 'small muted' }, '난이도를 직접 고릅니다. 어려울수록 보상이 큽니다. 패배해도 포인트의 40%는 받고 다음 스텝으로 넘어갑니다.'),
    ),
    list.length === 0
      ? h('div', { class: 'card' }, '몬스터 정보를 만들 수 없습니다. 메인으로 돌아갔다가 다시 시도하세요.')
      : h('div', { class: 'grid three' }, cards),
    h('div', { class: 'card' }, h('div', { class: 'card-title' }, '우리 팀'), h('div', { class: 'member-brief' }, team.members.map((c) =>
      h('div', { class: 'brief' }, h('span', { class: `job-badge job-${c.mainJob}` }, JOB_NAME_KO[c.mainJob]), ' ', c.name, h('span', { class: 'muted small' }, ` ${subJobName(c.subJob)} · 전투력 ${safePower(c)}`)),
    ))),
  );
}

function monsterCard(enc: MonsterEncounter, ourPower: number, day: number, onStart: (tier: MonsterTier) => void): HTMLElement {
  const color = MONSTER_TIER_COLOR[enc.tier];
  const map = MAPS[enc.map];
  const ratio = ourPower > 0 ? enc.estimatedPower / ourPower : 1;
  // 난이도 라벨은 등급 기준이다. 전투력 '점수'비는 편성(소수 정예 vs 다수 약체)에 따라 뒤집히므로 쓰지 않는다
  const diff = monsterDifficultyKo(enc.tier, ourPower, day);
  const comp = composition(enc.team);
  const reward = enc.reward;

  return h(
    'div',
    { class: `card monster-card tier-${enc.tier}`, style: `--tc:${color}`, onclick: () => onStart(enc.tier) },
    h('div', { class: 'row between wrap' },
      h('span', { class: `chip tier-badge tier-${enc.tier}`, style: `color:${color}; border-color:${color}` }, MONSTER_TIER_NAME_KO[enc.tier]),
      h('span', { class: `chip diff diff-${diff.level}` }, `예상 난이도 ${diff.label}`),
    ),
    h('div', { class: 'monster-name' }, enc.name),
    h('div', { class: 'small muted monster-desc' }, enc.desc),
    h('div', { class: 'section-title' }, '편성'),
    h('div', { class: 'chips' }, comp.map((u) => h('span', { class: `chip job-${u.job}` }, u.count > 1 ? `${u.label} ×${u.count}` : u.label))),
    h('div', { class: 'power-compare' },
      h('div', { class: 'row between tiny muted' }, h('span', null, `우리 ${fmtNum(ourPower)}`), h('span', { title: '전투력 점수는 편성을 반영하지 않는다. 소수 정예는 점수보다 강하다' }, `적 ${fmtNum(enc.estimatedPower)}`)),
      h('div', { class: 'bar' }, h('div', { class: 'fill', style: `width:${Math.max(4, Math.min(100, ratio * 50)).toFixed(1)}%; background:${color}` })),
      h('div', { class: 'tiny muted' }, MONSTER_TIER_HINT_KO[enc.tier]),
    ),
    h('div', { class: 'section-title' }, '전장'),
    h('div', { class: 'chips' },
      h('span', { class: `chip map-chip map-${enc.map}` }, map.name),
      h('span', { class: 'chip muted' }, VICTORY_KO[map.victory]),
    ),
    h('div', { class: 'section-title' }, '승리 보상'),
    h('ul', { class: 'reward-list' },
      h('li', null, `보너스 포인트 +${reward.points}`),
      reward.rarityFloor ? h('li', { style: `color:${rarityColor(reward.rarityFloor)}` }, `다음 선택지에 ${rarityKo(reward.rarityFloor)} 이상 1장 보장`) : null,
      reward.teamStatBonus > 0 ? h('li', null, `팀 전원 랜덤 스탯 +${reward.teamStatBonus}`) : null,
      h('li', { class: 'tiny muted' }, `패배 시 포인트 ${Math.round(reward.points * 0.4)}만 획득`),
    ),
    h('button', { class: 'btn small wide', onclick: (ev: Event) => { ev.stopPropagation(); onStart(enc.tier); } }, '도전'),
  );
}

// ───────────────────────── 5. 4:4 전투 준비 (5스텝) ─────────────────────────

function renderPreBattle(state: RunState): HTMLElement {
  if (!state.team) return noTeamScreen();
  if (!state.currentMap || !state.opponent) {
    prepareBattle(state, { ghosts: ghostsFor(state) });
    persist();
  }
  const mapId = state.currentMap ?? 'plains';
  const map = MAPS[mapId];
  const opp = state.opponent;
  // run.ts 는 고스트 상대의 팀/캐릭터 id 에 'g_' 접두사를 붙인다
  const isGhost = !!opp && (opp.id.startsWith('g_') || opp.members.some((c) => c.id.startsWith('g_')));

  const start = () => {
    if (!run || !run.team || !run.opponent || !run.currentMap) return;
    const input = runStartBattle(run);
    persist();
    startBattle(input, 'run', `${MAPS[input.map].name} · ${input.teamB.name}`);
  };

  return h(
    'div',
    { class: 'screen' },
    header(`${state.day}일차 · ${stepLabel(state.step)}`, `${state.team.name} · 보너스 ${state.bonusPoints}pt`, backToStartButton()),
    h(
      'div',
      { class: `card map-card map-${mapId}` },
      h('div', { class: 'card-title' }, `맵: ${map.name}`),
      h('p', null, map.desc),
      h('p', { class: 'small muted' }, `승리 조건: ${VICTORY_KO[map.victory]} · 제한 시간 ${fmtSec(map.timeLimitSec)}`),
      mapTraits(mapId),
    ),
    h('div', { class: 'grid two' },
      teamSummaryCard(state.team, '아군', 'A'),
      opp ? teamSummaryCard(opp, isGhost ? '상대 (고스트)' : '상대', 'B') : h('div', { class: 'card' }, '상대 정보 없음'),
    ),
    h('div', { class: 'row center' }, h('button', { class: 'btn primary big', onclick: start }, '전투 시작')),
    historyStrip(state),
  );
}

function mapTraits(mapId: MapType): HTMLElement {
  const m = MAPS[mapId];
  const items: string[] = [];
  if (m.visionRadius > 0) items.push(`시야 반경 ${m.visionRadius}`);
  if (m.stealthBonusSec > 0) items.push(`은신 +${m.stealthBonusSec}초`);
  if (m.staminaDrainMult !== 1) items.push(`지구력 소모 ×${m.staminaDrainMult}`);
  if (m.moveSpeedMult !== 1) items.push(`이동속도 ×${m.moveSpeedMult}`);
  if (m.slipFactor > 0) items.push(`미끄러짐 ${m.slipFactor}`);
  for (const [school, mult] of Object.entries(m.schoolBonus)) {
    if (mult && mult !== 1) items.push(`${schoolKo(school)} 이능 ×${mult}`);
  }
  if (m.capture) items.push(`거점 (${m.capture.x}, ${m.capture.y}) 반경 ${m.capture.radius} · ${m.capture.secondsToCapture}초 점유`);
  for (const hz of m.hazards ?? []) {
    items.push(`기믹: ${hz.name} — ${hz.startSec}초부터 ${hz.intervalSec}초 간격, 반경 ${hz.radius}, 최대 HP ${hz.damagePctMaxHp}%${hz.linger ? ` + 장판 ${hz.linger.durationSec}초` : ''}`);
  }
  items.push('120초부터 전장 붕괴 (초당 최대 HP 감소, 가속)');
  return h('div', { class: 'chips' }, items.map((t) => h('span', { class: 'chip' }, t)));
}

function historyStrip(state: RunState): HTMLElement | null {
  if (state.history.length === 0) return null;
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-title' }, '지난 전투'),
    h('div', { class: 'chips' },
      state.history.map((r) => {
        const w = r.result.winner === 'A' ? 'win' : r.result.winner === 'B' ? 'lose' : 'draw';
        const label = w === 'win' ? '승' : w === 'lose' ? '패' : '무';
        const mon = r.monster ? ` · 몬스터 ${MONSTER_TIER_NAME_KO[r.monster.tier]} ${r.monster.won ? '승' : '패'}` : '';
        return h('span', { class: `chip result-${w}`, title: `${r.opponentName} · ${reasonKo(r.result.reason)} · +${r.pointsEarned}pt${mon}` }, `${r.day}일 ${MAP_NAME_KO[r.map]} ${label}`);
      }),
    ),
  );
}

// ───────────────────────── 6. 전투 관전 (몬스터 / 4:4 공용) ─────────────────────────

function startBattle(input: BattleInput, mode: BattleMode, title: string): void {
  stopBattleLoop();
  const sim = createBattle(input);
  const frame = sim.currentFrame();
  battle = {
    mode,
    sim,
    input,
    title,
    speed: 1,
    paused: false,
    acc: 0,
    lastTs: 0,
    raf: 0,
    renderer: null,
    renderMode: storage.loadRenderMode(),
    canvas: null,
    wrap: null,
    frame,
    killLog: [],
    hud: emptyHud(),
  };
  // 도트 스프라이트 사전 적재 (양 팀 유닛 + 소환물 4종). 실패해도 코드 생성 시트로 그린다. 몬스터·완성팀 대전 포함
  preloadSprites(spriteKeysForFrame(frame)).catch(() => undefined);
  view = 'battle';
  render();
}

/** 프레임의 유닛 스프라이트 키 + 소환물 4종 (중복 제거, 순서 고정) */
function spriteKeysForFrame(frame: BattleFrame): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const u of frame.units) {
    const k = spriteKeyForUnit(u);
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  }
  for (const kind of SUMMON_KINDS) {
    const k = spriteKeyForSummon(kind);
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  }
  return keys;
}

function stopBattleLoop(): void {
  if (battle && battle.raf) cancelAnimationFrame(battle.raf);
  if (battle) battle.raf = 0;
}

/** 현재 모드에 맞는 렌더러를 캔버스에 붙인다. 이전 렌더러는 버린다 (같은 프레임을 이어서 그린다) */
function attachRenderer(b: BattleSession): void {
  if (!b.canvas) return;
  const map = MAPS[b.input.map];
  const monsters = monsterTiersOfInput(b.input);
  if (b.renderMode === 'pixel') {
    const r = new PixelRenderer(b.canvas, map, { monsters, sprites: { resolveSheet, preload: preloadSprites } });
    r.preloadForFrame(b.frame);
    b.renderer = r;
  } else {
    b.renderer = new BattleRenderer(b.canvas, map, monsters);
  }
  if (b.wrap) {
    b.wrap.classList.toggle('mode-pixel', b.renderMode === 'pixel');
    b.wrap.classList.toggle('mode-simple', b.renderMode !== 'pixel');
  }
  if (b.hud.modeBtn) b.hud.modeBtn.textContent = renderModeButtonLabel(b.renderMode);
  b.renderer.draw(b.frame);
}

/** 버튼은 '전환할 모드' 이름을 보여준다: 도트 모드일 때 '간단 모드', 간단 모드일 때 '도트 모드' */
function renderModeButtonLabel(mode: RenderMode): string {
  return mode === 'pixel' ? RENDER_MODE_NAME_KO.simple : RENDER_MODE_NAME_KO.pixel;
}

/** 렌더 모드 즉시 전환 (전투 중에도). 설정은 localStorage 에 저장 */
function toggleRenderMode(): void {
  const b = battle;
  if (!b) return;
  b.renderMode = b.renderMode === 'pixel' ? 'simple' : 'pixel';
  storage.saveRenderMode(b.renderMode);
  attachRenderer(b);
  toast(`${RENDER_MODE_NAME_KO[b.renderMode]}로 전환했습니다.`, 1400);
}

function renderBattle(): HTMLElement {
  const b = battle;
  if (!b) {
    view = 'start';
    return renderStart();
  }
  const map = MAPS[b.input.map];
  const canvas = h('canvas', { class: 'battle-canvas', width: 800, height: 600 });
  const wrap = h('div', { class: `canvas-wrap map-${b.input.map} mode-${b.renderMode}` }, canvas);
  b.canvas = canvas;
  b.wrap = wrap;

  const hpA = h('div', { class: 'fill side-A', style: 'width:100%' });
  const hpB = h('div', { class: 'fill side-B', style: 'width:100%' });
  const hpAText = h('span', { class: 'hp-text' }, '');
  const hpBText = h('span', { class: 'hp-text' }, '');
  const time = h('span', { class: 'time' }, '0:00');
  const kills = h('ul', { class: 'kill-log' });
  const capA = h('div', { class: 'fill side-A', style: 'width:0%' });
  const capB = h('div', { class: 'fill side-B', style: 'width:0%' });
  const capture = map.capture
    ? h('div', { class: 'capture-bar' },
        h('span', { class: 'small muted' }, '거점 점령'),
        h('div', { class: 'bar' }, capA),
        h('div', { class: 'bar' }, capB),
      )
    : null;
  // 전장 붕괴 배너 (DOM). 120초 전에는 숨긴다. 캔버스 안에도 같은 배너가 그려진다
  const attrition = h('div', { class: 'attrition-banner', hidden: true }, '');

  const speedBtns: HTMLButtonElement[] = [1, 2, 4].map((sp) =>
    h('button', { class: `btn small ${b.speed === sp ? 'primary' : ''}`, onclick: () => setSpeed(sp) }, `${sp}x`),
  );
  const pauseBtn = h('button', { class: 'btn small', onclick: () => togglePause() }, b.paused ? '재생' : '일시정지');
  const skipBtn = h('button', { class: 'btn small warn', onclick: () => skipBattle() }, '스킵');
  const modeBtn = h('button', { class: 'btn small ghost mode-btn', title: '렌더 모드 전환 (도트 / 간단)', onclick: () => toggleRenderMode() }, renderModeButtonLabel(b.renderMode));

  b.hud = { time, hpA, hpB, hpAText, hpBText, kills, capture, capA, capB, attrition, speedBtns, pauseBtn, modeBtn };

  const dayLabel = b.mode !== 'pvp' && run ? `${run.day}일차 ${b.mode === 'monster' ? '3스텝 몬스터 전투' : `5스텝 ${VS_LABEL} 전투`}` : '완성 팀 대전';

  const screen = h(
    'div',
    { class: `screen battle ${b.mode === 'monster' ? 'monster-battle' : ''}` },
    h('div', { class: 'battle-banner' },
      h('span', { class: 'small muted' }, dayLabel),
      h('strong', { class: 'battle-subtitle' }, b.title),
    ),
    h('div', { class: 'battle-head' },
      h('div', { class: 'team-hp side-A' }, h('div', { class: 'row between' }, h('strong', null, b.input.teamA.name), hpAText), h('div', { class: 'bar' }, hpA)),
      h('div', { class: 'battle-mid' }, h('div', { class: 'small muted' }, map.name), time),
      h('div', { class: 'team-hp side-B' }, h('div', { class: 'row between' }, hpBText, h('strong', null, b.input.teamB.name)), h('div', { class: 'bar rtl' }, hpB)),
    ),
    attrition,
    wrap,
    capture,
    h('div', { class: 'controls' }, ...speedBtns, pauseBtn, skipBtn, modeBtn),
    h('div', { class: 'card kill-card' }, h('div', { class: 'card-title' }, '킬 로그'), kills),
  );

  // 캔버스가 DOM 에 붙은 뒤 렌더러 생성 및 루프 시작
  requestAnimationFrame(() => {
    if (!battle || battle !== b) return;
    attachRenderer(b);
    updateHud(b, b.frame);
    b.lastTs = performance.now();
    b.raf = requestAnimationFrame(loop);
  });

  return screen;
}

function setSpeed(sp: number): void {
  if (!battle) return;
  battle.speed = sp;
  battle.hud.speedBtns.forEach((btn) => {
    btn.classList.toggle('primary', btn.textContent === `${sp}x`);
  });
}

function togglePause(): void {
  if (!battle) return;
  battle.paused = !battle.paused;
  if (battle.hud.pauseBtn) battle.hud.pauseBtn.textContent = battle.paused ? '재생' : '일시정지';
}

function loop(ts: number): void {
  const b = battle;
  if (!b) return;
  const dt = Math.min(0.1, Math.max(0, (ts - b.lastTs) / 1000));
  b.lastTs = ts;
  if (!b.paused) b.acc += dt * b.speed;
  let steps = Math.floor(b.acc * TICK_RATE);
  b.acc -= steps / TICK_RATE;
  if (b.acc < 0) b.acc = 0;

  const events: BattleEvent[] = [];
  let frame = b.frame;
  while (steps > 0 && !b.sim.finished) {
    frame = b.sim.step();
    for (const e of frame.events) events.push(e);
    steps--;
  }
  const changed = frame !== b.frame;
  b.frame = frame;

  if (changed) {
    handleEvents(b, events, frame);
    b.renderer?.draw({ ...frame, events });
    updateHud(b, frame);
  } else {
    b.renderer?.draw(frame);
  }

  if (b.sim.finished) {
    onBattleEnd();
    return;
  }
  b.raf = requestAnimationFrame(loop);
}

/** 로그 줄을 추가한다. 스킬 줄은 최근 KILL_LOG_SKILL_MAX 개만 남기고, 격파 줄은 영향을 받지 않는다 */
function pushKillLog(b: BattleSession, kind: KillLogLine['kind'], html: string): void {
  const seq = b.killLog.length > 0 ? b.killLog[b.killLog.length - 1].seq + 1 : 1;
  b.killLog.push({ seq, kind, html });
  if (kind === 'skill') {
    let n = 0;
    for (let i = b.killLog.length - 1; i >= 0; i--) {
      if (b.killLog[i].kind !== 'skill') continue;
      n++;
      if (n > KILL_LOG_SKILL_MAX) b.killLog.splice(i, 1);
    }
  }
}

/** 화면에 보일 로그 줄: 최근 격파 줄 KILL_LOG_KILL_MAX 개 + 스킬 줄 (최대 KILL_LOG_SKILL_MAX 개), 발생 순서대로 */
function visibleKillLog(b: BattleSession): KillLogLine[] {
  const kills = b.killLog.filter((l) => l.kind === 'kill').slice(-KILL_LOG_KILL_MAX);
  const skills = b.killLog.filter((l) => l.kind === 'skill').slice(-KILL_LOG_SKILL_MAX);
  return kills.concat(skills).sort((a, c) => a.seq - c.seq);
}

function handleEvents(b: BattleSession, events: BattleEvent[], frame: BattleFrame): void {
  let touched = false;
  for (const e of events) {
    if (e.kind === 'kill') {
      const killer = frame.units.find((x) => x.id === e.killer);
      const victim = frame.units.find((x) => x.id === e.victim);
      const ks = killer ? `<span class="side-${killer.side}-text">${escapeHtml(killer.name)}</span>` : escapeHtml(e.killer);
      const vs = victim ? `<span class="side-${victim.side}-text">${escapeHtml(victim.name)}</span>` : escapeHtml(e.victim);
      pushKillLog(b, 'kill', `[${fmtSec(e.t)}] ${ks} → ${vs} 격파`);
      touched = true;
    } else if (e.kind === 'capture' && e.progress >= 1) {
      pushKillLog(b, 'kill', `[${fmtSec(e.t)}] ${e.side === 'A' ? b.input.teamA.name : b.input.teamB.name} 거점 점령!`);
      touched = true;
    } else if (e.kind === 'attrition_start') {
      pushKillLog(b, 'kill', `[${fmtSec(e.t)}] <span class="attrition-text">전장 붕괴 시작</span> — 모든 유닛이 초당 최대 HP 를 잃습니다`);
      touched = true;
    } else if (e.kind === 'end') {
      pushKillLog(b, 'kill', `[${fmtSec(e.t)}] 전투 종료 — ${e.winner === 'draw' ? '무승부' : `${winnerLabel(b.input, e.winner)} 승리`} (${reasonKo(e.reason)})`);
      touched = true;
    } else if (e.kind === 'skill') {
      // 스킬명 외치기: '이름: 스킬명!' (모르는 스킬 id 는 id 그대로. 예외 없음)
      const caster = frame.units.find((x) => x.id === e.from);
      const cs = caster ? `<span class="side-${caster.side}-text">${escapeHtml(caster.name)}</span>` : escapeHtml(e.from);
      const zone = isZoneSkillId(e.skillId) ? ' zone' : '';
      pushKillLog(b, 'skill', `[${fmtSec(e.t)}] ${cs}: <span class="skill-shout${zone}">${escapeHtml(skillName(e.skillId))}!</span>`);
      touched = true;
    }
  }
  if (touched && b.hud.kills) {
    clear(b.hud.kills);
    for (const line of visibleKillLog(b)) {
      const li = document.createElement('li');
      if (line.kind === 'skill') li.className = 'skill-line';
      li.innerHTML = line.html;
      b.hud.kills.appendChild(li);
    }
  }
}

function updateHud(b: BattleSession, frame: BattleFrame): void {
  const hud = b.hud;
  if (hud.time) hud.time.textContent = fmtSec(frame.timeSec);
  const tot = { A: { hp: 0, max: 0, alive: 0 }, B: { hp: 0, max: 0, alive: 0 } };
  for (const u of frame.units) {
    if (u.job === 'summon') continue;
    const t = tot[u.side];
    t.max += u.maxHp;
    if (u.alive) {
      t.hp += Math.max(0, u.hp);
      t.alive++;
    }
  }
  const pctA = tot.A.max > 0 ? (tot.A.hp / tot.A.max) * 100 : 0;
  const pctB = tot.B.max > 0 ? (tot.B.hp / tot.B.max) * 100 : 0;
  if (hud.hpA) hud.hpA.style.width = `${pctA.toFixed(1)}%`;
  if (hud.hpB) hud.hpB.style.width = `${pctB.toFixed(1)}%`;
  if (hud.hpAText) hud.hpAText.textContent = `${fmtNum(tot.A.hp)} · ${tot.A.alive}명`;
  if (hud.hpBText) hud.hpBText.textContent = `${tot.B.alive}명 · ${fmtNum(tot.B.hp)}`;
  if (frame.capture) {
    if (hud.capA) hud.capA.style.width = `${(Math.min(1, frame.capture.progressA) * 100).toFixed(1)}%`;
    if (hud.capB) hud.capB.style.width = `${(Math.min(1, frame.capture.progressB) * 100).toFixed(1)}%`;
  }
  // 전장 붕괴 배너: ATTRITION_START_SEC 이후 현재 초당 감소율
  const attr = frame.attritionPctPerSec ?? 0;
  if (hud.attrition) {
    if (attr > 0) {
      hud.attrition.hidden = false;
      hud.attrition.textContent = `전장 붕괴 — 모든 유닛이 초당 최대 HP 의 ${fmtRate(attr)} 를 잃습니다`;
    } else {
      hud.attrition.hidden = true;
    }
  }
}

function skipBattle(): void {
  const b = battle;
  if (!b) return;
  stopBattleLoop();
  const result = b.sim.finished ? b.sim.result() ?? b.sim.runToEnd() : b.sim.runToEnd();
  finalizeBattle(b, result);
}

function onBattleEnd(): void {
  const b = battle;
  if (!b) return;
  stopBattleLoop();
  const result = b.sim.result() ?? b.sim.runToEnd();
  // 종료 화면을 잠깐 보여준 뒤 결과로
  b.renderer?.draw(b.frame);
  window.setTimeout(() => {
    if (battle === b) finalizeBattle(b, result);
  }, 700);
}

function finalizeBattle(b: BattleSession, result: BattleResult): void {
  let pointsEarned: number | null = null;
  let monster: LastResult['monster'] = null;

  if (b.mode === 'monster' && run) {
    const enc = run.currentMonster;
    const out = finishMonsterBattle(run, result);
    pointsEarned = out.reward.points;
    monster = { tier: enc?.tier ?? 'low', name: enc?.name ?? '몬스터', won: out.won, reward: out.reward };
    restoreRunData(run);
    persist();
  } else if (b.mode === 'run' && run) {
    const before = run.bonusPoints;
    finishBattle(run, result);
    pointsEarned = run.bonusPoints - before;
    const record = run.history[run.history.length - 1];
    if (record) {
      try {
        storage.saveGhost({ runSeed: run.seed, day: record.day, team: record.teamSnapshot, savedAt: new Date().toISOString() });
      } catch {
        /* 무시 */
      }
    }
    persist();
  }

  lastResult = { mode: b.mode, input: b.input, result, pointsEarned, monster };
  battle = null;
  view = 'result';
  render();
}

// ───────────────────────── 7. 전투 결과 ─────────────────────────

function renderResult(): HTMLElement {
  const lr = lastResult;
  if (!lr) {
    view = run ? 'run' : 'start';
    return run ? renderRun() : renderStart();
  }
  const { result, input } = lr;
  const playerWon = result.winner === 'A';
  const title = lr.mode === 'pvp'
    ? result.winner === 'draw' ? '무승부' : `${winnerLabel(input, result.winner)} 승리`
    : result.winner === 'draw' ? '무승부' : playerWon ? '승리!' : '패배';

  const nameOf = (id: string) => {
    const s = result.unitStats.find((u) => u.id === id);
    return s ? s.name : id;
  };

  const rows = result.unitStats
    .slice()
    .sort((a, b) => (a.side === b.side ? b.damageDealt - a.damageDealt : a.side === 'A' ? -1 : 1));

  const table = h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'table' },
      h('thead', null, h('tr', null, ['팀', '이름', '딜', '힐', '킬', '데스', '스킬', '생존'].map((t) => h('th', null, t)))),
      h('tbody', null, rows.map((u: UnitBattleStats) =>
        h('tr', { class: `${u.id === result.mvpId ? 'mvp' : ''} row-side-${u.side}` },
          h('td', null, h('span', { class: `side-dot side-${u.side}` }), u.side === 'A' ? input.teamA.name : input.teamB.name),
          h('td', null, u.name, u.id === result.mvpId ? h('span', { class: 'chip mvp' }, 'MVP') : null),
          h('td', { class: 'num' }, fmtNum(u.damageDealt)),
          h('td', { class: 'num' }, fmtNum(u.healingDone)),
          h('td', { class: 'num' }, String(u.kills)),
          h('td', { class: 'num' }, String(u.deaths)),
          h('td', { class: 'num' }, String(u.skillsUsed)),
          h('td', null, u.survived ? '생존' : '사망'),
        ),
      )),
    ),
  );

  const next = () => {
    lastResult = null;
    view = lr.mode === 'pvp' ? 'pvp_setup' : 'run';
    render();
  };

  const nextLabel = lr.mode === 'pvp' ? '다시' : lr.mode === 'monster' ? '다음 (4스텝 선택지)' : '하루 마무리로';

  const monsterReward = lr.monster
    ? h('div', { class: 'reward-box' },
        h('div', null, `${MONSTER_TIER_NAME_KO[lr.monster.tier]} · ${lr.monster.name}`),
        lr.monster.won
          ? h('ul', { class: 'reward-list' },
              h('li', null, `보너스 포인트 +${lr.pointsEarned ?? 0}`),
              lr.monster.reward.rarityFloor ? h('li', { style: `color:${rarityColor(lr.monster.reward.rarityFloor)}` }, `다음 선택지에 ${rarityKo(lr.monster.reward.rarityFloor)} 이상 1장 보장`) : null,
              lr.monster.reward.teamStatBonus > 0 ? h('li', null, `팀 전원 랜덤 스탯 +${lr.monster.reward.teamStatBonus}`) : null,
            )
          : h('ul', { class: 'reward-list' },
              h('li', null, `보너스 포인트 +${lr.pointsEarned ?? 0} (패배 — 40%만 지급)`),
              h('li', { class: 'tiny muted' }, '보장 등급과 추가 보상은 없습니다. 진행은 계속됩니다.'),
            ),
      )
    : null;

  return h(
    'div',
    { class: 'screen' },
    header('전투 결과', `${MAPS[result.map].name} · ${reasonKo(result.reason)} · ${fmtSec(result.durationSec)}`),
    h('div', { class: `card result-banner ${result.winner === 'draw' ? 'draw' : lr.mode === 'pvp' ? 'win' : (playerWon ? 'win' : 'lose')}` },
      h('div', { class: 'result-title' }, title),
      h('div', { class: 'muted' }, `${input.teamA.name} vs ${input.teamB.name}`),
      result.mvpId ? h('div', null, 'MVP: ', h('strong', null, nameOf(result.mvpId))) : null,
      lr.mode === 'run' && lr.pointsEarned !== null
        ? h('div', { class: 'bonus-earned' }, `보너스 획득 +${lr.pointsEarned}pt`, h('span', { class: 'muted small' }, ` (승 ${BONUS_WIN} / 무 ${BONUS_DRAW} / 패 ${BONUS_LOSE} 기준)`))
        : null,
      monsterReward,
    ),
    table,
    h('div', { class: 'row center' }, h('button', { class: 'btn primary big', onclick: next }, nextLabel)),
  );
}

// ───────────────────────── 8. 하루 마무리 (보상 요약 + 보너스 상점) ─────────────────────────

/**
 * 하루 마무리에 표시할 몬스터 승리 추가 보상 줄.
 * state.rarityFloor / state.pendingTeamStatBonus 는 day_end 에 닿기 전에 이미 소비되므로
 * (4스텝 선택 확정 시 / 4:4 전투 준비 시) 그 값이 아니라 그날의 기록에서 다시 구한다.
 */
function monsterExtraRewardLines(rec: DayRecord | undefined): Child[] {
  if (!rec || !rec.monster || !rec.monster.won) return [];
  const r = monsterRewardOf(rec.monster.tier, rec.day, true);
  const out: Child[] = [];
  if (r.rarityFloor) {
    out.push(h('div', { class: 'small', style: `color:${rarityColor(r.rarityFloor)}` },
      `획득: 다음 선택지 ${rarityKo(r.rarityFloor)} 이상 1장 보장 (적용 완료)`));
  }
  if (r.teamStatBonus > 0) {
    out.push(h('div', { class: 'small muted' }, `획득: 팀 전원 랜덤 스탯 +${r.teamStatBonus} (적용 완료)`));
  }
  return out;
}

function renderDayEnd(state: RunState): HTMLElement {
  const team = state.team;
  if (!team) return noTeamScreen();
  const rec: DayRecord | undefined = state.history[state.history.length - 1];
  const isLastDay = state.day >= TOTAL_DAYS;

  const nextDay = () => {
    if (!run) return;
    finishDay(run, { ghosts: ghostsFor(run) });
    restoreRunData(run);
    persist();
    if (run.phase === 'done' && run.team) {
      storage.saveCompletedTeam(run.team);
      toast('육성 완료! 완성 팀이 저장되었습니다.', 3000);
    }
    render();
  };

  const summary = h(
    'div',
    { class: 'card day-summary' },
    h('div', { class: 'card-title' }, `${state.day}일차 결과`),
    h('div', { class: 'section-title' }, '고른 선택지'),
    rec && rec.choicesTaken.length > 0
      ? h('ul', { class: 'taken-list' }, rec.choicesTaken.map((ct) =>
          h('li', null,
            h('span', { class: `chip rarity rarity-${ct.rarity}`, style: `color:${rarityColor(ct.rarity)}; border-color:${rarityColor(ct.rarity)}` }, rarityKo(ct.rarity)),
            ' ',
            h('span', null, ct.title),
            ct.success === true ? h('span', { class: 'win-text' }, ' 성공') : ct.success === false ? h('span', { class: 'lose-text' }, ' 실패') : null,
          ),
        ))
      : h('div', { class: 'small muted' }, '기록 없음'),
    h('div', { class: 'section-title' }, '몬스터 전투'),
    rec && rec.monster
      ? h('div', { class: 'row wrap' },
          h('span', { class: 'chip tier-badge', style: `color:${MONSTER_TIER_COLOR[rec.monster.tier]}; border-color:${MONSTER_TIER_COLOR[rec.monster.tier]}` }, MONSTER_TIER_NAME_KO[rec.monster.tier]),
          h('span', null, rec.monster.name),
          h('span', { class: rec.monster.won ? 'win-text' : 'lose-text' }, rec.monster.won ? '승리' : '패배'),
          h('span', { class: 'tiny muted' }, `${reasonKo(rec.monster.result.reason)} · ${fmtSec(rec.monster.result.durationSec)}`),
        )
      : h('div', { class: 'small muted' }, '기록 없음'),
    h('div', { class: 'section-title' }, `${VS_LABEL} 전투`),
    rec
      ? h('div', { class: 'row wrap' },
          h('span', { class: `chip map-chip map-${rec.map}` }, MAP_NAME_KO[rec.map]),
          h('span', null, rec.opponentName),
          h('span', { class: rec.result.winner === 'A' ? 'win-text' : rec.result.winner === 'B' ? 'lose-text' : '' }, rec.result.winner === 'A' ? '승리' : rec.result.winner === 'B' ? '패배' : '무승부'),
          h('span', { class: 'tiny muted' }, `${reasonKo(rec.result.reason)} · ${fmtSec(rec.result.durationSec)}`),
        )
      : h('div', { class: 'small muted' }, '기록 없음'),
    h('div', { class: 'day-points' }, `오늘 획득 포인트 +${rec ? rec.pointsEarned : 0}`),
    ...monsterExtraRewardLines(rec),
  );

  return h(
    'div',
    { class: 'screen' },
    header(`${state.day}일차 · 하루 마무리`, `${team.name} · 전투력 ${fmtNum(safeTeamPower(team))}`, backToStartButton()),
    h('div', { class: 'sticky-bar' },
      h('div', { class: 'row between wrap' },
        h('div', null, h('strong', { class: 'points' }, `${state.bonusPoints}pt`), h('span', { class: 'muted small' }, ` · 리롤권 ${state.rerolls}개 (선택지 리롤 ${REROLL_COST}pt)`)),
        h('button', { class: 'btn primary', onclick: nextDay }, isLastDay ? '육성 완료' : `다음 날 (${state.day + 1}일차)`),
      ),
    ),
    summary,
    h('div', { class: 'card' },
      h('div', { class: 'card-title' }, '보너스 상점'),
      h('p', { class: 'small muted' }, `포인트로 스킬을 사거나 스탯을 훈련합니다 (스탯 +${STAT_TRAIN_DELTA} / ${STAT_TRAIN_COST}pt).`),
    ),
    h('div', { class: 'grid cards wide-cards' }, team.members.map((c) => shopCard(state, c))),
    h('div', { class: 'row center' }, h('button', { class: 'btn primary big', onclick: nextDay }, isLastDay ? '육성 완료' : `다음 날 (${state.day + 1}일차)`)),
  );
}

function shopCard(state: RunState, c: Character): HTMLElement {
  const counts = safeCounts(c);
  const pool = safeSkillPool(c);
  const skillRows = pool.map((id) => {
    let def;
    try { def = getSkill(id); } catch { return null; }
    const isActive = def.type === 'active';
    const slotFull = isActive ? counts.active >= MAX_ACTIVE_SKILLS : counts.passive >= MAX_PASSIVE_SKILLS;
    const poor = state.bonusPoints < def.cost;
    const reason = slotFull ? (isActive ? '액티브 슬롯 가득' : '패시브 슬롯 가득') : poor ? '포인트 부족' : '';
    return h(
      'div',
      { class: 'skill-row' },
      h('div', { class: 'skill-info' },
        h('div', null, h('span', { class: `chip ${isActive ? 'active' : 'passive'}` }, isActive ? '액티브' : '패시브'), ' ', h('strong', null, def.name)),
        h('div', { class: 'small muted' }, def.desc),
      ),
      h('div', { class: 'skill-buy' },
        h('button', {
          class: 'btn small',
          disabled: slotFull || poor,
          title: reason,
          onclick: () => {
            if (!run) return;
            const ok = buySkill(run, c.id, id);
            if (ok) toast(`${c.name}: ${def.name} 습득 (-${def.cost}pt)`);
            else toast('구매할 수 없습니다.');
            persist();
            render();
          },
        }, `${def.cost}pt`),
        reason ? h('div', { class: 'tiny muted' }, reason) : null,
      ),
    );
  });

  const sel = h('select', { class: 'input' },
    BASE_STAT_KEYS.map((k) => h('option', { value: k, selected: (trainSel[c.id] ?? BASE_STAT_KEYS[0]) === k },
      c.stats[k] >= STAT_MAX ? `${STAT_NAME_KO[k]} (${c.stats[k]} · 최대)` : `${STAT_NAME_KO[k]} (${c.stats[k]})`)),
  );
  // 포인트뿐 아니라 선택된 스탯이 이미 상한(STAT_MAX)인지도 함께 본다 (run.ts 의 trainStat 거절 조건)
  const poorForTrain = state.bonusPoints < STAT_TRAIN_COST;
  const trainReasonOf = (stat: BaseStatKey): string =>
    c.stats[stat] >= STAT_MAX ? '이미 최대치입니다' : poorForTrain ? '포인트 부족' : '';

  const trainBtn = h('button', {
    class: 'btn small',
    onclick: () => {
      if (!run) return;
      const stat = (trainSel[c.id] ?? (sel.value as BaseStatKey)) as BaseStatKey;
      const ok = trainStat(run, c.id, stat);
      if (ok) toast(`${c.name}: ${STAT_NAME_KO[stat]} +${STAT_TRAIN_DELTA} (-${STAT_TRAIN_COST}pt)`);
      else toast(`훈련할 수 없습니다. (${trainReasonOf(stat) || '조건 불충족'})`);
      persist();
      render();
    },
  }, `+${STAT_TRAIN_DELTA} (${STAT_TRAIN_COST}pt)`);
  const trainNote = h('span', { class: 'tiny muted' });

  /** 드롭다운 선택이 바뀌면 버튼 활성/사유를 그 자리에서 갱신한다 (전체 재렌더 없이) */
  const syncTrainBtn = (): void => {
    const stat: BaseStatKey = trainSel[c.id] ?? BASE_STAT_KEYS[0];
    const reason = trainReasonOf(stat);
    trainBtn.disabled = reason !== '';
    trainBtn.title = reason;
    trainNote.textContent = reason;
  };
  sel.addEventListener('change', () => {
    trainSel[c.id] = sel.value as BaseStatKey;
    syncTrainBtn();
  });
  syncTrainBtn();

  return h(
    'div',
    { class: 'card member-card' },
    h('div', { class: 'char-head' },
      h('span', { class: `job-badge job-${c.mainJob}` }, JOB_NAME_KO[c.mainJob]),
      h('span', { class: 'name' }, c.name),
      h('span', { class: 'muted small' }, subJobName(c.subJob)),
      h('span', { class: 'muted small' }, `전투력 ${safePower(c)}`),
    ),
    h('div', { class: 'small muted' }, `보유 스킬 (액티브 ${counts.active}/${MAX_ACTIVE_SKILLS}, 패시브 ${counts.passive}/${MAX_PASSIVE_SKILLS})`),
    skillChips(c),
    persistentDetails(`shop:${c.id}`, '스탯 상세', statTable(c)),
    h('div', { class: 'section-title' }, '스탯 훈련'),
    h('div', { class: 'row' },
      sel,
      trainBtn,
      trainNote,
    ),
    h('div', { class: 'section-title' }, '스킬 상점'),
    skillRows.length === 0 ? h('div', { class: 'small muted' }, '구매 가능한 스킬이 없습니다.') : h('div', { class: 'skill-list' }, skillRows),
  );
}

// ───────────────────────── 9. 육성 완료 (10일 요약) ─────────────────────────

function renderDone(state: RunState): HTMLElement {
  const team = state.team;
  if (!team) return noTeamScreen();
  const wins = state.history.filter((r) => r.result.winner === 'A').length;
  const draws = state.history.filter((r) => r.result.winner === 'draw').length;
  const losses = state.history.length - wins - draws;
  const monsterWins = state.history.filter((r) => r.monster && r.monster.won).length;
  const monsterCount = state.history.filter((r) => r.monster).length;
  const totalPoints = state.history.reduce((acc, r) => acc + r.pointsEarned, 0);
  const alreadySaved = storage.isTeamSaved(team);

  const memberCards = team.members.map((c) => {
    let derived: string[] = [];
    try {
      const d = computeDerived(c, 'plains');
      derived = [`HP ${fmtNum(d.maxHp)}`, `물공 ${fmtNum(d.physAtk)}`, `이능공 ${fmtNum(d.magAtk)}`, `물방 ${fmtNum(d.physDef)}`, `이능방 ${fmtNum(d.magDef)}`, `공속 ${d.atkSpeed.toFixed(2)}`, `이속 ${d.moveSpeed.toFixed(1)}`, `치명 ${d.critChance.toFixed(0)}%`];
    } catch {
      derived = [];
    }
    return h(
      'div',
      { class: 'card member-card' },
      h('div', { class: 'char-head' },
        h('span', { class: `job-badge job-${c.mainJob}` }, JOB_NAME_KO[c.mainJob]),
        h('span', { class: 'name' }, c.name),
        h('span', { class: 'stars' }, stars(c.rarity)),
      ),
      h('div', { class: 'small muted' }, `${jobLabel(c)} · 전투력 ${safePower(c)} · 스탯 합계 ${statTotal(c)}`),
      derived.length > 0 ? h('div', { class: 'chips' }, derived.map((t) => h('span', { class: 'chip' }, t))) : null,
      statTable(c),
      adaptationBars(c),
      h('div', { class: 'section-title' }, '스킬'),
      c.skills.length === 0 ? h('div', { class: 'small muted' }, '없음') : h('ul', { class: 'skill-ul' }, c.skills.map((id) =>
        h('li', null, h('span', { class: `chip ${skillTypeKo(id) === '패시브' ? 'passive' : 'active'}` }, skillTypeKo(id) || '스킬'), ' ', h('strong', null, skillName(id)), h('div', { class: 'tiny muted' }, safeSkillDesc(id))),
      )),
    );
  });

  return h(
    'div',
    { class: 'screen' },
    header('육성 완료', `${team.name} · ${VS_LABEL} ${wins}승 ${draws}무 ${losses}패 · 몬스터 ${monsterWins}/${monsterCount} · 전투력 ${fmtNum(safeTeamPower(team))}`, backToStartButton()),
    h('div', { class: 'card' },
      h('div', { class: 'card-title' }, '팀 시너지'),
      team.synergies.length === 0 ? h('div', { class: 'small muted' }, '없음') : h('ul', { class: 'skill-ul' }, team.synergies.map((s) => h('li', null, h('strong', null, s.name), h('div', { class: 'tiny muted' }, s.desc)))),
    ),
    h('div', { class: 'card' },
      h('div', { class: 'card-title' }, `${TOTAL_DAYS}일 기록 (누적 포인트 ${fmtNum(totalPoints)})`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['일차', '맵', '상대', `${VS_LABEL} 결과`, '몬스터', '포인트', '선택'].map((t) => h('th', null, t)))),
        h('tbody', null, state.history.map((r) => h('tr', null,
          h('td', null, `${r.day}일`),
          h('td', null, MAP_NAME_KO[r.map]),
          h('td', null, r.opponentName),
          h('td', { class: r.result.winner === 'A' ? 'win-text' : r.result.winner === 'B' ? 'lose-text' : '' }, r.result.winner === 'A' ? '승' : r.result.winner === 'B' ? '패' : '무', h('span', { class: 'tiny muted' }, ` ${reasonKo(r.result.reason)} ${fmtSec(r.result.durationSec)}`)),
          h('td', { class: r.monster ? (r.monster.won ? 'win-text' : 'lose-text') : 'muted' }, r.monster ? `${MONSTER_TIER_NAME_KO[r.monster.tier]} ${r.monster.name} ${r.monster.won ? '승' : '패'}` : '—'),
          h('td', { class: 'num' }, `+${r.pointsEarned}`),
          h('td', { class: 'small' }, r.choicesTaken.map((ct) => `[${rarityKo(ct.rarity)}] ${ct.title}${ct.success === true ? ' ✓' : ct.success === false ? ' ✗' : ''}`).join(', ')),
        ))),
      )),
    ),
    h('div', { class: 'grid cards wide-cards' }, memberCards),
    h('div', { class: 'row center wrap' },
      h('button', {
        class: 'btn primary big',
        disabled: alreadySaved,
        onclick: () => {
          storage.saveCompletedTeam(team);
          toast(`${team.name} 저장 완료. 완성 팀 대전에서 사용할 수 있습니다.`);
          render();
        },
      }, alreadySaved ? '저장됨' : '완성 팀 저장'),
      h('button', {
        class: 'btn',
        onclick: () => {
          if (!alreadySaved && !window.confirm('팀을 저장하지 않았습니다. 그래도 종료할까요?')) return;
          storage.clearRun();
          run = null;
          view = 'start';
          render();
        },
      }, '육성 종료 (처음으로)'),
    ),
  );
}

// ───────────────────────── 10. 완성팀 대전 ─────────────────────────

function renderPvpSetup(): HTMLElement {
  const teams = storage.loadCompletedTeams();
  if (teams.length < 2) {
    return h('div', { class: 'screen' }, header('완성 팀 대전'), h('div', { class: 'card' }, '저장된 완성 팀이 2개 이상 필요합니다.'), h('button', { class: 'btn', onclick: () => { view = 'start'; render(); } }, '처음으로'));
  }
  if (!teams.some((t) => t.id === pvp.aId)) pvp.aId = teams[0].id;
  if (!teams.some((t) => t.id === pvp.bId)) pvp.bId = teams.find((t) => t.id !== pvp.aId)?.id ?? teams[1].id;

  const teamPicker = (side: TeamSide) =>
    h('div', { class: `card side-${side}` },
      h('div', { class: 'card-title' }, side === 'A' ? '팀 A (파랑)' : '팀 B (빨강)'),
      h('div', { class: 'team-pick-list' }, teams.map((t) => {
        const checked = (side === 'A' ? pvp.aId : pvp.bId) === t.id;
        return h('label', { class: `pick-row ${checked ? 'checked' : ''}` },
          h('input', { type: 'radio', name: `pick-${side}`, checked, onchange: () => { if (side === 'A') pvp.aId = t.id; else pvp.bId = t.id; render(); } }),
          h('span', { class: 'name' }, t.name),
          h('span', { class: 'muted small' }, t.members.map((c) => JOB_NAME_KO[c.mainJob]).join('/')),
          h('span', { class: 'muted small' }, `전투력 ${fmtNum(safeTeamPower(t))}`),
          h('button', { class: 'btn ghost tiny danger', onclick: (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); if (window.confirm(`${t.name} 팀을 삭제할까요?`)) { storage.deleteCompletedTeam(t.id); render(); } } }, '삭제'),
        );
      })),
    );

  const seedInput = h('input', { class: 'input', type: 'text', inputmode: 'numeric', value: String(pvp.seed) });
  seedInput.addEventListener('input', () => { pvp.seed = parseSeed(seedInput.value); });
  const mapSel = h('select', { class: 'input' }, MAP_TYPES.map((m) => h('option', { value: m, selected: pvp.map === m }, `${MAP_NAME_KO[m]} — ${MAPS[m].desc}`)));
  mapSel.addEventListener('change', () => { pvp.map = mapSel.value as MapType; });

  const fight = () => {
    const a = teams.find((t) => t.id === pvp.aId);
    const b0 = teams.find((t) => t.id === pvp.bId);
    if (!a || !b0) { toast('두 팀을 선택하세요.'); return; }
    if (a.members.length !== TEAM_SIZE || b0.members.length !== TEAM_SIZE) { toast(`완성 팀은 ${TEAM_SIZE}명이어야 합니다.`); return; }
    const b = dedupeTeamIds(a, b0);
    pvp.seed = parseSeed(seedInput.value);
    pvp.map = mapSel.value as MapType;
    startBattle({ seed: pvp.seed, map: pvp.map, teamA: a, teamB: b }, 'pvp', `${a.name} vs ${b.name}`);
  };

  return h(
    'div',
    { class: 'screen' },
    header('완성 팀 대전', `저장된 두 ${TEAM_SIZE}인 팀으로 ${VS_LABEL} 전투를 재생합니다. 같은 시드·맵·팀이면 결과가 항상 같습니다.`, h('button', { class: 'btn ghost small', onclick: () => { view = 'start'; render(); } }, '메인')),
    h('div', { class: 'grid two' }, teamPicker('A'), teamPicker('B')),
    h('div', { class: 'card' },
      h('div', { class: 'row wrap' },
        h('label', { class: 'label' }, '맵'), mapSel,
      ),
      h('div', { class: 'row wrap' },
        h('label', { class: 'label' }, '시드'), seedInput,
        h('button', { class: 'btn ghost', onclick: () => { pvp.seed = randomSeed(); seedInput.value = String(pvp.seed); } }, '랜덤'),
      ),
    ),
    h('div', { class: 'row center' }, h('button', { class: 'btn primary big', onclick: fight }, '전투 시작')),
  );
}

// ───────────────────────── 부트 ─────────────────────────

window.addEventListener('resize', () => {
  if (battle && battle.renderer) battle.renderer.resize();
});

document.addEventListener('visibilitychange', () => {
  // 탭 복귀 시 큰 dt 로 한꺼번에 진행되지 않도록 시간 기준을 리셋
  if (battle && !document.hidden) battle.lastTs = performance.now();
});

// 탭 제목도 팀 인원 표기(4:4)를 따른다. index.html 의 정적 제목은 부팅 시 덮어쓴다.
document.title = `이능 ${VS_LABEL} 전투 시뮬레이터`;
render();
// 시작 화면보다 먼저 그림을 모아 받는다 (전투 시작 시의 preload 는 안전망으로 남겨 둔다)
bootPreload();
