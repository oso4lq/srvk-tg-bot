// src/utils/format.ts

import { InlineKeyboard } from "grammy";

// ─── Форматирование ─────────────────────────────────────────

export function formatUptime(since: string): string {
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

export function formatTimeAgo(isoDate: string): string {
  if (!isoDate) return "—";
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}ч ${minutes % 60}м назад`;
  const days = Math.floor(hours / 24);
  return `${days}д ${hours % 24}ч назад`;
}

export function buildReportPage(
  header: string,
  incidents: string[],
  page: number
): { text: string; keyboard?: InlineKeyboard } {
  const pageSize = 10;
  const totalPages = Math.ceil(incidents.length / pageSize);
  const start = page * pageSize;
  const shown = incidents.slice(start, start + pageSize);

  let text = header;
  if (shown.length > 0) {
    text += "\n" + shown.map((i) => `  • ${i}`).join("\n");
  }
  if (totalPages > 1) {
    text += `\n\n📄 ${page + 1} / ${totalPages}`;
  }

  let keyboard: InlineKeyboard | undefined;
  if (totalPages > 1) {
    keyboard = new InlineKeyboard();
    if (page > 0) keyboard.text("◀️", `rpt:${page - 1}`);
    if (page < totalPages - 1) keyboard.text("▶️", `rpt:${page + 1}`);
  }

  return { text, keyboard };
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export function parseSystemdProps(stdout: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of stdout.trim().split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) props[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return props;
}
