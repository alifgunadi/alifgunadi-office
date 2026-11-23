// @mention parsing for the prompt dock: who a prompt is addressed to. Plain JavaScript that works as a classic browser script
// (global OfficeMentions) and as a Node module (so the server can use the same rules later and the tests need no browser).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./roles-shared'));
  else root.OfficeMentions = factory(root.OfficeRoles);
})(typeof self !== 'undefined' ? self : this, function (roles) {
  'use strict';

  const MAIN = roles.MAIN_DESK;
  // AlifGunadi (the main desk) cannot be @mentioned, so he is never in `targets`. He is the default instead: a prompt with no
  // target at all is his own (the dock and the server both apply that, see effectiveTargets in dock.js and POST /prompts).
  const AGENT_IDS = roles.ROLE_IDS.filter((id) => id !== MAIN);
  const DIVISION_LABELS = { product: 'Product', eng: 'Engineering', qa: 'QA' };
  const DIVISION_ALIASES = { product: ['product'], eng: ['eng', 'engineering'], qa: ['qa'] };
  const DIVISION_IDS = Object.fromEntries(Object.keys(DIVISION_LABELS).map((k) => [k, roles.ZONE_IDS[k].filter((id) => id !== MAIN)]));
  const EVERYONE = ['everyone', 'all'];

  const normalise = (s) => String(s).toLowerCase();

  // Which division a token names, if any (the alias list also covers "engineering").
  function divisionOf(token) {
    const t = normalise(token);
    return Object.keys(DIVISION_ALIASES).find((k) => DIVISION_ALIASES[k].includes(t)) || null;
  }

  // The agent a token names: an exact desk id, "ux" for "lead-ux", or a guest id that is currently in the office.
  function agentOf(token, guestIds) {
    const t = normalise(token);
    if (!t) return null;
    const known = AGENT_IDS.concat(guestIds || []);
    const exact = known.find((id) => normalise(id) === t);
    if (exact) return exact;
    const short = AGENT_IDS.filter((id) => id === 'lead-' + t);
    return short.length === 1 ? short[0] : null;
  }

  // Every @token in a text (an @ at the start or after a space or bracket/comma/semicolon, followed by letters, digits, - or _).
  function tokens(text) {
    const out = [];
    const re = /(^|[\s(,;])@([A-Za-z0-9_-]+)/g;
    let m;
    while ((m = re.exec(text)) !== null) out.push({ token: m[2], start: m.index + m[1].length, end: m.index + m[1].length + 1 + m[2].length });
    return out;
  }

  // Who a text is addressed to. targets is deduplicated and keeps the order they were first mentioned in.
  // Unknown @words are plain text, listed in unknown so the dock can warn.
  function resolve(text, guestIds) {
    const mentions = [], unknown = [], targets = [];
    let everyone = false;
    const add = (ids) => { for (const id of ids) if (!targets.includes(id)) targets.push(id); };
    for (const t of tokens(String(text))) {
      const low = normalise(t.token);
      if (EVERYONE.includes(low)) { everyone = true; mentions.push({ ...t, kind: 'everyone', ids: AGENT_IDS.slice() }); add(AGENT_IDS); continue; }
      const div = divisionOf(low);
      if (div) { mentions.push({ ...t, kind: 'division', division: div, ids: DIVISION_IDS[div].slice() }); add(DIVISION_IDS[div]); continue; }
      const id = agentOf(low, guestIds);
      if (id) { mentions.push({ ...t, kind: 'agent', ids: [id] }); add([id]); continue; }
      unknown.push(t.token);
    }
    return { targets, mentions, unknown, everyone };
  }

  // The @word being typed at the caret, so the dock knows when to offer suggestions: { start, end, query } or null.
  function activeMention(text, caret) {
    let i = caret;
    while (i > 0 && /[A-Za-z0-9_-]/.test(text[i - 1])) i--;
    if (i === 0 || text[i - 1] !== '@') return null;
    if (i - 1 > 0 && !/[\s(,;]/.test(text[i - 2])) return null;
    return { start: i - 1, end: caret, query: text.slice(i, caret) };
  }

  // Suggestions for what has been typed after the @, in the three groups of the design. Each item: { group, token, label, hint }.
  function suggestions(query, guestIds, labelOf) {
    const q = normalise(query || '');
    const label = labelOf || ((id) => id);
    const out = [];
    if (EVERYONE.some((w) => w.startsWith(q))) out.push({ group: 'Semua Tim', token: 'everyone', label: '@everyone / @all', hint: AGENT_IDS.length + ' agent' });
    for (const k of Object.keys(DIVISION_LABELS)) {
      if (DIVISION_ALIASES[k].some((a) => a.startsWith(q))) out.push({ group: 'Divisi', token: k, label: '@' + k, hint: DIVISION_IDS[k].length + ' agent' });
    }
    for (const id of AGENT_IDS.concat(guestIds || [])) {
      const low = normalise(id);
      if (!q || low.startsWith(q) || low.replace(/^lead-/, '').startsWith(q)) out.push({ group: 'Agent', token: id, label: '@' + id, hint: label(id) });
    }
    return out;
  }

  // Put the chosen @token where the user was typing, with a space after it. Returns the new text and caret.
  function insertMention(text, caret, token) {
    const active = activeMention(text, caret);
    const start = active ? active.start : caret, end = active ? active.end : caret;
    const insert = '@' + token + ' ';
    return { text: text.slice(0, start) + insert + text.slice(end), caret: start + insert.length };
  }

  // "Akan dikirim ke 4 agent Engineering" and friends: what will happen when the prompt is sent.
  function describe(targetIds, resolved, labelOf) {
    const label = labelOf || ((id) => id);
    const n = targetIds.length;
    if (!n) return '';
    if (resolved && resolved.everyone) return 'Akan dikirim ke semua ' + n + ' agent';
    if (resolved && resolved.mentions.length === 1 && resolved.mentions[0].kind === 'division' && resolved.mentions[0].ids.length === n) {
      return 'Akan dikirim ke ' + n + ' agent ' + DIVISION_LABELS[resolved.mentions[0].division];
    }
    if (n === 1) return 'Akan dikirim ke ' + label(targetIds[0]);
    return 'Akan dikirim ke ' + n + ' agent';
  }

  return Object.freeze({ AGENT_IDS, EVERYONE_IDS: AGENT_IDS, DIVISION_IDS, DIVISION_LABELS, resolve, tokens, activeMention, suggestions, insertMention, describe });
});
