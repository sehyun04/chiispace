/** 말풍선 안의 마크다운.
 *
 *  라이브러리를 들이지 않는다. claude 답변에 실제로 흔한 것 — 표 · 코드 ·
 *  굵게 · 헤딩 · 목록 · 인용 — 만 그리면 되고, 그 이상은 말풍선에서 오히려
 *  읽기를 방해한다. kasaterm 의 아로나 모드에서 옮겨 왔다.
 *
 *  **굵게(`**`)를 이탤릭(`*`)보다 먼저 봐야 한다.** 순서를 바꾸면 `**`의 앞
 *  별 하나를 이탤릭이 먼저 먹어 굵은 글이 통째로 어긋난다.
 *
 *  **단어 안의 밑줄은 강조가 아니다**(GFM 규칙). `agent_pid_for_shell` 같은
 *  이름이 답변에 늘 나오는데, 이걸 강조로 치면 밑줄이 사라지고 가운데가 기울어
 *  전혀 다른 이름으로 읽힌다. */
import { Fragment, useState, type ReactNode } from "react";

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|~~([^~]+)~~|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\n]+)\*|(?<![\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_]))/gu;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] != null) out.push(<strong key={`${keyBase}-b${i}`}>{m[2]}</strong>);
    else if (m[3] != null) out.push(<code key={`${keyBase}-c${i}`} className="md-code">{m[3]}</code>);
    else if (m[4] != null) out.push(<del key={`${keyBase}-s${i}`}>{m[4]}</del>);
    else if (m[5] != null)
      out.push(
        <a key={`${keyBase}-l${i}`} className="md-link" href={m[6]} target="_blank" rel="noreferrer">
          {m[5]}
        </a>,
      );
    else if (m[7] != null) out.push(<em key={`${keyBase}-i${i}`}>{m[7]}</em>);
    else if (m[8] != null) out.push(<em key={`${keyBase}-u${i}`}>{m[8]}</em>);
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isTableSep = (l: string) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes("-");
const cells = (l: string) =>
  l
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());

/** 코드 덩이. 길면 접어 둔다 — 답변 하나에 수백 줄짜리가 섞여 오면 그 아래
 *  말이 화면 밖으로 밀려난다. */
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const lines = code.split("\n");
  const long = lines.length > 18;
  const [open, setOpen] = useState(!long);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="md-pre">
      <div className="md-pre-bar">
        {long ? (
          <button className="md-pre-btn" onClick={() => setOpen((o) => !o)}>
            {open ? "접기" : `${lines.length}줄 펼치기`}
          </button>
        ) : (
          <span className="md-pre-lang">{lang ?? ""}</span>
        )}
        <button className="md-pre-btn" onClick={copy}>
          {copied ? "복사됨" : "복사"}
        </button>
      </div>
      <pre>{open ? code : lines.slice(0, 6).join("\n")}</pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, "").trim().split(/\s+/)[0] || undefined;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(<CodeBlock key={key++} code={buf.join("\n")} lang={lang} />);
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(cells(lines[i]));
        i++;
      }
      blocks.push(
        <div className="md-table" key={key++}>
          <table>
            <thead>
              <tr>
                {header.map((h, hi) => (
                  <th key={hi}>{inline(h, `th${key}-${hi}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {header.map((_, ci) => (
                    <td key={ci}>{inline(r[ci] ?? "", `td${key}-${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      blocks.push(
        <div className="md-h" key={key++} style={{ fontSize: [16, 15, 14, 13][h[1].length - 1] }}>
          {inline(h[2], `h${key}`)}
        </div>,
      );
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const its: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        its.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul className="md-list" key={key++}>
          {its.map((it, ii) => (
            <li key={ii}>{inline(it, `li${key}-${ii}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const its: string[] = [];
      // 첫 번호를 보존한다. 중간부터 이어지는 목록이 1 로 되돌아가면 안 된다.
      const start = parseInt(line.match(/^\s*(\d+)\./)?.[1] ?? "1", 10);
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        its.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol className="md-list" key={key++} start={start}>
          {its.map((it, ii) => (
            <li key={ii}>{inline(it, `ol${key}-${ii}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const its: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        its.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote className="md-quote" key={key++}>
          {inline(its.join("\n"), `bq${key}`)}
        </blockquote>,
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <div className="md-p" key={key++}>
        {inline(para.join("\n"), `p${key}`)}
      </div>,
    );
  }

  return <Fragment>{blocks}</Fragment>;
}
