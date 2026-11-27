/**
 * ProseMirror rich-text composer aligned with Buzz's MessageComposer layout
 * (.composerContext > .composerDock > form.composer > .composerReplySlot? +
 *  .composerContent/.composerInput + .composerActions/.composerToolRow).
 *
 * Includes:
 * - Reactive editable prop sync (fixes initial contenteditable=false after bootstrap)
 * - Rich inline & block formatting (Bold, Italic, Strikethrough, Code, Spoiler, Link,
 *   Code block, Bullet list, Ordered list, Quote) with Buzz's ComposerFormattingTools
 * - Buzz's emoji-mart picker (BuzzEmojiPicker)
 * - Buzz's MentionCompletions with ArrowUp/ArrowDown/Enter/Tab/Escape
 * - Enter-to-send / Shift+Enter newline, file/image uploads & Ctrl+V paste
 * - data-message-composer="" & dockRef for Buzz's inline ComposerSheet
 */
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from 'react';
import {
  Schema,
  type MarkType,
  type Node as PMNode,
} from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, toggleMark } from 'prosemirror-commands';
import { IconButton } from '../../design-system/ui/IconButton';
import { Button } from '../../design-system/ui/Button';
import { Input } from '../../design-system/ui/Input';
import {
  ArrowUpIcon,
  CheckIcon,
  PaperclipIcon,
  XIcon,
} from '../../design-system/icons/index';
import { accentButtonStyle } from '../../shared/theme/accent';
import {
  filterMentionCandidates,
  MentionCompletions,
  type MentionCandidate,
} from '../conversation/MentionCompletions';
import { BuzzEmojiPicker } from './BuzzEmojiPicker';
import {
  ComposerFormattingTools,
  type BlockFormat,
  type ComposerFormat,
  type InlineFormat,
} from './ComposerFormattingTools';
import styles from './Messages.module.css';

export interface UploadedAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
}

export interface ReplyContextTarget {
  author: string;
  excerpt: string;
  onCancel: () => void;
}

function createMessageId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // getRandomValues is also available on the Vite dev server's plain HTTP LAN URL.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const composerSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'inline*',
      parseDOM: [{ tag: 'p' }],
      toDOM() {
        return ['p', 0];
      },
    },
    code_block: {
      group: 'block',
      content: 'text*',
      code: true,
      defining: true,
      marks: '',
      parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
      toDOM() {
        return [
          'pre',
          {
            style:
              'margin: 4px 0; padding: 6px 8px; border-radius: 6px; background: var(--surface-inset); font-family: var(--font-mono); font-size: 0.9em;',
          },
          ['code', 0],
        ];
      },
    },
    blockquote: {
      group: 'block',
      content: 'inline*',
      defining: true,
      parseDOM: [{ tag: 'blockquote' }],
      toDOM() {
        return [
          'blockquote',
          {
            style:
              'margin: 2px 0; padding-inline-start: 10px; border-inline-start: 2px solid var(--border-standard); color: var(--text-subtle);',
          },
          0,
        ];
      },
    },
    bullet_list_item: {
      group: 'block',
      content: 'inline*',
      defining: true,
      parseDOM: [{ tag: 'div[data-list="bullet"]' }],
      toDOM() {
        return [
          'div',
          {
            'data-list': 'bullet',
            style: 'display: list-item; list-style-type: disc; margin-inline-start: 1.25em;',
          },
          0,
        ];
      },
    },
    ordered_list_item: {
      group: 'block',
      content: 'inline*',
      defining: true,
      parseDOM: [{ tag: 'div[data-list="ordered"]' }],
      toDOM() {
        return [
          'div',
          {
            'data-list': 'ordered',
            style: 'display: list-item; list-style-type: decimal; margin-inline-start: 1.25em;',
          },
          0,
        ];
      },
    },
    text: { group: 'inline' },
    hard_break: {
      inline: true,
      group: 'inline',
      selectable: false,
      parseDOM: [{ tag: 'br' }],
      toDOM() {
        return ['br'];
      },
    },
    mention: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: { id: { default: '' }, label: { default: '' } },
      toDOM(node) {
        return [
          'span',
          {
            class: 'spike-chip',
            'data-mention-id': node.attrs.id,
          },
          `@${node.attrs.label}`,
        ];
      },
      parseDOM: [
        {
          tag: 'span[data-mention-id]',
          getAttrs(dom) {
            const el = dom as HTMLElement;
            return {
              id: el.getAttribute('data-mention-id') || '',
              label: (el.textContent || '').replace(/^@/, ''),
            };
          },
        },
      ],
    },
  },
  marks: {
    bold: {
      parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
      toDOM() {
        return ['strong', 0];
      },
    },
    italic: {
      parseDOM: [{ tag: 'em' }, { tag: 'i' }],
      toDOM() {
        return ['em', 0];
      },
    },
    strike: {
      parseDOM: [{ tag: 'del' }, { tag: 's' }],
      toDOM() {
        return ['del', 0];
      },
    },
    code: {
      excludes: '_',
      parseDOM: [{ tag: 'code' }],
      toDOM() {
        return [
          'code',
          {
            style:
              'padding: 0 4px; border-radius: 4px; background: var(--surface-inset); font-family: var(--font-mono); font-size: 0.9em;',
          },
          0,
        ];
      },
    },
    spoiler: {
      parseDOM: [{ tag: 'span[data-spoiler]' }],
      toDOM() {
        return [
          'span',
          {
            'data-spoiler': '',
            style:
              'padding: 0 4px; border-radius: 4px; background: var(--affordance-hover); color: var(--text-subtle);',
          },
          0,
        ];
      },
    },
    link: {
      attrs: { href: { default: '' } },
      inclusive: false,
      parseDOM: [
        {
          tag: 'a[href]',
          getAttrs(dom) {
            return { href: (dom as HTMLElement).getAttribute('href') || '' };
          },
        },
      ],
      toDOM(mark) {
        return [
          'a',
          {
            href: mark.attrs.href,
            style: 'color: var(--text-link, var(--accent-11)); text-decoration: underline;',
          },
          0,
        ];
      },
    },
  },
});

function serializeInline(block: PMNode): string {
  let out = '';
  block.forEach((child) => {
    if (child.isText) {
      let piece = (child.text ?? '').replace(/\u00a0/g, ' ');
      const marks = child.marks;
      const hasCode = marks.some((m) => m.type.name === 'code');
      if (hasCode) {
        piece = `\`${piece}\``;
      } else {
        const hasBold = marks.some((m) => m.type.name === 'bold');
        const hasItalic = marks.some((m) => m.type.name === 'italic');
        const hasStrike = marks.some((m) => m.type.name === 'strike');
        const hasSpoiler = marks.some((m) => m.type.name === 'spoiler');
        const linkMark = marks.find((m) => m.type.name === 'link');
        if (hasBold) piece = `**${piece}**`;
        if (hasItalic) piece = `*${piece}*`;
        if (hasStrike) piece = `~~${piece}~~`;
        if (hasSpoiler) piece = `||${piece}||`;
        if (linkMark?.attrs.href) piece = `[${piece}](${linkMark.attrs.href})`;
      }
      out += piece;
    } else if (child.type.name === 'mention') {
      out += `@${child.attrs.label}`;
    } else if (child.type.name === 'hard_break') {
      out += '\n';
    }
  });
  return out;
}

function serializeDoc(doc: PMNode): string {
  const blocks: string[] = [];
  let orderedIndex = 0;
  doc.forEach((block) => {
    if (block.type.name !== 'ordered_list_item') orderedIndex = 0;
    switch (block.type.name) {
      case 'code_block': {
        const code = block.textContent;
        blocks.push(`\`\`\`\n${code}\n\`\`\``);
        break;
      }
      case 'blockquote': {
        const inner = serializeInline(block);
        blocks.push(
          inner
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n'),
        );
        break;
      }
      case 'bullet_list_item': {
        const inner = serializeInline(block);
        blocks.push(
          inner
            .split('\n')
            .map((line) => `- ${line}`)
            .join('\n'),
        );
        break;
      }
      case 'ordered_list_item': {
        const inner = serializeInline(block);
        blocks.push(
          inner
            .split('\n')
            .map((line) => {
              orderedIndex += 1;
              return `${orderedIndex}. ${line}`;
            })
            .join('\n'),
        );
        break;
      }
      default: {
        blocks.push(serializeInline(block));
        break;
      }
    }
  });
  return blocks.join('\n');
}

function getActiveFormats(state: EditorState): ComposerFormat[] {
  const active: ComposerFormat[] = [];
  const { $from, empty, from, to } = state.selection;
  const inlineMarks: InlineFormat[] = ['bold', 'italic', 'strike', 'code', 'spoiler'];
  for (const name of inlineMarks) {
    const type = composerSchema.marks[name];
    if (!type) continue;
    if (empty) {
      const stored = state.storedMarks || $from.marks();
      if (type.isInSet(stored)) active.push(name);
    } else if (state.doc.rangeHasMark(from, to, type)) {
      active.push(name);
    }
  }
  const parentName = $from.parent.type.name;
  if (parentName === 'code_block') active.push('code_block');
  else if (parentName === 'blockquote') active.push('blockquote');
  else if (parentName === 'bullet_list_item') active.push('bullet_list');
  else if (parentName === 'ordered_list_item') active.push('ordered_list');
  return active;
}

function getActiveMentionAtCursor(
  state: EditorState,
): { from: number; to: number; query: string } | null {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.name === 'code_block') {
    return null;
  }
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
  const match = textBefore.match(/(?:^|[\s\ufffc])@([^\s@\ufffc]*)$/);
  if (!match) return null;
  const query = match[1] ?? '';
  const to = $from.pos;
  const from = to - query.length - 1;
  return { from, to, query };
}

function toggleBlockNode(
  state: EditorState,
  dispatch: ((tr: EditorState['tr']) => void) | undefined,
  format: BlockFormat,
): boolean {
  const nodeName =
    format === 'bullet_list'
      ? 'bullet_list_item'
      : format === 'ordered_list'
        ? 'ordered_list_item'
        : format;
  const targetType = composerSchema.nodes[nodeName];
  const paragraphType = composerSchema.nodes.paragraph;
  if (!targetType || !paragraphType) return false;
  const { $from, $to } = state.selection;
  const isAlreadyTarget = $from.parent.type === targetType;
  const nextType = isAlreadyTarget ? paragraphType : targetType;
  const range = $from.blockRange($to);
  if (!range) return false;
  if (dispatch) {
    const tr = state.tr.setBlockType(range.start, range.end, nextType);
    dispatch(tr.scrollIntoView());
  }
  return true;
}

export interface ProseMirrorComposerHandle {
  insertMention: (candidate: Pick<MentionCandidate, 'id' | 'name'>) => void;
}

export function ProseMirrorComposer({
  placeholder = 'Send a message',
  disabled = false,
  candidates = [],
  draftScope,
  onSend,
  onTyping,
  onUploadFile,
  serverHttp,
  dockRef,
  composerRef,
  replyContext,
  autoFocus = false,
}: {
  placeholder?: string;
  disabled?: boolean;
  candidates?: readonly MentionCandidate[];
  draftScope: string;
  onSend: (text: string, attachments: UploadedAttachment[], messageId: string) => Promise<void>;
  onTyping?: () => void;
  onUploadFile?: (file: File) => Promise<UploadedAttachment | null>;
  serverHttp: string;
  dockRef?: Ref<HTMLDivElement>;
  composerRef?: Ref<ProseMirrorComposerHandle>;
  replyContext?: ReplyContextTarget | null;
  autoFocus?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sendInProgress = useRef(false);
  const lastAttempt = useRef<{
    messageId: string;
    scope: string;
    text: string;
    files: UploadedAttachment[];
  } | null>(null);

  const [isEmpty, setIsEmpty] = useState(true);
  const [activeFormats, setActiveFormats] = useState<ComposerFormat[]>([]);
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [mentionState, setMentionState] = useState<{
    from: number;
    to: number;
    query: string;
  } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [linkDraft, setLinkDraft] = useState<{ open: boolean; url: string }>({
    open: false,
    url: '',
  });

  const stateRef = useRef({
    mentionState,
    mentionIndex,
    candidates,
    attachments,
    disabled,
    draftScope,
    uploading,
    onSend,
    onTyping,
  });
  stateRef.current = {
    mentionState,
    mentionIndex,
    candidates,
    attachments,
    disabled,
    draftScope,
    uploading,
    onSend,
    onTyping,
  };

  const applyFormat = (format: ComposerFormat) => {
    const view = viewRef.current;
    if (!view || stateRef.current.disabled) return;
    if (
      format === 'bold' ||
      format === 'italic' ||
      format === 'strike' ||
      format === 'code' ||
      format === 'spoiler'
    ) {
      const markType: MarkType | undefined = composerSchema.marks[format];
      if (markType) {
        toggleMark(markType)(view.state, view.dispatch);
      }
    } else {
      toggleBlockNode(view.state, view.dispatch, format);
    }
    view.focus();
  };

  const openLinkEditor = () => {
    const view = viewRef.current;
    if (!view || stateRef.current.disabled) return;
    const { $from } = view.state.selection;
    const existing = $from
      .marks()
      .find((m) => m.type === composerSchema.marks.link);
    setLinkDraft({
      open: true,
      url: typeof existing?.attrs.href === 'string' ? existing.attrs.href : 'https://',
    });
  };

  const applyLink = (url: string) => {
    const view = viewRef.current;
    const trimmed = url.trim();
    setLinkDraft({ open: false, url: '' });
    if (!view || !trimmed) {
      view?.focus();
      return;
    }
    const linkMark = composerSchema.marks.link.create({ href: trimmed });
    const { from, to, empty } = view.state.selection;
    if (empty) {
      const tr = view.state.tr.insert(from, composerSchema.text(trimmed, [linkMark]));
      view.dispatch(tr.scrollIntoView());
    } else {
      const tr = view.state.tr.addMark(from, to, linkMark);
      view.dispatch(tr.scrollIntoView());
    }
    view.focus();
  };

  const insertEmoji = (emoji: string) => {
    const view = viewRef.current;
    if (!view || stateRef.current.disabled) return;
    const tr = view.state.tr.insertText(emoji);
    view.dispatch(tr.scrollIntoView());
    view.focus();
  };

  const insertMention = (candidate: MentionCandidate) => {
    const view = viewRef.current;
    const ms = stateRef.current.mentionState;
    if (!view || !ms) return;
    const mentionNode = composerSchema.nodes.mention.create({
      id: candidate.id,
      label: candidate.name,
    });
    const tr = view.state.tr.replaceWith(ms.from, ms.to, [
      mentionNode,
      composerSchema.text('\u00a0'),
    ]);
    tr.setSelection(TextSelection.create(tr.doc, ms.from + 2));
    view.dispatch(tr);
    view.focus();
    setMentionState(null);
    setMentionIndex(0);
  };

  useImperativeHandle(
    composerRef,
    () => ({
      insertMention(candidate: Pick<MentionCandidate, 'id' | 'name'>) {
        const view = viewRef.current;
        if (!view || stateRef.current.disabled) return;
        const firstParagraph = view.state.doc.firstChild;
        const firstInline = firstParagraph?.firstChild;
        const alreadyMentionedAtStart =
          (firstInline?.type === composerSchema.nodes.mention &&
            firstInline.attrs.id === candidate.id) ||
          view.state.doc.textContent
            .trimStart()
            .toLowerCase()
            .startsWith(`@${candidate.name.toLowerCase()}`);
        if (alreadyMentionedAtStart) {
          view.focus();
          return;
        }
        const mentionNode = composerSchema.nodes.mention.create({
          id: candidate.id,
          label: candidate.name,
        });
        const { from, to } = view.state.selection;
        const tr = view.state.tr.replaceWith(from, to, [
          mentionNode,
          composerSchema.text('\u00a0'),
        ]);
        tr.setSelection(TextSelection.create(tr.doc, from + 2));
        view.dispatch(tr.scrollIntoView());
        view.focus();
      },
    }),
    [],
  );

  const acceptActiveMention = (): boolean => {
    const ms = stateRef.current.mentionState;
    if (!ms) return false;
    const filtered = filterMentionCandidates(stateRef.current.candidates, ms.query);
    if (filtered.length === 0) return false;
    const clamped = Math.min(stateRef.current.mentionIndex, filtered.length - 1);
    const picked = filtered[clamped];
    if (!picked) return false;
    insertMention(picked);
    return true;
  };

  const triggerSend = async () => {
    const view = viewRef.current;
    const { disabled, draftScope: scope, uploading, attachments: files, onSend } = stateRef.current;
    if (!view || disabled || uploading || sendInProgress.current) return;
    const doc = view.state.doc;
    const text = serializeDoc(doc).trim();
    if (!text && files.length === 0) return;

    const previous = lastAttempt.current;
    const messageId =
      previous?.scope === scope && previous.text === text && previous.files === files
        ? previous.messageId
        : createMessageId();
    lastAttempt.current = { messageId, scope, text, files };
    sendInProgress.current = true;
    setSending(true);
    setSendError(null);

    try {
      await onSend(text, files, messageId);
      lastAttempt.current = null;
      if (viewRef.current !== view) return;
      if (view.state.doc.eq(doc)) {
        const fresh = EditorState.create({ schema: composerSchema, plugins: view.state.plugins });
        view.updateState(fresh);
        setIsEmpty(true);
        setActiveFormats([]);
        setMentionState(null);
        setMentionIndex(0);
      }
      if (files.length > 0) {
        setAttachments((current) => current.filter((file) => !files.includes(file)));
      }
    } catch (error) {
      if (viewRef.current === view) {
        setSendError(error instanceof Error ? error.message : 'Could not send. Try again.');
      }
    } finally {
      sendInProgress.current = false;
      if (viewRef.current === view) setSending(false);
    }
  };

  const handleFiles = async (fileList: FileList | File[]) => {
    if (!onUploadFile) return;
    setUploading(true);
    try {
      for (const file of Array.from(fileList)) {
        const uploaded = await onUploadFile(file);
        if (uploaded) {
          setAttachments((prev) => [...prev, uploaded]);
        }
      }
    } finally {
      setUploading(false);
    }
  };

  // Keep refs to callbacks used inside ProseMirror keymap
  const formatActionRef = useRef({ applyFormat, openLinkEditor, acceptActiveMention, triggerSend });
  formatActionRef.current = { applyFormat, openLinkEditor, acceptActiveMention, triggerSend };

  useEffect(() => {
    if (!hostRef.current) return;

    const customKeymap = keymap({
      'Mod-z': undo,
      'Mod-Shift-z': redo,
      'Mod-y': redo,
      'Mod-b': () => {
        formatActionRef.current.applyFormat('bold');
        return true;
      },
      'Mod-i': () => {
        formatActionRef.current.applyFormat('italic');
        return true;
      },
      'Mod-Shift-x': () => {
        formatActionRef.current.applyFormat('strike');
        return true;
      },
      'Mod-e': () => {
        formatActionRef.current.applyFormat('code');
        return true;
      },
      'Mod-Shift-p': () => {
        formatActionRef.current.applyFormat('spoiler');
        return true;
      },
      'Mod-Alt-c': () => {
        formatActionRef.current.applyFormat('code_block');
        return true;
      },
      'Mod-Shift-8': () => {
        formatActionRef.current.applyFormat('bullet_list');
        return true;
      },
      'Mod-Shift-7': () => {
        formatActionRef.current.applyFormat('ordered_list');
        return true;
      },
      'Mod-Shift-b': () => {
        formatActionRef.current.applyFormat('blockquote');
        return true;
      },
      'Mod-k': () => {
        formatActionRef.current.openLinkEditor();
        return true;
      },
      ArrowDown: () => {
        const ms = stateRef.current.mentionState;
        if (!ms) return false;
        const filtered = filterMentionCandidates(stateRef.current.candidates, ms.query);
        if (filtered.length === 0) return false;
        setMentionIndex((i) => (i + 1) % filtered.length);
        return true;
      },
      ArrowUp: () => {
        const ms = stateRef.current.mentionState;
        if (!ms) return false;
        const filtered = filterMentionCandidates(stateRef.current.candidates, ms.query);
        if (filtered.length === 0) return false;
        setMentionIndex((i) => (i - 1 + filtered.length) % filtered.length);
        return true;
      },
      Tab: () => formatActionRef.current.acceptActiveMention(),
      Escape: () => {
        if (!stateRef.current.mentionState) return false;
        setMentionState(null);
        setMentionIndex(0);
        return true;
      },
      'Shift-Enter': (state, dispatch) => {
        if (state.selection.$from.parent.type.name === 'code_block') {
          if (dispatch) dispatch(state.tr.insertText('\n').scrollIntoView());
          return true;
        }
        if (dispatch) {
          dispatch(
            state.tr
              .replaceSelectionWith(composerSchema.nodes.hard_break.create())
              .scrollIntoView(),
          );
        }
        return true;
      },
      Enter: () => {
        if (formatActionRef.current.acceptActiveMention()) return true;
        void formatActionRef.current.triggerSend();
        return true;
      },
    });

    const state = EditorState.create({
      schema: composerSchema,
      plugins: [history(), customKeymap, keymap(baseKeymap)],
    });

    const view = new EditorView(hostRef.current, {
      state,
      editable: () => !stateRef.current.disabled,
      attributes: {
        class: 'spike-editor',
        style: 'min-height: 1.5lh; outline: none; resize: none;',
        'aria-label': 'Message',
      },
      dispatchTransaction(tr) {
        const nextState = view.state.apply(tr);
        view.updateState(nextState);
        const text = serializeDoc(nextState.doc);
        setIsEmpty(text.trim().length === 0);
        if (tr.docChanged && text.trim().length > 0) {
          stateRef.current.onTyping?.();
        }
        setActiveFormats(getActiveFormats(nextState));
        const ms = getActiveMentionAtCursor(nextState);
        setMentionState(ms);
        if (!ms) setMentionIndex(0);
      },
      handlePaste(_view, event) {
        const files = event.clipboardData?.files;
        if (files && files.length > 0 && onUploadFile) {
          event.preventDefault();
          void handleFiles(files);
          return true;
        }
        return false;
      },
    });

    viewRef.current = view;
    if (autoFocus && !stateRef.current.disabled) {
      queueMicrotask(() => view.focus());
    }
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Re-evaluate ProseMirror's contenteditable attribute whenever `disabled` changes
  // (fixes initial channel load leaving contenteditable="false" after /api/bootstrap resolves).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.setProps({ editable: () => !disabled });
    if (autoFocus && !disabled) {
      view.focus();
    }
  }, [disabled, autoFocus]);

  const canSend = !disabled && !uploading && !sending && (!isEmpty || attachments.length > 0);

  return (
    <div className={styles.composerContext}>
      <div className={styles.composerDock} data-composer-dock="" ref={dockRef}>
        {mentionState && (
          <MentionCompletions
            candidates={candidates}
            query={mentionState.query}
            activeIndex={mentionIndex}
            onActiveIndexChange={setMentionIndex}
            onSelect={insertMention}
          />
        )}

        <form
          className={styles.composer}
          data-message-composer=""
          data-composer-surface=""
          data-attachments={attachments.length > 0 || undefined}
          data-disabled={disabled || undefined}
          onSubmit={(e) => {
            e.preventDefault();
            void triggerSend();
          }}
        >
          <div
            className={styles.composerReplySlot}
            data-open={replyContext ? '' : undefined}
          >
            <div className={styles.composerReplyClip}>
              <div className={styles.composerReplyContent}>
                {replyContext && (
                  <div className={styles.replyContext} data-reply-context="">
                    <div>
                      <strong>Replying to {replyContext.author}</strong>
                      {replyContext.excerpt && <p>{replyContext.excerpt}</p>}
                    </div>
                    <IconButton
                      hint="familiar"
                      size="xs"
                      type="button"
                      aria-label="Cancel reply target"
                      onClick={replyContext.onCancel}
                      icon={<XIcon size={14} aria-hidden="true" />}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>

          {attachments.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                paddingInline: 'var(--space-2)',
              }}
            >
              {attachments.map((att) => (
                <div
                  key={att.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 8px',
                    borderRadius: 'var(--radius-control)',
                    border: '1px solid var(--border-standard)',
                    background: 'var(--surface-inset)',
                    fontSize: 'var(--text-caption)',
                  }}
                >
                  {att.mimeType.startsWith('image/') && (
                    <img
                      src={
                        att.url.startsWith('http') || att.url.startsWith('data:')
                          ? att.url
                          : `${serverHttp}${att.url}`
                      }
                      alt={att.name}
                      style={{ width: 24, height: 24, objectFit: 'cover', borderRadius: 4 }}
                    />
                  )}
                  <span
                    style={{
                      maxWidth: 160,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {att.name}
                  </span>
                  <IconButton
                    hint="familiar"
                    size="xs"
                    aria-label="Remove attachment"
                    icon={<XIcon size={12} />}
                    onClick={() =>
                      setAttachments((prev) => prev.filter((a) => a.id !== att.id))
                    }
                  />
                </div>
              ))}
            </div>
          )}

          {linkDraft.open && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px var(--space-2)',
              }}
            >
              <Input
                value={linkDraft.url}
                onChange={(e) => setLinkDraft({ open: true, url: e.target.value })}
                placeholder="https://example.com"
                aria-label="Link URL"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    applyLink(linkDraft.url);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setLinkDraft({ open: false, url: '' });
                    viewRef.current?.focus();
                  }
                }}
              />
              <Button
                type="button"
                variant="primary"
                size="xs"
                onClick={() => applyLink(linkDraft.url)}
              >
                <CheckIcon size={12} aria-hidden="true" />
                Apply
              </Button>
              <IconButton
                hint="familiar"
                size="xs"
                type="button"
                aria-label="Cancel link"
                onClick={() => {
                  setLinkDraft({ open: false, url: '' });
                  viewRef.current?.focus();
                }}
                icon={<XIcon size={12} aria-hidden="true" />}
              />
            </div>
          )}

          <div className={styles.composerContent}>
            <div className={styles.composerInput}>
              {isEmpty && (
                <div
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    insetBlockStart: 0,
                    insetInline: 'var(--space-1)',
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                    color: 'var(--text-metadata)',
                    pointerEvents: 'none',
                  }}
                >
                  {placeholder}
                </div>
              )}
              <div ref={hostRef} />
            </div>
          </div>

          {sendError && (
            <p className={styles.composerStatus} role="alert">{sendError}</p>
          )}
          <div className={styles.composerActions}>
            <div className={styles.composerToolRow}>
              <div className={styles.composerLeadingTools} style={{ marginInlineEnd: 'auto' }}>
                <ComposerFormattingTools
                  disabled={disabled}
                  activeFormats={activeFormats}
                  toggleFormat={applyFormat}
                  editLink={openLinkEditor}
                >
                  {onUploadFile && (
                    <>
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          if (e.target.files?.length) {
                            void handleFiles(e.target.files);
                            e.target.value = '';
                          }
                        }}
                      />
                      <IconButton
                        hint="familiar"
                        size="sm"
                        aria-label="Attach file"
                        title="Attach file (paste image supported)"
                        loading={uploading}
                        disabled={disabled}
                        icon={<PaperclipIcon size={16} aria-hidden="true" />}
                        onClick={() => fileInputRef.current?.click()}
                      />
                    </>
                  )}
                  <BuzzEmojiPicker
                    disabled={disabled}
                    onSelect={insertEmoji}
                  />
                </ComposerFormattingTools>
              </div>
              <IconButton
                variant={canSend ? 'primary' : 'ghost'}
                style={canSend ? accentButtonStyle : undefined}
                hint="familiar"
                type="submit"
                size="toolbar"
                aria-label={sending ? 'Sending message' : 'Send message'}
                title="Send message (Enter)"
                loading={sending}
                disabled={!canSend}
                icon={<ArrowUpIcon size={16} aria-hidden="true" />}
              />
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
