//! Network attachment and application cryptography. Network data-frame
//! authentication/decryption is performed by the base station's radio stack.
use aes::{
    Aes128,
    cipher::{BlockCipherEncrypt, KeyInit, array::Array},
};
use anyhow::Result;
use cmac::{Cmac, Mac};
use lrwn::EUI64;

pub fn encrypt_block(key: &[u8], block: [u8; 16]) -> Result<Vec<u8>> {
    let cipher =
        Aes128::new_from_slice(key).map_err(|_| anyhow!("AES-128 key must contain 16 bytes"))?;
    let mut block = Array::from(block);
    cipher.encrypt_block(&mut block);
    Ok(block.to_vec())
}

pub fn signature(key: &[u8], iv: &[u8], data: &[u8]) -> Result<[u8; 4]> {
    let mut mac = <Cmac<Aes128> as KeyInit>::new_from_slice(key)
        .map_err(|_| anyhow!("invalid AES-CMAC key"))?;
    mac.update(iv);
    mac.update(data);
    Ok(mac.finalize().into_bytes()[..4].try_into()?)
}

pub fn verify(expected: &[u8], actual: &[u8]) -> Result<()> {
    anyhow::ensure!(expected.len() == actual.len(), "invalid signature length");
    let mut diff = 0u8;
    for (a, b) in expected.iter().zip(actual) {
        diff |= a ^ b;
    }
    anyhow::ensure!(diff == 0, "MIOTY signature mismatch");
    Ok(())
}

pub fn iv(eui: EUI64, prefix: u8, flags: u8, counter: u32, block: u16) -> [u8; 16] {
    let mut iv = [0; 16];
    iv[..8].copy_from_slice(&eui.to_be_bytes());
    iv[8] = prefix;
    iv[9] = flags;
    iv[10..14].copy_from_slice(&counter.to_be_bytes());
    iv[14..].copy_from_slice(&block.to_be_bytes());
    iv
}

pub fn session_key(eui: EUI64, nonce: &[u8], sign: &[u8], key: &[u8]) -> Result<Vec<u8>> {
    anyhow::ensure!(
        nonce.len() == 4 && sign.len() == 4,
        "invalid attachment nonce or signature"
    );
    let mut seed = [0; 16];
    seed[..8].copy_from_slice(&eui.to_be_bytes());
    seed[8..12].copy_from_slice(nonce);
    seed[12..].copy_from_slice(sign);
    encrypt_block(key, seed)
}

fn ctr(eui: EUI64, key: &[u8], counter: u32, down: bool, data: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(data.len());
    for (i, block) in data.chunks(16).enumerate() {
        let seed = encrypt_block(
            key,
            iv(eui, 0, 0x10 | u8::from(down), counter, u16::try_from(i)?),
        )?;
        out.extend(block.iter().zip(seed).map(|(a, b)| a ^ b));
    }
    Ok(out)
}

pub fn encode(
    eui: EUI64,
    key: &[u8],
    mode: i16,
    counter: u32,
    down: bool,
    data: &[u8],
) -> Result<Vec<u8>> {
    if mode == 0 {
        return Ok(data.to_vec());
    }
    anyhow::ensure!(
        [1, 17].contains(&mode),
        "unsupported MIOTY application crypto mode"
    );
    let mut out = ctr(eui, key, counter, down, data)?;
    if mode == 17 {
        out.extend(signature(
            key,
            &iv(eui, 0, 0x10 | u8::from(down), counter, 0xffff),
            &out,
        )?);
    }
    Ok(out)
}

pub fn decode(eui: EUI64, key: &[u8], mode: i16, counter: u32, data: &[u8]) -> Result<Vec<u8>> {
    if mode == 0 {
        return Ok(data.to_vec());
    }
    anyhow::ensure!(
        [1, 17].contains(&mode),
        "unsupported MIOTY application crypto mode"
    );
    let encrypted = if mode == 17 {
        anyhow::ensure!(data.len() >= 4, "MIOTY authentication signature missing");
        let (encrypted, sign) = data.split_at(data.len() - 4);
        verify(
            &signature(key, &iv(eui, 0, 0x10, counter, 0xffff), encrypted)?,
            sign,
        )?;
        encrypted
    } else {
        data
    };
    ctr(eui, key, counter, false, encrypted)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn alliance_application_crypto_vector() {
        // Application Layer Specification 1.1.0, annex 6.4.
        let eui = EUI64::from_be_bytes([0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7]);
        let key = hex::decode("8e31cda1c4cc6e2ea14c32bd0907f468").unwrap();
        let plain = hex::decode("abcdef").unwrap();
        assert_eq!(
            hex::encode(encode(eui, &key, 1, 0, false, &plain).unwrap()),
            "e4fcf8"
        );
        let ciphertext = encode(eui, &key, 17, 0, false, &plain).unwrap();
        assert_eq!(hex::encode(&ciphertext), "e4fcf860e6cc92");
        assert_eq!(decode(eui, &key, 17, 0, &ciphertext).unwrap(), plain);
        let mut tampered = ciphertext.clone();
        tampered[0] ^= 1;
        assert!(decode(eui, &key, 17, 0, &tampered).is_err());
        assert!(decode(eui, &key, 17, 1, &ciphertext).is_err());
    }
}
