// src/commands/register.ts

import { Bot } from "grammy";
import { isAdmin } from "../utils/notify";
import { mainKeyboard } from "../bot";
import {
  handleStatus,
  handleRestart,
  handleStats,
  handleConfig,
  handleMonitor,
  handleLinks,
  handleRmlink,
  handleText,
} from "./handlers";
import {
  handleSetlinkYes,
  handleSetlinkNo,
  handleReportPage,
} from "./callbacks";
import { applyLink } from "../links/apply";

// ─── Регистрация команд ─────────────────────────────────────

export function registerCommands(bot: Bot): void {
  // Middleware: фильтруем все сообщения не от админа
  bot.use(async (ctx, next) => {
    if (!isAdmin(ctx)) {
      // Молча игнорируем чужие сообщения
      return;
    }
    await next();
  });

  // /start — приветствие
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "🔧 VK TURN Proxy Monitor\n\n" +
        "Отправь ссылку в чат — она добавится в очередь резервных.\n" +
        "Для принудительной активации: /setlink <url>\n\n" +
        "Команды:\n" +
        "/status — проверка здоровья TURN\n" +
        "/stats — статистика\n" +
        "/links — очередь резервных ссылок\n" +
        "/rmlink N — удалить ссылку из очереди\n" +
        "/restart — перезапустить vk-turn-proxy\n" +
        "/config — текущая конфигурация\n" +
        "/monitor — вкл/выкл мониторинг",
      { reply_markup: mainKeyboard }
    );
  });

  // Команды + кнопки
  bot.command("status", handleStatus);
  bot.hears("Статус", handleStatus);

  bot.command("setlink", async (ctx) => {
    const link = ctx.match?.trim();
    if (!link) {
      await ctx.reply("Использование: /setlink https://vk.com/call/join/...");
      return;
    }
    await applyLink(link, ctx);
  });

  bot.command("restart", handleRestart);
  bot.hears("Перезапуск", handleRestart);

  bot.command("stats", handleStats);
  bot.hears("Статистика", handleStats);

  bot.command("config", handleConfig);
  bot.hears("Конфиг", handleConfig);

  bot.command("monitor", handleMonitor);
  bot.hears("Мониторинг", handleMonitor);

  bot.command("links", handleLinks);
  bot.command("rmlink", handleRmlink);

  // Callback queries
  bot.callbackQuery(/^setlink:yes:/, handleSetlinkYes);
  bot.callbackQuery(/^setlink:no:/, handleSetlinkNo);
  bot.callbackQuery(/^rpt:\d+$/, handleReportPage);

  // Текстовые сообщения (должен быть последним)
  bot.on("message:text", handleText);
}
