//! 폰에 건네는 대화 원문.
//!
//! 폰 대화창은 PC 와 같은 해석(`ui/transcript.ts`)으로 원문을 그린다. 그런데 원문 대부분은 화면에 안 나오는 것이다 —
//! 요청 기록·파일 스냅숏, 줄마다 붙는 겉봉(사용량·요청 id·도구 입력 사본), 화면 찍기 그림, 명령 출력. 끝 2MB 를 그대로
//! 자르면 긴 대화에서는 마지막 두어 마디만 남았다(45MB 대화에서 폰에 두 턴만 보였다). 그래서 화면이 읽는 칸만 남기고 긴
//! 글은 줄인 뒤에 같은 크기로 자른다 — 망에 싣는 양은 그대로이고 거슬러 보이는 대화가 훨씬 길다.
//!
//! 파일이 자랄 때마다 폰이 통째로 다시 받으니, 줄인 줄을 파일마다 들고 있다가 새로 붙은 줄만 읽는다.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Map, Value};

/// 처음 읽을 때 거슬러 가는 원문의 한도. 이보다 긴 대화는 끝에서부터 이만큼만 줄인다.
const FIRST_READ: u64 = 96 * 1024 * 1024;
/// 줄인 줄을 들고 있는 한도. 폰에 보내는 몫(`PHONE_TAIL`)보다 넉넉하면 된다 — 그보다 오래된 줄은 어차피 안 보낸다.
const KEEP_BYTES: usize = 8 * 1024 * 1024;
/// 도구 호출 입력·결과의 글. 폰에서 카드를 펼치면 앞부분이 보인다.
const TEXT_CAP: usize = 2000;
const THINK_CAP: usize = 4000;
/// 시스템 줄·예약 메시지의 본문. 사람이 친 말이라 넉넉히 둔다.
const CONTENT_CAP: usize = 20_000;
/// 구조화된 결과에서 남기는 짧은 글. 카드 머리 표시는 숫자만 쓴다(`ui/tools.ts` `toolStats`).
const SHORT: usize = 200;
const PATCH_LINE: usize = 300;
const CACHED_FILES: usize = 12;
/// 같은 파일인지 볼 때 견주는 앞부분. 세션이사가 파일을 갈아 끼우면 길이가 같거나 길어도 앞이 다르다.
const HEAD: usize = 512;
const CUT_NOTE: &str = "\n…(폰에는 여기까지)";

/// 대화창이 읽는 겉봉 칸(`SessionEvent`). `message` 는 따로 줄인다.
const ENVELOPE: &[&str] = &[
    "type",
    "uuid",
    "parentUuid",
    "logicalParentUuid",
    "isSidechain",
    "timestamp",
    "sourceToolUseID",
    "toolUseResult",
    "subtype",
    "content",
    "operation",
    "attachment",
    "compactMetadata",
    "error",
    "retryAttempt",
    "maxRetries",
    "retryInMs",
];

#[derive(Default)]
struct Slimmed {
    head: Vec<u8>,
    read_to: u64,
    /// 처음 읽기를 파일 가운데서 시작하면 첫 줄이 반 토막이다. 그 줄을 버린 뒤에 참이 된다.
    aligned: bool,
    lines: Vec<String>,
    bytes: usize,
    /// 사람이 친 말의 uuid. 버리는 줄이 이걸 부모로 가리키면 가리켰다는 사실만 남긴다.
    users: HashSet<String>,
    /// AskUserQuestion 호출 id. 그 결과는 줄이지 않는다 — 문답 카드가 결과 글에서 답을 찾는다.
    asks: HashSet<String>,
}

static CACHE: Mutex<Option<HashMap<PathBuf, Slimmed>>> = Mutex::new(None);

/// 줄인 원문의 끝에서 `budget` 바이트 안쪽. 줄 단위로 자른다.
pub(crate) fn tail(path: &Path, budget: usize) -> String {
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    let Ok(mut f) = File::open(path) else {
        map.remove(path);
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let head = read_head(&mut f);
    let same = map
        .get(path)
        .is_some_and(|s| len >= s.read_to && (head.starts_with(&s.head) || s.head.starts_with(&head)));
    if !same {
        if map.len() >= CACHED_FILES {
            map.clear();
        }
        let read_to = len.saturating_sub(FIRST_READ);
        map.insert(path.to_path_buf(), Slimmed { read_to, aligned: read_to == 0, ..Default::default() });
    }
    let s = map.get_mut(path).expect("방금 넣었다");
    if head.len() > s.head.len() {
        s.head = head;
    }
    s.extend(&mut f, len);
    s.tail(budget)
}

fn read_head(f: &mut File) -> Vec<u8> {
    let mut head = Vec::with_capacity(HEAD);
    let _ = f.seek(SeekFrom::Start(0));
    let _ = f.by_ref().take(HEAD as u64).read_to_end(&mut head);
    head
}

impl Slimmed {
    fn extend(&mut self, f: &mut File, len: u64) {
        if len <= self.read_to {
            return;
        }
        let mut buf = Vec::new();
        if f.seek(SeekFrom::Start(self.read_to)).is_err() || f.by_ref().take(len - self.read_to).read_to_end(&mut buf).is_err() {
            return;
        }
        let mut start = 0;
        if !self.aligned {
            let Some(i) = buf.iter().position(|&b| b == b'\n') else { return };
            start = i + 1;
            self.aligned = true;
        }
        // 끝의 반 줄은 claude 가 아직 쓰는 중이다. 다음에 다시 읽는다.
        let end = buf[start..].iter().rposition(|&b| b == b'\n').map_or(start, |i| start + i + 1);
        for line in buf[start..end].split(|&b| b == b'\n') {
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };
            if let Some(out) = self.slim(v) {
                let out = out.to_string();
                self.bytes += out.len() + 1;
                self.lines.push(out);
            }
        }
        self.read_to += end as u64;
        if self.bytes > KEEP_BYTES {
            let mut drop = 0;
            while self.bytes > KEEP_BYTES / 2 && drop < self.lines.len() {
                self.bytes -= self.lines[drop].len() + 1;
                drop += 1;
            }
            self.lines.drain(..drop);
        }
    }

    fn tail(&self, budget: usize) -> String {
        let mut used = 0;
        let mut n = 0;
        for l in self.lines.iter().rev() {
            // 맨 끝 줄은 몫보다 커도 보낸다. 그래야 방금 보낸 큰 그림 하나에 대화가 통째로 비지 않는다.
            if n > 0 && used + l.len() + 1 > budget {
                break;
            }
            used += l.len() + 1;
            n += 1;
        }
        let mut out = String::with_capacity(used);
        for l in &self.lines[self.lines.len() - n..] {
            out.push_str(l);
            out.push('\n');
        }
        out
    }

    fn slim(&mut self, v: Value) -> Option<Value> {
        let Value::Object(mut o) = v else { return None };
        let kind = o.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        let keep = match kind.as_str() {
            "user" | "assistant" | "system" | "queue-operation" => true,
            "attachment" => attachment_shown(o.get("attachment")),
            _ => false,
        };
        if !keep {
            // 대화창은 아무도 부모로 가리키지 않는 말을 보내자마자 물린 것으로 보고 지울 수 있다(`toItems`).
            // 사람이 친 말 바로 뒤에는 화면에 안 나오는 첨부 줄이 붙곤 하니, 그 가리킴은 남긴다.
            let p = o.get("parentUuid").and_then(Value::as_str).filter(|p| self.users.contains(*p))?;
            return Some(json!({ "type": "ref", "parentUuid": p }));
        }
        let mut out = Map::new();
        for k in ENVELOPE {
            if let Some(x) = o.remove(*k) {
                out.insert((*k).to_string(), x);
            }
        }
        if let Some(Value::String(c)) = out.get_mut("content") {
            *c = cut(c, CONTENT_CAP);
        }
        if let Some(r) = out.remove("toolUseResult") {
            out.insert("toolUseResult".into(), tool_use_result(r));
        }
        if let Some(a) = out.remove("attachment") {
            out.insert("attachment".into(), attachment(a));
        }
        let mut said = false;
        if let Some(m) = o.remove("message") {
            let (m, text) = self.message(m);
            said = text;
            out.insert("message".into(), m);
        }
        if kind == "user" && said {
            if let Some(u) = out.get("uuid").and_then(Value::as_str) {
                self.users.insert(u.to_string());
            }
        }
        Some(Value::Object(out))
    }

    /// 줄인 메시지와, 사람이 친 말(도구 결과가 아닌 글)이 들었는지.
    fn message(&mut self, m: Value) -> (Value, bool) {
        let Value::Object(mut m) = m else { return (m, false) };
        let mut out = Map::new();
        let user = m.get("role").and_then(Value::as_str) == Some("user");
        if let Some(r) = m.remove("role") {
            out.insert("role".into(), r);
        }
        // 대화창이 겉봉 사용량에서 읽는 것은 출력 토큰 하나다(`turnTokens`).
        if let Some(n) = m.get("usage").and_then(|u| u.get("output_tokens")).cloned() {
            out.insert("usage".into(), json!({ "output_tokens": n }));
        }
        let mut said = false;
        match m.remove("content") {
            Some(Value::String(s)) => {
                said = true;
                out.insert("content".into(), Value::String(if user { strip_reminders(&s) } else { s }));
            }
            Some(Value::Array(blocks)) => {
                said = blocks.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("text"));
                let blocks: Vec<Value> = blocks.into_iter().filter_map(|b| self.block(b, user)).collect();
                out.insert("content".into(), Value::Array(blocks));
            }
            Some(other) => {
                out.insert("content".into(), other);
            }
            None => {}
        }
        (Value::Object(out), said)
    }

    fn block(&mut self, b: Value, user: bool) -> Option<Value> {
        let Value::Object(mut b) = b else { return Some(b) };
        let kind = b.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        match kind.as_str() {
            "text" => {
                if user {
                    if let Some(Value::String(t)) = b.get_mut("text") {
                        *t = strip_reminders(t);
                    }
                }
                Some(Value::Object(b))
            }
            // 사람이 붙인 그림은 그 말의 일부라 남긴다. 도구가 돌려준 그림은 아래 tool_result 에서 걷는다.
            "image" => Some(Value::Object(b)),
            "thinking" => {
                let t = b.get("thinking").and_then(Value::as_str).unwrap_or("");
                Some(json!({ "type": "thinking", "thinking": cut(t, THINK_CAP) }))
            }
            "tool_use" => {
                let id = b.remove("id").unwrap_or(Value::Null);
                let name = b.remove("name").unwrap_or(Value::Null);
                let ask = name.as_str() == Some("AskUserQuestion");
                if let (true, Some(i)) = (ask, id.as_str()) {
                    self.asks.insert(i.to_string());
                }
                let input = b.remove("input").map(|i| if ask { i } else { cap_strings(i) }).unwrap_or(Value::Null);
                Some(json!({ "type": "tool_use", "id": id, "name": name, "input": input }))
            }
            "tool_result" => {
                let id = b.remove("tool_use_id").unwrap_or(Value::Null);
                let whole = id.as_str().is_some_and(|i| self.asks.contains(i));
                let content = b.remove("content").map(|c| if whole { c } else { result_content(c) }).unwrap_or(Value::Null);
                let mut r = json!({ "type": "tool_result", "tool_use_id": id, "content": content });
                if let Some(e) = b.remove("is_error") {
                    r["is_error"] = e;
                }
                Some(r)
            }
            // 서명·가려진 생각·서버 도구 줄은 대화창이 그리지 않는다.
            _ => None,
        }
    }
}

fn attachment_shown(a: Option<&Value>) -> bool {
    let kind = a.and_then(|a| a.get("type")).and_then(Value::as_str);
    match kind {
        Some("queued_command") => true,
        // 훅이 화면에 띄우라고 준 말만 카드가 된다. 그냥 뱉은 글은 대화창이 거른다.
        Some("hook_success") => a.and_then(|a| a.get("stdout")).and_then(Value::as_str).is_some_and(|s| s.contains("systemMessage")),
        _ => false,
    }
}

fn attachment(a: Value) -> Value {
    let Value::Object(mut a) = a else { return a };
    let mut out = Map::new();
    for k in ["type", "prompt", "toolUseID"] {
        if let Some(x) = a.remove(k) {
            out.insert(k.into(), x);
        }
    }
    if let Some(Value::String(s)) = a.remove("stdout") {
        out.insert("stdout".into(), Value::String(cut(&s, TEXT_CAP)));
    }
    Value::Object(out)
}

fn result_content(c: Value) -> Value {
    match c {
        Value::String(s) => Value::String(cut(&s, TEXT_CAP)),
        Value::Array(blocks) => Value::Array(
            blocks
                .into_iter()
                .map(|b| {
                    if b.get("type").and_then(Value::as_str) == Some("image") {
                        json!({ "type": "text", "text": "[그림]" })
                    } else {
                        cap_strings(b)
                    }
                })
                .collect(),
        ),
        other => cap_strings(other),
    }
}

/// 구조화된 결과는 카드 머리 숫자(끝 코드·줄 수·파일 수)와 바뀐 줄만 읽힌다. 파일 내용·출력 사본은 걷는다.
fn tool_use_result(r: Value) -> Value {
    match r {
        Value::Object(o) => {
            let mut out = Map::new();
            for (k, v) in o {
                let keep = match &v {
                    Value::Array(_) => k == "structuredPatch",
                    Value::String(s) => s.chars().count() <= SHORT,
                    Value::Number(_) | Value::Bool(_) | Value::Null => true,
                    Value::Object(_) => false,
                };
                if !keep {
                    continue;
                }
                let v = match v {
                    Value::Array(hunks) => Value::Array(hunks.into_iter().map(hunk).collect()),
                    other => other,
                };
                out.insert(k, v);
            }
            Value::Object(out)
        }
        Value::String(s) => Value::String(cut(&s, PATCH_LINE)),
        _ => Value::Null,
    }
}

fn hunk(h: Value) -> Value {
    let Value::Object(mut h) = h else { return h };
    if let Some(Value::Array(lines)) = h.get_mut("lines") {
        for l in lines.iter_mut() {
            if let Value::String(s) = l {
                if s.chars().count() > PATCH_LINE {
                    *s = s.chars().take(PATCH_LINE).collect();
                }
            }
        }
    }
    Value::Object(h)
}

fn cap_strings(v: Value) -> Value {
    match v {
        Value::String(s) => Value::String(cut(&s, TEXT_CAP)),
        Value::Array(a) => Value::Array(a.into_iter().map(cap_strings).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, cap_strings(v))).collect()),
        other => other,
    }
}

fn cut(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}{CUT_NOTE}", &s[..i]),
        None => s.to_string(),
    }
}

/// 사람 말에 끼워 넣은 `<system-reminder>` 덩이를 걷는다. 대화창도 같은 것을 지운다(`stripMeta`) — 여기서 먼저 걷으면
/// 메모리·규칙 파일 전문이 매 턴 폰으로 가지 않는다. 닫는 태그가 없으면 그대로 둔다(대화창이 그 뒤를 버린다).
fn strip_reminders(s: &str) -> String {
    const OPEN: &str = "<system-reminder>";
    const CLOSE: &str = "</system-reminder>";
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find(OPEN) {
        let Some(j) = rest[i + OPEN.len()..].find(CLOSE) else { break };
        out.push_str(&rest[..i]);
        rest = &rest[i + OPEN.len() + j + CLOSE.len()..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("chiispace-phone-transcript-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("s.jsonl")
    }

    fn write(path: &Path, lines: &[Value], append: bool) {
        let mut f = std::fs::OpenOptions::new().create(true).append(append).write(true).truncate(!append).open(path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    fn parse(text: &str) -> Vec<Value> {
        text.lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    #[test]
    fn keeps_what_the_chat_draws_and_drops_the_rest() {
        let p = temp("keep");
        let big = "x".repeat(50_000);
        write(
            &p,
            &[
                json!({"type": "permission-mode", "mode": "bypass"}),
                json!({"type": "user", "uuid": "u1", "timestamp": "t", "cwd": "C:\\x", "message": {"role": "user",
                    "content": "<system-reminder>메모리 전문</system-reminder>안녕"}}),
                json!({"type": "attachment", "uuid": "a1", "parentUuid": "u1", "attachment": {"type": "file", "content": big}}),
                json!({"type": "api-request-blob", "parentUuid": "a1", "blob": big}),
                json!({"type": "assistant", "uuid": "r1", "parentUuid": "a1", "requestId": "req", "message": {"role": "assistant",
                    "model": "m", "usage": {"output_tokens": 7, "input_tokens": 9, "iterations": [big]},
                    "content": [
                        {"type": "thinking", "thinking": "음", "signature": big},
                        {"type": "text", "text": "답"},
                        {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": big}},
                    ]}}),
                json!({"type": "user", "uuid": "u2", "parentUuid": "r1", "sourceToolUseID": "t1",
                    "toolUseResult": {"stdout": big, "exitCode": 1, "interrupted": false},
                    "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "is_error": true,
                        "content": [{"type": "text", "text": big}, {"type": "image", "source": {"type": "base64", "data": big}}]}]}}),
            ],
            false,
        );
        let out = tail(&p, 2 * 1024 * 1024);
        assert!(out.len() < 10_000, "큰 글이 그대로 갔다: {}", out.len());
        let v = parse(&out);
        let kinds: Vec<&str> = v.iter().map(|x| x["type"].as_str().unwrap()).collect();
        // 사람 말을 가리키던 첨부 줄은 가리킴만 남고, 첨부를 가리키는 요청 기록은 아예 빠진다.
        assert_eq!(kinds, ["user", "ref", "assistant", "user"]);
        assert_eq!(v[0]["message"]["content"], "안녕");
        assert!(v[0].get("cwd").is_none());
        assert_eq!(v[1]["parentUuid"], "u1");
        let a = &v[2]["message"];
        assert_eq!(a["usage"], json!({"output_tokens": 7}));
        assert_eq!(a["content"][0], json!({"type": "thinking", "thinking": "음"}));
        assert!(a["content"][2]["input"]["command"].as_str().unwrap().ends_with(CUT_NOTE));
        let r = &v[3];
        assert_eq!(r["toolUseResult"], json!({"exitCode": 1, "interrupted": false}));
        let c = &r["message"]["content"][0];
        assert_eq!(c["is_error"], true);
        assert_eq!(c["content"][1], json!({"type": "text", "text": "[그림]"}));
    }

    #[test]
    fn reads_only_new_lines_and_waits_for_half_written_ones() {
        let p = temp("grow");
        let u = |id: &str, text: &str| json!({"type": "user", "uuid": id, "message": {"role": "user", "content": text}});
        write(&p, &[u("1", "하나")], false);
        assert_eq!(parse(&tail(&p, 1 << 20)).len(), 1);
        // claude 가 줄을 쓰는 도중이면 끝에 줄바꿈이 없다. 그 반 줄은 다음 읽기로 미룬다.
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        write!(f, "{}", u("2", "둘")).unwrap();
        assert_eq!(parse(&tail(&p, 1 << 20)).len(), 1);
        writeln!(f).unwrap();
        write(&p, &[u("3", "셋")], true);
        let v = parse(&tail(&p, 1 << 20));
        assert_eq!(v.iter().map(|x| x["message"]["content"].as_str().unwrap()).collect::<Vec<_>>(), ["하나", "둘", "셋"]);
        // 파일을 새로 갈아 끼우면(세션이사) 처음부터 다시 읽는다.
        write(&p, &[u("9", "새 파일")], false);
        let v = parse(&tail(&p, 1 << 20));
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["message"]["content"], "새 파일");
    }

    #[test]
    fn budget_keeps_the_newest_whole_lines() {
        let p = temp("budget");
        let lines: Vec<Value> = (0..50).map(|i| json!({"type": "user", "uuid": format!("u{i}"), "message": {"role": "user", "content": format!("{i:03}")}})).collect();
        write(&p, &lines, false);
        let one = lines[0].to_string().len() + 1;
        let v = parse(&tail(&p, one * 10));
        assert!(v.len() >= 9 && v.len() <= 10, "{}", v.len());
        assert_eq!(v.last().unwrap()["message"]["content"], "049");
    }

    #[test]
    fn question_answers_are_not_cut() {
        let p = temp("ask");
        let long = "가".repeat(TEXT_CAP + 50);
        write(
            &p,
            &[
                json!({"type": "assistant", "uuid": "r", "message": {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "q1", "name": "AskUserQuestion", "input": {"questions": [{"question": long}]}}]}}),
                json!({"type": "user", "uuid": "u", "message": {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "q1", "content": format!("\"{long}\"=\"네\"")}]}}),
            ],
            false,
        );
        let v = parse(&tail(&p, 1 << 20));
        assert_eq!(v[0]["message"]["content"][0]["input"]["questions"][0]["question"], long.as_str());
        assert!(v[1]["message"]["content"][0]["content"].as_str().unwrap().ends_with("=\"네\""));
    }

    #[test]
    fn reminders_go_but_an_unclosed_one_stays_for_the_chat_to_cut() {
        assert_eq!(strip_reminders("a<system-reminder>x</system-reminder>b<system-reminder>y</system-reminder>"), "ab");
        assert_eq!(strip_reminders("a<system-reminder>열림"), "a<system-reminder>열림");
        assert_eq!(cut("가나다", 2), format!("가나{CUT_NOTE}"));
        assert_eq!(cut("가나", 2), "가나");
    }
}
