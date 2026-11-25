/**
 * Appearance controls ported from references/buzz-app/src/app/AppearanceSettings.tsx
 * (ThemePicker + Accent color swatches + Vibe level / Bubble contrast: Chillin’ / Buzzin’).
 */
import { CircleIcon } from '../../design-system/icons/index';
import { IconButton } from '../../design-system/ui/IconButton';
import { Select } from '../../design-system/ui/Select';
import { ThemePicker } from '../../design-system/ui/ThemePicker';
import { ACCENTS, accentButtonStyle } from '../../shared/theme/accent';
import { appearance, useAppearance } from '../../shared/theme/service';

export function AppearanceControls() {
  const { preference, mode, accent, contrast } = useAppearance();

  return (
    <div
      style={{
        padding: '10px 10px 12px',
        borderBottom: '1px solid var(--border-standard)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}
    >
      <ThemePicker
        value={preference}
        onValueChange={(next) => appearance.setMode(next)}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1h)' }}>
        <span className="text-caption text-subtle">Accent color</span>
        <div
          data-accent-colors=""
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-1h)',
            padding: '2px',
          }}
        >
          {ACCENTS.map((color) => {
            const colorLabel =
              color === 'bee'
                ? 'Honey'
                : `${color.charAt(0).toUpperCase()}${color.slice(1)}`;
            return (
              <IconButton
                key={color}
                data-color-swatch=""
                data-accent={color}
                data-color-mode={mode}
                style={accentButtonStyle}
                variant="primary"
                size="sm"
                shape="round"
                aria-label={`${colorLabel} accent color`}
                title={colorLabel}
                aria-pressed={accent === color}
                onClick={() => appearance.setAccent(color)}
                icon={
                  <CircleIcon
                    size={20}
                    strokeWidth={3}
                    aria-hidden="true"
                    style={{ opacity: accent === color ? 1 : 0 }}
                  />
                }
              />
            );
          })}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
        }}
      >
        <span className="text-caption text-subtle">Vibe level</span>
        <Select
          variant="compact"
          label="Vibe level"
          value={contrast}
          groups={[
            {
              label: 'Vibe level',
              options: [
                { value: 'low', label: 'Chillin’' },
                { value: 'high', label: 'Buzzin’' },
              ],
            },
          ]}
          onValueChange={(value) => {
            if (value === 'low' || value === 'high') {
              appearance.setContrast(value);
            }
          }}
        />
      </div>
    </div>
  );
}
