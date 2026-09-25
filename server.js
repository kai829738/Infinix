const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const publicDirectory = path.join(__dirname, 'public', 'current');
const transcriptApiUrl = 'https://transcriptapi.com/api/v2/youtube/transcript';

app.use(cors());
app.use(express.json({ limit: '16kb' }));
app.use(express.static(publicDirectory));

app.get('/', (_request, response) => {
  response.sendFile(path.join(publicDirectory, 'index.html'));
});

app.post('/get-transcript', async (request, response) => {
  const {
    videoUrl,
    format = 'json',
    includeTimestamp = 'true',
    translate = 'original',
    apiKey
  } = request.body || {};

  if (!videoUrl || typeof videoUrl !== 'string') {
    return response.status(400).json({ error: 'A YouTube video URL is required.' });
  }

  if (!apiKey || typeof apiKey !== 'string') {
    return response.status(400).json({ error: 'An API key is required.' });
  }

  const query = new URLSearchParams({
    video_url: videoUrl.trim(),
    format: String(format),
    include_timestamp: String(includeTimestamp),
    translate: String(translate || 'original')
  });

  try {
    const apiResponse = await fetch(`${transcriptApiUrl}?${query.toString()}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`
      }
    });

    const contentType = apiResponse.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
      ? await apiResponse.json()
      : { error: await apiResponse.text() };

    if (!apiResponse.ok) {
      return response.status(apiResponse.status).json({
        error: data.error || 'Transcript API request failed.',
        details: data
      });
    }

    return response.json(data);
  } catch (error) {
    console.error('Transcript request failed:', error);
    return response.status(502).json({
      error: 'Unable to reach the transcript service. Please try again later.'
    });
  }
});

app.use((error, _request, response, _next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return response.status(400).json({ error: 'Request body must contain valid JSON.' });
  }
  console.error('Unhandled server error:', error);
  return response.status(500).json({ error: 'Internal server error.' });
});

app.listen(port, () => {
  console.log(`YouTube Transcript API running at http://localhost:${port}`);
});
