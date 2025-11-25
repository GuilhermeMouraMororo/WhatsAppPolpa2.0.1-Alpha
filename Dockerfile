FROM node:18-bullseye

# Install all system dependencies needed for Puppeteer and Chromium
RUN apt-get update \
    && apt-get install -y \
        chromium \
        fonts-freefont-ttf \
        libxss1 \
        --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the system-installed Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

CMD ["npm", "start"]
