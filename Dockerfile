# TinyWebUI: small, auditable runtime. Config comes in read-only at /config,
# data lives in /data, secrets come from the environment.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    TINYWEBUI_CONFIG=/config/tinywebui.config.js \
    TINYWEBUI_DB=/data/tinywebui.db

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY bin ./bin
COPY src ./src
COPY public ./public

RUN mkdir -p /data /config && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 7777

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:7777/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["node", "bin/tinywebui.js"]
CMD ["start", "--host", "0.0.0.0", "--port", "7777"]
