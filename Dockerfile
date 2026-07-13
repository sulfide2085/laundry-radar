FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

COPY package.json server.mjs ./
COPY public ./public

RUN mkdir -p data && chown -R node:node /app/data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

USER node

CMD ["node", "server.mjs"]
