/** 기기 묶음 — PC 쪽 웹뷰가 다른 PC 와 서로 잇는 일. 규칙과 까닭은 src-tauri/src/remote.rs 머리에 있다.
 *
 *  [PC 잇기]는 그 PC 의 방에 폰처럼 짝짓는 데서 시작한다(숫자 확인). 그 통로로 그 PC 가 이 PC 의 방에 들어올 키와 소개장 열쇠를
 *  넘기고, 그 PC 방의 소개장 열쇠를 받는다(`group_link`). 그래서 한 번 이으면 양쪽으로 옮기고, 한쪽에 짝지은 폰이 다른 쪽도 쓴다. */
import { invoke } from "@tauri-apps/api/core";
import { b64u, newKey } from "./phone-crypto";
import { callOnce, socketUrl, type Paired } from "./phone-link";

type Prepared = { dev: string; page: string; pc: string; invite: string; name: string };

/** 그 PC 와 서로 잇는다. 그 PC 가 예전 판이라 묶기를 모르거나 도중에 끊기면 이 PC 에 만든 길을 거두고 까닭을 돌려준다 —
 *  그때는 이 PC 에서 보내기만 된다. 그 PC 가 이 PC 로 들어올 키(비밀키)는 여기서 만들어 넘긴다. 이 방에만 쓰는 키라 이 PC 가
 *  알아도 잃는 것이 없다. */
export async function linkBack(page: string, paired: Paired): Promise<{ ok: true; invite: string; device: string } | { ok: false; why: string }> {
  const key = await newKey();
  const prep = await invoke<Prepared>("remote_link_prepare", { name: paired.name ?? "PC", public: b64u(key.pub) });
  try {
    const r = (await callOnce(socketUrl(page), paired, paired.name ?? "PC", "group_link", {
      name: prep.name,
      page: prep.page,
      paired: { dev: prep.dev, jwk: key.jwk, pc: prep.pc },
      invite: prep.invite,
    })) as { invite?: unknown } | null;
    if (typeof r?.invite !== "string") throw new Error("묶기 답이 잘못됐다");
    return { ok: true, invite: r.invite, device: prep.dev };
  } catch (e) {
    await invoke("remote_forget", { device: prep.dev }).catch(() => {});
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
}
