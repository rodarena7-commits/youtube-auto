const { google } = require('googleapis')
const fs = require('fs')

function buildClient() {
  return new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    process.env.YOUTUBE_REDIRECT_URI
  )
}

function getAuthUrl() {
  return buildClient().generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/youtube.upload'],
    prompt: 'consent',
  })
}

async function handleCallback(code) {
  const client = buildClient()
  const { tokens } = await client.getToken(code)
  return tokens.refresh_token
}

async function uploadVideo({ videoPath, title, description, tags, privacy = 'public', onProgress }) {
  if (!process.env.YOUTUBE_REFRESH_TOKEN)
    throw new Error('YOUTUBE_REFRESH_TOKEN no configurado. Visitá /auth primero.')

  const client = buildClient()
  client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN })

  const youtube  = google.youtube({ version: 'v3', auth: client })
  const fileSize = fs.statSync(videoPath).size

  const res = await youtube.videos.insert(
    {
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title,
          description,
          tags: tags || [],
          categoryId: '27', // Education
          defaultLanguage: 'es',
          defaultAudioLanguage: 'es',
        },
        status: {
          privacyStatus: privacy,
          selfDeclaredMadeForKids: false,
        },
      },
      media: { body: fs.createReadStream(videoPath) },
    },
    {
      onUploadProgress: evt => {
        const pct = Math.round((evt.bytesRead / fileSize) * 100)
        if (onProgress) onProgress(pct)
      },
    }
  )

  return res.data
}

module.exports = { getAuthUrl, handleCallback, uploadVideo }
