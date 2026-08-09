/**
 * 바닥 관련 필드가 왜 0cm인지 가른다 (ISSUE-014 후속).
 *
 *   node --experimental-strip-types tools/ground-probe.ts
 *
 * `groundPlane`·`groundFriction`을 바꿔도 정점이 1e-4cm도 안 움직였다.
 * 두 가지 해석이 가능하고 **#16의 스키마가 달라진다**:
 *
 *   (a) 필드가 솔버에 도달하지 않는다      → 스키마에서 빼야 한다
 *   (b) 이 씬의 옷이 바닥에 닿지 않는다    → 필드는 정상. 씬을 잘못 골랐을 뿐이다
 *
 * 가르는 방법: 옷의 **월드 최저 Y**를 재서 바닥판(y=0으로 가정)과 비교한다.
 * 옷이 바닥보다 한참 위에 있으면 (b)다 — 닿지 않는 면의 마찰을 바꿔도
 * 아무 일이 안 일어나는 것은 필드가 죽은 것이 아니라 물리가 옳은 것이다.
 *
 * ⚠️ positions는 패턴 로컬 좌표다 (ISSUE-011). transform(TRS)을 곱해야
 *    월드 좌표가 된다. 이걸 빠뜨리면 최저 Y가 엉뚱하게 나온다.
 */

import { resolve } from 'node:path';

import { Session } from '../src/sdk/session.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const EXE = resolve(ROOT, 'backend/native/build/Release/zelusSandBoxd-demo.exe');
const ZLS = resolve(ROOT, 'backend/data/incoming/W_Bra top & Leggings.zls');

/** TRS를 점 하나에 적용한다. 쿼터니언은 [x,y,z,w] (glTF·three.js 순서). */
function apply(
  p: [number, number, number],
  t: { translation: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number] },
): [number, number, number] {
  const [sx, sy, sz] = t.scale;
  const x = p[0] * sx;
  const y = p[1] * sy;
  const z = p[2] * sz;

  const [qx, qy, qz, qw] = t.rotation;
  // v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;

  const rx = ix * qw + iw * -qx + iy * -qz - iz * -qy;
  const ry = iy * qw + iw * -qy + iz * -qx - ix * -qz;
  const rz = iz * qw + iw * -qz + ix * -qy - iy * -qx;

  return [rx + t.translation[0], ry + t.translation[1], rz + t.translation[2]];
}

async function main(): Promise<void> {
  const session = await Session.create({ exePath: EXE });
  try {
    await session.load(ZLS);
    const params = await session.getParams();
    console.log(`\ngroundPlane=${params.groundPlane} groundFriction=${params.groundFriction} groundMargin=${params.groundMargin}`);

    await session.start();
    await session.waitForFrame(100);
    await session.pause();

    const mesh = await session.meshData(true);

    let minY = Infinity;
    let maxY = -Infinity;
    let missing = 0;

    for (const p of mesh.patterns) {
      if (!p.transform) {
        missing++;
        continue;
      }
      const buf = Buffer.from(p.positions ?? '', 'base64');
      const pos = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      for (let i = 0; i + 2 < pos.length; i += 3) {
        const [, wy] = apply([pos[i]!, pos[i + 1]!, pos[i + 2]!], p.transform);
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
      }
    }

    console.log(`패턴 ${mesh.patterns.length}개 (transform 없음 ${missing}개)`);
    console.log(`월드 Y  최저 ${minY.toFixed(2)}cm   최고 ${maxY.toFixed(2)}cm`);
    console.log(
      minY > (params.groundMargin ?? 0) + 1
        ? `\n→ 옷이 바닥(y=0)보다 ${minY.toFixed(1)}cm 위에 있다. 바닥 필드가 0cm인 것은 ` +
            `필드가 죽어서가 아니라 **이 씬에서 접촉이 일어나지 않아서**다 — 해석 (b).`
        : `\n→ 옷이 바닥에 닿거나 근접해 있다(최저 ${minY.toFixed(1)}cm). ` +
            `그런데도 0cm이라면 필드가 솔버에 도달하지 않는다 — 해석 (a).`,
    );
  } finally {
    await session.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
