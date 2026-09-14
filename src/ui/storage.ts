/**
 * localStorage 접근 전담 모듈. 다른 모듈은 localStorage 를 직접 만지지 않는다.
 * 모든 접근은 try/catch 로 감싼다 (프라이빗 모드, 용량 초과, 차단 등).
 *
 * 불러온 팀 데이터는 현재 데이터 정의(스킬/세부 직업/직업)와 대조해 정리한다:
 * 스킬이 이름 변경·삭제된 뒤 남은 옛 저장은 computeDerived(getSkill) 에서 예외를 던져
 * 전투 준비 자체를 막으므로, 알 수 없는 id 는 여기서 제거한다.
 */
import { BASE_STAT_KEYS, MAIN_JOBS, MAP_TYPES, type Character, type GhostSnapshot, type RunState, type Team } from '../core/types';
import { SKILLS } from '../core/data/skills';
import { SUBJOBS, jobOfSubJob } from '../core/data/jobs';

const KEY_RUN = 'bs:run';
const KEY_GHOSTS = 'bs:ghosts';
const KEY_TEAMS = 'bs:teams';

/** 고스트 스냅샷 최대 보관 수 (오래된 것부터 버림) */
const MAX_GHOSTS = 300;
/** 완성 팀 최대 보관 수 */
const MAX_TEAMS = 30;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 무시 */
  }
}

function isTeam(v: unknown): v is Team {
  if (!v || typeof v !== 'object') return false;
  const t = v as Partial<Team>;
  return typeof t.id === 'string' && typeof t.name === 'string' && Array.isArray(t.members) && Array.isArray(t.synergies);
}

function isGhost(v: unknown): v is GhostSnapshot {
  if (!v || typeof v !== 'object') return false;
  const g = v as Partial<GhostSnapshot>;
  return typeof g.runSeed === 'number' && typeof g.cycle === 'number' && isTeam(g.team) && typeof g.savedAt === 'string';
}

// ───────────── 불러온 데이터 정리 ─────────────

function isMainJob(v: unknown): boolean {
  return typeof v === 'string' && (MAIN_JOBS as readonly string[]).includes(v);
}

/** 캐릭터의 스킬/세부 직업 id 를 현재 데이터 정의에 맞게 정리한다. 직업 자체가 유효하지 않으면 false */
function sanitizeCharacter(c: Character): boolean {
  if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !isMainJob(c.mainJob)) return false;
  if (!Array.isArray(c.skills)) c.skills = [];
  c.skills = c.skills.filter((id) => typeof id === 'string' && !!SKILLS[id]);
  if (c.subJob !== null && c.subJob !== undefined) {
    let ok = false;
    if (typeof c.subJob === 'string' && SUBJOBS[c.subJob]) {
      try {
        ok = jobOfSubJob(c.subJob) === c.mainJob;
      } catch {
        ok = false;
      }
    }
    if (!ok) c.subJob = null;
  } else {
    c.subJob = null;
  }
  return true;
}

/** 팀의 멤버·시너지를 정리한다. 유효한 멤버가 5명이 아니면 null (전투 입력으로 쓸 수 없음) */
function sanitizeTeam(t: Team): Team | null {
  if (!isTeam(t)) return null;
  t.members = t.members.filter((c) => sanitizeCharacter(c));
  if (t.members.length !== 5) return null;
  const ids = new Set(t.members.map((c) => c.id));
  t.synergies = t.synergies.filter((s) => {
    if (!s || typeof s !== 'object' || !s.condition) return false;
    if (s.condition.kind === 'adjacency') return ids.has(s.condition.a) && ids.has(s.condition.b);
    return true;
  });
  return t;
}

// ───────────── 육성 진행 상태 ─────────────

export function saveRun(s: RunState): void {
  write(KEY_RUN, s);
}

export function loadRun(): RunState | null {
  const v = read<Partial<RunState>>(KEY_RUN);
  if (!v || typeof v !== 'object') return null;
  if (typeof v.seed !== 'number' || typeof v.phase !== 'string' || !Array.isArray(v.pool)) return null;
  const s = v as RunState;
  // 풀: 유효하지 않은 캐릭터만 제거 (선택 단계에서만 쓰인다)
  s.pool = s.pool.filter((c) => sanitizeCharacter(c));
  if (s.team) {
    s.team = sanitizeTeam(s.team);
    if (!s.team) return null; // 팀이 깨졌으면 이어할 수 없음
  }
  if (s.opponent) {
    // 상대가 깨졌으면 비워 두면 UI 가 prepareNextBattle 로 다시 만든다
    s.opponent = sanitizeTeam(s.opponent);
    if (!s.opponent) s.currentMap = null;
  }
  if (!Array.isArray(s.history)) s.history = [];
  if (!s.subJobChoiceCycle || typeof s.subJobChoiceCycle !== 'object') s.subJobChoiceCycle = {};
  if (!Array.isArray(s.currentChoices)) s.currentChoices = [];
  for (const rec of s.history) {
    if (rec && rec.teamSnapshot) {
      const snap = sanitizeTeam(rec.teamSnapshot);
      if (snap) rec.teamSnapshot = snap;
    }
  }
  return s;
}

export function clearRun(): void {
  remove(KEY_RUN);
}

// ───────────── 고스트 (사이클별 팀 스냅샷) ─────────────

export function saveGhost(g: GhostSnapshot): void {
  const list = loadGhosts();
  const idx = list.findIndex((x) => x.runSeed === g.runSeed && x.cycle === g.cycle);
  if (idx >= 0) list[idx] = g;
  else list.push(g);
  while (list.length > MAX_GHOSTS) list.shift();
  write(KEY_GHOSTS, list);
}

export function loadGhosts(): GhostSnapshot[] {
  const v = read<unknown>(KEY_GHOSTS);
  if (!Array.isArray(v)) return [];
  const out: GhostSnapshot[] = [];
  for (const g of v) {
    if (!isGhost(g)) continue;
    const team = sanitizeTeam(g.team);
    if (!team) continue;
    g.team = team;
    out.push(g);
  }
  return out;
}

export function clearGhosts(): void {
  remove(KEY_GHOSTS);
}

// ───────────── 완성 팀 ─────────────

/** 팀 내용 지문 (id 제외). 같은 시드로 다시 육성한 다른 팀을 구분하고, 같은 팀의 중복 저장을 막는다. */
function teamFingerprint(t: Team): string {
  const members = t.members.map((c) => {
    const stats = BASE_STAT_KEYS.map((k) => c.stats[k] ?? 0).join(',');
    const adapt = MAP_TYPES.map((m) => c.adaptation[m] ?? 0).join(',');
    return `${c.name}|${c.mainJob}|${c.subJob ?? ''}|${stats}|${adapt}|${c.skills.join(',')}`;
  });
  const syn = t.synergies.map((s) => s.id).join(',');
  return `${t.name}#${members.join('#')}#${syn}`;
}

/** 같은 내용의 팀이 이미 저장되어 있는지 */
export function isTeamSaved(t: Team): boolean {
  const fp = teamFingerprint(t);
  return loadCompletedTeams().some((x) => teamFingerprint(x) === fp);
}

/**
 * 완성 팀 저장. 같은 내용이면 중복 저장하지 않는다.
 * id 가 겹치지만 내용이 다르면(같은 시드로 다시 육성) 기존 팀을 덮어쓰지 않고 새 id 로 추가한다.
 */
export function saveCompletedTeam(t: Team): void {
  const list = loadCompletedTeams();
  const fp = teamFingerprint(t);
  if (list.some((x) => teamFingerprint(x) === fp)) return;
  let id = t.id;
  if (list.some((x) => x.id === id)) {
    let n = 2;
    while (list.some((x) => x.id === `${t.id}_${n}`)) n++;
    id = `${t.id}_${n}`;
  }
  list.push({ ...t, id });
  while (list.length > MAX_TEAMS) list.shift();
  write(KEY_TEAMS, list);
}

export function loadCompletedTeams(): Team[] {
  const v = read<unknown>(KEY_TEAMS);
  if (!Array.isArray(v)) return [];
  const out: Team[] = [];
  for (const t of v) {
    if (!isTeam(t)) continue;
    const clean = sanitizeTeam(t);
    if (clean) out.push(clean);
  }
  return out;
}

export function deleteCompletedTeam(id: string): void {
  const list = loadCompletedTeams().filter((t) => t.id !== id);
  write(KEY_TEAMS, list);
}

/** 모든 저장 데이터 삭제 */
export function clearAll(): void {
  remove(KEY_RUN);
  remove(KEY_GHOSTS);
  remove(KEY_TEAMS);
}
