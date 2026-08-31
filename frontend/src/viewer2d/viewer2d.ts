/**
 * 가운데 칸의 2D 재단 도면 뷰포트 (L-2a).
 *
 * ── 왜 `Viewer3D` 를 재사용하지 않는가 ──────────────────────
 * `viewer3d/viewer.ts` 는 614줄이고 그 대부분이 **3D 와 도면을 하나의 카메라로
 * 잇는 일**이다 — 투영행렬 혼합, 양 끝 자세 기억, 격자를 눕히는 보간. 3분할
 * 이후 가운데 칸에는 이을 것이 없다. 도면만 정면으로, 정사영으로, 회전 없이
 * 보면 된다. 그 클래스에 "지금 3D 칸이냐 2D 칸이냐" 분기를 넣으면 얽힌
 * 상태가 두 배가 되므로, 필요한 것만 가진 작은 클래스를 따로 둔다.
 *
 * (모핑 자체는 버리지 않는다 — 왼쪽 칸의 `setUnfold` 는 그대로 살아 있다.
 *  슬라이더의 소속을 어디로 할지는 L-2b 가 정한다.)
 *
 * ── 도면은 시뮬레이션과 무관하다 ────────────────────────────
 * ★ 이 뷰는 **프레임을 받지 않는다.** `Unfolder` 가 만드는 목표 정점은
 *   `uvs` 와 `transform2d` 로만 계산되고(`unfold.ts` 의 `build`), 둘 다
 *   topology 와 함께 한 번만 온다. 즉 **재단 도면은 옷이 어떻게 드레이프
 *   되든 같다** — 씬 하나당 한 번 세우면 끝이고, 40/s 프레임 경로에 이 칸이
 *   붙을 이유가 없다. 왼쪽 칸의 모핑이 `sync` 를 프레임마다 부르는 것과
 *   대비된다(그쪽은 3D 원본이 살아 있어야 중간값이 나온다).
 *
 * ── 왜 렌더러를 하나 더 만드는가 ────────────────────────────
 * 캔버스 하나를 두 칸에 걸쳐 놓고 `setScissor` 로 나눠 그리는 방법이 있지만,
 * L-1 이 만든 격자는 칸마다 `overflow: hidden` 과 경계선을 가진 독립된
 * 상자다. 캔버스가 그 위를 가로지르면 칸 구조가 장식이 되고, 창을 줄일 때
 * 두 칸의 폭을 캔버스 안에서 다시 계산해야 한다. 컨텍스트 하나를 아끼는
 * 대신 배치의 정본이 CSS 에서 JS 로 넘어간다 — 그 교환은 남는 장사가 아니다.
 * (브라우저의 GL 컨텍스트 상한은 보통 8~16개다. 둘은 여유가 있다.)
 *
 * ── DOM 없는 것은 여기 두지 않는다 ──────────────────────────
 * 좌표 변환·범위 계산은 전부 `unfold.ts` 에 있고 이 파일은 그 결과를 받아
 * 그리기만 한다. 그래서 자동 테스트가 붙는 자리는 여전히 `unfold.ts` 다.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { ClothObject } from '../viewer3d/cloth.ts';
import { Design2DLayer } from './design.ts';
import type { DraftingBounds } from './unfold.ts';

export interface Viewer2DOptions {
  canvas: HTMLCanvasElement;
  /** 배경색. 왼쪽 칸과 같은 값을 기본으로 둔다 — 두 칸이 같은 화면이다 */
  background?: number;
}

/**
 * 도면 범위에 얼마나 여백을 둘 것인가.
 *
 * ⚠️ **`viewer3d/viewer.ts` 의 `pad = 1.28` 을 그대로 옮기지 않았다.** 그 값의
 *    근거는 "상단 바가 캔버스를 덮어 800px 중 690px 만 보인다"(690/800 = 1.16
 *    + 여백)였는데, L-1 에서 바가 흐름 안으로 들어가 **더 이상 아무것도
 *    덮지 않는다.** 가운데 칸은 위아래가 온전히 보이므로 그 보정이 필요 없다.
 *
 *    남긴 1.06 은 순수한 여백이다 — 도면이 칸 모서리에 닿아 잘린 것처럼
 *    보이지 않을 만큼만. 화면을 보고 조정할 값이다.
 */
const PAD = 1.06;

export class Viewer2D {
  /**
   * **왼쪽 칸과 별개의 옷 한 벌이다.**
   *
   * 같은 메시를 공유할 수 없는 이유는 `Unfolder.apply()` 가 정점 버퍼를
   * **덮어쓰기** 때문이다(`unfold.ts`). 왼쪽이 3D 를, 가운데가 도면을 동시에
   * 보여주려면 같은 자리에 두 값이 있어야 하는데 버퍼는 하나뿐이다.
   * 정점 13,398 / 삼각형 24,090 짜리 씬에서 한 벌이 더 느는 비용은 작다.
   */
  readonly cloth = new ClothObject();

  /**
   * 디자인 정보(커브·제어점·봉제선·스티치). **옷 메시와 별개의 그룹이다** —
   * 씬을 내렸다 올릴 때 둘의 수명이 갈리고, 도면선만 껐다 켜는 것도 열린다.
   */
  readonly design = new Design2DLayer();

  readonly #canvas: HTMLCanvasElement;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #scene = new THREE.Scene();
  readonly #camera: THREE.OrthographicCamera;
  readonly #controls: OrbitControls;
  readonly #grid: THREE.GridHelper;
  readonly #resizeObserver: ResizeObserver;

  /** 마지막으로 맞춘 도면 범위. `resize()` 가 화각을 다시 잡을 때 쓴다 */
  #bounds: DraftingBounds | null = null;
  #raf = 0;
  #running = false;
  /** 렌더 루프가 실제로 몇 번 돌았는지. "가운데 칸이 멈춘 건가" 를 가른다 */
  #renders = 0;

  constructor(opts: Viewer2DOptions) {
    this.#canvas = opts.canvas;

    this.#renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: true });
    this.#renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    /* 3D 칸보다 한 단 어둡다 — 두 칸이 같은 색이면 경계선 하나로만 갈린다.
       중성 회색이라야 하는 이유는 `viewer3d/viewer.ts` 의 같은 줄 주석 참고 */
    this.#scene.background = new THREE.Color(opts.background ?? 0x222222);

    // 화각은 `fit()` 이 도면 범위에서 정한다. 여기 값은 도면이 아직 없을 때만
    // 쓰인다 — 빈 칸에 격자만 보이는 상태다.
    this.#camera = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 5000);
    this.#camera.position.set(0, 0, 1000);
    this.#camera.lookAt(0, 0, 0);

    this.#controls = new OrbitControls(this.#camera, opts.canvas);
    // ★ 회전을 잠근다. **재단 도면을 비스듬히 보는 것은 원근을 없앤 이유를
    //   스스로 무르는 일이다** — 치수를 눈으로 재는 뷰에서 기울어진 화면은
    //   거짓말이다. 팬과 줌은 살려 둔다(확대해야 보이는 치수가 있다).
    this.#controls.enableRotate = false;
    this.#controls.enableDamping = true;
    this.#controls.dampingFactor = 0.08;
    // 좌드래그도 팬이다. 회전이 없으니 좌버튼을 놀릴 이유가 없고, 사용자가
    // 왼쪽 칸에서 하던 손동작(좌드래그)이 여기서 아무 일도 안 하면 고장으로
    // 읽힌다.
    this.#controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    opts.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.#addLights();

    // 격자 한 칸 = 10cm. `GridHelper(400, 40)` 이 정확히 10 단위 간격이므로
    // **배율을 건드리지 않는다** — 건드리는 순간 화면 아래 "격자 한 칸 = 10cm"
    // 가 거짓이 되고, 자가 아니라 장식이 된다.
    this.#grid = new THREE.GridHelper(400, 40, 0x4a5568, 0x2c333f);
    // GridHelper 는 XZ 평면에 눕는데 도면은 XY 평면(z=0)에 있다. 90° 세운다.
    this.#grid.rotation.x = Math.PI / 2;
    // 패턴과 깊이가 겹치면 얼룩진다(둘 다 평면이다). 살짝 뒤로 민다.
    this.#grid.position.z = -0.5;
    (this.#grid.material as THREE.Material).transparent = true;
    (this.#grid.material as THREE.Material).opacity = 0.5;
    this.#scene.add(this.#grid);

    this.#scene.add(this.cloth.group);
    this.#scene.add(this.design.group);

    this.#resizeObserver = new ResizeObserver(() => this.resize());
    this.#resizeObserver.observe(opts.canvas);
    this.resize();
  }

  get renders(): number {
    return this.#renders;
  }

  get camera(): THREE.OrthographicCamera {
    return this.#camera;
  }

  get controls(): OrbitControls {
    return this.#controls;
  }

  /** 지금 맞춰 둔 도면 범위. 없으면 null */
  get bounds(): DraftingBounds | null {
    return this.#bounds;
  }

  /**
   * 패턴 면을 **흰 종이**로 바꾼다 (D2-c).
   *
   * ★ 왼쪽 칸(3D)과 갈리는 지점이다. 실시간 뷰의 색은 "어느 삼각형이 어느
   *   패턴인가" 를 구분하려는 것이고, 재단 도면의 색은 **선이 말한다** —
   *   외곽선·봉제선·제어점이 정보를 지고 있으므로 면까지 색이면 선이 묻힌다.
   *   데스크톱 2D 뷰가 흰 종이인 것도 같은 이유다.
   *
   * `showScene` 이 메시를 새로 세울 때마다 재질도 새로 만들어지므로 **로드
   * 때마다 다시 불러야 한다.** 색만 바꾸는 이유는 조명·양면·polygonOffset
   * 같은 설정이 도면에서도 그대로 필요해서다(패턴들이 겹치는 구간에서
   * 얼룩지는 것은 여기서도 똑같이 일어난다).
   */
  paperize(): void {
    for (const p of this.cloth.patterns) {
      const m = p.mesh.material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[];
      const list = Array.isArray(m) ? m : [m];
      for (const one of list) {
        if (!(one as THREE.MeshStandardMaterial).color) continue;
        // 순백이 아니라 아주 옅은 회색이다. 순백이면 흰 배경 요소(스티치의
        // 흰색 4개)와 구분이 사라진다.
        (one as THREE.MeshStandardMaterial).color.setHex(0xf2f4f7);
      }
    }
  }

  /**
   * 도면이 평평하다는 전제 위에 있는 조명.
   *
   * 왼쪽 칸(3D)보다 단순하다 — 주름이 없으므로 굴곡을 만들 이유가 없고,
   * 오히려 방향광이 세면 패턴마다 밝기가 달라져 **같은 천이 다른 색으로
   * 보인다.** 정면에서 고르게 비춘다.
   */
  #addLights(): void {
    this.#scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30343c, 2.0));
    const front = new THREE.DirectionalLight(0xffffff, 1.2);
    // 카메라와 같은 쪽(+Z). 도면을 정면에서 본다.
    front.position.set(0, 0, 1000);
    this.#scene.add(front);
  }

  /** 캔버스 CSS 크기에 렌더 버퍼와 화각을 맞춘다 */
  resize(): void {
    const w = this.#canvas.clientWidth || 1;
    const h = this.#canvas.clientHeight || 1;
    this.#renderer.setSize(w, h, false);
    this.#fit();
  }

  /**
   * 도면 전체가 칸에 들어오도록 화각과 카메라를 잡는다.
   *
   * ★ 범위를 **경계 상자가 아니라 `Unfolder` 가 점으로 센 값**에서 받는다.
   *   `cloth.boundingBox()` 는 로컬 AABB 의 모서리 8개를 회전시킨 상자라
   *   평면에서도 z 가 [−12, +10.4] 로 부푼다(#15 실측). 이 프로젝트에서
   *   "박스 말고 점으로 재라" 가 세 번 반복된 교훈이다.
   *
   * @param bounds 도면 범위(cm). null 이면 도면이 없는 상태로 되돌린다
   */
  fit(bounds: DraftingBounds | null): void {
    this.#bounds = bounds;
    this.#fit();
    // 사용자가 옮겨 놓은 시점은 이전 씬의 것이다. 새 도면에는 아무 관계가 없다.
    this.#controls.update();
  }

  #fit(): void {
    const b = this.#bounds;
    const aspect = (this.#canvas.clientWidth || 1) / (this.#canvas.clientHeight || 1);

    if (!b) {
      // 도면이 없다. 격자만 보이는 기본 화각으로 되돌린다 — 옛 씬의 화각을
      // 들고 있으면 다음 씬이 화면 밖에서 시작한다.
      const half = 100;
      this.#camera.left = -half * aspect;
      this.#camera.right = half * aspect;
      this.#camera.top = half;
      this.#camera.bottom = -half;
      this.#camera.zoom = 1;
      this.#camera.position.set(0, 0, 1000);
      this.#controls.target.set(0, 0, 0);
      this.#camera.updateProjectionMatrix();
      return;
    }

    let halfH = Math.max(b.height, 1) * 0.5 * PAD;
    let halfW = Math.max(b.width, 1) * 0.5 * PAD;
    // 좁은 쪽이 먼저 잘린다. 넓은 쪽을 기준으로 키워 둘 다 담는다.
    if (halfW / halfH > aspect) halfH = halfW / aspect;
    else halfW = halfH * aspect;

    this.#camera.left = -halfW;
    this.#camera.right = halfW;
    this.#camera.top = halfH;
    this.#camera.bottom = -halfH;
    this.#camera.near = 0.1;
    this.#camera.far = 5000;
    this.#camera.updateProjectionMatrix();

    // 도면 한가운데를 정면(+Z)에서 내려다본다. 거리는 정사영이라 크기에
    // 영향이 없지만, near/far 안에 도면이 들어와야 한다.
    this.#camera.position.set(b.centerX, b.centerY, 1000);
    this.#controls.target.set(b.centerX, b.centerY, 0);
    this.#camera.lookAt(this.#controls.target);

    // 격자를 도면 한가운데로 옮긴다. 400cm 짜리가 도면(약 144 × 175cm)을
    // 넉넉히 덮는다.
    this.#grid.position.set(b.centerX, b.centerY, -0.5);
  }

  /** 렌더 루프 시작. 여러 번 불러도 안전하다 */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    const tick = (): void => {
      if (!this.#running) return;
      // 다음 프레임을 먼저 예약한다 — 아래에서 무엇이 던지든 칸이 통째로
      // 멎지 않는다(왼쪽 칸과 같은 판단이다).
      this.#raf = requestAnimationFrame(tick);
      this.#controls.update();
      this.#renderer.render(this.#scene, this.#camera);
      this.#renders += 1;
    };
    this.#raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.#running = false;
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
  }

  dispose(): void {
    this.stop();
    this.#resizeObserver.disconnect();
    this.#controls.dispose();
    this.cloth.clear();
    this.#grid.geometry.dispose();
    (this.#grid.material as THREE.Material).dispose();
    this.#renderer.dispose();
  }
}
