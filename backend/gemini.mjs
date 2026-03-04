import { config } from './config.mjs';

function systemPromptFor(channel, allowedQuotes, organizationName) {
  const channelText = channel === 'whatsapp'
    ? 'Canal: WhatsApp difusio. Text curt, clar, calid i mobil-first. Inclou CTA final per compartir.'
    : 'Canal: Xarxes socials (Meta). Text atractiu, coherent, amb crida a participacio i hashtags curts al final.';

  const quotesRules = [
    'Regles de cites literals:',
    '- Si fas servir una cita literal, ha de ser exacta i entre cometes.',
    '- No mostris identificadors interns tipus [PC_0001], [PT_0002], [AA_0003].',
    '- Nomes pots fer servir cites de la llista "allowed_quotes".',
    '- Si no hi ha cita adequada, escriu el text sense cites literals.',
    '- Els hashtags han d\'anar al final del text.'
  ].join('\n');

  const allowedBlock = allowedQuotes.length
    ? allowedQuotes.map((q) => `- [${q.id}] "${q.text}" | ${q.sourceTitle || 'Sense titol'} | ${q.sourceDoc || ''}`).join('\n')
    : '- (sense cites disponibles per aquest tema)';

  return [
    `Ets la persona de comunicacio de l'entitat ${organizationName || 'actual'}.`,
    'Estil: rigoros, proper, esperancador i compromes amb drets humans, justicia social, Amazonia i ecologia integral.',
    channelText,
    quotesRules,
    'Retorna JSON valid amb aquest esquema:',
    '{"post_text":"string","quote_ids_used":["ID_CITA"]}',
    'quote_ids_used es opcional i nomes per validacio interna.',
    `allowed_quotes:\n${allowedBlock}`
  ].join('\n');
}

function parseGeminiJson(rawText) {
  const text = String(rawText || '').trim();
  if (!text) throw new Error('Gemini no ha retornat contingut.');

  const direct = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  if (direct) return direct;

  const blockMatch = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```([\s\S]*?)```/);
  if (blockMatch?.[1]) {
    try {
      return JSON.parse(blockMatch[1].trim());
    } catch {
      // continue with fallback
    }
  }

  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch?.[0]) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      // ignore and fail below
    }
  }

  throw new Error('Resposta de Gemini invalida: no s\'ha pogut parsejar JSON.');
}

export async function generateWithGemini({ topic, channel, allowedQuotes, organizationName }) {
  if (!config.geminiApiKey) {
    throw new Error('Gemini no configurat: falta GEMINI_API_KEY.');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;

  const payload = {
    systemInstruction: {
      parts: [{ text: systemPromptFor(channel, allowedQuotes || [], organizationName) }]
    },
    contents: [{ parts: [{ text: `Tema:\n${topic}` }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.3
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const message = data?.error?.message || `Gemini error HTTP ${response.status}`;
    throw new Error(message);
  }

  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('Gemini no ha retornat contingut.');
  }

  const parsed = parseGeminiJson(rawText);
  const content = String(parsed.post_text || '').trim();
  const quoteIdsUsed = Array.isArray(parsed.quote_ids_used)
    ? parsed.quote_ids_used.map((id) => String(id || '').trim()).filter(Boolean)
    : [];

  if (!content) {
    throw new Error('Gemini no ha retornat post_text.');
  }

  return {
    content,
    quoteIdsUsed
  };
}
