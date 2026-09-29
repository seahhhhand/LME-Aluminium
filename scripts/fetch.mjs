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
    return { rows: d.rows ?? [], fx: d.fx ?? [], updatedAt: d.updatedAt ?? null };
  } catch {
    return { rows: [], fx: [], updatedAt: null };
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
    .map(([date, v]) => [date, v.KRW]);
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
      if (typeof j?.usd?.krw === "number" && j.date) return [j.date, Math.round(j.usd.krw * 100) / 100];
      throw new Error("형식이 다름");
    } catch (e) { last = e; }
  }
  throw last;
}

const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const FX_BACKFILL_CHUNKS_PER_RUN = 30; // 한 번에 너무 많이 요청하지 않도록 나눠서 채움

// 1) 최근 환율을 먼저 받고  2) 과거는 한 번에 일부씩 거슬러 올라가며 채움.
// 어느 단계에서 실패해도 그때까지 받은 값은 저장됨.
async function updateFx(existingFx) {
  const merged = new Map(existingFx.map((r) => [r[0], r]));
  const errors = [];
  const today = new Date();

  let start = existingFx.length ? addDays(new Date(existingFx.at(-1)[0] + "T00:00:00Z"), -10) : addDays(today, -85);
  try {
    while (start <= today) {
      const end = addDays(start, 85) > today ? today : addDays(start, 85);
      for (const r of await fetchFxRange(isoDay(start), isoDay(end))) merged.set(r[0], r);
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
      for (const r of await fetchFxRange(isoDay(st), isoDay(end))) merged.set(r[0], r);
    } catch (e) {
      errors.push(`과거 환율 채우기 중단(${e.message}), 다음 실행 때 이어서 받음`);
      break;
    }
    earliest = st;
    await sleep(300);
  }

  const fx = [...merged.values()].sort((a, b) => a[0].localeCompare(b[0]));
  return { fx, errors };
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
  const { rows: existing, fx: existingFx, updatedAt: prevUpdatedAt } = await readExisting();
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
  const { fx, errors: fxErrors } = await updateFx(existingFx);
  console.log(`환율: ${fx.length}일` + (fx.length ? ` (${fx[0][0]} ~ ${fx.at(-1)[0]}, 최신 ${fx.at(-1)[1]}원)` : ""));
  for (const m of fxErrors) console.warn(m);
  const fxStatus = { fxOk: fxErrors.length === 0, fxMessage: fxErrors.join(" / ") || undefined, fxLatest: fx.at(-1)?.[0] };

  if (JSON.stringify(existing) === JSON.stringify(rows) && JSON.stringify(existingFx) === JSON.stringify(fx)) {
    console.log(`변경 없음 (최신 ${rows.at(-1)[0]})`);
    return { changed: false, updatedAt: prevUpdatedAt, latest: rows.at(-1)[0], ...fxStatus };
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "Westmetall (LME Aluminium Cash-Settlement, 3-month, stock), Frankfurter/ECB (USD/KRW)",
    columns: ["date", "cash", "threeMonth", "stock"],
    rows,
    fxColumns: ["date", "usdkrw"],
    fx,
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
      fxOk: r.fxOk, fxMessage: r.fxMessage, fxLatest: r.fxLatest });
  } catch (e) {
    console.error(e.message);
    const prev = await readStatus();
    await writeStatus({ ...prev, checkedAt, ok: false, changed: false, message: e.message });
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();
