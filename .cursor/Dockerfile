# Node 26.12.1 — Oct 21 2026 security release (CVE-2026-111497 et al.)
FROM node:26.12.1-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      postgresql-client \
      sudo \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g corepack@latest \
    && corepack enable \
    && corepack prepare pnpm@9.10.0 --activate

RUN useradd -m -s /bin/bash ubuntu \
    && echo "ubuntu ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

USER ubuntu
WORKDIR /workspace
