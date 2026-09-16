/**
 * 맵 4종 정의 (GDD §5).
 * 맵 크기 40×30. 팀 A 는 왼쪽(x=4), 팀 B 는 오른쪽(x=36)에서 시작한다.
 *
 * spawnA / spawnB 는 **대열 기준 열(anchor)** 이다 (GDD §5, §7.3.2).
 * 배열의 x 평균이 그 팀의 기준 열, y 평균이 대열 중심이 되며, 실제 스폰 위치는
 * sim 의 computeFormation 이 인원 수(1~MONSTER_TEAM_MAX)와 역할에 맞춰 생성한다.
 * 따라서 배열 길이는 인원과 무관하고 어떤 모듈도 길이에 의존하면 안 된다.
 */
import type { MapDef, MapType } from '../types';
import { MAP_TYPES } from '../types';

export const MAP_WIDTH = 40;
export const MAP_HEIGHT = 30;
/** 팀 A / B 의 대열 기준 열 */
export const SPAWN_X_A = 4;
export const SPAWN_X_B = 36;
/** 대열 중심 y */
export const SPAWN_CENTER_Y = 15;
export const DEFAULT_TIME_LIMIT_SEC = 180;

/** 기준 열 1점. 대열은 sim 이 만든다 */
function anchor(x: number): { x: number; y: number }[] {
  return [{ x, y: SPAWN_CENTER_Y }];
}

export const MAPS: Record<MapType, MapDef> = {
  plains: {
    id: 'plains',
    name: '평원',
    desc: '개활지. 장애물이 없고 시야가 넓다. 저격수·궁수·마법사에게 유리하다. 승리 조건: 상대 전멸.',
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    visionRadius: 0,
    staminaDrainMult: 1,
    moveSpeedMult: 1,
    slipFactor: 0,
    stealthBonusSec: 0,
    schoolBonus: {},
    victory: 'annihilation',
    timeLimitSec: DEFAULT_TIME_LIMIT_SEC,
    spawnA: anchor(SPAWN_X_A),
    spawnB: anchor(SPAWN_X_B),
  },
  dark: {
    id: 'dark',
    name: '어둠',
    desc: '시야 반경이 9로 줄고 은신이 2초 더 지속된다. 암살자·소환사에게 유리하다. 승리 조건: 상대 전멸 또는 제한시간 종료 시 잔여 HP 합 비교.',
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    visionRadius: 9,
    staminaDrainMult: 1,
    moveSpeedMult: 1,
    slipFactor: 0,
    stealthBonusSec: 2,
    schoolBonus: {},
    // v0.5 보정: 시야 제한 때문에 10일차 어둠 전투의 9~17% 가 180초 시간 초과 무승부로 끝났다 (다른 맵 0~6%).
    // 시간 초과는 잔여 HP 합으로 판정해 무승부를 진짜 동점으로만 남긴다.
    victory: 'annihilation_or_hp',
    timeLimitSec: DEFAULT_TIME_LIMIT_SEC,
    spawnA: anchor(SPAWN_X_A),
    spawnB: anchor(SPAWN_X_B),
  },
  desert: {
    id: 'desert',
    name: '사막',
    desc: '지구력 소모 2배, 이동속도 15% 감소. 탱커·힐러·버서커에게 유리하다. 승리 조건: 상대 전멸 또는 제한시간 종료 시 잔여 HP 합 비교.',
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
    spawnA: anchor(SPAWN_X_A),
    spawnB: anchor(SPAWN_X_B),
  },
  glacier: {
    id: 'glacier',
    name: '빙하',
    desc: '이동 시 미끄러져 경로 오차가 생기고 냉기 이능 위력이 25% 강해진다. 냉기 마법사·검사에게 유리하다. 승리 조건: 중앙 거점을 15초 점유하거나 상대 전멸.',
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    visionRadius: 0,
    staminaDrainMult: 1,
    moveSpeedMult: 1,
    slipFactor: 0.35,
    stealthBonusSec: 0,
    schoolBonus: { ice: 1.25 },
    victory: 'capture_or_annihilation',
    timeLimitSec: DEFAULT_TIME_LIMIT_SEC,
    capture: { x: 20, y: 15, radius: 4, secondsToCapture: 15 },
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
