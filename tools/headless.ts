/**
 * 헤드리스 대량 시뮬레이션 CLI.
 *
 *   npm run headless -- --games 200 --seed 1 [--map plains] [--cycle 5] [--json]
 *   npm run headless -- --determinism [--seed 1] [--map dark] [--cycle 5]
 *   npm run headless -- --growth [--seed 1] [--json]
 *
 * 외부 의존성 없음. 난수는 전부 시드에서 파생한다 (Math.random / Date 금지).
 * DOM 을 쓰지 않으므로 node(tsx) 에서 그대로 실행된다.
 */

import {
  MAIN_JOBS,
  MAP_TYPES,
  JOB_NAME_KO,
  MAP_NAME_KO,
  TOTAL_CYCLES,
  SUBJOB_CHOICE_CYCLE_MIN,
  SUBJOB_CHOICE_CYCLE_MAX,
  type BattleFrame,
  type BattleInput,
  type BattleResult,
  type Character,
  type Choice,
  type MainJob,
  type MapType,
  type RunState,
  type Team,
  type TeamSide,
} from '../src/core/types';
import { Rng, hashSeed } from '../src/core/rng';
import { createBattle } from '../src/core/battle/sim';
import { generateOpponentTeam } from '../src/core/gen/charGen';
import { statTotal } from '../src/core/stats';
import { SKILLS, skillPoolFor } from '../src/core/data/skills';
import {
  newRun,
  selectTeam,
  battleInput,
  finishBattle,
  buySkill,
  finishBonus,
  pickChoice,
} from '../src/core/growth/run';

// ───────────────────────── 인자 파싱 ─────────────────────────

interface CliOptions {
  games: number;
  seed: number;
  map: MapType | 'random';
  cycle: number;
  determinism: boolean;
  growth: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    games: 100,
    seed: 1,
    map: 'random',
    cycle: 5,
    determinism: false,
    growth: false,
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
      case '--cycle':
        opts.cycle = Math.min(TOTAL_CYCLES, Math.max(1, parseIntStrict(value(key), key)));
        break;
      case '--determinism':
        opts.determinism = true;
        break;
      case '--growth':
        opts.growth = true;
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
      '헤드리스 전투 시뮬레이션 CLI',
      '',
      '사용법: npm run headless -- [옵션]',
      '',
      '  --games N        시뮬레이션 판 수 (기본 100)',
      '  --seed S         루트 시드 (기본 1)',
      '  --map M          plains | dark | desert | glacier | random (기본 random)',
      '  --cycle C        양 팀을 생성할 육성 사이클 1~10 (기본 5)',
      '  --determinism    같은 입력으로 전투를 두 번 돌려 틱별 프레임 해시를 비교',
      '  --growth         10사이클 육성을 헤드리스로 자동 진행하고 분화 보장을 검증',
      '  --json           요약을 JSON 으로 출력',
      '  --help           이 도움말',
    ].join('\n'),
  );
}

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

function fixed(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '-';
}

function section(title: string): void {
  console.log('');
  console.log(`== ${title} ==`);
}

// ───────────────────────── 프레임 해시 ─────────────────────────

/** 프레임 전체를 직렬화해 FNV-1a 32비트 해시. 결정론 검증용. */
function hashFrame(frame: BattleFrame): number {
  const payload = JSON.stringify({
    tick: frame.tick,
    timeSec: frame.timeSec,
    units: frame.units,
    events: frame.events,
    capture: frame.capture,
    finished: frame.finished,
  });
  return hashSeed(payload);
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
  const teamA = generateOpponentTeam(rngA, opts.cycle, map, `g${gameIndex}a`);
  const teamB = generateOpponentTeam(rngB, opts.cycle, map, `g${gameIndex}b`);
  return {
    seed: hashSeed(`${rootSeed}:${gameIndex}:battle`),
    map,
    teamA,
    teamB,
  };
}

// ───────────────────────── 대량 시뮬레이션 ─────────────────────────

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

interface BatchSummary {
  games: number;
  seed: number;
  cycle: number;
  mapOption: string;
  winsA: number;
  winsB: number;
  draws: number;
  avgDurationSec: number;
  perMap: Record<MapType, { games: number; winsA: number; winsB: number; draws: number; avgDurationSec: number }>;
  perJob: Record<MainJob, JobAgg & { winRate: number; avgDamage: number; avgHealing: number; survivalRate: number }>;
  topSkills: { skillId: string; name: string; uses: number }[];
  reasons: Record<string, number>;
}

function emptyJobAgg(): JobAgg {
  return { appearances: 0, wins: 0, draws: 0, damage: 0, healing: 0, kills: 0, survived: 0, skillsUsed: 0 };
}

function skillName(id: string): string {
  const def = SKILLS[id];
  return def ? def.name : id;
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
  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  let durationSum = 0;

  const showProgress = opts.games >= 20 && !opts.json;
  const progressEvery = Math.max(1, Math.floor(opts.games / 10));

  for (let g = 0; g < opts.games; g++) {
    const input = buildInput(opts.seed, g, opts);
    const result: BattleResult = createBattle(input).runToEnd();

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
      process.stderr.write(`\r진행 ${g + 1}/${opts.games}`);
      if (g + 1 === opts.games) process.stderr.write('\n');
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

  return {
    games: opts.games,
    seed: opts.seed,
    cycle: opts.cycle,
    mapOption: opts.map,
    winsA,
    winsB,
    draws,
    avgDurationSec: opts.games > 0 ? durationSum / opts.games : 0,
    perMap,
    perJob: perJobOut,
    topSkills,
    reasons,
  };
}

function printBatch(s: BatchSummary): void {
  const total = s.games;
  section(`전체 결과 (${total}판, 시드 ${s.seed}, 사이클 ${s.cycle}, 맵 ${s.mapOption === 'random' ? '랜덤' : MAP_NAME_KO[s.mapOption as MapType]})`);
  console.log(`A 승 ${pct(s.winsA, total)} (${s.winsA})  B 승 ${pct(s.winsB, total)} (${s.winsB})  무승부 ${pct(s.draws, total)} (${s.draws})`);
  console.log(`평균 전투 시간 ${fixed(s.avgDurationSec)}초`);

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
  pass: boolean;
  map: MapType;
  seed: number;
  ticks: number;
  firstDiffTick: number | null;
  detail: string;
  resultMatch: boolean;
  inputMutated: boolean;
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
  const maxTicks = 1_000_000;

  while (!(sim1.finished && sim2.finished) && ticks < maxTicks) {
    const f1 = sim1.step();
    const f2 = sim2.step();
    ticks++;
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
    pass: firstDiffTick === null && resultMatch,
    map: input.map,
    seed: input.seed,
    ticks,
    firstDiffTick,
    detail,
    resultMatch,
    inputMutated,
  };
}

/** 첫 불일치 프레임에서 어느 유닛의 어느 필드가 다른지 짧게 설명 */
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
  if (JSON.stringify(a.events) !== JSON.stringify(b.events)) return '이벤트 목록 불일치';
  if (JSON.stringify(a.capture) !== JSON.stringify(b.capture)) return '거점 상태 불일치';
  return '알 수 없는 차이 (직렬화 결과 불일치)';
}

function printDeterminism(r: DeterminismReport): void {
  section('결정론 검증');
  console.log(`맵 ${MAP_NAME_KO[r.map]}, 전투 시드 ${r.seed}, 진행 틱 ${r.ticks}`);
  console.log(`프레임 해시 비교: ${r.firstDiffTick === null ? 'PASS' : `FAIL (첫 불일치 틱 ${r.firstDiffTick})`}`);
  if (r.detail) console.log(`  ${r.detail}`);
  console.log(`최종 결과 비교: ${r.resultMatch ? 'PASS' : 'FAIL'}`);
  console.log(`입력 불변 검사: ${r.inputMutated ? '경고 - 시뮬레이터가 입력 객체를 변조함' : 'PASS'}`);
  console.log('');
  console.log(r.pass ? '결과: PASS' : '결과: FAIL');
}

// ───────────────────────── 육성 헤드리스 ─────────────────────────

interface CycleRow {
  cycle: number;
  map: MapType;
  outcome: 'win' | 'lose' | 'draw';
  reason: string;
  durationSec: number;
  bonusEarned: number;
  skillsBought: number;
  avgStatTotal: number;
  choices: string[];
}

interface SubJobCheck {
  charId: string;
  name: string;
  job: MainJob;
  scheduledCycle: number | null;
  /** 분화 선택지가 등장한 (사이클, 선택 순번) */
  appearances: { cycle: number; index: number }[];
  /** 직업 변경이 적용된 (사이클, 선택 순번). 이후의 분화 등장은 정당한 재분화 */
  jobChanges: { cycle: number; index: number }[];
  finalSubJob: string | null;
  ok: boolean;
}

interface GrowthReport {
  seed: number;
  teamName: string;
  members: { id: string; name: string; job: MainJob }[];
  cycles: CycleRow[];
  wins: number;
  loses: number;
  draws: number;
  finalAvgStatTotal: number;
  finalBonusPoints: number;
  subJobChecks: SubJobCheck[];
  subJobPass: boolean;
  finished: boolean;
}

/** 풀에서 서로 다른 직업 5명을 앞에서부터 고른다. 직업이 5종 미만이면 나머지는 순서대로 채운다. */
function pickDistinctJobs(pool: Character[]): string[] {
  const ids: string[] = [];
  const seen = new Set<MainJob>();
  for (const c of pool) {
    if (ids.length >= 5) break;
    if (seen.has(c.mainJob)) continue;
    seen.add(c.mainJob);
    ids.push(c.id);
  }
  for (const c of pool) {
    if (ids.length >= 5) break;
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

/** 살 수 있는 가장 싼 스킬을 계속 구매한다. 구매 횟수를 반환. */
function buyCheapestSkills(state: RunState): number {
  let bought = 0;
  const guard = 100;
  for (let iter = 0; iter < guard; iter++) {
    const team = state.team;
    if (!team) break;
    // 팀 전체 후보 중 최저가 (동가면 캐릭터 순서 → 스킬 id 순서)
    let best: { charId: string; skillId: string; cost: number } | null = null;
    for (const c of team.members) {
      const pool = skillPoolFor(c).slice().sort();
      for (const sid of pool) {
        const def = SKILLS[sid];
        if (!def) continue;
        if (def.cost > state.bonusPoints) continue;
        if (best === null || def.cost < best.cost) best = { charId: c.id, skillId: sid, cost: def.cost };
      }
    }
    if (!best) break;
    const before = state.bonusPoints;
    const ok = buySkill(state, best.charId, best.skillId);
    if (!ok) {
      // 구매가 거절되면 (슬롯 가득 참 등) 더 시도해도 같은 결과이므로 중단
      break;
    }
    bought++;
    if (state.bonusPoints >= before && best.cost > 0) break; // 포인트가 줄지 않으면 무한 루프 방지
  }
  return bought;
}

function runGrowth(opts: CliOptions): GrowthReport {
  const state = newRun(opts.seed);
  const ids = pickDistinctJobs(state.pool);
  const teamName = '헤드리스 검증팀';
  selectTeam(state, ids, teamName);

  const team = state.team;
  if (!team) throw new Error('selectTeam 이후 team 이 null 입니다.');
  const members = team.members.map((m: Character) => ({ id: m.id, name: m.name, job: m.mainJob }));
  const scheduled: Record<string, number | null> = {};
  for (const m of team.members) {
    const v = state.subJobChoiceCycle[m.id];
    scheduled[m.id] = typeof v === 'number' ? v : null;
  }

  // 캐릭터별 분화 선택지 등장 기록 (같은 세대(사이클,순번)는 한 번만)
  const appearances = new Map<string, { cycle: number; index: number }[]>();
  for (const m of team.members) appearances.set(m.id, []);
  const noteSubJobChoices = (choices: Choice[], cycle: number, index: number): void => {
    const seenThisGen = new Set<string>();
    for (const ch of choices) {
      if (ch.kind !== 'subjob') continue;
      const targets = new Set<string>(ch.charIds);
      for (const e of ch.effects) if (e.kind === 'set_subjob') targets.add(e.charId);
      for (const cid of targets) {
        if (seenThisGen.has(cid)) continue;
        seenThisGen.add(cid);
        const list = appearances.get(cid);
        if (list) list.push({ cycle, index });
      }
    }
  };

  // 캐릭터별 직업 변경 기록 (이후의 분화 등장은 재분화로 인정)
  const jobChanges = new Map<string, { cycle: number; index: number }[]>();
  for (const m of team.members) jobChanges.set(m.id, []);

  const cycles: CycleRow[] = [];
  let wins = 0;
  let loses = 0;
  let draws = 0;
  let stepGuard = 0;
  const maxSteps = TOTAL_CYCLES * 20;

  while (state.phase !== 'done' && stepGuard < maxSteps) {
    stepGuard++;
    if (state.phase === 'pre_battle' || state.phase === 'battle') {
      const cycle = state.cycle;
      const input = battleInput(state);
      const result = createBattle(input).runToEnd();
      finishBattle(state, result);
      const rec = state.history[state.history.length - 1];
      const outcome: CycleRow['outcome'] = result.winner === 'A' ? 'win' : result.winner === 'B' ? 'lose' : 'draw';
      if (outcome === 'win') wins++;
      else if (outcome === 'lose') loses++;
      else draws++;
      cycles.push({
        cycle,
        map: input.map,
        outcome,
        reason: result.reason,
        durationSec: result.durationSec,
        bonusEarned: rec && rec.cycle === cycle ? rec.bonusEarned : 0,
        skillsBought: 0,
        avgStatTotal: 0,
        choices: [],
      });
      continue;
    }
    if (state.phase === 'bonus') {
      const bought = buyCheapestSkills(state);
      const row = cycles[cycles.length - 1];
      if (row) row.skillsBought = bought;
      finishBonus(state);
      continue;
    }
    if (state.phase === 'choice') {
      const row = cycles[cycles.length - 1];
      const cycle = state.cycle;
      let choiceGuard = 0;
      while (state.phase === 'choice' && state.cycle === cycle && choiceGuard < 10) {
        choiceGuard++;
        noteSubJobChoices(state.currentChoices, cycle, state.choiceIndex);
        const picked = state.currentChoices[0];
        const pickedIndex = state.choiceIndex;
        const r = pickChoice(state, 0);
        if (picked && picked.kind === 'job_change') {
          for (const e of picked.effects) {
            if (e.kind !== 'change_job') continue;
            const list = jobChanges.get(e.charId);
            if (list) list.push({ cycle, index: pickedIndex });
          }
        }
        if (row && picked) {
          const tag = r.success === null ? '' : r.success ? ' (성공)' : ' (실패)';
          row.choices.push(`${picked.title}${tag}`);
        }
      }
      if (row) row.avgStatTotal = avgStatTotal(state.team);
      continue;
    }
    if (state.phase === 'select_team') {
      throw new Error('selectTeam 이후에도 phase 가 select_team 입니다.');
    }
  }

  // 마지막 사이클 행의 평균 스탯이 비어 있으면 채운다
  for (const row of cycles) if (row.avgStatTotal === 0) row.avgStatTotal = avgStatTotal(state.team);

  const finalTeam = state.team ?? team;
  const subJobChecks: SubJobCheck[] = finalTeam.members.map((m: Character) => {
    const apps = appearances.get(m.id) ?? [];
    const changes = jobChanges.get(m.id) ?? [];
    const cyclesSeen = [...new Set(apps.map((a) => a.cycle))];
    // 판정: 첫 분화 등장은 [MIN, MAX] 안에 있어야 한다. 추가 등장은 직전 등장 이후에 직업 변경이 있었을 때만 인정(재분화).
    // 직업 변경이 마지막 선택(10사이클 3번째)에서는 나오지 않으므로 최종 세부 직업도 있어야 한다.
    const order = (p: { cycle: number; index: number }): number => p.cycle * 10 + p.index;
    let ok = cyclesSeen.length >= 1 && cyclesSeen[0] >= SUBJOB_CHOICE_CYCLE_MIN && cyclesSeen[0] <= SUBJOB_CHOICE_CYCLE_MAX;
    for (let i = 1; i < cyclesSeen.length && ok; i++) {
      const prevLast = apps.filter((a) => a.cycle === cyclesSeen[i - 1]).map(order).reduce((a, b) => Math.max(a, b), 0);
      const thisFirst = apps.filter((a) => a.cycle === cyclesSeen[i]).map(order).reduce((a, b) => Math.min(a, b), Infinity);
      const changedBetween = changes.some((jc) => order(jc) >= prevLast && order(jc) < thisFirst);
      if (!changedBetween) ok = false;
    }
    if (ok && m.subJob === null) ok = false;
    return {
      charId: m.id,
      name: m.name,
      job: m.mainJob,
      scheduledCycle: scheduled[m.id] ?? null,
      appearances: apps,
      jobChanges: changes,
      finalSubJob: m.subJob,
      ok,
    };
  });

  return {
    seed: opts.seed,
    teamName,
    members,
    cycles,
    wins,
    loses,
    draws,
    finalAvgStatTotal: avgStatTotal(state.team),
    finalBonusPoints: state.bonusPoints,
    subJobChecks,
    subJobPass: subJobChecks.every((c) => c.ok),
    finished: state.phase === 'done',
  };
}

function printGrowth(r: GrowthReport): void {
  section(`육성 헤드리스 (시드 ${r.seed}, 팀 "${r.teamName}")`);
  console.log(
    '팀원: ' + r.members.map((m) => `${m.name}(${JOB_NAME_KO[m.job]})`).join(', '),
  );

  section('사이클별 진행');
  printTable(
    ['사이클', '맵', '결과', '사유', '시간', '보너스', '스킬 구매', '평균 스탯합', '선택'],
    r.cycles.map((c) => [
      String(c.cycle),
      MAP_NAME_KO[c.map],
      c.outcome === 'win' ? '승' : c.outcome === 'lose' ? '패' : '무',
      c.reason,
      fixed(c.durationSec, 0) + '초',
      String(c.bonusEarned),
      String(c.skillsBought),
      fixed(c.avgStatTotal, 1),
      c.choices.join(' / '),
    ]),
    ['r', 'l', 'l', 'l', 'r', 'r', 'r', 'r', 'l'],
  );
  console.log('');
  console.log(
    `전적 ${r.wins}승 ${r.loses}패 ${r.draws}무, 최종 평균 스탯합 ${fixed(r.finalAvgStatTotal, 1)}, 남은 보너스 ${r.finalBonusPoints}, 완료 ${r.finished ? '예' : '아니오 (phase 가 done 에 도달하지 못함)'}`,
  );

  section(`직업 분화 보장 검증 (첫 등장이 사이클 ${SUBJOB_CHOICE_CYCLE_MIN}~${SUBJOB_CHOICE_CYCLE_MAX} 사이, 추가 등장은 직업 변경 후 재분화만 인정)`);
  printTable(
    ['캐릭터', '직업', '예정 사이클', '등장 (사이클:순번)', '직업 변경', '최종 세부직업', '판정'],
    r.subJobChecks.map((c) => [
      c.name,
      JOB_NAME_KO[c.job],
      c.scheduledCycle === null ? '-' : String(c.scheduledCycle),
      c.appearances.length === 0 ? '없음' : c.appearances.map((a) => `${a.cycle}:${a.index}`).join(', '),
      c.jobChanges.length === 0 ? '-' : c.jobChanges.map((a) => `${a.cycle}:${a.index}`).join(', '),
      c.finalSubJob ?? '-',
      c.ok ? 'PASS' : 'FAIL',
    ]),
    ['l', 'l', 'r', 'l', 'l', 'l', 'l'],
  );
  console.log('');
  console.log(r.subJobPass ? '분화 보장: PASS' : '분화 보장: FAIL');
}

// ───────────────────────── 진입점 ─────────────────────────

function main(): number {
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

  if (opts.determinism) {
    const rep = runDeterminism(opts);
    if (opts.json) console.log(JSON.stringify(rep, null, 2));
    else printDeterminism(rep);
    return rep.pass ? 0 : 1;
  }

  if (opts.growth) {
    const rep = runGrowth(opts);
    if (opts.json) console.log(JSON.stringify(rep, null, 2));
    else printGrowth(rep);
    return rep.subJobPass && rep.finished ? 0 : 1;
  }

  const summary = runBatch(opts);
  if (opts.json) console.log(JSON.stringify(summary, null, 2));
  else printBatch(summary);
  return 0;
}

process.exitCode = main();
