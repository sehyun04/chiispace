import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// 말풍선 부품은 JSX 라 node 가 바로 못 읽는다. React 까지 한 덩이로 묶어 그 자리에서 글로 그려 본다.
const ui = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
const out = await build({
  stdin: {
    contents: `import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Markdown, Linkify } from "./Markdown";
export const md = (text) => renderToStaticMarkup(createElement(Markdown, { text }));
export const plain = (text) => renderToStaticMarkup(createElement(Linkify, { text }));`,
    resolveDir: ui,
    loader: "tsx",
  },
  bundle: true,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  write: false,
  logLevel: "silent",
});
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chiispace-md-")), "md.cjs");
fs.writeFileSync(file, out.outputFiles[0].text);
const { md, plain } = createRequire(import.meta.url)(file);

const links = (html) => [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]);

test("맨 주소도 누르면 새 창으로 열린다", () => {
  const html = md("레포를 공개로 바꿨습니다: https://github.com/sehyun04/chiiOS");
  assert.deepEqual(links(html), [["https://github.com/sehyun04/chiiOS", "https://github.com/sehyun04/chiiOS"]]);
  assert.match(html, /target="_blank"/);
});

test("주소 뒤의 마침표·한글·괄호는 주소에 안 붙는다", () => {
  assert.deepEqual(links(md("여기 https://a.example/x.")), [["https://a.example/x", "https://a.example/x"]]);
  assert.deepEqual(links(md("https://a.example/chiiOS입니다")), [["https://a.example/chiiOS", "https://a.example/chiiOS"]]);
  assert.deepEqual(links(md("(https://a.example/p?q=1&r=2)")), [["https://a.example/p?q=1&amp;r=2", "https://a.example/p?q=1&amp;r=2"]]);
  assert.match(md("여기 https://a.example/x."), /<\/a>\.<\/div>/);
});

test("마크다운 링크·굵게 안 주소·코드 안 주소", () => {
  assert.deepEqual(links(md("[치이스페](https://github.com/sehyun04/chiispace) 봐")), [["https://github.com/sehyun04/chiispace", "치이스페"]]);
  assert.deepEqual(links(md("**https://a.example/b**")), [["https://a.example/b", "https://a.example/b"]]);
  // 코드로 감싼 주소는 글자 그대로 둔다 — 복사해 쓰려고 감싼 것이다.
  assert.deepEqual(links(md("`https://a.example/c`")), []);
  // 주소 속 밑줄은 기울임이 아니다.
  assert.deepEqual(links(md("https://a.example/foo_bar_baz")), [["https://a.example/foo_bar_baz", "https://a.example/foo_bar_baz"]]);
});

test("내가 친 말은 주소만 링크가 되고 마크다운은 그대로다", () => {
  const html = plain("**이거** 봐 https://a.example/d, 고마워");
  assert.deepEqual(links(html), [["https://a.example/d", "https://a.example/d"]]);
  assert.match(html, /^\*\*이거\*\* 봐 <a /);
  assert.match(html, /<\/a>, 고마워$/);
});
