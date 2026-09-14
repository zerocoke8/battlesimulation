/**
 * 브라우저 UI 진입점. #app 에 화면을 상태 기반으로 렌더링한다.
 * 시뮬레이션/육성 로직은 src/core 에 있고 여기서는 호출만 한다.
 */
import {
  BASE_STAT_KEYS,
  CHOICE_KIND_NAME_KO,
  JOB_NAME_KO,
  MAP_NAME_KO,
  MAP_TYPES,
  MAX_ACTIVE_SKILLS,
  MAX_PASSIVE_SKILLS,
  STAT_CATEGORY_NAME_KO,
  STAT_NAME_KO,
  TICK_RATE,
  TOTAL_CYCLES,
  type BaseStatKey,
  type BattleEvent,
  type BattleFrame,
  type BattleInput,
  type BattleResult,
  type BattleSimulator,
  type Character,
  type Choice,
  type GhostSnapshot,
  type MapType,
  type RunState,
  type StatCategory,
  type Team,
  type TeamSide,
  type UnitBattleStats,
} from '../core/types';
import { MAPS } from '../core/data/maps';
import { getSkill, skillPoolFor, countSkills } from '../core/data/skills';
import { computeDerived, powerRating, statTotal } from '../core/stats';
import { createBattle } from '../core/battle/sim';
import {
  BONUS_DRAW,
  BONUS_LOSE,
  BONUS_WIN,
  REROLL_COST,
  STAT_TRAIN_COST,
  STAT_TRAIN_DELTA,
  battleInput,
  buySkill,
  ensureChoices,
  finishBattle,
  finishBonus,
  isSubJobChoiceSet,
  newRun,
  pickChoice,
  prepareNextBattle,
  rerollChoices,
  selectTeam,
  trainStat,
} from '../core/growth/run';
import { BattleRenderer } from './render';
import * as storage from './storage';
import {
  VICTORY_KO,
  categoryAverages,
  clear,
  fmtNum,
  fmtSec,
  h,
  jobLabel,
  reasonKo,
  skillName,
  skillTypeKo,
  stars,
  statsOfCategory,
  subJobName,
  type Child,
} from './format';

// ───────────────────────── 앱 상태 ─────────────────────────

type View = 'start' | 'run' | 'pvp_setup' | 'battle' | 'result';
type BattleMode = 'run' | 'pvp';

interface BattleSession {
  mode: BattleMode;
  sim: BattleSimulator;
  input: BattleInput;
  speed: number;
  paused: boolean;
  acc: number;
  lastTs: number;
  raf: number;
  renderer: BattleRenderer | null;
  frame: BattleFrame;
  killLog: string[];
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
    speedBtns: HTMLButtonElement[];
    pauseBtn: HTMLButtonElement | null;
  };
}

interface LastResult {
  mode: BattleMode;
  input: BattleInput;
  result: BattleResult;
  bonusEarned: number | null;
}

let view: View = 'start';
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

function safePower(c: Character): number {
  try {
    return Math.round(powerRating(c));
  } catch {
    return statTotal(c);
  }
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
    h('div', { class: 'card-title' }, title, ' ', h('span', { class: 'muted' }, team.name)),
    h(
      'ul',
      { class: 'member-list' },
      team.members.map((c) =>
        h(
          'li',
          null,
          h('span', { class: `job-badge job-${c.mainJob}` }, JOB_NAME_KO[c.mainJob]),
          h('span', { class: 'name' }, c.name),
          h('span', { class: 'muted small' }, subJobName(c.subJob) || '—'),
          h('span', { class: 'power' }, `전투력 ${safePower(c)}`),
        ),
      ),
    ),
    team.synergies.length > 0
      ? h('div', { class: 'synergy-list' }, team.synergies.map((s) => h('span', { class: 'chip synergy', title: s.desc }, s.name)))
      : null,
  );
}

// ───────────────────────── 렌더 루프 ─────────────────────────

/** 직전에 그린 화면 키. 화면이 바뀔 때만 맨 위로 스크롤한다 (같은 화면 갱신은 스크롤 위치 유지). */
let lastScreenKey = '';
/** 같은 화면을 다시 그려도 펼침 상태를 잃지 않도록 열린 <details> 키를 기억 */
const openDetails = new Set<string>();

function screenKey(): string {
  return view === 'run' && run ? `run:${run.phase}:${run.cycle}` : view;
}

function render(): void {
  const key = screenKey();
  const changed = key !== lastScreenKey;
  const prevY = window.scrollY;
  clear(root);
  switch (view) {
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
    if (run.phase === 'battle') run.phase = 'pre_battle';
    if (run.phase === 'pre_battle' && (!run.currentMap || !run.opponent)) {
      prepareNextBattle(run, { ghosts: ghostsFor(run) });
    }
    persist();
    view = 'run';
    render();
  };

  return h(
    'div',
    { class: 'screen start' },
    h('div', { class: 'hero' }, h('h1', null, '이능 5:5 전투 시뮬레이터'), h('p', { class: 'muted' }, '가챠 풀에서 5명을 고르고 10사이클 동안 육성해 팀을 완성하세요. 전투는 자동으로 진행되며 관전만 합니다.')),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-title' }, '새 육성 시작'),
      h('div', { class: 'row' }, h('label', { class: 'label' }, '시드'), seedInput, h('button', { class: 'btn ghost', onclick: () => { seedInput.value = String(randomSeed()); } }, '랜덤')),
      h('p', { class: 'muted small' }, '같은 시드면 같은 캐릭터 풀과 같은 상대가 나옵니다.'),
      h('button', { class: 'btn primary wide', onclick: startNew }, '새 육성 시작'),
    ),
    saved
      ? h(
          'div',
          { class: 'card' },
          h('div', { class: 'card-title' }, '이어하기'),
          h('p', { class: 'muted small' }, `시드 ${saved.seed} · ${saved.cycle > 0 ? `사이클 ${saved.cycle}/${TOTAL_CYCLES}` : '팀 선택 중'} · 단계: ${phaseKo(saved.phase)}${saved.team ? ` · ${saved.team.name}` : ''}`),
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
      h('div', null, `고스트 데이터 ${ghosts.length}개 (과거 육성의 사이클별 팀 스냅샷, 상대로 등장)`),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn ghost small', disabled: ghosts.length === 0, onclick: () => { if (window.confirm('고스트 데이터를 모두 삭제할까요?')) { storage.clearGhosts(); render(); } } }, '고스트 삭제'),
        h('button', { class: 'btn ghost small danger', onclick: () => { if (window.confirm('모든 저장 데이터(육성, 고스트, 완성 팀)를 삭제할까요?')) { storage.clearAll(); render(); } } }, '전체 초기화'),
      ),
    ),
  );
}

function phaseKo(p: RunState['phase']): string {
  switch (p) {
    case 'select_team': return '팀 선택';
    case 'pre_battle': return '전투 준비';
    case 'battle': return '전투';
    case 'bonus': return '보너스 상점';
    case 'choice': return '로그라이크 선택';
    case 'done': return '완료';
    default: return p;
  }
}

// ───────────────────────── 육성 화면 분기 ─────────────────────────

function renderRun(): HTMLElement {
  if (!run) {
    view = 'start';
    return renderStart();
  }
  switch (run.phase) {
    case 'select_team': return renderSelectTeam(run);
    case 'pre_battle': return renderPreBattle(run);
    case 'battle':
      run.phase = 'pre_battle';
      return renderPreBattle(run);
    case 'bonus': return renderBonus(run);
    case 'choice': return renderChoice(run);
    case 'done': return renderDone(run);
    default:
      return h('div', { class: 'screen' }, h('p', null, `알 수 없는 단계: ${String(run.phase)}`), h('button', { class: 'btn', onclick: () => { view = 'start'; render(); } }, '처음으로'));
  }
}

function backToStartButton(): HTMLElement {
  return h('button', { class: 'btn ghost small', onclick: () => { persist(); view = 'start'; render(); } }, '메인');
}

// ───────────────────────── 2. 팀 선택 ─────────────────────────

function renderSelectTeam(state: RunState): HTMLElement {
  const nameInput = h('input', { class: 'input', type: 'text', value: selection.name, maxlength: 16, placeholder: '팀 이름' });
  nameInput.addEventListener('input', () => { selection.name = nameInput.value; });

  const confirm = () => {
    if (selection.ids.length !== 5) { toast('5명을 선택해야 합니다.'); return; }
    const name = (nameInput.value.trim() || '나의 팀').slice(0, 16);
    selectTeam(state, selection.ids.slice(), name, { ghosts: ghostsFor(state) });
    if (state.phase === 'pre_battle' && (!state.currentMap || !state.opponent)) {
      prepareNextBattle(state, { ghosts: ghostsFor(state) });
    }
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
      h('strong', null, `선택 ${selection.ids.length}/5`),
      h('span', { class: 'chips' }, Object.entries(counts).map(([job, n]) => h('span', { class: `chip job-${job}` }, `${JOB_NAME_KO[job as keyof typeof JOB_NAME_KO]} ×${n}`))),
    ),
    h('div', { class: 'row' }, nameInput, h('button', { class: 'btn primary', disabled: selection.ids.length !== 5, onclick: confirm }, '확정')),
  );

  const cards = state.pool.map((c) => {
    const selected = selection.ids.includes(c.id);
    const full = selection.ids.length >= 5 && !selected;
    const card = h(
      'div',
      {
        class: `card char-card ${selected ? 'selected' : ''} ${full ? 'dim' : ''}`,
        onclick: () => {
          if (selected) selection.ids = selection.ids.filter((x) => x !== c.id);
          else if (selection.ids.length < 5) selection.ids.push(c.id);
          else { toast('이미 5명을 선택했습니다.'); return; }
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
    return card;
  });

  return h(
    'div',
    { class: 'screen' },
    header('팀 선택', `풀 ${state.pool.length}명 중 5명을 고르세요 · 시드 ${state.seed}`, backToStartButton()),
    bar,
    h('div', { class: 'grid cards' }, cards),
  );
}

// ───────────────────────── 3. 전투 전 ─────────────────────────

function renderPreBattle(state: RunState): HTMLElement {
  if (!state.team) {
    return h('div', { class: 'screen' }, h('p', null, '팀이 없습니다.'), backToStartButton());
  }
  if (!state.currentMap || !state.opponent) {
    prepareNextBattle(state, { ghosts: ghostsFor(state) });
    persist();
  }
  const mapId = state.currentMap ?? 'plains';
  const map = MAPS[mapId];
  const opp = state.opponent;
  // run.ts 는 고스트 상대의 팀/캐릭터 id 에 'g_' 접두사를 붙인다
  const isGhost = !!opp && (opp.id.startsWith('g_') || opp.members.some((c) => c.id.startsWith('g_')));

  const start = () => {
    if (!run || !run.team || !run.opponent || !run.currentMap) return;
    const input = battleInput(run);
    run.phase = 'battle';
    persist();
    startBattle(input, 'run');
  };

  return h(
    'div',
    { class: 'screen' },
    header(`사이클 ${state.cycle}/${TOTAL_CYCLES} · 전투 준비`, `${state.team.name} · 보너스 ${state.bonusPoints}pt`, backToStartButton()),
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
  return h('div', { class: 'chips' }, items.map((t) => h('span', { class: 'chip' }, t)));
}

function schoolKo(s: string): string {
  const m: Record<string, string> = { fire: '화염', lightning: '전기', ice: '냉기', holy: '신성', nature: '자연', shadow: '암흑', none: '무속성' };
  return m[s] ?? s;
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
        return h('span', { class: `chip result-${w}`, title: `${r.opponentName} · ${reasonKo(r.result.reason)} · +${r.bonusEarned}pt` }, `${r.cycle} ${MAP_NAME_KO[r.map]} ${label}`);
      }),
    ),
  );
}

// ───────────────────────── 4. 전투 ─────────────────────────

function startBattle(input: BattleInput, mode: BattleMode): void {
  stopBattleLoop();
  const sim = createBattle(input);
  battle = {
    mode,
    sim,
    input,
    speed: 1,
    paused: false,
    acc: 0,
    lastTs: 0,
    raf: 0,
    renderer: null,
    frame: sim.currentFrame(),
    killLog: [],
    hud: { time: null, hpA: null, hpB: null, hpAText: null, hpBText: null, kills: null, capture: null, capA: null, capB: null, speedBtns: [], pauseBtn: null },
  };
  view = 'battle';
  render();
}

function stopBattleLoop(): void {
  if (battle && battle.raf) cancelAnimationFrame(battle.raf);
  if (battle) battle.raf = 0;
}

function renderBattle(): HTMLElement {
  const b = battle;
  if (!b) {
    view = 'start';
    return renderStart();
  }
  const map = MAPS[b.input.map];
  const canvas = h('canvas', { class: 'battle-canvas', width: 800, height: 600 });
  const wrap = h('div', { class: `canvas-wrap map-${b.input.map}` }, canvas);

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

  const speedBtns: HTMLButtonElement[] = [1, 2, 4].map((sp) =>
    h('button', { class: `btn small ${b.speed === sp ? 'primary' : ''}`, onclick: () => setSpeed(sp) }, `${sp}x`),
  );
  const pauseBtn = h('button', { class: 'btn small', onclick: () => togglePause() }, b.paused ? '재생' : '일시정지');
  const skipBtn = h('button', { class: 'btn small warn', onclick: () => skipBattle() }, '스킵');

  b.hud = { time, hpA, hpB, hpAText, hpBText, kills, capture, capA, capB, speedBtns, pauseBtn };

  const screen = h(
    'div',
    { class: 'screen battle' },
    h('div', { class: 'battle-head' },
      h('div', { class: 'team-hp side-A' }, h('div', { class: 'row between' }, h('strong', null, b.input.teamA.name), hpAText), h('div', { class: 'bar' }, hpA)),
      h('div', { class: 'battle-mid' }, h('div', { class: 'small muted' }, `${map.name}${b.mode === 'run' && run ? ` · 사이클 ${run.cycle}` : ''}`), time),
      h('div', { class: 'team-hp side-B' }, h('div', { class: 'row between' }, hpBText, h('strong', null, b.input.teamB.name)), h('div', { class: 'bar rtl' }, hpB)),
    ),
    wrap,
    capture,
    h('div', { class: 'controls' }, ...speedBtns, pauseBtn, skipBtn),
    h('div', { class: 'card kill-card' }, h('div', { class: 'card-title' }, '킬 로그'), kills),
  );

  // 캔버스가 DOM 에 붙은 뒤 렌더러 생성 및 루프 시작
  requestAnimationFrame(() => {
    if (!battle || battle !== b) return;
    b.renderer = new BattleRenderer(canvas, map);
    b.renderer.draw(b.frame);
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

function unitName(frame: BattleFrame, id: string): string {
  const u = frame.units.find((x) => x.id === id);
  return u ? u.name : id;
}

function handleEvents(b: BattleSession, events: BattleEvent[], frame: BattleFrame): void {
  let touched = false;
  for (const e of events) {
    if (e.kind === 'kill') {
      const killer = frame.units.find((x) => x.id === e.killer);
      const victim = frame.units.find((x) => x.id === e.victim);
      const ks = killer ? `<span class="side-${killer.side}-text">${escapeHtml(killer.name)}</span>` : escapeHtml(e.killer);
      const vs = victim ? `<span class="side-${victim.side}-text">${escapeHtml(victim.name)}</span>` : escapeHtml(e.victim);
      b.killLog.push(`[${fmtSec(e.t)}] ${ks} → ${vs} 격파`);
      touched = true;
    } else if (e.kind === 'capture' && e.progress >= 1) {
      b.killLog.push(`[${fmtSec(e.t)}] ${e.side === 'A' ? b.input.teamA.name : b.input.teamB.name} 거점 점령!`);
      touched = true;
    } else if (e.kind === 'end') {
      b.killLog.push(`[${fmtSec(e.t)}] 전투 종료 — ${e.winner === 'draw' ? '무승부' : `${winnerLabel(b.input, e.winner)} 승리`} (${reasonKo(e.reason)})`);
      touched = true;
    }
  }
  if (touched && b.hud.kills) {
    clear(b.hud.kills);
    const last = b.killLog.slice(-6);
    for (const line of last) {
      const li = document.createElement('li');
      li.innerHTML = line;
      b.hud.kills.appendChild(li);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
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
  let bonusEarned: number | null = null;
  if (b.mode === 'run' && run) {
    finishBattle(run, result);
    const record = run.history[run.history.length - 1];
    if (record) {
      bonusEarned = record.bonusEarned;
      try {
        storage.saveGhost({ runSeed: run.seed, cycle: record.cycle, team: record.teamSnapshot, savedAt: new Date().toISOString() });
      } catch {
        /* 무시 */
      }
    }
    persist();
  }
  lastResult = { mode: b.mode, input: b.input, result, bonusEarned };
  battle = null;
  view = 'result';
  render();
}

// ───────────────────────── 5. 결과 ─────────────────────────

function renderResult(): HTMLElement {
  const lr = lastResult;
  if (!lr) {
    view = run ? 'run' : 'start';
    return run ? renderRun() : renderStart();
  }
  const { result, input } = lr;
  const playerWon = result.winner === 'A';
  const title = lr.mode === 'run'
    ? result.winner === 'draw' ? '무승부' : playerWon ? '승리!' : '패배'
    : result.winner === 'draw' ? '무승부' : `${winnerLabel(input, result.winner)} 승리`;

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
    if (lr.mode === 'run') {
      view = 'run';
    } else {
      view = 'pvp_setup';
    }
    render();
  };

  return h(
    'div',
    { class: 'screen' },
    header('전투 결과', `${MAPS[result.map].name} · ${reasonKo(result.reason)} · ${fmtSec(result.durationSec)}`),
    h('div', { class: `card result-banner ${result.winner === 'draw' ? 'draw' : lr.mode === 'run' ? (playerWon ? 'win' : 'lose') : 'win'}` },
      h('div', { class: 'result-title' }, title),
      h('div', { class: 'muted' }, `${input.teamA.name} vs ${input.teamB.name}`),
      result.mvpId ? h('div', null, 'MVP: ', h('strong', null, nameOf(result.mvpId))) : null,
      lr.bonusEarned !== null ? h('div', { class: 'bonus-earned' }, `보너스 획득 +${lr.bonusEarned}pt`, h('span', { class: 'muted small' }, ` (승 ${BONUS_WIN} / 무 ${BONUS_DRAW} / 패 ${BONUS_LOSE})`)) : null,
    ),
    table,
    h('div', { class: 'row center' }, h('button', { class: 'btn primary big', onclick: next }, lr.mode === 'run' ? '보너스 상점으로' : '다시')),
  );
}

// ───────────────────────── 6. 보너스 상점 ─────────────────────────

function renderBonus(state: RunState): HTMLElement {
  const team = state.team;
  if (!team) return h('div', { class: 'screen' }, '팀이 없습니다.', backToStartButton());

  const memberCards = team.members.map((c) => {
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
      BASE_STAT_KEYS.map((k) => h('option', { value: k, selected: (trainSel[c.id] ?? 'vitality') === k }, `${STAT_NAME_KO[k]} (${c.stats[k]})`)),
    );
    sel.addEventListener('change', () => { trainSel[c.id] = sel.value as BaseStatKey; });
    const canTrain = state.bonusPoints >= STAT_TRAIN_COST;

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
      persistentDetails(`bonus:${c.id}`, '스탯 상세', statTable(c)),
      h('div', { class: 'section-title' }, '스탯 훈련'),
      h('div', { class: 'row' },
        sel,
        h('button', {
          class: 'btn small',
          disabled: !canTrain,
          onclick: () => {
            if (!run) return;
            const stat = (trainSel[c.id] ?? (sel.value as BaseStatKey)) as BaseStatKey;
            const ok = trainStat(run, c.id, stat);
            if (ok) toast(`${c.name}: ${STAT_NAME_KO[stat]} +${STAT_TRAIN_DELTA} (-${STAT_TRAIN_COST}pt)`);
            else toast('훈련할 수 없습니다.');
            persist();
            render();
          },
        }, `+${STAT_TRAIN_DELTA} (${STAT_TRAIN_COST}pt)`),
      ),
      h('div', { class: 'section-title' }, '스킬 상점'),
      skillRows.length === 0 ? h('div', { class: 'small muted' }, '구매 가능한 스킬이 없습니다.') : h('div', { class: 'skill-list' }, skillRows),
    );
  });

  return h(
    'div',
    { class: 'screen' },
    header(`사이클 ${state.cycle}/${TOTAL_CYCLES} · 보너스 상점`, `${team.name}`, backToStartButton()),
    h('div', { class: 'sticky-bar' },
      h('div', { class: 'row between wrap' },
        h('div', null, h('strong', { class: 'points' }, `${state.bonusPoints}pt`), h('span', { class: 'muted small' }, ` · 리롤권 ${state.rerolls}개 (선택지 리롤 ${REROLL_COST}pt)`)),
        h('button', { class: 'btn primary', onclick: () => { if (!run) return; finishBonus(run); persist(); render(); } }, '다음 (로그라이크 선택)'),
      ),
    ),
    h('div', { class: 'grid cards wide-cards' }, memberCards),
  );
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

// ───────────────────────── 7. 로그라이크 선택 ─────────────────────────

function renderChoice(state: RunState): HTMLElement {
  const team = state.team;
  if (!team) return h('div', { class: 'screen' }, '팀이 없습니다.', backToStartButton());
  // 저장 데이터 정리 등으로 선택지가 비어 있으면 다시 만든다 (같은 시드에서 같은 결과)
  if (state.currentChoices.length === 0 && ensureChoices(state)) persist();
  const choices = state.currentChoices;

  const onPick = (index: number) => {
    if (!run) return;
    const choice = run.currentChoices[index];
    // 3번째 선택이면 run.ts 가 다음 사이클 전투(고스트 상대 포함)를 준비한다
    const r = pickChoice(run, index, { ghosts: ghostsFor(run) });
    if (choice) {
      const msg = r.success === true ? `성공! ${choice.title}` : r.success === false ? `실패... ${choice.title}` : `적용: ${choice.title}`;
      toast(msg, 2600);
    }
    persist();
    // 10사이클 완료: 완성 팀을 자동 저장한다 (저장을 잊고 새 육성을 시작해도 팀이 남도록)
    if (run.phase === 'done' && run.team) {
      storage.saveCompletedTeam(run.team);
      toast('육성 완료! 완성 팀이 저장되었습니다.', 3000);
    }
    render();
  };

  const subJobSet = isSubJobChoiceSet(state);
  const canReroll = !subJobSet && state.rerolls > 0 && state.bonusPoints >= REROLL_COST;
  const cards = choices.map((ch: Choice, i: number) =>
    h(
      'div',
      { class: `card choice-card kind-${ch.kind}`, onclick: () => onPick(i) },
      h('div', { class: 'row between' },
        h('span', { class: `chip kind kind-${ch.kind}` }, CHOICE_KIND_NAME_KO[ch.kind] ?? ch.kind),
        ch.successChance !== undefined ? h('span', { class: `chip chance ${ch.successChance >= 0.7 ? 'good' : ch.successChance >= 0.5 ? 'mid' : 'bad'}` }, `성공 ${Math.round(ch.successChance * 100)}%`) : h('span', { class: 'chip muted' }, '확정'),
      ),
      h('div', { class: 'choice-title' }, ch.title),
      h('div', { class: 'choice-desc' }, ch.desc),
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
    header(`사이클 ${state.cycle}/${TOTAL_CYCLES} · 로그라이크 선택 ${Math.min(state.choiceIndex + 1, 3)}/3`, `${team.name} · ${state.bonusPoints}pt`, backToStartButton()),
    h('div', { class: 'row between wrap' },
      h('span', { class: 'muted small' }, '세 가지 중 하나를 고르세요. 결과는 즉시 적용됩니다.'),
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

// ───────────────────────── 8. 완료 ─────────────────────────

function renderDone(state: RunState): HTMLElement {
  const team = state.team;
  if (!team) return h('div', { class: 'screen' }, '팀이 없습니다.', backToStartButton());
  const wins = state.history.filter((r) => r.result.winner === 'A').length;
  const draws = state.history.filter((r) => r.result.winner === 'draw').length;
  const losses = state.history.length - wins - draws;
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
    header('육성 완료', `${team.name} · ${wins}승 ${draws}무 ${losses}패`, backToStartButton()),
    h('div', { class: 'card' },
      h('div', { class: 'card-title' }, '팀 시너지'),
      team.synergies.length === 0 ? h('div', { class: 'small muted' }, '없음') : h('ul', { class: 'skill-ul' }, team.synergies.map((s) => h('li', null, h('strong', null, s.name), h('div', { class: 'tiny muted' }, s.desc)))),
    ),
    h('div', { class: 'card' },
      h('div', { class: 'card-title' }, '사이클 기록'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['사이클', '맵', '상대', '결과', '보너스', '선택'].map((t) => h('th', null, t)))),
        h('tbody', null, state.history.map((r) => h('tr', null,
          h('td', null, String(r.cycle)),
          h('td', null, MAP_NAME_KO[r.map]),
          h('td', null, r.opponentName),
          h('td', { class: r.result.winner === 'A' ? 'win-text' : r.result.winner === 'B' ? 'lose-text' : '' }, r.result.winner === 'A' ? '승' : r.result.winner === 'B' ? '패' : '무', h('span', { class: 'tiny muted' }, ` ${reasonKo(r.result.reason)} ${fmtSec(r.result.durationSec)}`)),
          h('td', { class: 'num' }, `+${r.bonusEarned}`),
          h('td', { class: 'small' }, r.choicesTaken.map((ct) => `${ct.title}${ct.success === true ? ' ✓' : ct.success === false ? ' ✗' : ''}`).join(', ')),
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

// ───────────────────────── 9. 완성팀 대전 ─────────────────────────

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
        const power = t.members.reduce((acc, c) => acc + safePower(c), 0);
        return h('label', { class: `pick-row ${checked ? 'checked' : ''}` },
          h('input', { type: 'radio', name: `pick-${side}`, checked, onchange: () => { if (side === 'A') pvp.aId = t.id; else pvp.bId = t.id; render(); } }),
          h('span', { class: 'name' }, t.name),
          h('span', { class: 'muted small' }, t.members.map((c) => JOB_NAME_KO[c.mainJob]).join('/')),
          h('span', { class: 'muted small' }, `전투력 ${power}`),
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
    const b = dedupeTeamIds(a, b0);
    pvp.seed = parseSeed(seedInput.value);
    pvp.map = mapSel.value as MapType;
    startBattle({ seed: pvp.seed, map: pvp.map, teamA: a, teamB: b }, 'pvp');
  };

  return h(
    'div',
    { class: 'screen' },
    header('완성 팀 대전', '저장된 두 팀으로 전투를 재생합니다. 같은 시드·맵·팀이면 결과가 항상 같습니다.', h('button', { class: 'btn ghost small', onclick: () => { view = 'start'; render(); } }, '메인')),
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
  if (battle && battle.renderer) battle.renderer.draw(battle.frame);
});

document.addEventListener('visibilitychange', () => {
  // 탭 복귀 시 큰 dt 로 한꺼번에 진행되지 않도록 시간 기준을 리셋
  if (battle && !document.hidden) battle.lastTs = performance.now();
});

render();
