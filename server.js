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

// ── Helper para formatear tiempo de ASS (H:MM:SS.cs) ─────────
function formatASSTime(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const cs = Math.round((seconds - Math.floor(seconds)) * 100)
  
  const hStr = h.toString()
  const mStr = m.toString().padStart(2, '0')
  const sStr = s.toString().padStart(2, '0')
  const csStr = cs.toString().padStart(2, '0').substring(0, 2)
  
  return `${hStr}:${mStr}:${sStr}.${csStr}`
}

// ── Generar archivo ASS de subtítulos y portada ───────────────
function generateASS(timings, title, outputPath) {
  const cleanTitle = title.toUpperCase().replace(/\?|¿|!|¡/g, '').trim()
  let content = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,3,1,1,2,10,10,25,1
Style: TitleStyle,Arial,32,&H0000FFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,3,1,1,5,10,10,15,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`
  // 1. Agregar la portada (Título centrado los primeros 4 segundos)
  content += `Dialogue: 0,0:00:00.00,0:00:04.00,TitleStyle,,0,0,0,,${cleanTitle}\n`

  // 2. Agregar los subtítulos normales abajo
  timings.forEach(t => {
    const startStr = formatASSTime(t.start)
    const endStr = formatASSTime(t.end)
    const textClean = t.text.replace(/\n/g, ' ').trim()
    content += `Dialogue: 0,${startStr},${endStr},Default,,0,0,0,,${textClean}\n`
  })

  fs.writeFileSync(outputPath, content, 'utf-8')
}

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

  function advance(key, overallPct, detail = '') {
    const now = new Date().toISOString()
    steps = steps.map(s => {
      if (s.status === 'running' && s.key !== key) {
        return { ...s, status: 'done', finishedAt: now, stepPct: 100 }
      }
      if (s.key === key) {
        return { ...s, status: 'running', startedAt: s.startedAt || now, detail: detail || s.label }
      }
      return s
    })
    lastJob.steps      = steps
    lastJob.overallPct = overallPct
  }

  function updateProgress(key, detail, stepPct) {
    steps = steps.map(s => {
      if (s.key === key) {
        return { ...s, detail, stepPct }
      }
      return s
    })
    lastJob.steps = steps
  }

  try {
    // 1. Guión
    advance('script', 5, 'Conectando con Groq API...')
    console.log('📝 Generando guión...')
    const script = await generateScript()
    lastJob.title = script.title
    lastJob.overallPct = 15
    updateProgress('script', `Guión generado: "${script.title}"`, 100)
    console.log(`  Título: ${script.title}`)

    // 2. Voz
    advance('voice', 15, 'Iniciando generación de voz...')
    console.log('🎤 Generando voz...')
    const { timings } = await textToSpeech(script.script, audioPath, (msg, stepPct) => {
      updateProgress('voice', msg, stepPct)
    })
    const audioDuration = await getAudioDuration(audioPath)
    lastJob.overallPct = 30
    updateProgress('voice', `Voz generada (${Math.round(audioDuration)}s)`, 100)
    console.log(`  Duración: ${Math.round(audioDuration)}s`)

    // 3. Footage
    advance('footage', 30, 'Buscando videos de fondo en Pexels...')
    console.log('📹 Descargando footage...')
    clips = await fetchFootage(script.keywords, audioDuration, (msg, stepPct) => {
      updateProgress('footage', msg, stepPct)
    })
    lastJob.overallPct = 60
    updateProgress('footage', `${clips.length} clips descargados con éxito`, 100)
    console.log(`  ${clips.length} clips descargados`)

    // 4. Edición
    advance('editing', 60, 'Inicializando el editor de video...')
    console.log('🎬 Editando video...')
    
    // Generar archivo ASS de subtítulos y portada
    const assPath = path.join(__dirname, 'subtitles.ass')
    generateASS(timings, script.title, assPath)

    await buildVideo(clips, audioPath, audioDuration, videoPath, script.title, assPath, (msg, stepPct) => {
      updateProgress('editing', msg, stepPct)
      lastJob.overallPct = 60 + Math.round(stepPct * 0.20)
    })
    lastJob.overallPct = 80
    updateProgress('editing', 'Video editado con subtítulos y portada listos', 100)
    console.log('  Video listo')

    // 5. Subida
    advance('upload', 80, 'Preparando subida a YouTube...')
    console.log('⬆️ Subiendo a YouTube...')
    const result = await uploadVideo({
      videoPath,
      title:       script.title,
      description: script.description,
      tags:        script.tags,
      privacy:     process.env.VIDEO_PRIVACY || 'public',
      onProgress:  pct => {
        updateProgress('upload', `Subiendo a YouTube: ${pct}%`, pct)
        lastJob.overallPct = 80 + Math.round(pct * 0.20)
      },
    })

    const videoUrl = `https://www.youtube.com/watch?v=${result.id}`
    console.log(`✅ Publicado: ${videoUrl}`)
    updateProgress('upload', 'Publicado correctamente en YouTube', 100)

    lastJob = {
      status: 'done', title: script.title, videoUrl,
      error: null, startedAt: lastJob.startedAt,
      finishedAt: new Date().toISOString(),
      steps: allStepsDone(steps), overallPct: 100,
    }
    history.push({ ...lastJob })

  } catch (e) {
    console.error(`❌ Error: ${e.message}`)
    steps = steps.map(s => s.status === 'running' ? { ...s, status: 'error', finishedAt: new Date().toISOString() } : s)
    lastJob = { ...lastJob, status: 'error', error: e.message, steps, finishedAt: new Date().toISOString() }
    history.push({ ...lastJob })
  } finally {
    clips.forEach(c => { try { fs.unlinkSync(c.path) } catch {} })
    try { fs.unlinkSync(audioPath) } catch {}
    try { fs.unlinkSync(videoPath) } catch {}
    try { fs.unlinkSync(path.join(__dirname, 'subtitles.ass')) } catch {}
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
