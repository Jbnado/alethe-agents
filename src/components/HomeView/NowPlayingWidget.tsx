import { Music } from 'lucide-react'

import { useNowPlaying } from '../../hooks/useNowPlaying'
import { useT } from '../../lib/i18n'
import styles from './HomeView.module.css'

type Props = {
  /** Hint pro hook se a Home está visível (controla polling). */
  enabled: boolean
}

export function NowPlayingWidget({ enabled }: Props) {
  const t = useT()
  const { connected, current, loading, connect } = useNowPlaying(enabled)

  if (connected === null) return null // ainda checando

  if (!connected) {
    return (
      <button
        type="button"
        className={styles.nowPlayingConnect}
        onClick={() => void connect()}
        disabled={loading}
      >
        {loading ? t('widget.authorizing') : `▶ ${t('widget.connectSpotify')}`}
      </button>
    )
  }

  // sem faixa atual e sem histórico → nada a mostrar
  if (!current) return null

  return (
    <button
      type="button"
      className={styles.nowPlaying}
      aria-label={current.playing ? t('widget.nowPlaying') : t('widget.lastTrack')}
    >
      <div className={styles.nowPlayingCover}>
        {current.cover_url ? (
          <img
            src={current.cover_url}
            alt=""
            draggable={false}
            onError={(e) => {
              ;(e.currentTarget as HTMLImageElement).style.visibility = 'hidden'
            }}
          />
        ) : (
          <Music size={18} />
        )}
      </div>
      <div className={styles.nowPlayingInfo}>
        <div className={styles.nowPlayingTrack}>{current.track}</div>
        <div className={styles.nowPlayingArtistRow}>
          <span className={styles.nowPlayingArtist}>{current.artist}</span>
          {current.playing ? (
            <Equalizer />
          ) : (
            <span className={styles.nowPlayingIdle}>{t('widget.last')}</span>
          )}
        </div>
      </div>
    </button>
  )
}

function Equalizer() {
  const heights = [60, 100, 40, 80]
  return (
    <span className={styles.equalizer} aria-hidden="true">
      {heights.map((h, i) => (
        <span key={i} className={styles.eqBar} style={{ height: `${h}%` }} />
      ))}
    </span>
  )
}
