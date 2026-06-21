FROM node:20-alpine

# Install FFmpeg (video thumbnails) + build tools for native addons (sharp)
RUN apk add --no-cache \
    ffmpeg \
    vips \
    python3 \
    make \
    g++

WORKDIR /app

COPY package*.json ./
RUN npm install --only=production && apk del python3 make g++

COPY src/ ./src/

RUN mkdir -p /storage

EXPOSE 5000

CMD ["node", "src/index.js"]
