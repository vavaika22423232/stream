/**
 * YouTube Website Streamer v2.0
 * 
 * 24/7 автоматическая трансляция сайта на YouTube Live
 * через Xvfb + x11grab (БЫСТРЫЙ захват экрана)
 * 
 * Архитектура:
 * 1. Xvfb создаёт виртуальный дисплей (например :99)
 * 2. Chromium запускается в ОБЫЧНОМ режиме (не headless!) на этом дисплее
 * 3. FFmpeg захватывает экран напрямую через x11grab - это очень быстро!
 * 4. Видеопоток кодируется в H.264 и отправляется на YouTube через RTMP
 * 
 * Преимущества x11grab vs CDP Screencast:
 * - x11grab работает на уровне X-сервера, минуя JavaScript
 * - Стабильные 30+ fps даже с тяжёлыми WebGL приложениями
 * - Меньше нагрузки на браузер
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
  
  // Разрешение видео (1080p - x11grab легко справится!)
  WIDTH: parseInt(process.env.WIDTH) || 1920,
  HEIGHT: parseInt(process.env.HEIGHT) || 1080,
  
  // FPS трансляции (30 fps без проблем с x11grab)
  FPS: parseInt(process.env.FPS) || 30,
  
  // Битрейт видео (8000k для чёткой картинки на Pro)
  VIDEO_BITRATE: process.env.VIDEO_BITRATE || '8000k',
  
  // Таймаут перезапуска при ошибке (мс)
  RESTART_DELAY: parseInt(process.env.RESTART_DELAY) || 5000,
  
  // Интервал обновления страницы (мс)
  PAGE_REFRESH_INTERVAL: parseInt(process.env.PAGE_REFRESH_INTERVAL) || 3600000, // 1 час
  
  // Путь к фоновой музыке
  MUSIC_PATH: process.env.MUSIC_PATH || path.join(__dirname, '..', 'music', 'background.mp3'),
  
  // Громкость музыки (0.0 - 1.0)
  MUSIC_VOLUME: parseFloat(process.env.MUSIC_VOLUME) || 0.15,
  
  // X11 дисплей (задаётся Xvfb)
  DISPLAY: process.env.DISPLAY || ':99',
};

// ==================== ЛОГИРОВАНИЕ ====================

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

function validateConfig() {
  if (!CONFIG.STREAM_KEY) {
    throw new Error('STREAM_KEY не установлен! Добавьте переменную окружения STREAM_KEY');
  }
  
  log.info('='.repeat(50));
  log.info('Конфигурация:');
  log.info(`  URL: ${CONFIG.TARGET_URL}`);
  log.info(`  Разрешение: ${CONFIG.WIDTH}x${CONFIG.HEIGHT}`);
  log.info(`  FPS: ${CONFIG.FPS}`);
  log.info(`  Битрейт: ${CONFIG.VIDEO_BITRATE}`);
  log.info(`  Дисплей: ${CONFIG.DISPLAY}`);
  log.info(`  Режим захвата: x11grab (быстрый)`);
  log.info('='.repeat(50));
}

// ==================== КЛАСС СТРИМЕРА ====================

class WebsiteStreamer {
  constructor() {
    this.browser = null;
    this.page = null;
    this.ffmpeg = null;
    this.isRunning = false;
    this.lastRefreshTime = Date.now();
  }

  /**
   * Запуск браузера в ОБЫЧНОМ режиме (не headless!) на виртуальном дисплее Xvfb
   */
  async startBrowser() {
    log.info('Запуск браузера на виртуальном дисплее...');
    
    this.browser = await puppeteer.launch({
      headless: false,  // ВАЖНО: НЕ headless! Запускаем с GUI на Xvfb
      ignoreDefaultArgs: ['--enable-automation'],  // Убираем плашку "controlled by automation"
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        // WebGL для карт
        '--enable-webgl',
        '--enable-webgl2',
        '--ignore-gpu-blocklist',
        '--enable-gpu-rasterization',
        // Полноэкранный режим
        '--start-fullscreen',
        '--start-maximized',
        `--window-size=${CONFIG.WIDTH},${CONFIG.HEIGHT}`,
        `--window-position=0,0`,
        // Kiosk mode - убирает все элементы UI браузера
        '--kiosk',
        // Убираем все плашки и предупреждения
        '--disable-infobars',
        '--disable-blink-features=AutomationControlled',
        '--disable-translate',
        '--no-default-browser-check',
        '--no-first-run',
        '--disable-session-crashed-bubble',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        '--disable-notifications',
        '--disable-popup-blocking',
        '--mute-audio',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--autoplay-policy=no-user-gesture-required',
      ],
      defaultViewport: null,  // Используем размер окна
      env: {
        ...process.env,
        DISPLAY: CONFIG.DISPLAY,
      },
    });

    // Получаем первую страницу
    const pages = await this.browser.pages();
    this.page = pages[0] || await this.browser.newPage();
    
    // Устанавливаем User-Agent
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Скрываем курсор мыши через CSS
    await this.page.evaluateOnNewDocument(() => {
      const style = document.createElement('style');
      style.innerHTML = '* { cursor: none !important; }';
      document.head.appendChild(style);
    });

    // Скрываем webdriver признаки
    await this.page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // Обработка ошибок страницы
    this.page.on('error', (error) => {
      log.error('Ошибка страницы:', error.message);
    });

    this.page.on('pageerror', (error) => {
      log.debug('JS ошибка на странице:', error.message);
    });

    // Блокируем диалоги
    this.page.on('dialog', async (dialog) => {
      await dialog.dismiss();
    });

    log.info('Браузер запущен');
  }

  /**
   * Загрузка целевого сайта
   */
  async loadPage() {
    log.info(`Загрузка страницы: ${CONFIG.TARGET_URL}`);
    
    await this.page.goto(CONFIG.TARGET_URL, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    // Устанавливаем viewport на полный размер
    await this.page.setViewport({
      width: CONFIG.WIDTH,
      height: CONFIG.HEIGHT,
    });
    
    // Ждём загрузки WebGL карты
    log.info('Ожидание загрузки WebGL карты (10 сек)...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Проверяем WebGL
    const webglStatus = await this.page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return 'WebGL НЕ работает';
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : 'unknown';
      return `WebGL работает (${renderer})`;
    });
    log.info(`Статус: ${webglStatus}`);
    
    log.info('Страница загружена и готова');
    this.lastRefreshTime = Date.now();
  }

  /**
   * Получить аргументы FFmpeg для аудио входа
   */
  getAudioInputArgs() {
    const musicExists = fs.existsSync(CONFIG.MUSIC_PATH);
    
    if (musicExists) {
      log.info(`Фоновая музыка: ${CONFIG.MUSIC_PATH}`);
      return [
        '-stream_loop', '-1',
        '-i', CONFIG.MUSIC_PATH,
      ];
    } else {
      log.info('Музыка не найдена, используем тишину');
      return [
        '-f', 'lavfi',
        '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      ];
    }
  }

  /**
   * Запуск FFmpeg с x11grab - захват экрана напрямую с X-сервера
   */
  startFFmpeg() {
    log.info('Запуск FFmpeg с x11grab...');
    
    const rtmpUrl = `${CONFIG.YOUTUBE_RTMP_URL}/${CONFIG.STREAM_KEY}`;
    
    log.info(`RTMP: ${CONFIG.YOUTUBE_RTMP_URL}/****`);
    
    const ffmpegArgs = [
      // Глобальные параметры
      '-y',
      '-loglevel', 'info',
      '-threads', '4',
      
      // === ВХОД 1: x11grab - захват экрана ===
      '-f', 'x11grab',
      '-framerate', String(CONFIG.FPS),
      '-video_size', `${CONFIG.WIDTH}x${CONFIG.HEIGHT}`,
      '-i', `${CONFIG.DISPLAY}+0,0`,  // Дисплей + смещение x,y
      
      // === ВХОД 2: Аудио ===
      ...this.getAudioInputArgs(),
      
      // === Кодирование видео (оптимизировано для Pro 2 CPU) ===
      '-c:v', 'libx264',
      '-preset', 'fast',          // fast = лучшее качество (не veryfast!)
      '-tune', 'zerolatency',     // Минимальная задержка
      '-crf', '18',               // CRF 18 = высокое качество (0-51, меньше = лучше)
      '-profile:v', 'high',       // High profile для YouTube
      '-level', '4.2',            // Level 4.2 для 1080p30 с высоким битрейтом
      '-pix_fmt', 'yuv420p',
      '-r', String(CONFIG.FPS),
      '-g', String(CONFIG.FPS * 2),        // Keyframe каждые 2 сек
      '-keyint_min', String(CONFIG.FPS * 2),
      '-sc_threshold', '0',
      '-b:v', CONFIG.VIDEO_BITRATE,        // Битрейт 8 Mbps
      '-maxrate', CONFIG.VIDEO_BITRATE,
      '-bufsize', '16000k',                // Буфер = 2x битрейт
      
      // === Кодирование аудио (высокое качество) ===
      '-c:a', 'aac',
      '-b:a', '192k',             // 192k для лучшего звука
      '-ar', '48000',             // 48kHz - стандарт для видео
      '-ac', '2',
      '-af', `volume=${CONFIG.MUSIC_VOLUME}`,
      
      // === Маппинг ===
      '-map', '0:v',
      '-map', '1:a',
      
      // === Выход ===
      '-f', 'flv',
      '-flvflags', 'no_duration_filesize',
      rtmpUrl,
    ];

    log.debug('FFmpeg команда:', 'ffmpeg ' + ffmpegArgs.join(' '));

    this.ffmpeg = spawn('ffmpeg', ffmpegArgs);
    this.isRunning = true;

    // Обработка вывода FFmpeg
    this.ffmpeg.stderr.on('data', (data) => {
      const output = data.toString().trim();
      // Показываем строки с прогрессом
      if (output.includes('frame=') || output.includes('fps=')) {
        const lines = output.split('\n');
        log.info('FFmpeg:', lines[lines.length - 1]);
      } else if (output.includes('error') || output.includes('Error')) {
        log.error('FFmpeg:', output);
      } else if (output.includes('Output')) {
        log.info('FFmpeg:', output);
      }
    });

    this.ffmpeg.on('close', (code) => {
      log.warn(`FFmpeg завершился с кодом: ${code}`);
      if (this.isRunning) {
        log.info('Перезапуск FFmpeg через 2 сек...');
        setTimeout(() => this.startFFmpeg(), 2000);
      }
    });

    this.ffmpeg.on('error', (error) => {
      log.error('Ошибка FFmpeg:', error.message);
    });

    log.info('FFmpeg запущен - стрим активен!');
  }

  /**
   * Периодическое обновление страницы
   */
  async refreshPageIfNeeded() {
    const elapsed = Date.now() - this.lastRefreshTime;
    
    if (elapsed >= CONFIG.PAGE_REFRESH_INTERVAL) {
      log.info('Обновление страницы (против утечек памяти)...');
      
      try {
        await this.page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 10000));
        log.info('Страница обновлена');
      } catch (error) {
        log.error('Ошибка при обновлении:', error.message);
      }
      
      this.lastRefreshTime = Date.now();
    }
  }

  /**
   * Главный цикл - следит за состоянием
   */
  async runMainLoop() {
    log.info('Главный цикл запущен');
    
    while (this.isRunning) {
      try {
        await this.refreshPageIfNeeded();
      } catch (error) {
        log.error('Ошибка в главном цикле:', error.message);
      }
      
      // Проверка каждые 10 секунд
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }

  /**
   * Запуск стримера
   */
  async start() {
    log.info('');
    log.info('🚀 Запуск YouTube Website Streamer v2.0');
    log.info('   Режим: Xvfb + x11grab (1080p30)');
    log.info('');
    
    await this.startBrowser();
    await this.loadPage();
    this.startFFmpeg();
    
    // Даём FFmpeg время подключиться к YouTube
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    await this.runMainLoop();
  }

  /**
   * Остановка стримера
   */
  async stop() {
    log.info('Остановка стримера...');
    this.isRunning = false;

    if (this.ffmpeg) {
      this.ffmpeg.kill('SIGTERM');
      this.ffmpeg = null;
    }

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }

    log.info('Стример остановлен');
  }
}

// ==================== MAIN ====================

async function main() {
  validateConfig();
  
  const streamer = new WebsiteStreamer();
  
  // Graceful shutdown
  const shutdown = async (signal) => {
    log.info(`Получен ${signal}, завершение...`);
    await streamer.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  
  process.on('uncaughtException', (error) => {
    log.error('Uncaught exception:', error.message);
  });

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection:', reason);
  });

  // Цикл с автоперезапуском
  while (true) {
    try {
      await streamer.start();
    } catch (error) {
      log.error('Стример упал:', error.message);
      await streamer.stop();
      
      log.info(`Перезапуск через ${CONFIG.RESTART_DELAY / 1000} сек...`);
      await new Promise(resolve => setTimeout(resolve, CONFIG.RESTART_DELAY));
    }
  }
}

main().catch((error) => {
  log.error('Фатальная ошибка:', error.message);
  process.exit(1);
});
