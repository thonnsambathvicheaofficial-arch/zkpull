// Simple username/password gate for the local app. Credentials live in
// ./config.json (which you edit); sessions are stateless signed cookies so a
// restart doesn't forcibly log everyone out mid-shift... actually it does re-key
// only if the secret changes — the secret is generated once and kept.
//
// This is a LAN convenience gate ("not just anyone on the network can pull"),
// not a hardened public auth system. Protect the app folder's file permissions.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const CFG = path.join(__dirname, '..', 'config.json')

function loadConfig() {
  let c = null
  try { c = JSON.parse(fs.readFileSync(CFG, 'utf8')) } catch { /* create below */ }
  let changed = false
  if (!c || typeof c !== 'object') {
    c = { users: [{ username: 'admin', password: 'changeme', role: 'admin' }], sessionSecret: '', sessionHours: 12 }
    changed = true
    console.log('\n  ⚠  Created config.json with a default login  →  admin / changeme  (role: admin)')
    console.log('     Edit config.json to set your real username & password.\n')
  }
  if (!c.sessionSecret) { c.sessionSecret = crypto.randomBytes(24).toString('hex'); changed = true }
  if (!Array.isArray(c.users) || !c.users.length) { c.users = [{ username: 'admin', password: 'changeme', role: 'admin' }]; changed = true }
  // Guarantee at least one admin (migrates older configs that had no roles).
  if (!c.users.some(u => u.role === 'admin')) { c.users[0].role = 'admin'; changed = true }
  if (!c.sessionHours) c.sessionHours = 12
  if (changed) fs.writeFileSync(CFG, JSON.stringify(c, null, 2))
  return c
}

const cfg = loadConfig()
const MAXAGE = (cfg.sessionHours || 12) * 3600      // seconds

const eq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

function check(username, password) {
  const u = cfg.users.find(u => u.username === username)
  return !!u && eq(password, u.password)
}

function sign(username) {
  const payload = `${username}|${Date.now() + MAXAGE * 1000}`
  const mac = crypto.createHmac('sha256', cfg.sessionSecret).update(payload).digest('hex')
  return Buffer.from(`${payload}|${mac}`).toString('base64')
}

function verify(token) {
  try {
    const raw = Buffer.from(token, 'base64').toString()
    const i = raw.lastIndexOf('|')
    const payload = raw.slice(0, i), mac = raw.slice(i + 1)
    const expect = crypto.createHmac('sha256', cfg.sessionSecret).update(payload).digest('hex')
    if (!eq(mac, expect)) return null
    const [username, exp] = payload.split('|')
    if (Date.now() > Number(exp)) return null
    return { username }
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

// ── user management (persists to config.json, live — no restart needed) ──
const save = () => fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2))
const listUsers = () => cfg.users.map(u => ({ username: u.username, role: u.role === 'admin' ? 'admin' : 'user' }))
const isAdmin = username => { const u = cfg.users.find(x => x.username === username); return !!u && u.role === 'admin' }
const adminCount = () => cfg.users.filter(u => u.role === 'admin').length

function addUser(username, password, role) {
  username = String(username || '').trim()
  if (!username || !password) throw new Error('Username and password are both required.')
  if (cfg.users.some(u => u.username === username)) throw new Error('That username already exists.')
  cfg.users.push({ username, password: String(password), role: role === 'admin' ? 'admin' : 'user' }); save()
}

function updateUser(username, patch = {}) {
  const u = cfg.users.find(x => x.username === username)
  if (!u) throw new Error('User not found.')
  const nn = patch.newUsername != null ? String(patch.newUsername).trim() : null
  if (nn) {
    if (nn !== username && cfg.users.some(x => x.username === nn)) throw new Error('That username already exists.')
    u.username = nn
  }
  if (patch.password) u.password = String(patch.password)
  if (patch.role != null) {
    const nr = patch.role === 'admin' ? 'admin' : 'user'
    if (u.role === 'admin' && nr !== 'admin' && adminCount() <= 1) throw new Error('At least one admin is required.')
    u.role = nr
  }
  save()
}

function deleteUser(username) {
  if (cfg.users.length <= 1) throw new Error('Cannot delete the only account — you would be locked out.')
  const u = cfg.users.find(x => x.username === username)
  if (!u) throw new Error('User not found.')
  if (u.role === 'admin' && adminCount() <= 1) throw new Error('Cannot delete the only admin.')
  cfg.users = cfg.users.filter(x => x.username !== username); save()
}

module.exports = { check, sign, currentUser, MAXAGE, listUsers, isAdmin, addUser, updateUser, deleteUser }
