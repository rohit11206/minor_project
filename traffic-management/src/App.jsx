import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'

const LANES = ['North', 'South', 'East', 'West']
const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000'

function App() {
  const [cameraData, setCameraData] = useState({})
  const [globalStats, setGlobalStats] = useState({
    latencyMs: 0,
    totalDetections: 0,
    category: 'Awaiting uploads'
  })
  const [timeline, setTimeline] = useState([])
  const [routeDelays, setRouteDelays] = useState({})
  const [phaseTimers, setPhaseTimers] = useState({ lanes: {} })
  const [laneCountdowns, setLaneCountdowns] = useState({})
  const [uploadingLane, setUploadingLane] = useState(null)

  const aggregatedLoad = useMemo(
    () =>
      Object.values(cameraData || {}).reduce(
        (sum, lane) => sum + (lane?.loadScore ?? 0),
        0
      ),
    [cameraData]
  )

  const fetchState = useCallback(async () => {
    try {
      const start = performance.now()
      const res = await fetch(`${API_BASE}/api/traffic-state`)
      const payload = await res.json()

      setCameraData(payload.cameras || {})
      setGlobalStats({
        latencyMs: Math.round(performance.now() - start),
        totalDetections: payload.totalDetections ?? 0,
        category: payload.category ?? 'Awaiting uploads'
      })
      setTimeline(payload.timeline || [])
      setRouteDelays(payload.routeDelays || {})
      setPhaseTimers(payload.laneTimers || { lanes: {} })
    } catch (err) {
      // optional: log to console for debugging
      // console.error('Failed to fetch state', err)
    }
  }, [])

  useEffect(() => {
    fetchState()
    const interval = setInterval(fetchState, 4000)
    return () => clearInterval(interval)
  }, [fetchState])

  useEffect(() => {
    if (!phaseTimers?.lanes) return
    setLaneCountdowns(() => {
      const next = {}
      LANES.forEach((laneKey) => {
        const laneId = laneKey.toLowerCase()
        const seconds = phaseTimers.lanes?.[laneId]?.secondsUntilGreen
        next[laneId] = typeof seconds === 'number' ? seconds : null
      })
      return next
    })
  }, [phaseTimers])

  useEffect(() => {
    const interval = setInterval(() => {
      setLaneCountdowns((prev) => {
        let changed = false
        const next = {}
        Object.entries(prev).forEach(([laneId, value]) => {
          if (typeof value === 'number' && value > 0) {
            next[laneId] = value - 1
            if (next[laneId] !== value) changed = true
          } else {
            next[laneId] = value
          }
        })
        return changed ? next : prev
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  const handleVideoUpload = (laneKey) => async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    const inputRef = event.target
    const laneId = laneKey.toLowerCase()

    setUploadingLane(laneKey)
    try {
      const start = performance.now()
      const formData = new FormData()
      formData.append('lane', laneId)
      formData.append('video', file)

      const res = await fetch(`${API_BASE}/api/upload-video`, {
        method: 'POST',
        body: formData
      })
      const uploadResult = await res.json()
      // Immediately fetch state to get video URL for playback
      await fetchState()
      setGlobalStats((stats) => ({
        ...stats,
        latencyMs: Math.round(performance.now() - start)
      }))
    } catch (err) {
      // console.error('Upload failed', err)
    } finally {
      setUploadingLane(null)
      inputRef.value = ''
    }
  }

  const featuredRoutes = [
    ['north', 'south'],
    ['south', 'north'],
    ['east', 'west'],
    ['west', 'east']
  ]

  const formatRouteLabel = (lane) => lane.charAt(0).toUpperCase() + lane.slice(1)

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Computer Vision · YOLO</p>
          <h1>AI Traffic Signal Orchestrator</h1>
          <p className="lead">
            Four live approaches, one adaptive controller. YOLO reads vehicle frequency on each camera and tunes red / green
            windows in real time.
          </p>
        </div>
        <div className="hero-stats">
          <div className="hero-pill">
            <span>Inference latency</span>
            <strong>{globalStats.latencyMs} ms</strong>
          </div>
          <div className="hero-pill">
            <span>Total detections</span>
            <strong>{globalStats.totalDetections}</strong>
          </div>
        </div>
      </header>

      <section className="grid uploads">
        <article className="panel">
          <div className="panel-head">
            <h2>Upload terminal videos</h2>
            <p>Send short clips for each side. Backend YOLO will estimate frequency and timing.</p>
          </div>
          <div className="upload-grid">
            {LANES.map((laneKey) => {
              const lane = cameraData?.[laneKey.toLowerCase()] || {}
              return (
                <div key={laneKey} className="upload-item">
                  <div className="upload-label">
                    <span className="upload-tag">{laneKey.charAt(0)}</span>
                    <div>
                      <strong>{laneKey} side</strong>
                      <p>
                        Phase {lane.phase?.toUpperCase?.() ?? '—'} · Green {lane.greenSeconds ?? 0}s · Red{' '}
                        {lane.redSeconds ?? 0}s
                      </p>
                    </div>
                  </div>
                  <label className={`upload-button ${uploadingLane === laneKey ? 'is-loading' : ''}`}>
                    <span>{uploadingLane === laneKey ? 'Uploading…' : 'Choose video'}</span>
                    <input
                      type="file"
                      accept="video/*"
                      onChange={handleVideoUpload(laneKey)}
                      disabled={uploadingLane === laneKey}
                    />
                  </label>
                </div>
              )
            })}
          </div>
        </article>
      </section>

      <section className="grid cameras">
        {LANES.map((laneKey) => {
          const laneId = laneKey.toLowerCase()
          const lane = cameraData?.[laneId] || {}
          const statusLabel = lane?.status === 'processing' ? 'Processing' : lane?.phase?.toUpperCase?.() ?? '—'
          const phaseClass = lane?.status === 'ready' ? lane.phase : 'idle'
          const videoSrc = lane?.videoUrl && lane.status === 'ready' ? `${API_BASE}${lane.videoUrl}` : null
          const countdownSeconds = laneCountdowns[laneId]
          const timerLabel =
            typeof countdownSeconds === 'number'
              ? countdownSeconds > 0
                ? `${countdownSeconds}s to green`
                : 'GREEN NOW'
              : lane.phase === 'green'
              ? 'GREEN'
              : '—'
          return (
            <article key={laneKey} className="panel monitor">
              <div className="panel-head">
                <div>
                  <h2>{laneKey} camera</h2>
                  <p className="panel-sub">State: {statusLabel}</p>
                </div>
                <span className={`phase-tag ${phaseClass}`}>{(lane.phase || 'idle').toUpperCase()}</span>
              </div>
              <div className="video-feed video-feed--small">
                <div className="grid-overlay" aria-hidden />
                {videoSrc ? (
                  <video key={videoSrc} src={videoSrc} autoPlay loop muted playsInline controls={false} />
                ) : (
                  <div className="video-placeholder">
                    <span>Video stream {laneKey}</span>
                    <p>{lane?.status === 'processing' ? 'YOLO processing video...' : 'Upload video to process with YOLO'}</p>
                  </div>
                )}
                {lane?.status === 'processing' && <span className="processing-pill">YOLO processing…</span>}
                <div className="vehicle-count">
                  {lane.totalVehicles || 0} vehicles
                </div>
                <div className={`lane-timer ${lane.phase === 'green' ? 'is-green' : ''}`}>
                  <span>{timerLabel}</span>
                </div>
                {(lane.detections || []).map((detection) => (
                  <div
                    key={detection.id}
                    className="bbox"
                    style={{
                      top: `${detection.bbox.top}%`,
                      left: `${detection.bbox.left}%`,
                      width: `${detection.bbox.width}%`,
                      height: `${detection.bbox.height}%`
                    }}
                  >
                    <span>
                      {detection.label} · {Math.round(detection.confidence * 100)}%
                    </span>
                  </div>
                ))}
                <div className="feed-footer">
                  <span>
                    {lane.totalVehicles || 0} vehicles · {Object.keys(lane.laneCounts || {}).length} classes
                  </span>
                  <span>
                    Green {lane.greenSeconds ?? 0}s · Red {lane.redSeconds ?? 0}s
                  </span>
                </div>
                {lane.laneCounts && (
                  <div className="lane-counts">
                    {Object.entries(lane.laneCounts).map(([label, count]) => (
                      <span key={label}>
                        {label}: {count}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </article>
          )
        })}
      </section>

      <section className="grid secondary">
        <article className="panel signal">
          <div className="panel-head">
            <h2>Global controller</h2>
            <p>Backend YOLO calculates lane frequency and suggests signal timings.</p>
          </div>
          <div className="metrics metrics--wide">
            <div>
              <p>Total load score</p>
              <strong>{aggregatedLoad.toFixed(1)}</strong>
            </div>
            <div>
              <p>Mode</p>
              <strong>{globalStats.category}</strong>
            </div>
            <div>
              <p>Cameras</p>
              <strong>{LANES.length}</strong>
            </div>
          </div>
        </article>

        <article className="panel timeline">
          <div className="panel-head">
            <h2>Phase timeline</h2>
            <p>Recent back-end recommendations per cycle.</p>
          </div>
          <ul>
            {timeline.map((entry) => (
              <li key={entry.id}>
                <div className="dot" data-phase={entry.phase} />
                <div>
                  <strong>
                    {entry.phase.toUpperCase()} · {entry.laneLabel}
                  </strong>
                  <p>
                    Green {entry.greenSeconds}s · Red {entry.redSeconds}s · load {entry.loadScore.toFixed(1)} at{' '}
                    {entry.timestamp}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </article>
        <article className="panel route-delays">
          <div className="panel-head">
            <h2>Lane-to-lane delay</h2>
            <p>Density-driven travel time plus current red wait.</p>
          </div>
          <ul className="route-delay-list">
            {featuredRoutes.map(([from, to]) => {
              const key = `${from}_to_${to}`
              const delay = routeDelays[key]
              const delaySeconds = delay?.delaySeconds ?? null
              const sourceDensity = delay?.factors?.sourceDensity ?? 0
              const destinationDensity = delay?.factors?.destinationDensity ?? 0
              const signalDelay = delay?.factors?.signalDelay ?? 0
              return (
                <li key={key}>
                  <div className="route-line">
                    <strong>
                      {formatRouteLabel(from)} to {formatRouteLabel(to)}
                    </strong>
                    <span>{delaySeconds ? `${delaySeconds}s` : '—'}</span>
                  </div>
                  <p>
                    Density {sourceDensity}/{destinationDensity} · red wait {signalDelay}s
                  </p>
                </li>
              )
            })}
          </ul>
        </article>
      </section>
    </div>
  )
}

export default App
