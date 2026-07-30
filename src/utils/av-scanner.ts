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
      { timeout: 30000, encoding: 'utf8' },
      (err: any, stdout, stderr) => {
        if (err && typeof err.code !== 'number') {
          // Non-numeric err.code means the process itself failed to launch
          // (e.g. ENOENT) rather than exiting with a non-zero status.
          reject(err)
          return
        }
        // ClamAV exits non-zero when it finds malware - that's still a
        // completed scan with a meaningful result, not a failure to scan.
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: err ? err.code : 0 })
      },
    )
    child.stdin?.end(fileBuffer)
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

    // ClamAV returns "OK" for clean files, exits non-zero when it finds malware
    const isClean = exitCode === 0 && stdout.includes('OK')

    if (!isClean) {
      logger.error({ fileName, stdout, stderr, exitCode }, 'ClamAV detected malware')
      return {
        clean: false,
        detected: stdout.trim() || 'malware_detected',
        message: 'File detected as malware by ClamAV',
      }
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
