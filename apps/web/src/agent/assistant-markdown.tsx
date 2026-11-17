import { memo } from "react"
import { cjk } from "@streamdown/cjk"
import { Streamdown, defaultRehypePlugins, type Components } from "streamdown"
import "streamdown/styles.css"
import "./assistant-markdown.css"

const plugins = { cjk }
const animation = { animation: "fadeIn", duration: 180, easing: "ease-out", sep: "char", stagger: 0 } as const
const remend = { linkMode: "text-only", katex: false } as const
// No raw HTML, external images or model-supplied UI. Only explicit web/mail links are actionable.
const rehypePlugins = [defaultRehypePlugins.sanitize!]
const components: Components = {
  h1: "h1", h2: "h2", h3: "h3", h4: "h4", h5: "h5", h6: "h6",
  p: "p", strong: "strong", ul: "ul", ol: "ol", li: "li", hr: "hr", blockquote: "blockquote",
  table: ({ children }) => <div className="assistant-table-scroll"><table>{children}</table></div>,
  thead: "thead", tbody: "tbody", tr: "tr", th: "th", td: "td",
  pre: ({ children }) => <pre>{children}</pre>,
  code: ({ children }) => <code>{children}</code>,
  inlineCode: ({ children }) => <code>{children}</code>,
  img: ({ alt }) => <>{alt}</>,
  a: ({ href, children }) => href && (/^(?:https?:\/\/|mailto:)/i.test(href) || /^\/review-deletion\/[a-f0-9-]{36}$/.test(href))
    ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <>{children}</>,
}

/** One renderer per timeline segment. In live mode Streamdown memoizes settled blocks
 * and repairs the unfinished tail for display only. Snapshots/history use the exact source. */
export const AssistantMarkdown = memo(function AssistantMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  return <Streamdown className="assistant-markdown space-y-0" mode={streaming ? "streaming" : "static"}
    isAnimating={streaming} parseIncompleteMarkdown={streaming} animated={animation} remend={remend}
    plugins={plugins} components={components} rehypePlugins={rehypePlugins} skipHtml controls={false}>
    {text}
  </Streamdown>
})
