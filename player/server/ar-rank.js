// Shared ranking for the MOSHI MOSHI "20-second challenge" (Hand Play game.js).
// One small JSON file per project in the deployments bucket (ar-creator/rank/<projectId>.json),
// read and rewritten server-side with the service key: no table / schema change.
// GET  /api/ar-rank?project=<uuid>              -> { list }
// POST /api/ar-rank { project, name, score }    -> { list, rank, id }
// Scores are a kids' game: integers 0..200, names cut to 10 characters, rate-limited per IP (loosely: a venue's Wi-Fi shares one IP).
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { rateLimit } from './_rate-limit.js'
import { cleanEnv } from './_env.js'

const SUPABASE_URL = cleanEnv(process.env.SUPABASE_URL) || 'https://pgyuabajrswdkzuksqfu.supabase.co'
const SUPABASE_SERVICE_KEY = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEEP = 50, SHOW = 10

const clean = (name) => String(name || '').replace(/[\u0000-\u001f<>"'`&\\]/g, '').trim().slice(0, 10)

async function read(sb, path) {
  const { data, error } = await sb.storage.from('deployments').download(path)
  if (error || !data) return []
  try { const j = JSON.parse(await data.text()); return Array.isArray(j) ? j : [] } catch { return [] }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' })
  if (!SUPABASE_SERVICE_KEY) return res.status(503).json({ error: 'storage not configured' })
  const project = String((req.method === 'GET' ? req.query?.project : req.body?.project) || '')
  if (!UUID.test(project)) return res.status(400).json({ error: 'project must be a project id' })
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  const path = `ar-creator/rank/${project.toLowerCase()}.json`

  if (req.method === 'GET') {
    if (rateLimit(req, res, { max: 60, windowMs: 60000 })) return
    const list = await read(sb, path)
    return res.status(200).json({ list: list.slice(0, SHOW) })
  }

  // generous: at an event everyone shares the venue Wi-Fi's public IP
  if (rateLimit(req, res, { max: 30, windowMs: 60000 })) return
  const score = Number(req.body?.score)
  if (!Number.isInteger(score) || score < 0 || score > 200) return res.status(400).json({ error: 'score must be an integer 0..200' })
  // only projects that exist on HACKAR:S
  const { data: exists } = await sb.storage.from('deployments').list(project, { limit: 1, search: 'overlay-params.json' })
  if (!exists || !exists.length) return res.status(404).json({ error: 'unknown project' })

  const me = { id: randomUUID().slice(0, 8), name: clean(req.body?.name) || 'ゲスト', score, at: Date.now() }
  const list = await read(sb, path)
  list.push(me)
  list.sort((a, b) => b.score - a.score || a.at - b.at)
  const kept = list.slice(0, KEEP)
  const { error } = await sb.storage.from('deployments').upload(path, Buffer.from(JSON.stringify(kept)), {
    contentType: 'application/json', upsert: true, cacheControl: '0',
  })
  if (error) return res.status(500).json({ error: 'save failed: ' + error.message })
  const rank = kept.findIndex((e) => e.id === me.id)
  return res.status(200).json({ list: kept.slice(0, SHOW), rank, id: me.id })
}
