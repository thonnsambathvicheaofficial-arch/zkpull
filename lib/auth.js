// Username/password gate, backed by Supabase (login_users table) so accounts
// persist across Vercel's stateless/ephemeral instances — a local config.json
// file wouldn't survive a redeploy or a different serverless container.
//
// Sessions stay a stateless signed cookie (payload includes the role, so
// authorization checks never need a DB round-trip — only login/user-management
// calls touch the database). SESSION_SECRET must be set as an env var and kept
// stable, or every existing session breaks on the next deploy/restart.
//
// This is a LAN/small-team convenience gate, not a hardened public auth system.

const crypto = require('crypto')
const bcrypt = require('bcryptjs')
const sb = require('./supabase')

require('dotenv').config()
const SECRET = process.env.SESSION_SECRET
if (!SECRET) throw new Error('Missing SESSION_SECRET. Set it in .env (local) or the Vercel project\'s Environment Variables — use a long random string and never change it, or all sessions will be invalidated.')
const MAXAGE = (Number(process.env.SESSION_HOURS) || 12) * 3600   // seconds

const eq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

async function check(username, password) {
  const { data: u } = await sb.from('login_users').select('*').eq('username', username).maybeSingle()
  if (!u) return null
  const ok = await bcrypt.compare(String(password || ''), u.password_hash)
  return ok ? { username: u.username, role: u.role } : null
}

function sign(username, role) {
  const payload = `${username}|${role}|${Date.now() + MAXAGE * 1000}`
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('hex')
  return Buffer.from(`${payload}|${mac}`).toString('base64')
}

function verify(token) {
  try {
    const raw = Buffer.from(token, 'base64').toString()
    const i = raw.lastIndexOf('|')
    const payload = raw.slice(0, i), mac = raw.slice(i + 1)
    const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('hex')
    if (!eq(mac, expect)) return null
    const [username, role, exp] = payload.split('|')
    if (Date.now() > Number(exp)) return null
    return { username, role }
  } catch { return null }
}

function cookies(req) {
  const out = {}
  for (const p of (req.headers.cookie || '').split(';')) {
    const i = p.indexOf('=')
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim())
  }
  return out
}

const currentUser = req => { const t = cookies(req).rp_session; return t ? verify(t) : null }

// ── user management (Supabase, live — no restart needed) ──
const listUsers = async () => {
  const { data, error } = await sb.from('login_users').select('username,role').order('username', { ascending: true })
  if (error) throw new Error(error.message)
  return data.map(u => ({ username: u.username, role: u.role === 'admin' ? 'admin' : 'user' }))
}

const adminCount = async () => {
  const { count, error } = await sb.from('login_users').select('*', { count: 'exact', head: true }).eq('role', 'admin')
  if (error) throw new Error(error.message)
  return count || 0
}

async function addUser(username, password, role) {
  username = String(username || '').trim()
  if (!username || !password) throw new Error('Username and password are both required.')
  const { data: exists } = await sb.from('login_users').select('username').eq('username', username).maybeSingle()
  if (exists) throw new Error('That username already exists.')
  const password_hash = await bcrypt.hash(String(password), 10)
  const { error } = await sb.from('login_users').insert({ username, password_hash, role: role === 'admin' ? 'admin' : 'user' })
  if (error) throw new Error(error.message)
}

async function updateUser(username, patch = {}) {
  const { data: u } = await sb.from('login_users').select('*').eq('username', username).maybeSingle()
  if (!u) throw new Error('User not found.')
  const row = {}
  const nn = patch.newUsername != null ? String(patch.newUsername).trim() : null
  if (nn && nn !== username) {
    const { data: taken } = await sb.from('login_users').select('username').eq('username', nn).maybeSingle()
    if (taken) throw new Error('That username already exists.')
    row.username = nn
  }
  if (patch.password) row.password_hash = await bcrypt.hash(String(patch.password), 10)
  if (patch.role != null) {
    const nr = patch.role === 'admin' ? 'admin' : 'user'
    if (u.role === 'admin' && nr !== 'admin' && (await adminCount()) <= 1) throw new Error('At least one admin is required.')
    row.role = nr
  }
  const { error } = await sb.from('login_users').update(row).eq('username', username)
  if (error) throw new Error(error.message)
}

async function deleteUser(username) {
  const { count } = await sb.from('login_users').select('*', { count: 'exact', head: true })
  if ((count || 0) <= 1) throw new Error('Cannot delete the only account — you would be locked out.')
  const { data: u } = await sb.from('login_users').select('*').eq('username', username).maybeSingle()
  if (!u) throw new Error('User not found.')
  if (u.role === 'admin' && (await adminCount()) <= 1) throw new Error('Cannot delete the only admin.')
  const { error } = await sb.from('login_users').delete().eq('username', username)
  if (error) throw new Error(error.message)
}

module.exports = { check, sign, currentUser, MAXAGE, listUsers, addUser, updateUser, deleteUser }
