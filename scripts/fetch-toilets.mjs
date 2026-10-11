// Ddong 전국 공중화장실 데이터 수집 스크립트
// 행정안전부_공중화장실정보 조회서비스(/info_v2) 전국 데이터
//   → 카카오 주소 검색으로 좌표 변환(한 번 바꾼 좌표는 캐시)
//   → 시·도별 JSON + 목록(index.json) 저장
//
// 실행: MOIS_TOILET_KEY=... KAKAO_REST_KEY=... node scripts/fetch-toilets.mjs
// 외부 패키지 없이 Node 18+ 에서 바로 돌아갑니다.

import fs from "node:fs/promises";
import path from "node:path";

const API = "https://apis.data.go.kr/1741000/public_restroom_info_v2/info_v2";
const KAKAO_ADDR = "https://dapi.kakao.com/v2/local/search/address.json";
const KAKAO_KEYWORD = "https://dapi.kakao.com/v2/local/search/keyword.json";

const OUT_DIR = process.env.OUT_DIR || "public/data";
const CACHE_FILE = process.env.CACHE_FILE || "data/geocache.json";
const ROWS = 100; // API 한 번에 최대 100건
const GEO_CONCURRENCY = Number(process.env.GEO_CONCURRENCY || 5);
// 한 번 실행에서 새로 변환할 최대 건수 (카카오 하루 한도 보호). 남은 건 다음 날 이어서.
const GEO_LIMIT = Number(process.env.GEO_LIMIT || 60000);

// 시·도 이름 → 파일 이름 / 짧은 이름
// 주소 첫 단어로 판별해요. 옛 이름(강원도, 전라북도 등)도 같은 곳으로 묶어요.
const SIDO = [
  { slug: "seoul", name: "서울", match: ["서울"] },
  { slug: "busan", name: "부산", match: ["부산"] },
  { slug: "daegu", name: "대구", match: ["대구"] },
  { slug: "incheon", name: "인천", match: ["인천"] },
  { slug: "gwangju", name: "광주", match: ["광주광역시"] },
  { slug: "jeonnam-gwangju", name: "전남광주", match: ["전남광주"] },
  { slug: "daejeon", name: "대전", match: ["대전"] },
  { slug: "ulsan", name: "울산", match: ["울산"] },
  { slug: "sejong", name: "세종", match: ["세종"] },
  { slug: "gyeonggi", name: "경기", match: ["경기"] },
  { slug: "gangwon", name: "강원", match: ["강원"] },
  { slug: "chungbuk", name: "충북", match: ["충청북도", "충북"] },
  { slug: "chungnam", name: "충남", match: ["충청남도", "충남"] },
  { slug: "jeonbuk", name: "전북", match: ["전라북도", "전북"] },
  { slug: "jeonnam", name: "전남", match: ["전라남도", "전남"] },
  { slug: "gyeongbuk", name: "경북", match: ["경상북도", "경북"] },
  { slug: "gyeongnam", name: "경남", match: ["경상남도", "경남"] },
  { slug: "jeju", name: "제주", match: ["제주"] },
];

function findSido(addr) {
  const first = (addr || "").trim().split(/\s+/)[0] || "";
  // "전남광주통합특별시"가 "광주"보다 먼저 걸리도록 위 순서 + startsWith 사용
  return SIDO.find((s) => s.match.some((m) => first.startsWith(m))) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, opts = {}, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, opts);
      const text = await res.text();
      if (res.status === 429) throw Object.assign(new Error("요청 한도 초과(429)"), { quota: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      try {
        return JSON.parse(text);
      } catch {
        // 공공데이터포털은 키 오류 등을 XML로 돌려줄 때가 있어요
        throw new Error(`JSON 아님: ${text.slice(0, 200)}`);
      }
    } catch (e) {
      if (i === tries || e.quota) throw e;
      await sleep(1000 * i);
    }
  }
}

// ---------- 1. 전국 데이터 받기 ----------

async function fetchPage(key, pageNo) {
  const qs = new URLSearchParams({
    serviceKey: key,
    pageNo: String(pageNo),
    numOfRows: String(ROWS),
    returnType: "json",
  });
  const data = await getJson(`${API}?${qs}`);
  const head = data?.response?.header;
  if (head && head.resultCode !== "0" && head.resultCode !== "00") {
    throw new Error(`API 오류 ${head.resultCode}: ${head.resultMsg}`);
  }
  const body = data?.response?.body ?? {};
  let items = body.items?.item ?? [];
  if (!Array.isArray(items)) items = [items];
  return { items, total: Number(body.totalCount ?? 0) };
}

async function fetchAll(key) {
  const first = await fetchPage(key, 1);
  const pages = Math.ceil(first.total / ROWS);
  console.log(`전국 ${first.total}건, ${pages}쪽 받는 중...`);
  const all = [...first.items];
  // 5쪽씩 동시에 받기
  for (let p = 2; p <= pages; p += 5) {
    const batch = [];
    for (let q = p; q < p + 5 && q <= pages; q++) batch.push(fetchPage(key, q));
    for (const r of await Promise.all(batch)) all.push(...r.items);
    if ((p - 1) % 100 === 0) console.log(`  ${Math.min(p + 4, pages)}/${pages}쪽`);
  }
  if (all.length < first.total * 0.95) {
    throw new Error(`받은 건수가 너무 적어요 (${all.length}/${first.total}) — 기존 데이터를 지키려고 중단해요`);
  }
  return all;
}

// ---------- 2. 좌표 변환 (카카오) ----------

function cleanAddr(addr) {
  if (!addr) return "";
  return addr
    .replace(/\(.*?\)/g, " ") // (금남로1가) 같은 괄호 제거
    .split(",")[0] // ", 금남지하상가" 같은 상세주소 제거
    .replace(/\s+/g, " ")
    .trim();
}

async function kakao(url, kakaoKey, query) {
  if (!query) return null;
  const data = await getJson(`${url}?${new URLSearchParams({ query })}`, {
    headers: { Authorization: `KakaoAK ${kakaoKey}` },
  });
  const d = data?.documents?.[0];
  return d ? [Number(d.y), Number(d.x)] : null;
}

function cacheKeyOf(it) {
  return cleanAddr(it.LCTN_ROAD_NM_ADDR) || cleanAddr(it.LCTN_LOTNO_ADDR) || `이름:${it.RSTRM_NM}`;
}

async function geocodeOne(kakaoKey, it) {
  const road = cleanAddr(it.LCTN_ROAD_NM_ADDR);
  const jibun = cleanAddr(it.LCTN_LOTNO_ADDR);
  const area = (road || jibun).split(" ").slice(0, 2).join(" ");
  return (
    (await kakao(KAKAO_ADDR, kakaoKey, road)) ||
    (await kakao(KAKAO_ADDR, kakaoKey, jibun)) ||
    (await kakao(KAKAO_KEYWORD, kakaoKey, `${area} ${it.RSTRM_NM}`.trim()))
  );
}

async function geocodeMissing(kakaoKey, items, cache) {
  const todo = [];
  const seen = new Set();
  for (const it of items) {
    const k = cacheKeyOf(it);
    if (cache[k] === undefined && !seen.has(k)) { seen.add(k); todo.push([k, it]); }
  }
  const run = todo.slice(0, GEO_LIMIT);
  console.log(`좌표 새로 변환: ${run.length}곳 (캐시에 있음 ${items.length - todo.length}, 다음 실행으로 미룸 ${todo.length - run.length})`);

  let i = 0, done = 0, stop = false;
  async function worker() {
    while (!stop && i < run.length) {
      const [k, it] = run[i++];
      try {
        cache[k] = await geocodeOne(kakaoKey, it); // 못 찾으면 null 저장 → 매일 다시 묻지 않음
      } catch (e) {
        if (e.quota) { stop = true; console.warn("⚠️ 카카오 하루 한도 도달 — 나머지는 내일 이어서 변환해요"); }
        // 실패한 건 캐시에 안 넣어서 다음 실행 때 다시 시도
      }
      if (++done % 1000 === 0) {
        console.log(`  좌표 ${done}/${run.length}`);
        await fs.writeFile(CACHE_FILE, JSON.stringify(cache)); // 중간 저장
      }
      await sleep(30);
    }
  }
  await Promise.all(Array.from({ length: GEO_CONCURRENCY }, worker));
}

// ---------- 3. 앱용 형태로 정리 ----------
// 파일 크기를 줄이려고 값이 없는 항목(0, 빈칸, false)은 넣지 않아요.

const num = (v) => Number(v || 0) || 0;

function compact(obj) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === "" || v === 0 || v === false || v == null) delete obj[k];
  }
  return obj;
}

function toToilet(it, pos, district) {
  return compact({
    id: it.MNG_NO,
    name: it.RSTRM_NM?.trim() || "공중화장실",
    type: it.SE_NM, // 공중화장실 / 개방화장실 등
    district, // 시·군·구 (지역 칩용)
    road: it.LCTN_ROAD_NM_ADDR,
    jibun: it.LCTN_LOTNO_ADDR,
    lat: Math.round(pos[0] * 1e6) / 1e6,
    lng: Math.round(pos[1] * 1e6) / 1e6,
    open: it.OPN_HR, // 상시 / 정시 등
    hours: it.OPN_HR_DTL,
    mT: num(it.MALE_TOILT_CNT), // 남자 대변기
    mU: num(it.MALE_URNL_CNT), // 남자 소변기
    fT: num(it.FEMALE_TOILT_CNT), // 여자 대변기
    accM: num(it.MALE_FRDBL_TOILT_CNT) + num(it.MALE_FRDBL_URNL_CNT), // 장애인용(남)
    accF: num(it.FEMALE_FRDBL_TOILT_CNT), // 장애인용(여)
    kidM: num(it.MALE_CHLD_TOILT_CNT) + num(it.MALE_CHLD_URNL_CNT), // 어린이용(남)
    kidF: num(it.FEMALE_CHLD_TOILT_CNT), // 어린이용(여)
    diaper: it.DIAP_EXCHCON_EN === "Y",
    diaperAt: it.DIAP_EXCHCON_PLC,
    bell: it.EMRGNCBLL_INSTL_YN === "Y",
    bellAt: it.EMRGNCBLL_INSTL_PLC,
    cctv: it.RSTRM_ENTRAN_CCTV_INSTL_EN === "Y",
    mgr: it.MNG_INST_NM,
    tel: it.TELNO,
    upd: it.DAT_CRTR_YMD,
  });
}

function isClosed(it) {
  return it.DAT_UPDT_SE === "D" || /폐업|폐쇄|철거|휴업/.test(it.BSS_STT_NM || "");
}

// ---------- 실행 ----------

async function main() {
  const key = process.env.MOIS_TOILET_KEY;
  const kakaoKey = process.env.KAKAO_REST_KEY;
  if (!key) throw new Error("MOIS_TOILET_KEY 가 없어요 (GitHub Secret 확인)");
  if (!kakaoKey) throw new Error("KAKAO_REST_KEY 가 없어요 (GitHub Secret 확인)");

  let cache = {};
  try { cache = JSON.parse(await fs.readFile(CACHE_FILE, "utf8")); } catch {}
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });

  const raw = await fetchAll(key);
  const open = raw.filter((it) => !isClosed(it));
  // 같은 관리번호 중복 제거
  const items = [...new Map(open.map((it) => [it.MNG_NO, it])).values()];
  console.log(`영업 중 ${items.length}곳 (폐업 등 제외 ${raw.length - open.length})`);

  await geocodeMissing(kakaoKey, items, cache);
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache));

  // 시·도별로 나누기
  const groups = new Map(SIDO.map((s) => [s.slug, []]));
  const missing = [];
  let unknownSido = 0;
  for (const it of items) {
    const addr = it.LCTN_ROAD_NM_ADDR || it.LCTN_LOTNO_ADDR;
    const sido = findSido(addr);
    if (!sido) { unknownSido++; missing.push(`[시도모름] ${it.RSTRM_NM} | ${addr}`); continue; }
    const pos = cache[cacheKeyOf(it)];
    if (!pos) { missing.push(`[좌표없음] ${it.RSTRM_NM} | ${addr}`); continue; }
    const district = (addr || "").trim().split(/\s+/)[1] || "";
    groups.get(sido.slug).push(toToilet(it, pos, district));
  }

  const index = {
    source: "행정안전부_공중화장실정보 조회서비스",
    generatedAt: new Date().toISOString(),
    total: 0,
    regions: [],
  };
  for (const s of SIDO) {
    const list = groups.get(s.slug);
    if (!list.length) continue;
    const lats = list.map((t) => t.lat), lngs = list.map((t) => t.lng);
    const districts = [...new Set(list.map((t) => t.district).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
    await fs.writeFile(path.join(OUT_DIR, `toilets-${s.slug}.json`), JSON.stringify(list));
    index.regions.push({
      slug: s.slug,
      name: s.name,
      count: list.length,
      districts,
      // 앱이 내 위치가 어느 시·도인지 대략 알 수 있게 범위를 넣어요
      bbox: [Math.min(...lats), Math.min(...lngs), Math.max(...lats), Math.max(...lngs)],
      file: `toilets-${s.slug}.json`,
    });
    index.total += list.length;
  }
  await fs.writeFile(path.join(OUT_DIR, "index.json"), JSON.stringify(index, null, 1));
  await fs.writeFile(path.join(OUT_DIR, "missing.txt"), missing.join("\n") + "\n");

  console.log(`✅ 전국 ${index.total}곳 저장 (${index.regions.length}개 시·도)`);
  for (const r of index.regions) console.log(`   ${r.name}: ${r.count}`);
  console.log(`   좌표 없음/시도 모름: ${missing.length}곳 (missing.txt 참고, 시도 모름 ${unknownSido})`);
}

main().catch((e) => {
  console.error("❌", e.message);
  // GitHub 요약 화면(Annotations)에도 이유가 보이게
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=수집 실패::${String(e.message).replace(/\r?\n/g, " ")}`);
  process.exit(1);
});
