import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { fullDate, timeAgo } from '../lib/format'
import type { CurrentUser, ExecutionDetail, ExecutionSummary } from '../lib/types'
import ResultCard from './ResultCard'
import Icon from './Icon'

interface Props {
  formId: string
  user: CurrentUser
  /** changes after every submit so the list refreshes */
  refreshKey: number
}

export default function RunHistory({ formId, user, refreshKey }: Props) {
  const [scope, setScope] = useState<'mine' | 'all'>('mine')
  const [rows, setRows] = useState<ExecutionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [open, setOpen] = useState<ExecutionDetail | null>(null)

  const load = useCallback(
    async (before?: string) => {
      setLoading(true)
      setError(null)
      try {
        const data = await api.listExecutions(formId, scope, before)
        setRows((prev) => (before ? [...prev, ...data] : data))
        setHasMore(data.length === 50)
      } catch (e) {
        setError((e as ApiError).message)
      } finally {
        setLoading(false)
      }
    },
    [formId, scope],
  )

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  async function show(id: string) {
    try {
      setOpen(await api.getExecution(id))
    } catch (e) {
      setError((e as ApiError).message)
    }
  }

  return (
    <div className="history">
      <div className="history-bar">
        <span className="muted small">{scope === 'mine' ? 'Your submissions' : 'Submissions by all users'}</span>
        <div className="history-actions">
          {user.isAdmin && (
            <div className="segmented" role="group" aria-label="Whose runs">
              <button className={scope === 'mine' ? 'on' : ''} onClick={() => setScope('mine')}>Mine</button>
              <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All users</button>
            </div>
          )}
          <button className="btn btn-sm" onClick={() => load()} disabled={loading}>Refresh</button>
        </div>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      {open ? (
        <div className="history-detail">
          <button className="btn btn-sm" onClick={() => setOpen(null)}><Icon name="back" size={14} /> All submissions</button>
          <div className="muted small detail-meta">
            Submitted {fullDate(open.createdAt)} by {open.userName}, form version {open.formVersion}
          </div>
          <ResultCard
            result={{
              ok: open.ok,
              stage: open.stage,
              status: open.status,
              message: open.message ?? '',
              details: open.details,
              request: open.request as never,
              response: open.response,
              durationMs: open.durationMs,
              requestId: open.requestId,
            }}
          />
        </div>
      ) : (
        <>
          {!loading && rows.length === 0 && !error && <div className="empty"><p>Nothing has been submitted with this form yet.</p></div>}
          {rows.length > 0 && (
            <table className="runs">
              <thead>
                <tr>
                  <th>Outcome</th>
                  <th>When</th>
                  {scope === 'all' && <th>User</th>}
                  <th>Message</th>
                  <th className="num">Duration</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => show(r.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && show(r.id)}>
                    <td>
                      <span className={`badge ${r.ok ? 'badge-ok' : 'badge-err'}`}>
                        {r.ok ? 'Submitted' : 'Failed'}
                      </span>
                    </td>
                    <td title={fullDate(r.createdAt)}>{timeAgo(r.createdAt)}</td>
                    {scope === 'all' && <td>{r.userName}</td>}
                    <td className="ellipsis" title={r.message}>{r.message}</td>
                    <td className="num muted">{r.durationMs !== undefined ? `${r.durationMs} ms` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {hasMore && (
            <button className="btn btn-sm load-more" onClick={() => load(rows[rows.length - 1]?.createdAt)} disabled={loading}>
              Load more
            </button>
          )}
          {loading && <div className="muted small pad">Loading…</div>}
        </>
      )}
    </div>
  )
}
