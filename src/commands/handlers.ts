import { exec } from "child_process";
import { promisify } from "util";
import { CommandContext, Context, Filter } from "grammy";
import { SYSTEMD_SERVICE, loadConfig, saveConfig } from "../config/config";
import { checkTurnHealth } from "../health/check-turn";
import { checkLinkHealth } from "../health/check-link";
import { applyLink, VK_CALL_REGEX, isApplying } from "../links/apply";
import { tryFallbackFromQueue } from "../links/fallback";
import { restartService } from "../service/restart";
import { formatUptime, formatTimeAgo, parseSystemdProps } from "../utils/format";

const execAsync = promisify(exec);

// ─── Обработчики команд ─────────────────────────────────────

// /status — проверка TURN
export async function handleStatus(ctx: Context): Promise<void> {
  const msg = await ctx.reply("⏳ Проверяю TURN...");

  const result = await checkTurnHealth();
  const config = loadConfig();

  config.stats.lastCheckOk = result.alive;
  config.stats.lastCheckAt = new Date().toISOString();
  config.stats.lastCheckDetails = result.details;
  saveConfig(config);

  const icon = result.alive ? "✅" : "❌";
  await ctx.api.editMessageText(
    ctx.chat!.id,
    msg.message_id,
    `${icon} TURN ${result.alive ? "жив" : "мёртв"}\n\n${result.details}`
  );
}

// /restart — перезапуск сервиса
export async function handleRestart(ctx: Context): Promise<void> {
  const msg = await ctx.reply("⏳ Перезапускаю vk-turn-proxy...");

  try {
    const result = await restartService();
    await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, `✅ ${result}`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      msg.message_id,
      `❌ ${errMsg}`
    );
  }
}

// /stats — статистика
export async function handleStats(ctx: Context): Promise<void> {
  const config = loadConfig();
  const s = config.stats;

  // Получаем информацию о сервисе из systemd
  let serviceState = "неизвестно";
  let serviceUptime = "";
  try {
    const { stdout } = await execAsync(
      `systemctl show ${SYSTEMD_SERVICE} --property=ActiveState,ActiveEnterTimestamp,MemoryCurrent 2>/dev/null`
    );
    const props = parseSystemdProps(stdout);
    serviceState = props.ActiveState || "неизвестно";
    if (props.ActiveEnterTimestamp && serviceState === "active") {
      serviceUptime = formatUptime(
        new Date(props.ActiveEnterTimestamp).toISOString()
      );
    }
    const mem = parseInt(props.MemoryCurrent || "0", 10);
    if (mem > 0) {
      serviceState += `, ${(mem / 1024 / 1024).toFixed(1)} МБ`;
    }
  } catch {
    // Сервис может быть не установлен на этапе разработки
  }

  const lines = [
    `📊 Статистика VK TURN Proxy`,
    ``,
    `Сервис: ${serviceState}`,
    serviceUptime ? `Аптайм сервиса: ${serviceUptime}` : null,
    `Аптайм бота: ${formatUptime(s.uptimeSince)}`,
    `Перезапусков: ${s.totalRestarts}`,
    ``,
    `Последняя проверка: ${s.lastCheckAt ? new Date(s.lastCheckAt).toLocaleString("ru") : "—"}`,
    `Результат: ${s.lastCheckOk ? "✅ OK" : "❌ Fail"}`,
    s.lastCheckDetails ? `Детали: ${s.lastCheckDetails}` : null,
    ``,
    `Ссылка обновлена: ${config.updatedAt ? new Date(config.updatedAt).toLocaleString("ru") : "—"}`,
  ];
  await ctx.reply(lines.filter((l) => l !== null).join("\n"));
}

// /config — текущая конфигурация (без секретов)
export async function handleConfig(ctx: Context): Promise<void> {
  const config = loadConfig();

  const link = config.vkCallLink || "не задана";
  const lastCheck = formatTimeAgo(config.stats.lastCheckAt);

  await ctx.reply(
    `⚙️ Конфигурация\n\n` +
      `VK-звонок: ${link}\n` +
      `WG peer: ${config.wgPeerAddress}:${config.wgPeerPort}\n` +
      `TURN порт: ${config.turnListenPort}\n` +
      `Интервал проверки: 5–10 мин (рандом)\n` +
      `Последняя проверка: ${lastCheck}`
  );
}

// /monitor — включение/отключение мониторинга
export async function handleMonitor(ctx: Context): Promise<void> {
  const config = loadConfig();
  config.monitoringEnabled = !config.monitoringEnabled;
  saveConfig(config);

  const state = config.monitoringEnabled ? "включён ✅" : "выключен ⏸";
  await ctx.reply(`Мониторинг ${state}`);
}

// /links — просмотр очереди резервных ссылок
export async function handleLinks(ctx: Context): Promise<void> {
  const config = loadConfig();

  const lines: string[] = [];
  if (config.vkCallLink) {
    lines.push(`🔗 Активная: ${config.vkCallLink}`);
  } else {
    lines.push("🔗 Активная ссылка не задана");
  }

  if (config.linkQueue.length === 0) {
    lines.push("\nОчередь пуста, резервных ссылок нет.");
  } else {
    lines.push(`\nОчередь (${config.linkQueue.length}):`);
    config.linkQueue.forEach((link, i) => {
      lines.push(`${i + 1}. ${link}`);
    });
  }

  await ctx.reply(lines.join("\n"));
}

// /rmlink N — удаление ссылки из очереди по номеру
export async function handleRmlink(ctx: CommandContext<Context>): Promise<void> {
  const arg = ctx.match.trim();
  const num = Number(arg);

  if (!arg || isNaN(num) || !Number.isInteger(num)) {
    await ctx.reply("Использование: /rmlink N (номер из /links)");
    return;
  }

  const config = loadConfig();
  const idx = num - 1;

  if (idx < 0 || idx >= config.linkQueue.length) {
    await ctx.reply(
      `❌ Номер должен быть от 1 до ${config.linkQueue.length}.\n` +
        `Используй /links для просмотра очереди.`
    );
    return;
  }

  const removed = config.linkQueue.splice(idx, 1)[0];
  saveConfig(config);

  await ctx.reply(
    `✅ Ссылка #${num} удалена.\n${removed}\n\nОсталось в очереди: ${config.linkQueue.length}`
  );
}

// Обработка текстовых сообщений — добавление в очередь
export async function handleText(ctx: Filter<Context, "message:text">): Promise<void> {
  const text = ctx.message.text.trim();

  if (VK_CALL_REGEX.test(text)) {
    // Добавляем в очередь, не активируем
    const config = loadConfig();

    if (text === config.vkCallLink) {
      await ctx.reply("ℹ️ Эта ссылка уже активна.");
      return;
    }

    if (config.linkQueue.includes(text)) {
      await ctx.reply("ℹ️ Эта ссылка уже в очереди.");
      return;
    }

    config.linkQueue.push(text);
    saveConfig(config);

    await ctx.reply(
      `✅ Ссылка добавлена в очередь (позиция ${config.linkQueue.length}).\n` +
        `Всего ссылок в очереди: ${config.linkQueue.length}`
    );

    // Если активная ссылка мертва — сразу пробуем fallback
    if (config.vkCallLink && !isApplying) {
      const health = await checkLinkHealth(config.vkCallLink, config, undefined, 2, 10_000);
      if (!health.alive) {
        await tryFallbackFromQueue();
      }
    } else if (!config.vkCallLink) {
      // Нет активной ссылки — сразу активируем из очереди
      await tryFallbackFromQueue();
    }
    return;
  }

  await ctx.reply("Неизвестная команда. Отправь /start для списка команд.");
}
