// 실행: node --test tests/parse.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { parseHtml, parseDate } from "../scripts/fetch.mjs";

const SAMPLE = `<h2>2026</h2><table>
<tr><th>date</th><th>LME Aluminium Cash-Settlement</th><th>LME Aluminium 3-month</th><th>LME Aluminium stock</th></tr>
<tr><td>28. September 2026</td><td>2,612.50</td><td>2,640.00</td><td>512,300</td></tr>
<tr><td>25. September 2026</td><td>2,598.00</td><td>2,631.50</td><td>515,125</td></tr>
<tr class="x"><td><b>24. September 2026</b></td><td>2,601.00</td><td>2,629.00</td><td>&nbsp;-</td></tr>
</table><table><tr><td>31. December 2025</td><td>2,480.00</td><td>2,510.00</td><td>600,000</td></tr>
<tr><td>average</td><td>1</td><td>1</td><td>1</td></tr></table>`;

test("parse", () => {
  const rows = parseHtml(SAMPLE);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], ["2025-12-31", 2480, 2510, 600000]);
  assert.deepEqual(rows.at(-1), ["2026-09-28", 2612.5, 2640, 512300]);
  assert.equal(rows[1][3], null);
});
test("dates", () => {
  assert.equal(parseDate("1. March 2026"), "2026-03-01");
  assert.equal(parseDate("01.03.2026"), "2026-03-01");
  assert.equal(parseDate("date"), null);
});
