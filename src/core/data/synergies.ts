/**
 * 팀 시너지 정의 생성기 (GDD §7.5).
 *  - generateSynergyCandidates: 로그라이크 선택지용 후보 (인접 / 직업 수 / 맵)
 *  - autoSynergies: 직업 조합으로 자동 부여되는 시너지
 * id 는 결정론적 문자열. 후보 목록은 항상 같은 순서로 만든 뒤 rng.sample 로 뽑는다.
 */
import type { Character, DerivedStatKey, MainJob, MapType, SynergyDef, Team } from '../types';
import { JOB_NAME_KO, MAIN_JOBS, MAP_NAME_KO, MAP_TYPES, DERIVED_NAME_KO } from '../types';
import type { Rng } from '../rng';

/** 인접 시너지 반경 (맵 단위) */
export const ADJ_RADIUS = 4;

// ───────────────────────── 인접 시너지 ─────────────────────────

type AdjMod = { key: DerivedStatKey; pct: number; label: string };

/** 인접 시너지 종류 (순서 고정) */
const ADJ_MODS: readonly AdjMod[] = [
  { key: 'physAtk', pct: 10, label: '합격' },
  { key: 'magAtk', pct: 10, label: '공명' },
  { key: 'physDef', pct: 10, label: '방진' },
  { key: 'magDef', pct: 10, label: '결계' },
  { key: 'castSpeed', pct: 10, label: '동조' },
  { key: 'atkSpeed', pct: 8, label: '연계' },
  { key: 'evasion', pct: 8, label: '엄호' },
  { key: 'maxHp', pct: 8, label: '결속' },
  { key: 'critChance', pct: 5, label: '급소 공유' },
];

/** 두 캐릭터의 직업에 어울리는 인접 보정만 고른다 (둘 중 하나라도 활용 가능해야 함). */
function adjModFits(a: Character, b: Character, mod: AdjMod): boolean {
  const jobs: MainJob[] = [a.mainJob, b.mainJob];
  const physJobs: MainJob[] = ['swordsman', 'tank', 'berserker', 'assassin', 'archer', 'sniper'];
  const magicJobs: MainJob[] = ['mage', 'summoner', 'healer'];
  const has = (list: MainJob[]) => jobs.some((j) => list.includes(j));
  switch (mod.key) {
    case 'physAtk':
    case 'atkSpeed':
    case 'critChance':
      return has(physJobs);
    case 'magAtk':
    case 'castSpeed':
      return has(magicJobs);
    default:
      return true;
  }
}

export function makeAdjacencySynergy(a: Character, b: Character, mod: AdjMod): SynergyDef {
  return {
    id: `syn_adj_${a.id}_${b.id}_${mod.key}`,
    name: `${mod.label}: ${a.name} & ${b.name}`,
    desc: `${a.name}와(과) ${b.name}이(가) 반경 ${ADJ_RADIUS} 안에 인접해 있으면 두 사람의 ${DERIVED_NAME_KO[mod.key]} +${mod.pct}%.`,
    condition: { kind: 'adjacency', a: a.id, b: b.id, adjRadius: ADJ_RADIUS },
    scope: 'involved',
    mods: { [mod.key]: mod.pct },
  };
}

// ───────────────────────── 직업 수 시너지 ─────────────────────────

/** 직업별 직업 수 시너지 보정 (해당 직업에게 적용). 순서 고정 */
const JOB_COUNT_MODS: Record<MainJob, { key: DerivedStatKey; base: number; label: string }[]> = {
  swordsman: [{ key: 'physAtk', base: 6, label: '검진' }, { key: 'physDef', base: 6, label: '철벽 진형' }],
  tank: [{ key: 'physDef', base: 8, label: '방패벽' }, { key: 'maxHp', base: 6, label: '굳건함' }],
  berserker: [{ key: 'physAtk', base: 8, label: '광란' }, { key: 'atkSpeed', base: 6, label: '피의 축제' }],
  assassin: [{ key: 'critChance', base: 4, label: '암살단' }, { key: 'evasion', base: 6, label: '그림자 무리' }],
  archer: [{ key: 'atkSpeed', base: 6, label: '일제 사격' }, { key: 'accuracy', base: 6, label: '사수 조직' }],
  sniper: [{ key: 'critMult', base: 8, label: '저격 조' }, { key: 'range', base: 4, label: '관측 지원' }],
  mage: [{ key: 'castSpeed', base: 8, label: '마법진' }, { key: 'magAtk', base: 6, label: '마력 공명' }],
  summoner: [{ key: 'maxHp', base: 6, label: '소환 결속' }, { key: 'mpRegen', base: 10, label: '마력의 샘' }],
  healer: [{ key: 'magAtk', base: 6, label: '성가대' }, { key: 'castSpeed', base: 8, label: '기도의 합창' }],
};

export function makeJobCountSynergy(job: MainJob, count: number, modIndex: number): SynergyDef {
  const mod = JOB_COUNT_MODS[job][modIndex];
  const pct = mod.base + 2 * count;
  return {
    id: `syn_job_${job}_${count}_${mod.key}`,
    name: `${mod.label} (${JOB_NAME_KO[job]} ${count}인)`,
    desc: `${JOB_NAME_KO[job]}가 ${count}명 이상이면 ${JOB_NAME_KO[job]} 전원의 ${DERIVED_NAME_KO[mod.key]} +${pct}%.`,
    condition: { kind: 'job_count', job, count },
    scope: 'involved',
    mods: { [mod.key]: pct },
  };
}

// ───────────────────────── 맵 시너지 ─────────────────────────

const MAP_MODS: Record<MapType, { key: DerivedStatKey; pct: number; label: string; stealth?: number }[]> = {
  plains: [{ key: 'range', pct: 8, label: '개활지 사격' }, { key: 'accuracy', pct: 8, label: '넓은 시야' }],
  dark: [{ key: 'evasion', pct: 10, label: '어둠 속의 그림자', stealth: 1 }, { key: 'magAtk', pct: 8, label: '밤의 마력' }],
  desert: [{ key: 'maxHp', pct: 8, label: '사막의 인내' }, { key: 'physDef', pct: 8, label: '모래 방벽' }],
  glacier: [{ key: 'moveSpeed', pct: 10, label: '빙판 적응' }, { key: 'magAtk', pct: 8, label: '서리의 힘' }],
};

export function makeMapSynergy(map: MapType, modIndex: number): SynergyDef {
  const mod = MAP_MODS[map][modIndex];
  const def: SynergyDef = {
    id: `syn_map_${map}_${mod.key}`,
    name: `${mod.label} (${MAP_NAME_KO[map]})`,
    desc: `${MAP_NAME_KO[map]} 맵에서 팀 전체 ${DERIVED_NAME_KO[mod.key]} +${mod.pct}%${mod.stealth ? `, 은신 지속 +${mod.stealth}초` : ''}.`,
    condition: { kind: 'map', map },
    scope: 'team',
    mods: { [mod.key]: mod.pct },
  };
  if (mod.stealth) def.bonusStealthSec = mod.stealth;
  return def;
}

// ───────────────────────── 후보 생성 ─────────────────────────

function jobCounts(team: Team): Record<MainJob, number> {
  const counts = {} as Record<MainJob, number>;
  for (const job of MAIN_JOBS) counts[job] = 0;
  for (const m of team.members) counts[m.mainJob]++;
  return counts;
}

/** 팀이 가질 수 있는 모든 시너지 후보 (순서 고정, 이미 보유한 id 제외) */
export function allSynergyCandidates(team: Team): SynergyDef[] {
  const owned = new Set(team.synergies.map((s) => s.id));
  const out: SynergyDef[] = [];
  const push = (s: SynergyDef) => {
    if (!owned.has(s.id)) out.push(s);
  };

  // 인접: 멤버 쌍 (i<j) × 어울리는 보정
  const members = team.members;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      for (const mod of ADJ_MODS) {
        if (adjModFits(members[i], members[j], mod)) push(makeAdjacencySynergy(members[i], members[j], mod));
      }
    }
  }

  // 직업 수: 실제 보유 수 기준
  const counts = jobCounts(team);
  for (const job of MAIN_JOBS) {
    const n = counts[job];
    if (n <= 0) continue;
    for (let k = 0; k < JOB_COUNT_MODS[job].length; k++) push(makeJobCountSynergy(job, n, k));
  }

  // 맵
  for (const map of MAP_TYPES) {
    for (let k = 0; k < MAP_MODS[map].length; k++) push(makeMapSynergy(map, k));
  }

  return out;
}

/**
 * 로그라이크 선택지용 시너지 후보 count 개.
 * 인접 후보가 압도적으로 많으므로 종류별로 균형 있게 뽑는다: 인접 / 직업 수 / 맵 을 번갈아 채운다.
 */
export function generateSynergyCandidates(team: Team, rng: Rng, count: number): SynergyDef[] {
  const all = allSynergyCandidates(team);
  const adj = rng.shuffle(all.filter((s) => s.condition.kind === 'adjacency'));
  const job = rng.shuffle(all.filter((s) => s.condition.kind === 'job_count'));
  const map = rng.shuffle(all.filter((s) => s.condition.kind === 'map'));
  const buckets = [adj, job, map];
  const weights = [3, 2, 1];
  const out: SynergyDef[] = [];
  while (out.length < count) {
    const available = buckets.map((b, i) => (b.length > 0 ? weights[i] : 0));
    if (available.every((w) => w === 0)) break;
    const idx = rng.weighted([0, 1, 2], available);
    const picked = buckets[idx].shift()!;
    out.push(picked);
  }
  return out;
}

// ───────────────────────── 자동 시너지 (직업 조합) ─────────────────────────

/** 직업 조합으로 자동 부여되는 시너지 (GDD 7.5). 팀 구성만으로 결정되므로 난수 없음 */
export function autoSynergies(team: Team): SynergyDef[] {
  const out: SynergyDef[] = [];
  const counts = jobCounts(team);
  const firstOf = (job: MainJob): Character | undefined => team.members.find((m) => m.mainJob === job);

  // 탱커 + 힐러 인접 시 탱커 방어 +10%
  const tank = firstOf('tank');
  const healer = firstOf('healer');
  if (tank && healer) {
    out.push({
      id: `syn_auto_tank_healer_${tank.id}_${healer.id}`,
      name: '수호의 맹세',
      desc: `${tank.name}(탱커)와(과) ${healer.name}(힐러)이(가) 반경 ${ADJ_RADIUS} 안에 인접하면 두 사람의 물리 방어 +10%, 이능 방어 +5%.`,
      condition: { kind: 'adjacency', a: tank.id, b: healer.id, adjRadius: ADJ_RADIUS },
      scope: 'involved',
      mods: { physDef: 10, magDef: 5 },
    });
  }

  // 마법사 3인 이상 시전속도 +15%
  if (counts.mage >= 3) {
    out.push({
      id: 'syn_auto_mage_circle',
      name: '대마법진',
      desc: '마법사가 3명 이상이면 마법사 전원의 시전 속도 +15%.',
      condition: { kind: 'job_count', job: 'mage', count: 3 },
      scope: 'involved',
      mods: { castSpeed: 15 },
    });
  }

  // 암살자 + 어둠 맵: 은신 지속 +2초
  if (counts.assassin >= 1) {
    out.push({
      id: 'syn_auto_assassin_dark',
      name: '어둠의 동맹',
      desc: '어둠 맵에서 팀의 은신 지속 +2초, 회피 +5%.',
      condition: { kind: 'map', map: 'dark' },
      scope: 'team',
      mods: { evasion: 5 },
      bonusStealthSec: 2,
    });
  }

  // 소환사 2인 이상: 소환 결속
  if (counts.summoner >= 2) {
    out.push({
      id: 'syn_auto_summoner_pact',
      name: '소환 계약',
      desc: '소환사가 2명 이상이면 소환사 전원의 최대 HP +10%, MP 회복 +10%.',
      condition: { kind: 'job_count', job: 'summoner', count: 2 },
      scope: 'involved',
      mods: { maxHp: 10, mpRegen: 10 },
    });
  }

  // 버서커 + 힐러 인접: 버서커가 마음껏 싸운다
  const berserker = firstOf('berserker');
  if (berserker && healer) {
    out.push({
      id: `syn_auto_berserker_healer_${berserker.id}_${healer.id}`,
      name: '광란의 축복',
      desc: `${berserker.name}(버서커)와(과) ${healer.name}(힐러)이(가) 인접하면 두 사람의 물리 공격 +8%, 최대 HP +5%.`,
      condition: { kind: 'adjacency', a: berserker.id, b: healer.id, adjRadius: ADJ_RADIUS },
      scope: 'involved',
      mods: { physAtk: 8, maxHp: 5 },
    });
  }

  // 원거리 딜러(궁수+저격수) 2인 이상: 평원 맵 사거리
  if (counts.archer + counts.sniper >= 2) {
    out.push({
      id: 'syn_auto_ranged_plains',
      name: '사선 확보',
      desc: '평원 맵에서 팀 전체 사거리 +6%, 적중 +5%.',
      condition: { kind: 'map', map: 'plains' },
      scope: 'team',
      mods: { range: 6, accuracy: 5 },
    });
  }

  // 검사 + 빙하 맵: 빙판 위 기동
  if (counts.swordsman >= 1) {
    out.push({
      id: 'syn_auto_swordsman_glacier',
      name: '빙판 검무',
      desc: '빙하 맵에서 팀 전체 이동 속도 +8%.',
      condition: { kind: 'map', map: 'glacier' },
      scope: 'team',
      mods: { moveSpeed: 8 },
    });
  }

  // 탱커 + 버서커 + 사막: 지구전
  if (counts.tank >= 1 && counts.berserker >= 1) {
    out.push({
      id: 'syn_auto_desert_march',
      name: '사막 행군',
      desc: '사막 맵에서 팀 전체 최대 HP +8%.',
      condition: { kind: 'map', map: 'desert' },
      scope: 'team',
      mods: { maxHp: 8 },
    });
  }

  return out;
}

/** 팀에 자동 시너지를 병합 (id 중복 제거, 기존 순서 유지). run.ts 등에서 사용 */
export function mergeAutoSynergies(team: Team): void {
  const owned = new Set(team.synergies.map((s) => s.id));
  for (const s of autoSynergies(team)) {
    if (!owned.has(s.id)) {
      team.synergies.push(s);
      owned.add(s.id);
    }
  }
}
