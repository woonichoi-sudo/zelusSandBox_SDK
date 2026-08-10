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

// ★ 제품 코드에서 **스키마만** 가져온다 (`panels/params.ts` — DOM 이 없어 Node 에서
//   돈다). 화면에 떠 있어야 할 필드 목록과 비활성 사유 문구를 하네스가 손으로
//   베끼지 않기 위해서다. 베끼면 문장이 바뀌는 날 하네스가 빨간불이 되고, 그때
//   고치는 사람이 "회귀인가?" 를 먼저 의심하게 된다. 스키마를 정본으로 두면
//   **문구가 바뀌어도 계약(어느 필드에 어느 종류의 사유가 붙는가)만 지켜지면
//   초록**이고, 화면이 그 문구를 안 보여주는 순간에만 빨간불이 된다.
import {
  paramDisabledReason,
  paramField,
  paramGroups,
  PARAM_FIELDS,
  type ParamContext,
  type ParamKey,
} from '../panels/index.ts';

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

// ── 워커로 나간 것 (WebSocket 프레임) ───────────────────────
//
// **왜 화면이 아니라 선을 보는가.** 스모크 §11-6 은 `buildSetParamsPayload` 가
// 죽은 필드를 빼는 것까지 증명한다. 그런데 그건 **그 함수를 지났을 때**의 이야기다.
// 화면이 위젯 상태 맵을 `client.setParams()` 에 곧바로 넘기면 스키마를 통째로
// 우회하게 되고, 그때 스모크 573건은 **하나도 안 깨진다** — 죽은 필드가 조용히
// 워커로 나가고 워커는 `applied` 로 답하며 물리는 그 값을 보지 않는다. 화면에는
// "적용됨" 이라고 뜬다. 그 거짓말은 오직 **선 위에서만** 보인다.
//
// 텍스트 프레임만 본다. 워커가 내려보내는 메시(frame 이벤트)는 바이너리이고
// 우리가 보내는 op 은 전부 JSON 한 줄이다 (`client.ts` 의 `ws.send(JSON.stringify)`).

interface SentOp {
  op: string;
  /** `setParams` 만 채워진다 */
  params: Record<string, unknown> | null;
  raw: string;
}

function collectWsFrames(page: Page): SentOp[] {
  const sent: SentOp[] = [];
  page.on('websocket', (ws) => {
    ws.on('framesent', (f: { payload: string | Buffer }) => {
      if (typeof f.payload !== 'string') return;
      const text = f.payload;
      if (!text.startsWith('{')) return;
      try {
        const msg = JSON.parse(text) as { op?: unknown; params?: unknown };
        const params =
          typeof msg.params === 'object' && msg.params !== null
            ? (msg.params as Record<string, unknown>)
            : null;
        sent.push({ op: String(msg.op ?? ''), params, raw: text });
      } catch {
        // JSON 이 아니면 우리 op 이 아니다. 판정에 넣을 것이 없다.
      }
    });
  });
  return sent;
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
    // 첫 소켓이 열리기 전에 붙여야 한다 — 페이지가 뜨는 순간 이미 붙는다.
    const sent = collectWsFrames(page);

    await sectionFirstPaint(page, logs);
    await sectionCoordinates(page);
    await sectionPlayback(page);
    await sectionOrbit(page);
    await sectionPauseResume(page);
    const colors = await sectionSnapshot(page);
    await sectionExclusive(page, colors);
    await sectionPlaybackControls(page);
    await sectionParams(page, sent);
    await sectionUnfold(page);
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
// §10. 재생 컨트롤 (#14) — 버튼·키가 실제로 화면을 움직인다
//
// ── 왜 여기에도 절이 필요한가 (스모크 §10 과의 분담) ─────────
// `protocol/smoke.ts` 의 §10-1~§10-10 이 상태 기계 전체를 가짜 포트로 돌린다.
// 그것으로 **덮이지 않는 것이 정확히 세 가지**이고, 셋 다 여기서만 보인다:
//
//   ① **배선.** `PlaybackController` 가 아무리 옳아도 `#load` 버튼이
//      `sceneLoading()` 을 안 부르면 화면은 그대로 거짓말한다 — ISSUE-009 가
//      정확히 그 모양이었다. 스모크는 초록인 채로 화면만 틀린다
//   ② **키가 실제로 먹는가.** `shortcutFor()` 의 표가 맞는 것과, `keydown` 이
//      그 표를 지나 시뮬을 켜는 것은 다른 명제다. IME·포커스 양보도 마찬가지다
//   ③ **리셋 뒤에 화면의 옷이 돌아오는가.** 리셋은 frame 이벤트를 한 건도 안
//      내므로(`maxFrame` 이 -1 로 돌아간다) 훅이 포즈를 다시 받지 않으면
//      **시뮬은 처음인데 화면은 드레이프된 옷 그대로**다. 경계 상자로만 보인다
//
// ── 무엇을 단언하지 않는가 ──────────────────────────────────
// 버튼 글자('▶ 재생')·상태 문구는 바뀔 수 있다. 그래서 문자열을 못으로 박지
// 않고 **관계**로 본다: '재생'/'정지' 중 하나만 들어 있는가, 리셋한 상자가
// 처음 로드한 상자에 가까운가, 드레이프된 상자와는 먼가. 유일하게 두 글자를
// 보는 이유는 `ensurePlaying` 이 그 글자로 상태를 읽기 때문이고, 그 사실 자체를
// 첫 단언이 명시한다.
// ─────────────────────────────────────────────────────────────

interface PlaybackProbe {
  state: string;
  playLabel: string;
  playing: boolean;
  frame: number | null;
  workerMode: string | null;
  scene: string | null;
  subscribed: boolean;
  canPlay: boolean;
  canReset: boolean;
  canClear: boolean;
  text: string;
  corrections: number;
  negativeFrames: number;
  subscribes: number;
  rejected: number;
  failures: number;
  syncs: number;
  /** DOM 쪽 — 컨트롤러의 view 와 **갈라질 수 있는** 값들이다 */
  playText: string;
  playDisabled: boolean;
  resetDisabled: boolean;
  clearDisabled: boolean;
  simText: string;
  framesText: string;
  statusText: string;
  hasStepButton: boolean;
  patternCount: number;
  clothBox: { min: number[]; max: number[]; empty: boolean };
}

function readPlayback(page: Page): Promise<PlaybackProbe> {
  return page.evaluate((): PlaybackProbe => {
    const c = globalThis.cobalt;
    const v = c.playbackView;
    const st = c.playback.stats;
    const box = c.viewer.cloth.boundingBox();
    const text = (id: string): string => document.getElementById(id)?.textContent ?? '';
    const dis = (id: string): boolean =>
      (document.getElementById(id) as HTMLButtonElement | null)?.disabled ?? true;
    return {
      state: v.state,
      playLabel: v.playLabel,
      playing: v.playing,
      frame: v.frame,
      workerMode: v.workerMode,
      scene: v.scene,
      subscribed: v.subscribed,
      canPlay: v.canPlay,
      canReset: v.canReset,
      canClear: v.canClear,
      text: v.text,
      corrections: st.corrections,
      negativeFrames: st.negativeFrames,
      subscribes: st.subscribes,
      rejected: st.rejected,
      failures: st.failures,
      syncs: st.syncs,
      playText: text('play'),
      playDisabled: dis('play'),
      resetDisabled: dis('reset'),
      clearDisabled: dis('clear'),
      simText: text('sim'),
      framesText: text('frames'),
      statusText: text('status'),
      hasStepButton: document.getElementById('step') !== null,
      patternCount: c.viewer.cloth.patternCount,
      clothBox: {
        min: box.min.toArray(), max: box.max.toArray(), empty: box.isEmpty(),
      },
    };
  });
}

/** 두 글자 중 하나만 들어 있는가. `ensurePlaying` 이 글자를 읽는 그 방식이다 */
function readsAs(label: string, want: '재생' | '정지'): boolean {
  const other = want === '재생' ? '정지' : '재생';
  return label.includes(want) && !label.includes(other);
}

/** 경계 상자 두 개의 min·max 최대 거리. 포즈가 얼마나 달라졌는지의 척도다 */
function boxGap(
  a: { min: number[]; max: number[] },
  b: { min: number[]; max: number[] },
): number {
  const d = (p: number[], q: number[]): number =>
    Math.hypot((p[0] ?? 0) - (q[0] ?? 0), (p[1] ?? 0) - (q[1] ?? 0), (p[2] ?? 0) - (q[2] ?? 0));
  return Math.max(d(a.min, b.min), d(a.max, b.max));
}

function boxText(b: { min: number[]; max: number[] }): string {
  return `y ${(b.min[1] ?? 0).toFixed(2)}~${(b.max[1] ?? 0).toFixed(2)}`;
}

/** 포커스를 아무 데도 두지 않는다. 버튼에 포커스가 남아 있으면 단축키가 양보한다 */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => {
    const a = document.activeElement;
    if (a instanceof HTMLElement) a.blur();
  });
}

async function sectionPlaybackControls(page: Page): Promise<void> {
  section('§10. 재생 컨트롤 (#14) — 버튼·키가 실제로 화면을 움직인다');

  // 확인창이 뜨면 여기에 쌓인다. **clear 에 confirm() 을 달지 않은 것이 판단이고**
  // (Playwright 는 대화상자를 기본으로 취소해서 자동 검증이 "clear 가 아무 일도
  // 안 함" 으로 보인다), 그 판단이 지켜지는지 여기서 본다.
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(`${d.type()}: ${d.message()}`);
    void d.dismiss();
  });

  await timed('§10 재생 컨트롤', async () => {
    await ensurePlaying(page, false);
    await blur(page);

    // ── ① 화면에 있는 컨트롤 ─────────────────────────────────
    {
      const p = await readPlayback(page);
      check(
        '★ 재생 버튼 글자가 "재생"/"정지" 중 하나로만 읽힌다 (ensurePlaying 이 이걸 본다)',
        readsAs(p.playText, '재생') || readsAs(p.playText, '정지'),
        `"${p.playText.trim()}"`,
      );
      check(
        '★ 컨트롤러의 view 와 실제 버튼 글자가 같다 (paintPlayback 배선이 살아 있다)',
        p.playText.trim() === p.playLabel.trim(),
        `DOM "${p.playText.trim()}" vs view "${p.playLabel}"`,
      );
      check(
        '★ 씬이 있으면 재생·리셋·씬내림이 전부 눌린다',
        !p.playDisabled && !p.resetDisabled && !p.clearDisabled,
        `play=${String(!p.playDisabled)} reset=${String(!p.resetDisabled)} clear=${String(!p.clearDisabled)}`,
      );
      check(
        '★★ 눌러도 아무 일이 없는 컨트롤은 화면에 없다 (워커의 step 이 no-op 인 동안 #step 을 안 올렸다)',
        !p.hasStepButton, p.hasStepButton ? '#step 이 생겼다' : '#step 없음',
      );
      // `#sim`(워커가 말하는 것)과 `#frames`(브라우저가 그린 것)는 출처가 다르다.
      // 둘 다 있어야 "프레임은 오는데 안 그려진다" 를 화면에서 가를 수 있다.
      check(
        '★ 워커 상태(#sim)와 브라우저가 그린 것(#frames)이 둘 다 찍혀 있다',
        p.simText.trim().length > 1 && p.framesText.trim().length > 1,
        `sim "${p.simText}" · frames "${p.framesText}"`,
      );
      check('상태줄이 컨트롤러의 문구를 그대로 쓴다', p.simText === p.text,
        `"${p.simText}" vs "${p.text}"`);
      note('진입 상태', `${p.state} · ${p.text} · 워커 mode=${String(p.workerMode)}`);
    }

    // ── ② 단축키 S — 실제 keydown 이 시뮬을 켠다 ─────────────
    {
      const before = await readStats(page);
      await page.keyboard.press('s');
      const on = await untilPage(
        page,
        () => (document.getElementById('play')?.textContent ?? '').includes('정지'),
        15_000,
      );
      check('★★ S 키가 재생을 켠다 (keydown → shortcutFor → toggle 배선)', on, 'play → 정지');
      const flowed = await page.waitForFunction(
        (n: number) => globalThis.cobalt.stats.applied > n,
        before.applied,
        { timeout: 30_000 },
      ).then(() => true, () => false);
      check('★ 그리고 실제로 프레임이 흐른다 (버튼과 같은 경로다)', flowed, '프레임 적용 증가');

      await page.keyboard.press('s');
      const off = await untilPage(
        page,
        () => (document.getElementById('play')?.textContent ?? '').includes('재생'),
        15_000,
      );
      check('★ 한 번 더 누르면 멈춘다 (토글이다 — 누른 횟수가 아니라 상태를 본다)', off, 'play → 재생');
    }

    // ── ③ 양보 — 키를 가로채면 안 되는 순간 ──────────────────
    {
      const b = await readPlayback(page);
      // 입력 요소에 포커스가 있으면 양보한다.
      await page.focus('#file');
      await page.keyboard.press('s');
      await sleep(300);
      const afterInput = await readPlayback(page);
      check(
        '★★ 입력 요소에 포커스가 있으면 단축키가 양보한다',
        afterInput.playing === b.playing && afterInput.state === b.state,
        `${b.state} → ${afterInput.state}`,
      );

      // ⚠️ 버튼에 포커스가 있을 때도 양보한다. 재생 버튼을 누른 직후가 그
      //    상태이고, 양보하지 않으면 한 번의 입력이 두 가지 동작이 된다.
      await page.focus('#play');
      await page.keyboard.press('s');
      await sleep(300);
      const afterButton = await readPlayback(page);
      check(
        '★★ 버튼에 포커스가 있어도 양보한다 (한 번 누른 것이 두 동작이 되지 않는다)',
        afterButton.playing === b.playing, `playing=${String(afterButton.playing)}`,
      );

      // 수식키가 눌려 있으면 브라우저/OS 의 것이다. Shift 로 확인한다 —
      // Ctrl+R 은 실제로 페이지를 새로고침해 버려서 하네스가 못 쓴다.
      await blur(page);
      await page.keyboard.press('Shift+S');
      await sleep(300);
      const afterShift = await readPlayback(page);
      check(
        '★ 수식키가 눌려 있으면 손대지 않는다 (Shift+S 로 확인 — Ctrl+R 은 새로고침이라 못 쓴다)',
        afterShift.playing === b.playing, `playing=${String(afterShift.playing)}`,
      );
    }

    // ── ④ ★★★ ISSUE-009 — 재생 중 재로드에서 버튼이 정직해진다 ──
    //
    // 스모크 §10-2 가 `sceneLoading()` 이 믿음을 내리는 것을 증명한다. 여기서
    // 증명하는 것은 **[로드] 버튼이 그 함수를 실제로 부르는가**다. 배선이
    // 끊기면 스모크는 초록인 채로 화면만 거짓말한다 — 그게 ISSUE-009 였다.
    {
      await ensurePlaying(page, true);
      await page.waitForFunction(() => globalThis.cobalt.stats.applied > 3, null, {
        timeout: 30_000,
      }).then(() => true, () => false);
      const playingNow = await readPlayback(page);
      check('전제 — 재생 중이고 버튼이 "정지" 다',
        playingNow.playing && readsAs(playingNow.playText, '정지'),
        `"${playingNow.playText.trim()}" · frame=${String(playingNow.frame)}`);
      const corr0 = playingNow.corrections;

      // 로드를 누른다. **로드가 끝나기를 기다리지 않고 곧바로 읽는다** —
      // 103MB 면 1초쯤이고, ISSUE-009 는 그 1초 동안의 거짓말이었다.
      await blur(page);
      await page.click('#load');
      const during = await readPlayback(page);
      check(
        '★★★ 로드가 끝나기 전에 이미 버튼이 "재생" 이다 (ISSUE-009 의 통과 기준)',
        readsAs(during.playText, '재생') && !during.playing,
        `"${during.playText.trim()}" · state=${during.state} · 상태줄 "${during.statusText}"`,
      );
      check(
        '★ 그때 화면은 아직 로드 중이라고 말한다 (완료된 뒤를 본 것이 아니다)',
        during.state === 'loading' || during.statusText.includes('로드'),
        `state=${during.state} · "${during.statusText}"`,
      );
      check('★ 로드 중에는 재생 버튼이 잠긴다 (누를 수 있으면 워커에 헛 op 이 간다)',
        during.playDisabled, `disabled=${String(during.playDisabled)}`);

      const done = await page.waitForFunction(
        () => (document.getElementById('status')?.textContent ?? '').includes('로드 완료'),
        null,
        { timeout: LOAD_TIMEOUT },
      ).then(() => true, () => false);
      // ⚠️ '로드 완료' 는 `show()` 의 try 안에서 찍히고, **되묻기는 finally 에서**
      //    일어난다. 곧바로 읽으면 `workerMode` 가 로드 **이전** 값(재생 중이었으니
      //    'play')이라 실측이 아니라 잔상을 보게 된다 — 실제로 그 잔상 때문에
      //    아래 단언이 간헐적으로 빨간불이 났다. 되묻기가 한 번 더 돌 때까지 기다린다.
      const synced = await page.waitForFunction(
        (n: number) => globalThis.cobalt.playback.stats.syncs > n,
        during.syncs,
        { timeout: 20_000 },
      ).then(() => true, () => false);
      const after = await readPlayback(page);
      check('★ 로드가 끝난 뒤 워커에 한 번 되묻는다 (믿음이 아니라 사실로 마무리한다)',
        synced && after.syncs > during.syncs, `syncs ${during.syncs} → ${after.syncs}`);
      check('★ 재로드가 완료된다', done && after.patternCount > 0,
        `패턴 ${after.patternCount} · "${after.statusText}"`);
      check(
        '★★ 로드가 끝나도 버튼은 "재생" 이다 (워커는 멈춰 있다 — 마음대로 다시 켜지 않는다)',
        readsAs(after.playText, '재생') && after.state === 'paused'
        && after.workerMode !== 'play',
        `"${after.playText.trim()}" · state=${after.state} · 워커 mode=${String(after.workerMode)}`,
      );
      check(
        '★★★ 대조군 — 이 경로에서 corrections 가 오르지 않았다 (믿음이 사실과 갈라진 적이 없다)',
        after.corrections === corr0, `${corr0} → ${after.corrections}`,
      );
      note('되묻기', `syncs=${after.syncs} · negativeFrames=${after.negativeFrames}`
        + ` · corrections=${after.corrections}`);
    }

    // ── ⑤ R 키 = 리셋. **화면의 포즈가 돌아온다** ────────────
    //
    // 리셋은 `maxFrame` 을 -1 로 되돌리므로 frame 이벤트가 한 건도 오지 않는다.
    // `afterReset` 훅이 포즈를 다시 받지 않으면 **시뮬은 처음인데 화면은
    // 드레이프된 옷 그대로**다. 경계 상자 세 장으로 그것을 가른다:
    //   fresh(방금 로드) → draped(재생 뒤) → reset(리셋 뒤)
    // 대조군이 안에 들어 있다 — draped 가 fresh 와 충분히 달라야 이 판정에
    // 이빨이 있고, reset 이 fresh 로 돌아와야 훅이 일한 것이다.
    {
      const fresh = (await readPlayback(page)).clothBox;
      await blur(page);
      await page.keyboard.press('s');
      const ran = await untilPage(page, () => globalThis.cobalt.stats.fps > 0, 20_000);
      await sleep(2_500); // 옷이 눈에 띄게 드레이프될 만큼
      await ensurePlaying(page, false);
      const draped = await readPlayback(page);
      const drapeGap = boxGap(fresh, draped.clothBox);
      check(
        '★ 전제 — 재생하면 옷의 형태가 실제로 달라진다 (아래 판정에 이빨이 생긴다)',
        ran && drapeGap > 1, `${boxText(fresh)} → ${boxText(draped.clothBox)} (Δ${drapeGap.toFixed(2)}cm)`,
      );
      check('전제 — 프레임 번호가 화면에 올라와 있다',
        draped.frame !== null && draped.simText.includes('프레임'),
        `frame=${String(draped.frame)} · "${draped.simText}"`);

      await blur(page);
      await page.keyboard.press('r');
      const reset = await untilPage(
        page,
        () => globalThis.cobalt.playbackView.frame === null,
        20_000,
      );
      await sleep(700); // afterReset 의 meshData(false) 왕복
      const afterReset = await readPlayback(page);
      const backGap = boxGap(fresh, afterReset.clothBox);
      check('★★ R 키가 리셋을 보낸다 (프레임 번호가 비워진다)', reset,
        `frame=${String(afterReset.frame)}`);
      check(
        '★★ 리셋하면 상태줄에서 프레임 항목이 사라진다 (옛 봉우리가 남지 않는다)',
        !afterReset.simText.includes('프레임') && afterReset.frame === null,
        `"${afterReset.simText}"`,
      );
      check(
        '★★★ 리셋하면 **화면의 옷도** 처음 자세로 돌아온다 (afterReset 이 포즈를 다시 받는다)',
        backGap < drapeGap * 0.5 && backGap < 2,
        `리셋 후 ${boxText(afterReset.clothBox)} — 첫 로드와 차이 ${backGap.toFixed(2)}cm`
        + ` vs 드레이프 차이 ${drapeGap.toFixed(2)}cm`,
      );
      check('★ 리셋은 씬을 남긴다 (패턴이 그대로 서 있다)',
        afterReset.patternCount > 0 && afterReset.state === 'paused',
        `패턴 ${afterReset.patternCount} · ${afterReset.state}`);
      note('포즈', `fresh ${boxText(fresh)} · draped ${boxText(draped.clothBox)}`
        + ` · reset ${boxText(afterReset.clothBox)}`);
    }

    // ── ⑥ C 키 = 씬 내림. 확인창은 없고, 로드 한 번이면 돌아온다 ──
    {
      const before = await readPlayback(page);
      await blur(page);
      await page.keyboard.press('c');
      const gone = await untilPage(
        page,
        () => globalThis.cobalt.viewer.cloth.patternCount === 0,
        20_000,
      );
      const cleared = await readPlayback(page);
      check('★★ C 키가 씬을 내린다 (화면에서 옷이 사라진다)', gone && cleared.patternCount === 0,
        `패턴 ${before.patternCount} → ${cleared.patternCount}`);
      check(
        '★★ 확인창이 뜨지 않는다 (Playwright 가 기본 취소해서 자동 검증이 눈멀지 않게 한 판단)',
        dialogs.length === 0, dialogs.join(' | ') || '0건',
      );
      check(
        '★ 씬을 내리면 재생 컨트롤이 전부 잠긴다 (누를 곳이 없다)',
        cleared.playDisabled && cleared.resetDisabled && cleared.clearDisabled
        && cleared.state === 'noScene',
        `state=${cleared.state}`,
      );
      check('★ 상태줄이 되돌리는 방법을 말한다',
        cleared.statusText.includes('로드') || cleared.text.includes('로드'),
        `"${cleared.statusText}" / "${cleared.text}"`);

      // 되돌린다 — 잃은 것은 시뮬 진행뿐이라는 것이 확인창을 안 단 근거다.
      await page.click('#load');
      const back = await page.waitForFunction(
        () => globalThis.cobalt.viewer.cloth.patternCount > 0,
        null,
        { timeout: LOAD_TIMEOUT },
      ).then(() => true, () => false);
      const restored = await readPlayback(page);
      check(
        '★★ [로드] 한 번이면 돌아온다 (.zls 는 게이트웨이에 남아 있다 — 확인창을 안 단 근거)',
        back && restored.patternCount > 0 && restored.state === 'paused',
        `패턴 ${restored.patternCount} · ${restored.state}`,
      );
    }

    // ── ⑦ 대조군과 계측기 ────────────────────────────────────
    {
      const p = await readPlayback(page);
      check(
        '★★★ 이 절 전체에서 corrections 가 0 이다 — 화면이 워커와 갈라진 적이 없다 (ISSUE-009)',
        p.corrections === 0, `corrections=${p.corrections}`,
      );
      check(
        '★★ 재생·리셋·clear·재로드를 지나도 subscribe 는 세션당 한 번이다',
        p.subscribes === 1, `subscribes=${p.subscribes}`,
      );
      check('실패한 조작이 없다', p.failures === 0, `failures=${p.failures} rejected=${p.rejected}`);
      check('★ 화면이 그린 프레임(#frames)과 워커가 말한 프레임(#sim)이 둘 다 살아 있다',
        p.framesText.length > 1 && p.simText.length > 1,
        `sim "${p.simText}" · frames "${p.framesText}"`);
      note(
        '계측기',
        `corrections=${p.corrections} · negativeFrames=${p.negativeFrames}`
        + ` (워커의 status.frame 이 음수로 온 횟수 — 화면에는 안 쓴다)`
        + ` · syncs=${p.syncs} · subscribes=${p.subscribes}`,
      );

      const sh = await shot(page, 'playback-controls');
      check(
        '★ 이 절이 끝난 뒤에도 화면에 옷이 서 있다',
        sh.colors.saturated > sh.colors.total * 0.01, describe(sh.colors),
      );
    }
  });
}

// ─────────────────────────────────────────────────────────────
// §11. 파라미터 패널 (#16) — 값을 바꾸면 시뮬이 달라진다
//
// ── 스모크 §11(109건)과의 분담 ──────────────────────────────
// `protocol/smoke.ts` 가 스키마·검증·비활성 판정·페이로드 변환을 전부 덮는다.
// **그것으로 덮이지 않는 것이 정확히 셋**이고, 셋 다 여기서만 보인다:
//
//   ① **배선.** `buildSetParamsPayload` 가 아무리 옳아도 화면이 그 함수를 안
//      지나면 죽은 필드가 그대로 워커로 나간다. 스모크는 초록인 채로 화면만
//      거짓말한다 — #14 에서 실증된 그 모양이다 (배선 한 줄을 지우면 스모크
//      464건이 전부 통과하고 UI 하네스만 잡았다)
//   ② **사유가 화면에 글자로 있는가.** `ParamDisabled.text` 가 존재한다는 것과
//      그 글자가 화면에 떠 있다는 것은 다른 명제다. `title`(툴팁)에만 넣으면
//      스모크는 아무것도 눈치채지 못하고, 사용자는 회색 위젯만 본다
//   ③ **★ 값을 바꾸면 시뮬이 실제로 달라지는가.** #16 의 통과 기준이고,
//      정점이 움직이는 것은 오직 화면에서만 확인된다
//
// ── ③ 을 어떻게 재는가 ──────────────────────────────────────
// **[실측]** 솔버는 결정적이다. **씬을 다시 로드하고** 같은 파라미터로 돌리면
// 프레임마다 정점이 **비트 단위로 같다**(아래 대조군이 매 실행 그것을 확인한다:
// 61프레임 전부 최대 오차 0.000000000cm). 그래서 "달라졌다"에 지터 여유를 줄
// 이유가 전혀 없다 — **0 이 아니면 달라진 것**이다.
//
// ⚠️ **리셋으로는 이 날카로움이 안 나온다.** 같은 워커에서 `reset` 뒤에 다시
//    돌리면 같은 파라미터인데도 평균 0.50cm / 최대 2.26cm 어긋난다(실측).
//    §10-⑤ 가 리셋 판정에 2cm 를 허용한 것과 같은 결이다. 그래서 이 절은
//    비교하는 세 번의 실행을 **매번 [로드] 로 시작한다.**
//
// 표본은 프레임 번호를 열쇠로 모은다. `stats.lastApplied` 가 f 인 순간의
// 정점은 **정확히 프레임 f 의 포즈**다(다음 프레임은 아직 안 왔다). 두 실행에서
// 같은 f 끼리만 맞대므로 프레임이 밀려도 비교가 흔들리지 않는다.
// ─────────────────────────────────────────────────────────────

/** 한 실행에서 모은 프레임별 정점 표본. `[프레임 번호, 좌표들]` */
type Poses = [number, number[]][];

/**
 * 몇 프레임까지 돌릴 것인가. **ISSUE-014 측정 도구는 100프레임을 썼다** —
 * 여기서는 실행 시간 때문에 60으로 줄였다. 그래도 판정이 서는 이유는 이 절이
 * 평균 변위의 절대값을 못으로 박지 않고 **대조군(0cm)과의 관계**로 보기 때문이다.
 */
const RUN_FRAMES = 60;

/** 정점을 몇 개마다 하나씩 뽑는가. 24패턴 × 전 정점이면 프레임마다 수 MB 다 */
const POSE_STRIDE = 37;

interface RowProbe {
  /** 'checkbox' | 'select' | 'number' | '' */
  widget: string;
  /** 체크박스는 'true'/'false', 나머지는 위젯의 문자열 값 */
  value: string;
  disabled: boolean;
  hasSlider: boolean;
  sliderValue: string | null;
  sliderDisabled: boolean | null;
  /** 비활성 사유가 **화면에 떠 있는가** (hidden 이면 false) */
  whyShown: boolean;
  whyText: string;
  noteText: string;
  helpText: string;
  badges: string[];
  /**
   * ★ 이 행에서 **눈에 보이는 글자 전부.** `innerText` 는 `hidden` 인 것을 빼고
   *   `title` 속성을 포함하지 않는다 — 그래서 "툴팁에만 있다"를 정확히 가른다.
   */
  visibleText: string;
  title: string;
  options: { value: string; label: string }[] | null;
}

function readParamRows(page: Page): Promise<Record<string, RowProbe>> {
  return page.evaluate((): Record<string, RowProbe> => {
    const out: Record<string, RowProbe> = {};
    for (const el of document.querySelectorAll('#params .prow')) {
      const row = el as HTMLElement;
      const key = row.dataset['key'] ?? '';
      const ctrl = row.querySelector(
        'input:not([type="range"]), select',
      ) as HTMLInputElement | HTMLSelectElement | null;
      const slider = row.querySelector('input[type="range"]') as HTMLInputElement | null;
      const why = row.querySelector('.pwhy') as HTMLElement | null;
      const note = row.querySelector('.pnote') as HTMLElement | null;
      const help = row.querySelector('.phelp') as HTMLElement | null;
      let widget = '';
      let value = '';
      if (ctrl instanceof HTMLSelectElement) {
        widget = 'select';
        value = ctrl.value;
      } else if (ctrl !== null) {
        widget = ctrl.type;
        value = ctrl.type === 'checkbox' ? String(ctrl.checked) : ctrl.value;
      }
      out[key] = {
        widget,
        value,
        disabled: ctrl?.disabled ?? true,
        hasSlider: slider !== null,
        sliderValue: slider?.value ?? null,
        sliderDisabled: slider === null ? null : slider.disabled,
        whyShown: why !== null && !why.hidden,
        whyText: why?.textContent ?? '',
        noteText: note?.textContent ?? '',
        helpText: help?.textContent ?? '',
        badges: [...row.querySelectorAll('.pbadge')].map((b) => b.textContent ?? ''),
        visibleText: row.innerText,
        title: row.title,
        options:
          ctrl instanceof HTMLSelectElement
            ? [...ctrl.options].map((o) => ({ value: o.value, label: o.textContent ?? '' }))
            : null,
      };
    }
    return out;
  });
}

interface PanelProbe {
  open: boolean;
  phase: string;
  stale: boolean;
  dirty: number;
  badge: string;
  bannerShown: boolean;
  bannerText: string;
  hintShown: boolean;
  hintText: string;
  applyDisabled: boolean;
  applyText: string;
  readDisabled: boolean;
  rowKeys: string[];
  groups: string[];
  worker: Record<string, number | boolean>;
}

function readPanel(page: Page): Promise<PanelProbe> {
  return page.evaluate((): PanelProbe => {
    const wrap = document.getElementById('paramsWrap') as HTMLDetailsElement | null;
    const banner = document.querySelector('#params .pbanner') as HTMLElement | null;
    const hint = document.querySelector('#params .phint') as HTMLElement | null;
    const apply = document.getElementById('paramsApply') as HTMLButtonElement | null;
    const read = document.getElementById('paramsRead') as HTMLButtonElement | null;
    const p = globalThis.cobalt.params;
    return {
      open: wrap?.open ?? false,
      phase: p.phase,
      stale: p.stale,
      dirty: p.dirty,
      badge: document.getElementById('paramsBadge')?.textContent ?? '',
      bannerShown: banner !== null && !banner.hidden,
      bannerText: banner?.textContent ?? '',
      hintShown: hint !== null && !hint.hidden,
      hintText: hint?.textContent ?? '',
      applyDisabled: apply?.disabled ?? true,
      applyText: apply?.textContent ?? '',
      readDisabled: read?.disabled ?? true,
      rowKeys: [...document.querySelectorAll('#params .prow')].map(
        (r) => (r as HTMLElement).dataset['key'] ?? '',
      ),
      groups: [...document.querySelectorAll('#params .pgroup > h4')].map(
        (h) => h.textContent ?? '',
      ),
      worker: p.workerValues as unknown as Record<string, number | boolean>,
    };
  });
}

/**
 * 지금 고른 씬을 **다시 로드한다.** 로드가 끝나는 것뿐 아니라 **되묻기까지**
 * 기다린다 — `show()` 는 `finally` 에서 `syncFromWorker()` 와 `refreshParams()`
 * 를 하고, 그 전에 값을 읽으면 이전 씬의 잔상을 본다 (§10-④ 가 같은 이유로
 * `syncs` 를 기다린다).
 */
async function loadScene(page: Page): Promise<void> {
  const syncs = await page.evaluate(() => globalThis.cobalt.playback.stats.syncs);
  await blur(page);
  await page.click('#load');
  await page.waitForFunction(
    (n: number) =>
      globalThis.cobalt.playback.stats.syncs > n
      && (document.getElementById('status')?.textContent ?? '').includes('로드 완료'),
    syncs,
    { timeout: LOAD_TIMEOUT },
  );
  // 패널이 열려 있으면 `refreshParams()` 가 워커에 다시 묻는다. 그 왕복이 끝나야
  // 화면의 값이 이 씬의 값이다.
  await page.waitForFunction(
    () => globalThis.cobalt.params.phase === 'ready' && !globalThis.cobalt.params.stale,
    null,
    { timeout: 20_000 },
  );
  await sleep(300);
}

/**
 * 재생을 켜고 `target` 프레임까지 프레임마다 정점 표본을 남긴 뒤 정지한다.
 *
 * ⚠️ `stats.lastApplied` 는 **리셋·재로드로 되돌아가지 않는다**(FrameStream 의
 *    누적 계측기다). 그래서 시작 전 값을 `stale` 로 들고 있다가 그 번호는 아예
 *    기록하지 않는다 — 안 그러면 이전 실행의 마지막 프레임(예: 85)이 곧바로
 *    `>= target` 을 만족해 **한 프레임도 안 돌고 끝난다.** 실제로 그렇게 재다가
 *    공통 프레임 0개가 나왔다.
 */
async function runFrames(page: Page, target: number): Promise<Poses> {
  const stale = await page.evaluate(() => globalThis.cobalt.stats.lastApplied);
  await page.evaluate(() => globalThis.cobalt.play(true));
  const poses = await page.evaluate(
    ({ target, stride, stale }: { target: number; stride: number; stale: number | null }) =>
      new Promise<Poses>((resolve, reject) => {
        const c = globalThis.cobalt;
        const rec = new Map<number, number[]>();
        const t0 = Date.now();
        const sample = (): number[] => {
          const out: number[] = [];
          for (const p of c.viewer.cloth.patterns) {
            const a = p.position.array as Float32Array;
            for (let i = 0; i + 2 < a.length; i += stride * 3) {
              out.push(a[i] ?? 0, a[i + 1] ?? 0, a[i + 2] ?? 0);
            }
          }
          return out;
        };
        const tick = (): void => {
          const f = c.stats.lastApplied;
          if (f !== null && f !== stale) {
            // 이 순간의 정점이 곧 프레임 f 의 포즈다 — 다음 프레임은 아직 안 왔다.
            if (!rec.has(f)) rec.set(f, sample());
            if (f >= target) {
              resolve([...rec.entries()]);
              return;
            }
          }
          if (Date.now() - t0 > 90_000) {
            reject(new Error(`프레임이 흐르지 않습니다 — lastApplied=${String(f)}`));
            return;
          }
          requestAnimationFrame(tick);
        };
        tick();
      }),
    { target, stride: POSE_STRIDE, stale },
  );
  await page.evaluate(() => globalThis.cobalt.play(false));
  await sleep(400);
  return poses;
}

interface PoseDiff {
  /** 두 실행에 공통으로 있는 프레임 수 */
  frames: number;
  /** 공통 프레임 전체의 정점 평균 변위 (cm) */
  mean: number;
  max: number;
  /** 정점이 **하나도 안 다른** 프레임 수 */
  identical: number;
  /** 처음으로 갈라진 프레임. 끝까지 같으면 null */
  firstDiff: number | null;
}

function poseDiff(a: Poses, b: Poses): PoseDiff {
  const ma = new Map(a);
  const mb = new Map(b);
  const frames = [...ma.keys()].filter((f) => mb.has(f)).sort((x, y) => x - y);
  let sum = 0;
  let n = 0;
  let max = 0;
  let identical = 0;
  let firstDiff: number | null = null;
  for (const f of frames) {
    const pa = ma.get(f) ?? [];
    const pb = mb.get(f) ?? [];
    let same = true;
    for (let i = 0; i + 2 < Math.min(pa.length, pb.length); i += 3) {
      const d = Math.hypot(
        (pa[i] ?? 0) - (pb[i] ?? 0),
        (pa[i + 1] ?? 0) - (pb[i + 1] ?? 0),
        (pa[i + 2] ?? 0) - (pb[i + 2] ?? 0),
      );
      sum += d;
      n++;
      if (d > max) max = d;
      if (d !== 0) same = false;
    }
    if (same) identical++;
    else if (firstDiff === null) firstDiff = f;
  }
  return { frames: frames.length, mean: n === 0 ? Number.NaN : sum / n, max, identical, firstDiff };
}

function diffText(d: PoseDiff): string {
  return (
    `공통 ${d.frames}프레임 · 평균 ${d.mean.toFixed(6)}cm · 최대 ${d.max.toFixed(6)}cm`
    + ` · 완전히 같은 프레임 ${d.identical}개`
    + ` · 처음 갈라진 프레임 ${d.firstDiff === null ? '없음' : String(d.firstDiff)}`
  );
}

/**
 * [적용] 을 누른다. **잠겨 있으면 누르지 않고 false 를 돌려준다.**
 *
 * `page.click()` 은 비활성 버튼을 30초 기다리다 **던지고**, 그러면 §11 이 통째로
 * 중단되면서 §8(콘솔)·§9 까지 잃는다 — 실측으로 한 번 그렇게 잃었다. §7 이
 * `#mode` 가 숨겨졌을 때 절을 접는 것과 같은 판단이다. 잠긴 사실 자체는 부르는
 * 쪽이 단언한다.
 */
async function clickApply(page: Page): Promise<boolean> {
  const on = await page.evaluate(
    () => !((document.getElementById('paramsApply') as HTMLButtonElement | null)?.disabled ?? true),
  );
  if (!on) return false;
  await page.click('#paramsApply');
  return true;
}

/** 스키마가 정한 사유 문구. **하네스가 문장을 베끼지 않는다** — `params.ts` 가 정본이다 */
function reasonText(key: ParamKey, ctx: ParamContext): string {
  const f = paramField(key);
  return f === null ? '' : (paramDisabledReason(f, ctx)?.text ?? '');
}

/** 위젯 종류의 계약. 스키마의 `kind` 가 화면에서 무엇이 되어야 하는가 */
const WIDGET_OF: Readonly<Record<string, string>> = {
  bool: 'checkbox',
  enum: 'select',
  int: 'number',
  float: 'number',
};

async function sectionParams(page: Page, sent: SentOp[]): Promise<void> {
  section('§11. 파라미터 패널 (#16) — 값을 바꾸면 시뮬이 달라진다');

  /**
   * [적용] 을 누른 자리마다 **무엇이 나가야 하는가**를 적어 둔다. ⑦ 이 실제 WS
   * 프레임과 하나씩 맞댄다 — "바뀐 것만 보낸다" 를 개수가 아니라 **이름**으로
   * 보기 위해서다. 개수만 세면 되돌린 값이 다른 값과 바꿔치기돼도 통과한다.
   */
  const expectedApplies: { label: string; keys: string[] }[] = [];

  await timed('§11 파라미터', async () => {
    // ── ① 접혀 있는 동안은 워커에 묻지 않는다 ────────────────
    //
    // 접힌 패널을 위해 씬을 로드할 때마다 `status`+`getParams` 를 보내는 것은
    // 보이지도 않는 화면을 위한 왕복이다. `main.ts` 는 대신 **낡았다고 표시만**
    // 하고 펼치는 순간 읽는다. 그 판단이 실제로 지켜지는지 본다.
    {
      const before = await readPanel(page);
      check(
        '★ 파라미터 패널이 화면에 있고 **기본은 접혀 있다** (첫 화면을 가리지 않는다)',
        (await page.locator('#paramsWrap').count()) === 1 && !before.open,
        `open=${String(before.open)}`,
      );
      check(
        '★★ 접혀 있는 동안에는 워커에 묻지 않았다 (§1~§10 을 다 지나도 idle 이다 — 안 보이는 화면을 위한 왕복이 없다)',
        before.phase === 'idle' && before.stale,
        `phase=${before.phase} · stale=${String(before.stale)}`,
      );

      // ⚠️ **토글하지 않고 "펼친 상태로 만든다."** 기본값이 열림으로 바뀌면
      //    무턱대고 누르는 코드는 패널을 **닫아 버리고**, 그 뒤의 절이 전부
      //    "버튼이 안 보인다"로 무너진다 (실측으로 한 번 그렇게 됐다).
      //    기본이 접혀 있는지는 위 단언이 이미 따로 지킨다.
      if (!before.open) await page.click('#paramsWrap > summary');
      const ready = await page
        .waitForFunction(() => globalThis.cobalt.params.phase === 'ready', null, { timeout: 20_000 })
        .then(() => true, () => false);
      const after = await readPanel(page);
      check(
        '★★ 펼치는 순간 워커에서 값을 읽는다 (idle → ready)',
        ready && after.phase === 'ready' && !after.stale,
        `phase=${after.phase} · badge "${after.badge}"`,
      );
      check(
        '읽고 나면 배너가 사라진다 (자리채움이라는 경고가 남아 있지 않다)',
        !after.bannerShown,
        after.bannerShown ? `"${after.bannerText}"` : '배너 없음',
      );
      check(
        '갓 읽은 직후에는 보낼 것이 없다 ([적용] 이 잠겨 있다)',
        after.dirty === 0 && after.applyDisabled,
        `dirty=${after.dirty} · "${after.applyText.trim()}"`,
      );
    }

    // ── ② 스키마가 그대로 화면이 된다 ────────────────────────
    //
    // 손으로 22개를 적은 화면이면 "스키마에는 있는데 화면에 없는 필드" 가
    // 생길 수 있다. 목록을 맞대어 그것이 불가능함을 확인한다.
    {
      const panel = await readPanel(page);
      const rows = await readParamRows(page);
      const want = PARAM_FIELDS.map((f) => String(f.key));
      check(
        `★★ 스키마의 필드 ${want.length}개가 그대로 화면의 행이다 (빠진 것도 남는 것도 없다)`,
        panel.rowKeys.join(',') === want.join(','),
        `화면 ${panel.rowKeys.length}행 / 스키마 ${want.length}개`,
      );
      check(
        '그룹 헤더가 스키마의 그룹·순서와 같다',
        panel.groups.join(',') === paramGroups().map((g) => g.label).join(','),
        `[${panel.groups.join(' · ')}]`,
      );

      const wrongWidget = PARAM_FIELDS.filter(
        (f) => rows[String(f.key)]?.widget !== WIDGET_OF[f.kind],
      ).map((f) => `${String(f.key)}:${rows[String(f.key)]?.widget ?? '없음'}≠${WIDGET_OF[f.kind]}`);
      check(
        '★ 위젯 종류가 스키마의 kind 와 맞는다 (bool→체크박스 · enum→콤보 · 숫자→number)',
        wrongWidget.length === 0,
        wrongWidget.join(', ') || `${PARAM_FIELDS.length}개 일치`,
      );

      // 열거형 라벨은 **코드 근거가 있는 값**이다(`MainGUI.cpp` 의 배열 +
      // `zsSimulation.h` 의 enum). 한 칸이라도 밀리면 사용자가 고른 것과 다른
      // 솔버가 걸린다 — 화면만 봐서는 절대 안 보이는 종류의 실패다.
      const badEnum = PARAM_FIELDS.filter((f) => f.kind === 'enum').filter((f) => {
        const got = rows[String(f.key)]?.options ?? [];
        const wantOpts = f.options ?? [];
        return (
          got.length !== wantOpts.length
          || wantOpts.some((o, i) => got[i]?.value !== String(o.value) || got[i]?.label !== o.label)
        );
      }).map((f) => String(f.key));
      check(
        '★★ 콤보의 선택지가 스키마의 값·라벨·순서와 정확히 같다 (한 칸 밀리면 다른 솔버가 걸린다)',
        badEnum.length === 0,
        badEnum.join(', ') || '적분기 3 · 전처리기 3 · 커플링 5×2',
      );

      // 슬라이더는 **범위와 스텝이 다 있을 때만** 만든다. `solverTolerance` 는
      // 1e-10..1 이라 선형 슬라이더로 훑는 것이 무의미하다(스키마의 판단).
      const wantSlider = PARAM_FIELDS.filter(
        (f) => f.kind !== 'bool' && f.kind !== 'enum' && f.step !== null && f.min !== null && f.max !== null,
      ).map((f) => String(f.key));
      const gotSlider = Object.entries(rows).filter(([, r]) => r.hasSlider).map(([k]) => k);
      check(
        '★ 슬라이더는 범위·스텝이 다 있는 숫자 필드에만 붙는다 (허용 오차 1e-10..1 은 숫자 입력이다)',
        gotSlider.sort().join(',') === wantSlider.sort().join(','),
        `슬라이더 ${gotSlider.length}개 · 없는 것 [${PARAM_FIELDS.filter((f) => !gotSlider.includes(String(f.key)) && f.kind !== 'bool' && f.kind !== 'enum').map((f) => String(f.key)).join(',')}]`,
      );

      const noHelp = PARAM_FIELDS.filter((f) => (rows[String(f.key)]?.helpText ?? '') !== f.description);
      check(
        '모든 행에 스키마의 설명이 글자로 붙어 있다',
        noHelp.length === 0,
        noHelp.map((f) => String(f.key)).join(', ') || `${PARAM_FIELDS.length}개`,
      );
    }

    // ── ③ 비활성에는 **이유가 화면에 글자로** 남는다 ─────────
    //
    // ★ 이 절이 §11 의 두 번째 이유다. 회색으로만 만들고 이유를 안 적으면
    //   그게 #14 가 없애려던 거짓말이고, `title`(툴팁)에만 넣는 것은 "보인다"
    //   가 아니다 — 마우스를 올려야 보이는 것은 화면에 없는 것과 같다.
    //
    // 문구를 하네스에 베껴 넣지 않는다. 스키마(`params.ts`)가 정본이고 여기서는
    // **그 문자열이 화면에 있는지**만 본다. 그래서 문장이 바뀌어도 안 깨진다.
    {
      // ⚠️ §10 이 마지막에 씬을 다시 로드하므로 **지금은 시뮬이 초기화 전이다**
      //    (워커의 `load` 가 `simInitialized` 를 false 로 되돌린다 — 실측).
      //    적분기 잠금은 상태를 만들어야 보이므로 아래에서 따로 다룬다.
      const st = await page.evaluate(() => globalThis.cobalt.client.status());
      check(
        '전제 — 지금은 시뮬이 초기화 전이다 (§10 이 마지막에 재로드했다)',
        !st.simInitialized,
        `simInitialized=${String(st.simInitialized)}`,
      );
      const ctx: ParamContext = { values: { useWind: false }, simInitialized: st.simInitialized };
      const rows = await readParamRows(page);

      // (a) 어느 필드에 어느 종류의 사유가 붙는가 — **계약**
      const cases: [ParamKey, string][] = [
        ['subStep', '엔진 미지원'],
        ['meshingEdgeLength', '엔진 미지원'],
        ['windMagnitude', '종속 미충족'],
      ];
      for (const [key, kind] of cases) {
        const r = rows[String(key)];
        const want = reasonText(key, ctx);
        check(
          `★★ ${key} (${kind}) — 위젯이 잠기고 **이유가 화면 글자로** 있다`,
          r !== undefined && r.disabled && r.whyShown && r.whyText.includes(want),
          r === undefined ? '행이 없다' : `disabled=${String(r.disabled)} · 보임=${String(r.whyShown)} · "${r.whyText}"`,
        );
        check(
          `★★★ ${key} — 그 이유가 **title 이 아니라 화면에 렌더된 글자**다 (마우스를 올려야 보이는 건 보이는 게 아니다)`,
          r !== undefined && want.length > 8 && r.visibleText.includes(want),
          r === undefined ? '행이 없다' : `innerText 안에 있음=${String(r.visibleText.includes(want))} · title="${r.title.slice(0, 24)}…"`,
        );
      }
      // 슬라이더가 있는 죽은 필드는 슬라이더까지 잠겨야 한다 — 숫자 칸만 잠그면
      // 슬라이더로 값을 바꿀 수 있게 된다.
      const dead = rows['meshingEdgeLength'];
      check(
        '★ 죽은 필드는 슬라이더까지 잠긴다 (숫자 칸만 잠그면 옆의 슬라이더로 만질 수 있다)',
        dead?.sliderDisabled === true,
        `slider disabled=${String(dead?.sliderDisabled)}`,
      );

      // (b) 죽은 것과 조건부는 **배지로도** 갈린다
      check(
        '★ 죽은 필드 2개에 "엔진 미지원" 배지가 붙어 있다',
        ['subStep', 'meshingEdgeLength'].every((k) => (rows[k]?.badges ?? []).includes('엔진 미지원')),
        `subStep [${(rows['subStep']?.badges ?? []).join('|')}] · meshingEdgeLength [${(rows['meshingEdgeLength']?.badges ?? []).join('|')}]`,
      );
      check(
        '★★ 조건부 2개(바닥면·바닥 마찰)는 **끄지 않고** 배지와 근거만 붙인다 (조건을 프런트가 알 수 없다 — 모르면서 끄면 만질 수 있는 걸 못 만지게 된다)',
        ['groundPlane', 'groundFriction'].every((k) => {
          const r = rows[k];
          return r !== undefined && !r.disabled && r.badges.includes('조건부') && !r.whyShown;
        }),
        ['groundPlane', 'groundFriction'].map((k) => `${k}: 잠김=${String(rows[k]?.disabled)} 배지[${(rows[k]?.badges ?? []).join('|')}]`).join(' · '),
      );
      const noteMissing = PARAM_FIELDS.filter((f) => f.note !== null)
        .filter((f) => !(rows[String(f.key)]?.visibleText ?? '').includes(f.note ?? ''))
        .map((f) => String(f.key));
      check(
        '★ 실측 단서(note)가 있는 필드는 그 단서가 화면 글자로 보인다 ("이 씬에서 미검증 — 9.27cm 떠 있다"가 여기 있다)',
        noteMissing.length === 0,
        noteMissing.join(', ') || `${PARAM_FIELDS.filter((f) => f.note !== null).length}개`,
      );

      // (c) ★ 대조군 — 전부 회색으로 만드는 구현이 아니다
      const shouldBeFree = PARAM_FIELDS.filter(
        (f) => !cases.some(([k]) => k === f.key),
      ).map((f) => String(f.key));
      const wronglyOff = shouldBeFree.filter((k) => {
        const r = rows[k];
        return r === undefined || r.disabled || r.whyShown;
      });
      check(
        `★★ 대조군 — 나머지 ${shouldBeFree.length}개는 전부 열려 있고 사유가 없다 (모두 잠그는 구현이면 위 판정이 무의미하다)`,
        wronglyOff.length === 0,
        wronglyOff.join(', ') || `${shouldBeFree.length}개 활성`,
      );

    }

    // ── ③-b 🔒 잠금이 **워커의 전이를 따라간다** ──────────────
    //
    // 위 셋과 달리 이 사유는 워커의 `status.simInitialized` 에서만 온다. 그리고
    // 그 값은 **정적이 아니다.** [실측] load false · start **true** · pause
    // true(유지) · reset **false** · clear false.
    //
    // ★ 그래서 잠기는 것만 보면 절반이다. **리셋에서 풀리는 것까지** 봐야 한다 —
    //   잠기고 안 풀리면 반대 방향의 거짓말이고, 그건 잠금을 아예 안 하는 것만큼
    //   나쁘다(만질 수 있는 것을 못 만지게 만든다).
    //
    // ── ★ 그리고 잠그는 것만으로는 결함이 한 칸 뒤로 밀릴 뿐이다 ──
    //
    // 재생 **전에** 적분기를 바꿔 뒀다면 위젯이 회색이 되어도 `#pending` 에 값이
    // 남아 `dirty` 가 서 있고, [적용] 이 그 값을 워커로 보낸다. `params.ts` 가
    // "잠긴 필드도 보낸다" 고 정한 근거가 **"화면이 못 만들게 막은 값은 애초에
    // 이 맵에 들어오지 않는다"** 인데, 그 전제를 화면이 안 지키면 스키마의 판단이
    // 통째로 무너진다. 그래서 **되돌리는지**까지 여기서 본다.
    //
    // ⚠️ **대조군을 같이 안 보면 "전부 되돌린다" 는 구현이 통과한다.** 되돌려야
    //    하는 것은 `simInitialized` 로 잠긴 것뿐이고, **`dependency` 로 잠긴
    //    `windMagnitude` 는 되돌리면 안 된다**(스키마가 "빼면 바람을 켠 순간 옛
    //    세기가 살아난다" 고 명시했다). 둘 다 "회색인데 편집이 남아 있는" 같은
    //    모양이라, 원인을 안 보고 잠긴 것을 전부 쓸어 담으면 대조군이 무너진다.
    {
      const lockCtx: ParamContext = { values: {}, simInitialized: true };
      const lockText = reasonText('solverType', lockCtx);
      const enter = await readParamRows(page);
      const enterPanel = await readPanel(page);
      check(
        '전제 — 로드 직후라 적분기가 열려 있고 보낼 변경이 없다',
        enter['solverType']?.disabled === false && enterPanel.dirty === 0,
        `solverType 잠김=${String(enter['solverType']?.disabled)} · dirty=${enterPanel.dirty}`,
      );

      // ① 대조군을 만든다 — **종속으로 잠긴 채 편집이 남아 있는 필드.**
      //    바람을 켜서 세기를 만진 뒤 다시 끄면, 세기는 회색인데 `#pending` 에는
      //    77 이 남는다. 잠긴 원인이 `dependency` 라 되돌아오면 안 되는 값이다.
      await page.check('#p-useWind');
      await page.locator('#params .prow[data-key="windMagnitude"] input[type="number"]').fill('77');
      await page.keyboard.press('Tab');
      await page.uncheck('#p-useWind');
      const armed = await readParamRows(page);
      const armedPanel = await readPanel(page);
      check(
        '전제(대조군) — 종속으로 잠긴 바람 세기에 **아직 안 보낸 편집**이 남아 있다',
        armed['windMagnitude']?.disabled === true && armed['windMagnitude'].value === '77'
        && armedPanel.dirty === 1,
        `windMagnitude 잠김=${String(armed['windMagnitude']?.disabled)} 값=${armed['windMagnitude']?.value ?? '-'} · dirty=${armedPanel.dirty}`,
      );

      // ② 재생 전에 적분기를 바꿔 둔다 — 이 값이 워커로 나가면 안 된다.
      const wasSolver = String(enterPanel.worker['solverType']);
      const other = (paramField('solverType')?.options ?? [])
        .map((o) => String(o.value)).find((v) => v !== wasSolver) ?? '1';
      await page.selectOption('#p-solverType', other);
      const edited = await readParamRows(page);
      const editedPanel = await readPanel(page);
      check(
        '전제 — 재생 전에는 적분기를 만질 수 있고 그 편집이 화면에 남는다',
        edited['solverType']?.disabled === false && edited['solverType'].value === other
        && editedPanel.dirty === 2,
        `solverType ${wasSolver} → ${edited['solverType']?.value ?? '-'} · dirty=${editedPanel.dirty}`,
      );

      // ③ [▶ 재생] — **아무 것도 대신 눌러 주지 않는다.** 예전에는 [워커에서
      //    읽기] 를 눌러야 잠겼고, 그것이 결함이었다.
      await ensurePlaying(page, true);
      const gotLocked = await page
        .waitForFunction(
          () => (document.getElementById('p-solverType') as HTMLSelectElement | null)?.disabled === true,
          null,
          { timeout: 20_000 },
        )
        .then(() => true, () => false);
      const said = await page.evaluate(() => ({
        status: document.getElementById('status')?.textContent ?? '',
        log: (document.getElementById('log')?.textContent ?? '').split('\n').slice(-12).join(' | '),
      }));
      const playing = await readParamRows(page);
      const playingPanel = await readPanel(page);
      const ran = await page.evaluate(() => globalThis.cobalt.client.status());
      check(
        '전제 — 재생하면 워커의 시뮬이 초기화 상태가 된다',
        ran.simInitialized,
        `simInitialized=${String(ran.simInitialized)}`,
      );
      check(
        '★★★★ [▶ 재생] 하나로 적분기가 잠긴다 — 아무 버튼도 대신 누르지 않았다 (예전에는 [워커에서 읽기] 를 눌러야 잠겼고 그게 결함이었다)',
        gotLocked && playing['solverType']?.disabled === true,
        `잠김=${String(playing['solverType']?.disabled)} · ${gotLocked ? '재생 직후' : '20초 안에 안 잠김'}`,
      );
      check(
        '★★ 그 이유가 화면 글자로 뜬다 (title 이 아니다)',
        playing['solverType']?.whyShown === true
        && (playing['solverType'].whyText.includes(lockText))
        && playing['solverType'].visibleText.includes(lockText),
        `"${playing['solverType']?.whyText ?? ''}"`,
      );
      check(
        '★★★★ 잠긴 필드의 **아직 안 보낸 편집이 워커 값으로 되돌아온다** (회색인데 [적용] 이 그 값을 보내면 잠금이 결함을 한 칸 미룬 것에 지나지 않는다)',
        playing['solverType']?.value === wasSolver && playingPanel.dirty === 1,
        `solverType ${other} → ${playing['solverType']?.value ?? '-'} (워커 ${wasSolver}) · dirty ${editedPanel.dirty} → ${playingPanel.dirty}`,
      );
      check(
        '★★★ 되돌린 사실을 화면이 말한다 (사용자가 맞춰 둔 값이 조용히 사라지면 그게 또 하나의 거짓말이다)',
        said.status.includes('되돌') || said.log.includes('되돌'),
        `상태줄 "${said.status}"`,
      );
      check(
        '★★★★ 대조군 — **종속으로** 잠긴 바람 세기의 편집은 되돌리지 않는다 (되돌리면 바람을 켠 순간 옛 세기가 살아난다 — 잠긴 것을 전부 쓸어 담는 구현을 여기서 가른다)',
        playing['windMagnitude']?.value === '77' && playing['windMagnitude'].disabled === true,
        `windMagnitude=${playing['windMagnitude']?.value ?? '-'} (잠김=${String(playing['windMagnitude']?.disabled)})`,
      );

      // ④ ★ 폴링이 생기지 않았는가 — **프레임이 흐르는 동안 왕복이 없어야 한다.**
      //    잠금을 되묻는 코드가 `paintPlayback` 에 붙었는데, 그 함수는 프레임
      //    경로에서도 불린다. 조건을 잘못 잡으면 프레임 하나마다 `status` 왕복이
      //    하나씩 생기고, 그건 새 결함이다. 선 위에서 직접 센다.
      //
      // ⚠️ **고정 3초로 재지 않는다 — 창을 시간이 아니라 프레임으로 닫는다.**
      //    이 절이 쓰는 씬은 패턴 24개짜리라 초당 5~8프레임이고(가벼운
      //    `sample.zls` 의 40/s 가 아니다), 3초 창에 담기는 프레임 수가 머신
      //    부하에 따라 흔들린다 — 같은 트리에서 16·18·24·24·25건을 봤다. 전제가
      //    `>= 20` 이라 문턱 위에 걸터앉아 있었고, 실제로 빨간불이 났다.
      //    **문턱만 낮추는 것은 답이 아니다**: 다음에 또 걸치고, 그 사이 전제의
      //    이빨("아무 일도 없는 구간을 잰 것이 아니다")이 같이 무뎌진다.
      //    그래서 **프레임 20건이 쌓일 때까지 기다린다.** 전제가 조건이 아니라
      //    **대기 종료 사유**가 되고, 본 단언은 그 창 안에서 재면 된다.
      //    누수는 프레임당 1건이므로 창이 짧아도 20건이면 20건이 잡힌다 —
      //    오히려 시간이 아니라 프레임에 묶여서 더 단단하다.
      //    최소 3초는 그대로 둔다: 프레임과 무관한 시간 기반 폴링
      //    (`setInterval` 로 status 를 되묻는 구현)도 같이 덮으려는 것이다.
      //    20건이 25초 안에 안 쌓이면 그건 흔들림이 아니라 **시뮬이 멎은 것**이고,
      //    그때는 전제가 빨간불이 되는 것이 맞다.
      const NEED_FRAMES = 20;
      const MIN_WINDOW_MS = 3_000;
      const MAX_WINDOW_MS = 25_000;
      const statusBefore = sent.filter((s) => s.op === 'status').length;
      const appliedBefore = (await readStats(page)).applied;
      const windowStart = Date.now();
      let frames = 0;
      let windowMs = 0;
      for (;;) {
        // `readStats` 는 화면 안의 계측기를 읽을 뿐 선 위로 아무것도 보내지
        // 않는다 — 폴링하는 이 루프 자체가 `status` 왕복을 만들지는 않는다.
        await sleep(250);
        frames = (await readStats(page)).applied - appliedBefore;
        windowMs = Date.now() - windowStart;
        if (windowMs >= MAX_WINDOW_MS) break;
        if (frames >= NEED_FRAMES && windowMs >= MIN_WINDOW_MS) break;
      }
      const statusAfter = sent.filter((s) => s.op === 'status').length;
      check(
        '전제 — 그 창 동안 프레임이 실제로 흘렀다 (아무 일도 없는 구간을 잰 것이 아니다 — 프레임 20건이 쌓일 때까지 기다린 창이다)',
        frames >= NEED_FRAMES,
        `프레임 ${frames}건 / ${ms(windowMs)} (25초 안에 20건이 안 쌓이면 흔들림이 아니라 시뮬이 멎은 것이다)`,
      );
      check(
        '★★★★ 재생 중에 status 왕복이 늘지 않는다 (잠금 되묻기가 프레임 경로로 새면 프레임 하나마다 왕복이 하나씩 생긴다)',
        statusAfter - statusBefore === 0,
        `${ms(windowMs)} · 프레임 ${frames}건 · status op ${statusAfter - statusBefore}건`,
      );

      // ⑤ [⏸ 정지] — 시뮬은 여전히 초기화된 상태다. 잠금이 풀리면 안 된다.
      await ensurePlaying(page, false);
      await sleep(500);
      const paused = await readParamRows(page);
      const pausedStatus = await page.evaluate(() => globalThis.cobalt.client.status());
      check(
        '★★ [⏸ 정지] 해도 잠금은 유지된다 (시뮬은 여전히 초기화 상태다 — 워커가 그렇게 답한다)',
        paused['solverType']?.disabled === true && pausedStatus.simInitialized,
        `잠김=${String(paused['solverType']?.disabled)} · simInitialized=${String(pausedStatus.simInitialized)}`,
      );

      // ⑥ [적용] — 되돌린 값이 **선 위에** 없는지는 ⑦ 이 프레임을 열어 본다.
      const pressed = await clickApply(page);
      if (pressed) {
        await page
          .waitForFunction(() => globalThis.cobalt.params.dirty === 0, null, { timeout: 30_000 })
          .then(() => true, () => false);
      }
      expectedApplies.push({ label: '잠금 뒤 적용 (되돌린 적분기는 빠진다)', keys: ['windMagnitude'] });
      const sentPanel = await readPanel(page);
      check(
        '★★ 되돌린 뒤 남은 것만 보내진다 (바람 세기 1건 — 적분기는 보낼 것이 없다)',
        pressed && sentPanel.dirty === 0 && sentPanel.worker['windMagnitude'] === 77,
        `눌림=${String(pressed)} · dirty=${sentPanel.dirty} · 워커 windMagnitude=${String(sentPanel.worker['windMagnitude'])}`,
      );

      // ⑦ [↺ 리셋] — **풀리는 방향.** 워커가 `simInitialized` 를 false 로 되돌린다.
      await blur(page);
      await page.click('#reset');
      const unlocked = await page
        .waitForFunction(
          () => (document.getElementById('p-solverType') as HTMLSelectElement | null)?.disabled === false,
          null,
          { timeout: 20_000 },
        )
        .then(() => true, () => false);
      const afterReset = await readParamRows(page);
      const resetStatus = await page.evaluate(() => globalThis.cobalt.client.status());
      check(
        '★★★★ [↺ 리셋] 하면 잠금이 **풀린다** (잠기고 안 풀리면 반대 방향의 거짓말이다 — 만질 수 있는 것을 못 만지게 만든다)',
        unlocked && afterReset['solverType']?.disabled === false
        && !afterReset['solverType'].whyShown,
        `잠김=${String(afterReset['solverType']?.disabled)} · 사유 보임=${String(afterReset['solverType']?.whyShown)}`,
      );
      check(
        '★★ 그리고 그것이 워커의 사실과 같다 (화면이 혼자 판단한 것이 아니다)',
        !resetStatus.simInitialized,
        `워커 simInitialized=${String(resetStatus.simInitialized)}`,
      );
    }

    // ── ④ 종속이 **그 자리에서** 풀린다 ──────────────────────
    //
    // 배선 검증이다. `disabledParams()` 를 편집할 때마다 다시 돌리지 않으면
    // 바람을 켜도 세기가 회색인 채로 남는다 — 사용자는 무엇을 더 해야 하는지
    // 알 수 없고, 워커 왕복 한 번 없이 화면 안에서 끝나야 하는 일이다.
    {
      const before = (await readParamRows(page))['windMagnitude'];
      await page.check('#p-useWind');
      const on = (await readParamRows(page))['windMagnitude'];
      check(
        '★★★ [바람 사용] 을 켜면 **그 자리에서** 바람 세기의 잠금이 풀리고 사유가 사라진다 (워커 왕복 없이)',
        before?.disabled === true && on?.disabled === false && !on.whyShown,
        `잠김 ${String(before?.disabled)} → ${String(on?.disabled)} · 사유 보임 ${String(before?.whyShown)} → ${String(on?.whyShown)}`,
      );
      await page.uncheck('#p-useWind');
      const off = (await readParamRows(page))['windMagnitude'];
      check(
        '★ 다시 끄면 도로 잠기고 이유가 돌아온다 (한 방향만 되는 구현이 아니다)',
        off?.disabled === true && off.whyShown,
        `잠김=${String(off?.disabled)} · "${off?.whyText ?? ''}"`,
      );
      const panel = await readPanel(page);
      check(
        '체크박스를 원래대로 돌려놓으면 보낼 변경도 없어진다',
        panel.dirty === 0,
        `dirty=${panel.dirty}`,
      );
    }

    // ── ④-b 값을 고쳤으면 **고쳤다고 화면이 말한다** ─────────
    //
    // `coerceParamValue` 가 사용자 입력을 조용히 바꾸는 것이 가장 나쁜 거짓말이
    // 될 수 있는 자리다. 스모크 §11-4 가 그 함수의 `reason` 을 22×적대적 입력으로
    // 덮지만, **그 문자열이 화면에 뜨는가**는 여기서만 보인다.
    // 사유가 둘 겹치는 입력을 쓴다(반올림 + 클램프) — 하나만 남기면 사용자가
    // 넣은 소수가 어디로 갔는지 화면 어디에도 안 남는다.
    {
      await page.locator('#params .prow[data-key="nonlinearIterations"] input[type="number"]').fill('400.6');
      await page.keyboard.press('Tab');
      const r = (await readParamRows(page))['nonlinearIterations'];
      const fixed = await page.evaluate(() => {
        const el = document.querySelector('.prow[data-key="nonlinearIterations"] .pfix') as HTMLElement | null;
        return { hidden: el?.hidden ?? true, text: el?.textContent ?? '' };
      });
      check(
        '★★ 범위 밖 입력은 화면에서 곧바로 고쳐지고 **무엇을 어떻게 고쳤는지 글자로** 남는다 (반올림·클램프 두 사유가 다 남는다)',
        r?.value === '200' && !fixed.hidden
        && fixed.text.includes('반올림') && fixed.text.includes('200'),
        `400.6 → ${r?.value ?? '-'} · "${fixed.text}"`,
      );
      check(
        '★ 그 글자도 title 이 아니라 화면에 렌더돼 있다',
        r !== undefined && fixed.text.length > 0 && r.visibleText.includes(fixed.text),
        `innerText 안에 있음=${String(r?.visibleText.includes(fixed.text))}`,
      );
      await page.click('#paramsRead');
      await page.waitForFunction(() => globalThis.cobalt.params.dirty === 0, null, { timeout: 20_000 });
    }

    // ── ⑤ 값의 출처가 워커다 ────────────────────────────────
    //
    // **씬마다 값이 다르다**는 것이 이 판정의 이빨이다. `timeStep` 의 자리채움은
    // 45(=`W_Bra top & Leggings.zls` 의 실측치)이므로, 자리채움을 그리는
    // 구현이라도 이 씬에서는 45 가 나와 통과한다. `sample.zls` 는 30 이다 —
    // **씬을 바꿔야만** 자리채움과 워커의 값이 갈린다.
    {
      const live = await page.evaluate(() => globalThis.cobalt.client.getParams());
      const rows = await readParamRows(page);
      const off = PARAM_FIELDS.filter((f) => {
        const r = rows[String(f.key)];
        if (r === undefined) return true;
        const w = (live as unknown as Record<string, unknown>)[String(f.key)];
        return f.kind === 'bool' ? r.value !== String(w) : Number(r.value) !== Number(w);
      }).map((f) => String(f.key));
      check(
        '★★ 화면의 22개 값이 **지금 워커에 물어본 값**과 하나도 다르지 않다 (패널의 믿음이 아니라 독립적인 왕복으로 확인한다)',
        off.length === 0,
        off.join(', ') || `${PARAM_FIELDS.length}개 일치`,
      );

      const scenes = await page.evaluate(() =>
        [...document.querySelectorAll('#scene option')].map((o) => ({
          value: (o as HTMLOptionElement).value,
          text: o.textContent ?? '',
        })),
      );
      const here = await page.evaluate(() => (document.getElementById('scene') as HTMLSelectElement).value);
      const other = scenes.find((s) => s.value !== here && s.value !== '');
      if (other === undefined) {
        note('씬 전환 판정', '씬이 하나뿐이라 건너뛴다 — 자리채움과 워커 값이 갈리려면 씬이 둘 이상이어야 한다');
      } else {
        const fallback = paramField('timeStep')?.fallback;
        const hereValue = rows['timeStep']?.value ?? '';
        await page.selectOption('#scene', other.value);
        await loadScene(page);
        const swapped = await readParamRows(page);
        const shown = Number(swapped['timeStep']?.value ?? Number.NaN);
        const worker = (await page.evaluate(() => globalThis.cobalt.client.getParams())).timeStep;
        check(
          '★★★ 씬을 바꾸면 화면의 값이 **그 씬의 워커 값**으로 갈아 끼워진다 (자리채움을 씬의 값인 척 보여주지 않는다)',
          shown === Number(worker) && shown !== Number(fallback),
          `${other.text.split(' ')[0] ?? ''} timeStep — 화면 ${shown} · 워커 ${String(worker)} · 자리채움 ${String(fallback)}`,
        );
        // 새로 로드한 씬은 아직 시뮬이 초기화되지 않았다 → 적분기 잠금이 풀린다.
        // ③ 의 잠금 판정이 "항상 잠긴 위젯" 을 본 것이 아님을 여기서 확인한다.
        const st = await page.evaluate(() => globalThis.cobalt.client.status());
        check(
          '★★ 대조군 — 갓 로드한 씬은 시뮬이 초기화 전이라 **적분기 잠금이 풀린다** (③ 의 🔒 는 항상 잠긴 위젯이 아니다)',
          !st.simInitialized && swapped['solverType']?.disabled === false && !swapped['solverType'].whyShown,
          `simInitialized=${String(st.simInitialized)} · solverType 잠김=${String(swapped['solverType']?.disabled)}`,
        );
        await page.selectOption('#scene', here);
        await loadScene(page);
        const back = await readParamRows(page);
        check(
          '★ 원래 씬으로 돌아오면 값도 원래대로 돌아온다 (한 방향만 따라가는 구현이 아니다)',
          back['timeStep']?.value === hereValue && hereValue !== String(shown),
          `timeStep ${hereValue} → ${shown} → ${back['timeStep']?.value ?? '-'}`,
        );
      }
    }

    // ── ⑥ ★★★ 통과 기준 — 슬라이더가 시뮬을 바꾼다 ──────────
    let sliderApplied = 0;
    {
      // A. 방금 로드한 상태 그대로 60프레임
      const A = await runFrames(page, RUN_FRAMES);
      note('기준선 A', `${A.length}프레임 · 프레임마다 정점 표본 ${(A[0]?.[1].length ?? 0) / 3}개`);

      // B. 다시 로드해서 **같은 파라미터로** 한 번 더 — 이 측정에 이빨이 있는가
      await loadScene(page);
      const B = await runFrames(page, RUN_FRAMES);
      const ctrl = poseDiff(A, B);
      check(
        '★★★ 대조군 — 같은 파라미터로 다시 돌리면 정점이 **비트 단위로** 같다 (그래서 아래 판정에 지터 여유가 필요 없다)',
        ctrl.frames > RUN_FRAMES / 2 && ctrl.max === 0,
        diffText(ctrl),
      );

      // C. 다시 로드하고 **슬라이더로** 드레이핑 시간을 끝까지 민다
      await loadScene(page);
      const fresh = await readParamRows(page);
      const slider = page.locator('#params .prow[data-key="drapingTime"] input[type="range"]');
      await slider.focus();
      // End = 최댓값. 진짜 키 입력이라 `input` 이벤트가 위젯에서 그대로 난다.
      await page.keyboard.press('End');
      const slid = await readParamRows(page);
      const panelAfterSlide = await readPanel(page);
      check(
        '★★ 슬라이더를 움직이면 옆의 숫자 칸이 따라온다 (한 값을 가리키는 두 위젯이 갈라지지 않는다)',
        slid['drapingTime']?.value === slid['drapingTime']?.sliderValue
        && slid['drapingTime']?.value !== fresh['drapingTime']?.value,
        `${fresh['drapingTime']?.value ?? '-'} → 숫자 ${slid['drapingTime']?.value ?? '-'} / 슬라이더 ${slid['drapingTime']?.sliderValue ?? '-'}`,
      );
      check(
        '★ 아직 보내기 전이라는 것이 화면에 있다 ([적용 (1)] 이 열리고 변경 수가 뜬다)',
        panelAfterSlide.dirty === 1 && !panelAfterSlide.applyDisabled
        && panelAfterSlide.applyText.includes('1'),
        `dirty=${panelAfterSlide.dirty} · "${panelAfterSlide.applyText.trim()}" · badge "${panelAfterSlide.badge}"`,
      );

      const pressed = await clickApply(page);
      const settled = pressed && await page
        .waitForFunction(
          () => globalThis.cobalt.params.dirty === 0 && globalThis.cobalt.params.phase === 'ready',
          null,
          { timeout: 30_000 },
        )
        .then(() => true, () => false);
      expectedApplies.push({ label: '슬라이더로 바꾼 드레이핑 시간', keys: ['drapingTime'] });
      const applied = await readPanel(page);
      const appliedRows = await readParamRows(page);
      const wantValue = Number(slid['drapingTime']?.value ?? Number.NaN);
      check(
        '★★ [적용] 뒤 화면이 **워커에서 되읽은 값**으로 덮인다 (#14 의 규칙 — 믿음이 아니라 사실을 보여준다)',
        settled && applied.worker['drapingTime'] === wantValue
        && Number(appliedRows['drapingTime']?.value ?? Number.NaN) === wantValue,
        `보냄 ${wantValue} · 워커 ${String(applied.worker['drapingTime'])} · 화면 ${appliedRows['drapingTime']?.value ?? '-'}`,
      );
      sliderApplied = wantValue;

      const C = await runFrames(page, RUN_FRAMES);
      const eff = poseDiff(A, C);
      check(
        '★★★★ #16 의 통과 기준 — **슬라이더로 바꾼 값이 시뮬을 실제로 바꾼다** (대조군이 0cm 인 같은 측정에서 정점이 움직였다)',
        eff.frames > RUN_FRAMES / 2 && eff.max > 0 && eff.mean > 0.1,
        diffText(eff),
      );
      check(
        '★★ 그 변화가 물리적으로 말이 된다 — 초기 몇 프레임은 **그대로 같다가** 도중에 갈라진다 (전 프레임이 어긋나면 씬이나 초기 포즈가 달라진 것이다)',
        eff.identical > 0 && eff.firstDiff !== null && eff.firstDiff > 0,
        `프레임 0..${(eff.firstDiff ?? 1) - 1} 은 정점까지 같고 ${String(eff.firstDiff)} 부터 갈라진다`
        + ` (드레이핑 0.4초 × 45Hz ≈ 18프레임)`,
      );

      // D. 체크박스도 같은 길을 지나는가. `useIEQS` 는 ISSUE-014 전수 측정에서
      //    영향이 가장 컸던 필드다(평균 5.51cm).
      await loadScene(page);
      await page.check('#p-useIEQS');
      if (await clickApply(page)) {
        await page
          .waitForFunction(() => globalThis.cobalt.params.dirty === 0, null, { timeout: 30_000 })
          .then(() => true, () => false);
      }
      expectedApplies.push({ label: '체크박스로 켠 준정적', keys: ['useIEQS'] });
      const afterCheck = await readPanel(page);
      check(
        '★ 체크박스도 워커에 걸린다 (준정적 false → true)',
        afterCheck.worker['useIEQS'] === true,
        `워커 useIEQS=${String(afterCheck.worker['useIEQS'])}`,
      );
      const D = await runFrames(page, RUN_FRAMES);
      const eff2 = poseDiff(A, D);
      check(
        '★★★ 체크박스 하나로도 시뮬이 달라진다 (준정적 — ISSUE-014 전수 측정에서 영향이 가장 컸던 필드)',
        eff2.max > 0 && eff2.mean > 0.1,
        diffText(eff2),
      );
      note(
        '두 실험의 크기',
        `드레이핑 시간 0.4→${sliderApplied}: 평균 ${eff.mean.toFixed(2)}cm · 준정적 off→on: 평균 ${eff2.mean.toFixed(2)}cm`
        + ` (ISSUE-014 의 100프레임 실측은 각각 4.94cm · 5.51cm — 여기서는 ${RUN_FRAMES}프레임이다)`,
      );
    }

    // ── ⑦ 죽은 필드가 **선 위에** 없다 ───────────────────────
    //
    // 스모크 §11-6 은 `buildSetParamsPayload` 가 죽은 필드를 빼는 것까지 본다.
    // 여기서 보는 것은 **화면이 그 함수를 실제로 지나는가**다. 위젯 상태 맵을
    // `client.setParams()` 로 곧바로 넘기는 구현이면 스모크는 전부 초록이고
    // 죽은 필드는 조용히 워커로 나간다.
    {
      const setOps = sent.filter((s) => s.op === 'setParams');
      const payloads = setOps.map((s) => s.params ?? {});
      check(
        '전제 — 이 절에서 setParams 가 실제로 선을 지났다',
        setOps.length >= 3,
        `${setOps.length}건 · 키 ${payloads.map((p) => `{${Object.keys(p).join(',')}}`).join(' / ')}`,
      );
      const keys = payloads.flatMap((p) => Object.keys(p));
      const deadKeys = PARAM_FIELDS.filter((f) => f.effect === 'dead').map((f) => String(f.key));
      check(
        '★★★ 죽은 필드가 **워커로 나간 어떤 프레임에도** 없다 (워커는 받으면 "적용됨" 이라 답하고 물리는 그 값을 보지 않는다)',
        deadKeys.every((k) => !sent.some((s) => s.raw.includes(`"${k}"`))),
        `찾은 것: [${deadKeys.filter((k) => sent.some((s) => s.raw.includes(`"${k}"`))).join(', ')}] / 전체 프레임 ${sent.length}건`,
      );

      // ★★ 잠긴 뒤 **되돌린** 값이 선에 없는가. ③-b 가 화면에서 되돌아온 것을
      //    봤고, 여기서는 그것이 정말 안 나갔는지를 선에서 확인한다 — 화면만
      //    되돌리고 `#pending` 에는 남기는 구현이면 여기서만 드러난다.
      //    **대조군이 같은 줄에 있다**: 되돌리면 안 되는 `windMagnitude` 는
      //    반대로 반드시 나가 있어야 한다.
      const solverSent = sent.some((s) => s.op === 'setParams' && s.raw.includes('"solverType"'));
      const windSent = payloads.some((p) => p['windMagnitude'] === 77);
      check(
        '★★★★ 잠기면서 되돌린 적분기는 **어떤 프레임에도 없고**, 되돌리지 않은 바람 세기는 **나가 있다** (한 줄에 대조군이 같이 있다)',
        !solverSent && windSent,
        `solverType 나감=${String(solverSent)} · windMagnitude=77 나감=${String(windSent)}`,
      );

      const unknownKeys = [...new Set(keys)].filter((k) => paramField(k) === null);
      check(
        '★★ 나간 키가 전부 스키마의 키다 (화면이 만든 이름이 워커로 새지 않는다)',
        unknownKeys.length === 0,
        unknownKeys.join(', ') || `[${[...new Set(keys)].join(', ')}]`,
      );

      // ★★ **바뀐 것만** 보낸다 — 개수가 아니라 **이름**으로 본다. 개수만 세면
      //    되돌린 값이 다른 값과 바꿔치기돼도 통과한다.
      check(
        '★ [적용] 을 누른 횟수와 나간 setParams 프레임 수가 같다',
        setOps.length === expectedApplies.length,
        `누름 ${expectedApplies.length}회 · 프레임 ${setOps.length}건`,
      );
      for (const [i, want] of expectedApplies.entries()) {
        const got = Object.keys(payloads[i] ?? {}).sort().join(',');
        const wanted = [...want.keys].sort().join(',');
        check(
          `★★ 바뀐 것만 보낸다 — ${want.label}`,
          got === wanted,
          `보냄 {${got}} · 기대 {${wanted}}`,
        );
      }
      const drape = payloads.find((p) => Object.hasOwn(p, 'drapingTime'));
      check(
        '★ 슬라이더로 만든 값이 그대로 선을 지났다',
        drape !== undefined && drape['drapingTime'] === sliderApplied,
        drape === undefined ? 'drapingTime 프레임이 없다' : `drapingTime=${String(drape['drapingTime'])}`,
      );
    }

    // ── ⑧ 재생 중에는 **[적용] 만** 잠근다 ───────────────────
    //
    // 데스크톱과 다른 선택이다(데스크톱은 `solverType` 만 막는다). 이유는
    // 시뮬이 도는 도중의 변경이 어떻게 반영되는지 **측정한 적이 없어서**이고,
    // 그래서 위젯은 열어 둔 채 보내는 것만 막는다. 잠근 이유는 글자로 뜬다.
    {
      await page.locator('#params .prow[data-key="untanglingDamping"] input[type="number"]').fill('300');
      await page.keyboard.press('Tab');
      const dirty = await readPanel(page);
      check(
        '전제 — 보낼 변경이 하나 있고 [적용] 이 열려 있다',
        dirty.dirty === 1 && !dirty.applyDisabled,
        `dirty=${dirty.dirty} · "${dirty.applyText.trim()}"`,
      );

      await page.evaluate(() => globalThis.cobalt.play(true));
      await untilPage(page, () => globalThis.cobalt.stats.fps > 0, 20_000);
      const playing = await readPanel(page);
      const playingRows = await readParamRows(page);
      check(
        '★★★ 재생 중에는 [적용] 이 잠기고 **왜 잠겼는지가 화면 글자로** 뜬다',
        playing.applyDisabled && playing.hintShown && playing.hintText.includes('재생'),
        `applyDisabled=${String(playing.applyDisabled)} · "${playing.hintText}"`,
      );
      check(
        '★★ 그런데 위젯은 열려 있다 (값을 미리 맞춰 두고 정지한 뒤 한 번에 보낼 수 있다 — 22개를 통째로 회색으로 만들지 않는다)',
        playingRows['untanglingDamping']?.disabled === false && playingRows['drapingTime']?.disabled === false,
        `untanglingDamping 잠김=${String(playingRows['untanglingDamping']?.disabled)}`,
      );

      await page.evaluate(() => globalThis.cobalt.play(false));
      await untilPage(page, () => !globalThis.cobalt.playbackView.playing, 20_000);
      await sleep(300);
      const paused = await readPanel(page);
      check(
        '★★ [정지] 하면 잠금이 풀린다 (사용자가 스스로 풀 수 있는 잠금이다 — 되돌릴 수 없는 상태를 만들지 않는다)',
        !paused.applyDisabled && paused.dirty === 1,
        `applyDisabled=${String(paused.applyDisabled)} · dirty=${paused.dirty}`,
      );

      // [워커에서 읽기] 로 화면의 값을 버린다 — 아래 절이 깨끗한 상태에서 시작한다.
      await page.click('#paramsRead');
      await page.waitForFunction(() => globalThis.cobalt.params.dirty === 0, null, { timeout: 20_000 });
      const reread = await readParamRows(page);
      check(
        '★ [워커에서 읽기] 가 화면의 미적용 변경을 워커의 값으로 되돌린다',
        reread['untanglingDamping']?.value !== '300',
        `untanglingDamping 300 → ${reread['untanglingDamping']?.value ?? '-'}`,
      );
    }

    // ── ⑨ 씬을 내려도 패널이 스스로 따라간다 ────────────────
    //
    // 파라미터는 씬에 딸려 있다. 씬이 내려가면 화면의 값은 더 이상 아무것도
    // 가리키지 않으므로 패널이 **아무 버튼도 없이** 다시 읽어야 한다
    // (`clearScene()` → `refreshParams()`).
    //
    // ⚠️ **`phase === 'noScene'` 은 단언하지 않는다.** 실측으로 워커는 `clear`
    //    뒤에도 `status.loaded` 를 **true 로 답한다**(아래 note). 그래서 패널은
    //    씬이 없는데도 'ready' 로 남고, 지금 동작을 못으로 박으면 워커가 고쳐지는
    //    날 이 하네스가 빨간불이 된다(§9 머리말의 규칙 ③).
    //
    // 대신 **다시 읽었다는 사실 자체**를 값으로 확인한다: `clear` 뒤 워커가 주는
    // 값은 씬의 값이 아니라 **엔진 구조체의 기본값**이라 눈에 띄게 다르다
    // (실측: timeStep 45 → 30 · groundMargin 0.5 → 0.1 · 강성 750 → 7500 —
    //  `params.ts` 머리말이 적어 둔 그 차이 그대로다).
    {
      const beforeClear = (await readPanel(page)).worker;
      await blur(page);
      await page.keyboard.press('c');
      await untilPage(page, () => globalThis.cobalt.viewer.cloth.patternCount === 0, 20_000);
      const reread = await page
        .waitForFunction(
          (was: number) => globalThis.cobalt.params.workerValues.timeStep !== was,
          Number(beforeClear['timeStep']),
          { timeout: 20_000 },
        )
        .then(() => true, () => false);
      const gone = await readPanel(page);
      check(
        '★★★ 씬을 내리면 패널이 **스스로** 워커에 다시 묻는다 (아무 버튼도 누르지 않았다 — 화면의 값이 씬의 값에서 엔진 기본값으로 갈아 끼워진다)',
        reread && gone.worker['timeStep'] !== beforeClear['timeStep'],
        `timeStep ${String(beforeClear['timeStep'])} → ${String(gone.worker['timeStep'])}`
        + ` · groundMargin ${String(beforeClear['groundMargin'])} → ${String(gone.worker['groundMargin'])}`,
      );
      note(
        '⚠ 워커가 clear 뒤에도 loaded:true 를 답한다 (판정하지 않음)',
        `그래서 패널의 'noScene' 화면(씬이 없다 · 위젯 전부 잠금)에 **도달할 수 없다** —`
        + ` 지금 phase=${gone.phase} 이고 위젯이 열려 있다.`
        + ' 값은 엔진 구조체 기본값이라 어느 씬의 값도 아닌데 화면은 "워커와 일치" 라고 말한다.'
        + ' 원인은 화면이 아니라 워커다(`protocol.cpp:604` 의 `manager.IsLoadedZls()` 가'
        + ' `Clear()` 뒤에도 true — 회사 저장소 코드라 여기서 고칠 수 없다).'
        + ' 고쳐지면 이 note 를 단언으로 승격할 것',
      );

      await loadScene(page);
      const back = await readPanel(page);
      check(
        '★★ 다시 로드하면 그 씬의 값이 돌아온다 (엔진 기본값이 눌러앉지 않는다)',
        back.phase === 'ready' && !back.bannerShown
        && back.worker['timeStep'] === beforeClear['timeStep'],
        `phase=${back.phase} · timeStep ${String(gone.worker['timeStep'])} → ${String(back.worker['timeStep'])}`,
      );

      const sh = await shot(page, 'params-panel');
      check(
        '★ 패널을 펼친 채로도 화면에 옷이 그대로 서 있다 (패널이 뷰포트를 잡아먹지 않는다)',
        sh.colors.saturated > sh.colors.total * 0.01,
        describe(sh.colors),
      );
      note('파라미터 패널 스크린샷', path.basename(sh.file));
    }

    // ── ⑩ 이 절 전체의 왕복 계측기 ──────────────────────────
    //
    // ③-b 가 3초 창에서 폴링이 없음을 단언한다. 여기서는 **절 전체**의 총량을
    // 남긴다 — 조작 하나당 status 한 번이라는 설계가 실제 숫자로 어떻게 보이는지
    // 다음 사람이 알아야 문턱을 다시 정할 수 있다.
    {
      const ops = new Map<string, number>();
      for (const s of sent) ops.set(s.op, (ops.get(s.op) ?? 0) + 1);
      const applied = (await readStats(page)).applied;
      note(
        '이 절이 만든 왕복',
        [...ops.entries()].sort((a, b) => b[1] - a[1]).map(([o, n]) => `${o} ${n}`).join(' · ')
        + ` — 같은 시간에 화면에 붙은 프레임은 ${fmt(applied)}건이다`,
      );
    }
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
// §12. 2D 펼침 (#15-b) — 도면이 실제로 평평하고 겹치지 않는가
//
// **#15 의 통과 기준 "화면 확인" 이 이 절이다.** 좌표 변환 쪽은 두 곳이 이미
// 덮었다: 워커가 실은 행렬이 옳은지는 backend 스모크 §5.7·§5.8 이 씬 파일의
// 정답지로, 그 행렬로 만든 도면이 옳은지는 protocol 스모크 §12 가 모핑 계산으로
// 본다. 여기 남는 것은 **브라우저에서만 참인 것들**이다:
//
//   - 투영이 정말 정사영 쪽으로 **이어지는가** (스냅이면 모핑이 아니라 전환이다)
//   - 격자가 도면 평면에 눕고 한 칸이 10cm 인가 (재단 뷰의 자다)
//   - 재생하는 동안 옷이 도면 쪽으로 **눌어붙지 않는가** — `main.ts` 의 rAF
//     안의 호출 **순서**가 정하는 것이라 DOM 밖에서는 볼 수 없다
//   - 그리고 실제 씬(패턴 24개, 정점 13,398개)에서 도면이 평평하고 안 겹치는가
//
// ── ⚠️ 평평한가를 **경계 상자로 재면 안 된다** ────────────────
// `cloth.boundingBox()` 는 패턴마다 로컬 AABB 의 모서리 8개를 변환해 합친다.
// 도면은 로컬 좌표계에서 기울어진 평면이라 그 상자는 부푼다 — 실측으로 t=1 에서
// z 범위가 [−11.96, +10.43] 이다. **평면인데 22cm 두께라고 말한다.** ISSUE-011
// 이 "상자는 회전을 거의 못 잡는다" 였는데 여기서 반대 방향으로 같은 함정이
// 나왔다. 그래서 아래는 **점으로 잰다**, 그리고 상자가 거짓말한다는 사실 자체를
// 한 줄로 못박아 둔다.
// ─────────────────────────────────────────────────────────────

/**
 * 3D 격자의 한 칸 크기(cm). **§12 가 펼치기 전에** 재서 여기 남기고 §9 가 읽는다.
 *
 * §9 에서 직접 재면 안 된다 — 그때는 §12 가 이미 격자를 도면 쪽으로 옮겨 놓은
 * 뒤라 배율이 보간된 값이다(실측으로 0.762 가 나왔다. 3D 자리의 값은 0.525 다).
 */
let grid3dCellCm = Number.NaN;

/** 슬라이더를 밀고 화면이 따라올 때까지 기다린다 */
async function setUnfoldSlider(page: Page, pct: number): Promise<void> {
  await page.evaluate((v: number) => {
    const s = document.getElementById('unfold') as HTMLInputElement | null;
    if (!s) return;
    s.value = String(v);
    s.dispatchEvent(new Event('input', { bubbles: true }));
  }, pct);
  // rAF 가 정점을 옮기고 렌더가 한 번 더 돌 시간.
  await sleep(400);
}

interface DraftMetrics {
  /** 정점을 하나씩 월드로 옮겨 잰 z 범위. **이것이 "평평한가" 의 정본이다** */
  pointZ: [number, number];
  /** 같은 상태에서 경계 상자가 말하는 z 범위. 위와 갈린다 */
  boxZ: [number, number];
  vertices: number;
  /** 0.25cm 격자에 삼각형을 칠해 센 것 */
  coveredCells: number;
  /** 두 장 이상이 덮은 칸 */
  overlapCells: number;
  /** 격자(GridHelper)의 X축 회전(도)과 배율 */
  gridRotX: number;
  gridScale: number;
  /** 투영행렬의 [11] 성분. 원근이면 −1, 정사영이면 0 */
  projW: number;
  cameraType: string;
  unfold: number;
  mode: string;
}

/**
 * 화면에 지금 서 있는 옷을 **월드 XY 평면에 칠해** 겹침을 센다.
 *
 * ★ AABB 로 세면 안 된다. 15-a 가 AABB 로 재서 "적용 후 276쌍 중 7쌍(2.5%)이
 *   겹친다" 를 남겼는데, 그 7쌍이 **진짜 겹침인지는 AABB 로 알 수 없다**
 *   (레깅스 가랑이 노치처럼 오목한 자리에 작은 조각이 들어앉으면 상자는 겹치고
 *   형상은 안 겹친다). 여기서 삼각형 단위로 칠하면 그 물음이 끝난다.
 *
 * 0.25cm 격자는 도면 144 × 175cm 를 576 × 702 칸으로 덮는다. 삼각형 24,090개를
 * 각자의 상자 안에서만 칠하므로 브라우저에서 수십 ms 다.
 *
 * ⚠️ 같은 패턴이 자기 삼각형으로 같은 칸을 두 번 칠하는 것은 겹침이 **아니다**
 *    (인접한 삼각형은 변을 공유한다). 패턴별 표식으로 그것을 걸러낸다.
 */
function readDraftMetrics(page: Page): Promise<DraftMetrics> {
  return page.evaluate((): DraftMetrics => {
    const v = globalThis.cobalt.viewer;
    v.cloth.group.updateMatrixWorld(true);

    const CELL = 0.25;
    let pMinZ = Infinity;
    let pMaxZ = -Infinity;
    let vertices = 0;

    const worlds: Float64Array[] = [];
    const indices: (Uint32Array | null)[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of v.cloth.patterns) {
      const a = p.position.array as Float32Array;
      const m = p.mesh.matrixWorld.elements;
      const w = new Float64Array(a.length);
      for (let i = 0; i + 2 < a.length; i += 3) {
        const x = a[i] ?? 0;
        const y = a[i + 1] ?? 0;
        const z = a[i + 2] ?? 0;
        const wx = (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0);
        const wy = (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0);
        const wz = (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0);
        w[i] = wx; w[i + 1] = wy; w[i + 2] = wz;
        if (wz < pMinZ) pMinZ = wz;
        if (wz > pMaxZ) pMaxZ = wz;
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
        vertices++;
      }
      worlds.push(w);
      const idx = p.geometry.index;
      indices.push(idx ? Uint32Array.from(idx.array as ArrayLike<number>) : null);
    }

    const cols = Math.max(1, Math.ceil((maxX - minX) / CELL) + 1);
    const rows = Math.max(1, Math.ceil((maxY - minY) / CELL) + 1);
    const grid = new Uint8Array(cols * rows);
    const seen = new Int32Array(cols * rows).fill(-1);
    let covered = 0;
    let overlap = 0;

    const paint = (
      ax: number, ay: number, bx: number, by: number, cx: number, cy: number, mark: number,
    ): void => {
      const x0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - minX) / CELL));
      const x1 = Math.min(cols - 1, Math.ceil((Math.max(ax, bx, cx) - minX) / CELL));
      const y0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - minY) / CELL));
      const y1 = Math.min(rows - 1, Math.ceil((Math.max(ay, by, cy) - minY) / CELL));
      const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(d) < 1e-12) return;
      for (let gy = y0; gy <= y1; gy++) {
        const py = minY + gy * CELL;
        for (let gx = x0; gx <= x1; gx++) {
          const px = minX + gx * CELL;
          const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / d;
          const w1 = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) / d;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
          const k = gy * cols + gx;
          if (seen[k] === mark) continue;   // 같은 패턴이 이미 칠했다
          seen[k] = mark;
          const n = grid[k] ?? 0;
          if (n === 0) { grid[k] = 1; covered++; } else if (n === 1) { grid[k] = 2; overlap++; }
        }
      }
    };

    worlds.forEach((w, pi) => {
      const idx = indices[pi];
      if (idx) {
        for (let t = 0; t + 2 < idx.length; t += 3) {
          const a = (idx[t] ?? 0) * 3;
          const b = (idx[t + 1] ?? 0) * 3;
          const c = (idx[t + 2] ?? 0) * 3;
          paint(w[a] ?? 0, w[a + 1] ?? 0, w[b] ?? 0, w[b + 1] ?? 0, w[c] ?? 0, w[c + 1] ?? 0, pi);
        }
      } else {
        for (let i = 0; i + 8 < w.length; i += 9) {
          paint(w[i] ?? 0, w[i + 1] ?? 0, w[i + 3] ?? 0, w[i + 4] ?? 0, w[i + 6] ?? 0, w[i + 7] ?? 0, pi);
        }
      }
    });

    // 격자는 씬 그래프를 타고 찾는다 — 하네스를 위한 훅을 제품에 넣지 않는다.
    const scene = v.cloth.group.parent;
    let gridRotX = Number.NaN;
    let gridScale = Number.NaN;
    scene?.children.forEach((o) => {
      if (o.type !== 'GridHelper') return;
      gridRotX = (o.rotation.x * 180) / Math.PI;
      gridScale = o.scale.x;
    });

    const box = v.cloth.boundingBox();
    return {
      pointZ: [pMinZ, pMaxZ],
      boxZ: [box.min.z, box.max.z],
      vertices,
      coveredCells: covered,
      overlapCells: overlap,
      gridRotX,
      gridScale,
      projW: v.camera.projectionMatrix.elements[11] ?? Number.NaN,
      cameraType: v.camera.type,
      unfold: v.unfold,
      mode: v.mode,
    };
  });
}

/**
 * **rAF 안에서 프레임마다** 옷의 월드 z 두께를 잰다.
 *
 * ⚠️ 밖에서 몇 번 재는 것으로는 안 된다. `main.ts` 의 rAF 안 호출 순서가 어긋나면
 *    두께가 **한 프레임씩 튄다** — 시뮬 프레임이 붙는 프레임에서만 옷이 3D 자세로
 *    돌아갔다가 다음 프레임에 다시 접힌다. 밖에서 재면 그 순간을 만날 확률이
 *    낮아 "가끔 이상한 값" 으로 보이고, 평균만 보면 멀쩡하다.
 *
 *    실측(t=0.5, 60프레임): 올바른 순서면 12.17~13.03(변동폭 0.86),
 *    `sync` 를 `apply` 뒤로 옮기면 12.17~26.06(변동폭 13.89)으로 매 시뮬
 *    프레임마다 24 쪽으로 튄다. 화면에서는 옷이 덜덜 떠는 것으로 보인다.
 */
function sampleThickness(page: Page, frames: number): Promise<number[]> {
  return page.evaluate((n: number) => new Promise<number[]>((res) => {
    const v = globalThis.cobalt.viewer;
    const out: number[] = [];
    const tick = (): void => {
      v.cloth.group.updateMatrixWorld(true);
      let mn = Infinity;
      let mx = -Infinity;
      for (const p of v.cloth.patterns) {
        const a = p.position.array as Float32Array;
        const m = p.mesh.matrixWorld.elements;
        for (let i = 0; i + 2 < a.length; i += 3) {
          const z = (m[2] ?? 0) * (a[i] ?? 0) + (m[6] ?? 0) * (a[i + 1] ?? 0)
            + (m[10] ?? 0) * (a[i + 2] ?? 0) + (m[14] ?? 0);
          if (z < mn) mn = z;
          if (z > mx) mx = z;
        }
      }
      out.push(mx - mn);
      if (out.length < n) requestAnimationFrame(tick);
      else res(out);
    };
    requestAnimationFrame(tick);
  }), frames);
}

async function sectionUnfold(page: Page): Promise<void> {
  section('§12. 2D 펼침 (#15-b) — 도면이 평평하고 겹치지 않는다');

  await timed('§12 2D 펼침', async () => {
    // 시작은 3D 다. 앞 절들이 무엇을 하고 왔든 여기서 기준을 세운다.
    await ensurePlaying(page, false);
    await setUnfoldSlider(page, 0);

    const flat0 = await readDraftMetrics(page);
    const span0 = flat0.pointZ[1] - flat0.pointZ[0];
    check(
      '★ 처음에는 3D 다 — 슬라이더가 0 이고 옷이 입체다',
      flat0.unfold === 0 && span0 > 1,
      `t=${flat0.unfold} · 정점 ${fmt(flat0.vertices)}개 · z 두께 ${span0.toFixed(2)}cm`,
    );
    check(
      '★ 3D 에서는 투영이 원근이다 (projectionMatrix[11] = −1)',
      Math.abs(flat0.projW + 1) < 1e-6,
      `[11] = ${flat0.projW}`,
    );
    check(
      '★★ 대조군 — 3D 드레이프를 도면과 같은 평면에 눌러 보면 천이 겹친다 (아래 판정에 이빨이 있다는 증거)',
      flat0.overlapCells > flat0.coveredCells * 0.05,
      `덮인 칸 ${fmt(flat0.coveredCells)} 중 겹친 칸 ${fmt(flat0.overlapCells)}`
      + ` (${(flat0.overlapCells / Math.max(1, flat0.coveredCells) * 100).toFixed(1)}%)`,
    );

    const view0 = await page.evaluate(() => ({
      enabled: globalThis.cobalt.unfoldControl.view.enabled,
      stat: document.getElementById('unfoldStat')?.textContent ?? '',
      why: document.getElementById('unfoldWhy')?.textContent ?? '',
      disabled: (document.getElementById('unfold') as HTMLInputElement | null)?.disabled ?? true,
      placed: globalThis.cobalt.unfolder.stats.placed,
      unplaced: globalThis.cobalt.unfolder.stats.unplaced,
    }));
    check(
      '★ 씬이 서 있으면 슬라이더를 만질 수 있고, 상태가 글자로 보인다',
      !view0.disabled && view0.enabled && view0.stat.length > 0,
      `"${view0.stat}" · 배치 ${view0.placed}/${view0.placed + view0.unplaced}`,
    );
    note(
      '이 씬의 배치',
      `placed ${view0.placed} · unplaced ${view0.unplaced}`
      + ' — 실측 씬은 전부 배치가 있다. 빈 갈래의 모핑 동작은 스모크 §12 ④ 가 태운다',
    );
    // 아직 펼치기 전이다 = 격자가 3D 자리에 있는 유일한 시점. §9 가 이 값을 읽는다.
    // (`GridHelper(400, 40)` 이라 한 칸이 10 단위이고, 거기 걸린 배율이 곧 칸 크기다)
    grid3dCellCm = flat0.gridScale * 10;

    // ── 도면으로 ─────────────────────────────────────────────
    await setUnfoldSlider(page, 100);
    const flat1 = await readDraftMetrics(page);
    const pointSpan = flat1.pointZ[1] - flat1.pointZ[0];
    const boxSpan = flat1.boxZ[1] - flat1.boxZ[0];

    check(
      '★★★ t=1 에서 도면이 **정말로 평평하다** — 정점 전부의 월드 z 가 0 이다',
      pointSpan < 0.01 && Math.abs(flat1.pointZ[0]) < 0.01,
      `정점 ${fmt(flat1.vertices)}개 · z ${flat1.pointZ[0].toExponential(2)} ~ ${flat1.pointZ[1].toExponential(2)}cm`
      + ` (3D 일 때는 ${span0.toFixed(1)}cm 두께였다)`,
    );
    check(
      '★★★ 같은 상태에서 **경계 상자는 평평하지 않다고 말한다** — 평평함을 상자로 재면 안 된다는 증거',
      boxSpan > 1 && boxSpan > pointSpan * 100,
      `상자 z ${flat1.boxZ[0].toFixed(2)} ~ ${flat1.boxZ[1].toFixed(2)} (${boxSpan.toFixed(1)}cm)`
      + ` vs 점 ${pointSpan.toExponential(2)}cm — 로컬 AABB 모서리 8개를 변환해 합치기 때문이다`,
    );

    check(
      '★★★ 도면 위에서 천이 겹치지 않는다 (0.25cm 격자에 삼각형 단위로 칠해서 센다)',
      flat1.coveredCells > 1_000 && flat1.overlapCells === 0,
      `덮인 칸 ${fmt(flat1.coveredCells)}개 · 두 장 이상 겹친 칸 ${fmt(flat1.overlapCells)}개`
      + ' — 15-a 의 AABB 기준 "7쌍 겹침" 은 상자가 겹친 것이지 형상이 겹친 것이 아니다',
    );
    note(
      '도면 면적',
      `${(flat1.coveredCells * 0.25 * 0.25).toFixed(0)}cm² (0.25cm 칸 ${fmt(flat1.coveredCells)}개)`,
    );

    check(
      '★★ 도면에서 투영이 정사영이다 (projectionMatrix[11] = 0 — 원근 왜곡이 없어야 치수가 자다)',
      Math.abs(flat1.projW) < 1e-6,
      `[11] = ${flat1.projW}`,
    );
    check(
      '★★ 그런데 카메라 **객체**는 그대로 PerspectiveCamera 다 (갈아 끼우지 않았다 — 이 하네스가 읽는 viewer.camera 가 안 흔들린다)',
      flat1.cameraType === 'PerspectiveCamera',
      flat1.cameraType,
    );
    check(
      '★★ 격자가 도면 평면으로 눕고 배율이 1 이다 — "격자 한 칸 = 10cm" 가 도면에서 글자 그대로 참이 된다',
      Math.abs(flat1.gridRotX - 90) < 0.5 && Math.abs(flat1.gridScale - 1) < 1e-6,
      `회전 ${flat1.gridRotX.toFixed(1)}° · 배율 ${flat1.gridScale}`,
    );
    check(
      '★★ 배타 모드는 손대지 않았다 — 2D 는 세 번째 뷰가 아니라 실시간 옷의 다른 자세다',
      flat1.mode === 'live',
      `mode=${flat1.mode}`,
    );

    const sh1 = await shot(page, 'unfold-2d');
    check(
      '도면이 화면에 실제로 그려져 있다',
      sh1.colors.saturated > sh1.colors.total * 0.01,
      describe(sh1.colors),
    );

    // ── 모핑인가, 전환인가 ────────────────────────────────────
    //
    // ★ 여기가 "슬라이더" 라는 선택의 값어치다. t=0.5 에서 투영이 −1 이나 0 이면
    //   그건 보간이 아니라 문턱에서 튀는 **전환**이고, 중간에서 멈춰 어느 조각이
    //   어디로 가는지 보는 일이 불가능해진다.
    await setUnfoldSlider(page, 50);
    const mid = await readDraftMetrics(page);
    const midSpan = mid.pointZ[1] - mid.pointZ[0];
    check(
      '★★★ t=0.5 의 투영이 원근과 정사영의 **중간**이다 (양 끝으로 스냅하면 모핑이 아니라 전환이다)',
      mid.projW < -0.05 && mid.projW > -0.95,
      `[11] = ${mid.projW.toFixed(4)} (원근 −1 / 정사영 0)`,
    );
    check(
      '★★ 옷도 중간에 있다 — 3D 두께와 도면 사이에 있다',
      midSpan > pointSpan + 0.1 && midSpan < span0,
      `z 두께 ${midSpan.toFixed(2)}cm (3D ${span0.toFixed(2)} → 도면 ${pointSpan.toExponential(1)})`,
    );

    // ── 재생 중에 눌어붙지 않는가 ─────────────────────────────
    //
    // ⚠️ **이 절에서만 볼 수 있는 것이다.** `main.ts` 의 rAF 가 `sync` 를
    //    `apply` 보다 **먼저** 불러야 한다는 계약이고, 뒤집히면 섞인 값을
    //    원본으로 착각해 옷이 프레임마다 도면 쪽으로 끌려간다. 몇 초에 걸쳐
    //    서서히 일어나 화면에서는 "원래 이런가" 로 보인다.
    //
    // 재는 법: t=0.5 로 두고 재생한 뒤 **t=0 으로 되돌려** 두께를 본다.
    // 눌어붙었다면 원본 자체가 도면에 가까워져 있어서 3D 로 돌아가도 납작하다.
    const applied0 = await page.evaluate(() => globalThis.cobalt.stats.applied);
    await ensurePlaying(page, true);
    const ran = await page.waitForFunction(
      (n: number) => globalThis.cobalt.stats.applied > n + 20,
      applied0,
      { timeout: 40_000 },
    ).then(() => true, () => false);
    const samples = await sampleThickness(page, 60);
    const applied1 = await page.evaluate(() => globalThis.cobalt.stats.applied);
    await ensurePlaying(page, false);
    await sleep(300);

    check('★ 재생이 흘렀다 (아래 판정의 전제)', ran, `applied ${applied0} → ${applied1}`);

    const sMin = Math.min(...samples);
    const sMax = Math.max(...samples);
    check(
      '★★ 재생 중에도 3D 는 살아 있다 — t=0.5 에서 옷이 납작해지지 않았다',
      sMin > 0.1,
      `z 두께 최소 ${sMin.toFixed(2)}cm (표본 ${samples.length}개)`,
    );
    // ★★★ **호출 순서를 잡는 유일한 단언이다.** `main.ts` 의 rAF 가 `sync` 를
    //   `apply` 보다 먼저 불러야 하는데, 뒤집으면 `apply` 의 "같은 t 는 다시 쓰지
    //   않는다" 가드와 맞물려 **시뮬 프레임이 붙는 프레임에서만 3D 원본이 그대로
    //   화면에 남는다.** 평균도 최종 상태도 멀쩡한데 매 프레임 튄다 — 사람 눈에는
    //   옷이 덜덜 떠는 것으로 보이고, 스크린샷 한 장으로는 절대 안 보인다.
    //   (Node 스모크 §12 ⑤ 는 그 오염 **메커니즘**을 못박는다. 실제 배선이 어느
    //    쪽인지는 여기서만 알 수 있다.)
    check(
      '★★★ 재생 중 두께가 프레임마다 흔들리지 않는다 (main.ts 가 sync 를 apply 보다 먼저 부른다는 계약)',
      sMax - sMin < span0 * 0.1,
      `${samples.length}프레임 · ${sMin.toFixed(2)} ~ ${sMax.toFixed(2)}cm (변동폭 ${(sMax - sMin).toFixed(2)},`
      + ` 문턱 ${(span0 * 0.1).toFixed(2)}) — 순서가 뒤집히면 시뮬 프레임마다 3D 로 튄다`,
    );

    await setUnfoldSlider(page, 0);
    const back = await readDraftMetrics(page);
    const backSpan = back.pointZ[1] - back.pointZ[0];
    check(
      '★★★ t 를 0 으로 되돌리면 옷이 다시 입체다 — 재생하는 동안 도면 쪽으로 눌어붙지 않았다'
      + ' (sync 를 apply 보다 먼저 부른다는 계약)',
      backSpan > span0 * 0.5,
      `되돌린 뒤 ${backSpan.toFixed(2)}cm vs 펼치기 전 ${span0.toFixed(2)}cm`,
    );
    check(
      '★ 투영도 원근으로 돌아왔다 (2D 를 안 쓰는 동안은 이 기능이 없는 것과 같다)',
      Math.abs(back.projW + 1) < 1e-6 && back.unfold === 0,
      `[11] = ${back.projW} · t=${back.unfold}`,
    );
    // ★ **이 줄은 한때 빨간불이었다 — 15-b 가 만든 회귀를 여기서 잡았다.**
    //
    //   그때의 `Viewer3D.setUnfold()` 는 `next === 0` 에서 카메라만 되돌리고
    //   조기 반환했다 — 격자를 되돌리는 사람이 없었다. 렌더 루프도
    //   `if (this.#unfold > 0)` 라 t=0 에서는 아무 일도 안 한다. 그래서 격자가
    //   **마지막으로 t>0 이었을 때의 자세에 멎었다.**
    //
    //   화살표로 한 칸씩 내려오면 마지막이 t=0.01 이라 0.9° 로 눈에 안 띈다.
    //   **점프하면 드러났다** — 슬라이더에 포커스를 두고 Home 키(또는 트랙 왼쪽
    //   끝 클릭)를 누르면 회전 90°·배율 1·위치 (44.5, 73.4, −0.5) 에 그대로
    //   남았다. 바닥 격자가 수직으로 선 채 옷 뒤에 서 있게 된다.
    //   **씬을 새로 로드해도 안 풀렸다** — `frameCamera()` 가 위치·배율은
    //   되돌리지만 `rotation` 은 건드리지 않기 때문이다.
    //
    //   지금은 `setUnfold` 의 t=0 분기가 `#restoreGrid()` 를 부르고, 이 줄은
    //   초록이다. **이 단언에 이빨이 있다는 것은 돌연변이로 확인했다**:
    //   `#restoreGrid()` 한 줄을 지우면 이 줄만 정확히 빨간불이 되고
    //   (verify:ui 199/200), Node 스모크는 651건 전부 초록으로 남는다 —
    //   격자는 `viewer3d/` 안에 있어 DOM 밖에서는 볼 수 없다.
    //   **줄이면 안 되는 단언이다.**
    check(
      '★★ 3D 로 되돌아오면 격자도 3D 자리로 돌아온다 (setUnfold 의 t=0 조기 반환이 #driveGrid(0) 을 건너뛴다)',
      Math.abs(back.gridRotX) < 0.5 && Math.abs(back.gridScale - flat0.gridScale) < 1e-6,
      `회전 ${back.gridRotX.toFixed(1)}° (3D 는 0°) · 배율 ${back.gridScale.toFixed(3)} (3D 는 ${flat0.gridScale.toFixed(3)})`,
    );

    // ── 배치를 모르는 패턴 — **화면이 그 사실을 말하는가** ─────
    //
    // 실측 씬은 24/24 가 전부 배치돼 있어 이 갈래를 지나갈 수 없다. 모핑 쪽
    // 동작(그 패턴만 3D 에 남는다)은 스모크 §12 ④ 가 태우고, 여기서는
    // **배선**만 본다: 판정이 바뀌면 화면의 글자가 실제로 따라오는가.
    // 창구(`unfoldControl.setStats`)는 공개 메서드다 — 하네스를 위해 제품에
    // 넣은 훅이 아니다.
    //
    // ⚠️ 문구를 통째로 박지 않는다. 계약은 **"이유가 있고, 몇 개인지 말한다"**
    //    이고 문장은 다듬을 수 있다 (#16-a 가 세운 기준).
    const forced = await page.evaluate(() => {
      const c = globalThis.cobalt;
      const real = c.unfolder.stats;
      const nudge = (): void => {
        document.getElementById('unfold')?.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const read = (): { why: string; disabled: boolean } => ({
        why: document.getElementById('unfoldWhy')?.textContent ?? '',
        disabled: (document.getElementById('unfold') as HTMLInputElement | null)?.disabled ?? true,
      });

      // ① 일부만 배치가 없다 — 만질 수는 있고, 이유가 보인다
      c.unfoldControl.setStats({ ...real, placed: real.patterns - 3, unplaced: 3 });
      nudge();
      const partial = read();

      // ② 전부 배치가 없다 — 만질 수 없고, 왜인지가 보인다
      c.unfoldControl.setStats({ ...real, placed: 0, unplaced: real.patterns, bounds: null });
      nudge();
      const none = read();

      // 원상복구. 남겨 두면 뒤따르는 절이 가짜 상태를 본다.
      c.unfoldControl.setScene(true);
      c.unfoldControl.setStats(real);
      nudge();
      return { partial, none, restored: read(), patterns: real.patterns };
    });

    check(
      '★★★ 배치가 없는 패턴이 생기면 화면이 **글자로** 말한다 (회색으로만 두지 않는다 — #16 이 세운 규칙)',
      forced.partial.why.length > 0 && forced.partial.why.includes('3') && !forced.partial.disabled,
      `"${forced.partial.why}" · 슬라이더 ${forced.partial.disabled ? '비활성' : '활성'}`,
    );
    check(
      '★★★ 전부 배치가 없으면 슬라이더가 잠기고, **왜 잠겼는지**가 화면에 남는다',
      forced.none.disabled && forced.none.why.length > 0
      && forced.none.why.includes(String(forced.patterns)),
      `"${forced.none.why}" · 슬라이더 ${forced.none.disabled ? '비활성' : '활성'}`,
    );
    check(
      '★ 되돌리면 화면도 되돌아온다 (하네스가 가짜 상태를 남기지 않는다)',
      forced.restored.why === '' && !forced.restored.disabled,
      `why="${forced.restored.why}" · 슬라이더 ${forced.restored.disabled ? '비활성' : '활성'}`,
    );

    const shBack = await shot(page, 'unfold-back-to-3d');
    check(
      '되돌아온 화면에도 옷이 있다',
      shBack.colors.saturated > shBack.colors.total * 0.01,
      describe(shBack.colors),
    );
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
    // ISSUE-009 는 #14 에서 닫혔다. **여기 있던 note 를 §10 의 단언으로 승격했다** —
    // 이 절의 머리말이 말한 "고쳐지면 위 §들 중 하나로 승격한다" 가 그것이다.
    // 재생 중 재로드는 §10-④ 가 실제로 눌러 보고, 그 판정의 계측기가
    // `playback.stats.corrections` 다.
    const pv = await page.evaluate(() => {
      const s = globalThis.cobalt.playback.stats;
      return { corrections: s.corrections, negativeFrames: s.negativeFrames };
    });
    note(
      'ISSUE-009 (재생 상태 어긋남) — #14 에서 닫혔다',
      `§10-④ 가 재생 중 재로드를 실제로 눌러 판정한다. 이번 실행의 계측기:`
      + ` corrections=${pv.corrections} (믿음이 워커와 갈라진 횟수)`,
    );
    note(
      '워커 쪽 미해결 (판정하지 않음)',
      `① status.frame 이 정지 중 음수로 온다 — 이번 실행 ${pv.negativeFrames}회.`
      + ' 화면은 maxFrame 만 쓰므로 영향이 없다.'
      + ' ② step op 이 no-op 이라 버튼·SPACE 를 화면에 올리지 않았다'
      + ' (스모크 §10-8·§10-10 이 관찰한다)',
    );
    // ★ 3D 격자의 한 칸은 10cm 가 아니다 — 그런데 화면 힌트는 그렇다고 단언한다.
    //   #15-b 에서 2D 쪽을 정확히 10cm 로 맞추면서 드러난 **기존 동작**이라
    //   여기서는 재현만 하고 판정하지 않는다(§9 의 규칙 그대로).
    note(
      '3D 격자의 한 칸이 10cm 가 아니다 (기존 동작 · 판정하지 않음)',
      `이번 실행에서 한 칸 ${grid3dCellCm.toFixed(1)}cm (§12 가 펼치기 전에 잰 값).`
      + ' 화면 아래 힌트는 "격자 한 칸 = 10cm" 라고 단언한다.'
      + ' frameCamera() 가 scale = cells·10/400 을 거는데 cells 가 옷 크기를 따라가서,'
      + ' 씬마다 값이 변한다. 2D 도면(§12)에서는 배율 1 = 정확히 10cm 로 맞췄다 —'
      + ' 재단 치수를 재는 뷰라 자가 어긋나면 안 되기 때문이다. 3D 는 이번 단위가 손대지 않았다',
    );
    note(
      '덮지 못하는 것',
      '업로드 경로 · 재연결(끊겼다 붙는 것). 화면이 생기면 절을 추가할 것'
      + ' (파라미터(#16)는 §11, 2D 펼침(#15)은 §12 로 들어왔다)',
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
