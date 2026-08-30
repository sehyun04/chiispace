import roster from "./roster.json";
import { Term } from "./Term";

type Member = {
  name: string;
  slug: string;
  school: string;
  header_color: string;
};

const leader = roster.leader as Member;
const members = roster.members as Member[];

export default function App() {
  return (
    <div className="app">
      <aside className="side">
        <div className="side-head">
          <span>kasaspace</span>
          <span className="cheeks">
            <i />
            <i />
          </span>
        </div>

        <div className="side-section">폴더</div>
        <div className="tree">
          <div className="empty">
            아직 연 폴더가 없어
            <br />
            (파일트리는 다음 차례)
          </div>
        </div>

        <div className="side-section">{roster.label} · {roster.user_title}</div>
        <div className="roster">
          <Row m={leader} lead />
          {members.map((m) => (
            <Row key={m.slug} m={m} />
          ))}
        </div>
      </aside>

      <main className="stage">
        <section className="pane">
          <header className="pane-head">
            <span className="pip" />
            <span className="title">shell</span>
          </header>
          <Term id="%0" />
        </section>
      </main>
    </div>
  );
}

function Row({ m, lead }: { m: Member; lead?: boolean }) {
  return (
    <div className={lead ? "member lead" : "member"}>
      <span className="pip" style={{ background: m.header_color }} />
      <span className="who">{m.name}</span>
      <span className="school">{m.school}</span>
    </div>
  );
}
