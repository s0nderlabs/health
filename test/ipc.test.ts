import { describe, expect, test, afterEach } from 'bun:test'
import { IpcServer, IpcClient, type EventMsg } from '../src/ipc.js'
import type { HealthEvent } from '../src/types.js'
import { join } from 'path'
import { tmpdir } from 'os'

function sockPath(): string {
  return join(tmpdir(), `health-ipc-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`)
}

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
})

function makeServer(path: string) {
  const acked: number[] = []
  const connects: number[] = []
  const disconnects: number[] = []
  const server = new IpcServer(path, {
    onAck: (id) => acked.push(id),
    onSubscriberConnected: (sessionId) => connects.push(sessionId),
    onSubscriberDisconnected: (sessionId) => disconnects.push(sessionId),
    onRpc: async (method, params) => {
      if (method === 'echo') return { echoed: params }
      if (method === 'big') return { blob: 'x'.repeat(Number(params.size ?? 0)) }
      throw new Error(`no such method ${method}`)
    },
  })
  server.start()
  cleanup.push(() => server.stop())
  return { server, acked, connects, disconnects }
}

function makeClient(path: string, session: string, wantEvents = true) {
  const received: EventMsg[] = []
  const client = new IpcClient(
    path,
    session,
    async (e) => {
      received.push(e)
    },
    () => {},
    wantEvents,
  )
  cleanup.push(() => client.stop())
  return { client, received }
}

function evt(id: number): HealthEvent & { id: number } {
  return {
    id, class: 'workout.card', priority: 'info', dedupe_key: `k${id}`,
    content: `event ${id}`, meta: {}, created_at: new Date().toISOString(),
  }
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition')
    await Bun.sleep(20)
  }
}

describe('ipc server/client', () => {
  test('events reach a subscribed session and get acked', async () => {
    const path = sockPath()
    const { server, acked } = makeServer(path)
    const { client, received } = makeClient(path, 'main')
    await client.connectLoop()
    await waitFor(() => server.hasSubscriber())

    const pushedTo = server.pushEvent(evt(42))
    expect(pushedTo.length).toBe(1)
    await waitFor(() => received.length === 1 && acked.length === 1)
    expect(received[0].content).toContain('event 42')
    expect(acked[0]).toBe(42)
    expect(client.eventsEnabled).toBe(true) // hello_ok arrived with events: true
  })

  test('events broadcast to every SUBSCRIBED session; RPC works everywhere', async () => {
    const path = sockPath()
    const { server } = makeServer(path)
    const a = makeClient(path, 'main')
    const b = makeClient(path, 'second')
    await a.client.connectLoop()
    await b.client.connectLoop()
    await waitFor(() => server.subscriberCount() === 2)

    const pushedTo = server.pushEvent(evt(1))
    expect(pushedTo.length).toBe(2)
    await waitFor(() => a.received.length === 1 && b.received.length === 1)

    const result = await b.client.rpc<{ echoed: Record<string, unknown> }>('echo', { a: 1 })
    expect(result.echoed).toEqual({ a: 1 })
  })

  test('a channel-less session (events: false) gets RPC but NEVER events', async () => {
    const path = sockPath()
    const { server, connects } = makeServer(path)
    const toolsOnly = makeClient(path, 'plain-session', false)
    await toolsOnly.client.connectLoop()
    await Bun.sleep(150)

    expect(server.hasSubscriber()).toBe(false) // no EVENT subscriber
    expect(connects.length).toBe(0) // onSubscriberConnected must not fire
    const pushedTo = server.pushEvent(evt(5))
    expect(pushedTo.length).toBe(0)
    expect(toolsOnly.received.length).toBe(0)
    expect(toolsOnly.client.eventsEnabled).toBe(false)

    const result = await toolsOnly.client.rpc<{ echoed: Record<string, unknown> }>('echo', { x: 2 })
    expect(result.echoed).toEqual({ x: 2 })
  })

  test('exclusions target pushes: latecomer gets its copy, earlier recipient is skipped', async () => {
    const path = sockPath()
    const { server, connects } = makeServer(path)
    const a = makeClient(path, 'first')
    await a.client.connectLoop()
    await waitFor(() => server.subscriberCount() === 1)
    const aId = connects[0]

    const first = server.pushEvent(evt(7))
    expect(first).toEqual([aId])

    const b = makeClient(path, 'second')
    await b.client.connectLoop()
    await waitFor(() => server.subscriberCount() === 2)

    // re-push excluding a's session id: only b receives
    const second = server.pushEvent(evt(7), new Set(first))
    expect(second.length).toBe(1)
    expect(second[0]).not.toBe(aId)
    await waitFor(() => b.received.length === 1)
    expect(a.received.length).toBe(1) // still just its original copy
  })

  test('subscriber ids flow through connect/disconnect callbacks', async () => {
    const path = sockPath()
    const { server, connects, disconnects } = makeServer(path)
    const a = makeClient(path, 'main')
    const b = makeClient(path, 'second')
    await a.client.connectLoop()
    await b.client.connectLoop()
    await waitFor(() => connects.length === 2)

    b.client.stop()
    await waitFor(() => disconnects.length === 1)
    expect(connects).toContain(disconnects[0])
    expect(server.subscriberCount()).toBe(1)

    a.client.stop()
    await waitFor(() => disconnects.length === 2)
    expect(server.subscriberCount()).toBe(0)
  })

  test('rpc errors propagate as rejections', async () => {
    const path = sockPath()
    makeServer(path)
    const { client } = makeClient(path, 'main')
    await client.connectLoop()
    await expect(client.rpc('does_not_exist')).rejects.toThrow('no such method')
  })

  test('a multi-MB frame round-trips intact (backpressure, no truncation)', async () => {
    const path = sockPath()
    makeServer(path)
    const { client } = makeClient(path, 'main')
    await client.connectLoop()
    // ~4MB payload: far exceeds any single socket buffer, forcing partial writes.
    const size = 4_000_000
    const result = await client.rpc<{ blob: string }>('big', { size }, 20_000)
    expect(result.blob.length).toBe(size)
    expect(result.blob).toBe('x'.repeat(size))
  })

  test('client reconnects after server restart and events resume', async () => {
    const path = sockPath()
    const first = makeServer(path)
    const { client, received } = makeClient(path, 'main')
    await client.connectLoop()
    await waitFor(() => first.server.hasSubscriber())

    first.server.stop()
    await Bun.sleep(100)

    const second = makeServer(path)
    await waitFor(() => second.server.hasSubscriber(), 5000)
    second.server.pushEvent(evt(9))
    await waitFor(() => received.length === 1)
    expect(received[0].id).toBe(9)
  })
})
