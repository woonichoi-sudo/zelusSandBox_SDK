/**
 * three.js 뷰포트 — 렌더러·카메라·조명·조작. **프로토콜을 모른다.**
 *
 * 이 파일이 아는 것은 `ClothObject` 하나뿐이고 `GatewayClient` 는 import 하지도
 * 않는다. 렌더링과 통신을 갈라 두면 "옷이 안 보인다" 의 원인이 둘 중 어디인지
 * 절반으로 좁혀진다 — 로드는 됐는데(정점 수가 찍힌다) 화면이 비었으면 카메라나
 * 머티리얼이고, 정점 수가 0이면 프로토콜이다.
 *
 * ── 단위는 cm 다 ────────────────────────────────────────────
 * 엔진이 주는 좌표가 cm 이고 옷 한 벌이 대략 100cm 높이다(앞판 20.5 × 96.4,
 * 첫 정점 (-12.33, 30.79, -8.94)). three 의 기본 카메라(near 0.1 / far 2000,
 * 원점에서 z=5)는 미터 단위 씬을 전제한 값이라 그대로 두면 옷이 카메라 안에
 * 파묻힌다. 그래서 카메라를 상수로 두지 않고 **실제 경계 상자에 맞춘다**
 * (`frameCamera()`). 씬이 바뀌어도 스케일 상수를 고칠 일이 없다.
 *
 * ── 조작 (데스크톱 기능 #64~#66) ────────────────────────────
 * OrbitControls 의 기본 배치가 좌드래그 회전 / 우드래그 팬 / 휠 줌으로,
 * 데스크톱 앱과 정확히 같다. 직접 만들 이유가 없다. three 의 `examples/jsm` 에
 * 들어 있어 **별도 패키지가 아니다.**
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { ClothObject } from './cloth.ts';
import { SnapshotObject } from './snapshotView.ts';

export interface Viewer3DOptions {
  canvas: HTMLCanvasElement;
  /** 배경색. 기본 어두운 회색 — 밝은 옷과 대비된다 */
  background?: number;
}

/**
 * 화면에 무엇을 세울지 — **둘 중 하나뿐이다.**
 *
 * - `live`     워커가 40/s 로 보내는 패턴 메시 (`cloth.ts`). **움직인다.**
 *              아바타가 없고 색은 패턴 구분용 임의 팔레트다.
 * - `snapshot` 익스포트한 glTF (`snapshotView.ts`). **정지 화면이다.**
 *              아바타·머티리얼·텍스처가 들어 있다.
 *
 * ★ 둘의 좌표계는 이제 **같다** (ISSUE-011 해결). `cloth.ts` 가 패턴마다 딸려
 *   오는 `transform` 을 `Mesh` 에 걸고, `snapshotView` 는 익스포터의 cm→m
 *   스케일을 100배로 되돌린다. 실측 대조에서 두 옷의 경계 상자가 0.03cm 안에서
 *   일치했다(sample.zls: live min[-24.10, 6.26, -15.00] / glTF min[-24.13,
 *   6.26, -15.03]).
 *
 *   그래도 동시에 켜지 않는 이유는 남는다: **같은 옷이 두 벌** 겹쳐 서므로
 *   두께 0 인 껍질끼리 깊이가 같아 z-파이팅이 나고, 화면에서 "지금 보고 있는
 *   것이 실시간인가 스냅샷인가"를 구분할 수 없다. 어느 쪽이 움직이는지로
 *   판정하게 만드는 것은 확인 방법이 아니라 착시다.
 */
export type ViewMode = 'live' | 'snapshot';

export class Viewer3D {
  readonly cloth = new ClothObject();

  /**
   * 익스포트한 glTF 가 서는 자리 (#: 아바타 + 진짜 색).
   *
   * `SnapshotTarget` 을 구현하므로 `SnapshotLoader` 에 그대로 넘긴다 —
   * 뷰어는 여전히 프로토콜을 모른다. 받아오는 일은 `snapshot.ts` 가 한다.
   */
  readonly snapshot = new SnapshotObject();

  readonly #canvas: HTMLCanvasElement;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #scene = new THREE.Scene();
  readonly #camera: THREE.PerspectiveCamera;
  readonly #controls: OrbitControls;
  readonly #grid: THREE.GridHelper;
  readonly #resizeObserver: ResizeObserver;

  #raf = 0;
  #running = false;
  /** 렌더 루프가 실제로 몇 번 돌았는지. "화면이 멈춘 건가" 를 구분한다 */
  #renders = 0;
  #mode: ViewMode = 'live';

  /**
   * 렌더 직전에 부를 콜백들 (#13 의 프레임 드레인이 여기 붙는다).
   *
   * 이 훅이 있는 이유는 **이 파일이 프로토콜을 모르게 두기 위해서다.** 프레임
   * 갱신을 여기서 직접 하려면 `FrameStream` → `decodePatterns` → `protocol/`
   * 을 끌어와야 하고, 그러면 머리말의 "렌더링과 통신을 갈라 둔다"가 깨진다.
   * 뷰어가 제공하는 것은 **rAF 박자 하나**이고, 그 박자에 무엇을 얹을지는
   * 배선하는 쪽(`main.ts`)이 정한다.
   */
  readonly #beforeRender = new Set<() => void>();
  #lastTickError: Error | null = null;

  constructor(opts: Viewer3DOptions) {
    this.#canvas = opts.canvas;

    this.#renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: true,
      // 3,022 정점짜리 씬이라 성능 여유가 크다. 화질을 택한다.
      powerPreference: 'high-performance',
    });
    // 레티나에서 2배를 넘겨봐야 눈에 안 보이고 픽셀만 4배가 된다.
    this.#renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));

    this.#scene.background = new THREE.Color(opts.background ?? 0x1b1e24);

    // near/far 는 frameCamera() 가 경계에 맞춰 다시 잡는다. 여기 값은 옷이
    // 아직 없을 때(빈 화면)만 쓰인다.
    this.#camera = new THREE.PerspectiveCamera(45, 1, 1, 5000);
    this.#camera.position.set(0, 60, 220);

    this.#controls = new OrbitControls(this.#camera, opts.canvas);
    // 관성. 손을 뗀 뒤 부드럽게 멎는다 — 이게 켜져 있으면 렌더 루프가 항상
    // 돌아야 하므로, 아래 #tick 은 조건 없이 매 프레임 그린다.
    this.#controls.enableDamping = true;
    this.#controls.dampingFactor = 0.08;
    // cm 단위다. 옷 안쪽까지 들어갈 수 있게 최소 거리를 작게 둔다.
    this.#controls.minDistance = 5;
    this.#controls.maxDistance = 4000;
    // 좌=회전 / 우=팬 / 휠=줌. 데스크톱 앱 #64~#66 과 같은 배치이자 기본값이다.
    this.#controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    // 캔버스 위에서 우클릭 메뉴가 뜨면 팬이 끊긴다.
    opts.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.#addLights();

    // 바닥 격자 = **스케일의 눈금**이다. 한 칸이 10cm 라, 옷이 열 칸 남짓이면
    // 100cm 로 제대로 들어온 것이다. 이것 없이는 화면만 보고 스케일을 못 본다.
    this.#grid = new THREE.GridHelper(400, 40, 0x4a5568, 0x2c333f);
    (this.#grid.material as THREE.Material).transparent = true;
    (this.#grid.material as THREE.Material).opacity = 0.5;
    this.#scene.add(this.#grid);

    this.#scene.add(this.cloth.group);
    this.#scene.add(this.snapshot.group);
    // 두 그룹의 visible 을 처음부터 한 곳에서 정한다. 생성자에서 이걸 빼면
    // "아직 setMode 를 안 불렀을 때" 라는 정의되지 않은 상태가 생긴다.
    this.setMode('live');

    this.#resizeObserver = new ResizeObserver(() => this.resize());
    this.#resizeObserver.observe(opts.canvas);
    this.resize();
  }

  get renders(): number {
    return this.#renders;
  }

  get camera(): THREE.PerspectiveCamera {
    return this.#camera;
  }

  get mode(): ViewMode {
    return this.#mode;
  }

  /**
   * 실시간 ↔ 스냅샷을 전환한다. **겹쳐 보이는 상태를 표현할 수 없다.**
   *
   * 두 `visible` 을 **한 값에서 파생**시키는 것이 이 함수의 전부다. 토글을
   * 두 개 두거나 각 그룹의 `visible` 을 밖에서 만지게 두면 "둘 다 켜짐" 이
   * 언젠가 반드시 나온다 — 그리고 그 화면은 같은 자리에 겹쳐 선 옷 두 벌이라
   * z-파이팅으로 얼룩지고, 어느 쪽을 보고 있는지도 알 수 없다
   * (`ViewMode` 주석).
   *
   * ⚠️ 안 보이는 쪽도 **갱신은 계속된다.** `cloth` 는 스냅샷 모드에서도 프레임을
   *    계속 받아 두므로 실시간으로 돌아오는 순간이 즉시다. 숨기는 것은 그리는
   *    것뿐이고 데이터가 아니다.
   */
  setMode(mode: ViewMode): void {
    this.#mode = mode;
    const live = mode === 'live';
    this.cloth.group.visible = live;
    this.snapshot.group.visible = !live;
  }

  /**
   * rAF 박자에 콜백을 얹는다. 돌려주는 함수를 부르면 뗀다.
   *
   * 콜백이 던져도 렌더는 계속된다 — 프레임 갱신 하나가 실패했다고 조작까지
   * 멎으면 원인을 화면에서 확인할 수조차 없다. 대신 삼키지 않고
   * `lastTickError` 에 남긴다.
   */
  onBeforeRender(fn: () => void): () => void {
    this.#beforeRender.add(fn);
    return (): void => {
      this.#beforeRender.delete(fn);
    };
  }

  /** 마지막으로 rAF 콜백이 던진 예외. 정상이면 null */
  get lastTickError(): Error | null {
    return this.#lastTickError;
  }

  get controls(): OrbitControls {
    return this.#controls;
  }

  /**
   * 조명 — 법선이 계산된 값이라는 전제 위에 있다.
   *
   * 반구광 하나로는 어느 쪽에서 봐도 평평해 보여서 주름이 안 읽힌다. 앞쪽
   * 주광과 뒤쪽 보조광을 더해 굴곡을 만든다. 옷이 양면이라 뒤에서 볼 때도
   * 새까맣지 않아야 한다.
   */
  #addLights(): void {
    this.#scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30343c, 1.6));

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(120, 200, 180);
    this.#scene.add(key);

    const fill = new THREE.DirectionalLight(0xc8d4ff, 1.0);
    fill.position.set(-160, 80, -140);
    this.#scene.add(fill);
  }

  /** 캔버스 CSS 크기에 렌더 버퍼를 맞춘다 */
  resize(): void {
    const w = this.#canvas.clientWidth || 1;
    const h = this.#canvas.clientHeight || 1;
    // false: three 가 canvas 의 style 을 건드리지 않게 한다. 크기는 CSS 가 정한다.
    this.#renderer.setSize(w, h, false);
    this.#camera.aspect = w / h;
    this.#camera.updateProjectionMatrix();
  }

  /**
   * 옷 전체가 화면에 들어오도록 카메라·클리핑·격자를 다시 잡는다.
   *
   * 스케일을 코드에 박지 않는 유일한 지점이다. cm 든 m 든, 옷이든 아바타든
   * 경계 상자만 있으면 맞는다.
   */
  frameCamera(padding = 1.35): void {
    // 지금 보이는 쪽에 맞춘다. 스냅샷은 아바타까지 들어 있어 경계가 옷보다
    // 훨씬 크므로(약 170cm), 옷 기준으로 잡으면 머리가 화면 밖으로 나간다.
    const box = this.#mode === 'snapshot' ? this.snapshot.boundingBox() : this.cloth.boundingBox();
    if (box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.5, 1);

    const fov = THREE.MathUtils.degToRad(this.#camera.fov);
    // 세로 화각뿐 아니라 가로도 담아야 한다 — 창이 좁으면 가로가 먼저 잘린다.
    const fovH = 2 * Math.atan(Math.tan(fov / 2) * this.#camera.aspect);
    const dist = (radius / Math.sin(Math.min(fov, fovH) / 2)) * padding;

    // 정면에서 살짝 위. 드레이프된 옷은 정면이 가장 알아보기 쉽다.
    const dir = new THREE.Vector3(0.25, 0.18, 1).normalize();
    this.#camera.position.copy(center).addScaledVector(dir, dist);

    // near 를 너무 작게 잡으면 깊이 정밀도가 날아가 앞뒤 면이 서로를 뚫는다.
    this.#camera.near = Math.max(dist * 0.01, 0.1);
    this.#camera.far = dist + radius * 20;
    this.#camera.updateProjectionMatrix();

    this.#controls.target.copy(center);
    this.#controls.minDistance = radius * 0.05;
    this.#controls.maxDistance = dist * 12;
    this.#controls.update();

    // 격자를 옷 발밑에 붙인다. 한 칸 10cm 를 유지하려고 크기와 분할을 같이 키운다.
    const span = Math.max(size.x, size.z) * 4;
    const cells = Math.max(10, Math.round(span / 10));
    this.#grid.position.set(center.x, box.min.y, center.z);
    this.#grid.scale.setScalar((cells * 10) / 400);
  }

  /** 렌더 루프 시작. 여러 번 불러도 안전하다 */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    const tick = (): void => {
      if (!this.#running) return;
      // 다음 프레임을 **먼저** 예약한다. 아래에서 무엇이 던지든 루프가 끊기지
      // 않는다 — 화면이 통째로 멎는 것이 가장 진단하기 어려운 실패다.
      this.#raf = requestAnimationFrame(tick);
      for (const fn of this.#beforeRender) {
        try {
          fn();
        } catch (err: unknown) {
          this.#lastTickError = err instanceof Error ? err : new Error(String(err));
        }
      }
      // damping 이 켜져 있으면 update() 를 매 프레임 불러야 관성이 돈다.
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
    this.snapshot.clear();
    this.#grid.geometry.dispose();
    (this.#grid.material as THREE.Material).dispose();
    this.#renderer.dispose();
  }
}
