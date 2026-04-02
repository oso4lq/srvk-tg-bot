import { Context } from "grammy";
import { loadConfig, saveConfig } from "../config/config";
import { pendingSetlinks, isApplying, setIsApplying } from "../links/apply";
import { publishToVk, isVkConfigured } from "../links/vk-api";
import { pendingReports } from "../monitoring/daily-report";
import { buildReportPage } from "../utils/format";

// ─── Callback queries ───────────────────────────────────────

// Callback: подтверждение /setlink для мёртвой ссылки
export async function handleSetlinkYes(ctx: Context): Promise<void> {
  const msgId = Number(ctx.callbackQuery!.data!.split(":")[2]);
  const pending = pendingSetlinks.get(msgId);

  if (!pending) {
    await ctx.answerCallbackQuery({ text: "Запрос устарел" });
    return;
  }

  clearTimeout(pending.timeout);
  pendingSetlinks.delete(msgId);

  if (isApplying) {
    await ctx.answerCallbackQuery({ text: "⏳ Уже применяю ссылку, подожди" });
    return;
  }

  setIsApplying(true);
  await ctx.answerCallbackQuery();

  try {
    const config = loadConfig();
    config.vkCallLink = pending.link;
    config.updatedAt = new Date().toISOString();
    config.stats.lastCheckOk = false;
    config.stats.lastCheckAt = new Date().toISOString();
    config.stats.lastCheckDetails = pending.healthError;
    saveConfig(config);

    const vkResult = await publishToVk(pending.link);
    let vkStatus = "";
    if (vkResult.ok) {
      vkStatus = "\nVK обновлён";
    } else if (!isVkConfigured) {
      vkStatus = "\nVK relay не настроен";
    } else {
      vkStatus = `\nVK: ${vkResult.error}`;
    }

    await ctx.api.editMessageText(
      pending.chatId,
      msgId,
      `⚠️ Ссылка сохранена, но соединение невозможно установить.${vkStatus}`
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    try {
      await ctx.api.editMessageText(pending.chatId, msgId, `❌ Ошибка: ${msg}`);
    } catch {}
  } finally {
    setIsApplying(false);
  }
}

export async function handleSetlinkNo(ctx: Context): Promise<void> {
  const msgId = Number(ctx.callbackQuery!.data!.split(":")[2]);
  const pending = pendingSetlinks.get(msgId);

  if (!pending) {
    await ctx.answerCallbackQuery({ text: "Запрос устарел" });
    return;
  }

  clearTimeout(pending.timeout);
  pendingSetlinks.delete(msgId);
  await ctx.answerCallbackQuery();

  try {
    await ctx.api.deleteMessage(pending.chatId, msgId);
  } catch {}
}

// Callback: пагинация инцидентов в ежедневном отчёте
export async function handleReportPage(ctx: Context): Promise<void> {
  const page = Number(ctx.callbackQuery!.data!.split(":")[1]);
  const chatId = ctx.callbackQuery!.message?.chat.id;
  const msgId = ctx.callbackQuery!.message?.message_id;

  if (!chatId || !msgId) {
    await ctx.answerCallbackQuery({ text: "Ошибка" });
    return;
  }

  const key = `${chatId}:${msgId}`;
  const report = pendingReports.get(key);

  if (!report) {
    await ctx.answerCallbackQuery({ text: "Отчёт устарел" });
    return;
  }

  const { text, keyboard } = buildReportPage(report.header, report.incidents, page);
  await ctx.answerCallbackQuery();
  await ctx.api.editMessageText(chatId, msgId, text, keyboard ? { reply_markup: keyboard } : undefined);
}
