# Stream Drops Hub v1.5.6 (로컬 작업본)

## 개요
- GitHub 저장소: https://github.com/Hwiyeongs/stream-drops-hub (Public)
- 최신 릴리즈: [v1.4.7](https://github.com/Hwiyeongs/stream-drops-hub/releases/tag/v1.4.7) (`stream-drops-hub-v1.4.7.zip`)

## 핵심 아키텍처 및 구현 원칙
- **트위치 수령 보안 및 무결성 (v1.4.7)**:
  - Twitch 실제 페이지의 GQL 요청에서 `Authorization`, `Client-Integrity`, 세션/디바이스 헤더를 `webRequest`로 읽기 전용 캡처하여 수령 요청에 재사용.
  - 헤더는 브라우저 세션 저장소(`chrome.storage.session`)에만 안전하게 보관.
  - 무결성 토큰 만료/거부 시 보관함 탭에서 헤더를 자동 갱신하고 1회 재시도.
  - 불필요해진 `scripting` 권한 제거 및 `webRequest` 권한 적용.
- **날짜 정렬 및 표기**:
  - 트위치: 제목의 `[MMDD]` 우선, 없을 시 개별 드롭 `startAt` → 캠페인 `startAt` 순서로 폴백.
  - 치지직: `createdDate`를 `acquiredAt`으로 보존.
  - SOOP: `recentDate` 기준 오늘/어제 필터링.
- **서비스워커 중심 처리**:
  - 팝업은 뷰/복사만 담당, 네트워크·설정·기록 쓰기는 백그라운드 서비스워커로 집중.
  - 쿠폰 상태 구분: saved(보관), copied(복사), claimed(인앱 수령).
  - 알림 ID와 수령 재시도 분리 (실패 시 주기적 재시도).
- **방송 감지 및 알림**:
  - 이터널리턴 치지직·SOOP 드롭스 방송 감지 및 캠페인 단위 중복 알림 방지.

## 검증 상태
- 회귀 테스트 36개 + 방송 감지 테스트 20개 (총 56개) 전체 통과 (`npm test`).


## v1.5.0 자동 수집
- `src/services/collector-plans.js`: 공개 캠페인/방송, 인증된 보상·미션 진행 데이터로 수집 계획 구성.
- `src/services/auto-collector.js`: 플랫폼별 단일 소유 탭, 재생 확인, 방송 전환, 완료 대기, OFF 정리.
- `background/service-worker.js`: 별도 1분 수집 알람, 기존 직렬 큐를 통한 대상 게임·캠페인 수령.
- 권한 `scripting`은 자동 생성한 치지직·SOOP 탭의 video 재생에 한정해 사용하며 Twitch 헤더 방식은 유지.
- 기존 네트워크/토큰 수령 구현은 유지. 로그인 정보 출력이나 외부 전송 없음.
- 로컬 검증 78개 및 격리 확장 프로그램 검사 통과. 실계정 적립·실수령은 미검증. GitHub 릴리즈는 아직 v1.4.7이며 이 작업에서는 게시하지 않음.

## v1.5.1 사용자 요청 반영
- 치지직·SOOP은 자동 시청/전환만 수행. collectorClaims 콜백 제거. 자동 수령은 트위치만 적용. 수동 쿠폰 처리는 그대로 유지.
- 총 79개 검사 통과.

## v1.5.4 새 방송 시작 안정화
- `auto-collector.js`는 자동 수집 소유 탭과 실제 video 요소를 첫 `play()` 전에 음소거한다. 영상 시간 증가로만 성공을 판정하고, 실패 원인/영상 상태/시도 횟수를 민감 정보 없이 `collectorState.<platform>.diagnostic`에 보관한다.
- 새 방송 로딩·재생 실패는 최대 8번 제한적으로 재시도한다. 소유 탭은 방송 URL을 열기 전에 음소거하며 `autoDiscardable:false`로 보호한다. 최초 `about:blank` 로딩 구간을 사용자 이동으로 오판하지 않고 실제 폐기 시 다시 활성화한다. 정상 재생 탭은 재로드하지 않는다.
- 기존 v1.5.3의 85개 검사와 신규 7개 검사가 통과했다. 모의 CHZZK·SOOP URL의 실제 Chromium에서 일시정지 영상의 음소거 재생 시작과 시간 증가를 확인했다. 물리적으로 모니터를 끈 실계정 적립은 미검증이다.

## v1.5.5 SOOP 재생 수정
- SOOP 실제 공개 방송의 `video#livePlayer`는 처음에 짧은 `data:video` 안내 영상이며, 여기에 직접 `play()`하면 실제 라이브로 연결되지 않는다. 소유 탭의 `button#play.play`를 클릭해 `blob:` 라이브 영상이 시작된 후 시간 증가를 판정한다. 탭 음소거는 계속 유지한다.
- 탭이 재로딩 중 `about:blank`/`pendingUrl` 없음으로 잠깐 보일 때 소유권과 새벽 5시 상태를 유지한다. 다른 URL로의 이동은 계속 사용자 중지로 처리한다.
- 공개 SOOP 방송을 격리 Chromium에서 실제 확장 프로그램으로 재생해 라이브 영상의 시간 증가를 확인했다. 로그인 계정의 서버 적립, 모니터 물리 OFF 조건은 미검증이다.

## v1.5.6 SOOP 탭 포커스 반복 방지
- 사용자가 보고 있던 탭과 SOOP 탭이 2~3분마다 오간다는 보고를 받았다. 원인은 기존 방송의 백그라운드 검사 한 번만 실패해도 `startPlayback()`이 탭을 활성화할 수 있는 경로다. 격리 Chromium에서는 첫 1분 검사 실패가 재현되지 않았으므로 실제 반복 원인의 단정은 보류한다.
- 이미 열린 SOOP 방송의 복구는 먼저 백그라운드 `probe(start=true)`로 수행한다. 새 방송 전환과 폐기 탭 복구는 기존 활성화 경로를 유지한다.
- 자동 수집 테스트에 일시적인 검사 실패 후 백그라운드 복구 및 무포커스 확인 사례를 추가했다.
