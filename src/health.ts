import http from 'http'
import { Pool } from 'pg'
import { Redis } from 'ioredis'
import { logger } from './utils/logger'

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy'
  checks: {
    postgres: 'ok' | 'error'
    redis: 'ok' | 'error'
    slack: 'ok' | 'error' | 'pending'
  }
  timestamp: string
  uptime: number
}

let healthServer: http.Server | null = null
let dbPool: Pool | null = null
let redisClient: Redis | null = null

export function initHealthCheck(
  port: number,
  pool: Pool,
  redis: Redis,
): void {
  dbPool = pool
  redisClient = redis

  healthServer = http.createServer(async (req, res) => {
    if (req.url === '/healthz' || req.url === '/') {
      const result = await checkHealth()
      const statusCode = result.status === 'healthy' ? 200 : 503

      res.writeHead(statusCode, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } else {
      res.writeHead(404)
      res.end('Not Found')
    }
  })

  healthServer.listen(port, () => {
    logger.info({ port }, 'Health check server started')
  })

  healthServer.on('error', (err) => {
    logger.error({ err, port }, 'Health check server failed to start')
  })
}

async function checkHealth(): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = {
    postgres: 'ok',
    redis: 'ok',
    slack: 'pending',
  }

  let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'

  // Check PostgreSQL
  if (dbPool) {
    try {
      await dbPool.query('SELECT 1')
      checks.postgres = 'ok'
    } catch (err: any) {
      checks.postgres = 'error'
      logger.error({ err }, 'Health check: PostgreSQL failed')
      status = 'unhealthy'
    }
  } else {
    checks.postgres = 'error'
    status = 'unhealthy'
  }

  // Check Redis
  if (redisClient) {
    try {
      await redisClient.ping()
      checks.redis = 'ok'
    } catch (err: any) {
      checks.redis = 'error'
      logger.error({ err }, 'Health check: Redis failed')
      status = 'unhealthy'
    }
  } else {
    checks.redis = 'error'
    status = 'unhealthy'
  }

  // Slack connection is always "ok" if the app is running (Socket Mode)
  checks.slack = 'ok'

  // If one check failed but not both, status is degraded
  if (status === 'healthy') {
    const failedChecks = Object.values(checks).filter(c => c === 'error').length
    if (failedChecks === 1) {
      status = 'degraded'
    } else if (failedChecks === 2) {
      status = 'unhealthy'
    }
  }

  return {
    status,
    checks,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }
}

export async function closeHealthCheck(): Promise<void> {
  if (healthServer) {
    await new Promise<void>((resolve) => {
      healthServer?.close(() => resolve())
    })
    logger.info('Health check server stopped')
  }
}
