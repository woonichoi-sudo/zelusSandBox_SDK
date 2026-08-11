/**
 * 텍스처를 **실제로 받아서 재질에 거는** 자리 (materials-c).
 *
 * 판단(어느 슬롯·몇 번 반복·켜졌나)은 전부 `panels/textures.ts` 가 끝냈다.
 * 여기 있는 것은 three 고유의 세 가지뿐이고, 셋 다 빠뜨리면 화면이 조용히
 * 틀린다:
 *
 * ── ① 같은 URL 은 한 번만 받는다 ────────────────────────────
 * `eyelashes_alp.png` 하나가 basecolor·alpha 두 슬롯에, 게다가 좌우 속눈썹이
 * 공유해 **네 번** 참조된다. `TextureLoader` 를 그대로 부르면 같은 이미지를
 * 네 번 받고 GPU 에도 네 벌이 올라간다. 워커가 표를 만들어 중복을 없앤 것이
 * 여기서 되살아나면 그 설계가 무의미해진다.
 *
 * ⚠️ **캐시 키에 색공간이 들어간다.** 같은 파일이 basecolor(sRGB)와
 *    alpha(선형)로 동시에 쓰이므로(속눈썹이 정확히 그렇다) 한 `Texture` 를
 *    공유하면 `colorSpace` 를 둘 중 하나로 정해야 하고, 어느 쪽으로 정하든
 *    한쪽이 틀린다. 이미지 자체는 브라우저 캐시가 한 번만 받는다 — 우리가
 *    두 벌 만드는 것은 GPU 텍스처뿐이다.
 *
 * ── ② 색공간은 basecolor 에만 ───────────────────────────────
 * basecolor 만 sRGB 다. normal 은 방향 벡터고 alpha 는 마스크라, 여기에
 * sRGB 감마를 걸면 값이 통째로 어긋난다 — 노멀맵은 요철이 부풀고 알파는
 * 경계가 뭉개진다. three 의 기본값이 `NoColorSpace`(= 선형)이므로 **건드리지
 * 않는 것이 맞다.**
 *
 * ── ③ 비동기가 늦게 도착한다 ────────────────────────────────
 * 19.7MB 라 첫 로드가 눈에 띄게 걸린다. 그 사이 화면은 지금까지처럼(색으로)
 * 그려져야 하고, 도착하면 그 자리에서 갈아 끼운다. 그런데 도착했을 때
 * **이미 씬이 바뀌었을 수 있다** — 그때 옛 텍스처를 새 재질에 걸면 다른 씬의
 * 무늬가 입혀진다. 세대 번호(`#generation`)가 그것을 막는다.
 */

import * as THREE from 'three';

import type { TexturePlan } from '../panels/index.ts';

/** 어느 슬롯이 sRGB 인가. **basecolor 하나뿐이다** (머리말 ②) */
const SRGB_SLOTS = new Set(['basecolor']);

/**
 * URL → `THREE.Texture` 캐시. 뷰어 하나당 하나 두고 씬을 갈아 끼울 때 비운다.
 *
 * 키가 `URL|색공간|flipY` 인 이유는 머리말 ① 참고 — 같은 파일이 다른 해석으로
 * 두 번 쓰인다.
 */
export class TextureCache {
  readonly #loader = new THREE.TextureLoader();
  readonly #byKey = new Map<string, THREE.Texture>();

  /** 로드가 끝난 뒤 `renderer.render` 를 한 번 더 돌리라고 알린다 */
  #onLoad: (() => void) | null = null;
  #onError: ((url: string) => void) | null = null;

  /**
   * 씬 세대. 이 값이 바뀐 뒤에 도착한 로드는 버린다.
   *
   * ⚠️ 없으면 "씬 A 로드 → 곧바로 씬 B 로드 → A 의 9.5MB 가 나중에 도착" 에서
   *    B 의 옷에 A 의 무늬가 붙는다. 크래시가 없어 화면만 보고는 못 찾는다.
   */
  #generation = 0;

  constructor(hooks: { onLoad?: () => void; onError?: (url: string) => void } = {}) {
    this.#onLoad = hooks.onLoad ?? null;
    this.#onError = hooks.onError ?? null;
  }

  get size(): number {
    return this.#byKey.size;
  }

  get generation(): number {
    return this.#generation;
  }

  /**
   * 텍스처 하나. **동기로 객체를 돌려주고 이미지는 나중에 채워진다** —
   * three 의 규약 그대로다(`needsUpdate` 는 로더가 세운다).
   */
  get(url: string, slot: string, flipY: boolean): THREE.Texture {
    const srgb = SRGB_SLOTS.has(slot);
    const key = `${url}|${srgb ? 's' : 'l'}|${flipY ? 'y' : 'n'}`;
    const hit = this.#byKey.get(key);
    if (hit) return hit;

    const gen = this.#generation;
    const tex = this.#loader.load(
      url,
      () => {
        // 늦게 도착했다. 씬이 이미 바뀌었으면 그릴 자리가 없다.
        if (gen === this.#generation) this.#onLoad?.();
      },
      undefined,
      () => { this.#onError?.(url); },
    );

    // ★ 기본값이 `ClampToEdgeWrapping` 이라 그냥 두면 **반복이 아예 안 일어난다** —
    //   repeat 를 0.033 로 잡아도 UV 1 을 넘는 자리가 가장자리 픽셀로 늘어나
    //   천이 한 방향으로 죽죽 늘어난 것처럼 보인다.
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.flipY = flipY;
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    // 비스듬히 보는 천의 무늬가 뭉개지는 것을 막는다. 8 은 대부분의 GPU 상한이고
    // three 가 초과분을 알아서 깎는다.
    tex.anisotropy = 8;

    this.#byKey.set(key, tex);
    return tex;
  }

  /** 씬이 바뀐다. 세대를 올려 **이미 떠 있는 로드의 결과를 무효로** 만든다 */
  bumpGeneration(): void {
    this.#generation += 1;
  }

  /** GPU 자원까지 해제한다. 씬을 갈아 끼울 때 반드시 부른다 */
  clear(): void {
    this.bumpGeneration();
    for (const t of this.#byKey.values()) t.dispose();
    this.#byKey.clear();
  }
}

/**
 * 재질 하나에 계획을 건다. `plan` 이 null 이면 **떼어 낸다**(= 색만 남는다).
 *
 * ⚠️ `needsUpdate` 를 반드시 세운다. three 는 맵이 붙고 떨어질 때 셰이더를 다시
 *    컴파일해야 하는데, 그 판단을 이 플래그로만 한다 — 빼면 텍스처를 걸어도
 *    화면이 안 바뀌고(껐다 켜는 스위치가 통째로 안 먹는다), 원인이 여기 있다는
 *    단서가 화면에 하나도 없다.
 */
export function applyPlan(
  material: THREE.MeshStandardMaterial,
  plan: TexturePlan | null,
  cache: TextureCache,
): void {
  const before = material.map;

  if (!plan) {
    material.map = null;
    material.normalMap = null;
    material.alphaMap = null;
  } else {
    material.map = plan.slots.basecolor
      ? tune(cache.get(plan.slots.basecolor, 'basecolor', plan.flipY), plan)
      : null;
    material.normalMap = plan.slots.normal
      ? tune(cache.get(plan.slots.normal, 'normal', plan.flipY), plan)
      : null;
    material.alphaMap = plan.slots.alpha
      ? tune(cache.get(plan.slots.alpha, 'alpha', plan.flipY), plan)
      : null;
  }

  // ★ 알파맵은 `transparent` 없이는 무시된다. 속눈썹이 정확히 이 경우고,
  //   빼면 눈 위에 검은 판때기가 선다. `depthWrite` 를 끄는 것도 같은 이유다
  //   (`avatar.ts` 의 `#materialFor` 와 같은 판단).
  if (material.alphaMap) {
    material.transparent = true;
    material.depthWrite = false;
  }

  // 셰이더 재컴파일이 필요한 변화가 맵의 **유무**다. 값만 바뀌는 경우는 공짜지만,
  // 구분해서 세면 한쪽을 빠뜨린다 — 로드/토글에만 불리므로 늘 세운다.
  material.needsUpdate = true;
  void before;
}

/** 반복 배수를 텍스처에 건다. 캐시가 공유하는 객체라 **매번 다시 쓴다** */
function tune(tex: THREE.Texture, plan: TexturePlan): THREE.Texture {
  // ⚠️ 같은 파일을 두 직물이 공유하면 여기서 마지막 값이 이긴다. 실측된 씬에는
  //    그런 경우가 없다(직물마다 자기 파일이다). 생기면 캐시 키에 repeat 를
  //    더해야 하는데, 지금 넣으면 없는 문제에 대비해 텍스처를 두 벌 만들게 된다.
  tex.repeat.set(plan.repeat[0], plan.repeat[1]);
  return tex;
}
