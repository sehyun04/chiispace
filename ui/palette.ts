/** 입력바의 `/` 명령 고르기. React 없이 단위 검증한다(palette.test.mjs).
 *
 *  무엇을 띄울지는 칸이 준다. 터미널 없는 두 칸은 입력바 위 줄(StreamBar)의 모델·추론·권한을 그대로 명령으로
 *  올린다 — 고르면 그 자리에서 바뀌어 TUI 메뉴를 찾아 터미널로 갈 일이 없다. Claude 칸은 거기에 claude 가 초기화 답으로
 *  준 명령(스킬·사용자 명령 포함)을 붙인다. 그 목록이 곧 그 claude 가 받는 명령이라 앱이 따로 적어 두지 않는다. */

export type PaletteChoice = { value: string; label: string; hint?: string; current?: boolean };

export type PaletteCommand = {
  /** 빗금을 뺀 이름. */
  name: string;
  aliases?: string[];
  hint?: string;
  /** 뒤에 붙일 말의 모양(`<model>`). */
  args?: string;
  /** 고르면 이어서 뜨는 목록. */
  choices?: PaletteChoice[];
  /** 고르는 순간 불러오는 목록(지난 대화처럼 미리 들고 있을 수 없는 것). 불러오면 부른 쪽이 `choices` 로 채워 다시 준다. */
  load?: () => Promise<PaletteChoice[]>;
  /** 목록이 비었을 때 보일 말. */
  empty?: string;
  /** 앱이 직접 한다. 없으면 `/이름` 이나 `/이름 값` 을 보낼 말로 보낸다. */
  run?: (value?: string) => void;
};

export type PaletteView =
  | { stage: "commands"; items: PaletteCommand[] }
  | { stage: "choices"; command: PaletteCommand; items: PaletteChoice[]; note?: string };

export type PaletteAction = { kind: "fill"; text: string } | { kind: "run"; run: () => void } | { kind: "send"; text: string };

const lower = (s: string) => s.toLowerCase();
const names = (c: PaletteCommand) => [c.name, ...(c.aliases ?? [])].map(lower);

/** 지금 쓴 글에 맞는 목록. 명령 이름을 쓰는 중이면 명령을, 고를 것이 있는 명령 뒤면 그 선택지를 준다. */
export function paletteView(text: string, commands: PaletteCommand[]): PaletteView | null {
  if (!commands.length || text.includes("\n")) return null;
  const head = /^\/(\S*)$/.exec(text);
  if (head) {
    const q = lower(head[1]);
    // 한글로 찾으면 설명에서 찾는다("/모델"). 영문 한두 글자로 설명까지 뒤지면 스킬 설명이 죄다 걸린다.
    const korean = /[^\x00-\x7f]/.test(q);
    const rank = (c: PaletteCommand) => {
      const n = names(c);
      if (n.includes(q)) return 0;
      if (n.some((x) => x.startsWith(q))) return 1;
      if (q && n.some((x) => x.includes(q))) return 2;
      if (korean && c.hint && lower(c.hint).includes(q)) return 3;
      return -1;
    };
    const items = commands
      .map((c, i) => ({ c, r: rank(c), i }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.c);
    return items.length ? { stage: "commands", items } : null;
  }
  const arg = /^\/(\S+) (.*)$/.exec(text);
  if (!arg) return null;
  const command = commands.find((c) => names(c).includes(lower(arg[1])));
  if (!command) return null;
  // 불러오는 목록은 비어도 목록 자리를 띄워 까닭을 보인다. 안 띄우면 Enter 가 "/resume" 을 claude 에 보낸다.
  if (command.load && !command.choices) return { stage: "choices", command, items: [], note: "불러오는 중" };
  if (!command.choices?.length) return command.load ? { stage: "choices", command, items: [], note: command.empty ?? "없음" } : null;
  const q = lower(arg[2].trim());
  const items = command.choices.filter((c) => !q || lower(c.label).includes(q) || lower(c.value).includes(q));
  if (items.length) return { stage: "choices", command, items };
  return command.load ? { stage: "choices", command, items: [], note: "맞는 것 없음" } : null;
}

/** 꼭 써야 하는 인자. `[이름]`·`<optional …>` 처럼 빼도 되는 것은 고르면 바로 보낸다. */
const needsArgs = (args?: string) => !!args && !args.startsWith("[") && !/optional/i.test(args);

/** Enter 로 고를 때. 고를 것이 없는 목록(불러오는 중·빈 목록)이면 아무 일도 안 한다. */
export function choose(view: PaletteView, index: number): PaletteAction | null {
  if (view.stage === "commands") {
    const c = view.items[index];
    if (c.choices?.length || c.load || needsArgs(c.args)) return { kind: "fill", text: `/${c.name} ` };
    if (c.run) return { kind: "run", run: () => c.run!() };
    return { kind: "send", text: `/${c.name}` };
  }
  const choice = view.items[index];
  if (!choice) return null;
  const c = view.command;
  if (c.run) return { kind: "run", run: () => c.run!(choice.value) };
  return { kind: "send", text: `/${c.name} ${choice.value}` };
}

/** Tab 으로 채울 때. 보내지 않고 입력바에만 둔다. */
export function complete(view: PaletteView, index: number): string {
  if (view.stage === "choices") return `/${view.command.name} ${view.items[index]?.value ?? ""}`;
  const c = view.items[index];
  return c.choices?.length || c.load || c.args ? `/${c.name} ` : `/${c.name}`;
}

type Field = { value: string; choices: { value: string; label: string; title?: string }[]; onChange: (value: string) => void; disabled?: boolean };

/** 입력바 위 줄을 명령으로. 줄과 같은 선택지·같은 바꾸기를 쓰므로 둘이 어긋날 일이 없다. */
export function barCommands(bar: { model: Field; effort?: Field; permission: Field; onStatus: () => void; onNew: () => void; busy: boolean }): PaletteCommand[] {
  const pick = (name: string, hint: string, f?: Field): PaletteCommand[] => {
    if (!f || f.disabled) return [];
    // 값이 빈 항목은 "지금 쓰는 것을 모른다"는 자리표시다. 고를 것이 아니다.
    const choices = f.choices.filter((c) => c.value).map((c) => ({ value: c.value, label: c.label, hint: c.title, current: c.value === f.value }));
    return choices.length ? [{ name, hint, choices, run: (v?: string) => v !== undefined && f.onChange(v) }] : [];
  };
  return [
    ...pick("model", "모델 바꾸기", bar.model),
    ...pick("effort", "추론 수준", bar.effort),
    ...pick("permissions", "권한 · 무엇을 묻고 할지", bar.permission),
    { name: "status", hint: "모델 · 권한 · 폴더 · 토큰 보기", run: bar.onStatus },
    // 일하는 중에 새 대화를 열면 하던 턴이 끊긴다. 줄의 단추와 같이 막는다.
    ...(bar.busy ? [] : [{ name: "clear", aliases: ["new", "reset"], hint: "이 칸에서 새 대화", run: bar.onNew }]),
  ];
}

/** 에이전트가 알려 준 명령. 내부용(`__`)은 뺀다. 설명은 첫 줄만 — 스킬 설명은 문단이다. */
export function agentCommands(list: { name: string; description?: string; argumentHint?: string; aliases?: string[] }[]): PaletteCommand[] {
  return list
    .filter((c) => c.name && !c.name.startsWith("__"))
    .map((c) => ({ name: c.name, aliases: c.aliases, hint: c.description?.split("\n")[0], args: c.argumentHint || undefined }));
}

/** 앱이 직접 하는 명령이 앞에 서고, 같은 이름의 에이전트 명령은 가린다. */
export function mergeCommands(app: PaletteCommand[], agent: PaletteCommand[]): PaletteCommand[] {
  const taken = new Set(app.flatMap(names));
  return [...app, ...agent.filter((c) => !names(c).some((n) => taken.has(n)))];
}

/** 목록의 "언제". 하루 안이면 몇 분·몇 시간 전, 그보다 오래면 날짜 — 지난 대화를 고를 때 기억을 되짚는 손잡이다. */
export function ago(ms: number, now = Date.now()): string {
  const m = Math.floor((now - ms) / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}시간 전`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}
