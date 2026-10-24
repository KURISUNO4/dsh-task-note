/**
 * Browser half of `dsh-task-note`.
 *
 * Two contributions:
 *
 *   1. `shell.overlay` — the note itself: a frame-wide, top-right widget that can be
 *      dragged by its header (or by the ball when collapsed) and collapsed into a
 *      floating ball. It shows the agent's live todo projection above the user's own
 *      task list. User tasks are created, edited, reordered, flagged important and
 *      completed entirely here; completing a task removes it immediately.
 *   2. `conversation.input.dock` — a replacement for the shipped `todo` entry that
 *      renders nothing, so the built-in task list above the composer no longer
 *      appears: this note is the task list.
 *
 * The agent's tasks come from the same `todos` session projection the shipped dock
 * reads (`useProjection('todos')`), bridged into the overlay through a module store
 * because `shell.overlay` is root-scoped and has no session projection hook.
 *
 * Plain browser JavaScript against the shell's module table: React comes from
 * `require('react')`, no Harness Client package is imported, and user data lives in
 * this browser's localStorage.
 */
window.__ModuleLoader__.load({
  id: 'dsh-task-note',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace of this plugin's visible text. */
    const NS = 'dsh-task-note'
    /** One versioned localStorage key holds tasks plus the widget's own layout. */
    const STORAGE_KEY = 'dsh-task-note/v1'
    /** Defensive bounds: a broken or hostile stored value must not wedge the widget. */
    const MAX_TASKS = 500
    const MAX_TEXT = 500
    /** Default anchor: top-right, below the conversation header's own controls. */
    const DEFAULT_RIGHT = 20
    const DEFAULT_TOP = 72
    /** Pointer travel below this reads as a click, not a drag. */
    const DRAG_CLICK_SLOP = 4
    /** Style tag id, one per page, owned by this plugin's effect. */
    const CSS_ID = 'dsh-task-note/widget.css'

    const ZH = {
      title: '任务便签',
      'summary.open': '{count} 项待办',
      'summary.important': '{count} 项重要',
      'summary.empty': '暂无待办',
      'ai.title': 'AI 任务',
      'ai.count': '{count} 项',
      'ai.empty': 'AI 暂无任务',
      'user.title': '我的任务',
      'user.count': '{count} 项',
      'user.empty': '还没有任务，添加一条吧',
      'add.placeholder': '添加一条任务，回车确认',
      'add.action': '添加任务',
      'a11y.collapse': '收起任务便签',
      'a11y.expand': '展开任务便签',
      'a11y.complete': '完成：{text}',
      'a11y.important': '标记为重要：{text}',
      'a11y.unimportant': '取消重要标记：{text}',
      'a11y.edit': '编辑：{text}',
      'a11y.drag': '拖动排序：{text}',
      'a11y.moveUp': '上移：{text}',
      'a11y.moveDown': '下移：{text}',
      'ball.label': '任务便签，{count} 项未完成',
      'edit.placeholder': '任务内容',
      'status.pending': '待处理',
      'status.in_progress': '进行中',
      'status.completed': '已完成',
    }

    const EN = {
      title: 'Task Note',
      'summary.open': '{count} pending',
      'summary.important': '{count} important',
      'summary.empty': 'Nothing pending',
      'ai.title': 'AI tasks',
      'ai.count': '{count}',
      'ai.empty': 'The AI has no tasks',
      'user.title': 'My tasks',
      'user.count': '{count}',
      'user.empty': 'No tasks yet — add one below',
      'add.placeholder': 'Add a task, press Enter',
      'add.action': 'Add task',
      'a11y.collapse': 'Collapse task note',
      'a11y.expand': 'Expand task note',
      'a11y.complete': 'Complete: {text}',
      'a11y.important': 'Mark important: {text}',
      'a11y.unimportant': 'Clear important: {text}',
      'a11y.edit': 'Edit: {text}',
      'a11y.drag': 'Drag to reorder: {text}',
      'a11y.moveUp': 'Move up: {text}',
      'a11y.moveDown': 'Move down: {text}',
      'ball.label': 'Task note, {count} open',
      'edit.placeholder': 'Task text',
      'status.pending': 'pending',
      'status.in_progress': 'in progress',
      'status.completed': 'completed',
    }

    /* ------------------------------------------------------------------ *
     * Small helpers
     * ------------------------------------------------------------------ */

    /**
     * Substitute `{name}` placeholders in one dictionary template.
     * @param {string} template dictionary value.
     * @param {Record<string, unknown> | undefined} params values to substitute.
     * @returns {string} the formatted text.
     */
    function format(template, params) {
      if (params === undefined || params === null) return String(template)
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (
        params[key] === undefined ? match : String(params[key])
      ))
    }

    /** @returns {string} a compact unique task id. */
    function makeTaskId() {
      return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    }

    /**
     * @param {string} text task content.
     * @returns {{ id: string, text: string, important: boolean, createdAt: number }} a new task.
     */
    function makeTask(text) {
      return { id: makeTaskId(), text, important: false, createdAt: Date.now() }
    }

    /* ------------------------------------------------------------------ *
     * Persistence: user tasks + widget layout
     * ------------------------------------------------------------------ */

    /**
     * @param {unknown} raw parsed or partially trusted stored value.
     * @returns {{ version: number, tasks: Array<{id: string, text: string, important: boolean, createdAt: number}>, collapsed: boolean, pos: ({ right: number, top: number } | null) }} a safe state.
     */
    function sanitizeState(raw) {
      const tasks = []
      const source = raw !== null && typeof raw === 'object' && Array.isArray(raw.tasks) ? raw.tasks : []
      for (const entry of source) {
        if (entry === null || typeof entry !== 'object') continue
        if (typeof entry.text !== 'string') continue
        const text = entry.text.trim().slice(0, MAX_TEXT)
        if (text.length === 0) continue
        tasks.push({
          id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id.slice(0, 64) : makeTaskId(),
          text,
          important: entry.important === true,
          createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
        })
        if (tasks.length >= MAX_TASKS) break
      }
      const storedPos = raw !== null && typeof raw === 'object' ? raw.pos : undefined
      const pos = storedPos !== null && typeof storedPos === 'object'
        && Number.isFinite(storedPos.right) && Number.isFinite(storedPos.top)
        ? { right: Number(storedPos.right), top: Number(storedPos.top) }
        : null
      return {
        version: 1,
        tasks,
        collapsed: raw !== null && typeof raw === 'object' ? raw.collapsed === true : false,
        pos,
      }
    }

    /** @returns {ReturnType<typeof sanitizeState>} the persisted state, or an empty one. */
    function loadState() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw === null) return sanitizeState(null)
        return sanitizeState(JSON.parse(raw))
      } catch (error) {
        console.warn('[task-note] stored state ignored:', error)
        return sanitizeState(null)
      }
    }

    /**
     * @param {ReturnType<typeof sanitizeState>} state the state to persist.
     * @returns {void}
     */
    function saveState(state) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
          version: 1,
          tasks: state.tasks,
          collapsed: state.collapsed,
          pos: state.pos,
        }))
      } catch (error) {
        console.warn('[task-note] state not persisted:', error)
      }
    }

    /** One tiny external store: subscribe/get/update, persisting on every committed change. */
    const noteStore = (() => {
      let state = loadState()
      const listeners = new Set()
      return {
        get() {
          return state
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        /**
         * @param {((current: typeof state) => typeof state) | Partial<typeof state>} mutator next state or updater.
         * @param {{ persist?: boolean } | undefined} options `persist: false` for in-flight drag frames.
         * @returns {void}
         */
        update(mutator, options) {
          const next = typeof mutator === 'function' ? mutator(state) : Object.assign({}, state, mutator)
          if (next === state) return
          state = next
          if (options === undefined || options.persist !== false) saveState(state)
          for (const listener of Array.from(listeners)) listener()
        },
        persist() {
          saveState(state)
        },
      }
    })()

    /** The agent's live projection, bridged from the session-scoped dock entry. */
    const aiStore = {
      snapshot: { sessionId: undefined, todos: null },
      listeners: new Set(),
    }

    /**
     * @param {string | undefined} sessionId session the projection belongs to.
     * @param {unknown} todos projection value.
     * @returns {void}
     */
    function publishAI(sessionId, todos) {
      const nextTodos = Array.isArray(todos) ? todos : null
      const previous = aiStore.snapshot
      if (previous.sessionId === sessionId && sameTodoList(previous.todos, nextTodos)) return
      aiStore.snapshot = { sessionId, todos: nextTodos }
      for (const listener of Array.from(aiStore.listeners)) listener()
    }

    /**
     * @param {unknown} left previous projection value.
     * @param {unknown} right next projection value.
     * @returns {boolean} whether both carry the same rows and statuses.
     */
    function sameTodoList(left, right) {
      if (left === right) return true
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
      for (let index = 0; index < left.length; index++) {
        if (left[index].content !== right[index].content || left[index].status !== right[index].status) return false
      }
      return true
    }

    /**
     * The active conversation session, read the way the shipped Cordis panel reads it:
     * the one summary whose main view retains it.
     * @param {(selector: (state: any) => unknown) => unknown} useSessions standard slot prop.
     * @returns {string | undefined} active session id.
     */
    function useActiveSessionId(useSessions) {
      return useSessions((state) => {
        const byId = state && state.byId
        if (byId === undefined || byId === null) return undefined
        for (const id of Object.keys(byId)) {
          const row = byId[id]
          if (row !== null && row !== undefined && row.retainedBy !== undefined
            && (row.retainedBy.mainView || 0) > 0) return id
        }
        return undefined
      })
    }

    /* ------------------------------------------------------------------ *
     * Icons (inline SVG: no artwork dependency, inherits currentColor)
     * ------------------------------------------------------------------ */

    function GlyphChecklist() {
      return h('svg', {
        viewBox: '0 0 20 20', width: 22, height: 22, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
      },
        h('path', { d: 'M3.2 5.1l1.5 1.5 2.5-2.9' }),
        h('path', { d: 'M9.8 5.3h6.8' }),
        h('path', { d: 'M3.2 11.1l1.5 1.5 2.5-2.9' }),
        h('path', { d: 'M9.8 11.3h6.8' }),
        h('circle', { cx: 4.6, cy: 16, r: 1.2 }),
        h('path', { d: 'M9.8 16.1h5.4' }),
      )
    }

    function GlyphChevronUp() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
      }, h('path', { d: 'M4 10l4-4 4 4' }))
    }

    function GlyphPlus() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', 'aria-hidden': true, focusable: false,
      }, h('path', { d: 'M8 3.5v9' }), h('path', { d: 'M3.5 8h9' }))
    }

    function GlyphCheck() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 11, height: 11, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
      }, h('path', { d: 'M3.2 8.4l3 3 6.4-7' }))
    }

    function GlyphGrip() {
      const dots = []
      for (const y of [3, 8, 13]) {
        dots.push(h('circle', { key: 'l' + y, cx: 3, cy: y, r: 1.05 }))
        dots.push(h('circle', { key: 'r' + y, cx: 7, cy: y, r: 1.05 }))
      }
      return h('svg', {
        viewBox: '0 0 10 16', width: 10, height: 16, fill: 'currentColor',
        'aria-hidden': true, focusable: false,
      }, dots)
    }

    /** @param {string} status todo status. @returns {import('react').ReactNode} its marker. */
    function StatusGlyph(status) {
      if (status === 'completed') {
        return h('span', { className: 'dsn-statusDone' }, h('svg', {
          viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
        },
          h('circle', { cx: 8, cy: 8, r: 5.4 }),
          h('path', { d: 'M5.4 8.2l1.9 1.9 3.5-3.9' }),
        ))
      }
      if (status === 'in_progress') {
        return h('span', { className: 'dsn-statusActive' }, h('span', { className: 'dsn-pulse' }))
      }
      return h('span', { className: 'dsn-statusIdle' }, h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.5, 'aria-hidden': true, focusable: false,
      }, h('circle', { cx: 8, cy: 8, r: 5.2 })))
    }

    /* ------------------------------------------------------------------ *
     * Styles
     * ------------------------------------------------------------------ */

    const CSS = [
      // The overlay layer is click-through; the widget opts back in.
      // The overlay slot itself sits below some conversation stacking contexts; a
      // manual popover puts the widget in the browser's top layer so it floats above
      // every column regardless of their z-index or clipping.
      '.dsn-ball,.dsn-root{pointer-events:auto;box-sizing:border-box;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);-webkit-font-smoothing:antialiased;z-index:2147483000;margin:0;left:auto;bottom:auto;inset-inline-start:auto;inset-block-end:auto}',
      '.dsn-root:not(:popover-open),.dsn-ball:not(:popover-open){display:none}',
      // Collapsed floating ball.
      // `overflow:visible` is load-bearing, not cosmetic: the UA stylesheet gives every
      // `[popover]` `overflow:auto`, which clips the badge that sits at top:-5px/right:-5px
      // outside the 44px circle (a clipped wedge plus a scrollbar track inside the ball).
      '.dsn-ball{position:fixed;display:grid;place-items:center;width:44px;height:44px;padding:0;border-radius:50%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));box-shadow:var(--dsw-elevation-panel,0 8px 24px rgba(0,0,0,.18));cursor:grab;touch-action:none;user-select:none;color:var(--dsw-alias-label-primary);overflow:visible}',
      '.dsn-ball:hover{color:var(--dsw-alias-brand-primary)}',
      '.dsn-ball:focus-visible,.dsn-root button:focus-visible,.dsn-root input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dsn-ball.dsn-dragging{cursor:grabbing}',
      '.dsn-badge{position:absolute;top:-5px;right:-5px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-size:11px;font-weight:600;line-height:18px;text-align:center;font-variant-numeric:tabular-nums;box-shadow:0 0 0 2px var(--dsw-alias-bg-base)}',
      // Expanded panel.
      '.dsn-root{position:fixed;display:flex;flex-direction:column;width:324px;max-height:min(70vh,580px);border-radius:var(--dsw-radius-lg,14px);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));box-shadow:var(--dsw-elevation-panel,0 12px 36px rgba(0,0,0,.2));backdrop-filter:var(--dsw-menu-backdrop-filter,none);overflow:hidden}',
      '.dsn-header{display:flex;align-items:center;gap:8px;min-height:40px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:grab;touch-action:none;user-select:none;flex:none}',
      '.dsn-root.dsn-dragging .dsn-header{cursor:grabbing}',
      '.dsn-gripMark{display:grid;place-items:center;flex:none;color:var(--dsw-alias-label-tertiary);margin-left:-2px}',
      '.dsn-title{flex:none;font-size:13px;font-weight:600;line-height:20px;white-space:nowrap}',
      '.dsn-summary{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsn-iconBtn{flex:none;display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.dsn-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}',
      '.dsn-body{display:flex;flex-direction:column;gap:10px;padding:8px 10px 10px;overflow-y:auto;min-height:0}',
      '.dsn-section{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dsn-sectionHead{display:flex;align-items:baseline;gap:6px;min-width:0}',
      '.dsn-sectionTitle{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;letter-spacing:.02em;white-space:nowrap}',
      '.dsn-count{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dsn-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.dsn-aiRow{display:flex;align-items:center;gap:8px;min-height:26px;padding:2px 4px;border-radius:6px;color:var(--dsw-alias-label-secondary);min-width:0}',
      '.dsn-aiText{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12.5px;line-height:20px}',
      '.dsn-aiRow[data-status="completed"] .dsn-aiText{text-decoration:line-through;color:var(--dsw-alias-label-tertiary)}',
      '.dsn-aiRow[data-status="in_progress"] .dsn-aiText{color:var(--dsw-alias-label-primary)}',
      '.dsn-status{flex:none;display:grid;place-items:center;width:16px;height:16px}',
      '.dsn-statusDone{color:var(--dsw-alias-state-success-primary)}',
      '.dsn-statusIdle{color:var(--dsw-alias-state-idle-primary)}',
      '.dsn-statusActive{display:grid;place-items:center;width:16px;height:16px}',
      '.dsn-pulse{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);animation:dsn-pulse 1.4s ease-in-out infinite}',
      '@keyframes dsn-pulse{0%,100%{opacity:.35;transform:scale(.82)}50%{opacity:1;transform:scale(1.12)}}',
      // One user task row.
      '.dsn-row{display:flex;align-items:center;gap:4px;min-height:28px;padding:1px 3px;border-radius:6px;min-width:0}',
      '.dsn-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.09))}',
      '.dsn-row.dsn-important{box-shadow:inset 2px 0 0 var(--dsw-alias-state-warn-primary)}',
      '.dsn-row.dsn-rowDragging{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));opacity:.85}',
      '.dsn-circle{flex:none;display:grid;place-items:center;width:18px;height:18px;padding:0;border-radius:50%;border:1.5px solid var(--dsw-alias-label-tertiary);background:transparent;color:transparent;cursor:pointer}',
      '.dsn-circle:hover{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.dsn-circle svg{opacity:0;transition:opacity .1s ease}',
      '.dsn-circle:hover svg,.dsn-circle:focus-visible svg{opacity:1}',
      '.dsn-text{flex:1;min-width:0;padding:2px 2px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:20px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:text;border-radius:4px}',
      '.dsn-text:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.09))}',
      '.dsn-rowInput{flex:1;min-width:0;height:24px;font-size:12.5px}',
      '.dsn-flag{flex:none;display:grid;place-items:center;width:20px;height:20px;padding:0;border:1px solid transparent;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;font-weight:700;line-height:1;cursor:pointer}',
      '.dsn-flag:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.09))}',
      '.dsn-flag[aria-pressed="true"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);background:transparent}',
      '.dsn-grip{flex:none;display:grid;place-items:center;width:16px;height:20px;color:var(--dsw-alias-label-tertiary);cursor:grab;touch-action:none;border-radius:4px;opacity:.5}',
      '.dsn-row:hover .dsn-grip{opacity:1}',
      '.dsn-grip:active{cursor:grabbing}',
      '.dsn-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;padding:2px 4px}',
      // Add-task row.
      '.dsn-add{display:flex;align-items:center;gap:6px;margin-top:2px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1);flex:none}',
      '.dsn-input{box-sizing:border-box;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:24px;outline:none;min-width:0}',
      '.dsn-input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.dsn-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dsn-add .dsn-input{flex:1}',
      '.dsn-addBtn{flex:none;display:grid;place-items:center;width:26px;height:26px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dsn-addBtn:hover{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.dsn-srOnly{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
      '@media (prefers-reduced-motion:reduce){.dsn-pulse{animation:none;opacity:.9}.dsn-circle svg{transition:none}}',
    ].join('')

    /** @returns {(() => void) | null} disposer for the style tag, or null when it is already there. */
    function installStyle() {
      if (typeof document === 'undefined' || document === null) return null
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']') !== null) return null
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-task-note'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    /* ------------------------------------------------------------------ *
     * React components
     * ------------------------------------------------------------------ */

    /** Subscribe the component to the note store. @returns {ReturnType<typeof noteStore.get>} current state. */
    function useNoteState() {
      const [, bump] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => noteStore.subscribe(bump), [])
      return noteStore.get()
    }

    /**
     * The session-scoped bridge: reads the live `todos` projection the shipped dock
     * would read, publishes it to the overlay, and renders nothing — this is the entry
     * that replaces the built-in task list above the composer.
     * @param {{ sessionId: string, useProjection: (key: string) => unknown }} props owner props.
     * @returns {null} nothing.
     */
    function TodoBridge(props) {
      const todos = props.useProjection('todos')
      React.useEffect(() => {
        publishAI(props.sessionId, todos)
      }, [props.sessionId, todos])
      return null
    }

    /**
     * The whole widget: the ball when collapsed, the panel when expanded.
     * @param {{ useSessions: Function, t: (key: string, params?: Record<string, unknown>) => string }} props standard props + translator.
     * @returns {import('react').ReactNode} the widget.
     */
    function TaskNote(props) {
      const t = props.t
      const state = useNoteState()
      const tasks = state.tasks
      const accountForAI = React.useReducer((value) => value + 1, 0)[1]
      React.useEffect(() => {
        aiStore.listeners.add(accountForAI)
        return () => {
          aiStore.listeners.delete(accountForAI)
        }
      }, [accountForAI])
      const activeSessionId = useActiveSessionId(props.useSessions)
      const ai = aiStore.snapshot
      const todos = activeSessionId !== undefined && ai.sessionId === activeSessionId ? ai.todos : null

      const rootRef = React.useRef(null)
      const [pos, setPos] = React.useState(() => {
        const stored = state.pos
        return stored === null ? { right: DEFAULT_RIGHT, top: DEFAULT_TOP } : { right: stored.right, top: stored.top }
      })
      const posRef = React.useRef(pos)
      posRef.current = pos
      const [dragging, setDragging] = React.useState(false)
      const widgetDrag = React.useRef(null)
      const [draft, setDraft] = React.useState('')
      const [editing, setEditing] = React.useState(null)
      const [dragIndex, setDragIndex] = React.useState(-1)
      const rowDrag = React.useRef(null)

      /**
       * Keep the widget inside the viewport, using its current rendered size.
       * @param {{ right: number, top: number }} next candidate anchor.
       * @param {HTMLElement | null | undefined} element rendered widget, when available.
       * @returns {{ right: number, top: number }} a clamped anchor.
       */
      const clampPos = React.useCallback((next, element) => {
        const viewportWidth = window.innerWidth || 1280
        const viewportHeight = window.innerHeight || 800
        const width = element === null || element === undefined ? (state.collapsed ? 44 : 324) : element.offsetWidth
        const height = element === null || element === undefined ? (state.collapsed ? 44 : 200) : element.offsetHeight
        return {
          right: Math.max(8, Math.min(next.right, Math.max(8, viewportWidth - width - 8))),
          top: Math.max(8, Math.min(next.top, Math.max(8, viewportHeight - height - 8))),
        }
      }, [state.collapsed])

      React.useLayoutEffect(() => {
        const element = rootRef.current
        if (element === null || typeof element.showPopover !== 'function') return
        try {
          if (!element.matches(':popover-open')) element.showPopover()
        } catch (error) {
          /* popover support is optional; the widget still renders in the overlay */
        }
      }, [state.collapsed])

      React.useLayoutEffect(() => {
        const current = posRef.current
        const next = clampPos(current, rootRef.current)
        if (next.right === current.right && next.top === current.top) return
        setPos(next)
        noteStore.update((value) => ({ ...value, pos: next }))
      }, [state.collapsed, clampPos])

      React.useEffect(() => {
        const onResize = () => {
          setPos((current) => clampPos(current, rootRef.current))
        }
        window.addEventListener('resize', onResize)
        return () => {
          window.removeEventListener('resize', onResize)
        }
      }, [clampPos])

      /* -------------------------- widget dragging -------------------------- */

      /**
       * @param {import('react').PointerEvent} event pointer down on the ball or header.
       * @param {boolean} clickable whether a click (no travel) toggles the panel.
       * @returns {void}
       */
      const startWidgetDrag = (event, clickable) => {
        if (event.button !== undefined && event.button !== 0) return
        const element = rootRef.current
        if (element === null) return
        const rect = element.getBoundingClientRect()
        widgetDrag.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startRight: posRef.current.right,
          startTop: posRef.current.top,
          width: rect.width,
          height: rect.height,
          moved: false,
          clickable,
        }
        setDragging(true)
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch (error) {
          /* capture unavailable: the per-element handlers still cover the in-element path */
        }
        if (clickable && event.pointerType === 'mouse') event.preventDefault()
      }

      const onWidgetPointerMove = (event) => {
        const drag = widgetDrag.current
        if (drag === null || drag.pointerId !== event.pointerId) return
        const dx = event.clientX - drag.startX
        const dy = event.clientY - drag.startY
        if (Math.abs(dx) + Math.abs(dy) > DRAG_CLICK_SLOP) drag.moved = true
        const viewportWidth = window.innerWidth || 1280
        const viewportHeight = window.innerHeight || 800
        setPos({
          right: Math.max(8, Math.min(drag.startRight - dx, Math.max(8, viewportWidth - drag.width - 8))),
          top: Math.max(8, Math.min(drag.startTop + dy, Math.max(8, viewportHeight - drag.height - 8))),
        })
      }

      const onWidgetPointerUp = (event) => {
        const drag = widgetDrag.current
        if (drag === null || drag.pointerId !== event.pointerId) return
        widgetDrag.current = null
        setDragging(false)
        try {
          event.currentTarget.releasePointerCapture(event.pointerId)
        } catch (error) {
          /* already released */
        }
        const next = clampPos(posRef.current, rootRef.current)
        setPos(next)
        noteStore.update((value) => ({ ...value, pos: next }))
        if (!drag.moved && drag.clickable) {
          noteStore.update((value) => ({ ...value, collapsed: !value.collapsed }))
        }
      }

      /* --------------------------- user task edits ------------------------- */

      const addTask = (text) => {
        const value = String(text).trim().slice(0, MAX_TEXT)
        if (value.length === 0) return
        noteStore.update((current) => {
          if (current.tasks.length >= MAX_TASKS) return current
          return { ...current, tasks: current.tasks.concat(makeTask(value)) }
        })
      }

      const completeTask = (id) => {
        noteStore.update((current) => ({
          ...current,
          tasks: current.tasks.filter((task) => task.id !== id),
        }))
      }

      const toggleImportant = (id) => {
        noteStore.update((current) => ({
          ...current,
          tasks: current.tasks.map((task) => (
            task.id === id ? { ...task, important: !task.important } : task
          )),
        }))
      }

      /**
       * Move one task and keep the array identity stable when nothing changes.
       * @param {number} from source index.
       * @param {number} to target index.
       * @param {{ persist?: boolean } | undefined} options persistence override for drag frames.
       * @returns {void}
       */
      const moveTask = (from, to, options) => {
        noteStore.update((current) => {
          if (from === to || from < 0 || to < 0) return current
          if (from >= current.tasks.length || to >= current.tasks.length) return current
          const tasks = current.tasks.slice()
          const moved = tasks.splice(from, 1)[0]
          tasks.splice(to, 0, moved)
          return { ...current, tasks }
        }, options)
      }

      const commitEdit = () => {
        const current = editing
        if (current === null) return
        setEditing(null)
        const text = String(current.value).trim().slice(0, MAX_TEXT)
        if (text.length === 0) return
        noteStore.update((value) => ({
          ...value,
          tasks: value.tasks.map((task) => (task.id === current.id ? { ...task, text } : task)),
        }))
      }

      /**
       * Pointer-based reordering: the row under the pointer becomes the insertion
       * target while the list reorders live. Persistence waits for pointer up.
       * @param {number} index index of the row being dragged.
       * @param {import('react').PointerEvent} event pointer down on that row's grip.
       * @returns {void}
       */
      const startRowDrag = (index, event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        rowDrag.current = { from: index }
        setDragIndex(index)
        const onMove = (moveEvent) => {
          const info = rowDrag.current
          if (info === null) return
          const node = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)
          const row = node !== null && node.closest !== undefined ? node.closest('[data-dsn-row]') : null
          if (row === null) return
          const to = Number(row.getAttribute('data-index'))
          if (!Number.isFinite(to) || to === info.from) return
          moveTask(info.from, to, { persist: false })
          info.from = to
          setDragIndex(to)
        }
        const finish = () => {
          if (rowDrag.current === null) return
          rowDrag.current = null
          setDragIndex(-1)
          noteStore.persist()
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', finish)
          window.removeEventListener('pointercancel', finish)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', finish)
        window.addEventListener('pointercancel', finish)
      }

      /* ------------------------------ rendering --------------------------- */

      const importantCount = tasks.filter((task) => task.important).length
      const aiOpenCount = todos === null ? 0 : todos.filter((item) => item.status !== 'completed').length
      const badgeCount = tasks.length + aiOpenCount
      const summary = tasks.length === 0
        ? t('summary.empty')
        : [
          t('summary.open', { count: tasks.length }),
          ...(importantCount > 0 ? [t('summary.important', { count: importantCount })] : []),
        ].join(' · ')

      if (state.collapsed) {
        return h('button', {
          type: 'button',
          ref: rootRef,
          popover: 'manual',
          className: 'dsn-ball' + (dragging ? ' dsn-dragging' : ''),
          style: { right: pos.right + 'px', top: pos.top + 'px' },
          title: t('a11y.expand'),
          'aria-label': t('ball.label', { count: badgeCount }),
          'aria-expanded': false,
          onPointerDown: (event) => startWidgetDrag(event, true),
          onPointerMove: onWidgetPointerMove,
          onPointerUp: onWidgetPointerUp,
          onPointerCancel: onWidgetPointerUp,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              noteStore.update((value) => ({ ...value, collapsed: false }))
            }
          },
        },
          h(GlyphChecklist),
          badgeCount > 0
            ? h('span', { className: 'dsn-badge' }, badgeCount > 99 ? '99+' : String(badgeCount))
            : null,
        )
      }

      const aiSection = h('section', { className: 'dsn-section', 'aria-label': t('ai.title') },
        h('div', { className: 'dsn-sectionHead' },
          h('span', { className: 'dsn-sectionTitle' }, t('ai.title')),
          h('span', { className: 'dsn-count' }, todos === null ? '' : t('ai.count', { count: todos.length })),
        ),
        todos !== null && todos.length > 0
          ? h('ul', { className: 'dsn-list' },
            todos.map((item, index) => h('li', {
              key: 'ai-' + index,
              className: 'dsn-aiRow',
              'data-status': item.status,
              title: item.content,
            },
              h('span', { className: 'dsn-status' }, StatusGlyph(item.status)),
              h('span', { className: 'dsn-aiText' }, item.content),
              h('span', { className: 'dsn-srOnly' }, t('status.' + item.status)),
            )),
          )
          : h('div', { className: 'dsn-empty' }, t('ai.empty')),
      )

      const userSection = h('section', { className: 'dsn-section', 'aria-label': t('user.title') },
        h('div', { className: 'dsn-sectionHead' },
          h('span', { className: 'dsn-sectionTitle' }, t('user.title')),
          h('span', { className: 'dsn-count' }, tasks.length > 0 ? t('user.count', { count: tasks.length }) : ''),
        ),
        tasks.length > 0
          ? h('ul', { className: 'dsn-list' },
            tasks.map((task, index) => h('li', {
              key: task.id,
              className: 'dsn-row'
                + (task.important ? ' dsn-important' : '')
                + (dragIndex === index ? ' dsn-rowDragging' : ''),
              'data-dsn-row': true,
              'data-index': index,
              title: task.text,
            },
              h('button', {
                type: 'button',
                className: 'dsn-circle',
                title: t('a11y.complete', { text: task.text }),
                'aria-label': t('a11y.complete', { text: task.text }),
                onClick: () => completeTask(task.id),
              }, h(GlyphCheck)),
              editing !== null && editing.id === task.id
                ? h('input', {
                  className: 'dsn-input dsn-rowInput',
                  value: editing.value,
                  autoFocus: true,
                  'aria-label': t('a11y.edit', { text: task.text }),
                  onChange: (event) => setEditing({ id: task.id, value: event.target.value }),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitEdit()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      setEditing(null)
                    }
                  },
                  onBlur: commitEdit,
                })
                : h('button', {
                  type: 'button',
                  className: 'dsn-text',
                  title: task.text,
                  'aria-label': t('a11y.edit', { text: task.text }),
                  onClick: () => setEditing({ id: task.id, value: task.text }),
                }, task.text),
              h('button', {
                type: 'button',
                className: 'dsn-flag',
                'aria-pressed': task.important,
                title: task.important ? t('a11y.unimportant', { text: task.text }) : t('a11y.important', { text: task.text }),
                'aria-label': task.important ? t('a11y.unimportant', { text: task.text }) : t('a11y.important', { text: task.text }),
                onClick: () => toggleImportant(task.id),
              }, '!'),
              h('span', {
                className: 'dsn-grip',
                role: 'button',
                tabIndex: 0,
                title: t('a11y.drag', { text: task.text }),
                'aria-label': t('a11y.drag', { text: task.text }),
                onPointerDown: (event) => startRowDrag(index, event),
                onKeyDown: (event) => {
                  if (event.key === 'ArrowUp' && event.altKey && index > 0) {
                    event.preventDefault()
                    moveTask(index, index - 1)
                  } else if (event.key === 'ArrowDown' && event.altKey && index < tasks.length - 1) {
                    event.preventDefault()
                    moveTask(index, index + 1)
                  }
                },
              }, h(GlyphGrip)),
            )),
          )
          : h('div', { className: 'dsn-empty' }, t('user.empty')),
        h('form', {
          className: 'dsn-add',
          onSubmit: (event) => {
            event.preventDefault()
            addTask(draft)
            setDraft('')
          },
        },
          h('input', {
            className: 'dsn-input',
            value: draft,
            placeholder: t('add.placeholder'),
            'aria-label': t('add.placeholder'),
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setDraft('')
              }
            },
          }),
          h('button', {
            type: 'submit',
            className: 'dsn-addBtn',
            title: t('add.action'),
            'aria-label': t('add.action'),
          }, h(GlyphPlus)),
        ),
      )

      return h('section', {
        ref: rootRef,
        popover: 'manual',
        className: 'dsn-root' + (dragging ? ' dsn-dragging' : ''),
        style: { right: pos.right + 'px', top: pos.top + 'px' },
        'aria-label': t('title'),
      },
        h('header', {
          className: 'dsn-header',
          onPointerDown: (event) => {
            const target = event.target
            if (target !== null && target.closest !== undefined && target.closest('button') !== null) return
            startWidgetDrag(event, false)
          },
          onPointerMove: onWidgetPointerMove,
          onPointerUp: onWidgetPointerUp,
          onPointerCancel: onWidgetPointerUp,
        },
          h('span', { className: 'dsn-gripMark', 'aria-hidden': true }, h(GlyphGrip)),
          h('span', { className: 'dsn-title' }, t('title')),
          h('span', { className: 'dsn-summary', title: summary }, summary),
          h('button', {
            type: 'button',
            className: 'dsn-iconBtn',
            title: t('a11y.collapse'),
            'aria-label': t('a11y.collapse'),
            onPointerDown: (event) => event.stopPropagation(),
            onClick: () => noteStore.update((value) => ({ ...value, collapsed: true })),
          }, h(GlyphChevronUp)),
        ),
        h('div', { className: 'dsn-body' }, aiSection, userSection),
      )
    }

    /* ------------------------------------------------------------------ *
     * Plugin definition
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const removeStyle = installStyle()
          const removeZh = ctx.locale.register(NS, 'zh', ZH)
          const removeEn = ctx.locale.register(NS, 'en', EN)
          return () => {
            removeZh()
            removeEn()
            if (removeStyle !== null) removeStyle()
          }
        })

        let bound = (key) => key
        try {
          bound = ctx.locale.bind(NS)
        } catch (error) {
          console.warn('[task-note] locale namespace not bound:', error)
        }
        /**
         * @param {string} key dictionary key.
         * @param {Record<string, unknown> | undefined} params optional substitutions.
         * @returns {string} localized text.
         */
        const translate = (key, params) => {
          let value
          try {
            value = bound(key, params)
          } catch (error) {
            value = undefined
          }
          if (typeof value === 'string' && value !== key) return value
          let localeId = ''
          try {
            localeId = String((ctx.locale.getLocale() || {}).active || '')
          } catch (error) {
            localeId = ''
          }
          const table = localeId.toLowerCase().startsWith('zh') ? ZH : EN
          const template = typeof table[key] === 'string' ? table[key] : key
          return format(template, params)
        }

        const noteEntry = (props) => h(TaskNote, Object.assign({}, props, { t: translate }))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'task-note',
          order: 100,
          locale: NS,
        }, noteEntry))

        // Reusing the shipped `todo` cell replaces the built-in task list above the
        // composer; the replacement renders nothing because this note owns the list.
        // A lower priority shadows the shipped entry (priority 0): the lowest renders.
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'todo',
          order: 0,
          priority: -1,
          locale: NS,
        }, TodoBridge))
      },
    }
  },
})
