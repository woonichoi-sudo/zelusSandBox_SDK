/**
 * 옷 사이즈 실측 (L-3b) — **`UpdateSizeSurface` 가 실제로 패턴을 바꾸는가.**
 *
 *   cd backend
 *   node --experimental-strip-types tools/probe-surface.ts
 *
 * 테스트가 아니다. `probe-avatar.ts`·`try-sdk.ts` 와 같은 성격이다 — 새 op 두
 * 개(`surfaces`·`setSurfaceSize`)가 무엇을 돌려주는지 눈으로 본다.
 *
 * ★ 아바타 때 배운 것을 그대로 쓴다: **되읽은 값만으로는 부족하다.** 값이
 *   저장됐다는 것과 지오메트리가 바뀌었다는 것은 다른 사실이고, 헤더로는 그
 *   구분이 안 보인다. glTF 해시로 가른다.
 */

import { Worker } from '../src/sdk/index.ts';

const EXE = 'native/build/Release/zelusSandBoxd-demo.exe';
const SCENE = 'data/incoming/W_Bra top & Leggings.zls';

interface Surface { uuid: string; name: string; width: number; height: number }
interface Surfaces { surfaces: Surface[] }

const w = Worker.spawn({ exePath: EXE });
await new Promise<void>((r) => w.on('ready', () => r()));

await w.request('init');
console.log('씬을 로드하는 중… (138MB)');
await w.request('load', { path: SCENE });

// ── ① 읽기 ───────────────────────────────────────────────────
const before = await w.request<Surfaces>('surfaces');
console.log(`\n=== ① 서피스 ${before.surfaces.length}개 ===`);
for (const s of before.surfaces.slice(0, 30)) {
  console.log(`  ${s.name.padEnd(22)} ${s.width.toFixed(3).padStart(9)} × ${s.height.toFixed(3).padStart(9)} cm   ${s.uuid}`);
}
if (before.surfaces.length === 0) {
  console.log('⛔ 서피스가 없다. 여기서 끝난다.');
  await w.request('quit').catch(() => {});
  setTimeout(() => process.exit(0), 300);
} else {
  const target = before.surfaces[0]!;

  // ── ② 쓰기 ─────────────────────────────────────────────────
  const wantW = target.width * 1.3;
  console.log(`\n=== ② 쓰기 — "${target.name}" 폭 ${target.width.toFixed(3)} → ${wantW.toFixed(3)} ===`);
  const after = await w.request<Surfaces>('setSurfaceSize', { uuid: target.uuid, width: wantW });
  const got = after.surfaces.find((s) => s.uuid === target.uuid);
  console.log(`되읽은 크기 : ${got?.width.toFixed(3)} × ${got?.height.toFixed(3)}`);
  console.log(
    got && Math.abs(got.width - wantW) < 1e-3
      ? '✅ 폭이 붙었다'
      : `⚠️ 요청과 다르다 (기대 ${wantW.toFixed(3)} / 실제 ${got?.width.toFixed(3)}) — 엔진이 클램프했거나 비율을 유지한 것일 수 있다`,
  );
  // ⚠️ 높이는 "안 건드렸으니 그대로" 가 아니다. 실측: 폭을 +30% 했더니 높이가
  //    9.739 → 9.742 로 **+0.03%** 움직였다. 비율 유지가 아니고(그랬다면 +30%),
  //    크기를 다시 맞추면서 경계가 재계산된 흔들림이다. 그래서 판정을 "같다"
  //    가 아니라 **"의도한 축만 크게 움직였다"** 로 본다 — 엄격 비교로 두면
  //    정상 동작이 실패로 읽힌다.
  const dh = got ? Math.abs(got.height - target.height) / Math.max(target.height, 1e-6) : 1;
  console.log(
    dh < 0.01
      ? `✅ 안 준 높이는 사실상 그대로다 (${(dh * 100).toFixed(2)}% 변화 — 재계산 흔들림)`
      : `⚠️ 높이가 ${(dh * 100).toFixed(1)}% 움직였다 — 엔진이 두 축을 함께 다룬다는 뜻이다`,
  );

  // ── ③ 지오메트리가 실제로 바뀌었는가 ────────────────────────
  console.log('\n=== ③ glTF 익스포트로 실제 메시 대조 ===');
  const { readFileSync, existsSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const digest = (p: string): string =>
    existsSync(p) ? createHash('sha1').update(readFileSync(p)).digest('hex').slice(0, 12) : '없음';

  const A = 'data/probe-surface-a.gltf';
  const B = 'data/probe-surface-b.gltf';
  await w.request('export', { path: A, format: 'gltf' });
  await w.request('setSurfaceSize', { uuid: target.uuid, width: target.width });
  await w.request('export', { path: B, format: 'gltf' });

  const [da, db] = [digest(A), digest(B)];
  console.log(`  폭 ${wantW.toFixed(1)} → ${da}`);
  console.log(`  폭 ${target.width.toFixed(1)} → ${db}`);
  console.log(
    da !== db && da !== '없음'
      ? '✅ 크기가 지오메트리를 바꾼다'
      : '⛔ 지오메트리가 그대로다 — UpdateSizeSurface 만으로는 부족하다',
  );

  // ── ④ 없는 uuid ────────────────────────────────────────────
  console.log('\n=== ④ 없는 uuid ===');
  try {
    await w.request('setSurfaceSize', { uuid: 'no-such-uuid', width: 10 });
    console.log('⛔ 조용히 성공했다 — 화면이 "바꿨다"고 거짓말하게 된다 (ISSUE-014)');
  } catch (err: unknown) {
    console.log('✅ 거절한다 —', err instanceof Error ? err.message : String(err));
  }

  await w.request('quit').catch(() => {});
  setTimeout(() => process.exit(0), 300);
}
