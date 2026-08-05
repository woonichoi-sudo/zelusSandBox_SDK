// JSON Lines 프로토콜 루프
//
// 게이트웨이(Node)가 이 exe를 자식 프로세스로 띄우고 파이프로 대화한다.
//   stdin  : 요청 1줄 = JSON 객체 1개
//   stdout : 응답과 이벤트. 반드시 JSON만 나간다
//   stderr : 사람이 읽는 로그
//
// 세션 = 프로세스 1개다. ZestManager의 콜백이 전부 static이라 한 프로세스에
// 두 세션을 둘 수 없고, 그래서 프로세스 수명이 곧 세션 수명이다.

#pragma once

class ZestManager;

// stdin이 닫히거나 quit을 받을 때까지 돈다. 프로세스 종료 코드를 반환한다.
int RunProtocolLoop(ZestManager& manager);
