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
const history = []   // últimos videos generados
let running   = false
let lastJob   = null // { status, step, title, videoUrl, error, startedAt }

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
    openaiReady: !!process.env.OPENAI_API_KEY,
    pexelsReady: !!process.env.PEXELS_API_KEY,
    niche:       process.env.NICHE || 'finanzas personales e inversiones',
    schedule:    process.env.CRON_SCHEDULE || '0 9 * * *',
  })
})

// ── Pipeline principal ────────────────────────────────────────
async function runPipeline() {
  if (running) return
  running  = true
  lastJob  = { status: 'running', step: 'Generando guión...', title: '', videoUrl: null, error: null, startedAt: new Date().toISOString() }

  const tmpDir  = os.tmpdir()
  const jobId   = Date.now().toString()
  const audioPath  = path.join(tmpDir, `audio_${jobId}.mp3`)
  const videoPath  = path.join(tmpDir, `final_${jobId}.mp4`)
  let clips = []

  try {
    // 1. Generar guión con GPT
    console.log('📝 Generando guión...')
    setStep('Generando guión con IA...')
    const script = await generateScript()
    lastJob.title = script.title
    console.log(`  Título: ${script.title}`)

    // 2. Convertir a voz
    console.log('🎤 Generando voz...')
    setStep('Convirtiendo texto a voz...')
    await textToSpeech(script.script, audioPath)
    const audioDuration = await getAudioDuration(audioPath)
    console.log(`  Duración: ${Math.round(audioDuration)}s`)

    // 3. Descargar footage de Pexels
    console.log('📹 Descargando footage...')
    setStep('Descargando imágenes de fondo...')
    clips = await fetchFootage(script.keywords, audioDuration)
    console.log(`  ${clips.length} clips descargados`)

    // 4. Construir video
    console.log('🎬 Editando video...')
    setStep('Editando y combinando video...')
    await buildVideo(clips, audioPath, audioDuration, videoPath, script.title)

    // 5. Subir a YouTube
    console.log('⬆️ Subiendo a YouTube...')
    setStep('Subiendo a YouTube...')
    const result = await uploadVideo({
      videoPath,
      title:       script.title,
      description: script.description,
      tags:        script.tags,
      privacy:     process.env.VIDEO_PRIVACY || 'public',
      onProgress:  pct => setStep(`Subiendo a YouTube... ${pct}%`),
    })

    const videoUrl = `https://www.youtube.com/watch?v=${result.id}`
    console.log(`✅ Publicado: ${videoUrl}`)

    lastJob = { status: 'done', step: 'Listo', title: script.title, videoUrl, error: null, startedAt: lastJob.startedAt, finishedAt: new Date().toISOString() }
    history.push({ ...lastJob })

  } catch (e) {
    console.error(`❌ Error en pipeline: ${e.message}`)
    lastJob = { ...lastJob, status: 'error', step: 'Error', error: e.message, finishedAt: new Date().toISOString() }
    history.push({ ...lastJob })
  } finally {
    // Cleanup
    clips.forEach(c => { try { fs.unlinkSync(c.path) } catch {} })
    try { fs.unlinkSync(audioPath) } catch {}
    try { fs.unlinkSync(videoPath) } catch {}
    running = false
  }
}

function setStep(step) {
  if (lastJob) lastJob.step = step
}

// ── Scheduler automático ──────────────────────────────────────
const schedule = process.env.CRON_SCHEDULE || '0 9 * * *' // 9am todos los días
cron.schedule(schedule, () => {
  console.log('⏰ Scheduler: iniciando generación automática...')
  runPipeline()
}, { timezone: 'America/Argentina/Buenos_Aires' })

console.log(`📅 Scheduler configurado: ${schedule}`)

app.listen(PORT, () => console.log(`🚀 YouTube Auto en http://localhost:${PORT}`))
