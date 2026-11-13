const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
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

// 1. Extract 11-character YouTube Video ID
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

// 3. Parse YouTube timedtext XML
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

// 4. Check if text is mostly English (A-Z) vs Hindi (Devanagari) - Ported from Colab
function isMostlyEnglish(segments) {
  const sample = segments.slice(0, 15).map((s) => s.text || '').join(' ');
  const asciiLetters = (sample.match(/[a-zA-Z]/g) || []).length;
  const devanagariLetters = (sample.match(/[\u0900-\u097F]/g) || []).length;
  return asciiLetters > devanagariLetters;
}

// 5. Direct Google Translate GTX JSON API - Ported from Colab (No rate-limit errors)
async function translateChunkGtx(text, targetLang) {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: 'auto',
    tl: targetLang,
    dt: 't'
  });
  const body = new URLSearchParams({ q: text });

  const response = await fetch(
    `https://translate.googleapis.com/translate_a/single?${params.toString()}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': 'Mozilla/5.0'
      },
      body: body.toString()
    }
  );

  if (!response.ok) {
    throw new Error(`Translation server returned HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('Invalid response from Google Translate GTX API.');
  }

  return data[0].map((part) => (part && part[0] ? part[0] : '')).join('');
}

// 6. Fetch Transcript from YouTube (with Multi-Client fallback for Render)
async function fetchYoutubeTranscript(videoId, preferredLanguages = ['hi', 'en']) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cookie': process.env.YOUTUBE_COOKIE || 'CONSENT=YES+cb'
  };

  const watchResponse = await fetch(watchUrl, { headers: commonHeaders });
  if (!watchResponse.ok) {
    throw new Error(`Failed to load YouTube watch page (HTTP ${watchResponse.status}).`);
  }

  const html = await watchResponse.text();
  const getTracks = (playerData) =>
    playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;

  let tracks = null;
  let lastPlayabilityReason = null;

  // Attempt A: Parse ytInitialPlayerResponse from Watch Page HTML
  const initialPlayerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s+meta|<\/script>)/s);
  if (initialPlayerMatch) {
    try {
      const initialData = JSON.parse(initialPlayerMatch[1]);
      tracks = getTracks(initialData);
      lastPlayabilityReason = initialData?.playabilityStatus?.reason;
    } catch (_) {}
  }

  // Attempt B: Try multiple Innertube clients (IOS, ANDROID, EMBEDDED)
  const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  if ((!Array.isArray(tracks) || tracks.length === 0) && apiKeyMatch) {
    const innertubeApiKey = apiKeyMatch[1];
    const clients = [
      {
        clientName: 'IOS',
        clientVersion: '19.29.1',
        deviceMake: 'Apple',
        deviceModel: 'iPhone16,2',
        userAgent: 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)'
      },
      {
        clientName: 'ANDROID',
        clientVersion: '20.10.38',
        userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)'
      },
      {
        clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
        clientVersion: '2.0',
        userAgent: commonHeaders['User-Agent'],
        thirdParty: { embedUrl: 'https://www.youtube.com/' }
      }
    ];

    for (const client of clients) {
      try {
        const body = {
          context: {
            client: {
              clientName: client.clientName,
              clientVersion: client.clientVersion,
              hl: 'en',
              gl: 'US',
              ...(client.deviceMake ? { deviceMake: client.deviceMake, deviceModel: client.deviceModel } : {})
            },
            ...(client.thirdParty ? { thirdParty: client.thirdParty } : {})
          },
          videoId
        };

        const playerResponse = await fetch(
          `https://www.youtube.com/youtubei/v1/player?key=${innertubeApiKey}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': client.userAgent,
              'Cookie': commonHeaders['Cookie']
            },
            body: JSON.stringify(body)
          }
        );

        if (playerResponse.ok) {
          const playerData = await playerResponse.json();
          lastPlayabilityReason = playerData?.playabilityStatus?.reason || lastPlayabilityReason;
          tracks = getTracks(playerData);
          if (Array.isArray(tracks) && tracks.length > 0) break;
        }
      } catch (_) {}
    }
  }

  if (!Array.isArray(tracks) || tracks.length === 0) {
    if (lastPlayabilityReason && /bot|sign in/i.test(lastPlayabilityReason)) {
      throw new Error(
        `YouTube blocked Render's IP ("${lastPlayabilityReason}"). Add a YOUTUBE_COOKIE environment variable in Render.`
      );
    }
    throw new Error('No captions/transcripts are available for this video.');
  }

  let selectedTrack = null;
  for (const lang of preferredLanguages) {
    selectedTrack =
      tracks.find((t) => t.languageCode === lang) ||
      tracks.find((t) => t.languageCode && t.languageCode.startsWith(`${lang}-`));
    if (selectedTrack) break;
  }
  if (!selectedTrack) selectedTrack = tracks[0];

  const baseUrl = selectedTrack.baseUrl.replace(/&fmt=[^&]+/g, '');
  const captionResponse = await fetch(baseUrl, { headers: commonHeaders });

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

    // Check if actual text needs translation (same logic as your Colab script)
    const currentlyEnglish = isMostlyEnglish(data.transcript);
    const needsTranslation =
      (requestedLanguage === 'hi' && currentlyEnglish) ||
      (requestedLanguage === 'en' && !currentlyEnglish);

    if (needsTranslation && Array.isArray(data.transcript) && data.transcript.length > 0) {
      let chunkIndices = [];
      let chunkTexts = [];
      let currentLen = 0;

      const flushChunk = async (indices, texts) => {
        const joined = texts.join('\n');
        const translatedText = await translateChunkGtx(joined, requestedLanguage);
        const translatedLines = translatedText.split('\n');
        for (let i = 0; i < indices.length; i++) {
          if (translatedLines[i] !== undefined) {
            data.transcript[indices[i]].text = translatedLines[i].trim();
          }
        }
      };

      for (let idx = 0; idx < data.transcript.length; idx++) {
        const itemText = String(data.transcript[idx].text || '');
        const lineLen = itemText.length + 1;
        if (currentLen + lineLen > 4500 && chunkTexts.length > 0) {
          await flushChunk(chunkIndices, chunkTexts);
          chunkIndices = [];
          chunkTexts = [];
          currentLen = 0;
        }
        chunkIndices.push(idx);
        chunkTexts.push(itemText);
        currentLen += lineLen;
      }

      if (chunkTexts.length > 0) {
        await flushChunk(chunkIndices, chunkTexts);
      }

      data.translatedTo = requestedLanguage;
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
