/**
 * 이펙트 로더 (v0.9 설계 [2]). 스프라이트 로더(src/ui/pixel/loader.ts)와 같은 방식이다.
 *
 * public/effects/<key>.png + <key>.json 을 비동기로 읽어 FxSheet 로 만든다.
 * 없거나(404) 깨졌으면 조용히 코드 생성 임시 이펙트로 폴백한다. DOM 이 없는 환경(node)에서는 항상 임시 이펙트.
 *
 *  - resolveFx(key):    동기. 외부 시트가 로드돼 있으면 그것, 없으면 임시 시트를 돌려주고 로드를 한 번 시작한다.
 *                       렌더러는 매 프레임 이 함수만 호출하면 된다 (로드가 끝난 다음 프레임부터 외부 시트로 바뀐다).
 *  - preloadFx(keys):   전투 시작 시 미리 로드.
 *  - loadExternalFx:    직접 로드 (캐시 없음).
 *  - hasExternalFx:     외부 시트가 로드돼 있는지.
 * 시뮬레이션에는 영향이 없다.
 */
import type { FxKey, FxMeta, FxSheet } from './fxTypes';
import { FX_KEYS, fxAssetPaths, fxDefaultMeta, parseFxMeta } from './fxTypes';
import { getFxSheet } from './fxSprites';

export type FxLoadState = 'idle' | 'loading' | 'loaded' | 'missing';

const STATE = new Map<FxKey, FxLoadState>();
const EXTERNAL = new Map<FxKey, FxSheet>();
const PENDING = new Map<FxKey, Promise<FxSheet | null>>();
let version = 0;

/** 외부 시트가 새로 로드될 때마다 1 씩 오른다. 렌더러가 캐시 무효화에 쓸 수 있다 */
export function fxSheetVersion(): number {
  return version;
}

function hasDom(): boolean {
  return typeof document !== 'undefined' && typeof Image !== 'undefined';
}

/**
 * Vite 의 base. `import.meta.env` 를 **그대로** 읽어야 빌드 시 정적으로 치환된다
 * (loader.ts 와 같은 이유). Vite 밖(node)에서는 './' 폴백.
 */
function baseUrl(): string {
  const env: { BASE_URL?: unknown } | undefined = import.meta.env;
  const raw = env && typeof env.BASE_URL === 'string' ? env.BASE_URL : './';
  return raw.length === 0 || raw.charAt(raw.length - 1) === '/' ? raw : raw + '/';
}

/** 키의 외부 에셋 URL (base 포함) */
export function fxAssetUrls(key: FxKey): { png: string; json: string } {
  const p = fxAssetPaths(key);
  const b = baseUrl();
  return { png: b + p.png, json: b + p.json };
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0 ? img : null);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function loadMeta(url: string, key: FxKey): Promise<FxMeta> {
  const base = fxDefaultMeta(key);
  if (typeof fetch === 'undefined') return base;
  try {
    const res = await fetch(url, { cache: 'default' });
    if (!res.ok) return base;
    const ct = res.headers.get('content-type') ?? '';
    // Vite dev 서버는 없는 파일에 index.html 을 돌려줄 수 있다 → JSON 이 아니면 기본값
    if (ct.indexOf('html') >= 0) return base;
    const raw: unknown = await res.json();
    return parseFxMeta(raw, key);
  } catch {
    return base;
  }
}

/** 시트 크기가 메타와 맞는지 (안 맞으면 경고만 하고 그대로 쓴다) */
function checkSheetSize(key: FxKey, img: HTMLImageElement, meta: FxMeta): void {
  const needW = meta.frameW * meta.frames;
  const needH = meta.frameH;
  if (img.naturalWidth < needW || img.naturalHeight < needH) {
    console.warn(
      `[effects] ${key}: 시트 크기 ${img.naturalWidth}×${img.naturalHeight} 가 메타(${needW}×${needH})보다 작습니다. 일부 프레임이 비어 보일 수 있습니다.`,
    );
  }
}

/**
 * public/effects/<key>.png (+ .json) 를 로드한다. PNG 가 없거나 실패하면 null.
 * JSON 이 없거나 깨졌으면 그 키의 기본 메타. 결과는 캐시하지 않는다 (resolveFx / preloadFx 가 캐시).
 */
export async function loadExternalFx(key: FxKey): Promise<FxSheet | null> {
  if (!hasDom()) return null;
  const urls = fxAssetUrls(key);
  const [img, meta] = await Promise.all([loadImage(urls.png), loadMeta(urls.json, key)]);
  if (!img) return null;
  checkSheetSize(key, img, meta);
  return { key, image: img, meta };
}

/** 로드를 한 번만 시작한다. 이미 시작했으면 그 Promise */
function ensureLoading(key: FxKey): Promise<FxSheet | null> {
  const pending = PENDING.get(key);
  if (pending) return pending;
  const st = STATE.get(key);
  if (st === 'loaded') return Promise.resolve(EXTERNAL.get(key) ?? null);
  if (st === 'missing') return Promise.resolve(null);
  if (!hasDom()) {
    STATE.set(key, 'missing');
    return Promise.resolve(null);
  }
  STATE.set(key, 'loading');
  const p = loadExternalFx(key)
    .then((sheet) => {
      if (sheet) {
        EXTERNAL.set(key, sheet);
        STATE.set(key, 'loaded');
        version++;
      } else {
        STATE.set(key, 'missing');
      }
      PENDING.delete(key);
      return sheet;
    })
    .catch(() => {
      STATE.set(key, 'missing');
      PENDING.delete(key);
      return null;
    });
  PENDING.set(key, p);
  return p;
}

export function fxLoadState(key: FxKey): FxLoadState {
  return STATE.get(key) ?? 'idle';
}

/** 외부 시트가 로드되어 있는지 */
export function hasExternalFx(key: FxKey): boolean {
  return EXTERNAL.has(key);
}

/**
 * 동기 조회. 외부 시트가 로드돼 있으면 그것, 없으면 코드 생성 임시 시트를 돌려주고 로드를 한 번 시작한다.
 * 렌더러는 매 프레임 이것만 부르면 된다.
 */
export function resolveFx(key: FxKey): FxSheet {
  const ext = EXTERNAL.get(key);
  if (ext) return ext;
  const st = STATE.get(key);
  if (st === undefined || st === 'idle') void ensureLoading(key);
  return getFxSheet(key);
}

/**
 * 여러 키의 외부 시트를 미리 로드한다 (전투 시작 시). 같은 키를 여러 번 넣어도 한 번만 로드하며,
 * 실패는 조용히 무시된다 (그 키는 계속 임시 이펙트).
 */
export function preloadFx(keys: readonly FxKey[]): void {
  const seen = new Set<FxKey>();
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (seen.has(k)) continue;
    seen.add(k);
    void ensureLoading(k);
  }
}

/** FX_KEYS 전부 미리 로드 */
export function preloadAllFx(): void {
  preloadFx(FX_KEYS);
}

/** 로더 상태 초기화 (테스트용) */
export function resetFxLoader(): void {
  STATE.clear();
  EXTERNAL.clear();
  PENDING.clear();
}
