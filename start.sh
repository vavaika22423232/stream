#!/bin/bash
# ===========================================
# Скрипт запуска с Xvfb (без курсора)
# ===========================================

set -e

# Получаем разрешение из переменных окружения
WIDTH=${WIDTH:-1920}
HEIGHT=${HEIGHT:-1080}

echo "[$(date -Iseconds)] Запуск Xvfb на дисплее :99 с разрешением ${WIDTH}x${HEIGHT}..."

# Запускаем Xvfb в фоне (без курсора!)
Xvfb :99 -screen 0 ${WIDTH}x${HEIGHT}x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!

# Ждём запуска Xvfb
sleep 2

# Проверяем что Xvfb запустился
if ! kill -0 $XVFB_PID 2>/dev/null; then
    echo "[$(date -Iseconds)] ОШИБКА: Xvfb не запустился!"
    exit 1
fi

echo "[$(date -Iseconds)] Xvfb запущен (PID: $XVFB_PID)"

# Устанавливаем DISPLAY
export DISPLAY=:99

# Скрываем курсор мыши (перемещаем за экран)
# unclutter не нужен - курсор будет скрыт через xdotool
if command -v xdotool &> /dev/null; then
    xdotool mousemove 99999 99999 2>/dev/null || true
fi

# Запускаем Node.js приложение
echo "[$(date -Iseconds)] Запуск стримера..."
exec node src/index.js
