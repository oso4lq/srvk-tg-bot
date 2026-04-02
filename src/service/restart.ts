import { exec } from "child_process";
import { promisify } from "util";
import { SYSTEMD_SERVICE, loadConfig, saveConfig } from "../config/config";

const execAsync = promisify(exec);

// ─── Управление сервисом ────────────────────────────────────

/** Перезапускает vk-turn-proxy сервис (простой restart без override) */
export async function restartService(): Promise<string> {
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
