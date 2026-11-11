tonic::include_proto!("api/api");

pub const DESCRIPTOR: &[u8] = tonic::include_file_descriptor_set!("api/proto_descriptor");

#[cfg(feature = "json")]
include!(concat!(env!("OUT_DIR"), "/api/api.serde.rs"));
