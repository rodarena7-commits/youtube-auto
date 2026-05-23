const axios = require('axios')
const fs    = require('fs')
const path  = require('path')
const os    = require('os')

const PEXELS_KEY = process.env.PEXELS_API_KEY

// Busca y descarga videos de Pexels según keywords
async function fetchFootage(keywords, neededSeconds) {
  if (!PEXELS_KEY) throw new Error('PEXELS_API_KEY no configurada')

  const tmpDir    = os.tmpdir()
  const clips     = []
  let totalSecs   = 0
  const tried     = new Set()

  for (const kw of keywords) {
    if (totalSecs >= neededSeconds + 10) break

    // Buscar en Pexels
    let videos = []
    try {
      const res = await axios.get('https://api.pexels.com/videos/search', {
        headers: { Authorization: PEXELS_KEY },
        params: { query: kw, per_page: 8, orientation: 'landscape', size: 'medium' },
        timeout: 15000,
      })
      videos = res.data.videos || []
    } catch (e) {
      console.warn(`Pexels error para "${kw}": ${e.message}`)
      continue
    }

    for (const video of videos) {
      if (totalSecs >= neededSeconds + 10) break
      if (tried.has(video.id)) continue
      tried.add(video.id)

      // Elegir el archivo HD disponible
      const file =
        video.video_files.find(f => f.quality === 'hd' && f.width >= 1280) ||
        video.video_files.find(f => f.quality === 'sd') ||
        video.video_files[0]
      if (!file) continue

      const clipPath = path.join(tmpDir, `clip_${Date.now()}_${video.id}.mp4`)
      try {
        await downloadFile(file.link, clipPath)
        const duration = video.duration || 10
        clips.push({ path: clipPath, duration })
        totalSecs += duration
        console.log(`  📹 Clip descargado: ${kw} (${duration}s)`)
      } catch (e) {
        console.warn(`  Error descargando clip ${video.id}: ${e.message}`)
      }
    }
  }

  if (clips.length === 0) throw new Error('No se pudieron descargar clips de Pexels')
  return clips
}

async function downloadFile(url, dest) {
  const res = await axios.get(url, { responseType: 'stream', timeout: 60000 })
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(dest)
    res.data.pipe(writer)
    writer.on('finish', resolve)
    writer.on('error', reject)
  })
}

module.exports = { fetchFootage }
