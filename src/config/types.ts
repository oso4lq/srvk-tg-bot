// ─── Типы конфигурации ──────────────────────────────────────

export interface TurnConfig {
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
    lastCheckDetails: string;
    uptimeSince: string;
  };
  /** Дневная статистика (сбрасывается при отправке отчёта) */
  dailyStats: {
    failedChecks: number;
    incidents: string[];
    periodStart: string;
    trafficSnapshotBytes: number;
  };
  /** Мониторинг включён */
  monitoringEnabled: boolean;
  /** Очередь резервных VK call ссылок */
  linkQueue: string[];
}

export const DEFAULT_DAILY_STATS = (): TurnConfig["dailyStats"] => ({
  failedChecks: 0,
  incidents: [],
  periodStart: new Date().toISOString(),
  trafficSnapshotBytes: 0,
});
