// src/monitoring/monitor.ts

import { loadConfig, saveConfig } from "../config/config";
import { checkTurnHealth } from "../health/check-turn";
import { tryFallbackFromQueue } from "../links/fallback";
import { notifyAdmins } from "../utils/notify";

// ─── Фоновый мониторинг ─────────────────────────────────────

const CHECK_MIN_MS = parseIntervalEnv("CHECK_INTERVAL_MIN_MINUTES", 5) * 60_000;
const CHECK_MAX_MS = parseIntervalEnv("CHECK_INTERVAL_MAX_MINUTES", 10) * 60_000;

/** Парсит переменную окружения как число минут, возвращает дефолт если не задана */
function parseIntervalEnv(name: string, defaultVal: number): number {
  const raw = process.env[name];
  if (!raw) return defaultVal;
  const val = Number(raw);
  if (isNaN(val) || val <= 0) {
    console.error(`Ошибка: ${name}=${raw} — должно быть положительное число (минуты)`);
    process.exit(1);
  }
  return val;
}

/** Валидация интервалов при импорте модуля */
if (CHECK_MIN_MS > CHECK_MAX_MS) {
  console.error(
    `Ошибка: CHECK_INTERVAL_MIN_MINUTES (${CHECK_MIN_MS / 60_000}) > CHECK_INTERVAL_MAX_MINUTES (${CHECK_MAX_MS / 60_000})`,
  );
  process.exit(1);
}

let monitorTimeout: ReturnType<typeof setTimeout>;

async function runHealthCheck(): Promise<void> {
  const config = loadConfig();

  if (!config.monitoringEnabled || !config.vkCallLink) return;

  const result = await checkTurnHealth();

  config.stats.lastCheckOk = result.alive;
  config.stats.lastCheckAt = new Date().toISOString();
  config.stats.lastCheckDetails = result.details;

  if (!result.alive) {
    config.dailyStats.failedChecks++;
    const ts = new Date().toLocaleString("ru");
    const short = result.details.split("\n")[0];
    config.dailyStats.incidents.push(`${ts} — ${short}`);
    if (config.dailyStats.incidents.length > 50) {
      config.dailyStats.incidents = config.dailyStats.incidents.slice(-50);
    }
    saveConfig(config);

    // Пробуем fallback из очереди
    const fallbackOk = await tryFallbackFromQueue();

    if (!fallbackOk) {
      await notifyAdmins(
        `🚨 TURN не отвечает!\n\n${result.details}\n\n` +
          `Отправь новую ссылку VK-звонка`
      );
    }
    return;
  }

  saveConfig(config);
}

/** Интервал проверки. При min === max — фиксированный, иначе рандом, избегая кратных 30 000 мс */
function checkInterval(): number {
  if (CHECK_MIN_MS === CHECK_MAX_MS) return CHECK_MIN_MS;

  let ms = CHECK_MIN_MS + Math.floor(Math.random() * (CHECK_MAX_MS - CHECK_MIN_MS + 1));
  while (ms % 30000 === 0) {
    ms = CHECK_MIN_MS + Math.floor(Math.random() * (CHECK_MAX_MS - CHECK_MIN_MS + 1));
  }
  return ms;
}

export function startMonitor(): void {
  const minMin = CHECK_MIN_MS / 60_000;
  const maxMin = CHECK_MAX_MS / 60_000;
  const label = minMin === maxMin ? `${minMin} мин` : `${minMin}–${maxMin} мин`;
  console.log(`Мониторинг запущен (интервал ${label})`);

  // Первая проверка через 30 секунд после старта
  monitorTimeout = setTimeout(async function scheduleNext() {
    await runHealthCheck();
    monitorTimeout = setTimeout(scheduleNext, checkInterval());
  }, 30_000);
}

export function stopMonitor(): void {
  clearTimeout(monitorTimeout);
}
