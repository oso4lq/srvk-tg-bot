# Auto-apply VK Call Link — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When admin sends a VK call link, the bot automatically saves it, publishes to VK, verifies TURN connectivity with retries, and reports the result.

**Architecture:** Single-file bot (`src/index.ts`). Add VK API publishing via native `fetch`, a retry health check, and an `applyLink()` orchestrator. Simplify `/restart` to plain `systemctl restart`. No new dependencies.

**Tech Stack:** TypeScript, Grammy, Node 20 native `fetch`, VK API `wall.edit`

**Spec:** `docs/superpowers/specs/2026-03-31-auto-apply-vk-link-design.md`

**Note:** Line numbers reference the original `src/index.ts`. After each task the file grows — use function/section names as anchors, not absolute line numbers.

---

### Task 1: Add VK env variables and config check

**Files:**
- Modify: `src/index.ts:31-36` (env constants section)
- Modify: `.env.example`

- [ ] **Step 1: Add VK constants to env section in `src/index.ts`**

After line 36 (`CHECK_INTERVAL_MS`), add:

```typescript
// VK API для публикации ссылки на стену закрытой группы
const VK_GROUP_TOKEN = process.env.VK_GROUP_TOKEN || "";
const VK_GROUP_ID = process.env.VK_GROUP_ID || "";
const VK_POST_ID = process.env.VK_POST_ID || "";
const isVkConfigured = !!(VK_GROUP_TOKEN && VK_GROUP_ID && VK_POST_ID);
```

- [ ] **Step 2: Add startup warning for partial VK config**

In `main()` function, after `loadConfig()` call (line 419), add:

```typescript
if (!isVkConfigured) {
  const hasAny = VK_GROUP_TOKEN || VK_GROUP_ID || VK_POST_ID;
  if (hasAny) {
    console.warn("VK relay частично настроен — нужны все три: VK_GROUP_TOKEN, VK_GROUP_ID, VK_POST_ID");
  } else {
    console.log("VK relay не настроен — публикация ссылок в VK отключена");
  }
}
```

- [ ] **Step 3: Update `.env.example`**

Add at the end of `.env.example`:

```env

# VK API для публикации ссылки (опционально)
# Закрытая группа, куда бот публикует ссылку для роутера
VK_GROUP_TOKEN=
VK_GROUP_ID=
VK_POST_ID=
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd "D:/0. workat/Custom VPN/vk-turn-bot" && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/index.ts .env.example
git commit -m "feat: add VK API env variables for wall.edit relay"
```

---

### Task 2: Add `publishToVk()` function

**Files:**
- Modify: `src/index.ts` (add after `saveConfig` function, ~line 63)

- [ ] **Step 1: Add `publishToVk` function**

Insert after the `saveConfig` function (after line 63):

```typescript
// ─── VK API ─────────────────────────────────────────────────

/** Публикует ссылку в закреплённый пост закрытой VK-группы */
async function publishToVk(link: string): Promise<{ ok: boolean; error?: string }> {
  if (!isVkConfigured) {
    return { ok: false, error: "VK relay не настроен" };
  }

  try {
    const params = new URLSearchParams({
      access_token: VK_GROUP_TOKEN,
      owner_id: `-${VK_GROUP_ID}`,
      post_id: VK_POST_ID,
      message: link,
      v: "5.199",
    });

    const res = await fetch("https://api.vk.com/method/wall.edit", {
      method: "POST",
      body: params,
    });

    const data = await res.json() as { response?: { post_id: number }; error?: { error_code: number; error_msg: string } };

    if (data.error) {
      const { error_code, error_msg } = data.error;
      return { ok: false, error: `VK API ${error_code}: ${error_msg}` };
    }

    if (data.response?.post_id) {
      return { ok: true };
    }

    return { ok: false, error: "VK API: неожиданный ответ" };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `VK API: ${msg}` };
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add publishToVk() for wall.edit relay"
```

---

### Task 3: Add `checkLinkHealth()` with retries

**Files:**
- Modify: `src/index.ts` (add after `publishToVk` function)

- [ ] **Step 1: Add `checkLinkHealth` function**

Insert after `publishToVk`:

```typescript
/** Проверяет валидность VK call link через TURN-клиент (до maxAttempts попыток) */
async function checkLinkHealth(
  link: string,
  config: TurnConfig,
  onAttempt?: (attempt: number) => void,
  maxAttempts = 5,
  intervalMs = 10_000,
): Promise<{ alive: boolean; attempts: number; error?: string }> {
  for (let i = 1; i <= maxAttempts; i++) {
    if (onAttempt) onAttempt(i);

    try {
      await execAsync(
        `timeout 15 ${VK_TURN_CLIENT_PATH} ` +
          `-link "${link}" ` +
          `-peer ${config.wgPeerAddress}:${config.turnListenPort} ` +
          `-listen 127.0.0.1:0 ` +
          `-n 1 2>&1`,
        { timeout: 20_000 }
      );
      // Клиент завершился успешно (exit 0) — ссылка валидна
      return { alive: true, attempts: i };
    } catch (error: any) {
      // timeout kill → клиент работал >15 сек, т.е. сессия установлена.
      // Node exec error имеет свойства: killed (boolean), signal (string), code (number).
      // `timeout 15` убивает процесс → killed=true или code=124.
      if (error?.killed || error?.signal === "SIGTERM" || error?.code === 124) {
        return { alive: true, attempts: i };
      }

      // Реальная ошибка — клиент завершился быстро с ошибкой
      if (i < maxAttempts) {
        await new Promise((r) => setTimeout(r, intervalMs));
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        return { alive: false, attempts: i, error: msg.slice(0, 200) };
      }
    }
  }

  return { alive: false, attempts: maxAttempts };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add checkLinkHealth() with retry logic"
```

---

### Task 4: Add `applyLink()` orchestrator

**Files:**
- Modify: `src/index.ts` (add after `checkLinkHealth`, add `isApplying` flag near globals)

- [ ] **Step 1: Add concurrency flag**

After `const CHECK_INTERVAL_MS = ...` (and the VK constants from Task 1), add:

```typescript
let isApplying = false;
```

- [ ] **Step 2: Add `applyLink` function**

Insert after `checkLinkHealth`:

```typescript
// ─── Применение ссылки ──────────────────────────────────────

const VK_CALL_REGEX = /^https:\/\/vk\.com\/call\/join\/[A-Za-z0-9_/-]+$/;

/** Применяет ссылку: валидация → сохранение → VK → health check → отчёт */
async function applyLink(link: string, ctx: Context): Promise<void> {
  // Concurrency guard
  if (isApplying) {
    await ctx.reply("⏳ Уже применяю ссылку, подожди.");
    return;
  }

  // Валидация
  if (!VK_CALL_REGEX.test(link)) {
    await ctx.reply("❌ Неверный формат ссылки. Ожидается: https://vk.com/call/join/...");
    return;
  }

  // Дедупликация
  const config = loadConfig();
  if (link === config.vkCallLink) {
    await ctx.reply("ℹ️ Эта ссылка уже активна.");
    return;
  }

  isApplying = true;
  const statusMsg = await ctx.reply("⏳ Применяю ссылку...");
  const chatId = ctx.chat!.id;

  const updateStatus = async (text: string) => {
    try {
      await ctx.api.editMessageText(chatId, statusMsg.message_id, text);
    } catch {
      // Telegram может отклонить edit если текст не изменился
    }
  };

  try {
    // Шаг 2: сохранение
    try {
      config.vkCallLink = link;
      config.updatedAt = new Date().toISOString();
      saveConfig(config);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await updateStatus(`❌ Не удалось сохранить конфиг: ${msg}`);
      return;
    }

    // Шаг 3: VK
    let vkStatus = "";
    await updateStatus("⏳ Ссылка сохранена. Публикую в VK...");

    const vkResult = await publishToVk(link);
    if (vkResult.ok) {
      vkStatus = "VK обновлён";
    } else if (!isVkConfigured) {
      vkStatus = "VK relay не настроен";
    } else {
      vkStatus = `VK: ${vkResult.error}`;
    }

    // Шаг 4: health check с retries
    const healthResult = await checkLinkHealth(link, config, async (attempt) => {
      await updateStatus(`⏳ ${vkStatus}. Проверяю TURN (${attempt}/5)...`);
    });

    // Шаг 5: финальный отчёт
    const parts: string[] = [];

    if (healthResult.alive) {
      parts.push("✅ Ссылка применена, TURN жив");
    } else {
      parts.push(`⚠️ Ссылка сохранена, но TURN не отвечает (${healthResult.attempts}/5 попыток)`);
    }
    parts.push(vkStatus);

    if (healthResult.alive) {
      config.stats.lastCheckOk = true;
    } else {
      config.stats.lastCheckOk = false;
    }
    config.stats.lastCheckAt = new Date().toISOString();
    saveConfig(config);

    await updateStatus(parts.join("\n"));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await updateStatus(`❌ Ошибка: ${msg}`);
  } finally {
    isApplying = false;
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add applyLink() orchestrator with progress updates"
```

---

### Task 5: Simplify `/restart` command

**Files:**
- Modify: `src/index.ts:164-210` (replace `restartService` function)

- [ ] **Step 1: Replace `restartService` function**

Replace the entire `restartService` function (lines 164-210) with:

```typescript
/** Перезапускает vk-turn-proxy сервис (простой restart без override) */
async function restartService(): Promise<string> {
  try {
    await execAsync(`systemctl restart ${SYSTEMD_SERVICE}`);

    // Ждём 3 секунды и проверяем
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const { stdout } = await execAsync(
      `systemctl is-active ${SYSTEMD_SERVICE}`
    );

    const config = loadConfig();
    config.stats.totalRestarts++;
    config.stats.uptimeSince = new Date().toISOString();
    saveConfig(config);

    if (stdout.trim() === "active") {
      return "Сервис перезапущен. Статус: active";
    }
    return `Сервис перезапущен, но статус: ${stdout.trim()}. Проверь логи!`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Ошибка перезапуска: ${msg}`);
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "refactor: simplify /restart to plain systemctl restart"
```

---

### Task 6: Rewire bot handlers

**Files:**
- Modify: `src/index.ts` — `/setlink` handler (lines 278-294), text message handler (lines 357-369)

- [ ] **Step 1: Replace `/setlink` handler**

Replace lines 278-294 with:

```typescript
// /setlink — применение ссылки на VK-звонок
bot.command("setlink", async (ctx) => {
  const link = ctx.match?.trim();

  if (!link) {
    await ctx.reply("Использование: /setlink https://vk.com/call/join/...");
    return;
  }

  await applyLink(link, ctx);
});
```

- [ ] **Step 2: Replace text message handler**

Replace lines 357-369 with:

```typescript
// Обработка текстовых сообщений — автоприменение VK-ссылки
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();

  if (text.startsWith("https://vk.com/call/join/")) {
    await applyLink(text, ctx);
    return;
  }

  await ctx.reply("Неизвестная команда. Отправь /start для списка команд.");
});
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: rewire /setlink and text handler to use applyLink()"
```

---

### Task 7: Remove dead code and clean up

**Files:**
- Modify: `src/index.ts` — delete `updateCallLink` function

- [ ] **Step 1: Delete `updateCallLink` function**

Remove the entire `updateCallLink` function (the one with JSDoc "Извлекает данные из ссылки VK-звонка и обновляет конфиг" — approximately 20 lines). This logic is now inside `applyLink`.

- [ ] **Step 2: Update monitor alert text**

In `runHealthCheck`, replace the alert message (line 392-393):

```typescript
`🚨 TURN не отвечает!\n\n${result.details}\n\n` +
  `Отправь новую ссылку VK-звонка или выполни /restart`
```

with:

```typescript
`🚨 TURN не отвечает!\n\n${result.details}\n\n` +
  `Отправь новую ссылку VK-звонка`
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "refactor: remove dead updateCallLink, update alert text"
```

---

### Task 8: Final verification

- [ ] **Step 1: Full TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: compiles to `dist/` without errors

- [ ] **Step 3: Verify file is coherent**

Read through `src/index.ts` top to bottom and verify:
- No orphaned imports
- No references to deleted functions
- All new functions are called
- `VK_CALL_REGEX` used in `applyLink`, not duplicated elsewhere
- The old regex in `updateCallLink` is gone

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "chore: final cleanup after auto-apply refactor"
```
