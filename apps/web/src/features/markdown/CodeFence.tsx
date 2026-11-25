/**
 * Adapted from references/buzz-app/src/features/markdown/code-blocks.tsx
 * Includes Shiki syntax highlighting (github-dark / github-light), language badge,
 * table overflow observer, and CopyIcon button.
 */
import { useEffect, useState, type ComponentProps } from 'react';
import type { ExtraProps } from 'react-markdown';
import { codeToHtml } from 'shiki';
import { labelText } from '../messages/label-text';
import { CheckIcon, CopyIcon } from '../../design-system/icons/index';
import { IconButton } from '../../design-system/ui/IconButton';
import { writeClipboardText } from '../../shared/clipboard';
import styles from './Markdown.module.css';

export function observeTableOverflow(table: HTMLTableElement | null) {
  if (!table || typeof ResizeObserver === 'undefined') return;
  const update = () => {
    const overflow = String(table.scrollWidth > table.clientWidth);
    if (table.dataset.overflow !== overflow) table.dataset.overflow = overflow;
  };
  update();
  const observer = new ResizeObserver(update);
  observer.observe(table);
  const contentObserver = new MutationObserver(update);
  contentObserver.observe(table, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  return () => {
    observer.disconnect();
    contentObserver.disconnect();
  };
}

export function codeLanguage(pre: ExtraProps['node']): string | undefined {
  const code = pre?.children[0];
  if (code?.type !== 'element' || code.tagName !== 'code') return undefined;
  const classes = code.properties.className;
  return Array.isArray(classes)
    ? classes
        .map(String)
        .find((name) => name.startsWith('language-'))
        ?.slice('language-'.length)
    : undefined;
}

export function CodeFence({ node, children, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const [copied, setCopied] = useState(false);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const code = labelText(children).replace(/\n$/, '');
  const lang = codeLanguage(node);

  useEffect(() => {
    if (!lang || !code) {
      setHighlightedHtml(null);
      return;
    }
    let cancelled = false;
    const isLight = document.documentElement.getAttribute('data-color-mode') === 'light';
    void codeToHtml(code, {
      lang,
      theme: isLight ? 'github-light' : 'github-dark',
    })
      .then((html) => {
        if (!cancelled) setHighlightedHtml(html);
      })
      .catch(() => {
        if (!cancelled) setHighlightedHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  const handleCopy = () => {
    void writeClipboardText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className={styles.codeFrame} data-language={lang}>
      <div className={styles.codeActions}>
        {lang && (
          <span
            className="text-caption text-secondary"
            style={{ fontFamily: 'var(--buzz-mono-family)', marginRight: 6 }}
          >
            {lang}
          </span>
        )}
        <IconButton
          hint="familiar"
          size="xs"
          aria-label={copied ? 'Copied' : 'Copy code'}
          title={copied ? 'Copied' : 'Copy code'}
          icon={copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          onClick={handleCopy}
        />
      </div>
      {highlightedHtml ? (
        <div
          className="shiki-wrapper"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <pre {...props}>{children}</pre>
      )}
    </div>
  );
}
