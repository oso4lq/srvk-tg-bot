import "dotenv/config";
import { bot } from "./bot";
import { mainKeyboard } from "./bot";
import { loadConfig, saveConfig } from "./config/config";
import { registerCommands } from "./commands/register";
import { startMonitor, stopMonitor } from "./monitoring/monitor";
import { scheduleDailyReport } from "./monitoring/daily-report";
import { checkLinkHealth } from "./health/check-link";
import { tryFallbackFromQueue } from "./links/fallback";
import { isVkConfigured, VK_GROUP_TOKEN, VK_GROUP_ID } from "./links/vk-api";
import { notifyAdmins } from "./utils/notify";
import { getServiceTrafficBytes } from "./utils/systemd";

// ─── Регистрация команд ─────────────────────────────────────

registerCommands(bot);

// ─── Запуск ─────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("VK TURN Proxy Monitor запускается...");

  // Инициализируем конфиг и обновляем время старта бота
  const config = loadConfig();
  config.stats.uptimeSince = new Date().toISOString();
  config.dailyStats.trafficSnapshotBytes = await getServiceTrafficBytes();
  saveConfig(config);

  // Проверка VK relay конфигурации
  if (!isVkConfigured) {
    const hasAny = VK_GROUP_TOKEN || VK_GROUP_ID;
    if (hasAny) {
      console.warn("VK relay частично настроен — нужны оба: VK_GROUP_TOKEN, VK_GROUP_ID");
    } else {
      console.log("VK relay не настроен — публикация ссылок в VK отключена");
    }
  }

  // Запускаем фоновый мониторинг
  startMonitor();

  // Запускаем ежедневный отчёт (04:00 UTC)
  scheduleDailyReport();

  // Запускаем бота
  bot.start({
    onStart: async () => {
      console.log("Бот запущен");

      // Fallback при старте: проверяем активную ссылку ДО отправки уведомления
      try {
        const preConfig = loadConfig();
        if (preConfig.vkCallLink && preConfig.linkQueue.length > 0) {
          const health = await checkLinkHealth(preConfig.vkCallLink, preConfig, undefined, 2, 10_000);
          if (!health.alive) {
            await tryFallbackFromQueue();
          }
        }
      } catch (err) {
        console.error("Startup fallback failed:", err);
      }

      // Уведомление о запуске (после fallback — актуальные данные)
      const startConfig = loadConfig();
      const monitorState = startConfig.monitoringEnabled ? "✅" : "⏸ выключен";
      const vkState = isVkConfigured ? "✅" : "выключена";
      const activeLine = startConfig.vkCallLink
        ? `Активная ссылка: ${startConfig.vkCallLink}`
        : "Активная ссылка не задана";
      const queueCount = startConfig.linkQueue.length;
      const queueLine = queueCount > 0
        ? `Ссылок в очереди: ${queueCount}`
        : "Очередь пуста";

      notifyAdmins(
        `🟢 VK TURN Monitor запущен\n\nМониторинг: ${monitorState}\nПубликация в VK: ${vkState}\n${activeLine}\n${queueLine}\n\nОтправь ссылку в чат, чтобы добавить её в очередь\n/setlink <url> — принудительная установка новой ссылки`,
        { reply_markup: mainKeyboard }
      ).catch(() => {});
    },
  });
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("Остановка...");
  stopMonitor();
  bot.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopMonitor();
  bot.stop();
  process.exit(0);
});

main().catch(console.error);
