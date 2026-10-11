# Ddong 공중화장실 (전국)

전국 공중화장실을 내 주변부터 찾아 주는 PWA 앱입니다. 제주판(jeju-toilet)과 같은 화면·기능에 연핑크 색상을 씁니다.

## 화면
- 상단 칩: **내 주변**(내 위치 둘레 시·도를 자동으로 불러옴) + 시·도별 칩 → 시·군·구 칩 → 편의시설 필터
- 홈(가까운 순 목록) · 지도(묶음 표시) · SOS · 이용 안내(문의하기)
- 길안내는 카카오맵·네이버지도 앱으로 내 위치에서 바로 출발
- 사진 올리기: 관리자 확인 후 공개 (Supabase, `app = korea`)

## 데이터
- 출처: 행정안전부_공중화장실정보 조회서비스 (공공데이터포털, 이용허락범위 제한 없음)
- `scripts/fetch-toilets.mjs` 가 매일 새벽 5시(한국시간) GitHub Actions로 실행되어
  전국 데이터를 받고, 카카오 주소 검색으로 좌표를 붙여 `public/data/` 에 시·도별 JSON으로 저장합니다.
  - `public/data/index.json` — 시·도 목록, 건수, 범위
  - `public/data/toilets-<시도>.json` — 화장실 목록
  - `data/geocache.json` — 주소→좌표 캐시 (다음 실행 때 새 화장실만 변환)
- 필요한 저장소 Secret: `MOIS_TOILET_KEY`(공공데이터 서비스키), `KAKAO_REST_KEY`(카카오 REST API 키)

## 배포
Settings → Pages → Branch `main` / `(root)` 로 GitHub Pages 를 켜면
`https://linkcleaning.github.io/ddong-korea/` 에서 열립니다.
