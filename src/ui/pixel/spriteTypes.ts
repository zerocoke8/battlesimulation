/**
 * 도트 스프라이트 계약 (v0.7). 스프라이트 생성기(코드 생성 임시 스프라이트)·로더(public/sprites)·
 * 픽셀 렌더러가 전부 이 파일의 타입과 규칙만 공유한다. 에셋 규격 문서: docs/SPRITES.md
 *
 * 규격 요약
 *  - 프레임 64×64, 시트는 애니메이션당 1행, 열 = 프레임. 오른쪽을 보는 기준으로 그리고 왼쪽은 코드에서 좌우 반전.
 *  - 앵커(발 위치) = (32, 58). 64px 스프라이트 = 맵 2 유닛.
 *  - 애니메이션 6종: idle 4f 6fps 반복, walk 6f 10fps 반복, attack 4f 12fps 1회, cast 4f 8fps 반복,
 *    hit 2f 10fps 1회, death 4f 8fps 1회(마지막 프레임 유지).
 */
import type { MainJob, SummonUnitId, UnitSnapshot } from '../../core/types';
import { MAIN_JOBS } from '../../core/types';

export type AnimName = 'idle' | 'walk' | 'attack' | 'cast' | 'hit' | 'death';

/** 애니메이션 이름 순서 (시트의 행 순서와 같다). 순회는 항상 이 배열로 */
export const ANIM_NAMES: readonly AnimName[] = ['idle', 'walk', 'attack', 'cast', 'hit', 'death'];

export interface AnimDef {
  /** 시트에서의 행 번호 (0부터) */
  row: number;
  /** 프레임 수 = 그 행의 열 수 */
  frames: number;
  fps: number;
  /** true 면 반복, false 면 1회 재생 후 마지막 프레임 유지 */
  loop: boolean;
}

export interface SpriteMeta {
  frameW: number;
  frameH: number;
  /** 발 위치. 이 점이 유닛의 (x, y) 에 놓인다 */
  anchor: { x: number; y: number };
  anims: Record<AnimName, AnimDef>;
}

export interface SpriteSheet {
  key: SpriteKey;
  image: CanvasImageSource;
  meta: SpriteMeta;
  /** true 면 세부 직업·팀 색에 따라 팔레트 틴트를 적용할 수 있다 (직업 시트). 몬스터·소환물은 false */
  tintable: boolean;
}

/** 기본 프레임 크기 */
export const SPRITE_FRAME_W = 64;
export const SPRITE_FRAME_H = 64;
/** 기본 앵커 (발 위치) */
export const SPRITE_ANCHOR_X = 32;
export const SPRITE_ANCHOR_Y = 58;
/** 스프라이트 1프레임(64px)이 차지하는 맵 유닛 수 */
export const SPRITE_UNITS = 2;
/** 오프스크린 캔버스 배율: 1 맵 유닛 = 32 픽셀 */
export const PIXELS_PER_UNIT = 32;

/** 설계 [5] 의 여섯 애니메이션. 외부 에셋 JSON 이 없을 때와 코드 생성 스프라이트가 쓴다 */
export const DEFAULT_META: SpriteMeta = {
  frameW: SPRITE_FRAME_W,
  frameH: SPRITE_FRAME_H,
  anchor: { x: SPRITE_ANCHOR_X, y: SPRITE_ANCHOR_Y },
  anims: {
    idle: { row: 0, frames: 4, fps: 6, loop: true },
    walk: { row: 1, frames: 6, fps: 10, loop: true },
    attack: { row: 2, frames: 4, fps: 12, loop: false },
    cast: { row: 3, frames: 4, fps: 8, loop: true },
    hit: { row: 4, frames: 2, fps: 10, loop: false },
    death: { row: 5, frames: 4, fps: 8, loop: false },
  },
};

/**
 * 스프라이트 키.
 *  - 직업 9종: MainJob id 그대로 ('swordsman' … 'healer'). 세부 직업은 같은 시트 + 팔레트 틴트.
 *  - 소환물 4종: 'summon_beast' | 'summon_spirit' | 'summon_skeleton' | 'summon_turret'
 *  - 몬스터 18종: 'monster_<MonsterDef.id>' (예 'monster_slime_swarm')
 * 외부 에셋 경로: public/sprites/<key>.png + public/sprites/<key>.json
 */
export type SpriteKey = string;

export const SPRITE_KEY_SUMMON_PREFIX = 'summon_';
export const SPRITE_KEY_MONSTER_PREFIX = 'monster_';

/** 소환물 종류 4종 (SummonUnitId 순서 고정) */
export const SUMMON_KINDS: readonly SummonUnitId[] = ['beast', 'spirit', 'skeleton', 'turret'];

/** 몬스터 종(species) 18종 = src/core/data/monsters.ts 의 MONSTERS 키. 하급 6 / 중급 6 / 고급 6 */
export const MONSTER_SPECIES: readonly string[] = [
  // 하급
  'slime_swarm', 'wild_dogs', 'goblin_scouts', 'cave_bats', 'mushroom_grove', 'giant_slime',
  // 중급
  'orc_warband', 'harpy_flock', 'living_armor', 'bandit_crew', 'wraith_choir', 'orc_chieftain',
  // 고급
  'ancient_golem', 'frost_dragon', 'inferno_lord', 'lich_host', 'abyss_pack', 'demon_legion',
];

export function spriteKeyForJob(job: MainJob): SpriteKey {
  return job;
}

export function spriteKeyForSummon(kind: SummonUnitId | string): SpriteKey {
  return SPRITE_KEY_SUMMON_PREFIX + kind;
}

export function spriteKeyForMonster(species: string): SpriteKey {
  return species.indexOf(SPRITE_KEY_MONSTER_PREFIX) === 0 ? species : SPRITE_KEY_MONSTER_PREFIX + species;
}

/** 외부 에셋 후보 키 전체 목록 (9 직업 + 4 소환물 + 18 몬스터 = 31). 로더가 사전 적재할 때 이 순서로 */
export const ALL_SPRITE_KEYS: readonly SpriteKey[] = [
  ...MAIN_JOBS.map(spriteKeyForJob),
  ...SUMMON_KINDS.map(spriteKeyForSummon),
  ...MONSTER_SPECIES.map(spriteKeyForMonster),
];

/** 코드 생성 폴백 키. 알 수 없는 키가 오면 이 시트를 쓴다 */
export const FALLBACK_SPRITE_KEY: SpriteKey = 'swordsman';

/**
 * 유닛 스냅샷 → 스프라이트 키.
 *  1. sim 이 채운 `u.spriteKey` 가 있으면 그대로.
 *  2. `monsterKindOf(u.id)` 가 값을 주면 몬스터 ('monster_' 접두사를 붙인다. 이미 있으면 그대로).
 *  3. job 이 'summon' 이면 'summon_<kind>'. kind 는 monsterKindOf 가 준 값이 없으므로 id 접미사로 알 수 없어 'beast' 기본.
 *     (sim 은 소환물의 spriteKey 를 항상 채우므로 이 분기는 구버전 프레임 방어용)
 *  4. 그 외 직업 캐릭터: mainJob id.
 */
export function spriteKeyForUnit(u: UnitSnapshot, monsterKindOf?: (id: string) => string | undefined): SpriteKey {
  if (u.spriteKey) return u.spriteKey;
  const species = monsterKindOf ? monsterKindOf(u.id) : undefined;
  if (species) return spriteKeyForMonster(species);
  if (u.job === 'summon') return spriteKeyForSummon('beast');
  return spriteKeyForJob(u.job);
}

/** 키의 분류 */
export type SpriteKeyKind = 'job' | 'summon' | 'monster';
export function spriteKeyKind(key: SpriteKey): SpriteKeyKind {
  if (key.indexOf(SPRITE_KEY_SUMMON_PREFIX) === 0) return 'summon';
  if (key.indexOf(SPRITE_KEY_MONSTER_PREFIX) === 0) return 'monster';
  return 'job';
}

/** 외부 에셋 경로 (Vite public/ 기준 → 배포 시 루트 상대 경로) */
export const SPRITE_ASSET_DIR = 'sprites/';
export function spriteAssetPaths(key: SpriteKey): { png: string; json: string } {
  return { png: `${SPRITE_ASSET_DIR}${key}.png`, json: `${SPRITE_ASSET_DIR}${key}.json` };
}

/** localStorage 키. 값은 RenderMode ('pixel' | 'simple') */
export const RENDER_MODE_STORAGE_KEY = 'bs:renderMode';

/**
 * 애니메이션 재생 상태. 시간은 **시뮬레이션 시간(초)** 기준 (배속·리플레이 동일).
 * startSec 은 이 애니메이션이 시작된 시각.
 */
export interface AnimState {
  anim: AnimName;
  startSec: number;
}

/**
 * 시뮬레이션 시각 → 현재 프레임 인덱스 (0 ~ frames−1). 순수 함수.
 * loop 면 순환, 아니면 마지막 프레임에서 멈춘다.
 */
export function animFrameAt(def: AnimDef, startSec: number, nowSec: number): number {
  const elapsed = Math.max(0, nowSec - startSec);
  const raw = Math.floor(elapsed * def.fps);
  if (def.frames <= 0) return 0;
  if (def.loop) return raw % def.frames;
  return raw >= def.frames ? def.frames - 1 : raw;
}

/** 1회 재생 애니메이션이 끝났는지 (loop 면 항상 false) */
export function animFinished(def: AnimDef, startSec: number, nowSec: number): boolean {
  if (def.loop) return false;
  return (nowSec - startSec) * def.fps >= def.frames;
}

/**
 * 외부 JSON 을 SpriteMeta 로 검증한다. 필드가 빠졌거나 형식이 다르면 null (로더는 그럼 DEFAULT_META 를 쓴다).
 * anims 에 없는 애니메이션은 DEFAULT_META 의 것으로 채운다.
 */
export function parseSpriteMeta(raw: unknown): SpriteMeta | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const frameW = typeof o.frameW === 'number' && o.frameW > 0 ? o.frameW : null;
  const frameH = typeof o.frameH === 'number' && o.frameH > 0 ? o.frameH : null;
  if (frameW === null || frameH === null) return null;
  const a = o.anchor as { x?: unknown; y?: unknown } | undefined;
  const anchor =
    a && typeof a.x === 'number' && typeof a.y === 'number' ? { x: a.x, y: a.y } : { x: frameW / 2, y: frameH - 6 };
  const animsRaw = (typeof o.anims === 'object' && o.anims !== null ? o.anims : {}) as Record<string, unknown>;
  const anims = {} as Record<AnimName, AnimDef>;
  for (let i = 0; i < ANIM_NAMES.length; i++) {
    const name = ANIM_NAMES[i];
    const d = animsRaw[name] as Partial<AnimDef> | undefined;
    const base = DEFAULT_META.anims[name];
    if (d && typeof d.row === 'number' && typeof d.frames === 'number' && d.frames > 0) {
      anims[name] = {
        row: d.row,
        frames: d.frames,
        fps: typeof d.fps === 'number' && d.fps > 0 ? d.fps : base.fps,
        loop: typeof d.loop === 'boolean' ? d.loop : base.loop,
      };
    } else {
      anims[name] = { ...base };
    }
  }
  return { frameW, frameH, anchor, anims };
}
