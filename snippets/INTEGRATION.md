# Интеграция email.ts в index.ts — список изменений

## 1. Новый импорт (добавить в начало файла, после `import "dotenv/config"`)

```typescript
import { startEmailMonitor, stopEmailMonitor, isEmailConfigured } from "./email";
```

## 2. Новая функция `processEmailLink` (добавить перед секцией "Инициализация бота")

Эта функция — колбэк, который email.ts вызывает при нахождении ссылки.
Логика идентична обработчику `bot.on("message:text")`, но источник — письмо.

```typescript
// ─── Обработка ссылки из email ──────────────────────────────

/**
 * Обрабатывает VK call ссылку, полученную из email.
 * Вызывается из email-модуля при нахождении ссылки в письме.
 * Повторяет логику обработчика текстовых сообщений Telegram.
 */
async function processEmailLink(link: string, fromAddress: string): Promise<void> {
  // Валидация формата (на случай частичного совпадения regex в HTML)
  if (!VK_CALL_REGEX.test(link)) {
    console.log(`[Email] Ссылка не прошла валидацию: ${link}`);
    return;
  }

  const config = loadConfig();

  // Дедупликация: уже активна?
  if (link === config.vkCallLink) {
    await notifyAdmins(`📧 Письмо от ${fromAddress}\nℹ️ Ссылка уже активна, пропущена.`);
    return;
  }

  // Дедупликация: уже в очереди?
  if (config.linkQueue.includes(link)) {
    await notifyAdmins(`📧 Письмо от ${fromAddress}\nℹ️ Ссылка уже в очереди, пропущена.`);
    return;
  }

  // Добавляем в очередь
  config.linkQueue.push(link);
  saveConfig(config);

  await notifyAdmins(
    `📧 Ссылка из письма (${fromAddress})\n` +
    `✅ Добавлена в очередь (позиция ${config.linkQueue.length})`
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
}
```

## 3. Запуск email-мониторинга (в функции `main`, после `startMonitor()`)

```typescript
  // Запускаем мониторинг почты (если настроена)
  startEmailMonitor({
    onLinkFound: processEmailLink,
    onNotify: notifyAdmins,
  });
```

## 4. Остановка при shutdown (в обработчиках SIGINT и SIGTERM)

```typescript
process.on("SIGINT", () => {
  console.log("Остановка...");
  clearTimeout(monitorTimeout);
  stopEmailMonitor();  // ← добавить
  bot.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  clearTimeout(monitorTimeout);
  stopEmailMonitor();  // ← добавить
  bot.stop();
  process.exit(0);
});
```

## 5. Статус email в стартовом уведомлении (в `bot.start` → `onStart`)

Добавить строку в сообщение о запуске:

```typescript
const emailState = isEmailConfigured() ? `✅ ${process.env.YANDEX_MAIL_USER}` : "выключена";

notifyAdmins(
  `🟢 VK TURN Monitor запущен\n\n` +
  `Мониторинг: ${monitorState}\n` +
  `Публикация в VK: ${vkState}\n` +
  `Почта: ${emailState}\n` +             // ← добавить
  `${queueLine}\n\n` +
  `Для обновления ссылки отправь её в чат`,
  { reply_markup: mainKeyboard }
).catch(() => {});
```

## 6. Установка зависимостей

```bash
npm install imapflow mailparser
npm install -D @types/mailparser
```

`imapflow` имеет встроенные типы, `@types/mailparser` нужен отдельно.
