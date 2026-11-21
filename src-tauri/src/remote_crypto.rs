//! 폰과 PC 사이의 암호. 폰 쪽 짝은 ui/phone-crypto.ts 이고 규칙은 거기 적었다 — 두 쪽이 같은 값을 내는지는 같은 시험값으로 본다.
//! 중계(Cloudflare)는 이 키를 모른다. 지나가는 것은 짝짓기 때의 공개키·난수와 암호문뿐이다.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64U;
use base64::Engine as _;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use sha2::{Digest, Sha256};

pub fn b64u(b: &[u8]) -> String {
    B64U.encode(b)
}

pub fn unb64u(s: &str) -> Option<Vec<u8>> {
    B64U.decode(s.trim_end_matches('=')).ok()
}

pub fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(|e| format!("난수를 못 얻었다: {e}"))?;
    Ok(b)
}

/// PC 의 키. 짝지은 폰마다 이 키의 공개키를 들고 있으므로 바꾸면 폰을 다시 짝지어야 한다.
pub fn new_secret() -> Result<SecretKey, String> {
    loop {
        if let Ok(k) = SecretKey::from_slice(&random::<32>()?) {
            return Ok(k);
        }
    }
}

pub fn secret_from(bytes: &[u8]) -> Option<SecretKey> {
    SecretKey::from_slice(bytes).ok()
}

pub fn public_of(k: &SecretKey) -> Vec<u8> {
    k.public_key().to_encoded_point(false).as_bytes().to_vec()
}

/// 상대 공개키가 곡선 위의 점인지까지 본다. 아니면 None.
pub fn parse_public(raw: &[u8]) -> Option<PublicKey> {
    (raw.len() == 65).then(|| PublicKey::from_sec1_bytes(raw).ok()).flatten()
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// 기기 묶음의 소개장. 묶인 다른 PC 가 이 PC 의 방에 새 기기(폰)를 들일 때 붙인다. 열쇠는 두 PC 가 이을 때 이 PC 가 그 PC 에
/// 준 것이라, 그 PC 만 만들 수 있고 이 PC 는 열쇠로 확인만 한다. 방·기기 id·공개키·이름을 다 묶어 하나라도 바꾸면 안 맞는다.
fn invite_hmac(key: &[u8], room: &str, dev: &str, public: &str, name: &str) -> Hmac<Sha256> {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC 은 어느 길이의 키든 받는다");
    m.update(format!("chiispace-invite
{room}
{dev}
{public}
{name}").as_bytes());
    m
}

pub fn invite_mac(key: &[u8], room: &str, dev: &str, public: &str, name: &str) -> Vec<u8> {
    invite_hmac(key, room, dev, public, name).finalize().into_bytes().to_vec()
}

/// 소개장이 맞는가. 견주기는 걸린 시간으로 새지 않게 한다.
pub fn invite_ok(key: &[u8], room: &str, dev: &str, public: &str, name: &str, mac: &[u8]) -> bool {
    invite_hmac(key, room, dev, public, name).verify_slice(mac).is_ok()
}

pub fn commit_of(phone_pub: &[u8], na: &[u8]) -> [u8; 32] {
    sha256(&[phone_pub, na])
}

/// 두 화면에 보일 여섯 자리. 두 공개키와 두 난수를 다 묶는다.
pub fn sas_of(phone_pub: &[u8], pc_pub: &[u8], na: &[u8], nb: &[u8]) -> String {
    let h = sha256(&[b"chiispace-sas", phone_pub, pc_pub, na, nb]);
    format!("{:06}", u32::from_be_bytes([h[0], h[1], h[2], h[3]]) % 1_000_000)
}

/// 이번 연결의 방향별 키. 앞 32바이트가 폰→PC(`up`), 뒤가 PC→폰(`down`).
pub struct Keys {
    pub up: Aes256Gcm,
    pub down: Aes256Gcm,
    #[cfg(test)]
    raw: [u8; 64],
}

pub fn session_keys(own: &SecretKey, other: &PublicKey, na: &[u8], nb: &[u8], dev: &str) -> Keys {
    let z = p256::ecdh::diffie_hellman(own.to_nonzero_scalar(), other.as_affine());
    let salt = [na, nb].concat();
    let hk = Hkdf::<Sha256>::new(Some(&salt), z.raw_secret_bytes());
    let mut okm = [0u8; 64];
    hk.expand(&[b"chiispace-session".as_slice(), dev.as_bytes()].concat(), &mut okm).expect("64바이트는 HKDF 한도 안이다");
    Keys {
        up: Aes256Gcm::new_from_slice(&okm[..32]).expect("32바이트 키"),
        down: Aes256Gcm::new_from_slice(&okm[32..]).expect("32바이트 키"),
        #[cfg(test)]
        raw: okm,
    }
}

fn iv(n: u64) -> [u8; 12] {
    let mut b = [0u8; 12];
    b[4..].copy_from_slice(&n.to_be_bytes());
    b
}

pub fn seal(key: &Aes256Gcm, n: u64, plain: &[u8]) -> String {
    b64u(&key.encrypt(Nonce::from_slice(&iv(n)), plain).expect("AES-GCM 암호화는 실패하지 않는다"))
}

pub fn open(key: &Aes256Gcm, n: u64, c: &str) -> Option<Vec<u8>> {
    key.decrypt(Nonce::from_slice(&iv(n)), unb64u(c)?.as_slice()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ui/phone-crypto.ts 쪽 시험(remote.test.mjs)과 같은 값. Node 의 crypto 로 따로 계산해 둔 것이다.
    const PHONE_PUB: &str = "BAIX5hfwtkQ5KCePlpmeaaI6TywVK99tbN9m5bgCgtTtGUp968uXcS0t2jyoWqh2Wlb0X8dYWZZS8ol8ZTBuV5Q";
    const PC_PUB: &str = "BNZak5d8qj0bCBhS_1ennkZfFmBXcwS66tUF3TpIWJzzUBheiVNy32Ih6joTdVfkc_3bZ1XwW9UHw8Uz_OnJEoU";

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn the_same_numbers_as_the_phone() {
        let phone = secret_from(&[0x11; 32]).unwrap();
        let pc = secret_from(&[0x22; 32]).unwrap();
        assert_eq!(b64u(&public_of(&phone)), PHONE_PUB);
        assert_eq!(b64u(&public_of(&pc)), PC_PUB);
        let (na, nb) = ([0xaa; 16], [0xbb; 16]);
        let phone_pub = public_of(&phone);
        let pc_pub = public_of(&pc);
        assert_eq!(b64u(&commit_of(&phone_pub, &na)), "E9oHB8Ni0IrtYIZSzH3yyq94cGa8u3y6TR4QKuoCHN0");
        assert_eq!(sas_of(&phone_pub, &pc_pub, &na, &nb), "816604");
        let keys = session_keys(&pc, &parse_public(&phone_pub).unwrap(), &na, &nb, "0123456789abcdef");
        assert_eq!(hex(&keys.raw[..32]), "b798196ef38dc56fce438a6813fffcaccf4bf9745a1e62951bde0067cae5d8b1");
        assert_eq!(hex(&keys.raw[32..]), "ed1393d272fddb9aae3d984867155d22423dbfa5f5d8a0cbafff03b5e881cdc5");
        // 폰이 보낸 것을 PC 가 풀고, PC 가 보낸 것은 폰과 같은 암호문이다.
        assert_eq!(open(&keys.up, 0, "1ofJnyf65KeJedF6yXZxCMXDTj7pH4ypYG-SiSgiPQiNT1RH").unwrap(), br#"{"t":"invoke","i":1}"#);
        assert_eq!(seal(&keys.down, 7, br#"{"t":"ev"}"#), "mg5Tvypfk8JxNu1wyXT5nk9n6HzzaGUyZJk");
    }

    #[test]
    fn a_frame_opens_only_with_its_key_and_number() {
        let pc = new_secret().unwrap();
        let phone = new_secret().unwrap();
        let keys = session_keys(&pc, &phone.public_key(), &[1; 16], &[2; 16], "dev");
        let c = seal(&keys.down, 3, b"hi");
        assert_eq!(open(&keys.down, 3, &c).unwrap(), b"hi");
        assert!(open(&keys.down, 4, &c).is_none(), "다른 순번");
        assert!(open(&keys.up, 3, &c).is_none(), "다른 방향");
        let other = session_keys(&pc, &phone.public_key(), &[1; 16], &[3; 16], "dev");
        assert!(open(&other.down, 3, &c).is_none(), "다른 연결");
        let mut bad = unb64u(&c).unwrap();
        bad[0] ^= 1;
        assert!(open(&keys.down, 3, &b64u(&bad)).is_none(), "바뀐 암호문");
        assert!(parse_public(&[4; 65]).is_none(), "곡선 밖의 점");
        assert!(parse_public(&public_of(&pc)[..64]).is_none());
    }
}
