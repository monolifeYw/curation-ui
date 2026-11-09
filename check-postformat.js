// postFormat.js 사본이 서버 원본과 같은 결과를 내는지 공용 벡터로 확인한다.
// 사용: node check-postformat.js <메인 저장소>/tests/fixtures/postFormat-vectors.json
"use strict";
const fs = require("fs");
const PF = require("./postFormat.js");

if (!process.argv[2]) {
  console.error("벡터 JSON 경로가 필요해요: node check-postformat.js <경로>/postFormat-vectors.json");
  process.exit(2);
}
const v = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));

const results = [];
const check = (group, name, ok, detail) => results.push({ group, name, ok, detail });

check("maxChars", "MAX_CHARS", PF.MAX_CHARS === v.maxChars, PF.MAX_CHARS + " vs " + v.maxChars);
for (const c of v.counts) {
  const n = PF.countChars(c.text);
  check("counts", c.name, n === c.length, n + " vs " + c.length);
}
for (const c of v.limits) {
  const text = c.parts.map(([s, k]) => s.repeat(k)).join("");
  const n = PF.countChars(text);
  const ok = n <= PF.MAX_CHARS;
  check("limits", c.name, n === c.length && ok === c.ok, n + "/" + ok + " vs " + c.length + "/" + c.ok);
}
for (const c of v.format) {
  const got = PF.formatPost(c.comment, c.summaryLine, c.url);
  check("format", c.name, got === c.text, JSON.stringify(got));
}
for (const c of v.summaryLine) {
  const got = PF.summaryLine(c.summary);
  check("summaryLine", c.name, got === c.line, JSON.stringify(got) + " vs " + JSON.stringify(c.line));
}

for (const r of results) console.log((r.ok ? "ok   " : "FAIL ") + r.group + " · " + r.name + (r.ok ? "" : " — " + r.detail));
const fail = results.filter((r) => !r.ok).length;
console.log(results.length - fail + "/" + results.length + " 통과");
process.exit(fail ? 1 : 0);
