#!/usr/bin/env bash
# Prefer a local Node.js 26 install over the Cloud Agent image default (often Node 22).
# Sourced by cloud-install.sh, cloud-start.sh, and environment terminals.
NODE26_PREFIX="${NODE26_PREFIX:-$HOME/.local/node-26}"
if [ -x "$NODE26_PREFIX/bin/node" ]; then
  export PATH="$NODE26_PREFIX/bin:$PATH"
fi
