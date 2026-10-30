import { execFile } from 'child_process'
import { logger } from './logger'

// execFile has no option to pipe a buffer to the child's stdin (that's a
// spawnSync/execFileSync-only feature) - write to the ChildProcess's stdin
// stream manually instead.
function runClamscan(fileBuffer: Buffer): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'clamscan',
      ['--no-summary', '--stdout', '-'],
      { timeout: 60000, encoding: 'utf8' },
      (err: any, stdout, stderr) => {
        // Non-numeric err.code means the process itself failed to launch
        // (e.g. ENOENT) rather than exiting with a non-zero status.
        if (err && typeof err.code !== 'number') {
          reject(err)
          return
        }
        // ClamAV exits non-zero when it finds malware - that's still a
        // completed scan with a meaningful result, not a failure to scan.
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: err ? err.code : 0 })
      },
    )

    // clamscan can exit early (e.g. malformed input); guard against an
    // unhandled EPIPE on a stdin that's already gone.
    child.stdin?.on('error', (streamErr) => {
      logger.warn({ streamErr }, 'clamscan stdin error, child may have terminated early')
    })

    try {
      child.stdin?.end(fileBuffer)
    } catch (writeErr) {
      logger.warn({ writeErr }, 'Failed writing to clamscan stdin')
    }
  })
}

const DENYLISTED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.ps1', '.scr', '.msi', '.com',
])

export interface ScanResult {
  clean: boolean
  detected?: string
  message?: string
}

export async function scanFile(
  fileBuffer: Buffer,
  fileName: string,
  enabled: boolean = process.env.AV_ENABLED === 'true',
): Promise<ScanResult> {
  // Check extension denylist first
  const ext = fileName.substring(fileName.lastIndexOf('.')).toLowerCase()
  if (DENYLISTED_EXTENSIONS.has(ext)) {
    logger.warn({ fileName, ext }, 'File extension blocked by denylist')
    return {
      clean: false,
      detected: 'blocked_extension',
      message: `File extension ${ext} is not allowed`,
    }
  }

  // If AV scanning is disabled, skip ClamAV scan
  if (!enabled) {
    logger.debug({ fileName }, 'AV scanning disabled, skipping ClamAV scan')
    return { clean: true }
  }

  // Run ClamAV scan
  try {
    const { stdout, stderr, exitCode } = await runClamscan(fileBuffer)

    // ClamAV exit codes:
    // 0 = Clean (no virus)
    // 1 = Virus detected
    // 2 = Operational error (missing database, corrupt file, etc.)
    if (exitCode === 1 || stdout.includes('FOUND')) {
      logger.error({ fileName, stdout, stderr, exitCode }, 'ClamAV detected malware')
      return {
        clean: false,
        detected: stdout.trim() || 'malware_detected',
        message: 'File detected as malware by ClamAV',
      }
    }

    // An operational error (e.g. missing/broken signature DB) is NOT a
    // verdict on the file - fail open rather than false-blocking it.
    if (exitCode === 2 || (stderr && stderr.includes('No supported database files'))) {
      logger.warn({ fileName, stdout, stderr, exitCode }, 'ClamAV scanner encountered an error, failing open')
      return { clean: true, message: 'Scanner unavailable, allowed file' }
    }

    logger.debug({ fileName }, 'ClamAV scan passed')
    return { clean: true }
  } catch (err: any) {
    // ClamAV binary itself could not be launched (e.g. not installed) -
    // this is an infra failure, not a completed scan, so fail open.
    if (err.code === 'ENOENT') {
      logger.warn({ fileName }, 'ClamAV not installed, skipping scan')
      return { clean: true }
    }

    logger.error({ err, fileName }, 'ClamAV scan failed to run')
    // Fail open - if the scanner itself couldn't run, allow the file through
    return { clean: true, message: 'ClamAV scan failed, allowing file' }
  }
}
