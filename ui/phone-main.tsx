/** 폰 화면의 시작점(mobile.html). 중계(relay/)를 거쳐 PC 앱이 내준다. 이름이 mobile.tsx 가 아닌 것은 Windows 에서
 *  Mobile.tsx 와 같은 파일이 되어서다.
 *
 *  Tauri 가 없는 브라우저라 대화창 부품이 부르는 `invoke`·`listen` 을 먼저 PC 로 가는 암호 통로로 바꿔 끼운 뒤에 그린다.
 *  짝지은 키는 이 브라우저에만 둔다. iOS 홈 화면 앱은 사파리와 저장소가 따로라 홈 화면에서 처음 열면 한 번 더 짝짓는다. */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Link, pair, socketUrl, type LinkStatus, type Paired } from "./phone-link";
import { installRemote } from "./remote-shim";
import { deviceName, updateAction } from "./phone";
import { Pair, Phone } from "./Mobile";
import "./theme.css";
import "./chat.css";
import "./mobile.css";

// 중계 주소는 방마다 다르다(`/r/<방>/`). 같은 중계에 방이 여럿이어도 짝지은 키가 섞이지 않게 주소로 가른다.
const KEY = `chiispace.paired:${location.pathname}`;
const read = (): Paired | null => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return v && typeof v.dev === "string" && v.jwk && typeof v.pc === "string" ? v : null;
  } catch {
    return null;
  }
};
const write = (p: Paired | null) => {
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify(p));
    else localStorage.removeItem(KEY);
  } catch {
    // 저장소를 못 쓰는 창(사생활 보호 등)이면 이번 창에서만 쓴다.
  }
};

const url = socketUrl(location.href);
let link: Link | null = null;
let ui = { paired: false, status: "connecting" as LinkStatus, stale: false };

// 이 페이지가 도는 판. 구운 묶음에서는 시작 파일(`assets/mobile-<해시>.js`)이고, PC 가 붙을 때 알려 주는 판과 견준다.
const own = (() => {
  try {
    return new URL(import.meta.url).pathname.split("/").pop() ?? null;
  } catch {
    return null;
  }
})();
const TRIED = "chiispace.reloaded-for";
/** PC 가 새로 구워져 판이 바뀌었으면 새로 불러온다. 홈 화면 앱은 뒤로 보냈다 다시 열면 옛 판이 그대로 남아 있다. */
function onVersion(v: string) {
  const draft = document.querySelector<HTMLTextAreaElement>(".composer textarea")?.value.trim() || document.querySelector(".composer-pic");
  let tried: string | null = null;
  try {
    tried = sessionStorage.getItem(TRIED);
  } catch {
    // 저장소를 못 쓰면 한 번 물어 보는 쪽으로 간다.
  }
  const act = updateAction(own, v, !!draft, tried);
  if (act === "reload") {
    try {
      sessionStorage.setItem(TRIED, v.split("/").pop() ?? v);
    } catch {}
    location.reload();
  } else update({ stale: act === "ask" });
}
let setUi: ((s: typeof ui) => void) | null = null;
const update = (patch: Partial<typeof ui>) => {
  ui = { ...ui, ...patch };
  setUi?.(ui);
};

const shim = installRemote((cmd, args) => (link ? link.invoke(cmd, args) : Promise.reject("짝지은 폰이 아니다")));

function begin(p: Paired) {
  link?.stop();
  link = new Link({
    url,
    paired: p,
    onStatus: (status) => update({ status }),
    onEvent: shim.emit,
    onVersion,
    onUnpaired: () => {
      link = null;
      write(null);
      update({ paired: false });
    },
  });
  link.start();
  update({ paired: true, status: "connecting" });
}

const saved = read();
if (saved) begin(saved);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") link?.wake();
});

// iOS 사파리는 화상 키보드가 올라와도 화면 높이를 줄이지 않고 화면을 민다. 보이는 높이를 재서 입력바가 키보드 위에 남게 한다.
const fit = () => {
  const h = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--app-h", `${Math.round(h)}px`);
  if (window.scrollY) window.scrollTo(0, 0);
};
window.visualViewport?.addEventListener("resize", fit);
window.addEventListener("resize", fit);
fit();

function Root() {
  const [s, set] = useState(ui);
  useEffect(() => {
    setUi = set;
    set(ui);
    return () => {
      setUi = null;
    };
  }, []);
  if (!s.paired)
    return (
      <Pair
        connect={async (onSas) => {
          const p = await pair(url, deviceName(navigator.userAgent), onSas);
          write(p);
          begin(p);
        }}
      />
    );
  return (
    <Phone
      status={s.status}
      stale={s.stale}
      onForget={() => {
        link?.stop();
        link = null;
        write(null);
        location.hash = "";
        update({ paired: false });
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(<Root />);
