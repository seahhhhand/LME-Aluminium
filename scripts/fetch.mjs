// Westmetall에서 LME 알루미늄 Cash / 3-month / 재고를 받아 data/lme.js, data/lme.json에 저장합니다.
// GitHub Actions가 매일 자동으로 실행합니다. 외부 패키지 없이 Node 20+만 있으면 됩니다.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SOURCE_URL = "https://www.westmetall.com/en/markdaten.php?action=table&field=LME_Al_cash";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
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
    const txt = await readFile(path.join(DATA_DIR, "lme.json"), "utf8");
    return JSON.parse(txt).rows ?? [];
  } catch {
    return [];
  }
}

export async function main() {
  const res = await fetch(SOURCE_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept-Language": "en",
    },
  });
  if (!res.ok) throw new Error(`원본 사이트 응답 오류: HTTP ${res.status}`);
  const fresh = parseHtml(await res.text());
  if (fresh.length < 50) throw new Error(`가격 표를 찾지 못했습니다(${fresh.length}행). 원본 사이트 구조가 바뀌었을 수 있습니다.`);

  // 기존 데이터와 합치기: 원본에 있는 값이 우선
  const merged = new Map((await readExisting()).map((r) => [r[0], r]));
  for (const r of fresh) merged.set(r[0], r);
  const rows = [...merged.values()].sort((a, b) => a[0].localeCompare(b[0]));

  const before = JSON.stringify(await readExisting());
  if (before === JSON.stringify(rows)) {
    console.log(`변경 없음 (최신 ${rows.at(-1)[0]})`);
    return;
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "Westmetall (LME Aluminium Cash-Settlement, 3-month, stock)",
    columns: ["date", "cash", "threeMonth", "stock"],
    rows,
  };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path.join(DATA_DIR, "lme.json"), JSON.stringify(payload));
  // file:// 로 열어도 동작하도록 스크립트 형태로도 저장
  await writeFile(path.join(DATA_DIR, "lme.js"), `window.LME_DATA=${JSON.stringify(payload)};\n`);
  console.log(`업데이트 완료: ${rows.length}행, 최신 ${rows.at(-1)[0]}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
