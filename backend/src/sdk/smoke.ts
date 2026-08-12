/**
 * SDK 스모크 테스트.
 *
 * 손으로 파이프에 밀어넣어 확인했던 시나리오를 Node에서 그대로 재현한다.
 * 같은 결과가 나오면 SDK 계층이 프로토콜을 제대로 감쌌다는 뜻이다.
 *
 *   node --experimental-strip-types src/sdk/smoke.ts
 */

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { SessionPool } from './pool.ts';
import type {
  AvatarMeshResult, MeshDataResult, PatternData, PatternTransform2D,
} from './protocol.ts';
import { decodePatterns, Session } from './session.ts';
import { Worker } from './worker.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const EXE = resolve(ROOT, 'backend/native/build/Release/zelusSandBoxd-demo.exe');
const ZLS = resolve(ROOT, 'zelusSandBox_Cobalt/Zest/testing/sdk/sample.zls');
/** 회전이 있는 씬을 찾는 곳. 저장소에 없는 사용자 데이터라 있으면 쓰고 없으면 넘어간다 */
const SCENE_DIRS = [resolve(ROOT, 'backend/data/incoming'), resolve(ROOT, 'backend/data/scenes')];

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  실패'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** 판정에 넣지 않는 진단. 기준 밖이지만 알아둘 값을 남긴다 (frontend 스모크와 같은 표기) */
function note(label: string, detail: string): void {
  console.log(`  ..    ${label}  — ${detail}`);
}

function ms(t: number): string {
  return `${Math.round(t)}ms`;
}

/** §5.11 이 뒤진 씬 수. 건너뛸 때 **무엇을 안 봤는지** 화면에 남기려고 센다 */
let accessoryScenesTried = 0;

/**
 * 액세서리를 걸친 아바타가 있는 씬을 찾는다 (§5.11).
 *
 * `findRotatedScene` · `findMultiColorScene` 과 같은 자리다 — 저장소에 없는
 * 사용자 데이터(`backend/data/` 는 .gitignore)라 **있으면 태우고 없으면 넘어간다.**
 *
 * ⚠️ 씬 하나가 100~140MB 라 로드가 싸지 않다. 그래서 **첫 히트에서 멈추고**,
 *    `SCENE_DIRS` 의 순서가 곧 비용이다(`incoming` 이 앞이라 사용자 씬이 먼저
 *    걸린다). 같은 파일이 두 디렉토리에 중복돼 있어도 첫 번째에서 끝난다.
 */
async function findAccessoryScene(
  session: Session,
): Promise<{ path: string; result: AvatarMeshResult } | null> {
  const seen = new Set<string>();
  for (const dir of SCENE_DIRS) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.toLowerCase().endsWith('.zls')) continue;
      const p = resolve(dir, name);
      // 크기가 같은 파일은 같은 씬일 가능성이 높다 — 138MB 를 두 번 열지 않는다.
      const key = String(statSync(p).size);
      if (seen.has(key)) continue;
      seen.add(key);
      accessoryScenesTried += 1;
      if (session.loadedPath !== p) {
        await session.clear();
        await session.load(p);
      }
      const result = await session.avatarMesh(true, false);
      if (result.avatars.some((a) => a.parts.some((q) => q.accessory !== undefined))) {
        return { path: p, result };
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 2D 배치 변환의 **정답지** — 씬 파일에서 직접 읽는다 (ISSUE-018)
//
// ⚠️ 이 도우미들이 없으면 `transform2d` 는 검증 불가능하다. 값이 그럴듯한지만
//    보는 단언(겹침이 줄었다, 유한하다)은 **행렬을 전치해도 전부 통과한다** —
//    전치본도 패턴을 흩어 놓고 유한하기 때문이다. ISSUE-011 에서 쿼터니언을
//    [w,x,y,z] 로 잘못 읽어도 AABB 가 0.036cm 밖에 안 흔들려 통과했던 것과
//    같은 함정이다. 가르는 유일한 방법은 **바깥에 있는 정답지와 대조**하는
//    것이고, 그 정답지가 `.zls` 안에 평문 JSON 으로 들어 있다.
//
// `.zls` 는 ZIP 이 아니라 큰 텍스트/바이너리 혼합 파일이고, 서피스마다 이런
// 블록이 들어 있다(키가 알파벳 순으로 정렬돼 있다):
//
//   "transform":
//   {
//       "rotation": 0.0,
//       "rotationCenter": [ 0.0, 0.0 ],
//       "scaleFactor": 1.0,
//       "scaleX": 1.0, "scaleY": 1.0,
//       "translateX": 15.7759323, "translateY": 64.8845138
//   }
//
// 같은 블록이 서피스당 3~4회 반복된다(.zls 안에 씬 사본이 여러 벌 있다).
// 그래서 **집합으로** 대조한다 — 순서로 짝을 지으면 그 순서 자체가 또 하나의
// 가정이 되고, 워커의 패턴 순서는 우리가 정한 것이 아니다.
// ─────────────────────────────────────────────────────────────

interface SurfaceTransform {
  rotation: number;
  rotCenter: [number, number];
  scaleX: number;
  scaleY: number;
  translateX: number;
  translateY: number;
}

const TRANSFORM_BLOCK = new RegExp(
  String.raw`"transform"\s*:\s*\{\s*`
  + String.raw`"rotation"\s*:\s*(-?[\d.eE+-]+)\s*,\s*`
  + String.raw`"rotationCenter"\s*:\s*\[\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*\]\s*,\s*`
  + String.raw`"scaleFactor"\s*:\s*(-?[\d.eE+-]+)\s*,\s*`
  + String.raw`"scaleX"\s*:\s*(-?[\d.eE+-]+)\s*,\s*`
  + String.raw`"scaleY"\s*:\s*(-?[\d.eE+-]+)\s*,\s*`
  + String.raw`"translateX"\s*:\s*(-?[\d.eE+-]+)\s*,\s*`
  + String.raw`"translateY"\s*:\s*(-?[\d.eE+-]+)\s*`,
  'g',
);

/**
 * 씬 파일을 흘려 읽으며 서피스 변환 블록을 전부 긁어 온다.
 *
 * 103MB 를 통째로 문자열로 만들지 않는다(UTF-16 으로 200MB+ 가 된다).
 * 청크 경계에서 블록이 잘리는 것을 막으려고 꼬리 8KB 를 다음 청크에 이어 붙인다
 * — 블록 하나가 ~300바이트라 넉넉하다. 겹치는 구간에서 같은 블록이 두 번
 * 잡힐 수 있지만, 어차피 집합으로 줄이므로 해가 없다.
 */
async function readSceneTransforms(file: string): Promise<SurfaceTransform[]> {
  const out: SurfaceTransform[] = [];
  const OVERLAP = 8192;
  let tail = '';
  await new Promise<void>((res, rej) => {
    // latin1: 바이트 → 코드포인트 1:1. UTF-8 디코딩이 청크 경계에서 깨지는 것을
    // 피하려는 것이고, 우리가 찾는 것은 ASCII 뿐이라 이걸로 충분하다.
    const s = createReadStream(file, { encoding: 'latin1', highWaterMark: 1 << 22 });
    s.on('data', (chunk) => {
      const text = tail + String(chunk);
      TRANSFORM_BLOCK.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = TRANSFORM_BLOCK.exec(text)) !== null) {
        out.push({
          rotation: Number(m[1]),
          rotCenter: [Number(m[2]), Number(m[3])],
          scaleX: Number(m[5]),
          scaleY: Number(m[6]),
          translateX: Number(m[7]),
          translateY: Number(m[8]),
        });
      }
      tail = text.slice(Math.max(0, text.length - OVERLAP));
    });
    s.on('end', () => res());
    s.on('error', rej);
  });
  return out;
}

/**
 * 씬 파일의 다섯 필드 → 3×3 행렬. `ztDesign2DTransform::GetMatrix33()` 의 재구현이다
 * (`Zest/design/ztDesign2DTransform.cpp:61-80`):
 *
 *   M = T(translate) · [T(sc)·S(scale)·T(−sc)] · [T(rc)·R(rotate)·T(−rc)]
 *
 * `scaleCenter`(sc)는 `.zls` 직렬화에 아예 없고 어디서도 채워지지 않으므로 0으로
 * 둔다 — 그 가정이 깨지면 아래 대조가 어긋나 **여기가 빨간불이 된다.** 그게 이
 * 재구현을 손으로 적어 둔 값어치다: 엔진이 합성 규칙을 바꾸면 우리가 안다.
 *
 * `rotation` 은 **라디안**이다(`cos(rad)` 에 그대로 들어간다). `scaleFactor` 는
 * 변환이 아니라 서피스 데이터의 별도 필드라 여기 들어오지 않는다.
 */
function matrixFromScene(t: SurfaceTransform): number[] {
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  const [rx, ry] = t.rotCenter;
  // R(θ) = [[c, −s], [s, c]] 를 rotCenter 기준으로: p ↦ R(p − rc) + rc
  const a02 = rx - (c * rx - s * ry);
  const a12 = ry - (s * rx + c * ry);
  return [
    t.scaleX * c, t.scaleX * -s, t.scaleX * a02 + t.translateX,
    t.scaleY * s, t.scaleY * c, t.scaleY * a12 + t.translateY,
    0, 0, 1,
  ];
}

/** 행렬을 집합의 키로. float32 왕복 오차보다 크고 씬의 값 간격보다는 작은 자리수 */
function matrixKey(m: readonly number[]): string {
  return m.map((v) => (Object.is(v, -0) ? 0 : v).toFixed(3)).join('|');
}

/** 행 우선 3×3 을 전치한다 — 이 단위에서 가장 잡기 어려운 오류의 재현 */
function transpose(m: readonly number[]): number[] {
  return [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];
}

/** 행 우선 · 열벡터 규약: world = M · [x, y, 1]ᵀ */
function apply2d(m: readonly number[], x: number, y: number): [number, number] {
  return [m[0]! * x + m[1]! * y + m[2]!, m[3]! * x + m[4]! * y + m[5]!];
}

interface Box2 { x0: number; x1: number; y0: number; y1: number }

/** 배치가 실제로 흩어 놓았는지 재는 자 — 겹치는 쌍의 비율과 면적 밀집도 */
function overlapOf(boxes: readonly Box2[]): { pairs: number; hit: number; pct: number; density: number } {
  let pairs = 0;
  let hit = 0;
  let area = 0;
  let ux0 = Infinity; let ux1 = -Infinity; let uy0 = Infinity; let uy1 = -Infinity;
  for (const b of boxes) {
    area += (b.x1 - b.x0) * (b.y1 - b.y0);
    ux0 = Math.min(ux0, b.x0); ux1 = Math.max(ux1, b.x1);
    uy0 = Math.min(uy0, b.y0); uy1 = Math.max(uy1, b.y1);
  }
  for (let a = 0; a < boxes.length; a++) {
    for (let b = a + 1; b < boxes.length; b++) {
      pairs++;
      const A = boxes[a]!; const B = boxes[b]!;
      if (Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0) > 0
        && Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0) > 0) hit++;
    }
  }
  const union = (ux1 - ux0) * (uy1 - uy0);
  return { pairs, hit, pct: pairs === 0 ? 0 : (hit / pairs) * 100, density: union === 0 ? 0 : area / union };
}

function f32(base64: string): Float32Array {
  const buf = Buffer.from(base64, 'base64');
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/** uv 로컬 상자와 `transform2d` 를 곱한 도면 상자를 **같은 정점에서** 한 번에 만든다 */
function boxesOf(patterns: readonly PatternData[]): { local: Box2[]; drawing: Box2[] } {
  const local: Box2[] = [];
  const drawing: Box2[] = [];
  for (const p of patterns) {
    const m = p.transform2d;
    if (!p.uvs || !m) continue;
    const uv = f32(p.uvs);
    let lx0 = Infinity; let lx1 = -Infinity; let ly0 = Infinity; let ly1 = -Infinity;
    let wx0 = Infinity; let wx1 = -Infinity; let wy0 = Infinity; let wy1 = -Infinity;
    for (let k = 0; k + 1 < uv.length; k += 2) {
      const x = uv[k]!; const y = uv[k + 1]!;
      lx0 = Math.min(lx0, x); lx1 = Math.max(lx1, x);
      ly0 = Math.min(ly0, y); ly1 = Math.max(ly1, y);
      const [wx, wy] = apply2d(m, x, y);
      wx0 = Math.min(wx0, wx); wx1 = Math.max(wx1, wx);
      wy0 = Math.min(wy0, wy); wy1 = Math.max(wy1, wy);
    }
    if (lx0 === Infinity) continue;
    local.push({ x0: lx0, x1: lx1, y0: ly0, y1: ly1 });
    drawing.push({ x0: wx0, x1: wx1, y0: wy0, y1: wy1 });
  }
  return { local, drawing };
}

/** 워커가 실은 행렬들을 씬 정답지와 짝지어 본다. 원본·전치본을 **같은 자로** 잰다 */
function matchAgainstScene(
  mats: readonly PatternTransform2D[],
  truth: ReadonlySet<string>,
): { matched: number; transposed: number; asymmetric: number; spun: number } {
  let matched = 0;
  let transposed = 0;
  let asymmetric = 0;
  let spun = 0;
  for (const m of mats) {
    if (truth.has(matrixKey(m))) matched++;
    const t = transpose(m);
    if (truth.has(matrixKey(t))) transposed++;
    // 전치가 **원본과 다른 행렬이 되는** 경우에만 위 대조에 이빨이 있다.
    if (matrixKey(m) !== matrixKey(t)) asymmetric++;
    // 2×2 블록까지 비대칭이어야 m01↔m10 부분 전치를 가른다 (= 회전이 있는 패턴)
    if (Math.abs(m[1] - m[3]) > 1e-4) spun++;
  }
  return { matched, transposed, asymmetric, spun };
}

/**
 * **회전이 0이 아닌** 서피스를 가진 씬 하나. 없으면 null.
 *
 * sample.zls 는 24개 블록 전부 `rotation: 0.0` 이라 2×2 블록이 항등이다 —
 * 그 씬에서는 `m01`↔`m10` 을 맞바꿔도 **값이 문자 그대로 같아서** 어떤 단언도
 * 그 손을 잡을 수 없다. 회전이 있는 씬이 있어야 부분 전치가 관측 가능해진다.
 *
 * 그런 씬은 저장소에 없다(`backend/data/` 는 .gitignore 이고 sample.zls 는
 * 회전이 없다). 그래서 **있으면 쓰고 없으면 넘어가는** 절로 만든다 — 없을 때
 * 무엇을 못 덮었는지 화면에 남기는 것이 조용히 통과하는 것보다 낫다.
 */
async function findRotatedScene(): Promise<{ path: string; truth: SurfaceTransform[] } | null> {
  for (const dir of SCENE_DIRS) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.toLowerCase().endsWith('.zls')) continue;
      const path = resolve(dir, name);
      const truth = await readSceneTransforms(path);
      if (truth.some((t) => Math.abs(t.rotation) > 1e-4)) return { path, truth };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 패턴 재질의 **정답지** — 같은 씬 파일에서 직접 읽는다 (materials-a)
//
// ⚠️ 위 `transform2d` 와 **똑같은 이유로** 필요하다. "색이 왔다 / 0~1 이다 /
//    유한하다" 만 보는 단언은 **채널 순서를 RGB→BGR 로 바꿔도 전부 통과한다.**
//    화면 쪽도 못 잡는다 — 노랑이 보라가 되어도 "이 씬은 원래 이런 색인가" 로만
//    보이고, 크래시도 예외도 없다. 가르는 유일한 방법은 바깥의 정답지다.
//
// `.zls` 는 8바이트 접두사 뒤에 **압축 없이(STORED)** 들어간 ZIP 이라 씬 JSON 이
// 평문으로 그대로 들어 있다(위 `readSceneTransforms` 가 이미 쓰는 성질이다).
// 그래서 zip 을 풀지 않고도 두 블록을 통째로 꺼낼 수 있다:
//
//   "materials": { "<머티리얼 uuid>": { "basecolor": [r,g,b,a], "colorProfile": 1,
//                                       "roughness": …, "metalness": …,
//                                       "textures": { "assetUuid": "<직물>" } }, … }
//   "clothPatterns": { "<패턴 uuid>": { "frontMaterial": "<머티리얼 uuid>", … } }
//
// 둘을 이으면 **패턴 uuid → 색** 표가 나온다. 집합 대조가 아니라 패턴별 대조라,
// 색을 통째로 뒤섞어 실어도(패턴 A 에 B 의 색) 여기서 걸린다.
//
// ★ 왜 별도 프로브 도구를 만들지 않았나 — `readSceneTransforms` 와 같은 자리에
//   같은 방식으로 두는 편이 낫다. 이 값을 쓰는 곳이 여기뿐이고, 도구로 빼면
//   "정답지가 테스트 바깥에 있다" 는 상태가 되어 갱신이 뒤처진다.
// ─────────────────────────────────────────────────────────────

interface MaterialTruth {
  /** basecolor 의 앞 세 성분. 넷째(`basecolor.w`)는 익스포터도 우리도 버린다 */
  color: [number, number, number];
  /** `ztColorProfile`: 0 = Linear, 1 = SRGB (`SDK/include/ztColor.h:7-11`) */
  colorProfile: number;
  /** 별도 필드다. 옛 포맷에는 아예 없어서(sample.zls) 그때는 구조체 기본값 1.0 */
  alpha: number;
  roughness: number;
  metalness: number;
  /** `textures` 섹션 안에 직렬화된다 (`ztDesignMaterial.cpp:62`) */
  fabricUuid: string;
}

/**
 * 씬 파일에서 이름 붙은 JSON 객체 블록들을 통째로 꺼낸다.
 *
 * 103~145MB 를 한 문자열로 만들지 않는다. 청크마다 `indexOf` 로 키를 찾고
 * (네이티브라 빠르다), 찾은 자리부터만 문자 단위로 중괄호 짝을 맞춘다 —
 * 블록 하나는 30~60KB 라 이 부분만 느려도 상관없다. 블록이 청크 경계를 넘으면
 * 다음 청크에서 이어 받는다(`cap` 상태가 청크를 가로질러 산다).
 *
 * ⚠️ `.zls` 안에는 텍스처 같은 바이너리 엔트리도 들어 있어서, 우연히 키 문자열이
 *    바이너리에 나타나면 짝이 안 맞는 `{` 를 물고 끝없이 자랄 수 있다. 그래서
 *    상한을 두고 넘으면 그 후보를 버린다. 진짜 블록인지는 호출자가 `JSON.parse`
 *    로 최종 판정한다.
 */
async function readSceneBlocks(
  file: string,
  keys: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(keys.map((k) => [k, []]));
  const MAX_BLOCK = 8 << 20;
  /** 키가 청크 경계에 걸리는 것만 막으면 된다 — 가장 긴 키보다 넉넉히 */
  const TAIL = 64;

  let carry = '';
  let cap: null | { key: string; buf: string; depth: number; inStr: boolean; esc: boolean } = null;

  await new Promise<void>((res, rej) => {
    // latin1: 바이트 → 코드포인트 1:1. 찾는 것이 전부 ASCII 라 이걸로 충분하고,
    // UTF-8 디코딩이 청크 경계에서 깨지는 것도 피한다.
    const s = createReadStream(file, { encoding: 'latin1', highWaterMark: 1 << 22 });
    s.on('data', (chunk) => {
      let text = carry + String(chunk);
      carry = '';
      let i = 0;
      while (i < text.length) {
        if (cap) {
          for (; i < text.length; i++) {
            const ch = text[i]!;
            cap.buf += ch;
            if (cap.inStr) {
              if (cap.esc) cap.esc = false;
              else if (ch === '\\') cap.esc = true;
              else if (ch === '"') cap.inStr = false;
            } else if (ch === '"') cap.inStr = true;
            else if (ch === '{') cap.depth++;
            else if (ch === '}') {
              cap.depth--;
              if (cap.depth === 0) {
                out.get(cap.key)!.push(cap.buf);
                cap = null;
                i++;
                break;
              }
            }
            if (cap.buf.length > MAX_BLOCK) { cap = null; i++; break; }  // 바이너리 오검출
          }
          if (cap) return;   // 청크가 다 떨어졌다. 다음 청크에서 이어 받는다
          continue;
        }

        let best = -1;
        let bestKey = '';
        for (const k of keys) {
          const j = text.indexOf(`"${k}"`, i);
          if (j >= 0 && (best < 0 || j < best)) { best = j; bestKey = k; }
        }
        if (best < 0) {
          carry = text.slice(Math.max(i, text.length - TAIL));
          return;
        }
        const open = text.indexOf('{', best);
        if (open < 0) { carry = text.slice(best); return; }
        cap = { key: bestKey, buf: '', depth: 0, inStr: false, esc: false };
        i = open;
      }
    });
    s.on('end', () => res());
    s.on('error', rej);
  });
  return out;
}

/**
 * 씬 파일 → **패턴 uuid → 재질** 표. 못 세우면 null.
 *
 * ⚠️ 블록은 파일 안에 여러 벌 있다. 그리고 **첫 번째를 고르면 안 된다** —
 *    실측: `sample.zls` 의 네 벌은 사본 두 벌이 아니라 **서로 다른 uuid 대역 두
 *    개**가 각각 두 번씩 들어 있는 것이다(`566024…` 계열과 `1023457615…` 계열).
 *    값은 같지만 키가 겹치지 않아서, 워커가 실제로 쓰는 쪽이 어느 것인지 파일만
 *    봐서는 모른다. 그래서 전부 합친다 — uuid 가 겹치지 않으므로 합집합이
 *    안전하고, 겹치는데 값이 다르면 그건 진짜 충돌이라 `copiesAgree` 로 알린다.
 *
 * 패턴 uuid 로 짝을 짓기 때문에, 쓰지 않는 대역이 표에 섞여 있어도 해가 없다.
 */
async function readSceneMaterials(file: string): Promise<{
  byPattern: Map<string, MaterialTruth>;
  materialCount: number;
  copies: number;
  copiesAgree: boolean;
} | null> {
  const blocks = await readSceneBlocks(file, ['materials', 'clothPatterns']);

  const parse = (list: readonly string[]): Record<string, Record<string, unknown>>[] => {
    const ok: Record<string, Record<string, unknown>>[] = [];
    for (const j of list) {
      try {
        const o: unknown = JSON.parse(j);
        if (o !== null && typeof o === 'object' && !Array.isArray(o)) {
          ok.push(o as Record<string, Record<string, unknown>>);
        }
      } catch { /* 바이너리 오검출. 버린다 */ }
    }
    return ok;
  };

  const mats = parse(blocks.get('materials') ?? []);
  const pats = parse(blocks.get('clothPatterns') ?? []);
  if (mats.length === 0 || pats.length === 0) return null;
  const M: Record<string, Record<string, unknown>> = Object.assign({}, ...mats) as never;

  const truthOf = (raw: Record<string, unknown> | undefined): MaterialTruth | null => {
    if (!raw) return null;
    const c = raw['basecolor'];
    if (!Array.isArray(c) || c.length < 3) return null;
    const tex = raw['textures'];
    const fab = tex !== null && typeof tex === 'object'
      ? (tex as Record<string, unknown>)['assetUuid'] : undefined;
    if (typeof fab !== 'string') return null;
    return {
      color: [Number(c[0]), Number(c[1]), Number(c[2])],
      colorProfile: Number(raw['colorProfile'] ?? 1),
      // 옛 포맷(sample.zls)에는 `alpha` 키가 없다 → 구조체 기본값
      // (`ztDesignMaterial.h:44`). 없는 것과 0 을 구분해야 한다.
      alpha: typeof raw['alpha'] === 'number' ? raw['alpha'] : 1,
      roughness: Number(raw['roughness'] ?? 0.3),
      metalness: Number(raw['metalness'] ?? 0),
      fabricUuid: fab,
    };
  };

  const byPattern = new Map<string, MaterialTruth>();
  /** 같은 패턴 uuid 가 사본마다 **다른** 재질을 말하면 합집합이 거짓말이 된다 */
  let copiesAgree = true;
  for (const P of pats) {
    for (const [uuid, p] of Object.entries(P)) {
      const front = p['frontMaterial'];
      if (typeof front !== 'string') continue;
      const t = truthOf(M[front]);
      if (!t) continue;
      const had = byPattern.get(uuid);
      if (had && JSON.stringify(had) !== JSON.stringify(t)) copiesAgree = false;
      byPattern.set(uuid, t);
    }
  }
  if (byPattern.size === 0) return null;

  return { byPattern, materialCount: Object.keys(M).length, copies: pats.length, copiesAgree };
}

/** 재질 하나를 대조 키로. float32 왕복 오차보다 크고 8비트 색 간격(1/255)보다는 작다 */
function colorKey(c: readonly number[]): string {
  return c.slice(0, 3).map((v) => v.toFixed(5)).join('|');
}

/**
 * 색이 **채널마다 다른** 씬 하나. 없으면 null.
 *
 * sample.zls 는 다섯 패턴이 전부 흰색 `[1,1,1]` 이다 — 회색축이라 채널 순서를
 * RGB→BGR 로 바꿔도 **값이 문자 그대로 같아서** 어떤 단언도 그 손을 잡을 수
 * 없다. §5.7 의 "회전이 0이라 부분 전치가 관측 불가" 와 정확히 같은 구멍이다.
 *
 * 게다가 색이 한 종류뿐이라 `fabricUuid` 그룹화도 1개짜리 자명한 답이 되어,
 * 그룹화가 거짓인지 참인지 구분되지 않는다. 두 구멍 모두 색이 갈리는 씬이
 * 있어야 메워진다. 그런 씬은 저장소에 없다(`backend/data/` 는 .gitignore).
 */
async function findMultiColorScene(): Promise<
  { path: string; truth: Map<string, MaterialTruth> } | null
> {
  for (const dir of SCENE_DIRS) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.toLowerCase().endsWith('.zls')) continue;
      const path = resolve(dir, name);
      const g = await readSceneMaterials(path);
      if (!g) continue;
      const colors = new Set([...g.byPattern.values()].map((t) => colorKey(t.color)));
      const chromatic = [...g.byPattern.values()].some(
        (t) => Math.abs(t.color[0] - t.color[1]) > 1e-3 || Math.abs(t.color[1] - t.color[2]) > 1e-3,
      );
      if (colors.size >= 2 && chromatic) return { path, truth: g.byPattern };
    }
  }
  return null;
}

/**
 * 2026-08-07 조사에서 **씬 JSON 을 직접 읽어** 확정한 값. 위 정답지 리더와
 * 완전히 독립된 출처라, 리더가 틀리면 여기서 갈린다(리더가 자기 자신을
 * 증명하는 순환을 끊는 유일한 못이다).
 *
 * 파일 이름과 **바이트 수**로 잠근다 — 다른 기계의 같은 이름 다른 씬에는
 * 적용되지 않아야 한다.
 */
const KNOWN_SCENES: readonly {
  name: string;
  bytes: number;
  patterns: number;
  colors: readonly { label: string; rgb: readonly [number, number, number]; count: number }[];
}[] = [
  {
    name: 'W_Bra top & Leggings.zls',
    bytes: 144_611_136,
    patterns: 24,
    colors: [
      { label: '노랑', rgb: [0.9254902, 0.8117647, 0.4705882], count: 16 },
      { label: '민트', rgb: [0.7333333, 0.8862745, 0.8156863], count: 8 },
    ],
  },
];

async function main(): Promise<void> {
  for (const [label, p] of [['exe', EXE], ['sample.zls', ZLS]] as const) {
    if (!existsSync(p)) {
      console.error(`${label}을 찾을 수 없습니다: ${p}`);
      process.exit(1);
    }
  }

  console.log('\n=== SDK 스모크 테스트 ===\n');

  // ── 0. 기동 실패는 세션 하나의 실패다 (ISSUE-006) ─────
  // spawn 자체가 실패하면(exe 없음, 권한, fd 고갈) child_process는 'exit'이
  // 아니라 'error'를 낸다. 리스너가 없으면 EventEmitter가 unhandled로 승격시켜
  // **SDK를 쓰는 프로세스를 통째로 죽인다.**
  //
  // 게이트웨이 스모크가 이걸 502로 간접 확인하지만, SDK는 게이트웨이 없이도
  // 쓰이는 계층이다. "호스트 프로세스를 죽이지 않는다"는 SDK 자신의 계약이므로
  // 자기 층에서 지켜야 한다 — 게이트웨이가 풀 배선을 바꾸면 그 간접 그물은
  // 조용히 사라진다. 비용도 0이다: 없는 exe는 워커를 띄우지 않는다.
  {
    // 랜덤 이름이라 우연히 존재할 수 없다.
    const ghost = `${EXE}.no-such-worker-${process.pid}-${Date.now()}.exe`;

    // ① Worker 층 — 'exit'이 **정확히 한 번**, code=null로 나간다.
    //    'error'와 'exit'이 둘 다 오는 플랫폼에서도 한 번이어야 한다.
    //    두 번 나가면 이미 끝난 세션을 다시 정리하는 경로가 열린다.
    const logs: string[] = [];
    const w = Worker.spawn({ exePath: ghost, onLog: (l) => logs.push(l) });
    const exits: (number | null)[] = [];
    const firstExit = new Promise<void>((res) => w.once('exit', () => res()));
    w.on('exit', (c) => exits.push(c));

    await Promise.race([firstExit, new Promise((r) => setTimeout(r, 3_000))]);
    await new Promise((r) => setTimeout(r, 150)); // 두 번째 발화가 있으면 여기서 잡힌다

    check('없는 exe → exit 이벤트 정확히 1회', exits.length === 1, `${exits.length}회 ${JSON.stringify(exits)}`);
    check('exit code는 null (spawn 실패엔 exit이 없다)', exits[0] === null, `code=${String(exits[0])}`);
    check('worker.closed === true', w.closed === true);
    check(
      '실패 로그에 exe 경로가 있다',
      logs.some((l) => l.includes(ghost)),
      logs.join(' / ').slice(0, 160) || '로그 없음',
    );

    // ② Session 층 — create()가 매달리지 않고 reject 된다.
    //    ('ready'가 영영 안 오므로, exit이 그 대기를 깨우는 유일한 탈출구다)
    const failed = await Session.create({ exePath: ghost }).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    check(
      'Session.create()가 reject (매달리지 않는다)',
      failed !== null && failed.includes('code=null'),
      failed ?? '성공해버렸다 — 없는 exe로 세션이 생겼다',
    );

    // ③ Pool 층 — acquire가 reject되고 세션을 세지 않는다.
    const badPool = new SessionPool({ exePath: ghost, idleTimeout: 0, onLog: () => {} });
    const rejected = await badPool.acquire().then(() => false, () => true);
    check(
      'pool.acquire()가 reject + 누수 없음',
      rejected && badPool.stats.total === 0,
      `rejected=${rejected}, stats=${JSON.stringify(badPool.stats)}`,
    );
    await badPool.close();

    // ④ 그리고 이 프로세스가 아직 살아 있다. 예전엔 ①에서 이미 죽었다 —
    //    여기까지 도달한 것 자체가 단언이고, 회귀하면 이 줄이 출력되지 않는다.
    check('기동 실패가 SDK 사용자 프로세스를 죽이지 않는다', true, `pid=${process.pid} 생존`);
  }

  // idleTimeout을 켜서 프로세스 재사용 경로까지 태운다.
  const pool = new SessionPool({
    exePath: EXE,
    idleTimeout: 30_000,
    maxIdle: 2,
    onLog: () => {},   // 엔진 로그는 조용히
  });

  try {
    // ── 1. 기동 + 기본 왕복 ───────────────────────────────
    let t = performance.now();
    const session = await pool.acquire();
    const spawnMs = performance.now() - t;
    check('세션 기동', session.alive, ms(spawnMs));

    const pong = await session.ping();
    check('ping 왕복', pong.pong === true);

    // 버전은 init/load 없이 ready 직후 답해야 한다.
    // 값은 링크된 엔진에 따라 달라지므로 "비어있지 않음"만 본다.
    const ver = await session.version();
    check(
      'version 조회',
      typeof ver.zelus === 'string' && ver.zelus.length > 0
        && typeof ver.lumia === 'string' && ver.lumia.length > 0,
      `zelus=${JSON.stringify(ver.zelus)}, lumia=${JSON.stringify(ver.lumia)}`,
    );

    // 구독 토글도 씬 로드 없이 ready 직후에 답해야 한다.
    // status가 실제로 그 상태를 들고 있는지가 핵심이다.
    const sub = await session.subscribe();
    const stSub = await session.status();
    check(
      'subscribe → 구독 켜짐',
      sub.subscribed === true && stSub.subscribed === true,
      `result=${sub.subscribed}, status=${stSub.subscribed}`,
    );

    const unsub = await session.unsubscribe();
    const stUnsub = await session.status();
    check(
      'unsubscribe → 구독 꺼짐',
      unsub.subscribed === false && stUnsub.subscribed === false,
      `result=${unsub.subscribed}, status=${stUnsub.subscribed}`,
    );

    // ── 2. 씬 로드 ────────────────────────────────────────
    t = performance.now();
    await session.load(ZLS);
    const loadMs = performance.now() - t;
    check('씬 로드 (103MB)', session.loadedPath === ZLS, ms(loadMs));

    // ── 3. 파라미터 ───────────────────────────────────────
    const before = await session.getParams();
    const setRes = await session.setParams({
      gravityY: -500,
      subStep: 2,
      // 일부러 틀린 키를 섞는다. 조용히 삼키면 안 된다.
      nonExistentKey: 1,
    } as never);

    check(
      '파라미터 반영',
      setRes.applied.includes('gravityY') && setRes.applied.includes('subStep'),
      setRes.applied.join(', '),
    );
    check(
      '모르는 키를 보고',
      setRes.unknown.includes('nonExistentKey'),
      setRes.unknown.join(', '),
    );

    const after = await session.getParams();
    check(
      '값이 실제로 바뀜',
      before.gravityY === -980 && after.gravityY === -500 && after.subStep === 2,
      `gravityY ${before.gravityY} → ${after.gravityY}, subStep ${before.subStep} → ${after.subStep}`,
    );

    // ── 4. 시뮬레이션 ─────────────────────────────────────
    const frames: number[] = [];
    session.on('frame', (f) => frames.push(f));

    // 회귀 확인용. 이 구간은 §1에서 unsubscribe로 끝났으므로 비구독 상태다.
    // 구독을 켜기 전에 리스너를 떼야 §5.5의 프레임이 섞이지 않는다.
    let plainFrames = 0;
    let plainWithMesh = 0;
    const onPlainFrame = (_f: number, mesh?: MeshDataResult): void => {
      plainFrames++;
      if (mesh !== undefined) plainWithMesh++;
    };
    session.on('frame', onPlainFrame);

    t = performance.now();
    await session.start();
    const reached = await session.waitForFrame(10, 120_000);
    const simMs = performance.now() - t;
    await session.pause();

    check('프레임 이벤트 수신', frames.length > 0, `${frames.length}개`);
    check('목표 프레임 도달', reached >= 10, `frame ${reached}, ${ms(simMs)}`);

    // 구독하지 않았을 때 frame 이벤트는 이전과 같아야 한다 (mesh 없음).
    session.off('frame', onPlainFrame);
    check(
      '비구독 프레임에 mesh 없음',
      plainFrames > 0 && plainWithMesh === 0,
      `${plainFrames}개 중 mesh 실린 프레임 ${plainWithMesh}개`,
    );

    // ── 5. 지오메트리 ─────────────────────────────────────
    t = performance.now();
    const geo = await session.geometry(true);
    const geoMs = performance.now() - t;

    const totalV = geo.reduce((s, p) => s + p.vertices, 0);
    const totalT = geo.reduce((s, p) => s + p.triangles, 0);

    check('패턴 수', geo.length === 5, `${geo.length}개`);
    check('정점 수', totalV === 3022, `${totalV}`);
    check('삼각형 수', totalT === 5472, `${totalT}`);

    const first = geo[0];
    check(
      'positions 디코딩',
      first !== undefined && first.positions.length === first.vertices * 3,
      first ? `${first.positions.length} floats = ${first.vertices} × 3` : '패턴 없음',
    );
    check(
      'indices 디코딩',
      first?.indices !== undefined && first.indices.length === first.triangles * 3,
      first?.indices ? `${first.indices.length} ints` : '없음',
    );

    // 좌표가 3D인지 (Z가 평면이면 2D 패턴이라는 뜻)
    if (first) {
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 2; i < first.positions.length; i += 3) {
        const z = first.positions[i]!;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      check(
        '3D 드레이프 확인',
        maxZ - minZ > 1,
        `Z 범위 ${minZ.toFixed(1)} ~ ${maxZ.toFixed(1)}`,
      );
    }

    console.log(`         지오메트리 취득 ${ms(geoMs)}`);

    // ── 5.5 구독 중 프레임에 메시 ─────────────────────────
    // 씬 로드와 시뮬 실행이 있어야 성립하므로 ready 직후 그룹(§1)에 둘 수
    // 없다. §5 뒤에 두어 §4·§5의 기존 단언이 구독 상태에 노출되지 않게 한다.
    const WANT = 5;
    const subFrames: { frame: number; mesh: MeshDataResult | undefined }[] = [];
    const onSubFrame = (f: number, mesh?: MeshDataResult): void => {
      subFrames.push({ frame: f, mesh });
    };

    await session.subscribe();
    session.on('frame', onSubFrame);

    try {
      const target = session.worker.lastFrame + WANT;
      await session.start();
      await session.waitForFrame(target, 120_000);
    } finally {
      // 구독은 워커 수명 내내 유지된다. 켠 채로 나가면 이후 테스트와
      // 풀 재사용 세션까지 샌다.
      await session.pause();
      session.off('frame', onSubFrame);
      await session.unsubscribe();
    }

    check('구독 중 프레임 수신', subFrames.length >= WANT, `${subFrames.length}개 (목표 ${WANT})`);

    let bad: string | null = null;
    let patternsChecked = 0;
    for (const ev of subFrames) {
      if (!ev.mesh) {
        bad = `frame ${ev.frame}: mesh 없음`;
        break;
      }
      const pats = decodePatterns(ev.mesh);
      if (pats.length === 0) {
        bad = `frame ${ev.frame}: 패턴 0개`;
        break;
      }
      for (const p of pats) {
        patternsChecked++;
        if (p.positions.length !== p.vertices * 3) {
          bad = `frame ${ev.frame} / ${p.uuid}: positions ${p.positions.length} != ${p.vertices} × 3`;
          break;
        }
      }
      if (bad) break;
    }

    check(
      '각 프레임 positions.length == 정점수 × 3',
      bad === null,
      bad ?? `프레임 ${subFrames.length}개 / 패턴 ${patternsChecked}개 검사`,
    );

    const stAfterSub = await session.status();
    check('구독 정리됨', stAfterSub.subscribed === false, `subscribed=${stAfterSub.subscribed}`);

    // ── 5.7 2D 도면 배치 (ISSUE-018) ──────────────────────
    //
    // #15 의 2D 펼침 뷰는 `uvs` 만으로는 못 그린다. uv 는 서피스 **로컬** 평면
    // 좌표라 패턴마다 자기 원점 근처에서 시작하고, 그대로 그리면 전부 겹쳐
    // 한 덩어리가 된다. 도면 위의 자리는 `transform2d`(행 우선 3×3)가 정한다.
    //
    // ★ 이 절이 겨냥하는 것은 "값이 왔는가" 가 아니라 **행렬을 뒤집어 읽지
    //   않았는가** 다. `zsMatrix33` 은 저장이 열 우선인데 `GetElement(i,j)` 는
    //   (행,열) 접근이라 두 규약이 반대다 — 전치해서 읽어도 패턴은 흩어지고
    //   숫자는 유한해서 **겹침 지표만 보면 통과한다.** ISSUE-011 에서 쿼터니언을
    //   [w,x,y,z] 로 잘못 읽어도 AABB 가 0.036cm 밖에 안 흔들려 통과했던 것과
    //   같은 함정이다. 그래서 여기서는 지표가 아니라 **씬 파일의 정답지**와
    //   성분별로 대조한다.
    //
    // 씬 파일은 이 절이 쓰는 유일한 외부 기준이다. 우리 코드가 만든 값이 아니라
    // 엔진이 쓴 값이므로, 워커와 우리 재구현이 **함께** 틀리지 않는 한 통과할 수
    // 없다.
    let t2dAtRest: string | null = null;
    /** 같은 것을 재질에 대해서도 (materials-a) */
    let matAtRest: string | null = null;
    {
      const tGround = performance.now();
      const truthList = await readSceneTransforms(ZLS);
      const truthSet = new Set(truthList.map((t) => matrixKey(matrixFromScene(t))));
      const md = await session.meshData(true);
      const pats = md.patterns;
      const mats = pats.map((p) => p.transform2d).filter((m): m is PatternTransform2D => m !== undefined);
      t2dAtRest = JSON.stringify(pats.map((p) => p.transform2d));

      check(
        '★ topology:true 의 모든 패턴에 transform2d 가 실린다 (ISSUE-018)',
        pats.length > 0 && mats.length === pats.length,
        `${mats.length}/${pats.length}개`,
      );
      check(
        '★ transform2d 는 길이 9 이고 전부 유한하다 (NaN 하나면 그 패턴이 화면에서 통째로 사라진다)',
        mats.length > 0 && mats.every((m) => m.length === 9 && m.every((v) => Number.isFinite(v))),
        mats.map((m) => m.length).join(','),
      );
      check(
        '★★ 마지막 행이 정확히 [0,0,1] 이다 — 전치되면 여기에 translate 가 앉는다',
        mats.length > 0 && mats.every((m) => m[6] === 0 && m[7] === 0 && m[8] === 1),
        mats.map((m) => `[${m[6]},${m[7]},${m[8]}]`).join(' '),
      );

      check(
        '★ 씬 정답지가 성립한다 — .zls 안의 서피스 변환 블록을 읽어 행렬로 되세웠다',
        truthList.length > 0 && truthSet.size >= mats.length,
        `블록 ${truthList.length}개 → 서로 다른 행렬 ${truthSet.size}개 (${ms(performance.now() - tGround)})`,
      );

      const m = matchAgainstScene(mats, truthSet);
      check(
        '★★★ 워커의 행렬이 씬 정답지와 하나도 빠짐없이 일치한다 (성분이 뒤바뀌면 여기서 걸린다)',
        mats.length > 0 && m.matched === mats.length,
        `${m.matched}/${mats.length}개 일치`,
      );
      check(
        '★★★ 전치본은 정답지와 단 하나도 짝이 안 지어진다 (위 단언이 전치를 실제로 가른다는 증거)',
        m.transposed === 0 && m.asymmetric === mats.length,
        `전치본 일치 ${m.transposed}개 / 전치에 민감한 행렬 ${m.asymmetric}/${mats.length}개`,
      );
      // 2×2 블록까지 비대칭이어야 `m01`↔`m10` **부분** 전치가 관측된다.
      // sample.zls 는 회전이 전부 0이라 그 자리가 0/0 이고, 바꿔도 값이 같다 —
      // 못 잡는 것이 아니라 **관측 불가능**하다. §5.8 이 그 구멍을 맡는다.
      note(
        '2×2 블록이 비대칭인 패턴',
        `${m.spun}/${mats.length}개 — 0이면 m01↔m10 부분 전치는 이 씬에서 관측 불가 (§5.8 참고)`,
      );

      // ── translate 가 어느 자리인가 ──────────────────────
      // 이 씬은 회전이 전부 0이라 m02·m12 가 곧 translateX·translateY 다.
      // (Builder 실측: 패턴 12 의 m02=64.9047 이 .zls 의 translateX 와 자릿수까지 같았다)
      const spinless = truthList.every((t) => Math.abs(t.rotation) < 1e-6);
      const txy = new Set(truthList.map((t) => `${t.translateX.toFixed(3)}|${t.translateY.toFixed(3)}`));
      check(
        '★★ translate 는 m02·m12 자리다 — 씬의 translateX/translateY 와 그대로 짝이 지어진다',
        spinless && mats.length > 0
        && mats.every((mm) => txy.has(`${mm[2].toFixed(3)}|${mm[5].toFixed(3)}`)),
        spinless
          ? mats.map((mm) => `[${mm[2].toFixed(2)},${mm[5].toFixed(2)}]`).join(' ')
          : '이 씬에 회전이 있어 m02 ≠ translateX 다 (이 단언은 회전 0인 씬 전용)',
      );

      // ── 겹침 — 배치가 실제로 일을 했는가 ────────────────
      //
      // ⚠️ 절대값을 못으로 박지 않는다. 씬이 바뀌면 82.2%도 2.5%도 바뀐다.
      //    계약은 **"배치를 곱하면 겹침이 확연히 준다"** 이고, 대조군을 같은
      //    실행에서 같은 정점으로 만들어 문턱 없이 비교한다.
      const { local, drawing } = boxesOf(pats);
      const before = overlapOf(local);
      const after = overlapOf(drawing);
      check(
        '★ 대조군이 실제로 겹쳐 있었다 — uvs 그대로 그리면 도면이 한 덩어리다 (#15 의 최초 전제가 틀린 이유)',
        before.pairs > 0 && before.pct > 50,
        `적용 전 ${before.hit}/${before.pairs}쌍 (${before.pct.toFixed(1)}%) 겹침`,
      );
      check(
        '★★★ transform2d 를 곱하면 겹침이 확연히 줄어든다 (이 단위가 성공했는지를 가르는 숫자)',
        after.pct < before.pct / 2,
        `${before.pct.toFixed(1)}% → ${after.pct.toFixed(1)}% (${after.hit}/${after.pairs}쌍)`,
      );
      check(
        '★ 면적 밀집도도 함께 내려간다 — 상자가 커져서 겹침이 준 것이 아니다',
        after.density < before.density && after.density < 1,
        `밀집도 ${before.density.toFixed(2)}배 → ${after.density.toFixed(2)}배`,
      );

      // ── 3D 변환과 섞이지 않는가 (ISSUE-011 을 다시 겪지 않는다) ──
      //
      // 둘은 **다른 값**이다: 3D 는 패턴 로컬 → 3D 월드(TRS 분해), 2D 는 로컬 →
      // 도면(3×3 행렬). 한쪽 자리에 다른 쪽을 실으면 타입은 통과하는데 화면이
      // 조용히 틀린다.
      const first = pats[0];
      check(
        '★★ 3D transform 과 2D transform2d 가 둘 다, 서로 다른 모양으로 온다 (TRS 객체 vs 숫자 9개)',
        first?.transform !== undefined && Array.isArray(first.transform2d)
        && !Array.isArray(first.transform) && first.transform2d.length === 9,
        `transform=${typeof first?.transform} / transform2d=${Array.isArray(first?.transform2d) ? `배열 ${first.transform2d.length}` : typeof first?.transform2d}`,
      );
      check(
        '★★ 두 변환이 같은 값이 아니다 (3D translation 을 2D 자리에 실어도 위 단언은 통과한다)',
        pats.every((p) => {
          const t3 = p.transform;
          const t2 = p.transform2d;
          if (!t3 || !t2) return false;
          // 3D 의 (x, y) 가 2D 의 (m02, m12) 로 새어 들어오지 않았는가
          return Math.abs(t3.translation[0] - t2[2]) > 1e-3
            || Math.abs(t3.translation[1] - t2[5]) > 1e-3;
        }),
        pats.map((p) => `3D[${p.transform?.translation.slice(0, 2).map((v) => v.toFixed(1)).join(',')}] vs 2D[${p.transform2d?.[2].toFixed(1)},${p.transform2d?.[5].toFixed(1)}]`).join(' '),
      );

      // ── 프레임 이벤트에는 안 실린다 (topology 게이팅) ────
      const framePats = subFrames.flatMap((ev) => ev.mesh?.patterns ?? []);
      check(
        '★★ 프레임 이벤트의 mesh 에는 transform2d 키가 아예 없다 (topology:true 에만 실린다)',
        framePats.length > 0
        && framePats.every((p) => !('transform2d' in (p as unknown as Record<string, unknown>))),
        `패턴 ${framePats.length}개 중 ${framePats.filter((p) => 'transform2d' in (p as unknown as Record<string, unknown>)).length}개에 실렸다`,
      );

      const mdNoTopo = await session.meshData(false);
      check(
        '★ topology:false 응답에도 transform2d 가 없다 (uvs·indices 와 같은 갈래에 있다)',
        mdNoTopo.patterns.length > 0
        && mdNoTopo.patterns.every((p) => !('transform2d' in (p as unknown as Record<string, unknown>))),
        `패턴 ${mdNoTopo.patterns.length}개`,
      );

      // ── 5.9 패턴 재질 (materials-a) ─────────────────────
      //
      // 실시간 3D 뷰는 여태 패턴 구분용 **임의 5색**을 칠했다. 진짜 색은
      // 스냅샷(glTF)에만 나왔고, 그래서 사용자는 움직이는 옷을 보면서 색을
      // 믿을 수 없었다. 이 절은 그 출처가 **씬의 값과 같은가**를 본다.
      // (화면에 칠하는 일은 materials-b 몫이다 — 여기서는 아직 배선되지 않는다.)
      //
      // ★ §5.7 과 같은 함정이 있다. "색이 실렸다 / 0~1 이다 / 유한하다" 는
      //   **채널 순서를 RGB→BGR 로 바꿔도 전부 통과한다.** 색은 틀려도 예외가
      //   안 나고, 화면에서도 "이 씬은 원래 이런 색인가" 로만 보인다. 그래서
      //   여기서도 지표가 아니라 **씬 파일의 정답지**와 패턴별로 대조한다.
      //
      // ⚠️ 다만 sample.zls 는 다섯 패턴이 **전부 흰색 [1,1,1]** 이다. 회색축이라
      //    채널을 어떻게 섞어도 값이 같아서, 채널 순서는 이 씬에서 **관측 불가**다
      //    (§5.7 의 "회전이 0이라 부분 전치가 안 보인다" 와 같은 구멍). §5.10 이
      //    그 구멍을 맡는다.
      {
        const tGround = performance.now();
        const ground = await readSceneMaterials(ZLS);
        const truth = ground?.byPattern ?? new Map<string, MaterialTruth>();
        const mats = pats.map((p) => p.material).filter((m) => m !== undefined);
        matAtRest = JSON.stringify(pats.map((p) => p.material));

        check(
          '★ 재질 정답지가 성립한다 — .zls 안의 materials·clothPatterns 블록을 이어 패턴→색 표를 세웠다',
          truth.size > 0,
          ground
            ? `패턴 ${truth.size}개 ← 머티리얼 ${ground.materialCount}개, 씬 사본 ${ground.copies}벌 (${ms(performance.now() - tGround)})`
            : '블록을 못 읽었다 — 이 씬이 STORED zip 이 아니거나 포맷이 바뀌었다',
        );
        // ⚠️ 실측: sample.zls 안에는 **서로 다른 uuid 대역 두 개**가 각각 두 번씩
        //    들어 있다(`566024…` / `1023457615…`). 값은 같지만 키가 겹치지 않아,
        //    "첫 블록" 을 정답지로 고르면 워커가 쓰는 대역이 아닐 수 있다. 그래서
        //    전부 합치고, 같은 패턴 uuid 가 두 값을 말하는 경우만 여기서 막는다.
        check(
          '★ 사본들이 같은 패턴에 같은 재질을 말한다 (여러 벌을 합쳐 정답지를 만든 근거)',
          ground?.copiesAgree === true,
          `clothPatterns 블록 ${ground?.copies ?? 0}벌 → 패턴 ${truth.size}개 (겹치는 uuid 에 다른 값이 있으면 실패)`,
        );

        check(
          '★ topology:true 의 모든 패턴에 material 이 실린다 (materials-a)',
          pats.length > 0 && mats.length === pats.length,
          `${mats.length}/${pats.length}개`,
        );
        check(
          '★★★ 패턴마다 색이 씬 정답지와 일치한다 — 패턴 uuid 로 짝지어 본다 (색을 뒤섞어 실으면 여기서 걸린다)',
          pats.length > 0 && pats.every((p) => {
            const t = truth.get(p.uuid);
            return t !== undefined && p.material !== undefined
              && colorKey(p.material.color) === colorKey(t.color);
          }),
          pats.map((p) => {
            const t = truth.get(p.uuid);
            return `${p.uuid.slice(-5)}:${p.material ? colorKey(p.material.color) : '없음'}${t ? '' : '(정답지에 없다)'}`;
          }).join(' '),
        );
        check(
          '★★ roughness·metalness·opacity 도 정답지와 같다 (색만 맞고 나머지가 밀리면 스냅샷과 재질이 갈린다)',
          pats.length > 0 && pats.every((p) => {
            const t = truth.get(p.uuid);
            const m = p.material;
            return t !== undefined && m !== undefined
              && Math.abs(m.roughness - t.roughness) < 1e-5
              && Math.abs(m.metalness - t.metalness) < 1e-5
              && Math.abs(m.opacity - t.alpha) < 1e-5;
          }),
          pats.map((p) => `r${p.material?.roughness}/m${p.material?.metalness}/a${p.material?.opacity}`).join(' '),
        );
        // ⚠️ roughness 는 두 씬에서 **값이 갈리는 유일한 스칼라**다
        //    (sample 0.3 / 위 §5.10 씬 1.0). 그래서 이 자리가 "스칼라 셋을
        //    서로 바꿔 실었는가" 를 실제로 가른다 — metalness·opacity 는 양쪽 다
        //    0·1 고정이라 자기들끼리는 못 가른다.
        note(
          '스칼라 정답지',
          [...truth.values()].slice(0, 1).map((t) => `roughness=${t.roughness}, metalness=${t.metalness}, alpha=${t.alpha}`).join('')
          || '없음',
        );

        check(
          '★★ colorProfile 이 씬의 값과 같다 (0=Linear / 1=SRGB — 틀리면 색이 조용히 어두워진다)',
          pats.length > 0 && pats.every((p) => {
            const t = truth.get(p.uuid);
            return t !== undefined && p.material?.colorProfile === (t.colorProfile === 0 ? 'linear' : 'srgb');
          }),
          `씬 ${[...new Set([...truth.values()].map((t) => t.colorProfile))].join(',')} → 워커 ${[...new Set(mats.map((m) => m.colorProfile))].join(',')}`,
        );

        check(
          '★★ fabricUuid 가 씬의 textures.assetUuid 와 같다 (그룹화의 키다 — 틀리면 직물 목록이 통째로 거짓이 된다)',
          pats.length > 0 && pats.every((p) => truth.get(p.uuid)?.fabricUuid === p.material?.fabricUuid),
          [...new Set(mats.map((m) => m.fabricUuid))].join(' '),
        );
        check(
          '★★ fabricUuid 가 패턴 uuid 와 하나도 겹치지 않는다 (패턴 uuid 를 그대로 실으면 그룹이 전부 1개짜리가 된다)',
          pats.length > 0 && pats.every((p) => p.material?.fabricUuid !== p.uuid),
          `패턴 ${pats[0]?.uuid} vs 직물 ${pats[0]?.material?.fabricUuid}`,
        );

        check(
          '★★ 색 채널이 0~1 범위다 (0~255 로 내면 여기서 걸린다 — three 는 1 초과를 잘라내서 화면은 흰색으로만 보인다)',
          mats.length > 0 && mats.every((m) => m.color.every((v) => v >= 0 && v <= 1)),
          mats.map((m) => `[${m.color.map((v) => v.toFixed(3)).join(',')}]`).join(' '),
        );

        // ── 세 필드가 서로 안 섞이는가 ───────────────────────
        //
        // 같은 패턴 객체에 `transform`(3D TRS 객체) · `transform2d`(숫자 9개) ·
        // `material`(객체) 셋이 앉았다. 한쪽 자리에 다른 쪽을 실으면 타입은
        // 통과하고 화면만 조용히 틀린다 (ISSUE-011 을 그대로 다시 겪는다).
        const one = pats[0];
        check(
          '★★ 세 필드가 각자 제 모양으로 온다 (TRS 객체 / 숫자 9개 / 재질 객체)',
          one?.transform !== undefined && Array.isArray(one.transform2d)
          && one.material !== undefined && !Array.isArray(one.material)
          && Array.isArray(one.material.color) && one.material.color.length === 3,
          `transform=${typeof one?.transform} / transform2d=${Array.isArray(one?.transform2d) ? `배열 ${one.transform2d.length}` : typeof one?.transform2d} / material=${Array.isArray(one?.material) ? '배열!' : typeof one?.material}`,
        );
        check(
          '★★★ material 이 transform2d 자리에 앉지 않았다 — 2D 배열 9개는 여전히 씬의 배치 행렬이다',
          pats.every((p) => {
            const t2 = p.transform2d;
            const c = p.material?.color;
            if (!t2 || !c) return false;
            // 색이 행렬 앞 세 자리로 새어 들어오지 않았는가
            return colorKey([t2[0], t2[1], t2[2]]) !== colorKey(c);
          }),
          pats.map((p) => `2D[${p.transform2d?.slice(0, 3).map((v) => v.toFixed(2)).join(',')}] vs 색[${p.material?.color.map((v) => v.toFixed(2)).join(',')}]`).join(' '),
        );
        check(
          '★★ 색이 3D translation 도 아니다 (transform 을 material 로 착각한 워커)',
          pats.every((p) => {
            const t3 = p.transform;
            const c = p.material?.color;
            return t3 !== undefined && c !== undefined && colorKey(t3.translation) !== colorKey(c);
          }),
          pats.map((p) => `3D[${p.transform?.translation.map((v) => v.toFixed(1)).join(',')}]`).join(' '),
        );

        // ── topology 게이팅 ────────────────────────────────
        check(
          '★★ 프레임 이벤트의 mesh 에는 material 키가 아예 없다 (topology:true 에만 실린다)',
          framePats.length > 0
          && framePats.every((p) => !('material' in (p as unknown as Record<string, unknown>))),
          `패턴 ${framePats.length}개 중 ${framePats.filter((p) => 'material' in (p as unknown as Record<string, unknown>)).length}개에 실렸다`,
        );
        check(
          '★ topology:false 응답에도 material 이 없다 (uvs·indices·transform2d 와 같은 갈래)',
          mdNoTopo.patterns.length > 0
          && mdNoTopo.patterns.every((p) => !('material' in (p as unknown as Record<string, unknown>))),
          `패턴 ${mdNoTopo.patterns.length}개`,
        );

        // ── ★ 게이팅의 근거가 살아 있는가 (미래를 지키는 자리) ──
        //
        // `material` 을 topology 안에 둔 근거는 "이 워커에 재질을 바꿀 op 이
        // 하나도 없다" 이다. 백로그의 `setFabric` 이 정확히 그 근거를 깬다 —
        // 그때 증상은 **원단을 바꿔도 색이 그대로**이고, 크래시도 에러도 없어서
        // "적용 버튼이 안 먹는다"로 보인다. UI 배선 문제로 오진하기 딱 좋다.
        //
        // 그 미래를 테스트로 지킬 방법은 "없는 것을 단언하는 것" 뿐이다. 워커가
        // `setFabric` 을 아직 모른다는 사실 자체를 못박아 두면, 그 op 이 생기는
        // 순간 이 줄이 **빨간불**이 되어 게이팅을 다시 보게 만든다. 값도 화면도
        // 아무것도 안 바뀌는 변경을 잡을 수 있는 유일한 자리다.
        {
          const probe = await session.worker
            .request('setFabric' as never, { patterns: [], fabricUuid: 'x' })
            .then(() => '성공해버렸다', (e: unknown) => (e instanceof Error ? e.message : String(e)));
          check(
            '★★★ 워커가 아직 setFabric 을 모른다 — 이 op 이 생기는 순간 material 의 topology 게이팅을 다시 봐야 한다',
            probe.includes('알 수 없는 op'),
            probe,
          );
        }
      }
    }

    // 시뮬을 더 돌린 뒤 다시 물어 본다. "한 세션 안에서 상수" 가 topology 안에
    // 둔 근거이고, 그게 깨지면 클라이언트는 최초 1회 값을 계속 써서 **입력이
    // 먹지 않는 것처럼** 보인다 (오차가 아니라 무반응이라 렌더 문제로 오진한다).
    {
      const target = session.worker.lastFrame + 5;
      await session.start();
      await session.waitForFrame(target, 120_000);
      await session.pause();
      const md2 = await session.meshData(true);
      check(
        '★★ 시뮬을 더 돌린 뒤에도 transform2d 가 한 글자도 안 바뀐다 (topology 에 둔 근거)',
        t2dAtRest !== null && JSON.stringify(md2.patterns.map((p) => p.transform2d)) === t2dAtRest,
        `frame ${session.worker.lastFrame} 까지 돌린 뒤 ${md2.patterns.length}개 비교`,
      );
      // 재질도 같은 근거로 topology 안에 있다. 다만 근거가 다르다 — 2D 배치는
      // "배치를 바꿀 op 이 없다", 재질은 "재질을 바꿀 op 이 없다"이고, 뒤쪽이
      // 백로그의 `setFabric` 때문에 **먼저 깨진다**(위 §5.9 의 마지막 단언 참고).
      check(
        '★★ 시뮬을 더 돌린 뒤에도 material 이 한 글자도 안 바뀐다 (topology 에 둔 근거)',
        matAtRest !== null && JSON.stringify(md2.patterns.map((p) => p.material)) === matAtRest,
        `frame ${session.worker.lastFrame} 까지 돌린 뒤 ${md2.patterns.length}개 비교`,
      );
    }

    // ── 5.8 회전이 있는 씬 (있으면) ───────────────────────
    //
    // sample.zls 는 서피스 회전이 전부 0이라 2×2 블록이 항등이다. 그 씬에서는
    // `m01`↔`m10` 을 맞바꿔도 **값이 문자 그대로 같아서** 어떤 단언도 못 잡는다.
    // 회전이 있는 씬이 하나라도 있으면 부분 전치가 관측 가능해지므로, 있으면
    // 여기서 태운다. 없으면 무엇을 못 덮었는지 화면에 남긴다.
    {
      const rotated = await findRotatedScene();
      if (!rotated) {
        note(
          '§5.8 생략',
          '회전이 0이 아닌 씬을 찾지 못했다 — m01↔m10 부분 전치는 이번 실행에서 미검증',
        );
      } else {
        const truthSet = new Set(rotated.truth.map((t) => matrixKey(matrixFromScene(t))));
        await session.clear();
        const tLoad = performance.now();
        await session.load(rotated.path);
        const pats = (await session.meshData(true)).patterns;
        const mats = pats.map((p) => p.transform2d).filter((m): m is PatternTransform2D => m !== undefined);
        const m = matchAgainstScene(mats, truthSet);

        note('§5.8 씬', `${rotated.path.split(/[\\/]/).pop()} — 패턴 ${pats.length}개, 로드 ${ms(performance.now() - tLoad)}`);
        check(
          '★ 이 씬에는 2×2 블록이 비대칭인 패턴이 있다 (아래 단언에 이빨이 있다는 전제)',
          m.spun > 0,
          `${m.spun}/${mats.length}개 — 0이면 부분 전치는 여기서도 관측 불가다`,
        );
        check(
          '★★★ 회전이 있는 씬에서도 워커의 행렬이 정답지와 전부 일치한다 (m01↔m10 을 맞바꾸면 여기서 걸린다)',
          mats.length > 0 && m.matched === mats.length,
          `${m.matched}/${mats.length}개 일치`,
        );
        check(
          '★★ 전치본은 하나도 짝이 안 지어진다',
          m.transposed === 0,
          `전치본 일치 ${m.transposed}개`,
        );

        const { local, drawing } = boxesOf(pats);
        const before = overlapOf(local);
        const after = overlapOf(drawing);
        check(
          '★★ 회전이 있는 씬에서도 겹침이 확연히 줄어든다',
          before.pct > 50 && after.pct < before.pct / 2 && after.density < before.density,
          `${before.pct.toFixed(1)}% → ${after.pct.toFixed(1)}%, 밀집도 ${before.density.toFixed(2)} → ${after.density.toFixed(2)}`,
        );
      }
    }

    // ── 5.10 색이 갈리는 씬 (있으면) ──────────────────────
    //
    // sample.zls 는 다섯 패턴이 **전부 흰색 [1,1,1]** 이다. 그 씬에서는
    //   ① 채널 순서를 RGB→BGR 로 바꿔도 값이 문자 그대로 같고,
    //   ② `fabricUuid` 그룹이 1개뿐이라 그룹화가 참인지 거짓인지 구분이 안 된다.
    // 둘 다 §5.9 가 못 잡는 구멍이고, 색이 갈리는 씬이 있어야 메워진다.
    // 그런 씬은 저장소에 없다(`backend/data/` 는 .gitignore). 있으면 태우고,
    // 없으면 **무엇을 못 덮었는지 화면에 남긴다.**
    {
      const multi = await findMultiColorScene();
      if (!multi) {
        note(
          '§5.10 생략',
          '색이 갈리는 씬을 찾지 못했다 — 채널 순서(RGB↔BGR)와 fabricUuid 그룹화는 이번 실행에서 미검증',
        );
      } else {
        const truth = multi.truth;
        const file = multi.path.split(/[\\/]/).pop() ?? multi.path;
        if (session.loadedPath !== multi.path) {
          await session.clear();
          await session.load(multi.path);
        }
        const pats = (await session.meshData(true)).patterns;
        const mats = pats.map((p) => p.material).filter((m) => m !== undefined);

        note('§5.10 씬', `${file} — 패턴 ${pats.length}개, 정답지 ${truth.size}개`);

        // 전제: 이 씬에서 채널 순서가 **관측 가능한가**. 회색축뿐이면 아래
        // 단언에 이빨이 없다 (§5.8 의 `spun > 0` 과 같은 자리다).
        const chromatic = [...truth.values()].filter(
          (t) => Math.abs(t.color[0] - t.color[1]) > 1e-3 || Math.abs(t.color[1] - t.color[2]) > 1e-3,
        ).length;
        check(
          '★ 이 씬에는 채널이 서로 다른 색이 있다 (아래 단언에 이빨이 있다는 전제)',
          chromatic > 0,
          `${chromatic}/${truth.size}개 — 0이면 채널 순서는 여기서도 관측 불가다`,
        );

        check(
          '★★★ 패턴마다 색이 정답지와 일치한다 (24개짜리 씬에서 하나만 어긋나도 걸린다)',
          pats.length > 0 && pats.every((p) => {
            const t = truth.get(p.uuid);
            return t !== undefined && p.material !== undefined
              && colorKey(p.material.color) === colorKey(t.color);
          }),
          `${pats.filter((p) => {
            const t = truth.get(p.uuid);
            return t && p.material && colorKey(p.material.color) === colorKey(t.color);
          }).length}/${pats.length}개 일치`,
        );
        // 위 단언이 **채널 순서를 실제로 가른다**는 증거. 같은 자로 BGR 사본을
        // 재서, 하나도 안 맞아야 한다 (§5.7 의 전치본 대조와 같은 논법).
        const bgrHits = pats.filter((p) => {
          const t = truth.get(p.uuid);
          const c = p.material?.color;
          if (!t || !c) return false;
          return colorKey([c[2], c[1], c[0]]) === colorKey(t.color);
        }).length;
        check(
          '★★★ 채널을 뒤집은(BGR) 사본은 정답지와 단 하나도 짝이 안 지어진다',
          bgrHits === 0,
          `BGR 일치 ${bgrHits}개 / 채널 비대칭 ${chromatic}개`,
        );

        // ── fabricUuid 그룹화가 거짓이 아닌가 ────────────────
        //
        // Builder 가 이 필드를 넣은 근거가 "진짜 N:1 축은 직물"이다. 그 근거가
        // 참이려면 **같은 직물이면 색도 같아야** 한다. 안 그러면 직물 목록 UI 가
        // 한 줄에 서로 다른 색을 묶어 보여주게 된다.
        const byFabric = new Map<string, Set<string>>();
        for (const p of pats) {
          if (!p.material) continue;
          const k = p.material.fabricUuid;
          if (!byFabric.has(k)) byFabric.set(k, new Set());
          byFabric.get(k)!.add(colorKey(p.material.color));
        }
        const truthFabrics = new Set([...truth.values()].map((t) => t.fabricUuid));
        check(
          '★★ fabricUuid 로 묶은 그룹 수가 정답지와 같다 (패턴 uuid 를 실으면 그룹이 패턴 수만큼 생긴다)',
          byFabric.size === truthFabrics.size && byFabric.size < pats.length,
          `워커 ${byFabric.size}종 / 씬 ${truthFabrics.size}종 (패턴 ${pats.length}개)`,
        );
        check(
          '★★★ 같은 fabricUuid 면 색이 정확히 같다 (아니면 그룹화가 거짓이다)',
          byFabric.size > 0 && [...byFabric.values()].every((s) => s.size === 1),
          [...byFabric.entries()].map(([f, s]) => `${f.slice(-9)}:색${s.size}종`).join(' '),
        );
        check(
          '★★ 그룹마다 패턴 수가 정답지와 같다 (어느 패턴에 어느 색인지가 맞아야 개수가 맞는다)',
          [...byFabric.keys()].every((f) => {
            const mine = pats.filter((p) => p.material?.fabricUuid === f).length;
            const want = [...truth.entries()].filter(([, t]) => t.fabricUuid === f).length;
            return mine === want && want > 0;
          }),
          [...byFabric.keys()].map((f) => `${f.slice(-9)}×${pats.filter((p) => p.material?.fabricUuid === f).length}`).join(' '),
        );

        // ── 밖에서 들고 온 못 (2026-08-07 조사) ──────────────
        //
        // 위 단언은 전부 **내 정답지 리더**를 믿는다. 리더가 틀리면 워커와 함께
        // 조용히 틀릴 수 있다. 그 순환을 끊으려면 리더와 무관한 출처가 하나
        // 필요하고, 그게 이 표다 — 조사 때 손으로 확인한 숫자다.
        const known = KNOWN_SCENES.find(
          (k) => k.name === file && k.bytes === statSync(multi.path).size,
        );
        if (!known) {
          note(
            '§5.10 절대값 생략',
            `${file} 은 알려진 씬이 아니다 — 리더와 독립된 대조는 이번 실행에서 미검증`,
          );
        } else {
          const tally = new Map<string, number>();
          for (const m of mats) {
            const k = m.color.map((v) => v.toFixed(7)).join(',');
            tally.set(k, (tally.get(k) ?? 0) + 1);
          }
          check(
            '★★★ 조사 때 손으로 확인한 색과 개수가 그대로다 (정답지 리더와 독립된 유일한 못)',
            pats.length === known.patterns
            && known.colors.every((c) => tally.get(c.rgb.map((v) => v.toFixed(7)).join(',')) === c.count)
            && tally.size === known.colors.length,
            known.colors.map((c) => `${c.label} 기대 ${c.count}개 / 실제 ${tally.get(c.rgb.map((v) => v.toFixed(7)).join(',')) ?? 0}개`).join(', ')
            + ` — 서로 다른 색 ${tally.size}종`,
          );
          note(
            '§5.10 실측 색',
            [...tally.entries()].map(([c, n]) => `[${c}]×${n}`).join(' '),
          );
        }
      }
    }

    // ── 5.11 아바타 액세서리 (신발·머리카락) ───────────────
    //
    // 액세서리는 몸 파트와 **같은 `parts` 배열에 섞여** 온다. 접근자만 다르고
    // (`GetRenderMeshs` vs `GetRenderAccessoryMeshes`) 포장은 완전히 같아서,
    // 여기서 재는 것은 "따로 왔는가" 가 아니라 **갈래를 가르는 필드가
    // 제대로 서 있는가**다.
    //
    // ★★ 이 단위에서 가장 조용한 결함은 **신발에 텍스처가 붙는 것**이다.
    //    엔진이 안 쓰는 슬롯에 기본값(`Default_Base_Color.png`)을 꽂아 두는데
    //    그 파일이 설치본에 없다. 붙여 보내면 게이트웨이가 "파일이 없습니다"
    //    로 거절하고 화면에 `⚠ 거절 1칸` 이 뜬다 — 기능은 멀쩡한데 경고만
    //    나는, 제일 나쁜 종류의 잡음이다. 실제로 밟았고 처음엔 엔진이 준
    //    값인 줄 알았다.
    {
      // ── 대조군. **항상 돈다** ─────────────────────────────
      //
      // sample.zls 는 zeta 인데 액세서리가 0개다 — 슬롯은 있고 아무것도 안
      // 걸친 상태라 `IsEnableMesh()` 가 전부 거른다. 즉 이 씬은 "액세서리
      // 경로가 돌면서 아무것도 안 싣는" 것을 보는 자리다. 그 경로가 통째로
      // 사라져도 아래 조건부 절은 씬이 없으면 안 도는데, 이건 언제나 돈다.
      if (session.loadedPath !== ZLS) {
        await session.clear();
        await session.load(ZLS);
      }
      const base = await session.avatarMesh(true, false);
      const baseParts = base.avatars.flatMap((a) => a.parts);
      const baseTextures = base.textures?.length ?? 0;

      check(
        '전제: sample.zls 의 아바타가 zeta 다 (액세서리 경로가 도는 씬이다)',
        base.avatars.length === 1 && base.avatars[0]?.subType === 'zeta' && baseParts.length > 0,
        `${base.avatars.length}개 · subType=${base.avatars[0]?.subType ?? '없음'} · 파트 ${baseParts.length}`,
      );
      // ★ 갈래를 가르는 필드가 몸 파트로 새면, 화면이 몸을 액세서리로 취급해
      //   양면 렌더링을 걸거나 종류별 처리를 태운다. 조용히 이상해지는 쪽이다.
      const leaked = baseParts.filter(
        (p) => p.accessory !== undefined || p.assetName !== undefined || p.doubleSided !== undefined,
      );
      check(
        '★★ 몸 파트는 액세서리 필드를 하나도 갖지 않는다 (`accessory` 가 갈래를 가른다)',
        leaked.length === 0,
        leaked.length === 0 ? `몸 ${baseParts.length}파트 전부 깨끗하다` : leaked.map((p) => p.name).join(', '),
      );
      check(
        '이 씬은 액세서리가 0개다 (슬롯은 있으나 아무것도 안 걸쳤다 — IsEnableMesh 가 거른다)',
        baseParts.every((p) => p.accessory === undefined),
        `파트 ${baseParts.length}개`,
      );

      // ── 실제 액세서리가 있는 씬 (있으면) ──────────────────
      const found = await findAccessoryScene(session);
      if (!found) {
        note(
          '§5.11 생략',
          '액세서리가 있는 씬을 찾지 못했다 — 종류 이름 · 텍스처 규칙 · 인덱스 · 양면은 이번 실행에서 미검증'
          + ` (뒤진 씬 ${accessoryScenesTried}개)`,
        );
      } else {
        const file = found.path.split(/[\\/]/).pop() ?? found.path;
        const parts = found.result.avatars.flatMap((a) => a.parts);
        const acc = parts.filter((p) => p.accessory !== undefined);
        const body = parts.filter((p) => p.accessory === undefined);
        note('§5.11 씬', `${file} — 몸 ${body.length}파트 · 액세서리 ${acc.length}개 [${acc.map((p) => p.accessory).join(', ')}]`);

        // 전제. 0개면 아래 단언이 전부 공짜로 통과한다.
        check('★ 전제: 이 씬에 액세서리가 실제로 있다 (아래 단언에 이빨이 있다)', acc.length > 0, `${acc.length}개`);

        const NAMES = ['underwearTop', 'underwearBottom', 'sock', 'shoes', 'hair', 'unknown'];
        check(
          '★★ 종류가 엔진의 이름으로 온다 (숫자가 아니다 — enum 값은 재배열되면 조용히 뜻이 바뀐다)',
          acc.every((p) => NAMES.includes(p.accessory ?? '')),
          acc.map((p) => p.accessory).join(', '),
        );
        check(
          '`unknown` 이 없다 (엔진이 종류를 늘렸으면 이름 표를 따라가야 한다)',
          acc.every((p) => p.accessory !== 'unknown'),
          acc.map((p) => `${p.name}=${p.accessory ?? ''}`).join(', '),
        );

        // ★★★ 이 절의 핵심.
        const hair = acc.filter((p) => p.accessory === 'hair');
        const notHair = acc.filter((p) => p.accessory !== 'hair');
        const texturedNotHair = notHair.filter((p) => p.material?.textures !== undefined);
        check(
          '★★★ 머리카락이 아닌 액세서리에는 텍스처가 없다 (엔진의 기본값은 없는 파일을 가리킨다)',
          texturedNotHair.length === 0,
          texturedNotHair.length === 0
            ? `${notHair.length}개 확인 (${notHair.map((p) => p.accessory).join(', ')})`
            : texturedNotHair.map((p) => `${p.name}: ${JSON.stringify(p.material?.textures)}`).join(' / '),
        );
        // 대조군 둘. 위 단언은 **머티리얼 자체가 안 왔어도** 통과한다 —
        // 색까지 사라진 회귀가 초록으로 보이면 안 된다.
        check(
          '★ 대조군: 그래도 머티리얼(색)은 온다 (텍스처만 없는 것이지 재질이 없는 것이 아니다)',
          acc.every((p) => p.material !== undefined),
          acc.map((p) => `${p.accessory ?? ''}:${p.material === undefined ? '없음' : '있음'}`).join(' '),
        );
        check(
          '★★ 그래서 텍스처 표가 몸만 쓰던 것과 같은 크기다 (액세서리가 표를 늘리지 않았다)',
          hair.length > 0 || (found.result.textures?.length ?? 0) === baseTextures,
          `이 씬 ${found.result.textures?.length ?? 0}칸 · 대조군 ${baseTextures}칸`
          + (hair.length > 0 ? ' (머리카락이 있어 늘어날 수 있다 — 판정 제외)' : ''),
        );

        // ⚠️ **연속이라고 단언하지 않는다.** 비활성 슬롯도 번호를 먹어서
        //    실측으로 몸 12파트(0–11) 다음의 신발이 **29번**이었다. 연속을
        //    기대하는 테스트를 쓰면 씬을 바꾸는 순간 빨개진다.
        const maxBody = Math.max(...body.map((p) => p.index));
        check(
          '★ 액세서리 인덱스가 몸 뒤에 오고 서로 겹치지 않는다 (연속은 아니다 — 빈 슬롯도 번호를 먹는다)',
          acc.every((p) => p.index > maxBody)
          && new Set(parts.map((p) => p.index)).size === parts.length,
          `몸 최대 ${maxBody} · 액세서리 [${acc.map((p) => p.index).join(', ')}]`,
        );

        check(
          '양면으로 온다 (데스크톱의 `enableTwoSided` 를 옮긴 값이다)',
          acc.every((p) => p.doubleSided === true),
          acc.map((p) => `${p.accessory ?? ''}:${String(p.doubleSided)}`).join(' '),
        );
        check(
          '에셋 이름이 실려 있다 (워커 로그·데스크톱과 대조할 유일한 이름이다)',
          acc.every((p) => typeof p.assetName === 'string' && p.assetName !== ''),
          acc.map((p) => p.assetName ?? '(없음)').join(', '),
        );

        // ★ 몸과 **같은 포장**을 쓴다는 것이 이 구현의 요점이다. 갈라 두면
        //   쓰레기 정점 AABB 규칙이나 법선 규약을 한쪽에만 고치는 사고가 난다.
        check(
          '★★ 액세서리도 몸과 같은 포장이다 (positions · indices · uvs 가 다 있다)',
          acc.every((p) => typeof p.positions === 'string' && p.positions !== ''
            && typeof p.indices === 'string' && p.indices !== ''
            && typeof p.uvs === 'string' && p.uvs !== ''
            && p.vertices > 0 && p.triangles > 0),
          acc.map((p) => `${p.accessory ?? ''} v=${p.vertices} t=${p.triangles}`).join(' · '),
        );

        // `vertices` 가 요청값의 메아리가 아니라 **실제로 실은 값**인지.
        for (const av of found.result.avatars) {
          const sum = av.parts.reduce((s, p) => s + p.vertices, 0);
          check(
            '아바타의 정점 합계가 파트 합과 같다 (액세서리를 더하고 합계를 안 고치는 사고가 흔하다)',
            av.vertices === sum,
            `${av.vertices} === ${sum}`,
          );
        }
      }
    }

    // ── 6. 세션 재사용 ────────────────────────────────────
    await session.clear();
    check('clear', session.loadedPath === null);

    await session.load(ZLS);
    const st = await session.status();
    check('같은 프로세스에서 재로드', st.loaded === true);

    const pid = session.worker.pid;
    await pool.release(session);

    t = performance.now();
    const reused = await pool.acquire();
    const reuseMs = performance.now() - t;
    check(
      '유휴 프로세스 재사용',
      reused.worker.pid === pid,
      `pid ${pid} 재사용, ${ms(reuseMs)}`,
    );
    await pool.release(reused);
  } finally {
    await pool.close();
  }

  console.log(
    failures === 0
      ? '\n전부 통과\n'
      : `\n${failures}건 실패\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('\n스모크 테스트 중 예외:', err);
  process.exit(1);
});
