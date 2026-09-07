export function emptyAgentPrompt(line: string, beforeCursor: string, screen: string): boolean {
  // 권한 선택과 질문 메뉴도 정지 상태이므로 스피너가 없다는 것만으로 입력하지 않는다.
  if (/esc to interrupt|allow (once|always)|do you (want|trust)|select an option|선택하|허용하/i.test(screen)) return false;
  const strip = (s: string) => s.replace(/^\s*[│┃]?\s*/, "").replace(/\s*[│┃]\s*$/, "");
  const prefix = strip(beforeCursor);
  if (!/^[❯›>]\s*$/.test(prefix)) return false;
  const body = strip(line).replace(/^[❯›>]\s*/, "");
  // 기본 안내 문구는 커서 뒤에 그려진다. 실제 초안 여부는 PTY 입력 이력으로도 검증한다.
  return body === "" || /^(Try |Ask |Write |Explain |Implement |Summarize |Find |Type )/.test(body);
}
