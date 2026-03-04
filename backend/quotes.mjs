import crypto from 'node:crypto';

import { config } from './config.mjs';
import { getQuotesCatalog, upsertQuotesCatalog } from './db.mjs';

let quotesCache = {
  loadedAt: 0,
  versionHash: null,
  quotes: null
};

function normalizeText(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeToken(value) {
  return normalizeText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function tokenize(value) {
  return normalizeToken(value)
    .split(/[^a-z0-9_]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

function confidenceRank(value) {
  const normalized = normalizeToken(value);
  if (normalized === 'alt') return 3;
  if (normalized === 'mitja') return 2;
  if (normalized === 'baix') return 1;
  return 0;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }

    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }

    if (ch === '\r') {
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  row.push(field);
  if (row.length > 1 || row[0]) rows.push(row);
  return rows;
}

function getValue(row, headerMap, aliases) {
  for (const alias of aliases) {
    const idx = headerMap.get(normalizeToken(alias));
    if (typeof idx === 'number' && typeof row[idx] !== 'undefined') {
      return normalizeText(row[idx]);
    }
  }
  return '';
}

function buildReference(quote) {
  const title = quote.sourceTitle || 'Sense títol';
  const year = quote.year || quote.exactDate || 's/d';
  const source = quote.sourceDoc || '';
  const location = quote.location || '';
  const details = [source, location].filter(Boolean).join(' · ');
  return {
    id: quote.id,
    title,
    year,
    details,
    text: details ? `${title} (${year}) · ${details}` : `${title} (${year})`
  };
}

function buildSheetCsvUrl(gid) {
  const url = new URL(config.quotesSheetCsvUrl);
  url.searchParams.set('output', 'csv');
  url.searchParams.set('single', 'true');
  url.searchParams.set('gid', String(gid));
  return url.toString();
}

function computeCatalogHash(quotes) {
  const canonical = quotes
    .map((q) => ({ id: q.id, text: q.text, sourceSheetGid: q.sourceSheetGid }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function parseQuotesFromRows(rows, gid) {
  if (!rows.length) return [];

  const header = rows[0].map((h) => normalizeText(h));
  const headerMap = new Map();
  header.forEach((name, idx) => headerMap.set(normalizeToken(name), idx));

  const minRank = confidenceRank(config.quotesMinConfidence);

  return rows
    .slice(1)
    .map((row) => {
      const id = getValue(row, headerMap, ['quote_id', 'cita_id', 'id']);
      const text = getValue(row, headerMap, ['Cita_literal', 'cita_literal', 'quote_text', 'cita']);
      if (!id || !text) return null;

      const confidence = getValue(row, headerMap, ['Nivell_confiança', 'nivell_confiança', 'nivell_confianca', 'confidence']);
      if (minRank > 0 && confidenceRank(confidence) > 0 && confidenceRank(confidence) < minRank) return null;

      const sourceTitle = getValue(row, headerMap, ['Obra_titol', 'obra_titol', 'source_title', 'obra']);
      const sourceDoc = getValue(row, headerMap, ['Font_doc', 'font_doc', 'source_ref', 'font']);
      const location = getValue(row, headerMap, ['Localitzacio', 'localitzacio', 'location']);
      const year = getValue(row, headerMap, ['Any', 'any', 'year']);
      const exactDate = getValue(row, headerMap, ['Data_exacta', 'data_exacta', 'date']);

      const tags = [
        getValue(row, headerMap, ['Tema_1', 'tema_1']),
        getValue(row, headerMap, ['Tema_2', 'tema_2']),
        getValue(row, headerMap, ['Tema_3', 'tema_3']),
        getValue(row, headerMap, ['tema_norm_1']),
        getValue(row, headerMap, ['tema_norm_2']),
        getValue(row, headerMap, ['tema_norm_3']),
        getValue(row, headerMap, ['Paraules_clau', 'paraules_clau', 'keywords'])
      ]
        .filter(Boolean)
        .join(', ')
        .split(',')
        .map((t) => normalizeToken(t))
        .filter(Boolean);

      const tokenPool = new Set([
        ...tokenize(text),
        ...tokenize(tags.join(' ')),
        ...tokenize(sourceTitle),
        ...tokenize(sourceDoc)
      ]);

      return {
        id,
        text,
        normalizedText: normalizeText(text),
        sourceTitle,
        sourceDoc,
        location,
        year,
        exactDate,
        tags,
        confidence,
        sourceSheetGid: String(gid),
        searchTokens: [...tokenPool]
      };
    })
    .filter(Boolean);
}

async function fetchQuotesFromSheet() {
  if (!config.quotesSheetCsvUrl) {
    throw new Error('No hi ha URL de Google Sheet per validar cites.');
  }
  if (!config.quotesSheetGids.length) {
    throw new Error('No hi ha GIDs configurats per validar cites.');
  }

  const allQuotes = [];
  for (const gid of config.quotesSheetGids) {
    const url = buildSheetCsvUrl(gid);
    // eslint-disable-next-line no-await-in-loop
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`No s'ha pogut llegir Google Sheet (gid=${gid}, HTTP ${response.status}).`);
    }
    // eslint-disable-next-line no-await-in-loop
    const csv = await response.text();
    const rows = parseCsv(csv);
    const parsedQuotes = parseQuotesFromRows(rows, gid);
    allQuotes.push(...parsedQuotes);
  }

  const dedupById = new Map();
  for (const quote of allQuotes) {
    if (!dedupById.has(quote.id)) dedupById.set(quote.id, quote);
  }

  const merged = [...dedupById.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (!merged.length) {
    throw new Error('No s\'han trobat cites vàlides al Google Sheet.');
  }

  return {
    quotes: merged,
    sourceSheets: config.quotesSheetGids.map((gid) => String(gid)),
    versionHash: computeCatalogHash(merged)
  };
}

function useMemoryCache(quotes, versionHash) {
  quotesCache = {
    loadedAt: Date.now(),
    versionHash,
    quotes
  };
}

export async function syncQuotesCatalog({ force = false } = {}) {
  const ttlMs = Math.max(1, config.quotesCacheTtlMin) * 60 * 1000;
  const now = Date.now();

  if (!force && quotesCache.quotes && now - quotesCache.loadedAt < ttlMs) {
    return {
      changed: false,
      skipped: true,
      versionHash: quotesCache.versionHash,
      totalQuotes: quotesCache.quotes.length
    };
  }

  const fetched = await fetchQuotesFromSheet();
  const currentCatalog = await getQuotesCatalog();
  const changed = fetched.versionHash !== currentCatalog.versionHash;

  if (changed) {
    await upsertQuotesCatalog({
      versionHash: fetched.versionHash,
      sourceSheets: fetched.sourceSheets,
      quotes: fetched.quotes
    });
  }

  useMemoryCache(fetched.quotes, fetched.versionHash);

  return {
    changed,
    skipped: false,
    versionHash: fetched.versionHash,
    totalQuotes: fetched.quotes.length,
    sourceSheets: fetched.sourceSheets
  };
}

export async function loadQuotes({ forceRefresh = false } = {}) {
  const ttlMs = Math.max(1, config.quotesCacheTtlMin) * 60 * 1000;
  const now = Date.now();

  if (!forceRefresh && quotesCache.quotes && now - quotesCache.loadedAt < ttlMs) {
    return quotesCache.quotes;
  }

  try {
    const sync = await syncQuotesCatalog({ force: forceRefresh });
    if (!sync.skipped && sync.totalQuotes > 0 && quotesCache.quotes) {
      return quotesCache.quotes;
    }
  } catch (err) {
    if (quotesCache.quotes) return quotesCache.quotes;

    const fromDb = await getQuotesCatalog();
    if (Array.isArray(fromDb.quotes) && fromDb.quotes.length) {
      useMemoryCache(fromDb.quotes, fromDb.versionHash || 'db-fallback');
      return fromDb.quotes;
    }
    throw err;
  }

  const fromDb = await getQuotesCatalog();
  if (Array.isArray(fromDb.quotes) && fromDb.quotes.length) {
    useMemoryCache(fromDb.quotes, fromDb.versionHash || 'db-state');
    return fromDb.quotes;
  }

  throw new Error('No hi ha catàleg de cites disponible.');
}

export async function getRelevantQuotes(topic, limit = 6) {
  const quotes = await loadQuotes();
  const topicTokens = tokenize(topic);

  const scored = quotes.map((quote) => {
    let score = 0;
    for (const token of topicTokens) {
      if (quote.tags.some((tag) => tag.includes(token) || token.includes(tag))) score += 4;
      if (quote.searchTokens.includes(token)) score += 2;
      if (quote.normalizedText.toLowerCase().includes(token)) score += 1;
    }
    return { quote, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.quote.id.localeCompare(b.quote.id);
  });

  return scored.slice(0, limit).map((item) => item.quote);
}

function extractQuotedFragments(content) {
  const patterns = [
    /"([^"\n]+)"/g,
    /“([^”\n]+)”/g,
    /«([^»\n]+)»/g
  ];

  const fragments = [];
  for (const pattern of patterns) {
    let match = pattern.exec(content);
    while (match) {
      fragments.push(normalizeText(match[1]));
      match = pattern.exec(content);
    }
  }
  return fragments;
}

function removeInternalIds(content) {
  return String(content || '').replace(/\s*\[(PC_\d{4}|PT_\d{4}|AA_\d{4})\]/g, '');
}

function isHashtagLine(line) {
  return /^#\S+(?:\s+#\S+)*$/.test(String(line || '').trim());
}

function splitTrailingHashtags(content) {
  const lines = String(content || '')
    .replace(/\r/g, '')
    .split('\n');
  let idx = lines.length - 1;

  while (idx >= 0) {
    const line = lines[idx].trim();
    if (!line) {
      idx -= 1;
      continue;
    }
    if (!isHashtagLine(line)) break;
    idx -= 1;
  }

  const body = lines.slice(0, idx + 1).join('\n').trim();
  const hashtags = lines.slice(idx + 1).join('\n').trim();
  return { body, hashtags };
}

function removeTrailingReferencesBlock(body) {
  return String(body || '')
    .replace(/\n{0,2}Refer[eè]nc(?:ia|ies)(?:\s+d(?:e|['’])obra|\s+documentals?)?\s*:[\s\S]*$/i, '')
    .trim();
}

function buildReferencesBlock(citationRefs) {
  const refs = Array.isArray(citationRefs) ? citationRefs : [];
  if (!refs.length) return '';
  if (refs.length === 1) return `Referència d'obra: ${refs[0].text}`;
  const lines = refs.map((ref) => `- ${ref.text}`).join('\n');
  return `Referències d'obra:\n${lines}`;
}

export function composeContentWithReferences(content, citationRefs) {
  const cleaned = removeInternalIds(content)
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  if (!cleaned) return '';

  const dedupRefs = [...new Map((citationRefs || []).map((ref) => [ref.id, ref])).values()];
  const { body, hashtags } = splitTrailingHashtags(cleaned);
  const bodyWithoutRefs = removeTrailingReferencesBlock(body);
  const refsBlock = buildReferencesBlock(dedupRefs);

  let result = bodyWithoutRefs;
  if (refsBlock) {
    result = result ? `${result}\n\n${refsBlock}` : refsBlock;
  }
  if (hashtags) {
    result = result ? `${result}\n\n${hashtags}` : hashtags;
  }

  return result.trim();
}

export async function validatePostCitations(content) {
  const text = removeInternalIds(content);
  if (!config.requireReferencedQuotes) {
    return {
      ok: true,
      quoteIdsUsed: [],
      citationRefs: [],
      sanitizedContent: composeContentWithReferences(text, [])
    };
  }

  const quotedFragments = extractQuotedFragments(text);
  if (!quotedFragments.length) {
    return {
      ok: true,
      quoteIdsUsed: [],
      citationRefs: [],
      sanitizedContent: composeContentWithReferences(text, [])
    };
  }

  const quotes = await loadQuotes();
  const byNormalizedText = new Map();
  for (const quote of quotes) {
    const key = normalizeText(quote.text);
    if (!byNormalizedText.has(key)) byNormalizedText.set(key, []);
    byNormalizedText.get(key).push(quote);
  }

  const quoteIdsUsed = [];
  for (const fragment of quotedFragments) {
    const matches = byNormalizedText.get(fragment) || [];
    if (!matches.length) {
      return {
        ok: false,
        error: 'Hi ha una cita literal que no coincideix exactament amb la BBDD de cites.'
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        error: `Cita amb coincidències múltiples a la BBDD. Cal desambiguar-la: "${fragment.slice(0, 70)}..."`
      };
    }
    quoteIdsUsed.push(matches[0].id);
  }

  const uniqueIds = [...new Set(quoteIdsUsed)];
  const byId = new Map(quotes.map((q) => [q.id, q]));
  const citationRefs = uniqueIds.map((id) => buildReference(byId.get(id)));
  const sanitizedContent = composeContentWithReferences(text, citationRefs);

  return {
    ok: true,
    quoteIdsUsed: uniqueIds,
    citationRefs,
    sanitizedContent
  };
}
