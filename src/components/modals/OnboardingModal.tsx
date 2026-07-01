import * as Dialog from '@radix-ui/react-dialog'
import { Check, GitBranch, Globe, Palette, Users } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import aletheLogo from '../../assets/alethe-logo.png'
import { LOCALES, useT } from '../../lib/i18n'
import { getProfileInitial } from '../../lib/profile'
import { THEME_OPTIONS, themeDescription, themeLabel } from '../../lib/themes'
import type { AgentType } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { AgentIcon } from '../icons/AgentIcons'
import { ImageInput } from './ImageInput'
import styles from './OnboardingModal.module.css'

const STEP_COUNT = 4

const AGENTS: { id: AgentType; label: string }[] = [
  { id: 'shell', label: 'Shell' },
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'freebuff', label: 'Freebuff' },
  { id: 'mimo', label: 'Mimo' },
]

export function OnboardingModal() {
  const t = useT()
  const preferences = useProjectsStore((s) => s.preferences)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const setLanguage = useProjectsStore((s) => s.setLanguage)
  const setAgentEnabled = useProjectsStore((s) => s.setAgentEnabled)
  const setUiTheme = useProjectsStore((s) => s.setUiTheme)
  const openModal = useUiStore((s) => s.openModal_)

  const [step, setStep] = useState(0)
  const [name, setName] = useState(preferences.displayName)
  const [photoUrl, setPhotoUrl] = useState(preferences.profileImageUrl)
  const [showPhoto, setShowPhoto] = useState(Boolean(preferences.profileImageUrl.trim()))
  const [imgFailed, setImgFailed] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)

  const enabledCount = Object.values(preferences.enabledAgents).filter(Boolean).length
  const trimmedName = name.trim()
  const trimmedPhotoUrl = photoUrl.trim()
  const initial = getProfileInitial(trimmedName)
  const progress = ((step + 1) / STEP_COUNT) * 100
  const isLast = step === STEP_COUNT - 1

  const stepMeta = useMemo(
    () => [
      {
        label: t('onboarding.profileStep'),
        hint: t('onboarding.profileStepHint'),
        icon: Globe,
      },
      {
        label: t('onboarding.themeStep'),
        hint: t('onboarding.themeStepHint'),
        icon: Palette,
      },
      {
        label: t('onboarding.agentsStep'),
        hint: t('onboarding.agentsStepHint'),
        icon: Users,
      },
      {
        label: t('onboarding.gitStep'),
        hint: t('onboarding.gitStepHint'),
        icon: GitBranch,
      },
    ],
    [t],
  )

  useEffect(() => {
    if (preferences.onboardingDone) return
    setStep(0)
    setName(preferences.displayName)
    setPhotoUrl(preferences.profileImageUrl)
    setShowPhoto(Boolean(preferences.profileImageUrl.trim()))
    setImgFailed(false)
  }, [preferences.displayName, preferences.onboardingDone, preferences.profileImageUrl])

  useEffect(() => {
    const node = contentRef.current?.querySelector<HTMLElement>('[data-autofocus]')
    node?.focus()
  }, [step])

  if (preferences.onboardingDone) return null

  const canProceed = step === 0 ? trimmedName.length > 0 : step === 2 ? enabledCount > 0 : true

  const finish = () => {
    if (!canProceed || enabledCount === 0 || trimmedName.length === 0) return
    setPreferences({
      accountCreated: true,
      onboardingDone: true,
      displayName: trimmedName,
      profileImageUrl: trimmedPhotoUrl,
    })
    window.setTimeout(() => {
      openModal('newProject')
    }, 0)
  }

  const next = () => {
    if (!canProceed) return
    if (isLast) finish()
    else setStep((value) => value + 1)
  }

  const back = () => {
    setStep((value) => Math.max(0, value - 1))
  }

  return (
    <Dialog.Root open onOpenChange={() => undefined}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          ref={contentRef}
          className={styles.content}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            const node = contentRef.current?.querySelector<HTMLElement>('[data-autofocus]')
            node?.focus()
          }}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <div className={styles.shell}>
            <aside className={styles.side}>
              <div>
                <div className={styles.brand}>
                  <img className={styles.brandLogo} src={aletheLogo} alt="Alethe" draggable={false} />
                </div>
                <div className={styles.eyebrow}>{t('onboarding.kicker')}</div>
                <h1 className={styles.headline}>{t('onboarding.title')}</h1>
                <p className={styles.subcopy}>{t('onboarding.subtitle')}</p>
              </div>

              <div className={styles.stepList}>
                {stepMeta.map((item, index) => {
                  const Icon = item.icon
                  const active = index === step
                  const done = index < step
                  return (
                    <div
                      key={item.label}
                      className={[
                        styles.stepItem,
                        active ? styles.stepItemActive : '',
                        done ? styles.stepItemDone : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <div className={styles.stepBadge}>
                        {done ? <Check size={12} /> : <Icon size={12} />}
                      </div>
                      <div className={styles.stepMeta}>
                        <div className={styles.stepName}>{item.label}</div>
                        <div className={styles.stepHint}>{item.hint}</div>
                      </div>
                    </div>
                  )
                })}
              </div>

              <p className={styles.localNote}>{t('onboarding.localNote')}</p>
            </aside>

            <section className={styles.main}>
              <header className={styles.mainHeader}>
                <div className={styles.progressMeta}>
                  <div className={styles.progressLabel}>{t('onboarding.progressLabel')}</div>
                  <div className={styles.progressStep}>
                    {t('onboarding.step', { current: step + 1, total: STEP_COUNT })}
                  </div>
                </div>
                <div className={styles.progressBar} aria-hidden>
                  <div className={styles.progressFill} style={{ width: `${progress}%` }} />
                </div>
              </header>

              <div className={styles.stage}>
                <div key={step} className={styles.panel}>
                  {step === 0 ? (
                    <>
                      <div className={styles.sectionIntro}>
                        <h2 className={styles.sectionTitle}>{t('onboarding.profileTitle')}</h2>
                        <p className={styles.sectionSubtitle}>{t('onboarding.profileSubtitle')}</p>
                      </div>

                      <div className={styles.profileGrid}>
                        <div className={styles.previewCard}>
                          <div className={styles.avatarShell}>
                            <div className={styles.avatarFrame}>
                              {trimmedPhotoUrl && !imgFailed ? (
                                <img
                                  className={styles.avatarImg}
                                  src={trimmedPhotoUrl}
                                  alt=""
                                  draggable={false}
                                  onError={() => setImgFailed(true)}
                                  onLoad={() => setImgFailed(false)}
                                />
                              ) : (
                                <div className={styles.avatarInitial}>{initial}</div>
                              )}
                            </div>
                          </div>

                          <div className={styles.previewText}>
                            <div className={styles.previewName}>{trimmedName || t('onboarding.namePlaceholder')}</div>
                            <div className={styles.previewHint}>{t('onboarding.profilePreviewHint')}</div>
                          </div>
                        </div>

                        <div className={styles.formCard}>
                          <div className={styles.field}>
                            <div className={styles.fieldLabel}>
                              <Globe size={12} style={{ verticalAlign: '-2px' }} /> {t('language.title')}
                            </div>
                            <div className={styles.languageGrid}>
                              {LOCALES.map((locale) => {
                                const active = preferences.language === locale.id
                                return (
                                  <button
                                    key={locale.id}
                                    type="button"
                                    className={[
                                      styles.languageCard,
                                      active ? styles.languageCardActive : '',
                                    ]
                                      .filter(Boolean)
                                      .join(' ')}
                                    onClick={() => setLanguage(locale.id)}
                                  >
                                    <span className={styles.languageCardBody}>
                                      <span className={styles.languageCardTitle}>{locale.nativeName}</span>
                                      <span className={styles.languageCardMeta}>
                                        {locale.id === 'en'
                                          ? t('onboarding.languageEnglishHint')
                                          : t('onboarding.languagePortugueseHint')}
                                      </span>
                                    </span>
                                    {active ? <Check size={16} className={styles.checkMark} /> : null}
                                  </button>
                                )
                              })}
                            </div>
                          </div>

                          <div className={styles.field}>
                            <label className={styles.fieldLabel} htmlFor="onboarding-name">
                              {t('onboarding.name')}
                            </label>
                            <input
                              id="onboarding-name"
                              data-autofocus
                              className={styles.input}
                              value={name}
                              onChange={(event) => setName(event.target.value)}
                              placeholder={t('onboarding.namePlaceholder')}
                              maxLength={60}
                            />
                            <div className={styles.inputHint}>{t('onboarding.nameHint')}</div>
                          </div>

                          <div className={styles.field}>
                            <div className={styles.toggleRow}>
                              <div className={styles.fieldLabel}>{t('onboarding.photoTitle')}</div>
                              <button
                                type="button"
                                className={styles.toggleButton}
                                onClick={() => setShowPhoto((value) => !value)}
                              >
                                {showPhoto ? t('onboarding.photoHide') : t('onboarding.photoShow')}
                              </button>
                            </div>
                            <div className={styles.inputHint}>{t('onboarding.photoHint')}</div>
                            {showPhoto ? (
                              <ImageInput
                                label={t('prefs.photoPlaceholder')}
                                value={photoUrl}
                                onChange={(value) => {
                                  setPhotoUrl(value)
                                  setImgFailed(false)
                                }}
                                placeholder="https://..."
                                hint={t('image.urlOrUpload')}
                              />
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </>
                  ) : null}

                  {step === 1 ? (
                    <>
                      <div className={styles.sectionIntro}>
                        <h2 className={styles.sectionTitle}>{t('onboarding.themeTitle')}</h2>
                        <p className={styles.sectionSubtitle}>{t('onboarding.themeSubtitle')}</p>
                      </div>

                      <div className={styles.themeGrid}>
                        {THEME_OPTIONS.map((theme) => {
                          const active = preferences.uiTheme === theme.id
                          const [bg, accent, highlight] = theme.colors
                          return (
                            <button
                              key={theme.id}
                              type="button"
                              className={[
                                styles.themeOption,
                                active ? styles.themeOptionActive : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                              onClick={() => setUiTheme(theme.id)}
                              data-autofocus={active ? 'true' : undefined}
                            >
                              <div className={styles.themeSwatches}>
                                <span style={{ background: bg }} />
                                <span style={{ background: accent }} />
                                <span style={{ background: highlight }} />
                              </div>
                              <div className={styles.themeOptionBody}>
                                <div className={styles.themeOptionTitle}>
                                  <span>{themeLabel(t, theme.id)}</span>
                                  {active ? <Check size={15} className={styles.checkMark} /> : null}
                                </div>
                                <div className={styles.themeOptionDesc}>{themeDescription(t, theme.id)}</div>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </>
                  ) : null}

                  {step === 2 ? (
                    <>
                      <div className={styles.sectionIntro}>
                        <h2 className={styles.sectionTitle}>{t('onboarding.agentsTitle')}</h2>
                        <p className={styles.sectionSubtitle}>{t('onboarding.agentsSubtitle')}</p>
                      </div>

                      <div className={styles.agentSummary}>
                        <span>{t('onboarding.agentsCount', { count: enabledCount })}</span>
                        <span>{t('onboarding.agentsCountHint')}</span>
                      </div>

                      <div className={styles.agentGrid}>
                        {AGENTS.map((agent) => {
                          const active = preferences.enabledAgents[agent.id]
                          const lockSingle = active && enabledCount === 1
                          return (
                            <button
                              key={agent.id}
                              type="button"
                              disabled={lockSingle}
                              className={[
                                styles.agentOption,
                                active ? styles.agentOptionActive : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                              onClick={() => setAgentEnabled(agent.id, !active)}
                              data-autofocus={active ? 'true' : undefined}
                            >
                              <div className={styles.agentIconWrap}>
                                <AgentIcon type={agent.id} size={20} theme={preferences.terminalTheme ?? preferences.uiTheme} />
                              </div>
                              <div className={styles.agentOptionBody}>
                                <div className={styles.agentNameRow}>
                                  <span className={styles.agentName}>{agent.label}</span>
                                  {active ? <Check size={15} className={styles.checkMark} /> : null}
                                </div>
                                <div className={styles.agentDesc}>{t(`agent.${agent.id}.desc`)}</div>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </>
                  ) : null}

                  {step === 3 ? (
                    <>
                      <div className={styles.sectionIntro}>
                        <h2 className={styles.sectionTitle}>{t('onboarding.gitTitle')}</h2>
                        <p className={styles.sectionSubtitle}>{t('onboarding.gitSubtitle')}</p>
                      </div>
                      <div className={styles.agentGrid}>
                        {[true, false].map((enabled) => {
                          const active = preferences.showGitControl === enabled
                          return (
                            <button
                              key={String(enabled)}
                              type="button"
                              className={[styles.agentOption, active ? styles.agentOptionActive : '']
                                .filter(Boolean)
                                .join(' ')}
                              onClick={() => setPreferences({ showGitControl: enabled })}
                              data-autofocus={active ? 'true' : undefined}
                            >
                              <div className={styles.agentIconWrap}><GitBranch size={20} /></div>
                              <div className={styles.agentOptionBody}>
                                <div className={styles.agentNameRow}>
                                  <span className={styles.agentName}>
                                    {enabled ? t('onboarding.gitEnable') : t('onboarding.gitDisable')}
                                  </span>
                                  {active ? <Check size={15} className={styles.checkMark} /> : null}
                                </div>
                                <div className={styles.agentDesc}>
                                  {enabled ? t('onboarding.gitEnableDesc') : t('onboarding.gitDisableDesc')}
                                </div>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </>
                  ) : null}
                </div>
              </div>

              <footer className={styles.footer}>
                <div className={styles.footerLeft}>{t('onboarding.footerNote')}</div>
                <div className={styles.footerActions}>
                  {step > 0 ? (
                    <button type="button" className={`${styles.button} ${styles.buttonSecondary}`} onClick={back}>
                      {t('common.back')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={`${styles.button} ${styles.buttonPrimary}`}
                    onClick={next}
                    disabled={!canProceed}
                  >
                    {isLast ? t('onboarding.finish') : t('common.next')}
                  </button>
                </div>
              </footer>
            </section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
