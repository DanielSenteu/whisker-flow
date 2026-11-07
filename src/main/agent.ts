// The browser agent: Gemini decides one action at a time, Puppeteer carries it out in a real, visible Chrome window.
// Self-contained on purpose (no Electron imports) so it can also be run from a plain Node script for testing.
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export interface AgentEvents {
  step(narration: string): void // a short line the pet says while it works
  done(answer: string): void // the result, spoken by the pet
  ask(message: string): void // the agent needs the human (login, captcha, a decision)
  error(message: string): void
}

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const MAX_STEPS = 14
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let browser: Browser | null = null
let page: Page | null = null
let cancelled = false

async function ensurePage(): Promise<Page> {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: false,
      defaultViewport: null,
      userDataDir: mkdtempSync(join(tmpdir(), 'wf-chrome-')), // a clean profile: no logins, no history
      args: ['--window-size=1180,800', '--window-position=60,50', '--no-first-run', '--no-default-browser-check']
    })
    page = null
  }
  if (!page || page.isClosed()) {
    const pages = await browser.pages()
    page = pages[0] ?? (await browser.newPage())
  }
  return page
}

export async function closeBrowser(): Promise<void> {
  try {
    await browser?.close()
  } catch {
    /* already gone */
  }
  browser = null
  page = null
}

export function stopTask(): void {
  cancelled = true
}

// ---------------------------------------------------------------- what the model sees
interface Observation {
  url: string
  title: string
  text: string
  elements: string[]
}

async function observe(p: Page): Promise<Observation> {
  const o = await p.evaluate(() => {
    document.querySelectorAll('[data-wf]').forEach((e) => e.removeAttribute('data-wf'))
    document.querySelectorAll('a[target]').forEach((a) => a.removeAttribute('target')) // keep everything in one tab
    const sel = 'a,button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem]'
    const els: string[] = []
    let n = 0
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect()
      const st = getComputedStyle(el)
      if (r.width < 4 || r.height < 4 || st.visibility === 'hidden' || st.display === 'none') continue
      if (r.bottom < 0 || r.top > innerHeight * 1.6) continue
      const inp = el as HTMLInputElement
      const label = (el.innerText || inp.value || inp.placeholder || el.getAttribute('aria-label') || el.title || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 80)
      if (!label && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') continue
      el.setAttribute('data-wf', String(++n))
      const href = (el as HTMLAnchorElement).href
      els.push(`[${n}] ${el.tagName.toLowerCase()}${inp.type ? `(${inp.type})` : ''} ${label}${href ? ` -> ${href.slice(0, 90)}` : ''}`)
      if (n >= 70) break
    }
    return {
      title: document.title,
      text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 2600),
      els
    }
  })
  return { url: p.url(), title: o.title, text: o.text, elements: o.els }
}

async function settle(p: Page): Promise<void> {
  await Promise.race([p.waitForNetworkIdle({ idleTime: 600, timeout: 4500 }).catch(() => undefined), sleep(4500)])
  await sleep(250)
}

// ---------------------------------------------------------------- the tools the model can call
const narration = { type: 'STRING', description: 'What you are doing, said out loud by the pet: first person, max 8 words, cheerful, plain words only.' }
const DECLARATIONS = [
  {
    name: 'navigate',
    description: 'Open a URL in the browser.',
    parameters: { type: 'OBJECT', properties: { url: { type: 'STRING' }, narration }, required: ['url', 'narration'] }
  },
  {
    name: 'click',
    description: 'Click an element by its number from the page element list.',
    parameters: { type: 'OBJECT', properties: { id: { type: 'INTEGER' }, narration }, required: ['id', 'narration'] }
  },
  {
    name: 'type_text',
    description: 'Type text into an input by its number (clears it first). Set press_enter to submit.',
    parameters: {
      type: 'OBJECT',
      properties: { id: { type: 'INTEGER' }, text: { type: 'STRING' }, press_enter: { type: 'BOOLEAN' }, narration },
      required: ['id', 'text', 'narration']
    }
  },
  {
    name: 'scroll',
    description: 'Scroll the page up or down by about one screen.',
    parameters: { type: 'OBJECT', properties: { direction: { type: 'STRING', enum: ['up', 'down'] }, narration }, required: ['direction', 'narration'] }
  },
  { name: 'go_back', description: 'Go back to the previous page.', parameters: { type: 'OBJECT', properties: { narration }, required: ['narration'] } },
  {
    name: 'finish',
    description: 'The task is done (or as done as it can be). Give the answer the pet will say out loud.',
    parameters: {
      type: 'OBJECT',
      properties: { answer: { type: 'STRING', description: 'Spoken answer, under 30 words, plain words only.' } },
      required: ['answer']
    }
  },
  {
    name: 'ask_user',
    description: 'You are blocked and need the human: a login, a captcha, a payment, or a real decision. Say what you need.',
    parameters: { type: 'OBJECT', properties: { message: { type: 'STRING', description: 'Under 25 words, plain words only.' } }, required: ['message'] }
  }
]

function systemPrompt(petName: string, species: string): string {
  return (
    `You are ${petName}, a loving ${species} sidekick who drives a web browser for your human. ` +
    'You see the page as a text list of numbered clickable elements plus the visible text. Call exactly ONE tool per turn. ' +
    'Everything you say (narration, answer, message) is spoken aloud: plain words, no asterisks, no emojis, no stage directions. ' +
    'To search the web, navigate straight to https://duckduckgo.com/?q=<url-encoded query> (never Google). ' +
    'Prefer reading the visible text when the answer is already there instead of clicking around. ' +
    'Never log in, type passwords, enter payment details, buy anything, or solve captchas: call ask_user instead. ' +
    'Vary your narration like an excited pet and do not start every line with "I am": for example "Sniffing out ramen spots!", "Ooh, this one looks good!", "Let me peek at the reviews." ' +
    'Be efficient: aim to finish in 6 steps or fewer. If you are stuck after two different attempts, call finish with what you found or ask_user. ' +
    'Be accurate: only report facts you actually saw on a page.'
  )
}

const model = (): string => process.env.GEMINI_AGENT_MODEL || process.env.GEMINI_MODEL || 'gemini-3-flash-preview'

async function think(contents: unknown[], system: string): Promise<any> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY is not set')
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model()}:generateContent`, {
    method: 'POST',
    signal: AbortSignal.timeout(40000),
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: [{ functionDeclarations: DECLARATIONS }],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } }
    })
  })
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

async function act(name: string, a: any): Promise<Record<string, unknown>> {
  let p = await ensurePage()
  try {
    switch (name) {
      case 'navigate': {
        const url = /^https?:\/\//.test(a.url) ? a.url : `https://${a.url}`
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
        break
      }
      case 'click': {
        const h = await p.$(`[data-wf="${Number(a.id)}"]`)
        if (!h) return { ok: false, error: `No element ${a.id} on the page; use the latest list.` }
        await h.evaluate((e) => e.scrollIntoView({ block: 'center' }))
        await sleep(150)
        await h.click()
        break
      }
      case 'type_text': {
        const h = await p.$(`[data-wf="${Number(a.id)}"]`)
        if (!h) return { ok: false, error: `No element ${a.id} on the page; use the latest list.` }
        await h.evaluate((e) => {
          ;(e as HTMLElement).focus()
          if ('value' in e) (e as HTMLInputElement).value = ''
        })
        await h.type(String(a.text), { delay: 22 })
        if (a.press_enter) await p.keyboard.press('Enter')
        break
      }
      case 'scroll':
        await p.evaluate((d) => window.scrollBy(0, d * innerHeight * 0.8), a.direction === 'up' ? -1 : 1)
        await sleep(400)
        break
      case 'go_back':
        await p.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 })
        break
    }
    await settle(p)
    // a click can open a new tab: follow it
    const pages = await browser!.pages()
    if (pages[pages.length - 1] !== p) {
      p = pages[pages.length - 1]
      page = p
      await p.bringToFront()
      await settle(p)
    }
    return { ok: true, ...(await observe(p)) }
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200), ...(await observe(p).catch(() => ({}))) }
  }
}

/** Keep the history small: older page observations are replaced by a one-line note. */
function trim(contents: any[]): void {
  const resp = contents.filter((c) => c.role === 'user' && c.parts?.[0]?.functionResponse)
  for (const c of resp.slice(0, -2)) {
    const r = c.parts[0].functionResponse.response
    if (r?.text) {
      r.text = '(older page text omitted)'
      r.elements = []
    }
  }
}

export async function runTask(goal: string, petName: string, species: string, ev: AgentEvents): Promise<void> {
  cancelled = false
  try {
    await ensurePage()
    const system = systemPrompt(petName, species)
    const contents: any[] = [{ role: 'user', parts: [{ text: `Task from your human: ${goal}` }] }]
    for (let step = 0; step < MAX_STEPS; step++) {
      if (cancelled) return
      const resp = await think(contents, system)
      const content = resp?.candidates?.[0]?.content
      const call = content?.parts?.find((p: any) => p.functionCall)?.functionCall
      if (!call) {
        const text = content?.parts?.map((p: any) => p.text ?? '').join(' ').trim()
        ev.done(text || "I couldn't find that one.")
        return
      }
      contents.push(content) // keep the model turn exactly as returned (it carries its reasoning signatures)
      const a = call.args ?? {}
      if (call.name === 'finish') return ev.done(String(a.answer ?? 'All done!'))
      if (call.name === 'ask_user') return ev.ask(String(a.message ?? 'I need your help with this one.'))
      ev.step(String(a.narration ?? 'Working on it!'))
      const result = await act(call.name, a)
      if (cancelled) return
      contents.push({ role: 'user', parts: [{ functionResponse: { name: call.name, response: result } }] })
      trim(contents)
    }
    ev.done("I looked around but ran out of steps. Here's where I got to.")
  } catch (e) {
    ev.error((e as Error).message)
  }
}
