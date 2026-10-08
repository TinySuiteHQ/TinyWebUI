# TinyWebUI with hybrid document search (BM25 + local embeddings), the
# default. Debian slim rather than Alpine because onnxruntime-node needs glibc.
# The embedding model is fetched once, here at build time, and baked in; the
# running container never downloads anything. retrieval.mode 'auto' (the
# default) finds it and runs hybrid.
#
#   docker build -t tinywebui .
#   docker build --build-arg EMBEDDING_SHA256=<sha256> -t tinywebui .   # pin the model
#
# EMBEDDING_MODEL must match retrieval.model (default 'fast'). For the small
# lexical-only image, build Dockerfile.lexical instead.
FROM node:22-slim

RUN apt-get update \
 && apt-get upgrade -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    TINYWEBUI_CONFIG=/data/tinywebui.config.json \
    TINYWEBUI_DB=/data/tinywebui.db \
    TINYWEBUI_MODELS_DIR=/app/models \
    ORT_DISABLE_TELEMETRY=1

COPY package.json package-lock.json ./
# Optional dependencies (onnxruntime-node, @huggingface/tokenizers) are
# included; --ignore-scripts skips onnxruntime's GPU download, the CPU build
# ships in the package.
# Keep npm/npx for user-configured stdio MCP servers. npm 12.2.0 still bundles
# brace-expansion 5.0.9, so replace it with the patched 5.0.11 release.
RUN npm ci --omit=dev --ignore-scripts \
 && npm install -g npm@12.2.0 --ignore-scripts --no-audit --no-fund \
 && npm pack brace-expansion@5.0.11 --pack-destination /tmp --silent \
 && tar -xzf /tmp/brace-expansion-5.0.11.tgz -C /tmp \
 && rm -rf /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
 && mv /tmp/package /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
 && rm /tmp/brace-expansion-5.0.11.tgz \
 && npm cache clean --force

COPY bin ./bin
COPY src ./src
COPY public ./public

ARG EMBEDDING_MODEL=fast
ARG EMBEDDING_SHA256=
# No config exists at build time (it is created in /data at runtime) and the pull needs none.
RUN env -u TINYWEBUI_CONFIG node bin/tinywebui.js models pull "$EMBEDDING_MODEL" > /tmp/pull.json \
 && node -e "const p=require('/tmp/pull.json'),w=process.env.EMBEDDING_SHA256; \
    if(w&&w.toLowerCase()!==p.sha256){console.error('model checksum mismatch: expected '+w+', got '+p.sha256);process.exit(1)} \
    console.log('embedding model '+p.model+' sha256 '+p.sha256)" \
 && rm /tmp/pull.json

RUN mkdir -p /data /config && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 7777

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:7777/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["node", "bin/tinywebui.js"]
CMD ["start", "--host", "0.0.0.0", "--port", "7777"]
