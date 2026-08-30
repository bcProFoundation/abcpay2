FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      postgresql \
      postgresql-client \
      sudo \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@9.10.0 --activate

# Bun (API runtime)
RUN curl -fsSL https://bun.sh/install | bash \
    && ln -sf /root/.bun/bin/bun /usr/local/bin/bun

RUN useradd -m -s /bin/bash ubuntu \
    && echo "ubuntu ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

USER ubuntu
WORKDIR /workspace
