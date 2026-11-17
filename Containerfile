# OpenMusic app 镜像：bun 运行时 + 前端构建产物
FROM docker.io/oven/bun:1 AS web-build
WORKDIR /build
COPY vendor/opencode/*.tgz vendor/opencode/
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN bun install
COPY apps/web apps/web
COPY packages/shared packages/shared
RUN cd apps/web && bun run build

FROM docker.io/oven/bun:1-slim
WORKDIR /app
COPY vendor/opencode/*.tgz vendor/opencode/
ARG YT_DLP_VERSION=2026.10.26
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3-venv ca-certificates \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default]==${YT_DLP_VERSION}" Pillow \
    && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
RUN bun install --production
COPY apps/server apps/server
COPY packages/shared packages/shared
COPY --from=web-build /build/apps/web/dist apps/web/dist
ENV NODE_ENV=production
ENV OPENMUSIC_TAG_PYTHON=/opt/yt-dlp/bin/python
EXPOSE 3000
CMD ["bun", "apps/server/src/main.ts"]
