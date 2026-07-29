#!/bin/bash
# Start all services required for secret-bot

set -e

echo "=== Starting Secret Bot Services ==="

# Check PostgreSQL
echo -n "PostgreSQL... "
if systemctl is-active --quiet postgresql 2>/dev/null || pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
    echo "OK"
else
    echo "Starting PostgreSQL..."
    sudo systemctl start postgresql
    echo "PostgreSQL started"
fi

# Check Redis
echo -n "Redis... "
if systemctl is-active --quiet redis 2>/dev/null || redis-cli ping >/dev/null 2>&1; then
    echo "OK"
else
    echo "Starting Redis..."
    sudo systemctl start redis
    echo "Redis started"
fi

# Check if bot is already running
echo -n "Secret Bot... "
if pgrep -f "tsx.*src/index.ts" >/dev/null 2>&1; then
    echo "Already running (PID: $(pgrep -f 'tsx.*src/index.ts'))"
else
    echo "Starting..."
    cd "$(dirname "$0")/.."
    nohup npm run dev > logs/bot.log 2>&1 &
    echo "Secret Bot started (check logs/bot.log)"
fi

echo ""
echo "=== All services status ==="
echo ""
echo "PostgreSQL: $(systemctl is-active postgresql 2>/dev/null || pg_isready -h localhost -p 5432 2>&1)"
echo "Redis: $(systemctl is-active redis 2>/dev/null || redis-cli ping 2>&1)"
echo "Secret Bot: $(pgrep -f 'tsx.*src/index.ts' >/dev/null 2>&1 && echo "Running (PID: $(pgrep -f 'tsx.*src/index.ts'))" || echo "Not running")"
echo ""
echo "To view bot logs: tail -f logs/bot.log"
echo "To stop bot: kill $(pgrep -f 'tsx.*src/index.ts')"
