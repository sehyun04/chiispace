/** 폰 화면의 시작점(mobile.html). PC 앱의 폰 서버(remote.rs)가 내준다. 이름이 mobile.tsx 가 아닌 것은 Windows 에서 Mobile.tsx 와 같은 파일이 되어서다.
 *
 *  Tauri 가 없는 브라우저라 대화창 부품이 부르는 `invoke`·`listen` 을 먼저 폰 서버로 바꿔 끼운 뒤에 그린다(remote-shim.ts).
 *  기기 토큰은 이 브라우저에만 둔다. iOS 홈 화면 앱은 사파리와 저장소가 따로라 홈 화면에서 처음 열면 번호를 한 번 더 넣는다. */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { installRemote, type RemoteStatus } from "./remote-shim";
import { Pair, Phone } from "./Mobile";
import "./theme.css";
import "./chat.css";
import "./mobile.css";

const KEY = "chiispace.remote.token";
const read = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const write = (t: string | null) => {
  try {
    if (t) localStorage.setItem(KEY, t);
    else localStorage.removeItem(KEY);
  } catch {
    // 저장소를 못 쓰는 창(사생활 보호 등)이면 이번 창에서만 쓴다.
  }
};

let token = read();
let setUi: ((s: { paired: boolean; status: RemoteStatus }) => void) | null = null;
let ui = { paired: !!token, status: "connecting" as RemoteStatus };
const update = (patch: Partial<typeof ui>) => {
  ui = { ...ui, ...patch };
  setUi?.(ui);
};

const remote = installRemote({
  token: () => token,
  onUnpaired: () => {
    token = null;
    write(null);
    update({ paired: false });
  },
  onStatus: (status) => update({ status }),
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
    if (token) remote.start();
    return () => {
      setUi = null;
    };
  }, []);
  if (!s.paired)
    return (
      <Pair
        onToken={(t) => {
          token = t;
          write(t);
          update({ paired: true, status: "connecting" });
          remote.start();
        }}
      />
    );
  return (
    <Phone
      status={s.status}
      onForget={() => {
        remote.stop();
        token = null;
        write(null);
        location.hash = "";
        update({ paired: false });
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(<Root />);
