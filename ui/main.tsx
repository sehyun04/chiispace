import { createRoot } from "react-dom/client";
import App from "./App";
import "./theme.css";
import "./app.css";

// StrictMode 를 쓰지 않는다 — 개발 모드의 이중 마운트가 PTY 를 두 번 열고
// 한 번 닫아, 셸이 하나 남거나 사라지는 상태가 된다.
createRoot(document.getElementById("root")!).render(<App />);
