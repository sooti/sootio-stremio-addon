# Use an official Node.js Alpine image
FROM node:20-alpine3.21

# Set working directory inside container
WORKDIR /app

# Install git, build tools, and Chromium for Puppeteer stealth browser (BTDigg)
RUN apk add --no-cache \
    git \
    curl \
    python3 \
    make \
    g++ \
    sqlite \
    sqlite-dev \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Tell Puppeteer to skip downloading its own Chromium (incompatible with Alpine/musl)
# and use the system-installed one instead
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

# Copy only dependency files first (better layer caching)
COPY package*.json ./
COPY pnpm-lock.yaml ./

# Install pnpm and then dependencies
RUN npm install -g pnpm@9 && pnpm install --no-frozen-lockfile

# Copy rest of the project files
COPY . .

# Expose app port (keep whatever your app actually listens on)
EXPOSE 55771

# Start the dev / app server
CMD ["npm", "run", "start"]
