import type { RenderHealth } from './workspace/renderClient'
import type { RenderState } from './workspace/useRender'

/** Progress, result or error of one render. `testId` keeps the two panels distinguishable in tests. */
export function RenderStatus({ state, testId }: { state: RenderState; testId: string }) {
  if (state.phase === 'idle') return null
  const { busy, phase, progress, message, error, notes } = state
  return (
    <div className="render-status" aria-live="polite" data-testid={testId}>
      {busy && (
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
          <div className="progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      <p className={phase === 'failed' ? 'error' : 'status-meta'} data-testid={`${testId}-message`}>
        {phase === 'failed' ? error : `${message}${busy && phase !== 'checking' ? ` · ${Math.round(progress * 100)}%` : ''}`}
      </p>
      {notes.length > 0 && (
        <ul className="notes" data-testid={`${testId}-notes`}>
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Shown once, above the render panels, only when the local render service can't render. */
export function ServiceNotice({ health }: { health: RenderHealth | null }) {
  if (health === null) return null
  if (!health.reachable) {
    return (
      <div className="warn" role="alert" data-testid="service-warning">
        <strong>{health.error}</strong> Start the app with <code>npm run dev</code>, which runs the page and the render service
        together, or run <code>npm run render-service</code> in a second terminal.
      </div>
    )
  }
  if (!health.ok) {
    return (
      <div className="warn" role="alert" data-testid="service-warning">
        <strong>Rendering is unavailable: {health.tools.problem}</strong> The render service needs FFmpeg with ffprobe, libx264 and
        AAC on this computer, on the PATH. Install it and restart <code>npm run dev</code>: Windows{' '}
        <code>winget install Gyan.FFmpeg</code> (then open a new terminal), macOS <code>brew install ffmpeg</code>, Debian/Ubuntu{' '}
        <code>sudo apt install ffmpeg</code>.
      </div>
    )
  }
  return null
}

export const serviceReady = (health: RenderHealth | null) => health?.reachable === true && health.ok
