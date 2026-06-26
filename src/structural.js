/**
 * structural.js — Tier-2 structural / cadence slop detection.
 *
 * The pattern detectors in patterns.js are density-based: weighted hits per
 * 100 words. That under-weights low-frequency but damning tells — a single
 * "X is not Y, it's Z" antithesis or three aphoristic one-line kickers in a
 * 1,200-word post is a dead AI giveaway, but it barely moves a density score.
 * This module ports the structural + lexical + cadence layers from the
 * 2026-slop scorer (the score.mjs the blog rebuild was calibrated against,
 * corpus mean ~17, worst offenders <40) so the headline score actually
 * reflects them.
 *
 * Layers (same weights as the calibrated reference):
 *   A — structural: antithesis, aphoristic kicker, -ing tails, copula
 *       inflation, rhetorical-question pivots, tricolon, staccato density
 *   B — lexical: 2026 blacklist words + sentence-opening transitions
 *   C — cadence: burstiness (sentence-length variation) + em-dash density
 */

// 2026 AI-slop vocabulary. Mirrors the reference scorer's blacklist.
const BLACKLIST = [
  'delve', 'delving', 'showcase', 'showcasing', 'underscore', 'underscores',
  'intricate', 'tapestry', 'meticulous', 'meticulously', 'pivotal', 'robust',
  'seamless', 'comprehensive', 'leverage', 'leverages', 'nuanced', 'realm',
  'boasts', 'garner', 'bolster', 'multifaceted', 'testament', 'beacon',
  'myriad', 'plethora', 'cutting-edge', 'game-changer', 'unlock', 'unleash',
  'elevate', 'empower', 'navigating', 'holistic',
];

const TRANSITIONS = [
  'Moreover', 'Furthermore', 'Additionally', 'Crucially', 'Importantly',
  'Ultimately', 'Consequently', 'Nevertheless', 'Nonetheless',
];

// ─── Helpers ─────────────────────────────────────────────

/**
 * Strip frontmatter, fenced code, inline code, markdown links and heading
 * marks so we score prose, not artifacts. (The reference scorer skipped
 * fenced code; we strip it too — code legitimately contains "not ... but".)
 */
function stripForStructural(text) {
  let t = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  t = t.replace(/```[\s\S]*?```/g, ' '); // fenced code blocks
  t = t.replace(/`[^`]*`/g, ' '); // inline code
  t = t.replace(/!?\[[^\]]*\]\([^)]*\)/g, ' '); // images + links
  t = t.replace(/[#>*]/g, ' '); // heading / quote / emphasis marks
  return t;
}

function splitSentences(body) {
  return body
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function countWords(s) {
  return (s.match(/\b[\w'-]+\b/g) || []).length;
}

function stdev(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
}

function matchAll(re, s) {
  return s.match(re) || [];
}

function clip(str, n = 90) {
  const one = str.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}

// ─── Detector regexes (ported from the calibrated reference) ──

const ANTITHESIS_RES = [
  /\b(it'?s|that'?s|this is|they'?re|i'?m|we'?re|there'?s)\s+not\s+(just |only |merely |simply |about )?[^.,;:]{1,60}[,.]?\s+(it'?s|but|they'?re|that'?s|it is)\b/gi,
  /\bnot\s+[\w-]+[,.]?\s+but\b/gi,
  /\bisn'?t\s+(just |only )?[^.,;:]{1,50}[,.]?\s+(it'?s|it is)\b/gi,
  /\b(is|are|was|were)\s+not\s+[^.!?]{1,70}[.!?]\s+(it|that|they|this|those)\s+(is|are|was|were)\b/gi,
  /\b(is|are)\s+not\s+(a|an|the)\s+[^.!?]{1,50}[.!?]\s+(it|that|they)\s+(is|are)\b/gi,
];
const ING_TAILS_RE = /,\s+(highlighting|underscoring|emphasizing|reflecting|ensuring|enabling|showcasing|cementing|signaling|signalling|marking|proving|paving|setting the stage|cultivating)\b/gi;
const RHET_Q_RE = /[A-Z][^.!?\n]{0,45}\?\s+[A-Z]/g;
const COPULA_RE = /\b(serves as|boasts|stands as a testament|acts as|a testament to)\b/gi;
const TRICOLON_RE = /\b[\w'-]+, [\w'-]+,? and [\w'-]+\b/g;

// ─── Main ────────────────────────────────────────────────

/**
 * Run the structural / lexical / cadence analysis on raw post text.
 *
 * @param {string} text — raw text (frontmatter + markdown ok)
 * @returns {{ aScore:number, bScore:number, cScore:number, slop:number,
 *   burst:number, emPer1k:number, sig:object, findings:object[] }}
 */
function analyzeStructural(text) {
  if (!text || typeof text !== 'string') {
    return {
      aScore: 0, bScore: 0, cScore: 0, slop: 0, burst: 0.7, emPer1k: 0,
      sig: { antithesis: 0, kicker: 0, kickerRatio: 0, ingTails: 0, copula: 0, rhetQ: 0, tricolon: 0, staccato: 0, blacklist: 0, transitions: 0 },
      findings: [],
    };
  }

  const body = stripForStructural(text);
  const W = countWords(body) || 1;
  const sents = splitSentences(body);
  const slen = sents.map(countWords).filter((n) => n > 0);
  const meanLen = slen.length ? slen.reduce((a, b) => a + b, 0) / slen.length : 0;
  const burst = slen.length > 1 && meanLen > 0 ? +(stdev(slen) / meanLen).toFixed(2) : 0.7;
  const per1k = (n) => +((n / W) * 1000).toFixed(2);

  const findings = [];

  // ── Layer A: structural ──────────────────────────────
  const antithesisMatches = [];
  for (const re of ANTITHESIS_RES) antithesisMatches.push(...matchAll(re, body));
  const antithesis = antithesisMatches.length;
  if (antithesis > 0) {
    findings.push(makeFinding(100, 'Antithesis cliché', 'structural', 4,
      'The "X is not Y, it\'s Z" / "not X but Y" construction. The signature 2026-AI rhetorical shape.',
      antithesisMatches, 'State it once, plainly. Drop the "not X, it\'s Y" framing.'));
  }

  // Aphoristic kicker: a paragraph ending in a short punchy declarative.
  const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 40);
  const kickerSents = [];
  for (const p of paras) {
    const ps = splitSentences(p);
    if (!ps.length) continue;
    const last = ps[ps.length - 1];
    const lw = countWords(last);
    if (lw >= 2 && lw <= 9 && /[.!?]$/.test(last) && !/[:•-]/.test(last)) kickerSents.push(last);
  }
  const kicker = kickerSents.length;
  const kickerRatio = paras.length ? kicker / paras.length : 0;
  if (kicker > 0) {
    findings.push(makeFinding(101, 'Aphoristic kicker', 'structural', 3,
      'Paragraph closed with an engineered one-line punch. One or two across a post is voice; a pile of them is a tic.',
      kickerSents, 'Merge the closer into the previous sentence, or cut it.'));
  }

  const ingTailMatches = matchAll(ING_TAILS_RE, body);
  const ingTails = ingTailMatches.length;
  if (ingTails > 0) {
    findings.push(makeFinding(102, 'Trailing -ing clause', 'structural', 3,
      'A participial tail (", highlighting…", ", ensuring…") bolted onto a sentence to editorialize.',
      ingTailMatches, 'Cut the -ing tail or give the point its own sentence.'));
  }

  const copulaMatches = matchAll(COPULA_RE, body);
  const copula = copulaMatches.length;
  if (copula > 0) {
    findings.push(makeFinding(103, 'Copula inflation', 'structural', 4,
      '"serves as", "acts as", "a testament to" — inflated linking phrases standing in for a plain verb.',
      copulaMatches, 'Replace with a concrete verb. "serves as a bridge" → "bridges".'));
  }

  const rhetMatches = matchAll(RHET_Q_RE, body);
  const rhetQ = rhetMatches.length;
  if (rhetQ > 0) {
    findings.push(makeFinding(104, 'Rhetorical-question pivot', 'structural', 2,
      'A question posed only to answer it in the next breath. AI uses it to fake momentum.',
      rhetMatches, 'Make it a statement. Lead with the answer.'));
  }

  const tricolonMatches = matchAll(TRICOLON_RE, body);
  const tricolon = tricolonMatches.length;
  if (tricolon >= 3) {
    findings.push(makeFinding(105, 'Tricolon pile-up', 'cadence', 1,
      'Repeated "a, b, and c" three-item parallels. One is rhetoric; several in a row is a rhythm tell.',
      tricolonMatches, 'Vary the list lengths or break the parallelism.'));
  }

  const staccato = slen.filter((n) => n <= 3).length;
  const staccatoRatio = slen.length ? staccato / slen.length : 0;

  // Ratio/rhythm signals (kicker, staccato) are reliable only with enough
  // sample. On a 3-paragraph snippet, kickerRatio spikes to ~1.0 — a
  // small-sample artifact, not slop. Scale them by a confidence factor so
  // terse human writing isn't condemned while a full post still gets the
  // full weight. Count-based tells (antithesis, -ing tails, copula) need no
  // such guard — one is one whether the text is short or long.
  const kConf = Math.min(1, paras.length / 8);
  const sConf = Math.min(1, slen.length / 15);

  const aScore = Math.min(
    45,
    antithesis * 7 +
      kickerRatio * 35 * kConf +
      ingTails * 4 +
      copula * 4 +
      rhetQ * 2 +
      tricolon * 1.0 +
      staccatoRatio * 15 * sConf,
  );

  // ── Layer B: lexical ─────────────────────────────────
  let blacklistTotal = 0;
  const blHits = {};
  for (const w of BLACKLIST) {
    const c = matchAll(new RegExp(`\\b${w}\\b`, 'gi'), body).length;
    if (c) {
      blacklistTotal += c;
      blHits[w] = c;
    }
  }
  if (blacklistTotal > 0) {
    const top = Object.entries(blHits).sort((a, b) => b[1] - a[1]);
    findings.push(makeFinding(106, 'AI-tell vocabulary', 'lexical', 3,
      'Words from the 2026-slop blacklist (delve, robust, seamless, leverage, tapestry…).',
      top.map(([w, c]) => `${w} ×${c}`), 'Swap for plain language a person would actually use.'));
  }

  let transitions = 0;
  const trHits = [];
  for (const w of TRANSITIONS) {
    const m = matchAll(new RegExp(`(^|\\n)\\s*${w}\\b`, 'g'), body);
    if (m.length) {
      transitions += m.length;
      trHits.push(`${w} ×${m.length}`);
    }
  }
  if (transitions > 0) {
    findings.push(makeFinding(107, 'Transition-word opener', 'lexical', 2,
      'Sentences opened with "Moreover / Furthermore / Additionally" — connective tissue AI over-uses.',
      trHits, 'Cut the opener or rework the join. Most are deletable.'));
  }

  const bScore = Math.min(25, per1k(blacklistTotal) * 3 + transitions * 2);

  // ── Layer C: cadence ─────────────────────────────────
  const emdash = matchAll(/—/g, body).length;
  const emPer1k = per1k(emdash);
  let cScore = 0;
  // Burstiness is a rhythm signal — same small-sample caveat as the kicker.
  const bConf = Math.min(1, slen.length / 15);
  if (burst < 0.4) cScore += 14 * bConf;
  else if (burst < 0.5) cScore += 9 * bConf;
  else if (burst < 0.6) cScore += 4 * bConf;
  cScore += Math.min(6, Math.max(0, emPer1k - 3) * 1.5); // em-dash count, no scaling
  cScore = Math.min(20, +cScore.toFixed(1));
  if (emPer1k > 3) {
    findings.push(makeFinding(108, 'Em-dash density', 'cadence', 2,
      'Em dashes well above human baseline. (The blog bans them outright.)',
      [`${emdash} em dashes (${emPer1k}/1k words)`], 'Replace with commas, periods, or parentheses.'));
  }

  const slop = Math.round(aScore + bScore + cScore);

  return {
    aScore: +aScore.toFixed(1),
    bScore: +bScore.toFixed(1),
    cScore,
    slop,
    burst,
    emPer1k,
    sig: {
      antithesis,
      kicker,
      kickerRatio: +kickerRatio.toFixed(2),
      ingTails,
      copula,
      rhetQ,
      tricolon,
      staccato,
      blacklist: blacklistTotal,
      transitions,
    },
    findings,
  };
}

function makeFinding(id, name, category, weight, description, rawMatches, suggestion) {
  const matches = rawMatches.slice(0, 8).map((m) => ({
    match: clip(String(m)),
    suggestion,
    confidence: 'high',
  }));
  return {
    patternId: id,
    patternName: name,
    category,
    description,
    weight,
    matchCount: rawMatches.length,
    matches,
    truncated: rawMatches.length > matches.length,
    structural: true,
  };
}

module.exports = { analyzeStructural, stripForStructural, BLACKLIST, TRANSITIONS };
