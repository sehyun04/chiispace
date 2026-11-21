/** 폰 화면의 시작점(mobile.html). 중계(relay/)를 거쳐 PC 앱이 내준다. 이름이 mobile.tsx 가 아닌 것은 Windows 에서
 *  Mobile.tsx 와 같은 파일이 되어서다.
 *
 *  Tauri 가 없는 브라우저라 대화창 부품이 부르는 `invoke`·`listen` 을 먼저 PC 로 가는 암호 통로로 바꿔 끼운 뒤에 그린다.
 *  짝지은 키는 이 브라우저에만 둔다. iOS 홈 화면 앱은 사파리와 저장소가 따로라 홈 화면에서 처음 열면 한 번 더 짝짓는다.
 *
 *  기기 묶음(remote.rs 머리): 이 페이지를 내준 PC 에 붙으면 그 PC 와 묶인 다른 PC 의 소개장을 받아 그 PC 에도 붙는다. 그래서
 *  홈 화면 앱 하나로 묶인 PC 들의 칸을 다 본다 — 홈 화면 앱은 제 주소(`/r/<방>/`) 밖으로 나가면 앱 밖 창이 되므로 다른 PC 의
 *  페이지로 옮겨 가지 않고 이 페이지가 PC 마다 통로를 하나씩 든다. 칸 화면의 `invoke`·`listen` 은 주소가 가리키는 PC 로 간다. */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Link, pair, socketUrl, type Invite, type LinkStatus, type Paired } from "./phone-link";
import { b64u, newKey } from "./phone-crypto";
import { installRemote } from "./remote-shim";
import { deviceName, roomFromHash, updateAction } from "./phone";
import { Pair, Phone, type PhonePc } from "./Mobile";
import "./theme.css";
import "./chat.css";
import "./mobile.css";

const roomOf = (page: string) => /\/r\/([0-9a-f]{32})\/?$/i.exec(page)?.[1]?.toLowerCase() ?? null;
// 중계 주소는 방마다 다르다(`/r/<방>/`). 같은 중계에 방이 여럿이어도 짝지은 키가 섞이지 않게 주소로 가른다. 묶인 다른 PC 도
// 같은 중계(같은 출처)라 이 저장소에 같이 둔다.
const here = location.origin + location.pathname;
const ownRoom = roomOf(here) ?? location.pathname;
const keyOf = (page: string) => `chiispace.paired:${new URL(page).pathname}`;
const OWN = `chiispace.paired:${location.pathname}`;
/** 묶음의 PC — 방 → 폰 주소·이름. `self` 면 그 PC 가 스스로 붙인 이름이라 다른 PC 가 부르는 이름보다 앞선다. */
const PCS = "chiispace.pcs";
type Known = Record<string, { page: string; name: string | null; self?: boolean }>;

const load = (key: string): unknown => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
};
const store = (key: string, v: unknown) => {
  try {
    if (v == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // 저장소를 못 쓰는 창(사생활 보호 등)이면 이번 창에서만 쓴다.
  }
};
const pairedAt = (key: string): Paired | null => {
  const v = load(key) as Paired | null;
  return v && typeof v.dev === "string" && v.jwk && typeof v.pc === "string" ? v : null;
};
const known = (): Known => {
  const v = load(PCS);
  return v && typeof v === "object" ? (v as Known) : {};
};
const remember = (room: string, page: string, name: string | null, self?: boolean) => {
  const k = known();
  k[room] = { page, name, ...(self ? { self } : {}) };
  store(PCS, k);
};

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

type Pc = { room: string; page: string; name: string | null; self: boolean; own: boolean; status: LinkStatus; link: Link };
const pcs = new Map<string, Pc>();
/** PC 마다 그 PC 에서 온 이벤트를 듣는 귀. 칸 목록이 PC 마다 따로 듣는다. */
const ears = new Map<string, Set<(event: string, payload: unknown) => void>>();

let ui = { paired: false, stale: false, pcs: [] as PhonePc[] };
let setUi: ((s: typeof ui) => void) | null = null;
const update = (patch: Partial<typeof ui> = {}) => {
  // 이 페이지를 내준 PC 를 맨 앞에.
  const list = [...pcs.values()].sort((a, b) => Number(b.own) - Number(a.own)).map(({ room, name, status, own }) => ({ room, name, status, own }));
  ui = { ...ui, ...patch, pcs: list };
  setUi?.(ui);
};

/** 주소가 가리키는 PC. 칸 화면의 대화창 부품이 부르는 것은 그 PC 로 간다. */
const active = () => roomFromHash(location.hash) ?? ownRoom;
const shim = installRemote((cmd, args) => {
  const pc = pcs.get(active());
  return pc ? pc.link.invoke(cmd, args) : Promise.reject("짝지은 폰이 아니다");
});
const call = (room: string, cmd: string, args: unknown) => {
  const pc = pcs.get(room);
  return pc ? pc.link.invoke(cmd, args) : Promise.reject("모르는 PC 다");
};
const on = (room: string, fn: (event: string, payload: unknown) => void) => {
  let s = ears.get(room);
  if (!s) ears.set(room, (s = new Set()));
  s.add(fn);
  return () => void s.delete(fn);
};

function add(room: string, page: string, paired: Paired, isOwn: boolean, name: string | null, self = false) {
  pcs.get(room)?.link.stop();
  const pc: Pc = { room, page, name, self, own: isOwn, status: "connecting", link: null as unknown as Link };
  pc.link = new Link({
    url: socketUrl(isOwn ? location.href : page),
    paired,
    onStatus: (status) => {
      pc.status = status;
      update();
      if (status === "open") void join(pc);
    },
    onEvent: (event, payload) => {
      ears.get(room)?.forEach((f) => f(event, payload));
      if (room === active()) shim.emit(event, payload);
    },
    // 폰 화면 파일은 이 페이지를 내준 PC 의 것이다. 다른 PC 의 판과는 견주지 않는다.
    onVersion: isOwn ? onVersion : undefined,
    onUnpaired: () => (isOwn ? unpairOwn() : drop(room)),
  });
  pcs.set(room, pc);
  pc.link.start();
  update();
}

function rename(room: string, name: string, self: boolean) {
  const pc = pcs.get(room);
  if (!pc || (pc.name === name && pc.self === self)) return;
  pc.name = name;
  pc.self = self;
  remember(room, pc.page, name, self);
  update();
}

/** 붙은 PC 에서 묶음의 다른 PC 를 받아, 아직 없는 PC 에 들어갈 소개장을 받는다. 키는 폰이 그 PC 몫으로 새로 만든다 —
 *  비밀키는 폰에만 있고 소개장에는 공개키만 실린다. 예전 판 PC 는 묶음을 모르므로 그 PC 하나만 쓴다. */
const joining = new Set<string>();
async function join(pc: Pc) {
  if (joining.has(pc.room)) return;
  joining.add(pc.room);
  try {
    const g = (await pc.link.invoke("group_pcs", {})) as { me?: string; named?: boolean; pcs?: { id: string; name: string; page: string }[] };
    if (g.me && (g.named || !pc.name)) rename(pc.room, g.me, !!g.named);
    for (const x of g.pcs ?? []) {
      const room = roomOf(x.page);
      if (!room) continue;
      const have = pcs.get(room);
      if (have) {
        if (!have.self) rename(room, x.name, false);
        continue;
      }
      const key = await newKey();
      const r = (await pc.link.invoke("group_invite", { peer: x.id, pub: b64u(key.pub) })) as { dev: string; pc: string; page: string; pcName: string; invite: Invite };
      const paired: Paired = { dev: r.dev, jwk: key.jwk, pc: r.pc, name: r.pcName, invite: r.invite };
      store(keyOf(r.page), paired);
      remember(room, r.page, r.pcName);
      add(room, r.page, paired, false, r.pcName);
    }
  } catch {
    // 예전 판 PC 거나 도중에 끊겼다. 다음에 붙을 때 다시 해 본다.
  } finally {
    joining.delete(pc.room);
  }
}

/** 묶인 PC 가 이 폰을 잊었다. 그 PC 만 뺀다. */
function drop(room: string) {
  const pc = pcs.get(room);
  pc?.link.stop();
  pcs.delete(room);
  if (pc) store(keyOf(pc.page), null);
  const k = known();
  delete k[room];
  store(PCS, k);
  update();
}

/** 이 페이지를 내준 PC 가 이 폰을 잊었다. 짝짓기 화면으로 돌아간다 — 그 PC 에서 다시 짝지으면 묶음도 다시 받는다. */
function unpairOwn() {
  pcs.get(ownRoom)?.link.stop();
  pcs.delete(ownRoom);
  store(OWN, null);
  update({ paired: false });
}

function forgetAll() {
  for (const pc of pcs.values()) {
    pc.link.stop();
    store(keyOf(pc.page), null);
  }
  pcs.clear();
  store(OWN, null);
  store(PCS, null);
  location.hash = "";
  update({ paired: false });
}

function begin(p: Paired) {
  const k = known();
  add(ownRoom, here, p, true, k[ownRoom]?.name ?? p.name ?? null, !!k[ownRoom]?.self);
  for (const [room, x] of Object.entries(k)) {
    if (pcs.has(room)) continue;
    const paired = pairedAt(keyOf(x.page));
    if (paired) add(room, x.page, paired, false, x.name, !!x.self);
  }
  update({ paired: true });
}

const saved = pairedAt(OWN);
if (saved) begin(saved);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") for (const pc of pcs.values()) pc.link.wake();
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
          const p = await pair(socketUrl(location.href), deviceName(navigator.userAgent), onSas);
          store(OWN, p);
          begin(p);
        }}
      />
    );
  return <Phone pcs={s.pcs} stale={s.stale} call={call} on={on} onForget={forgetAll} />;
}

createRoot(document.getElementById("root")!).render(<Root />);
