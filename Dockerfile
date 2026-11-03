FROM node:20-slim

# Quiet apt: no debconf prompts/warnings, no per-package progress in build logs
ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update -qq && apt-get install -y -qq \
    git \
    curl \
    ssh \
    python3 \
    make \
    g++ \
    jq \
    > /dev/null && rm -rf /var/lib/apt/lists/*

# gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg status=none \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update -qq && apt-get install -y -qq gh > /dev/null && rm -rf /var/lib/apt/lists/*

# Runtime folders, owned by the node user: ~/.claude (only .credentials.json is mounted from the host; other files
# stay in the container), the task work dir, the data volume and the app dir
RUN mkdir -p /home/node/.claude /tmp/work /data /app \
    && chown -R node:node /home/node /tmp/work /data /app

# Claude Code. CI passes the current npm version so only this layer rebuilds when a new release ships.
# Claude runs as non-root but needs to install tools dynamically (npm, pip, gem, etc.), so node owns /usr/local and
# /opt; in a container that's safe. The chown is in the same layer as the install so it doesn't copy /usr/local again.
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g --no-fund --no-audit --loglevel=error @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && chown -R node:node /usr/local /opt

# Add user-local bin paths for tools that default to home directory (cargo, go, bun, etc.)
ENV PATH=/home/node/.local/bin:/home/node/.cargo/bin:/home/node/go/bin:/home/node/.bun/bin:$PATH

USER node

# Git config for commits (as node user)
RUN git config --global user.email "noreply@anthropic.com" \
    && git config --global user.name "Claude"

# The app last: a code change only rebuilds the layers from here on. Installing and copying as node means no
# chown -R afterwards, which would copy node_modules into a new layer on every deploy.
WORKDIR /app
COPY --chown=node:node package.json ./
RUN npm install --no-fund --no-audit --loglevel=error
COPY --chown=node:node src ./src

EXPOSE 3000
CMD ["node", "src/server.js"]
