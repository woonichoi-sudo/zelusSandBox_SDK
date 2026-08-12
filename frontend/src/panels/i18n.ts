/**
 * 화면 글자의 다국어 (I-1) — **DOM 도 three 도 만지지 않는다.**
 *
 * `panels/` 의 규약대로 판단(사전 조회·언어 결정·저장)만 여기 있고, 그리는
 * 것은 `ui/`, 배선은 `main.ts` 다. DOM 을 모르므로 Node 스모크가 그대로 붙는다 —
 * 이 단위에서 자동으로 확인할 수 있는 것은 사실상 이 파일뿐이다(화면에 실제로
 * 한국어가 남았는지는 브라우저에서 눈으로 본다).
 *
 * ── 범위 ────────────────────────────────────────────────────
 *
 * **화면에 글자로 나오는 것만** 옮긴다. 사용자가 직접 좁힌 범위다(2026-08-12).
 *
 *   · 주석은 번역하지 않는다. 이 저장소의 한국어 주석은 설계 근거를 담은
 *     문서이고, 번역하면 근거가 흐려진다.
 *   · 변수명·함수명·프로토콜 필드명·로그 파일명도 그대로다.
 *
 * ⛔ **로그 문구는 범위 밖이다** (사용자가 2026-08-12 에 한 번 더 좁혔다:
 *    "로그는 안해도 돼 사용자가 보는 ui만"). 가르는 기준은 **접힌 로그 상자
 *    (`#logWrap`) 안에만 쌓이면 제외, 그 밖에 보이면 포함**이다. 그래서
 *    `main.ts` 의 `log(...)` 인자와 각 패널의 `hooks.log?.(...)` 인자는 한국어로
 *    남아 있다. 상태줄(`#status`)은 **항상 보이므로 포함**이다 — `status()` 가
 *    로그에도 같은 줄을 남기지만, 그 줄의 본적은 상태줄이다.
 *
 *    나중에 로그까지 하기로 하면 손댈 곳은 딱 셋이다: `main.ts` 의 `log(...)`
 *    호출 40여 곳, `panels/{avatarView,avatarMeasure,draping,playback,textures,
 *    params}.ts` 의 `hooks.log?.(...)` 호출, `ui/paramsPanel.ts` 의
 *    `this.#hooks.log?.(...)` 호출.
 *
 * ⛔ **엔진이 준 값은 사전에 넣지 않는다.** 서피스 이름(`pattern 2`), 치수
 *    부위명(`WaistCircum`·`ArmLength`), 체형 파라미터 키, 엔진 로그
 *    (`[엔진] … in draping time`), 씬 파일명·uuid·버전 문자열이 그것이다.
 *    번역하면 화면이 엔진이 모르는 말을 하게 되고, 사용자가 데스크톱 앱과
 *    대조할 때 어긋난다. 반대로 **우리가 붙인 한국어 라벨**(체형 슬라이더의
 *    `어깨너비` 처럼 엔진 키를 우리가 옮긴 것)은 번역 대상이다.
 *
 * ── 왜 문자열을 이어붙이지 않는가 ────────────────────────────
 *
 * 로그 문구에 값이 많이 끼어든다(`옷 사이즈 — pattern 4 → 30.00 × 98.38cm`).
 * `t('…') + name + '…'` 로 이으면 어순이 다른 영어에서 문장이 깨진다. 그래서
 * 사전 값에 `{name}` 같은 **자리표시자**를 두고 `t(key, { name })` 로 채운다.
 * 두 언어에서 자리표시자 집합이 같아야 값이 화면에서 사라지지 않는다.
 *
 * ── 모르는 키 ───────────────────────────────────────────────
 *
 * **빈 문자열을 돌려주지 않는다.** 글자가 조용히 사라지는 것이 이 종류의 가장
 * 흔한 사고다. 키 자체를 돌려주면 화면에 이상한 글자가 남아 바로 눈에 띈다.
 * 자리표시자도 마찬가지다 — 값이 안 들어오면 `{name}` 을 그대로 남긴다.
 *
 * ── 왜 모듈 하나에 상태가 있는가 (싱글턴) ────────────────────
 *
 * 이 프로젝트의 다른 패널은 전부 클래스인데 여기만 모듈 상태다. 언어는 화면
 * 전체에 한 개뿐인 값이고, 인스턴스를 만들어 넘기려면 `panels/*` 25개와
 * `ui/*` 11개의 생성자를 전부 고쳐야 한다 — 그 배선이 이 단위의 본체보다
 * 커진다. 대신 상태를 **함수 뒤에** 두어(`getLang()`/`setLang()`) 테스트가
 * 언제든 되돌릴 수 있게 했다.
 *
 * ⚠️ **기본값은 한국어여야 한다.** 기존 스모크 831건 중 여럿이 화면 글자로
 *    단언한다(`playLabel` 이 '재생' 인지, 커플링 라벨이 '없음' 인지 …).
 *    한국어 사전의 값이 **예전 하드코딩과 한 글자도 다르지 않아야** 그 단언이
 *    그대로 통과한다. 사전을 고칠 때 한국어 쪽 문구를 다듬지 말 것.
 */

export type Lang = 'ko' | 'en';

/** 화면에 고를 수 있는 언어. **순서가 곧 선택 상자의 순서다** */
export const LANGS: readonly Lang[] = ['ko', 'en'];

/** 저장된 값이 없을 때. 기존 동작(한국어)을 그대로 유지한다 */
export const DEFAULT_LANG: Lang = 'ko';

/**
 * 언어 이름은 **그 언어로** 적는다. 한국어 화면에서 "영어" 라고 쓰면 영어를
 * 찾는 사람이 못 읽는다 — 언어 선택은 자기가 읽을 수 있는 말로 보여야 한다.
 * 그래서 이 표만은 번역 대상이 아니다.
 */
export const LANG_LABELS: Readonly<Record<Lang, string>> = {
  ko: '한국어',
  en: 'English',
};

export type MessageVars = Readonly<Record<string, string | number>>;

/** 사전 한 벌. **두 언어의 키 집합이 같아야 한다**(스모크가 그것을 본다) */
export type Dict = Readonly<Record<string, string>>;

// ── 사전 ────────────────────────────────────────────────────
//
// 키는 `<자리>.<이름>` 이다. 자리는 화면에서 어디에 나오는지를 말한다:
//   bar.*      상단 바 (버튼·라벨·상태)
//   cell.*     세 칸 안의 글자 (힌트·빈 자리 표시·스위치)
//   side.*     오른쪽 칸 (탭·체형·치수·옷 사이즈)
//   params.*   파라미터 패널 (#16)
//   log.*      로그 상자와 상태줄에 흐르는 문구
//   err.*      실패 사유
//
// ⚠️ 두 표의 키를 **같이** 고칠 것. 한쪽에만 넣으면 그 자리가 반대 언어에서
//    키 문자열로 보인다(빈 화면보다는 낫지만 고장은 고장이다).

const KO: Dict = {
  // ── 상단 바 ─────────────────────────────────────────────
  'app.title': 'Cobalt — 3D 뷰',
  'bar.lang': '언어',
  'bar.scene': '씬',
  'bar.scene.loading': '불러오는 중…',
  'bar.scene.empty': '업로드된 씬이 없습니다 — .zls 를 올리세요',
  'bar.load': '로드',
  // 네이티브 `<input type=file>` 의 기본 글자는 브라우저가 그려서 못 바꾼다.
  // 입력을 감추고 `<label>` 을 버튼처럼 쓰므로 이 둘이 그 자리를 대신한다 —
  // 고른 파일 이름도 우리가 보여줘야 한다(감추면 네이티브 표시가 사라진다).
  'bar.file': '파일 선택',
  'bar.file.none': '선택된 파일 없음',
  'bar.upload': '업로드',
  'bar.play': '▶ 재생',
  'bar.pause': '⏸ 정지',
  'bar.reset': '↺ 리셋',
  'bar.reset.title': '시뮬레이션을 처음으로 되돌립니다. 씬은 그대로입니다 (R)',
  'bar.clear': '✕ 씬 내림',
  'bar.clear.title': '씬을 워커에서 내립니다. 다시 보려면 로드해야 합니다 (C)',
  'bar.drape': '👗 드레이프',
  'bar.snap': '🧍 스냅샷',
  'bar.snap.again': '🧍 다시 찍기',
  'bar.snap.title': '지금 포즈를 glTF 로 내보내 아바타와 함께 세웁니다',
  'bar.mode.live': '↩ 실시간',
  'bar.mode.snapshot': '🧍 스냅샷 보기',
  'bar.status.booting': '시작하는 중…',

  // ── 칸 안의 글자 ────────────────────────────────────────
  'hint.view': '좌드래그 회전 · 우드래그 팬 · 휠 줌  |  격자 한 칸 = 10cm',
  'hint.shortcuts': 'S 재생/정지 · R 리셋 · C 씬 내림',
  'cell.draft2d.title': '2D 재단 도면',
  'cell.draft2d.empty': '씬을 로드하면 여기에 재단 도면이 섭니다',
  'cell.unfold': '펼침',
  'cell.unfold.title': '3D 드레이프 ↔ 2D 재단 도면. 중간에서 멈추면 어느 조각이 어디로 가는지 보입니다',
  'cell.avatar': '🧍 아바타',
  'cell.texture': '🎨 무늬',

  // ── 오른쪽 칸 · 서랍 ────────────────────────────────────
  'side.drawer.open': '☰ 설정',
  'side.drawer.close': '✕ 설정',
  'side.drawer.title': '아바타 체형·옷 사이즈 칸을 여닫습니다 (Esc 로 닫기)',
  'side.tab.avatar': '아바타',
  'side.tab.surface': '옷 사이즈',

  // ── 접힌 상자 ───────────────────────────────────────────
  'params.summary': '⚙ 파라미터',
  'log.summary': '로그',

  // ── 재단 도면의 표시 스위치 (D2-e) ──────────────────────
  'draft2d.layer.links': '봉제 대응선',
  'draft2d.layer.seams': '봉제선',
  'draft2d.layer.outer': '외곽선',
  'draft2d.layer.inner': '내부선',
  'draft2d.layer.vertices': '제어점',
  'draft2d.layer.stitches': '스티치',

  // ── 실시간 뷰의 무늬 스위치 (materials-c) ────────────────
  'tex.noScene': '씬을 로드하면 무늬가 입혀집니다',
  'tex.none': '이 씬에는 텍스처가 없습니다',
  'tex.count': '무늬 {files}장',
  'tex.count.off': '무늬 {files}장 (꺼짐)',
  'tex.rejected': ' · ⚠ 거절 {n}칸',

  // ── 공통 위젯 ───────────────────────────────────────────
  'btn.apply': '적용',
  'btn.apply.n': '적용 ({n})',
  'btn.revert': '되돌리기',
  'btn.apply.title': '바뀐 값만 워커로 보냅니다',
  'valid.notNumber': '숫자가 아닙니다',
  'valid.notPositive': '0보다 커야 합니다',

  // ── 옷 사이즈 (L-3b) ────────────────────────────────────
  'side.surface.title': '옷 사이즈 (cm)',
  'side.surface.revert.title': '이 행의 편집을 버립니다',
  'surface.noScene': '씬을 로드하면 패턴 크기를 조절할 수 있습니다',
  'surface.empty': '이 씬에는 패턴이 없습니다',

  // ── 직물 (UI #50) ───────────────────────────────────────
  'fabric.label': '원단',
  'fabric.noScene': '씬을 로드하면 원단을 바꿀 수 있습니다',
  'fabric.empty': '이 씬에는 원단이 없습니다',
  // ⚠️ 선택지가 둘뿐인 것을 "목록이 안 불러와졌다" 로 읽지 않게 하는 글자다.
  //    프리셋이 하나라도 있으면 안 뜬다.
  'fabric.inFileOnly': '이 설치본에는 프리셋 원단이 없습니다 — 이 옷에 든 {n}개끼리만 바꿀 수 있습니다',
  'fabric.missingTexture': ' (무늬 파일 없음)',
  'fabric.applying': '원단을 입히는 중…',
  'fabric.applied': '원단 — {name}',
  'status.fabric.failed': '원단 적용 실패: {why}',

  // ── 아바타 체형 (L-3a) ──────────────────────────────────
  //
  // ⛔ 왼쪽의 엔진 키(`fatness` …)는 번역하지 않는다. 여기 있는 것은 **우리가
  //    붙인 이름**이라 번역 대상이다 (`panels/avatarBody.ts` 의 LABEL_KEYS).
  'side.body.title': '체형 (정규화 0~1)',
  'side.body.revert.title': '화면의 편집을 버리고 워커의 실제 값으로 다시 채웁니다',
  'body.noScene': '씬을 로드하면 아바타 체형을 조절할 수 있습니다',
  'avatar.none': '이 씬에는 아바타가 없습니다',
  'body.group.overall': '전체',
  'body.group.upper': '상체',
  'body.group.lower': '하체',
  'body.group.arm': '팔',
  'body.group.other': '기타',
  'body.fatness': '살집',
  'body.height': '키',
  'body.shoulder': '어깨너비',
  'body.shoulder_height': '어깨높이',
  'body.neck': '목둘레',
  'body.mid_neck': '목 중간',
  'body.backneck_height': '뒷목높이',
  'body.head': '머리',
  'body.chest': '가슴우리',
  'body.bust_size': '가슴크기',
  'body.bust_depth': '가슴깊이',
  'body.bust_height': '가슴높이',
  'body.under_bust': '언더버스트',
  'body.bustpoint_to_bustpoint': '유두 간격',
  'body.belly': '배',
  'body.waist_height': '허리높이',
  'body.pelvis': '골반',
  'body.high_hip': '윗엉덩이',
  'body.low_hip': '아랫엉덩이',
  'body.hip_height': '엉덩이높이',
  'body.crotch': '밑위',
  'body.arm_length': '팔길이',
  'body.upper_arm_length': '윗팔길이',
  'body.bicep': '이두',
  'body.wrist': '손목',
  'body.thigh': '허벅지',
  'body.knee_height': '무릎높이',
  'body.calf': '종아리',
  'body.ankle': '발목',

  // ── 아바타 치수 (W-2) ───────────────────────────────────
  //
  // ⛔ 부위명(`WaistCircum`·`ArmLength` … 25개)은 **엔진의 `GetMeasurePartName`**
  //    이 준 값이라 여기에 없다. 화면에도 엔진 이름 그대로 뜬다.
  'side.meas.title': '치수 (cm)',
  'side.meas.stale': '체형 슬라이더를 보낸 뒤입니다 — 아래 치수는 그 전에 잰 값입니다.'
    + ' 치수를 한 번 적용하면 25개 전부 다시 잰 값으로 갱신됩니다.',
  'side.meas.now': '현재 {v}',
  'side.meas.target': ' · 목표 {v} ({d})',
  'side.meas.locked': ' · 잠김',
  'meas.disconnected': '연결 없음 — 치수를 읽을 수도 보낼 수도 없습니다',
  'meas.noScene': '씬을 로드하면 치수를 조절할 수 있습니다',
  'meas.notSupported': '지금 아바타는 치수 변형을 지원하지 않습니다 (ztDesignZeta 아님)'
    + ' — 체형 슬라이더는 그대로 쓸 수 있습니다.'
    + ' 드레이프를 적용한 뒤라면 씬을 다시 로드하면 원래 아바타로 돌아갑니다',
  'meas.applying': '치수를 적용하는 중… {sec}초 / 예상 {want}초'
    + ' · 그동안 재생·리셋 등 다른 조작은 워커가 응답하지 않습니다',
  'meas.applied': '치수 적용됨 — {applied} ({sec}초 · 단계 {steps})'
    + ' · 시뮬레이션은 처음으로 되돌아갔습니다',
  'meas.approx': ' · 셰이퍼 근사라 목표와 최대 {cm}cm 차이가 납니다 (정상입니다)',
  'meas.unknown': ' · ⚠ 모르는 치수: {keys}',
  'meas.rejected': ' · ⚠ 못 쓴 값: {keys}',
  'meas.noChange': '바뀐 치수가 없습니다 — 값을 바꾼 뒤 [적용] 을 누르세요',
  'meas.failed': '치수 적용 실패: {why}',
  'meas.edited': '{n}개 편집됨 — 적용에 약 {sec}초 걸립니다',
  'meas.tooLong': ' · ⚠ 워커 제한 {limit}초를 넘길 수 있습니다 — 나눠서 적용하세요',

  // ── 실패 사유 ───────────────────────────────────────────
  'err.unknown': '알 수 없는 오류',
  'err.notConnected': '연결되어 있지 않습니다',
  'err.noScene': '씬이 로드되어 있지 않습니다',
  'err.noAvatarScene': '아바타가 있는 씬이 로드되어 있지 않습니다',
  'err.noMeasureToSend': '보낼 치수가 없습니다 — 값을 바꾼 뒤 누르세요',
  'err.unknownCause': '원인 불명',

  // ── 드레이프 (W-1) ──────────────────────────────────────
  'drape.disconnected': '연결 없음 — 드레이프를 적용할 수 없습니다',
  'drape.noScene': '씬을 로드하면 저장된 드레이프를 입힐 수 있습니다',
  'drape.applying': '드레이프를 적용하는 중…',
  'drape.applied': '드레이프 적용됨 · 시뮬레이션은 처음으로 되돌아갔습니다',
  'drape.applied.named': '드레이프 적용됨 — {name} · 시뮬레이션은 처음으로 되돌아갔습니다',
  'drape.noAutoItem': '이 씬에는 저장된 자동 드레이프가 없습니다 — 옷은 그대로입니다',
  'drape.loadFailed': '엔진이 드레이프를 적용하지 못했습니다',
  'drape.failed': '드레이프 적용 실패: {why}',

  // ── 시뮬 상태 (#14) ─────────────────────────────────────
  'sim.atFrame': ' · 프레임 {frame}',
  'sim.disconnected': '연결 없음',
  'sim.noScene': '씬 없음 — .zls 를 로드하세요',
  'sim.loading': '씬을 로드하는 중…',
  'sim.playing': '시뮬레이션 실행 중{at}',
  'sim.paused': '일시정지{at}',

  // ── 실시간 뷰의 아바타 (AM-1) ───────────────────────────
  'av.hidden': '아바타 숨김',
  'av.noScene': '씬을 로드하면 몸이 섭니다',
  'av.loading.first': '몸을 받는 중… (1.9MB)',
  'av.loading': '몸을 갱신하는 중…',
  'av.none': '이 씬에는 시뮬에 참여하는 아바타가 없습니다',
  'av.failed': '몸을 받지 못했습니다: {why}',
  'av.ready': '아바타 {avatars} · 정점 {vertices}',
  'av.anim': ' · 애니 {at}/{total}',

  // ── 2D 펼침 (#15-b) ─────────────────────────────────────
  'unfold.noScene': '씬이 없습니다',
  'unfold.allUnplaced': '패턴 {patterns}개 모두 2D 배치가 없습니다 — 도면을 그릴 수 없습니다',
  'unfold.noPatterns': '패턴이 없습니다',
  'unfold.someUnplaced': '패턴 {unplaced}개는 2D 배치가 없어 3D 자리에 남습니다',

  // ── 파라미터 패널 (#16) ─────────────────────────────────
  //
  // `param.<key>.*` 의 `<key>` 는 **프로토콜 필드명**이다(`timeStep` …). 그쪽은
  // 번역 대상이 아니고, 여기 값만 번역한다. `panels/params.ts` 의 `localize()`
  // 가 이 세 키를 게터로 붙인다.
  'param.group.general': '일반',
  'param.group.ground': '바닥',
  'param.group.wind': '바람',
  'param.group.solver': '솔버',
  'param.group.coupling': '커플링',
  'param.group.meshing': '메싱',

  'param.solverType.opt.0': '내재적 오일러 1차',
  'param.solverType.opt.1': '내재적 오일러 2차',
  'param.solverType.opt.2': 'XPBD (위치 기반)',
  'param.preconditioner.opt.0': 'Identity (없음)',
  'param.preconditioner.opt.1': 'Diagonal',
  'param.preconditioner.opt.2': 'Block-Diagonal (권장)',
  'param.coupling.opt.0': '없음',
  'param.coupling.opt.1': '내재적 접촉',
  'param.coupling.opt.2': '내재적 접촉 (방향)',
  'param.coupling.opt.3': '페널티',
  'param.coupling.opt.4': '투영 구속',

  'param.timeStep.label': '타임스텝 (Hz)',
  'param.timeStep.desc': '1초를 몇 번으로 쪼개 풀 것인가. 높이면 안정적이지만 느려진다.',
  'param.timeStep.note': '실측: 45 → 90 에서 평균 1.78cm / 최대 8.61cm 움직인다',
  'param.subStep.label': '서브스텝',
  'param.subStep.desc': '타임스텝 하나를 다시 쪼개는 수.',
  'param.subStep.note': '엔진 미지원 — 1 → 8 로 바꿔도 전 정점이 비트 단위로 같다 (ISSUE-014)',
  'param.drapingTime.label': '드레이핑 시간 (초)',
  'param.drapingTime.desc': '옷이 아바타에 자리를 잡는 초기 구간의 길이.',
  'param.drapingTime.note': '실측: 0.4 → 3 에서 평균 4.94cm / 최대 16.20cm. 영향이 큰 편이다',
  'param.gravityY.label': '중력 Y (cm/s²)',
  'param.gravityY.desc': '아래로 당기는 가속도. 0 이면 무중력.',
  'param.gravityY.note': '실측: -980 → 0 에서 평균 0.22cm. 반영은 되지만 변화가 작다 (ISSUE-014 미결 ②)',
  'param.groundPlane.label': '바닥면 충돌',
  'param.groundPlane.desc': '충돌용 바닥면을 켠다. 렌더링용 바닥과는 별개다.',
  'param.groundPlane.note': '이 씬에서 미검증 — 옷이 바닥에서 9.27cm 떠 있어 접촉이 없다 (ISSUE-014)',
  'param.groundFriction.label': '바닥 마찰',
  'param.groundFriction.desc': '옷이 바닥에 닿았을 때의 마찰 계수. 0 이면 미끄러진다.',
  'param.groundFriction.note': '이 씬에서 미검증 — 바닥 접촉이 없다 (ISSUE-014)',
  'param.groundMargin.label': '바닥 여유 (cm)',
  'param.groundMargin.desc': '충돌 바닥면을 렌더링 바닥에서 얼마나 띄울 것인가. 음수면 아래.',
  'param.groundMargin.note': '실측: 0.5 → 5 에서 평균 0.02cm / 최대 0.58cm — 접촉이 없는데 왜 움직이는지 미해결',
  'param.useWind.label': '바람 사용',
  'param.useWind.desc': '바람을 켠다. 세기는 아래 항목에서 정한다.',
  'param.useWind.note': '실측: 단독으로 켜면 평균 0.11cm. 세기와 함께 걸면 7.19cm',
  'param.windMagnitude.label': '바람 세기',
  'param.windMagnitude.desc': '바람의 크기. 방향은 씬에 저장된 값을 쓴다 (프로토콜에 없다).',
  'param.windMagnitude.note': '단독으로는 0cm. `바람 사용`과 함께 걸어야 움직인다 (ISSUE-014 ①)',
  'param.solverType.label': '적분기',
  'param.solverType.desc': '운동 방정식을 푸는 방식. 시뮬레이션이 초기화되기 전에만 바꿀 수 있다.',
  'param.solverType.note': '실측: 0 → 1 에서 평균 1.19cm',
  'param.preconditioner.label': '전처리기',
  'param.preconditioner.desc': '선형 시스템을 푸는 전처리 방식. Block-Diagonal 이 권장값이다.',
  'param.preconditioner.note': '실측: 2 → 1 에서 평균 3.84cm / 최대 9.80cm. 영향이 큰 편이다',
  'param.nonlinearIterations.label': '비선형 반복 수',
  'param.nonlinearIterations.desc': '한 스텝에서 비선형 시스템을 몇 번 다시 풀 것인가. 높이면 정확하지만 크게 느려진다.',
  'param.nonlinearIterations.note': '실측: 1 → 10 에서 평균 1.67cm. 같은 100프레임이 12초 → 56초가 된다',
  'param.maxSolverIterations.label': '선형 솔버 최대 반복 수',
  'param.maxSolverIterations.desc': '허용 오차에 닿지 못했을 때 몇 번까지 반복할 것인가.',
  'param.maxSolverIterations.note': '실측: 600 → 5 에서 평균 2.97cm / 최대 11.33cm',
  'param.solverTolerance.label': '선형 솔버 허용 오차',
  'param.solverTolerance.desc': '작을수록 정확하고 느리다. 지수 표기로 넣는다 (예: 1e-4).',
  'param.solverTolerance.note': '실측: 1e-4 → 0.1 에서 평균 3.03cm / 최대 13.56cm',
  'param.useIEQS.label': '준정적 (Quasi-static)',
  'param.useIEQS.desc': '드레이핑 구간에서 내재적 오일러 준정적 해법을 쓴다.',
  'param.useIEQS.note': '실측: false → true 에서 평균 5.51cm / 최대 17.94cm. 측정한 22개 중 영향이 가장 크다',
  'param.staticCouplingMethod.label': '정적 커플링',
  'param.staticCouplingMethod.desc': '아바타처럼 움직이지 않는 물체와의 접촉을 푸는 방식. 투영 구속이 권장값이다.',
  'param.staticCouplingMethod.note': '실측: 4 → 1 에서 평균 5.29cm / 최대 10.78cm',
  'param.dynamicCouplingMethod.label': '동적 커플링',
  'param.dynamicCouplingMethod.desc': '옷끼리의 자기 충돌을 푸는 방식. 페널티가 권장값이다.',
  'param.dynamicCouplingMethod.note': '실측: 3 → 1 에서 평균 0.41cm / 최대 6.80cm',
  'param.dynCouplingStiffness.label': '동적 페널티 강성',
  'param.dynCouplingStiffness.desc': '자기 충돌을 밀어내는 힘의 세기.',
  'param.dynCouplingStiffness.note': '실측: 750 → 0 에서 평균 0.43cm',
  'param.dynCouplingDamping.label': '동적 페널티 감쇠',
  'param.dynCouplingDamping.desc': '자기 충돌을 밀어낼 때의 감쇠.',
  'param.dynCouplingDamping.note': '실측: 0.1 → 0 에서 평균 0.57cm',
  'param.untanglingStiffness.label': '엉킴 해소 강성',
  'param.untanglingStiffness.desc': '이미 관통해 엉킨 곳을 풀어내는 힘의 세기.',
  'param.untanglingStiffness.note': '실측: 20000 → 0 에서 평균 0.33cm',
  'param.untanglingDamping.label': '엉킴 해소 감쇠',
  'param.untanglingDamping.desc': '엉킴을 풀어낼 때의 감쇠.',
  'param.untanglingDamping.note': '실측: 250 → 0 에서 평균 1.80cm / 최대 6.89cm',
  'param.meshingEdgeLength.label': '메시 엣지 길이 (cm)',
  'param.meshingEdgeLength.desc': '패턴을 삼각형으로 나눌 때의 목표 변 길이. 작을수록 촘촘하고 느리다.',
  'param.meshingEdgeLength.note': '엔진 미지원 — 1 → 4 로 바꿔도 전 정점이 비트 단위로 같다 (ISSUE-014)',

  // 값 보정 사유 (화면에 그대로 찍힌다)
  'coerce.numToBool': '숫자를 참/거짓으로 바꿨습니다',
  'coerce.notBool': '참/거짓이 아닙니다 — 기본값({fallback})을 씁니다',
  'coerce.wantNumber': '숫자가 와야 합니다 — 기본값({fallback})을 씁니다',
  'coerce.notNumber': '숫자가 아닙니다 — 기본값({fallback})을 씁니다',
  'coerce.notAnOption': '선택지에 없는 값({raw})입니다 — 기본값을 씁니다',
  'coerce.rounded': '정수만 받습니다 — {raw} 를 {value} 로 반올림했습니다',
  'coerce.belowMin': '최솟값 {min} 아래입니다 — {min} 로 맞췄습니다',
  'coerce.aboveMax': '최댓값 {max} 위입니다 — {max} 로 맞췄습니다',

  // 비활성 사유. **툴팁이 아니라 화면 글자다**(#16 에서 확립한 규칙)
  'param.off.dead': '엔진이 이 값을 보지 않습니다 (ISSUE-014) — 바꿔도 시뮬이 달라지지 않아 전송하지 않습니다',
  'param.off.simInit': '시뮬레이션이 초기화된 뒤에는 바꿀 수 없습니다 — 데스크톱도 같습니다',
  'param.off.dependency': "'{label}' 이(가) 꺼져 있어 이 값은 시뮬에 반영되지 않습니다",

  // 배지·버튼·배너 (`ui/paramsPanel.ts`)
  'param.badge.dead': '엔진 미지원',
  'param.badge.conditional': '조건부',
  'param.badge.guess': '범위 추정',
  'param.badge.guess.title': '데스크톱에 이 위젯이 없어 최소/최대가 추정치입니다',
  'params.read': '워커에서 읽기',
  'params.read.title': '화면의 값을 버리고 워커의 실제 값으로 다시 채웁니다',
  'params.banner.idle': '아직 워커에서 값을 읽지 않았습니다 — 보이는 값은 자리채움입니다. [워커에서 읽기] 를 누르세요.',
  'params.banner.disconnected': '연결이 없습니다 — 파라미터를 읽을 수도 보낼 수도 없습니다. 보이는 값은 자리채움입니다.',
  'params.banner.noScene': '씬이 없습니다 — 파라미터는 씬에 딸려 있어 로드해야 읽을 수 있습니다. 보이는 값은 자리채움입니다.',
  'params.banner.loading': '워커에서 읽는 중…',
  'params.banner.error': '워커에서 읽지 못했습니다: {why}',
  'params.banner.stale': '씬이나 세션이 바뀌었습니다 — [워커에서 읽기] 로 값을 다시 맞추세요.',
  'params.banner.missing': '워커가 값을 주지 않은 필드가 {n}개 있습니다 — 그 행은 자리채움을 보여줍니다.',
  'params.hint.clean': '바뀐 값이 없습니다. 워커의 값을 그대로 보여주는 중입니다.',
  'params.hint.dirty': '변경 {n}건 — [적용] 은 바뀐 값만 보내고, 보낸 뒤 워커에서 다시 읽어 화면을 덮습니다.',
  'params.badge.loading': '· 읽는 중…',
  'params.badge.disconnected': '· 연결 없음',
  'params.badge.noScene': '· 씬 없음',
  'params.badge.error': '· 읽기 실패',
  'params.badge.idle': '· 자리채움',
  'params.badge.stale': '· 갱신 필요',
  'params.badge.clean': '· 워커와 일치',
  'params.badge.dirty': '· 변경 {n}건',
  'params.row.missing': 'ⓘ 워커가 이 값을 주지 않았습니다 — 표시값은 자리채움입니다',
  'params.blocked.playing': '재생 중에는 적용하지 않습니다 — [⏸ 정지] 후 누르세요 (시뮬 도중 변경의 반영 방식은 측정되지 않았습니다)',

  // ── 상단 바의 계측 글자 ─────────────────────────────────
  'stat.mesh': '패턴 {patterns} · 정점 {vertices} · 삼각형 {triangles}',
  'stat.frames': '프레임 {frame} · 적용 {applied} · 버림 {dropped} · {fps}fps',
  'stat.frames.stalled': ' · ⚠정지',
  'snap.exporting': '익스포트 중… {sec}s',
  'snap.downloading': '내려받는 중… {loaded}',
  'snap.downloading.total': '내려받는 중… {loaded} / {total}',
  'snap.parsing': 'glTF 를 여는 중… ({total})',
  'snap.summary': '스냅샷 {bytes} · 메시 {meshes} · 정점 {vertices} · 머티리얼 {materials} · 텍스처 {textures}',

  // ── 상태줄 (#status) ────────────────────────────────────
  //
  // ⓘ 상태줄은 **항상 보이는 자리**라 로그(범위 밖)와 다르다. 여기 문구는
  //   `main.ts` 의 `statusT()` 를 거치고, 언어를 바꾸면 마지막 한 줄이 그대로
  //   다시 그려진다.
  'status.closed': '연결이 끊겼습니다 (code={code})',
  'status.closed.retry': '연결이 끊겼습니다 (code={code}) — 재시도 중',
  'status.topology.giveUp': '토폴로지를 다시 세워도 계속 어긋납니다 — 복구를 중단합니다',
  'status.topology.retry': '토폴로지를 다시 받습니다 ({n}/{max})',
  'status.body.unknownKeys': '워커가 모르는 체형 키가 있습니다: {keys}',
  'status.body.failed': '아바타 체형 적용 실패: {why}',
  'status.surface.failed': '옷 사이즈 적용 실패: {why}',
  'status.cleared': '씬을 내렸습니다 — 다시 보려면 [로드] 를 누르세요',
  'status.snap.making': '스냅샷을 만드는 중… (아바타·머티리얼이 들어간 glTF 를 받습니다)',
  'status.snap.showing': '스냅샷 표시 중 — {name}',
  'status.snap.failed': '스냅샷 실패: {why}',
  'status.mode.snapshot': '스냅샷 표시 중',
  'status.mode.live': '실시간 뷰 — 시뮬레이션 결과를 그립니다',
  'status.scenes.failed': '씬 목록을 읽지 못했습니다: {why}',
  'status.loading': '씬을 로드하는 중… (103MB 면 1초쯤 걸립니다)',
  'status.loaded': '로드 완료 ({ms}ms)',
  'status.load.failed': '로드 실패: {why}',
  'status.action.failed': '{action} 실패: {why}',
  'status.uploading': '업로드 중… {name} ({size})',
  'status.upload.failed': '업로드 실패: {why}',
  'status.gateway.down': '게이트웨이가 응답하지 않습니다 — backend 에서 `npm run serve` 를 띄우세요',
  'status.connecting': '세션을 여는 중… (워커 프로세스가 뜹니다)',
  'status.connect.failed': '연결 실패: {why}',
  'status.connected.empty': '연결됨 — .zls 를 업로드하세요',

  // 조작 이름 (실패 문구에 끼워 넣는다)
  'action.toggle': '재생/정지',
  'action.play': '재생',
  'action.pause': '정지',
  'action.reset': '리셋',
  'action.clear': '씬 내림',
  'action.step': '스텝',
};

const EN: Dict = {
  // ── 상단 바 ─────────────────────────────────────────────
  'app.title': 'Cobalt — 3D view',
  'bar.lang': 'Language',
  'bar.scene': 'Scene',
  'bar.scene.loading': 'Loading…',
  'bar.scene.empty': 'No scene uploaded — add a .zls file',
  'bar.load': 'Load',
  'bar.file': 'Choose file',
  'bar.file.none': 'No file chosen',
  'bar.upload': 'Upload',
  'bar.play': '▶ Play',
  'bar.pause': '⏸ Pause',
  'bar.reset': '↺ Reset',
  'bar.reset.title': 'Rewinds the simulation to the start. The scene stays loaded (R)',
  'bar.clear': '✕ Unload',
  'bar.clear.title': 'Unloads the scene from the worker. Load it again to see it (C)',
  'bar.drape': '👗 Drape',
  'bar.snap': '🧍 Snapshot',
  'bar.snap.again': '🧍 Retake',
  'bar.snap.title': 'Exports the current pose as glTF and shows it with the avatar',
  'bar.mode.live': '↩ Live',
  'bar.mode.snapshot': '🧍 Show snapshot',
  'bar.status.booting': 'Starting…',

  // ── 칸 안의 글자 ────────────────────────────────────────
  'hint.view': 'drag = orbit · right-drag = pan · wheel = zoom  |  one grid cell = 10cm',
  'hint.shortcuts': 'S play/pause · R reset · C unload scene',
  'cell.draft2d.title': '2D cutting draft',
  'cell.draft2d.empty': 'Load a scene and the cutting draft appears here',
  'cell.unfold': 'Unfold',
  'cell.unfold.title': '3D drape ↔ 2D cutting draft. Stop midway to see which piece goes where',
  'cell.avatar': '🧍 Avatar',
  'cell.texture': '🎨 Texture',

  // ── 오른쪽 칸 · 서랍 ────────────────────────────────────
  'side.drawer.open': '☰ Settings',
  'side.drawer.close': '✕ Settings',
  'side.drawer.title': 'Opens and closes the body / garment size panel (Esc to close)',
  'side.tab.avatar': 'Avatar',
  'side.tab.surface': 'Garment size',

  // ── 접힌 상자 ───────────────────────────────────────────
  'params.summary': '⚙ Parameters',
  'log.summary': 'Log',

  // ── 재단 도면의 표시 스위치 (D2-e) ──────────────────────
  'draft2d.layer.links': 'Seam links',
  'draft2d.layer.seams': 'Seams',
  'draft2d.layer.outer': 'Outer lines',
  'draft2d.layer.inner': 'Inner lines',
  'draft2d.layer.vertices': 'Control points',
  'draft2d.layer.stitches': 'Stitches',

  // ── 실시간 뷰의 무늬 스위치 (materials-c) ────────────────
  'tex.noScene': 'Load a scene and its textures are applied',
  'tex.none': 'This scene has no textures',
  'tex.count': '{files} textures',
  'tex.count.off': '{files} textures (off)',
  'tex.rejected': ' · ⚠ {n} slots rejected',

  // ── 공통 위젯 ───────────────────────────────────────────
  'btn.apply': 'Apply',
  'btn.apply.n': 'Apply ({n})',
  'btn.revert': 'Revert',
  'btn.apply.title': 'Sends only the values you changed to the worker',
  'valid.notNumber': 'Not a number',
  'valid.notPositive': 'Must be greater than 0',

  // ── 옷 사이즈 (L-3b) ────────────────────────────────────
  'side.surface.title': 'Garment size (cm)',
  'side.surface.revert.title': 'Discards the edits on this row',
  'surface.noScene': 'Load a scene to adjust pattern sizes',
  'surface.empty': 'This scene has no patterns',

  // ── 직물 (UI #50) ───────────────────────────────────────
  'fabric.label': 'Fabric',
  'fabric.noScene': 'Load a scene to change fabrics',
  'fabric.empty': 'This scene has no fabrics',
  'fabric.inFileOnly': 'This installation ships no preset fabrics — you can only swap between the {n} that came with this garment',
  'fabric.missingTexture': ' (texture file missing)',
  'fabric.applying': 'Applying the fabric…',
  'fabric.applied': 'Fabric — {name}',
  'status.fabric.failed': 'Applying the fabric failed: {why}',

  // ── 아바타 체형 (L-3a) ──────────────────────────────────
  'side.body.title': 'Body shape (normalized 0–1)',
  'side.body.revert.title': 'Discards on-screen edits and refills from the worker',
  'body.noScene': 'Load a scene to adjust the avatar body',
  'avatar.none': 'This scene has no avatar',
  'body.group.overall': 'Overall',
  'body.group.upper': 'Upper body',
  'body.group.lower': 'Lower body',
  'body.group.arm': 'Arm',
  'body.group.other': 'Other',
  'body.fatness': 'Body fat',
  'body.height': 'Height',
  'body.shoulder': 'Shoulder width',
  'body.shoulder_height': 'Shoulder height',
  'body.neck': 'Neck girth',
  'body.mid_neck': 'Mid neck',
  'body.backneck_height': 'Back neck height',
  'body.head': 'Head',
  'body.chest': 'Chest',
  'body.bust_size': 'Bust size',
  'body.bust_depth': 'Bust depth',
  'body.bust_height': 'Bust height',
  'body.under_bust': 'Under bust',
  'body.bustpoint_to_bustpoint': 'Bust point spacing',
  'body.belly': 'Belly',
  'body.waist_height': 'Waist height',
  'body.pelvis': 'Pelvis',
  'body.high_hip': 'High hip',
  'body.low_hip': 'Low hip',
  'body.hip_height': 'Hip height',
  'body.crotch': 'Crotch',
  'body.arm_length': 'Arm length',
  'body.upper_arm_length': 'Upper arm length',
  'body.bicep': 'Bicep',
  'body.wrist': 'Wrist',
  'body.thigh': 'Thigh',
  'body.knee_height': 'Knee height',
  'body.calf': 'Calf',
  'body.ankle': 'Ankle',

  // ── 아바타 치수 (W-2) ───────────────────────────────────
  'side.meas.title': 'Measurements (cm)',
  'side.meas.stale': 'You just sent body-shape sliders — the measurements below were taken before that.'
    + ' Applying measurements once refreshes all 25 with freshly taken values.',
  'side.meas.now': 'now {v}',
  'side.meas.target': ' · target {v} ({d})',
  'side.meas.locked': ' · locked',
  'meas.disconnected': 'Not connected — measurements can be neither read nor sent',
  'meas.noScene': 'Load a scene to adjust measurements',
  'meas.notSupported': 'This avatar does not support measurement reshaping (not a ztDesignZeta)'
    + ' — the body-shape sliders still work.'
    + ' If you applied a drape, reloading the scene brings the original avatar back',
  'meas.applying': 'Applying measurements… {sec}s / est. {want}s'
    + ' · meanwhile the worker will not answer play, reset or other commands',
  'meas.applied': 'Measurements applied — {applied} ({sec}s · {steps} steps)'
    + ' · the simulation was rewound to the start',
  'meas.approx': ' · the shaper approximates, so it is off target by up to {cm}cm (this is normal)',
  'meas.unknown': ' · ⚠ unknown measurements: {keys}',
  'meas.rejected': ' · ⚠ values not used: {keys}',
  'meas.noChange': 'No measurement changed — edit a value, then press [Apply]',
  'meas.failed': 'Applying measurements failed: {why}',
  'meas.edited': '{n} edited — applying takes about {sec}s',
  'meas.tooLong': ' · ⚠ may exceed the {limit}s worker limit — apply in smaller batches',

  // ── 실패 사유 ───────────────────────────────────────────
  'err.unknown': 'Unknown error',
  'err.notConnected': 'Not connected',
  'err.noScene': 'No scene is loaded',
  'err.noAvatarScene': 'No scene with an avatar is loaded',
  'err.noMeasureToSend': 'Nothing to send — change a value first',
  'err.unknownCause': 'cause unknown',

  // ── 드레이프 (W-1) ──────────────────────────────────────
  'drape.disconnected': 'Not connected — the drape cannot be applied',
  'drape.noScene': 'Load a scene to apply its saved drape',
  'drape.applying': 'Applying the drape…',
  'drape.applied': 'Drape applied · the simulation was rewound to the start',
  'drape.applied.named': 'Drape applied — {name} · the simulation was rewound to the start',
  'drape.noAutoItem': 'This scene has no saved auto drape — the garment is unchanged',
  'drape.loadFailed': 'The engine could not apply the drape',
  'drape.failed': 'Applying the drape failed: {why}',

  // ── 시뮬 상태 (#14) ─────────────────────────────────────
  'sim.atFrame': ' · frame {frame}',
  'sim.disconnected': 'Not connected',
  'sim.noScene': 'No scene — load a .zls',
  'sim.loading': 'Loading the scene…',
  'sim.playing': 'Simulation running{at}',
  'sim.paused': 'Paused{at}',

  // ── 실시간 뷰의 아바타 (AM-1) ───────────────────────────
  'av.hidden': 'Avatar hidden',
  'av.noScene': 'Load a scene and the body appears',
  'av.loading.first': 'Fetching the body… (1.9MB)',
  'av.loading': 'Refreshing the body…',
  'av.none': 'No avatar takes part in the simulation in this scene',
  'av.failed': 'Could not fetch the body: {why}',
  'av.ready': '{avatars} avatars · {vertices} vertices',
  'av.anim': ' · anim {at}/{total}',

  // ── 2D 펼침 (#15-b) ─────────────────────────────────────
  'unfold.noScene': 'No scene',
  'unfold.allUnplaced': 'None of the {patterns} patterns has a 2D placement — no draft can be drawn',
  'unfold.noPatterns': 'No patterns',
  'unfold.someUnplaced': '{unplaced} patterns have no 2D placement and stay at their 3D position',

  // ── 파라미터 패널 (#16) ─────────────────────────────────
  'param.group.general': 'General',
  'param.group.ground': 'Ground',
  'param.group.wind': 'Wind',
  'param.group.solver': 'Solver',
  'param.group.coupling': 'Coupling',
  'param.group.meshing': 'Meshing',

  'param.solverType.opt.0': 'Implicit Euler, 1st order',
  'param.solverType.opt.1': 'Implicit Euler, 2nd order',
  'param.solverType.opt.2': 'XPBD (position based)',
  'param.preconditioner.opt.0': 'Identity (none)',
  'param.preconditioner.opt.1': 'Diagonal',
  'param.preconditioner.opt.2': 'Block-Diagonal (recommended)',
  'param.coupling.opt.0': 'None',
  'param.coupling.opt.1': 'Implicit contact',
  'param.coupling.opt.2': 'Implicit contact (directional)',
  'param.coupling.opt.3': 'Penalty',
  'param.coupling.opt.4': 'Projective constraints',

  'param.timeStep.label': 'Time step (Hz)',
  'param.timeStep.desc': 'How many slices one second is solved in. Higher is more stable but slower.',
  'param.timeStep.note': 'Measured: 45 → 90 moves vertices 1.78cm on average / 8.61cm at most',
  'param.subStep.label': 'Sub-steps',
  'param.subStep.desc': 'How many times one time step is subdivided again.',
  'param.subStep.note': 'Engine ignores this — 1 → 8 leaves every vertex bit-identical (ISSUE-014)',
  'param.drapingTime.label': 'Draping time (s)',
  'param.drapingTime.desc': 'Length of the initial phase where the garment settles onto the avatar.',
  'param.drapingTime.note': 'Measured: 0.4 → 3 moves 4.94cm on average / 16.20cm at most. Fairly influential',
  'param.gravityY.label': 'Gravity Y (cm/s²)',
  'param.gravityY.desc': 'Downward acceleration. 0 means weightless.',
  'param.gravityY.note': 'Measured: -980 → 0 moves 0.22cm on average. It is applied, but the change is small (ISSUE-014, open ②)',
  'param.groundPlane.label': 'Ground collision',
  'param.groundPlane.desc': 'Enables the collision ground plane. Separate from the rendered floor.',
  'param.groundPlane.note': 'Unverified in this scene — the garment floats 9.27cm above the floor, so there is no contact (ISSUE-014)',
  'param.groundFriction.label': 'Ground friction',
  'param.groundFriction.desc': 'Friction coefficient when the garment touches the floor. 0 slides freely.',
  'param.groundFriction.note': 'Unverified in this scene — there is no ground contact (ISSUE-014)',
  'param.groundMargin.label': 'Ground margin (cm)',
  'param.groundMargin.desc': 'How far the collision plane sits above the rendered floor. Negative goes below.',
  'param.groundMargin.note': 'Measured: 0.5 → 5 moves 0.02cm on average / 0.58cm at most — why it moves without contact is unresolved',
  'param.useWind.label': 'Use wind',
  'param.useWind.desc': 'Turns wind on. Its strength is set by the next field.',
  'param.useWind.note': 'Measured: 0.11cm on average on its own. 7.19cm when combined with strength',
  'param.windMagnitude.label': 'Wind strength',
  'param.windMagnitude.desc': 'Magnitude of the wind. Its direction comes from the scene (not in the protocol).',
  'param.windMagnitude.note': '0cm on its own. It only moves together with `Use wind` (ISSUE-014 ①)',
  'param.solverType.label': 'Integrator',
  'param.solverType.desc': 'How the equations of motion are solved. Changeable only before the simulation is initialized.',
  'param.solverType.note': 'Measured: 0 → 1 moves 1.19cm on average',
  'param.preconditioner.label': 'Preconditioner',
  'param.preconditioner.desc': 'Preconditioning of the linear system. Block-Diagonal is the recommended value.',
  'param.preconditioner.note': 'Measured: 2 → 1 moves 3.84cm on average / 9.80cm at most. Fairly influential',
  'param.nonlinearIterations.label': 'Nonlinear iterations',
  'param.nonlinearIterations.desc': 'How many times the nonlinear system is re-solved per step. Higher is more accurate but much slower.',
  'param.nonlinearIterations.note': 'Measured: 1 → 10 moves 1.67cm on average. The same 100 frames go from 12s to 56s',
  'param.maxSolverIterations.label': 'Linear solver max iterations',
  'param.maxSolverIterations.desc': 'How many times to iterate when the tolerance is not reached.',
  'param.maxSolverIterations.note': 'Measured: 600 → 5 moves 2.97cm on average / 11.33cm at most',
  'param.solverTolerance.label': 'Linear solver tolerance',
  'param.solverTolerance.desc': 'Smaller is more accurate and slower. Enter it in exponent notation (e.g. 1e-4).',
  'param.solverTolerance.note': 'Measured: 1e-4 → 0.1 moves 3.03cm on average / 13.56cm at most',
  'param.useIEQS.label': 'Quasi-static',
  'param.useIEQS.desc': 'Uses the implicit-Euler quasi-static solve during the draping phase.',
  'param.useIEQS.note': 'Measured: false → true moves 5.51cm on average / 17.94cm at most. The largest effect of the 22 measured',
  'param.staticCouplingMethod.label': 'Static coupling',
  'param.staticCouplingMethod.desc': 'How contact with immobile bodies such as the avatar is solved. Projective constraints is the recommended value.',
  'param.staticCouplingMethod.note': 'Measured: 4 → 1 moves 5.29cm on average / 10.78cm at most',
  'param.dynamicCouplingMethod.label': 'Dynamic coupling',
  'param.dynamicCouplingMethod.desc': 'How cloth self-collision is solved. Penalty is the recommended value.',
  'param.dynamicCouplingMethod.note': 'Measured: 3 → 1 moves 0.41cm on average / 6.80cm at most',
  'param.dynCouplingStiffness.label': 'Dynamic penalty stiffness',
  'param.dynCouplingStiffness.desc': 'How hard self-collisions push apart.',
  'param.dynCouplingStiffness.note': 'Measured: 750 → 0 moves 0.43cm on average',
  'param.dynCouplingDamping.label': 'Dynamic penalty damping',
  'param.dynCouplingDamping.desc': 'Damping applied while self-collisions push apart.',
  'param.dynCouplingDamping.note': 'Measured: 0.1 → 0 moves 0.57cm on average',
  'param.untanglingStiffness.label': 'Untangling stiffness',
  'param.untanglingStiffness.desc': 'How hard already-interpenetrating regions are pulled apart.',
  'param.untanglingStiffness.note': 'Measured: 20000 → 0 moves 0.33cm on average',
  'param.untanglingDamping.label': 'Untangling damping',
  'param.untanglingDamping.desc': 'Damping applied while untangling.',
  'param.untanglingDamping.note': 'Measured: 250 → 0 moves 1.80cm on average / 6.89cm at most',
  'param.meshingEdgeLength.label': 'Mesh edge length (cm)',
  'param.meshingEdgeLength.desc': 'Target edge length when patterns are triangulated. Smaller is denser and slower.',
  'param.meshingEdgeLength.note': 'Engine ignores this — 1 → 4 leaves every vertex bit-identical (ISSUE-014)',

  // 값 보정 사유 (화면에 그대로 찍힌다)
  'coerce.numToBool': 'Converted a number to true/false',
  'coerce.notBool': 'Not a true/false value — using the default ({fallback})',
  'coerce.wantNumber': 'A number was expected — using the default ({fallback})',
  'coerce.notNumber': 'Not a number — using the default ({fallback})',
  'coerce.notAnOption': '{raw} is not one of the choices — using the default',
  'coerce.rounded': 'Integers only — rounded {raw} to {value}',
  'coerce.belowMin': 'Below the minimum {min} — clamped to {min}',
  'coerce.aboveMax': 'Above the maximum {max} — clamped to {max}',

  // 비활성 사유. **툴팁이 아니라 화면 글자다**(#16 에서 확립한 규칙)
  'param.off.dead': 'The engine does not read this value (ISSUE-014) — changing it does not change the simulation, so it is not sent',
  'param.off.simInit': 'Cannot be changed after the simulation is initialized — same as the desktop app',
  'param.off.dependency': "'{label}' is off, so this value is not applied to the simulation",

  // 배지·버튼·배너 (`ui/paramsPanel.ts`)
  'param.badge.dead': 'engine ignores',
  'param.badge.conditional': 'conditional',
  'param.badge.guess': 'range guessed',
  'param.badge.guess.title': 'The desktop app has no widget for this, so min/max are estimates',
  'params.read': 'Read from worker',
  'params.read.title': 'Discards the on-screen values and refills them from the worker',
  'params.banner.idle': 'Values have not been read from the worker yet — what you see is placeholder. Press [Read from worker].',
  'params.banner.disconnected': 'No connection — parameters can be neither read nor sent. What you see is placeholder.',
  'params.banner.noScene': 'No scene — parameters belong to a scene, so one must be loaded. What you see is placeholder.',
  'params.banner.loading': 'Reading from the worker…',
  'params.banner.error': 'Could not read from the worker: {why}',
  'params.banner.stale': 'The scene or session changed — press [Read from worker] to resync the values.',
  'params.banner.missing': 'The worker gave no value for {n} fields — those rows show placeholders.',
  'params.hint.clean': 'Nothing changed. Showing the worker values as they are.',
  'params.hint.dirty': '{n} changes — [Apply] sends only what changed, then reads back from the worker and overwrites the screen.',
  'params.badge.loading': '· reading…',
  'params.badge.disconnected': '· not connected',
  'params.badge.noScene': '· no scene',
  'params.badge.error': '· read failed',
  'params.badge.idle': '· placeholder',
  'params.badge.stale': '· needs refresh',
  'params.badge.clean': '· matches worker',
  'params.badge.dirty': '· {n} changed',
  'params.row.missing': 'ⓘ The worker gave no value for this — the shown value is a placeholder',
  'params.blocked.playing': 'Not applied while playing — press [⏸ Pause] first (how mid-simulation changes take effect has not been measured)',

  // ── 상단 바의 계측 글자 ─────────────────────────────────
  'stat.mesh': '{patterns} patterns · {vertices} vertices · {triangles} triangles',
  'stat.frames': 'frame {frame} · {applied} applied · {dropped} dropped · {fps}fps',
  'stat.frames.stalled': ' · ⚠stalled',
  'snap.exporting': 'Exporting… {sec}s',
  'snap.downloading': 'Downloading… {loaded}',
  'snap.downloading.total': 'Downloading… {loaded} / {total}',
  'snap.parsing': 'Opening the glTF… ({total})',
  'snap.summary': 'Snapshot {bytes} · {meshes} meshes · {vertices} vertices · {materials} materials · {textures} textures',

  // ── 상태줄 (#status) ────────────────────────────────────
  'status.closed': 'The connection dropped (code={code})',
  'status.closed.retry': 'The connection dropped (code={code}) — retrying',
  'status.topology.giveUp': 'The topology still does not match after restaging — giving up on recovery',
  'status.topology.retry': 'Refetching the topology ({n}/{max})',
  'status.body.unknownKeys': 'The worker does not know some body keys: {keys}',
  'status.body.failed': 'Applying the body shape failed: {why}',
  'status.surface.failed': 'Applying the garment size failed: {why}',
  'status.cleared': 'The scene was unloaded — press [Load] to see it again',
  'status.snap.making': 'Making a snapshot… (fetching a glTF with the avatar and materials)',
  'status.snap.showing': 'Showing a snapshot — {name}',
  'status.snap.failed': 'Snapshot failed: {why}',
  'status.mode.snapshot': 'Showing a snapshot',
  'status.mode.live': 'Live view — drawing the simulation result',
  'status.scenes.failed': 'Could not read the scene list: {why}',
  'status.loading': 'Loading the scene… (about a second for 103MB)',
  'status.loaded': 'Loaded ({ms}ms)',
  'status.load.failed': 'Load failed: {why}',
  'status.action.failed': '{action} failed: {why}',
  'status.uploading': 'Uploading… {name} ({size})',
  'status.upload.failed': 'Upload failed: {why}',
  'status.gateway.down': 'The gateway is not responding — run `npm run serve` in backend',
  'status.connecting': 'Opening a session… (a worker process starts up)',
  'status.connect.failed': 'Connection failed: {why}',
  'status.connected.empty': 'Connected — upload a .zls',

  // 조작 이름 (실패 문구에 끼워 넣는다)
  'action.toggle': 'Play/pause',
  'action.play': 'Play',
  'action.pause': 'Pause',
  'action.reset': 'Reset',
  'action.clear': 'Unload scene',
  'action.step': 'Step',
};

/** 사전 두 벌. 스모크가 **키 집합이 같은지** 를 여기서 본다 */
export const MESSAGES: Readonly<Record<Lang, Dict>> = { ko: KO, en: EN };

// ── 조회 ────────────────────────────────────────────────────

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

/**
 * 문구 안의 자리표시자 이름을 순서대로 모은다. 값이 끼어드는 문구가 두
 * 언어에서 **같은 집합**을 갖는지 보는 데 쓴다 — 한쪽에서 빠지면 그 값이
 * 화면에서 조용히 사라진다.
 */
export function placeholdersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    const name = m[1];
    if (name !== undefined && !out.includes(name)) out.push(name);
  }
  return out.sort();
}

/**
 * 사전에서 문구를 꺼내 자리표시자를 채운다.
 *
 * **모르는 키는 키 자체를 돌려준다.** 빈 문자열을 돌려주면 화면에서 글자가
 * 조용히 사라지고, 그러면 "안 만든 것" 과 "고장난 것" 을 구분할 수 없다.
 * 값이 안 들어온 자리표시자도 `{name}` 그대로 남긴다 — 같은 이유다.
 */
export function translate(lang: Lang, key: string, vars?: MessageVars): string {
  const table = MESSAGES[lang] ?? MESSAGES[DEFAULT_LANG];
  // 영어 사전에 아직 없는 키는 **한국어로 떨어진다.** 키 문자열보다 낫다
  const text = table[key] ?? MESSAGES[DEFAULT_LANG][key] ?? key;
  if (vars === undefined) return text;
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const v = vars[name];
    return v === undefined ? whole : String(v);
  });
}

/**
 * 모르는 언어 코드는 **한국어로 떨어진다.** 저장소에 이상한 값이 들어 있다고
 * 화면이 비면 안 된다. `'en-US'` 처럼 지역이 붙은 값도 받아 준다.
 */
export function normalizeLang(raw: unknown): Lang {
  if (typeof raw !== 'string') return DEFAULT_LANG;
  const head = raw.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return (LANGS as readonly string[]).includes(head) ? (head as Lang) : DEFAULT_LANG;
}

// ── 저장 ────────────────────────────────────────────────────

export const LANG_STORAGE_KEY = 'cobalt.lang';

/** `localStorage` 만큼만 요구한다 — Node 스모크가 가짜를 끼울 수 있어야 한다 */
export interface LangStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): LangStore | null {
  const g = globalThis as { localStorage?: LangStore };
  return g.localStorage ?? null;
}

/**
 * 저장된 언어를 읽는다. **저장소가 없거나 던져도 한국어로 떨어진다** —
 * 사생활 모드의 브라우저는 `localStorage` 접근 자체가 예외다.
 */
export function readStoredLang(store?: LangStore | null): Lang {
  const s = store === undefined ? defaultStore() : store;
  if (s === null) return DEFAULT_LANG;
  try {
    return normalizeLang(s.getItem(LANG_STORAGE_KEY));
  } catch {
    return DEFAULT_LANG;
  }
}

/**
 * 고른 언어를 적는다.
 *
 * @returns 실제로 적혔으면 참. **실패해도 던지지 않는다** — 저장이 안 되는
 *          것은 다음 방문에 기본 언어로 열린다는 뜻일 뿐이고, 그 때문에
 *          지금 화면이 죽으면 안 된다.
 */
export function storeLang(lang: Lang, store?: LangStore | null): boolean {
  const s = store === undefined ? defaultStore() : store;
  if (s === null) return false;
  try {
    s.setItem(LANG_STORAGE_KEY, lang);
    return true;
  } catch {
    return false;
  }
}

// ── 현재 언어 (싱글턴) ──────────────────────────────────────

let current: Lang = DEFAULT_LANG;
const listeners = new Set<(lang: Lang) => void>();

export function getLang(): Lang {
  return current;
}

/**
 * 언어를 바꾸고 **듣는 쪽에 알린다.** 새로고침을 요구하지 않는 이유는
 * 씬 로드가 2~3초라서다 — 언어를 바꿀 때마다 씬을 다시 열게 된다.
 *
 * @returns 실제로 적용된 언어(모르는 값이면 한국어).
 */
export function setLang(raw: unknown, store?: LangStore | null): Lang {
  const next = normalizeLang(raw);
  storeLang(next, store);
  if (next === current) return current;
  current = next;
  for (const fn of [...listeners]) fn(next);
  return current;
}

/**
 * 저장된 값으로 첫 언어를 정한다. 저장된 값이 없거나 모르는 값이면 한국어다.
 * 배선이 화면을 처음 그리기 **전에** 부른다.
 */
export function initLang(store?: LangStore | null): Lang {
  const next = readStoredLang(store);
  if (next !== current) {
    current = next;
    for (const fn of [...listeners]) fn(next);
  }
  return current;
}

/** @returns 듣기를 그만두는 함수 */
export function onLangChange(fn: (lang: Lang) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 지금 언어로 문구를 꺼낸다. 화면 글자를 만드는 자리는 전부 이것을 부른다 */
export function t(key: string, vars?: MessageVars): string {
  return translate(current, key, vars);
}
