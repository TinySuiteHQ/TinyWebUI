# TinyWebUI with hybrid document search (BM25 + local embeddings), the
# default. Debian slim rather than Alpine because onnxruntime-node needs glibc.
# The embedding model is fetched once, here at build time, and baked in; the
# running container downloads nothing for it (the bundled MCP servers are
# fetched by uv on their first start). retrieval.mode 'auto' (the
# default) finds it and runs hybrid.
#
#   docker build -t tinywebui .
#   docker build --build-arg EMBEDDING_SHA256=<sha256> -t tinywebui .   # pin the model
#
# EMBEDDING_MODEL must match retrieval.model (default 'fast'). For the small
# lexical-only image, build Dockerfile.lexical instead.
# The page: Vite builds web/ into dist/. Its own stage, so the dev
# dependencies it needs never reach the image. Not --omit=optional: Vite's
# bundler ships its native binary as an optional dependency.
FROM node:22.23.3-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY shared ./shared
COPY web ./web
RUN npm run build:web

FROM node:22.23.3-slim AS build
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# Optional dependencies (onnxruntime-node, @huggingface/tokenizers) are
# included; --ignore-scripts skips onnxruntime's GPU download, the CPU build
# ships in the package.
#
# onnxruntime-node ships its runtime for every OS and CPU (~290 MB) and loads
# only bin/napi-v6/<platform>/<arch>: the rest goes, as do type declarations
# and source maps, which nothing reads at run time. process.arch is the
# target's, under buildx emulation too.
RUN npm ci --omit=dev --ignore-scripts \
 && ort=node_modules/onnxruntime-node/bin/napi-v6 \
 && find "$ort" -mindepth 1 -maxdepth 1 ! -name linux -exec rm -rf {} + \
 && find "$ort/linux" -mindepth 1 -maxdepth 1 ! -name "$(node -p process.arch)" -exec rm -rf {} + \
 && find node_modules -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' \) -delete

COPY bin ./bin
COPY server ./server
COPY shared ./shared
COPY --from=web /app/dist ./dist

ARG EMBEDDING_MODEL=fast
ARG EMBEDDING_SHA256=
# No config exists at build time (it is created in /data at runtime) and the pull needs none.
RUN env -u TINYWEBUI_CONFIG node bin/tinywebui.ts models pull "$EMBEDDING_MODEL" > /tmp/pull.json \
 && node -e "const p=require('/tmp/pull.json'),w=process.env.EMBEDDING_SHA256; \
    if(w&&w.toLowerCase()!==p.sha256){console.error('model checksum mismatch: expected '+w+', got '+p.sha256);process.exit(1)} \
    console.log('embedding model '+p.model+' sha256 '+p.sha256)" \
 && rm /tmp/pull.json

FROM node:22.23.3-slim

# ca-certificates: the bundled MCP servers' model downloads (hf-xet) verify
# TLS against the system's roots, and slim ships none.
# npm, corepack, Yarn and Node's C headers come with the base image and
# nothing here uses them. Deleting them does not shrink the image (they stay
# in the base layer), but scanners stop flagging what they bundle.
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
            /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/include \
 && mkdir -p /data /config \
 && chown node:node /data

WORKDIR /app
ENV NODE_ENV=production \
    TINYWEBUI_CONFIG=/data/tinywebui.config.json \
    TINYWEBUI_DB=/data/tinywebui.db \
    TINYWEBUI_MODELS_DIR=/app/models \
    ORT_DISABLE_TELEMETRY=1

COPY --from=build /app /app
# uv runs the bundled MCP servers (TinySearch, TinyContext): uvx fetches each
# server and a Python for it on first start. Both are kept in /data, so they
# are downloaded once per volume, not once per container.
COPY --from=ghcr.io/astral-sh/uv:0.12.0 /uv /uvx /usr/local/bin/
ENV UV_CACHE_DIR=/data/uv/cache \
    UV_PYTHON_INSTALL_DIR=/data/uv/python

USER node
VOLUME ["/data"]
EXPOSE 7777

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:7777/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# node:sqlite is stable in all but name on Node 22; its warning on every start is noise.
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "bin/tinywebui.ts"]
CMD ["start", "--host", "0.0.0.0", "--port", "7777"]
