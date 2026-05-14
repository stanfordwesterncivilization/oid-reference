'use strict';

const express  = require('express');
const https    = require('https');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');
const { parse } = require('node-html-parser');

// ── SQLite setup ─────────────────────────────────────────────────────────────
let db = null;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'oid-cache.db');
try {
  const Database = require('better-sqlite3');
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS oids (
      oid        TEXT PRIMARY KEY,
      name       TEXT,
      data       TEXT NOT NULL,
      cached_at  INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS searches (
      query      TEXT PRIMARY KEY,
      results    TEXT NOT NULL,
      cached_at  INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_oid_name ON oids(name);
  `);
  console.log(`[cache] SQLite ready → ${DB_PATH}`);
} catch (e) {
  console.warn(`[cache] SQLite unavailable (${e.message}), using memory cache`);
}

// In-memory fallback
const memCache = { oids: {}, searches: {} };
const CACHE_TTL = 30 * 24 * 3600; // 30 days in seconds

function getCachedOID(oid) {
  if (db) {
    const row = db.prepare('SELECT data, cached_at FROM oids WHERE oid = ?').get(oid);
    if (row && (Date.now() / 1000 - row.cached_at) < CACHE_TTL) return JSON.parse(row.data);
    return null;
  }
  const entry = memCache.oids[oid];
  return entry ? entry.data : null;
}

function setCachedOID(oid, data) {
  const str = JSON.stringify(data);
  if (db) {
    db.prepare('INSERT OR REPLACE INTO oids (oid, name, data) VALUES (?, ?, ?)').run(oid, data.name || '', str);
  } else {
    memCache.oids[oid] = { data, ts: Date.now() };
  }
}

function getCachedSearch(query) {
  if (db) {
    const row = db.prepare('SELECT results, cached_at FROM searches WHERE query = ?').get(query);
    if (row && (Date.now() / 1000 - row.cached_at) < 3600) return JSON.parse(row.results); // 1hr TTL for search
    return null;
  }
  const entry = memCache.searches[query];
  return entry ? entry.data : null;
}

function setCachedSearch(query, results) {
  const str = JSON.stringify(results);
  if (db) {
    db.prepare('INSERT OR REPLACE INTO searches (query, results) VALUES (?, ?)').run(query, str);
  } else {
    memCache.searches[query] = { data: results, ts: Date.now() };
  }
}

// ── ENTERPRISE OID DATABASE (IANA) ───────────────────────────────────────────
const ENTERPRISE_NAMES = {
  2:     'IBM Corporation',
  9:     'Cisco Systems',
  11:    'Hewlett-Packard',
  42:    'Sun Microsystems',
  43:    '3Com',
  52:    'Cabletron / Enterasys',
  111:   'Oracle Corporation',
  171:   'D-Link Systems',
  207:   'Allied Telesis',
  232:   'HP / Compaq',
  244:   'Lantronix',
  311:   'Microsoft Corporation',
  318:   'APC by Schneider Electric',
  368:   'Axis Communications',
  434:   'Liebert / Vertiv',
  674:   'Dell Inc.',
  789:   'NetApp',
  890:   'Zyxel Communications',
  1139:  'Synology Inc.',
  1271:  'Eaton Corporation',
  1588:  'Brocade Communications',
  1872:  'Radware',
  1916:  'Extreme Networks',
  1991:  'Foundry Networks (Brocade)',
  2011:  'Huawei Technologies',
  2272:  'Nortel Networks',
  2544:  'Proxim Wireless',
  2620:  'Check Point Software',
  2636:  'Juniper Networks',
  3375:  'F5 Networks',
  3417:  'Riverbed Technology',
  3764:  'Spirent Communications',
  3902:  'ZTE Corporation',
  4329:  'Digi International',
  4491:  'CableLabs (DOCSIS)',
  4526:  'NETGEAR',
  4881:  'Avaya',
  5003:  'Polycom',
  5089:  'Alcatel-Lucent / Nokia',
  6027:  'Force10 Networks (Dell)',
  6246:  'ADTRAN',
  6527:  'Nokia (SR OS)',
  6643:  'Zhone Technologies',
  6876:  'VMware',
  7054:  'Blue Coat Systems',
  8072:  'Net-SNMP',
  8741:  'SonicWall',
  9694:  'Motorola Solutions',
  11011: 'Symbol Technologies (Zebra)',
  11129: 'Google LLC',
  11863: 'TP-Link Technologies',
  12356: 'Fortinet',
  13742: 'ADVA Optical Networking',
  14179: 'Cisco Systems (AireOS/WLC)',
  14823: 'Aruba Networks (HPE)',
  17713: 'Aruba Networks (HPE)',
  20632: 'Barracuda Networks',
  21067: 'Sophos',
  21839: 'WatchGuard Technologies',
  22610: 'Mimosa Networks',
  25053: 'Ruckus Networks (CommScope)',
  25461: 'Palo Alto Networks',
  26928: 'Aerohive Networks (Extreme)',
  29096: 'Meru Networks',
  29671: 'Cisco Meraki',
  30065: 'Arista Networks',
  30803: 'Crestron Electronics',
  31496: 'MOXA Technologies',
  32446: 'Paessler AG (PRTG)',
  33543: 'Eltek',
  34294: 'Opengear',
  35098: 'Cambium Networks',
  35225: 'Cradlepoint',
  37476: 'Ubiquiti Networks',
  40310: 'CommScope',
  41112: 'Ubiquiti Networks',
  43356: 'Powervar',
};

// ── HTTP FETCHER ─────────────────────────────────────────────────────────────
function fetchURL(targetUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const mod = targetUrl.startsWith('https') ? https : http;
    const req = mod.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OIDReference/1.0; +https://github.com/paessler/oid-reference)',
        'Accept': 'text/html',
      },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, targetUrl).href;
        return fetchURL(next, redirects + 1).then(resolve).catch(reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// ── HTML PARSER ──────────────────────────────────────────────────────────────
function parseOIDPage(body, oid) {
  const root = parse(body);
  const result = {
    oid,
    name: null,
    aliases: [],
    desc: null,
    plain: null,
    asn1: [],
    iri: null,
    children: [],
    org: null,
    childCount: 0,
    tags: [],
    source: 'oidref.com',
  };

  // Grab all text from the page in a structured way
  const allText = root.text;

  // Node name — look for "node name" label then next content
  const bodyText = body;

  // Names: look for the list items after "node name"
  const nameSection = bodyText.match(/node name[\s\S]{0,300}?<\/div>/i);
  if (nameSection) {
    const liMatches = nameSection[0].matchAll(/<li>([\w\s,\-()]+)<\/li>/gi);
    const names = [];
    for (const m of liMatches) names.push(m[1].trim());
    if (names.length) {
      result.name = names[0].split(',')[0].trim();
      result.aliases = names.slice(1).concat(names[0].split(',').slice(1).map(s => s.trim())).filter(Boolean);
    }
  }

  // Try title fallback
  if (!result.name) {
    const titleM = bodyText.match(/<title>OID [\d.]+ ([^<]+?) reference/i);
    if (titleM) {
      const parts = titleM[1].trim().split(/,\s*/);
      result.name = parts[0];
      result.aliases = parts.slice(1);
    }
  }

  // Description
  const descM = bodyText.match(/Description by oid_info[\s\S]{0,100}<p>([\s\S]+?)<\/p>/i);
  if (descM) result.desc = descM[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  // Information (plain language source)
  const infoM = bodyText.match(/Information by oid_info[\s\S]{0,100}<p>([\s\S]+?)<\/p>/i);
  if (infoM) result.plain = infoM[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 600);

  // ASN1
  const asn1Matches = bodyText.matchAll(/\{([^}]+)\}/g);
  const asn1Set = new Set();
  for (const m of asn1Matches) {
    const candidate = m[1].trim();
    if (/\w+\s*\(\d+\)/.test(candidate) || /^\w+\s+\d+$/.test(candidate)) asn1Set.add('{' + candidate + '}');
  }
  result.asn1 = [...asn1Set].slice(0, 6);

  // IRI
  const iriM = bodyText.match(/iri oid[\s\S]{0,200}?<li>(\/[\w\/\-]+)<\/li>/i);
  if (iriM) result.iri = iriM[1];

  // Children table — parse every link to oidref.com/X.X.X that isn't the current OID
  const childPattern = new RegExp(`href="https?://oidref\\.com/(${oid.replace(/\./g,'\\.')}\\.[\\d.]+)"[^>]*>[\\d.]+</a>([^<]*)`, 'g');
  const childrenSeen = new Set();
  const childMatches = bodyText.matchAll(/href="https?:\/\/oidref\.com\/([\d.]+)"[^>]*title="([^"]*)"[^>]*>[\d.]+<\/a>/g);
  for (const m of childMatches) {
    const childOid = m[1];
    if (childOid === oid || childrenSeen.has(childOid)) continue;
    if (!childOid.startsWith(oid + '.')) continue;
    childrenSeen.add(childOid);
    const titleParts = m[2].split(' ');
    const childName = titleParts.slice(1).join(' ').replace(/\s+/g, ' ').trim();
    result.children.push({ oid: childOid, name: childName || childOid });
  }

  // Sub nodes total from table header
  const totalM = bodyText.match(/Sub Nodes Total[\s\S]{0,100}?(\d[\d,]+)/i);
  if (totalM) result.childCount = parseInt(totalM[1].replace(/,/g, ''));

  // Registration authority
  const orgM = bodyText.match(/Registration Authority[\s\S]{0,300}<a[^>]+>([^<]{3,80})<\/a>/i);
  if (orgM) result.org = orgM[1].trim();

  // Auto-tag
  if (oid.startsWith('1.3.6.1')) result.tags.push('snmp');
  if (oid.startsWith('2.5') || oid.startsWith('1.2.840.113549') || oid.startsWith('1.3.6.1.5.5.7')) result.tags.push('pki');
  if (oid.startsWith('2.5.4')) result.tags.push('ldap');
  if (oid.startsWith('1.3.6.1.4.1')) result.tags.push('enterprise');

  return result;
}

// ── OID LOOKUP ────────────────────────────────────────────────────────────────
async function lookupOID(oid) {
  // 1. Check cache
  const cached = getCachedOID(oid);
  if (cached) return { ...cached, fromCache: true };

  // 2. Enterprise shortcut (no network needed)
  const parts = oid.split('.');
  if (parts.length === 7 && parts.slice(0, 6).join('.') === '1.3.6.1.4.1') {
    const entNum = parseInt(parts[6]);
    const entName = ENTERPRISE_NAMES[entNum];
    if (entName) {
      const result = {
        oid,
        name: entName.split(/[\s(]/)[0].toLowerCase(),
        aliases: [],
        desc: `Private enterprise OID for ${entName}`,
        plain: `This is the registered private enterprise OID arc for ${entName}. All vendor-specific SNMP OIDs for this company live under this arc. Enterprise number ${entNum} was assigned by IANA.`,
        asn1: [],
        tags: ['snmp', 'enterprise'],
        childCount: 0,
        children: [],
        org: entName,
      };
      setCachedOID(oid, result);
      return result;
    }
  }

  // 3. Fetch from oidref.com
  const { status, body } = await fetchURL(`https://oidref.com/${oid}`);
  if (status === 404) return null;
  if (status !== 200) throw new Error(`oidref.com returned HTTP ${status}`);

  const parsed = parseOIDPage(body, oid);
  if (!parsed.name) parsed.name = oid.split('.').pop(); // fallback

  // Cache and return
  setCachedOID(oid, parsed);
  return parsed;
}

// ── SEARCH ────────────────────────────────────────────────────────────────────
async function searchOIDs(query) {
  const q = query.toLowerCase().trim();

  // Check search cache
  const cached = getCachedSearch(q);
  if (cached) return cached;

  const results = [];
  const seen = new Set();

  // 1. Direct OID lookup (if query looks like an OID)
  if (/^[\d.]+$/.test(q)) {
    try {
      const info = await lookupOID(q);
      if (info) {
        results.push({ oid: q, name: info.name, desc: info.desc, tags: info.tags || [], plain: info.plain });
        seen.add(q);
      }
    } catch (e) { /* ignore */ }
  }

  // 2. Enterprise name search (vendor lookup — Meraki, Fortinet, etc.)
  for (const [num, name] of Object.entries(ENTERPRISE_NAMES)) {
    if (name.toLowerCase().includes(q)) {
      const oid = `1.3.6.1.4.1.${num}`;
      if (!seen.has(oid)) {
        results.push({
          oid,
          name,
          desc: `Private enterprise OID arc — IANA Enterprise Number ${num}`,
          plain: `Vendor-specific SNMP OID arc for ${name}.`,
          tags: ['snmp', 'enterprise'],
        });
        seen.add(oid);
      }
    }
  }

  // 3. SQLite full-text search over cached OIDs
  if (db) {
    const rows = db.prepare(`
      SELECT oid, name, data FROM oids
      WHERE name LIKE ? OR oid LIKE ?
      LIMIT 20
    `).all(`%${q}%`, `%${q}%`);
    for (const row of rows) {
      if (!seen.has(row.oid)) {
        const data = JSON.parse(row.data);
        if (
          row.name?.toLowerCase().includes(q) ||
          data.desc?.toLowerCase().includes(q) ||
          data.plain?.toLowerCase().includes(q) ||
          data.aliases?.some(a => a.toLowerCase().includes(q))
        ) {
          results.push({ oid: row.oid, name: data.name, desc: data.desc, tags: data.tags || [], plain: data.plain });
          seen.add(row.oid);
        }
      }
    }
  }

  // 4. Try oidref.com orgs search for name queries
  if (results.length < 5 && q.length >= 3 && !/^[\d.]+$/.test(q)) {
    try {
      const { body, status } = await fetchURL(`https://oidref.com/orgs/`);
      if (status === 200) {
        const orgMatches = body.matchAll(/href="(\/org\/[^"]+)"[^>]*>([^<]+)</g);
        for (const m of orgMatches) {
          if (m[2].toLowerCase().includes(q) && results.length < 25) {
            results.push({ oid: '', name: m[2].trim(), desc: 'Registered organization', tags: ['org'], slug: m[1] });
          }
        }
      }
    } catch (e) { /* ignore */ }
  }

  const final = results.slice(0, 30);
  setCachedSearch(q, final);
  return final;
}

// ── OID ENCODING UTILS ────────────────────────────────────────────────────────
function oidToDerHex(oid) {
  const parts = oid.split('.').map(Number);
  if (parts.length < 2) return '06 00';
  const encoded = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i];
    const bytes = [val & 0x7F]; val >>= 7;
    while (val > 0) { bytes.unshift((val & 0x7F) | 0x80); val >>= 7; }
    encoded.push(...bytes);
  }
  return '06 ' + encoded.length.toString(16).padStart(2, '0') + ' ' +
    encoded.map(b => b.toString(16).padStart(2, '0')).join(' ');
}

function oidToIri(oid) {
  return '/' + oid.split('.').join('/');
}

// ── EXPRESS APP ───────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');

// Serve static frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'oid-reference.html'));
});

// Health check (for Render)
app.get('/health', (req, res) => res.json({ ok: true, cached: db ? db.prepare('SELECT COUNT(*) as c FROM oids').get().c : Object.keys(memCache.oids).length }));

// OID lookup
app.get('/api/oid/*', async (req, res) => {
  const oid = req.params[0]?.trim();
  if (!oid || !/^[\d.]+$/.test(oid)) return res.status(400).json({ error: 'Invalid OID' });

  try {
    const data = await lookupOID(oid);
    if (!data) return res.status(404).json({ error: `OID ${oid} not found` });
    data.derHex = oidToDerHex(oid);
    data.iriPath = data.iri || oidToIri(oid);
    res.json(data);
  } catch (e) {
    console.error(`[oid] ${oid}:`, e.message);
    res.status(502).json({ error: `Lookup failed: ${e.message}` });
  }
});

// Search
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.status(400).json({ error: 'Query must be at least 2 characters' });

  try {
    const results = await searchOIDs(q);
    res.json({ query: q, count: results.length, results });
  } catch (e) {
    console.error(`[search] ${q}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

// Enterprise vendors
app.get('/api/enterprises', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const results = Object.entries(ENTERPRISE_NAMES)
    .filter(([, name]) => !q || name.toLowerCase().includes(q))
    .map(([num, name]) => ({ oid: `1.3.6.1.4.1.${num}`, enterprise: parseInt(num), name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ count: results.length, results });
});

// Cache stats
app.get('/api/stats', (req, res) => {
  let oidCount = 0, searchCount = 0;
  if (db) {
    oidCount = db.prepare('SELECT COUNT(*) as c FROM oids').get().c;
    searchCount = db.prepare('SELECT COUNT(*) as c FROM searches').get().c;
  } else {
    oidCount = Object.keys(memCache.oids).length;
    searchCount = Object.keys(memCache.searches).length;
  }
  res.json({ oidsCached: oidCount, searchesCached: searchCount, storage: db ? 'sqlite' : 'memory' });
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅  OID Reference running on port ${PORT}`);
  console.log(`   Local: http://localhost:${PORT}\n`);
});
