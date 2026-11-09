// 서버 supabase/functions/_shared/postFormat.ts 의 사본(타입만 걷어냄). 원본이 바뀌면 그대로 다시 복사하고
// `node check-postformat.js <메인 저장소>/tests/fixtures/postFormat-vectors.json` 으로 확인한다.
(function (root) {
  "use strict";

  /** Threads 글자 수 상한. 501부터 컨테이너 생성 단계에서 거부된다(M0 실측 2026-11-09). */
  const MAX_CHARS = 500;

  /** Threads가 세는 글자 수 = 유니코드 코드포인트 수(❤=1, ❤️=2, 🇰🇷=2, 👨‍👩‍👧=5, 줄바꿈=1, M0 실측). */
  function countChars(text) {
    return [...text].length;
  }

  // 문장 끝(. ! ? 。 …, 닫는 따옴표·괄호 허용) 뒤 공백에서 나눈다.
  // "U.S.", "e.g."처럼 한 글자 + 점으로 끝나는 약어 뒤에서는 나누지 않는다.
  function sentences(text) {
    const parts = [];
    let start = 0;
    for (const m of text.matchAll(/[.!?。…]["'”’)]?\s+/gu)) {
      const tail = text.slice(Math.max(0, m.index - 2), m.index + 1);
      if (m[0][0] === "." && /(^|[^\p{L}.])[A-Za-z]\.$|\.[A-Za-z]\.$/u.test(tail)) continue;
      const end = m.index + m[0].length;
      parts.push(text.slice(start, end).trim());
      start = end;
    }
    parts.push(text.slice(start).trim());
    return parts.filter(Boolean);
  }

  /** 게시 텍스트의 요약 한 줄 = 요약 첫 문장. */
  function summaryLine(summary) {
    return sentences(summary)[0] ?? "";
  }

  /** 최종 게시 텍스트: 코멘트 → 빈 줄 → 요약 한 줄 → 링크. */
  function formatPost(comment, line, url) {
    return `${comment.trim()}\n\n${line}\n${url}`;
  }

  const api = { MAX_CHARS, countChars, sentences, summaryLine, formatPost };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PostFormat = api;
})(this);
