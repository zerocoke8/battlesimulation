/**
 * 코드 생성 임시 도트 스프라이트 (v0.7 설계 [5]).
 *
 * 외부 에셋(public/sprites/<key>.png)이 없을 때 쓰는 64×64 픽셀 인형을 결정론적으로 만든다 (난수 없음).
 * 시트 규격은 docs/SPRITES.md / spriteTypes.ts 의 DEFAULT_META 와 같다:
 *   애니메이션당 1행(idle, walk, attack, cast, hit, death), 열 = 프레임, 오른쪽을 보는 기준, 앵커 (32, 58).
 *
 * 구조
 *  - PixelBuffer: RGBA 픽셀 배열 (DOM 없이 동작 → node self-check 가능)
 *  - G: 프레임 하나에 그리는 작은 도트 툴킷 (px, rect, line, disc, ellipse, tri, ray, outline, mirror)
 *  - 몸체 드로어: humanoid / blob / quadruped / bat / mushroom / ghost / dragon / golem / spirit / turret
 *  - DESIGNS: 키 31개 (직업 9, 소환물 4, 몬스터 18) → 드로어 + 옵션
 *  - hit / death 는 idle 0 프레임을 회전·이동시켜 만든다 (모든 몸체 공통: 뒤로 젖혀짐 → 쓰러짐)
 *  - getSpriteSheet(key, tint?): 캔버스에 올린 SpriteSheet (캐시). tint 는 세부 직업 색 (palette.applyHueTint)
 */
import type { AnimName, SpriteKey, SpriteSheet } from './spriteTypes';
import { ANIM_NAMES, DEFAULT_META, FALLBACK_SPRITE_KEY, SPRITE_FRAME_H, SPRITE_FRAME_W, spriteKeyKind } from './spriteTypes';
import {
  BONE, BONE_DARK, CLOTH_GREY, CLOTH_GREY_DARK, EYE, JOB_PALETTE, LEATHER, LEATHER_DARK, METAL, METAL_DARK, METAL_LIGHT,
  OUTLINE, RUST, SHADOW_PURPLE, SKIN, SKIN_DARK, SKIN_GREEN, SKIN_GREEN_DARK, SKIN_RED, STONE, STONE_DARK, STONE_LIGHT, WHITE,
  WOOD, WOOD_DARK, applyHueTint, hexToRgb,
} from './palette';

const FW = SPRITE_FRAME_W;
const FH = SPRITE_FRAME_H;
/** 앵커 (발 위치) */
const AX = DEFAULT_META.anchor.x;
const AY = DEFAULT_META.anchor.y;

// ───────────────────────── 픽셀 버퍼 ─────────────────────────

/** RGBA 픽셀 배열. 캔버스 없이 만들 수 있어 node 에서도 검사할 수 있다 */
export class PixelBuffer {
  readonly data: Uint8ClampedArray;
  constructor(readonly w: number, readonly h: number) {
    this.data = new Uint8ClampedArray(w * h * 4);
  }

  /** source-over 합성. a < 255 면 기존 픽셀과 섞는다 */
  set(x: number, y: number, r: number, g: number, b: number, a: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = (y * this.w + x) * 4;
    const d = this.data;
    if (a >= 255 || d[i + 3] === 0) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = a;
      return;
    }
    const sa = a / 255;
    const da = d[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    d[i] = Math.round((r * sa + d[i] * da * (1 - sa)) / oa);
    d[i + 1] = Math.round((g * sa + d[i + 1] * da * (1 - sa)) / oa);
    d[i + 2] = Math.round((b * sa + d[i + 2] * da * (1 - sa)) / oa);
    d[i + 3] = Math.round(oa * 255);
  }

  alphaAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.data[(y * this.w + x) * 4 + 3];
  }

  clone(): PixelBuffer {
    const b = new PixelBuffer(this.w, this.h);
    b.data.set(this.data);
    return b;
  }
}

// ───────────────────────── 프레임 툴킷 ─────────────────────────

/** 프레임 하나(64×64) 안에 그리는 툴킷. 좌표는 프레임 기준, 프레임 밖은 자동 클리핑 */
export class G {
  constructor(readonly buf: PixelBuffer, readonly ox: number, readonly oy: number) {}

  px(x: number, y: number, c: string, a = 255): void {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= FW || yi >= FH) return;
    const [r, g, b] = hexToRgb(c);
    this.buf.set(this.ox + xi, this.oy + yi, r, g, b, a);
  }

  rect(x: number, y: number, w: number, h: number, c: string, a = 255): void {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    for (let yy = 0; yy < Math.round(h); yy++) for (let xx = 0; xx < Math.round(w); xx++) this.px(x0 + xx, y0 + yy, c, a);
  }

  hline(x0: number, x1: number, y: number, c: string, a = 255): void {
    const a0 = Math.min(Math.round(x0), Math.round(x1));
    const a1 = Math.max(Math.round(x0), Math.round(x1));
    for (let x = a0; x <= a1; x++) this.px(x, y, c, a);
  }

  vline(x: number, y0: number, y1: number, c: string, a = 255): void {
    const a0 = Math.min(Math.round(y0), Math.round(y1));
    const a1 = Math.max(Math.round(y0), Math.round(y1));
    for (let y = a0; y <= a1; y++) this.px(x, y, c, a);
  }

  /** 브레젠험 선. w > 1 이면 각 점에 w×w 브러시 */
  line(x0: number, y0: number, x1: number, y1: number, c: string, w = 1, a = 255): void {
    let xa = Math.round(x0);
    let ya = Math.round(y0);
    const xb = Math.round(x1);
    const yb = Math.round(y1);
    const dx = Math.abs(xb - xa);
    const dy = -Math.abs(yb - ya);
    const sx = xa < xb ? 1 : -1;
    const sy = ya < yb ? 1 : -1;
    let err = dx + dy;
    const off = Math.floor(w / 2);
    for (let guard = 0; guard < 512; guard++) {
      if (w <= 1) this.px(xa, ya, c, a);
      else for (let yy = 0; yy < w; yy++) for (let xx = 0; xx < w; xx++) this.px(xa - off + xx, ya - off + yy, c, a);
      if (xa === xb && ya === yb) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        xa += sx;
      }
      if (e2 <= dx) {
        err += dx;
        ya += sy;
      }
    }
  }

  /** (x,y) 에서 deg 방향(0 = 오른쪽, −90 = 위)으로 len 만큼 선. 끝점을 돌려준다 */
  ray(x: number, y: number, deg: number, len: number, c: string, w = 1, a = 255): [number, number] {
    const r = (deg * Math.PI) / 180;
    const ex = x + Math.cos(r) * len;
    const ey = y + Math.sin(r) * len;
    this.line(x, y, ex, ey, c, w, a);
    return [ex, ey];
  }

  disc(cx: number, cy: number, r: number, c: string, a = 255): void {
    this.ellipse(cx, cy, r, r, c, a);
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, c: string, a = 255): void {
    const x0 = Math.round(cx);
    const y0 = Math.round(cy);
    const rxx = Math.max(0.5, rx);
    const ryy = Math.max(0.5, ry);
    const ex = Math.ceil(rxx);
    const ey = Math.ceil(ryy);
    for (let yy = -ey; yy <= ey; yy++) {
      for (let xx = -ex; xx <= ex; xx++) {
        const v = (xx * xx) / (rxx * rxx + rxx * 0.5) + (yy * yy) / (ryy * ryy + ryy * 0.5);
        if (v <= 1) this.px(x0 + xx, y0 + yy, c, a);
      }
    }
  }

  /** 위(top=true) 또는 아래 반원 */
  halfDisc(cx: number, cy: number, r: number, c: string, top: boolean, a = 255): void {
    const x0 = Math.round(cx);
    const y0 = Math.round(cy);
    const er = Math.ceil(r);
    for (let yy = -er; yy <= er; yy++) {
      if (top && yy > 0) continue;
      if (!top && yy < 0) continue;
      for (let xx = -er; xx <= er; xx++) if (xx * xx + yy * yy <= r * r + r * 0.5) this.px(x0 + xx, y0 + yy, c, a);
    }
  }

  ring(cx: number, cy: number, r: number, c: string, a = 255): void {
    const x0 = Math.round(cx);
    const y0 = Math.round(cy);
    const er = Math.ceil(r) + 1;
    for (let yy = -er; yy <= er; yy++) {
      for (let xx = -er; xx <= er; xx++) {
        const d = Math.sqrt(xx * xx + yy * yy);
        if (d >= r - 0.6 && d <= r + 0.5) this.px(x0 + xx, y0 + yy, c, a);
      }
    }
  }

  /** 채운 삼각형 */
  tri(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, c: string, a = 255): void {
    const minX = Math.floor(Math.min(x0, x1, x2));
    const maxX = Math.ceil(Math.max(x0, x1, x2));
    const minY = Math.floor(Math.min(y0, y1, y2));
    const maxY = Math.ceil(Math.max(y0, y1, y2));
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-6) {
      this.line(x0, y0, x1, y1, c, 1, a);
      this.line(x1, y1, x2, y2, c, 1, a);
      return;
    }
    const sgn = area > 0 ? 1 : -1;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((x1 - x0) * (py - y0) - (px - x0) * (y1 - y0)) * sgn;
        const w1 = ((x2 - x1) * (py - y1) - (px - x1) * (y2 - y1)) * sgn;
        const w2 = ((x0 - x2) * (py - y2) - (px - x2) * (y0 - y2)) * sgn;
        if (w0 >= -0.6 && w1 >= -0.6 && w2 >= -0.6) this.px(x, y, c, a);
      }
    }
  }

  alphaAt(x: number, y: number): number {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= FW || yi >= FH) return 0;
    return this.buf.alphaAt(this.ox + xi, this.oy + yi);
  }

  /** 불투명 픽셀에 4방향으로 닿은 투명 픽셀을 외곽선 색으로 채운다 */
  outline(c: string): void {
    const todo: number[] = [];
    for (let y = 0; y < FH; y++) {
      for (let x = 0; x < FW; x++) {
        if (this.alphaAt(x, y) > 0) continue;
        if (this.alphaAt(x - 1, y) > 40 || this.alphaAt(x + 1, y) > 40 || this.alphaAt(x, y - 1) > 40 || this.alphaAt(x, y + 1) > 40) {
          todo.push(x, y);
        }
      }
    }
    for (let i = 0; i < todo.length; i += 2) this.px(todo[i], todo[i + 1], c);
  }

  /** 프레임을 좌우 반전 (x 기준 = 앵커 x) */
  mirror(): void {
    const w = FW;
    for (let y = 0; y < FH; y++) {
      for (let x = 0; x < w / 2; x++) {
        const i = ((this.oy + y) * this.buf.w + this.ox + x) * 4;
        const j = ((this.oy + y) * this.buf.w + this.ox + (w - 1 - x)) * 4;
        const d = this.buf.data;
        for (let k = 0; k < 4; k++) {
          const t = d[i + k];
          d[i + k] = d[j + k];
          d[j + k] = t;
        }
      }
    }
  }
}

// ───────────────────────── 애니메이션 보조 ─────────────────────────

/** 프레임 인덱스 → 애니메이션 진행 파라미터 */
interface Pose {
  anim: AnimName;
  f: number;
  n: number;
  /** 세로 흔들림 (음수 = 위) */
  bob: number;
  /** 다리 흔들림 −1~1 (앞다리가 앞으로 나가면 +) */
  leg: number;
  /** 공격 단계 0~3 (attack 아닐 때 −1) */
  atk: number;
  /** 시전 단계 0~3 (cast 아닐 때 −1) */
  cast: number;
  /** 날개 펄럭임 0~6 */
  flap: number;
  /** 몸 기울기 x 오프셋 */
  lean: number;
}

const IDLE_BOB = [0, -1, -2, -1];
const WALK_LEG = [1, 0.5, -0.5, -1, -0.5, 0.5];
const WALK_BOB = [0, -1, -2, 0, -1, -2];
const ATK_LEAN = [-1, 0, 2, 1];

function makePose(anim: AnimName, f: number, n: number): Pose {
  const p: Pose = { anim, f, n, bob: 0, leg: 0, atk: -1, cast: -1, flap: 0, lean: 0 };
  switch (anim) {
    case 'idle':
      p.bob = IDLE_BOB[f % 4];
      p.flap = [0, 2, 4, 2][f % 4];
      break;
    case 'walk':
      p.leg = WALK_LEG[f % 6];
      p.bob = WALK_BOB[f % 6];
      p.flap = [0, 2, 4, 6, 4, 2][f % 6];
      break;
    case 'attack':
      p.atk = Math.min(3, f);
      p.lean = ATK_LEAN[p.atk];
      p.flap = [4, 6, 0, 2][p.atk];
      break;
    case 'cast':
      p.cast = Math.min(3, f);
      p.flap = [2, 4, 6, 4][p.cast];
      p.bob = [0, -1, -1, 0][p.cast];
      break;
    default:
      break;
  }
  return p;
}

/** 시전 글로우 크기 단계 1~4 */
function castGlowR(p: Pose): number {
  return [2, 3, 4, 3][Math.max(0, p.cast)];
}

function drawGlow(g: G, x: number, y: number, r: number, color: string): void {
  g.disc(x, y, r + 1, color, 90);
  g.disc(x, y, r, color, 200);
  if (r >= 3) g.disc(x, y, r - 2, WHITE, 230);
  // 십자 반짝임
  g.px(x - r - 2, y, color, 180);
  g.px(x + r + 2, y, color, 180);
  g.px(x, y - r - 2, color, 180);
  g.px(x, y + r + 2, color, 180);
}

/** 작은 파티클 몇 개를 결정론적으로 뿌린다 (앞쪽 방향으로 퍼짐) */
function drawSparks(g: G, x: number, y: number, dir: number, stage: number, color: string, core: string): void {
  const spread = [2, 5, 8, 6][Math.max(0, Math.min(3, stage))];
  for (let i = 0; i < 6; i++) {
    const ang = dir + (i - 2.5) * 14;
    const dist = spread + (i % 3) * 2;
    const rr = (ang * Math.PI) / 180;
    const px = x + Math.cos(rr) * dist;
    const py = y + Math.sin(rr) * dist;
    g.px(px, py, i % 2 === 0 ? core : color);
    if (spread > 4) g.px(px + Math.cos(rr) * 2, py + Math.sin(rr) * 2, color, 180);
  }
}

type Drawer = (g: G, p: Pose) => void;

interface Design {
  draw: Drawer;
  tintable: boolean;
}

// ───────────────────────── 인간형 ─────────────────────────

type WeaponKind =
  | 'sword' | 'greatsword' | 'axe' | 'daggers' | 'bow' | 'rifle' | 'staff' | 'holystaff' | 'book' | 'club' | 'scythe' | 'claws' | 'none';
type HeadKind = 'bare' | 'hair' | 'hood' | 'hat' | 'helmet' | 'horned' | 'skull' | 'cap' | 'bandana' | 'brim' | 'flame';

interface HumanoidOpts {
  scale?: number;
  skin: string;
  skinDark?: string;
  /** 상의 (틴트 대상이 되려면 채도 있는 색) */
  body: string;
  bodyDark: string;
  /** 바지 색. 없으면 bodyDark */
  legs?: string;
  /** 로브: 다리 대신 발까지 내려오는 치마. 색은 body */
  robe?: boolean;
  /** 로브 색을 상의와 다르게 */
  robeColor?: string;
  head: HeadKind;
  headColor?: string;
  hair?: string;
  weapon: WeaponKind;
  weaponColor?: string;
  weaponAccent?: string;
  shield?: string;
  cape?: string;
  wings?: string;
  wingsDark?: string;
  quiver?: boolean;
  bareChest?: boolean;
  /** 눈 색 (빛나는 눈). 없으면 검정 */
  eyes?: string;
  /** 속 빈 갑옷: 피부 대신 어두운 속 */
  hollow?: boolean;
  /** 해골: 갈비뼈 무늬 */
  skeleton?: boolean;
  /** 떠 있음: 다리 없이 로브가 뾰족하게 끝남 + 부유 흔들림 */
  float?: boolean;
  /** 공중 부양 높이 (다리는 그대로, 전체가 떠 있음) */
  hover?: number;
  tail?: string;
  horns?: string;
  tusks?: boolean;
  /** 어깨 넓은 거구 */
  brute?: boolean;
  sash?: string;
  glow: string;
  glowCore?: string;
}

function isMelee(w: WeaponKind): boolean {
  return w === 'sword' || w === 'greatsword' || w === 'axe' || w === 'daggers' || w === 'club' || w === 'scythe' || w === 'claws' || w === 'none';
}

function drawHumanoid(g: G, p: Pose, o: HumanoidOpts): void {
  const s = o.scale ?? 1;
  const S = (v: number): number => Math.round(v * s);
  const floatBob = o.float ? [0, -2, -3, -2, -1, -1][p.f % 6] : 0;
  const hover = (o.hover ?? 0) + (o.float ? 4 : 0);
  const baseX = AX + p.lean;
  const baseY = AY + p.bob + floatBob - S(hover);
  const X = (dx: number): number => baseX + S(dx);
  const Y = (dy: number): number => baseY + S(dy);
  const skin = o.hollow ? o.bodyDark : o.skin;
  const legsC = o.legs ?? o.bodyDark;
  const wide = o.brute ? 9 : 7;
  const shoulder = o.brute ? 8 : 6;
  const armW = Math.max(2, S(3));
  const legW = Math.max(2, S(o.brute ? 4 : 3));
  const armLen = S(11);
  const flap = p.flap;
  const eyeC = o.eyes ?? EYE;
  const weaponC = o.weaponColor ?? METAL_LIGHT;
  const weaponA = o.weaponAccent ?? WOOD;
  const glowCore = o.glowCore ?? WHITE;

  // 팔 각도 (0 = 앞, −90 = 위, 90 = 아래)
  let frontArm = 75;
  let backArm = 95;
  if (p.anim === 'idle') {
    frontArm = 75 + [0, 3, 6, 3][p.f % 4];
    backArm = 95 - [0, 3, 6, 3][p.f % 4];
  } else if (p.anim === 'walk') {
    frontArm = 75 - p.leg * 28;
    backArm = 95 + p.leg * 28;
  } else if (p.anim === 'attack') {
    if (isMelee(o.weapon)) {
      frontArm = [-120, -80, 5, 40][p.atk];
      backArm = [110, 100, 80, 90][p.atk];
    } else if (o.weapon === 'staff' || o.weapon === 'holystaff') {
      frontArm = [-110, -70, -15, 5][p.atk];
      backArm = [100, 90, 60, 70][p.atk];
    } else if (o.weapon === 'book') {
      frontArm = [-20, -50, -60, -30][p.atk];
      backArm = [20, 0, -10, 10][p.atk];
    } else if (o.weapon === 'rifle') {
      frontArm = 10;
      backArm = 20;
    } else {
      // bow
      frontArm = 0;
      backArm = 0;
    }
  } else if (p.anim === 'cast') {
    frontArm = [-50, -70, -95, -80][p.cast];
    backArm = [-130, -110, -95, -100][p.cast];
  }
  if (o.weapon === 'rifle' && p.anim !== 'attack') {
    frontArm = 25;
    backArm = 15;
  }
  if (o.weapon === 'bow' && p.anim !== 'attack' && p.anim !== 'cast') {
    backArm = 60;
  }

  // ── 날개 (맨 뒤)
  if (o.wings) {
    const wd = o.wingsDark ?? o.wings;
    const lift = S(flap);
    g.tri(X(-2), Y(-26), X(-22), Y(-34) + lift, X(-8), Y(-16), wd);
    g.tri(X(0), Y(-27), X(-18), Y(-42) + lift, X(-6), Y(-21), o.wings);
    g.line(X(0), Y(-27), X(-18), Y(-42) + lift, wd);
  }

  // ── 망토
  if (o.cape) {
    const sway = S(p.leg * 2) + (p.anim === 'attack' ? S(2) : 0);
    g.tri(X(-4), Y(-26), X(-14) - sway, Y(-4), X(-2), Y(-6), o.cape);
    g.tri(X(-4), Y(-26), X(2), Y(-25), X(-2), Y(-6), o.cape);
  }

  // ── 화살통
  if (o.quiver) {
    g.line(X(-9), Y(-31), X(-4), Y(-18), LEATHER, Math.max(2, S(3)));
    g.px(X(-10), Y(-33), o.weaponAccent ?? METAL_LIGHT);
    g.px(X(-8), Y(-34), o.weaponAccent ?? METAL_LIGHT);
    g.px(X(-11), Y(-31), o.weaponAccent ?? METAL_LIGHT);
  }

  // ── 꼬리
  if (o.tail) {
    const sw = S(p.leg * 2) + (p.anim === 'idle' ? [0, 1, 1, 0][p.f % 4] : 0);
    g.line(X(-5), Y(-13), X(-14), Y(-6) + sw, o.tail, 2);
    g.line(X(-14), Y(-6) + sw, X(-17), Y(-11) + sw, o.tail, 2);
    g.px(X(-18), Y(-12) + sw, o.tail);
  }

  // ── 뒷팔 (몸통 뒤)
  const bsx = X(-shoulder + 2);
  const bsy = Y(-25);
  const sleeve = o.bareChest ? skin : o.body;
  const [bhx, bhy] = g.ray(bsx, bsy, backArm, armLen, sleeve, armW);
  g.disc(bhx, bhy, Math.max(1, S(1.5)), skin);

  // ── 뒷다리
  const hipY = Y(-14);
  if (!o.float) {
    if (o.robe) {
      // 로브: 사다리꼴 치마
      const hem = S(p.leg * 2);
      const rc = o.robeColor ?? o.body;
      g.tri(X(-wide), hipY, X(wide), hipY, X(-wide - 3) + hem, Y(-1), rc);
      g.tri(X(wide), hipY, X(wide + 3) + hem, Y(-1), X(-wide - 3) + hem, Y(-1), rc);
      g.hline(X(-wide - 3) + hem, X(wide + 3) + hem, Y(-1), o.bodyDark);
      // 발끝
      g.rect(X(1) + hem, Y(-2), S(4), 2, o.hollow ? o.bodyDark : skin);
    } else {
      const bkFoot = X(-2) - S(p.leg * 4);
      g.line(X(-2), hipY, bkFoot, Y(-3), legsC, legW);
      g.rect(bkFoot - 1, Y(-2), S(4), 2, o.skeleton ? BONE : LEATHER_DARK);
    }
  }

  // ── 몸통
  const torsoTop = Y(-28);
  const torsoH = Y(-14) - torsoTop;
  if (o.bareChest) {
    g.rect(X(-wide), torsoTop, S(wide * 2), torsoH, skin);
    g.rect(X(-wide), torsoTop, S(wide * 2), 2, o.skinDark ?? SKIN_DARK);
    g.vline(X(0), torsoTop + 3, Y(-16), o.skinDark ?? SKIN_DARK);
    g.rect(X(-wide), Y(-16), S(wide * 2), 2, o.body); // 허리띠
  } else {
    g.rect(X(-wide), torsoTop, S(wide * 2), torsoH, o.body);
    g.rect(X(-wide), torsoTop, S(2), torsoH, o.bodyDark);
    g.rect(X(-wide), Y(-16), S(wide * 2), 2, o.bodyDark);
    if (o.skeleton) {
      for (let i = 0; i < 3; i++) g.hline(X(-wide + 1), X(wide - 1), Y(-26 + i * 4), o.bodyDark);
      g.vline(X(0), torsoTop, Y(-16), BONE_DARK);
    }
  }
  if (o.sash) {
    g.line(X(-wide), Y(-27), X(wide), Y(-17), o.sash, 2);
  }
  if (o.hollow) {
    // 갑옷 틈 (어두운 속)
    g.hline(X(-2), X(2), Y(-22), CLOTH_GREY_DARK);
  }

  // ── 방패 (뒷팔이 든다, 몸 앞)
  if (o.shield) {
    const shx = X(9);
    const shy = Y(-20);
    g.ellipse(shx, shy, S(5), S(8), o.shield);
    g.ellipse(shx, shy, S(3), S(6), o.bodyDark, 120);
    g.px(shx, shy, o.weaponAccent ?? METAL_LIGHT);
    g.px(shx, shy - 1, o.weaponAccent ?? METAL_LIGHT);
  }

  // ── 앞다리
  if (!o.float && !o.robe) {
    const frFoot = X(3) + S(p.leg * 4);
    const legLift = p.anim === 'walk' && p.leg > 0.4 ? -S(2) : 0;
    g.line(X(3), hipY, frFoot, Y(-3) + legLift, legsC, legW);
    g.rect(frFoot - 1, Y(-2) + legLift, S(4), 2, o.skeleton ? BONE : LEATHER_DARK);
  }
  if (o.float) {
    // 뾰족한 로브 끝
    const rc = o.robeColor ?? o.body;
    const wave = [0, 1, 2, 1, 0, -1][p.f % 6];
    g.tri(X(-wide), hipY, X(wide), hipY, X(-4) + wave, Y(2), rc);
    g.tri(X(wide), hipY, X(wide - 2), Y(-4), X(-4) + wave, Y(2), rc);
    g.tri(X(-wide), hipY, X(-wide + 2), Y(-4), X(-4) + wave, Y(2), o.bodyDark);
  }

  // ── 머리
  const hcx = X(0) + (p.anim === 'attack' ? S(p.atk === 2 ? 1 : 0) : 0);
  const hcy = Y(-34);
  const hr = S(6);
  const hc = o.headColor ?? o.bodyDark;
  switch (o.head) {
    case 'skull':
      g.disc(hcx, hcy, hr, BONE);
      g.rect(hcx - S(3), hcy + S(2), S(6), S(3), BONE_DARK);
      g.px(hcx + S(2), hcy - 1, EYE);
      g.px(hcx + S(2), hcy, EYE);
      g.px(hcx - S(2), hcy - 1, EYE);
      g.px(hcx - S(2), hcy, EYE);
      if (o.eyes) {
        g.px(hcx + S(2), hcy - 1, o.eyes);
        g.px(hcx - S(2), hcy - 1, o.eyes);
      }
      break;
    case 'flame': {
      g.disc(hcx, hcy, hr, o.skinDark ?? SKIN_DARK);
      const fl = [0, 1, 2, 1, 0, 1][p.f % 6];
      g.line(hcx - S(3), hcy - hr + 1, hcx - S(4), hcy - hr - S(4) - fl, o.glow, 2);
      g.line(hcx, hcy - hr, hcx + 1, hcy - hr - S(6) - fl, o.glow, 2);
      g.line(hcx + S(3), hcy - hr + 1, hcx + S(5), hcy - hr - S(3) - (2 - fl), o.glow, 2);
      g.px(hcx + 1, hcy - hr - S(4), glowCore);
      g.px(hcx + S(3), hcy - 1, glowCore);
      g.px(hcx + S(3), hcy, glowCore);
      break;
    }
    default:
      g.disc(hcx, hcy, hr, skin);
      if (o.hollow) {
        g.rect(hcx - hr, hcy - 2, hr * 2 + 1, 4, CLOTH_GREY_DARK);
      }
      break;
  }
  // 눈
  if (o.head !== 'skull' && o.head !== 'flame') {
    g.px(hcx + S(3), hcy - 1, eyeC);
    if (s >= 1.2) g.px(hcx + S(3), hcy, eyeC);
  }
  if (o.tusks) {
    g.px(hcx + S(2), hcy + S(4), WHITE);
    g.px(hcx + S(5), hcy + S(4), WHITE);
  }
  // 머리 장식
  switch (o.head) {
    case 'hair':
      g.halfDisc(hcx - 1, hcy - 1, hr, o.hair ?? hc, true);
      g.px(hcx + hr - 1, hcy - 2, o.hair ?? hc);
      break;
    case 'hood':
      g.halfDisc(hcx - 1, hcy, hr + 1, hc, true);
      g.rect(hcx - hr - 1, hcy - 1, S(4), S(5), hc);
      g.rect(hcx - hr - 1, hcy - 1, hr + 2, 2, hc);
      g.px(hcx + S(3), hcy - 1, eyeC);
      break;
    case 'hat': {
      const brimY = hcy - hr + 1;
      g.hline(hcx - S(9), hcx + S(8), brimY, hc);
      g.hline(hcx - S(9), hcx + S(8), brimY + 1, o.bodyDark);
      g.tri(hcx - S(6), brimY, hcx + S(5), brimY, hcx - S(3), brimY - S(16), hc);
      g.px(hcx - S(3), brimY - S(16), hc);
      g.px(hcx - S(5), brimY - S(17), hc);
      g.hline(hcx - S(5), hcx + S(4), brimY - 1, o.weaponAccent ?? JOB_PALETTE.mage.accent);
      break;
    }
    case 'helmet':
    case 'horned':
      g.halfDisc(hcx, hcy - 1, hr + 1, METAL, true);
      g.rect(hcx - hr - 1, hcy - 1, S(3), S(5), METAL);
      g.rect(hcx + hr - 1, hcy - 1, S(3), S(3), METAL_DARK);
      g.hline(hcx - hr, hcx + hr, hcy - 1, o.hollow ? (o.eyes ?? '#5ee7ff') : METAL_DARK, o.hollow ? 255 : 160);
      g.px(hcx + S(3), hcy - 1, eyeC);
      if (o.head === 'horned') {
        g.line(hcx - S(4), hcy - hr, hcx - S(8), hcy - hr - S(5), BONE, 2);
        g.line(hcx + S(4), hcy - hr, hcx + S(8), hcy - hr - S(5), BONE, 2);
      }
      break;
    case 'cap':
      g.halfDisc(hcx - 1, hcy - 2, hr, hc, true);
      g.line(hcx - hr, hcy - 3, hcx - hr - S(4), hcy - 6, hc, 2);
      break;
    case 'bandana':
      g.rect(hcx - hr, hcy - S(4), hr * 2 + 1, 2, hc);
      g.line(hcx - hr, hcy - S(3), hcx - hr - S(4), hcy + 1, hc, 2);
      g.rect(hcx - hr + 1, hcy + 1, hr * 2 - 1, S(4), o.bodyDark); // 복면
      break;
    case 'brim': {
      const by = hcy - S(4);
      g.hline(hcx - S(9), hcx + S(9), by, hc);
      g.hline(hcx - S(9), hcx + S(9), by + 1, o.bodyDark);
      g.rect(hcx - S(5), by - S(6), S(10), S(6), hc);
      g.hline(hcx - S(5), hcx + S(4), by - 1, o.weaponAccent ?? o.bodyDark);
      break;
    }
    default:
      break;
  }
  if (o.horns) {
    g.line(hcx - S(4), hcy - hr + 1, hcx - S(7), hcy - hr - S(6), o.horns, 2);
    g.line(hcx + S(3), hcy - hr + 1, hcx + S(6), hcy - hr - S(6), o.horns, 2);
  }

  // ── 앞팔 + 무기
  const fsx = X(shoulder - 2);
  const fsy = Y(-25);
  const [fhx, fhy] = g.ray(fsx, fsy, frontArm, armLen, sleeve, armW);
  g.disc(fhx, fhy, Math.max(1, S(1.5)), skin);

  const stage = p.atk;
  // 무기 각도: 공격·시전 중엔 팔 방향으로, 평소엔 앞쪽 위로 비스듬히 든다 (땅에 안 닿게)
  const wAngle = p.anim === 'attack' || p.anim === 'cast' ? frontArm - 20 : frontArm - 125;
  switch (o.weapon) {
    case 'sword': {
      const [ex, ey] = g.ray(fhx, fhy, wAngle, S(16), weaponC, 2);
      g.px(ex, ey, WHITE);
      g.ray(fhx, fhy, wAngle + 90, S(3), weaponA, 2);
      g.ray(fhx, fhy, wAngle - 90, S(3), weaponA, 2);
      break;
    }
    case 'greatsword': {
      const [ex, ey] = g.ray(fhx, fhy, wAngle, S(24), weaponC, 3);
      g.px(ex, ey, WHITE);
      g.ray(fhx, fhy, wAngle + 90, S(4), weaponA, 2);
      g.ray(fhx, fhy, wAngle - 90, S(4), weaponA, 2);
      break;
    }
    case 'axe': {
      const [ex, ey] = g.ray(fhx, fhy, wAngle, S(18), WOOD, 2);
      g.ray(ex, ey, wAngle + 90, S(4), weaponC, 3);
      g.ray(ex, ey, wAngle - 90, S(4), weaponC, 3);
      g.px(ex, ey, METAL_DARK);
      break;
    }
    case 'club': {
      const [ex, ey] = g.ray(fhx, fhy, wAngle, S(14), WOOD, 3);
      g.disc(ex, ey, S(3.5), WOOD_DARK);
      g.px(ex + 1, ey - 1, METAL_DARK);
      g.px(ex - 2, ey + 1, METAL_DARK);
      break;
    }
    case 'scythe': {
      const [ex, ey] = g.ray(fhx, fhy, wAngle, S(16), WOOD, 2);
      const [bx, by] = g.ray(ex, ey, wAngle + 100, S(8), weaponC, 2);
      g.px(bx, by, WHITE);
      break;
    }
    case 'daggers': {
      g.ray(fhx, fhy, wAngle, S(8), weaponC, 2);
      g.ray(bhx, bhy, backArm - 20, S(8), weaponC, 2);
      g.ray(fhx, fhy, wAngle + 90, S(2), weaponA, 1);
      break;
    }
    case 'claws': {
      for (let i = -1; i <= 1; i++) g.ray(fhx, fhy, wAngle + i * 18, S(6), weaponC, 1);
      break;
    }
    case 'staff':
    case 'holystaff': {
      // 손이 지팡이 가운데를 쥔다. idle 은 수직
      const sa = p.anim === 'attack' ? wAngle - 10 : p.anim === 'cast' ? -80 : -90 + (p.anim === 'idle' ? [0, 2, 2, 0][p.f % 4] : p.leg * 4);
      const half = S(13);
      g.ray(fhx, fhy, sa + 180, half, WOOD, 2);
      const [tx, ty] = g.ray(fhx, fhy, sa, half, WOOD, 2);
      if (o.weapon === 'staff') {
        g.disc(tx, ty, S(2.5), o.weaponAccent ?? o.glow);
        g.px(tx, ty - 1, WHITE);
      } else {
        g.ring(tx, ty, S(3), o.weaponAccent ?? JOB_PALETTE.healer.main);
        g.px(tx, ty, WHITE);
        g.vline(tx, ty - S(5), ty - S(3), o.weaponAccent ?? JOB_PALETTE.healer.main);
      }
      if (p.anim === 'cast' || (p.anim === 'attack' && stage >= 1 && stage <= 2)) {
        drawGlow(g, tx, ty, p.anim === 'cast' ? castGlowR(p) : 3, o.glow);
      }
      break;
    }
    case 'book': {
      const bx = fhx;
      const by = fhy - 1;
      g.rect(bx - S(4), by - S(3), S(9), S(6), o.weaponAccent ?? LEATHER);
      g.rect(bx - S(3), by - S(2), S(3), S(4), BONE);
      g.rect(bx + S(1), by - S(2), S(3), S(4), BONE);
      g.px(bx - S(2), by - 1, o.bodyDark);
      g.px(bx + S(2), by, o.bodyDark);
      if (p.anim === 'cast' || (p.anim === 'attack' && stage >= 1)) {
        const r = p.anim === 'cast' ? castGlowR(p) : [1, 2, 3, 2][stage];
        drawGlow(g, bx + S(2), by - S(6) - r, r, o.glow);
      }
      break;
    }
    case 'bow': {
      // 뒷손이 활을 들고 앞손이 시위를 당긴다 (공격 중). 평소엔 등에 멘 활을 뒷손에 든다
      const bowX = p.anim === 'attack' || p.anim === 'cast' ? X(shoulder + 9) : bhx;
      const bowY = p.anim === 'attack' || p.anim === 'cast' ? Y(-25) : bhy;
      const bowH = S(9);
      g.line(bowX, bowY - bowH, bowX + S(3), bowY, WOOD, 2);
      g.line(bowX + S(3), bowY, bowX, bowY + bowH, WOOD, 2);
      if (p.anim === 'attack') {
        const pull = [2, 6, 0, 1][stage];
        const px = bowX - S(pull);
        g.line(bowX, bowY - bowH, px, bowY, METAL_LIGHT);
        g.line(px, bowY, bowX, bowY + bowH, METAL_LIGHT);
        if (stage <= 1) {
          g.line(px, bowY, bowX + S(6), bowY, o.weaponAccent ?? WOOD_DARK);
          g.px(bowX + S(6), bowY, METAL_LIGHT);
        } else if (stage === 2) {
          g.line(bowX + S(8), bowY - 1, bowX + S(18), bowY - 1, o.weaponAccent ?? WOOD_DARK);
          g.px(bowX + S(18), bowY - 1, METAL_LIGHT);
        }
        // 당기는 손 위치 재지정
        g.disc(px, bowY, Math.max(1, S(1.5)), skin);
      } else {
        g.line(bowX, bowY - bowH, bowX, bowY + bowH, METAL_LIGHT);
      }
      break;
    }
    case 'rifle': {
      const recoil = p.anim === 'attack' ? [0, -2, -1, 0][stage] : 0;
      const gx = X(2) + S(recoil);
      const gy = Y(-24);
      g.rect(gx - S(4), gy - 1, S(5), 3, WOOD);
      g.line(gx, gy, gx + S(18), gy - 1, weaponC === METAL_LIGHT ? METAL_DARK : weaponC, 2);
      g.px(gx + S(6), gy - 2, METAL);
      if (p.anim === 'attack' && stage === 1) {
        drawGlow(g, gx + S(21), gy - 1, 3, o.weaponAccent ?? '#ffd27a');
      } else if (p.anim === 'attack' && stage === 2) {
        g.px(gx + S(20), gy - 3, CLOTH_GREY, 200);
        g.px(gx + S(22), gy - 4, CLOTH_GREY, 160);
        g.px(gx + S(21), gy - 6, CLOTH_GREY, 120);
      }
      // 손 (총 위)
      g.disc(gx + S(6), gy + 1, Math.max(1, S(1.5)), skin);
      break;
    }
    default:
      break;
  }

  g.outline(OUTLINE);

  // ── 시전 글로우 (외곽선 밖)
  if (p.anim === 'cast' && o.weapon !== 'staff' && o.weapon !== 'holystaff' && o.weapon !== 'book') {
    drawGlow(g, X(2), Y(-46), castGlowR(p), o.glow);
  }
  if (p.anim === 'cast' && o.eyes) {
    g.px(hcx + S(3), hcy - 1, o.eyes);
  }
  // 근접 공격 베기 잔상
  if (p.anim === 'attack' && stage === 2 && isMelee(o.weapon) && o.weapon !== 'none') {
    const cx = fhx;
    const cy = fhy;
    for (let i = 0; i < 5; i++) {
      const ang = (-40 + i * 22) * (Math.PI / 180);
      g.px(cx + Math.cos(ang) * S(18), cy + Math.sin(ang) * S(18), WHITE, 200 - i * 30);
    }
  }
}

// ───────────────────────── 슬라임 (blob) ─────────────────────────

interface BlobOpts {
  color: string;
  dark: string;
  light: string;
  rx: number;
  ry: number;
  eyes: string;
  glow: string;
  spots?: string;
}

function drawBlob(g: G, p: Pose, o: BlobOpts): void {
  let rx = o.rx;
  let ry = o.ry;
  let cx = AX;
  let bob = 0;
  if (p.anim === 'idle') {
    ry += [0, 1, 2, 1][p.f % 4];
    rx -= [0, 1, 2, 1][p.f % 4];
  } else if (p.anim === 'walk') {
    bob = [0, -3, -6, -4, -1, 0][p.f % 6];
    rx += [2, 0, -2, -1, 0, 2][p.f % 6];
    ry += [-2, 0, 2, 1, 0, -2][p.f % 6];
  } else if (p.anim === 'attack') {
    cx += [-2, 0, 4, 2][p.atk];
    rx += [1, 3, 4, 2][p.atk];
    ry += [1, -1, -2, 0][p.atk];
  } else if (p.anim === 'cast') {
    ry += [0, 1, 2, 1][p.cast];
  }
  const cy = AY - 1 - ry + bob;
  g.ellipse(cx, cy, rx, ry, o.color);
  g.ellipse(cx, cy + Math.round(ry * 0.45), rx - 1, Math.round(ry * 0.5), o.dark);
  g.ellipse(cx - Math.round(rx * 0.4), cy - Math.round(ry * 0.4), Math.max(1, Math.round(rx * 0.25)), Math.max(1, Math.round(ry * 0.2)), o.light);
  if (o.spots) {
    g.px(cx + 2, cy + 2, o.spots);
    g.px(cx - 4, cy + 1, o.spots);
    g.px(cx + 5, cy - 3, o.spots);
  }
  // 눈·입
  const ex = cx + Math.round(rx * 0.35);
  const ey = cy - Math.round(ry * 0.2);
  g.px(ex, ey, o.eyes);
  g.px(ex + 3, ey, o.eyes);
  if (p.anim === 'attack' && p.atk >= 1) g.hline(ex, ex + 3, ey + 3, o.dark);
  else g.px(ex + 1, ey + 3, o.dark);
  g.outline(OUTLINE);
  if (p.anim === 'attack' && p.atk === 2) {
    // 튀는 점액 방울
    g.px(cx + rx + 2, cy - 3, o.light);
    g.px(cx + rx + 4, cy - 6, o.color);
    g.px(cx + rx + 3, cy + 2, o.color);
  }
  if (p.anim === 'cast') {
    const r = castGlowR(p);
    drawGlow(g, cx, cy - ry - 4 - r, r, o.glow);
    g.px(cx - 5, cy - ry - 2 - p.cast, o.light);
    g.px(cx + 6, cy - ry - 3 - p.cast, o.light);
  }
}

// ───────────────────────── 4족 ─────────────────────────

interface QuadOpts {
  scale?: number;
  body: string;
  dark: string;
  light?: string;
  eyes: string;
  ears?: boolean;
  mane?: string;
  tailUp?: boolean;
  spikes?: string;
  glow: string;
}

function drawQuadruped(g: G, p: Pose, o: QuadOpts): void {
  const s = o.scale ?? 1;
  const S = (v: number): number => Math.round(v * s);
  const lunge = p.anim === 'attack' ? [-1, 0, 4, 2][p.atk] : 0;
  const baseX = AX + S(lunge);
  const baseY = AY + p.bob;
  const X = (dx: number): number => baseX + S(dx);
  const Y = (dy: number): number => baseY + S(dy);
  const legW = Math.max(2, S(3));
  // 꼬리
  const sw = p.anim === 'idle' ? [0, 1, 2, 1][p.f % 4] : p.leg * 2;
  if (o.tailUp) g.line(X(-13), Y(-13), X(-19), Y(-19) - S(sw), o.body, 2);
  else g.line(X(-13), Y(-12), X(-19), Y(-7) + S(sw), o.body, 2);
  // 뒷다리 (몸 뒤)
  const leg = p.leg;
  const raise = p.anim === 'attack' && p.atk === 2 ? -S(3) : 0;
  g.line(X(-9), Y(-9), X(-9) - S(leg * 3), Y(-2), o.dark, legW);
  g.line(X(6), Y(-9), X(6) + S(leg * 3), Y(-2) + raise, o.dark, legW);
  // 몸
  g.ellipse(X(-2), Y(-12), S(12), S(6), o.body);
  g.ellipse(X(-2), Y(-9), S(10), S(3), o.dark);
  if (o.light) g.ellipse(X(-2), Y(-15), S(6), S(2), o.light);
  if (o.mane) g.ellipse(X(6), Y(-15), S(5), S(4), o.mane);
  if (o.spikes) {
    for (let i = 0; i < 4; i++) g.line(X(-9 + i * 4), Y(-17), X(-8 + i * 4), Y(-21) - (i % 2), o.spikes, 1);
  }
  // 앞다리 (몸 앞)
  g.line(X(-6), Y(-9), X(-6) + S(leg * 3), Y(-2), o.body, legW);
  g.line(X(9), Y(-9), X(9) - S(leg * 3), Y(-2) + raise, o.body, legW);
  // 머리
  const headDrop = p.anim === 'attack' ? [0, -1, 3, 1][p.atk] : 0;
  const hx = X(12);
  const hy = Y(-16 + headDrop);
  g.disc(hx, hy, S(5), o.body);
  g.rect(hx + S(3), hy - 1, S(5), S(3), o.body); // 주둥이
  g.px(hx + S(7), hy - 1, EYE); // 코
  if (p.anim === 'attack' && p.atk >= 1) {
    g.rect(hx + S(3), hy + S(2), S(5), 2, o.dark); // 벌린 입
    g.px(hx + S(4), hy + S(2), WHITE);
    g.px(hx + S(6), hy + S(2), WHITE);
  }
  if (o.ears) {
    g.line(hx - S(2), hy - S(4), hx - S(3), hy - S(8), o.body, 2);
    g.line(hx + S(1), hy - S(4), hx + S(2), hy - S(8), o.dark, 2);
  }
  g.px(hx + S(2), hy - S(2), o.eyes);
  g.outline(OUTLINE);
  if (p.anim === 'cast') {
    const r = castGlowR(p);
    drawGlow(g, X(0), Y(-24) - r, r, o.glow);
    g.px(hx + S(2), hy - S(2), o.glow);
  }
  if (p.anim === 'attack' && p.atk === 2) {
    g.px(hx + S(10), hy, WHITE);
    g.px(hx + S(12), hy - 2, WHITE, 180);
    g.px(hx + S(11), hy + 3, WHITE, 180);
  }
}

// ───────────────────────── 박쥐 ─────────────────────────

interface BatOpts {
  body: string;
  wing: string;
  eyes: string;
  glow: string;
}

function drawBat(g: G, p: Pose, o: BatOpts): void {
  const flap = p.anim === 'walk' ? [0, 3, 6, 3, 0, -2][p.f % 6] : p.anim === 'idle' ? [0, 2, 4, 2][p.f % 4] : [4, 6, -3, 0][Math.max(p.atk, p.cast, 0)];
  const dive = p.anim === 'attack' ? [0, -2, 6, 3][p.atk] : 0;
  const cx = AX + (p.anim === 'attack' ? [0, 0, 4, 2][p.atk] : 0);
  const cy = AY - 28 + p.bob + dive;
  // 날개: 위로 올라간 정도 = flap (클수록 위)
  const tipY = cy - 2 - flap * 2;
  g.tri(cx - 3, cy - 3, cx - 17, tipY, cx - 6, cy + 4, o.wing);
  g.tri(cx + 3, cy - 3, cx + 17, tipY, cx + 6, cy + 4, o.wing);
  g.tri(cx - 3, cy - 3, cx - 17, tipY, cx - 12, cy - 6 - flap, o.body);
  g.tri(cx + 3, cy - 3, cx + 17, tipY, cx + 12, cy - 6 - flap, o.body);
  // 몸
  g.ellipse(cx, cy, 4, 6, o.body);
  g.disc(cx, cy - 6, 3, o.body);
  g.line(cx - 2, cy - 8, cx - 3, cy - 12, o.body, 1);
  g.line(cx + 2, cy - 8, cx + 3, cy - 12, o.body, 1);
  g.px(cx - 1, cy - 6, o.eyes);
  g.px(cx + 1, cy - 6, o.eyes);
  if (p.anim === 'attack' && p.atk >= 1) {
    g.px(cx - 1, cy - 3, WHITE);
    g.px(cx + 1, cy - 3, WHITE);
  }
  g.outline(OUTLINE);
  if (p.anim === 'cast') {
    const r = castGlowR(p);
    drawGlow(g, cx, cy - 16 - r, r, o.glow);
  }
  if (p.anim === 'attack' && p.atk === 2) {
    // 초음파
    g.ring(cx + 10, cy, 3, WHITE, 200);
    g.ring(cx + 12, cy, 6, WHITE, 120);
  }
}

// ───────────────────────── 버섯 ─────────────────────────

interface MushroomOpts {
  cap: string;
  capDark: string;
  spots: string;
  stem: string;
  eyes: string;
  glow: string;
}

function drawMushroom(g: G, p: Pose, o: MushroomOpts): void {
  const hop = p.anim === 'walk' ? [0, -2, -4, -2, 0, -1][p.f % 6] : 0;
  const tilt = p.anim === 'idle' ? [0, 1, 0, -1][p.f % 4] : p.anim === 'attack' ? [-1, 1, 3, 2][p.atk] : 0;
  const squash = p.anim === 'walk' && (p.f % 6 === 0 || p.f % 6 === 4) ? 1 : 0;
  const cx = AX;
  const base = AY - 1 + hop;
  // 줄기
  g.rect(cx - 4, base - 12 + squash, 9, 12 - squash, o.stem);
  g.rect(cx - 4, base - 12 + squash, 2, 12 - squash, BONE_DARK);
  g.px(cx + 1, base - 7, o.eyes);
  g.px(cx + 3, base - 7, o.eyes);
  if (p.anim === 'attack' && p.atk >= 1) g.hline(cx + 1, cx + 3, base - 4, o.capDark);
  // 갓
  const capY = base - 14 + squash;
  g.halfDisc(cx + tilt, capY, 12, o.cap, true);
  g.rect(cx - 12 + tilt, capY, 25, 2, o.capDark);
  g.disc(cx - 5 + tilt, capY - 6, 2, o.spots);
  g.disc(cx + 4 + tilt, capY - 8, 1.5, o.spots);
  g.px(cx + 8 + tilt, capY - 3, o.spots);
  g.outline(OUTLINE);
  // 포자
  if (p.anim === 'attack' && p.atk >= 1) {
    drawSparks(g, cx + 10, capY - 4, -20, p.atk, o.spots, WHITE);
  }
  if (p.anim === 'cast') {
    const r = castGlowR(p);
    drawGlow(g, cx + tilt, capY - 16 - r, r, o.glow);
    g.px(cx - 8, capY - 16 - p.cast, o.spots);
    g.px(cx + 9, capY - 18 - p.cast, o.spots);
  }
}

// ───────────────────────── 유령 ─────────────────────────

interface GhostOpts {
  body: string;
  dark: string;
  eyes: string;
  glow: string;
  alpha?: number;
}

function drawGhost(g: G, p: Pose, o: GhostOpts): void {
  const a = o.alpha ?? 215;
  const bob = p.anim === 'walk' ? [0, -1, -2, -3, -2, -1][p.f % 6] : p.anim === 'idle' ? [0, -1, -2, -1][p.f % 4] : p.bob;
  const lunge = p.anim === 'attack' ? [-1, 0, 4, 2][p.atk] : 0;
  const cx = AX + lunge;
  const top = AY - 38 + bob;
  const bottom = AY - 8 + bob;
  const wave = [0, 1, 2, 1, 0, -1][p.f % 6];
  // 몸통 (위 둥글고 아래로 갈수록 좁아지다 너덜너덜)
  g.disc(cx, top + 7, 7, o.body, a);
  g.tri(cx - 7, top + 8, cx + 7, top + 8, cx - 8 + wave, bottom, o.body, a);
  g.tri(cx + 7, top + 8, cx + 8 + wave, bottom, cx - 8 + wave, bottom, o.body, a);
  // 밑단 조각
  for (let i = 0; i < 4; i++) {
    const tx = cx - 7 + i * 5 + wave;
    const len = 3 + ((i + p.f) % 3);
    g.tri(tx - 2, bottom, tx + 2, bottom, tx, bottom + len, o.body, a);
  }
  g.rect(cx - 3, top + 12, 3, 12, o.dark, 140);
  // 팔
  const armAng = p.anim === 'attack' ? [-40, -20, 0, 10][p.atk] : p.anim === 'cast' ? [-60, -80, -100, -90][p.cast] : 30 + wave * 5;
  g.ray(cx + 4, top + 14, armAng, 9, o.body, 2, a);
  g.ray(cx - 5, top + 15, armAng + 20, 7, o.dark, 2, a);
  // 눈·입
  g.px(cx + 2, top + 6, o.eyes);
  g.px(cx + 3, top + 6, o.eyes);
  g.px(cx - 2, top + 6, o.eyes);
  g.rect(cx + 1, top + 9, 2, p.anim === 'attack' ? 4 : 2, o.dark);
  g.outline(OUTLINE);
  if (p.anim === 'cast') {
    const r = castGlowR(p);
    drawGlow(g, cx, top - 4 - r, r, o.glow);
  }
  if (p.anim === 'attack' && p.atk === 2) {
    g.ring(cx + 14, top + 12, 3, o.glow, 200);
    g.ring(cx + 16, top + 12, 6, o.glow, 110);
  }
}

// ───────────────────────── 드래곤 ─────────────────────────

interface DragonOpts {
  body: string;
  dark: string;
  belly: string;
  wing: string;
  eyes: string;
  glow: string;
  breath: string;
}

function drawDragon(g: G, p: Pose, o: DragonOpts): void {
  const lunge = p.anim === 'attack' ? [-1, 0, 3, 2][p.atk] : 0;
  const cx = AX + 3 + lunge;
  const by = AY - 1 + p.bob;
  const flap = p.flap;
  const leg = p.leg;
  // 꼬리
  const sw = p.anim === 'idle' ? [0, 1, 2, 1][p.f % 4] : leg * 2;
  g.line(cx - 16, by - 16, cx - 25, by - 10 + sw, o.body, 3);
  g.line(cx - 25, by - 10 + sw, cx - 29, by - 14 + sw, o.body, 2);
  g.px(cx - 29, by - 15 + sw, o.dark);
  // 뒷날개 (몸 뒤)
  g.tri(cx - 6, by - 24, cx - 22, by - 44 + flap * 2, cx - 14, by - 20, o.dark);
  // 다리 (뒤)
  g.line(cx - 10, by - 12, cx - 12 - leg * 3, by, o.dark, 3);
  g.line(cx + 6, by - 12, cx + 6 + leg * 3, by, o.dark, 3);
  // 몸
  g.ellipse(cx - 4, by - 17, 16, 9, o.body);
  g.ellipse(cx - 4, by - 13, 13, 4, o.belly);
  // 등 가시
  for (let i = 0; i < 5; i++) g.line(cx - 14 + i * 5, by - 25, cx - 13 + i * 5, by - 29, o.dark, 1);
  // 다리 (앞)
  g.line(cx - 6, by - 12, cx - 6 - leg * 3, by, o.body, 3);
  g.line(cx + 10, by - 12, cx + 10 + leg * 3, by, o.body, 3);
  // 앞날개
  g.tri(cx - 2, by - 24, cx - 16, by - 50 + flap * 2, cx - 10, by - 22, o.wing);
  g.line(cx - 2, by - 24, cx - 16, by - 50 + flap * 2, o.dark, 1);
  // 목·머리
  const headDrop = p.anim === 'attack' ? [-2, -1, 4, 2][p.atk] : 0;
  const hx = cx + 17 + (p.anim === 'attack' ? [0, 0, 3, 1][p.atk] : 0);
  const hy = by - 40 + headDrop;
  g.line(cx + 8, by - 22, hx - 4, hy + 3, o.body, 5);
  g.ellipse(hx, hy, 6, 4, o.body);
  g.rect(hx + 4, hy - 1, 6, 3, o.body); // 주둥이
  g.line(hx - 3, hy - 3, hx - 7, hy - 9, o.dark, 2); // 뿔
  g.line(hx, hy - 4, hx - 2, hy - 10, o.dark, 2);
  g.px(hx + 2, hy - 2, o.eyes);
  if (p.anim === 'attack' && p.atk >= 1) {
    g.rect(hx + 4, hy + 2, 6, 2, o.dark);
    g.px(hx + 5, hy + 2, WHITE);
    g.px(hx + 8, hy + 2, WHITE);
  }
  g.outline(OUTLINE);
  if (p.anim === 'attack' && p.atk >= 1) {
    drawSparks(g, hx + 11, hy + 1, 10, p.atk, o.breath, WHITE);
    if (p.atk === 2) {
      g.line(hx + 11, hy + 1, hx + 22, hy + 6, o.breath, 2, 180);
      g.line(hx + 11, hy + 1, hx + 22, hy - 3, o.breath, 1, 140);
    }
  }
  if (p.anim === 'cast') {
    const r = castGlowR(p);
    drawGlow(g, hx + 8, hy, r, o.glow);
  }
}

// ───────────────────────── 골렘 ─────────────────────────

interface GolemOpts {
  stone: string;
  dark: string;
  light: string;
  rune: string;
  eyes: string;
  glow: string;
}

function drawGolem(g: G, p: Pose, o: GolemOpts): void {
  const cx = AX + p.lean;
  const by = AY + p.bob;
  const leg = p.leg;
  const armShift = p.anim === 'idle' ? [0, 1, 2, 1][p.f % 4] : 0;
  // 다리
  g.rect(cx - 10 - leg * 2, by - 16, 7, 16, o.dark);
  g.rect(cx + 3 + leg * 2, by - 16, 7, 16, o.stone);
  // 뒷팔 (몸 뒤, 왼쪽)
  g.rect(cx - 20, by - 38 + armShift - leg * 2, 8, 26, o.dark);
  g.disc(cx - 16, by - 10 + armShift - leg * 2, 5, o.dark);
  // 몸통
  g.rect(cx - 13, by - 42, 26, 26, o.stone);
  g.rect(cx - 13, by - 42, 26, 3, o.light);
  g.rect(cx - 13, by - 42, 3, 26, o.light);
  g.line(cx - 8, by - 30, cx - 3, by - 24, o.dark); // 균열
  g.line(cx + 4, by - 38, cx + 7, by - 33, o.dark);
  // 룬
  const runeA = p.anim === 'cast' ? 255 : 170;
  g.rect(cx - 2, by - 33, 4, 6, o.rune, runeA);
  g.px(cx, by - 35, o.rune, runeA);
  g.px(cx, by - 26, o.rune, runeA);
  // 머리
  g.rect(cx - 6, by - 52, 12, 10, o.stone);
  g.rect(cx - 6, by - 52, 12, 2, o.light);
  g.rect(cx + 2, by - 48, 3, 2, o.eyes);
  g.rect(cx - 4, by - 48, 3, 2, o.eyes);
  // 앞팔 (오른쪽): 공격 시 위로 들었다가 내려찍는다
  if (p.anim === 'attack') {
    const ang = [-130, -100, 20, 45][p.atk];
    const [ex, ey] = g.ray(cx + 14, by - 38, ang, 24, o.stone, 7);
    g.disc(ex, ey, 6, o.light);
  } else if (p.anim === 'cast') {
    const ang = [-40, -60, -80, -70][p.cast];
    const [ex, ey] = g.ray(cx + 14, by - 38, ang, 22, o.stone, 7);
    g.disc(ex, ey, 6, o.light);
  } else {
    g.rect(cx + 12, by - 38 - armShift + leg * 2, 8, 26, o.stone);
    g.disc(cx + 16, by - 10 - armShift + leg * 2, 5, o.light);
  }
  g.outline(OUTLINE);
  if (p.anim === 'attack' && p.atk === 2) {
    // 지면 먼지
    g.px(cx + 30, by - 2, STONE_LIGHT);
    g.px(cx + 33, by - 5, STONE_LIGHT, 200);
    g.px(cx + 27, by - 6, STONE_LIGHT, 200);
    g.px(cx + 35, by - 1, STONE_LIGHT, 160);
  }
  if (p.anim === 'cast') {
    const r = castGlowR(p);
    drawGlow(g, cx, by - 30, r, o.glow);
  }
}

// ───────────────────────── 정령 ─────────────────────────

interface SpiritOpts {
  core: string;
  main: string;
  dark: string;
  glow: string;
}

function drawSpirit(g: G, p: Pose, o: SpiritOpts): void {
  const bob = p.anim === 'walk' ? [0, -1, -2, -3, -2, -1][p.f % 6] : p.anim === 'idle' ? [0, -1, -2, -1][p.f % 4] : p.bob;
  const pulse = p.anim === 'idle' ? [0, 0, 1, 1][p.f % 4] : p.anim === 'cast' ? [1, 2, 3, 2][p.cast] : 0;
  const lunge = p.anim === 'attack' ? [-1, 0, 3, 1][p.atk] : 0;
  const cx = AX + lunge;
  const cy = AY - 22 + bob;
  const r = 6 + pulse;
  // 꼬리 (아래로 늘어지는 빛)
  g.tri(cx - 3, cy + 2, cx + 3, cy + 2, cx + [0, 1, 2, 1, 0, -1][p.f % 6], cy + 14, o.dark, 200);
  g.disc(cx, cy, r, o.main, 230);
  g.disc(cx, cy, r - 3, o.core);
  g.ring(cx, cy, r + 2, o.dark, 120);
  // 궤도 불꽃
  for (let i = 0; i < 3; i++) {
    const ang = ((p.f * 40 + i * 120) * Math.PI) / 180;
    g.px(cx + Math.cos(ang) * (r + 4), cy + Math.sin(ang) * (r + 4) * 0.6, o.core);
  }
  g.outline(OUTLINE);
  if (p.anim === 'walk') {
    g.px(cx - r - 3, cy + 1, o.main, 180);
    g.px(cx - r - 6, cy + 2, o.main, 120);
  }
  if (p.anim === 'attack' && p.atk >= 1) {
    const d = [0, 4, 12, 18][p.atk];
    g.disc(cx + r + 2 + d, cy, 2, o.core);
    g.ring(cx + r + 2 + d, cy, 3, o.main, 200);
  }
  if (p.anim === 'cast') {
    drawGlow(g, cx, cy - r - 5, castGlowR(p), o.glow);
  }
}

// ───────────────────────── 화살탑 ─────────────────────────

interface TurretOpts {
  wood: string;
  dark: string;
  roof: string;
  flag: string;
  glow: string;
}

function drawTurret(g: G, p: Pose, o: TurretOpts): void {
  const cx = AX;
  const by = AY - 1;
  // 기둥
  g.rect(cx - 7, by - 14, 15, 14, o.wood);
  for (let i = 0; i < 3; i++) g.vline(cx - 4 + i * 5, by - 14, by - 1, o.dark);
  // 상단
  g.rect(cx - 9, by - 24, 19, 10, o.wood);
  g.hline(cx - 9, cx + 9, by - 24, o.dark);
  g.rect(cx - 8, by - 21, 3, 3, o.dark);
  // 지붕
  g.tri(cx - 11, by - 24, cx + 11, by - 24, cx, by - 33, o.roof);
  // 깃발
  const wave = p.anim === 'walk' || p.anim === 'idle' ? [0, 1, 2, 1, 0, -1][p.f % 6] : 0;
  g.vline(cx, by - 42, by - 33, o.dark);
  g.tri(cx + 1, by - 42, cx + 8 + wave, by - 40 + wave, cx + 1, by - 37, o.flag);
  // 발사구·활
  const bx = cx + 10;
  const byy = by - 19;
  g.line(bx, byy - 4, bx + 2, byy, WOOD_DARK, 1);
  g.line(bx + 2, byy, bx, byy + 4, WOOD_DARK, 1);
  if (p.anim === 'attack') {
    const pull = [1, 3, 0, 0][p.atk];
    g.line(bx, byy - 4, bx - pull, byy, METAL_LIGHT);
    g.line(bx - pull, byy, bx, byy + 4, METAL_LIGHT);
    if (p.atk <= 1) g.line(bx - pull, byy, bx + 5, byy, o.dark);
    else if (p.atk === 2) {
      g.line(bx + 6, byy - 1, bx + 16, byy - 1, o.dark);
      g.px(bx + 16, byy - 1, METAL_LIGHT);
    }
  } else {
    g.line(bx, byy - 4, bx, byy + 4, METAL_LIGHT);
  }
  g.outline(OUTLINE);
  if (p.anim === 'cast') {
    drawGlow(g, cx, by - 46, castGlowR(p), o.glow);
  }
}

// ───────────────────────── 디자인 표 ─────────────────────────

function human(o: HumanoidOpts, tintable: boolean): Design {
  return { draw: (g, p) => drawHumanoid(g, p, o), tintable };
}

const JP = JOB_PALETTE;

const DESIGNS: Record<SpriteKey, Design> = {
  // ── 직업 9종 (틴트 가능)
  swordsman: human({
    skin: SKIN, body: JP.swordsman.main, bodyDark: JP.swordsman.dark, legs: CLOTH_GREY_DARK,
    head: 'hair', hair: '#5a3a22', weapon: 'sword', weaponAccent: JP.swordsman.accent, glow: JP.swordsman.glow,
  }, true),
  tank: human({
    scale: 1.05, skin: SKIN, body: JP.tank.main, bodyDark: JP.tank.dark, legs: METAL_DARK,
    head: 'helmet', weapon: 'sword', shield: METAL, weaponAccent: JP.tank.accent, glow: JP.tank.glow,
  }, true),
  berserker: human({
    scale: 1.05, skin: SKIN, body: JP.berserker.main, bodyDark: JP.berserker.dark, legs: JP.berserker.main,
    bareChest: true, head: 'hair', hair: '#c2472a', weapon: 'axe', glow: JP.berserker.glow,
  }, true),
  assassin: human({
    scale: 0.95, skin: SKIN, body: JP.assassin.main, bodyDark: JP.assassin.dark, legs: JP.assassin.dark,
    head: 'hood', headColor: JP.assassin.dark, weapon: 'daggers', weaponAccent: JP.assassin.accent, glow: JP.assassin.glow,
  }, true),
  archer: human({
    skin: SKIN, body: JP.archer.main, bodyDark: JP.archer.dark, legs: LEATHER,
    head: 'cap', headColor: JP.archer.dark, weapon: 'bow', quiver: true, weaponAccent: WOOD_DARK, glow: JP.archer.glow,
  }, true),
  sniper: human({
    skin: SKIN, body: JP.sniper.main, bodyDark: JP.sniper.dark, legs: JP.sniper.dark, robe: true, robeColor: JP.sniper.main,
    head: 'brim', headColor: JP.sniper.dark, weapon: 'rifle', weaponColor: METAL_DARK, weaponAccent: '#ffd27a', glow: JP.sniper.glow,
  }, true),
  mage: human({
    skin: SKIN, body: JP.mage.main, bodyDark: JP.mage.dark, robe: true,
    head: 'hat', headColor: JP.mage.main, weapon: 'staff', weaponAccent: JP.mage.accent, glow: JP.mage.glow,
  }, true),
  summoner: human({
    skin: SKIN, body: JP.summoner.main, bodyDark: JP.summoner.dark, robe: true, cape: JP.summoner.dark,
    head: 'hair', hair: '#2a1a3a', weapon: 'book', weaponAccent: LEATHER_DARK, glow: JP.summoner.glow,
  }, true),
  healer: human({
    skin: SKIN, body: '#f2efe6', bodyDark: '#cfc9bb', robe: true, robeColor: '#f2efe6', sash: JP.healer.main,
    head: 'hood', headColor: JP.healer.main, weapon: 'holystaff', weaponAccent: JP.healer.main, glow: JP.healer.glow,
  }, true),

  // ── 소환물 4종
  summon_beast: {
    draw: (g, p) => drawQuadruped(g, p, { scale: 0.9, body: '#6f7f9a', dark: '#46526a', light: '#98a6bd', eyes: '#9ef0ff', ears: true, mane: '#46526a', tailUp: true, glow: '#9ef0ff' }),
    tintable: false,
  },
  summon_spirit: {
    draw: (g, p) => drawSpirit(g, p, { core: '#ffffff', main: '#7fe0e8', dark: '#2a9d8f', glow: '#bff7ff' }),
    tintable: false,
  },
  summon_skeleton: human({
    scale: 0.95, skin: BONE, skinDark: BONE_DARK, body: BONE, bodyDark: BONE_DARK, legs: BONE, skeleton: true,
    head: 'skull', weapon: 'sword', weaponColor: RUST, weaponAccent: WOOD_DARK, glow: '#b3ffb3',
  }, false),
  summon_turret: {
    draw: (g, p) => drawTurret(g, p, { wood: WOOD, dark: WOOD_DARK, roof: '#7a3b2a', flag: '#e0b040', glow: '#ffe9a0' }),
    tintable: false,
  },

  // ── 몬스터: 하급
  monster_slime_swarm: {
    draw: (g, p) => drawBlob(g, p, { color: '#5fcf5a', dark: '#2f8a3a', light: '#c9ffb8', rx: 11, ry: 8, eyes: EYE, glow: '#c9ffb8' }),
    tintable: false,
  },
  monster_wild_dogs: {
    draw: (g, p) => drawQuadruped(g, p, { scale: 0.9, body: '#a0703c', dark: '#6a4622', light: '#c9a070', eyes: '#ffd54a', ears: true, glow: '#ffd54a' }),
    tintable: false,
  },
  monster_goblin_scouts: human({
    scale: 0.75, skin: SKIN_GREEN, skinDark: SKIN_GREEN_DARK, body: LEATHER, bodyDark: LEATHER_DARK, legs: LEATHER_DARK,
    head: 'cap', headColor: '#b03030', weapon: 'scythe', eyes: '#ffe94a', glow: '#c6f59a',
  }, false),
  monster_cave_bats: {
    draw: (g, p) => drawBat(g, p, { body: '#4a3a5a', wing: '#2e2340', eyes: '#ff5a5a', glow: '#c9a6ff' }),
    tintable: false,
  },
  monster_mushroom_grove: {
    draw: (g, p) => drawMushroom(g, p, { cap: '#8a4ab0', capDark: '#5a2a80', spots: '#e8d0ff', stem: BONE, eyes: EYE, glow: '#c9a6ff' }),
    tintable: false,
  },
  monster_giant_slime: {
    draw: (g, p) => drawBlob(g, p, { color: '#3f8fd6', dark: '#24558f', light: '#bfe4ff', rx: 24, ry: 20, eyes: WHITE, glow: '#bfe4ff', spots: '#2a6fb0' }),
    tintable: false,
  },

  // ── 몬스터: 중급
  monster_orc_warband: human({
    scale: 1.15, brute: true, skin: SKIN_GREEN, skinDark: SKIN_GREEN_DARK, body: CLOTH_GREY, bodyDark: CLOTH_GREY_DARK, legs: LEATHER_DARK,
    bareChest: true, head: 'hair', hair: '#2a1a12', weapon: 'club', tusks: true, glow: '#ff9c7a',
  }, false),
  monster_harpy_flock: human({
    scale: 0.95, skin: SKIN, body: '#b07a3a', bodyDark: '#7a5020', legs: '#d9c27a', hover: 6,
    head: 'hair', hair: '#e0c060', weapon: 'claws', weaponColor: METAL_LIGHT, wings: '#d9b06a', wingsDark: '#9a7a3a', glow: '#ffe9a0',
  }, false),
  monster_living_armor: human({
    scale: 1.05, skin: CLOTH_GREY_DARK, body: METAL, bodyDark: METAL_DARK, legs: METAL_DARK, hollow: true,
    head: 'helmet', weapon: 'greatsword', weaponAccent: METAL_DARK, eyes: '#5ee7ff', glow: '#8fe3ff',
  }, false),
  monster_bandit_crew: human({
    skin: SKIN, body: CLOTH_GREY, bodyDark: CLOTH_GREY_DARK, legs: LEATHER_DARK,
    head: 'bandana', headColor: '#b03030', weapon: 'daggers', weaponAccent: LEATHER, glow: '#e0e0e0',
  }, false),
  monster_wraith_choir: {
    draw: (g, p) => drawGhost(g, p, { body: '#b8c8e8', dark: '#5a6a9a', eyes: '#3a1a5a', glow: '#c9a6ff' }),
    tintable: false,
  },
  monster_orc_chieftain: human({
    scale: 1.2, brute: true, skin: SKIN_GREEN, skinDark: SKIN_GREEN_DARK, body: LEATHER, bodyDark: LEATHER_DARK, legs: LEATHER_DARK,
    head: 'horned', weapon: 'axe', cape: '#8a2a1e', tusks: true, glow: '#ff9c7a',
  }, false),

  // ── 몬스터: 고급
  monster_ancient_golem: {
    draw: (g, p) => drawGolem(g, p, { stone: STONE, dark: STONE_DARK, light: STONE_LIGHT, rune: '#6fd648', eyes: '#6fd648', glow: '#c6f59a' }),
    tintable: false,
  },
  monster_frost_dragon: {
    draw: (g, p) => drawDragon(g, p, { body: '#4f8fd6', dark: '#2a5a9a', belly: '#bfe4ff', wing: '#7fb8e8', eyes: '#ffffff', glow: '#8fe3ff', breath: '#8fe3ff' }),
    tintable: false,
  },
  monster_inferno_lord: human({
    scale: 1.2, brute: true, skin: '#d9481c', skinDark: '#8a2a10', body: '#3a2a26', bodyDark: '#221816', legs: '#3a2a26',
    bareChest: true, head: 'flame', weapon: 'club', weaponColor: '#ff7a1f', eyes: '#fff1a8', glow: '#ff7a1f', glowCore: '#fff1a8',
  }, false),
  monster_lich_host: human({
    skin: BONE, skinDark: BONE_DARK, body: '#3a2a5a', bodyDark: '#22183a', float: true,
    head: 'skull', weapon: 'staff', weaponAccent: '#6fd648', eyes: '#6fd648', glow: '#9dff8a',
  }, false),
  monster_abyss_pack: {
    draw: (g, p) => drawQuadruped(g, p, { scale: 1.15, body: '#2a2030', dark: '#15101c', light: '#4a3a5a', eyes: '#ff3030', ears: true, spikes: '#5a3a7a', tailUp: true, glow: '#ff3030' }),
    tintable: false,
  },
  monster_demon_legion: human({
    scale: 1.1, skin: SKIN_RED, skinDark: '#7a1a14', body: '#2a1a30', bodyDark: '#15101c', legs: '#2a1a30',
    head: 'bare', horns: BONE, wings: '#4a2a5a', wingsDark: SHADOW_PURPLE, tail: SKIN_RED,
    weapon: 'sword', weaponColor: '#7a3fbf', weaponAccent: '#15101c', eyes: '#ffe94a', glow: '#d9b3ff',
  }, false),
};

/** 코드 생성 스프라이트가 있는 키 목록 (ALL_SPRITE_KEYS 와 같아야 한다) */
export const DESIGN_KEYS: readonly SpriteKey[] = Object.keys(DESIGNS);

export function hasDesign(key: SpriteKey): boolean {
  return Object.prototype.hasOwnProperty.call(DESIGNS, key);
}

// ───────────────────────── 시트 조립 ─────────────────────────

/** 시트 크기: 가장 긴 애니메이션 열 수 × 64, 6행 × 64 */
export function sheetSize(): { w: number; h: number; cols: number; rows: number } {
  let cols = 1;
  let rows = 1;
  for (let i = 0; i < ANIM_NAMES.length; i++) {
    const d = DEFAULT_META.anims[ANIM_NAMES[i]];
    cols = Math.max(cols, d.frames);
    rows = Math.max(rows, d.row + 1);
  }
  return { w: cols * FW, h: rows * FH, cols, rows };
}

/** 원본 프레임(64×64)을 pivot 기준으로 angleDeg 회전·alpha 곱 후 dst 프레임에 얹는다. 프레임 밖으로 나가면 안으로 밀어 넣는다 */
function transformFrame(src: PixelBuffer, dst: G, angleDeg: number, alphaMul: number, dx: number, dy: number, landOnGround: boolean): void {
  const SZ = 192;
  const OFF = 64;
  const tmp = new PixelBuffer(SZ, SZ);
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const px = AX;
  const py = AY - 2;
  let minX = SZ;
  let maxX = -1;
  let minY = SZ;
  let maxY = -1;
  for (let ty = 0; ty < SZ; ty++) {
    for (let tx = 0; tx < SZ; tx++) {
      const rx = tx - OFF - px;
      const ry = ty - OFF - py;
      const sx = Math.round(px + rx * cos + ry * sin);
      const sy = Math.round(py - rx * sin + ry * cos);
      if (sx < 0 || sy < 0 || sx >= FW || sy >= FH) continue;
      const si = (sy * FW + sx) * 4;
      const a = src.data[si + 3];
      if (a === 0) continue;
      tmp.set(tx, ty, src.data[si], src.data[si + 1], src.data[si + 2], Math.round(a * alphaMul));
      if (tx < minX) minX = tx;
      if (tx > maxX) maxX = tx;
      if (ty < minY) minY = ty;
      if (ty > maxY) maxY = ty;
    }
  }
  if (maxX < 0) return;
  // 프레임 좌표로 환산한 경계
  const fMinX = minX - OFF + dx;
  const fMaxX = maxX - OFF + dx;
  const fMinY = minY - OFF + dy;
  const fMaxY = maxY - OFF + dy;
  let sx = 0;
  let sy = 0;
  if (fMaxX > FW - 1) sx = FW - 1 - fMaxX;
  if (fMinX + sx < 0) sx = -fMinX;
  if (landOnGround) sy = AY + 4 - fMaxY;
  if (fMaxY + sy > FH - 1) sy = FH - 1 - fMaxY;
  if (fMinY + sy < 0) sy = -fMinY;
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      const i = (ty * SZ + tx) * 4;
      const a = tmp.data[i + 3];
      if (a === 0) continue;
      const fx = tx - OFF + dx + sx;
      const fy = ty - OFF + dy + sy;
      if (fx < 0 || fy < 0 || fx >= FW || fy >= FH) continue;
      dst.buf.set(dst.ox + fx, dst.oy + fy, tmp.data[i], tmp.data[i + 1], tmp.data[i + 2], a);
    }
  }
}

const HIT_ANGLE = [-14, -6];
const HIT_DX = [-2, -1];
const DEATH_ANGLE = [-10, -38, -66, -90];
const DEATH_ALPHA = [1, 1, 0.95, 0.85];

/** 한 프레임을 그린다 (hit / death 포함). 프레임 크기 64×64 의 버퍼를 새로 만들어 돌려준다 */
export function renderFrame(key: SpriteKey, anim: AnimName, frame: number): PixelBuffer {
  const design = DESIGNS[key] ?? DESIGNS[FALLBACK_SPRITE_KEY];
  const def = DEFAULT_META.anims[anim];
  const n = def.frames;
  const f = Math.max(0, Math.min(n - 1, frame));
  const out = new PixelBuffer(FW, FH);
  const g = new G(out, 0, 0);
  if (anim === 'hit' || anim === 'death') {
    const base = new PixelBuffer(FW, FH);
    design.draw(new G(base, 0, 0), makePose('idle', 0, DEFAULT_META.anims.idle.frames));
    if (anim === 'hit') {
      transformFrame(base, g, HIT_ANGLE[f % 2], 1, HIT_DX[f % 2], 0, false);
    } else {
      const i = f % 4;
      transformFrame(base, g, DEATH_ANGLE[i], DEATH_ALPHA[i], -i, i >= 2 ? 0 : i, i >= 2);
    }
    return out;
  }
  design.draw(g, makePose(anim, f, n));
  return out;
}

const SHEET_CACHE = new Map<SpriteKey, PixelBuffer>();

/**
 * 키의 전체 시트를 픽셀 버퍼로 만든다 (캐시). 알 수 없는 키는 FALLBACK_SPRITE_KEY 디자인.
 * DOM 을 쓰지 않으므로 node 에서도 호출할 수 있다.
 */
export function buildSheetBuffer(key: SpriteKey): PixelBuffer {
  const k = hasDesign(key) ? key : FALLBACK_SPRITE_KEY;
  const cached = SHEET_CACHE.get(k);
  if (cached) return cached;
  const { w, h } = sheetSize();
  const sheet = new PixelBuffer(w, h);
  for (let i = 0; i < ANIM_NAMES.length; i++) {
    const anim = ANIM_NAMES[i];
    const def = DEFAULT_META.anims[anim];
    for (let f = 0; f < def.frames; f++) {
      const frame = renderFrame(k, anim, f);
      const ox = f * FW;
      const oy = def.row * FH;
      for (let y = 0; y < FH; y++) {
        const src = (y * FW) * 4;
        const dst = ((oy + y) * w + ox) * 4;
        sheet.data.set(frame.data.subarray(src, src + FW * 4), dst);
      }
    }
  }
  SHEET_CACHE.set(k, sheet);
  return sheet;
}

// ───────────────────────── 캔버스 시트 ─────────────────────────

/** 픽셀 버퍼 → 캔버스. document 가 있으면 <canvas>, 없으면(워커) OffscreenCanvas. 둘 다 없으면 예외 */
export function bufferToCanvas(buf: PixelBuffer): HTMLCanvasElement | OffscreenCanvas {
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = buf.w;
    c.height = buf.h;
    canvas = c;
  } else if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(buf.w, buf.h);
  } else {
    throw new Error('캔버스를 만들 수 없는 환경입니다 (document / OffscreenCanvas 없음)');
  }
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('2D 컨텍스트를 만들 수 없습니다');
  const img = ctx.createImageData(buf.w, buf.h);
  img.data.set(buf.data);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * 시트의 한 프레임을 캔버스에 찍는다. (x, y) 는 앵커(발 위치)가 놓일 픽셀 좌표.
 * flip 이면 좌우 반전(왼쪽 보기). scale 은 픽셀 배율, alpha 는 투명도(죽은 유닛 반투명용).
 * 외부 시트는 meta 의 frameW/frameH/anchor 를 그대로 따른다.
 */
export function drawSpriteFrame(
  ctx: CanvasRenderingContext2D,
  sheet: SpriteSheet,
  anim: AnimName,
  frame: number,
  x: number,
  y: number,
  flip: boolean,
  scale = 1,
  alpha = 1,
): void {
  const meta = sheet.meta;
  const def = meta.anims[anim];
  const f = Math.max(0, Math.min(def.frames - 1, frame));
  const sx = f * meta.frameW;
  const sy = def.row * meta.frameH;
  const dw = meta.frameW * scale;
  const dh = meta.frameH * scale;
  const prevAlpha = ctx.globalAlpha;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (alpha < 1) ctx.globalAlpha = prevAlpha * alpha;
  if (flip) {
    ctx.translate(Math.round(x), Math.round(y));
    ctx.scale(-1, 1);
    ctx.drawImage(sheet.image, sx, sy, meta.frameW, meta.frameH, -Math.round(meta.anchor.x * scale), -Math.round(meta.anchor.y * scale), dw, dh);
  } else {
    ctx.drawImage(sheet.image, sx, sy, meta.frameW, meta.frameH, Math.round(x - meta.anchor.x * scale), Math.round(y - meta.anchor.y * scale), dw, dh);
  }
  ctx.restore();
}

const SPRITE_CACHE = new Map<string, SpriteSheet>();

function cacheKey(key: SpriteKey, tint: string | undefined): string {
  return tint ? `${key}|${tint}` : key;
}

/**
 * 코드 생성 시트 (캐시). tint 는 '#rrggbb' 세부 직업 색이며 직업 시트(tintable)에만 적용된다.
 * 몬스터·소환물 키에 tint 를 줘도 무시한다. 알 수 없는 키는 검사 시트로 그린다.
 */
export function getSpriteSheet(key: SpriteKey, tint?: string): SpriteSheet {
  const design = DESIGNS[key] ?? DESIGNS[FALLBACK_SPRITE_KEY];
  const effTint = design.tintable && tint ? tint : undefined;
  const ck = cacheKey(key, effTint);
  const hit = SPRITE_CACHE.get(ck);
  if (hit) return hit;
  let buf = buildSheetBuffer(key);
  if (effTint) {
    buf = buf.clone();
    applyHueTint(buf.data, effTint);
  }
  const sheet: SpriteSheet = {
    key,
    image: bufferToCanvas(buf),
    meta: DEFAULT_META,
    tintable: design.tintable,
  };
  SPRITE_CACHE.set(ck, sheet);
  return sheet;
}

/** 키가 직업 시트인지 (틴트 대상) */
export function isTintableKey(key: SpriteKey): boolean {
  const d = DESIGNS[key];
  return d ? d.tintable : spriteKeyKind(key) === 'job';
}

/** 캐시 비우기 (테스트·핫리로드용) */
export function clearSpriteCache(): void {
  SHEET_CACHE.clear();
  SPRITE_CACHE.clear();
}
