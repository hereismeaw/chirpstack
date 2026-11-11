//! BSSCI 1.0.0 framing and encoding (mioty Alliance specification, §5.1).
use anyhow::{Context, Result};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const MAGIC: &[u8; 8] = b"MIOTYB01";

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Encoding {
    Json,
    MessagePack,
}

pub async fn read<R: AsyncRead + Unpin>(
    reader: &mut R,
    max_size: usize,
) -> Result<(Value, Encoding)> {
    let mut header = [0u8; 12];
    reader.read_exact(&mut header).await?;
    anyhow::ensure!(&header[..8] == MAGIC, "invalid BSSCI frame identifier");
    let size = u32::from_le_bytes(header[8..].try_into()?) as usize;
    anyhow::ensure!(size > 0 && size <= max_size, "invalid BSSCI frame size");
    let mut payload = vec![0; size];
    reader.read_exact(&mut payload).await?;
    let encoding = if payload.iter().find(|b| !b.is_ascii_whitespace()) == Some(&b'{') {
        Encoding::Json
    } else {
        Encoding::MessagePack
    };
    let value = match encoding {
        Encoding::Json => serde_json::from_slice(&payload)?,
        Encoding::MessagePack => {
            let mut cursor = std::io::Cursor::new(&payload);
            let value = rmpv::decode::read_value(&mut cursor)?;
            anyhow::ensure!(cursor.position() == size as u64, "trailing BSSCI payload");
            to_json(value)?
        }
    };
    anyhow::ensure!(value.is_object(), "BSSCI message must be an object");
    Ok((value, encoding))
}

fn to_json(value: rmpv::Value) -> Result<Value> {
    Ok(match value {
        rmpv::Value::Nil => Value::Null,
        rmpv::Value::Boolean(v) => v.into(),
        rmpv::Value::Integer(v) => {
            if let Some(v) = v.as_u64() {
                v.into()
            } else {
                v.as_i64().context("integer outside BSSCI range")?.into()
            }
        }
        rmpv::Value::F32(v) => json!(v),
        rmpv::Value::F64(v) => json!(v),
        rmpv::Value::String(v) => v.as_str().context("invalid BSSCI UTF-8")?.into(),
        rmpv::Value::Binary(v) => json!(v),
        rmpv::Value::Array(v) => Value::Array(v.into_iter().map(to_json).collect::<Result<_>>()?),
        rmpv::Value::Map(v) => Value::Object(
            v.into_iter()
                .map(|(k, v)| {
                    Ok((
                        k.as_str()
                            .context("BSSCI map key must be text")?
                            .to_string(),
                        to_json(v)?,
                    ))
                })
                .collect::<Result<_>>()?,
        ),
        rmpv::Value::Ext(_, _) => anyhow::bail!("BSSCI MessagePack extensions are unsupported"),
    })
}

pub async fn write<W: AsyncWrite + Unpin>(
    writer: &mut W,
    value: &Value,
    encoding: Encoding,
) -> Result<()> {
    let payload = match encoding {
        Encoding::Json => serde_json::to_vec(value)?,
        Encoding::MessagePack => rmp_serde::to_vec_named(value)?,
    };
    let size = u32::try_from(payload.len())?;
    writer.write_all(MAGIC).await?;
    writer.write_all(&size.to_le_bytes()).await?;
    writer.write_all(&payload).await?;
    writer.flush().await?;
    Ok(())
}

pub fn uint(value: &Value, name: &str) -> Result<u64> {
    value
        .get(name)
        .and_then(Value::as_u64)
        .with_context(|| format!("invalid or missing {name}"))
}
pub fn int(value: &Value, name: &str) -> Result<i64> {
    value
        .get(name)
        .and_then(Value::as_i64)
        .with_context(|| format!("invalid or missing {name}"))
}
pub fn boolean(value: &Value, name: &str) -> Result<bool> {
    value
        .get(name)
        .and_then(Value::as_bool)
        .with_context(|| format!("invalid or missing {name}"))
}
pub fn bytes(value: &Value, name: &str, size: Option<usize>) -> Result<Vec<u8>> {
    let values = value
        .get(name)
        .and_then(Value::as_array)
        .with_context(|| format!("invalid or missing {name}"))?;
    if let Some(size) = size {
        anyhow::ensure!(values.len() == size, "invalid {name} length");
    }
    values
        .iter()
        .map(|v| {
            u8::try_from(v.as_u64().context("BSSCI byte must be unsigned")?)
                .context("BSSCI byte exceeds 255")
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn specification_derived_ping_frames() {
        // Synthetic fixtures derived from BSSCI rev1 sections 5.1 and 5.4.1,
        // not captured vendor traffic: exact 12-byte header + standard encodings.
        let json = b"MIOTYB01\x1b\0\0\0{\"command\":\"ping\",\"opId\":1}";
        let msgpack = b"MIOTYB01\x14\0\0\0\x82\xa7command\xa4ping\xa4opId\x01";
        for (frame, encoding) in [
            (json.as_slice(), Encoding::Json),
            (msgpack.as_slice(), Encoding::MessagePack),
        ] {
            let (value, detected) = read(&mut &frame[..], 1024).await.unwrap();
            assert_eq!(value, json!({"command":"ping", "opId":1}));
            assert_eq!(detected, encoding);
            let mut output = Vec::new();
            write(&mut output, &value, encoding).await.unwrap();
            assert_eq!(output, frame);
        }
    }
    #[tokio::test]
    async fn round_trip_encodings_and_full_range_eui() {
        for encoding in [Encoding::Json, Encoding::MessagePack] {
            let input = json!({"command":"con", "opId":0, "bsEui":u64::MAX, "snBsUuid":[0,1,2]});
            let mut buffer = Vec::new();
            write(&mut buffer, &input, encoding).await.unwrap();
            assert_eq!(&buffer[..8], MAGIC);
            assert_eq!(
                u32::from_le_bytes(buffer[8..12].try_into().unwrap()) as usize,
                buffer.len() - 12
            );
            let (decoded, detected) = read(&mut buffer.as_slice(), 4096).await.unwrap();
            assert_eq!(input, decoded);
            assert_eq!(encoding, detected);
        }
    }
    #[tokio::test]
    async fn rejects_bad_headers_and_bounds_before_allocating() {
        let mut oversized = b"MIOTYB01".to_vec();
        oversized.extend(u32::MAX.to_le_bytes());
        assert!(read(&mut oversized.as_slice(), 1024).await.is_err());
        assert!(read(&mut &b"wrongmagic!!"[..], 1024).await.is_err());
    }
}
