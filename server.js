const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { translate } = require('google-translate-api-x');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;
const publicDirectory = fs.existsSync(path.join(__dirname, 'public', 'current', 'index.html'))
  ? path.join(__dirname, 'public', 'current')
  : __dirname;

app.use(cors());
app.use(express.json({ limit: '16kb' }));
app.use(express.static(publicDirectory));

app.get('/', (_request, response) => {
  response.sendFile(path.join(publicDirectory, 'index.html'));
});

// 1. Extract 11-character YouTube Video ID (same regex logic as your Colab code)
function extractVideoId(urlOrId) {
  const cleaned = String(urlOrId || '').trim();
  if (/^[0-9A-Za-z_-]{11}$/.test(cleaned)) return cleaned;
  const match = cleaned.match(/(?:v=|\/|youtu\.be\/|embed\/|shorts\/)([0-9A-Za-z_-]{11}).*/);
  return match ? match[1] : null;
}

// 2. Decode XML/HTML entities in caption text
function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

// 3. Parse YouTube timedtext XML (supports both <text start="" dur=""> and <p t="" d=""> formats)
function parseTranscriptXml(xml) {
  const segments = [];

  const textRegex = /<text\s+start="([^"]+)"(?:\s+dur="([^"]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = textRegex.exec(xml)) !== null) {
    const cleanText = decodeHtmlEntities(match[3].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (cleanText) {
      segments.push({
        text: cleanText,
        start: parseFloat(match[1]) || 0,
        duration: parseFloat(match[2]) || 0
      });
    }
  }

  if (segments.length > 0) return segments;

  const pRegex = /<p\s+t="(\d+)"(?:\s+d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g;
  while ((match = pRegex.exec(xml)) !== null) {
    const cleanText = decodeHtmlEntities(match[3].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (cleanText) {
      segments.push({
        text: cleanText,
        start: (parseFloat(match[1]) || 0) / 1000,
        duration: (parseFloat(match[2]) || 0) / 1000
      });
    }
  }

  return segments;
}

// 4. Fetch Transcript directly from YouTube via Innertube API (No 3rd-party API needed)
async function fetchYoutubeTranscript(videoId, preferredLanguages = ['hi', 'en']) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const watchResponse = await fetch(watchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': 'CONSENT=YES+cb'
    }
  });

  if (!watchResponse.ok) {
    throw new Error(`Failed to load YouTube watch page (HTTP ${watchResponse.status}).`);
  }

  const html = await watchResponse.text();
  const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  if (!apiKeyMatch) {
    throw new Error('Could not extract INNERTUBE_API_KEY from YouTube page.');
  }

  const innertubeApiKey = apiKeyMatch[1];
  const playerResponse = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${innertubeApiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)'
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: '20.10.38',
            hl: 'en',
            gl: 'US'
          }
        },
        videoId
      })
    }
  );

  if (!playerResponse.ok) {
    throw new Error(`YouTube Innertube player request failed (HTTP ${playerResponse.status}).`);
  }

  const playerData = await playerResponse.json();
  const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new Error('No captions/transcripts are available for this video.');
  }

  // Try preferred languages first (['hi', 'en']), then fall back to first available track
  let selectedTrack = null;
  for (const lang of preferredLanguages) {
    selectedTrack =
      tracks.find((t) => t.languageCode === lang) ||
      tracks.find((t) => t.languageCode && t.languageCode.startsWith(`${lang}-`));
    if (selectedTrack) break;
  }

  if (!selectedTrack) {
    selectedTrack = tracks[0];
  }

  const baseUrl = selectedTrack.baseUrl.replace(/&fmt=[^&]+/g, '');
  const captionResponse = await fetch(baseUrl, {
    headers: {
      'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)'
    }
  });

  if (!captionResponse.ok) {
    throw new Error(`Failed to download caption track (HTTP ${captionResponse.status}).`);
  }

  const xml = await captionResponse.text();
  const transcript = parseTranscriptXml(xml);

  if (transcript.length === 0) {
    throw new Error('Transcript track was found but contained no text segments.');
  }

  return {
    videoId,
    language: selectedTrack.languageCode,
    languageName:
      selectedTrack.name?.simpleText ||
      selectedTrack.name?.runs?.[0]?.text ||
      selectedTrack.languageCode,
    transcript
  };
}

app.post('/get-transcript', async (request, response) => {
  const {
    videoUrl,
    translate: requestedLanguage = ''
  } = request.body || {};

  if (!videoUrl || typeof videoUrl !== 'string' || !videoUrl.trim()) {
    return response.status(400).json({ error: 'A YouTube video URL is required.' });
  }

  const videoId = extractVideoId(videoUrl);
  if (!videoId) {
    return response.status(400).json({ error: 'Invalid YouTube video URL or video ID.' });
  }

  try {
    const data = await fetchYoutubeTranscript(videoId, ['hi', 'en']);

    // Translate if requested and the transcript is not already in that language
    if (
      requestedLanguage &&
      data.language !== requestedLanguage &&
      Array.isArray(data.transcript) &&
      data.transcript.length > 0
    ) {
      try {
        const sourceTexts = data.transcript.map((entry) => String(entry.text || ''));
        const chunkSize = 30;
        const translatedTexts = [];

        for (let index = 0; index < sourceTexts.length; index += chunkSize) {
          const chunk = sourceTexts.slice(index, index + chunkSize);
          const translationResult = await translate(chunk, { to: requestedLanguage });

          if (!Array.isArray(translationResult)) {
            throw new Error('Translation service returned an invalid response.');
          }

          const translatedChunk = translationResult.map((item) => {
            if (typeof item === 'string') return item;
            return item.text || item.translation || '';
          });

          translatedTexts.push(...translatedChunk);

          if (index + chunkSize < sourceTexts.length) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }

        data.transcript = data.transcript.map((entry, index) => ({
          ...entry,
          text: translatedTexts[index] || entry.text
        }));
        data.translatedTo = requestedLanguage;
      } catch (translationError) {
        console.error('Translation failed:', translationError);
        return response.status(500).json({
          error: 'Translation failed. Please check server logs.',
          details: translationError.message
        });
      }
    }

    return response.json(data);
  } catch (error) {
    console.error('Transcript request failed:', error);
    return response.status(502).json({
      error: error.message || 'Unable to fetch transcript from YouTube.'
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
  console.log(`YouTube Transcript Server running at http://localhost:${port}`);
});
