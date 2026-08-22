/**
 * 错题面板：三态分组（观察中 / 已晋级 / 已归档）+ 单条操作。
 *
 * 分组口径（方案「决策结论」）：存 4 态、显 3 组——观察中 = raw + distilled
 * （distilled 显示「可晋级」，raw 显示失败次数进度）；已晋级 = promoted；
 * 已归档 = archived。操作：观察中/已晋级组可归档；归档组可反悔、删除；
 * 仅 distilled 条目可一键晋级（保留 lesson-promote 同名冲突守卫）。
 *
 * 工作区：自由输入路径（宿主平面无单一当前会话；list 缺省返回默认工作区，
 * 输入具体路径可触达任意项目层错题——见交付说明「已知问题」）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ErrataLessonView, ErrataRemoteApi } from './api.js'
import { unwrap } from './api.js'

export type ErrataT = (key: string, params?: Record<string, unknown>) => string

/** 设置页 section owner 通过 inject 注入的能力。 */
export interface ErrataPanelProps {
  api: ErrataRemoteApi
  t: ErrataT
}

type Tab = 'watching' | 'promoted' | 'archived'

const TAB_ORDER: readonly Tab[] = ['watching', 'promoted', 'archived']

const styles: Record<string, React.CSSProperties> = {
  section: { width: '100%', maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 14, color: 'var(--dsw-alias-label-primary)' },
  toolbar: { display: 'flex', alignItems: 'center', gap: 12 },
  tabs: { display: 'flex', gap: 4, borderBottom: '1px solid var(--dsw-alias-border-l2)' },
  tab: { padding: '6px 14px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--dsw-alias-label-tertiary)', borderBottom: '2px solid transparent' },
  tabActive: { color: 'var(--dsw-alias-label-primary)', borderBottomColor: 'var(--dsw-alias-state-business-primary)' },
  input: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 8, padding: '4px 8px', fontSize: 12, color: 'var(--dsw-alias-label-primary)', font: 'inherit', width: 240 },
  list: { display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0, listStyle: 'none' },
  card: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 },
  cardHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  title: { margin: 0, fontSize: 13, fontWeight: 600 },
  badge: { fontSize: 11, padding: '1px 8px', borderRadius: 99, border: '1px solid var(--dsw-alias-border-l2)' },
  badgePromotable: { color: 'var(--dsw-alias-state-business-primary)', borderColor: 'currentColor' },
  meta: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
  actions: { display: 'flex', gap: 8, marginTop: 2 },
  button: { border: '1px solid var(--dsw-alias-border-l2)', background: 'none', color: 'var(--dsw-alias-label-primary)', borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer' },
  buttonPrimary: { color: 'var(--dsw-alias-state-business-primary)', borderColor: 'currentColor' },
  buttonDanger: { color: 'var(--dsw-alias-state-error-primary)', borderColor: 'currentColor' },
  buttonDisabled: { opacity: 0.45, cursor: 'not-allowed' },
  status: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
  notice: { fontSize: 12, margin: 0 },
  noticeError: { color: 'var(--dsw-alias-state-error-primary)' },
  noticeOk: { color: 'var(--dsw-alias-state-success-primary)' },
}

/** 按三组划分条目（观察中 = raw + distilled）。 */
function groupLessons(lessons: readonly ErrataLessonView[]): Record<Tab, ErrataLessonView[]> {
  const watching: ErrataLessonView[] = []
  const promoted: ErrataLessonView[] = []
  const archived: ErrataLessonView[] = []
  for (const lesson of lessons) {
    if (lesson.status === 'archived') archived.push(lesson)
    else if (lesson.status === 'promoted') promoted.push(lesson)
    else watching.push(lesson)
  }
  return { watching, promoted, archived }
}

export function ErrataPanel({ api, t }: ErrataPanelProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('watching')
  const [workspace, setWorkspace] = useState<string>('')
  const [lessons, setLessons] = useState<ErrataLessonView[]>([])
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [confirmingId, setConfirmingId] = useState<string | undefined>(undefined)
  const loadSeq = useRef(0)

  const load = useCallback(async (ws: string) => {
    const seq = ++loadSeq.current
    setStatus('loading')
    setNotice(undefined)
    try {
      const value = await unwrap(api.list(ws.length === 0 ? undefined : ws))
      if (seq !== loadSeq.current) return // 过期响应丢弃
      setLessons(value.lessons)
      setStatus('ready')
    } catch {
      if (seq !== loadSeq.current) return
      setStatus('error')
    }
  }, [api])

  useEffect(() => {
    void load(workspace)
  }, [load, workspace])

  const groups = useMemo(() => groupLessons(lessons), [lessons])

  /** 执行单条操作；成功后刷新列表。 */
  const run = useCallback(async (lessonId: string, action: () => Promise<unknown>) => {
    if (busy !== undefined) return
    setBusy(lessonId)
    setNotice(undefined)
    try {
      await action()
      setNotice({ kind: 'ok', text: t('operationSucceeded') })
      await load(workspace)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setNotice({ kind: 'error', text: t('operationFailed', { message }) })
    } finally {
      setBusy(undefined)
    }
  }, [busy, load, t, workspace])

  /** workspace 尾参:空串/undefined 时省略(网关 acceptsUndefined 允许缺省)。 */
  const wsTail = (workspace.length === 0 ? [] : [workspace]) as [] | [string]
  const active = groups[tab]

  return (
    <div style={styles.section}>
      <div style={styles.toolbar}>
        <label style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('workspaceLabel')}
          <input
            style={styles.input}
            value={workspace}
            placeholder={t('defaultWorkspace')}
            onChange={(event) => setWorkspace(event.target.value)}
          />
        </label>
        {status === 'ready' && <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>{t('lessonCount', { count: lessons.length })}</span>}
      </div>

      <div style={styles.tabs} role="tablist">
        {TAB_ORDER.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            style={tab === key ? { ...styles.tab, ...styles.tabActive } : styles.tab}
            onClick={() => setTab(key)}
          >
            {t(key)}（{groups[key].length}）
          </button>
        ))}
      </div>

      {status === 'loading' && <p style={styles.status}>{t('loading')}</p>}
      {status === 'error' && (
        <p style={{ ...styles.status, color: 'var(--dsw-alias-state-error-primary)' }}>
          {t('error')}{' '}
          <button type="button" style={styles.button} onClick={() => void load(workspace)}>{t('retry')}</button>
        </p>
      )}

      {status === 'ready' && (
        <>
          {notice !== undefined && (
            <p style={{ ...styles.notice, ...(notice.kind === 'error' ? styles.noticeError : styles.noticeOk) }} role="status">
              {notice.text}
            </p>
          )}
          {active.length === 0 ? (
            <p style={styles.status}>{t(`empty${tab[0]!.toUpperCase()}${tab.slice(1)}`)}</p>
          ) : (
            <ul style={styles.list}>
              {active.map((lesson) => (
                <li key={lesson.id} style={styles.card}>
                  <div style={styles.cardHead}>
                    <strong style={styles.title}>{lesson.title}</strong>
                    {lesson.status === 'distilled' && (
                      <span style={{ ...styles.badge, ...styles.badgePromotable }}>{t('promotable')}</span>
                    )}
                    {lesson.status === 'promoted' && lesson.relatedSkillId !== undefined && (
                      <span style={styles.badge}>{t('skillRef', { name: lesson.relatedSkillId })}</span>
                    )}
                    {lesson.status === 'archived' && <span style={styles.badge}>{t('statusArchived')}</span>}
                  </div>
                  <p style={styles.meta}>
                    {lesson.tool} · {lesson.errorType} · {t('errorCount', { count: lesson.errorCount })}
                    {lesson.workspace !== undefined && ` · ${lesson.workspace}`}
                  </p>
                  <div style={styles.actions}>
                    {tab === 'watching' && (
                      <>
                        {lesson.status === 'distilled' ? (
                          <button
                            type="button"
                            style={{ ...styles.button, ...styles.buttonPrimary }}
                            disabled={busy !== undefined}
                            onClick={() => void run(lesson.id, () => unwrap(api.promote(lesson.id, ...wsTail)))}
                          >
                            {t('promote')}
                          </button>
                        ) : (
                          <span style={{ ...styles.meta, alignSelf: 'center' }}>
                            {t('notPromotable', { count: lesson.errorCount })}
                          </span>
                        )}
                        <button
                          type="button"
                          style={styles.button}
                          disabled={busy !== undefined}
                          onClick={() => void run(lesson.id, () => unwrap(api.archive(lesson.id, ...wsTail)))}
                        >
                          {t('archive')}
                        </button>
                      </>
                    )}
                    {tab === 'promoted' && (
                      <button
                        type="button"
                        style={styles.button}
                        disabled={busy !== undefined}
                        onClick={() => void run(lesson.id, () => unwrap(api.archive(lesson.id, ...wsTail)))}
                      >
                        {t('archive')}
                      </button>
                    )}
                    {tab === 'archived' && (
                      <>
                        <button
                          type="button"
                          style={styles.button}
                          disabled={busy !== undefined}
                          onClick={() => void run(lesson.id, () => unwrap(api.unarchive(lesson.id, ...wsTail)))}
                        >
                          {t('unarchive')}
                        </button>
                        <button
                          type="button"
                          style={{ ...styles.button, ...styles.buttonDanger }}
                          disabled={busy !== undefined}
                          onClick={() => {
                            // 内联二次确认（避免 window.confirm 在嵌入式 WebView 受限）：
                            // 首次点击进入确认态，再次点击执行删除。
                            if (confirmingId !== lesson.id) {
                              setConfirmingId(lesson.id)
                              return
                            }
                            setConfirmingId(undefined)
                            void run(lesson.id, () => unwrap(api.delete(lesson.id, ...wsTail)))
                          }}
                        >
                          {confirmingId === lesson.id ? t('removeConfirmShort') : t('remove')}
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
