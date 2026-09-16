/**
 * 헤드리스 대량 시뮬레이션 / 밸런싱 CLI (v0.5 — 4:4, 몬스터 1~8인, 광역 예고·회피·장판).
 *
 *   npm run headless -- --games 200 --seed 1 [--map plains] [--day 5] [--json]
 *   npm run headless -- --determinism [--seed 1] [--map dark] [--day 5]
 *   npm run headless -- --growth [--policy greedy|first|random] [--seed 1] [--json]
 *   npm run headless -- --monster [--runs 60] [--seed 1] [--json]
 *   npm run headless -- --rarity  [--runs 60] [--seed 1] [--json]
 *   npm run headless -- --dodge   [--trials 400] [--skill mage_blast] [--telegraph 0.8] [--radius 2.5] [--move 50] [--json]
 *
 * 외부 의존성 없음. 난수는 전부 시드에서 파생한다 (Math.random / Date 금지).
 * DOM 을 쓰지 않으므로 node(tsx) 에서 그대로 실행된다.
 *
 * 팀 인원은 숫자로 박지 않는다. 플레이어·상대·검증팀은 TEAM_SIZE, 몬스터는 MONSTER_TEAM_MIN~MAX.
 *
 * 육성 상태 머신(run.ts)·선택지(choices.ts) 는 이름이 조금씩 달라도 동작하도록
 * 아래 "모듈 어댑터" 에서 후보 이름을 순서대로 찾아 연결한다. 찾지 못하면
 * 어떤 이름을 시도했는지 한국어로 알려준다.
 */

import {
  BASE_STAT_KEYS,
  MAIN_JOBS,
  MAP_TYPES,
  STAT_MAX,
  JOB_NAME_KO,
  MAP_NAME_KO,
  TEAM_SIZE,
  MONSTER_TEAM_MIN,
  MONSTER_TEAM_MAX,
  TICK_RATE,
  TICK_DT,
  DEFAULT_TELEGRAPH_SEC,
  SHORT_TELEGRAPH_SEC,
  TOTAL_DAYS,
  STEPS_PER_DAY,
  CHOICE_STEPS,
  MONSTER_STEP,
  BATTLE_STEP,
  SUBJOB_DAY_MIN,
  SUBJOB_DAY_MAX,
  MONSTER_TIER_ORDER,
  MONSTER_TIER_NAME_KO,
  CHOICE_RARITY_ORDER,
  CHOICE_RARITY_NAME_KO,
  CHOICE_RARITY_RANK,
  CHOICE_KIND_NAME_KO,
  STEP_KIND_NAME_KO,
  stepKindOf,
  type Adaptation,
  type BaseStatKey,
  type BattleEvent,
  type BattleFrame,
  type BattleInput,
  type BattleResult,
  type Character,
  type Choice,
  type ChoiceKind,
  type ChoiceRarity,
  type MainJob,
  type MapType,
  type MonsterEncounter,
  type MonsterTier,
  type RunState,
  type SkillDef,
  type StatBlock,
  type Team,
  type TeamSide,
  type UnitSnapshot,
  type ZoneSnapshot,
} from '../src/core/types';
import { Rng, hashSeed } from '../src/core/rng';
import * as simModule from '../src/core/battle/sim';
import { createBattle } from '../src/core/battle/sim';
import { generateOpponentTeam } from '../src/core/gen/charGen';
import { computeDerived, powerRating, statTotal } from '../src/core/stats';
import { SKILLS, skillPoolFor } from '../src/core/data/skills';
import { JOBS } from '../src/core/data/jobs';

// ───────────────────────── 모듈 어댑터 ─────────────────────────
//
// run.ts / choices.ts 는 재설계와 함께 다시 쓰이는 중이라 함수 이름이 확정되지
// 않았다. 이 도구는 후보 이름을 순서대로 찾아 붙인다. 타입 계약(types.ts)만 지키면
// 이름이 달라도 CLI 는 그대로 동작한다.
// 또한 육성 모듈은 육성 모드에서만 동적으로 불러온다. 전투 전용 모드(--games /
// --determinism / --dodge)는 육성 모듈이 깨져 있어도 그대로 돌아간다.

type AnyFn = (...args: unknown[]) => unknown;

let runApi: Record<string, unknown> = {};
let choiceApi: Record<string, unknown> = {};

/** 육성 모드 진입 시 1회 호출. run.ts / choices.ts 를 동적으로 불러온다. */
async function loadGrowthModules(): Promise<void> {
  const run = await import('../src/core/growth/run');
  const choices = await import('../src/core/growth/choices');
  runApi = run as unknown as Record<string, unknown>;
  choiceApi = choices as unknown as Record<string, unknown>;
}

function lookup(mod: Record<string, unknown>, names: readonly string[]): AnyFn | null {
  for (const n of names) {
    const v = mod[n];
    if (typeof v === 'function') return v as AnyFn;
  }
  return null;
}

function require_(mod: Record<string, unknown>, names: readonly string[], label: string): AnyFn {
  const f = lookup(mod, names);
  if (f) return f;
  throw new Error(`${label} 을(를) 찾을 수 없습니다. 시도한 이름: ${names.join(', ')}`);
}

const NAMES = {
  newRun: ['newRun', 'createRun', 'startRun'],
  selectTeam: ['selectTeam', 'chooseTeam', 'pickTeam'],
  ensureChoices: ['ensureChoices'],
  pickChoice: ['pickChoice', 'chooseChoice', 'selectChoice', 'applyPick'],
  pickMonster: ['pickMonster', 'selectMonster', 'chooseMonster', 'pickMonsterOption', 'selectMonsterEncounter'],
  startMonsterBattle: ['startMonsterBattle'],
  monsterBattleInput: ['monsterBattleInput', 'monsterInput', 'battleInputMonster', 'monsterBattleInputOf'],
  finishMonsterBattle: ['finishMonsterBattle', 'finishMonster', 'resolveMonsterBattle', 'endMonsterBattle'],
  startBattle: ['startBattle'],
  battleInput: ['battleInput', 'teamBattleInput', 'currentBattleInput'],
  finishBattle: ['finishBattle', 'resolveBattle', 'endBattle'],
  buySkill: ['buySkill'],
  trainStat: ['trainStat', 'trainBaseStat', 'buyStat'],
  finishDay: ['finishDay', 'endDay', 'closeDay', 'finishDayEnd', 'nextDay', 'advanceDay', 'finishBonus'],
  generateChoices: ['generateChoices', 'makeChoices', 'buildChoices'],
  estimatePowerDelta: ['estimatePowerDelta'],
} as const;

function apiNewRun(seed: number): RunState {
  return require_(runApi, NAMES.newRun, '새 육성 시작 함수')(seed) as RunState;
}

function apiSelectTeam(state: RunState, charIds: string[], teamName: string): void {
  require_(runApi, NAMES.selectTeam, '팀 선택 함수')(state, charIds, teamName);
}

function apiEnsureChoices(state: RunState): void {
  const f = lookup(runApi, NAMES.ensureChoices);
  if (f) f(state);
}

function apiPickChoice(state: RunState, index: number): { success: boolean | null } {
  const r = require_(runApi, NAMES.pickChoice, '선택지 선택 함수')(state, index);
  if (r && typeof r === 'object' && 'success' in (r as Record<string, unknown>)) {
    return r as { success: boolean | null };
  }
  return { success: null };
}

/** 몬스터 난이도 선택. 인덱스로 먼저 시도하고, 거부되면 tier 문자열로 다시 시도한다. */
function apiPickMonster(state: RunState, index: number, tier: MonsterTier): void {
  const f = require_(runApi, NAMES.pickMonster, '몬스터 난이도 선택 함수');
  try {
    f(state, index);
  } catch {
    f(state, tier);
  }
}

function apiMonsterBattleInput(state: RunState): BattleInput {
  const start = lookup(runApi, NAMES.startMonsterBattle);
  if (start) {
    try {
      const r = start(state);
      if (isBattleInput(r)) return r;
    } catch {
      /* 이미 관전 단계라 거절될 수 있다. 아래 경로로 계속 */
    }
  }
  const f = lookup(runApi, NAMES.monsterBattleInput);
  if (f) {
    const r = f(state);
    if (isBattleInput(r)) return r;
  }
  // 폴백: 상태에서 직접 조립한다 (몬스터 팀은 B 측)
  const enc = state.currentMonster;
  const team = state.team;
  if (!enc || !team) throw new Error('몬스터 전투 입력을 만들 수 없습니다 (currentMonster / team 없음).');
  return {
    seed: hashSeed(`${state.seed}:${state.day}:monster`),
    map: enc.map,
    teamA: team,
    teamB: enc.team,
  };
}

function apiFinishMonsterBattle(state: RunState, result: BattleResult): void {
  require_(runApi, NAMES.finishMonsterBattle, '몬스터 전투 종료 함수')(state, result);
}

function apiBattleInput(state: RunState): BattleInput {
  if (state.phase === 'pre_battle') {
    const start = lookup(runApi, NAMES.startBattle);
    if (start) {
      try {
        const r = start(state);
        if (isBattleInput(r)) return r;
      } catch {
        /* 관전 시작을 거절하면 입력만 다시 얻는다 */
      }
    }
  }
  const r = require_(runApi, NAMES.battleInput, '4:4 전투 입력 함수')(state);
  if (!isBattleInput(r)) throw new Error('전투 입력 함수가 BattleInput 을 돌려주지 않았습니다.');
  return r;
}

function apiFinishBattle(state: RunState, result: BattleResult): void {
  require_(runApi, NAMES.finishBattle, '4:4 전투 종료 함수')(state, result);
}

function apiBuySkill(state: RunState, charId: string, skillId: string): boolean {
  const f = lookup(runApi, NAMES.buySkill);
  if (!f) return false;
  return f(state, charId, skillId) === true;
}

/** 스탯 훈련 (run.ts 가 제공하지 않으면 false) */
function apiTrainStat(state: RunState, charId: string, stat: BaseStatKey): boolean {
  const f = lookup(runApi, NAMES.trainStat);
  if (!f) return false;
  return f(state, charId, stat) === true;
}

function apiFinishDay(state: RunState): void {
  require_(runApi, NAMES.finishDay, '하루 마무리 종료 함수')(state);
}

function apiGenerateChoices(state: RunState, rng: Rng): Choice[] | null {
  const f = lookup(runApi, NAMES.generateChoices) ?? lookup(choiceApi, NAMES.generateChoices);
  if (!f) return null;
  const r = f(state, rng);
  return Array.isArray(r) ? (r as Choice[]) : null;
}

/** estimatePowerDelta 가 있으면 그것을, 없으면 카드에 박힌 powerDelta 를 쓴다. */
function powerDeltaOf(team: Team | null, ch: Choice): number {
  const f = lookup(choiceApi, NAMES.estimatePowerDelta);
  if (f && team) {
    const v = f(team, ch);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return Number.isFinite(ch.powerDelta) ? ch.powerDelta : 0;
}

function isBattleInput(v: unknown): v is BattleInput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.seed === 'number' && typeof o.map === 'string' && !!o.teamA && !!o.teamB;
}

// ───────────────────────── 인자 파싱 ─────────────────────────

type PolicyName = 'greedy' | 'first' | 'random';
const POLICIES: readonly PolicyName[] = ['greedy', 'first', 'random'];
const POLICY_NAME_KO: Record<PolicyName, string> = {
  greedy: '탐욕 (전투력 최대)',
  first: '첫 카드 고정',
  random: '무작위',
};

/** --dodge 기본 시험 스킬: 반경 2.5, 사거리 7, 예고 기본값 0.8초인 마법사 광역 */
const DEFAULT_DODGE_SKILL = 'mage_blast';
const DEFAULT_DODGE_TRIALS = 400;
const DEFAULT_DODGE_MOVE = 50;

interface CliOptions {
  games: number;
  seed: number;
  map: MapType | 'random';
  day: number;
  runs: number;
  policy: PolicyName;
  determinism: boolean;
  growth: boolean;
  monster: boolean;
  rarity: boolean;
  dodge: boolean;
  /** --dodge: 유닛당 판정 횟수 */
  trials: number;
  /** --dodge: 시험 광역 스킬 id */
  skill: string;
  /** --dodge: 예고 시간 덮어쓰기 (null 이면 스킬 정의/기본값) */
  telegraph: number | null;
  /** --dodge: 반경 덮어쓰기 (null 이면 스킬 정의) */
  radius: number | null;
  /** --dodge: 두 시험 유닛의 이동속도 스탯 */
  move: number;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    games: 100,
    seed: 1,
    map: 'random',
    day: 5,
    runs: 60,
    policy: 'greedy',
    determinism: false,
    growth: false,
    monster: false,
    rarity: false,
    dodge: false,
    trials: DEFAULT_DODGE_TRIALS,
    skill: DEFAULT_DODGE_SKILL,
    telegraph: null,
    radius: null,
    move: DEFAULT_DODGE_MOVE,
    json: false,
    help: false,
  };
  const takeValue = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new Error(`옵션 ${name} 에 값이 필요합니다.`);
    }
    return v;
  };
  const parseIntStrict = (raw: string, name: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new Error(`옵션 ${name} 값이 정수가 아닙니다: ${raw}`);
    }
    return n;
  };
  const parseNumStrict = (raw: string, name: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new Error(`옵션 ${name} 값이 숫자가 아닙니다: ${raw}`);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // --key=value 형태도 허용
    let key = a;
    let inlineValue: string | null = null;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) {
      key = a.slice(0, eq);
      inlineValue = a.slice(eq + 1);
    }
    const value = (name: string): string => {
      if (inlineValue !== null) return inlineValue;
      const v = takeValue(i, name);
      i++;
      return v;
    };
    switch (key) {
      case '--games':
        opts.games = Math.max(1, parseIntStrict(value(key), key));
        break;
      case '--seed':
        opts.seed = parseIntStrict(value(key), key) >>> 0;
        break;
      case '--map': {
        const m = value(key);
        if (m !== 'random' && !(MAP_TYPES as readonly string[]).includes(m)) {
          throw new Error(`알 수 없는 맵: ${m} (plains|dark|desert|glacier|random)`);
        }
        opts.map = m as MapType | 'random';
        break;
      }
      case '--day':
      case '--cycle': // v0.3 호환 별칭
        opts.day = Math.min(TOTAL_DAYS, Math.max(1, parseIntStrict(value(key), key)));
        break;
      case '--runs':
        opts.runs = Math.max(1, parseIntStrict(value(key), key));
        break;
      case '--policy': {
        const p = value(key);
        if (!(POLICIES as readonly string[]).includes(p)) {
          throw new Error(`알 수 없는 정책: ${p} (greedy|first|random)`);
        }
        opts.policy = p as PolicyName;
        break;
      }
      case '--trials':
        opts.trials = Math.max(1, parseIntStrict(value(key), key));
        break;
      case '--skill': {
        const s = value(key);
        if (!SKILLS[s]) throw new Error(`알 수 없는 스킬 id: ${s}`);
        opts.skill = s;
        break;
      }
      case '--telegraph':
        opts.telegraph = Math.max(0, parseNumStrict(value(key), key));
        break;
      case '--radius':
        opts.radius = Math.max(0.1, parseNumStrict(value(key), key));
        break;
      case '--move':
        opts.move = Math.min(STAT_MAX, Math.max(1, parseIntStrict(value(key), key)));
        break;
      case '--determinism':
        opts.determinism = true;
        break;
      case '--growth':
        opts.growth = true;
        break;
      case '--monster':
        opts.monster = true;
        break;
      case '--rarity':
        opts.rarity = true;
        break;
      case '--dodge':
        opts.dodge = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`알 수 없는 옵션: ${a} (--help 참고)`);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(
    [
      `헤드리스 전투 / 육성 시뮬레이션 CLI (10일 × 5스텝, ${TEAM_SIZE}:${TEAM_SIZE} 전투, 몬스터 ${MONSTER_TEAM_MIN}~${MONSTER_TEAM_MAX}인)`,
      '',
      '사용법: npm run headless -- [옵션]',
      '',
      '  --games N        시뮬레이션 판 수 (기본 100, 기본 모드). 광역·회피 통계도 함께 집계',
      '  --seed S         루트 시드 (기본 1)',
      '  --map M          plains | dark | desert | glacier | random (기본 random)',
      '  --day D          양 팀을 생성할 육성 일차 1~10 (기본 5). --cycle 은 같은 뜻의 옛 이름',
      '  --runs N         --monster / --rarity 의 표본 육성 수 (기본 60)',
      '  --policy P       육성 자동 정책 greedy | first | random (기본 greedy)',
      '  --determinism    같은 입력으로 전투를 두 번 돌려 틱별 프레임 해시(영역 포함)를 비교',
      '  --growth         10일 × 5스텝 육성을 헤드리스로 진행하고 분화 보장을 검증',
      '  --monster        일차별로 하급/중급/고급을 모두 싸워 승률표를 뽑는다 (난이도·인원 보정용)',
      '  --rarity         선택지 등급 분포와 등급별 예상 전투력 상승치를 집계',
      '  --dodge          광역 예고 회피율 측정 (판단력 80·민첩 70 vs 판단력 30·민첩 30)',
      `  --trials N       --dodge 유닛당 판정 횟수 (기본 ${DEFAULT_DODGE_TRIALS})`,
      `  --skill ID       --dodge 시험 광역 스킬 id (기본 ${DEFAULT_DODGE_SKILL})`,
      '  --telegraph T    --dodge 예고 시간(초) 덮어쓰기 (기본: 스킬 정의 또는 기본 규칙)',
      '  --radius R       --dodge 영역 반경 덮어쓰기 (기본: 스킬 정의)',
      `  --move M         --dodge 시험 유닛 이동속도 스탯 (기본 ${DEFAULT_DODGE_MOVE})`,
      '  --json           요약을 JSON 으로 출력',
      '  --help           이 도움말',
      '',
      `  하루 구성: ${DAY_STEP_LABEL}`,
    ].join('\n'),
  );
}

const DAY_STEP_LABEL = (() => {
  const parts: string[] = [];
  for (let s = 1; s <= STEPS_PER_DAY; s++) parts.push(`${s}${STEP_KIND_NAME_KO[stepKindOf(s)]}`);
  return parts.join(' · ');
})();

/** 화면·표에 쓰는 '4:4' 표기. 인원 상수에서 만든다 */
const VS_LABEL = `${TEAM_SIZE}:${TEAM_SIZE}`;

// ───────────────────────── 출력 유틸 ─────────────────────────

/** 터미널 표시 폭 (한글 등 동아시아 전각 문자는 2칸) */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff);
    w += wide ? 2 : 1;
  }
  return w;
}

function padRight(s: string, width: number): string {
  const d = displayWidth(s);
  return d >= width ? s : s + ' '.repeat(width - d);
}

function padLeft(s: string, width: number): string {
  const d = displayWidth(s);
  return d >= width ? s : ' '.repeat(width - d) + s;
}

type Align = 'l' | 'r';

/** 간단한 표 출력. 첫 행은 헤더. */
function printTable(headers: string[], rows: string[][], aligns: Align[]): void {
  const widths = headers.map((h, i) => {
    let w = displayWidth(h);
    for (const r of rows) w = Math.max(w, displayWidth(r[i] ?? ''));
    return w;
  });
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => {
        if (aligns[i] === 'r') return padLeft(c, widths[i]);
        // 마지막 열은 오른쪽 공백을 남기지 않는다
        return i === cells.length - 1 ? c : padRight(c, widths[i]);
      })
      .join('  ');
  console.log(fmt(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(fmt(r));
}

function pct(n: number, d: number): string {
  if (d <= 0) return '-';
  return ((n / d) * 100).toFixed(1) + '%';
}

function pctOf(ratio: number): string {
  return Number.isFinite(ratio) ? (ratio * 100).toFixed(1) + '%' : '-';
}

function fixed(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '-';
}

function section(title: string): void {
  console.log('');
  console.log(`== ${title} ==`);
}

function progress(label: string, done: number, total: number, enabled: boolean): void {
  if (!enabled) return;
  process.stderr.write(`\r${label} ${done}/${total}`);
  if (done >= total) process.stderr.write('\n');
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ───────────────────────── 프레임 해시 ─────────────────────────

/** 프레임 전체(유닛·이벤트·영역·거점)를 직렬화해 FNV-1a 32비트 해시. 결정론 검증용. */
function hashFrame(frame: BattleFrame): number {
  const payload = JSON.stringify({
    tick: frame.tick,
    timeSec: frame.timeSec,
    units: frame.units,
    events: frame.events,
    zones: frame.zones ?? [],
    capture: frame.capture,
    finished: frame.finished,
  });
  return hashSeed(payload);
}

// ───────────────────────── 광역 영역(Zone) 기하 ─────────────────────────

/** 시전자 쪽이 아닌, 피해를 받는 쪽인지 */
function isEnemyOf(side: TeamSide, unit: UnitSnapshot): boolean {
  return unit.side !== side;
}

/** 예고 시작 시점에 회피 판정을 받을 수 없는 상태 (GDD §4.4: 기절·빙결·도발) */
function cannotDodge(unit: UnitSnapshot): boolean {
  for (const st of unit.statuses) {
    if (st.kind === 'stun' || st.kind === 'freeze' || st.kind === 'taunt') return true;
  }
  return false;
}

/** 스킬 정의를 찾는다. 없으면 null (몬스터 전용 스킬도 SKILLS 에 있다) */
function skillDefOf(id: string): SkillDef | null {
  const def = SKILLS[id];
  return def ?? null;
}

/**
 * line 영역의 절반 폭. 스킬 정의의 radius 가 '폭' 이고 sim 은 선분과의 수직 거리 ≤ radius 로 판정하므로
 * 그 값을 그대로 쓴다. 스킬을 모르면 스냅샷의 width 를 전체 폭으로 보고 절반을 쓴다.
 */
function lineHalfWidth(z: ZoneSnapshot, def: SkillDef | null): number {
  if (def && def.radius !== undefined && def.radius > 0) return def.radius;
  if (z.width !== undefined && z.width > 0) return z.width / 2;
  return 0.5;
}

function insideZone(z: ZoneSnapshot, def: SkillDef | null, x: number, y: number): boolean {
  if (z.shape === 'circle') {
    const dx = x - z.x;
    const dy = y - z.y;
    return dx * dx + dy * dy <= z.radius * z.radius + 1e-9;
  }
  // line: (x,y)→(x2,y2) 선분과의 수직 거리
  const x2 = z.x2 ?? z.x;
  const y2 = z.y2 ?? z.y;
  const half = lineHalfWidth(z, def);
  const vx = x2 - z.x;
  const vy = y2 - z.y;
  const len2 = vx * vx + vy * vy;
  let t = 0;
  if (len2 > 0) {
    t = ((x - z.x) * vx + (y - z.y) * vy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const px = z.x + vx * t;
  const py = z.y + vy * t;
  const dx = x - px;
  const dy = y - py;
  return dx * dx + dy * dy <= half * half + 1e-9;
}

/** 적에게 피해를 주는 광역(enemy_area / line + damage 효과)인지. 이 영역만 회피 통계에 넣는다 */
function isDamageAoe(def: SkillDef | null): boolean {
  if (!def) return false;
  if (def.target !== 'enemy_area' && def.target !== 'line') return false;
  for (const e of def.effects) if (e.kind === 'damage') return true;
  return def.linger !== undefined && def.linger.dpsCoef > 0;
}

/** 한 판에서 모은 광역·회피 통계 */
interface ZoneStats {
  /** 'zone' 이벤트 수 (예고 시작) */
  zoneEvents: number;
  /** 프레임에 새로 나타난 피해 광역 영역 수 */
  damageZones: number;
  /** 예고 시작 시 영역 안에 있던, 회피 판정을 받을 수 있는 적 유닛 수 (= 회피 판정 횟수 추정) */
  dodgeAttempts: number;
  /** 'dodge' 이벤트 수 (회피 성공 = 인지) */
  dodgeEvents: number;
  /** 예고 시작 시 영역 안에 있었고 impact 때 살아 있던 적 유닛 수 */
  impactExposed: number;
  /** 그중 impact 시점에 영역 밖으로 벗어나 피해를 받지 않은 수 (회피 이동이든 일반 이동이든) */
  impactAvoided: number;
  /** 그중 예고 시작 틱에 그 스킬의 dodge 이벤트를 받았고(인지) impact 때 영역 밖이었던 수 = 회피 이동으로 벗어남 */
  dodgedEscaped: number;
  /** 인지(dodge 이벤트)했지만 impact 때 아직 영역 안이라 맞은 수 (이동속도 부족, 탈출점이 다른 영역 안, 밀림 등) */
  dodgedHit: number;
}

function emptyZoneStats(): ZoneStats {
  return { zoneEvents: 0, damageZones: 0, dodgeAttempts: 0, dodgeEvents: 0, impactExposed: 0, impactAvoided: 0, dodgedEscaped: 0, dodgedHit: 0 };
}

function addZoneStats(into: ZoneStats, s: ZoneStats): void {
  into.zoneEvents += s.zoneEvents;
  into.damageZones += s.damageZones;
  into.dodgeAttempts += s.dodgeAttempts;
  into.dodgeEvents += s.dodgeEvents;
  into.impactExposed += s.impactExposed;
  into.impactAvoided += s.impactAvoided;
  into.dodgedEscaped += s.dodgedEscaped;
  into.dodgedHit += s.dodgedHit;
}

interface TrackedZone {
  snapshot: ZoneSnapshot;
  def: SkillDef | null;
  /** 예고 시작 시 영역 안에 있던 적 유닛 id (배열 순서 = 프레임 순서) */
  insideAtStart: string[];
  /** 그중 예고 시작 틱에 이 스킬의 dodge 이벤트를 받은 유닛 id (인지) */
  dodged: Set<string>;
}

interface TrackedBattle {
  result: BattleResult;
  zones: ZoneStats;
}

/**
 * 전투를 틱 단위로 진행하며 광역 영역의 예고 시작/impact 를 프레임에서 추적한다.
 * 결과(BattleResult)는 runToEnd() 와 완전히 같다 (같은 step 을 같은 순서로 부른다).
 *  - zoneFilter: 어떤 영역을 회피 통계에 넣을지 (기본: 피해 광역 전부)
 *  - unitFilter: 어떤 적 유닛을 셀지 (기본: 전부)
 */
function runBattleTracked(
  input: BattleInput,
  zoneFilter?: (z: ZoneSnapshot, def: SkillDef | null) => boolean,
  unitFilter?: (u: UnitSnapshot) => boolean,
): TrackedBattle {
  const sim = createBattle(input);
  const stats = emptyZoneStats();
  const tracked = new Map<string, TrackedZone>();
  let prevIds = new Set<string>();
  const maxTicks = 1_000_000;
  let ticks = 0;

  while (!sim.finished && ticks < maxTicks) {
    const f = sim.step();
    ticks++;
    const zones = f.zones ?? [];
    const ids = new Set<string>();

    // 1) 이번 틱에 새로 나타난 영역: 예고 중이면 안에 있는 적 유닛을 기록한다
    for (const z of zones) {
      ids.add(z.id);
      if (prevIds.has(z.id)) continue;
      const def = skillDefOf(z.skillId);
      if (!isDamageAoe(def)) continue;
      if (zoneFilter && !zoneFilter(z, def)) continue;
      stats.damageZones++;
      if (z.phase !== 'telegraph') continue; // 예고 없는 스킬은 회피 판정이 없다
      const inside: string[] = [];
      for (const u of f.units) {
        if (!u.alive || !isEnemyOf(z.side, u)) continue;
        if (unitFilter && !unitFilter(u)) continue;
        if (!insideZone(z, def, u.x, u.y)) continue;
        inside.push(u.id);
        if (!cannotDodge(u)) stats.dodgeAttempts++;
      }
      // 같은 틱의 dodge 이벤트(같은 스킬 id, 영역 안 유닛)를 이 영역의 '인지' 로 본다.
      // (같은 틱에 같은 스킬의 영역이 둘 생기면 구분할 수 없어 둘 다에 센다 — 드물다)
      const dodged = new Set<string>();
      for (const ev of f.events) {
        if (ev.kind === 'dodge' && ev.skillId === z.skillId && inside.indexOf(ev.unit) >= 0) dodged.add(ev.unit);
      }
      tracked.set(z.id, { snapshot: z, def, insideAtStart: inside, dodged });
    }

    // 2) 예고가 끝난(phase 변경 또는 소멸) 영역: 시작 시 안에 있던 유닛이 아직 안에 있는지 본다
    if (tracked.size > 0) {
      const byId = new Map<string, ZoneSnapshot>();
      for (const z of zones) byId.set(z.id, z);
      const done: string[] = [];
      for (const [id, tz] of tracked) {
        const cur = byId.get(id);
        if (cur && cur.phase === 'telegraph') continue;
        const shape = cur ?? tz.snapshot;
        for (const uid of tz.insideAtStart) {
          let unit: UnitSnapshot | null = null;
          for (const u of f.units) {
            if (u.id === uid) {
              unit = u;
              break;
            }
          }
          if (!unit || !unit.alive) continue; // impact 전에 죽은 유닛은 회피와 무관
          stats.impactExposed++;
          const outside = !insideZone(shape, tz.def, unit.x, unit.y);
          if (outside) stats.impactAvoided++;
          if (tz.dodged.has(uid)) {
            if (outside) stats.dodgedEscaped++;
            else stats.dodgedHit++;
          }
        }
        done.push(id);
      }
      for (const id of done) tracked.delete(id);
    }

    prevIds = ids;
  }

  const result = sim.result();
  if (!result) throw new Error('전투가 끝나지 않았습니다 (틱 상한 초과).');
  for (const ev of result.events) {
    if (ev.kind === 'zone') stats.zoneEvents++;
    else if (ev.kind === 'dodge') {
      if (unitFilter) {
        // unitFilter 는 스냅샷 기준이라 id 만으로 걸러야 한다: 마지막 프레임의 유닛에서 찾는다
        const snap = sim.currentFrame().units.find((u) => u.id === ev.unit);
        if (snap && !unitFilter(snap)) continue;
      }
      stats.dodgeEvents++;
    }
  }
  return { result, zones: stats };
}

// ───────────────────────── 전투 입력 생성 ─────────────────────────

function pickMap(rootSeed: number, gameIndex: number, opt: MapType | 'random'): MapType {
  if (opt !== 'random') return opt;
  const rng = new Rng(hashSeed(`${rootSeed}:${gameIndex}:map`));
  return rng.pick(MAP_TYPES);
}

function buildInput(rootSeed: number, gameIndex: number, opts: CliOptions): BattleInput {
  const map = pickMap(rootSeed, gameIndex, opts.map);
  const rngA = new Rng(hashSeed(`${rootSeed}:${gameIndex}:A`));
  const rngB = new Rng(hashSeed(`${rootSeed}:${gameIndex}:B`));
  const teamA = generateOpponentTeam(rngA, opts.day, map, `g${gameIndex}a`);
  const teamB = generateOpponentTeam(rngB, opts.day, map, `g${gameIndex}b`);
  return {
    seed: hashSeed(`${rootSeed}:${gameIndex}:battle`),
    map,
    teamA,
    teamB,
  };
}

// ───────────────────────── 대량 시뮬레이션 ─────────────────────────

/** 4:4 전투 목표 평균 시간 (GDD §11 보정 목표) */
const PVP_DURATION_MIN_SEC = 60;
const PVP_DURATION_MAX_SEC = 120;

interface JobAgg {
  appearances: number;
  wins: number;
  draws: number;
  damage: number;
  healing: number;
  kills: number;
  survived: number;
  skillsUsed: number;
}

interface ZoneSummary {
  /** 판당 평균 */
  zonesPerGame: number;
  damageZonesPerGame: number;
  dodgeAttemptsPerGame: number;
  dodgeSuccessPerGame: number;
  /** 회피 성공(dodge 이벤트) / 회피 판정 */
  dodgeSuccessRate: number;
  /** impact 때 영역 밖에 있던 비율 = 광역 피해 회피 비율 */
  aoeDamageAvoidedShare: number;
  /** 회피 이동으로 벗어난 비율 (dodge 이벤트 + impact 때 영역 밖) / 노출 */
  dodgedEscapedShare: number;
  totals: ZoneStats;
}

interface BatchSummary {
  mode: 'batch';
  games: number;
  seed: number;
  day: number;
  teamSize: number;
  mapOption: string;
  winsA: number;
  winsB: number;
  draws: number;
  avgDurationSec: number;
  durationTarget: { min: number; max: number; ok: boolean };
  perMap: Record<MapType, { games: number; winsA: number; winsB: number; draws: number; avgDurationSec: number }>;
  perJob: Record<MainJob, JobAgg & { winRate: number; avgDamage: number; avgHealing: number; survivalRate: number }>;
  topSkills: { skillId: string; name: string; uses: number }[];
  reasons: Record<string, number>;
  zones: ZoneSummary;
}

function emptyJobAgg(): JobAgg {
  return { appearances: 0, wins: 0, draws: 0, damage: 0, healing: 0, kills: 0, survived: 0, skillsUsed: 0 };
}

function skillName(id: string): string {
  const def = SKILLS[id];
  return def ? def.name : id;
}

function zoneSummaryOf(totals: ZoneStats, games: number): ZoneSummary {
  const per = (n: number): number => (games > 0 ? n / games : 0);
  return {
    zonesPerGame: per(totals.zoneEvents),
    damageZonesPerGame: per(totals.damageZones),
    dodgeAttemptsPerGame: per(totals.dodgeAttempts),
    dodgeSuccessPerGame: per(totals.dodgeEvents),
    dodgeSuccessRate: totals.dodgeAttempts > 0 ? totals.dodgeEvents / totals.dodgeAttempts : 0,
    aoeDamageAvoidedShare: totals.impactExposed > 0 ? totals.impactAvoided / totals.impactExposed : 0,
    dodgedEscapedShare: totals.impactExposed > 0 ? totals.dodgedEscaped / totals.impactExposed : 0,
    totals,
  };
}

function runBatch(opts: CliOptions): BatchSummary {
  const perJob = {} as Record<MainJob, JobAgg>;
  for (const j of MAIN_JOBS) perJob[j] = emptyJobAgg();
  const perMap = {} as BatchSummary['perMap'];
  for (const m of MAP_TYPES) perMap[m] = { games: 0, winsA: 0, winsB: 0, draws: 0, avgDurationSec: 0 };
  const mapDuration = {} as Record<MapType, number>;
  for (const m of MAP_TYPES) mapDuration[m] = 0;

  const skillUses = new Map<string, number>();
  const reasons: Record<string, number> = {};
  const zoneTotals = emptyZoneStats();
  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  let durationSum = 0;

  const showProgress = opts.games >= 20 && !opts.json;
  const progressEvery = Math.max(1, Math.floor(opts.games / 10));

  for (let g = 0; g < opts.games; g++) {
    const input = buildInput(opts.seed, g, opts);
    const tracked = runBattleTracked(input);
    const result: BattleResult = tracked.result;
    addZoneStats(zoneTotals, tracked.zones);

    // 승패 집계
    if (result.winner === 'A') winsA++;
    else if (result.winner === 'B') winsB++;
    else draws++;
    durationSum += result.durationSec;
    reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;

    const pm = perMap[input.map];
    pm.games++;
    if (result.winner === 'A') pm.winsA++;
    else if (result.winner === 'B') pm.winsB++;
    else pm.draws++;
    mapDuration[input.map] += result.durationSec;

    // 유닛 id → (직업, 진영). 소환물은 ownerId 로 소환사에 귀속.
    const memberInfo = new Map<string, { job: MainJob; side: TeamSide }>();
    const register = (team: Team, side: TeamSide): void => {
      for (const c of team.members) memberInfo.set(c.id, { job: c.mainJob, side });
    };
    register(input.teamA, 'A');
    register(input.teamB, 'B');

    // 등장/승리/생존은 캐릭터 기준
    const countTeam = (team: Team, side: TeamSide): void => {
      for (const c of team.members) {
        const agg = perJob[c.mainJob];
        agg.appearances++;
        if (result.winner === side) agg.wins++;
        else if (result.winner === 'draw') agg.draws++;
      }
    };
    countTeam(input.teamA, 'A');
    countTeam(input.teamB, 'B');

    // 소환물 → 소환사 매핑 (스냅샷에서 ownerId 를 얻을 수 없으므로 이벤트로 추적)
    const summonOwner = new Map<string, string>();
    for (const ev of result.events) {
      if (ev.kind === 'summon') summonOwner.set(ev.unitId, ev.owner);
    }

    for (const us of result.unitStats) {
      const info = memberInfo.get(us.id);
      if (info) {
        const agg = perJob[info.job];
        agg.damage += us.damageDealt;
        agg.healing += us.healingDone;
        agg.kills += us.kills;
        agg.skillsUsed += us.skillsUsed;
        if (us.survived) agg.survived++;
        continue;
      }
      // 소환물: 피해/킬만 소환사 직업에 합산
      const owner = summonOwner.get(us.id);
      const ownerInfo = owner ? memberInfo.get(owner) : undefined;
      if (ownerInfo) {
        const agg = perJob[ownerInfo.job];
        agg.damage += us.damageDealt;
        agg.healing += us.healingDone;
        agg.kills += us.kills;
      }
    }

    for (const ev of result.events) {
      if (ev.kind === 'skill') skillUses.set(ev.skillId, (skillUses.get(ev.skillId) ?? 0) + 1);
    }

    if (showProgress && ((g + 1) % progressEvery === 0 || g + 1 === opts.games)) {
      progress('진행', g + 1, opts.games, true);
    }
  }

  for (const m of MAP_TYPES) {
    perMap[m].avgDurationSec = perMap[m].games > 0 ? mapDuration[m] / perMap[m].games : 0;
  }

  const perJobOut = {} as BatchSummary['perJob'];
  for (const j of MAIN_JOBS) {
    const a = perJob[j];
    perJobOut[j] = {
      ...a,
      winRate: a.appearances > 0 ? a.wins / a.appearances : 0,
      avgDamage: a.appearances > 0 ? a.damage / a.appearances : 0,
      avgHealing: a.appearances > 0 ? a.healing / a.appearances : 0,
      survivalRate: a.appearances > 0 ? a.survived / a.appearances : 0,
    };
  }

  const topSkills = [...skillUses.entries()]
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .slice(0, 10)
    .map(([skillId, uses]) => ({ skillId, name: skillName(skillId), uses }));

  const avgDurationSec = opts.games > 0 ? durationSum / opts.games : 0;

  return {
    mode: 'batch',
    games: opts.games,
    seed: opts.seed,
    day: opts.day,
    teamSize: TEAM_SIZE,
    mapOption: opts.map,
    winsA,
    winsB,
    draws,
    avgDurationSec,
    durationTarget: {
      min: PVP_DURATION_MIN_SEC,
      max: PVP_DURATION_MAX_SEC,
      ok: avgDurationSec >= PVP_DURATION_MIN_SEC && avgDurationSec <= PVP_DURATION_MAX_SEC,
    },
    perMap,
    perJob: perJobOut,
    topSkills,
    reasons,
    zones: zoneSummaryOf(zoneTotals, opts.games),
  };
}

function printZoneSummary(z: ZoneSummary, games: number): void {
  section('광역 영역(Zone)·회피 (판당 평균)');
  printTable(
    ['항목', '판당 평균', '합계'],
    [
      ['광역 영역 생성 (zone 이벤트)', fixed(z.zonesPerGame, 2), String(z.totals.zoneEvents)],
      ['피해 광역 영역 (프레임 기준)', fixed(z.damageZonesPerGame, 2), String(z.totals.damageZones)],
      ['회피 판정 (예고 시작 시 영역 안 적 유닛)', fixed(z.dodgeAttemptsPerGame, 2), String(z.totals.dodgeAttempts)],
      ['회피 성공 (dodge 이벤트)', fixed(z.dodgeSuccessPerGame, 2), String(z.totals.dodgeEvents)],
    ],
    ['l', 'r', 'r'],
  );
  console.log(
    `회피 성공률(인지) ${pctOf(z.dodgeSuccessRate)} (${z.totals.dodgeEvents}/${z.totals.dodgeAttempts})  ` +
      `광역 피해 회피 비율(impact 때 영역 밖) ${pctOf(z.aoeDamageAvoidedShare)} (${z.totals.impactAvoided}/${z.totals.impactExposed})  ` +
      `회피 이동으로 벗어남 ${pctOf(z.dodgedEscapedShare)} (${z.totals.dodgedEscaped}), 인지했지만 맞음 ${z.totals.dodgedHit}`,
  );
  if (z.totals.zoneEvents === 0 && z.totals.damageZones === 0) {
    console.log(`(${games}판 동안 광역 영역이 하나도 생성되지 않았습니다. sim 이 Zone 을 아직 만들지 않거나 광역 스킬이 쓰이지 않았습니다.)`);
  }
}

function printBatch(s: BatchSummary): void {
  const total = s.games;
  section(
    `전체 결과 (${total}판, 시드 ${s.seed}, ${s.day}일차, ${VS_LABEL}, 맵 ${s.mapOption === 'random' ? '랜덤' : MAP_NAME_KO[s.mapOption as MapType]})`,
  );
  console.log(
    `A 승 ${pct(s.winsA, total)} (${s.winsA})  B 승 ${pct(s.winsB, total)} (${s.winsB})  무승부 ${pct(s.draws, total)} (${s.draws})`,
  );
  console.log(
    `평균 전투 시간 ${fixed(s.avgDurationSec)}초 (목표 ${s.durationTarget.min}~${s.durationTarget.max}초: ${s.durationTarget.ok ? 'OK' : '조정 필요'})`,
  );

  section('맵별 A 승률');
  printTable(
    ['맵', '판수', 'A 승률', 'B 승률', '무승부', '평균 시간'],
    MAP_TYPES.map((m) => {
      const pm = s.perMap[m];
      return [
        MAP_NAME_KO[m],
        String(pm.games),
        pct(pm.winsA, pm.games),
        pct(pm.winsB, pm.games),
        pct(pm.draws, pm.games),
        pm.games > 0 ? fixed(pm.avgDurationSec) + '초' : '-',
      ];
    }),
    ['l', 'r', 'r', 'r', 'r', 'r'],
  );

  section('직업별 (소환물의 피해·킬은 소환사에 합산)');
  const jobRows = MAIN_JOBS.map((j) => {
    const a = s.perJob[j];
    return [
      JOB_NAME_KO[j],
      String(a.appearances),
      pct(a.wins, a.appearances),
      pct(a.draws, a.appearances),
      fixed(a.avgDamage, 0),
      fixed(a.avgHealing, 0),
      pct(a.survived, a.appearances),
      fixed(a.appearances > 0 ? a.kills / a.appearances : 0, 2),
      fixed(a.appearances > 0 ? a.skillsUsed / a.appearances : 0, 1),
    ];
  });
  jobRows.sort((x, y) => parseFloat(y[2]) - parseFloat(x[2]) || 0);
  printTable(
    ['직업', '등장', '승률', '무승부', '평균 피해', '평균 회복', '생존율', '평균 킬', '평균 스킬'],
    jobRows,
    ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r'],
  );

  section('스킬 사용 상위 10');
  if (s.topSkills.length === 0) {
    console.log('(스킬 사용 이벤트 없음)');
  } else {
    printTable(
      ['스킬', 'id', '사용 횟수', '판당'],
      s.topSkills.map((t) => [t.name, t.skillId, String(t.uses), fixed(t.uses / total, 2)]),
      ['l', 'l', 'r', 'r'],
    );
  }

  printZoneSummary(s.zones, total);

  section('종료 사유');
  const reasonKeys = Object.keys(s.reasons).sort();
  printTable(
    ['사유', '횟수', '비율'],
    reasonKeys.map((k) => [k, String(s.reasons[k]), pct(s.reasons[k], total)]),
    ['l', 'r', 'r'],
  );
}

// ───────────────────────── 결정론 검증 ─────────────────────────

interface DeterminismReport {
  mode: 'determinism';
  pass: boolean;
  map: MapType;
  seed: number;
  ticks: number;
  firstDiffTick: number | null;
  detail: string;
  resultMatch: boolean;
  inputMutated: boolean;
  /** 두 시뮬레이션에서 관측된 광역 영역 수 (같아야 한다) */
  zonesSeen: number;
}

function runDeterminism(opts: CliOptions): DeterminismReport {
  const input = buildInput(opts.seed, 0, opts);
  const original = JSON.stringify(input);
  // 두 시뮬레이터에 서로 독립적인 입력 복사본을 준다 (입력 변조 여부도 함께 검출)
  const input1 = JSON.parse(original) as BattleInput;
  const input2 = JSON.parse(original) as BattleInput;
  const sim1 = createBattle(input1);
  const sim2 = createBattle(input2);

  let firstDiffTick: number | null = null;
  let detail = '';
  let ticks = 0;
  let zonesSeen = 0;
  const maxTicks = 1_000_000;

  while (!(sim1.finished && sim2.finished) && ticks < maxTicks) {
    const f1 = sim1.step();
    const f2 = sim2.step();
    ticks++;
    for (const ev of f1.events) if (ev.kind === 'zone') zonesSeen++;
    if (f1.tick !== f2.tick) {
      firstDiffTick = Math.min(f1.tick, f2.tick);
      detail = `틱 번호 불일치: ${f1.tick} vs ${f2.tick}`;
      break;
    }
    const h1 = hashFrame(f1);
    const h2 = hashFrame(f2);
    if (h1 !== h2) {
      firstDiffTick = f1.tick;
      detail = describeFrameDiff(f1, f2);
      break;
    }
    if (f1.finished !== f2.finished) {
      firstDiffTick = f1.tick;
      detail = `종료 플래그 불일치: ${f1.finished} vs ${f2.finished}`;
      break;
    }
  }

  const r1 = sim1.result();
  const r2 = sim2.result();
  const resultMatch = JSON.stringify(r1) === JSON.stringify(r2);
  const inputMutated = JSON.stringify(input1) !== original || JSON.stringify(input2) !== original;

  return {
    mode: 'determinism',
    pass: firstDiffTick === null && resultMatch,
    map: input.map,
    seed: input.seed,
    ticks,
    firstDiffTick,
    detail,
    resultMatch,
    inputMutated,
    zonesSeen,
  };
}

/** 첫 불일치 프레임에서 어느 유닛/영역의 어느 필드가 다른지 짧게 설명 */
function describeFrameDiff(a: BattleFrame, b: BattleFrame): string {
  if (a.units.length !== b.units.length) return `유닛 수 불일치: ${a.units.length} vs ${b.units.length}`;
  for (let i = 0; i < a.units.length; i++) {
    const ua = a.units[i];
    const ub = b.units[i];
    const keys = Object.keys(ua) as (keyof typeof ua)[];
    for (const k of keys) {
      const va = JSON.stringify(ua[k]);
      const vb = JSON.stringify(ub[k]);
      if (va !== vb) return `유닛 ${ua.id} 필드 ${String(k)}: ${va} vs ${vb}`;
    }
  }
  const za = a.zones ?? [];
  const zb = b.zones ?? [];
  if (za.length !== zb.length) return `광역 영역 수 불일치: ${za.length} vs ${zb.length}`;
  for (let i = 0; i < za.length; i++) {
    const sa = JSON.stringify(za[i]);
    const sb = JSON.stringify(zb[i]);
    if (sa !== sb) return `광역 영역 ${za[i].id}: ${sa} vs ${sb}`;
  }
  if (JSON.stringify(a.events) !== JSON.stringify(b.events)) return '이벤트 목록 불일치';
  if (JSON.stringify(a.capture) !== JSON.stringify(b.capture)) return '거점 상태 불일치';
  return '알 수 없는 차이 (직렬화 결과 불일치)';
}

function printDeterminism(r: DeterminismReport): void {
  section('결정론 검증');
  console.log(`맵 ${MAP_NAME_KO[r.map]}, 전투 시드 ${r.seed}, 진행 틱 ${r.ticks}, 관측된 광역 영역 ${r.zonesSeen}개`);
  console.log(`프레임 해시 비교(유닛·이벤트·영역·거점): ${r.firstDiffTick === null ? 'PASS' : `FAIL (첫 불일치 틱 ${r.firstDiffTick})`}`);
  if (r.detail) console.log(`  ${r.detail}`);
  console.log(`최종 결과 비교: ${r.resultMatch ? 'PASS' : 'FAIL'}`);
  console.log(`입력 불변 검사: ${r.inputMutated ? '경고 - 시뮬레이터가 입력 객체를 변조함' : 'PASS'}`);
  console.log('');
  console.log(r.pass ? '결과: PASS' : '결과: FAIL');
}

// ───────────────────────── 육성 헤드리스 공통 ─────────────────────────

type Outcome = 'win' | 'lose' | 'draw';

interface DayRow {
  day: number;
  map: MapType | null;
  /** 1·2·4 스텝에서 실제로 고른 카드의 등급 */
  pickedRarities: ChoiceRarity[];
  /** 고른 카드 제목 (도박 성공/실패 표시 포함) */
  pickedTitles: string[];
  monsterTier: MonsterTier | null;
  monsterName: string;
  /** 몬스터 편성 인원 */
  monsterUnits: number;
  monsterWon: boolean | null;
  monsterDurationSec: number;
  battleOutcome: Outcome | null;
  battleReason: string;
  battleDurationSec: number;
  pointsEarned: number;
  skillsBought: number;
  avgStatTotal: number;
  teamPower: number;
}

/** 분화 선택지가 제시된 시점. differentiated 는 그때 이미 분화된 상태였는지 */
interface SubJobAppearance {
  day: number;
  step: number;
  differentiated: boolean;
}

interface SubJobCheck {
  charId: string;
  name: string;
  job: MainJob;
  scheduledDay: number | null;
  /** 분화 선택지가 등장한 (일차, 스텝) */
  appearances: SubJobAppearance[];
  /** 직업 변경이 적용된 (일차, 스텝). 이후의 분화 등장은 정당한 재분화 */
  jobChanges: { day: number; step: number }[];
  finalSubJob: string | null;
  ok: boolean;
  note: string;
}

interface DriverHooks {
  /** 선택지 세트가 제시되고 policy 가 고른 직후 (적용 전) */
  onChoiceSet?(state: RunState, cards: Choice[], pickedIndex: number): void;
  /** 몬스터 카드 3장이 제시된 직후 (선택 전) */
  onMonsterOptions?(state: RunState, options: readonly MonsterEncounter[]): void;
}

interface RunOutcome {
  state: RunState;
  days: DayRow[];
  members: { id: string; name: string; job: MainJob }[];
  teamName: string;
  subJobChecks: SubJobCheck[];
  subJobPass: boolean;
  finished: boolean;
  wins: number;
  loses: number;
  draws: number;
  monsterWins: number;
  monsterFights: number;
  /** rarityFloor 가 걸린 세트가 실제로 그 등급 이상을 포함했는지 */
  floorChecked: number;
  floorSatisfied: number;
  /** 4:4 전투의 광역·회피 통계 합계 */
  battleZones: ZoneStats;
}

/**
 * 풀에서 서로 다른 직업 TEAM_SIZE 명을 앞에서부터 고른다. 직업이 TEAM_SIZE 종 미만이면 나머지는 순서대로 채운다.
 *
 * 먼저 탱커 또는 힐러 1명을 반드시 넣는다. generateOpponentTeam(charGen.ts)이 3일차부터
 * 상대에게 탱커/힐러를 보장하는데 기준 플레이어만 그 보장이 없으면, 표본의 상당 부분이 구조적으로
 * 불리한 편성이 되어 몬스터·상대 난이도 보정값이 어긋난다. 4인 팀에서는 한 명의 비중이 더 커서 이 규칙이 더 중요하다.
 */
function pickDistinctJobs(pool: Character[]): string[] {
  const ids: string[] = [];
  const seen = new Set<MainJob>();
  for (const c of pool) {
    if (c.mainJob !== 'tank' && c.mainJob !== 'healer') continue;
    seen.add(c.mainJob);
    ids.push(c.id);
    break;
  }
  for (const c of pool) {
    if (ids.length >= TEAM_SIZE) break;
    if (seen.has(c.mainJob)) continue;
    seen.add(c.mainJob);
    ids.push(c.id);
  }
  for (const c of pool) {
    if (ids.length >= TEAM_SIZE) break;
    if (!ids.includes(c.id)) ids.push(c.id);
  }
  return ids;
}

function avgStatTotal(team: Team | null): number {
  if (!team || team.members.length === 0) return 0;
  let sum = 0;
  for (const m of team.members) sum += statTotal(m);
  return sum / team.members.length;
}

/** 팀 전투력 = 팀원 powerRating 합. run.ts 가 같은 이름의 함수를 제공하면 그것을 써 HUD 와 값을 맞춘다. */
function teamPower(team: Team | null): number {
  if (!team) return 0;
  const f = lookup(runApi, ['teamPower']);
  if (f) {
    const v = f(team);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  let sum = 0;
  for (const m of team.members) sum += powerRating(m);
  return sum;
}

/**
 * 보너스 상점 정책(탐욕). 실제 플레이어처럼 포인트를 남기지 않고 쓴다.
 *  1) 살 수 있는 가장 싼 스킬부터 산다 (하루 최대 SHOP_MAX_SKILLS_PER_DAY 개).
 *  2) 남은 포인트는 전부 스탯 훈련에 쓴다. 대상은 멤버를 순서대로 돌며 각자 성장 계수가 가장 높고
 *     아직 상한에 닿지 않은 스탯. 순회 순서가 고정이라 결정론이 유지된다.
 * 이 정책이 몬스터·상대팀 보정의 기준 플레이어다. 여기를 바꾸면 EXPECTED_TEAM_POWER_BY_DAY
 * (monsters.ts) 와 OPPONENT_POWER_BY_DAY (charGen.ts) 를 다시 측정해야 한다.
 */
const SHOP_MAX_SKILLS_PER_DAY = 2;

function runShop(state: RunState): { skills: number; trains: number } {
  let skills = 0;
  let trains = 0;
  for (let i = 0; i < SHOP_MAX_SKILLS_PER_DAY; i++) {
    if (!buyCheapestSkill(state)) break;
    skills++;
  }
  const team = state.team;
  if (!team) return { skills, trains };
  // 스탯 훈련: 포인트가 떨어지거나 더 올릴 스탯이 없을 때까지
  for (let guard = 0; guard < 400; guard++) {
    let did = false;
    for (const c of team.members) {
      let best: BaseStatKey | null = null;
      let bestScore = -Infinity;
      const growth = JOBS[c.mainJob].growth;
      for (const k of BASE_STAT_KEYS) {
        if (c.stats[k] >= STAT_MAX) continue;
        const score = (growth[k] ?? 1) * 100 - c.stats[k] * 0.01;
        if (score > bestScore) {
          bestScore = score;
          best = k;
        }
      }
      if (!best) continue;
      if (!apiTrainStat(state, c.id, best)) continue;
      trains++;
      did = true;
    }
    if (!did) break;
  }
  return { skills, trains };
}

/** 살 수 있는 가장 싼 스킬 1개를 산다. 샀으면 true. */
function buyCheapestSkill(state: RunState): boolean {
  const team = state.team;
  if (!team) return false;
  let best: { charId: string; skillId: string; cost: number } | null = null;
  for (const c of team.members) {
    const pool = skillPoolFor(c).slice().sort();
    for (const sid of pool) {
      if (c.skills.includes(sid)) continue;
      const def = SKILLS[sid];
      if (!def) continue;
      if (def.cost > state.bonusPoints) continue;
      if (best === null || def.cost < best.cost) best = { charId: c.id, skillId: sid, cost: def.cost };
    }
  }
  if (!best) return false;
  return apiBuySkill(state, best.charId, best.skillId);
}

function outcomeOf(result: BattleResult): Outcome {
  if (result.winner === 'A') return 'win';
  if (result.winner === 'B') return 'lose';
  return 'draw';
}

function outcomeKo(o: Outcome | null): string {
  return o === 'win' ? '승' : o === 'lose' ? '패' : o === 'draw' ? '무' : '-';
}

function newDayRow(day: number): DayRow {
  return {
    day,
    map: null,
    pickedRarities: [],
    pickedTitles: [],
    monsterTier: null,
    monsterName: '',
    monsterUnits: 0,
    monsterWon: null,
    monsterDurationSec: 0,
    battleOutcome: null,
    battleReason: '',
    battleDurationSec: 0,
    pointsEarned: 0,
    skillsBought: 0,
    avgStatTotal: 0,
    teamPower: 0,
  };
}

/**
 * 하나의 육성을 정책에 따라 끝까지 진행한다.
 * 전투는 즉시 끝내고(4:4 는 광역·회피 통계를 위해 틱 추적), 상태 머신이 요구하는 순서대로만 호출한다.
 */
function driveRun(seed: number, policy: PolicyName, hooks: DriverHooks = {}): RunOutcome {
  const state = apiNewRun(seed);
  const ids = pickDistinctJobs(state.pool);
  if (ids.length !== TEAM_SIZE) {
    throw new Error(`풀에서 ${TEAM_SIZE}명을 고를 수 없습니다 (풀 ${state.pool.length}명, 고른 인원 ${ids.length}).`);
  }
  const teamName = '헤드리스 검증팀';
  apiSelectTeam(state, ids, teamName);

  const team = state.team;
  if (!team) throw new Error('팀 선택 이후에도 state.team 이 null 입니다.');
  if (team.members.length !== TEAM_SIZE) {
    throw new Error(`팀 인원이 TEAM_SIZE(${TEAM_SIZE})와 다릅니다: ${team.members.length}`);
  }
  const members = team.members.map((m: Character) => ({ id: m.id, name: m.name, job: m.mainJob }));

  const scheduled: Record<string, number | null> = {};
  for (const m of team.members) {
    const v = state.subJobChoiceDay[m.id];
    scheduled[m.id] = typeof v === 'number' ? v : null;
  }

  const appearances = new Map<string, SubJobAppearance[]>();
  const jobChanges = new Map<string, { day: number; step: number }[]>();
  for (const m of team.members) {
    appearances.set(m.id, []);
    jobChanges.set(m.id, []);
  }
  /** 분화 선택지가 제시된 순간을 기록한다. 그 시점에 이미 분화된 상태였는지도 함께 남긴다. */
  const noteSubJobChoices = (cards: Choice[], day: number, step: number): void => {
    const seenThisSet = new Set<string>();
    for (const ch of cards) {
      if (ch.kind !== 'subjob') continue;
      const targets = new Set<string>(ch.charIds);
      for (const e of ch.effects) if (e.kind === 'set_subjob') targets.add(e.charId);
      for (const cid of targets) {
        if (seenThisSet.has(cid)) continue;
        seenThisSet.add(cid);
        const list = appearances.get(cid);
        if (!list) continue;
        const cur = state.team ? state.team.members.find((m) => m.id === cid) : undefined;
        list.push({ day, step, differentiated: !!cur && cur.subJob !== null });
      }
    }
  };

  const days: DayRow[] = [];
  const rowFor = (day: number): DayRow => {
    let row = days.length > 0 ? days[days.length - 1] : null;
    if (!row || row.day !== day) {
      row = newDayRow(day);
      days.push(row);
    }
    return row;
  };

  let wins = 0;
  let loses = 0;
  let draws = 0;
  let monsterWins = 0;
  let monsterFights = 0;
  let floorChecked = 0;
  let floorSatisfied = 0;
  const battleZones = emptyZoneStats();

  // 포인트 증감 추적 (획득만 합산. 상점 소비는 빼지 않는다)
  let lastPoints = state.bonusPoints;
  const collectPoints = (row: DayRow): void => {
    const diff = state.bonusPoints - lastPoints;
    if (diff > 0) row.pointsEarned += diff;
    lastPoints = state.bonusPoints;
  };

  const rngFor = (purpose: string): Rng => new Rng(hashSeed(`${seed}:${state.day}:${state.step}:${purpose}`));

  let guard = 0;
  const maxIter = TOTAL_DAYS * (STEPS_PER_DAY * 4 + 6) + 40;
  let stallKey = '';
  let stallCount = 0;

  while (state.phase !== 'done' && guard < maxIter) {
    guard++;
    const key = `${state.phase}:${state.day}:${state.step}:${state.history.length}:${state.bonusPoints}`;
    if (key === stallKey) {
      stallCount++;
      if (stallCount > 3) throw new Error(`육성 진행이 멈췄습니다 (phase=${state.phase}, day=${state.day}, step=${state.step}).`);
    } else {
      stallKey = key;
      stallCount = 0;
    }

    switch (state.phase) {
      case 'choice': {
        const row = rowFor(state.day);
        if (state.currentChoices.length === 0) apiEnsureChoices(state);
        const cards = state.currentChoices;
        if (cards.length === 0) throw new Error(`선택 단계인데 선택지가 비어 있습니다 (${state.day}일차 ${state.step}스텝).`);

        // rarityFloor 보장 검사 (선택 전에 확인)
        const floor = state.rarityFloor;
        if (floor) {
          floorChecked++;
          if (cards.some((c) => CHOICE_RARITY_RANK[c.rarity] >= CHOICE_RARITY_RANK[floor])) floorSatisfied++;
        }

        noteSubJobChoices(cards, state.day, state.step);
        const idx = pickChoiceIndex(policy, state, cards, rngFor('choice'));
        hooks.onChoiceSet?.(state, cards, idx);

        const picked = cards[idx];
        const day = state.day;
        const step = state.step;
        const res = apiPickChoice(state, idx);
        if (picked) {
          row.pickedRarities.push(picked.rarity);
          const tag = res.success === null ? '' : res.success ? ' (성공)' : ' (실패)';
          row.pickedTitles.push(`${picked.title}${tag}`);
          if (picked.kind === 'job_change') {
            for (const e of picked.effects) {
              if (e.kind !== 'change_job') continue;
              const list = jobChanges.get(e.charId);
              if (list) list.push({ day, step });
            }
          }
        }
        collectPoints(row);
        break;
      }

      case 'monster_select': {
        const row = rowFor(state.day);
        const options = state.monsterOptions ?? [];
        if (options.length === 0) throw new Error(`몬스터 선택 단계인데 후보가 없습니다 (${state.day}일차).`);
        hooks.onMonsterOptions?.(state, options);
        const idx = pickMonsterIndex(policy, options, rngFor('monster'));
        const enc = options[idx];
        row.monsterTier = enc.tier;
        row.monsterName = enc.name;
        row.monsterUnits = enc.team.members.length;
        apiPickMonster(state, idx, enc.tier);
        collectPoints(row);
        break;
      }

      case 'monster_battle': {
        const row = rowFor(state.day);
        const input = apiMonsterBattleInput(state);
        const result = createBattle(input).runToEnd();
        row.monsterWon = result.winner === 'A';
        row.monsterDurationSec = result.durationSec;
        monsterFights++;
        if (row.monsterWon) monsterWins++;
        apiFinishMonsterBattle(state, result);
        collectPoints(row);
        break;
      }

      case 'pre_battle':
      case 'battle': {
        const row = rowFor(state.day);
        const input = apiBattleInput(state);
        const tracked = runBattleTracked(input);
        const result = tracked.result;
        addZoneStats(battleZones, tracked.zones);
        const outcome = outcomeOf(result);
        row.map = input.map;
        row.battleOutcome = outcome;
        row.battleReason = result.reason;
        row.battleDurationSec = result.durationSec;
        if (outcome === 'win') wins++;
        else if (outcome === 'lose') loses++;
        else draws++;
        apiFinishBattle(state, result);
        collectPoints(row);
        break;
      }

      case 'day_end': {
        // 하루 마무리는 스텝이 아니므로 방금 끝낸 하루의 행에 기록한다
        // (run.ts 가 day 를 먼저 올리는 구현이어도 마지막 행을 쓴다).
        const row = days.length > 0 ? days[days.length - 1] : rowFor(state.day);
        collectPoints(row);
        if (policy === 'greedy') row.skillsBought += runShop(state).skills;
        lastPoints = state.bonusPoints; // 상점 소비는 획득으로 세지 않는다
        row.avgStatTotal = avgStatTotal(state.team);
        row.teamPower = teamPower(state.team);
        apiFinishDay(state);
        break;
      }

      case 'select_team':
        throw new Error('팀 선택 이후에도 phase 가 select_team 입니다.');

      default:
        throw new Error(`알 수 없는 phase: ${String(state.phase)}`);
    }
  }

  // 마지막 행 보정 (day_end 를 거치지 못한 경우)
  for (const row of days) {
    if (row.avgStatTotal === 0) row.avgStatTotal = avgStatTotal(state.team);
    if (row.teamPower === 0) row.teamPower = teamPower(state.team);
  }

  const finalTeam = state.team ?? team;
  const order = (p: { day: number; step: number }): number => p.day * 10 + p.step;
  const subJobChecks: SubJobCheck[] = finalTeam.members.map((m: Character) => {
    const apps = appearances.get(m.id) ?? [];
    const changes = jobChanges.get(m.id) ?? [];
    const daysSeen = [...new Set(apps.map((a) => a.day))];
    let ok = true;
    let note = '';
    if (daysSeen.length === 0) {
      ok = false;
      note = '분화 선택지가 한 번도 등장하지 않음';
    } else if (daysSeen[0] < SUBJOB_DAY_MIN || daysSeen[0] > SUBJOB_DAY_MAX) {
      ok = false;
      note = `첫 등장이 ${daysSeen[0]}일차 (보장 구간 ${SUBJOB_DAY_MIN}~${SUBJOB_DAY_MAX} 밖)`;
    }
    for (let i = 1; i < daysSeen.length && ok; i++) {
      const group = apps.filter((a) => a.day === daysSeen[i]);
      // 아직 분화하지 않은 캐릭터에게 다시 제시된 것은 같은 보장이 이어진 것이므로 정상이다.
      if (group.some((a) => !a.differentiated)) continue;
      const prevLast = apps.filter((a) => a.day === daysSeen[i - 1]).map(order).reduce((x, y) => Math.max(x, y), 0);
      const thisFirst = group.map(order).reduce((x, y) => Math.min(x, y), Infinity);
      const changedBetween = changes.some((jc) => order(jc) >= prevLast && order(jc) < thisFirst);
      if (!changedBetween) {
        ok = false;
        note = `${daysSeen[i]}일차 재등장에 대응하는 직업 변경이 없음 (이미 분화된 상태)`;
      }
    }
    return {
      charId: m.id,
      name: m.name,
      job: m.mainJob,
      scheduledDay: scheduled[m.id] ?? null,
      appearances: apps,
      jobChanges: changes,
      finalSubJob: m.subJob,
      ok,
      note,
    };
  });

  return {
    state,
    days,
    members,
    teamName,
    subJobChecks,
    subJobPass: subJobChecks.every((c) => c.ok),
    finished: state.phase === 'done',
    wins,
    loses,
    draws,
    monsterWins,
    monsterFights,
    floorChecked,
    floorSatisfied,
    battleZones,
  };
}

/** 정책별 선택지 인덱스 */
function pickChoiceIndex(policy: PolicyName, state: RunState, cards: Choice[], rng: Rng): number {
  if (cards.length <= 1) return 0;
  if (policy === 'first') return 0;
  if (policy === 'random') return rng.int(0, cards.length - 1);
  // greedy: estimatePowerDelta 최대 (동점이면 앞 카드)
  let bestIdx = 0;
  let bestVal = -Infinity;
  for (let i = 0; i < cards.length; i++) {
    const v = powerDeltaOf(state.team, cards[i]);
    if (v > bestVal) {
      bestVal = v;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** 정책별 몬스터 난이도 인덱스. greedy 는 중급(mid) 고정. */
function pickMonsterIndex(policy: PolicyName, options: readonly MonsterEncounter[], rng: Rng): number {
  if (options.length <= 1) return 0;
  if (policy === 'first') return 0;
  if (policy === 'random') return rng.int(0, options.length - 1);
  const mid = options.findIndex((o) => o.tier === 'mid');
  return mid >= 0 ? mid : 0;
}

// ───────────────────────── --growth ─────────────────────────

interface GrowthReport {
  mode: 'growth';
  seed: number;
  policy: PolicyName;
  teamSize: number;
  teamName: string;
  members: { id: string; name: string; job: MainJob }[];
  days: DayRow[];
  wins: number;
  loses: number;
  draws: number;
  monsterWins: number;
  monsterFights: number;
  /** 1일차와 10일차 4:4 전투 시간 (1일차가 짧아야 한다) */
  firstDayBattleSec: number;
  lastDayBattleSec: number;
  avgBattleSec: number;
  finalAvgStatTotal: number;
  finalTeamPower: number;
  finalBonusPoints: number;
  totalPoints: number;
  totalSkillsBought: number;
  floorChecked: number;
  floorSatisfied: number;
  subJobChecks: SubJobCheck[];
  subJobPass: boolean;
  finished: boolean;
  battleZones: ZoneSummary;
}

function runGrowth(opts: CliOptions): GrowthReport {
  const out = driveRun(opts.seed, opts.policy);
  let totalPoints = 0;
  let totalSkillsBought = 0;
  let battleSum = 0;
  let battles = 0;
  for (const d of out.days) {
    totalPoints += d.pointsEarned;
    totalSkillsBought += d.skillsBought;
    if (d.battleOutcome !== null) {
      battleSum += d.battleDurationSec;
      battles++;
    }
  }
  const first = out.days.find((d) => d.battleOutcome !== null);
  const last = [...out.days].reverse().find((d) => d.battleOutcome !== null);
  return {
    mode: 'growth',
    seed: opts.seed,
    policy: opts.policy,
    teamSize: TEAM_SIZE,
    teamName: out.teamName,
    members: out.members,
    days: out.days,
    wins: out.wins,
    loses: out.loses,
    draws: out.draws,
    monsterWins: out.monsterWins,
    monsterFights: out.monsterFights,
    firstDayBattleSec: first ? first.battleDurationSec : 0,
    lastDayBattleSec: last ? last.battleDurationSec : 0,
    avgBattleSec: battles > 0 ? battleSum / battles : 0,
    finalAvgStatTotal: avgStatTotal(out.state.team),
    finalTeamPower: teamPower(out.state.team),
    finalBonusPoints: out.state.bonusPoints,
    totalPoints,
    totalSkillsBought,
    floorChecked: out.floorChecked,
    floorSatisfied: out.floorSatisfied,
    subJobChecks: out.subJobChecks,
    subJobPass: out.subJobPass,
    finished: out.finished,
    battleZones: zoneSummaryOf(out.battleZones, battles),
  };
}

function rarityShort(r: ChoiceRarity): string {
  return CHOICE_RARITY_NAME_KO[r];
}

function printGrowth(r: GrowthReport): void {
  section(`육성 헤드리스 (시드 ${r.seed}, 정책 ${POLICY_NAME_KO[r.policy]}, 팀 "${r.teamName}", ${r.teamSize}인)`);
  console.log(`하루 구성: ${DAY_STEP_LABEL} (선택 스텝 ${CHOICE_STEPS.join('·')} / 몬스터 ${MONSTER_STEP} / 전투 ${BATTLE_STEP})`);
  console.log('팀원: ' + r.members.map((m) => `${m.name}(${JOB_NAME_KO[m.job]})`).join(', '));

  section('일차별 진행');
  printTable(
    ['일차', '맵', '선택 3장 등급', '몬스터', '인원', VS_LABEL, '전투 시간', '포인트', '평균 스탯합', '팀 전투력'],
    r.days.map((d) => [
      String(d.day),
      d.map ? MAP_NAME_KO[d.map] : '-',
      d.pickedRarities.length > 0 ? d.pickedRarities.map(rarityShort).join('·') : '-',
      d.monsterTier
        ? `${MONSTER_TIER_NAME_KO[d.monsterTier]} ${d.monsterWon === null ? '-' : d.monsterWon ? '승' : '패'}`
        : '-',
      d.monsterUnits > 0 ? `${d.monsterUnits}명` : '-',
      outcomeKo(d.battleOutcome),
      d.battleOutcome !== null ? fixed(d.battleDurationSec, 0) + '초' : '-',
      String(d.pointsEarned),
      fixed(d.avgStatTotal, 1),
      fixed(d.teamPower, 0),
    ]),
    ['r', 'l', 'l', 'l', 'r', 'l', 'r', 'r', 'r', 'r'],
  );

  section('일차별 고른 선택지');
  printTable(
    ['일차', '몬스터 종류', '고른 카드 (1·2·4스텝)'],
    r.days.map((d) => [String(d.day), d.monsterName || '-', d.pickedTitles.join(' / ')]),
    ['r', 'l', 'l'],
  );

  console.log('');
  console.log(
    `${VS_LABEL} 전적 ${r.wins}승 ${r.loses}패 ${r.draws}무, 몬스터 ${r.monsterWins}/${r.monsterFights}승, ` +
      `총 획득 포인트 ${r.totalPoints}, 상점 스킬 ${r.totalSkillsBought}개, 남은 포인트 ${r.finalBonusPoints}`,
  );
  console.log(
    `${VS_LABEL} 평균 전투 시간 ${fixed(r.avgBattleSec, 1)}초 (1일차 ${fixed(r.firstDayBattleSec, 0)}초 → 10일차 ${fixed(r.lastDayBattleSec, 0)}초` +
      `${r.firstDayBattleSec < r.lastDayBattleSec ? ', 1일차가 더 짧음 OK' : ', 1일차가 더 짧지 않음 - 표본 하나라 참고만'})`,
  );
  console.log(
    `최종 평균 스탯합 ${fixed(r.finalAvgStatTotal, 1)}, 최종 팀 전투력 ${fixed(r.finalTeamPower, 0)}, ` +
      `완료 ${r.finished ? '예' : '아니오 (phase 가 done 에 도달하지 못함)'}`,
  );
  console.log(
    `보장 등급(rarityFloor) 충족 ${r.floorSatisfied}/${r.floorChecked}` +
      (r.floorChecked === 0 ? ' (보장이 걸린 세트 없음)' : r.floorSatisfied === r.floorChecked ? ' PASS' : ' FAIL'),
  );

  printZoneSummary(r.battleZones, r.wins + r.loses + r.draws);

  section(`직업 분화 보장 검증 (첫 등장이 ${SUBJOB_DAY_MIN}~${SUBJOB_DAY_MAX}일차, 추가 등장은 직업 변경 후 재분화만 인정)`);
  console.log('등장 표기 "일차:스텝", 뒤의 * 는 이미 분화된 상태에서 다시 제시된 경우입니다.');
  printTable(
    ['캐릭터', '직업', '예정 일차', '등장 (일차:스텝)', '직업 변경', '최종 세부직업', '판정', '비고'],
    r.subJobChecks.map((c) => [
      c.name,
      JOB_NAME_KO[c.job],
      c.scheduledDay === null ? '-' : String(c.scheduledDay),
      c.appearances.length === 0 ? '없음' : c.appearances.map((a) => `${a.day}:${a.step}${a.differentiated ? '*' : ''}`).join(', '),
      c.jobChanges.length === 0 ? '-' : c.jobChanges.map((a) => `${a.day}:${a.step}`).join(', '),
      c.finalSubJob ?? '-',
      c.ok ? 'PASS' : 'FAIL',
      c.note,
    ]),
    ['l', 'l', 'r', 'l', 'l', 'l', 'l', 'l'],
  );
  console.log('');
  console.log(r.subJobPass ? '분화 보장: PASS' : '분화 보장: FAIL');
}

// ───────────────────────── --monster (난이도 보정) ─────────────────────────

/** 몬스터 인원 구간. 같은 난이도 안에서 1기 보스와 8기 떼의 승률 편차를 보기 위한 묶음 */
type CountBucket = '1~2' | '3~4' | '5~8';
const COUNT_BUCKETS: readonly CountBucket[] = ['1~2', '3~4', '5~8'];
/** 같은 난이도 안 인원 구간 승률 편차 허용치 (GDD §7.3.1: ±8%p) */
const BUCKET_SPREAD_MAX = 0.08;

function bucketOf(unitCount: number): CountBucket {
  if (unitCount <= 2) return '1~2';
  if (unitCount <= 4) return '3~4';
  return '5~8';
}

interface DefAgg {
  games: number;
  wins: number;
  durationSum: number;
  durations: number[];
  /** 편성 인원 (정의상 고정. 다른 값이 관측되면 최대값을 둔다) */
  unitCount: number;
}

interface BucketAgg {
  games: number;
  wins: number;
  durationSum: number;
}

interface TierAgg {
  games: number;
  wins: number;
  durationSum: number;
  /** 전투 시간 분포 검증용 (중앙값·짧은/긴 전투 비율). 평균만으로는 꼬리가 보이지 않는다 */
  durations: number[];
  monsterNames: Map<string, number>;
  /** 몬스터 종별 집계 (등장 순서 고정) */
  defs: Map<string, DefAgg>;
  /** 인원 구간별 집계 */
  buckets: Record<CountBucket, BucketAgg>;
}

interface TierStat {
  games: number;
  wins: number;
  winRate: number;
  avgDurationSec: number;
  medianDurationSec: number;
  /** 40초 미만 / 120초 초과 비율 (목표 전투 시간 40~120초) */
  shortRate: number;
  longRate: number;
}

/** 몬스터 종별 통계 (전투 시간 분포까지) */
interface DefStat {
  tier: MonsterTier;
  name: string;
  unitCount: number;
  games: number;
  winRate: number;
  avgDurationSec: number;
  medianDurationSec: number;
  longRate: number;
}

interface BucketStat {
  games: number;
  wins: number;
  winRate: number;
  avgDurationSec: number;
}

interface TierBucketStat {
  tier: MonsterTier;
  buckets: Record<CountBucket, BucketStat>;
  /** 표본이 있는 구간들의 승률 최대−최소. 구간이 1개 이하면 null */
  spread: number | null;
  pass: boolean;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface MonsterReport {
  mode: 'monster';
  seed: number;
  runs: number;
  policy: PolicyName;
  teamSize: number;
  monsterTeamRange: { min: number; max: number };
  /** 목표 승률 (하급은 하한) */
  targets: Record<MonsterTier, number>;
  /** 일차별 3스텝(몬스터 전투 직전) 평균 팀 전투력. EXPECTED_TEAM_POWER_BY_DAY 보정용 실측치 */
  perDay: { day: number; playerPower: number; tiers: Record<MonsterTier, TierStat> }[];
  overall: Record<MonsterTier, TierStat>;
  topMonsters: { tier: MonsterTier; name: string; unitCount: number; count: number }[];
  /** 몬스터 종별 승률·전투 시간 (종별 편차 확인용) */
  perDef: DefStat[];
  /** 난이도 × 인원 구간 승률 */
  perBucket: TierBucketStat[];
  /** 인원 범위 밖(1~8 위반) 편성이 관측된 횟수 */
  unitCountViolations: number;
  runsCompleted: number;
}

const MONSTER_TARGET: Record<MonsterTier, number> = { low: 0.975, mid: 0.8, high: 0.5 };
const MONSTER_TARGET_LABEL: Record<MonsterTier, string> = { low: '95~100%', mid: '80%', high: '50%' };

function emptyBuckets(): Record<CountBucket, BucketAgg> {
  const out = {} as Record<CountBucket, BucketAgg>;
  for (const b of COUNT_BUCKETS) out[b] = { games: 0, wins: 0, durationSum: 0 };
  return out;
}

function emptyTierAgg(): TierAgg {
  return {
    games: 0,
    wins: 0,
    durationSum: 0,
    durations: [],
    monsterNames: new Map(),
    defs: new Map(),
    buckets: emptyBuckets(),
  };
}

/** 몬스터 전투 목표 시간 구간 (GDD §6.1. 초반 육성 단계는 4:4 보다 짧게 끝나도 된다) */
const DURATION_MIN_SEC = 40;
const DURATION_MAX_SEC = 120;

function tierStat(a: TierAgg): TierStat {
  const sorted = a.durations.slice().sort((x, y) => x - y);
  let short = 0;
  let long = 0;
  for (const d of sorted) {
    if (d < DURATION_MIN_SEC) short++;
    else if (d > DURATION_MAX_SEC) long++;
  }
  return {
    games: a.games,
    wins: a.wins,
    winRate: a.games > 0 ? a.wins / a.games : 0,
    avgDurationSec: a.games > 0 ? a.durationSum / a.games : 0,
    medianDurationSec: median(sorted),
    shortRate: sorted.length > 0 ? short / sorted.length : 0,
    longRate: sorted.length > 0 ? long / sorted.length : 0,
  };
}

function bucketStats(tier: MonsterTier, a: TierAgg): TierBucketStat {
  const buckets = {} as Record<CountBucket, BucketStat>;
  let min = Infinity;
  let max = -Infinity;
  let present = 0;
  for (const b of COUNT_BUCKETS) {
    const agg = a.buckets[b];
    const winRate = agg.games > 0 ? agg.wins / agg.games : 0;
    buckets[b] = {
      games: agg.games,
      wins: agg.wins,
      winRate,
      avgDurationSec: agg.games > 0 ? agg.durationSum / agg.games : 0,
    };
    if (agg.games > 0) {
      present++;
      if (winRate < min) min = winRate;
      if (winRate > max) max = winRate;
    }
  }
  const spread = present >= 2 ? max - min : null;
  return { tier, buckets, spread, pass: spread === null || spread <= BUCKET_SPREAD_MAX + 1e-9 };
}

function runMonsterCalibration(opts: CliOptions): MonsterReport {
  // [일차][난이도] 집계
  const perDay = new Map<number, Record<MonsterTier, TierAgg>>();
  /** 일차별 몬스터 전투 직전 팀 전투력 표본 */
  const powerPerDay = new Map<number, { sum: number; n: number }>();
  const overall = {} as Record<MonsterTier, TierAgg>;
  for (const t of MONSTER_TIER_ORDER) overall[t] = emptyTierAgg();
  const dayAgg = (day: number): Record<MonsterTier, TierAgg> => {
    let rec = perDay.get(day);
    if (!rec) {
      rec = {} as Record<MonsterTier, TierAgg>;
      for (const t of MONSTER_TIER_ORDER) rec[t] = emptyTierAgg();
      perDay.set(day, rec);
    }
    return rec;
  };

  const showProgress = !opts.json;
  let runsCompleted = 0;
  let unitCountViolations = 0;

  for (let i = 0; i < opts.runs; i++) {
    const seed = (opts.seed + i) >>> 0;
    const hooks: DriverHooks = {
      onMonsterOptions: (state, options) => {
        const player = state.team;
        if (!player) return;
        const day = state.day;
        const rec = dayAgg(day);
        const pw = powerPerDay.get(day) ?? { sum: 0, n: 0 };
        pw.sum += teamPower(player);
        pw.n++;
        powerPerDay.set(day, pw);
        // 난이도 3장을 전부 싸워 본다. 복제본만 쓰므로 진행 중인 육성에는 영향이 없다.
        for (const enc of options) {
          const unitCount = enc.team.members.length;
          if (unitCount < MONSTER_TEAM_MIN || unitCount > MONSTER_TEAM_MAX) unitCountViolations++;
          const input: BattleInput = {
            seed: hashSeed(`${state.seed}:${day}:probe:${enc.tier}:${enc.monsterId}`),
            map: enc.map,
            teamA: deepClone(player),
            teamB: deepClone(enc.team),
          };
          const result = createBattle(input).runToEnd();
          const won = result.winner === 'A';
          const bucket = bucketOf(unitCount);
          for (const agg of [rec[enc.tier], overall[enc.tier]]) {
            agg.games++;
            if (won) agg.wins++;
            agg.durationSum += result.durationSec;
            agg.durations.push(result.durationSec);
            agg.monsterNames.set(enc.name, (agg.monsterNames.get(enc.name) ?? 0) + 1);
            let d = agg.defs.get(enc.name);
            if (!d) {
              d = { games: 0, wins: 0, durationSum: 0, durations: [], unitCount };
              agg.defs.set(enc.name, d);
            }
            d.games++;
            if (won) d.wins++;
            d.durationSum += result.durationSec;
            d.durations.push(result.durationSec);
            if (unitCount > d.unitCount) d.unitCount = unitCount;
            const b = agg.buckets[bucket];
            b.games++;
            if (won) b.wins++;
            b.durationSum += result.durationSec;
          }
        }
      },
    };
    try {
      const out = driveRun(seed, 'greedy', hooks);
      if (out.finished) runsCompleted++;
    } catch (e) {
      process.stderr.write(`\n시드 ${seed} 육성 중단: ${(e as Error).message}\n`);
    }
    progress('육성 표본', i + 1, opts.runs, showProgress);
  }

  const perDayOut: MonsterReport['perDay'] = [];
  const dayKeys = [...perDay.keys()].sort((a, b) => a - b);
  for (const day of dayKeys) {
    const rec = perDay.get(day)!;
    const tiers = {} as Record<MonsterTier, TierStat>;
    for (const t of MONSTER_TIER_ORDER) tiers[t] = tierStat(rec[t]);
    const pw = powerPerDay.get(day);
    perDayOut.push({ day, playerPower: pw && pw.n > 0 ? pw.sum / pw.n : 0, tiers });
  }
  const overallOut = {} as Record<MonsterTier, TierStat>;
  for (const t of MONSTER_TIER_ORDER) overallOut[t] = tierStat(overall[t]);

  const topMonsters: MonsterReport['topMonsters'] = [];
  for (const t of MONSTER_TIER_ORDER) {
    const entries = [...overall[t].monsterNames.entries()].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    for (const [name, count] of entries) {
      const d = overall[t].defs.get(name);
      topMonsters.push({ tier: t, name, unitCount: d ? d.unitCount : 0, count });
    }
  }

  const perDef: DefStat[] = [];
  for (const t of MONSTER_TIER_ORDER) {
    const entries = [...overall[t].defs.entries()].sort(
      (a, b) => a[1].unitCount - b[1].unitCount || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    for (const [name, d] of entries) {
      const sorted = d.durations.slice().sort((x, y) => x - y);
      let long = 0;
      for (const v of sorted) if (v > DURATION_MAX_SEC) long++;
      perDef.push({
        tier: t,
        name,
        unitCount: d.unitCount,
        games: d.games,
        winRate: d.games > 0 ? d.wins / d.games : 0,
        avgDurationSec: d.games > 0 ? d.durationSum / d.games : 0,
        medianDurationSec: median(sorted),
        longRate: sorted.length > 0 ? long / sorted.length : 0,
      });
    }
  }

  const perBucket: TierBucketStat[] = MONSTER_TIER_ORDER.map((t) => bucketStats(t, overall[t]));

  return {
    mode: 'monster',
    seed: opts.seed,
    runs: opts.runs,
    policy: 'greedy',
    teamSize: TEAM_SIZE,
    monsterTeamRange: { min: MONSTER_TEAM_MIN, max: MONSTER_TEAM_MAX },
    targets: MONSTER_TARGET,
    perDay: perDayOut,
    overall: overallOut,
    topMonsters,
    perDef,
    perBucket,
    unitCountViolations,
    runsCompleted,
  };
}

function printMonster(r: MonsterReport): void {
  section(
    `몬스터 난이도 보정 (표본 육성 ${r.runs}회, 시드 ${r.seed}~${(r.seed + r.runs - 1) >>> 0}, 정책 ${POLICY_NAME_KO[r.policy]}, 플레이어 ${r.teamSize}인 vs 몬스터 ${r.monsterTeamRange.min}~${r.monsterTeamRange.max}인)`,
  );
  console.log('매 일차 3스텝에서 하급·중급·고급을 모두 싸워 본 결과입니다 (복제 상태로 싸우므로 육성 진행에는 영향 없음).');
  console.log(`완주한 육성 ${r.runsCompleted}/${r.runs}`);
  if (r.unitCountViolations > 0) {
    console.log(`경고: 인원이 ${r.monsterTeamRange.min}~${r.monsterTeamRange.max} 범위 밖인 몬스터 편성이 ${r.unitCountViolations}회 관측되었습니다.`);
  }

  section('일차 × 난이도 승률 (괄호는 평균 전투 시간)');
  printTable(
    ['일차', ...MONSTER_TIER_ORDER.map((t) => MONSTER_TIER_NAME_KO[t]), '표본/난이도', '팀 전투력'],
    r.perDay.map((d) => [
      String(d.day),
      ...MONSTER_TIER_ORDER.map((t) => {
        const s = d.tiers[t];
        return s.games === 0 ? '-' : `${pctOf(s.winRate)} (${fixed(s.avgDurationSec, 0)}초)`;
      }),
      String(d.tiers[MONSTER_TIER_ORDER[0]].games),
      fixed(d.playerPower, 0),
    ]),
    ['r', 'r', 'r', 'r', 'r', 'r'],
  );
  console.log('팀 전투력은 몬스터 전투 직전(3스텝) 실측 평균입니다. monsters.ts 의 EXPECTED_TEAM_POWER_BY_DAY 를 이 값으로 맞추면 일차별 승률이 평평해집니다.');

  section('난이도별 전체 승률과 목표');
  printTable(
    ['난이도', '표본', '승률', '목표', '차이', '평균 전투 시간'],
    MONSTER_TIER_ORDER.map((t) => {
      const s = r.overall[t];
      const diff = s.winRate - r.targets[t];
      const inRange = t === 'low' ? s.winRate >= 0.95 : Math.abs(diff) <= 0.05;
      return [
        MONSTER_TIER_NAME_KO[t],
        String(s.games),
        pctOf(s.winRate),
        MONSTER_TARGET_LABEL[t],
        `${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}p ${inRange ? 'OK' : '조정 필요'}`,
        fixed(s.avgDurationSec, 1) + '초',
      ];
    }),
    ['l', 'r', 'r', 'r', 'r', 'r'],
  );

  section(`난이도 × 인원 구간 승률 (같은 난이도 안 편차 ±${Math.round(BUCKET_SPREAD_MAX * 100)}%p 이내 목표)`);
  printTable(
    ['난이도', ...COUNT_BUCKETS.map((b) => `${b}명`), '편차', '판정'],
    r.perBucket.map((tb) => [
      MONSTER_TIER_NAME_KO[tb.tier],
      ...COUNT_BUCKETS.map((b) => {
        const s = tb.buckets[b];
        return s.games === 0 ? '-' : `${pctOf(s.winRate)} (${s.games}판, ${fixed(s.avgDurationSec, 0)}초)`;
      }),
      tb.spread === null ? '-' : `${(tb.spread * 100).toFixed(1)}p`,
      tb.spread === null ? '구간 부족' : tb.pass ? 'OK' : '조정 필요',
    ]),
    ['l', 'r', 'r', 'r', 'r', 'l'],
  );
  console.log('인원 구간의 편차가 크면 TIER_POWER_RATIO 가 아니라 해당 인원 편성의 MonsterDef.powerScale 을 움직입니다 (1기 보스는 내리고, 8기 떼는 올리는 식).');

  section(`난이도별 전투 시간 분포 (목표 ${DURATION_MIN_SEC}~${DURATION_MAX_SEC}초)`);
  printTable(
    ['난이도', '평균', '중앙값', `${DURATION_MIN_SEC}초 미만`, `${DURATION_MAX_SEC}초 초과`, '판정'],
    MONSTER_TIER_ORDER.map((t) => {
      const s = r.overall[t];
      const ok = s.medianDurationSec >= DURATION_MIN_SEC && s.medianDurationSec <= DURATION_MAX_SEC
        && s.shortRate <= 0.35 && s.longRate <= 0.25;
      return [
        MONSTER_TIER_NAME_KO[t],
        fixed(s.avgDurationSec, 1) + '초',
        fixed(s.medianDurationSec, 1) + '초',
        pctOf(s.shortRate),
        pctOf(s.longRate),
        ok ? 'OK' : '조정 필요',
      ];
    }),
    ['l', 'r', 'r', 'r', 'r', 'l'],
  );
  console.log('평균만 보면 긴 꼬리에 가려 중앙값이 하한 아래로 내려간 것을 놓칩니다. 중앙값과 두 비율을 함께 보세요.');

  section('몬스터 종별 승률과 전투 시간 (인원 오름차순)');
  if (r.perDef.length === 0) {
    console.log('(표본 없음)');
  } else {
    printTable(
      ['난이도', '몬스터', '인원', '표본', '승률', '평균', '중앙값', `${DURATION_MAX_SEC}초 초과`],
      r.perDef.map((m) => [
        MONSTER_TIER_NAME_KO[m.tier],
        m.name,
        `${m.unitCount}명`,
        String(m.games),
        pctOf(m.winRate),
        fixed(m.avgDurationSec, 1) + '초',
        fixed(m.medianDurationSec, 1) + '초',
        pctOf(m.longRate),
      ]),
      ['l', 'l', 'r', 'r', 'r', 'r', 'r', 'r'],
    );
    console.log('종별 승률이 난이도 평균에서 크게 벗어나면 그 종의 MonsterDef.powerScale 을 조정합니다.');
  }

  console.log('');
  console.log('보정 방법: MonsterDef.powerScale 과 MonsterUnitTemplate.derivedMult 를 올리거나 내려 승률을 목표에 맞춥니다.');
}

// ───────────────────────── --rarity (선택지 등급 모델) ─────────────────────────

interface RarityCardSample {
  day: number;
  step: number;
  rarity: ChoiceRarity;
  kind: ChoiceKind;
  powerDelta: number;
  statGain: number;
}

interface RarityBandStat {
  label: string;
  cards: number;
  counts: Record<ChoiceRarity, number>;
  expected: Record<ChoiceRarity, number>;
}

interface RarityPerRarity {
  rarity: ChoiceRarity;
  cards: number;
  share: number;
  avgPowerDelta: number;
  minPowerDelta: number;
  maxPowerDelta: number;
  /** 순수 스탯 카드(STAT_KINDS)의 평균 순 변화량. 스킬·시너지·분화 카드는 0 이라 섞으면 기준과 비교할 수 없다 */
  avgStatGain: number;
  /** 위 평균에 쓰인 스탯형 카드 수 */
  statCards: number;
  targetStatGain: string;
  /** 평균 순 스탯 상승이 기준 구간 안인지 */
  statGainOk: boolean | null;
}

interface RarityReport {
  mode: 'rarity';
  seed: number;
  runs: number;
  sets: number;
  cards: number;
  subJobSets: number;
  source: 'generateChoices' | 'run';
  bands: RarityBandStat[];
  perRarity: RarityPerRarity[];
  perKind: { kind: ChoiceKind; name: string; cards: number; share: number; avgPowerDelta: number; topRarity: ChoiceRarity }[];
  floorTests: { floor: ChoiceRarity; sets: number; satisfied: number; pass: boolean }[];
}

/** GDD §7.4.1 의 기대 가중치 (표시 비교용) */
const RARITY_BANDS: { label: string; from: number; to: number; weights: Record<ChoiceRarity, number> }[] = [
  { label: '1~3일', from: 1, to: 3, weights: { common: 52, rare: 32, epic: 13, legendary: 3 } },
  { label: '4~7일', from: 4, to: 7, weights: { common: 44, rare: 34, epic: 17, legendary: 5 } },
  { label: '8~10일', from: 8, to: 10, weights: { common: 34, rare: 35, epic: 22, legendary: 9 } },
];

/** 보장 등급 검증에 쓸 등급 (일반은 보장 의미가 없어 제외) */
const FLOOR_TEST_ORDER: readonly ChoiceRarity[] = ['rare', 'epic', 'legendary'];

/** GDD §7.4.2 의 총 스탯 상승량 기준 (4인 팀에서도 유지) */
const RARITY_STAT_RANGE: Record<ChoiceRarity, { min: number; max: number }> = {
  common: { min: 10, max: 16 },
  rare: { min: 20, max: 30 },
  epic: { min: 36, max: 50 },
  legendary: { min: 60, max: 85 },
};

function rarityStatTargetLabel(r: ChoiceRarity): string {
  const t = RARITY_STAT_RANGE[r];
  return `${t.min}~${t.max}`;
}

/**
 * 희귀도별 '총 스탯 상승량 기준'(GDD §7.4.2)이 직접 적용되는 카드 종류.
 * 스킬 습득은 스킬 가격, 시너지는 레어~에픽, 직업 분화는 항상 에픽으로 등급을 보므로 제외한다.
 * 맵 적응 훈련은 상승치가 스탯이 아니라 적응도라 역시 제외한다.
 * 희생은 보상의 일부를 보너스 포인트로 주기도 해서 스탯 기준과 직접 비교할 수 없다 (종류별 표에서 따로 본다).
 */
const STAT_KINDS: readonly ChoiceKind[] = ['big_single', 'small_multi', 'tradeoff', 'gamble'];

/**
 * 카드 한 장의 순 스탯 변화량 (상승 - 하락).
 * GDD §7.4.2 의 '총 스탯 상승량 기준'은 순 변화량 기준이다. 상승분만 세면 편중 훈련처럼
 * 하락을 끼고 상승을 부풀린 카드가 기준을 넘은 것처럼 보인다.
 */
function statGainOf(ch: Choice): number {
  let g = 0;
  for (const e of ch.effects) {
    if (e.kind === 'stat') g += e.delta;
    else if (e.kind === 'stat_category') g += e.delta * 5;
  }
  return g;
}

function runRarity(opts: CliOptions): RarityReport {
  const cards: RarityCardSample[] = [];
  let sets = 0;
  let subJobSets = 0;
  const floorCounts = new Map<ChoiceRarity, { sets: number; satisfied: number }>();
  for (const r of CHOICE_RARITY_ORDER) floorCounts.set(r, { sets: 0, satisfied: 0 });

  const showProgress = !opts.json;
  let source: RarityReport['source'] = 'generateChoices';

  /**
   * 세트 1개 집계.
   * collect=false 면 보장 등급(rarityFloor) 검증에만 쓰고 등급 분포 표본에는 넣지 않는다
   * (보장을 건 세트를 분포에 섞으면 상위 등급 비율이 부풀려진다).
   */
  const record = (state: RunState, set: Choice[], day: number, step: number, collect: boolean): void => {
    const floor = state.rarityFloor;
    if (floor) {
      const rec = floorCounts.get(floor)!;
      rec.sets++;
      if (set.some((c) => CHOICE_RARITY_RANK[c.rarity] >= CHOICE_RARITY_RANK[floor])) rec.satisfied++;
    }
    if (!collect) return;
    sets++;
    if (set.length > 0 && set.every((c) => c.kind === 'subjob')) {
      subJobSets++;
      return; // 분화 보장 세트는 등급 분포 표본에서 제외 (항상 에픽 3장)
    }
    for (const c of set) {
      cards.push({
        day,
        step,
        rarity: c.rarity,
        kind: c.kind,
        powerDelta: powerDeltaOf(state.team, c),
        statGain: statGainOf(c),
      });
    }
  };

  // 1순위: generateChoices 를 직접 호출해 전투 없이 대량 표본을 뽑는다.
  let generated = false;
  try {
    for (let i = 0; i < opts.runs; i++) {
      const seed = (opts.seed + i) >>> 0;
      const state = apiNewRun(seed);
      apiSelectTeam(state, pickDistinctJobs(state.pool), '등급 표본팀');
      for (let day = 1; day <= TOTAL_DAYS; day++) {
        for (const step of CHOICE_STEPS) {
          state.day = day;
          state.step = step;
          state.phase = 'choice';
          // 분화 보장 세트는 등급 분포 표본이 아니므로, 예정표를 비워 일반 선택지가 나오게 한다.
          // (분화는 항상 에픽 3장이라 분포를 왜곡한다. 보장 자체는 --growth 가 검증한다)
          state.subJobChoiceDay = {};

          // (1) 보장 없는 세트 — 등급 분포 표본
          state.rarityFloor = null;
          const set = apiGenerateChoices(state, new Rng(hashSeed(`${seed}:${day}:${step}:rarity`)));
          if (!set) throw new Error('generateChoices 를 찾지 못했습니다.');
          record(state, set, day, step, true);
          generated = true;

          // (2) 보장 등급 검증용 세트 — 분포에는 넣지 않는다
          const floor = FLOOR_TEST_ORDER[(day + step) % FLOOR_TEST_ORDER.length];
          state.rarityFloor = floor;
          const floorSet = apiGenerateChoices(state, new Rng(hashSeed(`${seed}:${day}:${step}:floor:${floor}`)));
          if (floorSet) record(state, floorSet, day, step, false);
          state.rarityFloor = null;
        }
      }
      progress('등급 표본', i + 1, opts.runs, showProgress);
    }
  } catch (e) {
    if (!generated) {
      // 2순위: 실제 육성을 돌려 제시된 세트를 모은다 (느리지만 확실).
      source = 'run';
      cards.length = 0;
      sets = 0;
      subJobSets = 0;
      for (const r of CHOICE_RARITY_ORDER) floorCounts.set(r, { sets: 0, satisfied: 0 });
      process.stderr.write(`\ngenerateChoices 직접 호출 실패(${(e as Error).message}) — 실제 육성 진행으로 표본을 모읍니다.\n`);
      const runs = Math.max(1, Math.min(opts.runs, 20));
      for (let i = 0; i < runs; i++) {
        const seed = (opts.seed + i) >>> 0;
        const hooks: DriverHooks = {
          onChoiceSet: (state, set) => record(state, set, state.day, state.step, true),
        };
        try {
          driveRun(seed, 'greedy', hooks);
        } catch (err) {
          process.stderr.write(`\n시드 ${seed} 육성 중단: ${(err as Error).message}\n`);
        }
        progress('등급 표본(육성)', i + 1, runs, showProgress);
      }
    } else {
      // 이미 표본이 모였다면 모인 만큼으로 집계한다
      process.stderr.write(`\n표본 수집 중단(${(e as Error).message}) — 모인 ${cards.length}장으로 집계합니다.\n`);
    }
  }

  // 구간별 분포
  const bands: RarityBandStat[] = RARITY_BANDS.map((b) => {
    const counts = {} as Record<ChoiceRarity, number>;
    for (const r of CHOICE_RARITY_ORDER) counts[r] = 0;
    let n = 0;
    for (const c of cards) {
      if (c.day < b.from || c.day > b.to) continue;
      counts[c.rarity]++;
      n++;
    }
    return { label: b.label, cards: n, counts, expected: b.weights };
  });
  {
    const counts = {} as Record<ChoiceRarity, number>;
    for (const r of CHOICE_RARITY_ORDER) counts[r] = 0;
    for (const c of cards) counts[c.rarity]++;
    const expected = {} as Record<ChoiceRarity, number>;
    for (const r of CHOICE_RARITY_ORDER) {
      let sum = 0;
      for (const b of RARITY_BANDS) sum += b.weights[r] * (b.to - b.from + 1);
      expected[r] = sum / TOTAL_DAYS;
    }
    bands.push({ label: '전체', cards: cards.length, counts, expected });
  }

  // 등급별
  const perRarity: RarityPerRarity[] = CHOICE_RARITY_ORDER.map((r) => {
    const list = cards.filter((c) => c.rarity === r);
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    let statSum = 0;
    let statCards = 0;
    for (const c of list) {
      sum += c.powerDelta;
      if (STAT_KINDS.includes(c.kind)) {
        statSum += c.statGain;
        statCards++;
      }
      if (c.powerDelta < min) min = c.powerDelta;
      if (c.powerDelta > max) max = c.powerDelta;
    }
    const avgStatGain = statCards > 0 ? statSum / statCards : 0;
    const range = RARITY_STAT_RANGE[r];
    return {
      rarity: r,
      cards: list.length,
      share: cards.length > 0 ? list.length / cards.length : 0,
      avgPowerDelta: list.length > 0 ? sum / list.length : 0,
      minPowerDelta: list.length > 0 ? min : 0,
      maxPowerDelta: list.length > 0 ? max : 0,
      avgStatGain,
      statCards,
      targetStatGain: rarityStatTargetLabel(r),
      statGainOk: statCards > 0 ? avgStatGain >= range.min && avgStatGain <= range.max : null,
    };
  });

  // 종류별
  const kinds = [...new Set(cards.map((c) => c.kind))].sort();
  const perKind = kinds.map((k) => {
    const list = cards.filter((c) => c.kind === k);
    let sum = 0;
    const byRarity = {} as Record<ChoiceRarity, number>;
    for (const r of CHOICE_RARITY_ORDER) byRarity[r] = 0;
    for (const c of list) {
      sum += c.powerDelta;
      byRarity[c.rarity]++;
    }
    let topRarity: ChoiceRarity = CHOICE_RARITY_ORDER[0];
    for (const r of CHOICE_RARITY_ORDER) if (byRarity[r] > byRarity[topRarity]) topRarity = r;
    return {
      kind: k,
      name: CHOICE_KIND_NAME_KO[k],
      cards: list.length,
      share: cards.length > 0 ? list.length / cards.length : 0,
      avgPowerDelta: list.length > 0 ? sum / list.length : 0,
      topRarity,
    };
  });

  const floorTests = CHOICE_RARITY_ORDER.filter((r) => r !== 'common').map((r) => {
    const rec = floorCounts.get(r)!;
    return { floor: r, sets: rec.sets, satisfied: rec.satisfied, pass: rec.sets === 0 || rec.satisfied === rec.sets };
  });

  return {
    mode: 'rarity',
    seed: opts.seed,
    runs: opts.runs,
    sets,
    cards: cards.length,
    subJobSets,
    source,
    bands,
    perRarity,
    perKind,
    floorTests,
  };
}

function printRarity(r: RarityReport): void {
  section(`선택지 등급 모델 (표본 ${r.cards}장 / ${r.sets}세트, 시드 ${r.seed}~${(r.seed + r.runs - 1) >>> 0}, ${TEAM_SIZE}인 팀)`);
  console.log(
    `표본 방식: ${r.source === 'generateChoices' ? 'generateChoices 직접 호출 (전투 없음)' : '실제 육성 진행에서 수집'}` +
      `, 분화 보장 세트 ${r.subJobSets}개는 분포에서 제외`,
  );

  section('일차 구간별 등급 분포 (관측 / 기대)');
  printTable(
    ['구간', '카드', ...CHOICE_RARITY_ORDER.map((x) => CHOICE_RARITY_NAME_KO[x])],
    r.bands.map((b) => {
      const total = b.cards;
      let expSum = 0;
      for (const k of CHOICE_RARITY_ORDER) expSum += b.expected[k];
      return [
        b.label,
        String(total),
        ...CHOICE_RARITY_ORDER.map((k) => {
          const obs = total > 0 ? (b.counts[k] / total) * 100 : 0;
          const exp = expSum > 0 ? (b.expected[k] / expSum) * 100 : 0;
          return `${obs.toFixed(1)}% / ${exp.toFixed(1)}%`;
        }),
      ];
    }),
    ['l', 'r', 'r', 'r', 'r', 'r'],
  );

  section('등급별 예상 전투력 상승치(powerDelta)와 스탯 상승량');
  printTable(
    ['등급', '카드', '비율', '평균 powerDelta', '최소', '최대', '스탯형 카드', '평균 스탯상승', '기준(스탯)', '판정'],
    r.perRarity.map((p) => [
      CHOICE_RARITY_NAME_KO[p.rarity],
      String(p.cards),
      pctOf(p.share),
      fixed(p.avgPowerDelta, 1),
      fixed(p.minPowerDelta, 1),
      fixed(p.maxPowerDelta, 1),
      String(p.statCards),
      fixed(p.avgStatGain, 1),
      p.targetStatGain,
      p.statGainOk === null ? '표본 없음' : p.statGainOk ? 'OK' : '조정 필요',
    ]),
    ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l'],
  );
  console.log('평균 스탯상승은 순수 스탯 카드(집중·합동·편중·도박)의 순 변화량(상승-하락) 평균입니다. 스킬·시너지·분화·맵 적응·희생 카드는 보상이 스탯만이 아니라 제외했습니다.');
  console.log(`기준은 GDD §7.4.2 (일반 10~16 / 레어 20~30 / 에픽 36~50 / 전설 60~85). ${TEAM_SIZE}인 팀에서도 총량 기준은 그대로입니다.`);

  section('선택지 종류별');
  printTable(
    ['종류', '카드', '비율', '평균 powerDelta', '최빈 등급'],
    r.perKind.map((p) => [
      p.name,
      String(p.cards),
      pctOf(p.share),
      fixed(p.avgPowerDelta, 1),
      CHOICE_RARITY_NAME_KO[p.topRarity],
    ]),
    ['l', 'r', 'r', 'r', 'l'],
  );

  section('보장 등급(rarityFloor) 검증 — 세트 3장 중 최소 1장이 그 등급 이상이어야 함');
  printTable(
    ['보장 등급', '세트', '충족', '판정'],
    r.floorTests.map((f) => [
      CHOICE_RARITY_NAME_KO[f.floor],
      String(f.sets),
      String(f.satisfied),
      f.sets === 0 ? '표본 없음' : f.pass ? 'PASS' : 'FAIL',
    ]),
    ['l', 'r', 'r', 'l'],
  );
  const pass = r.floorTests.every((f) => f.pass);
  console.log('');
  console.log(pass ? '보장 등급: PASS' : '보장 등급: FAIL');
}

// ───────────────────────── --dodge (광역 예고 회피율) ─────────────────────────

/** 회피 이동 속도 배율 (GDD §4.4) */
const DODGE_SPEED_MULT = 1.15;
/** 탈출점 여유 거리 (GDD §4.4) */
const DODGE_ESCAPE_MARGIN = 0.6;
/** 이 예고 시간보다 짧으면 회피 확률 절반 */
const DODGE_SHORT_TELEGRAPH_SEC = 0.5;

/**
 * 광역 회피 확률 (GDD §4.4 확정 공식).
 *   clamp(판단력 × 0.006 + 민첩 × 0.003, 0.05, 0.85), 예고 < 0.5초면 절반. (v0.5 보정: 기본항 0.10 → 0)
 * sim 이 같은 이름의 함수를 내보내면 --dodge 가 그 값과 이 값을 대조한다.
 */
function dodgeChanceFormula(judgment: number, agility: number, telegraphSec: number): number {
  let p = judgment * 0.006 + agility * 0.003;
  if (p < 0.05) p = 0.05;
  else if (p > 0.85) p = 0.85;
  if (telegraphSec < DODGE_SHORT_TELEGRAPH_SEC) p *= 0.5;
  return p;
}

/** 스킬의 예고 시간 기본 규칙 (GDD §6.5.1). telegraphSec 이 있으면 그 값 */
function telegraphSecOf(def: SkillDef): number {
  if (def.telegraphSec !== undefined) return Math.max(0, def.telegraphSec);
  if (def.target === 'ally_area') return 0;
  if (def.target !== 'enemy_area' && def.target !== 'line') return 0;
  const radius = def.radius ?? 0;
  if (radius <= 2.5 && def.range <= 2) return SHORT_TELEGRAPH_SEC;
  return DEFAULT_TELEGRAPH_SEC;
}

/** 모든 스탯이 base 인 합성 캐릭터. overrides 로 일부만 바꾼다 */
function syntheticCharacter(
  id: string,
  name: string,
  job: MainJob,
  base: number,
  overrides: Partial<Record<BaseStatKey, number>>,
  skills: string[],
): Character {
  const stats = {} as StatBlock;
  for (const k of BASE_STAT_KEYS) {
    const v = overrides[k];
    stats[k] = v === undefined ? base : v;
  }
  const adaptation = {} as Adaptation;
  for (const m of MAP_TYPES) adaptation[m] = 50;
  return {
    id,
    name,
    mainJob: job,
    subJob: null,
    stats,
    adaptation,
    growthVariance: {},
    skills,
    rarity: 3,
  };
}

interface DodgeUnitSpec {
  label: string;
  judgment: number;
  agility: number;
  moveSpeed: number;
  /** 목표: 'min' 이면 회피율 ≥ value, 'max' 면 < value, null 이면 참고용 */
  target: { kind: 'min' | 'max'; value: number } | null;
}

interface DodgeUnitResult {
  label: string;
  judgment: number;
  agility: number;
  moveSpeed: number;
  /** 공식 인지 확률 */
  chance: number;
  /** 관측 인지율 (판정 성공 / 시도) */
  perceivedRate: number;
  /** 이동 가능 거리 (예고 시간 × 회피 속도) */
  reachSec: number;
  reachDist: number;
  /** 영역 중심에서 벗어나는 데 필요한 거리 (반경 + 여유) */
  needDistCenter: number;
  /** 영역 중심에 있을 때 실제 회피율 (인지 ∧ 이동 성공) */
  dodgeRateCenter: number;
  /** 영역 안 임의 위치에 있을 때 실제 회피율 */
  dodgeRateRandom: number;
  trials: number;
  target: DodgeUnitSpec['target'];
  /** 목표 판정 (중심 기준). 참고용 유닛은 null */
  pass: boolean | null;
  /** 실전 표본 */
  battle: {
    battles: number;
    zones: number;
    attempts: number;
    dodgeEvents: number;
    exposed: number;
    /** impact 때 영역 밖 (회피 이동이든 일반 이동이든) */
    avoided: number;
    /** 인지(dodge 이벤트) + impact 때 영역 밖 = 회피 이동으로 벗어남 */
    dodgedEscaped: number;
    /** 인지했지만 impact 때 영역 안 */
    dodgedHit: number;
    /** dodge 이벤트 / 회피 판정 */
    perceivedRate: number;
    /** 회피 이동으로 벗어남 / 노출. 판정 기준. (일반 이동으로 우연히 나간 경우는 제외 — 회피 공식의 효과만 잰다) */
    dodgeRate: number;
    pass: boolean | null;
    note: string;
  };
}

interface DodgeReport {
  mode: 'dodge';
  seed: number;
  trials: number;
  skillId: string;
  skillName: string;
  telegraphSec: number;
  radius: number;
  map: MapType;
  /** sim 이 내보낸 dodgeChance 와 공식 대조 결과 */
  simCheck: { available: boolean; matches: boolean | null; note: string };
  units: DodgeUnitResult[];
  /** 두 목표 유닛의 공식 기준 판정 */
  formulaPass: boolean;
  /** 실전 표본 판정 (측정 불가면 null) */
  battlePass: boolean | null;
  pass: boolean;
}

/** sim 이 dodgeChance 를 내보내면 (판단력, 민첩, 예고시간) 으로 불러 공식과 대조한다 */
function checkSimDodgeChance(telegraphSec: number): DodgeReport['simCheck'] {
  const f = lookup(simModule as unknown as Record<string, unknown>, ['dodgeChance', 'dodgeChanceOf', 'computeDodgeChance']);
  if (!f) return { available: false, matches: null, note: 'sim 이 dodgeChance 를 내보내지 않음 (공식은 이 도구의 구현으로 계산)' };
  const probes: [number, number][] = [
    [80, 70],
    [30, 30],
    [10, 10],
    [100, 100],
  ];
  const diffs: string[] = [];
  for (const [j, a] of probes) {
    let v: unknown;
    try {
      v = f(j, a, telegraphSec);
    } catch (e) {
      return { available: true, matches: null, note: `sim.dodgeChance 호출 실패 (인자 형태가 다름): ${(e as Error).message}` };
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      return { available: true, matches: null, note: 'sim.dodgeChance 가 0~1 확률을 돌려주지 않음 (인자 형태가 다름)' };
    }
    const expect = dodgeChanceFormula(j, a, telegraphSec);
    if (Math.abs(v - expect) > 1e-6) diffs.push(`판단력 ${j}·민첩 ${a}: sim ${v.toFixed(4)} vs 공식 ${expect.toFixed(4)}`);
  }
  if (diffs.length > 0) return { available: true, matches: false, note: `공식 불일치 — ${diffs.join(', ')}` };
  return { available: true, matches: true, note: 'sim.dodgeChance 가 GDD §4.4 공식과 일치' };
}

function runDodge(opts: CliOptions): DodgeReport {
  const def = SKILLS[opts.skill];
  if (!def) throw new Error(`알 수 없는 스킬 id: ${opts.skill}`);
  if (def.target !== 'enemy_area' && def.target !== 'line') {
    throw new Error(`--skill 은 enemy_area / line 대상 광역이어야 합니다: ${opts.skill} (${def.target})`);
  }
  const telegraphSec = opts.telegraph !== null ? opts.telegraph : telegraphSecOf(def);
  const radius = opts.radius !== null ? opts.radius : def.radius ?? 2.5;
  const map: MapType = opts.map === 'random' ? 'plains' : opts.map;
  const job: MainJob = 'swordsman';

  const specs: DodgeUnitSpec[] = [
    { label: '판단력 80·민첩 70', judgment: 80, agility: 70, moveSpeed: opts.move, target: { kind: 'min', value: 0.5 } },
    { label: '판단력 30·민첩 30', judgment: 30, agility: 30, moveSpeed: opts.move, target: { kind: 'max', value: 0.3 } },
    { label: '참고: 판단력 30·민첩 30·이동속도 20', judgment: 30, agility: 30, moveSpeed: 20, target: null },
  ];

  const ticks = Math.max(0, Math.round(telegraphSec * TICK_RATE));
  const reachSec = ticks * TICK_DT;

  const units: DodgeUnitResult[] = [];
  for (let si = 0; si < specs.length; si++) {
    const spec = specs[si];
    const unit = syntheticCharacter(`dodge_${si}`, spec.label, job, 40, {
      judgment: spec.judgment,
      agility: spec.agility,
      moveSpeed: spec.moveSpeed,
    }, []);
    const derived = computeDerived(unit, map);
    const escapeSpeed = derived.moveSpeed * DODGE_SPEED_MULT;
    const reachDist = reachSec * escapeSpeed;
    const needDistCenter = radius + DODGE_ESCAPE_MARGIN;
    const chance = dodgeChanceFormula(spec.judgment, spec.agility, telegraphSec);

    // ── 공식 + 이동 판정 (유닛당 trials 회) ──
    const rng = new Rng(hashSeed(`${opts.seed}:dodge:formula:${si}`));
    let perceived = 0;
    let escapedCenter = 0;
    let escapedRandom = 0;
    for (let t = 0; t < opts.trials; t++) {
      // 임의 위치: 면적 균등 (r = R·√u). 필요 거리 = (R − r) + 여유
      const r = radius * Math.sqrt(rng.next());
      const needRandom = radius - r + DODGE_ESCAPE_MARGIN;
      if (telegraphSec <= 0) continue; // 예고 없는 스킬은 회피 판정 없음
      if (!rng.chance(chance)) continue;
      perceived++;
      if (reachDist + 1e-9 >= needDistCenter) escapedCenter++;
      if (reachDist + 1e-9 >= needRandom) escapedRandom++;
    }
    const dodgeRateCenter = opts.trials > 0 ? escapedCenter / opts.trials : 0;
    const dodgeRateRandom = opts.trials > 0 ? escapedRandom / opts.trials : 0;
    const judge = (rate: number): boolean | null => {
      if (!spec.target) return null;
      return spec.target.kind === 'min' ? rate >= spec.target.value : rate < spec.target.value;
    };

    // ── 실전 표본: 시전자 1 vs 시험 유닛 2 (같은 유닛 2기 — 광역 AI 조건 '적 2명 이상' 충족용) ──
    const battle: DodgeUnitResult['battle'] = {
      battles: 0, zones: 0, attempts: 0, dodgeEvents: 0, exposed: 0, avoided: 0, dodgedEscaped: 0, dodgedHit: 0,
      perceivedRate: 0, dodgeRate: 0, pass: null, note: '',
    };
    try {
      const caster = syntheticCharacter('dodge_caster', '시험 시전자', def.job, 40, {
        vitality: 100, defenseTech: 100, resistance: 100, magicPower: 60, strength: 60, mana: 100, manaRegen: 100,
        castSpeed: 40, judgment: 60, accuracy: 60, moveSpeed: 30, stamina: 100,
      }, [def.id]);
      caster.derivedMult = { maxHp: 30, physAtk: 0.6, magAtk: 0.6 };
      const targets: Character[] = [];
      for (let k = 0; k < 2; k++) {
        const tgt = syntheticCharacter(`dodge_${si}_t${k}`, `${spec.label} ${k + 1}`, job, 40, {
          // 지구력 100: 표본 전투가 길어(시전자 HP ×30) 30초 이후 피로로 이동속도가 깎이면 회피가 아니라 피로를 재게 된다
          judgment: spec.judgment, agility: spec.agility, moveSpeed: spec.moveSpeed, vitality: 100, strength: 1, stamina: 100,
        }, []);
        tgt.derivedMult = { maxHp: 30, physAtk: 0.05 };
        targets.push(tgt);
      }
      const targetIds = new Set(targets.map((t) => t.id));
      const maxBattles = Math.max(1, Math.min(opts.trials, 200));
      for (let g = 0; g < maxBattles && battle.zones < opts.trials; g++) {
        const input: BattleInput = {
          seed: hashSeed(`${opts.seed}:dodge:battle:${si}:${g}`),
          map,
          teamA: { id: 'dodge_a', name: '시전자', members: [deepClone(caster)], synergies: [] },
          teamB: { id: 'dodge_b', name: '시험 유닛', members: targets.map((t) => deepClone(t)), synergies: [] },
        };
        const tracked = runBattleTracked(
          input,
          (z) => z.side === 'A' && z.skillId === def.id,
          (u) => targetIds.has(u.id),
        );
        battle.battles++;
        battle.zones += tracked.zones.damageZones;
        battle.attempts += tracked.zones.dodgeAttempts;
        battle.dodgeEvents += tracked.zones.dodgeEvents;
        battle.exposed += tracked.zones.impactExposed;
        battle.avoided += tracked.zones.impactAvoided;
        battle.dodgedEscaped += tracked.zones.dodgedEscaped;
        battle.dodgedHit += tracked.zones.dodgedHit;
        // 영역이 하나도 안 생기는 sim 이면 첫 판에서 멈춘다 (시간 낭비 방지)
        if (g === 0 && tracked.zones.damageZones === 0 && tracked.zones.zoneEvents === 0) break;
      }
      battle.perceivedRate = battle.attempts > 0 ? battle.dodgeEvents / battle.attempts : 0;
      battle.dodgeRate = battle.exposed > 0 ? battle.dodgedEscaped / battle.exposed : 0;
      if (battle.zones === 0) {
        battle.note = '측정 불가 — 실전에서 광역 영역(Zone)이 생성되지 않음 (sim 미구현 또는 스킬 미발동)';
      } else if (battle.exposed === 0) {
        battle.note = '측정 불가 — 예고 시작 시 영역 안에 시험 유닛이 없었음';
      } else {
        battle.pass = judge(battle.dodgeRate);
        battle.note = `${battle.battles}판, 영역 ${battle.zones}개`;
      }
    } catch (e) {
      battle.note = `실전 표본 실패: ${(e as Error).message}`;
    }

    units.push({
      label: spec.label,
      judgment: spec.judgment,
      agility: spec.agility,
      moveSpeed: spec.moveSpeed,
      chance,
      perceivedRate: opts.trials > 0 ? perceived / opts.trials : 0,
      reachSec,
      reachDist,
      needDistCenter,
      dodgeRateCenter,
      dodgeRateRandom,
      trials: opts.trials,
      target: spec.target,
      pass: judge(dodgeRateCenter),
      battle,
    });
  }

  const targeted = units.filter((u) => u.target !== null);
  const formulaPass = targeted.every((u) => u.pass === true);
  const battleJudged = targeted.filter((u) => u.battle.pass !== null);
  const battlePass = battleJudged.length === targeted.length && targeted.length > 0
    ? battleJudged.every((u) => u.battle.pass === true)
    : null;

  return {
    mode: 'dodge',
    seed: opts.seed,
    trials: opts.trials,
    skillId: def.id,
    skillName: def.name,
    telegraphSec,
    radius,
    map,
    simCheck: checkSimDodgeChance(telegraphSec),
    units,
    formulaPass,
    battlePass,
    pass: formulaPass && battlePass !== false,
  };
}

function targetLabel(t: DodgeUnitSpec['target']): string {
  if (!t) return '참고';
  return t.kind === 'min' ? `≥ ${Math.round(t.value * 100)}%` : `< ${Math.round(t.value * 100)}%`;
}

function passLabel(p: boolean | null): string {
  return p === null ? '-' : p ? 'PASS' : 'FAIL';
}

function printDodge(r: DodgeReport): void {
  section(`광역 예고 회피율 (시드 ${r.seed}, 유닛당 ${r.trials}회, 스킬 ${r.skillName}[${r.skillId}], 예고 ${fixed(r.telegraphSec, 2)}초, 반경 ${fixed(r.radius, 1)}, 맵 ${MAP_NAME_KO[r.map]})`);
  console.log('회피 확률 = clamp(판단력 × 0.006 + 민첩 × 0.003, 0.05, 0.85), 예고 0.5초 미만이면 절반 (GDD §4.4, v0.5 보정: 기본항 0.10 → 0).');
  console.log(`인지에 성공한 유닛은 이동속도 × ${DODGE_SPEED_MULT} 로 영역 밖 (+${DODGE_ESCAPE_MARGIN} 여유) 까지 달린다. 예고 시간 안에 못 나가면 맞는다.`);
  console.log(`sim 공식 대조: ${r.simCheck.note}`);

  section('공식 + 이동 판정 (유닛은 영역 중심에 서 있다고 가정. 임의 위치는 면적 균등)');
  printTable(
    ['유닛', '이동속도', '인지 확률', '관측 인지율', '이동 가능', '필요(중심)', '실제 회피율(중심)', '실제 회피율(임의)', '목표', '판정'],
    r.units.map((u) => [
      u.label,
      String(u.moveSpeed),
      pctOf(u.chance),
      pctOf(u.perceivedRate),
      `${fixed(u.reachDist, 2)} (${fixed(u.reachSec, 2)}초)`,
      fixed(u.needDistCenter, 2),
      pctOf(u.dodgeRateCenter),
      pctOf(u.dodgeRateRandom),
      targetLabel(u.target),
      passLabel(u.pass),
    ]),
    ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l'],
  );
  console.log('이동 가능 거리가 필요 거리보다 짧으면 인지해도 맞습니다 (이동속도가 낮은 유닛의 회피율이 여기서 떨어집니다).');

  section('실전 표본 (시전자 1기 vs 시험 유닛 2기, 지구력 100 으로 피로 배제. 실제 전투에서 zone / dodge 이벤트와 impact 시점 위치를 추적)');
  printTable(
    ['유닛', '전투', '영역', '회피 판정', 'dodge 이벤트', '노출', '벗어남(전체)', '회피로 벗어남', '인지 후 맞음', '인지율', '실제 회피율', '목표', '판정', '비고'],
    r.units.map((u) => [
      u.label,
      String(u.battle.battles),
      String(u.battle.zones),
      String(u.battle.attempts),
      String(u.battle.dodgeEvents),
      String(u.battle.exposed),
      String(u.battle.avoided),
      String(u.battle.dodgedEscaped),
      String(u.battle.dodgedHit),
      u.battle.attempts > 0 ? pctOf(u.battle.perceivedRate) : '-',
      u.battle.exposed > 0 ? pctOf(u.battle.dodgeRate) : '-',
      targetLabel(u.target),
      passLabel(u.battle.pass),
      u.battle.note,
    ]),
    ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l', 'l'],
  );
  console.log("실제 회피율 = 회피로 벗어남 / 노출. '벗어남(전체)' 는 일반 이동으로 우연히 나간 경우까지 포함한 참고값.");

  console.log('');
  console.log(`보정 목표 [4] 회피 — 공식+이동 판정: ${r.formulaPass ? 'PASS' : 'FAIL'}, 실전 표본: ${r.battlePass === null ? '측정 불가' : r.battlePass ? 'PASS' : 'FAIL'}`);
  console.log(r.pass ? '결과: PASS' : '결과: FAIL');
  const weak = r.units.find((u) => u.target && u.target.kind === 'max');
  if (weak && weak.pass === false && weak.perceivedRate >= 0.3) {
    console.log(
      `참고: 판단력 30·민첩 30 의 인지 확률이 ${pctOf(weak.chance)} 라 이동속도 ${weak.moveSpeed} 로 전부 벗어나면 30% 를 넘습니다. ` +
        '이 목표는 느린 유닛이 인지해도 못 벗어나는 것을 전제로 하므로, 반경·예고 시간·이동속도 조합(--radius / --telegraph / --move)을 바꿔 보거나 공식 계수를 낮춰야 합니다.',
    );
  }
}

// ───────────────────────── 진입점 ─────────────────────────

async function main(): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    printHelp();
    return 2;
  }
  if (opts.help) {
    printHelp();
    return 0;
  }

  try {
    if (opts.determinism) {
      const rep = runDeterminism(opts);
      if (opts.json) console.log(JSON.stringify(rep, null, 2));
      else printDeterminism(rep);
      return rep.pass ? 0 : 1;
    }

    if (opts.dodge) {
      const rep = runDodge(opts);
      if (opts.json) console.log(JSON.stringify(rep, null, 2));
      else printDodge(rep);
      return rep.pass ? 0 : 1;
    }

    if (opts.monster) {
      await loadGrowthModules();
      const rep = runMonsterCalibration(opts);
      if (opts.json) console.log(JSON.stringify(rep, null, 2));
      else printMonster(rep);
      return 0;
    }

    if (opts.rarity) {
      await loadGrowthModules();
      const rep = runRarity(opts);
      if (opts.json) console.log(JSON.stringify(rep, null, 2));
      else printRarity(rep);
      return rep.floorTests.every((f) => f.pass) ? 0 : 1;
    }

    if (opts.growth) {
      await loadGrowthModules();
      const rep = runGrowth(opts);
      if (opts.json) console.log(JSON.stringify(rep, null, 2));
      else printGrowth(rep);
      return rep.subJobPass && rep.finished ? 0 : 1;
    }

    const summary = runBatch(opts);
    if (opts.json) console.log(JSON.stringify(summary, null, 2));
    else printBatch(summary);
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}

process.exitCode = await main();
