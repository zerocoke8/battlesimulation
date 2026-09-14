/**
 * 맵 4종 정의 (GDD §5).
 * 맵 크기 40×30. 팀 A 는 왼쪽(x=4), 팀 B 는 오른쪽(x=36)에서 시작한다.
 * 스폰 위치는 역할과 무관한 순서(y = 9,12,15,18,21)이며, 누가 어디에 서는지는 sim 이 인덱스로 결정한다.
 */
import type { MapDef, MapType } from '../types';
import { MAP_TYPES } from '../types';

export const MAP_WIDTH = 40;
export const MAP_HEIGHT = 30;
export const SPAWN_X_A = 4;
export const SPAWN_X_B = 36;
export const SPAWN_YS: readonly number[] = [9, 12, 15, 18, 21];
export const DEFAULT_TIME_LIMIT_SEC = 180;

function spawns(x: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < SPAWN_YS.length; i++) out.push({ x, y: SPAWN_YS[i] });
  return out;
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
    spawnA: spawns(SPAWN_X_A),
    spawnB: spawns(SPAWN_X_B),
  },
  dark: {
    id: 'dark',
    name: '어둠',
    desc: '시야 반경이 9로 줄고 은신이 2초 더 지속된다. 암살자·소환사에게 유리하다. 승리 조건: 상대 전멸.',
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    visionRadius: 9,
    staminaDrainMult: 1,
    moveSpeedMult: 1,
    slipFactor: 0,
    stealthBonusSec: 2,
    schoolBonus: {},
    victory: 'annihilation',
    timeLimitSec: DEFAULT_TIME_LIMIT_SEC,
    spawnA: spawns(SPAWN_X_A),
    spawnB: spawns(SPAWN_X_B),
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
    spawnA: spawns(SPAWN_X_A),
    spawnB: spawns(SPAWN_X_B),
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
    spawnA: spawns(SPAWN_X_A),
    spawnB: spawns(SPAWN_X_B),
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
