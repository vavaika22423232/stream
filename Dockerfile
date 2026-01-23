# ===========================================
# YouTube Website Streamer - Dockerfile
# ===========================================
# Образ для 24/7 трансляции сайта на YouTube Live
# через headless браузер + FFmpeg
# ===========================================

# Используем официальный Node.js образ с Debian
FROM node:20-bookworm-slim

# Метаданные
LABEL maintainer="YouTube Website Streamer"
LABEL description="24/7 website streaming to YouTube Live"

# Переменные окружения
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    # Отключаем sandbox для Docker
    CHROME_DEVEL_SANDBOX=/usr/local/sbin/chrome-devel-sandbox

# Установка зависимостей системы
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Chromium и зависимости
    chromium \
    chromium-sandbox \
    # Шрифты для корректного рендеринга
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-noto-cjk \
    fonts-freefont-ttf \
    # FFmpeg для кодирования видео
    ffmpeg \
    # Утилиты
    ca-certificates \
    dumb-init \
    procps \
    # Очистка кеша
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Создаём непривилегированного пользователя
RUN groupadd -r streamer && useradd -r -g streamer -G audio,video streamer \
    && mkdir -p /home/streamer/app \
    && chown -R streamer:streamer /home/streamer

# Рабочая директория
WORKDIR /home/streamer/app

# Копируем package.json и package-lock.json, устанавливаем зависимости
COPY --chown=streamer:streamer package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Копируем исходный код
COPY --chown=streamer:streamer src/ ./src/

# Переключаемся на непривилегированного пользователя
USER streamer

# Healthcheck - проверяем что процесс node работает
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD pgrep -x node > /dev/null || exit 1

# Используем dumb-init для корректной обработки сигналов
ENTRYPOINT ["dumb-init", "--"]

# Запускаем приложение
CMD ["node", "src/index.js"]
