FROM node:24-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    fzf \
    fd-find \
    curl \
    ca-certificates \
    rsync \
  && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (for docker-in-docker via socket mount)
RUN install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
     > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli \
  && rm -rf /var/lib/apt/lists/*

# Install Neovim stable (arch-aware)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ]; then NVIM_ARCH="arm64"; else NVIM_ARCH="x86_64"; fi && \
    curl -fsSL "https://github.com/neovim/neovim/releases/download/stable/nvim-linux-${NVIM_ARCH}.tar.gz" \
    | tar xz -C /usr/local --strip-components=1

# Install typescript-language-server globally
RUN npm install -g typescript-language-server typescript

# Build tree-sitter TypeScript parser
RUN git clone --depth 1 https://github.com/tree-sitter/tree-sitter-typescript /tmp/tree-sitter-typescript \
  && cd /tmp/tree-sitter-typescript \
  && cc -shared -fPIC -O2 -I typescript/src typescript/src/parser.c typescript/src/scanner.c -o typescript.so \
  && mkdir -p /root/.local/share/nvim/parser \
  && cp typescript.so /root/.local/share/nvim/parser/ \
  && rm -rf /tmp/tree-sitter-typescript

# Configure git so the agent can commit
RUN git config --global user.name "magenta-agent" \
  && git config --global user.email "magenta-agent@localhost"

WORKDIR /workspace

# Install deps first (cached when lockfile unchanged)
COPY package.json package-lock.json ./
COPY node/server/package.json node/server/
RUN --mount=type=cache,target=/root/.npm npm ci

# Copy project files
COPY . .

CMD ["tail", "-f", "/dev/null"]
