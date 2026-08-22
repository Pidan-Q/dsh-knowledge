/**
 * 知识库面板：全局 / 项目双层展示，条目增删查。
 *
 * 作用域切换：全局层始终可见（写入受宿主 allowGlobalWrite 约束，失败时
 * 显示宿主错误文案）；项目层需要选择 workspace（方案「项目定位」：
 * Remote 方法显式携带 workspace）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KnowledgeEntryView, KnowledgeRemoteApi, RememberInputView } from './api.js'
import { unwrap } from './api.js'

export type KnowledgeT = (key: string, params?: Record<string, unknown>) => string

/** 设置页 section owner 通过 inject 注入的能力。 */
export interface KnowledgePanelProps {
  api: KnowledgeRemoteApi
  t: KnowledgeT
}

type Scope = 'global' | 'project'
type Category = 'convention' | 'fact' | 'decision' | 'pitfall' | 'lesson'

const CATEGORIES: readonly Category[] = ['convention', 'fact', 'decision', 'pitfall', 'lesson']

const styles: Record<string, React.CSSProperties> = {
  section: { width: '100%', maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 14, color: 'var(--dsw-alias-label-primary)' },
  toolbar: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  scopeSwitch: { display: 'flex', gap: 4, borderBottom: '1px solid var(--dsw-alias-border-l2)' },
  scope: { padding: '6px 14px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--dsw-alias-label-tertiary)', borderBottom: '2px solid transparent' },
  scopeActive: { color: 'var(--dsw-alias-label-primary)', borderBottomColor: 'var(--dsw-alias-state-business-primary)' },
  // colorScheme: 'dark' 让原生 <select> 选项弹层（Windows 默认跟随系统浅色）按深色渲染，
  // 否则深色主题下弹层白底 + 浅色文字不可读
  select: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 8, padding: '4px 8px', fontSize: 12, color: 'var(--dsw-alias-label-primary)', colorScheme: 'dark' },
  form: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 },
  input: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 8, padding: '6px 10px', fontSize: 13, color: 'var(--dsw-alias-label-primary)', font: 'inherit' },
  textarea: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 8, padding: '6px 10px', fontSize: 13, color: 'var(--dsw-alias-label-primary)', font: 'inherit', minHeight: 64, resize: 'vertical' },
  formRow: { display: 'flex', gap: 8, alignItems: 'center' },
  list: { display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0, listStyle: 'none' },
  card: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 },
  cardHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  title: { margin: 0, fontSize: 13, fontWeight: 600 },
  titleButton: { border: 'none', background: 'none', padding: 0, margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', textAlign: 'left', flex: 1, minWidth: 0 },
  titleButtonOpen: { color: 'var(--dsw-alias-state-business-primary)' },
  detail: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6, borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 8 },
  bodyText: { margin: 0, fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', color: 'var(--dsw-alias-label-primary)', maxHeight: 320, overflowY: 'auto' },
  badge: { fontSize: 11, padding: '1px 8px', borderRadius: 99, border: '1px solid var(--dsw-alias-border-l2)' },
  meta: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
  actions: { display: 'flex', gap: 8 },
  button: { border: '1px solid var(--dsw-alias-border-l2)', background: 'none', color: 'var(--dsw-alias-label-primary)', borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer' },
  buttonPrimary: { color: 'var(--dsw-alias-state-business-primary)', borderColor: 'currentColor' },
  buttonDanger: { color: 'var(--dsw-alias-state-error-primary)', borderColor: 'currentColor' },
  buttonDisabled: { opacity: 0.45, cursor: 'not-allowed' },
  status: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
  notice: { fontSize: 12, margin: 0 },
  noticeError: { color: 'var(--dsw-alias-state-error-primary)' },
  noticeOk: { color: 'var(--dsw-alias-state-success-primary)' },
}

export function KnowledgePanel({ api, t }: KnowledgePanelProps): JSX.Element {
  const [scope, setScope] = useState<Scope>('global')
  const [workspace, setWorkspace] = useState<string>('')
  const [workspaceOptions, setWorkspaceOptions] = useState<string[]>([])
  const [customWorkspace, setCustomWorkspace] = useState(false)
  const [entries, setEntries] = useState<KnowledgeEntryView[]>([])
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [confirmingId, setConfirmingId] = useState<string | undefined>(undefined)
  const [expandedId, setExpandedId] = useState<string | undefined>(undefined)
  const loadSeq = useRef(0)
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [category, setCategory] = useState<Category>('fact')
  const [landing, setLanding] = useState<'default' | 'custom'>('default')
  const [landingDir, setLandingDir] = useState('')

  /** 下拉框「自定义路径…」的哨兵值。 */
  const CUSTOM_KEY = '__custom__'

  const load = useCallback(async (ws: string, dir?: string) => {
    const seq = ++loadSeq.current
    setStatus('loading')
    setNotice(undefined)
    try {
      // list 描述符 2 个位置参数：workspace + dir（自定义落盘浏览），缺省显式传 undefined
      const value = await unwrap(api.list(ws.length === 0 ? undefined : ws, dir === undefined || dir.length === 0 ? undefined : dir))
      if (seq !== loadSeq.current) return
      setEntries(value.entries)
      setStatus('ready')
    } catch {
      if (seq !== loadSeq.current) return
      setStatus('error')
    }
  }, [api])

  /** 当前生效的自定义落盘目录（未启用自定义时 undefined → 走默认层目录）。 */
  const activeLandingDir = landing === 'custom' && landingDir.trim().length > 0 ? landingDir.trim() : undefined

  useEffect(() => {
    void load(workspace, activeLandingDir)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, workspace, activeLandingDir])

  /** 项目作用域时加载工作区候选（已有条目 + 扫描基目录发现），供下拉选择。 */
  useEffect(() => {
    if (scope !== 'project') return
    void (async () => {
      try {
        const value = await unwrap(api.workspaces())
        setWorkspaceOptions(value.workspaces)
      } catch {
        setWorkspaceOptions([])
      }
    })()
  }, [api, scope])

  /** 当前作用域下的可见条目（全局层恒可见；项目层仅当选择 workspace 时并入）。 */
  const visible = useMemo(() => {
    if (scope === 'global') return entries.filter((entry) => entry.scope === 'global')
    return entries.filter((entry) => entry.scope === 'project')
  }, [entries, scope])

  const run = useCallback(async (label: string, action: () => Promise<unknown>) => {
    if (busy !== undefined) return
    setBusy(label)
    setNotice(undefined)
    try {
      await action()
      await load(workspace, activeLandingDir)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setNotice({ kind: 'error', text: t('operationFailed', { message }) })
    } finally {
      setBusy(undefined)
    }
  }, [activeLandingDir, busy, load, t, workspace])

  const submit = useCallback(async () => {
    if (title.trim().length === 0) {
      setNotice({ kind: 'error', text: t('titleRequired') })
      return
    }
    if (body.trim().length === 0) {
      setNotice({ kind: 'error', text: t('bodyRequired') })
      return
    }
    const input: RememberInputView = {
      title: title.trim(),
      body: body.trim(),
      scope,
      category,
    }
    if (scope === 'project' && workspace.trim().length === 0) {
      setNotice({ kind: 'error', text: t('projectWorkspaceHint') })
      return
    }
    const ws = scope === 'project' && workspace.length > 0 ? workspace : undefined
    try {
      const { id } = await unwrap(ws === undefined ? api.remember(input) : api.remember(input, ws))
      setTitle('')
      setBody('')
      setCategory('fact')
      setAdding(false)
      setNotice({ kind: 'ok', text: t('operationSucceeded', { id }) })
      await load(workspace, activeLandingDir)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setNotice({ kind: 'error', text: t('operationFailed', { message }) })
    }
  }, [api, body, category, load, scope, t, title, workspace])

  /** 「获取知识库」：按当前作用域调用宿主扫描生成（项目层需 workspace）。
   * generate 描述符有 3 个位置参数（scope/workspace/target），缺省尾参
   * 必须显式传 undefined 占位。target = 自定义落盘目录（用户可选）。 */
  const fetchKnowledge = useCallback(async () => {
    if (busy !== undefined) return
    if (scope === 'project' && workspace.trim().length === 0) {
      setNotice({ kind: 'error', text: t('projectWorkspaceHint') })
      return
    }
    setBusy('generate')
    setNotice(undefined)
    try {
      const ws = scope === 'project' && workspace.length > 0 ? workspace : undefined
      const value = await unwrap(api.generate(scope, ws, activeLandingDir))
      setNotice({
        kind: 'ok',
        text: t('generateSucceeded', {
          generated: String(value.generated),
          scanned: String(value.scanned),
          skipped: String(value.skipped),
        }),
      })
      await load(workspace, activeLandingDir)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setNotice({ kind: 'error', text: t('operationFailed', { message }) })
    } finally {
      setBusy(undefined)
    }
  }, [activeLandingDir, api, busy, load, scope, t, workspace])

  return (
    <div style={styles.section}>
      <div style={styles.toolbar}>
        <div style={styles.scopeSwitch} role="tablist">
          {(['global', 'project'] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={scope === key}
              style={scope === key ? { ...styles.scope, ...styles.scopeActive } : styles.scope}
              onClick={() => {
                setScope(key)
                setWorkspace('')
                setCustomWorkspace(false)
              }}
            >
              {t(`scope${key[0]!.toUpperCase()}${key.slice(1)}`)}
            </button>
          ))}
        </div>
        {scope === 'project' && (
          <label style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', display: 'flex', alignItems: 'center', gap: 6 }}>
            {t('workspaceLabel')}
            <select
              style={styles.select}
              value={customWorkspace ? CUSTOM_KEY : workspace}
              onChange={(event) => {
                const value = event.target.value
                if (value === CUSTOM_KEY) {
                  setCustomWorkspace(true)
                } else {
                  setCustomWorkspace(false)
                  setWorkspace(value)
                }
              }}
            >
              <option value="">{t('selectWorkspace')}</option>
              {workspaceOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
              <option value={CUSTOM_KEY}>{t('customWorkspace')}</option>
            </select>
            {customWorkspace && (
              <input
                style={{ ...styles.input, width: 200 }}
                value={workspace}
                placeholder={t('projectWorkspaceHint')}
                onChange={(event) => setWorkspace(event.target.value)}
              />
            )}
          </label>
        )}
        {scope === 'global' && <span style={styles.meta}>{t('globalWriteHint')}</span>}
        <label style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('landingLabel')}
          <select
            style={styles.select}
            value={landing}
            onChange={(event) => setLanding(event.target.value as 'default' | 'custom')}
          >
            <option value="default">{scope === 'project' ? t('landingProjectDefault') : t('landingGlobalDefault')}</option>
            <option value="custom">{t('landingCustom')}</option>
          </select>
          {landing === 'custom' && (
            <input
              style={{ ...styles.input, width: 200 }}
              value={landingDir}
              placeholder={t('landingHint')}
              onChange={(event) => setLandingDir(event.target.value)}
            />
          )}
        </label>
        {status === 'ready' && <span style={styles.meta}>{t('entryCount', { count: visible.length })}</span>}
        <button
          type="button"
          style={{ ...styles.button, ...styles.buttonPrimary, marginLeft: 'auto' }}
          disabled={busy !== undefined}
          onClick={() => void fetchKnowledge()}
        >
          {busy === 'generate' ? t('generating') : t('fetchKnowledge')}
        </button>
      </div>

      {status === 'loading' && <p style={styles.status}>{t('loading')}</p>}
      {status === 'error' && (
        <p style={{ ...styles.status, color: 'var(--dsw-alias-state-error-primary)' }}>
          {t('error')}{' '}
          <button type="button" style={styles.button} onClick={() => void load(workspace, activeLandingDir)}>{t('retry')}</button>
        </p>
      )}

      {status === 'ready' && (
        <>
          {notice !== undefined && (
            <p style={{ ...styles.notice, ...(notice.kind === 'error' ? styles.noticeError : styles.noticeOk) }} role="status">
              {notice.text}
            </p>
          )}

          {adding ? (
            <form
              style={styles.form}
              onSubmit={(event) => {
                event.preventDefault()
                void submit()
              }}
            >
              <div style={styles.formRow}>
                <input
                  style={{ ...styles.input, flex: 1 }}
                  value={title}
                  placeholder={t('title')}
                  aria-label={t('title')}
                  onChange={(event) => setTitle(event.target.value)}
                />
                <select
                  style={styles.select}
                  value={category}
                  aria-label={t('category')}
                  onChange={(event) => setCategory(event.target.value as Category)}
                >
                  {CATEGORIES.map((key) => (
                    <option key={key} value={key}>{t(`category${key[0]!.toUpperCase()}${key.slice(1)}`)}</option>
                  ))}
                </select>
              </div>
              <textarea
                style={styles.textarea}
                value={body}
                placeholder={t('body')}
                aria-label={t('body')}
                onChange={(event) => setBody(event.target.value)}
              />
              <div style={styles.formRow}>
                <button type="submit" style={{ ...styles.button, ...styles.buttonPrimary }}>{t('addSubmit')}</button>
                <button type="button" style={styles.button} onClick={() => setAdding(false)}>{t('addCancel')}</button>
              </div>
            </form>
          ) : (
            <div>
              <button type="button" style={{ ...styles.button, ...styles.buttonPrimary }} onClick={() => setAdding(true)}>
                {t('add')}
              </button>
            </div>
          )}

          {visible.length === 0 ? (
            <p style={styles.status}>{t('empty')}</p>
          ) : (
            <ul style={styles.list}>
              {visible.map((entry) => {
                const expanded = expandedId === entry.id
                return (
                  <li key={entry.id} style={styles.card}>
                    <div style={styles.cardHead}>
                      <button
                        type="button"
                        style={{ ...styles.titleButton, ...(expanded ? styles.titleButtonOpen : {}) }}
                        onClick={() => setExpandedId(expanded ? undefined : entry.id)}
                        aria-expanded={expanded}
                      >
                        {expanded ? '▾' : '▸'} {entry.title}
                      </button>
                      <span style={styles.badge}>{t(`category${entry.category[0]!.toUpperCase()}${entry.category.slice(1)}`)}</span>
                      <span style={styles.badge}>{entry.id}</span>
                    </div>
                    <p style={styles.meta}>{t('created', { date: entry.created })}</p>
                    {expanded && (
                      <div style={styles.detail}>
                        <pre style={styles.bodyText}>{entry.body}</pre>
                        {entry.tags.length > 0 && (
                          <p style={styles.meta}>{t('tags', { tags: entry.tags.join(', ') })}</p>
                        )}
                        {entry.source !== undefined && (
                          <p style={styles.meta}>{t('source', { source: entry.source })}</p>
                        )}
                        <p style={styles.meta}>{t('status', { status: t(`status${entry.status[0]!.toUpperCase()}${entry.status.slice(1)}`) })}</p>
                      </div>
                    )}
                    <div style={styles.actions}>
                      <button
                        type="button"
                        style={styles.button}
                        disabled={busy !== undefined}
                        onClick={() => setExpandedId(expanded ? undefined : entry.id)}
                      >
                        {expanded ? t('collapse') : t('readMore')}
                      </button>
                      <button
                        type="button"
                        style={{ ...styles.button, ...styles.buttonDanger }}
                        disabled={busy !== undefined}
                        onClick={() => {
                          // 内联二次确认（避免 window.confirm 在嵌入式 WebView 受限）
                          if (confirmingId !== entry.id) {
                            setConfirmingId(entry.id)
                            return
                          }
                          setConfirmingId(undefined)
                          void run(entry.id, () => unwrap(
                          workspace.length === 0 ? api.forget(entry.id) : api.forget(entry.id, workspace),
                        ))
                      }}
                    >
                      {confirmingId === entry.id ? t('removeConfirmShort') : t('remove')}
                    </button>
                  </div>
                </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
