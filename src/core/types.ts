/**
 * 공용 타입 계약. 모든 모듈은 이 파일의 타입만 서로 참조한다.
 * 이 파일을 바꾸면 여러 모듈이 영향을 받으므로 변경 시 반드시 전체 typecheck.
 */

// ───────────────────────── 직업 ─────────────────────────

export const MAIN_JOBS = [
  'swordsman', // 검사
  'tank', // 탱커
  'berserker', // 버서커
  'assassin', // 암살자
  'archer', // 궁수
  'sniper', // 저격수
  'mage', // 마법사
  'summoner', // 소환사
  'healer', // 힐러
] as const;
export type MainJob = (typeof MAIN_JOBS)[number];

export const JOB_NAME_KO: Record<MainJob, string> = {
  swordsman: '검사', tank: '탱커', berserker: '버서커', assassin: '암살자', archer: '궁수',
  sniper: '저격수', mage: '마법사', summoner: '소환사', healer: '힐러',
};

/** 세부 직업 id. 예: 'mage_fire'. 정의는 data/jobs.ts */
export type SubJobId = string;

export type Role = 'melee_dps' | 'tank' | 'ranged_dps' | 'mage' | 'summoner' | 'healer' | 'assassin';

export interface SubJobDef {
  id: SubJobId;
  name: string; // 한국어 표시명
  desc: string;
  /** 분화 시 즉시 적용되는 스탯 보정 (절대값 가산) */
  statBonus: Partial<Record<BaseStatKey, number>>;
  /** 분화 후 성장 계수 추가 보정 (곱연산) */
  growthMod: Partial<Record<BaseStatKey, number>>;
  /** 분화 시 자동 습득 스킬 id */
  grantedSkills: string[];
  /** 세부 직업 전용 스킬 풀 id */
  skillPool: string[];
}

export interface JobDef {
  id: MainJob;
  name: string;
  role: Role;
  desc: string;
  /** 기본 공격 사거리 (맵 단위). 근접은 1.5 정도 */
  baseRange: number;
  /** 기본 공격이 물리인지 이능인지 */
  attackSchool: 'phys' | 'magic';
  /** 초기 스탯 생성 시 스탯별 평균 (1~100). 없는 스탯은 40 */
  statProfile: Partial<Record<BaseStatKey, number>>;
  /** 성장 계수 (0.5~1.5). 없는 스탯은 1.0 */
  growth: Partial<Record<BaseStatKey, number>>;
  /** HP 직업 보정 (가산) */
  hpBonus: number;
  /** 시작 시 갖는 스킬 후보 id (여기서 1개 랜덤 부여) */
  starterSkills: string[];
  /** 메인 직업 공통 스킬 풀 id */
  skillPool: string[];
  subJobs: SubJobDef[];
}

// ───────────────────────── 스탯 ─────────────────────────

export const BASE_STAT_KEYS = [
  // 신체
  'vitality', // 체력
  'strength', // 근력
  'agility', // 민첩
  'moveSpeed', // 이동속도
  'stamina', // 지구력
  // 정신
  'judgment', // 판단력
  'courage', // 용기
  'composure', // 침착
  'teamwork', // 협동
  'focus', // 집중
  // 기술
  'accuracy', // 명중
  'evasion', // 회피
  'defenseTech', // 방어기술
  'critical', // 치명
  'mastery', // 숙련도
  // 이능
  'magicPower', // 마력
  'mana', // 마력량
  'manaRegen', // 마력회복
  'castSpeed', // 시전속도
  'resistance', // 저항
] as const;
export type BaseStatKey = (typeof BASE_STAT_KEYS)[number];
export type StatBlock = Record<BaseStatKey, number>;

export type StatCategory = 'body' | 'mind' | 'skill' | 'magic';
export const STAT_CATEGORY: Record<BaseStatKey, StatCategory> = {
  vitality: 'body', strength: 'body', agility: 'body', moveSpeed: 'body', stamina: 'body',
  judgment: 'mind', courage: 'mind', composure: 'mind', teamwork: 'mind', focus: 'mind',
  accuracy: 'skill', evasion: 'skill', defenseTech: 'skill', critical: 'skill', mastery: 'skill',
  magicPower: 'magic', mana: 'magic', manaRegen: 'magic', castSpeed: 'magic', resistance: 'magic',
};
export const STAT_NAME_KO: Record<BaseStatKey, string> = {
  vitality: '체력', strength: '근력', agility: '민첩', moveSpeed: '이동속도', stamina: '지구력',
  judgment: '판단력', courage: '용기', composure: '침착', teamwork: '협동', focus: '집중',
  accuracy: '명중', evasion: '회피', defenseTech: '방어기술', critical: '치명', mastery: '숙련도',
  magicPower: '마력', mana: '마력량', manaRegen: '마력회복', castSpeed: '시전속도', resistance: '저항',
};
export const STAT_CATEGORY_NAME_KO: Record<StatCategory, string> = {
  body: '신체', mind: '정신', skill: '기술', magic: '이능',
};

export const STAT_MIN = 1;
export const STAT_MAX = 100;

// ───────────────────────── 맵 ─────────────────────────

export const MAP_TYPES = ['plains', 'dark', 'desert', 'glacier'] as const;
export type MapType = (typeof MAP_TYPES)[number];
export type Adaptation = Record<MapType, number>; // 각 1~100
export const MAP_NAME_KO: Record<MapType, string> = {
  plains: '평원', dark: '어둠', desert: '사막', glacier: '빙하',
};

export type VictoryRule =
  | 'annihilation' // 전멸만 (시간 초과 시 무승부)
  | 'annihilation_or_hp' // 전멸 또는 시간 초과 시 잔여 HP 합 비교
  | 'capture_or_annihilation'; // 거점 점령 또는 전멸

export interface MapDef {
  id: MapType;
  name: string;
  desc: string;
  width: number; // 맵 단위 (기본 40)
  height: number; // (기본 30)
  /** 시야 반경. 이 밖의 적은 타겟팅 불가. 0이면 무제한 */
  visionRadius: number;
  /** 지구력 소모 배율 (사막 2.0) */
  staminaDrainMult: number;
  /** 이동속도 배율 */
  moveSpeedMult: number;
  /** 이동 시 경로 오차 크기 (빙하). 0이면 없음 */
  slipFactor: number;
  /** 은신 지속시간 가산 초 (어둠) */
  stealthBonusSec: number;
  /** 특정 마법 계열 위력 배율. 예: { ice: 1.25 } */
  schoolBonus: Partial<Record<MagicSchool, number>>;
  /** 승리 규칙 */
  victory: VictoryRule;
  /** 제한 시간 (초) */
  timeLimitSec: number;
  /** 거점 (capture 규칙일 때). 점령에 필요한 누적 초 */
  capture?: { x: number; y: number; radius: number; secondsToCapture: number };
  /** 스폰 위치 (팀 A 왼쪽, 팀 B 오른쪽). 5개씩 */
  spawnA: { x: number; y: number }[];
  spawnB: { x: number; y: number }[];
}

// ───────────────────────── 스킬 ─────────────────────────

export type MagicSchool = 'fire' | 'lightning' | 'ice' | 'holy' | 'nature' | 'shadow' | 'none';

export type StatusKind =
  | 'stun' // 행동 불가
  | 'slow' // 이동속도 감소 (value = 감소 비율 0~1)
  | 'burn' // 초당 피해 (value = 초당 피해량)
  | 'poison' // 초당 피해, 방어 무시 (value = 초당 피해량)
  | 'freeze' // 행동 불가 + 받는 피해 증가
  | 'stealth' // 타겟팅 불가
  | 'taunt' // 시전자만 공격 (source 참조)
  | 'shield' // 피해 흡수 (value = 남은 흡수량)
  | 'silence' // 스킬 사용 불가
  | 'lifesteal' // 공격 시 피해의 value 비율만큼 회복
  | 'reflect' // 받은 물리 피해의 value 비율을 공격자에게 반사
  | 'regen' // 초당 회복 (value = 초당 회복량)
  | 'invuln'; // 무적

export type SkillTarget =
  | 'enemy' // 단일 적
  | 'enemy_area' // 적 중심 광역 (radius)
  | 'self'
  | 'ally' // 단일 아군 (자신 포함)
  | 'ally_area' // 아군 광역
  | 'ally_lowest_hp'
  | 'line'; // 시전자→타겟 직선 관통 (radius = 폭)

export type SkillEffect =
  | {
      kind: 'damage';
      school: 'phys' | 'magic';
      coef: number; // 공격력 × coef
      magic?: MagicSchool;
      ignoreDefPct?: number; // 0~1, 방어 무시 비율
      bonusIfStealth?: number; // 은신 중 시전 시 추가 배율 (예: 1.0 = +100%)
      bonusPerMissingHpPct?: number; // 시전자 잃은 HP 1%당 추가 배율
    }
  | { kind: 'heal'; coef: number } // 시전자 이능 공격력 × coef
  | { kind: 'status'; status: StatusKind; durationSec: number; value?: number; chance?: number }
  | { kind: 'buff'; stat: DerivedStatKey; pct: number; durationSec: number } // 파생 수치 % 버프
  | { kind: 'debuff'; stat: DerivedStatKey; pct: number; durationSec: number }
  | { kind: 'summon'; unit: SummonUnitId; count: number; durationSec: number }
  | { kind: 'dash'; distance: number } // 타겟 방향으로 순간 이동
  | { kind: 'knockback'; distance: number }
  | { kind: 'cleanse' } // 대상의 디버프 제거
  | { kind: 'restore_mp'; amount: number };

export type SummonUnitId = 'beast' | 'spirit' | 'skeleton' | 'turret';

export type AiCondition =
  | 'always'
  | 'self_hp_below_50'
  | 'self_hp_below_30'
  | 'ally_hp_below_60'
  | 'ally_hp_below_40'
  | 'enemies_clustered_2' // 반경 내 적 2명 이상
  | 'enemies_clustered_3'
  | 'target_hp_below_30'
  | 'out_of_range' // 대상이 사거리 밖일 때 (돌진용)
  | 'not_stealthed'
  | 'no_summons'; // 살아있는 소환물이 없을 때

export interface SkillDef {
  id: string;
  name: string;
  desc: string;
  type: 'active' | 'passive';
  /** 어느 직업 풀에 속하는지 (표시용). 실제 풀 소속은 JobDef.skillPool / SubJobDef.skillPool */
  job: MainJob;
  magic: MagicSchool;
  cooldownSec: number; // 패시브는 0
  mpCost: number;
  castTimeSec: number; // 시전 시간. 0이면 즉시
  range: number; // 사거리 (맵 단위)
  target: SkillTarget;
  radius?: number; // 광역 반경 / line 폭
  effects: SkillEffect[];
  /** 패시브 전용: 상시 적용되는 파생 수치 % 보정. 예: { critChance: 5, evasion: 10 } */
  passiveMods?: Partial<Record<DerivedStatKey, number>>;
  /** 패시브 전용: 상시 상태 (예: lifesteal 0.15, reflect 0.2) */
  passiveStatus?: { status: StatusKind; value: number }[];
  /** AI 발동 조건. 없으면 쿨타임 되는대로 사용 */
  aiCondition?: AiCondition;
  /** 스킬 상점 가격 (보너스 포인트) */
  cost: number;
}

export const MAX_ACTIVE_SKILLS = 3;
export const MAX_PASSIVE_SKILLS = 2;

// ───────────────────────── 파생 전투 수치 ─────────────────────────

export const DERIVED_STAT_KEYS = [
  'maxHp', 'physAtk', 'magAtk', 'physDef', 'magDef',
  'atkSpeed', 'moveSpeed', 'critChance', 'critMult', 'accuracy', 'evasion',
  'maxMp', 'mpRegen', 'castSpeed', 'cooldownReduction', 'range',
] as const;
export type DerivedStatKey = (typeof DERIVED_STAT_KEYS)[number];
export type DerivedStats = Record<DerivedStatKey, number>;
export const DERIVED_NAME_KO: Record<DerivedStatKey, string> = {
  maxHp: '최대 HP', physAtk: '물리 공격', magAtk: '이능 공격', physDef: '물리 방어', magDef: '이능 방어',
  atkSpeed: '공격 속도', moveSpeed: '이동 속도', critChance: '치명타 확률', critMult: '치명타 배율',
  accuracy: '적중', evasion: '회피', maxMp: '최대 MP', mpRegen: 'MP 회복', castSpeed: '시전 속도',
  cooldownReduction: '쿨타임 감소', range: '사거리',
};

// ───────────────────────── 캐릭터 / 팀 ─────────────────────────

export interface Character {
  id: string;
  name: string;
  mainJob: MainJob;
  subJob: SubJobId | null;
  stats: StatBlock;
  adaptation: Adaptation;
  /** 개체별 성장 편차 (0.85~1.15). 직업 growth 와 곱해진다 */
  growthVariance: Partial<Record<BaseStatKey, number>>;
  /** 습득 스킬 id 목록 (액티브 최대 3, 패시브 최대 2) */
  skills: string[];
  /** 가챠 등급 표시용 (1~5) */
  rarity: number;
}

export interface SynergyDef {
  id: string;
  name: string;
  desc: string;
  /**
   * 발동 조건.
   *  - job_count: 특정 메인 직업 N명 이상
   *  - adjacency: 두 캐릭터(id)가 인접 시 (반경 adjRadius)
   *  - map: 특정 맵일 때
   *  - always: 항상
   */
  condition:
    | { kind: 'job_count'; job: MainJob; count: number }
    | { kind: 'adjacency'; a: string; b: string; adjRadius: number }
    | { kind: 'map'; map: MapType }
    | { kind: 'always' };
  /** 적용 대상: 조건에 관련된 캐릭터만 / 팀 전체 */
  scope: 'involved' | 'team';
  mods: Partial<Record<DerivedStatKey, number>>; // % 보정
  bonusStealthSec?: number;
}

export interface Team {
  id: string;
  name: string;
  members: Character[]; // 정확히 5명
  synergies: SynergyDef[];
}

// ───────────────────────── 전투 ─────────────────────────

export type TeamSide = 'A' | 'B';

export interface BattleInput {
  seed: number;
  map: MapType;
  teamA: Team;
  teamB: Team;
}

export const TICK_RATE = 20; // 초당 틱
export const TICK_DT = 1 / TICK_RATE;

export interface UnitSnapshot {
  id: string; // 캐릭터 id 또는 소환물 id
  ownerId?: string; // 소환물이면 소환사 id
  name: string;
  side: TeamSide;
  job: MainJob | 'summon';
  subJob: SubJobId | null;
  x: number;
  y: number;
  facing: number; // 라디안
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  alive: boolean;
  statuses: { kind: StatusKind; remainingSec: number; value: number }[];
  /** 시전 중이면 스킬 id 와 진행률 0~1 */
  casting: { skillId: string; progress: number } | null;
  targetId: string | null;
}

export type BattleEvent =
  | { t: number; kind: 'attack'; from: string; to: string; damage: number; crit: boolean; school: 'phys' | 'magic'; miss?: boolean }
  | { t: number; kind: 'skill'; from: string; skillId: string; to: string | null; x: number; y: number }
  | { t: number; kind: 'heal'; from: string; to: string; amount: number }
  | { t: number; kind: 'kill'; killer: string; victim: string }
  | { t: number; kind: 'summon'; owner: string; unitId: string }
  | { t: number; kind: 'status'; to: string; status: StatusKind; applied: boolean }
  | { t: number; kind: 'capture'; side: TeamSide; progress: number }
  | { t: number; kind: 'end'; winner: TeamSide | 'draw'; reason: string };

export interface BattleFrame {
  tick: number;
  timeSec: number;
  units: UnitSnapshot[];
  /** 이번 틱에 발생한 이벤트 */
  events: BattleEvent[];
  /** 거점 점령 진행 (capture 맵일 때). 각 0~1 */
  capture: { progressA: number; progressB: number; holder: TeamSide | null } | null;
  finished: boolean;
}

export interface UnitBattleStats {
  id: string;
  name: string;
  side: TeamSide;
  damageDealt: number;
  damageTaken: number;
  healingDone: number;
  kills: number;
  deaths: number;
  skillsUsed: number;
  survived: boolean;
}

export interface BattleResult {
  seed: number;
  map: MapType;
  winner: TeamSide | 'draw';
  reason: string; // 'annihilation' | 'timeout_hp' | 'capture' | 'timeout_draw'
  durationSec: number;
  totalTicks: number;
  unitStats: UnitBattleStats[];
  mvpId: string | null;
  events: BattleEvent[];
}

/**
 * 시뮬레이션 인터페이스. battle/sim.ts 가 구현한다.
 * - step() 은 한 틱을 진행하고 프레임을 반환한다. 렌더러는 이 프레임만 그린다.
 * - runToEnd() 는 UI 없이 끝까지 돌려 결과를 낸다 (헤드리스).
 * 같은 BattleInput 이면 step 순서로 나온 프레임과 결과가 완전히 동일해야 한다.
 */
export interface BattleSimulator {
  readonly input: BattleInput;
  readonly finished: boolean;
  step(): BattleFrame;
  currentFrame(): BattleFrame;
  result(): BattleResult | null;
  runToEnd(): BattleResult;
}

// ───────────────────────── 육성 ─────────────────────────

export const TOTAL_CYCLES = 10;
export const CHOICES_PER_CYCLE = 3;
export const SUBJOB_CHOICE_CYCLE_MIN = 4;
export const SUBJOB_CHOICE_CYCLE_MAX = 6;

export type ChoiceKind =
  | 'big_single' // 한 명 대폭
  | 'small_multi' // 여러 명 소폭
  | 'tradeoff' // 다수 상승 + 한 명 하락
  | 'gamble' // 확률 성공/실패
  | 'skill' // 스킬 습득
  | 'subjob' // 직업 분화
  | 'job_change' // 직업 변경
  | 'adaptation' // 맵 적응 훈련
  | 'synergy' // 팀 시너지 획득
  | 'sacrifice'; // 한 명이 무언가 포기, 팀 이득

export const CHOICE_KIND_NAME_KO: Record<ChoiceKind, string> = {
  big_single: '집중 훈련', small_multi: '합동 훈련', tradeoff: '편중 훈련', gamble: '도박 훈련',
  skill: '스킬 습득', subjob: '직업 분화', job_change: '직업 변경', adaptation: '맵 적응 훈련',
  synergy: '팀 시너지', sacrifice: '희생',
};

export type ChoiceEffect =
  | { kind: 'stat'; charId: string; stat: BaseStatKey; delta: number }
  | { kind: 'stat_category'; charId: string; category: StatCategory; delta: number } // 카테고리 전체 각 스탯
  | { kind: 'adaptation'; charId: string | 'all'; map: MapType; delta: number }
  | { kind: 'learn_skill'; charId: string; skillId: string }
  | { kind: 'forget_skill'; charId: string; skillId: string }
  | { kind: 'set_subjob'; charId: string; subJob: SubJobId }
  | { kind: 'change_job'; charId: string; mainJob: MainJob; statLossPct: number }
  | { kind: 'add_synergy'; synergy: SynergyDef }
  | { kind: 'bonus_points'; delta: number };

export interface Choice {
  id: string;
  kind: ChoiceKind;
  title: string;
  desc: string;
  /** 관련 캐릭터 id (표시용) */
  charIds: string[];
  effects: ChoiceEffect[];
  /** 도박형: 성공 확률 0~1. 없으면 확정 */
  successChance?: number;
  failEffects?: ChoiceEffect[];
}

export type RunPhase =
  | 'select_team' // 풀에서 5명 선택
  | 'pre_battle' // 맵/상대 공개, 전투 시작 대기
  | 'battle' // 전투 관전
  | 'bonus' // 보너스 포인트로 스킬 구매 등
  | 'choice' // 로그라이크 선택 (3회)
  | 'done'; // 10사이클 완료

export interface CycleRecord {
  cycle: number;
  map: MapType;
  result: BattleResult;
  opponentName: string;
  bonusEarned: number;
  choicesTaken: { title: string; success: boolean | null }[];
  /** 전투 직전 팀 스냅샷 (Bazaar 방식 상대 풀용) */
  teamSnapshot: Team;
}

export interface RunState {
  seed: number;
  phase: RunPhase;
  cycle: number; // 1~10, select_team 단계에서는 0
  pool: Character[]; // 가챠 풀 (선택 단계)
  team: Team | null;
  bonusPoints: number;
  currentMap: MapType | null;
  opponent: Team | null;
  /** 현재 사이클에서 몇 번째 선택인지 (0~2) */
  choiceIndex: number;
  currentChoices: Choice[];
  /** 캐릭터별 분화 선택지 등장 예정 사이클 (등장하면 삭제) */
  subJobChoiceCycle: Record<string, number>;
  history: CycleRecord[];
  /** 현재 사이클에서 다음 선택지 리롤 가능 횟수 */
  rerolls: number;
}

/** 저장된 과거 육성의 사이클별 스냅샷. Bazaar 방식 상대 매칭에 사용 */
export interface GhostSnapshot {
  runSeed: number;
  cycle: number;
  team: Team;
  savedAt: string; // ISO
}
