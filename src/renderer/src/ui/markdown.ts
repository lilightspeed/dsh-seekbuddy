/**
 * 轻量 markdown → DOM 渲染(主页消息条/浮层用)。
 *
 * 安全纪律:所有用户文本一律经 textContent 写入,元素白名单由本文件代码控制,
 * 绝不 innerHTML 拼接来源文本 —— 无 XSS 面。
 *
 * 覆盖:代码块(```)、行内代码、**粗体**、*斜体*、[文本](链接)、标题、列表、引用。
 * 降级:表格等未支持语法原样显示;链接只显示文本(宠物窗口无导航,不生成 <a>);
 * 未闭合代码块 fence 容忍为"余下全部是代码"。
 */

/** 行内解析:依次识别 `code`、**bold**、*italic*、[text](url),其余原样。 */
function appendInline(parent: Node, text: string): void {
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)))
    const [full, code, bold, italic, link] = m
    if (code) {
      const el = document.createElement('code')
      el.textContent = code.slice(1, -1)
      parent.appendChild(el)
    } else if (bold) {
      const el = document.createElement('strong')
      el.textContent = bold.slice(2, -2)
      parent.appendChild(el)
    } else if (italic) {
      const el = document.createElement('em')
      el.textContent = italic.slice(1, -1)
      parent.appendChild(el)
    } else if (link) {
      const inner = link.match(/^\[([^\]]+)\]\([^)]*\)$/)
      parent.appendChild(document.createTextNode(inner?.[1] ?? full))
    }
    last = m.index + full.length
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)))
}

/**
 * 完整渲染(浮层用):代码块/标题/列表/引用/段落 → 块级元素。
 */
export function markdownToDom(text: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    // 代码块:```lang … ```(未闭合 → 余下全部按代码)
    const fence = line.match(/^```(\w*)/)
    if (fence) {
      const lang = fence[1] ?? ''
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i] ?? '')) {
        buf.push(lines[i] ?? '')
        i++
      }
      if (i < lines.length) i++ // 跳过闭合 fence
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      if (lang) code.className = `lang-${lang}`
      code.textContent = buf.join('\n')
      pre.appendChild(code)
      frag.appendChild(pre)
      continue
    }
    // 空行:段落间距
    if (line.trim() === '') {
      i++
      continue
    }
    // 标题 → 加粗段落
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const p = document.createElement('p')
      p.className = 'md-heading'
      appendInline(p, heading[2] ?? '')
      frag.appendChild(p)
      i++
      continue
    }
    // 列表
    const list = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/)
    if (list) {
      const p = document.createElement('p')
      p.className = 'md-list'
      const mark = document.createElement('span')
      mark.className = 'md-bullet'
      mark.textContent = /^\d/.test(list[1] ?? '') ? `${list[1]} ` : '• '
      p.appendChild(mark)
      appendInline(p, list[2] ?? '')
      frag.appendChild(p)
      i++
      continue
    }
    // 引用
    const quote = line.match(/^\s*>\s?(.*)$/)
    if (quote) {
      const p = document.createElement('p')
      p.className = 'md-quote'
      appendInline(p, quote[1] ?? '')
      frag.appendChild(p)
      i++
      continue
    }
    // 普通段落
    const p = document.createElement('p')
    p.className = 'md-para'
    appendInline(p, line)
    frag.appendChild(p)
    i++
  }
  return frag
}

/**
 * 单行预览(消息条用):换行折叠为空格后做行内渲染 —— 粗体/行内代码有效果,
 * 代码块 fence 原样出现(单行预览可接受)。
 */
export function markdownToInline(text: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  appendInline(frag, text.replace(/\s*\n\s*/g, ' ').trim())
  return frag
}
