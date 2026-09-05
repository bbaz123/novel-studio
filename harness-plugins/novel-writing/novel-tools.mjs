/**
 * novel-tools — Novel Studio 创作内核的 dsh 模型工具集。
 *
 * 本文件是 dsh 侧插件的唯一来源（headless profile 与 GUI preset 共用，
 * 由 harness-plugins/novel-writing/install.ps1 安装到 ~/.dsh 对应位置）。
 * 工具通过 novel-studio 本地 HTTP API（默认 http://127.0.0.1:3737）读写创作数据：
 *
 *  - novel_works          列出作品（确认 work_id）
 *  - novel_context        写作前取“ST 式分层上下文”（大纲/记忆/事件/伏笔/场景/角色卡/世界观/红线）
 *  - novel_lookup         按关键词检索角色/词条/章节/剧情线
 *  - novel_foreshadows    列出未闭合（或全部）伏笔
 *  - novel_foreshadow_update 标记伏笔状态（resolved/dropped/open，可回链回收事件）
 *  - novel_consistency    生成后核对：未闭合伏笔/出场角色状态/最近事件 vs 本章正文
 *  - novel_scan           对一段正文做确定性“反 AI 腔”红线扫描（可跳过引号内对话）
 *  - novel_style_contract 读取当前写作红线清单（风格契约）
 *  - novel_event_add      关键剧情/伏笔/状态变化写入事件账本（支持伏笔状态与回收、去重）
 *  - novel_memory_update  长期记忆增量/压缩提交（带版本快照，可回滚）
 *  - novel_chapter_save   把成稿写回章节正文（旧稿自动存历史版本，返回红线扫描）
 *
 * 身份：当本进程由 novel-studio 的 /api/harness/run 启动时，环境变量
 * NOVELSTUDIO_WORK_ID / NOVELSTUDIO_CHAPTER_ID / NOVELSTUDIO_MODE 已注入，
 * 工具会自动回退到它们；交互会话里可在调用参数中直接传 work_id。
 *
 * 提案模式：/api/harness/run 启动的任务带 NOVELSTUDIO_PROPOSE_MODE=1，
 * novel_event_add / novel_memory_update 会先把入账写成提案（不直接写入作品账本），
 * 由作者在 novel-studio 界面确认后生效。
 */

export const name = 'novel-tools'
export const inject = ['tools']
export const PLUGIN_VERSION = '0.7.0'

const DEFAULT_BASE = 'http://127.0.0.1:3737'

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

export function apply(ctx, config) {
  const baseOf = () => (config && config.baseUrl) || process.env.NOVELSTUDIO_BASE_URL || DEFAULT_BASE
  const proposeMode = () => process.env.NOVELSTUDIO_PROPOSE_MODE === '1'

  // 严格 JSON 客户端：连接失败/非 2xx/非 JSON 都给出可读错误，不把异常静默成 {raw}。
  async function jfetch(path, options = {}) {
    const base = baseOf()
    let res
    try {
      res = await fetch(base + path, {
        method: options.method || 'GET',
        headers: { 'content-type': 'application/json' },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(options.timeout || 25000),
      })
    } catch (e) {
      throw new Error(`无法连接 novel-studio（${base}）：请确认小说工坊服务已启动（npm start）。详情：${e.message}`)
    }
    const text = await res.text()
    if (!res.ok) {
      let detail = text
      try { detail = JSON.parse(text)?.error || detail } catch (_) { /* 保留原文 */ }
      throw new Error(`novel-studio ${res.status} ${path}: ${String(detail).slice(0, 300)}`)
    }
    if (!text) return {}
    try {
      return JSON.parse(text)
    } catch (_) {
      throw new Error(`novel-studio 返回了非 JSON 响应（${path}）：${text.slice(0, 200)}`)
    }
  }

  const envId = (args, key) => (args[key] !== undefined && args[key] !== null && args[key] !== '')
    ? args[key]
    : (process.env[`NOVELSTUDIO_${key.toUpperCase()}`] || undefined)

  function identitySuffix(workId, chapterId, mode) {
    const parts = []
    if (workId !== undefined) parts.push(`work_id=${encodeURIComponent(workId)}`)
    if (chapterId !== undefined) parts.push(`chapter_id=${encodeURIComponent(chapterId)}`)
    if (mode !== undefined) parts.push(`mode=${encodeURIComponent(mode)}`)
    return parts.length ? `?${parts.join('&')}` : ''
  }

  function register(name, description, parameters, execute) {
    ctx.tools.register({
      name,
      description,
      parameters: { type: 'object', properties: parameters, additionalProperties: false },
      output: textOutput,
      async execute(args) {
        const text = await execute(args)
        return { text: String(text ?? '') }
      },
    })
  }

  register('novel_works', [
    '列出 novel-studio 里的全部作品（id + 标题）。',
    '适合在本会话开始创作前确认要操作的 work_id；也可用 novel_lookup 检索具体设定。',
  ].join('\n'), {
    includeDescription: { type: 'boolean', description: '可选：为 true 时附带作品简介首行。' },
  }, async (args) => {
    const works = await jfetch('/api/works')
    const list = Array.isArray(works) ? works : []
    if (!list.length) return 'novel-studio 里还没有作品。请先在 novel-studio 网页创建作品，或确认服务已启动（http://127.0.0.1:3737）。'
    return '作品列表：\n' + list.map((w) => {
      const desc = args.includeDescription && w.description ? `（${String(w.description).slice(0, 80)}）` : ''
      return `${w.id}. ${w.title}${desc}`
    }).join('\n')
  })

  register('novel_context', [
    '写作前调用：取指定作品/章节的完整创作上下文（ST 式分层装配，每层有独立预算，超长会注明截断）。',
    '包含：卷/剧情线/章节进度大纲、长期记忆摘要（过长时会标注建议压缩）、最近事件账本、未闭合伏笔、当前场景与前后章衔接、出场角色卡（含对话示例与角色系统提示）、人物关系、按优先级激活的世界观词条、写作风格红线。',
    'output 的 assembled 字段就是可直接读入的整块上下文。',
    'work_id/chapter_id 缺省时自动使用进程注入的身份（由 novel-studio 启动的任务自带）。mode: full=整章代写/分析, continuation=接龙续写, fragment=片段补写。',
    '若任务提示词里已内联提供了同样的上下文（由 novel-studio 网页启动的任务通常如此），不必重复调用本工具，用 novel_lookup 按需补查即可。',
  ].join('\n'), {
    work_id: { type: 'string', description: '作品 id（可选，缺省用环境身份）' },
    chapter_id: { type: 'string', description: '章节 id（可选）' },
    mode: { type: 'string', description: 'full | continuation | fragment（默认 full）' },
  }, async (args) => {
    const workId = envId(args, 'work_id')
    if (workId === undefined) {
      const works = await jfetch('/api/works')
      if (!Array.isArray(works) || !works.length) throw new Error('未提供 work_id，且 novel-studio 中暂无作品（novel_works 可查看）')
      throw new Error('未提供 work_id，请先用 novel_works 确认作品 id，或在参数中给出 work_id')
    }
    const chapterId = envId(args, 'chapter_id')
    const mode = args.mode || process.env.NOVELSTUDIO_MODE || 'full'
    const ctx = await jfetch(`/api/novel/context${identitySuffix(workId, chapterId, mode)}`)
    if (!ctx.ok) throw new Error('novel-studio 返回异常')
    const head = `作品：${ctx.work.title}${ctx.chapter ? `｜当前章节：第${ctx.chapter.position + 1}节 ${ctx.chapter.title}` : ''}（mode=${ctx.mode}）`
    const body = ctx.assembled || JSON.stringify(ctx)
    // 服务端已做分层预算收敛（总预算 26000 字），这里不再盲截断，避免砍掉末尾的红线/角色卡层。
    return `${head}\n\n${body}`
  })

  register('novel_lookup', [
    '需要临时核实设定时调用：按关键词检索角色/设定词条/章节/剧情线（一次最多各 8 条）。',
    '写正文前若上下文未覆盖某设定，用它查证，避免凭记忆写错。',
  ].join('\n'), {
    query: { type: 'string', description: '要查的关键词（角色名、地名、物品、事件等）' },
    work_id: { type: 'string', description: '作品 id（可选，缺省用环境身份）' },
    kind: { type: 'string', description: '可选过滤：character | term | chapter | plotline' },
  }, async (args) => {
    const query = String(args.query || '').trim()
    if (!query) throw new Error('缺少 query')
    const workId = envId(args, 'work_id')
    const data = await jfetch(`/api/search?q=${encodeURIComponent(query)}${workId !== undefined ? `&work_id=${encodeURIComponent(workId)}` : ''}`)
    const out = []
    const pick = (list) => (Array.isArray(list) ? list.slice(0, 8) : [])
    const kind = args.kind
    if (!kind || kind === 'character') {
      const chars = pick(data.characters)
      if (chars.length) out.push('角色：\n' + chars.map((c) => `- ${c.name}（${c.identity || ''}）${c.status ? `｜当前状态：${c.status}` : ''}`).join('\n'))
    }
    if (!kind || kind === 'term') {
      const terms = pick(data.terms)
      if (terms.length) out.push('设定词条：\n' + terms.map((t) => `- 【${t.title}】${String(t.content || '').slice(0, 200)}`).join('\n'))
    }
    if (!kind || kind === 'chapter') {
      const chs = pick(data.chapters)
      if (chs.length) out.push('章节：\n' + chs.map((c) => `- ${c.title}${c.summary ? `：${String(c.summary).slice(0, 120)}` : ''}`).join('\n'))
    }
    if (!kind || kind === 'plotline') {
      const pls = pick(data.plotlines)
      if (pls.length) out.push('剧情线：\n' + pls.map((p) => `- ${p.title}（${p.kind === 'side' ? '支线' : '主线'}）${p.summary ? `：${String(p.summary).slice(0, 120)}` : ''}`).join('\n'))
    }
    if (!out.length) return `未检索到与“${query}”相关的内容。`
    return out.join('\n\n')
  })

  register('novel_foreshadows', [
    '列出作品里的伏笔。默认只列“未闭合”的（foreshadow_status 非 resolved/dropped），',
    '续写前用它与 novel_consistency 一起检查“哪些欠账还没还”；status=all 可查看全部伏笔。',
    '每个伏笔带 id，回收时在 novel_event_add 里用 resolves_event_id 指向它。',
  ].join('\n'), {
    work_id: { type: 'string', description: '作品 id（可选，缺省用环境身份）' },
    status: { type: 'string', description: 'open（默认，未闭合）| all（含已回收）' },
  }, async (args) => {
    const workId = envId(args, 'work_id')
    if (workId === undefined) throw new Error('未提供 work_id')
    const status = args.status === 'all' ? 'all' : 'open'
    const data = await jfetch(`/api/novel/foreshadows?work_id=${encodeURIComponent(workId)}&status=${status}`)
    const rows = Array.isArray(data.foreshadows) ? data.foreshadows : []
    if (!rows.length) return status === 'all' ? '该作品还没有伏笔记录。' : '✅ 当前没有未闭合的伏笔。'
    return `【${status === 'all' ? '全部伏笔' : '未闭合伏笔'}】\n` + rows.map((f) =>
      `#${f.id} ${f.summary}${f.foreshadow_status === 'resolved' ? '（已回收）' : f.foreshadow_status === 'dropped' ? '（已废弃）' : '（未闭合）'}${f.resolves_event_id ? ` → 回收事件 #${f.resolves_event_id}` : ''}`
    ).join('\n')
  })

  register('novel_foreshadow_update', [
    '标记某条伏笔的状态：resolved=已回收（可同时用 resolves_event_id 回链回收事件）、dropped=废弃不再回收、open=恢复未闭合。',
    '伏笔 id 见 novel_foreshadows 的 #id；正文确认废弃/回收某伏笔后调用，让账本与正文一致。',
    '注意：正文回收伏笔时更推荐用 novel_event_add（kind=event + resolves_event_id），它会把“回收这件事”也记进事件账本；',
    '本工具用于作者明确要求直接改状态（如废弃、恢复）的场景。',
  ].join('\n'), {
    id: { type: 'number', description: '伏笔 id（见 novel_foreshadows 返回的 #id）' },
    status: { type: 'string', description: 'open | resolved | dropped（必填）' },
    resolves_event_id: { type: 'number', description: '可选：回收该伏笔的事件 id（status=resolved 时回链）' },
  }, async (args) => {
    const id = Number(args.id)
    if (!id) throw new Error('缺少 id：伏笔 id 见 novel_foreshadows 返回的 #id')
    const status = String(args.status || '')
    if (!['open', 'resolved', 'dropped'].includes(status)) throw new Error('status 必须是 open/resolved/dropped')
    const data = await jfetch(`/api/novel/foreshadows/${id}/status`, {
      method: 'POST',
      body: { status, resolves_event_id: Number(args.resolves_event_id) || null }
    })
    const label = status === 'resolved' ? '已回收' : status === 'dropped' ? '已废弃' : '恢复为未闭合'
    return `伏笔 #${data.id} 已标记为「${label}」。`
  })

  register('novel_consistency', [
    '成文后核对一致性：把本章正文 text 与工坊里的“未闭合伏笔 / 出场角色当前状态 / 最近事件账本 / 长期记忆 / 红线扫描”逐项对照。',
    '返回的是确定性装配的核对清单，你需要逐项判断：正文有没有与既有设定/角色状态冲突、有没有误回收或漏掉的伏笔、有没有把“未发生”的事写成既成事实。',
    '发现冲突时向作者报告：冲突点、依据（来自哪条事件/状态）、建议改法；没有冲突也要明确说“已核对”。',
    '适用于整章成文后的自检，也适用于润色/扩写后的复查。',
  ].join('\n'), {
    work_id: { type: 'string', description: '作品 id（可选，缺省用环境身份）' },
    chapter_id: { type: 'string', description: '归属章节 id（可选）' },
    text: { type: 'string', description: '要核对的正文全文' },
  }, async (args) => {
    const workId = envId(args, 'work_id')
    if (workId === undefined) throw new Error('未提供 work_id')
    const text = String(args.text || '')
    if (!text.trim()) throw new Error('缺少 text：需要把成文后的正文传进来核对')
    const chapterId = envId(args, 'chapter_id')
    const data = await jfetch('/api/novel/consistency', {
      method: 'POST',
      body: { work_id: workId, chapter_id: chapterId, text },
    })
    const c = data.checklist || {}
    const fores = Array.isArray(c.open_foreshadows) ? c.open_foreshadows : []
    const chars = Array.isArray(c.present_characters) ? c.present_characters : []
    const events = Array.isArray(c.recent_events) ? c.recent_events : []
    const lines = ['【一致性核对清单 · 请逐项对照正文判断并报告冲突】']
    if (fores.length) {
      lines.push('\n未闭合伏笔（正文若回收了其中某条，应显式呼应并在 novel_event_add 里用 resolves_event_id 标记）：')
      fores.forEach((f) => lines.push(`- #${f.id} ${f.summary}`))
    } else {
      lines.push('\n未闭合伏笔：无')
    }
    if (chars.length) {
      lines.push('\n正文出场角色及其当前状态（检查人物状态/性格/说话方式是否一致）：')
      chars.forEach((c) => lines.push(`- ${c.name}｜${c.identity || '身份未填'}｜当前状态：${c.status || '未填'}`))
    } else {
      lines.push('\n正文出场角色：未能按姓名匹配到角色卡（可能为全新角色，提醒作者确认）')
    }
    if (events.length) {
      lines.push('\n最近事件账本（检查正文是否与此前发生的事冲突）：')
      events.forEach((e) => lines.push(`- [${e.kind}] ${e.summary.slice(0, 160)}`))
    }
    if (c.story_memory) {
      lines.push('\n长期记忆摘要：')
      lines.push(c.story_memory.slice(0, 1200))
    }
    const scan = c.style_scan || {}
    lines.push(`\n风格红线扫描：${scan.total ? `命中 ${scan.total} 处` : '未命中'}`)
    lines.push('\n请输出核对结论：先一句总结，再列冲突项（如有），每项附依据与建议改法；没有冲突则明确说明。')
    return lines.join('\n')
  })

  register('novel_scan', [
    '对一段正文做确定性“反 AI 腔”红线扫描（词/句式/正则三类，返回命中条目与出现次数、示例上下文）。',
    '写作完成或润色后调用，把命中条目作为自检报告；命中较多时应主动改写后重扫。',
    'skip_dialogue=true 时先剥掉引号内对话再扫：角色台词里的口语词不应按叙述标准误杀。',
    '注意：若任务响应已附 scan 报告（novel-studio 网页启动的任务通常如此），不必重复调用本工具。',
  ].join('\n'), {
    text: { type: 'string', description: '要检查的正文文本' },
    work_id: { type: 'string', description: '作品 id（可选，缺省用环境身份/全局红线）' },
    skip_dialogue: { type: 'boolean', description: '跳过引号内对话（默认 false）' },
  }, async (args) => {
    const text = String(args.text || '')
    if (!text.trim()) throw new Error('缺少 text')
    const workId = envId(args, 'work_id')
    const data = await jfetch('/api/novel/scan', { method: 'POST', body: { work_id: workId, text, skip_dialogue: args.skip_dialogue === true } })
    const hits = Array.isArray(data.hits) ? data.hits : []
    if (!hits.length) return '红线扫描通过：未命中任何反 AI 腔条目。'
    const lines = hits.map((h) => `- ${h.pattern}（${h.kind}）x${h.count}${h.sample ? `\n  示例：…${String(h.sample).slice(0, 80)}…` : ''}`)
    return `红线扫描命中 ${data.total} 处（建议改写后重扫）：\n${lines.join('\n')}`
  })

  register('novel_style_contract', [
    '读取当前生效的写作风格契约（反 AI 腔红线清单：慎用词/慎用句式/句式模式）。',
    '写作、润色前若不确定红线内容可调用；上下文里通常已含该段，非必需。',
  ].join('\n'), {
    work_id: { type: 'string', description: '作品 id（可选，缺省用环境身份/全局红线）' },
  }, async (args) => {
    const workId = envId(args, 'work_id')
    const data = await jfetch(`/api/novel/redlines${workId !== undefined ? `?work_id=${encodeURIComponent(workId)}` : ''}`)
    const rows = Array.isArray(data.redlines) ? data.redlines : []
    if (!rows.length) return '当前未启用任何红线规则。'
    const lines = rows.map((r) => `- [${r.kind === 'regex' ? '句式模式' : r.kind === 'word' ? '慎用词' : '慎用句式'}] ${r.pattern}${r.note ? `（${r.note}）` : ''}`)
    return '【写作风格红线 · 反 AI 腔】写作时主动避免以下词句，需要更具体、更有画面感的写法：\n' + lines.join('\n')
  })

  register('novel_event_add', [
    '把“已发生的关键剧情/新伏笔/角色状态变化/设定变更”写入作品事件账本，供长期记忆与后续一致性维护使用。',
    '仅在正文确认生成/采纳后调用，避免污染账本。',
    '伏笔用法：新埋伏笔传 kind="foreshadow"（foreshadow_status 默认 open）；正文回收某伏笔时，',
    '传 kind="event" + resolves_event_id=该伏笔的 #id，服务端会自动把它标记为 resolved。',
    'dedup_key：同一事件的幂等键（如“ch12-mother-dies”），重复提交不会重复入账。',
    '提案模式说明：由 novel-studio 网页启动的任务，本调用会先写成提案，由作者在工坊界面确认后入账——这是正常行为，不要重复调用。',
  ].join('\n'), {
    work_id: { type: 'string', description: '作品 id（可选，缺省用环境身份）' },
    chapter_id: { type: 'string', description: '归属章节 id（可选）' },
    kind: { type: 'string', description: 'event | foreshadow | status_change | setting_change（默认 event）' },
    summary: { type: 'string', description: '一句话事件描述' },
    payload: { type: 'object', description: '可选结构化细节（角色、物品等）' },
    foreshadow_status: { type: 'string', description: '伏笔状态（open | resolved | dropped，仅 kind=foreshadow 有意义）' },
    resolves_event_id: { type: 'number', description: '本事件回收的伏笔 id（见 novel_foreshadows）' },
    dedup_key: { type: 'string', description: '可选幂等键，同一事件重复提交只入账一次' },
  }, async (args) => {
    const workId = envId(args, 'work_id')
    if (workId === undefined) throw new Error('未提供 work_id')
    const summary = String(args.summary || '').trim()
    if (!summary) throw new Error('缺少 summary')
    const chapterId = envId(args, 'chapter_id')
    const body = {
      work_id: workId,
      chapter_id: chapterId,
      kind: args.kind || 'event',
      summary,
      payload: args.payload || {},
      foreshadow_status: args.foreshadow_status || '',
      resolves_event_id: args.resolves_event_id || null,
      dedup_key: args.dedup_key || '',
      proposed: proposeMode()
    }
    const data = await jfetch('/api/novel/events', { method: 'POST', body })
    if (data.proposed) return `已记为提案 #${data.proposal_id}：${summary}（作者在 novel-studio 界面确认后入账）`
    if (data.duplicate) return `事件已存在（#${data.id}），按 dedup_key 跳过重复入账：${summary}`
    return `已记录事件 #${data.id}：${summary}`
  })

  register('novel_memory_update', [
    '把一段创作后“已发生的故事进展”并入作品长期记忆（自动写版本快照，可在 novel-studio 回滚）。',
    '两种用法：1) 你已看过旧摘要，自行把“旧摘要+新进展”合并压缩为 ≤800 字的新摘要，传 summary；2) 只传 delta 让服务端简单追加（会用【此前进度】分段，提示后续压缩）。',
    '若上下文里的长期记忆已超过 1200 字压缩提示线，本次应优先传压缩后的 summary。',
    '提交前请保证内容反映正文已确认发生的事件，而不是计划。',
    '提案模式说明：由 novel-studio 网页启动的任务，本调用会先写成提案，由作者在工坊界面确认后写入——这是正常行为，不要重复调用。',
  ].join('\n'), {
    work_id: { type: 'string', description: '作品 id（可选，缺省用环境身份）' },
    summary: { type: 'string', description: '合并压缩后的完整新摘要（与 delta 二选一）' },
    delta: { type: 'string', description: '本次进展的增量描述（与 summary 二选一）' },
    note: { type: 'string', description: '备注（如“第12章后”）' },
  }, async (args) => {
    const workId = envId(args, 'work_id')
    if (workId === undefined) throw new Error('未提供 work_id')
    if (!String(args.summary || '').trim() && !String(args.delta || '').trim()) throw new Error('需要 summary 或 delta 至少一个')
    const data = await jfetch('/api/story_memory', {
      method: 'PUT',
      body: {
        work_id: workId,
        summary: args.summary || '',
        delta: args.summary ? undefined : args.delta || '',
        source: 'auto',
        note: args.note || 'dsh 创作插件提交',
        proposed: proposeMode()
      },
    })
    if (data.proposed) return `长期记忆更新已记为提案 #${data.proposal_id}（作者在 novel-studio 界面确认后写入并留版本快照）`
    const extra = data.version_id ? `（版本 #${data.version_id}，可回滚）` : ''
    if (data.summary === '') return '记忆更新为空（与旧摘要相同则自动跳过）'
    const hint = data.needs_compression ? '｜⚠ 当前摘要已超压缩提示线，建议下次优先压缩合并' : ''
    return `长期记忆已更新${extra}${hint}，当前摘要（前 ${120} 字）：${String(data.summary || '').slice(0, 120)}`
  })

  register('novel_review', [
    '把成文的审稿报告保存到章节（审稿→确认清单→修稿→差异合并闭环的记录锚点）。',
    '用法：作者要求审稿时，先对照上下文输出审稿报告给作者（总评 + 问题逐条 + 优点），作者确认后调用本工具保存。',
    'report 参数：{ summary: "总评", issues: ["问题描述1", ...], strengths: ["优点1", ...] }。',
    '保存后作者可在 novel-studio 界面逐条确认/忽略并按清单修稿。',
  ].join('\n'), {
    work_id: { type: 'string', description: '作品 id（可选，缺省用环境身份）' },
    chapter_id: { type: 'string', description: '章节 id（必填）' },
    summary: { type: 'string', description: '审稿总评（两三句）' },
    issues: { type: 'string', description: '问题清单，每条一行' },
    strengths: { type: 'string', description: '优点，每条一行（可选）' },
  }, async (args) => {
    const workId = envId(args, 'work_id')
    const chapterId = envId(args, 'chapter_id')
    if (chapterId === undefined) throw new Error('缺少 chapter_id')
    const report = {
      summary: String(args.summary || ''),
      issues: String(args.issues || '').split(/\n+/).map((s) => s.trim()).filter(Boolean),
      strengths: String(args.strengths || '').split(/\n+/).map((s) => s.trim()).filter(Boolean)
    }
    if (!report.summary.trim() && !report.issues.length) throw new Error('审稿报告不能为空')
    const data = await jfetch('/api/novel/review', {
      method: 'PUT',
      body: { work_id: workId, chapter_id: chapterId, report },
      timeout: 30000
    })
    return `审稿报告已保存（review #${data.review_id}）：${report.issues.length} 条问题，作者可在工坊界面确认清单并修稿。`
  })

  register('novel_blueprint', [
    '把“本章写作蓝图”保存到章节（写前规划，落库后随上下文带入、一致性核对以其为锚点）。',
    '用法：先把蓝图草稿发给作者确认（场景目标/情节点/冲突与转折/角色状态变化/钩子/需回扣的设定），作者同意后再调用本工具保存。',
    'target_words 可选：本章目标字数，不传则用作品默认（每章目标字数）。',
    '蓝图应只覆盖“一章”的容量：情节点 3-8 条，能撑起整章篇幅但不越章。',
  ].join('\n'), {
    work_id: { type: 'string', description: '作品 id（可选，缺省用环境身份）' },
    chapter_id: { type: 'string', description: '章节 id（必填）' },
    scene_goal: { type: 'string', description: '本场景目标（一句话）' },
    plot_points: { type: 'string', description: '情节点，3-8 条，每条一行' },
    conflicts: { type: 'string', description: '冲突与转折' },
    character_changes: { type: 'string', description: '出场角色状态变化' },
    hook: { type: 'string', description: '下一章钩子' },
    references: { type: 'string', description: '需要回扣的既有设定/伏笔' },
    target_words: { type: 'number', description: '本章目标字数（可选，缺省用作品默认）' },
  }, async (args) => {
    const workId = envId(args, 'work_id')
    const chapterId = envId(args, 'chapter_id')
    if (chapterId === undefined) throw new Error('缺少 chapter_id：请先用 novel_context/novel_works 确认章节')
    const blueprint = {
      scene_goal: String(args.scene_goal || ''),
      plot_points: String(args.plot_points || ''),
      conflicts: String(args.conflicts || ''),
      character_changes: String(args.character_changes || ''),
      hook: String(args.hook || ''),
      references: String(args.references || '')
    }
    if (!Object.values(blueprint).some((v) => v.trim())) throw new Error('蓝图内容不能为空')
    const data = await jfetch('/api/novel/chapter_blueprint', {
      method: 'PUT',
      body: { work_id: workId, chapter_id: chapterId, blueprint, target_words: Number(args.target_words) || 0 },
      timeout: 30000
    })
    return `章节蓝图已保存（章节 #${data.chapter_id}，目标 ${data.target_words} 字）：场景目标=${blueprint.scene_goal.slice(0, 60) || '—'}。成文时严格按蓝图执行。`
  })

  register('novel_chapter_save', [
    '把成文后的正文写回 novel-studio 的章节。调用前应已获作者同意（例如作者说“保存/写进去”）。',
    '服务端会先把旧稿存为历史版本（可在工坊界面恢复），再覆盖正文，并返回红线扫描结果。',
    'title/summary 不传则保持原样。写回成功后建议照常用 novel_event_add / novel_memory_update 收尾。',
  ].join('\n'), {
    work_id: { type: 'string', description: '作品 id（可选，缺省用环境身份）' },
    chapter_id: { type: 'string', description: '要写回的章节 id（必填）' },
    content: { type: 'string', description: '成文后的正文全文' },
    title: { type: 'string', description: '可选：新章节标题' },
    summary: { type: 'string', description: '可选：新章节摘要' },
  }, async (args) => {
    const workId = envId(args, 'work_id')
    const chapterId = envId(args, 'chapter_id')
    if (chapterId === undefined) throw new Error('缺少 chapter_id：请先用 novel_context/novel_works 确认要写回的章节')
    const content = String(args.content || '')
    if (!content.trim()) throw new Error('缺少 content')
    const data = await jfetch('/api/novel/chapter_save', {
      method: 'POST',
      body: {
        work_id: workId,
        chapter_id: chapterId,
        content,
        title: args.title,
        summary: args.summary
      },
      timeout: 30000
    })
    const scan = data.scan || {}
    return `正文已写回章节 #${data.chapter_id}（旧稿存为历史版本 #${data.version_id}，可恢复）。` +
      `红线扫描：${scan.total ? `命中 ${scan.total} 处（${(scan.hits || []).slice(0, 5).map((h) => `${h.pattern}×${h.count}`).join('、')}）` : '未命中'}。`
  })
}
