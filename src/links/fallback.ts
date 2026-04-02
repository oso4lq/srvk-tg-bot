// src/links/fallback.ts

import { loadConfig, saveConfig } from "../config/config";
import { checkLinkHealth } from "../health/check-link";
import { publishToVk } from "./vk-api";
import { isApplying, setIsApplying } from "./apply";
import { notifyAdmins } from "../utils/notify";
import { formatUptime } from "../utils/format";

// ─── Fallback из очереди ────────────────────────────────────

/**
 * Перебирает linkQueue, ищет живую ссылку для замены мёртвой активной.
 * Мёртвые ссылки удаляются из очереди. Живая активируется и постится в VK.
 * Возвращает true если fallback удался.
 */
export async function tryFallbackFromQueue(): Promise<boolean> {
  if (isApplying) return false;
  setIsApplying(true);

  try {
    const config = loadConfig();
    const deadLink = config.vkCallLink;
    let activated = false;

    // При splice без инкремента i — следующий элемент сдвигается на текущий индекс
    let i = 0;
    while (i < config.linkQueue.length) {
      const candidate = config.linkQueue[i];

      // Пропускаем ссылку, совпадающую с текущей активной
      if (candidate === deadLink) {
        i++;
        continue;
      }

      const result = await checkLinkHealth(candidate, config, undefined, 2, 10_000);

      if (result.alive) {
        // Активируем и удаляем из очереди
        config.linkQueue.splice(i, 1);
        config.vkCallLink = candidate;
        config.updatedAt = new Date().toISOString();
        config.stats.lastCheckOk = true;
        config.stats.lastCheckAt = new Date().toISOString();
        config.stats.lastCheckDetails = `Fallback: переключение на резервную ссылку`;
        saveConfig(config);

        // Публикуем в VK (не фатально при ошибке)
        const vkResult = await publishToVk(candidate);
        const vkNote = vkResult.ok ? "" : `\n⚠️ VK: ${vkResult.error}`;

        const durationNote = config.updatedAt
          ? `\nПрошлая ссылка проработала: ${formatUptime(config.updatedAt)}`
          : "";

        await notifyAdmins(
          `🔄 Ссылка умерла, переключился на резервную\n` +
            `Новая: ${candidate}${durationNote}\n` +
            `Ссылок в очереди: ${config.linkQueue.length}${vkNote}`
        );

        activated = true;
        break;
      } else {
        // Мёртвая — удаляем из очереди
        config.linkQueue.splice(i, 1);
        saveConfig(config);

        await notifyAdmins(
          `❌ Резервная ссылка мертва, удалена:\n${candidate}`
        );
        // Не увеличиваем i — следующий элемент сдвинулся на текущий индекс
      }
    }

    if (!activated) {
      // Удаляем из очереди ссылку, совпадающую с мёртвой активной (если есть)
      config.linkQueue = config.linkQueue.filter((l) => l !== deadLink);
      saveConfig(config);

      await notifyAdmins(
        `🚨 Все ссылки мертвы!\n` +
          `Очередь пуста, валидных ссылок нет.\n` +
          `Отправь новые ссылки в чат.`
      );
    }

    return activated;
  } finally {
    setIsApplying(false);
  }
}
