# Ddong 공중화장실 (전국)

전국 공중화장실을 지도에서 찾는 PWA 앱입니다.

## 데이터
- 출처: 행정안전부_공중화장실정보 조회서비스 (공공데이터포털, 이용허락범위 제한 없음)
- `scripts/fetch-toilets.mjs` 가 매일 새벽 5시(한국시간) GitHub Actions로 실행되어
  전국 데이터를 받고, 카카오 주소 검색으로 좌표를 붙여 `public/data/` 에 시·도별 JSON으로 저장합니다.
- 필요한 저장소 Secret: `MOIS_TOILET_KEY`(공공데이터 서비스키), `KAKAO_REST_KEY`(카카오 REST API 키)
