/**
 * YouTube Website Streamer
 * 
 * 24/7 автоматическая трансляция сайта на YouTube Live
 * через headless браузер (Puppeteer) + FFmpeg
 * 
 * Архитектура:
 * 1. Puppeteer открывает сайт в headless режиме (1920x1080)
 * 2. Скриншоты браузера передаются в FFmpeg через pipe
 * 3. FFmpeg кодирует видеопоток и отправляет на YouTube через RTMP
 * 4. Автоматический перезапуск при любых сбоях
 */

const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ==================== КОНФИГУРАЦИЯ ====================

const CONFIG = {
  // URL сайта для трансляции
  TARGET_URL: process.env.TARGET_URL || 'https://neptun.in.ua',
  
  // YouTube RTMP настройки
  YOUTUBE_RTMP_URL: process.env.YOUTUBE_RTMP_URL || 'rtmp://a.rtmp.youtube.com/live2',
  STREAM_KEY: process.env.STREAM_KEY,
  
  // Разрешение видео (Full HD 1080p с CDP Screencast)
  WIDTH: parseInt(process.env.WIDTH) || 1920,
  HEIGHT: parseInt(process.env.HEIGHT) || 1080,
  
  // FPS трансляции (24 fps - плавное видео с CDP)
  FPS: parseInt(process.env.FPS) || 24,
  
  // Битрейт видео (в kbps)
  VIDEO_BITRATE: process.env.VIDEO_BITRATE || '4500k',
  
  // Интервал между скриншотами (мс) = 1000 / FPS
  get FRAME_INTERVAL() {
    return Math.floor(1000 / this.FPS);
  },
  
  // Таймаут перезапуска при ошибке (мс)
  RESTART_DELAY: parseInt(process.env.RESTART_DELAY) || 5000,
  
  // Интервал обновления страницы для предотвращения утечек памяти (мс)
  PAGE_REFRESH_INTERVAL: parseInt(process.env.PAGE_REFRESH_INTERVAL) || 3600000, // 1 час
  
  // Путь к фоновой музыке (mp3)
  MUSIC_PATH: process.env.MUSIC_PATH || path.join(__dirname, '..', 'music', 'background.mp3'),
  
  // Громкость музыки (0.0 - 1.0)
  MUSIC_VOLUME: parseFloat(process.env.MUSIC_VOLUME) || 0.3,
};

// ==================== ЛОГИРОВАНИЕ ====================

/**
 * Форматированное логирование с таймстампом
 */
const log = {
  info: (message, ...args) => {
    console.log(`[${new Date().toISOString()}] [INFO] ${message}`, ...args);
  },
  error: (message, ...args) => {
    console.error(`[${new Date().toISOString()}] [ERROR] ${message}`, ...args);
  },
  warn: (message, ...args) => {
    console.warn(`[${new Date().toISOString()}] [WARN] ${message}`, ...args);
  },
  debug: (message, ...args) => {
    if (process.env.DEBUG) {
      console.log(`[${new Date().toISOString()}] [DEBUG] ${message}`, ...args);
    }
  }
};

// ==================== ВАЛИДАЦИЯ ====================

/**
 * Проверка обязательных переменных окружения
 */
function validateConfig() {
  if (!CONFIG.STREAM_KEY) {
    throw new Error('STREAM_KEY не установлен! Добавьте переменную окружения STREAM_KEY');
  }
  
  log.info('Конфигурация валидна');
  log.info(`URL: ${CONFIG.TARGET_URL}`);
  log.info(`Разрешение: ${CONFIG.WIDTH}x${CONFIG.HEIGHT}`);
  log.info(`FPS: ${CONFIG.FPS}`);
  log.info(`Битрейт: ${CONFIG.VIDEO_BITRATE}`);
}

// ==================== КЛАСС СТРИМЕРА ====================

class WebsiteStreamer {
  constructor() {
    this.browser = null;
    this.page = null;
    this.cdpSession = null;
    this.ffmpeg = null;
    this.isRunning = false;
    this.frameCount = 0;
    this.lastRefreshTime = Date.now();
  }

  /**
   * Запуск headless браузера
   */
  async startBrowser() {
    log.info('Запуск браузера...');
    
    this.browser = await puppeteer.launch({
      headless: 'new', // Новый headless режим Puppeteer
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process', // Важно для Docker/Render
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        '--disable-translate',
        '--mute-audio',
        `--window-size=${CONFIG.WIDTH},${CONFIG.HEIGHT}`,
      ],
      defaultViewport: {
        width: CONFIG.WIDTH,
        height: CONFIG.HEIGHT,
      },
    });

    this.page = await this.browser.newPage();
    
    // Устанавливаем User-Agent
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Блокируем диалоги
    this.page.on('dialog', async (dialog) => {
      log.debug(`Диалог заблокирован: ${dialog.message()}`);
      await dialog.dismiss();
    });

    // Обработка ошибок страницы
    this.page.on('error', (error) => {
      log.error('Ошибка страницы:', error.message);
    });

    this.page.on('pageerror', (error) => {
      log.debug('JS ошибка на странице:', error.message);
    });

    log.info('Браузер запущен');
  }

  /**
   * Загрузка целевого сайта
   */
  async loadPage() {
    log.info(`Загрузка страницы: ${CONFIG.TARGET_URL}`);
    
    try {
      await this.page.goto(CONFIG.TARGET_URL, {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });
      
      // Ждём полную загрузку
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      log.info('Страница загружена');
      this.lastRefreshTime = Date.now();
    } catch (error) {
      log.error('Ошибка загрузки страницы:', error.message);
      throw error;
    }
  }

  /**
   * Периодическое обновление страницы для предотвращения утечек памяти
   */
  async refreshPageIfNeeded() {
    const timeSinceRefresh = Date.now() - this.lastRefreshTime;
    
    if (timeSinceRefresh >= CONFIG.PAGE_REFRESH_INTERVAL) {
      log.info('Обновление страницы для предотвращения утечек памяти...');
      await this.loadPage();
    }
  }

  /**
   * Получить аргументы FFmpeg для аудио входа
   * Если есть музыкальный файл - используем его, иначе тишина
   */
  getAudioInputArgs() {
    const musicExists = fs.existsSync(CONFIG.MUSIC_PATH);
    
    if (musicExists) {
      log.info(`Используем фоновую музыку: ${CONFIG.MUSIC_PATH}`);
      return [
        '-stream_loop', '-1',           // Бесконечный цикл музыки
        '-i', CONFIG.MUSIC_PATH,        // Путь к mp3 файлу
      ];
    } else {
      log.info('Музыкальный файл не найден, используем тишину');
      return [
        '-f', 'lavfi',
        '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      ];
    }
  }

  /**
   * Запуск FFmpeg процесса
   * 
   * FFmpeg принимает последовательность JPEG изображений через stdin
   * и кодирует их в H.264 видеопоток для YouTube
   */
  startFFmpeg() {
    log.info('Запуск FFmpeg...');
    
    const rtmpUrl = `${CONFIG.YOUTUBE_RTMP_URL}/${CONFIG.STREAM_KEY}`;
    
    log.info(`RTMP URL: ${CONFIG.YOUTUBE_RTMP_URL}/****`);
    
    // FFmpeg аргументы для стриминга на YouTube
    const ffmpegArgs = [
      // Глобальные параметры
      '-y',                           // Перезаписывать выходные файлы
      '-loglevel', 'info',            // Полное логирование
      
      // Вход 1: Видео из stdin (JPEG кадры)
      '-f', 'image2pipe',             // Формат входа - последовательность изображений
      '-vcodec', 'mjpeg',             // Входной кодек - MJPEG
      '-framerate', String(CONFIG.FPS), // Входной FPS
      '-probesize', '32',             // Минимальный размер для анализа
      '-analyzeduration', '0',        // Не анализировать длительность
      '-i', 'pipe:0',                 // Читать из stdin
      
      // Вход 2: Аудио (музыка или тишина)
      ...this.getAudioInputArgs(),
      
      // Кодирование видео
      '-c:v', 'libx264',              // H.264 кодек
      '-preset', 'ultrafast',         // Самый быстрый пресет для realtime
      '-tune', 'zerolatency',         // Оптимизация для низкой задержки
      '-pix_fmt', 'yuv420p',          // Формат пикселей для совместимости
      '-g', String(CONFIG.FPS * 2),   // GOP размер = 2 секунды
      '-b:v', CONFIG.VIDEO_BITRATE,   // Битрейт видео
      '-maxrate', CONFIG.VIDEO_BITRATE, // Максимальный битрейт
      '-bufsize', `${parseInt(CONFIG.VIDEO_BITRATE) * 2}k`, // Размер буфера
      
      // Кодирование аудио
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      
      // Маппинг потоков
      '-map', '0:v',                  // Видео из первого входа
      '-map', '1:a',                  // Аудио из второго входа
      
      // Выходные параметры
      '-f', 'flv',                    // FLV формат для RTMP
      rtmpUrl,                        // RTMP URL с ключом
    ];

    log.debug('FFmpeg команда:', 'ffmpeg', ffmpegArgs.join(' '));

    this.ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Обработка stdout FFmpeg
    this.ffmpeg.stdout.on('data', (data) => {
      log.debug('FFmpeg stdout:', data.toString());
    });

    // Обработка stderr FFmpeg (основной вывод)
    this.ffmpeg.stderr.on('data', (data) => {
      const message = data.toString().trim();
      // Показываем ВСЕ сообщения FFmpeg для отладки
      if (message) {
        log.info('FFmpeg:', message);
      }
    });

    // Обработка завершения FFmpeg
    this.ffmpeg.on('close', (code) => {
      log.warn(`FFmpeg завершился с кодом: ${code}`);
      this.ffmpeg = null;
      
      if (this.isRunning) {
        log.info('Перезапуск FFmpeg...');
        setTimeout(() => this.startFFmpeg(), 1000);
      }
    });

    // Обработка ошибок FFmpeg
    this.ffmpeg.on('error', (error) => {
      log.error('Ошибка FFmpeg:', error.message);
    });

    log.info('FFmpeg запущен');
  }

  /**
   * Захват и отправка кадра (используется только как fallback)
   */
  async captureAndSendFrame() {
    if (!this.page || !this.ffmpeg || !this.ffmpeg.stdin.writable) {
      return false;
    }

    try {
      const screenshot = await this.page.screenshot({
        type: 'jpeg',
        quality: 80,
        fullPage: false,
      });

      return this.sendFrameToFFmpeg(screenshot);
    } catch (error) {
      log.error('Ошибка захвата кадра:', error.message);
      return false;
    }
  }

  /**
   * Отправка кадра в FFmpeg
   */
  sendFrameToFFmpeg(frameData) {
    if (!this.ffmpeg || !this.ffmpeg.stdin.writable) {
      return false;
    }

    try {
      const canWrite = this.ffmpeg.stdin.write(frameData);
      this.frameCount++;
      
      // Логируем каждые 30 кадров
      if (this.frameCount % 30 === 0) {
        log.info(`Отправлено кадров: ${this.frameCount}`);
      }

      if (!canWrite) {
        // Буфер переполнен - пропускаем кадры до drain
        return new Promise((resolve) => {
          this.ffmpeg.stdin.once('drain', () => resolve(true));
        });
      }
      
      return true;
    } catch (error) {
      log.error('Ошибка записи в FFmpeg:', error.message);
      return false;
    }
  }

  /**
   * Запуск CDP Screencast - нативный захват экрана браузера
   * Работает в 3-5 раз быстрее чем page.screenshot()
   */
  async startScreencast() {
    log.info('Запуск CDP Screencast для быстрого захвата...');
    
    // Получаем CDP сессию
    this.cdpSession = await this.page.target().createCDPSession();
    
    // Обработчик кадров screencast
    this.cdpSession.on('Page.screencastFrame', async (frame) => {
      if (!this.isRunning || !this.ffmpeg || !this.ffmpeg.stdin.writable) {
        return;
      }

      try {
        // Декодируем base64 кадр в Buffer
        const frameBuffer = Buffer.from(frame.data, 'base64');
        
        // Отправляем в FFmpeg
        this.sendFrameToFFmpeg(frameBuffer);
        
        // Подтверждаем получение кадра (важно для продолжения потока)
        await this.cdpSession.send('Page.screencastFrameAck', {
          sessionId: frame.sessionId,
        });
      } catch (error) {
        log.error('Ошибка обработки screencast кадра:', error.message);
      }
    });

    // Запускаем screencast
    await this.cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 80,
      maxWidth: CONFIG.WIDTH,
      maxHeight: CONFIG.HEIGHT,
      everyNthFrame: 1, // Каждый кадр
    });

    log.info('CDP Screencast запущен');
    this.isRunning = true;

    // Поддерживаем процесс активным и проверяем обновление страницы
    while (this.isRunning) {
      await this.refreshPageIfNeeded();
      
      // Логируем статистику каждые 30 секунд
      if (this.frameCount % (CONFIG.FPS * 30) === 0 && this.frameCount > 0) {
        log.info(`Статистика: отправлено ${this.frameCount} кадров`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  /**
   * Остановка CDP Screencast
   */
  async stopScreencast() {
    if (this.cdpSession) {
      try {
        await this.cdpSession.send('Page.stopScreencast');
        await this.cdpSession.detach();
      } catch (e) {
        // Игнорируем ошибки при остановке
      }
      this.cdpSession = null;
    }
  }

  /**
   * Запуск стримера
   */
  async start() {
    try {
      log.info('========================================');
      log.info('Запуск YouTube Website Streamer');
      log.info('========================================');
      log.info('Режим: CDP Screencast (Full HD)');
      
      await this.startBrowser();
      await this.loadPage();
      this.startFFmpeg();
      
      // Даём FFmpeg время на инициализацию
      await new Promise((resolve) => setTimeout(resolve, 2000));
      
      // Используем CDP Screencast вместо screenshot loop
      await this.startScreencast();
      
    } catch (error) {
      log.error('Критическая ошибка при запуске:', error.message);
      await this.stop();
      throw error;
    }
  }

  /**
   * Остановка стримера
   */
  async stop() {
    log.info('Остановка стримера...');
    this.isRunning = false;

    // Останавливаем CDP Screencast
    await this.stopScreencast();

    // Закрываем FFmpeg
    if (this.ffmpeg) {
      this.ffmpeg.stdin.end();
      this.ffmpeg.kill('SIGTERM');
      this.ffmpeg = null;
    }

    // Закрываем браузер
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }

    log.info('Стример остановлен');
  }
}

// ==================== ГЛАВНАЯ ФУНКЦИЯ ====================

async function main() {
  // Валидация конфигурации
  validateConfig();
  
  const streamer = new WebsiteStreamer();
  
  // Обработка сигналов завершения
  const shutdown = async (signal) => {
    log.info(`Получен сигнал ${signal}, завершение...`);
    await streamer.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Обработка необработанных исключений
  process.on('uncaughtException', (error) => {
    log.error('Необработанное исключение:', error.message);
    log.error(error.stack);
  });

  process.on('unhandledRejection', (reason, promise) => {
    log.error('Необработанный rejection:', reason);
  });

  // Цикл автоматического перезапуска
  while (true) {
    try {
      await streamer.start();
    } catch (error) {
      log.error('Стример упал:', error.message);
      await streamer.stop();
      
      log.info(`Перезапуск через ${CONFIG.RESTART_DELAY / 1000} секунд...`);
      await new Promise((resolve) => setTimeout(resolve, CONFIG.RESTART_DELAY));
    }
  }
}

// Запуск
main().catch((error) => {
  log.error('Фатальная ошибка:', error.message);
  process.exit(1);
});
