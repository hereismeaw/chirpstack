#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
source "$HOME/.cargo/env"
export CARGO_TARGET_DIR="${MIOTY_DEMO_TARGET_DIR:-$HOME/chirpstack-validation/target}"
export CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0
# Embed UI assets in dev builds too; the container has no host source-tree mount.
cargo +1.98.1 build -p chirpstack --locked --no-default-features \
  --features sqlite,rust-embed/debug-embed
bundle=.mioty-demo/context
mkdir -p "$bundle/api" "$bundle/tools/mioty"
cp "$CARGO_TARGET_DIR/debug/chirpstack" "$bundle/chirpstack"
cp tools/mioty/docker/Dockerfile tools/mioty/docker/requirements.txt "$bundle/"
cp -R api/proto "$bundle/api/"
cp tools/mioty/{e2e,simulator,docker_demo,docker_smoke}.py "$bundle/tools/mioty/"
