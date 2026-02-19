import { ComponentProps, ReactNode, isValidElement, useMemo, useState } from 'react'
import ReactMarkdown, { Components } from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { stripAnsi } from '../lib/openclaw'

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (isValidElement(node)) return extractText((node.props as { children?: ReactNode }).children)
  return ''
}

function CopyablePre({ children, ...props }: ComponentProps<'pre'>) {
  const [copied, setCopied] = useState(false)
  const rawText = useMemo(() => extractText(children), [children])
  const textToCopy = rawText.endsWith('\n') ? rawText.slice(0, -1) : rawText

  const handleCopy = async () => {
    try {
      if (!textToCopy || !navigator.clipboard?.writeText) return
      await navigator.clipboard.writeText(textToCopy)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Ignore clipboard errors (e.g., permission denied).
    }
  }

  return (
    <div className="code-block-wrapper">
      <button
        type="button"
        className={`code-copy-btn${copied ? ' copied' : ''}`}
        aria-label="Copy code"
        onClick={handleCopy}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>
      <pre {...props}>{children}</pre>
    </div>
  )
}

const markdownComponents: Components = {
  pre: CopyablePre,
}

export function SafeMarkdown({ content }: { content: string }) {
  const sanitized = useMemo(() => stripAnsi(content), [content])

  return (
    <div className="markdown-content">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={markdownComponents}
      >
        {sanitized}
      </ReactMarkdown>
    </div>
  )
}
