#!/usr/bin/env node
/**
 * Generates the GitHub streak / contribution stats SVGs for the profile README.
 *
 * Self-hosted on purpose: every public streak-stats service this README used to
 * point at is either rate-limited or has had its free deployment disabled, which
 * is what left the README with broken images. This runs inside Actions with the
 * repo's own GITHUB_TOKEN, so there is nothing external left to go down.
 *
 * Usage: GITHUB_TOKEN=... node scripts/gen-stats.mjs [login] [outDir]
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const LOGIN = process.argv[2] || process.env.GITHUB_USER || 'Luqidrari'
const OUT_DIR = process.argv[3] || 'assets'
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN

if (!TOKEN) {
  console.error('Missing GITHUB_TOKEN')
  process.exit(1)
}

async function graphql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `bearer ${TOKEN}`,
      'content-type': 'application/json',
      'user-agent': 'profile-stats-generator',
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`)
  const body = await res.json()
  if (body.errors) throw new Error(JSON.stringify(body.errors))
  return body.data
}

const YEARS_QUERY = `
  query ($login: String!) {
    user(login: $login) {
      createdAt
      contributionsCollection { contributionYears }
    }
  }
`

const CALENDAR_QUERY = `
  query ($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          weeks { contributionDays { date contributionCount } }
        }
      }
    }
  }
`

/** All contribution days, oldest first, deduplicated across year windows. */
async function fetchDays(login) {
  const { user } = await graphql(YEARS_QUERY, { login })
  const years = user.contributionsCollection.contributionYears
  const byDate = new Map()

  for (const year of [...years].sort()) {
    const from = `${year}-01-01T00:00:00Z`
    const to = `${year}-12-31T23:59:59Z`
    const data = await graphql(CALENDAR_QUERY, { login, from, to })
    for (const week of data.user.contributionsCollection.contributionCalendar.weeks)
      for (const day of week.contributionDays) byDate.set(day.date, day.contributionCount)
  }

  return {
    createdAt: user.createdAt,
    days: [...byDate.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
  }
}

const todayISO = () => new Date().toISOString().slice(0, 10)

function computeStats(days) {
  const today = todayISO()
  // Future days are padded into the calendar by GitHub; they would break streaks.
  const past = days.filter((d) => d.date <= today)

  const total = past.reduce((sum, d) => sum + d.count, 0)

  let longest = { length: 0, start: null, end: null }
  let run = { length: 0, start: null, end: null }
  for (const day of past) {
    if (day.count > 0) {
      run = { length: run.length + 1, start: run.length ? run.start : day.date, end: day.date }
      if (run.length > longest.length) longest = { ...run }
    } else {
      run = { length: 0, start: null, end: null }
    }
  }

  // The current streak survives a still-empty today — the day is not over yet.
  let current = { length: 0, start: null, end: null }
  for (let i = past.length - 1; i >= 0; i--) {
    const day = past[i]
    if (day.count === 0) {
      if (i === past.length - 1) continue
      break
    }
    current = { length: current.length + 1, start: day.date, end: current.end || day.date }
  }

  const firstContribution = past.find((d) => d.count > 0)?.date || past[0]?.date || today
  return { total, longest, current, firstContribution, today }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function fmt(iso, withYear = true) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  const base = `${MONTHS[Number(m) - 1]} ${Number(d)}`
  return withYear ? `${base}, ${y}` : base
}

function fmtRange(start, end) {
  if (!start) return '—'
  const sameYear = start.slice(0, 4) === end.slice(0, 4)
  if (start === end) return fmt(start)
  return `${fmt(start, !sameYear)} - ${fmt(end)}`
}

const THEMES = {
  light: {
    stroke: '#e4e2e2',
    ring: '#fb8c00',
    fire: '#fb8c00',
    currStreakNum: '#151515',
    currStreakLabel: '#fb8c00',
    sideNums: '#151515',
    sideLabels: '#464646',
    dates: '#464646',
  },
  dark: {
    stroke: '#30363d',
    ring: '#fb8c00',
    fire: '#fb8c00',
    currStreakNum: '#e6edf3',
    currStreakLabel: '#fb8c00',
    sideNums: '#e6edf3',
    sideLabels: '#8b949e',
    dates: '#8b949e',
  },
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function renderSVG(stats, theme) {
  const c = THEMES[theme]
  const font = `'Segoe UI', Ubuntu, sans-serif`

  // Base state is fully visible and the animation only plays *into* it, so the
  // SVG still renders correctly wherever SMIL is stripped (e.g. image proxies).
  const panel = (x, num, label, range, delay) => `
    <g transform="translate(${x}, 48)">
      <animate attributeName="opacity" from="0" to="1" dur="0.5s" begin="${delay}s" fill="freeze"/>
      <text x="0" y="0" text-anchor="middle" fill="${c.sideNums}" font-family="${font}" font-weight="700" font-size="28">${esc(num)}</text>
      <text x="0" y="28" text-anchor="middle" fill="${c.sideLabels}" font-family="${font}" font-weight="500" font-size="14">${esc(label)}</text>
      <text x="0" y="52" text-anchor="middle" fill="${c.dates}" font-family="${font}" font-weight="400" font-size="12">${esc(range)}</text>
    </g>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="495" height="195" viewBox="0 0 495 195" role="img" aria-label="GitHub contribution streak for ${esc(LOGIN)}">
  <title>${esc(LOGIN)} — ${stats.total} contributions, ${stats.current.length} day current streak, ${stats.longest.length} day longest streak</title>
  <rect width="495" height="195" rx="6" fill="none"/>
  <line x1="165" y1="35" x2="165" y2="160" stroke="${c.stroke}" stroke-width="1"/>
  <line x1="330" y1="35" x2="330" y2="160" stroke="${c.stroke}" stroke-width="1"/>
${panel(82.5, stats.total.toLocaleString('en-US'), 'Total Contributions', fmtRange(stats.firstContribution, stats.today), 0.1)}
${panel(412.5, stats.longest.length, 'Longest Streak', fmtRange(stats.longest.start, stats.longest.end), 0.3)}

  <g transform="translate(247.5, 0)">
    <animate attributeName="opacity" from="0" to="1" dur="0.5s" begin="0.2s" fill="freeze"/>
    <circle cx="0" cy="68" r="40" fill="none" stroke="${c.ring}" stroke-width="5"/>
    <text x="0" y="78" text-anchor="middle" fill="${c.currStreakNum}" font-family="${font}" font-weight="700" font-size="28">${stats.current.length}</text>
    <text x="0" y="135" text-anchor="middle" fill="${c.currStreakLabel}" font-family="${font}" font-weight="700" font-size="14">Current Streak</text>
    <text x="0" y="156" text-anchor="middle" fill="${c.dates}" font-family="${font}" font-weight="400" font-size="12">${esc(fmtRange(stats.current.start, stats.current.end))}</text>
    <g transform="translate(0, 28) scale(0.5)" fill="${c.fire}">
      <path d="M -12 -0.5 C -12 -8 -6 -12 -6 -18 C -6 -22 -3 -26 0 -28 C 0 -22 4 -19 7 -15 C 10 -11 12 -6 12 -0.5 C 12 6 5 12 0 12 C -5 12 -12 6 -12 -0.5 Z"/>
    </g>
  </g>
</svg>
`
}

const GRAPH_THEMES = {
  light: { line: '#e05d44', area: '#e05d44', grid: '#e4e2e2', text: '#464646', title: '#151515' },
  dark: { line: '#f97316', area: '#f97316', grid: '#30363d', text: '#8b949e', title: '#e6edf3' },
}

/** Catmull-Rom through the points, emitted as cubic beziers, so the line reads smooth. */
function smoothPath(pts) {
  if (pts.length < 2) return ''
  let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] || p2
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += ` C ${c1[0].toFixed(2)} ${c1[1].toFixed(2)}, ${c2[0].toFixed(2)} ${c2[1].toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`
  }
  return d
}

function renderActivityGraph(days, theme) {
  const c = GRAPH_THEMES[theme]
  const font = `'Segoe UI', Ubuntu, sans-serif`
  const W = 840
  const H = 340
  const pad = { top: 66, right: 24, bottom: 44, left: 52 }
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom

  const today = todayISO()
  const window = days.filter((d) => d.date <= today).slice(-365)
  const max = Math.max(1, ...window.map((d) => d.count))
  const x = (i) => pad.left + (i / Math.max(1, window.length - 1)) * plotW
  const y = (v) => pad.top + plotH - (v / max) * plotH

  const pts = window.map((d, i) => [x(i), y(d.count)])
  const line = smoothPath(pts)
  const area = `${line} L ${x(window.length - 1).toFixed(2)} ${(pad.top + plotH).toFixed(2)} L ${pad.left.toFixed(2)} ${(pad.top + plotH).toFixed(2)} Z`

  const ticks = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i)
  const grid = ticks
    .map(
      (v) => `
    <line x1="${pad.left}" y1="${y(v).toFixed(2)}" x2="${(W - pad.right).toFixed(2)}" y2="${y(v).toFixed(2)}" stroke="${c.grid}" stroke-width="1"/>
    <text x="${pad.left - 10}" y="${(y(v) + 4).toFixed(2)}" text-anchor="end" fill="${c.text}" font-family="${font}" font-size="11">${v}</text>`
    )
    .join('')

  const months = window
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.date.endsWith('-01'))
    .map(
      ({ d, i }) =>
        `<text x="${x(i).toFixed(2)}" y="${H - pad.bottom + 22}" text-anchor="middle" fill="${c.text}" font-family="${font}" font-size="11">${MONTHS[Number(d.date.slice(5, 7)) - 1]}</text>`
    )
    .join('')

  const total = window.reduce((s, d) => s + d.count, 0)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Contribution activity graph for ${esc(LOGIN)}">
  <title>${esc(LOGIN)} — ${total} contributions in the last year</title>
  <defs>
    <linearGradient id="fill-${theme}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${c.area}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${c.area}" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="reveal-${theme}">
      <rect x="0" y="0" width="${W}" height="${H}">
        <animate attributeName="width" from="0" to="${W}" dur="1.4s" fill="freeze"/>
      </rect>
    </clipPath>
  </defs>
  <text x="${pad.left}" y="34" fill="${c.title}" font-family="${font}" font-weight="700" font-size="18">Contribution Graph</text>
  <text x="${pad.left}" y="52" fill="${c.text}" font-family="${font}" font-size="12">${total.toLocaleString('en-US')} contributions in the last year</text>
${grid}
  <g clip-path="url(#reveal-${theme})">
    <path d="${area}" fill="url(#fill-${theme})"/>
    <path d="${line}" fill="none" stroke="${c.line}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  </g>
${months}
</svg>
`
}

const { days } = await fetchDays(LOGIN)
const stats = computeStats(days)

await mkdir(OUT_DIR, { recursive: true })
for (const theme of Object.keys(THEMES)) {
  await writeFile(join(OUT_DIR, `streak-${theme}.svg`), renderSVG(stats, theme))
  await writeFile(join(OUT_DIR, `activity-${theme}.svg`), renderActivityGraph(days, theme))
}

console.log(
  `${LOGIN}: ${stats.total} total, current ${stats.current.length}d, longest ${stats.longest.length}d ` +
    `(${fmtRange(stats.longest.start, stats.longest.end)})`
)
