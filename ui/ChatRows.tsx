/** 대화창의 한 줄 한 줄 — 말풍선·도구 카드·생각·쓰이는 중인 답.
 *
 *  그리기만 한다. 대화 파일을 읽고 무엇을 그릴지 고르는 일은 Chat.tsx 가, 무엇을 보낼지는
 *  Composer.tsx 가 한다. 서브에이전트 대화 보기(SubagentView)도 같은 `Row` 로 그린다. */
import { useContext, useState } from "react";
import { Markdown } from "./Markdown";
import { faceUrl, bySlug } from "./roster";
import { fmtClock, fmtDuration, fmtTokens, resultText, type Item } from "./transcript";
import { shortToolName, toolSummary, toolStats, diffLines } from "./tools";
import { partialInput, type Live } from "./live";
import { OpenSubContext } from "./SubagentView";

function Caret() {
  return (
    <svg className="tool-caret" width="9" height="9" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 접었다 펴는 카드 한 장. 도구 호출과 생각이 같은 모양을 쓴다. */
function Card({
  kind,
  name,
  summary,
  stats,
  bad,
  children,
}: {
  kind: "tool" | "think";
  name: string;
  summary: string;
  stats?: { label: string; bad?: boolean }[];
  bad?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const cls = [kind === "think" ? "think" : "tool", open ? "open" : "", bad ? "bad" : ""].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Caret />
        <span className="tool-name">{name}</span>
        <span className="tool-sum">{summary}</span>
        {!!stats?.length && (
          <span className="tool-stats">
            {stats.map((s, i) => (
              <span key={i} className={s.bad ? "tool-stat bad" : "tool-stat"}>
                {s.label}
              </span>
            ))}
          </span>
        )}
      </button>
      {open && <div className="tool-body">{children}</div>}
    </div>
  );
}

function ToolCard({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const { name, input } = item.toolUse;
  const result = item.pair?.toolResult;
  const bad = result?.is_error === true;
  const diff = diffLines(item.pair?.toolUseResult);
  const text = resultText(result?.content);
  const stats = toolStats(name, item.pair?.toolUseResult);
  return (
    <Card
      kind="tool"
      name={shortToolName(name)}
      summary={toolSummary(name, input)}
      stats={bad ? [...stats, { label: "실패", bad: true }] : stats}
      bad={bad}
    >
      {/* 펼쳤을 때는 줄이지 않은 것을 보여준다. 한 줄로 줄인 것은 접힘용이다. */}
      <div className="tool-label">호출</div>
      <pre>{typeof input === "string" ? input : JSON.stringify(input, null, 2)}</pre>
      {diff.length > 0 && (
        <>
          <div className="tool-label">바뀐 줄</div>
          <div className="diff">
            {diff.map((l, i) => (
              <div key={i} className={l.sign === "+" ? "add" : l.sign === "-" ? "del" : undefined}>
                <span className="n">{l.n ?? ""}</span>
                <span>
                  {l.sign}
                  {l.text}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      {!!text && (
        <>
          <div className="tool-label">결과</div>
          <pre className={bad ? "bad" : undefined}>{text}</pre>
        </>
      )}
      {!text && !diff.length && !result && <div className="tool-label">아직 결과가 없다</div>}
    </Card>
  );
}

function Face({ slug }: { slug?: string }) {
  const url = faceUrl(slug);
  const who = slug ? bySlug.get(slug) : undefined;
  if (!url) return <span className="msg-face" />;
  return (
    <span className="msg-face">
      <img src={url} alt={who?.name ?? ""} draggable={false} />
    </span>
  );
}

export function Row({
  item,
  slug,
  name,
  showFace,
  grouped,
  durMs,
  tokens,
}: {
  item: Item;
  slug?: string;
  name: string;
  showFace: boolean;
  grouped: boolean;
  durMs?: number;
  tokens?: number;
}) {
  const openSub = useContext(OpenSubContext);
  switch (item.kind) {
    case "bubble": {
      const mine = item.role === "user";
      const clock = fmtClock(item.ts);
      return (
        <div className={`msg${mine ? " mine" : ""}${grouped ? " grouped" : ""}`}>
          {!mine && (showFace ? <Face slug={slug} /> : <span className="msg-face" />)}
          <div className="msg-col">
            {!mine && showFace && <span className="msg-who">{name}</span>}
            {mine && item.queued && <span className="msg-tag">예약 · 아직 안 들어감</span>}
            <div className="msg-row">
              <div className={`bubble${item.queued ? " queued" : ""}`}>
                {item.images?.map((src, i) => <img key={i} className="msg-img" src={src} alt="" />)}
                {/* 내가 친 말은 그대로 보인다 — 마크다운으로 해석하면 쓴 것과 달라진다. */}
                {item.text && (mine ? <span style={{ whiteSpace: "pre-wrap" }}>{item.text}</span> : <Markdown text={item.text} />)}
              </div>
              {clock && <span className="msg-clock">{clock}</span>}
            </div>
            {(durMs != null || tokens != null) && (
              <div className="msg-foot">
                {durMs != null && <span>{fmtDuration(durMs)}</span>}
                {tokens != null && <span>↓ {fmtTokens(tokens)}</span>}
              </div>
            )}
          </div>
        </div>
      );
    }
    case "tool":
      return <ToolCard item={item} />;
    case "thinking":
      return (
        <Card kind="think" name="생각" summary={item.text.slice(0, 90).replace(/\s+/g, " ")}>
          <Markdown text={item.text} />
        </Card>
      );
    case "launch": {
      const text = `${item.description ?? "서브에이전트"} 부름${item.agentType ? ` · ${item.agentType}` : ""}`;
      // 누르면 그 서브에이전트의 대화 전체를 연다. 어느 것인지는 부른 호출 id 로 찾는다(meta.json).
      return item.id && openSub ? (
        <button className="note launch" onClick={() => openSub({ toolUseId: item.id, label: item.description ?? "서브에이전트" })} title="서브에이전트 대화 보기">
          {text}
        </button>
      ) : (
        <div className="note">{text}</div>
      );
    }
    case "qa":
      return (
        <div className="qa">
          {item.qa.map((p, i) => (
            <div className="pair" key={i}>
              <div className="q">{p.q}</div>
              <div className="a">{p.a}</div>
            </div>
          ))}
        </div>
      );
    case "command":
      return (
        <div className="cmd">
          <span>
            {item.name}
            {item.args ? ` ${item.args}` : ""}
          </span>
        </div>
      );
    case "local-command":
      return (
        <Card kind="tool" name="출력" summary={item.stdout.slice(0, 90).replace(/\s+/g, " ")}>
          <pre>{item.stdout}</pre>
        </Card>
      );
    case "system":
      return (
        <Card kind="tool" name="시스템" summary={item.text.split("\n")[0].slice(0, 90)}>
          <pre>{item.text}</pre>
        </Card>
      );
    case "interrupted":
      return <div className="note mid">여기서 중단했다</div>;
    // 답을 기다리는 질문("ask")은 통로가 카드로 준다(ClaudeStreamPane). 대화 파일 쪽 것은 그리지 않는다.
    default:
      return null;
  }
}

/** 쓰이는 중인 답. 대화 파일에 적히기 전이라 여기서만 보인다. */
export function LiveRows({ live, slug, name, showFace }: { live: Live; slug?: string; name: string; showFace: boolean }) {
  const blocks = live.blocks.filter(Boolean);
  const firstText = blocks.findIndex((b) => b.kind === "text");
  const head = (i: number) => showFace && i === firstText;
  const rows = blocks.map((b, i) => {
    if (b.kind === "thinking") {
      const tail = b.text.slice(-90).replace(/\s+/g, " ");
      return (
        <div className="think live" key={i}>
          <div className="tool-head">
            <span className="tool-name">생각{live.done ? "" : " 중"}</span>
            <span className="tool-sum">{tail}</span>
          </div>
        </div>
      );
    }
    if (b.kind === "tool") {
      return (
        <div className="tool live" key={i}>
          <div className="tool-head">
            <Caret />
            <span className="tool-name">{shortToolName(b.name)}</span>
            <span className="tool-sum">{toolSummary(b.name, partialInput(b.json))}</span>
            {!live.done && <span className="tool-stat">채우는 중</span>}
          </div>
        </div>
      );
    }
    return (
      <div className="msg live" key={i}>
        {head(i) ? <Face slug={slug} /> : <span className="msg-face" />}
        <div className="msg-col">
          {head(i) && <span className="msg-who">{name}</span>}
          <div className="msg-row">
            <div className={`bubble${live.done ? "" : " writing"}`}>
              <Markdown text={b.text || " "} />
            </div>
          </div>
        </div>
      </div>
    );
  });
  const waiting = !live.done && !blocks.some((b) => b.kind === "text" || b.kind === "tool");
  return (
    <>
      {rows}
      {/* 아직 글이 한 자도 안 왔을 때. 말풍선이 없으면 보낸 말이 허공에 뜬 것처럼 보인다. */}
      {waiting && (
        <div className="msg live">
          {showFace && firstText < 0 ? <Face slug={slug} /> : <span className="msg-face" />}
          <div className="msg-col">
            <div className="bubble typing" aria-label="쓰는 중">
              <i />
              <i />
              <i />
            </div>
          </div>
        </div>
      )}
      {live.error && <div className="note bad">{live.error}</div>}
    </>
  );
}
