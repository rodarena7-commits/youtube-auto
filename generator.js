const OpenAI = require('openai')

// Groq es compatible con la API de OpenAI — gratis y más rápido
const client = new OpenAI({
  apiKey:  process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
})

const NICHE_DEFAULT  = process.env.NICHE       || 'finanzas personales e inversiones en Argentina'
const NICHE_BOOKS    = process.env.NICHE_BOOKS  || 'resúmenes de libros de no ficción, desarrollo personal y negocios en español'
const NICHE_MUSIC    = process.env.NICHE_MUSIC  || 'música relajante para dormir, estudiar, concentrarse y lofi beats'

// Temas ya usados por nicho (en memoria, se resetea al reiniciar)
const usedTopicsByNiche = {}

async function generateScript(niche = null) {
  const activeNiche = niche || NICHE_DEFAULT
  if (!usedTopicsByNiche[activeNiche]) usedTopicsByNiche[activeNiche] = new Set()
  const usedSet = usedTopicsByNiche[activeNiche]

  const usedList = usedSet.size > 0
    ? `\nNO repitas estos temas ya usados: ${[...usedSet].slice(-10).join(', ')}`
    : ''

  const isBooks = activeNiche.includes('libro') || activeNiche.includes('resumen')
  const isMusic = activeNiche.includes('música') || activeNiche === NICHE_MUSIC

  let prompt = ''
  
  if (isMusic) {
    prompt = `Eres un creador de contenido de YouTube especializado en el nicho: "${activeNiche}".
${usedList}

Generá la metadata para un video musical largo (aprox 30 minutos).
Respondé SOLO con este JSON válido, sin markdown:
{
  "title": "Título atractivo para YouTube (máx 70 caracteres, ej: Música para Estudiar y Concentrarse - Lofi Beats 30 Min)",
  "description": "Descripción para YouTube de 3-4 oraciones indicando que es ideal para relajarse/estudiar/dormir, con hashtags al final",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8"],
  "keywords": ["palabras clave en INGLÉS para buscar en Pixabay API, ej: lofi, study, relax, ambient"],
  "topic": "resumen de 5 palabras del tema",
  "script": ""
}`
  } else {
    const scriptInstruction = isBooks
      ? 'Guión completo de exactamente 220 a 260 palabras para narrar en voz off. Empezá con el nombre del libro y el autor, explicá las 2-3 ideas más importantes con ejemplos concretos, y cerrá con una reflexión final y llamado a la acción pidiendo suscripción.'
      : 'Guión completo de exactamente 220 a 260 palabras para narrar en voz off. Empezá con un hook impactante, desarrollá el contenido con datos y ejemplos concretos, y cerrá con un llamado a la acción pidiendo suscripción.'

    prompt = `Eres un guionista profesional de YouTube en español para el nicho: "${activeNiche}".
${usedList}

Generá un video educativo/informativo de exactamente 1.5 a 2 minutos (220 a 260 palabras aprox).
El video no tiene locutor visible ni cara, solo voz en off con imágenes de fondo.

Respondé SOLO con este JSON válido, sin markdown:
{
  "title": "Título atractivo para YouTube (máx 70 caracteres, con número o pregunta)",
  "description": "Descripción para YouTube de 3-4 oraciones con hashtags al final",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8"],
  "keywords": ["keyword1", "keyword2", "keyword3"],
  "topic": "resumen de 5 palabras del tema",
  "script": "${scriptInstruction}"
}`
  }

  const response = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8,
    max_tokens: 1200,
  })

  const text = response.choices[0].message.content.trim()

  let data
  try {
    data = JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('GPT no devolvió JSON válido')
    data = JSON.parse(match[0])
  }

  usedSet.add(data.topic)
  return data
}

module.exports = { generateScript, NICHE_BOOKS, NICHE_MUSIC }
