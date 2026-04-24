FROM node:20-slim

RUN apt-get update && apt-get install -y \
  chromium \
  ffmpeg \
  libnss3 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libgbm1 \
  libasound2 \
  libpango-1.0-0 \
  libcairo2 \
  build-essential \
  && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev

# DIF-002: Cross-browser support. Chromium uses the apt-installed system
# binary; Firefox and WebKit are downloaded with their bundled binaries from
# Playwright's CDN. Adds ~400MB to the image; skip with BUILD_SKIP_FIREFOX_WEBKIT=1
# for chromium-only builds.
ARG BUILD_SKIP_FIREFOX_WEBKIT=0
RUN if [ "$BUILD_SKIP_FIREFOX_WEBKIT" != "1" ]; then \
      npx playwright install firefox webkit; \
    fi

COPY backend/src/ ./src/
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
