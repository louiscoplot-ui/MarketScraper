// Theme + Scrape progress modals — extracted from App.jsx to keep
// modules under the MCP push size limit.

export function ThemeModal({ theme, setTheme, defaultTheme, presets, updateColor, onClose }) {
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal theme-modal">
        <div className="modal-header">
          <h2>Customize Theme</h2>
          <button className="btn btn-icon" onClick={onClose}>x</button>
        </div>
        <div className="theme-presets">
          {Object.entries(presets).map(([name, colors]) => (
            <button
              key={name}
              className="theme-preset-btn"
              style={{ background: colors.surface, color: colors.text, borderColor: colors.primary }}
              onClick={() => setTheme(colors)}
            >
              <span className="preset-dot" style={{ background: colors.primary }} />
              {name}
            </button>
          ))}
        </div>
        <div className="theme-colors">
          {[
            ['bg', 'Background'],
            ['surface', 'Panels'],
            ['border', 'Borders'],
            ['text', 'Text'],
            ['textMuted', 'Text Secondary'],
            ['primary', 'Accent Color'],
          ].map(([key, label]) => (
            <div key={key} className="theme-color-row">
              <label>{label}</label>
              <div className="color-input-group">
                <input type="color" value={theme[key]} onChange={e => updateColor(key, e.target.value)} />
                <input type="text" value={theme[key]} onChange={e => updateColor(key, e.target.value)} className="color-hex" />
              </div>
            </div>
          ))}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setTheme(defaultTheme)}>Reset</button>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}


export function ScrapeModal({
  scrapeJobs, isAnyScraping, completedCount, totalJobs,
  elapsed, estimatedRemaining, formatTime, cancelScrape, onClose,
}) {
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !isAnyScraping) onClose() }}>
      <div className="modal">
        <div className="modal-header">
          <h2>Scraping Progress</h2>
          {!isAnyScraping && <button className="btn btn-icon" onClick={onClose}>×</button>}
        </div>

        <div className="progress-bar-container">
          <div className="progress-bar-fill" style={{ width: `${totalJobs > 0 ? (completedCount / totalJobs) * 100 : 0}%` }} />
        </div>
        <div className="progress-stats">
          <span>{completedCount}/{totalJobs} suburbs done</span>
          <span>Elapsed: {formatTime(elapsed)}</span>
          {estimatedRemaining !== null && isAnyScraping && (
            <span>~{formatTime(estimatedRemaining)} remaining</span>
          )}
          {isAnyScraping && (
            <button className="btn btn-danger btn-small" onClick={cancelScrape}>Cancel Scraping</button>
          )}
        </div>

        <div className="modal-jobs">
          {scrapeJobs.map(job => (
            <div key={job.id} className={`modal-job status-${job.status}`}>
              <span className="job-name">{job.name}</span>
              <span className={`job-status ${job.status}`}>
                {job.status === 'running' && '⏳ '}
                {job.status === 'completed' && '✓ '}
                {job.status === 'cancelled' && '⊘ '}
                {job.status === 'error' && '✗ '}
                {job.progress || job.status}
              </span>
            </div>
          ))}
        </div>

        {!isAnyScraping && (
          <div className="modal-footer">
            <button className="btn btn-primary" onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  )
}
