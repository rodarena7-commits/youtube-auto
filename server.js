const express   = require('express')
const cron      = require('node-cron')
const fs        = require('fs')
const path      = require('path')
const os        = require('os')

const { generateScript }            = require('./generator')
const { textToSpeech, getAudioDuration } = require('./voice')
const { fetchFootage }              = require('./footage')
const { buildVideo }                = require('./editor')
const { getAuthUrl, handleCallback, uploadVideo } = require('./uploader')

const app  = express()
const PORT = process.env.PORT || 3000

app.use(express.json())
app.use(express.static('public'))

// ── Estado global ────────────────────────────────────────────
const history = []
let running   = false
let lastJob   = null

const STEPS = [
  { key: 'script',   label: 'Generando guión con IA',        pct: 15  },
  { key: 'voice',    label: 'Convirtiendo texto a voz',       pct: 30  },
  { key: 'footage',  label: 'Descargando imágenes de fondo',  pct: 60  },
  { key: 'editing',  label: 'Editando y combinando video',    pct: 80  },
  { key: 'upload',   label: 'Subiendo a YouTube',             pct: 100 },
]

function initSteps() {
  return STEPS.map(s => ({ ...s, status: 'pending' }))
}

function setStepRunning(steps, key) {
  return steps.map(s => ({
    ...s,
    status: s.key === key ? 'running' : s.status === 'running' ? 'done' : s.status,
  }))
}

function allStepsDone(steps) {
  return steps.map(s => ({ ...s, status: 'done' }))
}

// ── Auth YouTube ─────────────────────────────────────────────
app.get('/auth', (req, res) => {
  if (!process.env.YOUTUBE_CLIENT_ID)
    return res.status(500).send('<h2>Falta YOUTUBE_CLIENT_ID en variables de entorno</h2>')
  res.redirect(getAuthUrl())
})

app.get('/auth/callback', async (req, res) => {
  try {
    const token = await handleCallback(req.query.code)
    res.send(`
      <html><head><meta charset="UTF-8"><title>Autenticado</title>
      <style>body{font-family:sans-serif;max-width:600px;margin:3rem auto;padding:0 1rem}
      code{background:#f3f4f6;padding:.5rem 1rem;border-radius:8px;display:block;word-break:break-all;margin:1rem 0}</style></head>
      <body>
        <h2>✅ Canal autenticado</h2>
        <p>Copiá este token y agregalo en Render como <b>YOUTUBE_REFRESH_TOKEN</b>:</p>
        <code>${token}</code>
        <p>Luego hacé <b>Redeploy</b> en Render y listo.</p>
        <a href="/">← Volver</a>
      </body></html>
    `)
  } catch (e) {
    res.status(500).send(`<h2>❌ Error: ${e.message}</h2>`)
  }
})

// ── Estado actual ─────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({ running, lastJob, history: history.slice(-10).reverse() })
})

// ── Trigger manual ────────────────────────────────────────────
app.post('/generate', async (req, res) => {
  if (running) return res.status(429).json({ error: 'Ya hay un video en proceso' })
  res.json({ ok: true, message: 'Generando video...' })
  runPipeline()
})

// ── Health ────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    ytReady:     !!process.env.YOUTUBE_REFRESH_TOKEN,
    openaiReady: !!process.env.GROQ_API_KEY,
    pexelsReady: !!process.env.PEXELS_API_KEY,
    niche:       process.env.NICHE || 'finanzas personales e inversiones',
    schedule:    process.env.CRON_SCHEDULE || '0 9 * * *',
    channel:     process.env.CHANNEL_NAME || '—',
  })
})

// ── Pipeline principal ────────────────────────────────────────
async function runPipeline() {
  if (running) return
  running = true
  let steps = initSteps()
  lastJob = {
    status: 'running', title: '', videoUrl: null,
    error: null, startedAt: new Date().toISOString(),
    steps, overallPct: 0,
  }

  const tmpDir    = os.tmpdir()
  const jobId     = Date.now().toString()
  const audioPath = path.join(tmpDir, `audio_${jobId}.mp3`)
  const videoPath = path.join(tmpDir, `final_${jobId}.mp4`)
  let clips = []

  function advance(key, pct) {
    steps = setStepRunning(steps, key)
    lastJob.steps      = steps
    lastJob.overallPct = pct
  }

  try {
    // 1. Guión
    advance('script', 5)
    console.log('📝 Generando guión...')
    const script = await generateScript()
    lastJob.title = script.title
    lastJob.overallPct = 15
    console.log(`  Título: ${script.title}`)

    // 2. Voz
    advance('voice', 18)
    console.log('🎤 Generando voz...')
    await textToSpeech(script.script, audioPath)
    const audioDuration = await getAudioDuration(audioPath)
    lastJob.overallPct = 30
    console.log(`  Duración: ${Math.round(audioDuration)}s`)

    // 3. Footage
    advance('footage', 33)
    console.log('📹 Descargando footage...')
    clips = await fetchFootage(script.keywords, audioDuration)
    lastJob.overallPct = 60
    console.log(`  ${clips.length} clips descargados`)

    // 4. Edición
    advance('editing', 63)
    console.log('🎬 Editando video...')
    await buildVideo(clips, audioPath, audioDuration, videoPath, script.title)
    lastJob.overallPct = 80
    console.log('  Video listo')

    // 5. Subida
    advance('upload', 82)
    console.log('⬆️ Subiendo a YouTube...')
    const result = await uploadVideo({
      videoPath,
      title:       script.title,
      description: script.description,
      tags:        script.tags,
      privacy:     process.env.VIDEO_PRIVACY || 'public',
      onProgress:  pct => {
        lastJob.overallPct = 82 + Math.round(pct * 0.18)
      },
    })

    const videoUrl = `https://www.youtube.com/watch?v=${result.id}`
    console.log(`✅ Publicado: ${videoUrl}`)

    lastJob = {
      status: 'done', title: script.title, videoUrl,
      error: null, startedAt: lastJob.startedAt,
      finishedAt: new Date().toISOString(),
      steps: allStepsDone(steps), overallPct: 100,
    }
    history.push({ ...lastJob })

  } catch (e) {
    console.error(`❌ Error: ${e.message}`)
    steps = steps.map(s => s.status === 'running' ? { ...s, status: 'error' } : s)
    lastJob = { ...lastJob, status: 'error', error: e.message, steps, finishedAt: new Date().toISOString() }
    history.push({ ...lastJob })
  } finally {
    clips.forEach(c => { try { fs.unlinkSync(c.path) } catch {} })
    try { fs.unlinkSync(audioPath) } catch {}
    try { fs.unlinkSync(videoPath) } catch {}
    running = false
  }
}

// ── Scheduler automático ──────────────────────────────────────
const schedule = process.env.CRON_SCHEDULE || '0 9 * * *' // 9am todos los días
cron.schedule(schedule, () => {
  console.log('⏰ Scheduler: iniciando generación automática...')
  runPipeline()
}, { timezone: 'America/Argentina/Buenos_Aires' })

console.log(`📅 Scheduler configurado: ${schedule}`)

app.listen(PORT, () => console.log(`🚀 YouTube Auto en http://localhost:${PORT}`))
