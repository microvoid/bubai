/**
 * Markdown renderer using Buzz's copied Messages.module.css (.text), CodeFence,
 * observeTableOverflow, and rehypeMarkupNewlines (ported from MessageMarkdown.tsx).
 */
import Markdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import messageStyles from './Messages.module.css';
import { CodeFence, observeTableOverflow } from '../markdown/CodeFence';

type HtmlNode = {
  type: string;
  tagName?: string;
  children?: HtmlNode[];
  value?: string;
};

const blockTags = new Set([
  'p',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'hr',
  'section',
  'table',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

const isBlock = (node: HtmlNode | undefined) =>
  node?.type === 'root' || blockTags.has(node?.tagName ?? '');

/** Bodies keep authored spaces (`white-space: pre-wrap`), so drop the newlines
 * the renderer writes only as markup: between blocks and after a `<br>`. */
function rehypeMarkupNewlines() {
  return function visit(node: HtmlNode) {
    const children = node.children;
    if (!children) return;
    node.children = children.flatMap((child, index) => {
      if (child.type !== 'text') {
        visit(child);
        return [child];
      }
      const before = index ? children[index - 1] : node;
      const after = children[index + 1] ?? node;
      let value = child.value ?? '';
      if (before?.tagName === 'br' || isBlock(before)) {
        value = value.replace(/^\n/, '');
      }
      if (isBlock(after)) {
        value = value.replace(/\n$/, '');
      }
      return value ? [{ ...child, value }] : [];
    });
  };
}

export function BuzzMessageMarkdown({
  content,
  edited = false,
}: {
  content: string;
  edited?: boolean;
}) {
  return (
    <div className={messageStyles.text}>
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeMarkupNewlines]}
        components={{
          pre(props) {
            return <CodeFence {...props} />;
          },
          table({ children, ...props }) {
            return (
              <table ref={observeTableOverflow} {...props}>
                {children}
              </table>
            );
          },
          a({ href, children, ...props }) {
            return (
              <a href={href} target="_blank" rel="noreferrer noopener" {...props}>
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </Markdown>
      {edited && <span className={messageStyles.edited}> (edited)</span>}
    </div>
  );
}
