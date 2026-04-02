// src/links/apply.ts

import { Context, InlineKeyboard } from "grammy";
import { loadConfig, saveConfig } from "../config/config";
import { checkLinkHealth } from "../health/check-link";
import { publishToVk, isVkConfigured } from "./vk-api";

// ─── Применение ссылки ──────────────────────────────────────

export const VK_CALL_REGEX = /^https:\/\/vk\.(com|ru)\/call\/join\/[A-Za-z0-9_/-]+$/;

export let isApplying = false;

export function setIsApplying(value: boolean): void {
  isApplying = value;
}

/** Ожидающие подтверждения /setlink (ключ — message_id сообщения с кнопками) */
export const pendingSetlinks = new Map<number, {
  link: string;
  chatId: number;
  healthError: string;
  timeout: ReturnType<typeof setTimeout>;
}>();

/** Применяет ссылку: валидация → health check → подтверждение → сохранение → VK → отчёт */
export async function applyLink(link: string, ctx: Context): Promise<void> {
  if (isApplying) {
    await ctx.reply("⏳ Уже применяю ссылку, подожди.");
    return;
  }

  if (!VK_CALL_REGEX.test(link)) {
    await ctx.reply("❌ Неверный формат ссылки. Ожидается: https://vk.com/call/join/...");
    return;
  }

  const config = loadConfig();
  if (link === config.vkCallLink) {
    await ctx.reply("ℹ️ Эта ссылка уже активна.");
    return;
  }

  isApplying = true;
  const chatId = ctx.chat!.id;
  const statusMsg = await ctx.reply("⏳ Проверяю TURN...");

  const updateStatus = async (text: string, extra?: object) => {
    try {
      await ctx.api.editMessageText(chatId, statusMsg.message_id, text, extra);
    } catch {
      // Telegram может отклонить edit если текст не изменился
    }
  };

  try {
    // Шаг 1: health check ПЕРЕД сохранением
    const healthResult = await checkLinkHealth(link, config, async (attempt) => {
      await updateStatus(`⏳ Проверяю TURN (${attempt}/5)...`);
    });

    if (healthResult.alive) {
      // Ссылка жива — сохраняем и публикуем сразу
      try {
        config.vkCallLink = link;
        config.updatedAt = new Date().toISOString();
        saveConfig(config);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await updateStatus(`❌ Не удалось сохранить конфиг: ${msg}`);
        return;
      }

      const vkResult = await publishToVk(link);
      let vkStatus = "";
      if (vkResult.ok) {
        vkStatus = "VK обновлён";
      } else if (!isVkConfigured) {
        vkStatus = "VK relay не настроен";
      } else {
        vkStatus = `VK: ${vkResult.error}`;
      }

      config.stats.lastCheckOk = true;
      config.stats.lastCheckAt = new Date().toISOString();
      config.stats.lastCheckDetails = `Ссылка проверена, ${healthResult.attempts} попыток`;
      saveConfig(config);

      const parts = ["✅ Ссылка применена, TURN жив", vkStatus];
      if (healthResult.error) parts.push(healthResult.error);
      await updateStatus(parts.join("\n"));
    } else {
      // Ссылка мертва — спрашиваем подтверждение
      const keyboard = new InlineKeyboard()
        .text("Да", `setlink:yes:${statusMsg.message_id}`)
        .text("Нет", `setlink:no:${statusMsg.message_id}`);

      await updateStatus(
        `⚠️ Ссылка не прошла проверку (${healthResult.attempts}/5 попыток).\n` +
          `Соединение невозможно установить. Сохранить?`,
        { reply_markup: keyboard }
      );

      // Таймаут 2 минуты — автоотмена
      const timeout = setTimeout(async () => {
        pendingSetlinks.delete(statusMsg.message_id);
        try {
          await ctx.api.deleteMessage(chatId, statusMsg.message_id);
        } catch {}
      }, 120_000);

      pendingSetlinks.set(statusMsg.message_id, {
        link,
        chatId,
        healthError: healthResult.error || "TURN не отвечает",
        timeout,
      });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await updateStatus(`❌ Ошибка: ${msg}`);
  } finally {
    isApplying = false;
  }
}
