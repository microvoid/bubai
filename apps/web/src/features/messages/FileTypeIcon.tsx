/** Copied from references/buzz-app/src/features/messages/FileTypeIcon.tsx */
import {
  FileCodeIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileTypePdfIcon,
  FileZipIcon,
} from '../../design-system/icons/index';
import styles from './FileTypeIcon.module.css';

export function FileTypeIcon({
  name = '',
  mime = '',
}: {
  name?: string | undefined;
  mime?: string | undefined;
}) {
  const extension = name.toLowerCase().split('.').at(-1);
  const kind =
    mime === 'application/pdf' || extension === 'pdf'
      ? 'pdf'
      : ['csv', 'xls', 'xlsx', 'ods'].includes(extension ?? '')
        ? 'sheet'
        : ['zip', 'gz', 'tar', '7z', 'rar'].includes(extension ?? '')
          ? 'archive'
          : [
                'js',
                'ts',
                'tsx',
                'jsx',
                'json',
                'py',
                'rs',
                'html',
                'css',
                'sh',
                'diff',
                'patch',
              ].includes(extension ?? '')
            ? 'code'
            : 'text';
  const Icon = {
    pdf: FileTypePdfIcon,
    sheet: FileSpreadsheetIcon,
    archive: FileZipIcon,
    code: FileCodeIcon,
    text: FileTextIcon,
  }[kind];

  return (
    <span className={styles.icon} data-kind={kind} aria-hidden="true">
      <Icon size={20} />
    </span>
  );
}
