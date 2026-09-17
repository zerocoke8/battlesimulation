/**
 * 첫 실행 프리로드 (v1.0 설계 [1]).
 *
 * 앱을 처음 열 때 화면에 보일 그림을 한 번에 모아 받는다. 예전에는 전투를 시작할 때마다 스프라이트·이펙트를,
 * 배경·직업 아이콘은 처음 그릴 때 받아서 첫 전투나 새 맵에서 그림이 늦게 떴다.
 *
 *  - 목록은 전부 코드에서 가져온다 (ALL_SPRITE_KEYS / FX_KEYS / MAP_TYPES / MAIN_JOBS). 손으로 적지 않는다.
 *  - 순서는 배경 → 스프라이트 → 직업 아이콘 → 이펙트 (먼저 보이는 것부터).
 *  - 동시에 받는 자산(작업)은 PRELOAD_CONCURRENCY(8) 개다. 작업 하나가 파일 여러 개를 받으므로
 *    실제 HTTP 요청은 그보다 많다: 배경·아이콘은 1개, 스프라이트·이펙트는 png + json 2개,
 *    의상 마스크가 있는 직업 시트는 3개 → 구간에 따라 최대 16~24 요청이 동시에 열린다.
 *  - 자산 하나 제한 시간 ASSET_TIMEOUT_MS(10초), 전체 제한 시간 TOTAL_TIMEOUT_MS(25초).
 *    제한 시간을 넘으면 기다리기만 그만두고(요청 자체는 끊지 않는다) 남은 것은 백그라운드로 계속 받으며 화면만 진행시킨다.
 *  - 실패는 조용히 넘어간다 (아직 제작되지 않은 이펙트는 404 → 임시 이펙트, 스프라이트는 코드 생성 시트가 폴백).
 *    실패 개수만 센다.
 *  - 두 번 호출해도 실제 요청은 한 번뿐이다 (모듈 수준 Promise 캐시). 나중에 부른 쪽도 진행률을 받는다.
 *  - DOM 이 없는 환경(node 하네스)에서는 즉시 완료된 것으로 돌려준다.
 *
 * 시뮬레이션에는 영향이 없다 (그림만 받는다).
 */
import { MAIN_JOBS, MAP_TYPES } from '../core/types';
import type { MainJob, MapType } from '../core/types';
import { ALL_SPRITE_KEYS } from './pixel/spriteTypes';
import { FX_KEYS } from './pixel/fx/fxTypes';
import type { FxKey } from './pixel/fx/fxTypes';
import { hasExternalSheet, preloadSprites } from './pixel/loader';
import { hasExternalFx, preloadFxSheets } from './pixel/fx/fxLoader';
import { preloadJobIcon } from './pixel/icons';
import { loadArtImage } from './pixel/imageAssets';

/** 프리로드 진행 상황. total 은 받을 자산 개수, loaded 는 끝난 개수(실패 포함), failed 는 그중 실패 */
export interface PreloadProgress {
  loaded: number;
  total: number;
  /**
   * 폴백(코드 생성 시트·임시 이펙트)으로 대체된 자산 개수.
   * 제한 시간을 넘겨 기다리기를 그만둔 자산도 여기에 들어가며, 그 자산이 나중에 늦게 도착해도 숫자는 줄지 않는다.
   */
  failed: number;
  /** 방금 끝난 자산의 한국어 이름 (화면에 보여줄 용도). 끝나면 완료/안내 문구가 들어간다 */
  label: string;
}

/** 자산 분류 */
export type PreloadKind = 'background' | 'sprite' | 'icon' | 'fx';

/** 분류별 한국어 이름 */
export const PRELOAD_KIND_KO: Record<PreloadKind, string> = {
  background: '배경',
  sprite: '캐릭터',
  icon: '직업 아이콘',
  fx: '이펙트',
};

/** 동시에 보내는 요청 수 */
export const PRELOAD_CONCURRENCY = 8;
/** 자산 하나의 제한 시간 (ms) */
export const ASSET_TIMEOUT_MS = 10000;
/** 전체 제한 시간 (ms). 넘으면 남은 것은 백그라운드로 계속 받는다 */
export const TOTAL_TIMEOUT_MS = 25000;

interface PreloadTask {
  kind: PreloadKind;
  key: string;
  /** 성공하면 true. 실패해도 예외를 던지지 않는다 */
  run: () => Promise<boolean>;
}

/** 분류별 자산 개수 (자체 점검용) */
export interface PreloadPlanCounts {
  backgrounds: number;
  sprites: number;
  icons: number;
  fx: number;
  total: number;
}

function backgroundTask(map: MapType): PreloadTask {
  return {
    kind: 'background',
    key: map,
    run: () => loadArtImage(`backgrounds/${map}.png`).then((img) => img !== null),
  };
}

function spriteTask(key: string): PreloadTask {
  // 로더가 .png + .json 을 받고, 직업 시트의 의상 마스크(.tint.png)는 메타를 읽은 뒤 알아서 받는다.
  return { kind: 'sprite', key, run: () => preloadSprites([key]).then(() => hasExternalSheet(key)) };
}

function iconTask(job: MainJob): PreloadTask {
  return { kind: 'icon', key: job, run: () => preloadJobIcon(job) };
}

function fxTask(key: FxKey): PreloadTask {
  // 아직 제작되지 않은 키는 404 → 임시 이펙트 폴백. 실패로 세되 진행을 막지 않는다.
  return { kind: 'fx', key, run: () => preloadFxSheets([key]).then(() => hasExternalFx(key)) };
}

/** 받을 자산 목록. 순서는 배경 → 스프라이트 → 직업 아이콘 → 이펙트 */
function buildPlan(): PreloadTask[] {
  const tasks: PreloadTask[] = [];
  for (const map of MAP_TYPES) tasks.push(backgroundTask(map));
  for (const key of ALL_SPRITE_KEYS) tasks.push(spriteTask(key));
  for (const job of MAIN_JOBS) tasks.push(iconTask(job));
  for (const key of FX_KEYS) tasks.push(fxTask(key));
  return tasks;
}

/** 분류별 자산 개수 (스프라이트 31 + 이펙트 68 + 배경 4 + 아이콘 9). 목록은 코드에서 가져온다 */
export function preloadPlanCounts(): PreloadPlanCounts {
  const counts: PreloadPlanCounts = { backgrounds: 0, sprites: 0, icons: 0, fx: 0, total: 0 };
  for (const t of buildPlan()) {
    if (t.kind === 'background') counts.backgrounds++;
    else if (t.kind === 'sprite') counts.sprites++;
    else if (t.kind === 'icon') counts.icons++;
    else counts.fx++;
    counts.total++;
  }
  return counts;
}

function hasDom(): boolean {
  return typeof document !== 'undefined' && typeof Image !== 'undefined';
}

/** 제한 시간을 넘기면 false 로 끝낸다. 실제 요청은 백그라운드에서 계속 진행된다 */
function withTimeout(p: Promise<boolean>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(false);
    }, ms);
    p.then(
      (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(ok);
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

// ───────────────────────── 모듈 수준 캐시 ─────────────────────────

type ProgressListener = (p: PreloadProgress) => void;

const listeners: ProgressListener[] = [];
let running: Promise<PreloadProgress> | null = null;
let current: PreloadProgress = { loaded: 0, total: 0, failed: 0, label: '' };

function snapshot(): PreloadProgress {
  return { loaded: current.loaded, total: current.total, failed: current.failed, label: current.label };
}

function emit(): void {
  const p = snapshot();
  for (let i = 0; i < listeners.length; i++) {
    try {
      listeners[i](p);
    } catch {
      /* 화면 갱신 실패가 로딩을 막지 않는다 */
    }
  }
}

/** 전체 제한 시간이 지난 뒤에는 화면 갱신을 멈춘다 (받기는 계속한다) */
let settled = false;

async function runAll(): Promise<PreloadProgress> {
  const tasks = buildPlan();
  current = { loaded: 0, total: tasks.length, failed: 0, label: '' };
  emit();

  if (!hasDom()) {
    // node 등 DOM 이 없는 환경: 받을 것이 없으므로 즉시 완료로 본다
    current = { loaded: tasks.length, total: tasks.length, failed: 0, label: '완료' };
    settled = true;
    emit();
    return snapshot();
  }

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      const task = tasks[i];
      let ok = false;
      try {
        ok = await withTimeout(task.run(), ASSET_TIMEOUT_MS);
      } catch {
        ok = false;
      }
      current.loaded++;
      if (!ok) current.failed++;
      // 전체 제한 시간이 지난 뒤(settled)에는 마지막 안내 문구를 덮어쓰지 않는다
      if (!settled) {
        current.label = `${PRELOAD_KIND_KO[task.kind]} ${task.key}`;
        emit();
      }
    }
  };

  const workers: Promise<void>[] = [];
  const n = Math.min(PRELOAD_CONCURRENCY, Math.max(1, tasks.length));
  for (let i = 0; i < n; i++) workers.push(worker());

  const all = Promise.all(workers).then(() => undefined);
  let overallTimer: ReturnType<typeof setTimeout> | null = null;
  const overall = new Promise<void>((resolve) => {
    overallTimer = setTimeout(resolve, TOTAL_TIMEOUT_MS);
  });
  await Promise.race([all, overall]);
  // 먼저 다 받았으면 남은 타이머를 치운다
  if (overallTimer !== null) clearTimeout(overallTimer);

  settled = true;
  current.label = current.loaded >= current.total ? '완료' : '남은 그림은 배경에서 계속 받습니다';
  const done = snapshot();
  emit();
  return done;
}

/**
 * 모든 그림(배경·스프라이트·직업 아이콘·이펙트)을 미리 받는다.
 * 두 번 호출해도 실제 요청은 한 번뿐이고, 나중에 부른 쪽도 지금까지의 진행률을 즉시 받는다.
 * 실패한 자산은 폴백(코드 생성 시트·임시 이펙트)이 있으므로 조용히 넘어간다.
 */
export function preloadAllArt(onProgress: (p: PreloadProgress) => void): Promise<PreloadProgress> {
  listeners.push(onProgress);
  if (running) {
    // 이미 진행 중이거나 끝났다면 현재 상태를 한 번 알려준다
    try {
      onProgress(snapshot());
    } catch {
      /* 무시 */
    }
    return running;
  }
  running = runAll();
  return running;
}

/** 프리로드가 이미 끝났는지 (건너뛴 뒤에도 남은 것은 백그라운드로 계속 받는다) */
export function preloadSettled(): boolean {
  return settled;
}

/** 지금까지의 진행률 */
export function preloadProgress(): PreloadProgress {
  return snapshot();
}

/** 상태 초기화 (테스트용) */
export function resetPreload(): void {
  listeners.length = 0;
  running = null;
  settled = false;
  current = { loaded: 0, total: 0, failed: 0, label: '' };
}
