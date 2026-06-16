import { useEffect, useRef, useState } from 'react'

import {
  spotifyGetCurrent,
  spotifyLogin,
  spotifyLogout,
  spotifyStatus,
  type NowPlaying,
} from '../lib/spotify'
import { readScopedStorage, writeScopedStorage } from '../lib/storageNamespace'
import { useProjectsStore } from '../stores/projectsStore'

const POLL_MS = 8000
const LAST_TRACK_KEY = 'home.nowPlaying.last'

/** Lê a última faixa conhecida do storage (marcada como pausada). */
function loadLastTrack(): NowPlaying | null {
  try {
    const raw = readScopedStorage(LAST_TRACK_KEY, true)
    if (!raw) return null
    const parsed = JSON.parse(raw) as NowPlaying
    if (!parsed || typeof parsed.track !== 'string' || !parsed.track) return null
    return { ...parsed, playing: false }
  } catch {
    return null
  }
}

/** Persiste a faixa atual pra não perder o estado entre sessões. */
function saveLastTrack(np: NowPlaying): void {
  try {
    writeScopedStorage(LAST_TRACK_KEY, JSON.stringify(np))
  } catch {
    /* storage cheio/indisponível — ignora */
  }
}

export type NowPlayingState = {
  /** null = ainda checando status */
  connected: boolean | null
  /** null = não tocando ou desconectado */
  current: NowPlaying | null
  error: string | null
  loading: boolean
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  refresh: () => Promise<void>
}

/**
 * Hook que mantém o estado de "tocando agora" do Spotify.
 * - Polling a cada 8s enquanto `enabled === true` e conectado
 * - Pausa o polling quando `enabled` vira false (ex: Home não visível)
 */
export function useNowPlaying(enabled: boolean): NowPlayingState {
  const spotifyClientId = useProjectsStore((s) => s.preferences.spotifyClientId)
  const spotifyClientSecret = useProjectsStore((s) => s.preferences.spotifyClientSecret)
  const [connected, setConnected] = useState<boolean | null>(null)
  // hidrata com a última faixa conhecida pra Home nunca aparecer vazia
  const [current, setCurrent] = useState<NowPlaying | null>(() => loadLastTrack())
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const cancelledRef = useRef(false)
  const credentials = {
    clientId: spotifyClientId.trim() || undefined,
    clientSecret: spotifyClientSecret.trim() || undefined,
  }

  const fetchCurrent = async () => {
    try {
      const np = await spotifyGetCurrent(credentials)
      if (cancelledRef.current) return
      if (np) {
        setCurrent(np)
        saveLastTrack(np)
      } else {
        // nada tocando: mantém a última faixa, só marca como pausada
        setCurrent((prev) => (prev ? { ...prev, playing: false } : null))
      }
      setError(null)
    } catch (err) {
      if (cancelledRef.current) return
      setError(String(err))
    }
  }

  // checa status na primeira montagem
  useEffect(() => {
    cancelledRef.current = false
    spotifyStatus()
      .then((ok) => {
        if (cancelledRef.current) return
        setConnected(ok)
        if (ok) void fetchCurrent()
      })
      .catch(() => setConnected(false))
    return () => {
      cancelledRef.current = true
    }
  }, [])

  // polling
  useEffect(() => {
    if (!enabled || !connected) return
    void fetchCurrent()
    const id = setInterval(fetchCurrent, POLL_MS)
    return () => clearInterval(id)
  }, [enabled, connected])

  const connect = async () => {
    setLoading(true)
    setError(null)
    try {
      await spotifyLogin(credentials)
      setConnected(true)
      await fetchCurrent()
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  const disconnect = async () => {
    await spotifyLogout()
    setConnected(false)
    setCurrent(null)
  }

  return {
    connected,
    current,
    error,
    loading,
    connect,
    disconnect,
    refresh: fetchCurrent,
  }
}
