import { createRoot } from "react-dom/client";
import App from "./App";
import "./theme.css";
import "./app.css";

// StrictMode 를 쓰지 않는다 — 개발 모드의 이중 마운트가 PTY 를 두 번 열고
// 한 번 닫아, 셸이 하나 남거나 사라지는 상태가 된다.
const boot = () => createRoot(document.getElementById("root")!).render(<App />);

// 등폭 폰트를 실어 놓고 그린다. xterm 은 열릴 때 글자 하나를 재서 칸 크기를
// 정하는데, 그때 폰트가 아직 안 실려 있으면 폴백의 폭으로 격자를 짜 놓고 만다.
// 뒤늦게 실려도 그 격자는 다시 재지 않아, 글자가 칸에서 조금씩 밀리고 PTY 에
// 알린 열 수까지 틀어진다. 지금 첫 순위(D2Koding)는 시스템 설치본이라 기다릴
// 것이 없지만, 그게 없는 기계에서는 웹폰트인 Cascadia 가 첫 순위가 된다.
//
// `document.fonts.ready` 만으로는 안 된다 — 아직 아무것도 안 그렸으니 그 폰트를
// 쓰는 요소가 없고, 쓰이지 않는 @font-face 는 애초에 받아 오지도 않는다.
// 이름을 대고 직접 부탁해야 받아 온다.
document.fonts.load('16px "Cascadia Code"').then(boot, boot);
