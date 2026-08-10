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

import type { DraftingBounds } from '../viewer2d/index.ts';
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

  // ── 2D 펼침 (#15-b) ────────────────────────────────────────
  //
  // **카메라 객체를 바꾸지 않는다.** `#camera` 하나로 계속 그리고, 투영행렬만
  // 정사영 쪽으로 섞는다. 카메라를 갈아 끼우면 `controls`·`frameCamera`·
  // 하네스가 읽는 `viewer.camera` 가 전부 "지금 어느 카메라냐" 에 의존하게
  // 되고, 무엇보다 **모핑이 아니라 전환**이 된다.
  /** 정사영 쪽 투영행렬의 출처. 씬에 넣지 않는다 — 행렬을 뽑는 용도뿐이다 */
  readonly #ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
  /** 0 = 원근, 1 = 정사영. `setUnfold` 가 정한다 */
  #unfold = 0;
  /** 도면 범위. 정사영 화각과 카메라 목표를 여기서 뽑는다 */
  #drafting: DraftingBounds | null = null;
  /** 펼침이 시작될 때의 카메라 자세. 되돌아올 자리다 */
  readonly #from = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  #fromValid = false;
  /** 매 프레임 새로 만들지 않으려고 잡아 둔다 */
  readonly #blend = new THREE.Matrix4();

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
    // 정사영 화각도 종횡비를 따라야 한다. 창을 줄이면 도면이 옆으로 잘린다.
    // (`#driveUnfold` 가 렌더 직전에 다시 걸므로 여기서는 계산만 해 둔다.)
    if (this.#unfold > 0) this.#fitDrafting();
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
    // 2D 펼침에서 되돌아올 자리. **여기서만 정해진다** — 3D 격자를 놓는 곳이
    // 여기뿐이라, 다른 데서 기억하면 두 값이 갈라진다.
    this.#gridHome = this.#grid.position.clone();
    this.#grid3dScale = this.#grid.scale.x;
  }

  /**
   * 2D 펼침의 카메라 쪽 (#15-b). **정점을 옮기는 것은 `viewer2d/unfold.ts` 다.**
   *
   * 이 함수가 맡는 것은 셋이다: 투영(원근 ↔ 정사영), 카메라 자세, 격자 평면.
   * 셋 다 같은 `t` 하나로 움직이므로 화면 전체가 한 덩어리로 이어진다.
   *
   * ── 왜 정사영인가 ───────────────────────────────────────────
   * **재단 치수를 보는 뷰에서 원근 왜곡은 거짓말이다.** 원근으로 두면 화면
   * 안쪽의 패턴이 실제보다 작게 그려져서, 같은 20cm 가 자리에 따라 다른 길이로
   * 보인다. 격자 한 칸 = 10cm 규약도 그때 깨진다.
   *
   * ── 왜 투영행렬을 섞는가 (카메라를 갈아 끼우지 않고) ────────
   * 원근 카메라와 정사영 카메라를 t 에서 맞바꾸면 그 지점에서 화면이 **튄다.**
   * 두 투영행렬을 성분별로 섞으면 t=0 에서 정확히 원근, t=1 에서 정확히
   * 정사영이면서 중간이 이어진다. 안전한 이유는 w 성분이다 — 원근은
   * `w = −z`(눈앞이면 양수), 정사영은 `w = 1` 이라 섞어도
   * `w = (1−t)(−z) + t` 로 항상 양수다. 0 으로 나누는 자리가 생기지 않는다.
   *
   * ── 카메라 자세는 누구 것인가 ───────────────────────────────
   * `t = 0` 과 `t = 1` 에서는 **사용자 것**이다(OrbitControls 가 산다). 그 사이
   * 에서만 우리가 몬다 — 3D 에서 보던 시점에서 도면 정면까지 데려다 놓는 것이
   * 모핑의 절반이기 때문이다. 양 끝의 자세를 각각 기억해 두므로, 도면에서
   * 확대해 놓고 슬라이더를 되돌리면 **그 자리에서** 3D 로 돌아온다.
   *
   * @param t      0 = 3D, 1 = 2D 도면
   * @param bounds 도면 범위(cm). 한 번 주면 기억한다
   */
  setUnfold(t: number, bounds?: DraftingBounds | null): void {
    if (bounds !== undefined && bounds !== this.#drafting) {
      this.#drafting = bounds;
      // 씬이 바뀌었다. 이전 씬에서 사용자가 잡아 둔 도면 시점은 새 도면과
      // 아무 관계가 없다 — 들고 있으면 새 옷의 도면이 화면 밖에서 시작한다.
      this.#toValid = false;
    }

    const next = t <= 0 ? 0 : t >= 1 ? 1 : t;
    const prev = this.#unfold;
    if (next === prev && bounds === undefined) return;

    // 양 끝을 떠나는 순간의 자세를 붙잡는다. 이게 없으면 되돌아올 자리가
    // 사라져서, 슬라이더를 왕복할 때마다 카메라가 기본 위치로 튄다.
    if (prev === 0 && next > 0) this.#captureFrom();
    if (prev === 1 && next < 1) this.#captureTo();

    this.#unfold = next;

    // ★ 도면에 **도착**하는 순간. 여기서 자세를 한 번 딱 맞춰 준다.
    //   `#driveUnfold` 는 t=1 에서 조작을 사용자에게 넘기느라 자세를 건드리지
    //   않는데, 그러면 카메라가 t=0.99 에서 멈춘 자리에 그대로 남는다 —
    //   실측으로 도면 위쪽(브라 어깨끈)이 화면 밖으로 잘려 나갔다.
    if (next === 1 && prev !== 1) {
      this.#fitDrafting();
      this.#camera.position.copy(this.#to.pos);
      this.#controls.target.copy(this.#to.target);
      this.#camera.lookAt(this.#controls.target);
      // 이제부터 `#to` 는 **사용자가 잡은 자리**다. 다시 계산해 덮어쓰지 않는다.
      this.#toValid = true;
    }

    // 양 끝에서만 조작을 돌려준다. 그 사이는 우리가 몰고 있어서, 켜 두면
    // 사용자의 드래그와 보간이 같은 값을 두고 싸운다(관성 때문에 손을 떼도
    // 계속 싸운다).
    this.#controls.enabled = next === 0 || next === 1;
    // 도면에서는 회전을 잠근다. 재단 도면을 비스듬히 보는 것은 원근 왜곡을
    // 없앤 이유를 스스로 무르는 일이다. 팬과 줌은 살려 둔다 — 치수를 보려면
    // 확대가 필요하다.
    this.#controls.enableRotate = next < 1;

    if (next === 0) {
      // 완전히 3D 다. 투영도 카메라도 손대지 않은 상태로 되돌린다 —
      // **이 경로가 "2D 를 안 쓰는 동안은 이 기능이 없는 것과 같다" 를 보장한다.**
      this.#camera.updateProjectionMatrix();
      this.#fromValid = false;
      // ★ 격자도 되돌린다. **투영은 저절로 돌아오는데 격자는 아니다** —
      //   그 비대칭이 이 버그의 전부였다(t 를 밀었다 되돌리면 옷·투영·카메라는
      //   3D 인데 격자만 도면 자리에 비스듬히 남았다).
      //
      //   왜 갈리는가: 투영행렬은 **재구성할 원본이 있다.** fov·aspect·near·far
      //   가 카메라에 그대로 남아 있어서 위의 `updateProjectionMatrix()` 한 줄이
      //   언제든 원근을 다시 만들어 낸다. 격자의 3D 자리는 그런 원본이 없다 —
      //   `#gridHome`/`#grid3dScale` 에만 있고, **돌아오는 길에 그걸 읽는
      //   사람이 없었다.** 그래서 되돌리는 일을 명시적으로 해 줘야 한다.
      this.#restoreGrid();
      return;
    }

    this.#driveUnfold();
  }

  /** 지금 펼침 정도 (0 = 3D, 1 = 2D) */
  get unfold(): number {
    return this.#unfold;
  }

  #captureFrom(): void {
    this.#from.pos.copy(this.#camera.position);
    this.#from.target.copy(this.#controls.target);
    this.#fromValid = true;
  }

  /** 도면 쪽 자세. 사용자가 도면에서 움직여 놨으면 그 자리를 기억한다 */
  readonly #to = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  #toValid = false;

  #captureTo(): void {
    this.#to.pos.copy(this.#camera.position);
    this.#to.target.copy(this.#controls.target);
    this.#toValid = true;
  }

  /**
   * 도면을 정면으로 보는 자세와 정사영 화각을 계산한다.
   *
   * 도면은 월드 XY 평면(z = 0)에 있으므로 **−Z 방향으로 내려다본다.**
   * 창이 좁으면 가로가 먼저 잘리므로 세로·가로를 둘 다 담는다.
   */
  #fitDrafting(): void {
    const b = this.#drafting;
    if (!b) return;

    const aspect = this.#camera.aspect || 1;
    // ★ 여백이 큰 이유는 **화면 위아래를 다른 것이 덮고 있기 때문**이다.
    //   상단 `.bar`(약 70px)는 불투명하고 하단에는 힌트·슬라이더(약 40px)가
    //   있다. 800px 중 실제로 보이는 띠는 690px 뿐이라, 딱 맞게 잡으면
    //   도면 위쪽이 바 뒤로 들어간다 — 실측으로 브라 어깨끈이 잘렸다.
    //   690/800 을 되돌리면 1.16 이 최소이고, 눈에 보이는 여백까지 두어 1.28.
    const pad = 1.28;
    let halfH = Math.max(b.height, 1) * 0.5 * pad;
    let halfW = Math.max(b.width, 1) * 0.5 * pad;
    // 종횡비에 맞춰 넓은 쪽을 기준으로 키운다.
    if (halfW / halfH > aspect) halfH = halfW / aspect;
    else halfW = halfH * aspect;

    this.#ortho.left = -halfW;
    this.#ortho.right = halfW;
    this.#ortho.top = halfH;
    this.#ortho.bottom = -halfH;
    this.#ortho.near = 0.1;
    this.#ortho.far = Math.max(halfH, halfW) * 20 + 1000;
    this.#ortho.updateProjectionMatrix();

    // 원근 쪽도 같은 크기로 보이게 거리를 잡는다. 이래야 투영을 섞는 동안
    // 도면 크기가 출렁이지 않는다.
    const fov = THREE.MathUtils.degToRad(this.#camera.fov);
    this.#draftDist = halfH / Math.tan(fov / 2);

    if (!this.#toValid) {
      this.#to.target.set(b.centerX, b.centerY, 0);
      this.#to.pos.set(b.centerX, b.centerY, this.#draftDist);
    }
  }

  /** 도면을 꽉 채우는 기준 거리. 줌을 환산하는 분자다 */
  #draftDist = 0;

  /** `t` 를 카메라·투영·격자에 반영한다 */
  #driveUnfold(): void {
    const t = this.#unfold;
    if (t === 0) return;
    this.#fitDrafting();
    if (!this.#fromValid) this.#captureFrom();

    // 끝에서 부드럽게 붙도록 완만하게 만든다. 선형으로 두면 슬라이더를 놓는
    // 순간 카메라가 딱 멈춰서 기계적으로 보인다.
    const e = t * t * (3 - 2 * t);

    // 양 끝에서는 조작이 살아 있으므로 우리가 자세를 덮어쓰지 않는다.
    if (t < 1) {
      this.#camera.position.lerpVectors(this.#from.pos, this.#to.pos, e);
      this.#controls.target.lerpVectors(this.#from.target, this.#to.target, e);
      this.#camera.lookAt(this.#controls.target);
    }

    // 클리핑을 자세에 맞춰 다시 잡는다. 도면이 near 안쪽에 들어가면 통째로
    // 사라지는데, 원인이 화면에 아무 흔적도 안 남는다.
    const span = this.#camera.position.distanceTo(this.#controls.target);
    this.#camera.near = Math.max(span * 0.001, 0.1);
    this.#camera.far = span * 10 + 2000;
    this.#camera.updateProjectionMatrix();

    // ★ 휠 줌을 정사영에 옮긴다. OrbitControls 는 원근 카메라를 **가까이
    //   끌어당겨** 확대하는데, 정사영에서는 거리가 크기를 바꾸지 않는다 —
    //   그대로 두면 도면에서 휠이 아무 일도 안 하는 것처럼 보인다(카메라는
    //   실제로 움직이고 있어서 원인을 찾기 어렵다). 거리비를 `zoom` 으로
    //   환산하면 같은 손동작이 같은 결과를 낸다.
    if (this.#draftDist > 0) {
      this.#ortho.zoom = this.#draftDist / Math.max(span, 1e-3);
      this.#ortho.updateProjectionMatrix();
    }

    // ★ 투영행렬을 성분별로 섞는다 (머리말 참고). `updateProjectionMatrix()`
    //   가 방금 원근으로 덮어썼으므로 **반드시 그 뒤에** 온다.
    const p = this.#camera.projectionMatrix.elements;
    const o = this.#ortho.projectionMatrix.elements;
    const out = this.#blend.elements;
    for (let i = 0; i < 16; i++) out[i] = (p[i] ?? 0) * (1 - t) + (o[i] ?? 0) * t;
    this.#camera.projectionMatrix.copy(this.#blend);
    this.#camera.projectionMatrixInverse.copy(this.#blend).invert();

    this.#driveGrid(t);
  }

  /**
   * 격자를 도면 평면으로 눕힌다.
   *
   * `GridHelper` 는 XZ 평면에 있어서 도면(XY)에서는 **모로 서서 선 하나로**
   * 보인다. X 축으로 90° 돌려 XY 로 옮긴다. 한 칸 10cm 규약은 그대로 따라온다 —
   * 단위가 cm 로 같으므로 공짜다(`index.html` 의 힌트가 2D 에서도 참이 된다).
   */
  #driveGrid(t: number): void {
    const b = this.#drafting;
    if (!b) return;
    // 되돌릴 것이 생겼다고 표시한다. `#restoreGrid` 가 이 깃발만 보고 일한다.
    this.#gridDisplaced = true;
    this.#grid.rotation.x = (Math.PI / 2) * t;
    // 3D 자리 → 도면 평면. 도면은 z = 0 이고, 격자를 살짝 뒤로 밀어 패턴과
    // 깊이가 겹치지 않게 한다(둘 다 평면이라 z 가 같으면 얼룩진다).
    this.#gridHome ??= this.#grid.position.clone();
    this.#grid.position.set(
      THREE.MathUtils.lerp(this.#gridHome.x, b.centerX, t),
      THREE.MathUtils.lerp(this.#gridHome.y, b.centerY, t),
      THREE.MathUtils.lerp(this.#gridHome.z, -0.5, t),
    );
    // ★ 도면에서는 **배율 1 이 정답이다.** `GridHelper(400, 40)` 은 한 칸이
    //   정확히 10 단위(= 10cm)이므로 배율을 건드리는 순간 한 칸이 10cm 가
    //   아니게 된다. 400cm 짜리 격자가 도면(144 × 175cm)을 넉넉히 덮는다.
    //   화면 아래 힌트의 "격자 한 칸 = 10cm" 가 도면에서 **글자 그대로 참**이
    //   되는 자리다 — 재단 치수를 눈으로 재는 뷰에서 이게 어긋나면 격자가
    //   자가 아니라 장식이 된다.
    const scale3d = this.#grid3dScale ?? this.#grid.scale.x;
    this.#grid.scale.setScalar(THREE.MathUtils.lerp(scale3d, 1, t));
  }

  /**
   * 격자를 3D 자리로 되돌린다 — **t=0 으로 돌아온 순간 한 번.**
   *
   * ── 조기 반환의 의도를 살린다 ───────────────────────────────
   * `setUnfold` 의 `t=0` 분기는 "2D 를 안 쓰는 동안 비용 0" 을 위한 것이고,
   * 렌더 루프의 `if (this.#unfold > 0)` 도 같은 뜻이다. 그 의도를 지키려고
   * 여기서는 **깃발 하나만 보고 즉시 되돌아온다** — 격자가 옮겨진 적이
   * 없으면(= 한 번도 안 펼쳤으면) 불리언 비교 하나가 전부다. 매 프레임
   * `#driveGrid(0)` 을 부르는 쪽으로 고치면 안 쓰는 기능이 렌더 루프에
   * 상주하게 되고, 그건 이 분기가 애초에 없애려던 것이다.
   *
   * ── 보간이 아니라 **딱 되돌린다** ───────────────────────────
   * `#driveGrid(0)` 을 부르지 않는 이유는 하나이고, 그것으로 충분하다:
   * **그쪽은 `#drafting` 이 있어야 동작한다.** 씬을 내리면(`clearScene` →
   * `paintUnfold` → `setUnfold(0, null)`) bounds 가 null 이 되는데, 하필
   * 그때가 격자를 반드시 되돌려야 하는 순간이다 — 조건이 서로 어긋나서
   * 격자가 도면 자리에 영영 남는다.
   *
   * (`lerp(a, b, 0)` 자체는 IEEE754 에서도 정확히 `a` 다. 그건 이유가 아니다.
   *  다만 기억해 둔 값을 그대로 대입하는 편이 읽는 사람에게 "정확히 되돌린다"
   *  를 보이는 데 짧다 — 하네스가 배율을 1e-6 으로 맞춘다.)
   */
  #restoreGrid(): void {
    if (!this.#gridDisplaced) return;
    this.#gridDisplaced = false;
    this.#grid.rotation.x = 0;
    if (this.#gridHome) this.#grid.position.copy(this.#gridHome);
    if (this.#grid3dScale !== null) this.#grid.scale.setScalar(this.#grid3dScale);
  }

  /** 3D 에서의 격자 자리. 되돌아올 때 쓴다 */
  #gridHome: THREE.Vector3 | null = null;
  #grid3dScale: number | null = null;
  /** 격자가 도면 쪽으로 옮겨져 있는가. `#restoreGrid` 의 유일한 조건 */
  #gridDisplaced = false;

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
      // ★ 펼침 중이면 **렌더 직전에 다시 건다.** `resize()` 와 조작이
      //   `updateProjectionMatrix()` 로 원근 행렬을 되살려 놓기 때문이다 —
      //   한 프레임이라도 놓치면 도면을 보다가 화면이 원근으로 튄다.
      //   `t = 0` 이면 이 줄은 아무 일도 하지 않는다.
      if (this.#unfold > 0) this.#driveUnfold();
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
