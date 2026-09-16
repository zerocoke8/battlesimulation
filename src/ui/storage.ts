/**
 * localStorage 접근 전담 모듈. 다른 모듈은 localStorage 를 직접 만지지 않는다.
 * 모든 접근은 try/catch 로 감싼다 (프라이빗 모드, 용량 초과, 차단 등).
 *
 * 저장 형식 버전 (SAVE_VERSION):
 *  - 저장은 항상 { v: SAVE_VERSION, data } 봉투에 담는다.
 *  - 버전이 다르면(= v0.3 이전의 사이클 기반 저장 포함) 조용히 버린다. 경고도 마이그레이션도 하지 않는다.
 *
 * 불러온 팀 데이터는 현재 데이터 정의(스킬/세부 직업/직업)와 대조해 정리한다:
 * 스킬이 이름 변경·삭제된 뒤 남은 옛 저장은 computeDerived(getSkill) 에서 예외를 던져
 * 전투 준비 자체를 막으므로, 알 수 없는 id 는 여기서 제거한다.
 */
import {
  BASE_STAT_KEYS,
  CHOICE_RARITY_ORDER,
  MAIN_JOBS,
  MAP_TYPES,
  MONSTER_TIER_ORDER,
  type Character,
  type ChoiceRarity,
  type GhostSnapshot,
  type MapType,
  type MonsterEncounter,
  type MonsterTier,
  type RunState,
  type Team,
} from '../core/types';
import { SKILLS } from '../core/data/skills';
import { SUBJOBS, jobOfSubJob } from '../core/data/jobs';

/** 저장 형식 버전. 구조가 바뀌면 올린다. 버전이 다른 저장 데이터는 조용히 폐기된다. */
export const SAVE_VERSION = 2;

const KEY_RUN = 'bs:run';
const KEY_GHOSTS = 'bs:ghosts';
const KEY_TEAMS = 'bs:teams';

/** 고스트 스냅샷 최대 보관 수 (오래된 것부터 버림) */
const MAX_GHOSTS = 300;
/** 완성 팀 최대 보관 수 */
const MAX_TEAMS = 30;

interface Envelope<T> {
  v: number;
  data: T;
}

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

/** 버전 봉투에서 데이터를 꺼낸다. 버전이 다르면 null (조용히 폐기) */
function readVersioned<T>(key: string): T | null {
  const raw = read<unknown>(key);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const env = raw as Partial<Envelope<T>>;
  if (env.v !== SAVE_VERSION) return null;
  if (env.data === undefined || env.data === null) return null;
  return env.data as T;
}

function writeVersioned(key: string, data: unknown): boolean {
  return write(key, { v: SAVE_VERSION, data });
}

// ───────────── 타입 가드 ─────────────

function isTeam(v: unknown): v is Team {
  if (!v || typeof v !== 'object') return false;
  const t = v as Partial<Team>;
  return typeof t.id === 'string' && typeof t.name === 'string' && Array.isArray(t.members) && Array.isArray(t.synergies);
}

function isGhost(v: unknown): v is GhostSnapshot {
  if (!v || typeof v !== 'object') return false;
  const g = v as Partial<GhostSnapshot>;
  return typeof g.runSeed === 'number' && typeof g.day === 'number' && isTeam(g.team) && typeof g.savedAt === 'string';
}

function isMapType(v: unknown): v is MapType {
  return typeof v === 'string' && (MAP_TYPES as readonly string[]).includes(v);
}

function isTier(v: unknown): v is MonsterTier {
  return typeof v === 'string' && (MONSTER_TIER_ORDER as readonly string[]).includes(v);
}

function isRarity(v: unknown): v is ChoiceRarity {
  return typeof v === 'string' && (CHOICE_RARITY_ORDER as readonly string[]).includes(v);
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
  // 몬스터 표시 정보: 난이도가 이상하면 일반 캐릭터로 취급
  if (c.monster !== undefined) {
    const m = c.monster as Partial<{ kind: string; tier: MonsterTier }>;
    if (!m || typeof m.kind !== 'string' || !isTier(m.tier)) delete c.monster;
  }
  if (c.derivedMult !== undefined && (c.derivedMult === null || typeof c.derivedMult !== 'object')) {
    delete c.derivedMult;
  }
  return true;
}

/**
 * 팀의 멤버·시너지를 정리한다.
 * 플레이어/상대 팀은 정확히 5명, 몬스터 팀은 1~5명이어야 한다 (min/max 로 지정).
 */
function sanitizeTeam(t: Team, min = 5, max = 5): Team | null {
  if (!isTeam(t)) return null;
  t.members = t.members.filter((c) => sanitizeCharacter(c));
  if (t.members.length < min || t.members.length > max) return null;
  const ids = new Set(t.members.map((c) => c.id));
  t.synergies = t.synergies.filter((s) => {
    if (!s || typeof s !== 'object' || !s.condition) return false;
    if (s.condition.kind === 'adjacency') return ids.has(s.condition.a) && ids.has(s.condition.b);
    return true;
  });
  return t;
}

/** 몬스터 인카운터 1장 정리. 쓸 수 없으면 false */
function sanitizeEncounter(e: MonsterEncounter): boolean {
  if (!e || typeof e !== 'object') return false;
  if (typeof e.id !== 'string' || typeof e.monsterId !== 'string' || typeof e.name !== 'string') return false;
  if (!isTier(e.tier) || !isMapType(e.map)) return false;
  if (!e.reward || typeof e.reward !== 'object' || typeof e.reward.points !== 'number') return false;
  if (e.reward.rarityFloor !== null && !isRarity(e.reward.rarityFloor)) e.reward.rarityFloor = null;
  if (typeof e.reward.teamStatBonus !== 'number') e.reward.teamStatBonus = 0;
  if (typeof e.desc !== 'string') e.desc = '';
  if (typeof e.estimatedPower !== 'number') e.estimatedPower = 0;
  const team = sanitizeTeam(e.team, 1, 5);
  if (!team) return false;
  e.team = team;
  return true;
}

// ───────────── 육성 진행 상태 ─────────────

export function saveRun(s: RunState): void {
  writeVersioned(KEY_RUN, s);
}

/**
 * 저장된 육성을 불러온다.
 * - 저장 버전이 다르면 null (조용히 폐기).
 * - 전투 관전 중에 저장된 것은 그 전투 직전 단계로 되돌린다 (battle → pre_battle, monster_battle → monster_select).
 */
export function loadRun(): RunState | null {
  const v = readVersioned<Partial<RunState>>(KEY_RUN);
  if (!v || typeof v !== 'object') return null;
  if (typeof v.seed !== 'number' || typeof v.phase !== 'string' || !Array.isArray(v.pool)) return null;
  const s = v as RunState;

  // 풀: 유효하지 않은 캐릭터만 제거 (선택 단계에서만 쓰인다)
  s.pool = s.pool.filter((c) => sanitizeCharacter(c));

  if (typeof s.day !== 'number' || !Number.isFinite(s.day)) s.day = 0;
  if (typeof s.step !== 'number' || !Number.isFinite(s.step)) s.step = 0;
  if (typeof s.bonusPoints !== 'number' || !Number.isFinite(s.bonusPoints)) s.bonusPoints = 0;
  if (typeof s.rerolls !== 'number' || !Number.isFinite(s.rerolls)) s.rerolls = 0;
  if (typeof s.pendingTeamStatBonus !== 'number' || !Number.isFinite(s.pendingTeamStatBonus)) s.pendingTeamStatBonus = 0;
  if (!isRarity(s.rarityFloor)) s.rarityFloor = null;
  if (!isMapType(s.currentMap)) s.currentMap = null;

  if (s.team) {
    s.team = sanitizeTeam(s.team);
    if (!s.team) return null; // 팀이 깨졌으면 이어할 수 없음
  } else {
    s.team = null;
  }
  if (s.opponent) {
    // 상대가 깨졌으면 비워 두면 UI 가 prepareNextBattle 로 다시 만든다
    s.opponent = sanitizeTeam(s.opponent);
    if (!s.opponent) s.currentMap = null;
  } else {
    s.opponent = null;
  }

  // 전투 관전 중 저장 → 그 전투 직전 단계로 되돌린다
  if (s.phase === 'battle') s.phase = 'pre_battle';
  if (s.phase === 'monster_battle') s.phase = 'monster_select';

  if (s.phase === 'monster_select') s.currentMonster = null;
  if (s.currentMonster && !sanitizeEncounter(s.currentMonster)) s.currentMonster = null;

  if (Array.isArray(s.monsterOptions)) {
    if (!s.monsterOptions.every((e) => sanitizeEncounter(e))) s.monsterOptions = null;
  } else {
    s.monsterOptions = null;
  }

  if (!Array.isArray(s.history)) s.history = [];
  if (!s.subJobChoiceDay || typeof s.subJobChoiceDay !== 'object') s.subJobChoiceDay = {};
  if (!Array.isArray(s.currentChoices)) s.currentChoices = [];
  // 희귀도/전투력 표시값이 없는 옛 선택지는 버린다 (UI 가 ensureChoices 로 다시 만든다)
  if (!s.currentChoices.every((c) => c && isRarity(c.rarity) && typeof c.powerDelta === 'number')) {
    s.currentChoices = [];
  }

  for (const rec of s.history) {
    if (!rec) continue;
    if (!Array.isArray(rec.choicesTaken)) rec.choicesTaken = [];
    rec.choicesTaken = rec.choicesTaken.filter((ct) => ct && typeof ct.title === 'string');
    for (const ct of rec.choicesTaken) if (!isRarity(ct.rarity)) ct.rarity = 'common';
    if (typeof rec.pointsEarned !== 'number') rec.pointsEarned = 0;
    if (rec.monster && !isTier(rec.monster.tier)) rec.monster = null;
    if (rec.teamSnapshot) {
      const snap = sanitizeTeam(rec.teamSnapshot);
      if (snap) rec.teamSnapshot = snap;
    }
  }
  return s;
}

export function clearRun(): void {
  remove(KEY_RUN);
}

// ───────────── 고스트 (일차별 팀 스냅샷) ─────────────

export function saveGhost(g: GhostSnapshot): void {
  const list = loadGhosts();
  const idx = list.findIndex((x) => x.runSeed === g.runSeed && x.day === g.day);
  if (idx >= 0) list[idx] = g;
  else list.push(g);
  while (list.length > MAX_GHOSTS) list.shift();
  writeVersioned(KEY_GHOSTS, list);
}

export function loadGhosts(): GhostSnapshot[] {
  const v = readVersioned<unknown>(KEY_GHOSTS);
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
  writeVersioned(KEY_TEAMS, list);
}

export function loadCompletedTeams(): Team[] {
  const v = readVersioned<unknown>(KEY_TEAMS);
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
  writeVersioned(KEY_TEAMS, list);
}

/** 모든 저장 데이터 삭제 */
export function clearAll(): void {
  remove(KEY_RUN);
  remove(KEY_GHOSTS);
  remove(KEY_TEAMS);
}
