/**
 * 아바타 체형 실측 (L-3a) — **`UpdateAvatar` 가 체형 변경을 실제로 반영하는가.**
 *
 *   cd backend
 *   node --experimental-strip-types tools/probe-avatar.ts
 *
 * 테스트가 아니다. `smoke.ts` 가 단언으로 회귀를 잡는 물건이고, 이건 **워커의
 * 새 op 두 개(`avatarBody`·`setAvatarBody`)가 무엇을 돌려주는지 눈으로 보는**
 * 물건이다. `try-sdk.ts` 와 같은 성격이다.
 *
 * ── 이 스크립트가 존재하는 이유 ─────────────────────────────
 * 엔진에 `ztAvatarManager::SetBodyParam`·`UpdateBodyParams` 가 있지만 **그
 * 객체를 얻는 공개 경로가 SDK 헤더에 없다.** 대신 `ztSceneQueryInterface` 가
 * 데이터 왕복(`GetAvatarData` → 수정 → `UpdateAvatar`)을 열어 둔다. 그 왕복이
 * 값만 저장하는지, 아니면 메시까지 다시 만드는지가 **헤더로는 안 보인다.**
 * 돌려 봐야 안다.
 *
 * ★ 판정의 핵심은 ②가 아니라 ③이다. 체형 값이 되읽혀도 그건 "저장됐다" 까지고,
 *   **실측 치수(`measurementRealValues`)가 따라 움직여야** 메시가 실제로 다시
 *   만들어진 것이다. 값만 붙고 치수가 그대로면 화면도 안 바뀐다.
 */

import { Worker } from '../src/sdk/index.ts';

const EXE = 'native/build/Release/zelusSandBoxd-demo.exe';
const SCENE = 'data/incoming/W_Bra top & Leggings.zls';

interface AvatarBody {
  hasAvatar: boolean;
  uuid?: string;
  bodyParams?: Record<string, number>;
  measurements?: Record<string, { real: number; expected?: number; locked: boolean }>;
}

interface WriteResult {
  applied: string[];
  unknown: string[];
  avatar: AvatarBody;
}

const w = Worker.spawn({ exePath: EXE });
await new Promise<void>((r) => w.on('ready', () => r()));

await w.request('init');
console.log('씬을 로드하는 중… (138MB)');
console.log('load →', JSON.stringify(await w.request('load', { path: SCENE })));

// ── ① 읽기 ───────────────────────────────────────────────────
const before = await w.request<AvatarBody>('avatarBody');
console.log('\n=== ① 읽기 ===');
console.log('hasAvatar :', before.hasAvatar, ' uuid :', before.uuid ?? '—');

if (!before.hasAvatar || !before.bodyParams || !before.measurements) {
  console.log('⛔ 아바타가 없다. 여기서 끝난다.');
  await w.request('quit').catch(() => {});
  setTimeout(() => process.exit(0), 300);
} else {
  const bp = before.bodyParams;
  console.log(`\n체형 ${Object.keys(bp).length}개`);
  for (const [k, v] of Object.entries(bp)) console.log(`  ${k.padEnd(24)} ${v}`);

  const ms = before.measurements;
  console.log(`\n치수 ${Object.keys(ms).length}개  (real / expected / lock)`);
  for (const [k, v] of Object.entries(ms)) {
    console.log(
      `  ${k.padEnd(24)} ${String(v.real.toFixed(3)).padEnd(12)}`
      + ` ${v.expected === undefined ? '—' : v.expected.toFixed(3)}  ${v.locked ? 'lock' : ''}`,
    );
  }

  // ── ② 쓰기 ─────────────────────────────────────────────────
  // 값의 단위·범위를 모르므로 **현재값 기준으로 민다.** 절대값을 찍으면
  // 범위 밖일 때 엔진이 조용히 클램프해도 구분이 안 된다.
  const cur = before.bodyParams['height'] ?? 0;
  const want = cur + 0.3;
  console.log(`\n=== ② 쓰기 — height ${cur} → ${want} ===`);

  const wrote = await w.request<WriteResult>('setAvatarBody', { bodyParams: { height: want } });
  console.log('applied :', wrote.applied, ' unknown :', wrote.unknown);

  const got = wrote.avatar?.bodyParams?.['height'];
  console.log('되읽은 height :', got);
  // ⚠️ 엄격 비교(===)로 보면 안 된다. 엔진이 float32 라 0.8 이 0.800000011920929
  //    로 돌아온다 — 실제로 값이 붙었는데 "안 붙었다" 로 읽힌다(첫 실행에서
  //    그렇게 오판했다).
  console.log(
    got !== undefined && Math.abs(got - want) < 1e-6
      ? '✅ 값이 붙었다 (float32 오차 범위)'
      : `⛔ 값이 안 붙었다 (기대 ${want} / 실제 ${got})`,
  );

  // ── ③ 진짜 판정: 메시가 다시 만들어졌는가 ───────────────────
  console.log('\n=== ③ 실측 치수가 따라 움직였는가 (메시 갱신의 증거) ===');
  let changed = 0;
  for (const [k, v] of Object.entries(ms)) {
    const after = wrote.avatar?.measurements?.[k]?.real;
    if (after !== undefined && Math.abs(after - v.real) > 1e-6) {
      console.log(`  ${k.padEnd(24)} ${v.real.toFixed(3)} → ${after.toFixed(3)}`);
      changed += 1;
    }
  }
  console.log(
    changed > 0
      ? `✅ ${changed}개 치수가 움직였다 — UpdateAvatar 가 메시까지 갱신한다`
      : '⚠️ 치수가 하나도 안 움직였다 — 값만 저장되고 메시는 그대로일 수 있다',
  );

  // ── ③-b 진짜 메시가 바뀌었는가 (glTF 바이트 대조) ───────────
  //
  // ③ 이 보는 `measurementRealValues` 는 **우리가 복사해 넘긴 데이터의 필드**다.
  // 엔진이 다시 계산해 써 주지 않으면 당연히 그대로다 — 즉 ③ 만으로는
  // "메시가 안 바뀌었다" 를 결론지을 수 없다. 익스포트한 glTF 는 지금 씬의
  // 실제 지오메트리라 그 구분이 선다.
  console.log('\n=== ③-b glTF 익스포트로 실제 메시 대조 ===');
  const { readFileSync, existsSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');

  const digest = (p: string): string =>
    existsSync(p) ? createHash('sha1').update(readFileSync(p)).digest('hex').slice(0, 12) : '없음';

  const A = 'data/probe-avatar-a.gltf';
  const B = 'data/probe-avatar-b.gltf';

  // 지금(체형을 바꾼 뒤) 상태를 A 로 찍는다.
  await w.request('export', { path: A, format: 'gltf' });
  // 되돌린 뒤 B 를 찍는다. 두 파일이 같으면 체형이 지오메트리에 안 닿는 것이다.
  await w.request('setAvatarBody', { bodyParams: { height: cur } });
  await w.request('export', { path: B, format: 'gltf' });

  const [da, db] = [digest(A), digest(B)];
  console.log(`  height=${want} → ${da}`);
  console.log(`  height=${cur} → ${db}`);
  console.log(
    da !== db && da !== '없음'
      ? '✅ 체형이 지오메트리를 바꾼다 — UpdateAvatar 로 충분하다'
      : '⛔ 지오메트리가 그대로다 — UpdateAvatar 는 값만 저장한다. 다른 트리거가 필요하다',
  );

  // ── ④ 모르는 키를 되돌리는가 (ISSUE-014 계열 방지) ──────────
  const bogus = await w.request<WriteResult>('setAvatarBody', { bodyParams: { nope: 1 } });
  console.log('\n=== ④ 모르는 키 ===');
  console.log('applied :', bogus.applied, ' unknown :', bogus.unknown);
  console.log(
    bogus.unknown?.includes('nope')
      ? '✅ 모르는 키를 unknown 으로 되돌린다'
      : '⛔ 조용히 삼킨다 — 화면이 "적용됨" 으로 거짓말하게 된다 (ISSUE-014)',
  );

  await w.request('quit').catch(() => {});
  setTimeout(() => process.exit(0), 300);
}
