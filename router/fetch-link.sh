#!/bin/sh
# ============================================
# fetch-link.sh — опрос VK API и обновление туннеля
# Файл: /etc/vk-tunnel/fetch-link.sh
# Запуск: cron каждые 5 минут
# ============================================

# Загружаем конфигурацию
. /etc/vk-tunnel/config.sh

# --- Логирование ---
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$1] $2" >> "$LOG_FILE"
}

# Ограничиваем размер лога (последние 200 строк)
if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE")" -gt 500 ]; then
    tail -200 "$LOG_FILE" > "${LOG_FILE}.tmp"
    mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi

log "INFO" "=== Запуск проверки ==="

# --- Шаг 1: Запрос к VK API ---
# Читаем последний пост со стены группы (owner_id отрицательный для групп)
RESPONSE=$(curl -s --max-time 15 \
    "https://api.vk.com/method/wall.get?owner_id=-${VK_GROUP_ID}&count=1&access_token=${VK_TOKEN}&v=${VK_API_VERSION}" \
    2>> "$LOG_FILE")

# Проверяем, что curl отработал
if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
    log "ERROR" "Не удалось получить ответ от VK API"
    exit 1
fi

# Проверяем, нет ли ошибки в ответе VK
ERROR_MSG=$(echo "$RESPONSE" | grep -o '"error_msg":"[^"]*"' | head -1)
if [ -n "$ERROR_MSG" ]; then
    log "ERROR" "VK API вернул ошибку: $ERROR_MSG"
    exit 1
fi

# --- Шаг 2: Извлекаем ссылку ---
# grep -o вытаскивает первое совпадение с паттерном из JSON-ответа
NEW_LINK=$(echo "$RESPONSE" | grep -oE "$LINK_PATTERN" | head -1)

if [ -z "$NEW_LINK" ]; then
    log "WARN" "Ссылка не найдена в последнем посте группы"
    exit 0
fi

log "INFO" "Получена ссылка: $NEW_LINK"

# --- Шаг 3: Сравниваем с текущей ---
CURRENT_LINK=""
if [ -f "$CURRENT_LINK_FILE" ]; then
    CURRENT_LINK=$(cat "$CURRENT_LINK_FILE" 2>/dev/null)
fi

if [ "$NEW_LINK" = "$CURRENT_LINK" ]; then
    log "INFO" "Ссылка не изменилась, пропускаем"
    exit 0
fi

log "INFO" "Обнаружена новая ссылка! Старая: ${CURRENT_LINK:-<нет>}"

# --- Шаг 4: Сохраняем новую ссылку ---
echo "$NEW_LINK" > "$CURRENT_LINK_FILE"
log "INFO" "Ссылка сохранена в $CURRENT_LINK_FILE"

# --- Шаг 5: Перезапускаем vk-turn-client ---
# Останавливаем текущий процесс (если есть)
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        log "INFO" "Останавливаем vk-turn-client (PID: $OLD_PID)"
        kill "$OLD_PID"
        # Ждём завершения (макс 5 секунд)
        COUNT=0
        while kill -0 "$OLD_PID" 2>/dev/null && [ "$COUNT" -lt 5 ]; do
            sleep 1
            COUNT=$((COUNT + 1))
        done
        # Если не завершился — принудительно
        if kill -0 "$OLD_PID" 2>/dev/null; then
            kill -9 "$OLD_PID" 2>/dev/null
            log "WARN" "Принудительная остановка (SIGKILL)"
        fi
    fi
    rm -f "$PID_FILE"
fi

# Запускаем с новой ссылкой (с правильными флагами клиента)
if [ -x "$VK_TURN_CLIENT" ]; then
    $VK_TURN_CLIENT \
        -vk-link "$NEW_LINK" \
        -peer "$VK_TURN_PEER" \
        -listen "$VK_TURN_LISTEN" \
        -n "$VK_TURN_CHANNELS" \
        >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    log "INFO" "vk-turn-client запущен (PID: $!) с новой ссылкой"
else
    log "ERROR" "vk-turn-client не найден или не исполняемый: $VK_TURN_CLIENT"
    exit 1
fi

log "INFO" "=== Обновление завершено ==="
