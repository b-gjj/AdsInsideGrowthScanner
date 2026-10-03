# Playwright's official image ships Chromium + all system libraries, so nothing is installed by hand.
FROM mcr.microsoft.com/playwright:v1.62.0-noble
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY config ./config
COPY public ./public
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
