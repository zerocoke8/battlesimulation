/**
 * 스프라이트 로더 (v0.7 설계 [5]).
 *
 * public/sprites/<key>.png + <key>.json 을 비동기로 읽어 SpriteSheet 로 만든다. 없으면(404·로드 실패) 코드 생성 시트로 폴백.
 *  - resolveSheet(key, tint?): 동기. 이미 로드된 외부 시트가 있으면 그것, 아니면 코드 생성 시트를 돌려주고 로드를 한 번 시작한다.
 *    렌더러는 매 프레임 이 함수로 시트를 얻으면 된다 (로드가 끝난 다음 프레임부터 외부 시트로 바뀐다).
 *  - preloadSprites(keys): 전투 시작 시 유닛 키를 모아 미리 로드.
 *  - loadExternalSheet(key): 직접 로드 (결과 캐시 없음. 보통 resolveSheet / preloadSprites 를 쓴다).
 * 시뮬레이션에는 영향이 없다. DOM 이 없는 환경(node)에서는 항상 코드 생성 시트만 쓴다.
 */
import type { SpriteKey, SpriteMeta, SpriteSheet } from './spriteTypes';
import { ALL_SPRITE_KEYS, ANIM_NAMES, DEFAULT_META, parseSpriteMeta, spriteAssetPaths } from './spriteTypes';
import { getSpriteSheet, isTintableKey } from './sprites';
import { applyHueTint } from './palette';

export type SpriteLoadState = 'idle' | 'loading' | 'loaded' | 'missing';

const STATE = new Map<SpriteKey, SpriteLoadState>();
const EXTERNAL = new Map<SpriteKey, SpriteSheet>();
const PENDING = new Map<SpriteKey, Promise<SpriteSheet | null>>();
const TINTED_EXTERNAL = new Map<string, SpriteSheet>();
let version = 0;

/** 외부 시트가 새로 로드될 때마다 1 씩 오른다. 렌더러가 캐시 무효화에 쓸 수 있다 */
export function spriteSheetVersion(): number {
  return version;
}

function hasDom(): boolean {
  return typeof document !== 'undefined' && typeof Image !== 'undefined';
}

/**
 * Vite 의 base (vite.config: './'). `import.meta.env` 를 **그대로** 읽어야 Vite 가 빌드 시 정적으로 치환한다
 * (`import.meta` 를 변수에 담아 두면 치환되지 않아 브라우저에서 env 가 undefined 가 된다). 타입은 src/vite-env.d.ts.
 * Vite 밖(node 하네스)에서는 env 가 없으므로 './' 폴백.
 */
function baseUrl(): string {
  const env: { BASE_URL?: unknown } | undefined = import.meta.env;
  const raw = env && typeof env.BASE_URL === 'string' ? env.BASE_URL : './';
  return raw.length === 0 || raw.charAt(raw.length - 1) === '/' ? raw : raw + '/';
}

/** 키의 외부 에셋 URL (base 포함) */
export function spriteAssetUrls(key: SpriteKey): { png: string; json: string } {
  const p = spriteAssetPaths(key);
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

async function loadMeta(url: string): Promise<SpriteMeta> {
  if (typeof fetch === 'undefined') return DEFAULT_META;
  try {
    const res = await fetch(url, { cache: 'default' });
    if (!res.ok) return DEFAULT_META;
    const ct = res.headers.get('content-type') ?? '';
    // Vite dev 서버는 없는 파일에 index.html 을 돌려줄 수 있다 → JSON 이 아니면 기본값
    if (ct.indexOf('html') >= 0) return DEFAULT_META;
    const raw: unknown = await res.json();
    return parseSpriteMeta(raw) ?? DEFAULT_META;
  } catch {
    return DEFAULT_META;
  }
}

/** 시트 크기가 메타와 맞는지 (안 맞으면 경고만 하고 그대로 쓴다) */
function checkSheetSize(key: SpriteKey, img: HTMLImageElement, meta: SpriteMeta): void {
  let needW = 0;
  let needH = 0;
  for (let i = 0; i < ANIM_NAMES.length; i++) {
    const d = meta.anims[ANIM_NAMES[i]];
    needW = Math.max(needW, d.frames * meta.frameW);
    needH = Math.max(needH, (d.row + 1) * meta.frameH);
  }
  if (img.naturalWidth < needW || img.naturalHeight < needH) {
    console.warn(`[sprites] ${key}: 시트 크기 ${img.naturalWidth}×${img.naturalHeight} 가 메타(${needW}×${needH})보다 작습니다. 일부 프레임이 비어 보일 수 있습니다.`);
  }
}

/**
 * public/sprites/<key>.png (+ .json) 를 로드한다. PNG 가 없거나 실패하면 null.
 * JSON 이 없거나 깨졌으면 DEFAULT_META. 결과는 캐시하지 않는다 (resolveSheet / preloadSprites 가 캐시).
 */
export async function loadExternalSheet(key: SpriteKey): Promise<SpriteSheet | null> {
  if (!hasDom()) return null;
  const urls = spriteAssetUrls(key);
  const [img, meta] = await Promise.all([loadImage(urls.png), loadMeta(urls.json)]);
  if (!img) return null;
  checkSheetSize(key, img, meta);
  let tintMask: HTMLImageElement | null = null;
  if (meta.tintMask) {
    const loaded = await loadImage(urls.png.slice(0, urls.png.lastIndexOf('/') + 1) + meta.tintMask);
    if (loaded && loaded.naturalWidth === img.naturalWidth && loaded.naturalHeight === img.naturalHeight) tintMask = loaded;
  }
  return { key, image: img, meta, tintable: isTintableKey(key), ...(tintMask ? { tintMask } : {}) };
}

/** 로드를 한 번만 시작한다. 이미 시작했으면 그 Promise */
function ensureLoading(key: SpriteKey): Promise<SpriteSheet | null> {
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
  const p = loadExternalSheet(key)
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

export function spriteLoadState(key: SpriteKey): SpriteLoadState {
  return STATE.get(key) ?? 'idle';
}

/** 외부 시트가 로드되어 있는지 */
export function hasExternalSheet(key: SpriteKey): boolean {
  return EXTERNAL.has(key);
}

/** 외부 시트(이미지)에 팔레트 틴트를 적용한 복사본 (캐시). 캔버스에 그려 픽셀을 바꾼다 */
function tintExternal(sheet: SpriteSheet, tint: string): SpriteSheet {
  // If an authored mask fails to load, preserve the source art's face colors.
  if (sheet.meta.tintMask && !sheet.tintMask) return sheet;
  const ck = `${sheet.key}|${tint}`;
  const hit = TINTED_EXTERNAL.get(ck);
  if (hit) return hit;
  const img = sheet.image as HTMLImageElement;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  let result: SpriteSheet = sheet;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, w, h);
      let mask: Uint8ClampedArray | undefined;
      if (sheet.tintMask) {
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(sheet.tintMask, 0, 0);
        mask = ctx.getImageData(0, 0, w, h).data;
      }
      applyHueTint(data.data, tint, mask);
      ctx.putImageData(data, 0, 0);
      result = { key: sheet.key, image: canvas, meta: sheet.meta, tintable: true };
    }
  } catch {
    // 교차 출처 등으로 픽셀을 읽을 수 없으면 원본 그대로
    result = sheet;
  }
  TINTED_EXTERNAL.set(ck, result);
  return result;
}

/**
 * 동기 조회. 외부 시트가 로드되어 있으면 그것(틴트 적용), 아니면 코드 생성 시트를 돌려주고 로드를 한 번 시작한다.
 * tint 는 세부 직업 색('#rrggbb'). 직업 시트에만 적용된다.
 */
export function resolveSheet(key: SpriteKey, tint?: string): SpriteSheet {
  const ext = EXTERNAL.get(key);
  if (ext) {
    if (tint && ext.tintable) return tintExternal(ext, tint);
    return ext;
  }
  const st = STATE.get(key);
  if (st === undefined || st === 'idle') void ensureLoading(key);
  return getSpriteSheet(key, tint);
}

/** 여러 키를 미리 로드한다. 모두 끝나면(성공·실패 무관) resolve. 같은 키를 여러 번 넣어도 한 번만 로드 */
export function preloadSprites(keys: readonly string[]): Promise<void> {
  const seen = new Set<string>();
  const ps: Promise<SpriteSheet | null>[] = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (seen.has(k)) continue;
    seen.add(k);
    ps.push(ensureLoading(k));
  }
  return Promise.all(ps).then(() => undefined);
}

/** 31개 키 전부 미리 로드 */
export function preloadAllSprites(): Promise<void> {
  return preloadSprites(ALL_SPRITE_KEYS);
}

/** 로더 상태 초기화 (테스트용) */
export function resetSpriteLoader(): void {
  STATE.clear();
  EXTERNAL.clear();
  PENDING.clear();
  TINTED_EXTERNAL.clear();
}
