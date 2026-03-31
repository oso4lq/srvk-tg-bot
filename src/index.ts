import { Bot, Context } from "grammy";
import { exec, execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { promisify } from "util";
import "dotenv/config";

const execAsync = promisify(exec);

// ─── Конфигурация ───────────────────────────────────────────

interface TurnConfig {
  /** Текущая ссылка на VK-звонок */
  vkCallLink: string;
  /** IP VPS для WireGuard-пира */
  wgPeerAddress: string;
  /** Порт WireGuard */
  wgPeerPort: number;
  /** Порт vk-turn-proxy сервера */
  turnListenPort: number;
  /** Метка времени последнего обновления ссылки */
  updatedAt: string;
  /** Статистика */
  stats: {
    totalRestarts: number;
    lastCheckOk: boolean;
    lastCheckAt: string;
    uptimeSince: string;
  };
}

const BOT_TOKEN = process.env.BOT_TOKEN!;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID!);
const CONFIG_PATH = process.env.CONFIG_PATH || "/etc/vk-turn-proxy/config.json";
const SYSTEMD_SERVICE = process.env.SYSTEMD_SERVICE || "vk-turn-proxy";
const VK_TURN_CLIENT_PATH = process.env.VK_TURN_CLIENT_PATH || "/usr/local/bin/vk-turn-client";
const CHECK_INTERVAL_MS = (Number(process.env.CHECK_INTERVAL_MIN) || 5) * 60 * 1000;

// ─── Работа с конфигом ──────────────────────────────────────

function loadConfig(): TurnConfig {
  if (!existsSync(CONFIG_PATH)) {
    const defaultConfig: TurnConfig = {
      vkCallLink: "",
      wgPeerAddress: process.env.WG_PEER_IP || "127.0.0.1",
      wgPeerPort: Number(process.env.WG_PEER_PORT) || 51820,
      turnListenPort: Number(process.env.VK_TURN_LISTEN_PORT) || 56000,
      updatedAt: new Date().toISOString(),
      stats: {
        totalRestarts: 0,
        lastCheckOk: false,
        lastCheckAt: "",
        uptimeSince: "",
      },
    };
    saveConfig(defaultConfig);
    return defaultConfig;
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

function saveConfig(config: TurnConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

// ─── Проверка здоровья TURN ─────────────────────────────────

/**
 * Проверяет, жива ли связка vk-turn-proxy.
 *
 * Стратегия: запускаем клиент vk-turn-proxy с таймаутом 15 сек.
 * Если клиент успевает установить TURN-соединение — ссылка жива.
 * Если таймаут или ошибка — ссылка мертва.
 *
 * Альтернатива: проверяем, что systemd-сервис активен
 * и есть активные UDP-сокеты на нужном порту.
 */
async function checkTurnHealth(): Promise<{
  alive: boolean;
  details: string;
}> {
  const config = loadConfig();

  if (!config.vkCallLink) {
    return { alive: false, details: "Ссылка на VK-звонок не задана" };
  }

  try {
    // Проверка 1: systemd-сервис запущен?
    const { stdout: serviceStatus } = await execAsync(
      `systemctl is-active ${SYSTEMD_SERVICE} 2>/dev/null || echo "inactive"`
    );

    if (serviceStatus.trim() !== "active") {
      return {
        alive: false,
        details: `Сервис ${SYSTEMD_SERVICE} не запущен (${serviceStatus.trim()})`,
      };
    }

    // Проверка 2: есть ли активные UDP-соединения на порту?
    const { stdout: connections } = await execAsync(
      `ss -unlp | grep ":${config.turnListenPort}" | wc -l`
    );

    const connCount = parseInt(connections.trim(), 10);

    if (connCount === 0) {
      return {
        alive: false,
        details: "Сервис запущен, но нет активных UDP-соединений",
      };
    }

    // Проверка 3: пробуем подключиться клиентом с коротким таймаутом
    // Клиент пытается установить TURN-сессию и выходит
    try {
      await execAsync(
        `timeout 15 ${VK_TURN_CLIENT_PATH} ` +
          `-link "${config.vkCallLink}" ` +
          `-peer ${config.wgPeerAddress}:${config.turnListenPort} ` +
          `-listen 127.0.0.1:0 ` + // Случайный порт, просто проверка
          `-n 1 2>&1 | head -5`,
        { timeout: 20_000 }
      );
    } catch {
      // Таймаут — нормально, значит клиент подключился и мы его убили.
      // Если бы ссылка была мертва, он бы вернул ошибку раньше 15 сек.
    }

    return {
      alive: true,
      details: `Сервис активен, ${connCount} UDP-соединений`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { alive: false, details: `Ошибка проверки: ${msg}` };
  }
}

// ─── Управление сервисом ────────────────────────────────────

/** Извлекает данные из ссылки VK-звонка и обновляет конфиг */
async function updateCallLink(newLink: string): Promise<string> {
  // Валидация формата ссылки
  const vkCallRegex = /^https:\/\/vk\.com\/call\/join\/[A-Za-z0-9_/-]+$/;
  if (!vkCallRegex.test(newLink)) {
    throw new Error(
      "Неверный формат ссылки. Ожидается: https://vk.com/call/join/..."
    );
  }

  const config = loadConfig();
  const oldLink = config.vkCallLink;

  config.vkCallLink = newLink;
  config.updatedAt = new Date().toISOString();
  saveConfig(config);

  return oldLink
    ? `Ссылка обновлена.\nСтарая: ${oldLink.slice(0, 40)}...\nНовая: ${newLink.slice(0, 40)}...`
    : `Ссылка установлена: ${newLink.slice(0, 40)}...`;
}

/** Перезапускает vk-turn-proxy сервис с новыми параметрами */
async function restartService(): Promise<string> {
  const config = loadConfig();

  if (!config.vkCallLink) {
    throw new Error("Сначала задай ссылку на VK-звонок через /setlink");
  }

  try {
    // Обновляем аргументы в systemd override
    const overrideContent = [
      "[Service]",
      `ExecStart=`,
      `ExecStart=${VK_TURN_CLIENT_PATH}-server \\`,
      `  -listen 0.0.0.0:${config.turnListenPort} \\`,
      `  -connect 127.0.0.1:${config.wgPeerPort}`,
    ].join("\n");

    writeFileSync(
      `/etc/systemd/system/${SYSTEMD_SERVICE}.service.d/override.conf`,
      overrideContent
    );

    await execAsync("systemctl daemon-reload");
    await execAsync(`systemctl restart ${SYSTEMD_SERVICE}`);

    // Ждём 3 секунды и проверяем, что сервис поднялся
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const { stdout } = await execAsync(
      `systemctl is-active ${SYSTEMD_SERVICE}`
    );

    config.stats.totalRestarts++;
    config.stats.uptimeSince = new Date().toISOString();
    saveConfig(config);

    if (stdout.trim() === "active") {
      return `Сервис перезапущен. Статус: active`;
    } else {
      return `Сервис перезапущен, но статус: ${stdout.trim()}. Проверь логи!`;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Ошибка перезапуска: ${msg}`);
  }
}

// ─── Форматирование ─────────────────────────────────────────

function formatUptime(since: string): string {
  if (!since) return "неизвестно";
  const diff = Date.now() - new Date(since).getTime();
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}д ${hours % 24}ч`;
  }
  return `${hours}ч ${minutes}м`;
}

// ─── Гарда: только админ ────────────────────────────────────

function isAdmin(ctx: Context): boolean {
  return ctx.from?.id === ADMIN_CHAT_ID;
}

// ─── Инициализация бота ─────────────────────────────────────

const bot = new Bot(BOT_TOKEN);

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
      "Команды:\n" +
      "/status — проверка здоровья TURN\n" +
      "/setlink <url> — установить ссылку на VK-звонок\n" +
      "/restart — перезапустить vk-turn-proxy\n" +
      "/stats — статистика\n" +
      "/config — текущая конфигурация"
  );
});

// /status — проверка TURN
bot.command("status", async (ctx) => {
  const msg = await ctx.reply("⏳ Проверяю TURN...");

  const result = await checkTurnHealth();
  const config = loadConfig();

  config.stats.lastCheckOk = result.alive;
  config.stats.lastCheckAt = new Date().toISOString();
  saveConfig(config);

  const icon = result.alive ? "✅" : "❌";
  await ctx.api.editMessageText(
    ctx.chat!.id,
    msg.message_id,
    `${icon} TURN ${result.alive ? "жив" : "мёртв"}\n\n${result.details}`
  );
});

// /setlink — обновление ссылки на VK-звонок
bot.command("setlink", async (ctx) => {
  const link = ctx.match?.trim();

  if (!link) {
    await ctx.reply("Использование: /setlink https://vk.com/call/join/...");
    return;
  }

  try {
    const result = await updateCallLink(link);
    await ctx.reply(`✅ ${result}\n\nВыполни /restart для применения.`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ ${msg}`);
  }
});

// /restart — перезапуск сервиса
bot.command("restart", async (ctx) => {
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
});

// /stats — статистика
bot.command("stats", async (ctx) => {
  const config = loadConfig();
  const s = config.stats;

  let serviceInfo = "неизвестно";
  try {
    const { stdout } = await execAsync(
      `systemctl show ${SYSTEMD_SERVICE} --property=ActiveState,MemoryCurrent 2>/dev/null`
    );
    serviceInfo = stdout.trim().replace(/\n/g, ", ");
  } catch {
    // Сервис может быть не установлен на этапе разработки
  }

  await ctx.reply(
    `📊 Статистика VK TURN Proxy\n\n` +
      `Аптайм: ${formatUptime(s.uptimeSince)}\n` +
      `Перезапусков: ${s.totalRestarts}\n` +
      `Последняя проверка: ${s.lastCheckAt ? new Date(s.lastCheckAt).toLocaleString("ru") : "—"}\n` +
      `Результат: ${s.lastCheckOk ? "✅ OK" : "❌ Fail"}\n` +
      `Сервис: ${serviceInfo}\n` +
      `Ссылка обновлена: ${config.updatedAt ? new Date(config.updatedAt).toLocaleString("ru") : "—"}`
  );
});

// /config — текущая конфигурация (без секретов)
bot.command("config", async (ctx) => {
  const config = loadConfig();

  // Маскируем ссылку — показываем только начало
  const maskedLink = config.vkCallLink
    ? config.vkCallLink.slice(0, 35) + "..."
    : "не задана";

  await ctx.reply(
    `⚙️ Конфигурация\n\n` +
      `VK-звонок: ${maskedLink}\n` +
      `WG peer: ${config.wgPeerAddress}:${config.wgPeerPort}\n` +
      `TURN порт: ${config.turnListenPort}\n` +
      `Интервал проверки: ${CHECK_INTERVAL_MS / 60_000} мин`
  );
});

// Обработка простых сообщений — если прислали ссылку VK, предлагаем /setlink
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;

  if (text.startsWith("https://vk.com/call/join/")) {
    await ctx.reply(
      `Похоже на ссылку VK-звонка. Применить?\n\n/setlink ${text}`
    );
    return;
  }

  await ctx.reply("Неизвестная команда. Отправь /start для списка команд.");
});

// ─── Фоновый мониторинг ─────────────────────────────────────

let monitorInterval: ReturnType<typeof setInterval>;

async function runHealthCheck(): Promise<void> {
  const config = loadConfig();

  // Не проверяем, если ссылка не задана
  if (!config.vkCallLink) return;

  const result = await checkTurnHealth();

  config.stats.lastCheckOk = result.alive;
  config.stats.lastCheckAt = new Date().toISOString();
  saveConfig(config);

  // Алерт только если TURN упал
  if (!result.alive) {
    try {
      await bot.api.sendMessage(
        ADMIN_CHAT_ID,
        `🚨 TURN не отвечает!\n\n${result.details}\n\n` +
          `Отправь новую ссылку VK-звонка или выполни /restart`
      );
    } catch (error) {
      console.error("Не удалось отправить алерт:", error);
    }
  }
}

function startMonitor(): void {
  console.log(
    `Мониторинг запущен, интервал: ${CHECK_INTERVAL_MS / 60_000} мин`
  );

  // Первая проверка через 30 секунд после старта
  setTimeout(() => runHealthCheck(), 30_000);

  // Далее — по расписанию
  monitorInterval = setInterval(() => runHealthCheck(), CHECK_INTERVAL_MS);
}

// ─── Запуск ─────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("VK TURN Proxy Monitor запускается...");

  // Инициализируем конфиг, если его нет
  loadConfig();

  // Запускаем фоновый мониторинг
  startMonitor();

  // Запускаем бота
  bot.start({
    onStart: () => {
      console.log("Бот запущен");

      // Уведомляем админа о запуске
      bot.api
        .sendMessage(ADMIN_CHAT_ID, "🟢 VK TURN Monitor запущен")
        .catch(() => {});
    },
  });
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("Остановка...");
  clearInterval(monitorInterval);
  bot.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  clearInterval(monitorInterval);
  bot.stop();
  process.exit(0);
});

main().catch(console.error);
