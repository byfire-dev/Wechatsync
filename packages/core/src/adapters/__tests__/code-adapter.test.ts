import { describe, expect, it, vi } from 'vitest'

import type { RuntimeInterface } from '../../runtime/interface'
import type { Article, AuthResult, PlatformMeta, SyncResult } from '../../types'
import { CodeAdapter } from '../code-adapter'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

class HeaderRuleTestAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'header-rule-test',
    name: 'Header rule test',
    icon: '',
    homepage: 'https://example.com',
    capabilities: ['article'],
  }

  async checkAuth(): Promise<AuthResult> {
    return { isAuthenticated: true }
  }

  async publish(_article: Article): Promise<SyncResult> {
    return this.createResult(true)
  }

  runWithRule<T>(label: string, operation: () => Promise<T>): Promise<T> {
    return this.withHeaderRules(
      [
        {
          urlFilter: `*://example.com/${label}*`,
          headers: { 'X-Test-Operation': label },
        },
      ],
      operation,
    )
  }
}

describe('CodeAdapter header rule ownership', () => {
  it('cleans only the rules owned by each concurrent invocation', async () => {
    let ruleNumber = 0
    const add = vi.fn(async () => `rule-${++ruleNumber}`)
    const remove = vi.fn(async () => {})
    const runtime = {
      type: 'extension',
      headerRules: { add, remove, clear: vi.fn(async () => {}) },
    } as unknown as RuntimeInterface
    const adapter = new HeaderRuleTestAdapter()
    await adapter.init(runtime)

    const firstEntered = deferred()
    const releaseFirst = deferred()
    const secondEntered = deferred()
    const releaseSecond = deferred()

    const first = adapter.runWithRule('first', async () => {
      firstEntered.resolve()
      await releaseFirst.promise
      return 'first'
    })
    await firstEntered.promise

    const second = adapter.runWithRule('second', async () => {
      secondEntered.resolve()
      await releaseSecond.promise
      return 'second'
    })
    await secondEntered.promise

    releaseFirst.resolve()
    await expect(first).resolves.toBe('first')
    expect(remove.mock.calls).toEqual([['rule-1']])

    releaseSecond.resolve()
    await expect(second).resolves.toBe('second')
    expect(remove.mock.calls).toEqual([['rule-1'], ['rule-2']])
  })
})
