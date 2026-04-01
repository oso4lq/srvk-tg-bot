# Link Queue & Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a queue of backup VK call links with automatic fallback when the active link dies.

**Architecture:** Extend existing `TurnConfig` with `linkQueue: string[]`. Auto-detected links go to queue instead of activating. Background health-check triggers fallback sweep on failure. Monitoring interval randomized via `setTimeout` chain.

**Tech Stack:** TypeScript, Grammy (Telegram bot), Node.js file I/O, VK API

**Spec:** `docs/superpowers/specs/2026-04-01-link-queue-fallback-design.md`

---

## File Structure

All changes in a single file:
- **Modify:** `src/index.ts` — all logic lives here (monolithic bot, ~860 lines)

No new files. No test framework in this project — testing is manual via Telegram.

---

### Task 1: Extend TurnConfig and loadConfig

**Files:**
- Modify: `src/index.ts:11-39` (TurnConfig interface)
- Modify: `src/index.ts:68-95` (loadConfig)
- Modify: `src/index.ts:70-87` (default config)

- [ ] **Step 1: Add `linkQueue` to TurnConfig interface**

After line 38 (`monitoringEnabled: boolean;`), add:

```typescript
  /** Очередь резервных VK call ссылок */
  linkQueue: string[];
```

- [ ] **Step 2: Add `linkQueue` to default config**

In `loadConfig()`, in the `defaultConfig` object (line 70-85), add after `monitoringEnabled: true`:

```typescript
      linkQueue: [],
```

- [ ] **Step 3: Add backwards compatibility**

In `loadConfig()`, after line 93 (`if (raw.monitoringEnabled === undefined) raw.monitoringEnabled = true;`), add:

```typescript
  if (!Array.isArray(raw.linkQueue)) raw.linkQueue = [];
```

- [ ] **Step 4: Build and verify no errors**

Run: `cd "D:/0. workat/Custom VPN/vk-turn-bot" && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: add linkQueue field to TurnConfig"
```

---

### Task 2: Add randomCheckInterval and refactor startMonitor

**Files:**
- Modify: `src/index.ts:50` (CHECK_INTERVAL_MS — keep but stop using)
- Modify: `src/index.ts:653` (monitorInterval variable)
- Modify: `src/index.ts:690-700` (startMonitor)
- Modify: `src/index.ts:847-858` (graceful shutdown)

- [ ] **Step 1: Add `randomCheckInterval` function**

Before `startMonitor()` (around line 689), add:

```typescript
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
```

- [ ] **Step 2: Change `monitorInterval` type from `setInterval` to `setTimeout`**

Replace line 653:
```typescript
let monitorInterval: ReturnType<typeof setInterval>;
```
with:
```typescript
let monitorTimeout: ReturnType<typeof setTimeout>;
```

- [ ] **Step 3: Refactor `startMonitor` to use setTimeout chain**

Replace `startMonitor()` (lines 690-700) with:

```typescript
function startMonitor(): void {
  console.log("Мониторинг запущен (рандомный интервал 5–10 мин)");

  // Первая проверка через 30 секунд после старта
  monitorTimeout = setTimeout(async function scheduleNext() {
    await runHealthCheck();
    const nextInterval = randomCheckInterval();
    monitorTimeout = setTimeout(scheduleNext, nextInterval);
  }, 30_000);
}
```

- [ ] **Step 4: Update graceful shutdown to clear setTimeout**

In both `SIGINT` and `SIGTERM` handlers (lines 847-858), replace:
```typescript
clearInterval(monitorInterval);
```
with:
```typescript
clearTimeout(monitorTimeout);
```

- [ ] **Step 5: Update `/config` display**

In `handleConfig` (line 621), replace:
```typescript
      `Интервал проверки: ${CHECK_INTERVAL_MS / 60_000} мин`
```
with:
```typescript
      `Интервал проверки: 5–10 мин (рандом)`
```

- [ ] **Step 6: Build and verify**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: randomize health-check interval 5-10 min via setTimeout chain"
```

---

### Task 3: Add fallback sweep logic

**Files:**
- Modify: `src/index.ts` — add new function after `checkTurnHealth` (around line 379)
- Modify: `src/index.ts:655-688` (runHealthCheck — integrate fallback)

- [ ] **Step 1: Add `tryFallbackFromQueue` function**

After `checkTurnHealth()` (around line 379), add:

```typescript
/**
 * Перебирает linkQueue, ищет живую ссылку для замены мёртвой активной.
 * Мёртвые ссылки удаляются из очереди. Живая активируется и постится в VK.
 * Возвращает true если fallback удался.
 */
async function tryFallbackFromQueue(): Promise<boolean> {
  if (isApplying) return false;
  isApplying = true;

  try {
    const config = loadConfig();
    const deadLink = config.vkCallLink;
    let activated = false;

    // Итерируем с конца, чтобы безопасно удалять по индексу
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
        // Активируем
        config.vkCallLink = candidate;
        config.updatedAt = new Date().toISOString();
        config.stats.lastCheckOk = true;
        config.stats.lastCheckAt = new Date().toISOString();
        config.stats.lastCheckDetails = `Fallback: переключение на резервную ссылку`;
        saveConfig(config);

        // Публикуем в VK (не фатально при ошибке)
        const vkResult = await publishToVk(candidate);
        const vkNote = vkResult.ok ? "" : `\n⚠️ VK: ${vkResult.error}`;

        await notifyAdmins(
          `🔄 Ссылка умерла, переключился на резервную\n` +
            `Новая: ${candidate}\n` +
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
    isApplying = false;
  }
}
```

- [ ] **Step 2: Integrate fallback into `runHealthCheck`**

In `runHealthCheck()`, after the block that sends the alert (around line 682-687):

```typescript
  // Алерт только если TURN упал
  if (!result.alive) {
    ...
  }
```

Replace the `if (!result.alive)` block with:

```typescript
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
    return; // saveConfig уже вызван выше и в tryFallbackFromQueue
  }
```

Note: move the incident logging BEFORE the fallback call (it was already there in the existing code at lines 668-676), and remove the duplicate `saveConfig(config)` at line 679 since we now call it inside the `if (!result.alive)` block.

The full updated `runHealthCheck` should look like:

```typescript
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
```

- [ ] **Step 3: Build and verify**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add fallback sweep from link queue on health-check failure"
```

---

### Task 4: Change auto-detect to add to queue

**Files:**
- Modify: `src/index.ts:640-649` (text message handler)

- [ ] **Step 1: Replace auto-detect handler**

Replace lines 640-649:

```typescript
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();

  if (/^https:\/\/vk\.(com|ru)\/call\/join\//.test(text)) {
    await applyLink(text, ctx);
    return;
  }

  await ctx.reply("Неизвестная команда. Отправь /start для списка команд.");
});
```

With:

```typescript
bot.on("message:text", async (ctx) => {
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
    return;
  }

  await ctx.reply("Неизвестная команда. Отправь /start для списка команд.");
});
```

- [ ] **Step 2: Build and verify**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: auto-detected links now added to queue instead of activating"
```

---

### Task 5: Add `/links` and `/rmlink` commands

**Files:**
- Modify: `src/index.ts` — add handlers after `/monitor` handler (around line 637)

- [ ] **Step 1: Add `/links` handler**

After the `/monitor` handler (line 637), add:

```typescript
// /links — просмотр очереди резервных ссылок
bot.command("links", async (ctx) => {
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
});
```

- [ ] **Step 2: Add `/rmlink` handler**

Right after `/links`:

```typescript
// /rmlink N — удаление ссылки из очереди по номеру
bot.command("rmlink", async (ctx) => {
  const arg = ctx.match?.trim();
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
});
```

- [ ] **Step 3: Build and verify**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add /links and /rmlink commands for queue management"
```

---

### Task 6: Update /start help, startup message, and daily report

**Files:**
- Modify: `src/index.ts:493-505` (/start help text)
- Modify: `src/index.ts:838-841` (startup notification)
- Modify: `src/index.ts:748-769` (daily report)
- Modify: `src/index.ts:804-844` (main — add fallback at startup)

- [ ] **Step 1: Update `/start` help text**

In the `/start` handler (line 493-505), update the message to include new commands. Replace the help text with:

```typescript
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
```

- [ ] **Step 2: Add queue count to daily report**

In `sendDailyReport()`, after the `Трафик за сутки` line (around line 756), add the queue count. Insert after:
```typescript
    `Трафик за сутки: ${trafficStr}`,
```
this line:
```typescript
    `Ссылок в очереди: ${config.linkQueue.length}`,
```

- [ ] **Step 3: Update startup: fallback FIRST, then notification**

Per spec: fallback runs after `bot.start()` but BEFORE startup notification, so the queue count in the notification reflects the post-fallback state.

Replace the entire `onStart` callback with:

```typescript
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
      const queueCount = startConfig.linkQueue.length;
      const queueLine = queueCount > 0
        ? `Ссылок в очереди: ${queueCount}`
        : "Очередь пуста";

      notifyAdmins(
        `🟢 VK TURN Monitor запущен\n\nМониторинг: ${monitorState}\nПубликация в VK: ${vkState}\n${queueLine}\n\nДля обновления ссылки отправь её в чат`,
        { reply_markup: mainKeyboard }
      ).catch(() => {});
    },
```

- [ ] **Step 4: Build and verify**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: update help, startup message, daily report with queue info; add startup fallback"
```

---

### Task 7: Build dist and final verification

**Files:**
- Modify: `dist/index.js` (compiled output)

- [ ] **Step 1: Build the project**

Run: `npx tsc`
Expected: `dist/index.js` updated, no errors

- [ ] **Step 2: Verify the compiled output exists**

Run: `ls -la dist/index.js`
Expected: file exists with recent timestamp

- [ ] **Step 3: Commit compiled output**

```bash
git add dist/
git commit -m "build: compile updated bot with link queue support"
```

---

## Manual Testing Checklist

After deployment, verify via Telegram:

1. `/start` — shows updated help with `/links` and `/rmlink`
2. Send a VK link as plain text — should add to queue, not activate
3. Send same link again — should say "already in queue"
4. `/links` — should show active link + numbered queue
5. `/rmlink 1` — should remove first link from queue
6. `/setlink <url>` — should force-activate, not touch queue
7. Startup message — should show queue count
8. Health-check interval — verify via logs that intervals vary (5-10 min)
