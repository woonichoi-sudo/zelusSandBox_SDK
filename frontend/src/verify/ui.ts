/**
 * UI 검증 하네스 — **브라우저를 실제로 띄워 화면을 판정한다** (Playwright).
 *
 *   npm run verify:ui        # frontend/ 에서. 게이트웨이와 Vite 가 떠 있어야 한다
 *
 * ── 이 파일이 존재하는 이유 ──────────────────────────────────
 * `src/protocol/smoke.ts` 는 DOM 도 WebGL 도 없는 Node 에서 돈다. 그래서 이
 * 프로젝트에서 **화면으로만 드러나는 것들**을 구조적으로 못 본다:
 *
 *   - `Viewer3D.frameCamera()` / `WebGLRenderer` — 스모크 §8 이 스텁으로 대신한다
 *   - 배타 모드(실시간 ↔ 스냅샷) — `visible` 두 개가 **화면에서** 어떻게 보이는가
 *   - 임베드 텍스처가 **실제 픽셀**이 되는가 — glTF 를 파싱했다는 것과
 *     그 색이 화면에 나온다는 것은 다른 명제다
 *   - `main.ts` 전체 — DOM 을 잡고 있어서 스모크가 import 조차 못 한다
 *     (ISSUE-009 가 "자동 테스트가 덮지 않는다"고 적은 그 층이다)
 *
 * 지금까지 이것들은 사람이 브라우저를 눌러 확인했고, **실제로 그 확인에서만
 * 나온 발견이 많다** — 옷이 움직인다는 것, 시뮬을 돌려야 옷이 입혀진다는 것,
 * ISSUE-009·010·011. 이 파일은 그 수동 절차를 그대로 옮긴 것이고, 사람이 하던
 * 판정 중 **기계가 대신 할 수 있는 부분만** 가져왔다.
 *
 * ── 제품 코드를 한 줄도 건드리지 않는다 ─────────────────────
 * 화면 상태를 읽는 창구는 `main.ts` 끝의 `globalThis.cobalt` 하나이고, 그것으로
 * 충분했다. 뷰어·스트림·스냅샷 로더가 전부 거기 걸려 있어서 브라우저 안에서
 * 직접 물어볼 수 있다. **검증을 위해 제품 코드에 훅을 추가한 것이 없다.**
 *
 * ── 스타일은 스모크와 같다 ──────────────────────────────────
 * 프레임워크 없음. `check(label, ok, detail?)` 로 세고, 실패가 있으면 exit 1.
 * 아래 하네스 6개(`check`/`note`/`section`/`ms`/`sleep`/`messageOf`)는
 * `protocol/smoke.ts` 의 것과 같은 코드다. **공유하지 않고 복사했다** — 그쪽은
 * export 하지 않는 모듈 스코프 함수이고, 공유하려면 `protocol/` 안의 파일을
 * 고쳐야 하는데 그건 이 작업의 범위 밖이다. 30줄을 베끼는 편이 검증 도구를
 * 위해 제품 디렉토리를 건드리는 것보다 싸다.
 *
 * ── 세 가지 판단 ────────────────────────────────────────────
 *
 * ① **서버는 띄우지 않는다. 떠 있다고 전제하고, 없으면 원인을 지목한다.**
 *    스모크들은 자기가 게이트웨이를 띄운다. 여기서는 그러지 않는다:
 *      - 이 하네스가 검증하는 대상이 **개발자가 실제로 보는 그 화면**이다.
 *        띄우는 순간 Vite 설정·프록시·워커 기동까지 하네스의 책임이 되고,
 *        게이트웨이가 못 뜬 것이 "UI 실패"로 보고된다.
 *      - ISSUE-007 (서버 스모크가 Windows 에서 간헐적으로 프로세스째 죽는다)
 *        이 아직 열려 있다. 그 불안정을 UI 판정으로 끌어들일 이유가 없다.
 *    대신 `preflight()` 가 **세 가지를 갈라서** 말한다 — Vite 가 없는가,
 *    게이트웨이가 없는가, 씬이 없는가. 그냥 죽으면 브라우저 안에서
 *    60초 타임아웃으로 나타나고 원인이 안 보인다.
 *
 * ② **단언은 관계와 범위로만 한다.** 화면은 씬·GPU·타이밍에 따라 달라진다.
 *    "정점이 3,022개다", "노랑이 14,315px 이다" 같은 단언은 씬을 바꾸는 순간
 *    깨지고, 그러면 아무도 이 하네스를 안 믿게 된다. 그래서 값 자체는 `note`
 *    로 **찍기만** 하고, 단언은 관계로 한다: 옷이 원점 위에 있는가, 스냅샷의
 *    지배색이 실시간에는 없는 색인가, 재개했을 때 프레임이 **이어지는가**.
 *
 * ── 첫 실행이 잡아낸 것 ─────────────────────────────────────
 * 처음 돌렸을 때 64건 중 2건이 빨간불이었고, **둘 다 제품 버그가 아니었다.**
 * 그래도 둘 다 알 가치가 있어 근거와 함께 남겨 뒀다:
 *
 *   ① 익스포트 다운로드가 매번 `net::ERR_ABORTED` 를 남긴다. 바이트는 전부
 *      도착한다 — `downloadExport` 가 진행률 때문에 `getReader()` 경로를 타서
 *      생기는 기록상의 흔적이다(`isIgnorableNetFailure` 주석에 실험 결과).
 *      기능은 멀쩡하지만 개발자 도구 Network 탭에서는 실패로 보인다.
 *   ② 스냅샷에서 실시간으로 되돌아오면 **카메라가 스냅샷 화각 그대로다**
 *      (`main.ts:326` 의 의도된 동작). 처음 짠 판정이 그걸 모르고 §6 의 화면과
 *      픽셀을 맞대다가 깨졌다 — §7 에 경위를 적고 화각에 무관한 판정으로 바꿨다.
 *
 * ③ **열려 있는 이슈의 현재 동작을 단언으로 박지 않는다.** ISSUE-009(재생
 *    상태 어긋남)·010(로그 홍수)은 아직 안 고쳤다. 지금 동작을 못으로 박으면
 *    고치는 날 이 하네스가 빨간불이 되고, 고친 사람이 "회귀인가?" 를 먼저
 *    의심하게 된다. 둘 다 `note` 로 남긴다 — §9 참고.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright';

// ── 설정 ────────────────────────────────────────────────────

const HERE = import.meta.dirname;
const FRONTEND = path.resolve(HERE, '..', '..');

/** 브라우저가 볼 주소. **Vite 개발 서버**다 — `/api`·`/ws` 는 그쪽이 프록시한다 */
const BASE = process.env['VERIFY_UI_BASE'] ?? 'http://127.0.0.1:5173';

/**
 * 스크린샷이 쌓이는 곳. `.gitignore` 에 `frontend/verify-out/` 을 넣어 뒀다.
 * 실행마다 통째로 지우고 다시 만든다 — 지난 실행의 그림이 남아 있으면
 * "실패한 그 화면"을 열었다고 믿으면서 다른 걸 보게 된다.
 */
const OUT = process.env['VERIFY_UI_OUT'] ?? path.resolve(FRONTEND, 'verify-out');

/** 눈으로 보고 싶을 때: `VERIFY_UI_HEADED=1 npm run verify:ui` */
const HEADED = process.env['VERIFY_UI_HEADED'] === '1';

/**
 * ⚠️ `channel: 'chrome'` 은 선택이 아니다.
 *
 * 이 환경에 설치된 playwright 패키지(1.62.1)가 요구하는 번들 chromium 리비전과
 * 실제로 받아져 있는 것이 다르다(설치본 1148 vs 요구 1234). 시스템 Chrome 을
 * 쓰면 다운로드가 아예 필요 없고, **사용자가 실제로 보는 브라우저와 같다.**
 * 헤드리스에서도 진짜 GPU 를 탄다(실측: ANGLE / NVIDIA GeForce RTX 3070 / D3D11).
 */
const CHANNEL = 'chrome';

const VIEWPORT = { width: 1280, height: 800 } as const;

/** 씬 로드가 끝날 때까지. 103~144MB 라 첫 로드가 느리다 */
const LOAD_TIMEOUT = 90_000;
/** 익스포트 4.5초 + 다운로드 + 36.5MB 파싱 0.8초. 넉넉하게 준다 */
const SNAPSHOT_TIMEOUT = 180_000;

// ── 하네스 (protocol/smoke.ts 와 같은 코드) ─────────────────

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = ''): void {
  checks++;
  console.log(`${ok ? '  OK ' : '  실패'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** 판정에 넣지 않는 진단. 기준 밖이지만 알아둘 값을 남긴다 */
function note(label: string, detail: string): void {
  console.log(`  ..    ${label}  — ${detail}`);
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

function ms(t: number): string {
  return `${Math.round(t)}ms`;
}

function sleep(msec: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, msec);
    t.unref?.();
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── 스크린샷 + 픽셀 검사 ────────────────────────────────────
//
// ⚠️ `gl.readPixels()` 로 화면을 검사하면 **항상 0 이 나온다.** `Viewer3D` 는
//    `preserveDrawingBuffer` 를 켜지 않으므로(켤 이유도 없다 — 성능 손해다)
//    프레임을 표시한 직후 백버퍼가 비어 있다. 그래서 화면을 보는 유일한 길은
//    `page.screenshot()` 이 준 **PNG 를 여는 것**이다.
//
// PNG 를 여는 데 새 의존성을 들이지 않는다. 브라우저가 이미 PNG 디코더이므로
// 바이트를 페이지로 돌려보내 `createImageBitmap` → `OffscreenCanvas` →
// `getImageData` 로 읽는다. 2D 캔버스라 WebGL 백버퍼 문제와 무관하다.

/** 색상환을 10°씩 36칸. 지배색을 "같은 색인가" 수준에서 비교하기 위한 해상도다 */
const HUE_BUCKETS = 36;

interface ScreenColors {
  width: number;
  height: number;
  /** 전체 픽셀 수 */
  total: number;
  /** 채도·명도가 충분해 "색"이라 부를 수 있는 픽셀 수 */
  saturated: number;
  /** 배경(#1b1e24)보다 밝은 픽셀 수. 화면이 통째로 검은지 본다 */
  bright: number;
  /** 10° 칸별 픽셀 수 */
  buckets: number[];
  /** 가장 많은 칸의 인덱스 */
  dominant: number;
  /**
   * **옅은 색**만 따로 센 10° 칸. 채도가 `PALE_MIN`~`SAT_MIN` 사이인 픽셀이다.
   *
   * 이게 왜 필요한가 — 위 `buckets` 는 회색(격자·배경·UI)을 걸러내려고 채도
   * 0.22 를 문턱으로 쓴다. 그런데 이 씬의 민트는 basecolor 채도가 **0.173**
   * 이고(=(0.886−0.733)/0.886), 조명이 흰색을 더하면 화면에서 0.09 까지
   * 내려간다. 즉 **민트는 그 문턱을 구조적으로 통과할 수 없다** — 실제로
   * 처음 짠 민트 판정이 0px 으로 빨간불이 났고, 원인이 이것이었다.
   *
   * 문턱을 낮추는 대신 띠를 하나 더 두는 이유는, 옅은 것과 진한 것을 **갈라
   * 놓는 것 자체가 판정력**이기 때문이다. 실시간 팔레트의 민트빛
   * (`0x8fc9a0`)은 채도 0.289 로 진하다. 그래서 "색조는 민트인데 옅다" 는
   * 조합은 팔레트가 만들 수 없고, 파일에서 온 색만 만족한다.
   */
  pale: number[];
  /** 옅은 픽셀 총수 */
  paleTotal: number;
}

interface Shot {
  file: string;
  colors: ScreenColors;
}

/** 10° 칸 인덱스 → 사람이 읽는 색 이름. 판정이 아니라 출력용이다 */
function hueName(bucket: number): string {
  const h = bucket * 10 + 5;
  if (h < 15) return '빨강';
  if (h < 45) return '주황';
  if (h < 70) return '노랑';
  if (h < 100) return '연두';
  if (h < 140) return '초록';
  if (h < 175) return '민트';
  if (h < 200) return '청록';
  if (h < 255) return '파랑';
  if (h < 290) return '보라';
  if (h < 345) return '자주';
  return '빨강';
}

function describe(c: ScreenColors): string {
  const top = c.buckets[c.dominant] ?? 0;
  return (
    `지배색 ${hueName(c.dominant)}(${c.dominant * 10}~${c.dominant * 10 + 10}°) ${top.toLocaleString('ko-KR')}px`
    + ` · 유채색 ${(c.saturated / c.total * 100).toFixed(1)}%`
    + ` · 옅은색 ${(c.paleTotal / c.total * 100).toFixed(1)}%`
    + ` · 밝은 픽셀 ${(c.bright / c.total * 100).toFixed(1)}%`
  );
}

const shots: string[] = [];

/** 화면을 찍어 파일로 남기고, 그 PNG 의 색 분포를 돌려준다 */
async function shot(page: Page, label: string): Promise<Shot> {
  const file = path.join(OUT, `${String(shots.length + 1).padStart(2, '0')}-${label}.png`);
  const png = await page.screenshot();
  await writeFile(file, png);
  shots.push(file);

  const colors = await page.evaluate(async (b64: string): Promise<ScreenColors> => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D 컨텍스트를 못 얻었습니다');
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;

    // 회색(격자·배경·UI)을 걸러내는 채도 문턱. 이 위는 "진한 색"이다.
    const SAT_MIN = 0.22;
    // 그 아래로 여기까지가 "옅은 색". 더 내리면 안티에일리어싱으로 생긴
    // 회색 언저리가 색조를 갖게 되어 띠가 오염된다(실측: 0.06 에서 멎는다).
    const PALE_MIN = 0.06;

    const buckets = new Array<number>(36).fill(0);
    const pale = new Array<number>(36).fill(0);
    let total = 0;
    let saturated = 0;
    let paleTotal = 0;
    let bright = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = (d[i] ?? 0) / 255;
      const g = (d[i + 1] ?? 0) / 255;
      const b = (d[i + 2] ?? 0) / 255;
      total++;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const s = mx === 0 ? 0 : (mx - mn) / mx;
      // 배경 #1b1e24 는 v≈0.14 다. 그보다 확실히 위만 "밝다"로 센다.
      if (mx > 0.18) bright++;
      // 배경보다 어두운 것은 색조를 따질 값이 없다. 밝기 문턱은 둘이 공유한다.
      if (mx < 0.22 || s < PALE_MIN) continue;
      let h: number;
      if (mx === mn) h = 0;
      else if (mx === r) h = 60 * (((g - b) / (mx - mn)) % 6);
      else if (mx === g) h = 60 * ((b - r) / (mx - mn) + 2);
      else h = 60 * ((r - g) / (mx - mn) + 4);
      if (h < 0) h += 360;
      const k = Math.min(35, Math.floor(h / 10));
      if (s >= SAT_MIN) {
        saturated++;
        buckets[k] = (buckets[k] ?? 0) + 1;
      } else {
        paleTotal++;
        pale[k] = (pale[k] ?? 0) + 1;
      }
    }
    let dominant = 0;
    for (let k = 1; k < buckets.length; k++) {
      if ((buckets[k] ?? 0) > (buckets[dominant] ?? 0)) dominant = k;
    }
    return {
      width: bmp.width, height: bmp.height,
      total, saturated, bright, buckets, dominant, pale, paleTotal,
    };
  }, png.toString('base64'));

  return { file, colors };
}

function bucketOf(c: ScreenColors, k: number): number {
  return c.buckets[k] ?? 0;
}

/** 10° 칸 `[from, to]` 을 합친다. 조명이 색조를 한두 칸 밀기 때문에 띠로 본다 */
function band(buckets: number[], from: number, to: number): number {
  let n = 0;
  for (let k = from; k <= to; k++) n += buckets[k] ?? 0;
  return n;
}

/**
 * 실시간 옷의 디버그 팔레트(`viewer3d/cloth.ts` 의 `PALETTE`)가 차지하는 10° 칸.
 *
 * 이 값들이 필요한 이유는 §6 의 "진짜 색" 판정 때문이다. 스냅샷 화면에서 민트나
 * 노랑을 찾을 때, **그 색이 팔레트로도 만들어질 수 있으면 아무것도 증명하지
 * 못한다.** 그래서 팔레트의 색조를 미리 계산해 두고 겹치지 않는 것을 확인한다:
 *
 *   0xd8a87e → 28.0°  (칸 2, 주황)
 *   0x8fc9a0 → 137.4° (칸 13, 연두빛 민트)  ← 진짜 민트(152.5°)와 가장 가깝다
 *   0x7ea8d8 → 212.0° (칸 21, 파랑)
 *   0xb0a8d8 → 249.9° (칸 24, 보라)
 *   0xc98f9e → 344.4° (칸 34, 자주)
 *
 * 팔레트에 노랑(30~70°)은 아예 없고, 민트도 137°라 아래 민트 띠(150~180°)와
 * 겹치지 않는다. 게다가 배타 모드 때문에 스냅샷 화면에는 옷 그룹이 아예 그려
 * 지지 않는다(§7) — 두 겹으로 오염이 막혀 있다.
 */
const LIVE_PALETTE_BUCKETS = [2, 13, 21, 24, 34] as const;

/**
 * 실측 basecolor 를 색조 칸으로 옮긴 것. **이 값이 이 파일에서 유일하게 씬을
 * 아는 상수라, 씬 이름이 맞을 때만 쓴다** (§6 의 `KNOWN_SCENE`).
 *
 *   민트 [0.733, 0.886, 0.816] → 152.5° → 칸 15
 *   노랑 [0.925, 0.812, 0.471] →  45.1° → 칸 4
 *
 * ── 왜 칸 하나가 아니라 띠인가 ──────────────────────────────
 * 화면 픽셀은 basecolor 가 아니라 `basecolor × 조명` 이다. 조명이 세 채널을
 * **같은 비율로** 곱하면 색조는 그대로지만, 스페큘러가 흰색을 더하는 만큼
 * 채도가 내려가면서 색조가 한두 칸 흔들린다(실측: 노랑이 칸 4 가 아니라 칸 5
 * 로 나왔다). 그래서 정확히 일치를 요구하지 않고 ±2 칸 띠로 본다. 띠를 넓혀도
 * 위 팔레트 칸과는 여전히 겹치지 않으므로 판정력이 죽지 않는다.
 *
 * ── 민트는 `pale` 쪽에서 센다 ───────────────────────────────
 * 민트의 basecolor 채도는 0.173 이라 회색 걸름 문턱(0.22)을 **원리상 넘지
 * 못한다.** 그래서 색조는 민트 띠인데 채도는 옅은 픽셀(`ScreenColors.pale`)을
 * 센다. 이 조합이 판정의 핵심이다 — 팔레트의 민트빛 `0x8fc9a0` 은 채도 0.289
 * 라 **진한 쪽**에 들어가므로 이 띠를 채울 수 없다. 실측이 그대로 보여준다:
 *
 *              민트 띠(진한)   민트 띠(옅은)
 *   실시간          3,116px          198px   ← 팔레트. 진한 쪽에 몰린다
 *   스냅샷              0px        2,564px   ← 파일의 민트. 옅은 쪽에만 있다
 *
 * 노랑(basecolor 채도 0.491)은 문턱을 넉넉히 넘으므로 진한 쪽에서 그대로 센다.
 */
const MINT_BAND = [14, 17] as const; // 140~180°
const YELLOW_BAND = [3, 6] as const; // 30~70°

// ── 브라우저 안에서 읽는 상태 ───────────────────────────────
//
// 전부 `globalThis.cobalt` 를 지난다. 이 창구가 사라지면 아래가 통째로 죽으므로
// §1 이 맨 먼저 그 존재를 확인한다.

interface Snapshotish {
  patterns: number;
  vertices: number;
  triangles: number;
  renders: number;
  mode: string;
  clothVisible: boolean;
  snapVisible: boolean;
  clothBox: { min: number[]; max: number[]; empty: boolean };
  snapBox: { min: number[]; max: number[]; empty: boolean };
  /** 패턴별 position 어트리뷰트의 version. 프레임이 실제로 붙으면 오른다 */
  versions: number[];
  camera: number[];
  tickError: string | null;
  statText: string;
  statusText: string;
  snapstatText: string;
  playText: string;
  modeHidden: boolean;
}

/** 화면 상태 한 벌. 한 번의 evaluate 로 모아 온다 — 왕복마다 시점이 어긋나지 않게 */
function readState(page: Page): Promise<Snapshotish> {
  return page.evaluate((): Snapshotish => {
    const c = globalThis.cobalt;
    const v = c.viewer;
    const cb = v.cloth.boundingBox();
    const sb = v.snapshot.boundingBox();
    const text = (id: string): string => document.getElementById(id)?.textContent ?? '';
    return {
      patterns: v.cloth.patternCount,
      vertices: v.cloth.vertexCount,
      triangles: v.cloth.triangleCount,
      renders: v.renders,
      mode: v.mode,
      clothVisible: v.cloth.group.visible,
      snapVisible: v.snapshot.group.visible,
      clothBox: { min: cb.min.toArray(), max: cb.max.toArray(), empty: cb.isEmpty() },
      snapBox: { min: sb.min.toArray(), max: sb.max.toArray(), empty: sb.isEmpty() },
      versions: v.cloth.patterns.map((p) => p.position.version),
      camera: v.camera.position.toArray(),
      tickError: v.lastTickError ? v.lastTickError.message : null,
      statText: text('stat'),
      statusText: text('status'),
      snapstatText: text('snapstat'),
      playText: text('play'),
      modeHidden: (document.getElementById('mode') as HTMLButtonElement | null)?.hidden ?? true,
    };
  });
}

interface StreamStats {
  received: number;
  withMesh: number;
  dropped: number;
  applied: number;
  mismatched: number;
  failed: number;
  lastApplied: number | null;
  stalled: boolean;
  fps: number;
}

function readStats(page: Page): Promise<StreamStats> {
  return page.evaluate((): StreamStats => {
    const s = globalThis.cobalt.stats;
    return {
      received: s.received,
      withMesh: s.withMesh,
      dropped: s.dropped,
      applied: s.applied,
      mismatched: s.mismatched,
      failed: s.failed,
      lastApplied: s.lastApplied,
      stalled: s.stalled,
      fps: s.fps,
    };
  });
}

function fmt(n: number): string {
  return n.toLocaleString('ko-KR');
}

function xyz(v: number[]): string {
  return `[${v.map((n) => n.toFixed(2)).join(', ')}]`;
}

/** 조건이 참이 될 때까지 브라우저에 되묻는다. 시간이 다하면 false */
async function untilPage(
  page: Page,
  pred: () => boolean,
  timeoutMs = 10_000,
): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(pred)) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(100);
  }
}

/**
 * 재생 상태를 **원하는 값으로 만든다.** `#play` 는 토글이라 그냥 누르면 안 된다.
 *
 * 실측으로 앱이 스스로 멎은 실행이 있었다(§3 에서 19프레임까지 흐른 뒤 2초 만에
 * fps 0 · 버튼 "재생"). 그 다음부터 모든 절이 **반대 위상**으로 돌아, 원인과
 * 아무 상관 없는 실패가 §5·§7 에 줄줄이 났다. 상태를 읽고 필요할 때만 누르면
 * 그 전파가 끊긴다 — 진짜 이상은 그것을 처음 본 절 하나에만 남는다.
 */
async function ensurePlaying(page: Page, want: boolean): Promise<boolean> {
  const now = await page.evaluate(
    () => (document.getElementById('play')?.textContent ?? '').includes('정지'),
  );
  if (now !== want) await page.click('#play');
  return want
    ? await untilPage(
        page,
        () => (document.getElementById('play')?.textContent ?? '').includes('정지'),
        10_000,
      )
    : await untilPage(
        page,
        () => (document.getElementById('play')?.textContent ?? '').includes('재생'),
        10_000,
      );
}

// ── 콘솔 / 네트워크 수집 ────────────────────────────────────
//
// **무시하는 것은 파비콘 404 하나뿐이고, 근거는 이렇다:** 브라우저가 문서를
// 열 때 자동으로 `GET /favicon.ico` 를 보낸다. `index.html` 에 아이콘 선언이
// 없고 Vite 의 `public/` 에도 파일이 없으니 개발 서버가 404 를 준다. 요청을
// 만든 것은 우리 코드가 아니고, 실패해도 앱의 어떤 경로도 지나지 않는다.
// **이 한 건 말고는 무시 목록이 없다** — 목록이 늘기 시작하면 §8 이 의미를
// 잃으므로, 새 항목을 넣으려면 여기에 같은 수준의 근거를 함께 적을 것.
function isIgnorableConsoleError(text: string, url: string): boolean {
  return url.endsWith('/favicon.ico') && text.includes('404');
}

/**
 * 익스포트 다운로드가 남기는 `net::ERR_ABORTED` — **실패가 아니다.**
 *
 * 이 하네스가 처음 돌았을 때 §8 이 이걸로 빨간불이 됐다. 실험으로 정체를
 * 좁혔다(같은 페이지에서 같은 URL 을 두 방식으로 받아 이벤트를 비교):
 *
 *   res.arrayBuffer()          36,639,537 바이트 → response 200 · requestfinished
 *   res.body.getReader() 루프   36,639,537 바이트 → response 200 · **ERR_ABORTED**
 *
 * 바이트 수가 정확히 같고, 그 본문으로 glTF 파싱이 메시 139개까지 성공한다
 * (§6 이 그걸 단언한다). 즉 **데이터는 전부 도착했고**, 크로뮴이 본문을 리더로
 * 끝까지 읽은 요청을 기록상 '취소됨' 으로 남기는 것뿐이다. `downloadExport`
 * (`protocol/http.ts:187`)가 진행률을 세려고 리더 경로를 타기 때문에 익스포트
 * 다운로드마다 반드시 하나씩 생긴다.
 *
 * **그래서 이걸 무시해도 검증에 구멍이 나지 않는다** — 다운로드가 진짜로 끊기면
 * 파싱이 실패하고 §6 의 `스냅샷이 완성된다` 가 먼저 빨간불이 된다. 이 규칙은
 * 익스포트 URL 의 ERR_ABORTED 하나로 좁혀져 있고, 다른 요청의 실패는 그대로
 * 판정에 들어간다.
 */
function isIgnorableNetFailure(url: string, reason: string): boolean {
  return url.includes('/api/exports/') && reason.includes('ERR_ABORTED');
}

interface Collected {
  errors: { text: string; url: string }[];
  ignored: { text: string; url: string }[];
  pageErrors: string[];
  httpErrors: { url: string; status: number }[];
  netFailures: { url: string; reason: string }[];
  ignoredNet: { url: string; reason: string }[];
}

function collect(page: Page): Collected {
  const c: Collected = {
    errors: [], ignored: [], pageErrors: [], httpErrors: [], netFailures: [], ignoredNet: [],
  };
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() !== 'error') return;
    const entry = { text: m.text(), url: m.location().url };
    if (isIgnorableConsoleError(entry.text, entry.url)) c.ignored.push(entry);
    else c.errors.push(entry);
  });
  page.on('pageerror', (e) => c.pageErrors.push(String(e)));
  page.on('response', (r) => {
    if (r.status() < 400) return;
    if (r.url().endsWith('/favicon.ico')) return;
    c.httpErrors.push({ url: r.url(), status: r.status() });
  });
  page.on('requestfailed', (r) => {
    const entry = { url: r.url(), reason: r.failure()?.errorText ?? '?' };
    if (isIgnorableNetFailure(entry.url, entry.reason)) c.ignoredNet.push(entry);
    else c.netFailures.push(entry);
  });
  return c;
}

// ── 사전 점검 ───────────────────────────────────────────────
//
// 판단 ①의 뒷감당이 전부 여기 있다. 이게 없으면 서버가 안 떠 있을 때
// 브라우저 안에서 `waitForFunction` 이 90초를 기다리다 죽고, 출력에는
// "타임아웃" 만 남아 무엇이 없어서인지 알 수 없다.

class PreflightError extends Error {}

async function head(url: string, timeoutMs = 4_000): Promise<Response | null> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
}

async function preflight(): Promise<{ scenes: number }> {
  // ① Vite. 브라우저가 붙을 곳이다.
  const root = await head(BASE);
  if (!root || !root.ok) {
    throw new PreflightError(
      `Vite 개발 서버가 ${BASE} 에 없습니다`
      + `${root ? ` (HTTP ${root.status})` : ''}.\n`
      + '        frontend/ 에서 `npm run dev` 를 띄우고 다시 실행하세요.\n'
      + '        (다른 주소면 VERIFY_UI_BASE=http://호스트:포트 로 지정)',
    );
  }

  // ② 게이트웨이. Vite 프록시(/api)를 통해 확인한다 — 브라우저가 가는 길과
  //    같은 경로여야 프록시 설정 자체의 문제도 여기서 잡힌다.
  const health = await head(`${BASE}/api/health`);
  if (!health || !health.ok) {
    throw new PreflightError(
      `Vite 는 떴는데 ${BASE}/api/health 가 응답하지 않습니다`
      + `${health ? ` (HTTP ${health.status})` : ' (연결 실패)'}.\n`
      + '        게이트웨이가 없거나 Vite 프록시가 다른 곳을 보고 있습니다.\n'
      + '        backend/ 에서 `npm run serve` 를 띄우고 다시 실행하세요.',
    );
  }

  // ③ 씬. 없으면 앱은 정상 동작하면서 빈 화면을 띄우고, 아래 단언이 전부
  //    "옷이 안 뜬다"로 무너진다 — 원인은 검증 대상이 아니라 데이터다.
  const list = await head(`${BASE}/api/scenes`);
  const body = list && list.ok ? ((await list.json()) as { count?: number }) : null;
  const scenes = body?.count ?? 0;
  if (scenes === 0) {
    throw new PreflightError(
      '게이트웨이에 씬이 하나도 없습니다.\n'
      + '        이 하네스는 첫 화면에서 자동 로드된 씬을 판정합니다 — .zls 를 먼저 업로드하세요.\n'
      + `        (브라우저에서 ${BASE} 를 열고 업로드하거나, POST ${BASE}/api/scenes)`,
    );
  }
  return { scenes };
}

// ─────────────────────────────────────────────────────────────
// 본체
// ─────────────────────────────────────────────────────────────

const timings: [string, number][] = [];

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    timings.push([label, performance.now() - t0]);
  }
}

async function main(): Promise<void> {
  console.log('=== UI 검증 하네스 (Playwright + 시스템 Chrome) ===');
  console.log(`대상 ${BASE}  ·  뷰포트 ${VIEWPORT.width}×${VIEWPORT.height}  ·  ${HEADED ? '창 표시' : '헤드리스'}`);
  console.log(`스크린샷 → ${OUT}`);

  const pre = await timed('사전 점검', preflight);
  note('사전 점검', `Vite ok · 게이트웨이 ok · 씬 ${pre.scenes}건`);

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: !HEADED, channel: CHANNEL });
    const page = await browser.newPage({ viewport: { ...VIEWPORT } });
    const logs = collect(page);

    await sectionFirstPaint(page, logs);
    await sectionCoordinates(page);
    await sectionPlayback(page);
    await sectionOrbit(page);
    await sectionPauseResume(page);
    const colors = await sectionSnapshot(page);
    await sectionExclusive(page, colors);
    await sectionConsole(page, logs);
    await sectionOpenIssues(page);
  } finally {
    await browser?.close();
  }
}

// ─────────────────────────────────────────────────────────────
// §1. 첫 화면 — 씬이 자동 로드되고 옷이 뜬다
//
// 이 단위의 판정 기준이자 다른 모든 절의 전제다. 여기서 실패하면 아래는
// 전부 무의미하므로 창구(`globalThis.cobalt`)의 존재부터 확인한다.
// ─────────────────────────────────────────────────────────────

async function sectionFirstPaint(page: Page, logs: Collected): Promise<void> {
  section('§1. 첫 화면 — 씬 자동 로드');

  await timed('§1 첫 화면', async () => {
    await page.goto(BASE, { waitUntil: 'load' });

    const hasCobalt = await page
      .waitForFunction(() => globalThis.cobalt !== undefined, null, { timeout: 15_000 })
      .then(() => true, () => false);
    check(
      '★ globalThis.cobalt 창구가 있다 (없으면 이 하네스 전체가 성립하지 않는다)',
      hasCobalt,
      hasCobalt ? 'main.ts 끝의 진단 표면' : 'main.ts 가 죽었거나 창구가 사라졌다',
    );
    if (!hasCobalt) throw new PreflightError('globalThis.cobalt 가 없어 더 진행할 수 없습니다');

    const t0 = performance.now();
    // 로드 완료와 **로드 실패**를 같이 기다린다. 실패를 안 보면 워커가 죽어도
    // LOAD_TIMEOUT 90초를 꼬박 서 있게 되는데, 화면은 이미 1초 만에 이유를
    // 적어 놓은 상태다(실측: 90.5초 → 5초로 줄었다).
    const loaded = await Promise.race([
      page
        .waitForFunction(() => globalThis.cobalt.viewer.cloth.patternCount > 0, null, {
          timeout: LOAD_TIMEOUT,
        })
        .then(() => true, () => false),
      page
        .waitForFunction(
          () => (document.getElementById('status')?.textContent ?? '').includes('로드 실패'),
          null,
          { timeout: LOAD_TIMEOUT },
        )
        .then(() => false, () => false),
    ]);
    check('★ 씬이 자동 로드되고 옷이 선다', loaded, loaded ? ms(performance.now() - t0) : '시간 초과');

    // 여기서 실패하면 **아래를 계속 돌리면 안 된다.** 옷이 없으면 경계 상자가
    // 비고, 그러면 §2~§7 이 전부 빨간불이 되면서 13건짜리 "UI 회귀" 처럼 보인다
    // — 실제 원인은 화면이 아니라 워커인데도. 그 혼동이 실제로 한 번 났다.
    //
    // 재현 조건까지 알아냈다: **연달아 돌리면 죽는다.** 앞 실행의 브라우저가
    // 닫히면 게이트웨이가 그 세션의 워커를 정리하는데, 그게 끝나기 전에 새
    // 워커가 144MB 씬을 또 올리면 워커가 죽는다(code=4001). 한 번씩 띄엄띄엄
    // 돌리면 재현되지 않는다 — ISSUE-007 과 같은 결의 불안정으로 보인다.
    if (!loaded) {
      const dead = await page.evaluate(
        () => document.getElementById('status')?.textContent ?? '',
      );
      const shotFile = await shot(page, 'load-failed');
      note('로드 실패 화면', path.basename(shotFile.file));
      const workerDied = /워커|code=4001|연결이 끊/.test(dead);
      throw new PreflightError(
        (workerDied
          ? '게이트웨이 워커가 죽어서 씬이 서지 않았습니다 — **UI 회귀가 아닙니다.**\n'
            + '        앞 실행 직후에 다시 돌리면 재현됩니다(앞 세션의 워커 정리와 새 워커의\n'
            + '        144MB 로드가 겹친다). 잠시 뒤 다시 돌리거나 게이트웨이를 재시작하세요.'
          : '씬이 시간 안에 서지 않았습니다. 화면 쪽 회귀일 수 있습니다.')
        + `\n        상태줄: "${dead}"`,
      );
    }

    const s = await readState(page);
    check('패턴이 하나 이상', s.patterns > 0, `${s.patterns}개`);
    check('정점이 하나 이상', s.vertices > 0, `${fmt(s.vertices)}개`);
    check('삼각형이 하나 이상', s.triangles > 0, `${fmt(s.triangles)}개`);

    // 상태줄이 화면의 값과 같은가. `#stat` 은 showScene 의 반환값으로 그려지고
    // 위 숫자들은 ClothObject 가 센 것이라, **출처가 다르다.** 어긋나면 디코딩과
    // 표시 중 한쪽이 다른 씬을 말하고 있다는 뜻이다.
    const nums = [...s.statText.matchAll(/\d[\d,]*/g)].map((m) => Number(m[0].replace(/,/g, '')));
    check(
      '★ 상태줄의 패턴·정점 수가 실제 지오메트리와 같다',
      nums[0] === s.patterns && nums[1] === s.vertices,
      `"${s.statText}" vs 패턴 ${s.patterns} / 정점 ${s.vertices}`,
    );
    check('상태줄이 로드 완료를 말한다', s.statusText.includes('로드 완료'), `"${s.statusText}"`);

    // 렌더 루프가 실제로 돈다 — 정적인 그림 한 장이 아니다.
    const r0 = s.renders;
    await sleep(600);
    const r1 = (await readState(page)).renders;
    check('★ 렌더 루프가 돌고 있다', r1 > r0, `${r0} → ${r1} (0.6초)`);

    const gl = await page.evaluate(() => {
      const cv = document.getElementById('view') as HTMLCanvasElement | null;
      const g = cv?.getContext('webgl2') ?? cv?.getContext('webgl');
      if (!g) return null;
      const ext = g.getExtension('WEBGL_debug_renderer_info');
      return String(g.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : g.RENDERER));
    });
    check('WebGL 컨텍스트가 살아 있다', gl !== null, gl ?? '없다');
    note('GPU', gl ?? '-');

    const sh = await shot(page, 'first-paint');
    // 화면이 통째로 검거나 배경만 있는 상태를 잡는다. 실측 5.5% 라 1% 는
    // 충분히 느슨하면서도 "아무것도 안 그려짐"과는 확실히 갈린다.
    check(
      '★ 화면에 옷이 실제로 그려져 있다 (배경만 있는 상태가 아니다)',
      sh.colors.saturated > sh.colors.total * 0.01,
      describe(sh.colors),
    );
    note('첫 화면 스크린샷', path.basename(sh.file));
    note('콘솔', `오류 ${logs.errors.length}건 · 무시 ${logs.ignored.length}건 (§8 에서 판정)`);
  });
}

// ─────────────────────────────────────────────────────────────
// §2. ISSUE-011 — 옷이 몸 높이에 선다
//
// **최근에 고친 것이라 회귀 감시 가치가 가장 높다.** 워커가 주는 정점은
// 패턴 로컬 좌표이고, 패턴마다 딸려 오는 `transform` 을 Mesh 에 걸어야 월드
// 좌표가 된다(`cloth.ts`). 그 배선이 끊기면 옷이 원점 아래로 내려앉는다 —
// 실측상 min y 가 -49 쯤이 된다. 화면만 보면 "옷이 좀 낮네" 로 보여서
// 사람 눈으로는 잘 안 잡히는 회귀다.
// ─────────────────────────────────────────────────────────────

async function sectionCoordinates(page: Page): Promise<void> {
  section('§2. ISSUE-011 — 옷이 몸 높이에 선다');

  await timed('§2 좌표계', async () => {
    const s = await readState(page);
    const min = s.clothBox.min;
    const max = s.clothBox.max;
    const minY = min[1] ?? Number.NaN;
    const maxY = max[1] ?? Number.NaN;

    check('경계 상자가 비어 있지 않다', !s.clothBox.empty, `min ${xyz(min)} / max ${xyz(max)}`);
    check(
      '★ 옷의 min y 가 양수다 (변환이 걸려 있다 — 미적용이면 -49 쯤이 된다)',
      minY > 0,
      `min y = ${minY.toFixed(2)}cm`,
    );
    // 단위가 cm 라는 것까지 함께 지킨다. m 로 바뀌면 이 범위에서 떨어진다.
    check(
      '옷이 사람 키 범위 안에 있다 (cm 단위가 유지된다)',
      maxY > 30 && maxY < 300,
      `max y = ${maxY.toFixed(2)}cm`,
    );
    check(
      '옷의 세로 길이가 그럴듯하다',
      maxY - minY > 10 && maxY - minY < 250,
      `${(maxY - minY).toFixed(1)}cm`,
    );
    note('경계 상자(월드, cm)', `min ${xyz(min)} → max ${xyz(max)}`);

    // 카메라가 그 상자를 실제로 겨누고 있는가. `frameCamera()` 는 렌더러가
    // 필요해 Node 스모크가 스텁으로 대신하는 함수다 — 여기가 유일한 검증이다.
    const cam = s.camera;
    const camY = cam[1] ?? 0;
    const dist = Math.hypot(
      (cam[0] ?? 0) - ((min[0] ?? 0) + (max[0] ?? 0)) / 2,
      camY - (minY + maxY) / 2,
      (cam[2] ?? 0) - ((min[2] ?? 0) + (max[2] ?? 0)) / 2,
    );
    const radius = Math.hypot(
      (max[0] ?? 0) - (min[0] ?? 0),
      maxY - minY,
      (max[2] ?? 0) - (min[2] ?? 0),
    ) / 2;
    check(
      '★ frameCamera() 가 옷을 담는 거리에 카메라를 뒀다',
      dist > radius && dist < radius * 8,
      `중심까지 ${dist.toFixed(1)}cm · 반지름 ${radius.toFixed(1)}cm`,
    );
    check(
      '카메라가 옷 높이 근처에 있다 (원점을 겨누고 있지 않다)',
      camY > minY * 0.2,
      `카메라 y = ${camY.toFixed(1)}cm`,
    );
  });
}

// ─────────────────────────────────────────────────────────────
// §3. 재생 — 옷이 실제로 움직인다
//
// "프레임 번호는 오르는데 옷은 안 움직인다"가 #13 에서 가장 원인이 안 보이는
// 실패다. 그래서 숫자 하나가 아니라 **사슬 전체**를 본다: 이벤트가 오는가
// (received) → mesh 가 실려 있는가(withMesh) → 붙었는가(applied) → GPU
// 어트리뷰트가 실제로 갱신됐는가(BufferAttribute.version).
// ─────────────────────────────────────────────────────────────

async function sectionPlayback(page: Page): Promise<void> {
  section('§3. 재생 — 옷이 움직인다');

  await timed('§3 재생', async () => {
    const before = await readState(page);
    const t0 = performance.now();
    await ensurePlaying(page, true);

    const started = await page
      .waitForFunction(() => globalThis.cobalt.stats.applied >= 5, null, { timeout: 30_000 })
      .then(() => true, () => false);
    check('★ 재생을 누르면 프레임이 흐르기 시작한다', started, ms(performance.now() - t0));

    await sleep(2_000);
    const st = await readStats(page);
    const after = await readState(page);

    check('프레임 이벤트가 온다', st.received > 0, `received ${st.received}`);
    check(
      '★ 구독이 켜져 있다 (received === withMesh — 하나라도 mesh 가 없으면 옷은 안 움직인다)',
      st.received === st.withMesh && st.withMesh > 0,
      `received ${st.received} / withMesh ${st.withMesh}`,
    );
    check('★ 프레임이 화면에 적용된다', st.applied >= 5, `applied ${st.applied}`);
    check('토폴로지가 어긋나지 않았다', st.mismatched === 0, `mismatched ${st.mismatched}`);
    check('디코딩 실패가 없다', st.failed === 0, `failed ${st.failed}`);
    check('스트림이 정지 상태가 아니다', !st.stalled && st.fps > 0, `${st.fps.toFixed(1)}fps`);

    // 여기가 이 절의 핵심이다. applied 는 "적용했다고 믿는" 카운터이고,
    // version 은 three 가 GPU 로 올릴 때 보는 **실제** 값이다. 둘이 갈라지면
    // 숫자는 도는데 화면은 멎어 있는 상태가 된다.
    const moved = after.versions.filter((v, i) => v > (before.versions[i] ?? -1)).length;
    check(
      '★ 패턴 전부의 position 어트리뷰트가 갱신됐다 (진짜로 움직인다)',
      moved === after.versions.length && moved > 0,
      `${moved}/${after.versions.length}개 · version ${before.versions[0] ?? '-'} → ${after.versions[0] ?? '-'}`,
    );

    check(
      '버튼이 "정지"로 바뀌어 있다',
      after.playText.includes('정지'),
      `"${after.playText.trim()}"`,
    );
    check('rAF 콜백이 예외를 던지지 않았다', after.tickError === null, after.tickError ?? '-');

    const sh = await shot(page, 'playing');
    check(
      '재생 중에도 옷이 화면에 있다',
      sh.colors.saturated > sh.colors.total * 0.01,
      describe(sh.colors),
    );
    note('프레임 통계', `received ${st.received} · applied ${st.applied} · dropped ${st.dropped} · ${st.fps.toFixed(1)}fps`);
  });
}

// ─────────────────────────────────────────────────────────────
// §4. 회전 — 드래그해도 검게 되거나 사라지지 않는다
//
// 프러스텀 컬링·경계구 갱신이 어긋나면 옷이 **돌리는 도중에** 사라진다
// (`cloth.ts` 의 함정 ③). 카메라가 움직였다는 것과 화면에 여전히 옷이 있다는
// 것을 같이 봐야 이 실패가 잡힌다.
// ─────────────────────────────────────────────────────────────

async function sectionOrbit(page: Page): Promise<void> {
  section('§4. 회전 — 드래그해도 옷이 사라지지 않는다');

  await timed('§4 회전', async () => {
    const before = await readState(page);

    // 좌드래그 = 회전. 상단 바(y<50)를 피해 캔버스 한가운데를 잡는다.
    const cx = VIEWPORT.width / 2;
    const cy = VIEWPORT.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(cx + i * 22, cy - i * 6);
      await sleep(16);
    }
    await page.mouse.up();
    // OrbitControls 는 damping 이 켜져 있어 손을 뗀 뒤에도 조금 더 돈다.
    await sleep(700);

    const after = await readState(page);
    const moved = Math.hypot(
      (after.camera[0] ?? 0) - (before.camera[0] ?? 0),
      (after.camera[1] ?? 0) - (before.camera[1] ?? 0),
      (after.camera[2] ?? 0) - (before.camera[2] ?? 0),
    );
    check('★ 드래그가 카메라를 움직인다 (OrbitControls 가 붙어 있다)', moved > 1, `${moved.toFixed(1)}cm 이동`);
    check('회전 중에도 렌더 루프가 산다', after.renders > before.renders, `${before.renders} → ${after.renders}`);
    check('rAF 콜백이 예외를 던지지 않았다', after.tickError === null, after.tickError ?? '-');

    const sh = await shot(page, 'rotated');
    check(
      '★ 돌린 뒤에도 옷이 화면에 있다 (검게 되거나 사라지지 않았다)',
      sh.colors.saturated > sh.colors.total * 0.01,
      describe(sh.colors),
    );
    note('회전 후 카메라', xyz(after.camera));
  });
}

// ─────────────────────────────────────────────────────────────
// §5. 정지 / 재개
//
// 재개가 **0부터 다시 시작**하면 화면은 멀쩡해 보이는데 시뮬은 처음으로
// 돌아간 것이다. 그래서 fps 가 0 이 되는 것만 보지 않고, 재개 후의 프레임
// 번호가 정지 시점보다 **큰지**를 본다.
// ─────────────────────────────────────────────────────────────

async function sectionPauseResume(page: Page): Promise<void> {
  section('§5. 정지 / 재개');

  await timed('§5 정지·재개', async () => {
    await ensurePlaying(page, false);
    const stopped = await untilPage(page, () => globalThis.cobalt.stats.fps === 0, 8_000);
    const paused = await readStats(page);
    check('★ 정지를 누르면 fps 가 0으로 내려간다', stopped, `${paused.fps.toFixed(1)}fps`);
    check(
      '버튼이 "재생"으로 돌아온다',
      (await readState(page)).playText.includes('재생'),
      `"${(await readState(page)).playText.trim()}"`,
    );

    // 정말로 멎었는가 — fps 는 감쇠값이라 0이어도 프레임이 올 수 있다.
    const frozen = paused.lastApplied;
    await sleep(1_200);
    const still = await readStats(page);
    check(
      '★ 정지 뒤에는 프레임이 더 오지 않는다',
      still.lastApplied === frozen,
      `lastApplied ${String(frozen)} → ${String(still.lastApplied)}`,
    );

    await ensurePlaying(page, true);
    const resumed = await untilPage(
      page,
      () => globalThis.cobalt.stats.fps > 0,
      20_000,
    );
    await sleep(800);
    const back = await readStats(page);
    check('★ 다시 누르면 재개된다', resumed && back.fps > 0, `${back.fps.toFixed(1)}fps`);
    check(
      '★ 0부터 다시 시작하지 않고 이어서 돈다',
      (back.lastApplied ?? -1) > (frozen ?? -1),
      `정지 ${String(frozen)} → 재개 ${String(back.lastApplied)}`,
    );
    check('재개 후에도 토폴로지가 맞는다', back.mismatched === 0 && back.failed === 0,
      `mismatched ${back.mismatched} / failed ${back.failed}`);
  });
}

// ─────────────────────────────────────────────────────────────
// §6. 스냅샷 — 아바타와 진짜 색
//
// ⚠️ **시뮬을 돌린 뒤에 찍어야 옷이 입혀진다.** 익스포트는 찍는 순간의 포즈를
//    담으므로, 0프레임에서 찍으면 옷이 아바타 위에 얹히기 전 상태가 나온다.
//    그래서 이 절은 §3~§5 뒤에 있고, 순서를 바꾸면 "아바타는 나오는데 옷이
//    몸에서 떨어져 있다"로 보인다 — ISSUE-011 회귀와 구별되지 않는 그림이다.
//
// 먼저 정지시키는 이유: 익스포트 4.5초 동안 시뮬이 계속 진행하면 화면의 옷과
// 파일 속 포즈가 달라져 §7 의 화면 비교가 흔들린다.
// ─────────────────────────────────────────────────────────────

interface SnapshotColors {
  live: ScreenColors;
  snap: ScreenColors;
}

async function sectionSnapshot(page: Page): Promise<SnapshotColors> {
  section('§6. 스냅샷 — 아바타 + 진짜 색');

  return await timed('§6 스냅샷', async () => {
    await ensurePlaying(page, false);
    await untilPage(page, () => globalThis.cobalt.stats.fps === 0, 8_000);

    // 실시간 화면의 색 분포. §7 의 비교 기준이자, 아래 "진짜 색" 판정의 대조군이다.
    const liveShot = await shot(page, 'live-before-snapshot');
    const before = await readState(page);

    const t0 = performance.now();
    await page.click('#snap');
    const done = await page
      .waitForFunction(
        () => ['ready', 'error'].includes(globalThis.cobalt.snapStats.phase),
        null,
        { timeout: SNAPSHOT_TIMEOUT },
      )
      .then(() => true, () => false);
    const elapsed = performance.now() - t0;

    const snapStats = await page.evaluate(() => {
      const s = globalThis.cobalt.snapStats;
      return {
        phase: s.phase,
        succeeded: s.succeeded,
        failed: s.failed,
        present: s.present,
        error: s.lastError ? s.lastError.message : null,
        bytes: s.lastResult?.info.bytes ?? 0,
        name: s.lastResult?.info.name ?? '',
        meshes: s.lastResult?.stats.meshes ?? 0,
        vertices: s.lastResult?.stats.vertices ?? 0,
        materials: s.lastResult?.stats.materials ?? 0,
        textures: s.lastResult?.stats.textures ?? 0,
        timings: s.lastResult?.timings ?? null,
      };
    });

    check('★ 스냅샷이 완성된다', done && snapStats.phase === 'ready',
      `${snapStats.phase} · ${ms(elapsed)}${snapStats.error ? ` · ${snapStats.error}` : ''}`);
    check('실패 없이 한 번에 성공', snapStats.succeeded >= 1 && snapStats.failed === 0,
      `성공 ${snapStats.succeeded} / 실패 ${snapStats.failed}`);
    check('내려받은 glTF 가 비어 있지 않다', snapStats.bytes > 1_000_000,
      `${(snapStats.bytes / (1 << 20)).toFixed(1)}MB · ${snapStats.name}`);

    // 아바타가 정말 들어 있는가 — 메시 수·정점 수가 옷보다 훨씬 크다는 관계로
    // 본다. 절대값을 박으면 씬을 바꾸는 순간 깨진다.
    check(
      '★ 스냅샷에 옷 말고도 무언가가 들어 있다 (= 아바타)',
      snapStats.meshes > before.patterns * 2 && snapStats.vertices > before.vertices,
      `메시 ${snapStats.meshes} (옷 패턴 ${before.patterns}) · 정점 ${fmt(snapStats.vertices)} (옷 ${fmt(before.vertices)})`,
    );
    check(
      '★ 머티리얼과 임베드 텍스처가 딸려 왔다',
      snapStats.materials > 0 && snapStats.textures > 0,
      `머티리얼 ${snapStats.materials} · 텍스처 ${snapStats.textures}`,
    );

    const after = await readState(page);
    check('화면이 스냅샷 모드로 넘어갔다', after.mode === 'snapshot', after.mode);
    check('스냅샷 상태줄이 채워진다', after.snapstatText.includes('스냅샷'), `"${after.snapstatText}"`);
    check('모드 전환 버튼이 나타난다', !after.modeHidden, after.modeHidden ? '숨겨져 있다' : '보인다');

    // 아바타가 옷보다 위아래로 넘친다 — 발은 옷단보다 아래, 머리는 옷보다 위.
    // 두 경계 상자가 같은 공간(cm)에 있다는 것까지 한 번에 지킨다.
    const sMin = after.snapBox.min[1] ?? Number.NaN;
    const sMax = after.snapBox.max[1] ?? Number.NaN;
    const cMin = after.clothBox.min[1] ?? Number.NaN;
    const cMax = after.clothBox.max[1] ?? Number.NaN;
    check(
      '★ 아바타가 옷보다 위아래로 넘친다 (두 뷰가 같은 좌표계에 있다)',
      sMin < cMin && sMax > cMax,
      `스냅샷 y ${sMin.toFixed(1)}~${sMax.toFixed(1)} vs 옷 y ${cMin.toFixed(1)}~${cMax.toFixed(1)}`,
    );
    check(
      '스냅샷이 사람 키 규모다 (SNAPSHOT_SCALE 이 살아 있다)',
      sMax - sMin > 100 && sMax - sMin < 300,
      `${(sMax - sMin).toFixed(1)}cm`,
    );

    // ── 픽셀 검사: "진짜 색"이 화면에 나오는가 ─────────────
    //
    // 파싱했다는 것과 그 색이 픽셀이 됐다는 것은 다른 명제다. 판정 방법은
    // **대조**다 — 실시간 옷의 색은 `cloth.ts` 의 디버그 팔레트 5색이고,
    // 스냅샷의 색은 glTF 머티리얼·텍스처에서 온다. 두 화면의 지배색이
    // 서로에게 거의 없는 색이면, 스냅샷 화면의 색은 팔레트로 만들 수 없는
    // 색 = **파일에서 온 색**이다.
    //
    // 특정 색 이름(노랑·민트)을 단언하지 않는 이유: 그건 씬이 정하는 값이라
    // .zls 를 바꾸면 깨진다. 색 이름은 note 로 남기고 단언은 관계로 한다.
    const snapShot = await shot(page, 'snapshot');
    const sc = snapShot.colors;
    const lc = liveShot.colors;

    check(
      '★ 스냅샷 화면에 색이 실제로 칠해져 있다',
      sc.saturated > sc.total * 0.005,
      describe(sc),
    );
    const snapDomInLive = bucketOf(lc, sc.dominant);
    const liveDomInSnap = bucketOf(sc, lc.dominant);
    check(
      '★ 스냅샷의 지배색이 실시간 화면에는 거의 없다 (팔레트가 아니라 파일의 색이다)',
      bucketOf(sc, sc.dominant) > 2_000 && snapDomInLive < bucketOf(sc, sc.dominant) * 0.2,
      `${hueName(sc.dominant)} — 스냅샷 ${fmt(bucketOf(sc, sc.dominant))}px / 실시간 ${fmt(snapDomInLive)}px`,
    );
    check(
      '★ 반대로 실시간의 지배색은 스냅샷에 거의 없다 (두 화면이 섞이지 않았다)',
      liveDomInSnap < bucketOf(lc, lc.dominant) * 0.2,
      `${hueName(lc.dominant)} — 실시간 ${fmt(bucketOf(lc, lc.dominant))}px / 스냅샷 ${fmt(liveDomInSnap)}px`,
    );
    // ── 그리고 색 이름까지 (씬을 아는 유일한 판정) ──────────
    //
    // 위 두 단언은 씬을 몰라도 성립하지만, 그 대가로 **어느 색인지는 말하지
    // 못한다** — 파일에서 온 색이기만 하면 회색이어도 통과한다. 실측 basecolor
    // 를 아는 씬에서는 거기까지 확인한다. 씬이 다르면 단언하지 않고 넘어간다
    // (씬을 바꿨다고 빨간불이 되면 아무도 이 하네스를 안 믿게 된다).
    const KNOWN_SCENE = 'W_Bra top & Leggings';
    if (snapStats.name.includes(KNOWN_SCENE)) {
      // 민트는 옅은 쪽에서, 노랑은 진한 쪽에서 센다 — 이유는 MINT_BAND 주석.
      const mint = band(sc.pale, MINT_BAND[0], MINT_BAND[1]);
      const yellow = band(sc.buckets, YELLOW_BAND[0], YELLOW_BAND[1]);
      const liveMint = band(lc.pale, MINT_BAND[0], MINT_BAND[1]);
      const liveYellow = band(lc.buckets, YELLOW_BAND[0], YELLOW_BAND[1]);
      // 문턱 1,000px 은 1280×800(102만px)의 0.1% 다. 실측(민트 2,564 · 노랑
      // 16,134)과는 두 배~열 배 여유가 있고, 안티에일리어싱 경계가 우연히
      // 넘을 수 있는 수(실시간 민트띠 198px)는 확실히 넘는다.
      const FLOOR = 1_000;
      check(
        '★ 스냅샷에 민트가 실제 픽셀로 있다 (실측 basecolor [0.733,0.886,0.816] → 152.5°, 옅은 띠)',
        mint > FLOOR,
        `색조 ${MINT_BAND[0] * 10}~${(MINT_BAND[1] + 1) * 10}° · 채도 옅음 ${fmt(mint)}px`,
      );
      check(
        '★ 스냅샷에 노랑이 실제 픽셀로 있다 (실측 basecolor [0.925,0.812,0.471] → 45.1°)',
        yellow > FLOOR,
        `색조 ${YELLOW_BAND[0] * 10}~${(YELLOW_BAND[1] + 1) * 10}° ${fmt(yellow)}px`,
      );
      // 두 색이 팔레트에서 올 수 있었다면 위 둘은 아무것도 증명하지 않는다.
      // 실시간 화면에서 **같은 띠를 같은 채도 구간으로** 재서 그 길을 닫는다.
      check(
        '★ 그 두 색은 디버그 팔레트로 만들 수 없다 (실시간 화면의 같은 띠가 비어 있다)',
        liveMint < mint * 0.2 && liveYellow < yellow * 0.2,
        `실시간 민트띠(옅은) ${fmt(liveMint)}px vs 스냅샷 ${fmt(mint)}px`
        + ` · 노랑띠 ${fmt(liveYellow)}px vs ${fmt(yellow)}px`,
      );
      note(
        '팔레트 색조',
        `${LIVE_PALETTE_BUCKETS.map((k) => `${k * 10}°`).join(' · ')}`
        + ' — 노랑띠와 겹치지 않고, 민트빛(130°)은 채도 0.289 라 옅은 띠에 못 들어간다',
      );
    } else {
      note(
        '색 이름 판정',
        `건너뛴다 — 실측 basecolor 를 아는 씬("${KNOWN_SCENE}")이 아니라 "${snapStats.name}" 이 열려 있다`,
      );
    }

    note('실시간 화면', describe(lc));
    note('스냅샷 화면', describe(sc));
    if (snapStats.timings) {
      const t = snapStats.timings;
      note('스냅샷 소요', `익스포트 ${t.exportMs}ms · 다운로드 ${t.downloadMs}ms · 파싱 ${t.parseMs}ms · 부착 ${t.installMs}ms`);
    }

    return { live: lc, snap: sc };
  });
}

// ─────────────────────────────────────────────────────────────
// §7. 배타 모드 — 동시에 보이지도, 둘 다 안 보이지도 않는다
//
// `Viewer3D.setMode` 는 두 `visible` 을 한 값에서 파생시켜 "둘 다 켜짐"을
// 표현할 수 없게 만든 함수다. 그 불변식이 **화면에서** 지켜지는지는 여기서만
// 확인된다 — Node 스모크는 렌더러가 없어 판정할 수 없다.
// ─────────────────────────────────────────────────────────────

async function sectionExclusive(page: Page, colors: SnapshotColors): Promise<void> {
  section('§7. 배타 모드 — 실시간 ↔ 스냅샷');

  await timed('§7 배타 모드', async () => {
    const inSnap = await readState(page);

    // §6 이 실패했으면 `#mode` 버튼이 `hidden` 이라 클릭이 30초를 기다리다
    // 던지고, **하네스가 통째로 중단된다** — 실측으로 §8·§9 를 통째로 잃었다.
    // 전제가 없으면 이 절만 접는다. §6 이 이미 이유를 적어 놓았다.
    if (inSnap.modeHidden) {
      note('§7 건너뜀', '스냅샷이 없어 모드 전환을 시험할 수 없다 — 원인은 §6 에 있다');
      check('★ 배타 모드를 판정할 수 있다 (스냅샷이 있다)', false, '스냅샷이 없다');
      return;
    }
    check(
      '★ 스냅샷 모드: 스냅샷만 보인다',
      inSnap.snapVisible && !inSnap.clothVisible,
      `cloth ${inSnap.clothVisible} / snapshot ${inSnap.snapVisible}`,
    );

    await page.click('#mode');
    await sleep(500);
    const inLive = await readState(page);
    check(
      '★ 되돌리면 실시간만 보인다',
      inLive.clothVisible && !inLive.snapVisible,
      `cloth ${inLive.clothVisible} / snapshot ${inLive.snapVisible}`,
    );
    check('모드 값도 따라온다', inLive.mode === 'live', inLive.mode);

    const backShot = await shot(page, 'back-to-live');

    // 화면이 실제로 되돌아왔는가 — 상태값이 아니라 픽셀로 본다.
    //
    // ⚠️ **아까 찍은 실시간 화면과 픽셀을 맞대면 안 된다.** 처음엔 그렇게
    //    짰다가 빨간불이 났고, 원인은 회귀가 아니라 카메라였다: 스냅샷으로
    //    갈 때는 `setMode('snapshot', { refit: true })` 가 아바타 경계(약
    //    177cm)에 맞춰 카메라를 다시 잡고, 되돌아올 때는 **일부러 다시 잡지
    //    않는다** (`main.ts:326` — "사용자가 잡아 둔 시점을 빼앗지 않는다").
    //    그래서 돌아온 화면은 §6 때와 같은 옷을 **다른 화각에서** 본 그림이고,
    //    색조별 픽셀 수는 당연히 다르다. 실측으로 주황이 12,267 → 2,929px 로
    //    떨어지면서 지배색이 파랑으로 바뀌었다 — 정상 동작이다.
    //
    // 그래서 화각이 바뀌어도 성립하는 명제로 판정한다: **스냅샷의 색이
    // 사라졌는가.** 이게 "상태만 바뀌고 그림은 그대로"를 잡는 데 필요한 전부다
    // (그림이 안 바뀌었다면 스냅샷 색이 그대로 남아 있다).
    const snapDom = colors.snap.dominant;
    check(
      '★ 되돌린 화면에서 스냅샷의 색이 사라졌다 (상태만 바뀌고 그림이 안 바뀌는 경우를 막는다)',
      bucketOf(backShot.colors, snapDom) < bucketOf(colors.snap, snapDom) * 0.2,
      `${hueName(snapDom)} — 스냅샷 ${fmt(bucketOf(colors.snap, snapDom))}px → 되돌린 뒤 ${fmt(bucketOf(backShot.colors, snapDom))}px`,
    );
    // 그리고 그 자리를 실시간 팔레트가 채우고 있는가. 팔레트 칸은 카메라
    // 각도와 무관하게(패턴 24개가 전부 화면에 있으므로) 나타난다.
    const palettePx = LIVE_PALETTE_BUCKETS.reduce(
      (n, k) => n + band(backShot.colors.buckets, k - 1, k + 1),
      0,
    );
    check(
      '★ 되돌린 화면이 실시간 팔레트 색으로 채워져 있다',
      palettePx > backShot.colors.saturated * 0.5,
      `팔레트 칸 ${fmt(palettePx)}px / 유채색 ${fmt(backShot.colors.saturated)}px`,
    );
    check(
      '★ 둘 다 안 보이는 상태가 아니다 (화면이 비지 않았다)',
      backShot.colors.saturated > backShot.colors.total * 0.005,
      describe(backShot.colors),
    );
    note('되돌린 화면', describe(backShot.colors));

    // 왕복. 한 방향만 보면 "한 번은 되는데 다시 가면 안 되는" 경우를 놓친다.
    await page.click('#mode');
    await sleep(500);
    const again = await readState(page);
    check(
      '★ 다시 스냅샷으로 가도 배타가 유지된다',
      again.snapVisible && !again.clothVisible && again.mode === 'snapshot',
      `cloth ${again.clothVisible} / snapshot ${again.snapVisible} / mode ${again.mode}`,
    );
    const againShot = await shot(page, 'snapshot-again');
    check(
      '★ 왕복해도 화면이 비지 않는다',
      againShot.colors.saturated > againShot.colors.total * 0.005,
      describe(againShot.colors),
    );

    // 재생을 누르면 실시간으로 돌아온다 (main.ts 의 returnToLiveForPlayback).
    // 스냅샷을 보는 채로 시뮬을 켜면 "재생을 눌렀는데 아무것도 안 움직인다"가
    // 되는데, 그 실패는 화면 어디에도 원인이 안 남는다.
    await ensurePlaying(page, true);
    await sleep(700);
    const afterPlay = await readState(page);
    check(
      '★ 재생을 누르면 실시간 뷰로 돌아온다 (정지 화면 위에서 시뮬을 켜지 않는다)',
      afterPlay.mode === 'live' && afterPlay.clothVisible && !afterPlay.snapVisible,
      `mode ${afterPlay.mode} · cloth ${afterPlay.clothVisible} / snapshot ${afterPlay.snapVisible}`,
    );
    check(
      '스냅샷은 버려지지 않는다 (모드 버튼이 남아 있다)',
      !afterPlay.modeHidden,
      afterPlay.modeHidden ? '버튼이 사라졌다' : '버튼이 남아 있다',
    );
    await ensurePlaying(page, false); // 정리: 시뮬을 멈춰 둔다
  });
}

// ─────────────────────────────────────────────────────────────
// §8. 콘솔 오류 0건
// ─────────────────────────────────────────────────────────────

async function sectionConsole(page: Page, logs: Collected): Promise<void> {
  section('§8. 콘솔 · 네트워크');

  await timed('§8 콘솔', async () => {
    check(
      '★ 콘솔 오류가 없다',
      logs.errors.length === 0,
      logs.errors.map((e) => `${e.text} ← ${e.url}`).join(' | ') || '0건',
    );
    check(
      '★ 잡히지 않은 예외가 없다',
      logs.pageErrors.length === 0,
      logs.pageErrors.join(' | ') || '0건',
    );
    check(
      'HTTP 4xx/5xx 응답이 없다',
      logs.httpErrors.length === 0,
      logs.httpErrors.map((e) => `${e.status} ${e.url}`).join(' | ') || '0건',
    );
    check(
      '실패한 요청이 없다',
      logs.netFailures.length === 0,
      logs.netFailures.map((e) => `${e.reason} ${e.url}`).join(' | ') || '0건',
    );
    check(
      'rAF 콜백이 끝까지 예외를 던지지 않았다',
      (await readState(page)).tickError === null,
      (await readState(page)).tickError ?? '-',
    );

    // 무시한 것을 조용히 넘기지 않는다. 근거는 isIgnorableConsoleError 위에 있다.
    if (logs.ignored.length > 0) {
      note(
        `무시한 콘솔 오류 ${logs.ignored.length}건`,
        'favicon.ico 404 — 브라우저가 자동으로 보내는 요청이고 index.html 에 아이콘 선언이 없다.'
        + ' 앱 코드가 만든 요청이 아니며 어떤 경로도 지나지 않는다',
      );
    }
    if (logs.ignoredNet.length > 0) {
      note(
        `무시한 요청 실패 ${logs.ignoredNet.length}건`,
        '익스포트 다운로드의 net::ERR_ABORTED — 바이트는 전부 도착했고 §6 의 파싱이 그 증거다.'
        + ' downloadExport 가 진행률 때문에 리더 경로를 타서 생기는 기록상의 흔적이다'
        + ' (근거는 isIgnorableNetFailure 주석)',
      );
    }
  });
}

// ─────────────────────────────────────────────────────────────
// §9. 열려 있는 이슈 — **단언하지 않고 값만 남긴다**
//
// ISSUE-009·010 은 아직 안 고쳤다. 지금 동작을 단언으로 박으면 고치는 날
// 이 하네스가 빨간불이 되고, 고친 사람이 "내가 뭘 깨뜨렸나"를 먼저 의심하게
// 된다. 그래서 여기서는 **재현만 하고 수치를 찍는다.** 고쳐지면 이 절의
// 숫자가 달라지고, 그때 위 §들 중 하나로 승격하면 된다.
// ─────────────────────────────────────────────────────────────

async function sectionOpenIssues(page: Page): Promise<void> {
  section('§9. 열려 있는 이슈 (판정하지 않음)');

  await timed('§9 이슈 관찰', async () => {
    const log = await page.evaluate(() => {
      const lines = (document.getElementById('log')?.textContent ?? '').split('\n').filter(Boolean);
      const engine = lines.filter((l) => l.includes('[엔진]')).length;
      return { total: lines.length, engine, first: lines[0] ?? '', last: lines[lines.length - 1] ?? '' };
    });
    note(
      'ISSUE-010 (로그 홍수)',
      `로그 ${log.total}줄 중 [엔진] ${log.engine}줄 (${(log.engine / Math.max(1, log.total) * 100).toFixed(0)}%)`
      + ` — 300줄 상한이라 40/s 면 7.5초 뒤 나머지가 밀려난다`,
    );
    note(
      'ISSUE-009 (재생 상태 어긋남)',
      '재현하지 않는다 — 재생 중 씬 재로드가 필요한데, 지금 동작(버튼이 "정지"로 남는다)을'
      + ' 단언으로 박으면 #14 가 고치는 날 이 하네스가 깨진다',
    );
    note(
      '덮지 못하는 것',
      '2D 펼침(#15) · 파라미터(#16) · 업로드 경로 · 재연결. 화면이 생기면 절을 추가할 것',
    );
  });
}

// ─────────────────────────────────────────────────────────────

const started = performance.now();
try {
  await main();
} catch (err: unknown) {
  if (err instanceof PreflightError) {
    console.log(`\n  중단  ${messageOf(err)}`);
  } else {
    console.log(`\n  중단  하네스가 던졌습니다: ${messageOf(err)}`);
    if (err instanceof Error && err.stack) console.log(err.stack);
  }
  failures++;
}

section('소요');
for (const [label, t] of timings) console.log(`  ${label.padEnd(16)} ${ms(t)}`);
console.log(`  ${'합계'.padEnd(16)} ${ms(performance.now() - started)}`);

section('결과');
console.log(`  ${checks - failures}/${checks} 통과${failures ? `, ${failures}건 실패` : ''}`);
if (shots.length > 0) {
  console.log(`  스크린샷 ${shots.length}장 → ${OUT}`);
  if (failures > 0) {
    console.log('  실패를 눈으로 확인할 때 볼 파일:');
    for (const f of shots) console.log(`    ${path.basename(f)}`);
  }
}
process.exitCode = failures > 0 ? 1 : 0;
