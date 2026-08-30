FROM node:26-bookworm-slim

ARG BUN_VERSION=1.4.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      postgresql-client \
      sudo \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@9.10.0 --activate

# Bun (API runtime) — pinned for reproducible Cloud Agent builds
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && ln -sf /root/.bun/bin/bun /usr/local/bin/bun

RUN useradd -m -s /bin/bash ubuntu \
    && echo "ubuntu ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

USER ubuntu
WORKDIR /workspace
