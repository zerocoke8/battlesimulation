/**
 * 맵 4종 정의 (GDD §5).
 * (v0.7) 맵 크기 28×20 (MAP_DEFAULT_WIDTH/HEIGHT). 팀 A 는 왼쪽(x=4), 팀 B 는 오른쪽(x=24)에서 시작한다.
 * 승리 조건은 전 맵 'annihilation_or_hp', 제한 시간 MAP_TIME_LIMIT_SEC(240). 빙하 거점(capture)은 제거했다.
 *
 * spawnA / spawnB 는 **대열 기준 열(anchor)** 이다 (GDD §5, §7.3.2).
 * 배열의 x 평균이 그 팀의 기준 열, y 평균이 대열 중심이 되며, 실제 스폰 위치는
 * sim 의 computeFormation 이 인원 수(1~MONSTER_TEAM_MAX)와 역할에 맞춰 생성한다.
 * 따라서 배열 길이는 인원과 무관하고 어떤 모듈도 길이에 의존하면 안 된다.
 *
 * 맵 기믹(hazards)은 GDD §5.1. 빙하 = 눈보라(hazard_blizzard). 다른 맵은 빈 배열.
 */
import type { HazardDef, MapDef, MapType } from '../types';
import { MAP_DEFAULT_HEIGHT, MAP_DEFAULT_WIDTH, MAP_TIME_LIMIT_SEC, MAP_TYPES } from '../types';

export const MAP_WIDTH = MAP_DEFAULT_WIDTH;
export const MAP_HEIGHT = MAP_DEFAULT_HEIGHT;
/** 팀 A / B 의 대열 기준 열 */
export const SPAWN_X_A = 4;
export const SPAWN_X_B = MAP_WIDTH - 4;
/** 대열 중심 y */
export const SPAWN_CENTER_Y = MAP_HEIGHT / 2;
/** 전 맵 공통 제한 시간 (안전장치). 실제로는 전장 붕괴 때문에 190초 안팎에 끝난다 */
export const DEFAULT_TIME_LIMIT_SEC = MAP_TIME_LIMIT_SEC;

/** 기준 열 1점. 대열은 sim 이 만든다 */
function anchor(x: number): { x: number; y: number }[] {
  return [{ x, y: SPAWN_CENTER_Y }];
}

/**
 * 빙하 눈보라 (GDD §5.1). 10초부터 양 팀 유닛 위에 떨어지는 냉기 광역 + 3초 장판(둔화).
 * v0.7 보정 (10일차 4:4, 시드 5, 맵별 150판 / 랜덤 맵 200판):
 *  - 설계 초기값 impact 8% · 장판 2%/초 · 간격 8초(−0.4/파도) 로는 눈보라 피해 비중 22.6% (목표 8~20%), 빙하 평균 전투 시간 0.68배 (목표 0.7 이상).
 *  - impact 5% · 장판 1.2%/초 · 간격 8초: 비중 16~17%, 빙하 54~55초 (다른 맵 64~71초). 빙하만 목표 하한 60초를 밑돌았다.
 *    눈보라가 전체 피해의 17% 를 더 얹으니 전투가 그만큼(≈17%) 짧아지는 구조다.
 *  - 1회 피해를 더 깎는 대신(4%/0.9% 도 시험: 눈보라 맞는 체감이 옅어지고 빙하 56초로 부족) **파도 간격을 8 → 12초, 감소 0.4 → 0.5/파도** 로 늘렸다.
 *    파도 수가 60초 기준 8 → 5 로 줄어 총 눈보라 피해 −30~35%, 1회 피해(5% + 장판)는 그대로라 '맞으면 아프다' 는 유지된다.
 *    간격은 파도마다 0.5초씩 줄어 최소 4초까지 잦아진다 (설계 의도 '갈수록 잦고 넓게' 유지). 반경·예고·둔화·적응 보정은 설계값 그대로.
 */
export const HAZARD_BLIZZARD: HazardDef = {
  id: 'hazard_blizzard',
  name: '눈보라',
  startSec: 10,
  intervalSec: 12,
  minIntervalSec: 4,
  intervalDecayPerWave: 0.5,
  targeting: 'random_unit_each_side',
  radius: 3.5,
  telegraphSec: 1.2,
  damagePctMaxHp: 5,
  linger: { durationSec: 3, dpsPctMaxHp: 1.2, slow: 0.5 },
  magic: 'ice',
  adaptationScaled: true,
  radiusGrowthPerWave: 0.1,
  maxRadius: 5,
};

/** 모든 기믹 정의 (id 순회용, 배열 순서 고정) */
export const HAZARDS: readonly HazardDef[] = [HAZARD_BLIZZARD];

export function getHazard(id: string): HazardDef | null {
  for (let i = 0; i < HAZARDS.length; i++) if (HAZARDS[i].id === id) return HAZARDS[i];
  return null;
}

const VICTORY_DESC = '승리 조건: 상대 전멸 또는 제한시간 종료 시 잔여 HP 합 비교. 120초부터 전장 붕괴.';

export const MAPS: Record<MapType, MapDef> = {
  plains: {
    id: 'plains',
    name: '평원',
    desc: '개활지. 장애물이 없고 시야가 넓다. 저격수·궁수·마법사에게 유리하다. ' + VICTORY_DESC,
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    visionRadius: 0,
    staminaDrainMult: 1,
    moveSpeedMult: 1,
    slipFactor: 0,
    stealthBonusSec: 0,
    schoolBonus: {},
    victory: 'annihilation_or_hp',
    timeLimitSec: DEFAULT_TIME_LIMIT_SEC,
    hazards: [],
    spawnA: anchor(SPAWN_X_A),
    spawnB: anchor(SPAWN_X_B),
  },
  dark: {
    id: 'dark',
    name: '어둠',
    desc: '시야 반경이 11로 줄고 은신이 2초 더 지속된다. 암살자·소환사에게 유리하다. ' + VICTORY_DESC,
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    // v0.7: 9 → 11. 맵이 28×20 으로 줄어도 어둠은 다른 맵보다 전투가 4~8초 길고 붕괴 후 종료 비율이 가장 높았다(맵별 150판 18%).
    // 시야 9 에서는 초반 탐색과 후반 1~2기 잔존 상황에서 서로를 못 찾는 시간이 길다. 11 이면 스폰 간격(20)보다 여전히 좁아 어둠의 정체성은 유지된다 (74.7초 / 14%).
    visionRadius: 11,
    staminaDrainMult: 1,
    moveSpeedMult: 1,
    slipFactor: 0,
    stealthBonusSec: 2,
    schoolBonus: {},
    victory: 'annihilation_or_hp',
    timeLimitSec: DEFAULT_TIME_LIMIT_SEC,
    hazards: [],
    spawnA: anchor(SPAWN_X_A),
    spawnB: anchor(SPAWN_X_B),
  },
  desert: {
    id: 'desert',
    name: '사막',
    desc: '지구력 소모 2배, 이동속도 15% 감소. 탱커·힐러·버서커에게 유리하다. ' + VICTORY_DESC,
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    visionRadius: 0,
    staminaDrainMult: 2,
    moveSpeedMult: 0.85,
    slipFactor: 0,
    stealthBonusSec: 0,
    schoolBonus: {},
    victory: 'annihilation_or_hp',
    timeLimitSec: DEFAULT_TIME_LIMIT_SEC,
    hazards: [],
    spawnA: anchor(SPAWN_X_A),
    spawnB: anchor(SPAWN_X_B),
  },
  glacier: {
    id: 'glacier',
    name: '빙하',
    desc:
      '이동 시 미끄러져 경로 오차가 생기고 냉기 이능 위력이 25% 강해진다. 10초부터 양 팀 유닛 위로 눈보라가 떨어진다 (빙하 적응도가 높을수록 덜 아프다). 냉기 마법사·검사에게 유리하다. ' +
      VICTORY_DESC,
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    visionRadius: 0,
    staminaDrainMult: 1,
    moveSpeedMult: 1,
    slipFactor: 0.35,
    stealthBonusSec: 0,
    schoolBonus: { ice: 1.25 },
    victory: 'annihilation_or_hp',
    timeLimitSec: DEFAULT_TIME_LIMIT_SEC,
    hazards: [HAZARD_BLIZZARD],
    spawnA: anchor(SPAWN_X_A),
    spawnB: anchor(SPAWN_X_B),
  },
};

/** MAP_TYPES 순서로 정렬된 맵 목록 (결정론적 순회용) */
export const MAP_LIST: readonly MapDef[] = MAP_TYPES.map((id) => MAPS[id]);

/** 알 수 없는 맵 id 면 예외 */
export function getMap(id: MapType): MapDef {
  const m = MAPS[id];
  if (!m) throw new Error('알 수 없는 맵: ' + String(id));
  return m;
}
