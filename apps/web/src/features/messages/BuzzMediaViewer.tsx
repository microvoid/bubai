/**
 * In-app media viewer ported from references/buzz-app/src/features/messages/MediaAttachment.tsx
 * (MediaViewer) and ImageReviewStage.tsx (zoom/pan/gallery navigation/download).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CaretLeftIcon,
  CaretRightIcon,
  DownloadIcon,
  MinusIcon,
  PlusIcon,
  XIcon,
} from '../../design-system/icons/index';
import { Button } from '../../design-system/ui/Button';
import { IconButton } from '../../design-system/ui/IconButton';
import { PanelHeader, PanelHeaderLabel } from '../../design-system/ui/PanelHeader';
import styles from './Messages.module.css';
import type { UploadedAttachment } from './ProseMirrorComposer';
import { MIN_ZOOM, useImageViewport } from './use-image-viewport';
import { useModalBoundary } from './useModalBoundary';

const ZOOM_STEP = 0.25;
const ZOOM_PRESETS = [0.5, 1, 1.5, 2];
const CLICK_SLOP = 4;

export interface MediaViewerSelection {
  attachments: readonly UploadedAttachment[];
  selectedId: string;
}

export function resolveAttachmentSource(url: string, serverHttp: string): string {
  if (
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('data:') ||
    url.startsWith('blob:')
  ) {
    return url;
  }
  return `${serverHttp}${url}`;
}

export function BuzzMediaViewer({
  selection,
  serverHttp,
  onSelectId,
  onClose,
}: {
  selection: MediaViewerSelection;
  serverHttp: string;
  onSelectId: (id: string) => void;
  onClose: () => void;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useModalBoundary(backdrop, closeButton, onClose);

  const mediaItems = selection.attachments.filter(
    (a) =>
      a.mimeType.startsWith('image/') ||
      a.mimeType.startsWith('video/') ||
      a.mimeType.startsWith('audio/'),
  );
  const selectedIndex = Math.max(
    0,
    mediaItems.findIndex((a) => a.id === selection.selectedId),
  );
  const selected = mediaItems[selectedIndex] ?? mediaItems[0];
  const source = selected ? resolveAttachmentSource(selected.url, serverHttp) : undefined;
  const isVideo = selected?.mimeType.startsWith('video/');
  const isAudio = selected?.mimeType.startsWith('audio/');
  const title = selected?.name || (isVideo ? 'Video attachment' : isAudio ? 'Audio attachment' : 'Image attachment');

  return createPortal(
    <div
      ref={backdrop}
      className={styles.mediaViewerBackdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`${styles.mediaViewer} dark`}
        data-color-mode="dark"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className={styles.mediaViewerHeading}>
          <PanelHeader
            title={<PanelHeaderLabel title={title} />}
            actions={
              <IconButton
                size="compact"
                ref={closeButton}
                type="button"
                aria-label="Close fullscreen viewer"
                onClick={onClose}
                icon={<XIcon size={20} aria-hidden="true" />}
              />
            }
          />
        </div>

        {!selected || !source ? (
          <p className={styles.mediaReviewUnavailable} role="status">
            Media unavailable
          </p>
        ) : isVideo ? (
          <div
            style={{
              display: 'grid',
              placeItems: 'center',
              background: 'var(--bg-media-canvas)',
              minHeight: 0,
              position: 'relative',
            }}
          >
            <video
              className={styles.mediaViewerVideo}
              src={source}
              controls
              autoPlay
              playsInline
            />
          </div>
        ) : isAudio ? (
          <div
            style={{
              display: 'grid',
              placeItems: 'center',
              background: 'var(--bg-media-canvas)',
              minHeight: 0,
              padding: 'var(--space-6)',
            }}
          >
            <audio src={source} controls autoPlay style={{ width: 'min(32rem, 100%)' }} />
          </div>
        ) : (
          <BuzzImageStage
            attachments={mediaItems.filter((a) => a.mimeType.startsWith('image/'))}
            selected={selected}
            serverHttp={serverHttp}
            onSelectId={onSelectId}
          />
        )}
      </section>
    </div>,
    document.body,
  );
}

function BuzzImageStage({
  attachments,
  selected,
  serverHttp,
  onSelectId,
}: {
  attachments: readonly UploadedAttachment[];
  selected: UploadedAttachment;
  serverHttp: string;
  onSelectId: (id: string) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const previousButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const zoomHint = useId();
  const [dragging, setDragging] = useState(false);

  const press = useRef<
    | {
        pointer: number;
        origin: { x: number; y: number };
        offset: { x: number; y: number };
        panning: boolean;
        click: boolean;
      }
    | undefined
  >(undefined);

  const selectedIndex = Math.max(
    0,
    attachments.findIndex((item) => item.id === selected.id),
  );
  const source = resolveAttachmentSource(selected.url, serverHttp);
  const { zoom, offset, maxZoom, zoomTo, toggleZoomAt, panTo, constrain } =
    useImageViewport(stage, image, source);
  const pannable = zoom > 1;
  const nextZoom = ZOOM_PRESETS.find((preset) => preset > zoom) ?? MIN_ZOOM;

  const choose = useCallback(
    (index: number) => {
      const item = attachments[index];
      if (!item || item.id === selected.id) return;
      zoomTo(1);
      onSelectId(item.id);
    },
    [attachments, selected.id, zoomTo, onSelectId],
  );

  useEffect(() => {
    if (attachments.length < 2) return;
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
      )
        return;
      event.preventDefault();
      choose(selectedIndex + (event.key === 'ArrowRight' ? 1 : -1));
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [attachments.length, selectedIndex, choose]);

  return (
    <div
      ref={stage}
      role="group"
      aria-label="Image gallery"
      tabIndex={-1}
      data-controls-revealed=""
      data-review-zoomed={zoom !== 1 || undefined}
      className={`${styles.imageReviewStage} ${pannable ? styles.imageReviewPannable : ''} ${dragging ? styles.imageReviewDragging : ''}`}
      style={{ background: 'var(--bg-media-canvas)' }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        press.current = {
          pointer: event.pointerId,
          origin: { x: event.clientX, y: event.clientY },
          offset,
          panning: pannable,
          click: event.isPrimary && event.target === image.current,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(pannable);
      }}
      onPointerMove={(event) => {
        const active = press.current;
        if (!active || active.pointer !== event.pointerId) return;
        const dx = event.clientX - active.origin.x;
        const dy = event.clientY - active.origin.y;
        if (Math.hypot(dx, dy) > CLICK_SLOP) active.click = false;
        if (active.panning) {
          panTo({ x: active.offset.x + dx, y: active.offset.y + dy });
        }
      }}
      onPointerUp={(event) => {
        const active = press.current;
        if (active?.pointer !== event.pointerId) return;
        press.current = undefined;
        setDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
        if (active.click) toggleZoomAt(event.clientX, event.clientY);
      }}
      onPointerCancel={() => {
        press.current = undefined;
        setDragging(false);
      }}
    >
      <img
        ref={image}
        data-review-media=""
        src={source}
        alt={selected.name}
        aria-describedby={zoomHint}
        draggable={false}
        onLoad={constrain}
        style={{
          transform:
            zoom === 1
              ? 'none'
              : `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
        }}
      />
      <p id={zoomHint} className="sr-only">
        Click the image to zoom.
      </p>
      <div
        className={styles.imageReviewToolbar}
        data-image-controls=""
        onPointerDown={(event) => event.stopPropagation()}
      >
        {attachments.length > 1 && (
          <div className={styles.imageReviewSwitcher}>
            <IconButton
              size="sm"
              type="button"
              ref={previousButton}
              aria-label="Previous image"
              disabled={selectedIndex === 0}
              onClick={() => choose(selectedIndex - 1)}
              icon={<CaretLeftIcon size={18} aria-hidden="true" />}
            />
            <span aria-live="polite" aria-atomic="true">
              {selectedIndex + 1} / {attachments.length}
            </span>
            <IconButton
              size="sm"
              type="button"
              ref={nextButton}
              aria-label="Next image"
              disabled={selectedIndex === attachments.length - 1}
              onClick={() => choose(selectedIndex + 1)}
              icon={<CaretRightIcon size={18} aria-hidden="true" />}
            />
          </div>
        )}
        <div className={styles.imageReviewZoom}>
          <IconButton
            size="sm"
            type="button"
            aria-label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => zoomTo(zoom - ZOOM_STEP)}
            icon={<MinusIcon size={16} aria-hidden="true" />}
          />
          <Button
            variant="ghost"
            size="sm"
            type="button"
            aria-label={`Image zoom: ${Math.round(zoom * 100)}%. Zoom to ${nextZoom * 100}%`}
            onClick={() => zoomTo(nextZoom)}
          >
            {Math.round(zoom * 100)}%
          </Button>
          <IconButton
            size="sm"
            type="button"
            aria-label="Zoom in"
            disabled={zoom >= maxZoom}
            onClick={() => zoomTo(zoom + ZOOM_STEP)}
            icon={<PlusIcon size={16} aria-hidden="true" />}
          />
        </div>
        <IconButton
          nativeButton={false}
          role="link"
          render={<a href={source} download={selected.name} />}
          size="sm"
          aria-label="Download image"
          title="Download image"
          icon={<DownloadIcon size={17} />}
        />
      </div>
    </div>
  );
}
