/**
 * 재단 도면의 **디자인 정보**를 three 객체로 세운다 (D2-c).
 *
 * `cloth.ts`·`unfold.ts` 와 같은 층위다 — **DOM 을 안 쓴다**(three 의 자료구조
 * 뿐). 그래서 Node 에서 그대로 돌고, 이 프로젝트에서 자동 테스트가 붙는 유일한
 * 자리에 남는다. 캔버스·배선은 `viewer2d.ts` 와 `main.ts` 의 일이다.
 *
 * ── ★ 좌표를 다시 변환하지 않는다 ───────────────────────────
 *
 * 워커가 `atWorld` 로 배치까지 끝낸 값을 준다(D2-a). 같은 칸의 옷 메시는
 * 패턴 로컬이라 `transform2d` 를 곱해 세우는데(#15), **여기에 그것을 또
 * 곱하면 두 번 적용된다.** 그 증상은 "패턴이 좀 흩어져 보인다" 로만 보여서
 * 원인을 못 찾는다. 실측으로 확인된 전제다 — 전체 범위 144.24 × 175.45cm 가
 * L-2a 의 도면 크기와 소수점까지 같다.
 *
 * ── 색은 우리가 정한다 (데이터에 없다) ──────────────────────
 *
 * 참고 이미지에서 변마다 다른 색이 보이는데, 실측 결과 **그 색은 씬에 없다** —
 * 스티치가 가진 색은 회색 50개·흰색 4개뿐이다. 그러므로 색은 데이터가 아니라
 * **표현**이고, 우리가 배정한다. 무엇을 구분하려는 색인가가 곧 규칙이다:
 * **봉제선 하나 = 색 하나.** 45개가 서로 구분되면 "이 변이 저 변과 꿰매진다"
 * 를 눈으로 따라갈 수 있고, 그것이 이 화면의 목적이다.
 *
 * ⚠️ 이 프로젝트에는 "패턴 구분용 임의 5색" 이라는 전례가 있다(실시간 뷰).
 *    같은 성격이므로 **엔진이 준 색인 척하지 않는다** — 스티치만 자기 색을
 *    쓰고, 나머지는 전부 우리가 만든 값이다.
 *
 * ── 선 굵기에 기대지 않는다 ─────────────────────────────────
 *
 * ⚠️ `LineBasicMaterial.linewidth` 는 대부분의 플랫폼에서 **무시되고 1px 로
 *    고정된다**(WebGL 의 제약이다). 그래서 굵기로 종류를 구분하려 하면 화면에서
 *    전부 같은 선이 된다. 여기서는 **색과 z 순서**로만 구분한다.
 */

import * as THREE from 'three';

import type {
  Design2DCurve,
  Design2DResult,
  Design2DSeam,
} from '../protocol/index.ts';

/**
 * 겹쳐 그리는 순서. 도면은 전부 z=0 평면에 있으므로 **살짝씩 띄우지 않으면
 * 얼룩진다**(z-fighting). 값 자체는 의미가 없고 **순서만이 의미다.**
 * 옷 메시가 0 근처에 있으므로 전부 그 앞(+z)에 둔다.
 */
const Z = {
  /** 외곽선 — 가장 아래. 다른 것이 그 위에 얹힌다 */
  outer: 0.5,
  /** 내부선(다트 등) */
  inner: 0.6,
  /** 스티치 — 실제 실이라 도면선보다 앞이다 */
  stitch: 0.7,
  /** 봉제선 구간 — 색으로 짝을 말한다 */
  seam: 0.8,
  /** 봉제 대응 점선 — 패턴 사이를 가로지르므로 가장 앞 */
  link: 0.9,
  /** 제어점 — 점이 선에 묻히면 안 된다 */
  vertex: 1.0,
};

/** 도면선 색. 흰 종이 위라서 **어두운 값**이어야 한다 */
const COLOR = {
  outer: 0x1b1f27,
  inner: 0x8892a4,
  /** 앵커(끝점) — `ztDesignVertexType` 0 */
  anchor: 0xe4572e,
  /** 핸들(제어) — 앵커보다 옅다. 만질 수 없는 점이라는 뜻이다 */
  handle: 0x6d8cff,
  /** 봉제 대응선. 색이 있는 봉제 구간과 달리 **중립색**이어야 짝 색을 안 흐린다 */
  link: 0x9aa4b8,
};

/**
 * 봉제선 하나에 색 하나. **황금각으로 돌린다.**
 *
 * 팔레트 N개를 돌려 쓰면 45개에서 반드시 같은 색이 여러 번 나오고, 하필
 * 가까이 놓인 둘이 같은 색이면 "이 둘이 꿰매진다" 는 거짓 신호가 된다.
 * 황금각(137.5°)은 몇 개를 뽑든 이웃끼리 최대한 벌어진다.
 *
 * 채도·명도를 고정하는 이유: 흰 종이 위에서 읽혀야 하고, 밝기가 들쭉날쭉하면
 * 어떤 봉제선은 안 보인다. **구분은 색상(hue)만으로 한다.**
 */
export function seamColor(index: number): THREE.Color {
  const hue = ((index * 137.508) % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.72, 0.42);
}

/** 폴리라인 `[x,y,...]` → 이어진 선분들의 정점 배열 (three 는 쌍으로 받는다) */
function polylineSegments(pts: number[], z: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + 3 < pts.length; i += 2) {
    out.push(pts[i]!, pts[i + 1]!, z);
    out.push(pts[i + 2]!, pts[i + 3]!, z);
  }
  return out;
}

/** 선분 배열에서 `LineSegments` 하나를 만든다. 비었으면 null */
function segmentsObject(
  verts: number[],
  color: number | THREE.Color,
  opts: { dashed?: boolean; opacity?: number } = {},
): THREE.LineSegments | null {
  if (verts.length === 0) return null;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));

  const material = opts.dashed
    ? new THREE.LineDashedMaterial({
        color,
        dashSize: 1.2,
        gapSize: 0.9,
        transparent: opts.opacity !== undefined,
        opacity: opts.opacity ?? 1,
      })
    : new THREE.LineBasicMaterial({
        color,
        transparent: opts.opacity !== undefined,
        opacity: opts.opacity ?? 1,
      });

  const line = new THREE.LineSegments(geom, material);
  // ⚠️ 점선은 이것을 안 부르면 **실선으로 나온다.** 셰이더가 정점별 누적
  //    거리를 쓰는데 그 속성이 여기서 만들어진다.
  if (opts.dashed) line.computeLineDistances();
  return line;
}

export interface Design2DLayerView {
  curves: number;
  vertices: number;
  seams: number;
  /** 대응선을 실제로 그은 봉제선 수. `seams` 보다 작을 수 있다 */
  links: number;
  stitches: number;
}

/**
 * 디자인 정보 한 벌. `viewer2d` 의 씬에 `group` 하나만 붙이면 된다.
 *
 * 다시 `build()` 하면 이전 것을 **정리하고** 새로 세운다 — 씬을 바꿔 로드할
 * 때 옛 도면이 남아 겹치면 "패턴이 두 벌 보인다" 가 된다.
 */
export class Design2DLayer {
  readonly group = new THREE.Group();

  #view: Design2DLayerView = { curves: 0, vertices: 0, seams: 0, links: 0, stitches: 0 };

  get view(): Design2DLayerView {
    return { ...this.#view };
  }

  build(d: Design2DResult): void {
    this.clear();

    // ── ① 도면선 ────────────────────────────────────────────
    //
    // 종류별로 **객체를 나눈다.** 하나로 합치면 색을 못 가르고, 나중에
    // "내부선만 끄기" 같은 것을 붙일 자리도 사라진다.
    const byKind = new Map<string, number[]>();
    const anchors: number[] = [];
    const handles: number[] = [];
    let curveCount = 0;

    for (const s of d.surfaces) {
      for (const c of s.curves) {
        const z = c.kind === 'outer' ? Z.outer : Z.inner;
        const bucket = byKind.get(c.kind) ?? [];
        bucket.push(...polylineSegments(c.pts, z));
        byKind.set(c.kind, bucket);
        curveCount++;

        collectControlPoints(c, anchors, handles);
      }
    }

    for (const [kind, verts] of byKind) {
      const line = segmentsObject(verts, kind === 'outer' ? COLOR.outer : COLOR.inner);
      if (line) {
        line.name = `curves:${kind}`;
        this.group.add(line);
      }
    }

    // ── ② 제어점 ────────────────────────────────────────────
    //
    // 참고 이미지의 원들이다. 앵커와 핸들을 색으로 가른다 — 앵커는 도면의
    // 실제 꼭짓점이고 핸들은 곡률을 정하는 보조점이라, 같은 색으로 두면
    // 도면을 읽을 때 꼭짓점 개수를 잘못 세게 된다.
    const anchorPts = pointsObject(anchors, COLOR.anchor, 3.4);
    if (anchorPts) {
      anchorPts.name = 'vertices:anchor';
      this.group.add(anchorPts);
    }
    const handlePts = pointsObject(handles, COLOR.handle, 2.2);
    if (handlePts) {
      handlePts.name = 'vertices:handle';
      this.group.add(handlePts);
    }

    // ── ③ 스티치 ────────────────────────────────────────────
    //
    // **자기 색을 쓴다** — 이 레이어에서 유일하게 엔진이 준 색이다.
    // 실측은 회색·흰색 2종뿐이지만 그 사실을 코드에 박지 않는다(다른 씬에서
    // 다를 수 있고, 박아 두면 그때 조용히 틀린 색이 된다).
    let stitchCount = 0;
    for (const st of d.stitches) {
      const verts: number[] = [];
      for (const c of st.curves) verts.push(...polylineSegments(c.pts, Z.stitch));
      const [r, g, b] = st.color;
      const line = segmentsObject(verts, new THREE.Color(r ?? 0.5, g ?? 0.5, b ?? 0.5));
      if (line) {
        line.name = `stitch:${st.uuid}`;
        this.group.add(line);
        stitchCount++;
      }
    }

    // ── ④ 봉제선 + 대응 점선 ────────────────────────────────
    //
    // 이 화면의 핵심이다. 같은 색의 두 구간이 서로 꿰매지고, 점선이 그 둘을
    // 잇는다. 실측: 45개 중 42개가 **패턴을 가로지른다** — 그 42개가 참고
    // 이미지에서 길게 뻗은 점선이다.
    const linkVerts: number[] = [];
    const linkColors: number[] = [];
    let seamCount = 0;
    let linkCount = 0;

    d.seams.forEach((seam: Design2DSeam, i: number) => {
      // ★ **엔진이 준 색이 정본이다.** 우리 팔레트는 폴백일 뿐이다 —
      //   실측 22종이고 참고 이미지의 알록달록함이 바로 이 색이다.
      const color = seam.color && seam.color.length >= 3
        ? new THREE.Color(seam.color[0]!, seam.color[1]!, seam.color[2]!)
        : seamColor(i);
      const verts: number[] = [];

      for (const side of seam.sides) {
        for (const part of side) {
          verts.push(...polylineSegments(part.pts, Z.seam));
        }
      }

      const line = segmentsObject(verts, color);
      if (line) {
        line.name = `seam:${seam.uuid}`;
        this.group.add(line);
        seamCount++;
      }

      // ── 대응선: **개수도 위치도 엔진이 정한다** ───────────
      //
      // ⚠️ 여기를 두 번 틀렸다. 처음엔 측마다 중점 하나씩(45줄), 다음엔
      //    길이 4cm 마다(199줄)로 **지어냈다.** 엔진이 주는 것은 108줄
      //    (봉제선당 2~4)이고, 데스크톱 `RenderSewingLines` 가 쓰는 값이
      //    바로 그것이다. 우리가 개수를 정하면 데스크톱과 다른 그림이
      //    나오는데, 그 차이는 "점선이 좀 많은/적은 것 같다" 로만 보여서
      //    화면으로는 무엇이 옳은지 못 가른다.
      for (const L of seam.links ?? []) {
        if (L.length < 4) continue;
        linkVerts.push(L[0]!, L[1]!, Z.link, L[2]!, L[3]!, Z.link);
        // 선분의 양 끝에 같은 색. 정점 색이라 선마다 다른 색이 된다
        linkColors.push(color.r, color.g, color.b, color.r, color.g, color.b);
        linkCount++;
      }
    });

    // ⚠️ 봉제선마다 객체를 만들지 않고 **하나로 합친다.** 45개가 각자
    //    LineSegments 면 드로콜이 그만큼 늘고, 점선 재질은 색만 다를 뿐
    //    나머지가 같다. 정점 색으로 색을 싣는다.
    const links = dashedLinks(linkVerts, linkColors);
    if (links) {
      links.name = 'seam:links';
      this.group.add(links);
    }

    this.#view = {
      curves: curveCount,
      vertices: anchors.length / 3 + handles.length / 3,
      seams: seamCount,
      links: linkCount,
      stitches: stitchCount,
    };
  }

  /** 세운 것을 전부 지우고 GPU 자원을 반납한다 */
  clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      const obj = child as THREE.Mesh;
      obj.geometry?.dispose();
      const m = obj.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose();
    }
    this.#view = { curves: 0, vertices: 0, seams: 0, links: 0, stitches: 0 };
  }

  get visible(): boolean {
    return this.group.visible;
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }
}

/**
 * 커브의 제어점 4개를 앵커/핸들로 가른다.
 *
 * 3차 베지어의 관례대로 **0번과 3번이 앵커, 1번과 2번이 핸들**이다.
 * ⚠️ 직선(`isLine`)은 핸들이 의미가 없다 — 엔진이 값을 채워 두더라도 곡률을
 *    만들지 않으므로, 그리면 아무 데도 안 붙은 점이 떠 있는 것처럼 보인다.
 */
function collectControlPoints(c: Design2DCurve, anchors: number[], handles: number[]): void {
  const cp = c.cp;
  if (cp.length < 8) return;

  anchors.push(cp[0]!, cp[1]!, Z.vertex);
  anchors.push(cp[6]!, cp[7]!, Z.vertex);

  if (!c.isLine) {
    handles.push(cp[2]!, cp[3]!, Z.vertex);
    handles.push(cp[4]!, cp[5]!, Z.vertex);
  }
}

/**
 * 봉제 대응선 전부를 담은 점선 객체 하나. **색은 정점에 실린다.**
 *
 * `LineDashedMaterial` 은 `vertexColors` 를 받으므로 봉제선마다 객체를 나눌
 * 필요가 없다. 45개를 따로 만들면 드로콜만 늘고 얻는 것이 없다.
 */
function dashedLinks(verts: number[], colors: number[]): THREE.LineSegments | null {
  if (verts.length === 0) return null;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  const line = new THREE.LineSegments(
    geom,
    new THREE.LineDashedMaterial({
      vertexColors: true,
      // 흰 종이 위에서 점선이 도면선을 덮지 않을 만큼만 진하다. 그물이라
      // 불투명하면 패턴이 안 보인다.
      transparent: true,
      opacity: 0.75,
      dashSize: 1.1,
      gapSize: 1.0,
    }),
  );
  // ⚠️ 이것을 안 부르면 **실선으로 나온다** — 셰이더가 쓰는 정점별 누적
  //    거리가 여기서 만들어진다.
  line.computeLineDistances();
  return line;
}

/**
 * 점 무리 하나. `sizeAttenuation: false` 라서 **줌을 해도 점 크기가 안 변한다** —
 * 도면을 확대해 치수를 볼 때 점이 같이 커지면 정작 선이 가려진다.
 */
function pointsObject(verts: number[], color: number, size: number): THREE.Points | null {
  if (verts.length === 0) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  return new THREE.Points(
    geom,
    new THREE.PointsMaterial({ color, size, sizeAttenuation: false }),
  );
}
