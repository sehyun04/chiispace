/** 폰과 PC 사이의 암호 — 중계(Cloudflare)는 이 키를 모르고 암호문만 나른다. PC 쪽 짝은 src-tauri/src/remote_crypto.rs 이고,
 *  둘이 같은 값을 내는지는 같은 시험값으로 본다(remote.test.mjs · remote_crypto 테스트).
 *
 *  - 키: P-256 ECDH(WebCrypto 가 iOS 사파리까지 다 받는 곡선). 공개키는 압축 안 한 65바이트를 base64url 로.
 *  - 짝짓기: 폰이 먼저 제 공개키를 해시로 약속하고(commit), PC 가 제 키와 난수를 낸 뒤에 폰이 키를 연다. 그다음 두 화면이
 *    여섯 자리(SAS)를 보이고 사람이 같은지 본다. 약속을 먼저 하지 않으면 중계가 키를 바꿔치기하며 여섯 자리를 맞출 때까지
 *    백만 번 돌려 볼 수 있다.
 *  - 연결마다: 짝지을 때의 두 키로 ECDH → HKDF(소금 = 이번 연결의 두 난수)로 방향별 키 둘. AES-256-GCM, IV 는 방향별 순번.
 *    순번이 어긋나면(빠지거나 되풀이되거나 순서가 바뀌면) 풀리지 않는다. */

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64u = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64u = (s: string) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
export const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const sha256 = async (...parts: Uint8Array[]) => new Uint8Array(await subtle.digest("SHA-256", cat(...parts)));

const CURVE = { name: "ECDH", namedCurve: "P-256" } as const;

export type KeyPair = { priv: CryptoKey; pub: Uint8Array };

export async function newKey(): Promise<KeyPair & { jwk: JsonWebKey }> {
  const k = (await subtle.generateKey(CURVE, true, ["deriveBits"])) as CryptoKeyPair;
  return { priv: k.privateKey, pub: new Uint8Array(await subtle.exportKey("raw", k.publicKey)), jwk: await subtle.exportKey("jwk", k.privateKey) };
}

/** 저장해 둔 폰 키. 공개키는 JWK 의 x·y 로 다시 만든다. */
export async function loadKey(jwk: JsonWebKey): Promise<KeyPair> {
  const priv = await subtle.importKey("jwk", jwk, CURVE, false, ["deriveBits"]);
  return { priv, pub: cat(new Uint8Array([4]), unb64u(jwk.x ?? ""), unb64u(jwk.y ?? "")) };
}

async function ecdh(priv: CryptoKey, other: Uint8Array) {
  const pub = await subtle.importKey("raw", other, CURVE, false, []);
  return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
}

export const commitOf = (phonePub: Uint8Array, nA: Uint8Array) => sha256(phonePub, nA);

export async function sasOf(phonePub: Uint8Array, pcPub: Uint8Array, nA: Uint8Array, nB: Uint8Array) {
  const h = await sha256(enc.encode("chiispace-sas"), phonePub, pcPub, nA, nB);
  const n = ((h[0] << 24) >>> 0) + (h[1] << 16) + (h[2] << 8) + h[3];
  return String(n % 1_000_000).padStart(6, "0");
}

/** 이번 연결의 방향별 키. `up` 은 폰→PC, `down` 은 PC→폰. */
export async function sessionKeys(priv: CryptoKey, pcPub: Uint8Array, nA: Uint8Array, nB: Uint8Array, dev: string) {
  const z = await ecdh(priv, pcPub);
  const ikm = await subtle.importKey("raw", z, "HKDF", false, ["deriveBits"]);
  const okm = new Uint8Array(
    await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: cat(nA, nB), info: cat(enc.encode("chiispace-session"), enc.encode(dev)) }, ikm, 512),
  );
  const key = (raw: Uint8Array) => subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { up: await key(okm.subarray(0, 32)), down: await key(okm.subarray(32)), raw: okm };
}

const iv = (n: number) => {
  const b = new Uint8Array(12);
  new DataView(b.buffer).setBigUint64(4, BigInt(n));
  return b;
};

export async function seal(key: CryptoKey, n: number, text: string) {
  return b64u(new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: iv(n) }, key, enc.encode(text))));
}

export async function openRaw(key: CryptoKey, n: number, c: string) {
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: iv(n) }, key, unb64u(c)));
}

export async function open(key: CryptoKey, n: number, c: string) {
  return dec.decode(await openRaw(key, n, c));
}
