# Stream Drops Hub v1.4.7

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
