FROM node:20-slim

# Install Chromium + all Playwright system deps
RUN apt-get update && apt-get install -y \
  chromium \
  libnss3 \
  libatk-bridge2.0-0 \
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
  && rm -rf /var/lib/apt/lists/*

# Tell Playwright to skip downloading its own browser bundle —
# we'll point it at the system Chromium via PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy package files and install production deps
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src/ ./src/

EXPOSE 3001

# Healthcheck so docker-compose / orchestrators know when backend is ready
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/api/dashboard').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]