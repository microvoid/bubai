import {
  CheckIcon,
  DotsThreeIcon,
  MonitorIcon,
  MoonIcon,
  PencilSimpleIcon,
  PlusIcon,
  SignOutIcon,
  SunIcon,
  UsersIcon,
} from '../../design-system/icons/index';
import { Avatar } from '../../design-system/ui/Avatar';
import {
  MenuIcon,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
  MenuTrigger,
} from '../../design-system/ui/Menu';
import type { ColorModePreference } from '../../shared/theme/service';
import type { AuthOrgSummary, AuthUserSummary } from './AuthGate';
import styles from './ProfileButton.module.css';

const COLOR_MODES: Array<{ value: ColorModePreference; label: string; Icon: typeof SunIcon }> = [
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
  { value: 'system', label: 'System', Icon: MonitorIcon },
];

export interface ProfileButtonProps {
  user: AuthUserSummary | null;
  fallbackName: string;
  fallbackAvatarUrl?: string;
  organizations: readonly AuthOrgSummary[];
  activeOrg: AuthOrgSummary | null;
  colorMode: ColorModePreference;
  onColorModeChange: (mode: ColorModePreference) => void;
  onSwitchOrg: (orgId: string) => void;
  onOpenCreateOrg: () => void;
  onOpenCommunityMembers: () => void;
  onOpenProfileSettings: () => void;
  onSignOut: () => void;
}

/**
 * Sidebar footer profile & community switcher ported from
 * references/buzz-app/src/app/shell/ProfileButton.tsx.
 */
export function ProfileButton({
  user,
  fallbackName,
  fallbackAvatarUrl,
  organizations,
  activeOrg,
  colorMode,
  onColorModeChange,
  onSwitchOrg,
  onOpenCreateOrg,
  onOpenCommunityMembers,
  onOpenProfileSettings,
  onSignOut,
}: ProfileButtonProps) {
  const displayName = user
    ? user.name.trim() || user.email.split('@')[0] || user.email
    : fallbackName;
  const displayEmail = user?.email || '';
  const avatarUrl = user?.image || fallbackAvatarUrl;
  const activeMode = COLOR_MODES.find((m) => m.value === colorMode) || COLOR_MODES[2]!;
  const ActiveModeIcon = activeMode.Icon;

  return (
    <div className={styles.footerWrap}>
      <MenuRoot>
        <MenuTrigger
          render={
            <button
              type="button"
              className={styles.triggerRow}
              data-profile-trigger=""
              aria-label={`Account menu for ${displayName}`}
            >
              <Avatar
                src={avatarUrl}
                alt={displayName}
                fallback={displayName}
                size="small"
                statusBadge="online"
              />
              <span className={styles.triggerMeta}>
                <span className={styles.triggerName}>{displayName}</span>
                {activeOrg && <span className={styles.triggerOrg}>{activeOrg.name}</span>}
              </span>
              <DotsThreeIcon size={16} aria-hidden="true" />
            </button>
          }
        />
        <MenuPopup side="top" align="start" sideOffset={8} data-profile-menu="">
          <div className={styles.profileHeader}>
            <div className={styles.profileAvatar}>
              <Avatar
                src={avatarUrl}
                alt={displayName}
                fallback={displayName}
                size="large"
                statusBadge="online"
              />
            </div>
            <div className={styles.profileDetails}>
              <p className={styles.profileName}>{displayName}</p>
              {displayEmail && <p className={styles.profileEmail}>{displayEmail}</p>}
            </div>
          </div>

          <MenuSeparator />

          {user && (
            <>
              <MenuSubmenu>
                <MenuSubmenuTrigger data-profile-action="community-switcher">
                  <MenuIcon>
                    <UsersIcon size={16} />
                  </MenuIcon>
                  Community: {activeOrg?.name || '选择空间'}
                </MenuSubmenuTrigger>
                <MenuSubmenuPopup>
                  {organizations.map((org) => (
                    <MenuItem
                      key={org.id}
                      data-profile-org-id={org.id}
                      onClick={() => onSwitchOrg(org.id)}
                    >
                      <MenuIcon>
                        {org.id === activeOrg?.id ? <CheckIcon size={14} /> : <span />}
                      </MenuIcon>
                      {org.name}
                    </MenuItem>
                  ))}
                  {organizations.length > 0 && <MenuSeparator />}
                  <MenuItem
                    data-profile-action="create-community"
                    onClick={onOpenCreateOrg}
                  >
                    <MenuIcon>
                      <PlusIcon size={14} />
                    </MenuIcon>
                    新建 Community…
                  </MenuItem>
                </MenuSubmenuPopup>
              </MenuSubmenu>

              {activeOrg && (
                <MenuItem
                  data-profile-action="open-community-members"
                  onClick={onOpenCommunityMembers}
                >
                  <MenuIcon>
                    <UsersIcon size={16} />
                  </MenuIcon>
                  Community 成员与邀请…
                </MenuItem>
              )}

              <MenuSeparator />
            </>
          )}

          <MenuSubmenu>
            <MenuSubmenuTrigger data-profile-action="appearance-menu">
              <MenuIcon>
                <ActiveModeIcon size={16} />
              </MenuIcon>
              外观：{activeMode.label}
            </MenuSubmenuTrigger>
            <MenuSubmenuPopup>
              <MenuRadioGroup
                value={colorMode}
                onValueChange={(value) => onColorModeChange(value as ColorModePreference)}
              >
                {COLOR_MODES.map(({ value, label, Icon }) => (
                  <MenuRadioItem key={value} value={value}>
                    <MenuIcon>
                      <Icon size={14} />
                    </MenuIcon>
                    {label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubmenuPopup>
          </MenuSubmenu>

          {user && (
            <MenuItem
              data-profile-action="open-profile-settings"
              onClick={onOpenProfileSettings}
            >
              <MenuIcon>
                <PencilSimpleIcon size={16} />
              </MenuIcon>
              个人资料设置…
            </MenuItem>
          )}

          {user && (
            <>
              <MenuSeparator />
              <MenuItem
                tone="danger"
                data-profile-action="sign-out"
                onClick={onSignOut}
              >
                <MenuIcon>
                  <SignOutIcon size={16} />
                </MenuIcon>
                退出登录
              </MenuItem>
            </>
          )}
        </MenuPopup>
      </MenuRoot>
    </div>
  );
}
