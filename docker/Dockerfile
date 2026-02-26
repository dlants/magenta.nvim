FROM node:24-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    fzf \
    fd-find \
    curl \
    ca-certificates \
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

CMD ["tail", "-f", "/dev/null"]