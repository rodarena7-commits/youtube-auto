const youtubedl = require('youtube-dl-exec')
const fs = require('fs')

async function fetchMusic(keywords, outputPath, onProgress) {
  // Solo usamos las primeras palabras clave para la búsqueda
  const query = keywords.slice(0, 3).join(' ') + ' no copyright'
  
  if (onProgress) onProgress(`Buscando música en YouTube: "${query}"`, 10)
  
  try {
    // Usamos ytsearch1: para buscar y descargar el primer resultado
    // match-filter duration < 1800 evita descargar directos o videos de 10 horas que colapsen el servidor
    if (onProgress) onProgress(`Descargando pista de audio...`, 30)
    
    await youtubedl(`ytsearch1:${query}`, {
      extractAudio: true,
      audioFormat: 'mp3',
      output: outputPath,
      matchFilter: 'duration < 3600', // Máximo 1 hora para no saturar disco
      noPlaylist: true
    })
    
    if (onProgress) onProgress(`Música descargada con éxito.`, 100)
    return outputPath
  } catch (error) {
    throw new Error(`Error descargando música: ${error.message}`)
  }
}

module.exports = { fetchMusic }
