// Westmetall에서 LME 알루미늄 Cash / 3-month / 재고를 받아 data/lme.js, data/lme.json에 저장합니다.
// GitHub Actions가 매일 자동으로 실행합니다. 외부 패키지 없이 Node 20+만 있으면 됩니다.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SOURCE_URL = "https://www.westmetall.com/en/markdaten.php?action=table&field=LME_Al_cash";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const START_YEAR = 2008; // 원본에 데이터가 있는 첫 해
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

const pad = (n) => String(n).padStart(2, "0");

function cleanCell(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseDate(text) {
  const t = text.trim().toLowerCase();
  let m = t.match(/^(\d{1,2})\.\s*([a-z]+)\s+(\d{4})$/);
  if (m && MONTHS.includes(m[2])) return `${m[3]}-${pad(MONTHS.indexOf(m[2]) + 1)}-${pad(m[1])}`;
  m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return null;
}

export function parseNumber(text) {
  const t = text.replace(/[,\s]/g, "");
  if (!t || t === "-" || t === "–") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// 반환: [["YYYY-MM-DD", cash, threeMonth, stock], ...] 날짜 오름차순
export function parseHtml(html) {
  const byDate = new Map();
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => cleanCell(m[1]));
    if (cells.length < 4) continue;
    const date = parseDate(cells[0]);
    if (!date || byDate.has(date)) continue;
    const vals = cells.slice(1, 4).map(parseNumber);
    if (vals.every((v) => v === null)) continue;
    byDate.set(date, [date, ...vals]);
  }
  return [...byDate.values()].sort((a, b) => a[0].localeCompare(b[0]));
}

async function readExisting() {
  try {
    const d = JSON.parse(await readFile(path.join(DATA_DIR, "lme.json"), "utf8"));
    const fx = (d.fx ?? []).map((r) => [r[0], r[1], r[2] ?? "E"]);
    return { rows: d.rows ?? [], fx, updatedAt: d.updatedAt ?? null, eximCursor: d.eximCursor ?? null };
  } catch {
    return { rows: [], fx: [], updatedAt: null, eximCursor: null };
  }
}

// ---------- 환율 (USD/KRW, 유럽중앙은행 기준환율, Frankfurter API) ----------
const FX_API = "https://api.frankfurter.dev/v1";
const isoDay = (d) => d.toISOString().slice(0, 10);

async function fetchFxRange(start, end) {
  // 90일 이하 구간은 일별 값을 모두 돌려주므로 구간을 나눠 요청
  const url = `${FX_API}/${start}..${end}?base=USD&symbols=KRW`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`환율 응답 오류: HTTP ${res.status}`);
  const data = await res.json();
  return Object.entries(data.rates ?? {})
    .filter(([, v]) => typeof v?.KRW === "number")
    .map(([date, v]) => [date, v.KRW, "E"]);
}

// 예비 출처: Frankfurter가 안 될 때 최신 1일치만 받음
const FX_FALLBACK = [
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
  "https://latest.currency-api.pages.dev/v1/currencies/usd.json",
];
async function fetchFxLatestFallback() {
  let last;
  for (const url of FX_FALLBACK) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (typeof j?.usd?.krw === "number" && j.date) return [j.date, Math.round(j.usd.krw * 100) / 100, "F"];
      throw new Error("형식이 다름");
    } catch (e) { last = e; }
  }
  throw last;
}

const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const FX_BACKFILL_CHUNKS_PER_RUN = 30; // 한 번에 너무 많이 요청하지 않도록 나눠서 채움

// 1) 최근 환율을 먼저 받고  2) 과거는 한 번에 일부씩 거슬러 올라가며 채움.
// 어느 단계에서 실패해도 그때까지 받은 값은 저장됨.
// 수출입은행(K) 값은 ECB(E)나 예비 출처(F)로 덮어쓰지 않음
function putFx(map, r) {
  const old = map.get(r[0]);
  if (old && old[2] === "K" && r[2] !== "K") return;
  map.set(r[0], r);
}

async function updateFx(existingFx) {
  const merged = new Map(existingFx.map((r) => [r[0], r]));
  const errors = [];
  const today = new Date();

  let start = existingFx.length ? addDays(new Date(existingFx.at(-1)[0] + "T00:00:00Z"), -10) : addDays(today, -85);
  try {
    while (start <= today) {
      const end = addDays(start, 85) > today ? today : addDays(start, 85);
      for (const r of await fetchFxRange(isoDay(start), isoDay(end))) putFx(merged, r);
      start = addDays(end, 1);
      await sleep(300);
    }
  } catch (e) {
    errors.push(`최근 환율 실패(${e.message})`);
    try {
      const r = await fetchFxLatestFallback();
      if (!merged.has(r[0])) merged.set(r[0], r);
      console.log(`예비 출처로 최신 환율 사용: ${r[0]} ${r[1]}원`);
    } catch (e2) {
      errors.push(`예비 출처도 실패(${e2.message})`);
    }
  }

  const floor = new Date(Date.UTC(START_YEAR, 0, 1));
  const dates = [...merged.keys()].sort();
  let earliest = dates.length ? new Date(dates[0] + "T00:00:00Z") : null;
  for (let n = 0; earliest && earliest > addDays(floor, 4) && n < FX_BACKFILL_CHUNKS_PER_RUN; n++) {
    const end = addDays(earliest, -1);
    const st = addDays(end, -85) < floor ? floor : addDays(end, -85);
    try {
      for (const r of await fetchFxRange(isoDay(st), isoDay(end))) putFx(merged, r);
    } catch (e) {
      errors.push(`과거 환율 채우기 중단(${e.message}), 다음 실행 때 이어서 받음`);
      break;
    }
    earliest = st;
    await sleep(300);
  }

  return { merged, errors };
}

// ---------- 한국수출입은행 매매기준율 (인증키가 있을 때만) ----------
// 하루 1,000회 제한이 있어 한 번 실행에 최대 EXIM_BACKFILL_PER_RUN일씩만 과거를 채움
const EXIM_URL = "https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON";
const EXIM_BACKFILL_PER_RUN = 10;
const ymd = (iso) => iso.replaceAll("-", "");
const isWeekend = (iso) => { const g = new Date(iso + "T00:00:00Z").getUTCDay(); return g === 0 || g === 6; };
const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000); // UTC 기준 Date를 한국시간 값으로 이동

class EximStop extends Error {}

async function fetchExim(key, iso) {
  let res;
  try {
    res = await fetch(`${EXIM_URL}?authkey=${encodeURIComponent(key)}&searchdate=${ymd(iso)}&data=AP01`, {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: "application/json" },
    });
  } catch (e) {
    throw new EximStop(`접속 실패(${e.name === "TimeoutError" ? "시간 초과, 해외 접속 차단 가능성" : e.message})`);
  }
  if (!res.ok) throw new EximStop(`응답 오류 HTTP ${res.status}`);
  let list;
  try { list = await res.json(); } catch { throw new EximStop("응답 형식이 JSON이 아님"); }
  if (!Array.isArray(list) || list.length === 0) return null; // 주말·공휴일·발표 전
  const code = list[0]?.result;
  if (code === 3) throw new EximStop("인증키 오류");
  if (code === 4) throw new EximStop("일일 요청 한도 초과");
  if (code === 2) throw new EximStop("요청 형식 오류");
  const usd = list.find((x) => x.cur_unit === "USD");
  const v = usd && Number(String(usd.deal_bas_r).replace(/,/g, ""));
  return Number.isFinite(v) && v > 0 ? [iso, v, "K"] : null;
}

async function updateExim(merged, cursor) {
  const key = process.env.KOREAEXIM_API_KEY?.trim();
  if (!key) return { cursor, message: "인증키 없음(ECB 환율 사용)", used: false };
  const now = kstNow();
  const todayIso = now.toISOString().slice(0, 10);
  const afterPublish = now.getUTCHours() >= 11; // 수출입은행은 영업일 오전 11시 전후 발표
  let calls = 0;
  try {
    // 1) 최근: 마지막 수출입은행 값 다음날부터 오늘까지
    const kDates = [...merged.values()].filter((r) => r[2] === "K").map((r) => r[0]).sort();
    let d = kDates.length ? isoDay(addDays(new Date(kDates.at(-1) + "T00:00:00Z"), 1)) : isoDay(addDays(new Date(todayIso + "T00:00:00Z"), -7));
    while (d <= todayIso) {
      if (!isWeekend(d) && (d < todayIso || afterPublish)) {
        const r = await fetchExim(key, d); calls++;
        if (r) merged.set(r[0], r);
        await sleep(200);
      }
      d = isoDay(addDays(new Date(d + "T00:00:00Z"), 1));
    }
    // 2) 과거: 커서에서 거꾸로 조금씩
    const floorIso = `${START_YEAR}-01-01`;
    let c = cursor ?? (kDates[0] ?? todayIso);
    let n = 0;
    while (n < EXIM_BACKFILL_PER_RUN && c > floorIso) {
      c = isoDay(addDays(new Date(c + "T00:00:00Z"), -1));
      if (isWeekend(c) || merged.get(c)?.[2] === "K") continue;
      const r = await fetchExim(key, c); calls++; n++;
      if (r) merged.set(r[0], r);
      await sleep(200);
    }
    return { cursor: c, message: c > floorIso ? `과거 매매기준율 채우는 중(${c}까지)` : undefined, used: true, calls };
  } catch (e) {
    if (e instanceof EximStop) return { cursor, message: e.message, used: calls > 0, failed: true, calls };
    throw e;
  }
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept-Language": "en",
    },
  });
  if (!res.ok) throw new Error(`원본 사이트 응답 오류: HTTP ${res.status} (${url})`);
  return parseHtml(await res.text());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function main() {
  const { rows: existing, fx: existingFx, updatedAt: prevUpdatedAt, eximCursor } = await readExisting();
  const merged = new Map(existing.map((r) => [r[0], r]));
  const now = new Date();
  const thisYear = now.getUTCFullYear();

  // 1) 올해 데이터 (매일)
  const fresh = await fetchPage(SOURCE_URL);
  if (fresh.length === 0) throw new Error("가격 표를 찾지 못했습니다. 원본 사이트 구조가 바뀌었을 수 있습니다.");
  for (const r of fresh) merged.set(r[0], r);

  // 2) 과거 연도: 아직 없는 연도만 한 번 받아 채움. 1월에는 작년 연말 값 보정을 위해 작년도 다시 받음
  const haveYears = new Set(existing.map((r) => Number(r[0].slice(0, 4))));
  const targets = [];
  for (let y = START_YEAR; y < thisYear; y++) if (!haveYears.has(y)) targets.push(y);
  if (now.getUTCMonth() === 0 && !targets.includes(thisYear - 1)) targets.push(thisYear - 1);
  for (const y of targets) {
    try {
      const rows = (await fetchPage(`${SOURCE_URL}&year=${y}`)).filter((r) => r[0].startsWith(String(y)));
      for (const r of rows) merged.set(r[0], r);
      console.log(`${y}년: ${rows.length}행`);
    } catch (e) {
      console.warn(`${y}년 받기 실패, 다음 실행 때 다시 시도: ${e.message}`);
    }
    await sleep(800);
  }

  const rows = [...merged.values()].sort((a, b) => a[0].localeCompare(b[0]));

  // 3) 환율: 실패해도 알루미늄 데이터 저장은 계속 진행
  const { merged: fxMap, errors: fxErrors } = await updateFx(existingFx);
  const exim = await updateExim(fxMap, eximCursor);
  console.log(`수출입은행: ${exim.message ?? "정상"}${exim.calls ? ` (요청 ${exim.calls}회)` : ""}`);
  const fx = [...fxMap.values()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`환율: ${fx.length}일` + (fx.length ? ` (${fx[0][0]} ~ ${fx.at(-1)[0]}, 최신 ${fx.at(-1)[1]}원)` : ""));
  for (const m of fxErrors) console.warn(m);
  const fxStatus = {
    fxOk: fxErrors.length === 0 || fx.some((r) => r[2] === "K"),
    fxMessage: fxErrors.join(" / ") || undefined,
    fxLatest: fx.at(-1)?.[0],
    fxSource: fx.at(-1)?.[2],
    eximOk: exim.failed ? false : exim.used ? true : undefined,
    eximMessage: exim.message,
  };

  if (JSON.stringify(existing) === JSON.stringify(rows) && JSON.stringify(existingFx) === JSON.stringify(fx) && exim.cursor === eximCursor) {
    console.log(`변경 없음 (최신 ${rows.at(-1)[0]})`);
    return { changed: false, updatedAt: prevUpdatedAt, latest: rows.at(-1)[0], ...fxStatus };
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "Westmetall (LME Aluminium Cash-Settlement, 3-month, stock), Frankfurter/ECB (USD/KRW)",
    columns: ["date", "cash", "threeMonth", "stock"],
    rows,
    fxColumns: ["date", "usdkrw", "source"], // source: K=수출입은행 매매기준율, E=ECB 기준환율, F=예비 출처
    fx,
    eximCursor: exim.cursor,
  };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path.join(DATA_DIR, "lme.json"), JSON.stringify(payload));
  // file:// 로 열어도 동작하도록 스크립트 형태로도 저장
  await writeFile(path.join(DATA_DIR, "lme.js"), `window.LME_DATA=${JSON.stringify(payload)};\n`);
  console.log(`업데이트 완료: ${rows.length}행, ${rows[0][0]} ~ ${rows.at(-1)[0]}`);
  return { changed: true, updatedAt: payload.updatedAt, latest: rows.at(-1)[0], ...fxStatus };
}

// 매 실행마다 "마지막 확인" 기록. 작은 파일이라 30분마다 저장해도 저장소가 커지지 않음
async function writeStatus(status) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path.join(DATA_DIR, "status.json"), JSON.stringify(status));
  await writeFile(path.join(DATA_DIR, "status.js"), `window.LME_STATUS=${JSON.stringify(status)};\n`);
}

async function readStatus() {
  try { return JSON.parse(await readFile(path.join(DATA_DIR, "status.json"), "utf8")); } catch { return {}; }
}

export async function run() {
  const checkedAt = new Date().toISOString();
  try {
    const r = await main();
    await writeStatus({ checkedAt, ok: true, changed: r.changed, dataUpdatedAt: r.updatedAt, latest: r.latest,
      fxOk: r.fxOk, fxMessage: r.fxMessage, fxLatest: r.fxLatest, fxSource: r.fxSource,
      eximOk: r.eximOk, eximMessage: r.eximMessage });
  } catch (e) {
    console.error(e.message);
    const prev = await readStatus();
    await writeStatus({ ...prev, checkedAt, ok: false, changed: false, message: e.message });
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();
