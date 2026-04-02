import { loadConfig, saveConfig } from "../config/config";
import { checkTurnHealth } from "../health/check-turn";
import { tryFallbackFromQueue } from "../links/fallback";
import { notifyAdmins } from "../utils/notify";

// ─── Фоновый мониторинг ─────────────────────────────────────

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

/** Случайный интервал 5–10 минут, избегая кратных 30 000 мс */
function randomCheckInterval(): number {
  const minMs = 5 * 60 * 1000;
  const maxMs = 10 * 60 * 1000;
  let ms = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  while (ms % 30000 === 0) {
    ms = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  }
  return ms;
}

export function startMonitor(): void {
  console.log("Мониторинг запущен (рандомный интервал 5–10 мин)");

  // Первая проверка через 30 секунд после старта
  monitorTimeout = setTimeout(async function scheduleNext() {
    await runHealthCheck();
    const nextInterval = randomCheckInterval();
    monitorTimeout = setTimeout(scheduleNext, nextInterval);
  }, 30_000);
}

export function stopMonitor(): void {
  clearTimeout(monitorTimeout);
}
