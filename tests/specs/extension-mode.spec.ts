/**
 * Option-C tests: Playwright extension testing mode.
 *
 * These tests load the history module as a real Chrome extension with real Chrome APIs
 * (chrome.alarms, chrome.history, chrome.storage, IndexedDB). The test extension lives
 * in tests/extension/ and is built by tests/scripts/build-test-bundle.js.
 *
 * Playwright communicates with the extension's service worker via serviceWorker.evaluate().
 * The sw-entry.mts shim exposes __testSendMessage on globalThis so tests can route
 * messages without needing to open an extension page.
 *
 * All tests in this file share a single browser context launched in beforeAll.
 * This avoids repeated browser startup and the MV3 service-worker registration
 * race (where the SW fires before the per-test waitForEvent listener is attached).
 * Tests run serially so that stateful operations (injecting config, triggering
 * collection) compose cleanly without cross-test interference.
 *
 * IMPORTANT — headless mode:
 *   Chrome's CDP bridge does not expose extension service workers when running in
 *   headless mode (headless: true). Tests use headless: false. On macOS/Windows a
 *   small window appears during the run; on Linux CI wrap in Xvfb.
 */

import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------------------------------------------------------------------------
// Helpers (evaluated inside the real service worker context)
// ---------------------------------------------------------------------------

/** Wait until setup() has written its initial status to chrome.storage. */
async function waitForSetupComplete(sw: Worker) {
  await sw.evaluate(async () => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      // chrome is available in the real extension service worker
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (globalThis as any).chrome.storage.local.get('webmunkHistoryStatus')
      if (result.webmunkHistoryStatus !== undefined) return
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('setup() did not write webmunkHistoryStatus within 10s')
  })
}

/** Inject config + identifier so the module will activate collection. */
async function injectConfigAndIdentifier(sw: Worker) {
  await sw.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (globalThis as any).chrome.storage.local.set({
      rexIdentifier: 'option-c-test-user',
      REXConfiguration: {
        history: {
          collection_interval_minutes: 60,
          lookback_days: 7,
          filter_lists: [],
          allow_lists: [],
          category_lists: [],
          domain_only_lists: [],
          generate_top_domains: false,
          top_domains_count: 50,
          top_domains_list_name: 'top-domains'
        }
      }
    })
  })
}

/** Wait until the module has reacted to the injected config (configSource → 'server'). */
async function waitForConfigLoaded(sw: Worker) {
  await sw.evaluate(async () => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (globalThis as any).chrome.storage.local.get('webmunkHistoryStatus')
      if (result.webmunkHistoryStatus?.configSource === 'server') return
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('configSource did not reach "server" within 5s')
  })
}

// ---------------------------------------------------------------------------
// Tests — one shared browser context for the entire describe block
// ---------------------------------------------------------------------------

test.describe('HistoryServiceWorkerModule — Option C (real extension)', () => {
  // Run tests in definition order so stateful operations (inject config, trigger
  // collection) compose correctly across the shared context.
  test.describe.configure({ mode: 'serial' })

  let context: BrowserContext
  let serviceWorker: Worker
  let userDataDir: string

  test.beforeAll(async () => {
    const extensionPath = path.join(__dirname, '../extension')
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-history-ext-'))

    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    })

    // Use an already-active worker when available; otherwise wait for the
    // 'serviceworker' event.  A single launchPersistentContext means the
    // race (SW registers before the listener is attached) only needs to be
    // handled once here rather than once per test.
    serviceWorker =
      context.serviceWorkers()[0] ??
      await context.waitForEvent('serviceworker', { timeout: 30_000 })

    // Ensure the module's initial setup() has completed before any test runs.
    await waitForSetupComplete(serviceWorker)
  })

  test.afterAll(async () => {
    await context?.close()
    if (userDataDir) {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  test('service worker starts and writes initial status to chrome.storage', async () => {
    const status = await serviceWorker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (globalThis as any).chrome.storage.local.get('webmunkHistoryStatus')
      return result.webmunkHistoryStatus
    })

    expect(status).toBeTruthy()
    expect(status.isCollecting).toBe(false)
  })

  test('without a config, configSource is "none"', async () => {
    const status = await serviceWorker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (globalThis as any).chrome.storage.local.get('webmunkHistoryStatus')
      return result.webmunkHistoryStatus
    })

    expect(status.configSource).toBe('none')
  })

  test('injecting config + identifier causes configSource to become "server"', async () => {
    await injectConfigAndIdentifier(serviceWorker)
    await waitForConfigLoaded(serviceWorker)

    const status = await serviceWorker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (globalThis as any).chrome.storage.local.get('webmunkHistoryStatus')
      return result.webmunkHistoryStatus
    })

    expect(status.configSource).toBe('server')
  })

  test('alarm is created in real chrome.alarms after config + identifier', async () => {
    // Config + identifier were injected by the previous test; calling again is
    // idempotent and ensures correctness if tests are run individually.
    await injectConfigAndIdentifier(serviceWorker)

    const alarm = await serviceWorker.evaluate(async () => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = await (globalThis as any).chrome.alarms.get('webmunk-history-collection')
        if (a) return a
        await new Promise((r) => setTimeout(r, 100))
      }
      return null
    })

    expect(alarm).toBeTruthy()
    expect(alarm.periodInMinutes).toBe(60)
  })

  test('getHistoryStatus message returns the module status', async () => {
    const response = await serviceWorker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (self as any).__testSendMessage({ messageType: 'getHistoryStatus' })
    })

    expect(response).toBeTruthy()
    expect(response.isCollecting).toBe(false)
  })

  test('triggerHistoryCollection runs and updates lastCollectionTime', async () => {
    // Config was injected in earlier tests; wait for the module to reflect it.
    await waitForConfigLoaded(serviceWorker)

    // Trigger a full collection cycle.
    // The fresh user-data dir has no browsing history, so itemsCollected stays the same,
    // but lastCollectionTime must be set to confirm the cycle ran.
    const result = await serviceWorker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (self as any).__testSendMessage({ messageType: 'triggerHistoryCollection' })
    })

    expect(result.success).toBe(true)

    const status = await serviceWorker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await (globalThis as any).chrome.storage.local.get('webmunkHistoryStatus')
      return r.webmunkHistoryStatus
    })

    expect(status.isCollecting).toBe(false)
    expect(typeof status.lastCollectionTime).toBe('number')
  })
})
